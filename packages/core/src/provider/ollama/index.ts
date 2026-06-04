import type {
  ProviderAdapter,
  GenerateArgs,
  GenerateResult,
} from '../adapter.js';
import type { Message } from '../../types/message.js';
import type { StreamEvent, TokenUsage, StreamDoneReason } from '../../types/stream.js';
import type { ToolCall } from '../../types/tool.js';
import type { ModelCapabilities } from '../../types/capabilities.js';
import { FlintError } from '../../types/error.js';
import { encodeAssistantText, encodeToolCallTurn } from '../../core/encoding.js';
import { newId } from '../../core/util.js';
import { ollamaCapabilities } from './capabilities.js';
import { OllamaHttpError, toAiError } from './errors.js';
import { mapMessages, mapDoneReason } from './mapping.js';
import { buildToolSystemPrompt, extractToolCall } from './tool-protocol.js';

export interface OllamaProviderOptions {
  /** Base URL of the Ollama server. Defaults to http://localhost:11434. */
  baseURL?: string;
  /** Injectable fetch (for tests / custom transports). Defaults to global fetch. */
  fetch?: typeof fetch;
  /** Default Ollama `options` (temperature, num_ctx, …) merged into every call. */
  defaultOptions?: Record<string, unknown>;
}

const DEFAULT_BASE_URL = 'http://localhost:11434';

interface OllamaChatChunk {
  message?: { role: string; content: string };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

/**
 * Phase 2 provider — local models via Ollama's HTTP API. Same `ProviderAdapter`
 * contract as Anthropic; nothing in `core/` knows the difference. Reports honest
 * lower capabilities and owns the prompted tool-calling protocol.
 */
export class OllamaProvider implements ProviderAdapter {
  readonly name = 'ollama';
  private readonly baseURL: string;
  private readonly fetchImpl: typeof fetch;
  private readonly defaultOptions: Record<string, unknown>;

  constructor(opts: OllamaProviderOptions = {}) {
    this.baseURL = (opts.baseURL ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.fetchImpl = opts.fetch ?? fetch;
    this.defaultOptions = opts.defaultOptions ?? {};
  }

  getCapabilities(model: string): ModelCapabilities {
    return ollamaCapabilities(model);
  }

  estimateTokens(messages: Message[], _model: string): number {
    const chars = messages.reduce((sum, m) => sum + m.content.length, 0);
    return Math.ceil(chars / 4);
  }

  async generate(args: GenerateArgs): Promise<GenerateResult> {
    try {
      const body = this.buildBody(args, false);
      const resp = await this.fetchImpl(`${this.baseURL}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        ...(args.signal ? { signal: args.signal } : {}),
      });
      if (!resp.ok) throw new OllamaHttpError(resp.status, await safeText(resp));

      const chunk = (await resp.json()) as OllamaChatChunk;
      const text = chunk.message?.content ?? '';
      const usage: TokenUsage = {
        input: chunk.prompt_eval_count ?? 0,
        output: chunk.eval_count ?? 0,
      };

      const { message, reason } = this.interpret(text, args, chunk.done_reason);
      return { message, usage, reason };
    } catch (err) {
      throw new FlintError(toAiError(err));
    }
  }

  async *stream(args: GenerateArgs): AsyncIterable<StreamEvent> {
    const hasTools = Boolean(args.tools && args.tools.length > 0);
    let buffered = '';
    const usage: TokenUsage = { input: 0, output: 0 };
    let doneReason: string | undefined;

    try {
      const body = this.buildBody(args, true);
      const resp = await this.fetchImpl(`${this.baseURL}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        ...(args.signal ? { signal: args.signal } : {}),
      });
      if (!resp.ok) throw new OllamaHttpError(resp.status, await safeText(resp));
      if (!resp.body) throw new OllamaHttpError(502, 'Ollama returned no response body');

      for await (const line of readNdjson(resp.body)) {
        const chunk = JSON.parse(line) as OllamaChatChunk;
        const delta = chunk.message?.content ?? '';
        if (delta) {
          buffered += delta;
          // In the prompted-tools regime we can't stream live (the text might
          // BE a tool-call JSON) — buffer and decide at the end. Without tools,
          // stream tokens as they arrive.
          if (!hasTools) yield { type: 'text', delta };
        }
        if (chunk.done) {
          doneReason = chunk.done_reason;
          usage.input = chunk.prompt_eval_count ?? usage.input;
          usage.output = chunk.eval_count ?? usage.output;
        }
      }

      if (hasTools) {
        const call = extractToolCall(buffered);
        if (call) {
          const toolCall: ToolCall = {
            id: newId('toolu'),
            toolName: call.name,
            args: call.arguments,
          };
          yield { type: 'tool_call', call: toolCall };
          yield { type: 'done', reason: 'tool_call', usage };
          return;
        }
        // No tool call — emit the buffered answer as text now.
        if (buffered) yield { type: 'text', delta: buffered };
      }

      yield { type: 'done', reason: mapDoneReason(doneReason), usage };
    } catch (err) {
      yield { type: 'error', error: toAiError(err) };
    }
  }

  // --- internals ------------------------------------------------------------

  private buildBody(args: GenerateArgs, stream: boolean): Record<string, unknown> {
    const systemParts: string[] = [];
    if (args.system) systemParts.push(args.system);
    if (args.tools && args.tools.length > 0) {
      systemParts.push(buildToolSystemPrompt(args.tools));
    }
    const systemPrefix = systemParts.length > 0 ? systemParts.join('\n\n') : undefined;

    const options: Record<string, unknown> = { ...this.defaultOptions };
    if (args.maxTokens !== undefined) options.num_predict = args.maxTokens;

    return {
      model: args.model,
      messages: mapMessages(args.messages, systemPrefix),
      stream,
      ...(Object.keys(options).length > 0 ? { options } : {}),
    };
  }

  /** Shared text→Message interpretation for the non-streaming path. */
  private interpret(
    text: string,
    args: GenerateArgs,
    doneReason: string | undefined,
  ): { message: Message; reason: StreamDoneReason } {
    if (args.tools && args.tools.length > 0) {
      const call = extractToolCall(text);
      if (call) {
        const toolCall: ToolCall = {
          id: newId('toolu'),
          toolName: call.name,
          args: call.arguments,
        };
        return {
          message: encodeToolCallTurn(newId('msg'), '', [toolCall], 0),
          reason: 'tool_call',
        };
      }
    }
    return {
      message: encodeAssistantText(newId('msg'), text, 0),
      reason: mapDoneReason(doneReason),
    };
  }
}

/** Read a web ReadableStream of bytes as newline-delimited JSON lines. */
async function* readNdjson(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) yield line;
      }
    }
    const tail = buffer.trim();
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}

async function safeText(resp: Response): Promise<string> {
  try {
    return await resp.text();
  } catch {
    return `HTTP ${resp.status}`;
  }
}

export { ollamaCapabilities } from './capabilities.js';
