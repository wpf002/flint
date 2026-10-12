/**
 * Health on flint_test: unknown and stale are not ok, disabled sources are
 * left out, the bus is degraded by dead letters; the watchdog raises each
 * critical condition once per occurrence (a service down from the first down
 * observation, 30 minutes on; a backup once per last good one; the latest
 * drill only; a migration once per sha; a vendor once a day unless the server
 * said so); circuits open once and close once; details are redacted; the
 * spend view goes to the server. A calendar's warnings are said as they are
 * (only a skip, or no calendars, is an issue), and a disconnected Apple
 * Calendar is ok, never stale, and not in the digest. Goal reviews (P3) are
 * disabled while the planner is off; on, a review over an hour late is
 * degraded and over a day late is down, said in counts, never a goal's words.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digestOf, localDay } from '@flint/policy';
import { NO_DB, freshDb, withClient, type TestUrls } from './db';
import { enrollTestKey } from './sign';
import { createDb, type Db } from '../src/db';
import { loadConfig, type Config } from '../src/config';
import { syncOnce } from '../src/sources/sync';
import { createProposal, approveProposal } from '../src/governance/proposals';
import { runInternal } from '../src/governance/internal';
import { markProcessed, recordEvent } from '../src/events/record';
import { checkComponents, healthReport, recordChecks } from '../src/health/checks';
import { raise, watchdog } from '../src/health/watchdog';
import { circuitAllows, circuitEvents } from '../src/health/circuits';
import { pushSpend } from '../src/spend/push';
import { buildDigest } from '../src/digest';
import { googleCalendarSource } from '../src/sources/google/calendar';
import { appleCalendarSource } from '../src/sources/apple/calendar';
import { CalendarInbox } from '../src/sources/apple/inbox';
import { parseSnapshot } from '../src/sources/apple/wire';
import type { Source, SourceObservation, SourceRun } from '../src/sources/types';
import { healthName } from '@flint/policy';
import { runReview } from '../src/goals/review';
import { FakeBus, goalFixture } from './goals/fixture';

const runAt = (now: Date): Omit<SourceRun, 'cursor'> => ({ now, signal: new AbortController().signal, fetch: async () => new Response(null, { status: 599 }) });
const MIN = 60_000;

describe('circuits', () => {
  const t0 = new Date('2026-10-02T12:00:00Z');
  const at = (failures: number, lastOk: Date | null, updated = t0) => ({ consecutiveFailures: failures, lastOkAt: lastOk, updatedAt: updated });
  it('opens at 5 failures (one event), backs off to one try every 6 cadences, closes once', () => {
    expect(circuitEvents('github', at(3, t0), at(4, t0), t0)).toEqual([]);
    const open = circuitEvents('github', at(4, t0), at(5, t0), t0);
    expect(open).toMatchObject([{ type: 'source.circuit_open', ref: `github:${t0.toISOString()}`, payload: { source: 'github', failures: 5 } }]);
    expect(circuitEvents('github', at(5, t0), at(6, t0), t0)).toEqual([]);
    expect(circuitAllows(at(5, t0, t0), 5 * MIN, new Date(t0.getTime() + 29 * MIN))).toBe(false);
    expect(circuitAllows(at(5, t0, t0), 5 * MIN, new Date(t0.getTime() + 30 * MIN))).toBe(true);
    expect(circuitAllows(at(4, t0, t0), 5 * MIN, t0)).toBe(true);
    expect(circuitEvents('github', at(9, t0), at(0, new Date()), t0)).toMatchObject([{ type: 'source.circuit_closed', ref: open[0]!.ref }]);
  });
});

describe('the spend push', () => {
  it('posts Flint\'s ledger per vendor as an estimate, to the internal listener only', async () => {
    const home = mkdtempSync(join(tmpdir(), 'spend-push-'));
    mkdirSync(join(home, '.flint', 'spend'), { recursive: true });
    const now = new Date('2026-10-02T15:00:00Z');
    writeFileSync(join(home, '.flint', 'spend', 'spend-2026-10.jsonl'), `${JSON.stringify({ ts: now.getTime() - 1000, vendor: 'anthropic', usd: 0.25 })}\n${JSON.stringify({ ts: now.getTime() - 86_400_000, vendor: 'anthropic', usd: 1 })}\n`);
    const seen: Array<{ url: string; body: unknown; auth: string | null }> = [];
    const f = (async (url: string, init: RequestInit) => (seen.push({ url, body: JSON.parse(String(init.body)), auth: new Headers(init.headers).get('authorization') }), new Response('{"ok":true}'))) as unknown as typeof fetch;
    const server = { url: 'http://[::1]:8081', token: 'k'.repeat(64) };
    expect(await pushSpend({ server, home, tz: 'America/Chicago' }, now, f)).toBe('pushed');
    expect(seen[0]!.url).toBe('http://[::1]:8081/internal/spend-external');
    expect(seen[0]!.auth).toBe(`Bearer ${server.token}`);
    expect(seen[0]!.body).toMatchObject({ asOf: now.toISOString(), vendors: { anthropic: { dayUsd: 0.25, monthUsd: 1.25, estimate: true }, openai: { dayUsd: 0, monthUsd: 0, estimate: true } } });
    expect(await pushSpend({ home, tz: 'UTC' }, now, f)).toBe('skipped');
    expect(await pushSpend({ server, home, tz: 'UTC' }, now, (async () => new Response('', { status: 500 })) as unknown as typeof fetch)).toBe('failed');
  });
});

describe.skipIf(NO_DB)('health and the watchdog on flint_test', () => {
  let urls: TestUrls;
  let db: Db;
  let config: Config;
  let home: string;
  let key: Awaited<ReturnType<typeof enrollTestKey>>;
  const owner = (sql: string, params: unknown[] = []) => withClient(urls.owner, (c) => c.query(sql, params));
  /** A source turned on as Will turns one on: a world.source.enable he signed. */
  async function enable(source: string) {
    const p = await createProposal(db, { kind: 'tool_call', origin: 'console', action: 'world.source.enable', args: { source }, argsProvenance: { source: { source: 'will', tainted: false } }, tainted: false, sensitivity: 'ops', destructive: false, consequential: false, ttlMinutes: 60 }, 'test');
    await approveProposal(db, p.id, await key.approve({ subjectId: p.id, action: 'world.source.enable', argsDigest: digestOf({ source }) }), undefined, 'test');
    await runInternal(db, p.id, undefined, 'UTC', 'test');
  }
  const svc = (running: boolean, lastExit = 0): SourceObservation => ({ type: 'service.status', kind: 'service', key: 'service:launchd:com.flint.watched', name: 'com.flint.watched', sensitivity: 'ops', externalId: 'com.flint.watched', state: { managedBy: 'launchd', loaded: true, running, lastExit, disabled: false } });
  const launchd = (o: () => SourceObservation[]): Source => ({ name: 'launchd', cadenceMs: 2 * MIN, run: async () => ({ observations: o(), metrics: [] }) });

  beforeAll(async () => {
    urls = await freshDb();
    db = createDb(urls.app);
    home = mkdtempSync(join(tmpdir(), 'health-home-'));
    config = loadConfig({ DATABASE_URL: urls.app, HOME: home, FLINT_TZ: 'UTC', FLINT_RUNTIME_TRIAGE: 'on' });
    key = await enrollTestKey(urls);
    await enable('launchd');
  });
  afterAll(async () => db?.$disconnect());

  it('unknown and stale are not ok; a disabled source is shown and left out; the bus is degraded by dead letters', async () => {
    const now = new Date();
    await syncOnce(db, launchd(() => [svc(true)]), runAt(now), 'UTC');
    await owner(`INSERT INTO pgboss.job (name, data) VALUES ('dead', '{"eventId":"x"}')`);
    const checks = await checkComponents({ db, config, now, sources: [{ name: 'launchd', cadenceMs: 2 * MIN }, { name: 'github', cadenceMs: 5 * MIN }] });
    const by = Object.fromEntries(checks.map((c) => [c.component, c]));
    expect(by.postgres!.status).toBe('ok');
    expect(by.bus).toMatchObject({ status: 'degraded', detail: 'The queue had 1 failed job in the last day.' });
    expect(by.server).toMatchObject({ status: 'unknown', detail: 'It hasn’t been checked yet.' });
    expect(by['source:launchd']!.status).toBe('ok');
    expect(by['source:github']!.status).toBe('disabled');
    expect(by.backup).toMatchObject({ status: 'down', detail: 'There’s no backup yet.' });
    expect(by.retention).toMatchObject({ status: 'unknown', detail: 'It hasn’t run yet.' });
    expect(by.triage!.status).toBe('ok');
    await owner(`DELETE FROM pgboss.job WHERE name = 'dead'`);
    // Later than two cadences without a good run: degraded, then down.
    const later = await checkComponents({ db, config, now: new Date(now.getTime() + 5 * MIN), sources: [{ name: 'launchd', cadenceMs: 2 * MIN }] });
    expect(later.find((c) => c.component === 'source:launchd')!.status).toBe('degraded');
    // A good run that set something aside (a calendar item it could not read) is degraded, with why.
    await owner(`UPDATE "SourceCursor" SET "lastError" = 'an item set aside', "consecutiveFailures" = 0 WHERE source = 'launchd'`);
    const aside = (await checkComponents({ db, config, now, sources: [{ name: 'launchd', cadenceMs: 2 * MIN }] })).find((c) => c.component === 'source:launchd');
    expect(aside).toMatchObject({ status: 'degraded', detail: 'The last read skipped at least one item.' });
    await owner(`UPDATE "SourceCursor" SET "lastError" = NULL WHERE source = 'launchd'`);
    await recordChecks(db, checks, now);
    // The triage worker's own mark is not a component: nothing writes it an ok row, so it never shows as an issue.
    await db.healthCheck.create({ data: { component: 'triage.deferral', status: 'degraded', detail: 'Chat was busy.', at: now } });
    const report = await healthReport(db, config, now);
    expect(report.triage).toBe('on');
    expect(report.components.find((c) => c.component === 'bus')!.status).toBe('degraded');
    expect(report.components.map((c) => c.component)).not.toContain('triage.deferral');
    expect(report.components.map((c) => c.component)).toContain('triage');
    expect(await db.auditEntry.count({ where: { kind: 'health', action: 'health.check' } })).toBe(1);
  });

  it('a detail is redacted', async () => {
    const now = new Date();
    await recordChecks(db, [{ component: 'triage', status: 'degraded', detail: 'failed with Bearer sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123' }], now);
    const row = await db.healthCheck.findFirstOrThrow({ where: { component: 'triage', at: now } });
    expect(row.detail).not.toMatch(/sk-ant/);
  });

  it('down 29 min → nothing; 31 min → one event; 60 min → still one; recovered, then down again → a new one', async () => {
    const t0 = new Date(Date.now() - 3 * 3_600_000);
    await syncOnce(db, launchd(() => [svc(false, 1)]), runAt(t0), 'UTC');
    await syncOnce(db, launchd(() => [svc(false, 9)]), runAt(new Date(t0.getTime() + 10 * MIN)), 'UTC'); // still down, another version
    expect((await watchdog(db, config, new Date(t0.getTime() + 29 * MIN))).filter((r) => r.type === 'service.down_30m')).toEqual([]);
    const at31 = (await watchdog(db, config, new Date(t0.getTime() + 31 * MIN))).filter((r) => r.type === 'service.down_30m');
    expect(at31).toMatchObject([{ payload: { downMinutes: 31 } }]);
    expect(Object.keys(at31[0]!.payload).sort()).toEqual(['downMinutes', 'entityId']);
    expect(await raise(db, at31, new Date())).toHaveLength(1);
    const at60 = (await watchdog(db, config, new Date(t0.getTime() + 60 * MIN))).filter((r) => r.type === 'service.down_30m');
    expect(await raise(db, at60, new Date())).toHaveLength(0);
    await syncOnce(db, launchd(() => [svc(true)]), runAt(new Date(t0.getTime() + 70 * MIN)), 'UTC');
    await syncOnce(db, launchd(() => [svc(false, 2)]), runAt(new Date(t0.getTime() + 80 * MIN)), 'UTC');
    const again = (await watchdog(db, config, new Date(t0.getTime() + 111 * MIN))).filter((r) => r.type === 'service.down_30m');
    expect(await raise(db, again, new Date())).toHaveLength(1);
    expect(await db.sourceEvent.count({ where: { source: 'runtime', type: 'service.down_30m' } })).toBe(2);
  });

  it('a backup once per last good one; the latest drill only; a migration once per sha', async () => {
    const now = new Date();
    await owner(`INSERT INTO "BackupRun" (id, kind, location, path, encrypted, status, "startedAt") VALUES ('bk1', 'pg_dump_flint', 'local', '/x', false, 'ok', $1)`, [new Date(now.getTime() - 40 * 3_600_000)]);
    const w1 = (await watchdog(db, config, now)).filter((r) => r.type === 'backup.stale');
    expect(w1).toMatchObject([{ ref: 'after:bk1', payload: { hoursSince: 40 } }]);
    await raise(db, w1, now);
    expect(await raise(db, (await watchdog(db, config, new Date(now.getTime() + 3_600_000))).filter((r) => r.type === 'backup.stale'), now)).toHaveLength(0);

    await owner(`INSERT INTO "BackupRun" (id, kind, location, path, encrypted, status, "startedAt", "restoreTestedAt", "restoreOk", "restoreDetail") VALUES ('dr1', 'pg_dump_flint', 'local', '/y', false, 'ok', $1, $1, false, '{"mismatches":["a","b"]}')`, [new Date(now.getTime() - 2 * 3_600_000)]);
    expect((await watchdog(db, config, now)).filter((r) => r.type === 'drill.failed')).toMatchObject([{ ref: 'dr1', payload: { mismatches: 2 } }]);
    await owner(`INSERT INTO "BackupRun" (id, kind, location, path, encrypted, status, "startedAt", "restoreTestedAt", "restoreOk") VALUES ('dr2', 'pg_dump_flint', 'local', '/z', false, 'ok', $1, $1, true)`, [new Date(now.getTime() - 3_600_000)]);
    expect((await watchdog(db, config, now)).filter((r) => r.type === 'drill.failed')).toEqual([]);

    mkdirSync(join(home, '.flint', 'runtime'), { recursive: true });
    writeFileSync(join(home, '.flint', 'runtime', 'migrate-failed'), `${'a'.repeat(40)}\n${'a'.repeat(40)}\nnot a sha\n`);
    const m = (await watchdog(db, config, now)).filter((r) => r.type === 'migrate.failed');
    expect(m).toMatchObject([{ ref: 'a'.repeat(40), payload: { sha: 'a'.repeat(40) } }]);
    expect(await raise(db, m, now)).toHaveLength(1);
    expect(await raise(db, m, now)).toHaveLength(0);
    const after = await checkComponents({ db, config, now, sources: [] });
    expect(after.find((c) => c.component === 'migrate_failed')).toMatchObject({ status: 'down', detail: 'A database update failed and won’t be retried until it’s fixed.' });
    // Each detail is a sentence: the latest backup's age (dr2, an hour ago), and the latest drill (passed an hour ago).
    expect(after.find((c) => c.component === 'backup')).toMatchObject({ status: 'ok', detail: 'The last backup is 1 hour old.' });
    // dr2 passed an hour ago: today, or yesterday when that hour crossed midnight (config.tz is UTC).
    const dr2Day = localDay('UTC', new Date(now.getTime() - 3_600_000)) === localDay('UTC', now) ? 'today' : 'yesterday';
    expect(after.find((c) => c.component === 'restore_drill')).toMatchObject({ status: 'ok', detail: `The last restore test was ${dr2Day}.` });
  });

  it('the restore test’s day is Will’s calendar day: this morning’s is "today" all day, last night’s "yesterday"', async () => {
    // The newest drill of all (2030), so it is the one checked; removed after, so it leaves the watchdog alone.
    const chicago = { ...config, tz: 'America/Chicago' };
    const tested = new Date('2030-06-02T07:15:00Z'); // Sunday 2:15 AM in Chicago (CDT)
    await owner(`INSERT INTO "BackupRun" (id, kind, location, path, encrypted, status, "startedAt", "restoreTestedAt", "restoreOk") VALUES ('dr2030', 'pg_dump_flint', 'local', '/w', false, 'ok', $1, $1, false)`, [tested]);
    try {
      const at = async (iso: string) => (await checkComponents({ db, config: chicago, now: new Date(iso), sources: [] })).find((c) => c.component === 'restore_drill')!.detail;
      // 3 PM the same day: 0.53 days later, which used to round to "1 day ago".
      expect(await at('2030-06-02T20:00:00Z')).toBe('The last restore test failed today.');
      // 12:30 AM Monday: under a day later, but yesterday.
      expect(await at('2030-06-03T05:30:00Z')).toBe('The last restore test failed yesterday.');
      expect(await at('2030-06-05T20:00:00Z')).toBe('The last restore test failed 3 days ago.');
      await owner(`UPDATE "BackupRun" SET "restoreOk" = true WHERE id = 'dr2030'`);
      expect(await at('2030-06-02T08:00:00Z')).toBe('The last restore test was today.');
    } finally {
      await owner(`DELETE FROM "BackupRun" WHERE id = 'dr2030'`);
    }
  });

  it('the offsite copy: off until Will’s age key is here; after that a missing or stale copy is an issue by its own name, in Health and in the morning digest', async () => {
    const keyFile = join(home, '.flint', 'backup-age-recipient');
    mkdirSync(join(home, '.flint'), { recursive: true });
    const offsite = async (at: Date) => (await checkComponents({ db, config, now: at, sources: [] })).find((c) => c.component === 'offsite_backup');
    const now = new Date();
    try {
      // No key, or an empty file: the nightly job sends no copy (backup-nightly.sh), so it is off, not failing.
      rmSync(keyFile, { force: true });
      expect(await offsite(now)).toEqual({ component: 'offsite_backup', status: 'disabled' });
      writeFileSync(keyFile, '');
      expect(await offsite(now)).toEqual({ component: 'offsite_backup', status: 'disabled' });
      // The key is here and no copy was ever made (five nights of "Offsite Backup Failed"): down, and said plainly.
      writeFileSync(keyFile, 'age1example\n');
      expect(await offsite(now)).toEqual({ component: 'offsite_backup', status: 'down', detail: 'There’s no offsite copy yet.' });
      // A failed run's row is not a copy; a local backup is not an offsite one.
      await owner(`INSERT INTO "BackupRun" (id, kind, location, path, encrypted, status, "startedAt") VALUES ('offbad', 'pg_dump_flint', 'icloud', '/o/bad.age', true, 'failed', $1), ('offlocal', 'pg_dump_flint', 'local', '/l/x.dump', false, 'ok', $1)`, [now]);
      expect((await offsite(now))!.status).toBe('down');
      await owner(`INSERT INTO "BackupRun" (id, kind, location, path, encrypted, status, "startedAt") VALUES ('off1', 'pg_dump_flint', 'icloud', '/o/x.age', true, 'ok', $1)`, [new Date(now.getTime() - 3_600_000)]);
      expect(await offsite(now)).toEqual({ component: 'offsite_backup', status: 'ok', detail: 'The last offsite copy is 1 hour old.' });
      // A night missed is degraded; two are down.
      expect(await offsite(new Date(now.getTime() + 29 * 3_600_000))).toEqual({ component: 'offsite_backup', status: 'degraded', detail: 'The last offsite copy is 30 hours old.' });
      expect(await offsite(new Date(now.getTime() + 39 * 3_600_000))).toEqual({ component: 'offsite_backup', status: 'down', detail: 'The last offsite copy is 40 hours old.' });
      // The morning digest names it as Settings > Health does.
      await owner(`UPDATE "BackupRun" SET "startedAt" = $1 WHERE id = 'off1'`, [new Date(now.getTime() - 40 * 3_600_000)]);
      await recordChecks(db, await checkComponents({ db, config, now, sources: [] }), now);
      const digest = await buildDigest(db, 'UTC', now);
      expect(digest.degraded).toContain('offsite_backup');
      expect(digest.body).toMatch(/need(s)? a look: [^\n]*Offsite Backup/);
      expect(digest.body).not.toContain('offsite_backup');
    } finally {
      rmSync(keyFile, { force: true });
      await owner(`DELETE FROM "BackupRun" WHERE id IN ('off1', 'offbad', 'offlocal')`);
      await owner(`DELETE FROM "HealthCheck" WHERE at >= $1`, [now]);
    }
  });

  it('a vendor at its cap is raised once a day, and not when the server said so today', async () => {
    const now = new Date();
    const id = 'cvendor0000ab1';
    await owner(`INSERT INTO "Entity" (id, kind, key, name, state, "stateHash", sensitivity, "lastObservedAt", "updatedAt") VALUES ($1, 'account', 'account:vendor:openai', 'openai', '{"vendor":"openai","level":"100"}', $2, 'financial', now(), now())`, [id, 'f'.repeat(64)]);
    const w = (await watchdog(db, config, now)).filter((r) => r.type === 'vendor.cap_100');
    expect(w).toMatchObject([{ payload: { vendor: 'openai' } }]);
    await db.$transaction(async (tx) => {
      const ev = await recordEvent(tx, { source: 'server', sourceRef: 'thr1', type: 'spend.threshold', occurredAt: now, sensitivity: 'financial', tainted: false, payload: { vendor: 'openai', level: 'exhausted', period: 'day' } }, now);
      await markProcessed(tx, ev!, 'applied', now);
    });
    expect((await watchdog(db, config, now)).filter((r) => r.type === 'vendor.cap_100')).toEqual([]);
  });

  it('a disabled agent is never "down"; one that is merely not loaded (a failed bootstrap) is', async () => {
    const t0 = new Date(Date.now() - 2 * 3_600_000);
    const parked = (label: string, extra: Record<string, unknown>): SourceObservation => ({ type: 'service.status', kind: 'service', key: `service:launchd:${label}`, name: label, sensitivity: 'ops', externalId: label, state: { managedBy: 'launchd', running: false, lastExit: null, ...extra } });
    await syncOnce(db, launchd(() => [parked('com.nexus.ui', { loaded: false, disabled: true }), parked('com.flint.stuck', { loaded: false, disabled: false }), parked('com.flint.unsaid', { loaded: false })]), runAt(t0), 'UTC');
    const id = async (key: string) => (await db.entity.findFirstOrThrow({ where: { key } })).id;
    const raised = (await watchdog(db, config, new Date())).filter((r) => r.type === 'service.down_30m').map((r) => r.payload.entityId);
    expect(raised).not.toContain(await id('service:launchd:com.nexus.ui'));
    expect(raised).toContain(await id('service:launchd:com.flint.stuck'));
    // A state written before the source said whether it was disabled says nothing.
    expect(raised).not.toContain(await id('service:launchd:com.flint.unsaid'));
  });

  it('the launchd source archives an agent of ours that is neither listed nor installed', async () => {
    const { launchdSource } = await import('../src/sources/launchd');
    const dir = mkdtempSync(join(tmpdir(), 'agents-'));
    const run = async (cmd: string, args: readonly string[]) => (cmd.endsWith('launchctl') ? (args[0] === 'list' ? 'PID\tStatus\tLabel\n' : '') : '{}');
    const known = async () => [{ key: 'service:launchd:com.flint.gone', name: 'com.flint.gone', state: { managedBy: 'launchd', loaded: true, running: true, lastExit: 0, disabled: false }, taintedPaths: [] }];
    const r = await launchdSource({ run, agentsDir: dir, prefixes: ['com.flint.'] }).run({ now: new Date(), signal: new AbortController().signal, fetch: async () => new Response(null), known });
    expect(r.observations).toMatchObject([{ key: 'service:launchd:com.flint.gone', status: 'archived' }]);
  });

  it('a calendar’s warnings in words: only a skip or no calendars is an issue; a disconnected Apple Calendar is ok, never stale, and not in the digest', async () => {
    await enable('google_calendar');
    await enable('apple_calendar');
    const sources = [{ name: 'google_calendar', cadenceMs: 5 * MIN }, { name: 'apple_calendar', cadenceMs: 5 * MIN }];
    const check = async (source: string, now: Date) => {
      const c = (await checkComponents({ db, config, now, sources })).find((x) => x.component === `source:${source}`)!;
      return { status: c.status, detail: c.detail };
    };
    const skipped = { status: 'degraded', detail: 'The last read skipped at least one item.' };

    // Google, through its real source: an item it cannot read, then a listing past its page limit. Each skipped something.
    const google = googleCalendarSource({ tz: 'UTC', maxPages: 1, accessToken: async () => 'ya29.test' });
    const listing = (body: unknown) => ({ ...runAt(new Date()), fetch: async () => new Response(JSON.stringify(body)) });
    expect(await syncOnce(db, google, listing({ items: [42] }), 'UTC')).toMatchObject({ ran: true, failed: 0, reason: expect.stringMatching(/set aside$/) });
    expect(await check('google_calendar', new Date())).toEqual(skipped);
    expect(await syncOnce(db, google, listing({ items: [], nextPageToken: 'more' }), 'UTC')).toMatchObject({ ran: true, failed: 0, reason: expect.stringMatching(/the rest are not read/) });
    expect(await check('google_calendar', new Date())).toEqual(skipped);
    // Wording no rule knows is still an issue, said plainly.
    await owner(`UPDATE "SourceCursor" SET "lastError" = 'google calendar: something new' WHERE source = 'google_calendar'`);
    expect(await check('google_calendar', new Date())).toEqual({ status: 'degraded', detail: 'The last read finished with a warning.' });

    // Apple, through its real source: each snapshot read a minute after the last, as Flint Calendar would push it.
    // Three hours ago, so "two hours after it was disconnected" is in the past too (an audit entry is never in the future).
    const H = (x: string) => createHash('sha256').update(x).digest('hex');
    const iso = (t: number) => new Date(t).toISOString();
    const T0 = Date.now() - 180 * MIN;
    let at = T0;
    const ev = (name: string, o: Record<string, unknown> = {}) => ({
      id: H(name), recurring: false, status: 'confirmed', title: `Title ${name}`, start: { at: iso(T0 + 3 * 86_400_000) }, end: { at: iso(T0 + 3 * 86_400_000 + 3_600_000) }, self: 'accepted', ...o,
    });
    const push = async (events: unknown[], o: Record<string, unknown> = {}) => {
      at += MIN;
      const p = parseSnapshot({
        v: 1, generatedAt: iso(at), access: 'full', state: 'live', window: { start: iso(at), end: iso(at + 14 * 86_400_000) }, tz: 'UTC', complete: true,
        calendars: { count: 1, hash: H('cal') }, events, ...o,
      });
      if (!p.ok) throw new Error(`refused: ${p.issues.join(', ')}`);
      const inbox = new CalendarInbox(at - 60 * MIN);
      expect(inbox.offer(p.snapshot, at)).toBe('accepted');
      expect(await syncOnce(db, appleCalendarSource({ tz: 'UTC', inbox }), runAt(new Date(at)), 'UTC')).toMatchObject({ ran: true, failed: 0 });
      return check('apple_calendar', new Date(at));
    };
    const eight = Array.from({ length: 8 }, (_, i) => ev(`e${i}`));
    // No calendars chosen: Will has something to fix, so it is an issue, and it is said every run until he does.
    expect(await push([], { calendars: { count: 0, hash: H('none') } })).toEqual({ status: 'degraded', detail: 'No calendars are chosen in Flint Calendar, or iCloud Calendar is off.' });
    // A change of calendars lasts one run, and a mass absence is archived or comes back within the hour: said, not issues.
    expect(await push(eight)).toEqual({ status: 'ok', detail: 'The calendars Flint Calendar reads changed, so nothing missing was archived.' });
    expect(await push([])).toEqual({ status: 'ok', detail: 'Some events are missing from Flint Calendar. They’re archived if still missing in an hour.' });
    // An event set aside, and a snapshot cut at the helper's limits, each skipped something.
    expect(await push([...eight, ev('bad', { location: 'Room 4' })])).toEqual(skipped);
    expect(await push(eight, { complete: false })).toEqual(skipped);
    // Two at once: both said, and the skip makes it an issue.
    expect(await push([ev('bad', { location: 'Room 4' })], { calendars: { count: 2, hash: H('two') } }))
      .toEqual({ status: 'degraded', detail: 'The last read skipped at least one item. The calendars Flint Calendar reads changed, so nothing missing was archived.' });
    expect(await push(eight, { calendars: { count: 2, hash: H('two') } })).toEqual({ status: 'ok' });

    // Disconnected in Flint Calendar: every run after is idle, so lastOkAt stands still. Two hours on it is still ok, and says why.
    await push([], { state: 'revoked', access: 'denied' });
    const later = new Date(at + 2 * 3_600_000);
    expect(await check('apple_calendar', later)).toEqual({ status: 'ok', detail: 'It’s disconnected in Flint Calendar.' });
    await recordChecks(db, await checkComponents({ db, config, now: later, sources }), later);
    expect((await buildDigest(db, 'UTC', later)).degraded).not.toContain('source:apple_calendar');
    // A run that failed since (a live snapshot with calendar access off) is said, and judged as any source's.
    await owner(`UPDATE "SourceCursor" SET "consecutiveFailures" = 1 WHERE source = 'apple_calendar'`);
    expect(await check('apple_calendar', later)).toEqual({ status: 'down', detail: 'The last read failed.' });
  });

  it('goal reviews: disabled while the planner is off; over an hour late is degraded, over a day is down; counts only', async () => {
    const fx = await goalFixture(urls, db);
    const on = loadConfig({ DATABASE_URL: urls.app, HOME: home, FLINT_TZ: 'UTC', FLINT_PLANNER: 'on', FLINT_TRIAGE_MODEL: 'muse-glimmer:30b' });
    const goals = async (cfg: Config, now: Date, reviewsSince?: Date | null) =>
      (await checkComponents({ db, config: cfg, now, sources: [], ...(reviewsSince !== undefined ? { reviewsSince } : {}) })).find((c) => c.component === 'goals');
    const now = new Date();
    const at = (ms: number) => new Date(now.getTime() + ms);
    // Off (the default): shown as off, whatever the goals' review times say.
    const g = await fx.activeGoal();
    expect(await goals(config, at(48 * 3_600_000))).toEqual({ component: 'goals', status: 'disabled' });
    // On: a goal just started is due, not late. An hour on with no review it is late; a day on, an outage.
    expect(await goals(on, now)).toEqual({ component: 'goals', status: 'ok' });
    expect(await goals(on, at(59 * MIN))).toEqual({ component: 'goals', status: 'ok' });
    expect(await goals(on, at(62 * MIN))).toEqual({ component: 'goals', status: 'degraded', detail: 'A goal’s review is over an hour late.' });
    const other = await fx.activeGoal();
    expect(await goals(on, at(3 * 3_600_000))).toEqual({ component: 'goals', status: 'degraded', detail: '2 goals’ reviews are over an hour late.' });
    expect(await goals(on, at(25 * 3_600_000))).toEqual({ component: 'goals', status: 'down', detail: '2 goals’ reviews are over a day late.' });
    // Review finding 7: late means late while Flint was reviewing. Reviews just turned on, a restart or a sleep: the
    // reviews that came due meanwhile are not late for that, and Flint runs them within minutes.
    expect(await goals(on, at(25 * 3_600_000), null)).toEqual({ component: 'goals', status: 'ok' });
    expect(await goals(on, at(25 * 3_600_000), at(25 * 3_600_000 - 5 * MIN))).toEqual({ component: 'goals', status: 'ok' });
    expect(await goals(on, at(25 * 3_600_000), at(25 * 3_600_000 - 59 * MIN))).toEqual({ component: 'goals', status: 'ok' });
    // Still not reviewed after an hour of ticking: late. An outage only after a day of it.
    expect(await goals(on, at(25 * 3_600_000), at(25 * 3_600_000 - 61 * MIN))).toEqual({ component: 'goals', status: 'degraded', detail: '2 goals’ reviews are over an hour late.' });
    expect(await goals(on, at(50 * 3_600_000), at(25 * 3_600_000))).toEqual({ component: 'goals', status: 'down', detail: '2 goals’ reviews are over a day late.' });
    // A paused goal is not reviewed, so it is never late.
    await db.goal.update({ where: { id: other.id }, data: { status: 'paused' } });
    expect(await goals(on, at(25 * 3_600_000))).toEqual({ component: 'goals', status: 'down', detail: 'A goal’s review is over a day late.' });
    // Its scheduled review moves the goal on: on time again.
    const due = (await db.goal.findUniqueOrThrow({ where: { id: g.id } })).nextReviewAt!;
    expect((await runReview({ db, bus: new FakeBus(), tz: 'UTC' }, { goalId: g.id, kind: 'scheduled', dueAt: due.toISOString() })).outcome).toBe('reviewed');
    expect(await goals(on, at(25 * 3_600_000))).toEqual({ component: 'goals', status: 'ok' });
    // Reviews on with no local model to ask: every review would suggest nothing, so health says so.
    const noModel = loadConfig({ DATABASE_URL: urls.app, HOME: home, FLINT_TZ: 'UTC', FLINT_PLANNER: 'on' });
    expect(await goals(noModel, now)).toEqual({ component: 'goals', status: 'degraded', detail: 'No local model is set up, so goal reviews suggest no plan changes.' });

    // Review finding 5: the plan stage. When the last few reviews that asked the model got no usable answer, health says so.
    const reviewNow = async (planner: string) => {
      const r = await runReview({ db, bus: new FakeBus(), tz: 'UTC' }, { goalId: g.id, kind: 'requested' });
      if (r.outcome !== 'reviewed') throw new Error(r.outcome);
      await db.goalReview.update({ where: { id: r.reviewId }, data: { planner } });
    };
    const stages = () => goals(on, at(25 * 3_600_000));
    // (The scheduled review above is still waiting for its plan stage: nothing to judge yet.)
    expect(await stages()).toEqual({ component: 'goals', status: 'ok' });
    await reviewNow('none:unavailable');
    expect(await stages()).toEqual({ component: 'goals', status: 'degraded', detail: 'The local model gave no usable answer to the last goal review, so Flint suggested no plan changes.' });
    await reviewNow('none:invalid');
    expect(await stages()).toEqual({ component: 'goals', status: 'degraded', detail: 'The local model gave no usable answer to the last 2 goal reviews, so Flint suggested no plan changes.' });
    // One answer among the last three is enough: a single bad reply is not a fault.
    await reviewNow('ollama:muse-glimmer:30b');
    expect(await stages()).toEqual({ component: 'goals', status: 'ok' });
    await reviewNow('none:invalid');
    await reviewNow('none:unavailable');
    expect(await stages()).toEqual({ component: 'goals', status: 'ok' });
    // A stage that never asked the model (chat was busy, the day's cap, a newer review took its place) is not the model's failure.
    await reviewNow('none:deferred');
    await reviewNow('none:capped');
    await reviewNow('none:skipped');
    expect(await stages()).toEqual({ component: 'goals', status: 'ok' });
    await reviewNow('none:unavailable');
    expect(await stages()).toEqual({ component: 'goals', status: 'degraded', detail: 'The local model gave no usable answer to the last 3 goal reviews, so Flint suggested no plan changes.' });
    // It clears with the next answer, and a finished goal's old failures are nobody's problem.
    await reviewNow('ollama:muse-glimmer:30b');
    expect(await stages()).toEqual({ component: 'goals', status: 'ok' });
    // In the report and the digest it is a component like any other, by its plain name.
    await db.goal.update({ where: { id: g.id }, data: { nextReviewAt: at(-25 * 3_600_000) } });
    await db.healthCheck.create({ data: { component: 'goals.deferral', status: 'degraded', detail: 'Chat was busy.', at: now } });
    await recordChecks(db, await checkComponents({ db, config: on, now, sources: [] }), now);
    const report = await healthReport(db, on, now);
    expect(report.components.find((c) => c.component === 'goals')).toMatchObject({ status: 'down', detail: 'A goal’s review is over a day late.' });
    expect(report.components.map((c) => c.component)).not.toContain('goals.deferral');
    const digest = await buildDigest(db, 'UTC', now);
    expect(digest.degraded).toContain('goals');
    expect(digest.degraded).not.toContain('goals.deferral');
    expect(digest.body).toContain('Goal Reviews');
    expect(healthName('goals')).toBe('Goal Reviews');
    expect(JSON.stringify(report)).not.toContain('CANARY');
  });
});
