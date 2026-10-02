/**
 * Event intake (P2 pipeline step 1) on flint_test with the real job bus: an
 * event and its triage job commit or roll back together, reconcile re-sends
 * what has no job (in bounded batches: the backfill after triage was off), a
 * fifth failure makes an event dead, an event happened when its source says,
 * and a source's first run is backfill.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { digestOf } from '@flint/policy';
import { NO_DB, freshDb, withClient, type TestUrls } from './db';
import { enrollTestKey } from './sign';
import { createDb, type Db } from '../src/db';
import { startBus, type Bus } from '../src/bus';
import { syncOnce } from '../src/sources/sync';
import { createProposal, approveProposal } from '../src/governance/proposals';
import { runInternal } from '../src/governance/internal';
import { triageEnqueue, type Enqueue } from '../src/events/record';
import { reconcile, sweepEvents, RECONCILE_LIMIT } from '../src/triage/reconcile';
import { isBackfill, sourceTime } from '../src/triage/facts';
import { raise } from '../src/health/watchdog';
import { processEvent } from '../src/triage/worker';
import type { Source, SourceName, SourceObservation, SourceRun } from '../src/sources/types';

const runAt = (now: Date): Omit<SourceRun, 'cursor'> => ({ now, signal: new AbortController().signal, fetch: async () => new Response(null, { status: 599 }) });
const fakeSource = (name: SourceName, observations: () => SourceObservation[]): Source => ({ name, cadenceMs: 1, run: async () => ({ observations: observations(), metrics: [] }) });
const service = (n: string, running: boolean): SourceObservation => ({
  type: 'service.status', kind: 'service', key: `service:launchd:${n}`, name: n, sensitivity: 'ops', externalId: n, state: { managedBy: 'launchd', loaded: true, running },
});

describe('source time and backfill', () => {
  const now = new Date('2026-10-02T12:00:00Z');
  it('takes a believable source time, else now', () => {
    expect(sourceTime('2026-10-01T08:00:00Z', now).toISOString()).toBe('2026-10-01T08:00:00.000Z');
    expect(sourceTime('2026-10-02T12:03:00Z', now)).toEqual(now);
    expect(sourceTime('2026-10-02T13:00:00Z', now)).toEqual(now);
    expect(sourceTime('1970-01-01T00:00:00Z', now)).toEqual(now);
    expect(sourceTime('not a date', now)).toEqual(now);
    expect(sourceTime(undefined, now)).toEqual(now);
  });
  it('is backfill when marked, or more than a day old when seen', () => {
    expect(isBackfill({ occurredAt: now, receivedAt: now, payload: { backfill: true } })).toBe(true);
    expect(isBackfill({ occurredAt: new Date(now.getTime() - 25 * 3_600_000), receivedAt: now, payload: {} })).toBe(true);
    expect(isBackfill({ occurredAt: new Date(now.getTime() - 23 * 3_600_000), receivedAt: now, payload: null })).toBe(false);
  });
});

describe.skipIf(NO_DB)('event intake (flint_test, real bus)', () => {
  let urls: TestUrls;
  let db: Db;
  let bus: Bus;
  let enqueue: Enqueue;
  const owner = (sql: string, params: unknown[] = []) => withClient(urls.owner, (c) => c.query(sql, params));
  const jobsFor = async (eventId: string) => (await owner(`SELECT data, singleton_key, state FROM pgboss.job WHERE name = 'triage' AND singleton_key = $1`, [eventId])).rows;
  const triageJobs = async () => Number((await owner(`SELECT count(*) AS n FROM pgboss.job WHERE name = 'triage'`)).rows[0].n);
  const age = (minutes: number) => owner(`UPDATE "SourceEvent" SET "receivedAt" = "receivedAt" - make_interval(mins => $1)`, [minutes]);

  async function enable(source: SourceName) {
    const key = await enrollTestKey(urls);
    const p = await createProposal(db, { kind: 'tool_call', origin: 'console', action: 'world.source.enable', args: { source }, argsProvenance: { source: { source: 'will', tainted: false } }, tainted: false, sensitivity: 'ops', destructive: false, consequential: false, ttlMinutes: 60 }, 'test');
    await approveProposal(db, p.id, await key.approve({ subjectId: p.id, action: 'world.source.enable', argsDigest: digestOf({ source }) }), undefined, 'test');
    await runInternal(db, p.id, undefined, 'UTC', 'test');
  }

  beforeAll(async () => {
    urls = await freshDb();
    db = createDb(urls.app);
    bus = await startBus(urls.app, () => {});
    enqueue = triageEnqueue(bus);
    for (const s of ['launchd', 'github', 'railway'] as const) await enable(s);
  });
  afterAll(async () => {
    await bus?.boss.stop({ graceful: false });
    await db?.$disconnect();
  });
  afterEach(async () => {
    await owner(`DELETE FROM pgboss.job`);
  });

  it('the event and its job commit or roll back together', async () => {
    let running = true;
    const src = fakeSource('launchd', () => [service('com.flint.intake', running)]);
    // The source's first run: its events are the world as it was.
    await syncOnce(db, src, runAt(new Date()), 'UTC', enqueue);
    const first = await db.sourceEvent.findFirstOrThrow({ where: { source: 'launchd' }, orderBy: { receivedAt: 'desc' } });
    expect(first.status).toBe('applied');
    expect(first.payload).toMatchObject({ backfill: true });
    expect(await jobsFor(first.id)).toEqual([{ data: { eventId: first.id }, singleton_key: first.id, state: 'created' }]);
    // The payload's hash is of the JSON as written.
    const text = (await owner(`SELECT payload::text AS t, "payloadHash" AS h FROM "SourceEvent" WHERE id = $1`, [first.id])).rows[0];
    expect(digestOf(JSON.parse(text.t))).toBe(text.h);

    // The send succeeds, then the transaction fails: neither the event nor its job is there.
    running = false;
    const boom: Enqueue = async (tx, id) => {
      await enqueue(tx, id);
      throw new Error('after the send');
    };
    const s = await syncOnce(db, src, runAt(new Date()), 'UTC', boom);
    expect(s.failed).toBe(1);
    const failed = await db.sourceEvent.findFirstOrThrow({ where: { source: 'launchd', status: 'failed' } });
    expect(failed.attempts).toBe(1);
    expect(failed.payload).not.toHaveProperty('backfill');
    expect(await jobsFor(failed.id)).toEqual([]);
    expect(await triageJobs()).toBe(1);

    // Next run: the failed event is taken back, applied, and gets its job.
    await syncOnce(db, src, runAt(new Date()), 'UTC', enqueue);
    const retaken = await db.sourceEvent.findUniqueOrThrow({ where: { id: failed.id } });
    expect(retaken).toMatchObject({ status: 'applied', attempts: 2, lastError: null });
    expect((await jobsFor(failed.id)).length).toBe(1);
  });

  it('an event committed without a job is triaged after one reconcile', async () => {
    const src = fakeSource('launchd', () => [service('com.flint.lost', true)]);
    await syncOnce(db, src, runAt(new Date()), 'UTC');
    const ev = await db.sourceEvent.findFirstOrThrow({ where: { source: 'launchd', sourceRef: { startsWith: 'com.flint.lost@' } } });
    expect(await jobsFor(ev.id)).toEqual([]);
    // Within the 2-minute grace, nothing: its job may still be on its way.
    expect((await reconcile(db, bus)).resent).toBe(0);
    await age(3);
    expect((await reconcile(db, bus)).resent).toBeGreaterThanOrEqual(1);
    expect((await jobsFor(ev.id)).length).toBe(1);
    // Waiting already: not sent twice.
    expect((await reconcile(db, bus)).resent).toBe(0);
  });

  it('triage off → no jobs; on → one bounded backfill', async () => {
    await owner(`UPDATE "SourceEvent" SET status = 'ignored' WHERE status = 'applied'`);
    const many = Array.from({ length: 250 }, (_, i) => ({
      type: 'service.railway', kind: 'service', key: `service:railway:bf${i}`, name: `bf${i}`, sensitivity: 'ops' as const, externalId: `railway:service:bf${i}`, state: { managedBy: 'railway' },
    }));
    // Triage off: the source runs, nothing is queued.
    await syncOnce(db, fakeSource('railway', () => many), runAt(new Date()), 'UTC');
    expect(await db.sourceEvent.count({ where: { source: 'railway', status: 'applied' } })).toBe(250);
    expect(await triageJobs()).toBe(0);
    // On again, two days later: reconcile sends them in batches of 200.
    await age(2 * 24 * 60);
    expect((await reconcile(db, bus)).resent).toBe(RECONCILE_LIMIT);
    expect((await reconcile(db, bus)).resent).toBe(50);
    expect((await reconcile(db, bus)).resent).toBe(0);
    expect(await triageJobs()).toBe(250);
  });

  it('old news is never an escalation: a critical event triaged a day after it arrived is logged in the relevant lane', async () => {
    const [id] = await raise(db, [{ type: 'backup.stale', ref: 'late-one', occurredAt: new Date(), payload: { hoursSince: 40 } }], new Date());
    await owner(`UPDATE "SourceEvent" SET "receivedAt" = "receivedAt" - interval '2 days', "occurredAt" = "occurredAt" - interval '2 days' WHERE id = $1`, [id]);
    expect(await processEvent({ eventId: id! }, { db, config: { tz: 'UTC' }, bus: { boss: { send: async () => null } } as never, load: async () => 'proceed' })).toBe('decided');
    expect(await db.triageDecision.findUniqueOrThrow({ where: { sourceEventId: id! } })).toMatchObject({ action: 'log', lane: 'relevant', critical: false, decidedBy: 'code:backup.stale' });
    expect(await db.escalation.count()).toBe(0);
  });

  it('a note the server never took is sent again; one waiting is not sent twice', async () => {
    const [ev] = await raise(db, [{ type: 'backup.stale', ref: 'undelivered', occurredAt: new Date(), payload: { hoursSince: 40 } }], new Date());
    const tenAgo = new Date(Date.now() - 10 * 60_000);
    await db.triageDecision.create({ data: { id: 'tdundeliv1', sourceEventId: ev!, action: 'escalate', lane: 'relevant', decidedBy: 'code:backup.stale', critical: true, shadow: false, sensitivity: 'ops', createdAt: tenAgo } });
    await db.escalation.create({ data: { id: 'esundeliv1', triageDecisionId: 'tdundeliv1', templateId: 'backup_stale', fields: { hoursSince: 40 }, title: 'Backups have stopped', body: 'x', channels: ['inapp'], sensitivity: 'ops', createdAt: tenAgo } });
    await db.escalationDelivery.create({ data: { id: 'edundeliv1', escalationId: 'esundeliv1', channel: 'inapp', status: 'pending', createdAt: tenAgo } });
    expect((await reconcile(db, bus)).redelivered).toBe(1);
    expect((await owner(`SELECT data FROM pgboss.job WHERE name = 'deliver'`)).rows).toEqual([{ data: { escalationId: 'esundeliv1' } }]);
    expect((await reconcile(db, bus)).redelivered).toBe(0);
  });

  it('failed → dead after 5 attempts', async () => {
    const src = fakeSource('launchd', () => [service('com.flint.poison', true)]);
    const boom: Enqueue = async () => {
      throw new Error('cannot apply');
    };
    for (let i = 0; i < 5; i++) await syncOnce(db, src, runAt(new Date()), 'UTC', boom);
    const ev = await db.sourceEvent.findFirstOrThrow({ where: { source: 'launchd', sourceRef: { startsWith: 'com.flint.poison@' } } });
    expect(ev).toMatchObject({ status: 'failed', attempts: 5 });
    expect((await sweepEvents(db)).dead).toBe(1);
    expect((await db.sourceEvent.findUniqueOrThrow({ where: { id: ev.id } })).status).toBe('dead');
    const audit = await db.auditEntry.findFirstOrThrow({ where: { action: 'events.dead' } });
    expect(audit.inputs).toMatchObject({ count: 1, sources: ['launchd'] });
    // Dead stays dead: a later run does not take it back.
    await syncOnce(db, src, runAt(new Date()), 'UTC', boom);
    expect(await db.sourceEvent.findUniqueOrThrow({ where: { id: ev.id } })).toMatchObject({ status: 'dead', attempts: 5 });
  });

  it('a failed event the same thing has since moved past is dead', async () => {
    let running = true;
    const src = fakeSource('launchd', () => [service('com.flint.moved', running)]);
    await syncOnce(db, src, runAt(new Date()), 'UTC', async () => { throw new Error('once'); });
    const failed = await db.sourceEvent.findFirstOrThrow({ where: { sourceRef: { startsWith: 'com.flint.moved@' }, status: 'failed' } });
    running = false;
    await syncOnce(db, src, runAt(new Date()), 'UTC');
    expect((await sweepEvents(db)).dead).toBe(1);
    expect((await db.sourceEvent.findUniqueOrThrow({ where: { id: failed.id } })).status).toBe('dead');
  });

  it('occurredAt = source change time', async () => {
    const now = new Date();
    const issue = (n: number, changedAt?: string): SourceObservation => ({
      type: 'issue.state', kind: 'issue', key: `issue:github:wpf002/flint#${n}`, name: `issue ${n}`, sensitivity: 'ops', externalId: `issue:wpf002/flint#${n}`,
      taintedPaths: ['name'], state: { number: n, state: 'open', labels: [], title: `issue ${n}` }, ...(changedAt ? { changedAt } : {}),
    });
    const changed = new Date(now.getTime() - 3 * 3_600_000).toISOString();
    await syncOnce(db, fakeSource('github', () => [issue(1, changed), issue(2), issue(3, new Date(now.getTime() + 3_600_000).toISOString())]), runAt(now), 'UTC', enqueue);
    const at = async (n: number) => (await db.sourceEvent.findFirstOrThrow({ where: { source: 'github', sourceRef: { startsWith: `issue:wpf002/flint#${n}@` } } })).occurredAt.toISOString();
    expect(await at(1)).toBe(changed);
    expect(await at(2)).toBe(now.toISOString());
    expect(await at(3)).toBe(now.toISOString());
    // Not the first run any more: a change is not backfill.
    await syncOnce(db, fakeSource('github', () => [{ ...issue(1, now.toISOString()), state: { number: 1, state: 'closed', labels: [], title: 'issue 1' }, status: 'archived' as const }]), runAt(new Date(now.getTime() + 1000)), 'UTC', enqueue);
    const closed = await db.sourceEvent.findFirstOrThrow({ where: { source: 'github', sourceRef: { startsWith: 'issue:wpf002/flint#1@' } }, orderBy: { receivedAt: 'desc' } });
    expect(closed.payload).not.toHaveProperty('backfill');
    expect(isBackfill(closed)).toBe(false);
  });

  it('a bot-opened PR applies through the world model, and the source stays healthy', async () => {
    const bot: SourceObservation = { type: 'pull_request.state', kind: 'pull_request', key: 'pull_request:github:wpf002/flint#99', name: 'Bump x', sensitivity: 'ops', externalId: 'pull_request:wpf002/flint#99', taintedPaths: ['name', 'state.title'], state: { number: 99, state: 'open', title: 'Bump x', byBot: true } };
    const s = await syncOnce(db, fakeSource('github', () => [bot]), runAt(new Date()), 'UTC', enqueue);
    expect(s.failed).toBe(0);
    expect((await db.sourceEvent.findFirstOrThrow({ where: { sourceRef: { startsWith: 'pull_request:wpf002/flint#99@' } } })).status).toBe('applied');
    expect((await db.sourceCursor.findUniqueOrThrow({ where: { source: 'github' } })).consecutiveFailures).toBe(0);
  });
});
