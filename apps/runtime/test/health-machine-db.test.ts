/**
 * Health sees the whole machine (P7), on flint_test with a scratch home:
 *  - what is read from the Mac itself (free space, remote access, the local
 *    models) becomes components only when there is a reading;
 *  - the database says when it holds a large object no backup includes; a
 *    backup that failed since the last good one is said at once;
 *  - Automatic Updates says when the deploy job last looked, and when it has
 *    stopped looking;
 *  - Offsite Restore Test is off until the MacBook reports a first result;
 *  - the watchdog raises each new condition once per occurrence: the Mac nearly
 *    full (critical), no offsite copy in three days, remote access running out
 *    or down for half an hour, updates no longer looked for, the MacBook no
 *    longer testing; and the triage rules turn each into its note.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HEALTH_NAMES, digestOf, healthName, noteProblems } from '@flint/policy';
import { NO_DB, freshDb, healthRows, withClient, type TestUrls } from './db';
import { enrollTestKey } from './sign';
import { createDb, type Db } from '../src/db';
import { loadConfig, type Config } from '../src/config';
import { approveProposal, createProposal } from '../src/governance/proposals';
import { runInternal } from '../src/governance/internal';
import { syncOnce } from '../src/sources/sync';
import type { Source, SourceRun } from '../src/sources/types';
import { DATABASE_HEALTH, UPDATE_GRACE_MS, UPDATE_LATE_MS, UPKEEP_HEALTH, checkComponents, healthReport, recordChecks } from '../src/health/checks';
import { OFFSITE_DRILL_STALE_MS, OFFSITE_STALE_MS, UPDATES_STALLED_MS, raise, watchdog } from '../src/health/watchdog';
import type { MachineReading } from '../src/health/machine';
import { fileBackup } from '../src/backup/record';
import { CRITICAL_TEMPLATES, codeVerdict, criticalVerdict } from '../src/triage/critical';
import { render, type TemplateId } from '../src/templates/escalations';
import { digestBody } from '../src/digest';
import { facts, noCode } from './triage/helpers';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const GB = 1e9;
const runAt = (now: Date): Omit<SourceRun, 'cursor'> => ({ now, signal: new AbortController().signal, fetch: async () => new Response(null, { status: 599 }) });

describe.skipIf(NO_DB)('Health sees the whole machine (flint_test)', () => {
  let urls: TestUrls;
  let db: Db;
  let config: Config;
  let home: string;
  const owner = (sql: string, params: unknown[] = []) => withClient(urls.owner, (c) => c.query(sql, params));
  const flint = (name: string) => join(home, '.flint', name);
  const checks = async (now: Date, machine?: MachineReading, named: { standbyModel: boolean } = { standbyModel: true }) => {
    const { standbyModel: _named, ...unnamed } = config;
    return Object.fromEntries((await checkComponents({ db, config: named.standbyModel ? config : unnamed, now, sources: [], ...(machine ? { machine } : {}) })).map((c) => [c.component, c]));
  };
  const healthy: MachineReading = { freeBytes: 212 * GB, remote: { state: 'ok' }, models: { installed: new Set(['qwen2.5:14b', 'llama3.2:latest']), loaded: new Set(['qwen2.5:14b']), elsewhere: new Set() } };
  /** A file's time set to `ms` before `now`. */
  const aged = (file: string, now: Date, ms: number) => {
    writeFileSync(file, '');
    utimesSync(file, (now.getTime() - ms) / 1000, (now.getTime() - ms) / 1000);
  };

  beforeAll(async () => {
    urls = await freshDb();
    db = createDb(urls.app);
    home = mkdtempSync(join(tmpdir(), 'flint-machine-home-'));
    mkdirSync(join(home, '.flint'), { mode: 0o700 });
    config = loadConfig({ DATABASE_URL: urls.app, HOME: home, FLINT_TZ: 'UTC', FLINT_TRIAGE_MODEL: 'qwen2.5:14b', FLINT_LOCAL_FALLBACK_MODEL: 'llama3.2' });
  });
  afterAll(async () => {
    await db?.$disconnect();
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it('the settings: the standby model is named by the server’s own setting, and Ollama is asked on this Mac only', () => {
    expect(config.standbyModel).toBe('llama3.2');
    expect(config.ollamaUrl).toBe('http://127.0.0.1:11434');
    expect(loadConfig({ DATABASE_URL: urls.app, HOME: home }).standbyModel).toBeUndefined();
    expect(() => loadConfig({ DATABASE_URL: urls.app, HOME: home, FLINT_LOCAL_FALLBACK_MODEL: 'a model; rm -rf' })).toThrow();
    expect(() => loadConfig({ DATABASE_URL: urls.app, HOME: home, OLLAMA_URL: 'http://ollama.example.com:11434' })).toThrow();
  });

  it('what is read from the Mac is shown only when there is a reading, each under its own name', async () => {
    const now = new Date();
    const without = await checks(now);
    for (const component of ['disk', 'remote_access', 'standby_model']) expect(without[component], component).toBeUndefined();
    const withIt = await checks(now, healthy);
    expect(withIt.disk).toEqual({ component: 'disk', status: 'ok', detail: 'This Mac has 212 GB free.' });
    expect(withIt.remote_access).toEqual({ component: 'remote_access', status: 'ok', detail: 'Your phone and MacBook can reach Flint.' });
    expect(withIt.standby_model).toEqual({ component: 'standby_model', status: 'ok', detail: 'The standby model is ready.' });
    // Each bad reading, as its own component says it.
    const bad = await checks(now, { freeBytes: 3 * GB, remote: { state: 'down', why: 'signed_out' }, models: { installed: new Set(['qwen2.5:14b']), loaded: new Set(), elsewhere: new Set() } });
    expect(bad.disk).toMatchObject({ status: 'down', detail: 'This Mac is nearly full, with 3 GB free.' });
    expect(bad.remote_access).toMatchObject({ status: 'down', detail: 'Remote access needs a new sign-in, so your phone and MacBook can’t reach Flint.' });
    expect(bad.standby_model).toMatchObject({ status: 'degraded', detail: 'The standby model isn’t installed.' });
    // Nothing could be read: unknown, never ok; remote access never set up, and no standby model named, are off.
    const blind = await checks(now, { remote: { state: 'unknown' } });
    expect(blind.disk!.status).toBe('unknown');
    expect(blind.remote_access!.status).toBe('unknown');
    expect(blind.standby_model!.status).toBe('unknown');
    const off = await checks(now, { freeBytes: 50 * GB, remote: { state: 'off' } }, { standbyModel: false });
    expect(off.remote_access).toEqual({ component: 'remote_access', status: 'disabled' });
    // No standby named in the runtime's settings: no line at all (the server picks one for this Mac by itself).
    expect(off.standby_model).toBeUndefined();
    // Named "off": it is off, and that is what the line says.
    const turnedOff = Object.fromEntries((await checkComponents({ db, config: { ...config, standbyModel: 'off' }, now, sources: [], machine: healthy })).map((c) => [c.component, c]));
    expect(turnedOff.standby_model).toEqual({ component: 'standby_model', status: 'disabled' });
    // Each has a name on screen, and the morning digest uses it.
    for (const component of ['disk', 'remote_access', 'standby_model', 'files_backup', 'offsite_drill']) expect(HEALTH_NAMES[component], component).toMatch(/^[A-Z][A-Za-z ]+$/);
    expect(digestBody({ relevant: 0, quiet: 0, escalated: 0, did: 0, queued: 0, open: 0, due: 0 }, ['disk', 'remote_access', 'files_backup'])).toContain('These need a look: Disk Space, Remote Access and Files Backup.');
  });

  it('Local Model: once Ollama answers, it says whether the model Flint asks is there', async () => {
    const key = await enrollTestKey(urls);
    const p = await createProposal(db, { kind: 'tool_call', origin: 'console', action: 'world.source.enable', args: { source: 'health' }, argsProvenance: { source: { source: 'will', tainted: false } }, tainted: false, sensitivity: 'ops', destructive: false, consequential: false, ttlMinutes: 60 }, 'test');
    await approveProposal(db, p.id, await key.approve({ subjectId: p.id, action: 'world.source.enable', argsDigest: digestOf({ source: 'health' }) }), undefined, 'test');
    await runInternal(db, p.id, undefined, 'UTC', 'test');
    const now = new Date();
    // Before the health source has looked, what it saw stands: not checked yet, whatever the lists say.
    expect((await checks(now, healthy)).ollama).toMatchObject({ status: 'unknown', detail: 'It hasn’t been checked yet.' });
    const source: Source = { name: 'health', cadenceMs: 5 * MIN, run: async () => ({ observations: [{ type: 'service.health', kind: 'service', key: 'service:endpoint:ollama', name: 'ollama', sensitivity: 'ops', externalId: 'ollama', state: { managedBy: 'other', health: 'ok' } }], metrics: [] }) };
    await syncOnce(db, source, runAt(now), 'UTC');
    expect((await checks(now, healthy)).ollama).toEqual({ component: 'ollama', status: 'ok', detail: 'The local model is loaded.' });
    expect((await checks(now, { ...healthy, models: { installed: new Set(['qwen2.5:14b']), loaded: new Set(), elsewhere: new Set() } })).ollama!.detail).toBe('The local model is installed, and loads when it’s needed.');
    // Ollama answers, and the model Flint asks was never installed (or was removed): nothing local can answer.
    expect((await checks(now, { ...healthy, models: { installed: new Set(['llama3.2:latest']), loaded: new Set(), elsewhere: new Set() } })).ollama).toEqual({ component: 'ollama', status: 'down', detail: 'The local model isn’t installed.' });
    // Ollama lists both, and says each runs on someone else's servers: neither is on this Mac, whatever it is called.
    const cloud = await checks(now, { ...healthy, models: { ...healthy.models!, elsewhere: new Set(['qwen2.5:14b', 'llama3.2:latest']) } });
    expect(cloud.ollama).toEqual({ component: 'ollama', status: 'down', detail: 'The local model isn’t on this Mac.' });
    expect(cloud.standby_model).toEqual({ component: 'standby_model', status: 'degraded', detail: 'The standby model isn’t on this Mac.' });
    expect((await checks(now, { freeBytes: healthy.freeBytes!, remote: healthy.remote })).ollama).toMatchObject({ status: 'unknown', detail: 'Flint couldn’t check which models are installed.' });
    // With no reading from the Mac at all (the other checks' own tests), it is what the health source saw.
    expect((await checks(now)).ollama).toEqual({ component: 'ollama', status: 'ok' });
  });

  it('Database: a large object that is not Flint’s is said, because no backup includes it', async () => {
    const now = new Date();
    expect((await checks(now)).postgres).toEqual({ component: 'postgres', status: 'ok' });
    await owner('SELECT lo_create(0)');
    try {
      expect((await checks(now)).postgres).toEqual({ component: 'postgres', status: 'degraded', detail: 'The database holds 1 large object that isn’t Flint’s. No backup includes it.' });
      await owner('SELECT lo_create(0)');
      expect((await checks(now)).postgres!.detail).toBe('The database holds 2 large objects that aren’t Flint’s. No backup includes them.');
    } finally {
      // Its maker takes them away again (only its owner may remove one), whatever the lines above did.
      await owner('SELECT lo_unlink(oid) FROM pg_largeobject_metadata WHERE lomowner = current_user::regrole');
    }
    expect((await checks(now)).postgres!.status).toBe('ok');
    for (const n of [1, 2, 40]) expect(noteProblems(HEALTH_NAMES.postgres!, DATABASE_HEALTH.largeObjects(n))).toEqual([]);
  });

  it('Backups: a run that failed since the last good one is said at once, not left to show as a backup growing old', async () => {
    const now = new Date();
    try {
      await fileBackup(db, { kind: 'pg_dump_flint', location: 'local', path: '/b/flint-a.dump', startedAt: new Date(now.getTime() - 20 * HOUR) });
      expect((await checks(now)).backup).toEqual({ component: 'backup', status: 'ok', detail: 'The last backup is 20 hours old.' });
      // An older failure, before the good one, is history.
      await owner(`INSERT INTO "BackupRun" (id, kind, location, path, encrypted, status, "startedAt") VALUES ('bf-old', 'pg_dump_flint', 'local', '/b/flint-old.dump', false, 'failed', $1)`, [new Date(now.getTime() - 44 * HOUR)]);
      expect((await checks(now)).backup!.status).toBe('ok');
      await owner(`INSERT INTO "BackupRun" (id, kind, location, path, encrypted, status, "startedAt") VALUES ('bf-new', 'pg_dump_flint', 'local', '/b/flint-new.dump', false, 'failed', $1)`, [new Date(now.getTime() - HOUR)]);
      expect((await checks(now)).backup).toEqual({ component: 'backup', status: 'degraded', detail: 'The last backup failed.' });
      // The next good one clears it.
      await fileBackup(db, { kind: 'pg_dump_flint', location: 'local', path: '/b/flint-c.dump', startedAt: new Date(now.getTime() - 10 * MIN) });
      expect((await checks(now)).backup).toMatchObject({ status: 'ok', detail: 'The last backup is 0 hours old.' });
    } finally {
      await owner(`DELETE FROM "BackupRun"`);
    }
  });

  it('Automatic Updates: when the deploy job last looked, and an hour without a look is an issue; a pause is still a pause', async () => {
    const now = new Date();
    const instance = await db.runtimeInstance.create({ data: { id: `ri${Date.now().toString(36)}`, gitSha: 'dev', startedAt: new Date(now.getTime() - UPDATE_GRACE_MS + MIN), lastBeatAt: now } });
    try {
      // No look on record, and the runtime has only just started: nothing is said yet.
      expect((await checks(now)).deploy_hold).toEqual({ component: 'deploy_hold', status: 'ok' });
      await owner(`UPDATE "RuntimeInstance" SET "startedAt" = $1 WHERE id = $2`, [new Date(now.getTime() - UPDATE_GRACE_MS - MIN), instance.id]);
      expect((await checks(now)).deploy_hold).toEqual({ component: 'deploy_hold', status: 'unknown', detail: 'Flint hasn’t checked for updates since it was installed.' });
      aged(flint('deploy-tick'), now, 30_000);
      expect((await checks(now)).deploy_hold).toEqual({ component: 'deploy_hold', status: 'ok', detail: 'Flint checked for updates less than a minute ago.' });
      aged(flint('deploy-tick'), now, 3 * MIN);
      expect((await checks(now)).deploy_hold!.detail).toBe('Flint checked for updates 3 minutes ago.');
      // (From here the runtime has been up for days: the hour is counted from the last look.)
      await owner(`UPDATE "RuntimeInstance" SET "startedAt" = $1 WHERE id = $2`, [new Date(now.getTime() - 5 * DAY), instance.id]);
      // A deploy's own checks can hold one look for a quarter of an hour: still normal.
      aged(flint('deploy-tick'), now, UPDATE_LATE_MS - MIN);
      expect((await checks(now)).deploy_hold!.status).toBe('ok');
      aged(flint('deploy-tick'), now, UPDATE_LATE_MS + MIN);
      expect((await checks(now)).deploy_hold).toEqual({ component: 'deploy_hold', status: 'degraded', detail: 'Flint hasn’t checked for updates in 1 hour.' });
      aged(flint('deploy-tick'), now, 3 * DAY);
      expect((await checks(now)).deploy_hold!.detail).toBe('Flint hasn’t checked for updates in 3 days.');
      // Paused on purpose: that is what is said, with its own age (the job looks at nothing while it is paused).
      aged(flint('deploy-hold'), now, 5 * HOUR);
      aged(flint('deploy-hold-seen'), now, 5 * HOUR);
      expect((await checks(now)).deploy_hold).toEqual({ component: 'deploy_hold', status: 'degraded', detail: 'Updates have been paused for 5 hours.' });
      // The pause is lifted, and the job has not looked yet (it keeps its own mark until it has): the three days the
      // look is old are days it was paused, never "hasn't checked in 3 days".
      rmSync(flint('deploy-hold'));
      expect((await checks(now)).deploy_hold).toEqual({ component: 'deploy_hold', status: 'degraded', detail: 'Updates were paused, and Flint hasn’t checked again yet.' });
      expect((await watchdog(db, config, now)).filter((r) => r.type === 'auto_update.stalled')).toEqual([]);
      // Its first look takes the mark away and leaves its time.
      rmSync(flint('deploy-hold-seen'));
      aged(flint('deploy-tick'), now, 20_000);
      expect((await checks(now)).deploy_hold).toEqual({ component: 'deploy_hold', status: 'ok', detail: 'Flint checked for updates less than a minute ago.' });
      for (const said of [UPKEEP_HEALTH.neverChecked, UPKEEP_HEALTH.resuming, UPKEEP_HEALTH.checked(0), UPKEEP_HEALTH.checked(MIN), UPKEEP_HEALTH.checked(9 * HOUR), UPKEEP_HEALTH.checked(3 * DAY), UPKEEP_HEALTH.notChecked(HOUR), UPKEEP_HEALTH.notChecked(50 * HOUR)]) {
        expect(noteProblems(HEALTH_NAMES.deploy_hold!, said), said).toEqual([]);
      }
    } finally {
      rmSync(flint('deploy-hold'), { force: true });
      rmSync(flint('deploy-hold-seen'), { force: true });
      rmSync(flint('deploy-tick'), { force: true });
      await db.runtimeInstance.update({ where: { id: instance.id }, data: { stoppedAt: now } });
    }
  });

  it('Automatic Updates after the Mac was off, or was rebuilt: the hour is counted from when the runtime started, not from an old look', async () => {
    const boot = new Date();
    const at = (ms: number) => new Date(boot.getTime() + ms);
    // The last look is 9 hours old (the Mac was off overnight; or the mark came back from a backup with its old time).
    aged(flint('deploy-tick'), boot, 9 * HOUR);
    const instance = await db.runtimeInstance.create({ data: { id: `ri${Date.now().toString(36)}b`, gitSha: 'dev', startedAt: boot, lastBeatAt: boot } });
    const stalled = async (now: Date) => (await watchdog(db, config, now)).filter((r) => r.type === 'auto_update.stalled');
    try {
      // Twenty seconds after it started: no issue and no note. What it says is true: when the last look was.
      expect((await checks(at(20_000))).deploy_hold).toEqual({ component: 'deploy_hold', status: 'ok', detail: 'Flint checked for updates 9 hours ago.' });
      expect(await stalled(at(20_000))).toEqual([]);
      expect((await checks(at(59 * MIN))).deploy_hold!.status).toBe('ok');
      // A real hour of this runtime with no look: an issue, with how long it has really been.
      expect((await checks(at(61 * MIN))).deploy_hold).toEqual({ component: 'deploy_hold', status: 'degraded', detail: 'Flint hasn’t checked for updates in 10 hours.' });
      // The note waits for three real hours of it.
      expect(await stalled(at(2 * HOUR + 59 * MIN))).toEqual([]);
      expect(await stalled(at(3 * HOUR + MIN))).toMatchObject([{ payload: { hours: 12 } }]);
      // A look, even a minute after the start, and all is normal again.
      aged(flint('deploy-tick'), at(HOUR), 0);
      expect((await checks(at(61 * MIN))).deploy_hold!.status).toBe('ok');
    } finally {
      rmSync(flint('deploy-tick'), { force: true });
      await db.runtimeInstance.update({ where: { id: instance.id }, data: { stoppedAt: at(4 * HOUR) } });
    }
  });

  it('Standby Model: when the setting that named one goes away, the next check says Off once, so an old "isn’t installed" does not stand', async () => {
    const now = new Date();
    const { standbyModel: _named, ...unnamed } = config;
    const missing: MachineReading = { ...healthy, models: { installed: new Set(['qwen2.5:14b']), loaded: new Set(), elsewhere: new Set() } };
    const standbyOf = async (cfg: typeof unnamed, at: Date, machine?: MachineReading) => (await checkComponents({ db, config: cfg, now: at, sources: [], ...(machine ? { machine } : {}) })).filter((c) => c.component === 'standby_model');
    const latest = async () => (await healthReport(db, config, new Date())).components.find((c) => c.component === 'standby_model');
    try {
      // Never named: no line, and none is made up.
      expect(await standbyOf(unnamed, now, missing)).toEqual([]);
      // Named, and not installed: an issue, on record.
      await recordChecks(db, await checkComponents({ db, config, now, sources: [], machine: missing }), now);
      expect(await latest()).toMatchObject({ status: 'degraded', detail: 'The standby model isn’t installed.' });
      // The setting goes away. The next check writes Off, with or without a reading of the Mac...
      const next = await standbyOf(unnamed, new Date(now.getTime() + 5 * MIN), missing);
      expect(next).toEqual([{ component: 'standby_model', status: 'disabled' }]);
      expect(await standbyOf(unnamed, new Date(now.getTime() + 5 * MIN))).toEqual([{ component: 'standby_model', status: 'disabled' }]);
      await recordChecks(db, next, new Date(now.getTime() + 5 * MIN));
      expect(await latest()).toMatchObject({ status: 'disabled' });
      // ...once: after that there is nothing more to say about it.
      expect(await standbyOf(unnamed, new Date(now.getTime() + 10 * MIN), missing)).toEqual([]);
    } finally {
      await owner(`DELETE FROM "HealthCheck"`);
    }
  });

  it('Offsite Restore Test: off until the MacBook reports one; then a failure is down, and a week without one is late', async () => {
    const now = new Date('2026-10-12T18:00:00Z');
    try {
      expect((await checks(now)).offsite_drill).toEqual({ component: 'offsite_drill', status: 'disabled' });
      // A test of a copy on this Mac is the Studio's own restore test, and is not this one.
      await owner(`INSERT INTO "BackupRun" (id, kind, location, path, encrypted, status, "startedAt", "restoreTestedAt", "restoreOk") VALUES ('od-local', 'pg_dump_flint', 'local', '/b/x.dump', false, 'ok', $1, $1, true)`, [new Date(now.getTime() - HOUR)]);
      expect((await checks(now)).offsite_drill!.status).toBe('disabled');
      await owner(`INSERT INTO "BackupRun" (id, kind, location, path, encrypted, status, "startedAt", "restoreTestedAt", "restoreOk") VALUES ('od-1', 'pg_dump_flint', 'icloud', '/o/x.dump.age', true, 'ok', $1, $2, true)`, [new Date(now.getTime() - 2 * DAY), new Date(now.getTime() - DAY)]);
      expect((await checks(now)).offsite_drill).toEqual({ component: 'offsite_drill', status: 'ok', detail: 'Your MacBook restored an offsite copy yesterday.' });
      expect((await checks(new Date(now.getTime() + 8 * DAY))).offsite_drill).toEqual({ component: 'offsite_drill', status: 'degraded', detail: 'Your MacBook hasn’t tested an offsite copy in 9 days.' });
      expect((await checks(new Date(now.getTime() + 34 * DAY))).offsite_drill!.detail).toBe('Your MacBook hasn’t tested an offsite copy in 5 weeks.');
      await owner(`UPDATE "BackupRun" SET "restoreOk" = false WHERE id = 'od-1'`);
      expect((await checks(now)).offsite_drill).toEqual({ component: 'offsite_drill', status: 'down', detail: 'Your MacBook’s last test of an offsite copy failed yesterday.' });
      // And the Studio's own Restore Test still reads only the copies on this Mac.
      expect((await checks(now)).restore_drill).toMatchObject({ status: 'ok', detail: 'The last restore test was today.' });
    } finally {
      await owner(`DELETE FROM "BackupRun"`);
    }
  });

  it('the report the console shows carries the new components, by name, with their sentences', async () => {
    const now = new Date();
    await recordChecks(db, await checkComponents({ db, config, now, sources: [], machine: { ...healthy, freeBytes: 14 * GB } }), now);
    const report = await healthReport(db, config, now);
    const by = Object.fromEntries(report.components.map((c) => [c.component, c]));
    expect(by.disk).toMatchObject({ status: 'degraded', detail: 'This Mac is low on space, with 14 GB free.' });
    expect(by.remote_access).toMatchObject({ status: 'ok' });
    for (const component of ['disk', 'remote_access', 'standby_model', 'files_backup', 'offsite_drill']) {
      expect(by[component], component).toBeDefined();
      expect(healthName(component)).toBe(HEALTH_NAMES[component]);
    }
    await owner(`DELETE FROM "HealthCheck"`);
  });

  describe('the watchdog', () => {
    const only = async (now: Date, type: string, machine?: MachineReading) => (await watchdog(db, config, now, machine)).filter((r) => r.type === type);
    /** The note an event becomes: its template, rendered. */
    const note = async (type: string, payload: Record<string, unknown>) => {
      const f = facts({ source: 'runtime', type, payload });
      const v = criticalVerdict(f) ?? (await codeVerdict(f, noCode));
      expect(v, type).toMatchObject({ action: 'escalate', lane: 'relevant' });
      const said = render(v!.template!.id as TemplateId, v!.template!.fields);
      expect(noteProblems(said.title, said.body), `${said.title} / ${said.body}`).toEqual([]);
      expect(`${said.title} ${said.body}`).not.toMatch(/%/);
      return { ...said, critical: v!.critical, id: v!.template!.id };
    };

    it('the Mac nearly full: one critical note a day while it lasts, and none when it is merely low', async () => {
      const now = new Date('2026-10-12T18:00:00Z');
      expect(await only(now, 'disk.low', { freeBytes: 14 * GB, remote: { state: 'off' } })).toEqual([]);
      expect(await only(now, 'disk.low', { remote: { state: 'off' } })).toEqual([]); // could not be read
      expect(await only(now, 'disk.low')).toEqual([]); // no reading at all
      const low = await only(now, 'disk.low', { freeBytes: 3.2 * GB, remote: { state: 'off' } });
      expect(low).toMatchObject([{ ref: 'low:2026-10-12', payload: { gb: 3 } }]);
      expect(await raise(db, low, now)).toHaveLength(1);
      // The same day, an hour on: nothing new. The next day, still full: once more.
      expect(await raise(db, await only(new Date(now.getTime() + HOUR), 'disk.low', { freeBytes: 2.9 * GB, remote: { state: 'off' } }), now)).toHaveLength(0);
      expect(await raise(db, await only(new Date(now.getTime() + DAY), 'disk.low', { freeBytes: 0.2 * GB, remote: { state: 'off' } }), now)).toHaveLength(1);
      const said = await note('disk.low', low[0]!.payload);
      expect(said).toMatchObject({ title: 'This Mac Is Nearly Full', body: 'Only 3 GB is free. Backups and the database stop when the disk fills.', critical: true });
      expect(CRITICAL_TEMPLATES.has('disk_low')).toBe(true);
      expect((await note('disk.low', { gb: 0 })).body).toBe('Less than 1 GB is free. Backups and the database stop when the disk fills.');
      // A number that could not have come from the reading is brought inside what the note can say.
      expect((await note('disk.low', { gb: 9000 })).body).toMatch(/^Only 4 GB is free\./);
    });

    it('remote access: its sign-in running out is said at two weeks and once more in the last three days', async () => {
      const now = new Date('2026-10-12T18:00:00Z');
      const expires = new Date(now.getTime() + 12 * DAY + HOUR);
      const ok = (at: Date): MachineReading => ({ remote: { state: 'ok', expiresAt: at } });
      expect(await only(now, 'remote_access.expiring', ok(new Date(now.getTime() + 40 * DAY)))).toEqual([]);
      expect(await only(now, 'remote_access.expiring', { remote: { state: 'ok' } })).toEqual([]);
      const first = await only(now, 'remote_access.expiring', ok(expires));
      expect(first).toMatchObject([{ payload: { days: 12 } }]);
      expect(await raise(db, first, now)).toHaveLength(1);
      // Every five minutes for the next nine days: nothing more.
      expect(await raise(db, await only(new Date(now.getTime() + 5 * DAY), 'remote_access.expiring', ok(expires)), now)).toHaveLength(0);
      // Three days left: once more.
      const last = await only(new Date(now.getTime() + 9 * DAY + 2 * HOUR), 'remote_access.expiring', ok(expires));
      expect(last).toMatchObject([{ payload: { days: 2 } }]);
      expect(await raise(db, last, now)).toHaveLength(1);
      expect(await raise(db, await only(new Date(now.getTime() + 11 * DAY), 'remote_access.expiring', ok(expires)), now)).toHaveLength(0);
      // A new sign-in has a new date: its own two notes, when its time comes.
      expect(await raise(db, await only(now, 'remote_access.expiring', ok(new Date(expires.getTime() + 180 * DAY))), now)).toHaveLength(0);
      expect(await note('remote_access.expiring', { days: 12 })).toMatchObject({ title: 'Remote Access Expires in 12 Days', body: 'Sign in to Tailscale on the Mac Studio to keep reaching Flint from your phone.', critical: false });
      expect((await note('remote_access.expiring', { days: 1 })).title).toBe('Remote Access Expires in 1 Day');
      expect((await note('remote_access.expiring', { days: 0 })).title).toBe('Remote Access Expires Today');
    });

    it('remote access down: nothing for half an hour, then once per outage', async () => {
      const t0 = new Date(Date.now() - 6 * HOUR);
      const down: MachineReading = { remote: { state: 'down', why: 'offline' } };
      const seen = (at: Date, status: string) => healthRows(urls, [{ component: 'remote_access', status, at }]);
      await seen(new Date(t0.getTime() - 10 * MIN), 'ok');
      await seen(t0, 'down');
      await seen(new Date(t0.getTime() + 25 * MIN), 'down');
      expect(await only(new Date(t0.getTime() + 29 * MIN), 'remote_access.down', down)).toEqual([]);
      const at31 = await only(new Date(t0.getTime() + 31 * MIN), 'remote_access.down', down);
      expect(at31).toMatchObject([{ ref: `down:${t0.toISOString()}`, payload: { downMinutes: 31 } }]);
      expect(await raise(db, at31, new Date())).toHaveLength(1);
      expect(await raise(db, await only(new Date(t0.getTime() + 3 * HOUR), 'remote_access.down', down), new Date())).toHaveLength(0);
      // It came back, then went down again: a new outage, told once.
      await seen(new Date(t0.getTime() + 4 * HOUR), 'ok');
      await seen(new Date(t0.getTime() + 4 * HOUR + 5 * MIN), 'down');
      expect(await only(new Date(t0.getTime() + 4 * HOUR + 20 * MIN), 'remote_access.down', down)).toEqual([]);
      expect(await raise(db, await only(new Date(t0.getTime() + 4 * HOUR + 40 * MIN), 'remote_access.down', down), new Date())).toHaveLength(1);
      // A check that could not tell, between two that said down, does not start the half hour again (something in
      // trouble answers slowly); only one that saw it working, or off, does.
      await owner(`DELETE FROM "HealthCheck" WHERE component = 'remote_access'`);
      const t1 = new Date(Date.now() - 3 * HOUR);
      await seen(new Date(t1.getTime() - 5 * MIN), 'degraded');
      for (let i = 0; i < 12; i++) await seen(new Date(t1.getTime() + i * 5 * MIN), i % 3 === 2 ? 'unknown' : 'down');
      const flapping = await only(new Date(t1.getTime() + 56 * MIN), 'remote_access.down', down);
      expect(flapping).toMatchObject([{ ref: `down:${t1.toISOString()}`, payload: { downMinutes: 56 } }]);
      for (const working of ['ok', 'degraded', 'disabled']) {
        await seen(new Date(t1.getTime() + 60 * MIN), working);
        await seen(new Date(t1.getTime() + 65 * MIN), 'down');
        expect(await only(new Date(t1.getTime() + 80 * MIN), 'remote_access.down', down), working).toEqual([]);
        await owner(`DELETE FROM "HealthCheck" WHERE component = 'remote_access' AND at >= $1`, [new Date(t1.getTime() + 60 * MIN)]);
      }
      // Unknown, or never set up, raises nothing: "could not be read" is not "down".
      expect(await only(new Date(), 'remote_access.down', { remote: { state: 'unknown' } })).toEqual([]);
      expect(await only(new Date(), 'remote_access.down', { remote: { state: 'off' } })).toEqual([]);
      expect(await note('remote_access.down', { downMinutes: 31 })).toMatchObject({ title: 'Remote Access Is Down', body: 'Your phone and MacBook can’t reach Flint. Flint on this Mac still works.', critical: false });
      await owner(`DELETE FROM "HealthCheck" WHERE component = 'remote_access'`);
    });

    it('no offsite copy in three days: once per last good copy, only with Will’s key here, and the files’ copy only when the database’s is current', async () => {
      const now = new Date('2026-10-12T18:00:00Z');
      const t = now.getTime();
      try {
        await fileBackup(db, { kind: 'pg_dump_flint', location: 'local', path: '/b/a.dump', startedAt: new Date(t - 2 * HOUR) });
        await fileBackup(db, { kind: 'pg_dump_flint', location: 'icloud', path: '/o/a.dump.age', startedAt: new Date(t - OFFSITE_STALE_MS - HOUR) });
        // Without his key nothing is sent offsite, on purpose: nothing to say.
        expect(await only(now, 'offsite.stale')).toEqual([]);
        writeFileSync(flint('backup-age-recipient'), 'age1example\n');
        // The default folder is iCloud Drive, when this Mac has it.
        expect((await only(now, 'offsite.stale'))[0]!.payload).toMatchObject({ icloud: 0 });
        mkdirSync(join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs'), { recursive: true });
        const stale = await only(now, 'offsite.stale');
        expect(stale).toMatchObject([{ payload: { days: 3, what: 'database', local: 1, icloud: 1 } }]);
        expect(stale[0]!.ref).toMatch(/^database:after:/);
        expect(await raise(db, stale, now)).toHaveLength(1);
        expect(await raise(db, await only(new Date(t + 2 * DAY), 'offsite.stale'), now)).toHaveLength(0);
        expect(await note('offsite.stale', stale[0]!.payload)).toMatchObject({
          title: 'No Backup Has Reached iCloud in 3 Days', body: 'No copy of the database has gone offsite. The backups on this Mac are current. Check that iCloud Drive is signed in and has space.', critical: false,
        });
        // A copy goes: quiet. Then the files' copy alone falls behind: said for the files.
        await fileBackup(db, { kind: 'pg_dump_flint', location: 'icloud', path: '/o/b.dump.age', startedAt: new Date(t - HOUR) });
        expect(await only(now, 'offsite.stale')).toEqual([]);
        await fileBackup(db, { kind: 'flint_tar', location: 'icloud', path: '/o/flint-20261008-0215.tar.gz.age', startedAt: new Date(t - 4 * DAY - HOUR) });
        const files = await only(now, 'offsite.stale');
        expect(files).toMatchObject([{ payload: { days: 4, what: 'files' } }]);
        expect(files[0]!.ref).toMatch(/^files:after:/);
        expect((await note('offsite.stale', files[0]!.payload)).body).toBe('The copy of your files hasn’t gone offsite. The backups on this Mac are current. Check that iCloud Drive is signed in and has space.');
        // A folder of his own choosing is not called iCloud.
        writeFileSync(flint('backup.env'), `FLINT_OFFSITE_DIR=${join(home, 'elsewhere')}\n`, { mode: 0o600 });
        const other = await only(now, 'offsite.stale');
        expect(other[0]!.payload).toMatchObject({ icloud: 0 });
        expect(await note('offsite.stale', other[0]!.payload)).toMatchObject({ title: 'No Offsite Backup in 4 Days', body: 'The copy of your files hasn’t gone offsite. The backups on this Mac are current. Check that the offsite folder is there and has space.' });
      } finally {
        rmSync(flint('backup-age-recipient'), { force: true });
        rmSync(flint('backup.env'), { force: true });
        await owner(`DELETE FROM "BackupRun"`);
      }
    });

    it('the deploy job no longer looking for updates: once per stall, and never while updates are paused', async () => {
      const now = new Date();
      try {
        expect(await only(now, 'auto_update.stalled')).toEqual([]); // no look on record: Health says so, and no note
        aged(flint('deploy-tick'), now, UPDATES_STALLED_MS - MIN);
        expect(await only(now, 'auto_update.stalled')).toEqual([]);
        aged(flint('deploy-tick'), now, UPDATES_STALLED_MS + 5 * MIN);
        const stalled = await only(now, 'auto_update.stalled');
        expect(stalled).toMatchObject([{ payload: { hours: 3 } }]);
        expect(await raise(db, stalled, now)).toHaveLength(1);
        expect(await raise(db, await only(new Date(now.getTime() + HOUR), 'auto_update.stalled'), now)).toHaveLength(0);
        expect(await note('auto_update.stalled', { hours: 3 })).toMatchObject({ title: 'Flint Stopped Checking for Updates', body: 'The last check was 3 hours ago.', critical: false });
        expect((await note('auto_update.stalled', { hours: 72 })).body).toBe('The last check was 3 days ago.');
        // Paused by Will: that has its own line and its own note. So has a pause that was lifted a moment ago.
        aged(flint('deploy-hold'), now, HOUR);
        expect(await only(now, 'auto_update.stalled')).toEqual([]);
        rmSync(flint('deploy-hold'));
        aged(flint('deploy-hold-seen'), now, HOUR);
        expect(await only(now, 'auto_update.stalled')).toEqual([]);
        rmSync(flint('deploy-hold-seen'));
        expect(await only(now, 'auto_update.stalled')).toHaveLength(1);
      } finally {
        rmSync(flint('deploy-hold'), { force: true });
        rmSync(flint('deploy-hold-seen'), { force: true });
        rmSync(flint('deploy-tick'), { force: true });
      }
    });

    it('the MacBook no longer testing the offsite copies: after five weeks, once per last test, and never before a first one', async () => {
      const now = new Date('2026-10-12T18:00:00Z');
      try {
        expect(await only(now, 'offsite_drill.stale')).toEqual([]);
        await owner(`INSERT INTO "BackupRun" (id, kind, location, path, encrypted, status, "startedAt", "restoreTestedAt", "restoreOk") VALUES ('wd-1', 'pg_dump_flint', 'icloud', '/o/x.dump.age', true, 'ok', $1, $1, true)`, [new Date(now.getTime() - OFFSITE_DRILL_STALE_MS + DAY)]);
        expect(await only(now, 'offsite_drill.stale')).toEqual([]);
        await owner(`UPDATE "BackupRun" SET "restoreTestedAt" = $1 WHERE id = 'wd-1'`, [new Date(now.getTime() - OFFSITE_DRILL_STALE_MS - DAY)]);
        const stale = await only(now, 'offsite_drill.stale');
        expect(stale).toMatchObject([{ ref: 'after:wd-1', payload: { weeks: 5 } }]);
        expect(await raise(db, stale, now)).toHaveLength(1);
        expect(await raise(db, await only(new Date(now.getTime() + 7 * DAY), 'offsite_drill.stale'), now)).toHaveLength(0);
        expect(await note('offsite_drill.stale', { weeks: 5 })).toMatchObject({ title: 'Your MacBook Hasn’t Tested a Backup in 5 Weeks', body: 'Open your MacBook and leave it awake for 10 minutes.', critical: false });
        // The Studio's own failed drill is still the latest LOCAL one only: an offsite test does not hide or stand in for it.
        expect(await only(now, 'drill.failed')).toEqual([]);
      } finally {
        await owner(`DELETE FROM "BackupRun"`);
      }
    });
  });
});
