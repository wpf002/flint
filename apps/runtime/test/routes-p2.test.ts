/**
 * The runtime's P2 routes on flint_test (Fastify inject, real bus): scopes
 * per route (the connector's token can read projections and nothing else),
 * pushed events deduped on their id and triaged unless they are measurements,
 * acknowledgements and labels written with their audit entries, projections
 * that never carry reasoning or a tainted title, paging, and one vendor-cap
 * escalation whichever of the server and the watchdog says it first.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { digestOf, entityRef } from '@flint/policy';
import { NO_DB, freshDb, withClient, type TestUrls } from './db';
import { enrollTestKey } from './sign';
import { buildApp, type RuntimeStatus } from '../src/app';
import { createDb, type Db } from '../src/db';
import { startBus, type Bus } from '../src/bus';
import { loadConfig, SCOPES, type Config, type RuntimeScope } from '../src/config';
import { syncOnce } from '../src/sources/sync';
import { createProposal, approveProposal } from '../src/governance/proposals';
import { runInternal } from '../src/governance/internal';
import { processEvent, type WorkerDeps } from '../src/triage/worker';
import { raise } from '../src/health/watchdog';
import type { Source, SourceObservation, SourceRun } from '../src/sources/types';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const SERVER = 'server-token-0123456789abcdef';
const MCP = 'mcp-token-0123456789abcdef01';
const MARKER = 'MARKER-ro8f2';
const runAt = (now: Date): Omit<SourceRun, 'cursor'> => ({ now, signal: new AbortController().signal, fetch: async () => new Response(null, { status: 599 }) });
const id32 = () => randomBytes(16).toString('hex');

describe.skipIf(NO_DB)('runtime P2 routes', () => {
  let urls: TestUrls;
  let db: Db;
  let bus: Bus;
  let config: Config;
  let app: ReturnType<typeof buildApp>;
  const status: RuntimeStatus = { problems: new Set(), busStartedAt: null };
  const owner = (sql: string, params: unknown[] = []) => withClient(urls.owner, (c) => c.query(sql, params));
  const call = (method: 'GET' | 'POST', url: string, body?: unknown, token = SERVER) =>
    app.inject({ method, url, ...(body !== undefined ? { payload: body as object } : {}), headers: token ? { authorization: `Bearer ${token}` } : {} });
  const deps = (): WorkerDeps => ({
    db, config, bus, load: async () => 'proceed',
    fetch: (async () => new Response(JSON.stringify({ model: 'm', message: { role: 'assistant', content: JSON.stringify({ relevance: 0.95, reasonCode: 'needs_will', reasoning: `it says ${MARKER}` }) }, done: true, done_reason: 'stop' }), { status: 200 })) as unknown as typeof fetch,
  });
  const chatTurn = (id = id32()) => ({ id, type: 'chat.turn', at: new Date().toISOString(), brain: 'local', outcome: 'answered', tools: [], ms: 5, tainted: false });

  beforeAll(async () => {
    urls = await freshDb();
    db = createDb(urls.app);
    bus = await startBus(urls.app, () => {});
    status.bus = bus;
    config = loadConfig({ DATABASE_URL: urls.app, HOME: '/nonexistent', FLINT_RUNTIME_TRIAGE: 'on', FLINT_TRIAGE_MODEL: 'muse-glimmer:30b', FLINT_TZ: 'UTC' });
    app = buildApp({
      db, status,
      config: {
        tz: 'UTC', triage: true,
        tokens: [
          { name: 'server', sha256: sha(SERVER), scopes: new Set(SCOPES) },
          { name: 'runtime-mcp', sha256: sha(MCP), scopes: new Set<RuntimeScope>(['world:read', 'ledger']) },
        ],
      },
    });
    const key = await enrollTestKey(urls);
    const p = await createProposal(db, { kind: 'tool_call', origin: 'console', action: 'world.source.enable', args: { source: 'github' }, argsProvenance: { source: { source: 'will', tainted: false } }, tainted: false, sensitivity: 'ops', destructive: false, consequential: false, ttlMinutes: 60 }, 'test');
    await approveProposal(db, p.id, await key.approve({ subjectId: p.id, action: 'world.source.enable', argsDigest: digestOf({ source: 'github' }) }), undefined, 'test');
    await runInternal(db, p.id, undefined, 'UTC', 'test');
  });
  afterAll(async () => {
    await app?.close();
    await bus?.boss.stop({ graceful: false });
    await db?.$disconnect();
  });
  afterEach(async () => {
    await owner(`DELETE FROM pgboss.job`);
  });

  it('scopes: the connector\'s token reads the projections and nothing else', async () => {
    for (const [method, url, body] of [
      ['POST', '/v1/events', { events: [chatTurn()] }],
      ['GET', '/v1/inbox?lane=relevant'],
      ['POST', '/v1/inbox/td1/feedback', { feedback: 'ok' }],
      ['POST', '/v1/escalations/es1/ack', {}],
      ['POST', '/v1/escalations/es1/dismiss', {}],
      ['GET', '/v1/health/report'],
    ] as const) {
      expect((await call(method, url, body, '')).statusCode, url).toBe(401);
      expect((await call(method, url, body, MCP)).statusCode, url).toBe(403);
    }
    for (const url of ['/v1/triage/recent', '/v1/escalations/open', '/v1/triage/decisions/td0000/explain']) {
      expect((await call('GET', url, undefined, '')).statusCode).toBe(401);
      expect([200, 404]).toContain((await call('GET', url, undefined, MCP)).statusCode);
    }
  });

  it('refuses bad input: 400 for the contract, 400 for a NUL, 413 for size', async () => {
    expect((await call('POST', '/v1/events', { events: [{ ...chatTurn(), outcome: 'mysterious' }] })).statusCode).toBe(400);
    expect((await call('POST', '/v1/events', { events: [{ ...chatTurn(), tools: ['a\u0000b'] }] })).statusCode).toBe(400);
    expect((await call('POST', '/v1/events', { events: [] })).statusCode).toBe(400);
    expect((await call('POST', '/v1/events', { events: [chatTurn()], pad: 'x'.repeat(70_000) })).statusCode).toBe(413);
    expect((await call('GET', '/v1/inbox?lane=loud')).statusCode).toBe(400);
    expect((await call('GET', '/v1/triage/recent?limit=21', undefined, MCP)).statusCode).toBe(400);
    expect((await call('POST', '/v1/escalations/es1/ack', { force: true })).statusCode).toBe(400);
  });

  it('the same event id twice is one event; a chat turn is counted, never triaged; a route error is', async () => {
    const turn = chatTurn();
    const err = { id: id32(), type: 'route.error', at: new Date().toISOString(), route: 'chat', status: 502 };
    expect((await call('POST', '/v1/events', { events: [turn, err] })).json()).toEqual({ accepted: 2, duplicates: 0 });
    expect((await call('POST', '/v1/events', { events: [turn, err] })).json()).toEqual({ accepted: 0, duplicates: 2 });
    expect(await db.sourceEvent.count({ where: { source: 'server', sourceRef: { in: [turn.id, err.id] } } })).toBe(2);
    const jobs = (await owner(`SELECT data FROM pgboss.job WHERE name = 'triage'`)).rows.map((r) => r.data.eventId);
    const errEvent = await db.sourceEvent.findFirstOrThrow({ where: { sourceRef: err.id } });
    expect(jobs).toEqual([errEvent.id]);
  });

  it('projections never carry reasoning or a tainted title; the console\'s lane has both, under the taint mark', async () => {
    const issue = (n: number, title: string): SourceObservation => ({ type: 'issue.state', kind: 'issue', key: `issue:github:wpf002/flint#${n}`, name: title, sensitivity: 'ops', externalId: `issue:wpf002/flint#${n}`, taintedPaths: ['name', 'state.title'], state: { number: n, state: 'open', labels: [], title } });
    const src = (list: SourceObservation[]): Source => ({ name: 'github', cadenceMs: 1, run: async () => ({ observations: list, metrics: [] }) });
    await syncOnce(db, src([issue(1, 'first')]), runAt(new Date()), 'UTC');
    await syncOnce(db, src([issue(1, 'first'), issue(2, `Help ${MARKER}`), issue(3, 'Third one')]), runAt(new Date()), 'UTC');
    for (const ev of await db.sourceEvent.findMany({ where: { source: 'github' } })) await processEvent({ eventId: ev.id }, deps());

    const recent = await call('GET', '/v1/triage/recent?limit=2', undefined, MCP);
    expect(recent.statusCode).toBe(200);
    const r = recent.json();
    expect(r.decisions).toHaveLength(2);
    expect(r.more).toBe(1);
    expect(recent.body).not.toMatch(/reasoning|MARKER|Help/);
    expect(r.decisions[0]).toMatchObject({ lane: 'relevant', action: 'escalate', source: 'github', eventType: 'issue.state', tainted: true });
    expect(r.decisions[0].entity).toMatch(/^issue#[A-Za-z0-9]{6}$/);

    const open = await call('GET', '/v1/escalations/open', undefined, MCP);
    expect(open.json().escalations.map((x: { title: string; tainted: boolean }) => [x.title, x.tainted])).toEqual([['Something new needs a look', true], ['Something new needs a look', true]]);

    const decisionId = r.decisions[0].id;
    const explained = await call('GET', `/v1/triage/decisions/${decisionId}/explain`, undefined, MCP);
    expect(explained.body).not.toMatch(/reasoning|MARKER/);
    expect(explained.json()).toMatchObject({ id: decisionId, decidedBy: 'model:ollama:muse-glimmer:30b', escalation: { templateId: 'new_item', fields: { kind: 'issue', reasonCode: 'needs_will' } } });
    expect((await call('GET', '/v1/triage/decisions/tdnosuch/explain', undefined, MCP)).statusCode).toBe(404);

    // The console's lane: the reasoning, the real name, and the mark that says they were read from a stranger.
    const lane = (await call('GET', '/v1/inbox?lane=relevant&limit=1')).json();
    expect(lane.items).toHaveLength(1);
    expect(lane.next).not.toBeNull();
    expect(lane.items[0]).toMatchObject({ tainted: true, escalation: { status: 'open', channels: ['inapp', 'banner', 'push'] } });
    const older = (await call('GET', `/v1/inbox?lane=relevant&before=${encodeURIComponent(lane.next)}`)).json();
    expect(older.items.map((i: { id: string }) => i.id)).not.toContain(lane.items[0].id);
    const all = [...lane.items, ...older.items];
    expect(all.some((i: { reasoning: string | null; entity: { name: string } }) => i.reasoning?.includes(MARKER) && i.entity.name.includes(MARKER))).toBe(true);
    expect((await call('GET', '/v1/world/now', undefined, MCP)).json().openEscalations).toBe(2);
  });

  it('ack and dismiss: once each way, with the console\'s audit entry; a label sets usefulness too', async () => {
    const [a, b] = await db.escalation.findMany({ where: { status: 'open' }, orderBy: { createdAt: 'asc' } });
    expect((await call('POST', `/v1/escalations/${a!.id}/ack`, {})).json()).toEqual({ ok: true });
    expect((await call('POST', `/v1/escalations/${a!.id}/ack`, {})).statusCode).toBe(409);
    expect((await call('POST', `/v1/escalations/${a!.id}/dismiss`)).statusCode).toBe(200);
    expect((await call('POST', `/v1/escalations/${a!.id}/dismiss`, {})).statusCode).toBe(409);
    expect((await call('POST', '/v1/escalations/esnosuch/ack', {})).statusCode).toBe(404);
    const audits = await db.auditEntry.findMany({ where: { correlationId: { in: [`${a!.id}.ack`, `${a!.id}.dismiss`] } }, orderBy: { at: 'asc' } });
    expect(audits.map((x) => [x.actor, x.context, x.kind, x.action])).toEqual([['will:console', 'console', 'action', 'escalation.ack'], ['will:console', 'console', 'action', 'escalation.dismiss']]);
    // An acknowledgement is never the proof that something was done.
    const acted = await withClient(urls.app, (c) => c.query(`UPDATE "Escalation" SET status = 'acted', "actedAuditId" = $2 WHERE id = $1`, [b!.id, audits[0]!.id]).catch((e) => e));
    expect(acted.code).toBe('23514');

    expect((await call('POST', `/v1/inbox/${b!.triageDecisionId}/feedback`, { feedback: 'should_be_quiet' })).json()).toEqual({ ok: true });
    expect(await db.triageDecision.findUniqueOrThrow({ where: { id: b!.triageDecisionId } })).toMatchObject({ feedback: 'should_be_quiet' });
    expect((await db.escalation.findUniqueOrThrow({ where: { id: b!.id } })).useful).toBe(false);
    expect(await db.auditEntry.count({ where: { action: 'triage.feedback', correlationId: `${b!.triageDecisionId}.feedback` } })).toBe(1);
    expect((await call('POST', `/v1/inbox/${b!.triageDecisionId}/feedback`, { feedback: 'meh' })).statusCode).toBe(400);
    expect((await call('POST', '/v1/inbox/tdnosuch/feedback', { feedback: 'ok' })).statusCode).toBe(404);
  });

  it('the health report is the contract', async () => {
    const r = await call('GET', '/v1/health/report');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ triage: 'on', components: [] });
  });

  it('a vendor at its cap is one escalation, whichever of the server and the watchdog says it first', async () => {
    // The watchdog first, then the server.
    await raise(db, [{ type: 'vendor.cap_100', ref: 'openai:today', occurredAt: new Date(), payload: { vendor: 'openai' } }], new Date());
    const thr = { id: id32(), type: 'spend.threshold', at: new Date().toISOString(), vendor: 'openai', level: 'exhausted', period: 'day' };
    await call('POST', '/v1/events', { events: [thr] });
    for (const ev of await db.sourceEvent.findMany({ where: { OR: [{ type: 'vendor.cap_100' }, { type: 'spend.threshold' }] }, orderBy: { receivedAt: 'asc' } })) await processEvent({ eventId: ev.id }, deps());
    expect(await db.escalation.count({ where: { templateId: 'vendor_cap' } })).toBe(1);
    const second = await db.triageDecision.findFirstOrThrow({ where: { decidedBy: 'code:spend.threshold' } });
    expect(second).toMatchObject({ action: 'log', lane: 'relevant', critical: false });
    expect(entityRef('x', 'abcdef123456')).toBe('x#123456');
  });
});
