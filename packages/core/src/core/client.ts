import type { FlintConfig, CallOptions } from '../types/config.js';
import type { CacheHints } from '../provider/adapter.js';
import type { Message } from '../types/message.js';
import type { StreamEvent, StreamDoneReason, TokenUsage } from '../types/stream.js';
import type { ToolDefinition, ToolHandler } from '../types/tool.js';
import type { ModelCapabilities } from '../types/capabilities.js';
import type { AiObserver } from '../observability/observer.js';
import type { MemoryStore } from '../memory/store.js';
import { noopObserver } from '../observability/observer.js';
import { InMemoryStore } from '../memory/in-memory.js';
import { FlintError, makeAiError, isFlintError } from '../types/error.js';
import { ConcurrencyLimiter } from './concurrency.js';
import { FIT_MARGIN, assembleContext, fittedPromptTokens, fixedPromptTokens, messageBudget } from './context.js';
import { resolveCall, type ResolvedCall } from './escape-hatch.js';
import { runToolLoop, type LoopSink } from './tool-loop.js';
import { decodeAssistantTurn } from './encoding.js';
import { newId, now } from './util.js';

/** A tool the app registers: its definition plus the handler that runs it. */
export interface Tool {
  definition: ToolDefinition;
  handler: ToolHandler;
  /**
   * This tool was chosen for the message being asked (a router matched it to
   * the words), where the others are offered on every turn. It changes one
   * thing: when a prompt has to be fitted to a small window
   * (FlintConfig.fitToWindow) and tools must be left out, a tool marked `keep`
   * is left out only after every tool that is not. The order the tools are
   * sent in is never changed by it.
   */
  keep?: boolean;
}

/** Shared inputs for stateless calls. */
export interface GenerateInput {
  system?: string;
  /** Either a ready message list, or a single user prompt string. */
  messages?: Message[];
  prompt?: string;
  tools?: Tool[];
  /**
   * Optional prompt-cache breakpoints, passed straight to the provider. Purely a
   * cost hint — omit it and the call is exactly what it was before.
   */
  cache?: CacheHints;
}

/** Inputs for a memory-backed chat turn. */
export interface ChatInput {
  conversationId: string;
  /** The new user message (string is wrapped into a user Message). */
  message: string | Message;
  system?: string;
  tools?: Tool[];
  /** Optional prompt-cache breakpoints — see GenerateInput.cache. */
  cache?: CacheHints;
}

export interface GenerateOutcome {
  text: string;
  /** The final assistant message. */
  message: Message;
  /** Every response message produced this turn (assistant turns + tool results). */
  messages: Message[];
  usage: TokenUsage;
  reason: StreamDoneReason;
}

/**
 * The entry point. Construct once per app with a provider + config, then call
 * `generate` / `stream` / `chat`. The provider is swappable behind this surface
 * — app code never imports a vendor SDK (the prime directive).
 */
export class Flint {
  private readonly config: FlintConfig;
  private readonly observer: AiObserver;
  private readonly memory: MemoryStore;
  private readonly limiter: ConcurrencyLimiter;

  constructor(config: FlintConfig) {
    this.config = config;
    this.observer = config.observer ?? noopObserver;
    this.memory = config.memory ?? new InMemoryStore();
    this.limiter = new ConcurrencyLimiter(config.maxConcurrent ?? 4);
  }

  /** Capabilities for a model (defaults to the configured model). Query only for unbridgeable gaps. */
  getCapabilities(model?: string): ModelCapabilities {
    return this.config.provider.getCapabilities(model ?? this.config.defaultModel);
  }

  /** The underlying store, for inspection (e.g. reading turn history/status). */
  get store(): MemoryStore {
    return this.memory;
  }

  /**
   * Single-shot generation (no memory). Runs the full tool loop internally but
   * returns a collected result rather than a stream.
   */
  async generate(
    input: GenerateInput,
    options?: CallOptions,
  ): Promise<GenerateOutcome> {
    const sink = freshSink();
    let errored: FlintError | undefined;

    for await (const event of this.streamInternal(input, options, sink)) {
      if (event.type === 'error') {
        errored = new FlintError(event.error);
      }
    }
    if (errored) throw errored;

    return collect(sink);
  }

  /**
   * Streaming generation (no memory). Yields normalized StreamEvents and always
   * ends with exactly one `done` or `error`.
   */
  stream(input: GenerateInput, options?: CallOptions): AsyncIterable<StreamEvent> {
    return this.streamInternal(input, options, freshSink());
  }

  /**
   * Memory-backed chat turn. The user message and the assistant response are
   * committed together ONLY on a successful `done` (transactional, invariant
   * #4). On error, abort, or early break, the turn is failed and leaves no
   * orphaned user message in history.
   */
  async *chat(input: ChatInput, options?: CallOptions): AsyncIterable<StreamEvent> {
    const resolved = resolveCall(this.config, options);
    const userMessage = toUserMessage(input.message);
    const turnId = newId('turn');
    const createdAt = now();

    await this.memory.beginTurn({
      conversationId: input.conversationId,
      turnId,
      userMessage,
      createdAt,
      ...(resolved.context !== undefined ? { context: resolved.context } : {}),
    });

    const history = await this.memory.getMessages(input.conversationId);
    const sink = freshSink();
    let committed = false;
    let failure: FlintError | undefined;

    try {
      const generated = this.runLoop(
        {
          system: input.system,
          cache: input.cache,
          baseMessages: [...history, userMessage],
          tools: input.tools ?? [],
        },
        resolved,
        sink,
      );

      for await (const event of generated) {
        if (event.type === 'error') failure = new FlintError(event.error);
        yield event;
      }

      // A refused turn is not an answer: keeping it would leave the question in
      // history with an empty reply, and a caller that retries the turn on
      // another model would find the question there twice.
      if (!failure && sink.finalReason === 'refusal') {
        failure = new FlintError(
          makeAiError('validation', 'The model declined to answer (refusal); the turn was not saved.', {
            retryable: false,
          }),
        );
      }

      if (!failure && sink.finalReason !== 'error') {
        await this.memory.commitTurn({
          conversationId: input.conversationId,
          turnId,
          responseMessages: sink.responseMessages,
          usage: sink.usage,
          updatedAt: now(),
        });
        committed = true;
      }
    } finally {
      if (!committed) {
        const err =
          failure?.error ??
          makeAiError('internal', 'Chat turn did not complete', { retryable: false });
        await this.memory.failTurn({
          conversationId: input.conversationId,
          turnId,
          error: err,
          updatedAt: now(),
        });
      }
    }
  }

  // --- internals ------------------------------------------------------------

  private streamInternal(
    input: GenerateInput,
    options: CallOptions | undefined,
    sink: LoopSink,
  ): AsyncIterable<StreamEvent> {
    const resolved = resolveCall(this.config, options);
    const baseMessages = resolveMessages(input);
    return this.runLoop(
      { system: input.system, cache: input.cache, baseMessages, tools: input.tools ?? [] },
      resolved,
      sink,
    );
  }

  /** Shared loop driver: context assembly + concurrency + the tool loop. */
  private async *runLoop(
    work: {
      system?: string | undefined;
      cache?: CacheHints | undefined;
      baseMessages: Message[];
      tools: Tool[];
    },
    resolved: ResolvedCall,
    sink: LoopSink,
  ): AsyncGenerator<StreamEvent, void, void> {
    const provider = this.config.provider;
    const caps = provider.getCapabilities(resolved.model);

    const handlers = new Map<string, ToolHandler>();
    const definitions: ToolDefinition[] = [];
    /** The tools chosen for this very message (Tool.keep): the last to be left out of a fitted prompt. */
    const kept = new Set<string>();
    for (const t of work.tools) {
      handlers.set(t.definition.name, t.handler);
      definitions.push(t.definition);
      if (t.keep === true) kept.add(t.definition.name);
    }

    // Reserve output budget, then the system prompt and tool schemas (they share the
    // window with the messages); assemble the messages to fit what is left.
    const reserve = resolved.maxTokens ?? caps.maxOutputTokens;
    const estimate = (m: Message[]): number => provider.estimateTokens(m, resolved.model);
    const fitted = this.config.fitToWindow === true;
    const shed: string[] = [];
    let budget: number;
    let fixed: number;
    if (fitted) {
      // Nothing is sent that does not fit (FlintConfig.fitToWindow). Counted on the safe side (fittedPromptTokens,
      // and a margin of the window left free), because the server's own count is the one that cuts. The messages
      // are owed the newest one, and never less than a quarter of the input window: tools give way for that, the
      // last listed first. A tool chosen for this message (Tool.keep) gives way only when no other is left: a
      // router lists the ones it matched to the words LAST, and those are the ones the turn is most likely to need.
      const input = Math.max(0, caps.maxContextTokens - reserve - Math.ceil(caps.maxContextTokens * FIT_MARGIN));
      const newest = work.baseMessages.length > 0 ? estimate([work.baseMessages[work.baseMessages.length - 1]!]) : 0;
      const owed = Math.min(input, Math.max(newest, Math.floor(input / 4)));
      const listed = definitions.map((d) => d.name);
      while (definitions.length > 0 && fittedPromptTokens(work.system, definitions) > input - owed) {
        let at = definitions.length - 1;
        while (at >= 0 && kept.has(definitions[at]!.name)) at--;
        if (at < 0) at = definitions.length - 1;
        shed.push(definitions.splice(at, 1)[0]!.name);
      }
      // Reported in the order they were listed.
      shed.sort((a, b) => listed.indexOf(a) - listed.indexOf(b));
      fixed = fittedPromptTokens(work.system, definitions);
      budget = input - fixed;
      if (budget < newest) {
        // The system prompt alone leaves no room for the question: said, not sent and cut by the server.
        sink.finalReason = 'error';
        yield {
          type: 'error',
          error: makeAiError('context_overflow', `The prompt does not fit this model's window: ${caps.maxContextTokens} tokens, ${reserve} of them kept for the reply, and the system prompt takes about ${fittedPromptTokens(work.system, [])}.`, { retryable: false }),
        };
        return;
      }
    } else {
      fixed = fixedPromptTokens(work.system, definitions);
      budget = messageBudget(Math.max(0, caps.maxContextTokens - reserve), fixed);
    }

    let assembled: Message[];
    let dropped = 0;
    try {
      const fit = assembleContext({
        messages: work.baseMessages,
        budgetTokens: budget,
        strategy: resolved.contextStrategy,
        estimate,
      });
      assembled = fit.messages;
      dropped = fit.dropped;
    } catch (err) {
      const flintErr = isFlintError(err)
        ? err
        : new FlintError(makeAiError('internal', String(err), { retryable: false }));
      sink.finalReason = 'error';
      yield { type: 'error', error: flintErr.error };
      return;
    }

    const observeContext =
      resolved.context !== undefined ? resolved.context : undefined;
    const requestId = newId('req');

    // How the prompt was sized, before anything is sent: numbers and tool names, nothing of the prompt.
    this.observer.onContext?.({
      requestId,
      provider: provider.name,
      model: resolved.model,
      timestamp: now(),
      context: observeContext,
      windowTokens: caps.maxContextTokens,
      reserveTokens: reserve,
      fixedTokens: fixed,
      budgetTokens: budget,
      messages: { kept: assembled.length, dropped },
      tools: { offered: definitions.length, shed },
      fitted,
    });

    // Debug escape hatch (spec §7.9): when on, surface the unfiltered request
    // and response payloads through the observer. Off by default.
    if (resolved.debug) {
      this.observer.onDebug?.({
        requestId,
        provider: provider.name,
        model: resolved.model,
        timestamp: now(),
        context: observeContext,
        phase: 'request',
        raw: {
          model: resolved.model,
          system: work.system,
          messages: assembled,
          tools: definitions,
          maxTokens: resolved.maxTokens,
        },
      });
    }

    const loop = runToolLoop(
      {
        provider,
        model: resolved.model,
        system: work.system,
        cache: work.cache,
        initialMessages: assembled,
        tools: definitions,
        handlers,
        maxTokens: resolved.maxTokens,
        retryPolicy: resolved.retryPolicy,
        signal: resolved.signal,
        observer: this.observer,
        observe: {
          requestId,
          provider: provider.name,
          context: observeContext,
        },
      },
      sink,
    );

    // The whole turn (including tool-driven continuations) occupies one slot in
    // the per-provider limiter — held from first token to terminal event.
    const release = await this.limiter.acquireSlot();
    try {
      yield* loop;
    } finally {
      release();
      if (resolved.debug) {
        this.observer.onDebug?.({
          requestId,
          provider: provider.name,
          model: resolved.model,
          timestamp: now(),
          context: observeContext,
          phase: 'response',
          raw: {
            messages: sink.responseMessages,
            usage: sink.usage,
            reason: sink.finalReason,
          },
        });
      }
    }
  }
}

function freshSink(): LoopSink {
  return { responseMessages: [], usage: { input: 0, output: 0 }, finalReason: 'complete' };
}

function resolveMessages(input: GenerateInput): Message[] {
  if (input.messages && input.messages.length > 0) return input.messages;
  if (input.prompt !== undefined) return [toUserMessage(input.prompt)];
  throw new FlintError(
    makeAiError('validation', 'GenerateInput requires `messages` or `prompt`', {
      retryable: false,
    }),
  );
}

function toUserMessage(message: string | Message): Message {
  if (typeof message === 'string') {
    return { id: newId('msg'), role: 'user', content: message, timestamp: now() };
  }
  return message;
}

function collect(sink: LoopSink): GenerateOutcome {
  // The final assistant message is the last assistant text turn.
  let finalMessage: Message | undefined;
  let text = '';
  for (const m of sink.responseMessages) {
    if (m.role === 'assistant') {
      finalMessage = m;
      text = m.content;
    } else if (m.role === 'tool') {
      // Carry forward any text that accompanied a tool-call turn.
      const turn = decodeAssistantTurn(m);
      if (turn.text) text = turn.text;
    }
  }
  const message: Message =
    finalMessage ?? {
      id: newId('msg'),
      role: 'assistant',
      content: text,
      timestamp: now(),
    };
  return {
    text,
    message,
    messages: sink.responseMessages,
    usage: sink.usage,
    reason: sink.finalReason,
  };
}
