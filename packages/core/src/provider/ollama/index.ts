import type {
  ProviderAdapter,
  GenerateArgs,
  GenerateResult,
} from '../adapter.js';
import type { Message } from '../../types/message.js';
import type { StreamEvent, TokenUsage } from '../../types/stream.js';
import type { ToolCall } from '../../types/tool.js';
import type { ModelCapabilities } from '../../types/capabilities.js';
import { FlintError } from '../../types/error.js';
import { encodeAssistantText, encodeToolCallTurn } from '../../core/encoding.js';
import { newId } from '../../core/util.js';
import { ollamaCapabilities } from './capabilities.js';
import { OllamaHttpError, toAiError } from './errors.js';
import { mapMessages, mapDoneReason } from './mapping.js';

export interface OllamaProviderOptions {
  /** Base URL of the Ollama server. Defaults to http://localhost:11434. */
  baseURL?: string;
  /** Injectable fetch (for tests / custom transports). Defaults to global fetch. */
  fetch?: typeof fetch;
  /** Default Ollama `options` (temperature, num_ctx, …) merged into every call. */
  defaultOptions?: Record<string, unknown>;
}

const DEFAULT_BASE_URL = 'http://localhost:11434';

interface FullResult {
  text: string;
  toolCalls: ToolCall[];
  usage: TokenUsage;
  doneReason: string | undefined;
}

interface OllamaChatChunk {
  message?: {
    role: string;
    content: string;
    tool_calls?: Array<{ function: { name: string; arguments: unknown } }>;
  };
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

  /** Non-streamed call with retry: native tool-calling is reliable only in
   *  non-stream mode, and with many tools qwen occasionally returns an EMPTY
   *  turn (no text, no call). Retry a couple times until it produces something
   *  rather than handing the user back nothing. */
  private async fetchFull(args: GenerateArgs): Promise<FullResult> {
    let last: FullResult = { text: '', toolCalls: [], usage: { input: 0, output: 0 }, doneReason: undefined };
    for (let attempt = 0; attempt < 3; attempt++) {
      last = await this.chatOnce(args, attempt);
      if (last.toolCalls.length > 0 || last.text.trim().length > 0) return last;
    }
    return last;
  }

  private async chatOnce(args: GenerateArgs, attempt = 0): Promise<FullResult> {
    const body = this.buildBody(args, false);
    if (attempt > 0) {
      // Last try came back empty. Nudge the model to commit, and raise the
      // temperature so the retry explores a different path instead of repeating
      // the same empty one.
      const b = body as {
        messages: Array<{ role: string; content: string }>;
        options: Record<string, unknown>;
      };
      b.messages.push({
        role: 'user',
        content:
          '(Your last reply was empty. Answer the question now — if it needs current info like weather, news, prices, or scores, call web_search with a plain query, then state the answer in words.)',
      });
      b.options = { ...b.options, temperature: 0.9 + attempt * 0.15 };
    }
    const resp = await this.fetchImpl(`${this.baseURL}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      ...(args.signal ? { signal: args.signal } : {}),
    });
    if (!resp.ok) throw new OllamaHttpError(resp.status, await safeText(resp));
    const chunk = (await resp.json()) as OllamaChatChunk;
    let toolCalls: ToolCall[] = (chunk.message?.tool_calls ?? []).map((c) => ({
      id: newId('toolu'),
      toolName: c.function.name,
      args: c.function.arguments,
    }));
    let text = chunk.message?.content ?? '';
    // Recovery: with many tools, qwen sometimes dumps the tool call into the
    // text instead of the structured field. Parse it back into a real call so
    // tools still fire reliably.
    if (toolCalls.length === 0 && args.tools && args.tools.length > 0) {
      const recovered = extractTextToolCall(text, args.tools.map((t) => t.name));
      if (recovered) {
        toolCalls = [{ id: newId('toolu'), toolName: recovered.name, args: recovered.arguments }];
        text = '';
      }
    }
    return {
      text,
      toolCalls,
      usage: { input: chunk.prompt_eval_count ?? 0, output: chunk.eval_count ?? 0 },
      doneReason: chunk.done_reason,
    };
  }

  async generate(args: GenerateArgs): Promise<GenerateResult> {
    try {
      const { text, toolCalls, usage, doneReason } = await this.fetchFull(args);
      if (toolCalls.length > 0) {
        return { message: encodeToolCallTurn(newId('msg'), text, toolCalls, 0), usage, reason: 'tool_call' };
      }
      return { message: encodeAssistantText(newId('msg'), text, 0), usage, reason: mapDoneReason(doneReason) };
    } catch (err) {
      throw new FlintError(toAiError(err));
    }
  }

  async *stream(args: GenerateArgs): AsyncIterable<StreamEvent> {
    // The tool-DECISION pass (tools offered, no tool result in history yet) must
    // be reliable, so it's non-streamed with retry-on-empty. But once a tool has
    // run — or there were never any tools — the model is just writing prose, so
    // we STREAM it live: the user sees words as they're generated instead of
    // waiting for the whole answer. (The 14B runs ~13 tok/s, so non-streamed the
    // user stares at nothing for the full generation.)
    const hasTools = !!(args.tools && args.tools.length > 0);
    const lastRole = args.messages[args.messages.length - 1]?.role;
    const answerPass = lastRole === 'tool_result';

    if (hasTools && !answerPass) {
      try {
        const { text, toolCalls, usage, doneReason } = await this.fetchFull(args);
        if (toolCalls.length > 0) {
          for (const call of toolCalls) yield { type: 'tool_call', call };
          yield { type: 'done', reason: 'tool_call', usage };
          return;
        }
        if (text) yield { type: 'text', delta: text };
        yield { type: 'done', reason: mapDoneReason(doneReason), usage };
      } catch (err) {
        yield { type: 'error', error: toAiError(err) };
      }
      return;
    }

    // Live-streamed path: pure chat, or the answer pass after a tool result.
    const usage: TokenUsage = { input: 0, output: 0 };
    let doneReason: string | undefined;
    let sawTool = false;
    let producedAnything = false;
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
        // A tool call can still appear on the answer pass (the model chains
        // another lookup) — surface it so the loop runs it.
        for (const tc of chunk.message?.tool_calls ?? []) {
          sawTool = true;
          producedAnything = true;
          yield { type: 'tool_call', call: { id: newId('toolu'), toolName: tc.function.name, args: tc.function.arguments } };
        }
        const delta = chunk.message?.content ?? '';
        if (delta) {
          producedAnything = true;
          yield { type: 'text', delta };
        }
        if (chunk.done) {
          doneReason = chunk.done_reason;
          usage.input = chunk.prompt_eval_count ?? usage.input;
          usage.output = chunk.eval_count ?? usage.output;
        }
      }

      // Safety net: a streamed answer pass that produced NOTHING (the empty-turn
      // failure mode) falls back to the reliable non-streamed retry path so the
      // user never gets a blank reply.
      if (!producedAnything && answerPass) {
        const full = await this.fetchFull(args);
        if (full.toolCalls.length > 0) {
          for (const call of full.toolCalls) yield { type: 'tool_call', call };
          yield { type: 'done', reason: 'tool_call', usage: full.usage };
          return;
        }
        if (full.text) yield { type: 'text', delta: full.text };
        yield { type: 'done', reason: mapDoneReason(full.doneReason), usage: full.usage };
        return;
      }
      yield { type: 'done', reason: sawTool ? 'tool_call' : mapDoneReason(doneReason), usage };
    } catch (err) {
      yield { type: 'error', error: toAiError(err) };
    }
  }

  // --- internals ------------------------------------------------------------

  private buildBody(args: GenerateArgs, stream: boolean): Record<string, unknown> {
    const options: Record<string, unknown> = { ...this.defaultOptions };
    if (args.maxTokens !== undefined) options.num_predict = args.maxTokens;

    const body: Record<string, unknown> = {
      model: args.model,
      messages: mapMessages(args.messages, args.system),
      stream,
      ...(Object.keys(options).length > 0 ? { options } : {}),
    };
    if (args.tools && args.tools.length > 0) {
      // Native function-calling: hand Ollama the tool schemas directly, instead
      // of describing them in a prompt and parsing the model's free text.
      body.tools = args.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      }));
    }
    return body;
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

/**
 * Recover a tool call the model dumped into its text content (instead of the
 * structured `tool_calls` field) — a common qwen failure mode when many tools
 * are offered. Scans for balanced JSON objects and accepts the first whose name
 * matches a known tool, tolerating leading/trailing garbage and a `tool_call`/
 * `function` wrapper.
 */
function extractTextToolCall(
  text: string,
  toolNames: string[],
): { name: string; arguments: unknown } | null {
  if (!text || text.indexOf('{') === -1) return null;
  const objs: string[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        objs.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  for (const candidate of objs) {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(candidate) as Record<string, unknown>;
    } catch {
      continue;
    }
    const inner = (obj.tool_call ?? obj.function ?? obj) as Record<string, unknown>;
    const name = inner?.name;
    if (typeof name === 'string' && toolNames.includes(name)) {
      const argsv = (inner.arguments ?? inner.args ?? {}) as unknown;
      return { name, arguments: argsv };
    }
  }
  return null;
}

async function safeText(resp: Response): Promise<string> {
  try {
    return await resp.text();
  } catch {
    return `HTTP ${resp.status}`;
  }
}

export { ollamaCapabilities } from './capabilities.js';
