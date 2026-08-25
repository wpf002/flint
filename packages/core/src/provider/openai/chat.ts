import type { ProviderAdapter, GenerateArgs, GenerateResult } from '../adapter.js';
import type { Message } from '../../types/message.js';
import type { StreamEvent, TokenUsage } from '../../types/stream.js';
import type { ToolCall } from '../../types/tool.js';
import type { ModelCapabilities } from '../../types/capabilities.js';
import { FlintError } from '../../types/error.js';
import { encodeAssistantText, encodeToolCallTurn } from '../../core/encoding.js';
import { newId } from '../../core/util.js';
import { OpenAiHttpError, toAiError } from './errors.js';
import { fromOpenAiToolName, mapFinishReason, mapMessages, mapTools, parseArgs } from './mapping.js';

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
}

interface ChatChoice {
  message?: { content?: string | null; tool_calls?: RawToolCall[] };
  delta?: { content?: string | null; tool_calls?: RawDeltaToolCall[] };
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
  usage?: { prompt_tokens?: number; completion_tokens?: number };
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
    // Best-effort heuristic (~4 chars/token). Budgeting only, never billing.
    const chars = messages.reduce((sum, m) => sum + m.content.length, 0);
    return Math.ceil(chars / 4);
  }

  async generate(args: GenerateArgs): Promise<GenerateResult> {
    try {
      const body = this.buildBody(args, false);
      const raw = (await this.post(body, args.signal)) as ChatResponse;

      const choice = raw.choices?.[0];
      const text = choice?.message?.content ?? '';
      const toolCalls: ToolCall[] = (choice?.message?.tool_calls ?? []).map((c) => ({
        id: c.id,
        toolName: fromOpenAiToolName(c.function.name),
        args: parseArgs(c.function.arguments),
        rawProviderPayload: c,
      }));

      const usage: TokenUsage = {
        input: raw.usage?.prompt_tokens ?? 0,
        output: raw.usage?.completion_tokens ?? 0,
      };
      const id = raw.id ?? newId(this.name);
      const message =
        toolCalls.length > 0
          ? encodeToolCallTurn(id, text, toolCalls, 0)
          : encodeAssistantText(id, text, 0);

      return this.decorate({ message, usage, reason: mapFinishReason(choice?.finish_reason) }, raw);
    } catch (err) {
      throw new FlintError(toAiError(err, this.wire.name));
    }
  }

  async *stream(args: GenerateArgs): AsyncIterable<StreamEvent> {
    let usage: TokenUsage = { input: 0, output: 0 };
    let finish: string | null | undefined;

    // Tool calls arrive as fragments keyed by index and must be reassembled.
    const builders = new Map<number, { id: string; name: string; json: string }>();

    // Endpoints that carry extra top-level fields (Perplexity's sources, say) put
    // them on the final chunk, so the last one seen is the one worth keeping.
    let lastChunk: unknown;

    try {
      const body = this.buildBody(args, true);
      const response = await this.send(body, args.signal);
      if (!response.body) throw new OpenAiHttpError(502, 'Response had no body');

      for await (const chunk of readSse(response.body)) {
        const parsed = safeJson(chunk) as ChatResponse | undefined;
        if (!parsed) continue;
        lastChunk = parsed;

        if (parsed.usage) {
          usage = {
            input: parsed.usage.prompt_tokens ?? usage.input,
            output: parsed.usage.completion_tokens ?? usage.output,
          };
        }

        const choice = parsed.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finish = choice.finish_reason;

        const delta = choice.delta;
        if (delta?.content) yield { type: 'text', delta: delta.content };

        for (const frag of delta?.tool_calls ?? []) {
          const existing = builders.get(frag.index) ?? { id: '', name: '', json: '' };
          builders.set(frag.index, {
            id: frag.id ?? existing.id,
            name: frag.function?.name ?? existing.name,
            json: existing.json + (frag.function?.arguments ?? ''),
          });
        }
      }

      /*
       * Emitted at the end rather than on each `content_block_stop`, because this
       * wire has no per-call terminator — a call is only known to be complete once
       * the stream is.
       */
      for (const [, b] of [...builders.entries()].sort((a, z) => a[0] - z[0])) {
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

      const suffix = this.streamSuffix(lastChunk);
      if (suffix) yield { type: 'text', delta: suffix };

      yield { type: 'done', reason: mapFinishReason(finish), usage };
    } catch (err) {
      // Always terminate with exactly one done or error, never just stop.
      yield { type: 'error', error: toAiError(err, this.wire.name) };
    }
  }

  /**
   * Hook for a compatible endpoint to fold its own non-standard response fields into
   * the result. Default is identity: the shared engine models exactly the fields the
   * chat-completions API defines, and anything beyond that is the subclass's business.
   */
  protected decorate(result: GenerateResult, _raw: unknown): GenerateResult {
    return result;
  }

  /** Text appended as a final delta before `done`, for the streaming counterpart. */
  protected streamSuffix(_lastChunk: unknown): string | undefined {
    return undefined;
  }

  private buildBody(args: GenerateArgs, stream: boolean): Record<string, unknown> {
    const tools = this.wire.supportsTools ? mapTools(args.tools) : undefined;
    return {
      model: args.model,
      messages: mapMessages(args.messages, args.system),
      [this.wire.maxTokensField]: args.maxTokens ?? this.wire.defaultMaxTokens,
      ...(tools ? { tools } : {}),
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
  const message = parsed?.error?.message ?? describeBody(text) ?? response.statusText;
  const code = parsed?.error?.code ?? parsed?.error?.type;
  return new OpenAiHttpError(response.status, message || response.statusText, code);
}

/**
 * An edge under load answers with its own web page rather than the API's error shape.
 * Pasting that into the message buried every log line under a page of markup and said
 * nothing the status code had not already said.
 */
function describeBody(text: string): string | undefined {
  const body = text.trim();
  if (body.length === 0) return undefined;
  if (/^<(!doctype|html)/i.test(body)) {
    return 'the endpoint returned a web page instead of a response, which usually means its edge is failing rather than the API';
  }
  return body.slice(0, 300);
}

/**
 * Yields the payload of each SSE `data:` line, stopping at `[DONE]`.
 *
 * Buffers across reads because a chunk boundary lands mid-event often enough that
 * parsing per-read would silently drop tokens.
 */
async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
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
    reader.releaseLock();
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
