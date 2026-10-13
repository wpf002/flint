/**
 * The files backup's own lines, read into the list of backups
 * (src/backup/ingest.ts), and what Settings > Health says from them.
 *
 * The nightly archive of Flint's files is made by a shell script with no
 * database. It leaves one line for each archive in ~/.flint/backup-events.jsonl
 * (apps/studio/test/backup_events.test.sh checks what the script writes). Here:
 *  - a line is taken only when it is exactly the contract's shape; anything
 *    else is skipped and counted, and no path is ever read from the file;
 *  - reading the same lines again writes nothing;
 *  - a failure never takes the place of a good record of the same archive;
 *  - Files Backup and Offsite Backup say what the records say, in sentences.
 * Everything runs in a scratch home folder, on flint_test.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HEALTH_NAMES, noteProblems } from '@flint/policy';
import { NO_DB, freshDb, withClient, type TestUrls } from './db';
import { createDb, type Db } from '../src/db';
import { loadConfig, type Config } from '../src/config';
import { EVENTS_TAIL_BYTES, archiveFolders, backupEventsFile, ingestBackupEvents, readBackupEvents } from '../src/backup/ingest';
import { fileBackup, fileFailure } from '../src/backup/record';
import { BACKUP_HEALTH, checkComponents } from '../src/health/checks';

const HOUR = 3_600_000;
const hex = (len: number): string => randomBytes(len / 2).toString('hex');
/** A line as the script writes one. */
function line(over: Record<string, unknown> = {}): string {
  return JSON.stringify({ id: hex(32), at: '2026-10-12T07:15:00Z', kind: 'flint_tar', location: 'local', outcome: 'ok', name: 'flint-20261012-0215.tar.gz', bytes: 1234, sha256: hex(64), ...over });
}
const failed = (over: Record<string, unknown> = {}): string => {
  const { bytes: _b, sha256: _s, ...rest } = JSON.parse(line({ outcome: 'failed', reason: 'archive', ...over })) as Record<string, unknown>;
  return JSON.stringify(rest);
};

describe('reading the script’s lines', () => {
  let home: string;
  let file: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'flint-ingest-'));
    mkdirSync(join(home, '.flint'), { mode: 0o700 });
    file = backupEventsFile(home);
  });
  const write = (text: string, mode = 0o600) => {
    writeFileSync(file, text, { mode });
    chmodSync(file, mode);
  };

  it('takes a line only when it is exactly the contract’s shape, and counts the rest', () => {
    const good = [line(), line({ location: 'icloud', name: 'flint-20261012-0215.tar.gz.age' }), failed({ reason: 'space' })];
    const bad = [
      'not json', '{}', '[]', '"flint-20261012-0215.tar.gz"',
      line({ name: '../../etc/passwd' }), line({ name: '/Users/will/FlintBackups/flint-20261012-0215.tar.gz' }), line({ name: 'flint-20261012-0215.tar.gz; rm -rf ~' }),
      line({ path: '/tmp/x' }), line({ kind: 'pg_dump_flint' }), line({ location: 'dropbox' }), line({ outcome: 'maybe' }),
      line({ location: 'icloud' }), line({ name: 'flint-20261012-0215.tar.gz.age' }), // offsite is the encrypted one, and only that
      line({ bytes: -1 }), line({ bytes: '12' }), line({ sha256: 'abc' }), line({ id: 'x' }), line({ at: 'last night' }),
      line({ reason: 'space' }), failed({ reason: 'the disk was full, see /var/log' }), failed({ reason: undefined }),
    ];
    write([...good, ...bad].map((l) => `${l}\n`).join(''));
    const read = readBackupEvents(file);
    expect(read.events).toHaveLength(good.length);
    expect(read.skipped).toBe(bad.length);
    expect(read.events.map((e) => [e.location, e.outcome])).toEqual([['local', 'ok'], ['icloud', 'ok'], ['local', 'failed']]);
  });

  it('a line still being written is left for the next run, and blank lines are nothing', () => {
    write(`${line()}\n\n${line({ name: 'flint-20261013-0215.tar.gz' }).slice(0, 40)}`);
    expect(readBackupEvents(file)).toMatchObject({ events: [{ name: 'flint-20261012-0215.tar.gz' }], skipped: 0 });
    // Finished (its newline is there), it is read.
    write(`${line()}\n${line({ name: 'flint-20261013-0215.tar.gz' })}\n`);
    expect(readBackupEvents(file).events).toHaveLength(2);
  });

  it('only the end of a long file is read, and the line the cut falls in is dropped, not counted', () => {
    const old = `${line({ name: 'flint-20200101-0215.tar.gz' })}\n`;
    const filler = `${'x'.repeat(1000)}\n`.repeat(Math.ceil(EVENTS_TAIL_BYTES / 1001));
    const newest = `${line({ name: 'flint-20261014-0215.tar.gz' })}\n`;
    write(old + filler + newest);
    const read = readBackupEvents(file);
    expect(read.events.map((e) => e.name)).toEqual(['flint-20261014-0215.tar.gz']);
    // Every whole filler line in the part that was read is counted as not the script's; the cut one is not.
    expect(read.skipped).toBeGreaterThan(200);
    expect(read.skipped).toBeLessThan(Math.ceil(EVENTS_TAIL_BYTES / 1001));
  });

  it('no file, or one that someone else could have written, is not the script’s record', () => {
    expect(readBackupEvents(file)).toEqual({ events: [], skipped: 0 });
    for (const mode of [0o620, 0o602, 0o666]) {
      write(`${line()}\n`, mode);
      expect(readBackupEvents(file), mode.toString(8)).toEqual({ events: [], skipped: 0 });
    }
    write(`${line()}\n`, 0o644); // Readable by others is not writable by them.
    expect(readBackupEvents(file).events).toHaveLength(1);
    rmSync(file);
    mkdirSync(file);
    expect(readBackupEvents(file)).toEqual({ events: [], skipped: 0 });
  });
});

describe.skipIf(NO_DB)('into the list of backups, and what Health says from it (flint_test)', () => {
  let urls: TestUrls;
  let db: Db;
  let config: Config;
  let home: string;
  let file: string;
  const rows = () => db.backupRun.findMany({ where: { kind: 'flint_tar' }, orderBy: [{ location: 'asc' }, { path: 'asc' }], select: { location: true, path: true, status: true, bytes: true, sha256: true, encrypted: true, startedAt: true } });
  const add = (...lines: string[]) => appendFileSync(file, lines.map((l) => `${l}\n`).join(''), { mode: 0o600 });
  const at = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const health = async (now: Date, component: string) => (await checkComponents({ db, config, now, sources: [] })).find((c) => c.component === component);

  beforeAll(async () => {
    urls = await freshDb();
    db = createDb(urls.app);
    home = mkdtempSync(join(tmpdir(), 'flint-ingest-home-'));
    mkdirSync(join(home, '.flint'), { mode: 0o700 });
    file = backupEventsFile(home);
    config = loadConfig({ DATABASE_URL: urls.app, HOME: home, FLINT_TZ: 'UTC' });
  });
  afterAll(async () => {
    await db?.$disconnect();
    if (home) rmSync(home, { recursive: true, force: true });
  });
  /** The runtime's own role may not delete a backup's record: a test clears them as the owner. */
  const forget = (where = '') => withClient(urls.owner, (c) => c.query(`DELETE FROM "BackupRun" ${where}`));
  beforeEach(async () => {
    rmSync(file, { force: true });
    await forget();
  });

  it('one row for each archive, where it is worked out from its name; read again, nothing is written', async () => {
    const folders = archiveFolders(home);
    const sha = hex(64);
    add(
      line({ at: '2026-10-12T07:15:00Z', bytes: 5000, sha256: sha }),
      line({ at: '2026-10-12T07:16:00Z', location: 'icloud', name: 'flint-20261012-0215.tar.gz.age', bytes: 5100 }),
      'someone else’s line',
    );
    expect(await ingestBackupEvents(db, home)).toEqual({ read: 2, written: 2, skipped: 1 });
    expect(await rows()).toEqual([
      { location: 'icloud', path: join(folders.icloud, 'flint-20261012-0215.tar.gz.age'), status: 'ok', bytes: 5100n, sha256: expect.stringMatching(/^[0-9a-f]{64}$/), encrypted: true, startedAt: new Date('2026-10-12T07:16:00Z') },
      { location: 'local', path: join(folders.local, 'flint-20261012-0215.tar.gz'), status: 'ok', bytes: 5000n, sha256: sha, encrypted: false, startedAt: new Date('2026-10-12T07:15:00Z') },
    ]);
    expect(folders.local).toBe(join(home, 'FlintBackups'));
    expect(folders.icloud).toBe(join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'FlintBackups'));
    // The health job reads the file every five minutes: the same lines again change nothing.
    const before = await rows();
    for (let i = 0; i < 3; i++) expect(await ingestBackupEvents(db, home)).toEqual({ read: 2, written: 0, skipped: 1 });
    expect(await rows()).toEqual(before);
    // The next night's line is the only new row.
    add(line({ at: '2026-10-13T07:15:00Z', name: 'flint-20261013-0215.tar.gz' }));
    expect(await ingestBackupEvents(db, home)).toEqual({ read: 3, written: 1, skipped: 1 });
    expect(await rows()).toHaveLength(3);
  });

  it('a failure is on record only where nothing is; it never takes a good record’s place, and a later good archive takes its', async () => {
    const name = 'flint-20261012-0215.tar.gz';
    // The archive could not be written.
    add(failed({ at: '2026-10-12T07:15:00Z', name, reason: 'space' }));
    expect(await ingestBackupEvents(db, home)).toMatchObject({ written: 1 });
    expect(await rows()).toMatchObject([{ status: 'failed', bytes: null, sha256: null, startedAt: new Date('2026-10-12T07:15:00Z') }]);
    // Tried again the same minute a little later, and failed again: the same row, at the later time.
    add(failed({ at: '2026-10-12T07:15:40Z', name, reason: 'archive' }));
    expect(await ingestBackupEvents(db, home)).toMatchObject({ written: 1 });
    expect(await rows()).toMatchObject([{ status: 'failed', startedAt: new Date('2026-10-12T07:15:40Z') }]);
    // Then it was made: the row says what is there now.
    add(line({ at: '2026-10-12T07:15:50Z', name, bytes: 7000 }));
    expect(await ingestBackupEvents(db, home)).toMatchObject({ written: 1 });
    expect(await rows()).toMatchObject([{ status: 'ok', bytes: 7000n, startedAt: new Date('2026-10-12T07:15:50Z') }]);
    // A failure reported after that (the offsite copy of another name is a different row; this is the same archive) changes nothing.
    add(failed({ at: '2026-10-12T07:15:59Z', name, reason: 'interrupted' }));
    expect(await ingestBackupEvents(db, home)).toMatchObject({ written: 0 });
    expect(await rows()).toMatchObject([{ status: 'ok', bytes: 7000n }]);
    expect(await db.backupRun.count()).toBe(1);
  });

  it('the records themselves: one row for each file, a failure never over a good record, and a file written again loses its old test result', async () => {
    const w = { kind: 'pg_dump_flint' as const, location: 'local' as const, path: '/b/flint-x.dump', startedAt: new Date('2026-10-12T07:15:00Z') };
    expect(await fileFailure(db, w)).toBe(true);
    expect(await fileFailure(db, w)).toBe(false);
    await fileBackup(db, { ...w, bytes: 10, sha256: hex(64) });
    expect(await fileFailure(db, { ...w, startedAt: new Date('2026-10-12T08:00:00Z') })).toBe(false);
    await db.backupRun.updateMany({ where: { path: w.path }, data: { restoreTestedAt: new Date(), restoreOk: true, restoreDetail: { tables: 3 } } });
    // The same name written again (a retry): its record is of the new file, which nobody has tested.
    await fileBackup(db, { ...w, bytes: 12, sha256: hex(64), startedAt: new Date('2026-10-12T09:00:00Z') });
    expect(await db.backupRun.findMany({ where: { path: w.path }, select: { status: true, bytes: true, restoreTestedAt: true, restoreOk: true, restoreDetail: true } }))
      .toEqual([{ status: 'ok', bytes: 12n, restoreTestedAt: null, restoreOk: null, restoreDetail: null }]);
    // Offsite means encrypted, and the row says so by itself.
    await fileBackup(db, { kind: 'flint_tar', location: 'icloud', path: '/o/flint-20261012-0215.tar.gz.age', startedAt: w.startedAt });
    expect((await db.backupRun.findFirstOrThrow({ where: { location: 'icloud' } })).encrypted).toBe(true);
  });

  it('Files Backup: nothing on record is unknown; then its age; a failure since the last good one is said at once', async () => {
    const now = new Date('2026-10-12T14:00:00Z');
    const t = now.getTime();
    expect(await health(now, 'files_backup')).toEqual({ component: 'files_backup', status: 'unknown', detail: 'No files backup is on record yet.' });
    add(line({ at: at(t - 7 * HOUR) }));
    await ingestBackupEvents(db, home);
    expect(await health(now, 'files_backup')).toEqual({ component: 'files_backup', status: 'ok', detail: 'The last files backup is 7 hours old.' });
    expect((await health(new Date(t + 20 * HOUR), 'files_backup'))).toEqual({ component: 'files_backup', status: 'degraded', detail: 'The last files backup is 27 hours old.' });
    expect((await health(new Date(t + 30 * HOUR), 'files_backup'))).toEqual({ component: 'files_backup', status: 'down', detail: 'The last files backup is 37 hours old.' });
    // The next night's run failed: said now, not when last night's archive has grown old.
    add(failed({ at: at(t + 17 * HOUR), name: 'flint-20261013-0215.tar.gz', reason: 'space' }));
    await ingestBackupEvents(db, home);
    expect(await health(new Date(t + 18 * HOUR), 'files_backup')).toEqual({ component: 'files_backup', status: 'degraded', detail: 'The last files backup failed.' });
    // And made the night after: its age again.
    add(line({ at: at(t + 41 * HOUR), name: 'flint-20261014-0215.tar.gz' }));
    await ingestBackupEvents(db, home);
    expect(await health(new Date(t + 42 * HOUR), 'files_backup')).toEqual({ component: 'files_backup', status: 'ok', detail: 'The last files backup is 1 hour old.' });
    // A first run that failed, with nothing good before it.
    await forget();
    rmSync(file);
    add(failed({ at: at(t - HOUR) }));
    await ingestBackupEvents(db, home);
    expect(await health(now, 'files_backup')).toEqual({ component: 'files_backup', status: 'down', detail: 'The last files backup failed.' });
  });

  it('Offsite Backup says whichever copy is worse off: the database’s, or the files’ once that job has reported', async () => {
    const now = new Date('2026-10-12T14:00:00Z');
    const t = now.getTime();
    writeFileSync(join(home, '.flint', 'backup-age-recipient'), 'age1example\n');
    try {
      await fileBackup(db, { kind: 'pg_dump_flint', location: 'icloud', path: '/o/flint-x.dump.age', startedAt: new Date(t - 6 * HOUR) });
      // The files backup has written no record yet: only the database's copy is looked at.
      expect(await health(now, 'offsite_backup')).toEqual({ component: 'offsite_backup', status: 'ok', detail: 'The last offsite copy is 6 hours old.' });
      // It has, and its own copy never went offsite.
      add(line({ at: at(t - 7 * HOUR) }));
      await ingestBackupEvents(db, home);
      expect(await health(now, 'offsite_backup')).toEqual({ component: 'offsite_backup', status: 'down', detail: 'There’s no offsite copy of your files yet.' });
      add(line({ at: at(t - 7 * HOUR), location: 'icloud', name: 'flint-20261012-0215.tar.gz.age' }));
      await ingestBackupEvents(db, home);
      expect(await health(now, 'offsite_backup')).toEqual({ component: 'offsite_backup', status: 'ok', detail: 'The last offsite copy is 6 hours old.' });
      // The next night the files' copy did not go: said, though the database's is current.
      await fileBackup(db, { kind: 'pg_dump_flint', location: 'icloud', path: '/o/flint-y.dump.age', startedAt: new Date(t + 17 * HOUR) });
      add(line({ at: at(t + 17 * HOUR), name: 'flint-20261013-0215.tar.gz' }), failed({ at: at(t + 17 * HOUR), location: 'icloud', name: 'flint-20261013-0215.tar.gz.age', reason: 'encrypt' }));
      await ingestBackupEvents(db, home);
      expect(await health(new Date(t + 18 * HOUR), 'offsite_backup')).toEqual({ component: 'offsite_backup', status: 'degraded', detail: 'The last files copy didn’t go offsite.' });
      // Two nights on with no files copy: down, by its age.
      await fileBackup(db, { kind: 'pg_dump_flint', location: 'icloud', path: '/o/flint-z.dump.age', startedAt: new Date(t + 41 * HOUR) });
      await forget(`WHERE kind = 'flint_tar' AND location = 'icloud' AND status = 'failed'`);
      expect(await health(new Date(t + 42 * HOUR), 'offsite_backup')).toEqual({ component: 'offsite_backup', status: 'down', detail: 'The offsite copy of your files is 49 hours old.' });
      // Without Will's key nothing goes offsite, on purpose: off, whatever the records say.
      rmSync(join(home, '.flint', 'backup-age-recipient'));
      expect(await health(new Date(t + 42 * HOUR), 'offsite_backup')).toEqual({ component: 'offsite_backup', status: 'disabled' });
    } finally {
      rmSync(join(home, '.flint', 'backup-age-recipient'), { force: true });
    }
  });

  it('every line these say is a plain sentence', () => {
    const lines = [
      BACKUP_HEALTH.failed, BACKUP_HEALTH.filesNone, BACKUP_HEALTH.filesFailed, BACKUP_HEALTH.filesOffsiteNone, BACKUP_HEALTH.filesOffsiteFailed,
      ...[0, 1, 7, 49].flatMap((h) => [BACKUP_HEALTH.filesAge(h), BACKUP_HEALTH.filesOffsiteAge(h)]),
      ...['today', 'yesterday', '3 days ago'].flatMap((when) => [BACKUP_HEALTH.drillPassed(when), BACKUP_HEALTH.drillFailed(when)]),
      ...[9, 13, 14, 35, 400].map((d) => BACKUP_HEALTH.drillLate(d)),
    ];
    for (const said of lines) {
      for (const component of ['files_backup', 'offsite_backup', 'offsite_drill', 'backup']) expect(noteProblems(HEALTH_NAMES[component]!, said), said).toEqual([]);
      expect(said, said).toMatch(/^[A-Z].*\.$/);
      expect(said, said).not.toMatch(/[%()/~]|flint_tar|icloud|[a-z]+_[a-z]+/);
    }
    expect(BACKUP_HEALTH.filesAge(1)).toBe('The last files backup is 1 hour old.');
    expect(BACKUP_HEALTH.drillLate(9)).toBe('Your MacBook hasn’t tested an offsite copy in 9 days.');
    expect(BACKUP_HEALTH.drillLate(35)).toBe('Your MacBook hasn’t tested an offsite copy in 5 weeks.');
  });
});
