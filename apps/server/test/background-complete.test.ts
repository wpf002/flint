/**
 * /internal/complete (Machine plan P2 "Budget" test, 3.0.8): a background
 * frontier call is refused at the $0 default, at its kind's cap, at 80% of the
 * vendor's own cap, and on the unified view (missing, older than 2 h, 70%, or
 * no vendor cap to hold it against); every refusal is audited. With a raised
 * cap and room everywhere, a durable intent is written before the call, the
 * call is metered under its kind, and the outcome is audited with its cost.
 * The provider is a scripted stub behind a real Flint client and the real
 * spend observer: no network, nothing paid.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Flint, costOf, makeAiError, type ProviderAdapter, type StreamEvent, type TokenUsage } from '@flint/core';
import { AuditUnavailable, type AuditRecord } from '../src/audit-sink';
import { CompleteGate, type BackgroundFrontier, type CompleteGateDeps } from '../src/background-complete';
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
  const f: BackgroundFrontier = {
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

function gate(o: { kindCaps?: KindCaps; caps?: Caps; external?: { asOf: string; dayUsd: number; monthUsd: number } | null; failDurable?: boolean; f?: BackgroundFrontier | undefined; maxWaiting?: number } = {}) {
  const guard = new SpendGuard(ledger, o.caps ?? vendorCaps());
  const ext = o.external === undefined ? { asOf: new Date(NOON - 10 * 60_000).toISOString(), dayUsd: 1, monthUsd: 10 } : o.external;
  if (ext) guard.setExternal({ asOf: ext.asOf, vendors: { anthropic: { dayUsd: ext.dayUsd, monthUsd: ext.monthUsd } } });
  const made = 'f' in o ? { f: o.f, provider: undefined } : frontier();
  const g = new CompleteGate({ guard, kindCaps: o.kindCaps ?? readKindCaps({}), audit: auditSink({ failDurable: o.failDurable ?? false }), frontier: () => made.f, now: () => NOON, ...(o.maxWaiting ? { maxWaiting: o.maxWaiting } : {}) });
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

  it('when there is no frontier, and when the request is not one', async () => {
    expect(await gate({ kindCaps: raised(), f: undefined }).g.handle(REQ)).toMatchObject({ status: 503, body: { reason: 'no_frontier' } });
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
    const slow: BackgroundFrontier = { vendor: 'anthropic', model: MODEL, generate: async () => (await hold, { text: 'x', usage: { input: 1, output: 1 } }) };
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
    expect(r.body).toHaveProperty('error', 'the frontier call failed (rate_limit)');
    expect(order).toEqual(['audit:intent:pending', 'call', 'audit:spend:failed']);
    expect(audit[1]).toMatchObject({ outcome: 'failed', inputs: { error: 'rate_limit' } });
    expect(JSON.stringify(audit)).not.toContain('secret detail');
  });
});
