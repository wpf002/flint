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
import { NO_DB, freshDb, healthRows, withClient, type TestUrls } from './db';
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
import { CANARY, DAY, dayStart, ledgerKit } from './ledger/kit';
import { sweep } from '../src/ledger/sweep';
import { appendAudit } from '../src/governance/audit';
import { runSnapshot } from '../src/ledger/calibration';
import { runForecasts, runSeries } from '../src/predict/run';
import { forecastSeries } from '../src/predict/series';

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
    // (The database dates the row itself, HealthCheck_clock: it is the latest one, not the one at `now` to the millisecond.)
    const row = await db.healthCheck.findFirstOrThrow({ where: { component: 'triage', at: { gte: new Date(now.getTime() - 1000) } }, orderBy: { at: 'desc' } });
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
    const goals = async (cfg: Config, now: Date) => (await checkComponents({ db, config: cfg, now, sources: [] })).find((c) => c.component === 'goals');
    const now = new Date();
    const H = 3_600_000;
    const at = (ms: number) => new Date(now.getTime() + ms);
    /** The Goal Reviews rows the health job would have written every 5 minutes over a stretch (by default: reviews on and fine). */
    const reviewing = (from: number, to: number, over: { status?: string; detail?: string } = {}) =>
      healthRows(urls, Array.from({ length: Math.floor((to - from) / (5 * MIN)) + 1 }, (_, i) => ({ component: 'goals', status: over.status ?? 'ok', ...(over.detail ? { detail: over.detail } : {}), at: at(from + i * 5 * MIN) })));
    const forget = () => db.healthCheck.deleteMany({ where: { component: 'goals' } });
    // Off (the default): shown as off, whatever the goals' review times say.
    const g = await fx.activeGoal();
    expect(await goals(config, at(48 * H))).toEqual({ component: 'goals', status: 'disabled' });
    // On, and reviewing the whole time: a goal just started is due, not late. An hour on with no review it is late; a day on, an outage.
    await forget();
    await reviewing(-10 * MIN, 26 * H);
    expect(await goals(on, now)).toEqual({ component: 'goals', status: 'ok' });
    expect(await goals(on, at(59 * MIN))).toEqual({ component: 'goals', status: 'ok' });
    expect(await goals(on, at(62 * MIN))).toEqual({ component: 'goals', status: 'degraded', detail: 'A goal’s review is over an hour late.' });
    const other = await fx.activeGoal();
    expect(await goals(on, at(3 * H))).toEqual({ component: 'goals', status: 'degraded', detail: '2 goals’ reviews are over an hour late.' });
    expect(await goals(on, at(25 * H))).toEqual({ component: 'goals', status: 'down', detail: '2 goals’ reviews are over a day late.' });
    // Review finding 7: late means late while Flint was reviewing. Reviews just turned on (no row yet), or on for minutes:
    // the reviews that came due meanwhile are not late for that, and Flint runs them within minutes.
    await forget();
    expect(await goals(on, at(25 * H))).toEqual({ component: 'goals', status: 'ok' });
    await reviewing(25 * H - 5 * MIN, 25 * H);
    expect(await goals(on, at(25 * H))).toEqual({ component: 'goals', status: 'ok' });
    await forget();
    await reviewing(25 * H - 59 * MIN, 25 * H);
    expect(await goals(on, at(25 * H))).toEqual({ component: 'goals', status: 'ok' });
    // Still not reviewed after an hour of it: late.
    await forget();
    await reviewing(25 * H - 61 * MIN, 25 * H);
    expect(await goals(on, at(25 * H))).toEqual({ component: 'goals', status: 'degraded', detail: '2 goals’ reviews are over an hour late.' });
    // A day with reviews off, or stopped by a rule, is no reviewing time at all.
    await forget();
    await reviewing(0, 25 * H, { status: 'disabled' });
    expect(await goals(on, at(25 * H))).toEqual({ component: 'goals', status: 'ok' });
    await forget();
    await reviewing(0, 25 * H, { status: 'degraded', detail: 'A rule stops goal reviews, so none are running.' });
    expect(await goals(on, at(25 * H))).toEqual({ component: 'goals', status: 'ok' });
    // Review finding R3: a review stuck for days shows as down, although the Mac sleeps every night and a deploy restarts the
    // runtime every day, so it never runs 24 hours on end. Nine hours of reviewing a day, with an 8-minute restart in each.
    await forget();
    for (const day of [0, 1, 2]) {
      await reviewing(day * 24 * H, day * 24 * H + 4 * H);
      await reviewing(day * 24 * H + 4 * H + 8 * MIN, day * 24 * H + 9 * H);
    }
    const late = { component: 'goals', status: 'degraded', detail: '2 goals’ reviews are over an hour late.' };
    expect(await goals(on, at(9 * H))).toEqual(late);
    // The next morning, before the day's first check: nothing new has been waited, and it is still what it was.
    expect(await goals(on, at(24 * H - 30 * MIN))).toEqual(late);
    expect(await goals(on, at(33 * H))).toEqual(late);
    expect(await goals(on, at(48 * H + 5 * H))).toEqual(late);
    // 9 + 9 + 6 hours and a bit: a day of reviewing with the review still not done.
    expect(await goals(on, at(48 * H + 6 * H + 15 * MIN))).toEqual({ component: 'goals', status: 'down', detail: '2 goals’ reviews are over a day late.' });
    // (Back to reviewing the whole time, for what follows.)
    await forget();
    await reviewing(-25 * H - 10 * MIN, 26 * H);
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
    // (The stand-in rows for the hours ahead go: from here on the latest Goal Reviews row is the one the check itself writes.)
    await db.healthCheck.deleteMany({ where: { component: 'goals', at: { gte: now } } });
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
  it('prediction checks (P4): off until Will turns predictions on; late after 3 hours, down after 26, restarts or not; a refused write, a prediction nothing can check and stale scores are said in counts', async () => {
    const k = await ledgerKit(urls);
    /** A rule Will signed that forbids an action. */
    const forbid = async (pattern: string) => {
      const args = { rows: [{ pattern, tier: 'forbidden', expiresAt: new Date(Date.now() + 30 * DAY).toISOString() }] };
      const p = await createProposal(db, { kind: 'policy', origin: 'console', action: 'policy.change', args, argsProvenance: { rows: { source: 'will', tainted: false } }, tainted: false, sensitivity: 'ops', destructive: false, consequential: false, ttlMinutes: 60 }, 'test');
      await approveProposal(db, p.id, await key.approve({ subjectId: p.id, action: 'policy.change', argsDigest: digestOf(args) }), undefined, 'test');
      await runInternal(db, p.id, undefined, 'UTC', 'test');
    };
    const on = loadConfig({ DATABASE_URL: urls.app, HOME: home, FLINT_TZ: 'UTC', FLINT_PREDICT: 'on' });
    const ledger = async (cfg: Config, now = new Date()) => (await checkComponents({ db, config: cfg, now, sources: [] })).find((c) => c.component === 'ledger');
    const H = 3_600_000;
    const at = (ms: number) => new Date(Date.now() + ms);
    try {
      // The switch off (the default): off, whatever is there. The switch on with no number ever turned on: still off.
      expect(await ledger(config)).toEqual({ component: 'ledger', status: 'disabled' });
      expect(await ledger(on)).toEqual({ component: 'ledger', status: 'disabled' });
      // Will signs the card (a number is turned on). No check has run yet: it starts within the hour.
      const series = await k.onSeries();
      expect(await ledger(config)).toEqual({ component: 'ledger', status: 'disabled' });
      expect(await ledger(on)).toEqual({ component: 'ledger', status: 'ok', detail: 'Prediction checks start within the hour.' });
      expect(await ledger(on, at(2 * H))).toMatchObject({ status: 'ok' });
      // Three hours on with no check, it is late; a day on, it is down.
      expect(await ledger(on, at(3 * H + MIN))).toEqual({ component: 'ledger', status: 'degraded', detail: 'Prediction checks haven’t run in 3 hours.' });
      expect(await ledger(on, at(8 * H + MIN))).toEqual({ component: 'ledger', status: 'degraded', detail: 'Prediction checks haven’t run in 8 hours.' });
      expect(await ledger(on, at(26 * H + MIN))).toEqual({ component: 'ledger', status: 'down', detail: 'Prediction checks didn’t run in the last day.' });
      // A check runs, with nothing to do.
      await sweep(db, { tz: 'UTC', resolve: true, expire: true });
      expect(await ledger(on)).toEqual({ component: 'ledger', status: 'ok', detail: 'Flint had no predictions to check in the last day.' });
      // Then with something: one resolved, and one of Will's that ran out two weeks after he was asked. Run out is not
      // checked: it is said beside. A number a series took is never in the words.
      const day = dayStart(1);
      await k.point(series, day, CANARY);
      await k.range(series, day, {}, { madeAgo: Date.now() - day.getTime() - H, dueAgo: MIN });
      await k.asked(await k.prediction({ method: 'model_reasoning', resolver: 'will', createdBy: 'client:server' }, { madeAgo: 20 * DAY, dueAgo: 15 * DAY }), 15 * DAY);
      expect(await sweep(db, { tz: 'UTC', resolve: true, expire: true })).toMatchObject({ resolved: 1, expired: 1 });
      expect(await ledger(on)).toEqual({ component: 'ledger', status: 'ok', detail: 'Flint checked 1 prediction in the last day, and 1 ran out unchecked.' });
      // The hours are counted from the last check: late again three hours after it, down a day after.
      expect(await ledger(on, at(3 * H + MIN))).toMatchObject({ status: 'degraded', detail: 'Prediction checks haven’t run in 3 hours.' });
      expect(await ledger(on, at(27 * H))).toMatchObject({ status: 'down' });
      // A runtime that just started is given one hourly slot: up for ten minutes, a quiet day reads as starting...
      const inst = await db.runtimeInstance.create({ data: { id: `ri${Date.now().toString(36)}`, gitSha: 'dev', startedAt: at(27 * H - 10 * MIN), lastBeatAt: at(27 * H) } });
      expect(await ledger(on, at(27 * H))).toEqual({ component: 'ledger', status: 'ok', detail: 'Prediction checks start within the hour.' });
      // ...and with a check 25 hours ago, as starting too: never as a day in which there was nothing to check.
      expect(await ledger(on, at(25 * H))).toMatchObject({ status: 'ok', detail: 'Prediction checks start within the hour.' });
      // ...but 71 minutes up with still no check, the restart excuses nothing.
      expect(await ledger(on, at(27 * H + 61 * MIN))).toEqual({ component: 'ledger', status: 'down', detail: 'Prediction checks didn’t run in the last day.' });
      await db.runtimeInstance.update({ where: { id: inst.id }, data: { stoppedAt: at(27 * H) } });
      // Review finding 1: no check for 60 hours while the runtime restarts every two to three hours (a deploy on each
      // merge). Every hourly look used to read Normal. Now only the hour right after a restart does.
      {
        const seen: Array<{ h: number; fresh: boolean; status: string }> = [];
        let running: string | undefined;
        for (let h = 1; h <= 60; h += 1) {
          const restarted = h % 5 === 0 || h % 5 === 2;
          if (restarted) {
            if (running) await db.runtimeInstance.update({ where: { id: running }, data: { stoppedAt: at((h - 0.5) * H) } });
            running = `rix${h}x${Date.now().toString(36)}`;
            await db.runtimeInstance.create({ data: { id: running, gitSha: 'dev', startedAt: at((h - 0.4) * H), lastBeatAt: at(h * H) } });
          }
          seen.push({ h, fresh: restarted, status: (await ledger(on, at(h * H)))!.status });
        }
        if (running) await db.runtimeInstance.update({ where: { id: running }, data: { stoppedAt: at(61 * H) } });
        // Up 24 minutes: inside the slot, so not yet a missed check.
        expect(seen.filter((x) => x.fresh).every((x) => x.status === 'ok')).toBe(true);
        // Up 84 minutes or more: late from the third hour, down from the 26th.
        const settled = seen.filter((x) => !x.fresh);
        expect(settled.filter((x) => x.h < 3).map((x) => x.status)).toEqual(['ok']);
        expect(settled.filter((x) => x.h >= 3 && x.h < 26).every((x) => x.status === 'degraded')).toBe(true);
        expect(settled.filter((x) => x.h >= 26).every((x) => x.status === 'down')).toBe(true);
        expect(settled.filter((x) => x.h >= 26).length).toBeGreaterThan(15);
        expect(seen.find((x) => x.h === 59)).toEqual({ h: 59, fresh: false, status: 'down' });
      }
      // A prediction with no rule at all: said, in a count, since it will run out unchecked. So is one whose rule does not fit its own row.
      await k.prediction({ resolverSpec: null }, { madeAgo: 3 * H, dueAgo: H });
      await sweep(db, { tz: 'UTC', resolve: true, expire: true });
      expect(await ledger(on)).toEqual({ component: 'ledger', status: 'degraded', detail: 'Flint can’t check 1 prediction, so it will run out unchecked.' });
      await k.prediction({ resolver: 'auto_metric', resolverSpec: { seriesKey: 'no.such.series', at: dayStart(1).toISOString(), op: 'above', value: 1 } }, { madeAgo: 3 * H, dueAgo: H });
      await sweep(db, { tz: 'UTC', resolve: true, expire: true });
      expect(await ledger(on)).toEqual({ component: 'ledger', status: 'degraded', detail: 'Flint can’t check 2 predictions, so they will run out unchecked.' });
      // A write the database refused in the latest check (here: the sweep's clock a day ahead of the database's).
      await k.point(series, dayStart(0), 3);
      await k.range(series, dayStart(0), {}, { madeAgo: 2 * MIN, dueAgo: MIN });
      expect(await sweep(db, { tz: 'UTC', resolve: true, expire: false, now: at(DAY) })).toMatchObject({ refused: 1 });
      expect(await ledger(on)).toEqual({ component: 'ledger', status: 'degraded', detail: 'The database refused 1 prediction check.' });
      // The night's scores: fine for two days after predictions were turned on, then said to be old; a run puts it right.
      await owner(`UPDATE "Prediction" SET status = 'expired' WHERE status = 'open' AND "resolveBy" < now()`);
      await sweep(db, { tz: 'UTC', resolve: true, expire: true });
      expect((await ledger(on))!.status).toBe('ok');
      // Review findings 6 and 7: a prediction that carries another module's rule, and one whose item Will had Flint
      // forget, are no fault of the checks. Neither is counted as one Flint cannot check, and Health stays Normal.
      await k.prediction({ resolverSpec: { taskId: 'tktest0001', rule: 'task_meets_bar' } }, { madeAgo: 3 * H, dueAgo: H });
      const forgotten = await k.entity('service');
      await k.prediction({ subjectEntityId: forgotten, resolverSpec: { entityId: forgotten, check: 'healthy', at: 'resolveBy' } }, { madeAgo: 3 * H, dueAgo: H });
      await k.forget(forgotten);
      expect(await sweep(db, { tz: 'UTC', resolve: true, expire: true })).toMatchObject({ unknownSpec: 0, others: 1, waiting: 1, refused: 0 });
      expect((await ledger(on))!.status).toBe('ok');
      // An entry under the same action from anyone but the ledger is not a check: Health reads the ledger's own.
      await appendAudit(db, [{ actor: 'client:server', context: 'chat', kind: 'action', action: 'ledger.sweep', outcome: 'ok', inputs: { refused: 9, unknownSpec: 9 } }]);
      expect((await ledger(on))!.status).toBe('ok');
      // The night's scores: fine for two days after predictions were turned on. Then, with none ever written, said as that
      // (never as scores of some age); with old ones, how old; a run puts it right.
      await k.past('ForecastSeries', 'USER', (q) => q(`UPDATE "ForecastSeries" SET "enabledAt" = now() - interval '3 days'`));
      expect(await ledger(on)).toEqual({ component: 'ledger', status: 'degraded', detail: 'Flint hasn’t scored its predictions yet.' });
      await appendAudit(db, [{ actor: 'runtime:ledger', context: 'autonomous', kind: 'action', action: 'ledger.calibration.snapshot', outcome: 'ok', inputs: { groups: 0 }, at: new Date(Date.now() - 3 * DAY - H).toISOString() }]);
      expect(await ledger(on)).toEqual({ component: 'ledger', status: 'degraded', detail: 'Flint’s accuracy scores are 3 days old.' });
      await runSnapshot(db, { tz: 'UTC' });
      expect((await ledger(on))!.status).toBe('ok');
      // A rule that forbids the scores: not Flint's lateness, so not said. One that forbids both checks: said plainly.
      await forbid('ledger.calibration.snapshot');
      expect((await ledger(on))!.status).toBe('ok');
      await forbid('ledger.expire');
      expect((await ledger(on))!.status).toBe('ok');
      await forbid('ledger.resolve.auto');
      expect(await ledger(on)).toEqual({ component: 'ledger', status: 'degraded', detail: 'A rule stops Flint from checking its predictions.' });
      // Recorded and reported under its plain name; the digest lists it when it needs a look.
      const now = new Date();
      await recordChecks(db, await checkComponents({ db, config: on, now, sources: [] }), now);
      const report = await healthReport(db, on, now);
      expect(report.components.find((c) => c.component === 'ledger')).toMatchObject({ status: 'degraded', detail: 'A rule stops Flint from checking its predictions.' });
      expect(healthName('ledger')).toBe('Prediction Checks');
      expect((await buildDigest(db, 'UTC', now)).degraded).toContain('ledger');
      // Nothing Health wrote holds a number, a series' key or a prediction's id.
      const details = (await db.healthCheck.findMany({ where: { component: 'ledger' }, select: { detail: true } })).map((c) => c.detail).join(' ');
      expect(details).not.toMatch(/31337|4242|daily\.|test\.|pd[a-z0-9]{8}/);
    } finally {
      await k.db.$disconnect();
    }
  });
  it('forecasts (P4): off until a number is on; a missed night, a failed forecast and unrecorded numbers are said in counts; the digest leaves forecasts out of what resolves today', async () => {
    const k = await ledgerKit(urls);
    const on = loadConfig({ DATABASE_URL: urls.app, HOME: home, FLINT_TZ: 'UTC', FLINT_PREDICT: 'on' });
    const forecasts = async (cfg: Config, now = new Date()) => (await checkComponents({ db, config: cfg, now, sources: [] })).find((c) => c.component === 'forecasts');
    const H = 3_600_000;
    const at = (ms: number) => new Date(Date.now() + ms);
    const audit = (action: string, inputs: Record<string, number>) => appendAudit(db, [{ actor: 'runtime:forecast', context: 'autonomous', kind: 'action', action, tier: 'approval', outcome: 'ok', inputs }]);
    const backdate = (hours: number) => k.past('ForecastSeries', 'USER', (q) => q(`UPDATE "ForecastSeries" SET "enabledAt" = now() - make_interval(hours => $1) WHERE "on"`, [hours]));
    try {
      // Whatever earlier tests turned on is turned off (no signature needed): with no number on, Forecasts is off.
      await k.inTx((q) => q(`UPDATE "ForecastSeries" SET "on" = false WHERE "on"`), { actor: 'will:console' });
      await db.runtimeInstance.updateMany({ where: { stoppedAt: null }, data: { stoppedAt: new Date() } });
      expect(await forecasts(on)).toEqual({ component: 'forecasts', status: 'disabled' });
      // A registered number, turned on, with a month of history.
      const def = forecastSeries('daily.deploys.count')!;
      await k.series({ key: def.key, unit: def.unit, freq: 'D', sensitivity: def.sensitivity, description: def.description });
      await k.turnOn([def.key]);
      expect(await forecasts(config)).toEqual({ component: 'forecasts', status: 'disabled' });
      expect(await forecasts(on)).toEqual({ component: 'forecasts', status: 'ok', detail: 'Forecasts start tonight.' });
      // A night goes by with no run, then two.
      expect(await forecasts(on, at(27 * H))).toEqual({ component: 'forecasts', status: 'degraded', detail: 'Forecasts didn’t run last night.' });
      expect(await forecasts(on, at(51 * H))).toEqual({ component: 'forecasts', status: 'down', detail: 'Forecasts haven’t run in 2 days.' });
      // The first night: not enough history yet. That is said, and it is not a fault.
      expect(await runForecasts({ db, tz: 'UTC' })).toMatchObject({ on: 1, waiting: 1, ran: 0 });
      expect(await forecasts(on)).toEqual({ component: 'forecasts', status: 'ok', detail: 'Flint needs more history before it forecasts its number.' });
      // With history, the night's run makes its forecast.
      for (let i = 1; i <= 30; i++) await k.point(def.key, dayStart(i), CANARY + i);
      expect(await runForecasts({ db, tz: 'UTC' })).toMatchObject({ ran: 1, waiting: 0 });
      expect(await forecasts(on)).toEqual({ component: 'forecasts', status: 'ok', detail: 'Last night’s forecasts ran for 1 number.' });
      // The same night again: nothing new to make, and it still reads as made.
      expect(await runForecasts({ db, tz: 'UTC' })).toMatchObject({ ran: 0, same: 1 });
      expect(await forecasts(on)).toMatchObject({ status: 'ok', detail: 'Last night’s forecasts ran for 1 number.' });
      // Yesterday's numbers were not recorded (the number has been on for 30 hours and the numbers job never ran).
      await backdate(30);
      expect(await forecasts(on)).toEqual({ component: 'forecasts', status: 'degraded', detail: 'Flint didn’t record yesterday’s numbers.' });
      expect(await runSeries({ db, tz: 'UTC' })).toMatchObject({ ran: true, on: 1 });
      expect((await forecasts(on))!.status).toBe('ok');
      // A number that could not be built, and a forecast that failed, each in a count.
      await audit('forecast.series.build', { on: 3, written: 2, down: 0, failed: 1 });
      expect(await forecasts(on)).toEqual({ component: 'forecasts', status: 'degraded', detail: 'Flint couldn’t record 1 number last night.' });
      await audit('forecast.series.build', { on: 3, written: 3, down: 0, failed: 0 });
      await audit('forecast.local', { on: 3, ran: 1, steady: 0, same: 0, waiting: 0, capped: 0, refused: 0, failed: 2, predictions: 2 });
      expect(await forecasts(on)).toEqual({ component: 'forecasts', status: 'degraded', detail: '2 forecasts failed last night.' });
      await audit('forecast.local', { on: 3, ran: 2, steady: 1, same: 0, waiting: 0, capped: 0, refused: 0, failed: 0, predictions: 4 });
      expect(await forecasts(on)).toEqual({ component: 'forecasts', status: 'ok', detail: 'Last night’s forecasts ran for 3 numbers.' });
      // The digest's "resolve today" count is for what Will might watch for: a forecast's own two are left out.
      const before = (await buildDigest(db, 'UTC', new Date())).counts.due as number;
      await k.range(def.key, dayStart(0), {}, { madeAgo: 1000, dueAgo: -MIN });
      await k.question(def.key, dayStart(0), 'above', 5, {}, { madeAgo: 1000, dueAgo: -MIN });
      expect((await buildDigest(db, 'UTC', new Date())).counts.due).toBe(before);
      await k.prediction({}, { madeAgo: 1000, dueAgo: -MIN });
      expect((await buildDigest(db, 'UTC', new Date())).counts.due).toBe(before + 1);
      // Recorded and reported under its plain name; nothing it wrote holds a number or a key.
      const now = new Date();
      await recordChecks(db, await checkComponents({ db, config: on, now, sources: [] }), now);
      expect((await healthReport(db, on, now)).components.find((c) => c.component === 'forecasts')).toMatchObject({ status: 'ok', detail: 'Last night’s forecasts ran for 3 numbers.' });
      expect(healthName('forecasts')).toBe('Forecasts');
      const details = (await db.healthCheck.findMany({ where: { component: 'forecasts' }, select: { detail: true } })).map((c) => c.detail).join(' ');
      expect(details).not.toMatch(/31337|4242|daily\.|pd[a-z0-9]{8}/);
    } finally {
      await k.db.$disconnect();
    }
  });
});
