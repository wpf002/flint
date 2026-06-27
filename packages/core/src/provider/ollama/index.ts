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
      const recovered = extractTextToolCall(text, args.tools);
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
    const toolDefs = args.tools ?? [];
    // Some smaller models (notably llama3.1) emit a tool call as TEXT — a bare
    // `{"name":...,"parameters":...}` JSON object — instead of a structured tool
    // call. If the streamed content starts with `{`, we don't stream it raw
    // (that would leak JSON to the user); we buffer it and try to recover a real
    // tool call at the end. Prose answers (the common case) stream live as before.
    let buf = '';
    let mode: 'undecided' | 'stream' | 'buffer' = 'undecided';
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
        // A properly-structured tool call on the answer pass (model chains a
        // lookup) — surface it so the loop runs it.
        for (const tc of chunk.message?.tool_calls ?? []) {
          sawTool = true;
          producedAnything = true;
          yield { type: 'tool_call', call: { id: newId('toolu'), toolName: tc.function.name, args: tc.function.arguments } };
        }
        const delta = chunk.message?.content ?? '';
        if (delta) {
          producedAnything = true;
          if (mode === 'stream') {
            yield { type: 'text', delta };
          } else if (mode === 'buffer') {
            buf += delta;
          } else {
            // Undecided: keep buffering while the text is still a bare identifier
            // (a tool name might be forming, e.g. "web_search"). Commit only when
            // the disambiguating character arrives — "(" or "{" ⇒ a tool call to
            // recover; anything else ⇒ prose, so flush and stream live.
            buf += delta;
            const trimmed = buf.replace(/^\s+/, '');
            if (trimmed.length > 0 && !/^[\w.]+$/.test(trimmed)) {
              if (looksLikeToolText(trimmed)) {
                mode = 'buffer';
              } else {
                mode = 'stream';
                yield { type: 'text', delta: buf };
                buf = '';
              }
            }
          }
        }
        if (chunk.done) {
          doneReason = chunk.done_reason;
          usage.input = chunk.prompt_eval_count ?? usage.input;
          usage.output = chunk.eval_count ?? usage.output;
        }
      }

      // Buffered a `{...}` blob: recover a real tool call if that's what it is,
      // otherwise it was genuine JSON the user wanted — emit it as text.
      if (mode === 'buffer' && buf.trim()) {
        const recovered = extractTextToolCall(buf, toolDefs);
        if (recovered) {
          yield { type: 'tool_call', call: { id: newId('toolu'), toolName: recovered.name, args: recovered.arguments } };
          yield { type: 'done', reason: 'tool_call', usage };
          return;
        }
        yield { type: 'text', delta: buf };
      } else if (mode === 'undecided' && buf) {
        // Stream ended before we decided (a very short answer) — emit it.
        yield { type: 'text', delta: buf };
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

interface ToolLike {
  name: string;
  inputSchema?: unknown;
}

/** Resolve a model-emitted name (bare "web_search" or full "web.web_search") to
 *  the real namespaced tool. */
function resolveTool(name: string, tools: ToolLike[]): ToolLike | undefined {
  return tools.find((t) => t.name === name) ?? tools.find((t) => t.name.split('.').pop() === name);
}
/** The tool's primary parameter name (for mapping a positional arg). */
function firstParamName(tool: ToolLike): string | undefined {
  const s = tool.inputSchema as { properties?: Record<string, unknown>; required?: string[] } | undefined;
  if (Array.isArray(s?.required) && s.required.length > 0) return s.required[0];
  return s?.properties ? Object.keys(s.properties)[0] : undefined;
}
/** Top-level balanced `{...}` substrings. */
function balancedObjects(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (text[i] === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        out.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return out;
}

/** True if `text` looks like a tool call written as prose (so we should try to
 *  recover it rather than show it). Used to decide whether to buffer a stream. */
function looksLikeToolText(text: string): boolean {
  const t = text.replace(/^\s+/, '');
  return t.startsWith('{') || /^[\w.]+\s*\(/.test(t);
}

/**
 * Recover a tool call the model dumped into its text content instead of the
 * structured `tool_calls` field — a failure mode that varies by model. Handles
 * BOTH formats seen in the wild:
 *   - JSON:          {"name":"web_search","parameters":{"query":"…"}}   (qwen, llama)
 *   - function-call: web_search("…")  |  web_search(query="…", max_results=1)  (llama3.1)
 * Matches bare or namespaced names and maps a positional arg onto the tool's
 * primary parameter via its schema.
 */
function extractTextToolCall(
  text: string,
  tools: ToolLike[],
): { name: string; arguments: unknown } | null {
  if (!text) return null;

  // 1) JSON object format.
  for (const candidate of balancedObjects(text)) {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(candidate) as Record<string, unknown>;
    } catch {
      continue;
    }
    const inner = (obj.tool_call ?? obj.function ?? obj) as Record<string, unknown>;
    const raw = inner?.name;
    if (typeof raw === 'string') {
      const tool = resolveTool(raw, tools);
      if (tool) {
        const argsv = (inner.arguments ?? inner.parameters ?? inner.args ?? inner.input ?? {}) as unknown;
        return { name: tool.name, arguments: argsv };
      }
    }
  }

  // 2) Function-call syntax: name(...).
  const fc = text.match(/([a-zA-Z_][\w]*(?:\.[\w]+)?)\s*\(([\s\S]*)\)/);
  const fcName = fc?.[1];
  if (fcName) {
    const tool = resolveTool(fcName, tools);
    if (tool) {
      const argStr = (fc?.[2] ?? '').trim();
      const p = firstParamName(tool);
      let args: unknown = {};
      if (argStr.startsWith('{')) {
        try {
          args = JSON.parse(argStr);
        } catch {
          args = {};
        }
      } else if (/^["'][\s\S]*["']$/.test(argStr)) {
        args = p ? { [p]: argStr.slice(1, -1) } : {};
      } else if (argStr.includes('=')) {
        const o: Record<string, unknown> = {};
        for (const m of argStr.matchAll(/([a-zA-Z_]\w*)\s*=\s*("([^"]*)"|'([^']*)'|[\d.]+|true|false)/g)) {
          const key = m[1];
          const lit = m[2] ?? '';
          if (!key) continue;
          let v: unknown = m[3] ?? m[4] ?? lit;
          if (m[3] === undefined && m[4] === undefined) {
            if (/^[\d.]+$/.test(lit)) v = Number(lit);
            else if (lit === 'true' || lit === 'false') v = lit === 'true';
          }
          o[key] = v;
        }
        args = o;
      } else if (argStr.length > 0) {
        args = p ? { [p]: argStr } : {};
      }
      return { name: tool.name, arguments: args };
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
