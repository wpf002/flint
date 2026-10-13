import type { ProviderAdapter, GenerateArgs, GenerateResult } from '../adapter.js';
import { estimateMessageTokens, type Message } from '../../types/message.js';
import type { StreamEvent, TokenUsage } from '../../types/stream.js';
import type { ToolCall } from '../../types/tool.js';
import type { ModelCapabilities } from '../../types/capabilities.js';
import { FlintError } from '../../types/error.js';
import { encodeAssistantText, encodeToolCallTurn } from '../../core/encoding.js';
import { newId } from '../../core/util.js';
import { OpenAiHttpError, toAiError } from './errors.js';
import { fromOpenAiToolName, mapFinishReason, mapMessages, mapTools, parseArgs } from './mapping.js';
import { responseFormatName } from '../response-format.js';
import { raceAbort, readDeadline, startDeadline, type DeadlineMs } from '../deadline.js';

/**
 * The chat-completions wire format, as spoken by OpenAI and by everyone who cloned
 * it. Written against plain `fetch` rather than a vendor SDK for one specific reason:
 * the compatible endpoints differ only in small, declarable ways — base URL, which
 * field carries the output cap, whether functions exist at all — so one honest
 * implementation plus a config object covers all of them, and a new one costs a table
 * entry instead of a package.
 */
export interface ChatWire {
  /** Provider name, surfaced on the adapter and in error messages. */
  name: string;
  baseURL: string;
  apiKey: string;
  /** OpenAI's newer models want `max_completion_tokens`; the compatibles want `max_tokens`. */
  maxTokensField: 'max_tokens' | 'max_completion_tokens';
  /** False for endpoints with no function-calling at all (a search model, say). */
  supportsTools: boolean;
  capabilities: (model: string) => ModelCapabilities;
  defaultMaxTokens: number;
  /** Injectable fetch, for tests and custom transports. */
  fetch?: typeof fetch;
  /** Fields merged into every request body (e.g. a search filter). */
  extraBody?: Record<string, unknown>;
  headers?: Record<string, string>;
  /*
   * The fields below are for endpoints that can stall rather than fail (a local
   * model server whose model is cold). All are off unless set, and a wire that
   * sets none of them sends exactly the requests it always did.
   */
  /**
   * ms from sending a streamed call that starts a turn to its first sign of
   * output (text, a tool call, or reasoning). Past it the call ends with a
   * `timeout` error whose providerCode is `first_token_timeout`, not retryable.
   * Like the two below, a number or a function read on every call (DeadlineMs).
   */
  firstTokenTimeoutMs?: DeadlineMs;
  /** The same for a call that follows a tool result (the last message is one). Unset: firstTokenTimeoutMs. */
  toolPassTimeoutMs?: DeadlineMs;
  /** ms for a non-streamed generate() to answer (providerCode `request_timeout`). */
  requestTimeoutMs?: DeadlineMs;
  /**
   * ms a streamed reply may go quiet once it has begun, between one piece and
   * the next (providerCode `idle_timeout`). A model that sends one delta and
   * then nothing would otherwise hold the turn until the caller gave up.
   */
  idleTimeoutMs?: DeadlineMs;
  /**
   * How `toolChoice: 'none'` is sent: `send` (the default) keeps the tools
   * defined and sends the API's own `tool_choice: "none"`; `drop_tools` leaves
   * the tools out instead, for a server with no such knob (Ollama's /v1).
   */
  toolChoiceNone?: 'send' | 'drop_tools';
  /** Never follow a redirect: a server at a fixed address has no reason to send one. */
  refuseRedirects?: boolean;
}

interface ChatChoice {
  /** `refusal` is set (and `content` null) when the model declines to answer. */
  message?: { content?: string | null; refusal?: string | null; tool_calls?: RawToolCall[] };
  delta?: {
    content?: string | null;
    refusal?: string | null;
    tool_calls?: RawDeltaToolCall[];
    /** A thinking model's reasoning (Ollama: `reasoning`; llama.cpp: `reasoning_content`). Never the answer. */
    reasoning?: string | null;
    reasoning_content?: string | null;
  };
  finish_reason?: string | null;
}

interface RawToolCall {
  id: string;
  function: { name: string; arguments: string };
}

interface RawDeltaToolCall {
  index: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface ChatResponse {
  id?: string;
  choices?: ChatChoice[];
  usage?: ChatUsage;
}

interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  /** The part of the prompt served from OpenAI's cache, billed at a tenth of the rate. */
  prompt_tokens_details?: { cached_tokens?: number | null } | null;
}

/**
 * Token counts in Flint's shape. prompt_tokens includes the cached part; it is reported
 * separately as cacheRead, which is what a cost has to be worked out from.
 */
function toUsage(raw: ChatUsage | undefined, fallback: TokenUsage = { input: 0, output: 0 }): TokenUsage {
  if (!raw) return fallback;
  const cached = raw.prompt_tokens_details?.cached_tokens;
  return {
    input: raw.prompt_tokens ?? fallback.input,
    output: raw.completion_tokens ?? fallback.output,
    ...(typeof cached === 'number' && cached > 0 ? { cacheRead: cached } : {}),
  };
}

export class OpenAiCompatibleProvider implements ProviderAdapter {
  readonly name: string;
  protected readonly wire: ChatWire;

  constructor(wire: ChatWire) {
    if (!wire.apiKey) {
      throw new Error(`${wire.name} requires an apiKey (Flint never reads process.env).`);
    }
    this.name = wire.name;
    this.wire = wire;
  }

  getCapabilities(model: string): ModelCapabilities {
    return this.wire.capabilities(model);
  }

  estimateTokens(messages: Message[], _model: string): number {
    // Best-effort heuristic (~4 chars/token + a per-attachment cost). Budgeting only.
    return estimateMessageTokens(messages);
  }

  async generate(args: GenerateArgs): Promise<GenerateResult> {
    // A deadline of the wire's own on the whole reply (off unless the wire sets one).
    const guard = startDeadline('request', readDeadline(this.wire.requestTimeoutMs), args.signal);
    try {
      const body = this.buildBody(args, false);
      const raw = (await (guard.active ? raceAbort(this.post(body, guard.signal), guard.signal) : this.post(body, args.signal))) as ChatResponse;

      const choice = raw.choices?.[0];
      const text = choice?.message?.content ?? '';
      const toolCalls: ToolCall[] = (choice?.message?.tool_calls ?? []).map((c) => ({
        id: c.id,
        toolName: fromOpenAiToolName(c.function.name),
        args: parseArgs(c.function.arguments),
        rawProviderPayload: c,
      }));

      const usage = toUsage(raw.usage);
      const id = raw.id ?? newId(this.name);
      const message =
        toolCalls.length > 0
          ? encodeToolCallTurn(id, text, toolCalls, 0)
          : encodeAssistantText(id, text, 0);

      const reason = choice?.message?.refusal ? 'refusal' : mapFinishReason(choice?.finish_reason);
      return this.decorate({ message, usage, reason }, raw, args);
    } catch (err) {
      throw new FlintError(toAiError(guard.fired() ?? err, this.wire.name));
    } finally {
      guard.dispose();
    }
  }

  async *stream(args: GenerateArgs): AsyncIterable<StreamEvent> {
    let usage: TokenUsage = { input: 0, output: 0 };
    let finish: string | null | undefined;
    // The refusal text itself is not emitted: the reason carries the signal, and
    // the caller decides what to tell the user.
    let refused = false;

    // Tool calls arrive as fragments keyed by index and must be reassembled. A fragment
    // with no index continues the call before it; and a NEW id where a call with another
    // id already sits is another call (some local servers send every call at index 0, or
    // with no index at all: keyed by index alone, the second overwrote the first).
    interface CallBuilder {
      index: number | undefined;
      id: string;
      name: string;
      json: string;
    }
    const calls: CallBuilder[] = [];
    const byIndex = new Map<number, CallBuilder>();
    let lastCall: CallBuilder | undefined;

    // Endpoints that carry extra top-level fields (Perplexity's sources, say) put
    // them on the final chunk, so the last one seen is the one worth keeping.
    let lastChunk: unknown;
    // The first sign of output has arrived: from here the idle clock runs between pieces.
    let started = false;

    // The wire's own deadlines: on the first sign of output, and then between one piece of the
    // reply and the next (both off unless the wire sets them).
    const idleMs = readDeadline(this.wire.idleTimeoutMs);
    const guard = startDeadline('first_token', this.firstTokenMs(args), args.signal, { always: idleMs !== undefined });

    try {
      const body = this.buildBody(args, true);
      const response = await (guard.active ? raceAbort(this.send(body, guard.signal), guard.signal) : this.send(body, args.signal));
      if (!response.body) throw new OpenAiHttpError(502, 'Response had no body');

      for await (const chunk of readSse(response.body, guard.active ? guard.signal : undefined)) {
        const parsed = safeJson(chunk) as (ChatResponse & { error?: unknown }) | undefined;
        if (!parsed) continue;
        // An error sent inside the stream (llama.cpp and Ollama's /v1 do this once the 200 is
        // out): the call failed. It used to be skipped as a chunk with no choices, and the
        // turn ended `complete` with whatever text had arrived, or none.
        if (parsed.error !== undefined && parsed.error !== null && !parsed.choices?.length) throw inStreamError(parsed.error);
        lastChunk = parsed;
        // Anything at all from the server restarts the idle clock, once the reply has begun.
        if (guard.active && started) guard.rearm('idle', idleMs);

        if (parsed.usage) usage = toUsage(parsed.usage, usage);

        const choice = parsed.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finish = choice.finish_reason;

        const delta = choice.delta;
        // Any sign the model is producing something ends the first-token deadline. Reasoning
        // counts (the model is working) but is never emitted: only `content` is the answer.
        if (!started && (delta?.content || delta?.refusal || delta?.reasoning || delta?.reasoning_content || (delta?.tool_calls?.length ?? 0) > 0 || choice.finish_reason)) {
          started = true;
          guard.rearm('idle', idleMs);
        }
        if (delta?.refusal) refused = true;
        if (delta?.content) yield { type: 'text', delta: delta.content };

        for (const frag of delta?.tool_calls ?? []) {
          const index = typeof frag.index === 'number' ? frag.index : undefined;
          let b = index !== undefined ? byIndex.get(index) : lastCall;
          if (!b || (frag.id && b.id && frag.id !== b.id)) {
            b = { index, id: '', name: '', json: '' };
            calls.push(b);
            if (index !== undefined) byIndex.set(index, b);
          }
          lastCall = b;
          b.id = frag.id ?? b.id;
          b.name = frag.function?.name ?? b.name;
          b.json += frag.function?.arguments ?? '';
        }
      }

      /*
       * Emitted at the end rather than on each `content_block_stop`, because this
       * wire has no per-call terminator — a call is only known to be complete once
       * the stream is.
       */
      // By index, as the API numbers them; calls that share an index (or have none) keep the order they arrived in.
      const ordered = calls.map((b, seen) => ({ b, seen })).sort((x, y) => (x.b.index ?? x.seen) - (y.b.index ?? y.seen) || x.seen - y.seen);
      for (const { b } of ordered) {
        if (!b.name) continue;
        yield {
          type: 'tool_call',
          call: {
            id: b.id || newId('call'),
            toolName: fromOpenAiToolName(b.name),
            args: parseArgs(b.json),
          },
        };
      }

      const suffix = this.streamSuffix(lastChunk, args);
      if (suffix) yield { type: 'text', delta: suffix };

      yield { type: 'done', reason: refused ? 'refusal' : mapFinishReason(finish), usage };
    } catch (err) {
      // Always terminate with exactly one done or error, never just stop.
      yield { type: 'error', error: toAiError(guard.fired() ?? err, this.wire.name) };
    } finally {
      guard.dispose();
    }
  }

  /** The first-token deadline for this call: the tool-pass one after a tool result, when set. */
  private firstTokenMs(args: GenerateArgs): number | undefined {
    const afterTool = args.messages[args.messages.length - 1]?.role === 'tool_result';
    const first = readDeadline(this.wire.firstTokenTimeoutMs);
    return afterTool && this.wire.toolPassTimeoutMs !== undefined ? readDeadline(this.wire.toolPassTimeoutMs) : first;
  }

  /**
   * Hook for a compatible endpoint to fold its own non-standard response fields into
   * the result. Default is identity: the shared engine models exactly the fields the
   * chat-completions API defines, and anything beyond that is the subclass's business.
   * `args` is the request, so a hook can leave a constrained reply (responseFormat),
   * whose text must stay exactly the JSON, alone.
   */
  protected decorate(result: GenerateResult, _raw: unknown, _args?: GenerateArgs): GenerateResult {
    return result;
  }

  /** Text appended as a final delta before `done`, for the streaming counterpart. */
  protected streamSuffix(_lastChunk: unknown, _args?: GenerateArgs): string | undefined {
    return undefined;
  }

  private buildBody(args: GenerateArgs, stream: boolean): Record<string, unknown> {
    // responseFormat replaces the caller's tools (see GenerateArgs.responseFormat):
    // offered both, the model may answer with a tool call and no JSON at all.
    const caps = this.wire.capabilities(args.model);
    // Tools go only to a model that can call them: the wire has function calling at
    // all, and this model's capability is not `unsupported` (a local model may not be).
    const offered = this.wire.supportsTools && caps.toolCalling !== 'unsupported' && !args.responseFormat;
    // An endpoint with no `tool_choice` honours `none` by not being offered the tools.
    const dropped = args.toolChoice === 'none' && this.wire.toolChoiceNone === 'drop_tools';
    const tools = offered && !dropped ? mapTools(args.tools) : undefined;
    return {
      model: args.model,
      messages: mapMessages(args.messages, args.system, {
        vision: caps.vision === true,
        pdfInput: caps.pdfInput === true,
      }),
      [this.wire.maxTokensField]: args.maxTokens ?? this.wire.defaultMaxTokens,
      ...(tools ? { tools } : {}),
      // Only `none` is mapped (the tool loop's answer-only call); every other request
      // is byte-identical to before.
      ...(tools && args.toolChoice === 'none' ? { tool_choice: 'none' } : {}),
      // responseFormat: OpenAI's own structured output. Not strict: a strict schema
      // must list every property as required and forbid extras, which callers'
      // schemas need not.
      ...(args.responseFormat
        ? { response_format: { type: 'json_schema', json_schema: { name: responseFormatName(args.responseFormat), schema: args.responseFormat.schema, strict: false } } }
        : {}),
      ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
      ...this.wire.extraBody,
    };
  }

  private async send(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    const doFetch = this.wire.fetch ?? fetch;
    const response = await doFetch(`${this.wire.baseURL.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.wire.apiKey}`,
        ...this.wire.headers,
      },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
      ...(this.wire.refuseRedirects ? { redirect: 'error' as const } : {}),
    });

    if (!response.ok) throw await httpError(response);
    return response;
  }

  private async post(body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const response = await this.send(body, signal);
    return response.json();
  }
}

/** Turn a non-2xx response into an error carrying the API's own code where present. */
async function httpError(response: Response): Promise<OpenAiHttpError> {
  const text = await response.text().catch(() => '');
  const parsed = safeJson(text) as { error?: { message?: string; code?: string; type?: string } } | undefined;
  const message = parsed?.error?.message ?? describeBody(text, response.status) ?? response.statusText;
  const code = parsed?.error?.code ?? parsed?.error?.type;
  return new OpenAiHttpError(response.status, message || response.statusText, code);
}

/**
 * An edge under load answers with its own web page rather than the API's error shape.
 * Pasting that into the message buried every log line under a page of markup and said
 * nothing the status code had not already said.
 */
function describeBody(text: string, status?: number): string | undefined {
  const body = text.trim();
  if (body.length === 0) return undefined;
  if (/^<(!doctype|html)/i.test(body)) {
    /*
     * The status and the page's title, and nothing else from it. Without them a 502
     * outage and a bot-check page served to a datacenter IP read the same, and they
     * have opposite fixes: wait it out, or change where the request comes from.
     */
    const title = /<title[^>]*>([^<]{1,120})<\/title>/i.exec(body)?.[1]?.trim();
    const detail = [status ? `HTTP ${status}` : null, title ? `"${title}"` : null].filter(Boolean).join(', ');
    return `the endpoint returned a web page instead of a response${detail ? ` (${detail})` : ''}, which usually means its edge is failing rather than the API`;
  }
  return body.slice(0, 300);
}

/**
 * Yields the payload of each SSE `data:` line, stopping at `[DONE]`.
 *
 * Buffers across reads because a chunk boundary lands mid-event often enough that
 * parsing per-read would silently drop tokens.
 */
async function* readSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      // With a deadline, a read gives up when it fires even if the transport ignores the signal.
      const { done, value } = await (signal ? raceAbort(reader.read(), signal) : reader.read());
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');

        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') return;
        if (payload.length > 0) yield payload;
      }
    }
  } finally {
    // A stream abandoned at its deadline is closed, not left open behind the turn.
    if (signal?.aborted) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/**
 * An `error` object a server sent inside a 200 stream, as the failure it is.
 * The status is the error's own when it is one (llama.cpp sends `code: 503`),
 * else 502: the upstream answered, and what it answered was a failure.
 */
function inStreamError(error: unknown): OpenAiHttpError {
  const e = (typeof error === 'object' && error !== null ? error : { message: String(error) }) as { message?: unknown; code?: unknown; type?: unknown };
  const numeric = typeof e.code === 'number' ? e.code : typeof e.code === 'string' && /^\d{3}$/.test(e.code) ? Number(e.code) : undefined;
  const status = numeric !== undefined && numeric >= 400 && numeric <= 599 ? numeric : 502;
  const code = typeof e.code === 'string' && !/^\d{3}$/.test(e.code) ? e.code : typeof e.type === 'string' ? e.type : undefined;
  return new OpenAiHttpError(status, typeof e.message === 'string' && e.message ? e.message : 'the server sent an error in the middle of its reply', code);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
