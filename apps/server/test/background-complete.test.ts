/**
 * /internal/complete (Machine plan P2 "Budget" test, 3.0.8). Two halves:
 *
 *  - The gate's money guards, against a brain that bills (a scripted stub
 *    behind a real Flint client and the real spend observer): a background call
 *    is refused at the $0 default, at its kind's cap, at 80% of the vendor's own
 *    cap, and on the unified view (missing, older than 2 h, 70%, or no vendor
 *    cap to hold it against); every refusal is audited. With a raised cap and
 *    room everywhere, a durable intent is written before the call, the call is
 *    metered under its kind, and the outcome is audited with its cost.
 *  - The brain main() actually wires: the local Ollama model (a fake Ollama).
 *    It answers with no key and no vendor cap, costs nothing, holds the reply
 *    to a JSON schema when asked, and gives way to Will's chat.
 *
 * No network, nothing paid.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Flint, costOf, makeAiError, type ProviderAdapter, type StreamEvent, type TokenUsage } from '@flint/core';
import { AuditUnavailable, type AuditRecord } from '../src/audit-sink';
import {
  ChatBusy,
  CompleteGate,
  DEFAULT_DAILY_CALLS,
  fitWindow,
  localBackgroundBrain,
  localBackgroundModel,
  matchesSchema,
  readKindCallCaps,
  type BackgroundBrain,
  type CompleteGateDeps,
  type KindCallCaps,
} from '../src/background-complete';
import type { LocalMemoryModel } from '../src/memory-brain';
import { SpendGuard, SpendLedger, readKindCaps, spendContext, spendObserver, type Caps, type KindCaps } from '../src/spend';

const NOON = Date.parse('2026-10-02T17:00:00Z');
const MODEL = 'claude-sonnet-4-6';
const USAGE: TokenUsage = { input: 1200, output: 300 };
const REQ = { kind: 'runtime', ref: 'es_cmabc123', system: 'You write one sentence.', prompt: 'Summarise: service api is down.', maxTokens: 200 };

function scripted(events: StreamEvent[]): ProviderAdapter & { calls: () => number } {
  let n = 0;
  return {
    name: 'anthropic',
    calls: () => n,
    getCapabilities: () => ({ toolCalling: 'native', structuredOutput: 'native', streaming: 'full', maxContextTokens: 200_000, maxOutputTokens: 8_192 }),
    estimateTokens: () => 10,
    generate: () => Promise.reject(new Error('stream only')),
    stream: () => {
      n++;
      return (async function* () {
        for (const e of events) yield e;
      })();
    },
  };
}

let dir: string;
let ledger: SpendLedger;
let audit: AuditRecord[];
let order: string[];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flint-complete-'));
  ledger = new SpendLedger({ dir, timeZone: 'America/Chicago', now: () => NOON });
  audit = [];
  order = [];
});

const auditSink = (opts: { failDurable?: boolean } = {}): CompleteGateDeps['audit'] => ({
  record: (e, durable = false) => {
    if (durable && opts.failDurable) throw new AuditUnavailable('the audit spool is full');
    const full = { ...e, id: `au${audit.length}`, at: new Date(NOON).toISOString() } as AuditRecord;
    audit.push(full);
    order.push(`audit:${e.kind}:${e.outcome}`);
    return full;
  },
});

/** A real Flint client on a scripted provider, metered by the real observer (as index.ts builds it). */
function frontier(events: StreamEvent[] = [{ type: 'text', delta: 'The api service is down.' }, { type: 'done', reason: 'complete', usage: USAGE }]) {
  const provider = scripted(events);
  const flint = new Flint({ provider, defaultModel: MODEL, observer: spendObserver(ledger), retryPolicy: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 } });
  const f: BackgroundBrain = {
    vendor: 'anthropic',
    model: MODEL,
    generate: async (input, o) => {
      order.push('call');
      const out = await flint.generate(input, { context: spendContext(o.kind), maxTokens: o.maxTokens, signal: o.signal });
      return { text: out.text, usage: out.usage };
    },
  };
  return { f, provider };
}

const vendorCaps = (anthropic: Caps['anthropic'] = { dailyUsd: 10, monthlyUsd: 100 }): Caps => ({ anthropic, openai: {}, perplexity: {}, tavily: {} });
const raised = (over: Partial<KindCaps['runtime']> = {}): KindCaps => ({ ...readKindCaps({}), runtime: { dailyUsd: 1, monthlyUsd: 5, ...over } });

function gate(o: { kindCaps?: KindCaps; caps?: Caps; external?: { asOf: string; dayUsd: number; monthUsd: number } | null; failDurable?: boolean; f?: BackgroundBrain | undefined; maxWaiting?: number } = {}) {
  const guard = new SpendGuard(ledger, o.caps ?? vendorCaps());
  const ext = o.external === undefined ? { asOf: new Date(NOON - 10 * 60_000).toISOString(), dayUsd: 1, monthUsd: 10 } : o.external;
  if (ext) guard.setExternal({ asOf: ext.asOf, vendors: { anthropic: { dayUsd: ext.dayUsd, monthUsd: ext.monthUsd } } });
  const made = 'f' in o ? { f: o.f, provider: undefined } : frontier();
  const g = new CompleteGate({ guard, kindCaps: o.kindCaps ?? readKindCaps({}), audit: auditSink({ failDurable: o.failDurable ?? false }), brain: () => made.f, now: () => NOON, ...(o.maxWaiting ? { maxWaiting: o.maxWaiting } : {}) });
  return { g, guard, provider: made.provider };
}

const ledgerRows = () =>
  readFileSync(join(dir, 'spend-2026-10.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as { kind: string; usd: number; vendor: string });

describe('kind caps', () => {
  it('unset, blank or junk is $0 for every background kind', () => {
    const warns: string[] = [];
    const c = readKindCaps({ FLINT_BUDGET_KIND_RUNTIME_DAILY_USD: '', FLINT_BUDGET_KIND_REVIEW_DAILY_USD: 'lots', FLINT_BUDGET_KIND_DISPATCH_MONTHLY_USD: '$2.50', FLINT_BUDGET_KIND_SELFMOD_DAILY_USD: '-1' }, (m) => warns.push(m));
    expect(c.runtime).toEqual({ dailyUsd: 0, monthlyUsd: 0 });
    expect(c.review).toEqual({ dailyUsd: 0, monthlyUsd: 0 });
    expect(c.dispatch).toEqual({ dailyUsd: 0, monthlyUsd: 2.5 });
    expect(c.selfmod).toEqual({ dailyUsd: 0, monthlyUsd: 0 });
    expect(warns).toHaveLength(2);
  });
});

describe('/internal/complete refuses', () => {
  it('at the default $0 cap, every kind, before anything is spent, and audits the refusal', async () => {
    const { g, provider } = gate();
    for (const kind of ['runtime', 'review', 'dispatch', 'selfmod']) {
      const r = await g.handle({ ...REQ, kind });
      expect(r).toMatchObject({ status: 402, body: { reason: 'kind_cap' } });
      expect(r.body).toHaveProperty('error', expect.stringContaining(`FLINT_BUDGET_KIND_${kind.toUpperCase()}_DAILY_USD`));
    }
    expect(provider!.calls()).toBe(0);
    expect(audit).toHaveLength(4);
    expect(audit[0]).toMatchObject({ actor: 'runtime', context: 'autonomous', kind: 'decision', action: 'runtime.frontier.complete', decision: 'deny', outcome: 'denied', inputs: { kind: 'runtime', ref: REQ.ref, reason: 'kind_cap' } });
    // Nothing the runtime sent (its prompt) is in the audit trail.
    expect(JSON.stringify(audit)).not.toContain('Summarise');
  });

  it('when only one of the two periods is raised', async () => {
    const { g } = gate({ kindCaps: raised({ monthlyUsd: 0 }) });
    expect(await g.handle(REQ)).toMatchObject({ status: 402, body: { reason: 'kind_cap' } });
  });

  it("when the kind's spend plus this call's estimate would pass its cap", async () => {
    // $0.998 spent; the call's estimate (about half a cent) does not fit under $1.
    ledger.record({ vendor: 'anthropic', model: MODEL, kind: 'runtime', usd: 0.998 });
    const { g, provider } = gate({ kindCaps: raised({ dailyUsd: 1 }) });
    const r = await g.handle(REQ);
    expect(r).toMatchObject({ status: 402, body: { reason: 'kind_cap' } });
    expect(r.body).toHaveProperty('error', expect.stringMatching(/daily cap/));
    expect(provider!.calls()).toBe(0);
    // Another kind's spend is not this kind's.
    expect(ledger.kindTotals('review').dayUsd).toBe(0);
  });

  it("at 80% of the vendor's own cap (background work waits there)", async () => {
    ledger.record({ vendor: 'anthropic', model: MODEL, kind: 'chat', usd: 8 });
    const { g } = gate({ kindCaps: raised() });
    expect(await g.handle(REQ)).toMatchObject({ status: 402, body: { reason: 'vendor_cap' } });
  });

  it('when the unified view is missing, older than 2 h, or from the future', async () => {
    expect(await gate({ kindCaps: raised(), external: null }).g.handle(REQ)).toMatchObject({ status: 402, body: { reason: 'unified_missing' } });
    const old = { asOf: new Date(NOON - 2 * 3600_000 - 1).toISOString(), dayUsd: 0, monthUsd: 0 };
    expect(await gate({ kindCaps: raised(), external: old }).g.handle(REQ)).toMatchObject({ status: 402, body: { reason: 'unified_stale' } });
    const future = { asOf: new Date(NOON + 3600_000).toISOString(), dayUsd: 0, monthUsd: 0 };
    expect(await gate({ kindCaps: raised(), external: future }).g.handle(REQ)).toMatchObject({ status: 402, body: { reason: 'unified_stale' } });
    expect(await gate({ kindCaps: raised(), external: { asOf: 'yesterday', dayUsd: 0, monthUsd: 0 } }).g.handle(REQ)).toMatchObject({ status: 402, body: { reason: 'unified_stale' } });
  });

  it("at 70% of Flint's cap on the unified view (every account's spend), daily or monthly", async () => {
    const at = (dayUsd: number, monthUsd: number) => gate({ kindCaps: raised(), external: { asOf: new Date(NOON).toISOString(), dayUsd, monthUsd } }).g.handle(REQ);
    expect(await at(7, 10)).toMatchObject({ status: 402, body: { reason: 'unified_70' } });
    expect(await at(1, 70)).toMatchObject({ status: 402, body: { reason: 'unified_70' } });
    expect(audit.filter((a) => a.inputs.reason === 'unified_70')).toHaveLength(2);
  });

  it('when Flint has no cap for the vendor: there is nothing to hold 70% against', async () => {
    const { g } = gate({ kindCaps: raised(), caps: vendorCaps({}) });
    expect(await g.handle(REQ)).toMatchObject({ status: 402, body: { reason: 'vendor_uncapped' } });
  });

  it('when the intent cannot be made durable: nothing is called', async () => {
    const { g, provider } = gate({ kindCaps: raised(), failDurable: true });
    expect(await g.handle(REQ)).toMatchObject({ status: 503, body: { reason: 'audit_unavailable' } });
    expect(provider!.calls()).toBe(0);
  });

  it('when there is no local model to ask, and when the request is not one', async () => {
    expect(await gate({ kindCaps: raised(), f: undefined }).g.handle(REQ)).toMatchObject({ status: 503, body: { reason: 'no_local_model' } });
    const { g } = gate({ kindCaps: raised() });
    expect(await g.handle({ ...REQ, kind: 'chat' })).toMatchObject({ status: 400, body: { reason: 'bad_request' } });
    expect(await g.handle({ ...REQ, maxTokens: 100_000 })).toMatchObject({ status: 400 });
    expect(await g.handle({ ...REQ, tools: [] })).toMatchObject({ status: 400 });
  });
});

describe('/internal/complete with a raised cap', () => {
  it('writes the intent before the call, meters it under its kind, and audits the outcome with its cost', async () => {
    const { g, provider } = gate({ kindCaps: raised() });
    const r = await g.handle(REQ);
    const cost = costOf('anthropic', MODEL, USAGE);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ text: 'The api service is down.', usage: USAGE, costUsd: Math.round(cost * 1e6) / 1e6 });
    expect(provider!.calls()).toBe(1);
    expect(order).toEqual(['audit:intent:pending', 'call', 'audit:spend:ok']);
    const [intent, done] = audit;
    expect(intent).toMatchObject({ kind: 'intent', action: 'runtime.frontier.complete', inputs: { kind: 'runtime', ref: REQ.ref, vendor: 'anthropic', model: MODEL, maxTokens: 200 } });
    expect(done).toMatchObject({ kind: 'spend', outcome: 'ok', correlationId: intent!.correlationId, inputs: { usageIn: 1200, usageOut: 300 } });
    expect(done!.costUsd).toBeCloseTo(cost, 6);
    expect(intent!.correlationId).toMatch(/^complete:es_cmabc123:[0-9a-f]{8}$/);
    // Metered into the ledger under its kind, so the kind's cap sees it.
    expect(ledgerRows()).toEqual([expect.objectContaining({ kind: 'runtime', vendor: 'anthropic' })]);
    expect(ledger.kindTotals('runtime').dayUsd).toBeCloseTo(cost, 6);
    expect(JSON.stringify(audit)).not.toContain('Summarise');
  });

  it('one call at a time: two calls that each fit, but not together, are not both made', async () => {
    // Room for one estimate (prompt + 200 answer tokens on Sonnet is well under a cent), not two.
    const { g, provider } = gate({ kindCaps: raised({ dailyUsd: 0.0075 }) });
    const [a, b] = await Promise.all([g.handle(REQ), g.handle(REQ)]);
    expect([a.status, b.status].sort()).toEqual([200, 402]);
    expect(provider!.calls()).toBe(1);
  });

  it('refuses as busy past the waiting limit', async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const slow: BackgroundBrain = { vendor: 'anthropic', model: MODEL, generate: async () => (await hold, { text: 'x', usage: { input: 1, output: 1 } }) };
    const { g } = gate({ kindCaps: raised(), f: slow, maxWaiting: 2 });
    const first = g.handle(REQ);
    const second = g.handle(REQ);
    expect(await g.handle(REQ)).toMatchObject({ status: 503, body: { reason: 'busy' } });
    release();
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
  });

  it("a provider failure is audited as failed with the error's class, never its words", async () => {
    const { g } = gate({ kindCaps: raised(), f: frontier([{ type: 'error', error: makeAiError('rate_limit', 'secret detail from the vendor', { retryable: false }) }]).f });
    const r = await g.handle(REQ);
    expect(r).toMatchObject({ status: 502, body: { reason: 'provider_failed' } });
    expect(r.body).toHaveProperty('error', 'the call failed (rate_limit)');
    expect(order).toEqual(['audit:intent:pending', 'call', 'audit:spend:failed']);
    expect(audit[1]).toMatchObject({ outcome: 'failed', inputs: { error: 'rate_limit' } });
    expect(JSON.stringify(audit)).not.toContain('secret detail');
  });
});

// ---------------------------------------------------------------------------
// the brain main() wires: the local model

/** Ollama's /api/chat reply for a non-streamed call. */
function chatReply(content: string, doneReason = 'stop', promptTokens = 40): Response {
  return new Response(JSON.stringify({ message: { role: 'assistant', content }, done: true, done_reason: doneReason, prompt_eval_count: promptTokens, eval_count: 9 }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

interface Seen {
  url: string;
  method: string | undefined;
  body: { model: string; messages: Array<{ role: string; content: string }>; format?: unknown; think?: boolean; stream: boolean; options?: Record<string, unknown> };
  signal: AbortSignal | undefined;
}

/** A fake Ollama: records each request, answers with `reply`. */
function fakeOllama(reply: (seen: Seen, n: number) => Response | Promise<Response>) {
  const requests: Seen[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const seen: Seen = { url: String(url), method: init?.method, body: JSON.parse(String(init?.body)), signal: init?.signal ?? undefined };
    requests.push(seen);
    return reply(seen, requests.length);
  }) as typeof fetch;
  return { f, requests };
}

const LOCAL: LocalMemoryModel = { baseURL: 'http://127.0.0.1:11434', model: 'muse-glimmer:30b', numCtx: 4096, unloadAfter: false };

/** The gate as main() builds it, with no vendor caps and no unified view at all: a local call needs neither. */
function localGate(brain: BackgroundBrain | undefined, kindCaps: KindCaps = raised(), opts: { callCaps?: KindCallCaps; now?: () => number } = {}) {
  const guard = new SpendGuard(ledger, { anthropic: {}, openai: {}, perplexity: {}, tavily: {} });
  return new CompleteGate({ guard, kindCaps, audit: auditSink(), brain: () => brain, now: opts.now ?? (() => NOON), ...(opts.callCaps ? { callCaps: opts.callCaps } : {}) });
}

describe('/internal/complete on the local model', () => {
  it('asks the chat brain\'s own Ollama model, with no key, no vendor cap and no unified view, and costs nothing', async () => {
    const { f, requests } = fakeOllama(() => chatReply('The api service is down.'));
    const r = await localGate(localBackgroundBrain(LOCAL, { fetch: f })).handle(REQ);
    expect(r).toEqual({ status: 200, body: { text: 'The api service is down.', usage: { input: 40, output: 9 }, costUsd: 0 } });
    expect(requests).toHaveLength(1);
    const [req] = requests;
    expect(req!.url).toBe('http://127.0.0.1:11434/api/chat');
    expect(req!.method).toBe('POST');
    expect(req!.body).toMatchObject({ model: 'muse-glimmer:30b', stream: false, think: false, options: { temperature: 0, num_ctx: 4096, num_predict: 200 } });
    expect(req!.body.messages).toEqual([{ role: 'system', content: REQ.system }, { role: 'user', content: REQ.prompt }]);
    expect(req!.body.format).toBeUndefined();
    // Free: the audit says so, and the spend ledger has no row for it.
    expect(audit.map((a) => [a.kind, a.outcome])).toEqual([['intent', 'pending'], ['spend', 'ok']]);
    expect(audit[0]).toMatchObject({ inputs: { kind: 'runtime', vendor: 'free', model: 'muse-glimmer:30b', estimateUsd: 0 } });
    expect(audit[1]).toMatchObject({ costUsd: 0 });
    expect(ledger.kindTotals('runtime')).toMatchObject({ dayUsd: 0, monthUsd: 0 });
    expect(JSON.stringify(audit)).not.toContain('Summarise');
  });

  it('holds the reply to the request\'s JSON schema (Ollama\'s format)', async () => {
    const schema = { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] };
    const { f, requests } = fakeOllama(() => chatReply('{"summary":"api is down"}'));
    const r = await localGate(localBackgroundBrain(LOCAL, { fetch: f })).handle({ ...REQ, schema });
    expect(r).toMatchObject({ status: 200, body: { text: '{"summary":"api is down"}' } });
    expect(requests[0]!.body.format).toEqual(schema);
  });

  it('a reply that is not the schema is asked again, three requests at most, then fails as its class', async () => {
    const { f, requests } = fakeOllama(() => chatReply('not json at all'));
    const r = await localGate(localBackgroundBrain(LOCAL, { fetch: f })).handle({ ...REQ, schema: { type: 'object' } });
    expect(r).toMatchObject({ status: 502, body: { reason: 'provider_failed' } });
    expect(requests).toHaveLength(3);
    expect(JSON.stringify(audit)).not.toContain('not json');
  });

  it('stays dormant at the default $0 caps: the kind\'s caps are its switch, and nothing is asked', async () => {
    const { f, requests } = fakeOllama(() => chatReply('x'));
    const r = await localGate(localBackgroundBrain(LOCAL, { fetch: f }), readKindCaps({})).handle(REQ);
    expect(r).toMatchObject({ status: 402, body: { reason: 'kind_cap' } });
    expect(requests).toHaveLength(0);
  });

  // Will's chat comes first, and giving way to it is not a failure of anything.
  it('does not start while Will is chatting: 503 busy, a refusal, with no intent and no failed call in the audit', async () => {
    const { f, requests } = fakeOllama(() => chatReply('x'));
    const r = await localGate(localBackgroundBrain(LOCAL, { fetch: f, chatActive: () => true })).handle(REQ);
    expect(r).toEqual({ status: 503, body: { error: 'Will is chatting; the local model is his', reason: 'busy' } });
    expect(requests).toHaveLength(0);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ kind: 'decision', decision: 'deny', outcome: 'denied', inputs: { reason: 'busy' } });
  });

  it('a call cut off because Will started chatting is 503 busy too: its intent is closed as skipped, never as a failed spend, and it is not one of the day\'s calls', async () => {
    let chatting = false;
    const { f, requests } = fakeOllama(
      (seen) =>
        new Promise((_, reject) => {
          seen.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
          chatting = true;
        }),
    );
    const g = localGate(localBackgroundBrain(LOCAL, { fetch: f, chatActive: () => chatting, pollMs: 5 }), raised(), { callCaps: { ...readKindCallCaps({}), runtime: 1 } });
    const r = await g.handle(REQ);
    expect(r).toEqual({ status: 503, body: { error: 'Will is chatting; the local model is his', reason: 'busy' } });
    expect(requests).toHaveLength(1);
    expect(audit.map((a) => [a.kind, a.outcome])).toEqual([['intent', 'pending'], ['decision', 'skipped']]);
    expect(audit[1]).toMatchObject({ correlationId: audit[0]!.correlationId, inputs: { reason: 'busy' } });
    expect(audit.some((a) => a.kind === 'spend')).toBe(false);
    // The one call a day this kind has is still there once Will is done.
    chatting = false;
    const again = fakeOllama(() => chatReply('ok'));
    const g2 = localGate(localBackgroundBrain(LOCAL, { fetch: again.f }), raised(), { callCaps: { ...readKindCallCaps({}), runtime: 1 } });
    expect((await g2.handle(REQ)).status).toBe(200);
  });

  it('is cut off the moment a chat turn starts', async () => {
    let chatting = false;
    const { f, requests } = fakeOllama(
      (seen) =>
        new Promise((_, reject) => {
          seen.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
          chatting = true; // Will sends a message while the call is running
        }),
    );
    const brain = localBackgroundBrain(LOCAL, { fetch: f, chatActive: () => chatting, pollMs: 5 });
    await expect(brain.generate({ system: '', prompt: 'p' }, { kind: 'runtime', maxTokens: 10, signal: new AbortController().signal })).rejects.toBeInstanceOf(ChatBusy);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.signal?.aborted).toBe(true);
  });

  it('an Ollama that is down is a failed call, never a reason to ask anyone else', async () => {
    const asked: string[] = [];
    const down = (async (url: string | URL | Request) => {
      asked.push(String(url));
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    const r = await localGate(localBackgroundBrain(LOCAL, { fetch: down })).handle(REQ);
    expect(r).toMatchObject({ status: 502, body: { reason: 'provider_failed' } });
    expect(asked).toEqual(['http://127.0.0.1:11434/api/chat']);
  });

  it('the gate\'s timeout reaches the model call', async () => {
    const { f, requests } = fakeOllama(
      (seen) => new Promise((_, reject) => seen.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')))),
    );
    const guard = new SpendGuard(ledger, { anthropic: {}, openai: {}, perplexity: {}, tavily: {} });
    const g = new CompleteGate({ guard, kindCaps: raised(), audit: auditSink(), brain: () => localBackgroundBrain(LOCAL, { fetch: f }), now: () => NOON, timeoutMs: 20 });
    expect(await g.handle(REQ)).toMatchObject({ status: 502, body: { reason: 'provider_failed' } });
    expect(requests[0]!.signal?.aborted).toBe(true);
  });
});

describe('localBackgroundModel (which local model background calls ask)', () => {
  it('the chat brain\'s model, host and num_ctx, so Ollama never reloads it between chat and a call', () => {
    const logs: string[] = [];
    expect(localBackgroundModel({ OLLAMA_HOST: 'http://127.0.0.1:11434/', OLLAMA_NUM_CTX: '8192' }, 'muse-glimmer:30b', (m) => logs.push(m))).toEqual({
      baseURL: 'http://127.0.0.1:11434',
      model: 'muse-glimmer:30b',
      numCtx: 8192,
      unloadAfter: false,
    });
    expect(localBackgroundModel({}, 'qwen2.5:7b', (m) => logs.push(m))).toMatchObject({ baseURL: 'http://127.0.0.1:11434', numCtx: 4096 });
    expect(logs).toEqual([]);
  });

  it('none when the chat model runs off this Mac, or the host is no URL: the reason is logged and calls answer 503', async () => {
    const logs: string[] = [];
    expect(localBackgroundModel({}, 'gpt-oss:120b-cloud', (m) => logs.push(m))).toBeUndefined();
    expect(localBackgroundModel({ OLLAMA_HOST: 'not a url' }, 'qwen2.5:7b', (m) => logs.push(m))).toBeUndefined();
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatch(/cloud model/);
    expect(await localGate(undefined).handle(REQ)).toMatchObject({ status: 503, body: { reason: 'no_local_model' } });
  });

  // An Anthropic key in the environment changes nothing: there is no path from here to it.
  it('ignores every vendor key', () => {
    const env = { ANTHROPIC_API_KEY: 'sk-ant-x', OPENAI_API_KEY: 'sk-x', FLINT_TIER_ROUTINE: 'anthropic:claude-sonnet-5-5' };
    expect(localBackgroundModel(env, 'muse-glimmer:30b', () => {})).toEqual(localBackgroundModel({}, 'muse-glimmer:30b', () => {}));
  });
});

describe('/internal/complete on the local model: a reply that is no answer is a failure, not a 200', () => {
  const failed = async (brain: BackgroundBrain, req: Record<string, unknown> = REQ) => {
    const r = await localGate(brain).handle(req);
    return [r.status, (r.body as { error?: string }).error, audit.at(-1)?.inputs.error];
  };

  it('an empty reply (after the provider\'s own retries)', async () => {
    const { f, requests } = fakeOllama(() => chatReply('   '));
    expect(await failed(localBackgroundBrain(LOCAL, { fetch: f }))).toEqual([502, 'the call failed (EmptyReply)', 'EmptyReply']);
    expect(requests).toHaveLength(3);
    expect(audit.at(-1)).toMatchObject({ kind: 'spend', outcome: 'failed' });
  });

  it('a reply cut off at its token limit (done_reason length), plain or to a schema', async () => {
    const plain = fakeOllama(() => chatReply('The api service is', 'length'));
    expect(await failed(localBackgroundBrain(LOCAL, { fetch: plain.f }))).toEqual([502, 'the call failed (Truncated)', 'Truncated']);
    const shaped = fakeOllama(() => chatReply('{"summary":"api is', 'length'));
    expect(await failed(localBackgroundBrain(LOCAL, { fetch: shaped.f }), { ...REQ, schema: { type: 'object' } })).toEqual([502, 'the call failed (Truncated)', 'Truncated']);
  });

  it('JSON that is not the schema asked for', async () => {
    const schema = { type: 'object', properties: { severity: { type: 'string', enum: ['low', 'high'] }, summary: { type: 'string' } }, required: ['severity', 'summary'], additionalProperties: false };
    for (const reply of ['{"severity":"medium","summary":"x"}', '{"summary":"x"}', '{"severity":"low","summary":7}', '{"severity":"low","summary":"x","extra":1}', '[]', '"low"']) {
      const { f } = fakeOllama(() => chatReply(reply));
      expect(await failed(localBackgroundBrain(LOCAL, { fetch: f }), { ...REQ, schema }), reply).toEqual([502, 'the call failed (InvalidReply)', 'InvalidReply']);
    }
    const ok = fakeOllama(() => chatReply('{"severity":"high","summary":"api is down"}'));
    expect((await localGate(localBackgroundBrain(LOCAL, { fetch: ok.f })).handle({ ...REQ, schema })).status).toBe(200);
    // What the model wrote never reaches the audit trail, only the class of what went wrong.
    expect(JSON.stringify(audit)).not.toContain('medium');
  });
});

describe('matchesSchema (the part of JSON Schema a reply\'s shape is written in)', () => {
  it('type, one or several, with integer a kind of number', () => {
    expect(matchesSchema('x', { type: 'string' })).toBe(true);
    expect(matchesSchema(3, { type: 'string' })).toBe(false);
    expect(matchesSchema(3, { type: 'integer' })).toBe(true);
    expect(matchesSchema(3.5, { type: 'integer' })).toBe(false);
    expect(matchesSchema(3, { type: 'number' })).toBe(true);
    expect(matchesSchema(null, { type: ['string', 'null'] })).toBe(true);
    expect(matchesSchema([], { type: 'object' })).toBe(false);
    expect(matchesSchema({}, { type: 'array' })).toBe(false);
    expect(matchesSchema(true, { type: 'boolean' })).toBe(true);
  });

  it('enum and const', () => {
    expect(matchesSchema('low', { enum: ['low', 'high'] })).toBe(true);
    expect(matchesSchema('mid', { enum: ['low', 'high'] })).toBe(false);
    expect(matchesSchema(1, { const: 1 })).toBe(true);
    expect(matchesSchema(2, { const: 1 })).toBe(false);
  });

  it('objects: properties, required, additionalProperties: false; arrays: items; all nested', () => {
    const schema = { type: 'object', required: ['items'], properties: { items: { type: 'array', items: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } }, additionalProperties: false } } } };
    expect(matchesSchema({ items: [{ id: 1 }, { id: 2 }] }, schema)).toBe(true);
    expect(matchesSchema({ items: [{ id: 1 }, { id: 'two' }] }, schema)).toBe(false);
    expect(matchesSchema({ items: [{ id: 1, more: true }] }, schema)).toBe(false);
    expect(matchesSchema({}, schema)).toBe(false);
    expect(matchesSchema({ items: [], other: 1 }, schema)).toBe(true); // additional properties are allowed unless the schema says not
  });

  // The review's two cases: valid replies it refused.
  it('enum and const compare by value: an object whose keys come in another order is the same object', () => {
    const point = { enum: [{ x: 1, y: { a: [1, { p: 1, q: 2 }], b: null } }] };
    expect(matchesSchema({ y: { b: null, a: [1, { q: 2, p: 1 }] }, x: 1 }, point)).toBe(true);
    expect(matchesSchema({ y: { b: null, a: [1, { q: 3, p: 1 }] }, x: 1 }, point)).toBe(false);
    expect(matchesSchema({ b: 2, a: 1 }, { const: { a: 1, b: 2 } })).toBe(true);
    expect(matchesSchema({ a: 1 }, { const: { a: 1, b: 2 } })).toBe(false);
    expect(matchesSchema([2, 1], { const: [1, 2] })).toBe(false); // an array's order is its value
  });

  it('patternProperties allows keys it cannot name, so additionalProperties: false does not refuse them', () => {
    const schema = { type: 'object', properties: { id: { type: 'string' } }, patternProperties: { '^x-': { type: 'string' } }, additionalProperties: false, required: ['id'] };
    expect(matchesSchema({ id: 'a', 'x-note': 'kept' }, schema)).toBe(true);
    expect(matchesSchema({ 'x-note': 'kept' }, schema)).toBe(false); // what it can check, it still checks
    expect(matchesSchema({ id: 7, 'x-note': 'kept' }, schema)).toBe(false);
    // Without patternProperties an unnamed key is still refused.
    expect(matchesSchema({ id: 'a', extra: 1 }, { ...schema, patternProperties: undefined })).toBe(false);
  });

  it('a keyword it does not know is not checked, and a schema that is no object matches anything', () => {
    expect(matchesSchema('abc', { type: 'string', minLength: 10 })).toBe(true);
    expect(matchesSchema(1, true)).toBe(true);
  });
});

describe('/internal/complete sizes the call to the model\'s window', () => {
  // 2 characters a token: what the runtime sends is log lines and JSON, which measured 2.3, not prose's 4.
  it('fitWindow: the reply as asked, up to half the window; the prompt in the rest at 2 characters a token, or it does not fit', () => {
    expect(fitWindow(4096, 1000, 200)).toEqual({ maxTokens: 200, promptRoom: (4096 - 200) * 2 });
    expect(fitWindow(4096, 1000, 4000)).toEqual({ maxTokens: 2048, promptRoom: 4096 });
    expect(fitWindow(4096, 4096, 4000)).toBeDefined();
    expect(fitWindow(4096, 4097, 4000)).toBeUndefined();
    expect(fitWindow(16384, 24_000, 4000)).toEqual({ maxTokens: 4000, promptRoom: 24_768 });
    // A prompt of log-like JSON at 2.3 characters a token that the old 3.5 let through: 13,000 characters is
    // about 5,650 tokens, more than the whole 4,096 window.
    expect(fitWindow(4096, 13_000, 200)).toBeUndefined();
  });

  // The estimate can still be wrong. The model's own count of the prompt is the check after the fact.
  it('a reply given with the window full is a failure: the prompt as the model counted it, plus the reply\'s budget, must fit', async () => {
    const full = fakeOllama(() => chatReply('An answer to a prompt that was cut.', 'stop', 3896));
    const r = await localGate(localBackgroundBrain(LOCAL, { fetch: full.f })).handle(REQ); // 3,896 + 200 reaches 4,096
    expect(r).toEqual({ status: 502, body: { error: 'the call failed (WindowFull)', reason: 'provider_failed' } });
    expect(audit.at(-1)).toMatchObject({ kind: 'spend', outcome: 'failed', inputs: { error: 'WindowFull' } });
    const room = fakeOllama(() => chatReply('An answer.', 'stop', 3895));
    expect((await localGate(localBackgroundBrain(LOCAL, { fetch: room.f })).handle(REQ)).status).toBe(200);
  });

  // The breaker's last review, F6: a constrained reply the adapter has to ask for again (the JSON did not
  // parse) sums its tries in usage.input. Three tries of a 1,500-token prompt read as 4,500 in a 4,096
  // window, and a reply that fit was refused as WindowFull.
  it('a reply that needed a second try is judged by that try\'s own prompt count, never the sum of the tries', async () => {
    const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
    const retried = fakeOllama((_seen, n) => (n < 3 ? chatReply('not json at all', 'stop', 1500) : chatReply('{"ok":true}', 'stop', 1500)));
    const r = await localGate(localBackgroundBrain(LOCAL, { fetch: retried.f })).handle({ ...REQ, schema });
    expect(retried.requests).toHaveLength(3);
    // 3 x 1,500 = 4,500 was summed, and 4,500 + 200 is past the 4,096 window; the last try alone is 1,500.
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ text: '{"ok":true}' });
    // The sum is still what the meter is told was processed.
    expect((r.body as { usage: { input: number } }).usage.input).toBe(4500);
    // And a last try that really did fill the window is still refused.
    const full = fakeOllama((_seen, n) => (n < 2 ? chatReply('nope', 'stop', 100) : chatReply('{"ok":true}', 'stop', 3896)));
    expect((await localGate(localBackgroundBrain(LOCAL, { fetch: full.f })).handle({ ...REQ, schema })).body).toMatchObject({ error: 'the call failed (WindowFull)' });
  });

  it('a reply budget over half the window is cut to it before the model is asked', async () => {
    const { f, requests } = fakeOllama(() => chatReply('ok'));
    const r = await localGate(localBackgroundBrain(LOCAL, { fetch: f })).handle({ ...REQ, maxTokens: 4000 });
    expect(r.status).toBe(200);
    expect(requests[0]!.body.options).toMatchObject({ num_ctx: 4096, num_predict: 2048 });
    expect(audit[0]).toMatchObject({ kind: 'intent', inputs: { maxTokens: 2048 } });
  });

  // Ollama would silently drop the start of it (the instructions) and answer something else.
  it('a prompt that does not fit is refused, 400 too_long, and the model is not asked', async () => {
    const { f, requests } = fakeOllama(() => chatReply('ok'));
    const r = await localGate(localBackgroundBrain(LOCAL, { fetch: f })).handle({ ...REQ, prompt: 'x'.repeat(10_000) });
    expect(r).toMatchObject({ status: 400, body: { reason: 'too_long' } });
    expect(r.body).toHaveProperty('error', expect.stringContaining("does not fit the model's 4096-token window"));
    expect(requests).toHaveLength(0);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ outcome: 'denied', inputs: { reason: 'too_long' } });
    // The same prompt fits the window the chat brain really has.
    const big = fakeOllama(() => chatReply('ok'));
    expect((await localGate(localBackgroundBrain({ ...LOCAL, numCtx: 16384 }, { fetch: big.f })).handle({ ...REQ, prompt: 'x'.repeat(10_000) })).status).toBe(200);
  });

  it('with no num_ctx from the chat brain, it sizes to Ollama\'s own 4,096', () => {
    expect(localBackgroundBrain({ ...LOCAL, numCtx: undefined }).numCtx).toBe(4096);
    expect(localBackgroundBrain({ ...LOCAL, numCtx: 8192 }).numCtx).toBe(8192);
  });
});

// Dollars bound a brain that bills. The local model is free, so calls a day are what bound a kind.
describe('/internal/complete: each kind\'s calls a day', () => {
  it('reads FLINT_BUDGET_KIND_<KIND>_DAILY_CALLS, 100 unless set, 0 a real cap', () => {
    const warns: string[] = [];
    const caps = readKindCallCaps({ FLINT_BUDGET_KIND_RUNTIME_DAILY_CALLS: '5', FLINT_BUDGET_KIND_REVIEW_DAILY_CALLS: '0', FLINT_BUDGET_KIND_DISPATCH_DAILY_CALLS: 'lots', FLINT_BUDGET_KIND_SELFMOD_DAILY_CALLS: '2.5' }, (m) => warns.push(m));
    expect(caps).toEqual({ runtime: 5, review: 0, dispatch: DEFAULT_DAILY_CALLS, selfmod: DEFAULT_DAILY_CALLS });
    expect(DEFAULT_DAILY_CALLS).toBe(100);
    expect(warns).toHaveLength(2);
    expect(readKindCallCaps({})).toEqual({ runtime: 100, review: 100, dispatch: 100, selfmod: 100 });
  });

  it('refuses once the kind has made its calls for the day (402 call_cap), per kind, and starts over the next day', async () => {
    const { f, requests } = fakeOllama(() => chatReply('ok'));
    let now = NOON;
    const all: KindCaps = { runtime: { dailyUsd: 1, monthlyUsd: 5 }, review: { dailyUsd: 1, monthlyUsd: 5 }, dispatch: { dailyUsd: 1, monthlyUsd: 5 }, selfmod: { dailyUsd: 1, monthlyUsd: 5 } };
    const g = localGate(localBackgroundBrain(LOCAL, { fetch: f }), all, { callCaps: { ...readKindCallCaps({}), runtime: 2 }, now: () => now });
    expect((await g.handle(REQ)).status).toBe(200);
    expect((await g.handle(REQ)).status).toBe(200);
    const third = await g.handle(REQ);
    expect(third).toMatchObject({ status: 402, body: { reason: 'call_cap' } });
    expect(third.body).toHaveProperty('error', expect.stringContaining('FLINT_BUDGET_KIND_RUNTIME_DAILY_CALLS'));
    expect(requests).toHaveLength(2);
    // Another kind has its own count.
    expect((await g.handle({ ...REQ, kind: 'review' })).status).toBe(200);
    // Tomorrow (the ledger's day, America/Chicago here) the count starts over.
    now = NOON + 24 * 3600_000;
    expect((await g.handle(REQ)).status).toBe(200);
  });

  it('a failed call is one of the day\'s calls: a model that keeps failing cannot be asked without end', async () => {
    const { f, requests } = fakeOllama(() => chatReply(''));
    const g = localGate(localBackgroundBrain(LOCAL, { fetch: f }), raised(), { callCaps: { ...readKindCallCaps({}), runtime: 1 } });
    expect((await g.handle(REQ)).status).toBe(502);
    expect(await g.handle(REQ)).toMatchObject({ status: 402, body: { reason: 'call_cap' } });
    expect(requests).toHaveLength(3); // the one call's own three tries
  });

  it('a cap of 0 turns a kind off, whatever its dollars say', async () => {
    const { f, requests } = fakeOllama(() => chatReply('ok'));
    const g = localGate(localBackgroundBrain(LOCAL, { fetch: f }), raised(), { callCaps: { ...readKindCallCaps({}), runtime: 0 } });
    expect(await g.handle(REQ)).toMatchObject({ status: 402, body: { reason: 'call_cap' } });
    expect(requests).toHaveLength(0);
  });
});
