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
import { ChatBusy, CompleteGate, localBackgroundBrain, localBackgroundModel, type BackgroundBrain, type CompleteGateDeps } from '../src/background-complete';
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
function chatReply(content: string): Response {
  return new Response(JSON.stringify({ message: { role: 'assistant', content }, done: true, done_reason: 'stop', prompt_eval_count: 40, eval_count: 9 }), {
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
function localGate(brain: BackgroundBrain | undefined, kindCaps: KindCaps = raised()) {
  const guard = new SpendGuard(ledger, { anthropic: {}, openai: {}, perplexity: {}, tavily: {} });
  return new CompleteGate({ guard, kindCaps, audit: auditSink(), brain: () => brain, now: () => NOON });
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

  it('does not start while Will is chatting', async () => {
    const { f, requests } = fakeOllama(() => chatReply('x'));
    const r = await localGate(localBackgroundBrain(LOCAL, { fetch: f, chatActive: () => true })).handle(REQ);
    expect(r).toEqual({ status: 502, body: { error: 'the call failed (ChatBusy)', reason: 'provider_failed' } });
    expect(requests).toHaveLength(0);
    expect(audit.at(-1)).toMatchObject({ outcome: 'failed', inputs: { error: 'ChatBusy' } });
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
