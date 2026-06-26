import type { ProviderAdapter } from '../provider/adapter.js';
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

const DEFAULT_MAX_ITERATIONS = 16;

/**
 * The tool-call loop. Lives in Flint, never in apps (locked invariant #3).
 * Yields normalized StreamEvents to the caller as they happen and drives the
 * model→tool→model cycle off `done.reason === 'tool_call'`. Exactly one
 * terminal event is yielded to the caller: a `done` (success) or `error`.
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

    let attempt = 0;
    let streamed: StreamOnceResult | undefined;

    // Provider-call retry: only retry when NOTHING was forwarded this attempt
    // (we can't un-yield partial text). Tool side effects are already in
    // `responseMessages`, so re-streaming never re-runs a tool.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      attempt++;
      const forwarded = { content: false };
      try {
        streamed = yield* streamOnce(params, conversation, forwarded);
        break;
      } catch (err) {
        const flintErr = isFlintError(err)
          ? err
          : new FlintError(makeAiError('internal', String(err), { retryable: false }));

        emitError(params, flintErr);

        const canRetry =
          !forwarded.content &&
          flintErr.retryable &&
          attempt < params.retryPolicy.maxAttempts;

        if (!canRetry) {
          yield { type: 'error', error: flintErr.error };
          return;
        }

        const backoff = Math.min(
          params.retryPolicy.maxDelayMs,
          params.retryPolicy.baseDelayMs * 2 ** (attempt - 1),
        );
        await delay(Math.floor(backoff * random()), params.signal);
      }
    }

    if (!streamed) return; // unreachable; satisfies the type checker

    // Accumulate usage across iterations.
    sink.usage = {
      input: sink.usage.input + streamed.usage.input,
      output: sink.usage.output + streamed.usage.output,
    };

    if (streamed.reason !== 'tool_call') {
      // Normal completion (or max_tokens): record assistant text, end the turn.
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
      const flintErr = isFlintError(err)
        ? err
        : new FlintError(makeAiError('internal', String(err), { retryable: false }));
      emitError(params, flintErr);
      yield { type: 'error', error: flintErr.error };
      return;
    }
    // Loop again with the tool results appended.
  }

  // Ran out of iterations — surface as an error; do not commit a partial turn.
  const err = makeAiError(
    'internal',
    `Tool loop exceeded ${maxIterations} iterations without completing.`,
    { retryable: false },
  );
  emitError(params, new FlintError(err));
  yield { type: 'error', error: err };
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
): AsyncGenerator<StreamEvent, StreamOnceResult, void> {
  const startedAt = now();
  emitRequest(params, conversation, 'tool-loop');

  let text = '';
  const toolCalls: ToolCall[] = [];

  const iterable = params.provider.stream({
    model: params.model,
    messages: conversation,
    ...(params.tools.length > 0 ? { tools: params.tools } : {}),
    ...(params.system ? { system: params.system } : {}),
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
 * Execute one tool call. Idempotency gates auto-retry (locked invariant #5):
 *  - idempotent     → retry the handler up to the policy on failure,
 *  - non-idempotent → run exactly once; a failure surfaces to the app.
 * Either way, exhausted/non-retryable failures throw FlintError to surface for
 * a manual retry decision rather than silently re-running side effects.
 */
async function executeTool(params: ToolLoopParams, call: ToolCall): Promise<ToolResult> {
  const def = params.tools.find((t) => t.name === call.toolName);
  const handler = params.handlers.get(call.toolName);

  if (!def || !handler) {
    throw new FlintError(
      makeAiError('validation', `No handler registered for tool '${call.toolName}'`, {
        retryable: false,
      }),
    );
  }

  const maxAttempts = def.idempotent ? params.retryPolicy.maxAttempts : 1;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await handler(call);
      return { toolCallId: call.id, toolName: call.toolName, result, isError: false };
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
