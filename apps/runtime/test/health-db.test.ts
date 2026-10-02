/**
 * Health on flint_test: unknown and stale are not ok, disabled sources are
 * left out, the bus is degraded by dead letters; the watchdog raises each
 * critical condition once per occurrence (a service down from the first down
 * observation, 30 minutes on; a backup once per last good one; the latest
 * drill only; a migration once per sha; a vendor once a day unless the server
 * said so); circuits open once and close once; details are redacted; the
 * spend view goes to the server.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digestOf } from '@flint/policy';
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
import type { Source, SourceObservation, SourceRun } from '../src/sources/types';

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
  const owner = (sql: string, params: unknown[] = []) => withClient(urls.owner, (c) => c.query(sql, params));
  const svc = (running: boolean, lastExit = 0): SourceObservation => ({ type: 'service.status', kind: 'service', key: 'service:launchd:com.flint.watched', name: 'com.flint.watched', sensitivity: 'ops', externalId: 'com.flint.watched', state: { managedBy: 'launchd', loaded: true, running, lastExit } });
  const launchd = (o: () => SourceObservation[]): Source => ({ name: 'launchd', cadenceMs: 2 * MIN, run: async () => ({ observations: o(), metrics: [] }) });

  beforeAll(async () => {
    urls = await freshDb();
    db = createDb(urls.app);
    home = mkdtempSync(join(tmpdir(), 'health-home-'));
    config = loadConfig({ DATABASE_URL: urls.app, HOME: home, FLINT_TZ: 'UTC', FLINT_RUNTIME_TRIAGE: 'on' });
    const key = await enrollTestKey(urls);
    const p = await createProposal(db, { kind: 'tool_call', origin: 'console', action: 'world.source.enable', args: { source: 'launchd' }, argsProvenance: { source: { source: 'will', tainted: false } }, tainted: false, sensitivity: 'ops', destructive: false, consequential: false, ttlMinutes: 60 }, 'test');
    await approveProposal(db, p.id, await key.approve({ subjectId: p.id, action: 'world.source.enable', argsDigest: digestOf({ source: 'launchd' }) }), undefined, 'test');
    await runInternal(db, p.id, undefined, 'UTC', 'test');
  });
  afterAll(async () => db?.$disconnect());

  it('unknown and stale are not ok; a disabled source is shown and left out; the bus is degraded by dead letters', async () => {
    const now = new Date();
    await syncOnce(db, launchd(() => [svc(true)]), runAt(now), 'UTC');
    await owner(`INSERT INTO pgboss.job (name, data) VALUES ('dead', '{"eventId":"x"}')`);
    const checks = await checkComponents({ db, config, now, sources: [{ name: 'launchd', cadenceMs: 2 * MIN }, { name: 'github', cadenceMs: 5 * MIN }] });
    const by = Object.fromEntries(checks.map((c) => [c.component, c]));
    expect(by.postgres!.status).toBe('ok');
    expect(by.bus).toMatchObject({ status: 'degraded', detail: '1 dead-lettered in a day, 0 stuck active' });
    expect(by.server!.status).toBe('unknown');
    expect(by['source:launchd']!.status).toBe('ok');
    expect(by['source:github']!.status).toBe('disabled');
    expect(by.backup!.status).toBe('down');
    expect(by.retention!.status).toBe('unknown');
    expect(by.triage!.status).toBe('ok');
    await owner(`DELETE FROM pgboss.job WHERE name = 'dead'`);
    // Later than two cadences without a good run: degraded, then down.
    const later = await checkComponents({ db, config, now: new Date(now.getTime() + 5 * MIN), sources: [{ name: 'launchd', cadenceMs: 2 * MIN }] });
    expect(later.find((c) => c.component === 'source:launchd')!.status).toBe('degraded');
    await recordChecks(db, checks, now);
    const report = await healthReport(db, config, now);
    expect(report.triage).toBe('on');
    expect(report.components.find((c) => c.component === 'bus')!.status).toBe('degraded');
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
    expect((await checkComponents({ db, config, now, sources: [] })).find((c) => c.component === 'migrate_failed')).toMatchObject({ status: 'down', detail: 'not retried: aaaaaaa' });
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
    await syncOnce(db, launchd(() => [parked('com.nexus.ui', { loaded: false, disabled: true }), parked('com.flint.stuck', { loaded: false })]), runAt(t0), 'UTC');
    const id = async (key: string) => (await db.entity.findFirstOrThrow({ where: { key } })).id;
    const raised = (await watchdog(db, config, new Date())).filter((r) => r.type === 'service.down_30m').map((r) => r.payload.entityId);
    expect(raised).not.toContain(await id('service:launchd:com.nexus.ui'));
    expect(raised).toContain(await id('service:launchd:com.flint.stuck'));
  });
});
