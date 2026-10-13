import type {
  ProviderAdapter,
  GenerateArgs,
  GenerateResult,
} from '../adapter.js';
import { estimateMessageTokens, type Message } from '../../types/message.js';
import type { StreamEvent, TokenUsage } from '../../types/stream.js';
import type { ToolCall } from '../../types/tool.js';
import type { ModelCapabilities } from '../../types/capabilities.js';
import { FlintError } from '../../types/error.js';
import { decodeAssistantTurn, encodeAssistantText, encodeToolCallTurn } from '../../core/encoding.js';
import { newId } from '../../core/util.js';
import { ollamaCapabilities } from './capabilities.js';
import { OllamaFormatError, OllamaHttpError, toAiError } from './errors.js';
import { responseFormatName } from '../response-format.js';
import { mapMessages, mapDoneReason } from './mapping.js';
import { raceAbort, readDeadline, startDeadline, type DeadlineMs } from '../deadline.js';

export interface OllamaProviderOptions {
  /** Base URL of the Ollama server. Defaults to http://localhost:11434. */
  baseURL?: string;
  /** Injectable fetch (for tests / custom transports). Defaults to global fetch. */
  fetch?: typeof fetch;
  /** Default Ollama `options` (temperature, num_ctx, …) merged into every call. */
  defaultOptions?: Record<string, unknown>;
  /**
   * Ollama's top-level `think` flag, sent on every /api/chat call (generate and
   * stream) when set. Undefined, the default, sends nothing: the model's own
   * default applies and request bodies are exactly what they were before this
   * option existed.
   *
   * What Ollama 0.34 does with it (checked against the local server):
   *  - thinking models (qwen3.8, muse-glimmer) think when it's omitted, and with
   *    `true`; that reasoning comes back in `message.thinking`, which is never
   *    read, so it stays out of Flint's text. `false` turns thinking off: no
   *    `message.thinking` and far fewer tokens (muse-glimmer still spends some on
   *    reasoning Ollama drops). But a model can then reason in `message.content`
   *    itself: qwen3.8 sometimes leads with an answer and visibly corrects it
   *    ("Wait, ..."), and that is part of the answer Flint returns.
   *  - a model without the thinking capability (qwen2.5) accepts `false` as a
   *    no-op, but answers `true` with HTTP 400 "does not support thinking" on
   *    every call. So only set `true` for a model that can think.
   */
  think?: boolean;
  /**
   * What the caller knows about a model, typically the server's own report
   * (`/api/show`): it wins over the built-in table, field by field. Return
   * undefined for a model it knows nothing about. A model it marks
   * `toolCalling: 'unsupported'` is not offered tools (Ollama answers every
   * such call with a 400). Unset, requests are exactly what they were.
   */
  capabilities?: (model: string) => Partial<ModelCapabilities> | undefined;
  /*
   * Deadlines of the adapter's own, for a model that stalls instead of failing
   * (cold, or evaluating a long prompt). All off unless set, and a client that
   * sets none makes exactly the calls it did. Each is a number of ms, or a
   * function read on every call (DeadlineMs).
   */
  /**
   * ms from sending a call to its first sign of output: text, a tool call, or
   * a thinking model's reasoning. Past it the call ends with a `timeout` error
   * whose providerCode is `first_token_timeout`, not retryable.
   *
   * It covers EVERY call, the ones that answer whole too: the tool-decision
   * pass (tools offered, no tool result yet, which is the first pass of nearly
   * every chat turn), a constrained reply, generate(). With this set, such a
   * call is sent `stream: true`, timed on its first line, and folded back into
   * the one object a non-streamed call returns (postWhole), so nothing changes
   * for the caller. Without it they are the plain non-streamed calls they were:
   * a model that stalled there held the turn for the whole-reply deadline.
   */
  firstTokenTimeoutMs?: DeadlineMs;
  /** The same for a call that follows a tool result. Unset: firstTokenTimeoutMs. */
  toolPassTimeoutMs?: DeadlineMs;
  /**
   * ms for a call that answers whole to finish: the tool-decision pass, a
   * constrained reply, generate(). providerCode `request_timeout`.
   */
  requestTimeoutMs?: DeadlineMs;
  /**
   * ms a reply may go quiet once it has begun, between one piece and the next
   * (providerCode `idle_timeout`): a model that sends a token and then nothing.
   * It applies wherever a first-token deadline does.
   */
  idleTimeoutMs?: DeadlineMs;
  /**
   * Called when a request's first sign of output arrives, once per request
   * this client reads as a stream (which, with a first-token deadline, is all
   * of them). For a caller that measures time to first token: the events of a
   * call that answers whole only come out when the whole reply is in.
   */
  onFirstOutput?: () => void;
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
    /** A thinking model's reasoning. Deliberately never read: only `content` is the answer. */
    thinking?: string;
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
  /**
   * The server every request goes to, without a trailing slash. Readable, so a
   * caller can tell a model on this machine from one on a server elsewhere.
   */
  readonly baseURL: string;
  /**
   * The context window this client asks Ollama for on every call (`num_ctx` in
   * `defaultOptions`), or undefined when it sets none and Ollama's own default
   * applies. Readable, so a caller can size a prompt to the window the model
   * will really have instead of a table's guess.
   */
  readonly numCtx: number | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly defaultOptions: Record<string, unknown>;
  private readonly think: boolean | undefined;
  private readonly known: ((model: string) => Partial<ModelCapabilities> | undefined) | undefined;
  private readonly deadlines: Pick<OllamaProviderOptions, 'firstTokenTimeoutMs' | 'toolPassTimeoutMs' | 'requestTimeoutMs' | 'idleTimeoutMs'>;
  private readonly onFirstOutput: (() => void) | undefined;

  constructor(opts: OllamaProviderOptions = {}) {
    this.baseURL = (opts.baseURL ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    const numCtx = opts.defaultOptions?.num_ctx;
    this.numCtx = typeof numCtx === 'number' && Number.isInteger(numCtx) && numCtx > 0 ? numCtx : undefined;
    this.fetchImpl = opts.fetch ?? fetch;
    this.defaultOptions = opts.defaultOptions ?? {};
    this.think = opts.think;
    this.known = opts.capabilities;
    this.deadlines = {
      ...(opts.firstTokenTimeoutMs !== undefined ? { firstTokenTimeoutMs: opts.firstTokenTimeoutMs } : {}),
      ...(opts.toolPassTimeoutMs !== undefined ? { toolPassTimeoutMs: opts.toolPassTimeoutMs } : {}),
      ...(opts.requestTimeoutMs !== undefined ? { requestTimeoutMs: opts.requestTimeoutMs } : {}),
      ...(opts.idleTimeoutMs !== undefined ? { idleTimeoutMs: opts.idleTimeoutMs } : {}),
    };
    this.onFirstOutput = opts.onFirstOutput;
  }

  /** The first-token deadline for a call: the tool-pass one after a tool result, when set. */
  private firstMsFor(args: Pick<GenerateArgs, 'messages'>): number | undefined {
    const afterTool = args.messages[args.messages.length - 1]?.role === 'tool_result';
    return afterTool && this.deadlines.toolPassTimeoutMs !== undefined ? readDeadline(this.deadlines.toolPassTimeoutMs) : readDeadline(this.deadlines.firstTokenTimeoutMs);
  }

  /** The first sign of output of the request being read. A caller's callback that throws is its own trouble. */
  private sawFirstOutput(): void {
    try {
      this.onFirstOutput?.();
    } catch {
      /* not the request's */
    }
  }

  /**
   * One POST to /api/chat that answers whole: the response, or a deadline's
   * own error.
   *
   * With no deadline it is the plain non-streamed fetch it always was, with the
   * caller's signal untouched. With a request deadline only, the same call,
   * bounded.
   *
   * With a FIRST-TOKEN deadline (`firstMs`) it is sent `stream: true` and read
   * as it arrives (postFolded): the first line is timed with that deadline,
   * the gaps after it with the idle one, the whole with the request one, and
   * the lines are folded into the one object a non-streamed call returns. So
   * chatOnce and structured parse what they always parsed, and a model that is
   * cold or stalled is found out in seconds instead of holding the call for
   * the whole-reply deadline.
   */
  private async postWhole(body: Record<string, unknown>, signal: AbortSignal | undefined, firstMs?: number): Promise<Response> {
    if (firstMs !== undefined) return this.postFolded(body, signal, firstMs);
    const guard = startDeadline('request', readDeadline(this.deadlines.requestTimeoutMs), signal);
    const send = (s: AbortSignal | undefined): Promise<Response> =>
      this.fetchImpl(`${this.baseURL}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        redirect: 'error', // Ollama is at a fixed address: a redirect is never followed
        ...(s ? { signal: s } : {}),
      });
    if (!guard.active) return send(signal);
    try {
      // The whole reply is awaited under the deadline: the body too, not only the headers.
      const resp = await raceAbort(send(guard.signal), guard.signal);
      const text = await raceAbort(resp.text(), guard.signal);
      // (A status that may carry no body gets none.)
      return new Response([204, 205, 304].includes(resp.status) ? null : text, { status: resp.status, headers: resp.headers });
    } catch (err) {
      throw guard.fired() ?? err;
    } finally {
      guard.dispose();
    }
  }

  /**
   * postWhole, streamed and folded. What comes back is exactly a non-streamed
   * reply: `message.content` is every piece of content joined, `tool_calls`
   * every call in order, and the counts and `done_reason` are the last line's.
   * An error object inside the stream is the failure it would have been
   * (status 500, the same body); a stream that ends before `done` is a 502.
   */
  private async postFolded(body: Record<string, unknown>, signal: AbortSignal | undefined, firstMs: number): Promise<Response> {
    const idleMs = readDeadline(this.deadlines.idleTimeoutMs);
    // The whole reply is still bounded; the first-token and idle clocks run inside that bound.
    const whole = startDeadline('request', readDeadline(this.deadlines.requestTimeoutMs), signal);
    const guard = startDeadline('first_token', firstMs, whole.signal);
    const json = { 'content-type': 'application/json' };
    try {
      const resp = await raceAbort(
        this.fetchImpl(`${this.baseURL}/api/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...body, stream: true }),
          redirect: 'error',
          ...(guard.signal ? { signal: guard.signal } : {}),
        }),
        guard.signal,
      );
      if (!resp.ok) return new Response(await raceAbort(resp.text(), guard.signal), { status: resp.status, headers: resp.headers });
      if (!resp.body) return new Response(JSON.stringify({ error: 'Ollama returned no response body' }), { status: 502, headers: json });

      let content = '';
      let thinking = '';
      const toolCalls: NonNullable<NonNullable<OllamaChatChunk['message']>['tool_calls']> = [];
      let last: OllamaChatChunk | undefined;
      let started = false;
      for await (const line of readNdjson(resp.body, guard.signal)) {
        let chunk: OllamaChatChunk & { error?: unknown };
        try {
          chunk = JSON.parse(line) as OllamaChatChunk & { error?: unknown };
        } catch {
          continue; // a line that is not JSON says nothing; the reply is judged by the lines that are
        }
        if (chunk.error !== undefined && chunk.error !== null) return new Response(JSON.stringify({ error: chunk.error }), { status: 500, headers: json });
        // Any sign the model is producing something ends the first-token deadline (reasoning counts), and
        // from then on each line restarts the idle clock.
        if (!started && (chunk.message?.content || chunk.message?.thinking || (chunk.message?.tool_calls?.length ?? 0) > 0 || chunk.done)) {
          started = true;
          this.sawFirstOutput();
        }
        if (started) guard.rearm('idle', idleMs);
        content += chunk.message?.content ?? '';
        thinking += chunk.message?.thinking ?? '';
        for (const tc of chunk.message?.tool_calls ?? []) toolCalls.push(tc);
        if (chunk.done) last = chunk;
      }
      if (!last) return new Response(JSON.stringify({ error: 'Ollama closed the reply before it was done' }), { status: 502, headers: json });
      const folded: OllamaChatChunk = {
        ...last,
        message: { role: 'assistant', content, ...(thinking ? { thinking } : {}), ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}) },
      };
      return new Response(JSON.stringify(folded), { status: 200, headers: json });
    } catch (err) {
      throw guard.fired() ?? whole.fired() ?? err;
    } finally {
      guard.dispose();
      whole.dispose();
    }
  }

  /**
   * The built-in table, then what the caller knows (`capabilities`), then the
   * context this client actually asks Ollama for: `defaultOptions.num_ctx` is
   * sent on every call, so that IS the window, whatever a table says. Budgeting
   * against a table's guess sent a 16K model a 2K history (an unknown model's
   * 4,096 default) and a 4K one far more than it could hold. One thing bounds
   * it: the model's own maximum, when the caller's `capabilities` gives it as
   * `maxContextTokens` (Ollama gives a model no more than that, whatever is asked).
   */
  getCapabilities(model: string): ModelCapabilities {
    const told = definedOnly(this.known?.(model));
    const caps: ModelCapabilities = { ...ollamaCapabilities(model), ...told };
    const numCtx = this.defaultOptions.num_ctx;
    if (typeof numCtx === 'number' && Number.isInteger(numCtx) && numCtx > 0) {
      // Ollama clamps num_ctx to the model's own maximum. When the caller knows that maximum (the
      // server's own report, through `capabilities`), the window is the smaller of the two: budgeting
      // against the number ASKED for sends a model more than it holds, and Ollama cuts the prompt's start.
      const most = typeof told.maxContextTokens === 'number' && told.maxContextTokens > 0 ? told.maxContextTokens : undefined;
      const window = most !== undefined ? Math.min(numCtx, most) : numCtx;
      caps.maxContextTokens = window;
      // The reply's share never crowds out the prompt: at most a quarter of the real window.
      caps.maxOutputTokens = Math.max(1, Math.min(caps.maxOutputTokens, Math.floor(window / 4)));
    }
    return caps;
  }

  /** `args` without its tools, for a model the caller knows cannot call them; otherwise `args` itself. */
  private offerable(args: GenerateArgs): GenerateArgs {
    if (!args.tools || args.tools.length === 0 || this.known?.(args.model)?.toolCalling !== 'unsupported') return args;
    const { tools: _tools, toolChoice: _choice, ...rest } = args;
    return rest;
  }

  estimateTokens(messages: Message[], _model: string): number {
    // Best-effort heuristic (~4 chars/token + a per-attachment cost). Budgeting only.
    return estimateMessageTokens(messages);
  }

  /** Non-streamed call with retry: native tool-calling is reliable only in
   *  non-stream mode, and with many tools qwen occasionally returns an EMPTY
   *  turn (no text, no call). Retry a couple times until it produces something
   *  rather than handing the user back nothing. */
  private async fetchFull(args: GenerateArgs, recoverWith: ToolLike[] = args.tools ?? []): Promise<FullResult> {
    let last: FullResult = { text: '', toolCalls: [], usage: { input: 0, output: 0 }, doneReason: undefined };
    for (let attempt = 0; attempt < 3; attempt++) {
      last = await this.chatOnce(args, attempt, recoverWith);
      if (last.toolCalls.length > 0 || last.text.trim().length > 0) return last;
    }
    return last;
  }

  /** `recoverWith`: the tools a call written as text is matched against (see honourToolChoice). */
  private async chatOnce(args: GenerateArgs, attempt = 0, recoverWith: ToolLike[] = args.tools ?? []): Promise<FullResult> {
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
    const resp = await this.postWhole(body, args.signal, this.firstMsFor(args));
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
    if (toolCalls.length === 0 && recoverWith.length > 0) {
      const recovered = extractTextToolCall(text, recoverWith);
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

  async generate(rawArgs: GenerateArgs): Promise<GenerateResult> {
    const structured = structuredOf(rawArgs);
    if (structured) {
      try {
        return await this.structured(rawArgs, structured);
      } catch (err) {
        throw new FlintError(toAiError(err));
      }
    }
    const offered = this.offerable(rawArgs);
    const args = honourToolChoice(offered);
    try {
      const { text, toolCalls, usage, doneReason } = await this.fetchFull(args, offered.tools ?? []);
      if (toolCalls.length > 0) {
        return { message: encodeToolCallTurn(newId('msg'), text, toolCalls, 0), usage, reason: 'tool_call' };
      }
      return { message: encodeAssistantText(newId('msg'), text, 0), usage, reason: mapDoneReason(doneReason) };
    } catch (err) {
      throw new FlintError(toAiError(err));
    }
  }

  async *stream(rawArgs: GenerateArgs): AsyncIterable<StreamEvent> {
    // A constrained reply (responseFormat, or a forced tool) is one JSON value:
    // nothing to show before it is whole, so it is generated in one piece.
    const structured = structuredOf(rawArgs);
    if (structured) {
      try {
        const r = await this.structured(rawArgs, structured);
        const turn = decodeAssistantTurn(r.message);
        for (const call of turn.toolCalls) yield { type: 'tool_call', call };
        if (turn.text) yield { type: 'text', delta: turn.text };
        yield { type: 'done', reason: r.reason, usage: r.usage };
      } catch (err) {
        yield { type: 'error', error: toAiError(err) };
      }
      return;
    }
    const offered = this.offerable(rawArgs);
    const args = honourToolChoice(offered);
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
    // The tools as the caller defined them, even when honourToolChoice didn't
    // offer them: a call the model writes as text on the answer-only call must
    // still be recognised as a call, not shown as the answer.
    const toolDefs = offered.tools ?? [];
    // Some smaller models (notably llama3.1) emit a tool call as TEXT — a bare
    // `{"name":...,"parameters":...}` JSON object — instead of a structured tool
    // call. If the streamed content starts with `{`, we don't stream it raw
    // (that would leak JSON to the user); we buffer it and try to recover a real
    // tool call at the end. Prose answers (the common case) stream live as before.
    let buf = '';
    let mode: 'undecided' | 'stream' | 'buffer' = 'undecided';
    // The adapter's own deadlines: on the first sign of output, then between one piece of the
    // reply and the next (both off unless set).
    const idleMs = readDeadline(this.deadlines.idleTimeoutMs);
    const guard = startDeadline('first_token', this.firstMsFor(args), args.signal, { always: idleMs !== undefined });
    let started = false;
    try {
      const body = this.buildBody(args, true);
      const send = this.fetchImpl(`${this.baseURL}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        redirect: 'error',
        ...(guard.signal ? { signal: guard.signal } : {}),
      });
      const resp = await (guard.active ? raceAbort(send, guard.signal) : send);
      if (!resp.ok) throw new OllamaHttpError(resp.status, await safeText(resp));
      if (!resp.body) throw new OllamaHttpError(502, 'Ollama returned no response body');

      for await (const line of readNdjson(resp.body, guard.active ? guard.signal : undefined)) {
        const chunk = JSON.parse(line) as OllamaChatChunk & { error?: unknown };
        // An error sent inside the stream, once the 200 is out: the call failed. It used to be
        // read as a line with nothing in it, and the reply ended `complete` with what had arrived.
        if (chunk.error !== undefined && chunk.error !== null) throw new OllamaHttpError(500, typeof chunk.error === 'string' ? chunk.error : JSON.stringify(chunk.error));
        // Any sign the model is producing something ends the first-token deadline: reasoning
        // counts (the model is working), though only `content` is ever the answer. From then
        // on each line restarts the idle clock.
        if (!started && (chunk.message?.content || chunk.message?.thinking || (chunk.message?.tool_calls?.length ?? 0) > 0 || chunk.done)) {
          started = true;
          this.sawFirstOutput();
        }
        if (started) guard.rearm('idle', idleMs);
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
            // (a tool name might be forming, e.g. "web_search") or the start of a
            // `<tool_call>` tag. Commit only when the disambiguating character
            // arrives — "(", "{" or a whole `<tool_call>` ⇒ a tool call to
            // recover; anything else ⇒ prose, so flush and stream live.
            buf += delta;
            const trimmed = buf.replace(/^\s+/, '');
            if (trimmed.length > 0 && !undecided(trimmed)) {
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
      yield { type: 'error', error: toAiError(guard.fired() ?? err) };
    } finally {
      guard.dispose();
    }
  }

  /**
   * Ollama's `format` constrains the reply to a JSON schema. It serves both
   * responseFormat (the JSON is the reply's text) and a forced tool (`toolChoice:
   * {name}`, which Ollama has no knob for): the tool's input schema is the
   * format, and the JSON comes back as that tool's call. A whole reply that is
   * not valid JSON is retried twice before it is an error.
   *
   * A reply cut off at num_predict (`done_reason: "length"`) is not retried: the
   * same request would be cut off again. It is reported the way a text turn
   * reports it, reason `max_tokens` with the partial text, so the caller can give
   * it more room. A reply that parses is whole even when Ollama says `length` (a
   * model under `format` can pad the JSON with whitespace up to the cap).
   */
  private async structured(args: GenerateArgs, s: Structured): Promise<GenerateResult> {
    const { tools: _t, toolChoice: _c, responseFormat: _r, ...rest } = args;
    let lastText = '';
    let usage: TokenUsage = { input: 0, output: 0 };
    for (let attempt = 0; attempt < 3; attempt++) {
      const body = { ...this.buildBody(rest as GenerateArgs, false), format: s.schema };
      const resp = await this.postWhole(body, args.signal, this.firstMsFor(args));
      if (!resp.ok) throw new OllamaHttpError(resp.status, await safeText(resp));
      const chunk = (await resp.json()) as OllamaChatChunk;
      // Summed over the tries (what was processed); from the second try on, the last try's own prompt count
      // rides along, for a caller that checks the window: three tries of a 1,500-token prompt is not 4,500 in it.
      usage = {
        input: usage.input + (chunk.prompt_eval_count ?? 0),
        output: usage.output + (chunk.eval_count ?? 0),
        ...(attempt > 0 ? { lastInput: chunk.prompt_eval_count ?? 0 } : {}),
      };
      lastText = withoutTurnEnd(chunk.message?.content ?? '');
      let value: unknown;
      try {
        value = JSON.parse(lastText);
      } catch {
        if (chunk.done_reason === 'length') {
          return { message: encodeAssistantText(newId('msg'), lastText, 0), usage, reason: 'max_tokens' };
        }
        continue;
      }
      if (s.tool) {
        const call: ToolCall = { id: newId('toolu'), toolName: s.tool, args: value };
        return { message: encodeToolCallTurn(newId('msg'), '', [call], 0), usage, reason: 'tool_call' };
      }
      return { message: encodeAssistantText(newId('msg'), JSON.stringify(value), 0), usage, reason: 'complete' };
    }
    // Only the reply's length goes in the message: its text is the model's, and
    // error messages end up in logs.
    const target = s.tool ?? (args.responseFormat ? responseFormatName(args.responseFormat) : 'the format');
    throw new OllamaFormatError(`the model did not return valid JSON for ${target} in 3 tries (last reply: ${lastText.length} chars)`);
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
    // Only when configured: omitting it keeps the body byte-identical to before,
    // and `think: true` would be a 400 on a model that can't think (see `think`).
    if (this.think !== undefined) body.think = this.think;
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

/**
 * Ollama has no `tool_choice`, and it doesn't need tools defined to read tool
 * calls and results already in the history. So `none` (the tool loop's
 * answer-only call) is honoured by not offering the tools at all. Any other
 * choice leaves the request exactly as it was.
 *
 * Without tools, Ollama also stops parsing the model's tool-call output, so a
 * model that still calls one writes it as text (bare JSON, or qwen's
 * `<tool_call>` markup). Callers therefore recover text-form calls against the
 * ORIGINAL `rawArgs.tools`: a recovered call is a tool_call, which the loop
 * drops on that call (and then fails the turn as empty), instead of tool
 * syntax shown to the user and stored as the answer.
 */
function honourToolChoice(args: GenerateArgs): GenerateArgs {
  if (args.toolChoice !== 'none') return args;
  const { tools: _tools, toolChoice: _choice, ...rest } = args;
  return rest;
}

interface Structured {
  schema: Record<string, unknown>;
  /** Set when a forced tool is being called; the JSON is its input. */
  tool?: string;
}

/** responseFormat, or `toolChoice: {name}` naming a supplied tool; otherwise undefined. */
function structuredOf(args: GenerateArgs): Structured | undefined {
  if (args.responseFormat) return { schema: args.responseFormat.schema };
  const choice = args.toolChoice;
  if (choice && typeof choice === 'object') {
    const t = args.tools?.find((x) => x.name === choice.name);
    if (t) return { schema: t.inputSchema as Record<string, unknown>, tool: t.name };
  }
  return undefined;
}

/** Read a web ReadableStream of bytes as newline-delimited JSON lines. */
async function* readNdjson(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      // With a deadline, a read gives up when it fires even if the transport ignores the signal.
      const { done, value } = await (signal ? raceAbort(reader.read(), signal) : reader.read());
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
    // A stream abandoned at its deadline is closed, not left open behind the turn.
    if (signal?.aborted) void reader.cancel().catch(() => {});
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

/** How qwen-family templates wrap a tool call; it reaches `content` when no tools were offered. */
const TOOL_CALL_TAG = '<tool_call>';

/** Too little text yet to tell prose from a tool call: a bare identifier (a
 *  tool name forming) or the beginning of a `<tool_call>` tag. */
function undecided(trimmed: string): boolean {
  return /^[\w.]+$/.test(trimmed) || (trimmed.length < TOOL_CALL_TAG.length && TOOL_CALL_TAG.startsWith(trimmed));
}

/** True if `text` looks like a tool call written as prose (so we should try to
 *  recover it rather than show it). Used to decide whether to buffer a stream. */
function looksLikeToolText(text: string): boolean {
  const t = text.replace(/^\s+/, '');
  return t.startsWith('{') || t.startsWith(TOOL_CALL_TAG) || /^[\w.]+\s*\(/.test(t);
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

/** An object without its undefined values, so spreading it never erases a field. */
function definedOnly<T extends object>(o: T | undefined): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(o ?? {})) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}

async function safeText(resp: Response): Promise<string> {
  try {
    return await resp.text();
  } catch {
    return `HTTP ${resp.status}`;
  }
}

export { ollamaCapabilities } from './capabilities.js';

/**
 * The reply without the end-of-turn tokens a model with no stop parameters
 * lets through (muse-glimmer under `format` ends its JSON with `<|eot|>`):
 * trailing `<|name|>` tokens and whitespace only, so the JSON itself is never
 * touched.
 */
export function withoutTurnEnd(text: string): string {
  return text.trim().replace(/(?:\s*<\|[A-Za-z0-9_]{1,32}\|>)+$/, '').trim();
}
