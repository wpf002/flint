/**
 * POST /internal/complete (Machine plan P2, 3.0.8): a model call the runtime
 * asks for, under a background kind (runtime, review, dispatch, selfmod). The
 * runtime holds no vendor keys; the server makes the call.
 *
 * The call is answered by the LOCAL model (localBackgroundBrain): the chat
 * brain's own Ollama model, with the reply held to a JSON schema when the
 * request carries one, as memory extraction is (./memory-brain). It used to go
 * to the routine frontier tier (Sonnet) and answer 503 without one; nothing
 * calls it yet, and every background call from here on stays on this machine.
 * It yields to Will's chat: not started while he is chatting, and cut off the
 * moment a turn starts (503 busy either way, never a failed call). The prompt
 * and the reply are sized to the model's window before anything is asked, and
 * a reply that is empty, cut off, or not the schema asked for is a failure, not
 * a 200.
 *
 * The gate itself still guards money, for any brain that bills (the local one
 * does not, so steps 2 and 3 pass it by). In order, before anything runs:
 *  1. the kind's own caps (FLINT_BUDGET_KIND_<KIND>_DAILY_USD / _MONTHLY_USD,
 *     $0 until Will raises both): refused at $0, or when what the kind has
 *     spent plus this call's estimate (prompt plus maxTokens of answer, priced
 *     high) would pass either cap. With a free brain this is the kind's switch:
 *     off until both are raised. Since dollars no longer bound a free brain, a
 *     kind also has a cap on calls a day (FLINT_BUDGET_KIND_<KIND>_DAILY_CALLS,
 *     100 unless set): refused once that many have been made today;
 *  2. the vendor's own cap: refused once Flint's ledger is at 80% of it (the
 *     point where background work waits) or spent;
 *  3. the unified view the runtime pushes (every account's spend on that
 *     vendor): refused when it is missing, older than 2 h, or at 70% of Flint's
 *     cap, and when Flint has no cap for that vendor at all (there is nothing
 *     to hold the 70% against: fail closed);
 *  4. a durable audit intent (fsynced; if it cannot be written, nothing runs);
 *  then the call (no tools, a timeout), metered into the spend ledger under its
 *  kind when it bills, and its outcome audited with the cost.
 *
 * One call at a time, so two calls cannot both pass a cap that has room for
 * one; a few may wait, more are refused (busy). Every refusal is audited, with
 * its reason. Nothing the runtime sent (the prompt) reaches the audit trail:
 * ids, enums and numbers only, and a failed call's error as its class.
 *
 * Refusals answer 400 (not a request, or a prompt too long for the model's
 * window), 402 {error, reason} (a budget, or the day's calls), 503 (no local
 * model, busy, Will is chatting, no audit) or 502 (the call failed); the
 * runtime reads any of them as "no text". With the default $0 caps every call
 * is refused.
 */
import { randomBytes } from 'node:crypto';
import { OllamaProvider, estimateCost, type TokenUsage, type TokenVendor } from '@flint/core';
import { InternalCompleteRequest, SPEND_KINDS, type SpendKind as BackgroundKind } from '@flint/policy';
import type { AuditSink } from './audit-sink';
import { errorClass } from './error-log';
import { chatOllama, isCloudModel, type LocalMemoryModel } from './memory-brain';
import { DEGRADE_AT, UNIFIED_BACKGROUND_STOP, atLeast, type KindCaps, type SpendGuard } from './spend';

export type CompleteReason =
  | 'bad_request'
  | 'too_long'
  | 'kind_cap'
  | 'call_cap'
  | 'vendor_cap'
  | 'vendor_uncapped'
  | 'unified_missing'
  | 'unified_stale'
  | 'unified_70'
  | 'no_local_model'
  | 'busy'
  | 'audit_unavailable'
  | 'provider_failed';

/** The brain background calls use: the local model (localBackgroundBrain). A brain that bills is metered by the server's spend observer under `kind`. */
export interface BackgroundBrain {
  /** The paid vendor it bills, or undefined for a free (local) brain. */
  vendor: TokenVendor | undefined;
  model: string;
  /** The model's context window in tokens, when the brain knows it: the gate sizes the call to it (fitWindow). */
  numCtx?: number;
  /** Is the brain spoken for right now (Will is chatting)? Asked before the intent is written: a busy brain is a refusal, not a call. */
  busy?: () => boolean;
  /** `schema`: a JSON schema the reply must match; omitted, the reply is plain text. */
  generate(
    input: { system: string; prompt: string; schema?: Record<string, unknown> },
    opts: { kind: BackgroundKind; maxTokens: number; signal: AbortSignal },
  ): Promise<{ text: string; usage: TokenUsage }>;
}

export interface CompleteGateDeps {
  guard: Pick<SpendGuard, 'ledger' | 'status' | 'unifiedView'>;
  kindCaps: KindCaps;
  audit: Pick<AuditSink, 'record'>;
  /** The brain to ask, or undefined when there is no local model to ask (503 no_local_model). */
  brain: () => BackgroundBrain | undefined;
  /** Calls a day each kind may make (readKindCallCaps); DEFAULT_DAILY_CALLS each when omitted. */
  callCaps?: KindCallCaps;
  now?: () => number;
  /** How long the call may take (default 120 s). */
  timeoutMs?: number;
  /** Calls running or waiting before more are refused as busy (default 4). */
  maxWaiting?: number;
  log?: (msg: string) => void;
}

export type CompleteResult =
  | { status: 200; body: { text: string; usage: TokenUsage; costUsd: number } }
  | { status: 400 | 402 | 502 | 503; body: { error: string; reason: CompleteReason } };

// The audit action's name predates the move to the local model; it is kept so the trail stays one series.
const ACTION = 'runtime.frontier.complete';

/** Calls a day a background kind may make, unless FLINT_BUDGET_KIND_<KIND>_DAILY_CALLS says otherwise. */
export const DEFAULT_DAILY_CALLS = 100;

export type KindCallCaps = Record<BackgroundKind, number>;

/**
 * FLINT_BUDGET_KIND_<KIND>_DAILY_CALLS: how many calls a day each background
 * kind may make. The dollar caps bound a brain that bills; the local model
 * costs nothing, so they only switch a kind on, and this is what bounds it
 * (GPU time that is otherwise Will's chat's). Unset: DEFAULT_DAILY_CALLS.
 * `0` is a real cap. Anything that is not a whole number >= 0 is reported
 * via `warn` and ignored.
 */
export function readKindCallCaps(env: Record<string, string | undefined>, warn: (msg: string) => void = () => {}): KindCallCaps {
  const out = {} as KindCallCaps;
  for (const kind of SPEND_KINDS) {
    const key = `FLINT_BUDGET_KIND_${kind.toUpperCase()}_DAILY_CALLS`;
    const raw = env[key]?.trim();
    const n = raw ? Number(raw) : NaN;
    if (raw && !(Number.isInteger(n) && n >= 0)) warn(`${key}=${JSON.stringify(raw.slice(0, 40))} is not a whole number of calls; using ${DEFAULT_DAILY_CALLS}`);
    out[kind] = raw && Number.isInteger(n) && n >= 0 ? n : DEFAULT_DAILY_CALLS;
  }
  return out;
}

/**
 * Prompt characters per token, for sizing: 2. Prose runs near 4 and a
 * transcript near 3.5, but what the runtime sends is log lines and JSON, which
 * measured 2.3; an estimate that is too generous lets through a prompt Ollama
 * then cuts. The reply's own usage is the check after the fact (WindowFull).
 */
const CHARS_PER_TOKEN = 2;

/**
 * Size one call to a model's context window: the reply gets what was asked
 * for, up to half the window, and the prompt must fit in what is left. Returns
 * the reply's token budget, or undefined when the prompt does not fit. Without
 * this Ollama silently drops the start of an over-long prompt (the
 * instructions) and answers something else.
 */
export function fitWindow(numCtx: number, promptChars: number, maxTokens: number): { maxTokens: number; promptRoom: number } | undefined {
  const out = Math.max(1, Math.min(maxTokens, Math.floor(numCtx / 2)));
  const promptRoom = Math.max(0, Math.floor((numCtx - out) * CHARS_PER_TOKEN));
  return promptChars <= promptRoom ? { maxTokens: out, promptRoom } : undefined;
}

export class CompleteGate {
  private queue: Promise<unknown> = Promise.resolve();
  private waiting = 0;
  /** Calls made today, per kind: in memory, so a restart starts the day's count over. */
  private calls: { day: string; made: Partial<Record<BackgroundKind, number>> } = { day: '', made: {} };

  constructor(private readonly deps: CompleteGateDeps) {}

  /** One /internal/complete request, from its parsed JSON body. */
  async handle(raw: unknown): Promise<CompleteResult> {
    const parsed = InternalCompleteRequest.safeParse(raw);
    if (!parsed.success) return { status: 400, body: { error: 'not a complete request (kind, ref, system, prompt, maxTokens)', reason: 'bad_request' } };
    const req = parsed.data;
    if (this.waiting >= (this.deps.maxWaiting ?? 4)) return this.refuse(req, 503, 'busy', 'other background calls are waiting; try later');
    this.waiting++;
    const run = this.queue.then(() => this.decideAndCall(req));
    this.queue = run.catch(() => {});
    try {
      return await run;
    } finally {
      this.waiting--;
    }
  }

  private refuse(req: InternalCompleteRequest, status: 400 | 402 | 502 | 503, reason: CompleteReason, error: string, extra: Record<string, string | number | null> = {}): CompleteResult {
    try {
      this.deps.audit.record({
        actor: 'runtime', context: 'autonomous', kind: 'decision', action: ACTION, decision: 'deny', outcome: 'denied',
        inputs: { kind: req.kind, ref: req.ref, reason, ...extra }, reasoning: error,
      });
    } catch {
      /* a refusal runs nothing: losing its row costs no safety */
    }
    return { status, body: { error, reason } };
  }

  private async decideAndCall(req: InternalCompleteRequest): Promise<CompleteResult> {
    const now = this.deps.now?.() ?? Date.now();
    const KIND = req.kind.toUpperCase();
    const caps = this.deps.kindCaps[req.kind];
    // 1. the kind's caps: at $0 (the default) nothing else matters.
    if (!(caps.dailyUsd > 0) || !(caps.monthlyUsd > 0)) {
      return this.refuse(req, 402, 'kind_cap', `the ${req.kind} spend kind is capped at $0 (FLINT_BUDGET_KIND_${KIND}_DAILY_USD and _MONTHLY_USD)`);
    }
    const f = this.deps.brain();
    if (!f) return this.refuse(req, 503, 'no_local_model', 'there is no local model to ask');
    const where = { vendor: f.vendor ?? 'free', model: f.model.slice(0, 120) };
    // ...and the kind's calls for the day: what bounds a brain that costs nothing.
    const day = this.deps.guard.ledger.period(now).day;
    if (this.calls.day !== day) this.calls = { day, made: {} };
    const callCap = (this.deps.callCaps ?? readKindCallCaps({}))[req.kind];
    const made = this.calls.made[req.kind] ?? 0;
    if (made >= callCap) {
      return this.refuse(req, 402, 'call_cap', `the ${req.kind} kind has made its ${callCap} calls for today (FLINT_BUDGET_KIND_${KIND}_DAILY_CALLS)`, { ...where, calls: made });
    }
    // The call has to fit the model's window: the reply as asked (up to half of it), the prompt in the rest.
    const promptChars = req.system.length + req.prompt.length;
    const fit = f.numCtx === undefined ? { maxTokens: req.maxTokens } : fitWindow(f.numCtx, promptChars, req.maxTokens);
    if (!fit) {
      return this.refuse(req, 400, 'too_long', `the prompt (${promptChars} characters) does not fit the model's ${f.numCtx}-token window with a ${req.maxTokens}-token reply`, { ...where, promptChars });
    }
    // ...and with room for this call's estimate (it errs high).
    const spent = this.deps.guard.ledger.kindTotals(req.kind, now);
    const estimate = f.vendor ? estimateCost(f.vendor, f.model, req.system.length + req.prompt.length, { expectedOutputTokens: req.maxTokens }) : 0;
    const round = (n: number) => Math.round(n * 1e4) / 1e4;
    if (spent.dayUsd + estimate > caps.dailyUsd || spent.monthUsd + estimate > caps.monthlyUsd) {
      const daily = spent.dayUsd + estimate > caps.dailyUsd;
      return this.refuse(
        req, 402, 'kind_cap',
        `the ${req.kind} kind's ${daily ? 'daily' : 'monthly'} cap ($${daily ? caps.dailyUsd : caps.monthlyUsd}) has no room for this call (spent $${round(daily ? spent.dayUsd : spent.monthUsd)}, estimate $${round(estimate)})`,
        { ...where, estimateUsd: round(estimate) },
      );
    }
    if (f.vendor) {
      // 2. the vendor's own cap: background work waits from 80%.
      const s = this.deps.guard.status(f.vendor);
      if (atLeast(s.level, 'degrade')) {
        return this.refuse(req, 402, 'vendor_cap', `${s.name} is at ${Math.round(s.fraction * 100)}% of Flint's cap; background calls stop at ${Math.round(DEGRADE_AT * 100)}%`, where);
      }
      // 3. the unified view: every account's spend on this vendor.
      const u = this.deps.guard.unifiedView(f.vendor, now);
      if (u.state !== 'fresh') {
        return u.state === 'missing'
          ? this.refuse(req, 402, 'unified_missing', `no unified spend view for ${f.vendor} from the runtime`, where)
          : this.refuse(req, 402, 'unified_stale', `the unified spend view for ${f.vendor} is older than 2 h`, where);
      }
      if (u.fraction === undefined) return this.refuse(req, 402, 'vendor_uncapped', `Flint has no cap for ${f.vendor} to hold the unified view against (FLINT_BUDGET_${f.vendor.toUpperCase()}_*)`, where);
      if (u.fraction >= UNIFIED_BACKGROUND_STOP) {
        return this.refuse(req, 402, 'unified_70', `${f.vendor} is at ${Math.round(u.fraction * 100)}% of Flint's cap across every account; background calls stop at ${Math.round(UNIFIED_BACKGROUND_STOP * 100)}%`, where);
      }
    }
    // Will's chat comes first: a brain he is using is not asked, and nothing was started to audit as failed.
    if (f.busy?.()) return this.refuse(req, 503, 'busy', 'Will is chatting; the local model is his', where);
    // 4. the intent, on disk before anything is spent.
    const correlationId = `complete:${req.ref}:${randomBytes(4).toString('hex')}`;
    const inputs = { kind: req.kind, ref: req.ref, ...where, maxTokens: fit.maxTokens, promptChars, estimateUsd: round(estimate) };
    try {
      this.deps.audit.record({ actor: 'runtime', context: 'autonomous', kind: 'intent', action: ACTION, decision: 'act', outcome: 'pending', inputs, correlationId }, true);
    } catch {
      this.deps.log?.('[complete] the intent could not be recorded; the call was not made');
      return { status: 503, body: { error: 'the intent could not be recorded, so nothing was run', reason: 'audit_unavailable' } };
    }
    this.calls.made[req.kind] = made + 1;
    try {
      const out = await f.generate(
        { system: req.system, prompt: req.prompt, ...(req.schema ? { schema: req.schema } : {}) },
        { kind: req.kind, maxTokens: fit.maxTokens, signal: AbortSignal.timeout(this.deps.timeoutMs ?? 120_000) },
      );
      const costUsd = f.vendor ? Math.round(this.deps.guard.ledger.priceTokens(f.vendor, f.model, out.usage) * 1e6) / 1e6 : 0;
      this.deps.audit.record({
        actor: 'runtime', context: 'autonomous', kind: 'spend', action: ACTION, decision: 'act', outcome: 'ok',
        inputs: { ...inputs, usageIn: out.usage.input, usageOut: out.usage.output }, costUsd, correlationId,
      });
      return { status: 200, body: { text: out.text, usage: out.usage, costUsd } };
    } catch (err) {
      // Cut off because Will started a chat turn: the model was his to take. Not a failed call, and
      // not one of the day's: the intent is closed as skipped, and the runtime is told to try later.
      if (err instanceof ChatBusy) {
        this.calls.made[req.kind] = made;
        this.deps.audit.record({
          actor: 'runtime', context: 'autonomous', kind: 'decision', action: ACTION, decision: 'deny', outcome: 'skipped',
          inputs: { ...inputs, reason: 'busy' }, reasoning: 'Will started chatting; the call gave way', correlationId,
        });
        return { status: 503, body: { error: 'Will is chatting; the local model is his', reason: 'busy' } };
      }
      const cls = errorClass(err);
      this.deps.log?.(`[complete] the ${req.kind} call for ${req.ref} failed (${cls})`);
      this.deps.audit.record({
        actor: 'runtime', context: 'autonomous', kind: 'spend', action: ACTION, decision: 'act', outcome: 'failed',
        inputs: { ...inputs, error: cls }, reasoning: `the provider call failed (${cls})`, correlationId,
      });
      return { status: 502, body: { error: `the call failed (${cls})`, reason: 'provider_failed' } };
    }
  }
}

// ---------------------------------------------------------------------------
// the local model as the background brain

type Env = Record<string, string | undefined>;

/**
 * The local model background calls ask: the chat brain's own (`chatModel`, what
 * main() resolved from OLLAMA_MODEL) at OLLAMA_HOST with the num_ctx the chat
 * brain sends, so Ollama never reloads it between Will's chat and a call.
 * Undefined, with the reason logged, when that model runs off this Mac (an
 * Ollama cloud model) or OLLAMA_HOST is not an http(s) URL.
 */
export function localBackgroundModel(env: Env, chatModel: string, log: (msg: string) => void): LocalMemoryModel | undefined {
  if (isCloudModel(chatModel)) {
    log('[complete] the chat model is an Ollama cloud model, which runs off this Mac: background calls have no local model');
    return undefined;
  }
  const live = chatOllama(env);
  if (!live) {
    log('[complete] OLLAMA_HOST is not an http(s) URL: background calls have no local model');
    return undefined;
  }
  return { ...live, model: chatModel, unloadAfter: false };
}

/** Thrown when a background call gives way to Will's chat. The gate answers 503 busy: nothing failed. */
export class ChatBusy extends Error {
  constructor() {
    super('Will is chatting; the local model is his');
    this.name = 'ChatBusy';
  }
}

/**
 * A reply that is no answer: nothing in it (EmptyReply), cut off at its token
 * limit (Truncated), not the schema asked for (InvalidReply), or given with the
 * window full (WindowFull: the prompt the model counted plus the reply's budget
 * reached the window, so part of the prompt was cut or pushed out while it
 * wrote). The name is what the audit trail records.
 */
export class ReplyError extends Error {
  constructor(name: 'EmptyReply' | 'Truncated' | 'InvalidReply' | 'WindowFull') {
    super(name);
    this.name = name;
  }
}

/** A JSON value as text with every object's keys in order, so two values that are equal compare equal however their keys were written. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (typeof v === 'object' && v !== null) {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/**
 * Does `value` match `schema`? The part of JSON Schema a reply's shape is
 * written in: `type` (one or a list), `enum`, `const`, `properties`,
 * `required`, `additionalProperties: false` and `items`. Ollama's `format`
 * holds the model to the schema while it writes, but a reply cut short or a
 * model that ignores the grammar still comes back as JSON; this is the check
 * that it is the JSON that was asked for. Keywords it does not know are not
 * checked, and it never refuses a reply over one: a schema with
 * `patternProperties` allows keys this cannot name, so extra keys are not
 * counted against it; `enum` and `const` compare by value, whatever order an
 * object's keys are in.
 */
export function matchesSchema(value: unknown, schema: unknown): boolean {
  if (typeof schema !== 'object' || schema === null) return true;
  const s = schema as Record<string, unknown>;
  const typeOf = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'number' && Number.isInteger(v) ? 'integer' : typeof v);
  if (s.type !== undefined) {
    const t = typeOf(value);
    const want = (Array.isArray(s.type) ? s.type : [s.type]) as unknown[];
    if (!want.some((w) => w === t || (w === 'number' && t === 'integer'))) return false;
  }
  if (Array.isArray(s.enum) && !s.enum.some((e) => canonical(e) === canonical(value))) return false;
  if ('const' in s && canonical(s.const) !== canonical(value)) return false;
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const props = typeof s.properties === 'object' && s.properties !== null ? (s.properties as Record<string, unknown>) : {};
    if (Array.isArray(s.required) && !s.required.every((k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(obj, k))) return false;
    for (const [k, v] of Object.entries(obj)) {
      if (Object.prototype.hasOwnProperty.call(props, k)) {
        if (!matchesSchema(v, props[k])) return false;
      } else if (s.additionalProperties === false && s.patternProperties === undefined) return false;
    }
  }
  if (Array.isArray(value) && s.items !== undefined && !value.every((v) => matchesSchema(v, s.items))) return false;
  return true;
}

/** Requests one call may make: the provider's own retries of an empty or unparsable reply. */
const BACKGROUND_MODEL_REQUESTS = 3;
/** Ollama's own window, for sizing a call when the chat brain sends no num_ctx. */
const DEFAULT_NUM_CTX = 4096;
/** How often a running call checks whether Will started a chat turn. */
const CHAT_POLL_MS = 500;

export interface LocalBackgroundDeps {
  /** Is Will chatting? Checked before the call, and every pollMs while it runs. */
  chatActive?: () => boolean;
  fetch?: typeof fetch;
  pollMs?: number;
}

/**
 * The local model as the BackgroundBrain, built the way memory extraction's is
 * (./memory-brain localExtractBrain):
 *  - OllamaProvider on the chat brain's host and num_ctx, `think` off,
 *    temperature 0;
 *  - a request's `schema` is Ollama's `format` (responseFormat), and the reply
 *    is checked against it again (matchesSchema): JSON of that shape, or the
 *    call fails (InvalidReply);
 *  - a reply with nothing in it, or cut off at its token limit, fails too
 *    (EmptyReply, Truncated): half an answer is not handed on as an answer;
 *  - so does one given with the window full (WindowFull): the prompt as the
 *    model counted it, plus the reply's budget, has to fit;
 *  - only POST /api/chat on that host, at most BACKGROUND_MODEL_REQUESTS times;
 *  - Will's chat comes first: `busy` says so before a call is started, and a
 *    call already running is cut off the moment a turn starts (ChatBusy).
 * `numCtx` is the window the gate sizes each call to: what the chat brain
 * sends, or Ollama's own 4,096 when it sends none. It bills nothing (`vendor`
 * undefined), so nothing is metered.
 */
export function localBackgroundBrain(m: LocalMemoryModel, deps: LocalBackgroundDeps = {}): BackgroundBrain {
  const chatActive = deps.chatActive ?? (() => false);
  const base = deps.fetch ?? fetch;
  const numCtx = typeof m.numCtx === 'number' && Number.isInteger(m.numCtx) && m.numCtx > 0 ? m.numCtx : DEFAULT_NUM_CTX;
  return {
    vendor: undefined,
    model: m.model,
    numCtx,
    busy: chatActive,
    generate: async (input, o) => {
      if (chatActive()) throw new ChatBusy();
      const ac = new AbortController();
      const cancel = () => ac.abort();
      if (o.signal.aborted) cancel();
      else o.signal.addEventListener('abort', cancel, { once: true });
      let gaveWay = false;
      const watch = setInterval(() => {
        if (!chatActive()) return;
        gaveWay = true;
        ac.abort();
      }, deps.pollMs ?? CHAT_POLL_MS);
      watch.unref?.();
      let requests = 0;
      // Every request the provider makes, its own retries included, comes through here.
      const gatedFetch = (async (url: string | URL | Request, init?: RequestInit) => {
        const u = new URL(typeof url === 'string' || url instanceof URL ? String(url) : url.url);
        if (u.origin !== m.baseURL || u.pathname !== '/api/chat' || (init?.method ?? 'GET').toUpperCase() !== 'POST') throw new Error('only /api/chat');
        if (requests >= BACKGROUND_MODEL_REQUESTS) throw new Error('no more requests');
        requests += 1;
        return base(u.href, init);
      }) as typeof fetch;
      const provider = new OllamaProvider({
        baseURL: m.baseURL,
        fetch: gatedFetch,
        think: false,
        defaultOptions: { temperature: 0, ...(m.numCtx !== undefined ? { num_ctx: m.numCtx } : {}) },
      });
      try {
        const r = await provider.generate({
          model: m.model,
          ...(input.system ? { system: input.system } : {}),
          messages: [{ id: 'background', role: 'user', content: input.prompt, timestamp: Date.now() }],
          ...(input.schema ? { responseFormat: { type: 'json_schema' as const, name: 'background_reply', schema: input.schema } } : {}),
          maxTokens: o.maxTokens,
          signal: ac.signal,
        });
        const text = r.message.content;
        // The model's own count of the prompt, not the estimate it was sized by: with the reply's
        // budget it must leave room in the window, or Ollama cut the prompt to make some.
        if (r.usage.input + o.maxTokens >= numCtx) throw new ReplyError('WindowFull');
        if (r.reason === 'max_tokens') throw new ReplyError('Truncated');
        if (text.trim().length === 0) throw new ReplyError('EmptyReply');
        if (input.schema) {
          let value: unknown;
          try {
            value = JSON.parse(text);
          } catch {
            throw new ReplyError('InvalidReply');
          }
          if (!matchesSchema(value, input.schema)) throw new ReplyError('InvalidReply');
        }
        return { text, usage: r.usage };
      } catch (err) {
        if (gaveWay) throw new ChatBusy();
        throw err;
      } finally {
        clearInterval(watch);
        o.signal.removeEventListener('abort', cancel);
      }
    },
  };
}
