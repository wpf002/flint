import type { ProviderAdapter, CacheHints } from '../provider/adapter.js';
import type { Message } from '../types/message.js';
import type {
  StreamEvent,
  StreamDoneReason,
  TokenUsage,
} from '../types/stream.js';
import type { ToolCall, ToolDefinition, ToolHandler, ToolResult } from '../types/tool.js';
import type { RetryPolicy } from '../types/config.js';
import type { AiObserver } from '../observability/observer.js';
import { FlintError, isFlintError, makeAiError } from '../types/error.js';
import {
  encodeAssistantText,
  encodeToolCallTurn,
  encodeToolResult,
} from './encoding.js';
import { delay, newId, now } from './util.js';

/** Where the loop deposits the turn's results for the caller to commit. */
export interface LoopSink {
  /** Assistant turns + tool results produced this turn, in order. */
  responseMessages: Message[];
  /** Summed usage across all provider calls in the turn. */
  usage: TokenUsage;
  /** The terminal reason the loop ended on. */
  finalReason: StreamDoneReason;
}

export interface ToolLoopParams {
  provider: ProviderAdapter;
  model: string;
  system: string | undefined;
  /**
   * Optional prompt-cache breakpoints for every provider call in this turn. The
   * loop re-sends the same system + tool prefix on each iteration, so this is
   * where a breakpoint earns most of its money.
   */
  cache: CacheHints | undefined;
  /** Full context to send on the first iteration (history + new user message). */
  initialMessages: Message[];
  tools: ToolDefinition[];
  handlers: Map<string, ToolHandler>;
  maxTokens: number | undefined;
  retryPolicy: RetryPolicy;
  signal: AbortSignal | undefined;
  observer: AiObserver;
  /** Correlation context for observer events. */
  observe: {
    requestId: string;
    provider: string;
    context: unknown;
  };
  /** Hard ceiling on model→tool→model round-trips (runaway guard). */
  maxIterations?: number;
  /** Deterministic jitter source for tests. */
  random?: () => number;
}

const DEFAULT_MAX_ITERATIONS = 6;

/**
 * What the model reads on the answer-only call after the loop runs out of
 * iterations. A user-role note rather than an edit to `system`, so the system
 * prompt (and its cache breakpoint) stays byte-identical; it is sent on that one
 * call only and never lands in `responseMessages`, so it is never stored.
 */
export const TOOL_LIMIT_NOTE =
  '[Note from the runtime, not from the user: the tool-call limit for this turn has been reached, so no more tools can be called. Answer the request now from the tool results above. If something is still unknown, say so in one line.]';

/**
 * The tool-call loop. Lives in Flint, never in apps (locked invariant #3).
 * Yields normalized StreamEvents to the caller as they happen and drives the
 * model→tool→model cycle off `done.reason === 'tool_call'`. Exactly one
 * terminal event is yielded to the caller: a `done` (success) or `error`.
 *
 * If the model is still calling tools after `maxIterations` round-trips, the
 * loop makes ONE more provider call with tool use forbidden and a note asking
 * for an answer from the results so far. Only if that call also fails (or says
 * nothing) does the turn end in an error.
 *
 * On any failure the loop yields an `error` event and stops WITHOUT marking
 * `sink.finalReason` to a terminal success — the caller uses that to keep the
 * turn out of memory (transactional commit, invariant #4).
 */
export async function* runToolLoop(
  params: ToolLoopParams,
  sink: LoopSink,
): AsyncGenerator<StreamEvent, void, void> {
  const maxIterations = params.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const random = params.random ?? Math.random;

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const conversation = [...params.initialMessages, ...sink.responseMessages];

    const streamed = yield* callProvider(params, conversation, random, false);
    if (streamed instanceof FlintError) {
      yield { type: 'error', error: streamed.error };
      return;
    }

    // Accumulate usage across iterations.
    sink.usage = addUsage(sink.usage, streamed.usage);

    if (streamed.reason !== 'tool_call') {
      // Normal completion (or max_tokens / refusal): record assistant text, end the turn.
      sink.responseMessages.push(
        encodeAssistantText(newId('msg'), streamed.text, now()),
      );
      sink.finalReason = streamed.reason;
      yield { type: 'done', reason: streamed.reason, usage: sink.usage };
      return;
    }

    // The model asked for tools. Record the assistant tool-call turn...
    sink.responseMessages.push(
      encodeToolCallTurn(newId('msg'), streamed.text, streamed.toolCalls, now()),
    );

    // ...execute each tool, honoring the idempotency rule, and feed results back.
    try {
      for (const call of streamed.toolCalls) {
        const startedAt = now();
        let result;
        try {
          result = await executeTool(params, call);
        } catch (toolErr) {
          emitToolResult(
            params,
            call,
            { error: toolErr instanceof Error ? toolErr.message : String(toolErr) },
            true,
            now() - startedAt,
          );
          throw toolErr;
        }
        emitToolResult(params, call, result.result, result.isError ?? false, now() - startedAt);
        sink.responseMessages.push(encodeToolResult(newId('msg'), result, now()));
      }
    } catch (err) {
      const flintErr = toFlintError(err);
      emitError(params, flintErr);
      yield { type: 'error', error: flintErr.error };
      return;
    }
    // Loop again with the tool results appended.
  }

  yield* answerFromResults(params, sink, random, maxIterations);
}

/**
 * Out of iterations: one last call with tool use forbidden, asking the model to
 * answer from the tool results it already has. Only this call's own failure (or
 * an empty answer) ends the turn in the error the loop used to throw outright.
 */
async function* answerFromResults(
  params: ToolLoopParams,
  sink: LoopSink,
  random: () => number,
  maxIterations: number,
): AsyncGenerator<StreamEvent, void, void> {
  const exceeded = `Tool loop exceeded ${maxIterations} iterations without completing.`;
  const note: Message = { id: newId('msg'), role: 'user', content: TOOL_LIMIT_NOTE, timestamp: now() };
  const conversation = [...params.initialMessages, ...sink.responseMessages, note];

  const final = yield* callProvider(params, conversation, random, true);
  if (final instanceof FlintError) {
    // callProvider already reported the underlying error to the observer.
    yield {
      type: 'error',
      error: { ...final.error, message: `${exceeded} The answer-only call also failed: ${final.error.message}` },
    };
    return;
  }

  sink.usage = addUsage(sink.usage, final.usage);
  if (final.reason !== 'refusal' && final.text.trim().length === 0) {
    const err = makeAiError('internal', `${exceeded} The answer-only call came back empty.`, {
      retryable: false,
    });
    emitError(params, new FlintError(err));
    yield { type: 'error', error: err };
    return;
  }

  // A provider that ignored the `none` choice may still have asked for a tool:
  // its calls were dropped (never run), and the text it wrote is the answer.
  const reason: StreamDoneReason = final.reason === 'tool_call' ? 'complete' : final.reason;
  sink.responseMessages.push(encodeAssistantText(newId('msg'), final.text, now()));
  sink.finalReason = reason;
  yield { type: 'done', reason, usage: sink.usage };
}

/**
 * One provider call with the loop's retry policy. Retries only when NOTHING was
 * forwarded this attempt (we can't un-yield partial text). Tool side effects are
 * already in `responseMessages`, so re-streaming never re-runs a tool. Returns
 * the streamed result, or the terminal error (already reported to the observer)
 * for the caller to surface.
 */
async function* callProvider(
  params: ToolLoopParams,
  conversation: Message[],
  random: () => number,
  answerOnly: boolean,
): AsyncGenerator<StreamEvent, StreamOnceResult | FlintError, void> {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempt++;
    const forwarded = { content: false };
    try {
      return yield* streamOnce(params, conversation, forwarded, answerOnly);
    } catch (err) {
      const flintErr = toFlintError(err);
      emitError(params, flintErr);

      const canRetry =
        !forwarded.content &&
        flintErr.retryable &&
        attempt < params.retryPolicy.maxAttempts;
      if (!canRetry) return flintErr;

      const backoff = Math.min(
        params.retryPolicy.maxDelayMs,
        params.retryPolicy.baseDelayMs * 2 ** (attempt - 1),
      );
      await delay(Math.floor(backoff * random()), params.signal);
    }
  }
}

function toFlintError(err: unknown): FlintError {
  return isFlintError(err)
    ? err
    : new FlintError(makeAiError('internal', String(err), { retryable: false }));
}

/**
 * Sum two usage records. The cache counters are optional — only providers that
 * cache report them — and dropping them here would hide the saving on exactly
 * the multi-iteration turns where a breakpoint pays off most.
 */
function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  const cacheWrite = addOptional(a.cacheWrite, b.cacheWrite);
  const cacheRead = addOptional(a.cacheRead, b.cacheRead);
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    ...(cacheRead !== undefined ? { cacheRead } : {}),
  };
}

function addOptional(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return a + b;
}

interface StreamOnceResult {
  text: string;
  toolCalls: ToolCall[];
  reason: StreamDoneReason;
  usage: TokenUsage;
}

/**
 * One provider streaming pass. Forwards text/tool_call events to the caller,
 * accumulates them, and returns on the terminal `done`. Throws FlintError on a
 * terminal `error` event so the retry layer can decide what to do.
 */
async function* streamOnce(
  params: ToolLoopParams,
  conversation: Message[],
  forwarded: { content: boolean },
  answerOnly = false,
): AsyncGenerator<StreamEvent, StreamOnceResult, void> {
  const startedAt = now();
  emitRequest(params, conversation, answerOnly ? 'tool-loop-answer' : 'tool-loop');

  let text = '';
  const toolCalls: ToolCall[] = [];

  const iterable = params.provider.stream({
    model: params.model,
    messages: conversation,
    ...(params.tools.length > 0 ? { tools: params.tools } : {}),
    // The answer-only call keeps the tools DEFINED (history holds tool calls,
    // which Anthropic won't accept without them) but forbids using them.
    ...(answerOnly && params.tools.length > 0 ? { toolChoice: 'none' as const } : {}),
    ...(params.system ? { system: params.system } : {}),
    ...(params.cache ? { cache: params.cache } : {}),
    ...(params.maxTokens !== undefined ? { maxTokens: params.maxTokens } : {}),
    ...(params.signal ? { signal: params.signal } : {}),
  });

  for await (const event of iterable) {
    switch (event.type) {
      case 'text':
        text += event.delta;
        forwarded.content = true;
        yield event;
        break;
      case 'tool_call':
        // On the answer-only call a tool request can't be honoured: drop it
        // rather than show the caller a call that will never run.
        if (answerOnly) break;
        toolCalls.push(event.call);
        forwarded.content = true;
        emitToolCallRequested(params, event.call);
        yield event;
        break;
      case 'done':
        emitResponse(params, event.reason, event.usage, now() - startedAt);
        return { text, toolCalls, reason: event.reason, usage: event.usage };
      case 'error':
        throw new FlintError(event.error);
    }
  }

  // Provider ended without a terminal event — contract violation. Treat as error.
  throw new FlintError(
    makeAiError('internal', 'Provider stream ended without done/error event', {
      retryable: false,
    }),
  );
}

/**
 * The tool the model meant. Tool-calling templates expect names like
 * [a-zA-Z0-9_-], so models drop Flint's `server.` namespace (qwen3.8 called
 * `web_search` for `web.web_search`) or swap the dot for a separator. Resolve
 * only when exactly one offered tool fits; otherwise leave it unresolved.
 */
export function resolveToolName(called: string, offered: readonly string[]): string | undefined {
  if (offered.includes(called)) return called;
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const one = (xs: string[]): string | undefined => (xs.length === 1 ? xs[0] : undefined);
  return (
    one(offered.filter((n) => norm(n) === norm(called))) ??
    one(offered.filter((n) => n.endsWith(`.${called}`)))
  );
}

/**
 * Execute one tool call. Idempotency gates auto-retry (locked invariant #5):
 *  - idempotent     → retry the handler up to the policy on failure,
 *  - non-idempotent → run exactly once; a failure surfaces to the app.
 * Either way, exhausted/non-retryable failures throw FlintError to surface for
 * a manual retry decision rather than silently re-running side effects.
 */
async function executeTool(params: ToolLoopParams, call: ToolCall): Promise<ToolResult> {
  const offered = params.tools.map((t) => t.name).filter((n) => params.handlers.has(n));
  const name = resolveToolName(call.toolName, offered);
  if (name === undefined) {
    // Nothing ran, so letting the model try again is safe: tell it which tools
    // exist instead of failing the whole turn on one misspelled name.
    return {
      toolCallId: call.id,
      toolName: call.toolName,
      result: { error: `Unknown tool '${call.toolName}'. Available tools: ${offered.join(', ')}` },
      isError: true,
    };
  }
  const def = params.tools.find((t) => t.name === name)!;
  const handler = params.handlers.get(name)!;
  // The handler sees the real name; the transcript keeps the name the model used.
  const target = name === call.toolName ? call : { ...call, toolName: name };

  const maxAttempts = def.idempotent ? params.retryPolicy.maxAttempts : 1;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await handler(target);
      return { toolCallId: call.id, toolName: call.toolName, result, isError: reportsError(result) };
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) {
        const backoff = Math.min(
          params.retryPolicy.maxDelayMs,
          params.retryPolicy.baseDelayMs * 2 ** (attempt - 1),
        );
        await delay(backoff, params.signal);
        continue;
      }
    }
  }

  const message = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new FlintError(
    makeAiError(
      'internal',
      `Tool '${call.toolName}' failed${def.idempotent ? ' after retries' : ''}: ${message}`,
      { retryable: false, raw: lastErr },
    ),
  );
}

/**
 * Whether a handler's return value is a soft failure. MCP tools (@flint/mcp)
 * return `{ isError: true, content }` when the server reports an error, and
 * built-in tools follow the same shape; that used to be recorded as a success,
 * so the model and the action log both saw a failed call as `ok`.
 */
function reportsError(result: unknown): boolean {
  return typeof result === 'object' && result !== null && (result as { isError?: unknown }).isError === true;
}

// --- observer dispatch (core never calls console.*; invariant #6) -----------

function emitRequest(params: ToolLoopParams, messages: Message[], kind: string): void {
  params.observer.onRequest?.({
    requestId: params.observe.requestId,
    provider: params.observe.provider,
    model: params.model,
    timestamp: now(),
    context: params.observe.context,
    messages,
    ...(params.system ? { system: params.system } : {}),
    toolNames: params.tools.map((t) => t.name),
    kind,
  });
}

function emitResponse(
  params: ToolLoopParams,
  reason: string,
  usage: TokenUsage,
  durationMs: number,
): void {
  params.observer.onResponse?.({
    requestId: params.observe.requestId,
    provider: params.observe.provider,
    model: params.model,
    timestamp: now(),
    context: params.observe.context,
    usage,
    reason,
    durationMs,
  });
}

function emitToolCallRequested(params: ToolLoopParams, call: ToolCall): void {
  const def = params.tools.find((t) => t.name === call.toolName);
  params.observer.onToolCall?.({
    requestId: params.observe.requestId,
    provider: params.observe.provider,
    model: params.model,
    timestamp: now(),
    context: params.observe.context,
    call,
    idempotent: def?.idempotent ?? false,
  });
}

function emitToolResult(
  params: ToolLoopParams,
  call: ToolCall,
  result: unknown,
  isError: boolean,
  durationMs: number,
): void {
  params.observer.onToolResult?.({
    requestId: params.observe.requestId,
    provider: params.observe.provider,
    model: params.model,
    timestamp: now(),
    context: params.observe.context,
    toolCallId: call.id,
    toolName: call.toolName,
    result,
    isError,
    durationMs,
  });
}

function emitError(params: ToolLoopParams, err: FlintError): void {
  params.observer.onError?.({
    requestId: params.observe.requestId,
    provider: params.observe.provider,
    model: params.model,
    timestamp: now(),
    context: params.observe.context,
    error: err.error,
  });
}
