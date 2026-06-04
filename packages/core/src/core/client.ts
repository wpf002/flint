import type { FlintConfig, CallOptions } from '../types/config.js';
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
import { assembleContext } from './context.js';
import { resolveCall, type ResolvedCall } from './escape-hatch.js';
import { runToolLoop, type LoopSink } from './tool-loop.js';
import { decodeAssistantTurn } from './encoding.js';
import { newId, now } from './util.js';

/** A tool the app registers: its definition plus the handler that runs it. */
export interface Tool {
  definition: ToolDefinition;
  handler: ToolHandler;
}

/** Shared inputs for stateless calls. */
export interface GenerateInput {
  system?: string;
  /** Either a ready message list, or a single user prompt string. */
  messages?: Message[];
  prompt?: string;
  tools?: Tool[];
}

/** Inputs for a memory-backed chat turn. */
export interface ChatInput {
  conversationId: string;
  /** The new user message (string is wrapped into a user Message). */
  message: string | Message;
  system?: string;
  tools?: Tool[];
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
      { system: input.system, baseMessages, tools: input.tools ?? [] },
      resolved,
      sink,
    );
  }

  /** Shared loop driver: context assembly + concurrency + the tool loop. */
  private async *runLoop(
    work: { system?: string | undefined; baseMessages: Message[]; tools: Tool[] },
    resolved: ResolvedCall,
    sink: LoopSink,
  ): AsyncGenerator<StreamEvent, void, void> {
    const provider = this.config.provider;
    const caps = provider.getCapabilities(resolved.model);

    // Reserve output budget; assemble input to fit the remaining context.
    const reserve = resolved.maxTokens ?? caps.maxOutputTokens;
    const budget = Math.max(0, caps.maxContextTokens - reserve);

    let assembled: Message[];
    try {
      assembled = assembleContext({
        messages: work.baseMessages,
        budgetTokens: budget,
        strategy: resolved.contextStrategy,
        estimate: (m) => provider.estimateTokens(m, resolved.model),
      }).messages;
    } catch (err) {
      const flintErr = isFlintError(err)
        ? err
        : new FlintError(makeAiError('internal', String(err), { retryable: false }));
      sink.finalReason = 'error';
      yield { type: 'error', error: flintErr.error };
      return;
    }

    const handlers = new Map<string, ToolHandler>();
    const definitions: ToolDefinition[] = [];
    for (const t of work.tools) {
      handlers.set(t.definition.name, t.handler);
      definitions.push(t.definition);
    }

    const observeContext =
      resolved.context !== undefined ? resolved.context : undefined;
    const requestId = newId('req');

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
