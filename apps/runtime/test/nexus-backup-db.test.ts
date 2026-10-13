/**
 * Nexus's own backup (P7; src/backup/nexus.ts and the three commands in
 * src/cli.ts), on a SECOND database made for this test in the test server.
 * The real Nexus database is never opened here, by any name: every address
 * these tests use names the fixture.
 *
 *  - the dump is taken read-only, as its own set: its own folder and names,
 *    0600, without large objects, with row counts from the listed schemas;
 *  - a login that could change the database is refused before anything is
 *    dumped;
 *  - the weekly test restores into a scratch database, compares the counts,
 *    catches a difference, drops the scratch database, and never opens the
 *    database the dump came from;
 *  - the three commands record each file once (kind nexus_dump), wait for a
 *    card until promoted, send only an encrypted copy offsite with its row
 *    counts, and prune by their own names;
 *  - switched off, nothing runs, nothing is filed and no database is opened;
 *  - when Nexus will not let Flint read, the command says what to run, and
 *    never the address or its password;
 *  - `nexus-setup` works the address out, checks it, and writes one line;
 *  - Settings > Health has one line for it, and the watchdog's stale-backup
 *    rule covers it, only while it is switched on.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { noteProblems } from '@flint/policy';
import { NO_DB, URLS, freshDb, withClient } from './db';
import { enrollTestKey } from './sign';
import { createDb, type Db } from '../src/db';
import { loadConfig, nexusBackupState, nexusBackupWanted, runtimeEnv, type Config } from '../src/config';
import { DrillBusy, FLINT_SET, NEXUS_SET, NotReadOnly, StepClock, TookTooLong, canWrite, checkedSet, client, countRows, drillLockKey, dumpDatabase, encryptTo, needsSetup, newestDump, pruneDumps, pruneOffsite, restoreDrill, targetOf, type BackupSet, type StepLimits, type Tools } from '../src/backup/backup';
import { NEXUS_OFF, nexusHelp, nexusSetup, nexusSetupArgs } from '../src/backup/nexus';
import { sendOffsite } from '../src/backup/offsite';
import { fileBackup, fileFailure } from '../src/backup/record';
import { checkDump, RestoreRefused } from '../src/backup/restore';
import { ACTION, STEP, forNexus, gate } from '../src/backup/nightly';
import { approveProposal, createProposal } from '../src/governance/proposals';
import { runInternal } from '../src/governance/internal';
import { NEXUS_HEALTH, checkComponents } from '../src/health/checks';
import { watchdog } from '../src/health/watchdog';
import { p2Report } from '../src/report/exit';
import { CRITICAL_TEMPLATES, criticalVerdict } from '../src/triage/critical';
import { render, type TemplateId } from '../src/templates/escalations';
import { facts } from './triage/helpers';

const RUNTIME = join(__dirname, '..');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const bin = (n: string) => ['/opt/homebrew/opt/postgresql@17/bin', '/usr/lib/postgresql/17/bin', '/opt/homebrew/bin', '/usr/bin'].map((d) => join(d, n)).find((p) => existsSync(p));
const tools: Tools = { pgDump: bin('pg_dump') ?? 'pg_dump', pgRestore: bin('pg_restore') ?? 'pg_restore' };
const clientMajor = (() => {
  try {
    return Number(/(\d+)\./.exec(execFileSync(tools.pgDump, ['--version'], { encoding: 'utf8' }))?.[1] ?? 0);
  } catch {
    return 0;
  }
})();
const READY = !NO_DB && !!URLS?.backup && !!URLS?.restore && clientMajor >= 17;
const AGE = bin('age');
const AGE_KEYGEN = bin('age-keygen');
/** The same address with another database's name: how the fixture is reached by each login. */
const onDatabase = (url: string, database: string): string => url.replace(/\/[^/?#]+$/, `/${database}`);
/** Every line is a sentence, or a command on a line of its own. */
const sentencesOrCommands = (lines: readonly string[]) => {
  for (const l of lines) expect(l, l).toMatch(/^[A-Z].*[.:]$|^ {2}(cd ~\/flint && pnpm --filter @flint\/runtime nexus-[a-z]+( --database <name>)?|psql -d postgres -c '[A-Za-z_ ]+')$/);
};

describe('a backup set’s names', () => {
  it('the two sets are Flint’s and Nexus’s, and neither can be given a name that reaches anything else', () => {
    expect(FLINT_SET).toEqual({ prefix: 'flint', schemas: ['public'], scratch: 'flint_restore_test', kind: 'pg_dump_flint' });
    expect(NEXUS_SET).toEqual({
      prefix: 'nexus', schemas: ['public'], scratch: 'nexus_restore_test', kind: 'nexus_dump', readOnly: true,
      // A database others are using: pg_dump waits 15 seconds on a lock, each tool and statement has a time limit, a
      // second test waits two minutes, and a whole step ends within the hour whatever its parts add up to.
      limits: { lockWaitMs: 15_000, dumpMs: 20 * 60_000, offsiteMs: 20 * 60_000, drillMs: 30 * 60_000, drillWaitMs: 2 * 60_000, stepMs: 60 * 60_000 },
    });
    expect(NEXUS_SET.limits!.stepMs).toBeLessThanOrEqual(60 * 60_000);
    // Flint's own set has none of that: its commands are what they were.
    expect(FLINT_SET.limits ?? FLINT_SET.readOnly).toBeUndefined();
    for (const limits of [{ ...NEXUS_SET.limits!, dumpMs: 0 }, { ...NEXUS_SET.limits!, lockWaitMs: 1.5 }, { ...NEXUS_SET.limits!, drillMs: 48 * 3_600_000 }, { ...NEXUS_SET.limits!, stepMs: 0 }, { ...NEXUS_SET.limits!, stepMs: Number.NaN }]) expect(() => checkedSet({ ...NEXUS_SET, limits })).toThrow(/limits/);
    expect(checkedSet(NEXUS_SET)).toBe(NEXUS_SET);
    const bad: Array<Partial<BackupSet>> = [
      { prefix: 'nexus.*' }, { prefix: '' }, { prefix: 'Nexus' }, { prefix: '../nexus' }, { prefix: 'n' },
      { schemas: [] }, { schemas: ['public"; DROP SCHEMA public; --'] }, { schemas: ['Public'] }, { schemas: ['public', ''] },
      // The scratch database is dropped and made each time: only a name that says it is one is ever taken.
      { scratch: 'nexus' }, { scratch: 'flint' }, { scratch: 'postgres' }, { scratch: 'nexus_restore_test"; DROP DATABASE nexus; --' }, { scratch: 'restore_test' }, { scratch: 'nexus_restore_test_' }, { scratch: 'NEXUS_restore_test' },
    ];
    for (const over of bad) expect(() => checkedSet({ ...NEXUS_SET, ...over }), JSON.stringify(over)).toThrow();
    expect(checkedSet({ ...NEXUS_SET, scratch: 'nexus_restore_test_ab12' }).scratch).toBe('nexus_restore_test_ab12');
  });

  it('each set’s files are its own: pruning, the newest dump and the offsite list never take the other’s', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flint-nexus-names-'));
    for (const day of ['2026-10-01', '2026-10-02', '2026-10-03']) {
      for (const prefix of ['flint', 'nexus']) {
        for (const tail of ['.dump', '.dump.counts.json', '.dump.sha256', '.dump.age', '.dump.counts.json.age']) writeFileSync(join(dir, `${prefix}-${day}${tail}`), '');
      }
    }
    const ofFlint = () => readdirSync(dir).filter((f) => f.startsWith('flint-')).sort();
    const flintBefore = ofFlint();
    expect(newestDump(dir, 'nexus')).toBe(join(dir, 'nexus-2026-10-03.dump'));
    expect(newestDump(dir)).toBe(join(dir, 'flint-2026-10-03.dump'));
    expect(pruneDumps(dir, 2, 'nexus')).toEqual(['nexus-2026-10-01.dump']);
    expect(existsSync(join(dir, 'nexus-2026-10-01.dump.counts.json')) || existsSync(join(dir, 'nexus-2026-10-01.dump.sha256'))).toBe(false);
    expect(ofFlint()).toEqual(flintBefore);
    // Offsite, in one folder with Flint's own copies and a list that names both: only Nexus's old copy goes.
    const manifest = join(dir, 'offsite-copies.txt');
    writeFileSync(manifest, ['flint-2026-10-01.dump.age', 'flint-2026-10-02.dump.age', 'nexus-2026-10-01.dump.age', 'nexus-2026-10-02.dump.age', ''].join('\n'));
    const gone = pruneOffsite(dir, manifest, 'nexus-2026-10-03.dump.age', 2, { prefix: 'nexus', recorded: ['flint-2026-10-01.dump.age', 'nexus-2026-10-01.dump.age'] });
    expect(gone).toEqual(['nexus-2026-10-01.dump.age']);
    expect(existsSync(join(dir, 'nexus-2026-10-01.dump.counts.json.age'))).toBe(false);
    expect(ofFlint()).toEqual(flintBefore);
    expect(readFileSync(manifest, 'utf8')).toBe('nexus-2026-10-02.dump.age\nnexus-2026-10-03.dump.age\n');
    // A name of the other set is not a copy of this one at all.
    expect(() => pruneOffsite(dir, manifest, 'flint-2026-10-03.dump.age', 2, { prefix: 'nexus' })).toThrow(/not an encrypted copy/);
    expect(() => pruneOffsite(dir, manifest, 'nexus-2026-10-03.dump.age', 2)).toThrow(/not an encrypted copy/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('Nexus’s offsite copy only ever writes by path: into a folder it may not list, beside copies it may not read, each is recorded by what was written and the oldest is pruned by name', async () => {
    // What a launchd job has of iCloud Drive: it may write a file by its path, and may neither list the folder nor
    // read a file back. Here the folder cannot be listed, and every copy is made unreadable as soon as it is there.
    const root = mkdtempSync(join(tmpdir(), 'flint-nexus-writeonly-'));
    const dumps = join(root, 'nexus');
    const offsite = join(root, 'icloud', 'FlintBackups', 'nexus');
    mkdirSync(dumps, { recursive: true });
    mkdirSync(offsite, { recursive: true });
    const age = join(root, 'age');
    writeFileSync(age, `#!/bin/zsh\nprint -n -- 'age-encryption.org/v1\\n-> stand-in\\n'\ncat -- "$3"\n`, { mode: 0o755 });
    const sealed = (plain: string) => Buffer.from(`age-encryption.org/v1\n-> stand-in\n${plain}`);
    const night = (n: number) => `nexus-2026-10-${String(n).padStart(2, '0')}T07-15-00-000Z.dump`;
    const records: Array<{ path: string; bytes: bigint; sha256: string }> = [];
    const db = {
      backupRun: {
        findFirst: async () => null,
        findMany: async () => records.map((r) => ({ path: r.path })),
        create: async (a: { data: { path: string; bytes: bigint; sha256: string } }) => records.push(a.data),
        update: async () => undefined,
      },
    } as unknown as Parameters<typeof sendOffsite>[0];
    const warned: string[] = [];
    chmodSync(offsite, 0o300);
    try {
      for (let n = 1; n <= 9; n++) {
        writeFileSync(join(dumps, night(n)), `rows of night ${n}`, { mode: 0o600 });
        writeFileSync(join(dumps, `${night(n)}.counts.json`), `{"public.t":${n}}`, { mode: 0o600 });
        const sent = await sendOffsite(
          db, { ageRecipient: `age1${'q'.repeat(58)}`, offsiteDir: offsite, offsiteManifest: join(dumps, 'offsite-copies.txt'), dumpDir: dumps, tools: { pgDump: 'pg_dump', pgRestore: 'pg_restore', age } },
          new Date(), (line) => warned.push(line), { set: NEXUS_SET, action: 'backup.nexus.offsite' },
        );
        // Its size and fingerprint are of what was written, taken as it went by: the copy is never opened again.
        const copy = sealed(`rows of night ${n}`);
        expect(sent, night(n)).toEqual({ bytes: copy.length, sha256: createHash('sha256').update(copy).digest('hex'), pruned: n > 7 ? 1 : 0 });
        expect(records.at(-1), night(n)).toMatchObject({ path: join(offsite, `${night(n)}.age`), bytes: BigInt(copy.length), sha256: sent.sha256 });
        for (const file of [`${night(n)}.age`, `${night(n)}.counts.json.age`]) chmodSync(join(offsite, file), 0o000);
      }
      expect(warned).toEqual([]);
      expect(() => readdirSync(offsite)).toThrow(/EACCES/);
    } finally {
      chmodSync(offsite, 0o700);
    }
    // The newest seven, each with its row counts; the two oldest went, with theirs.
    expect(readdirSync(offsite).sort()).toEqual([3, 4, 5, 6, 7, 8, 9].flatMap((n) => [`${night(n)}.age`, `${night(n)}.counts.json.age`]).sort());
    rmSync(root, { recursive: true, force: true });
  });

  it('the commands: three for Nexus, each under its own action, doing the same three steps', () => {
    expect(ACTION).toEqual({
      backup: 'backup.local', offsite: 'backup.offsite', drill: 'restore.drill',
      'nexus-backup': 'backup.nexus', 'nexus-offsite': 'backup.nexus.offsite', 'nexus-drill': 'restore.drill.nexus',
    });
    expect([STEP['nexus-backup'], STEP['nexus-offsite'], STEP['nexus-drill']]).toEqual(['backup', 'offsite', 'drill']);
    expect((Object.keys(ACTION) as Array<keyof typeof ACTION>).filter(forNexus)).toEqual(['nexus-backup', 'nexus-offsite', 'nexus-drill']);
    // Each is a script of the runtime's own, so `pnpm --filter @flint/runtime nexus-backup` reaches it.
    const scripts = (JSON.parse(readFileSync(join(RUNTIME, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts;
    for (const name of ['nexus-setup', 'nexus-backup', 'nexus-offsite', 'nexus-drill']) expect(scripts[name], name).toBe(`tsx src/cli.ts ${name}`);
  });

  it('`nexus-setup` takes nothing, or the database’s name, and nothing else', () => {
    expect(nexusSetupArgs([])).toEqual({ database: 'nexus' });
    expect(nexusSetupArgs(['--database', 'nexus_two'])).toEqual({ database: 'nexus_two' });
    for (const argv of [['--database'], ['--database', 'Nexus'], ['--database', 'a b'], ['--database', 'x"; DROP'], ['--database', 'nexus', 'more'], ['nexus'], ['--url', 'postgresql://x'], ['--auto']]) {
      expect(() => nexusSetupArgs(argv), JSON.stringify(argv)).toThrow('usage: cli.ts nexus-setup [--database <name>]');
    }
  });

  it('what Flint says when Nexus will not let it read: what is wrong and what to run, never the address', () => {
    const secret = 'pw-9f2c1e7a';
    const url = `postgresql://flint_backup:${secret}@[::1]:5432/nexus`;
    const pgError = (code: string, message: string) => Object.assign(new Error(message), { code });
    const cases: Array<[unknown, RegExp]> = [
      [pgError('42501', 'permission denied for database "nexus"'), /^Flint’s backup login is not let into the Nexus database\.$/],
      [pgError('42501', 'permission denied for table MemoryEntry'), /not let into/],
      [pgError('28P01', 'password authentication failed for user "flint_backup"'), /^The login in the Nexus address was refused\. Its password may have changed\.$/],
      [pgError('3D000', 'database "nexus" does not exist'), /^There is no database by the name in the Nexus address on this Mac\.$/],
      [new NotReadOnly(['table']), /^The login in the Nexus address holds a right to change Nexus, so Flint backed nothing up\.$/],
      // A right Nexus gives to every login is said as that: no login could give it up.
      [new NotReadOnly(['schema'], ['schema']), /^Nexus gives every login a right to change it, so Flint backed nothing up\.$/],
      [new NotReadOnly(['schema', 'table'], ['schema']), /^The login in the Nexus address holds a right to change Nexus, so Flint backed nothing up\.$/],
    ];
    for (const [err, first] of cases) {
      const lines = nexusHelp(err, { backupUrl: url });
      expect(lines[0], lines[0]).toMatch(first);
      sentencesOrCommands(lines);
      expect(lines.join('\n')).not.toContain(secret);
      expect(lines.join('\n')).not.toMatch(/postgres(ql)?:\/\//);
    }
    // The grants the owner's side gives, to the letter, with what each one lets that login do.
    expect(nexusHelp(pgError('42501', 'permission denied for database "nexus"'), { backupUrl: url })).toEqual([
      'Flint’s backup login is not let into the Nexus database.',
      'Let it in once with these commands, then run this again:',
      "  psql -d postgres -c 'GRANT CONNECT ON DATABASE nexus TO flint_backup'",
      "  psql -d postgres -c 'GRANT pg_read_all_data TO flint_backup'",
      'The first lets that login connect to Nexus. The second lets it read every table there and gives it no right to change one.',
    ]);
    // That advice is the backup's alone: only the backup reads Nexus. A restore test that was refused (its scratch
    // database belongs to someone else, an extension it may not make) says so in its own words, and names no grant;
    // the offsite copy, which works on a file, gets none.
    for (const refused of [pgError('42501', 'must be owner of database nexus_restore_test'), pgError('42501', 'permission denied to create extension "vector"'), pgError('28P01', 'password authentication failed for user "flint_restore"')]) {
      const drill = nexusHelp(refused, { backupUrl: url }, 'drill');
      expect(drill).toEqual(['The restore test could not use its scratch database, so nothing was tested.', 'Nexus was not opened, and nothing there needs changing.']);
      expect(nexusHelp(refused, { backupUrl: url }, 'offsite')).toEqual([]);
      expect(nexusHelp(refused, { backupUrl: url }, 'backup').join('\n')).toMatch(/GRANT|Set the address again/);
    }
    for (const other of [new Error('row counts differ in 1 table'), new DrillBusy(), new TookTooLong('pg_restore', 60_000), new NotReadOnly(['table']), undefined]) {
      expect(nexusHelp(other, { backupUrl: url }, 'drill')).toEqual([]);
      expect(nexusHelp(other, { backupUrl: url }, 'offsite')).toEqual([]);
    }
    // An address that cannot be used is said the same way whichever step it stopped.
    for (const step of ['backup', 'offsite', 'drill'] as const) expect(nexusHelp(undefined, { problem: 'FLINT_NEXUS_BACKUP_URL is not a URL' }, step)[0]).toBe('Flint did not back Nexus up: the address set for it is not a URL.');
    // A login or a database whose name would need quoting is never put into a command.
    const odd = nexusHelp(pgError('42501', 'permission denied'), { backupUrl: `postgresql://Some%20One:${secret}@[::1]:5432/nexus` });
    expect(odd.join('\n')).not.toMatch(/psql|GRANT|Some/);
    sentencesOrCommands(odd);
    // An address that cannot be used says why, in words that hold nothing of it.
    expect(nexusHelp(undefined, { problem: 'FLINT_NEXUS_BACKUP_URL must be a database on this Mac' })).toEqual([
      'Flint did not back Nexus up: the address set for it must be a database on this Mac.', 'Set it again with this command:', '  cd ~/flint && pnpm --filter @flint/runtime nexus-setup',
    ]);
    // A failure that is not one of setup gets no advice.
    expect(nexusHelp(new Error('No space left on device'), { backupUrl: url })).toEqual([]);
    expect(nexusHelp(undefined, { backupUrl: url })).toEqual([]);
    sentencesOrCommands(NEXUS_OFF);
    // A login that could write is a setup problem, never "tries again tonight"; the scratch database missing is not,
    // nor is a step that was stopped for taking too long or held up by another test.
    expect(needsSetup(new NotReadOnly())).toBe(true);
    expect(needsSetup(new TookTooLong('pg_dump', 20 * 60_000))).toBe(false);
    expect(needsSetup(new DrillBusy())).toBe(false);
    expect(new TookTooLong('pg_dump', 20 * 60_000).message).toBe('pg_dump was stopped because it ran longer than 20 minutes');
    expect(new TookTooLong('age', 60_000).message).toBe('age was stopped because it ran longer than 1 minute');
    // A whole step that ran past its hour is said of the step, and is no more a setup problem than a tool that did.
    const hour = new StepClock(NEXUS_SET.limits!.stepMs, 'the backup');
    expect(hour.late().message).toBe('the backup was stopped because it ran longer than 60 minutes');
    expect(needsSetup(hour.late())).toBe(false);
    // Each part of a step is given its own limit, or what is left of the step's when that is less; with nothing left the step ends.
    expect(hour.left(20 * 60_000)).toBe(20 * 60_000);
    expect(hour.over).toBe(false);
    const short = new StepClock(400, 'the restore test');
    expect(short.left(20 * 60_000)).toBeLessThanOrEqual(400);
    expect(short.left(20 * 60_000)).toBeGreaterThan(300);
    expect(short.left(50.9)).toBe(50);
    const spent = new StepClock(1, 'the offsite copy');
    const until = Date.now() + 30;
    while (Date.now() < until) { /* a moment */ }
    expect(spent.over).toBe(true);
    expect(() => spent.left(1000)).toThrow('the offsite copy was stopped because it ran longer than 1 second');
    expect(new DrillBusy().message).toBe('another restore test was using the scratch database, so this one did not run');
    expect(needsSetup(new Error('database "nexus_restore_test" does not exist'))).toBe(false);
    expect(needsSetup(new Error('database "nexus" does not exist'))).toBe(true);
  });
});

describe('the one-time setup, as the README gives it', () => {
  const readme = readFileSync(join(RUNTIME, 'README.md'), 'utf8');
  const section = readme.slice(readme.indexOf('## Nexus is backed up and tested (P7)'), readme.indexOf('## When a database update fails'));
  const commands = [...section.matchAll(/^ {0,3}```\n([\s\S]*?)^ {0,3}```$/gm)].flatMap((m) => m[1]!.split('\n').map((l) => l.trim()).filter(Boolean));

  it('is the commands Flint itself prints: the grant, the switch, and the first backup and test', () => {
    expect(section.length).toBeGreaterThan(2000);
    expect(commands).toEqual([
      "psql -d postgres -c 'GRANT CONNECT ON DATABASE nexus TO flint_backup'",
      'cd ~/flint && pnpm --filter @flint/runtime nexus-setup',
      'cd ~/flint && pnpm --filter @flint/runtime nexus-backup',
      'cd ~/flint && pnpm --filter @flint/runtime nexus-drill',
      "sed -i '' -E '/^(export[[:space:]]+)?FLINT_NEXUS_BACKUP_URL=/d' ~/.flint/backup.env && chmod 600 ~/.flint/backup.env",
      `psql -d flint -c "UPDATE \\"BackupRun\\" SET \\"restoreTestedAt\\" = NULL, \\"restoreOk\\" = NULL, \\"restoreDetail\\" = NULL WHERE kind = 'nexus_dump'"`,
    ]);
    // The grants are the ones a refusal prints, to the letter; the other one it prints is named in the text.
    const printed = nexusHelp(Object.assign(new Error('permission denied for database "nexus"'), { code: '42501' }), { backupUrl: 'postgresql://flint_backup:x@[::1]:5432/nexus' }).map((l) => l.trim());
    expect(printed).toContain(commands[0]);
    expect(section).toContain('`GRANT pg_read_all_data TO flint_backup`');
    expect(printed).toContain("psql -d postgres -c 'GRANT pg_read_all_data TO flint_backup'");
    expect([...NEXUS_OFF].map((l) => l.trim())).toContain(commands[1]);
    // It says what it never does, and that restoring Nexus is not here yet.
    for (const said of ['It ships off.', 'Flint cannot restore Nexus.', 'It never opens the Nexus database.', 'Nexus\'s own backup job is not touched.']) expect(section, said).toContain(said);
    // What it says of the login is what is checked, and it says what is left over; it never promises Nexus cannot be changed.
    expect(section).toContain('through a login that has no right to\n  change Nexus\'s tables');
    expect(section).toContain('### What the login check covers');
    for (const left of ['call a function Nexus\nopened to everyone', 'make temporary tables', 'ordinary read locks']) expect(section, left).toContain(left);
    expect(section).not.toMatch(/can change nothing|cannot change it|changes nothing there|change nothing there|write none|change none/);
    // Rolling back to an older runtime: it says that runtime reads any tested backup, and gives the one step.
    expect(section).not.toContain('are read by nothing');
    expect(section).toContain('read the newest tested backup of any kind');
    const runbook = readFileSync(join(RUNTIME, '..', '..', 'docs', 'RECOVERY.md'), 'utf8');
    expect(runbook).toContain('it cannot\n  put Nexus back');
    expect(runbook).toContain('Restoring Nexus from one is a later part.');
  });

  it('switching it off: the README’s own command takes the line out however it was written, keeps the others, and leaves the file its owner’s alone', () => {
    const home = mkdtempSync(join(tmpdir(), 'flint-nexus-off-'));
    mkdirSync(join(home, '.flint'), { mode: 0o700 });
    const file = join(home, '.flint', 'backup.env');
    const off = commands.find((c) => c.startsWith('sed '))!;
    const script = readFileSync(join(RUNTIME, 'backup-nightly.sh'), 'utf8');
    const fn = /^nexus_on\(\) \{.*\}$/m.exec(script)![0];
    const nightly = () => spawnSync('/bin/zsh', ['-c', `DATA="$1"; ${fn}\nnexus_on`, 'zsh', join(home, '.flint')], { encoding: 'utf8' }).status === 0;
    const url = 'postgresql://flint_backup:x@[::1]:5432/nexus';
    // As `nexus-setup` writes it, as someone exporting it wrote it, quoted, and twice.
    for (const line of [`FLINT_NEXUS_BACKUP_URL=${url}`, `export FLINT_NEXUS_BACKUP_URL=${url}`, `export   FLINT_NEXUS_BACKUP_URL="${url}"`, `FLINT_NEXUS_BACKUP_URL=${url}\nexport FLINT_NEXUS_BACKUP_URL=${url}`]) {
      writeFileSync(file, `FLINT_DB_BACKUP_URL=postgresql://flint_backup:x@[::1]:5432/flint\n${line}\nFLINT_BACKUP_CATCHUP=on\n`, { mode: 0o600 });
      expect(nexusBackupState(home, file), line).toBe('on');
      expect(nightly(), line).toBe(true);
      const r = spawnSync('/bin/zsh', ['-c', off], { env: { PATH: '/usr/bin:/bin', HOME: home }, encoding: 'utf8' });
      expect(`${r.stdout}${r.stderr}`, line).toBe('');
      expect(r.status, line).toBe(0);
      expect(readFileSync(file, 'utf8'), line).toBe('FLINT_DB_BACKUP_URL=postgresql://flint_backup:x@[::1]:5432/flint\nFLINT_BACKUP_CATCHUP=on\n');
      expect(statSync(file).mode & 0o777, line).toBe(0o600);
      expect(nexusBackupState(home, file), line).toBe('off');
      expect(nightly(), line).toBe(false);
    }
    // A line left with nothing after the = is off everywhere too: for the runtime, for the nightly script, and for the commands.
    for (const empty of ['FLINT_NEXUS_BACKUP_URL=', 'export FLINT_NEXUS_BACKUP_URL=', 'FLINT_NEXUS_BACKUP_URL=""', "export FLINT_NEXUS_BACKUP_URL=''", 'FLINT_NEXUS_BACKUP_URL=   ']) {
      writeFileSync(file, `FLINT_DB_BACKUP_URL=postgresql://flint_backup:x@[::1]:5432/flint\n${empty}\n`, { mode: 0o600 });
      expect(nexusBackupState(home, file), empty).toBe('off');
      expect(nexusBackupWanted(home, file), empty).toBe(false);
      expect(nightly(), empty).toBe(false);
      expect(runtimeEnv(file, {}).FLINT_NEXUS_BACKUP_URL?.trim() ?? '', empty).toBe('');
    }
    rmSync(home, { recursive: true, force: true });
  });
});

describe.skipIf(!READY)('Nexus’s own backup, on a second database (never the real one)', () => {
  const tag = randomBytes(4).toString('hex');
  const fixture = `nexus_fixture_${tag}`;
  /** The same set with a scratch name of this run's own, so two runs on one server never share one. */
  const SET: BackupSet = { ...NEXUS_SET, scratch: `nexus_restore_test_${tag}` };
  const ROWS = { '"MemoryEntry"': 250, '"Thread"': 7 };
  let db: Db;
  let nexusUrl: string;
  let ownerUrl: string;
  let dir: string;
  const asOwner = <T>(fn: (c: import('pg').Client) => Promise<T>) => withClient(ownerUrl, fn);
  const databases = async (like: string) => withClient(URLS!.restore!, async (c) => (await c.query<{ datname: string }>('SELECT datname FROM pg_database WHERE datname LIKE $1 ORDER BY 1', [like])).rows.map((r) => r.datname));
  const count = (table: string) => asOwner(async (c) => Number((await c.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n));

  beforeAll(async () => {
    await freshDb();
    db = createDb(URLS!.app);
    nexusUrl = onDatabase(URLS!.backup!, fixture);
    ownerUrl = onDatabase(URLS!.restore!, fixture);
    dir = mkdtempSync(join(tmpdir(), 'flint-nexus-'));
    // A stand-in for Nexus: its own database, made and owned by a login that is not Flint's backup login.
    await withClient(URLS!.restore!, (c) => c.query(`CREATE DATABASE ${fixture}`));
    await asOwner(async (c) => {
      // As Nexus's own schema is: one schema, a function, and a column the database works out itself.
      await c.query(`CREATE FUNCTION nexus_tags_text(tags text[]) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT array_to_string(tags, ' ') $$`);
      await c.query(`CREATE TABLE "MemoryEntry" (id integer PRIMARY KEY, key text NOT NULL, content text, tags text[] NOT NULL DEFAULT '{}',
        "searchVector" tsvector GENERATED ALWAYS AS (setweight(to_tsvector('english'::regconfig, coalesce(key, '')), 'A') || setweight(to_tsvector('english'::regconfig, coalesce(nexus_tags_text(tags), '')), 'C')) STORED)`);
      await c.query(`INSERT INTO "MemoryEntry" (id, key, content, tags) SELECT g, 'key ' || g, 'another writer''s words ' || g, ARRAY['a', 'b'] FROM generate_series(1, ${ROWS['"MemoryEntry"']}) g`);
      await c.query(`CREATE TABLE "Thread" (id integer PRIMARY KEY, title text)`);
      await c.query(`INSERT INTO "Thread" SELECT g, 'thread ' || g FROM generate_series(1, ${ROWS['"Thread"']}) g`);
      await c.query(`CREATE TABLE _prisma_migrations (id text PRIMARY KEY)`);
      await c.query(`INSERT INTO _prisma_migrations VALUES ('a'), ('b')`);
      // Outside the schemas the set lists: dumped and restored like the rest, and not one of the counts.
      await c.query(`CREATE SCHEMA other`);
      await c.query(`CREATE TABLE other.elsewhere (id integer)`);
      await c.query(`INSERT INTO other.elsewhere SELECT generate_series(1, 5)`);
      // A large object some other login made: Flint's backup login may not read it, and no dump includes it.
      await c.query(`SELECT lo_from_bytea(0, 'not a table'::bytea)`);
    });
  });
  afterAll(async () => {
    await db?.$disconnect();
    if (URLS?.restore) {
      await withClient(URLS.restore, async (c) => {
        await c.query(`ALTER DATABASE ${fixture} ALLOW_CONNECTIONS true`).catch(() => {});
        await c.query(`DROP DATABASE IF EXISTS ${fixture} WITH (FORCE)`).catch(() => {});
        // This run's own scratch name. The real one (nexus_restore_test) is never made or dropped from here: only a
        // restore test does that, holding its lock, so a test run beside a real one cannot take its database away.
        await c.query(`DROP DATABASE IF EXISTS ${SET.scratch}`).catch(() => {});
      });
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  describe('the dump, the read-only login and the weekly test', () => {
    let dump: string;

    it('Flint’s backup login can read the fixture and change nothing in it; its owner, and the runtime’s own login in Flint’s database, could', async () => {
      const able = async (url: string) => {
        const c = client(targetOf(url));
        await c.connect();
        try {
          return await canWrite(c);
        } finally {
          await c.end();
        }
      };
      expect(await able(nexusUrl)).toBe(false);
      expect(await able(ownerUrl)).toBe(true);
      expect(await able(URLS!.app)).toBe(true);
      // The same login reads Flint's own database, and can change nothing there either.
      expect(await able(URLS!.backup!)).toBe(false);
      // One write privilege on one table is enough to be refused, and so is leave to make things in it.
      await asOwner((c) => c.query(`GRANT UPDATE ON "Thread" TO flint_backup`));
      expect(await able(nexusUrl)).toBe(true);
      await asOwner((c) => c.query(`REVOKE UPDATE ON "Thread" FROM flint_backup`));
      expect(await able(nexusUrl)).toBe(false);
      await asOwner((c) => c.query(`GRANT CREATE ON SCHEMA other TO flint_backup`));
      expect(await able(nexusUrl)).toBe(true);
      await asOwner((c) => c.query(`REVOKE CREATE ON SCHEMA other FROM flint_backup`));
      await asOwner((c) => c.query(`GRANT CREATE ON DATABASE ${fixture} TO flint_backup`));
      expect(await able(nexusUrl)).toBe(true);
      await asOwner((c) => c.query(`REVOKE CREATE ON DATABASE ${fixture} FROM flint_backup`));
      expect(await able(nexusUrl)).toBe(false);
    });

    it('a login that could change the database is refused before anything is dumped, and nothing is left behind', async () => {
      const out = join(dir, 'refused');
      await expect(dumpDatabase(ownerUrl, out, tools, new Date(), SET)).rejects.toBeInstanceOf(NotReadOnly);
      expect(readdirSync(out)).toEqual([]);
      // Flint's own set does not ask this of its login: its own backup is as it was.
      expect(FLINT_SET.readOnly).toBeUndefined();
    });

    it('the dump: its own name, 0600 in a 0700 folder, without large objects, with counts of the listed schemas from the same snapshot', async () => {
      const out = join(dir, 'nexus');
      const now = new Date('2026-10-13T07:15:02.345Z');
      const d = await dumpDatabase(nexusUrl, out, tools, now, SET);
      dump = d.path;
      expect(basename(d.path)).toBe('nexus-2026-10-13T07-15-02-345Z.dump');
      expect(statSync(out).mode & 0o777).toBe(0o700);
      expect(statSync(d.path).mode & 0o777).toBe(0o600);
      expect(statSync(`${d.path}.counts.json`).mode & 0o777).toBe(0o600);
      expect(readdirSync(out).sort()).toEqual([basename(d.path), `${basename(d.path)}.counts.json`]);
      // The counts: the listed schema's tables, never the migrations table, never another schema's.
      expect(d.counts).toEqual({ 'public."MemoryEntry"': ROWS['"MemoryEntry"'], 'public."Thread"': ROWS['"Thread"'] });
      expect(JSON.parse(readFileSync(`${d.path}.counts.json`, 'utf8'))).toEqual(d.counts);
      // The one large object the fixture holds is counted, so the run can say it was left out; Flint's own dump counts none.
      expect(d.largeObjects).toBe(1);
      // What is in it: every schema's tables (pg_dump takes the whole database), and no large object.
      const listing = execFileSync(tools.pgRestore, ['-l', d.path], { encoding: 'utf8' });
      expect(listing).toMatch(/TABLE DATA public MemoryEntry/);
      expect(listing).toMatch(/TABLE DATA other elsewhere/);
      expect(listing).not.toMatch(/BLOB|LARGE OBJECT/i);
      // Nothing in the fixture changed.
      expect(await count('"MemoryEntry"')).toBe(ROWS['"MemoryEntry"']);
      // A schema list is a list: with both, both are counted.
      const c = client(targetOf(nexusUrl));
      await c.connect();
      try {
        expect(Object.keys(await countRows(c, ['public', 'other'])).sort()).toEqual(['other.elsewhere', 'public."MemoryEntry"', 'public."Thread"']);
        expect(await countRows(c, ['other'])).toEqual({ 'other.elsewhere': 5 });
      } finally {
        await c.end();
      }
    });

    it('the weekly test restores into its scratch database, compares, drops it, and never opens the database the dump came from', async () => {
      // Closed to every connection: a test that opened it would fail here.
      await withClient(URLS!.restore!, (c) => c.query(`ALTER DATABASE ${fixture} ALLOW_CONNECTIONS false`));
      // A scratch database a run that was killed left behind, under this set's own name: it is the one replaced.
      await withClient(URLS!.restore!, (c) => c.query(`CREATE DATABASE ${SET.scratch}`));
      try {
        const r = await restoreDrill(dump, URLS!.restore!, tools, SET);
        expect(r).toEqual({ ok: true, tables: 2, mismatches: [] });
        expect(await databases(`${SET.scratch}%`)).toEqual([]);
        // The login that restores is never pointed at the scratch database itself (it could not then drop it).
        await expect(restoreDrill(dump, onDatabase(URLS!.restore!, SET.scratch), tools, SET)).rejects.toThrow('the restore login’s own database is the scratch database');
      } finally {
        await withClient(URLS!.restore!, (c) => c.query(`ALTER DATABASE ${fixture} ALLOW_CONNECTIONS true`));
      }
    });

    it('the test catches a restored copy that differs from the backup, and still drops the scratch database', async () => {
      const off = join(dir, 'differs');
      mkdirSync(off);
      const copy = join(off, basename(dump));
      writeFileSync(copy, readFileSync(dump), { mode: 0o600 });
      writeFileSync(`${copy}.counts.json`, JSON.stringify({ 'public."MemoryEntry"': ROWS['"MemoryEntry"'] + 1, 'public."Thread"': ROWS['"Thread"'], 'public."Gone"': 3 }));
      const r = await restoreDrill(copy, URLS!.restore!, tools, SET);
      expect(r.ok).toBe(false);
      expect(r.mismatches).toEqual([
        { table: 'public."MemoryEntry"', expected: ROWS['"MemoryEntry"'] + 1, restored: ROWS['"MemoryEntry"'] },
        { table: 'public."Gone"', expected: 3, restored: null },
      ]);
      expect(await databases(`${SET.scratch}%`)).toEqual([]);
      // A file that is no dump fails the test, and the scratch database is gone all the same.
      writeFileSync(copy, 'not a dump');
      await expect(restoreDrill(copy, URLS!.restore!, tools, SET)).rejects.toThrow(/pg_restore exited/);
      expect(await databases(`${SET.scratch}%`)).toEqual([]);
    });

    it('Flint’s own dump and restore test run the tools exactly as before; Nexus’s add only the lock wait, and its own scratch name', async () => {
      // A stand-in for each tool that writes down how it was run, then runs the real one.
      const log = join(dir, 'argv.log');
      const wrapped = (real: string, name: string): string => {
        const f = join(dir, name);
        writeFileSync(f, `#!/bin/zsh\nprint -r -- "${name} $*" >> ${JSON.stringify(log)}\n[[ -n $PGPASSWORD ]] && print -r -- "${name} had its password in its environment" >> ${JSON.stringify(log)}\nexec ${JSON.stringify(real)} "$@"\n`, { mode: 0o755 });
        return f;
      };
      const logging: Tools = { pgDump: wrapped(tools.pgDump, 'pg_dump'), pgRestore: wrapped(tools.pgRestore, 'pg_restore') };
      const ran = () => readFileSync(log, 'utf8').trim().split('\n');
      const at = new Date('2026-10-13T08:00:00.000Z');
      const where = (url: string) => {
        const t = targetOf(url);
        return `-h ${t.host} -p ${t.port} -U ${t.user}`;
      };
      // Flint's own database (flint_test here): the arguments main runs, to the letter.
      const own = join(dir, 'own');
      const f = await dumpDatabase(URLS!.backup!, own, logging, at);
      expect(f.largeObjects).toBeUndefined();
      await restoreDrill(f.path, URLS!.restore!, logging);
      const flintDb = targetOf(URLS!.backup!).database;
      expect(ran().map((l) => l.replace(/--snapshot=\S+/, '--snapshot=S'))).toEqual([
        `pg_dump -Fc --no-large-objects --snapshot=S ${where(URLS!.backup!)} -d ${flintDb} -f ${f.path}.partial`,
        'pg_dump had its password in its environment',
        `pg_restore --no-owner --no-privileges --exit-on-error ${where(URLS!.restore!)} -d flint_restore_test ${f.path}`,
        'pg_restore had its password in its environment',
      ]);
      // Nexus's: the same, with the wait on a lock, and its own scratch database.
      writeFileSync(log, '');
      const n = await dumpDatabase(nexusUrl, join(dir, 'theirs'), logging, at, SET);
      await restoreDrill(n.path, URLS!.restore!, logging, SET);
      expect(ran().map((l) => l.replace(/--snapshot=\S+/, '--snapshot=S'))).toEqual([
        `pg_dump -Fc --no-large-objects --lock-wait-timeout=15000 --snapshot=S ${where(nexusUrl)} -d ${fixture} -f ${n.path}.partial`,
        'pg_dump had its password in its environment',
        `pg_restore --no-owner --no-privileges --exit-on-error ${where(URLS!.restore!)} -d ${SET.scratch} ${n.path}`,
        'pg_restore had its password in its environment',
      ]);
      // No password is ever an argument.
      for (const url of [URLS!.backup!, URLS!.restore!]) expect(readFileSync(log, 'utf8')).not.toContain(decodeURIComponent(new URL(url).password));
    });

    it('a lock someone holds in Nexus ends the dump after its wait, with nothing half-written: it is not waited on all night', async () => {
      // Someone in Nexus holds a table locked (a migration, say): pg_dump cannot take its own lock on it.
      const holder = client(targetOf(ownerUrl));
      await holder.connect();
      await holder.query('BEGIN');
      await holder.query('LOCK TABLE other.elsewhere IN ACCESS EXCLUSIVE MODE');
      try {
        const out = join(dir, 'locked');
        const began = Date.now();
        const err = await dumpDatabase(nexusUrl, out, tools, new Date(), { ...SET, limits: { ...NEXUS_SET.limits!, lockWaitMs: 1000, dumpMs: 20_000 } }).then(() => undefined, (e: unknown) => e);
        expect(err).toBeInstanceOf(Error);
        // (pg_dump's own wait on a lock is a time limit on the statement that takes it.)
        expect((err as Error).message).toBe('pg_dump exited 1: canceling statement due to statement timeout');
        expect(Date.now() - began).toBeLessThan(20_000);
        expect(readdirSync(out)).toEqual([]);
        // Another night may go better: it is not a setup problem.
        expect(needsSetup(err)).toBe(false);
        // And were the wait itself to hang, the step's own time limit stops the tool where it stands.
        const late = join(dir, 'late');
        const stopped = await dumpDatabase(nexusUrl, late, tools, new Date(), { ...SET, limits: { ...NEXUS_SET.limits!, lockWaitMs: 40_000, dumpMs: 1500 } }).then(() => undefined, (e: unknown) => e);
        expect(stopped).toBeInstanceOf(TookTooLong);
        expect((stopped as Error).message).toBe('pg_dump was stopped because it ran longer than 2 seconds');
        expect(readdirSync(late)).toEqual([]);
        expect(spawnSync('/usr/bin/pgrep', ['-f', join(late, 'nexus-')], { encoding: 'utf8' }).stdout.trim()).toBe('');
      } finally {
        await holder.query('ROLLBACK');
        await holder.end();
      }
      // The lock gone, the same dump is taken.
      expect((await dumpDatabase(nexusUrl, join(dir, 'unlocked'), tools, new Date(), SET)).counts).toMatchObject({ 'public."Thread"': ROWS['"Thread"'] });
    });

    it('the offsite copy and the restore test have a time limit too: the tool is stopped, the step fails, and nothing half-made stays', async () => {
      const bin = join(dir, 'slow');
      mkdirSync(bin);
      // An age that begins as age does and never finishes; a pg_restore that never finishes. (exec: the tool itself is what is stopped.)
      writeFileSync(join(bin, 'age'), `#!/bin/zsh\nprint -n -- 'age-encryption.org/v1\\n-> stand-in\\n'\nexec sleep 20\n`, { mode: 0o755 });
      writeFileSync(join(bin, 'pg_restore'), '#!/bin/zsh\nexec sleep 20\n', { mode: 0o755 });
      const sent = join(dir, 'sent');
      const began = Date.now();
      const copy = await encryptTo(dump, `age1${'q'.repeat(58)}`, { ...tools, age: join(bin, 'age') }, sent, 700).then(() => undefined, (e: unknown) => e);
      expect(copy).toBeInstanceOf(TookTooLong);
      expect((copy as Error).message).toBe('age was stopped because it ran longer than 1 second');
      expect(readdirSync(sent)).toEqual([]);
      // The offsite step itself hands age its set's limit: stopped the same way, with no copy and no record of one.
      const recorded: unknown[] = [];
      const noDb = { backupRun: { findFirst: async () => null, findMany: async () => [], create: async (a: unknown) => recorded.push(a), update: async (a: unknown) => recorded.push(a) } } as unknown as Parameters<typeof sendOffsite>[0];
      const step = await sendOffsite(
        noDb, { ageRecipient: `age1${'q'.repeat(58)}`, offsiteDir: sent, offsiteManifest: join(dir, 'offsite-copies.txt'), dumpDir: join(dir, 'nexus'), tools: { ...tools, age: join(bin, 'age') } },
        new Date(), () => {}, { set: { ...SET, limits: { ...NEXUS_SET.limits!, offsiteMs: 700 } }, action: 'backup.nexus.offsite' },
      ).then(() => undefined, (e: unknown) => e);
      expect(step).toBeInstanceOf(TookTooLong);
      expect(readdirSync(sent)).toEqual([]);
      expect(recorded).toEqual([]);
      // Flint's own offsite step has no such limit: its age is run as it always was.
      expect(FLINT_SET.limits).toBeUndefined();
      const test = await restoreDrill(dump, URLS!.restore!, { ...tools, pgRestore: join(bin, 'pg_restore') }, { ...SET, limits: { ...NEXUS_SET.limits!, drillMs: 700 } }).then(() => undefined, (e: unknown) => e);
      expect(test).toBeInstanceOf(TookTooLong);
      expect((test as Error).message).toBe('pg_restore was stopped because it ran longer than 1 second');
      expect(await databases(`${SET.scratch}%`)).toEqual([]);
      expect(Date.now() - began).toBeLessThan(15_000);
      expect(spawnSync('/usr/bin/pgrep', ['-f', bin], { encoding: 'utf8' }).stdout.trim()).toBe('');
    });

    it('one Nexus restore test at a time: a second waits its turn, and says so when the wait is too long, instead of dropping the first one’s database', async () => {
      const key = drillLockKey(SET);
      expect(key).toBe(`restore test ${SET.scratch}`);
      // Another test is under way: it holds the scratch database's lock, as every Nexus test does from start to end.
      const other = client(targetOf(URLS!.restore!));
      await other.connect();
      await other.query('SELECT pg_advisory_lock(hashtext($1))', [key]);
      await other.query(`CREATE DATABASE ${SET.scratch}`);
      try {
        const busy = await restoreDrill(dump, URLS!.restore!, tools, { ...SET, limits: { ...NEXUS_SET.limits!, drillWaitMs: 600 } }).then(() => undefined, (e: unknown) => e);
        expect(busy).toBeInstanceOf(DrillBusy);
        expect((busy as Error).message).toBe('another restore test was using the scratch database, so this one did not run');
        // The other test's database is still there: nothing was dropped under it.
        expect(await databases(`${SET.scratch}%`)).toEqual([SET.scratch]);
        // With time to wait, it runs once the other has finished.
        const waiting = restoreDrill(dump, URLS!.restore!, tools, { ...SET, limits: { ...NEXUS_SET.limits!, drillWaitMs: 30_000 } });
        await new Promise((r) => setTimeout(r, 800));
        expect(await databases(`${SET.scratch}%`)).toEqual([SET.scratch]);
        await other.query(`DROP DATABASE ${SET.scratch}`);
        await other.query('SELECT pg_advisory_unlock(hashtext($1))', [key]);
        expect(await waiting).toEqual({ ok: true, tables: 2, mismatches: [] });
      } finally {
        await other.end();
      }
      // Two started at once: each has the scratch database to itself, one after the other, and both pass.
      const both = await Promise.all([restoreDrill(dump, URLS!.restore!, tools, SET), restoreDrill(dump, URLS!.restore!, tools, SET), restoreDrill(dump, URLS!.restore!, tools, SET)]);
      expect(both.map((r) => r.ok)).toEqual([true, true, true]);
      expect(await databases(`${SET.scratch}%`)).toEqual([]);
    });

    it('a tool that started a helper of its own is stopped with it, at the limit: the step does not wait for the helper to let go', async () => {
      const bin = join(dir, 'helpers');
      mkdirSync(bin);
      // A sleep nobody else on this Mac is running, so whatever is left of it can be looked for.
      const nap = `31.${randomBytes(4).readUInt32BE(0)}`;
      const running = () => spawnSync('/usr/bin/pgrep', ['-f', `sleep ${nap}`], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean);
      const gone = async () => {
        for (let i = 0; i < 40 && running().length; i++) await new Promise((r) => setTimeout(r, 50));
        return running();
      };
      // Each stand-in starts a helper that inherits its pipes, then hangs with it: both far past the limit. The
      // pg_dump has begun its file by then, and the age its stream.
      const hang = `sleep ${nap} &\nsleep ${nap}\n:\n`;
      writeFileSync(join(bin, 'pg_dump'), `#!/bin/zsh\nfor ((i = 1; i <= $#; i++)); do [[ $argv[i] == -f ]] && print -n -- 'half a dump' > $argv[i+1]; done\n${hang}`, { mode: 0o755 });
      writeFileSync(join(bin, 'age'), `#!/bin/zsh\nprint -n -- 'age-encryption.org/v1\\n-> stand-in\\n'\n${hang}`, { mode: 0o755 });
      writeFileSync(join(bin, 'pg_restore'), `#!/bin/zsh\n${hang}`, { mode: 0o755 });
      const standIns: Tools = { pgDump: join(bin, 'pg_dump'), pgRestore: join(bin, 'pg_restore'), age: join(bin, 'age') };
      const withLimits = (over: Partial<StepLimits>): BackupSet => ({ ...SET, limits: { ...NEXUS_SET.limits!, ...over } });
      try {
        // The dump: ended at its limit, not when the helper lets go (half a minute later); nothing half-written; both gone.
        const out = join(dir, 'helped');
        let began = Date.now();
        const d = await dumpDatabase(nexusUrl, out, standIns, new Date(), withLimits({ dumpMs: 1500 })).then(() => undefined, (e: unknown) => e);
        expect(d).toBeInstanceOf(TookTooLong);
        expect((d as Error).message).toBe('pg_dump was stopped because it ran longer than 2 seconds');
        expect(Date.now() - began).toBeLessThan(6000);
        expect(readdirSync(out)).toEqual([]);
        expect(await gone()).toEqual([]);
        // The encrypted copy.
        const sent = join(dir, 'helped-sent');
        began = Date.now();
        const e = await encryptTo(dump, `age1${'q'.repeat(58)}`, standIns, sent, 700).then(() => undefined, (x: unknown) => x);
        expect(e).toBeInstanceOf(TookTooLong);
        expect(Date.now() - began).toBeLessThan(5000);
        expect(readdirSync(sent)).toEqual([]);
        expect(await gone()).toEqual([]);
        // The restore test: its scratch database goes too.
        began = Date.now();
        const r = await restoreDrill(dump, URLS!.restore!, standIns, withLimits({ drillMs: 700 })).then(() => undefined, (x: unknown) => x);
        expect(r).toBeInstanceOf(TookTooLong);
        expect((r as Error).message).toBe('pg_restore was stopped because it ran longer than 1 second');
        expect(Date.now() - began).toBeLessThan(6000);
        expect(await databases(`${SET.scratch}%`)).toEqual([]);
        expect(await gone()).toEqual([]);
      } finally {
        spawnSync('/usr/bin/pkill', ['-f', `sleep ${nap}`]);
      }
    });

    it('a tool with a limit ends with the command that started it: stopped from outside, the command leaves no tool running behind it', async () => {
      const bin = join(dir, 'tied');
      mkdirSync(bin);
      const nap = `32.${randomBytes(4).readUInt32BE(0)}`;
      const running = () => spawnSync('/usr/bin/pgrep', ['-f', `sleep ${nap}`], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean);
      writeFileSync(join(bin, 'tool'), `#!/bin/zsh\nsleep ${nap} &\nsleep ${nap}\n:\n`, { mode: 0o755 });
      // A command that runs the tool with a limit it will not reach, as the three Nexus commands run theirs.
      // (Were it to go on after its tool was stopped, it would leave a mark.)
      const script = join(bin, 'command.mts');
      const wentOn = join(bin, 'went-on');
      writeFileSync(script, [
        `import { writeFileSync } from 'node:fs';`,
        `import { run } from ${JSON.stringify(join(RUNTIME, 'src', 'backup', 'backup.ts'))};`,
        `await run(${JSON.stringify(join(bin, 'tool'))}, [], '', { timeoutMs: 600_000 }).catch(() => undefined);`,
        `writeFileSync(${JSON.stringify(wentOn)}, 'the command went on after it was told to end');`, '',
      ].join('\n'));
      const command = spawn(join(RUNTIME, 'node_modules', '.bin', 'tsx'), [script], { cwd: RUNTIME, stdio: 'ignore', env: { PATH: process.env.PATH ?? '', HOME: dir } });
      const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => command.on('close', (code, signal) => resolve({ code, signal })));
      try {
        // The tool and its helper are both running (a group of their own, apart from the command's).
        for (let i = 0; i < 300 && running().length < 2; i++) await new Promise((r) => setTimeout(r, 50));
        expect(running()).toHaveLength(2);
        // Terminal closed, Ctrl-C, or the job stopped: the command is told to end.
        command.kill('SIGTERM');
        const how = await ended;
        expect(how.signal === 'SIGTERM' || how.code === 143, JSON.stringify(how)).toBe(true);
        for (let i = 0; i < 40 && running().length; i++) await new Promise((r) => setTimeout(r, 50));
        expect(running()).toEqual([]);
        // And the command itself ended there, as the signal meant: it did not carry on to its next step.
        expect(existsSync(wentOn)).toBe(false);
      } finally {
        command.kill('SIGKILL');
        spawnSync('/usr/bin/pkill', ['-f', `sleep ${nap}`]);
      }
    });

    it('each Nexus step has one limit over all its parts: a part well inside its own limit still ends when the step’s time is up', async () => {
      const folder = join(dir, 'whole');
      mkdirSync(folder);
      writeFileSync(join(folder, 'pg_dump'), '#!/bin/zsh\nexec sleep 20\n', { mode: 0o755 });
      writeFileSync(join(folder, 'age'), `#!/bin/zsh\nprint -n -- 'age-encryption.org/v1\\n-> stand-in\\n'\nexec sleep 20\n`, { mode: 0o755 });
      writeFileSync(join(folder, 'pg_restore'), '#!/bin/zsh\nexec sleep 20\n', { mode: 0o755 });
      const slow: Tools = { pgDump: join(folder, 'pg_dump'), pgRestore: join(folder, 'pg_restore'), age: join(folder, 'age') };
      // Every tool and statement has all the time it could want (the real limits, 20 and 30 minutes): only the step's own is short.
      const step = (ms: number, over: Partial<StepLimits> = {}): BackupSet => ({ ...SET, limits: { ...NEXUS_SET.limits!, ...over, stepMs: ms } });
      // The backup, held up in a statement: a table someone holds locked in Nexus is counted before pg_dump runs.
      const holder = client(targetOf(ownerUrl));
      await holder.connect();
      await holder.query('BEGIN');
      await holder.query('LOCK TABLE "Thread" IN ACCESS EXCLUSIVE MODE');
      let began = Date.now();
      try {
        const out = join(dir, 'whole-statement');
        const err = await dumpDatabase(nexusUrl, out, tools, new Date(), step(2000)).then(() => undefined, (e: unknown) => e);
        expect(err).toBeInstanceOf(TookTooLong);
        expect((err as Error).message).toBe('the backup was stopped because it ran longer than 2 seconds');
        // (Without the step's limit it would have waited 15 seconds for the lock and said so.)
        expect(Date.now() - began).toBeLessThan(8000);
        expect(readdirSync(out)).toEqual([]);
        expect(needsSetup(err)).toBe(false);
      } finally {
        await holder.query('ROLLBACK');
        await holder.end();
      }
      // The backup, held up in its tool.
      began = Date.now();
      const tool = await dumpDatabase(nexusUrl, join(dir, 'whole-tool'), slow, new Date(), step(2000)).then(() => undefined, (e: unknown) => e);
      expect((tool as Error).message).toBe('the backup was stopped because it ran longer than 2 seconds');
      expect(Date.now() - began).toBeLessThan(8000);
      expect(readdirSync(join(dir, 'whole-tool'))).toEqual([]);
      // The offsite copy.
      const sent = join(dir, 'whole-sent');
      const recorded: unknown[] = [];
      const noDb = { backupRun: { findFirst: async () => null, findMany: async () => [], create: async (a: unknown) => recorded.push(a), update: async (a: unknown) => recorded.push(a) } } as unknown as Parameters<typeof sendOffsite>[0];
      began = Date.now();
      const copy = await sendOffsite(
        noDb, { ageRecipient: `age1${'q'.repeat(58)}`, offsiteDir: sent, offsiteManifest: join(dir, 'whole-copies.txt'), dumpDir: join(dir, 'nexus'), tools: slow },
        new Date(), () => {}, { set: step(2000), action: 'backup.nexus.offsite' },
      ).then(() => undefined, (e: unknown) => e);
      expect(copy).toBeInstanceOf(TookTooLong);
      expect((copy as Error).message).toBe('the offsite copy was stopped because it ran longer than 2 seconds');
      expect(Date.now() - began).toBeLessThan(8000);
      expect(readdirSync(sent)).toEqual([]);
      expect(recorded).toEqual([]);
      // The restore test: its wait for another test and its restore together. Each is inside its own limit (30
      // seconds to wait, 20 to restore); the step ends three seconds after it began, and drops what it made.
      const other = client(targetOf(URLS!.restore!));
      await other.connect();
      await other.query('SELECT pg_advisory_lock(hashtext($1))', [drillLockKey(SET)]);
      try {
        // (The wait alone: with the other test never done, it ends with the step, long before its own 30 seconds.)
        began = Date.now();
        const waited = await restoreDrill(dump, URLS!.restore!, tools, step(2000, { drillWaitMs: 30_000 })).then(() => undefined, (e: unknown) => e);
        expect((waited as Error).message).toBe('the restore test was stopped because it ran longer than 2 seconds');
        expect(Date.now() - began).toBeLessThan(8000);
        began = Date.now();
        const test = restoreDrill(dump, URLS!.restore!, slow, step(3000, { drillWaitMs: 30_000, drillMs: 20_000 })).then(() => undefined, (e: unknown) => e);
        await new Promise((r) => setTimeout(r, 1200));
        await other.query('SELECT pg_advisory_unlock(hashtext($1))', [drillLockKey(SET)]);
        const err = await test;
        expect(err).toBeInstanceOf(TookTooLong);
        expect((err as Error).message).toBe('the restore test was stopped because it ran longer than 3 seconds');
        const took = Date.now() - began;
        expect(took).toBeGreaterThan(2500);
        expect(took).toBeLessThan(9000);
      } finally {
        await other.end();
      }
      expect(await databases(`${SET.scratch}%`)).toEqual([]);
      expect(spawnSync('/usr/bin/pgrep', ['-f', folder], { encoding: 'utf8' }).stdout.trim()).toBe('');
      // The restore test, held up in its comparison: the restore itself is done, and a session left on the scratch
      // database holds one restored table locked. The count of it ends with the step (not after the 15 seconds a lock
      // is waited on), and the scratch database is dropped with that session still on it.
      const psql = bin('psql');
      if (psql) {
        writeFileSync(join(folder, 'pg_restore'), [
          '#!/bin/zsh',
          `${JSON.stringify(tools.pgRestore)} "$@" || exit $?`,
          'for ((i = 1; i <= $#; i++)); do case $argv[i] in (-h) h=$argv[i+1];; (-p) p=$argv[i+1];; (-U) u=$argv[i+1];; (-d) d=$argv[i+1];; esac; done',
          `${JSON.stringify(psql)} -X -q -w -h $h -p $p -U $u -d $d -c 'BEGIN' -c 'LOCK TABLE "Thread" IN ACCESS EXCLUSIVE MODE' -c 'SELECT pg_sleep(7)' > /dev/null 2>&1 &!`,
          'sleep 0.7', 'exit 0', '',
        ].join('\n'), { mode: 0o755 });
        began = Date.now();
        const held = await restoreDrill(dump, URLS!.restore!, slow, step(3000, { drillMs: 20_000 })).then(() => undefined, (e: unknown) => e);
        expect(held).toBeInstanceOf(TookTooLong);
        expect((held as Error).message).toBe('the restore test was stopped because it ran longer than 3 seconds');
        expect(Date.now() - began).toBeLessThan(9000);
        expect(await databases(`${SET.scratch}%`)).toEqual([]);
      }
      // With the real limits the same steps pass: nothing of this is in their way.
      expect((await restoreDrill(dump, URLS!.restore!, tools, SET)).ok).toBe(true);
    });

    it('a scratch database the restore login is still connected to is replaced all the same: a plain drop would leave it, and every later test would fail', async () => {
      // What a run that was stopped mid-way leaves: the scratch database, and a session of the restore login's own on it.
      await withClient(URLS!.restore!, (c) => c.query(`CREATE DATABASE ${SET.scratch}`));
      const stray = client(targetOf(onDatabase(URLS!.restore!, SET.scratch)));
      await stray.connect();
      try {
        await stray.query('CREATE TABLE left_behind (id integer)');
        // A plain drop is refused for as long as that session is there.
        const plain = await withClient(URLS!.restore!, (c) => c.query(`DROP DATABASE IF EXISTS ${SET.scratch}`)).then(() => undefined, (e: unknown) => e);
        expect((plain as { code?: string }).code).toBe('55006');
        expect(await databases(`${SET.scratch}%`)).toEqual([SET.scratch]);
        // The test replaces it, session and all, restores into a new one, and leaves nothing.
        expect(await restoreDrill(dump, URLS!.restore!, tools, SET)).toEqual({ ok: true, tables: 2, mismatches: [] });
        expect(await databases(`${SET.scratch}%`)).toEqual([]);
        await expect(stray.query('SELECT 1')).rejects.toThrow();
      } finally {
        await stray.end().catch(() => {});
      }
    });

    it('a Nexus dump is never taken for one of Flint’s: the restore of Flint’s database refuses it by name', async () => {
      await expect(checkDump(dump, tools)).rejects.toBeInstanceOf(RestoreRefused);
      const named = join(dir, 'named');
      mkdirSync(named);
      const asFlint = join(named, basename(dump).replace(/^nexus-/, 'flint-'));
      writeFileSync(asFlint, readFileSync(dump), { mode: 0o600 });
      // Renamed, its name fits; with no fingerprint recorded for it as one of Flint's, it is still refused.
      await expect(checkDump(asFlint, tools)).rejects.toThrow(/No fingerprint was recorded/);
    });
  });

  describe('the three commands, as they are run', () => {
    let home: string;
    let backupEnv: string;
    let key: Awaited<ReturnType<typeof enrollTestKey>>;
    const offsite = () => join(home, 'offsite', 'nexus');
    const dumps = () => join(home, 'FlintBackups', 'nexus');
    const writeEnv = (lines: Record<string, string>) => {
      writeFileSync(backupEnv, `${Object.entries(lines).map(([k, v]) => `${k}=${v}`).join('\n')}\n`, { mode: 0o600 });
      chmodSync(backupEnv, 0o600);
    };
    const base = () => ({ FLINT_DB_BACKUP_URL: URLS!.backup!, FLINT_DB_RESTORE_URL: URLS!.restore! });
    const cli = (args: string[], env: Record<string, string> = {}) => {
      const r = spawnSync(join(RUNTIME, 'node_modules', '.bin', 'tsx'), ['src/cli.ts', ...args], {
        cwd: RUNTIME, encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '', HOME: home, NODE_ENV: 'test', RUNTIME_ENV_FILE: join(home, 'none.env'), BACKUP_ENV_FILE: backupEnv, DATABASE_URL: URLS!.app, FLINT_TZ: 'UTC', FLINT_OFFSITE_DIR: join(home, 'offsite'), ...env },
      });
      return { status: r.status, out: r.stdout, err: r.stderr, lines: r.stdout.trim().split('\n').filter(Boolean) };
    };
    const rows = (where: Record<string, unknown> = {}) => db.backupRun.findMany({ where: { kind: 'nexus_dump', ...where }, orderBy: { startedAt: 'asc' }, select: { location: true, path: true, status: true, encrypted: true, bytes: true, sha256: true, restoreOk: true, restoreTestedAt: true } });
    const cards = (action: string) => db.proposal.findMany({ where: { action }, orderBy: { createdAt: 'asc' } });
    const noSecrets = (r: { out: string; err: string }) => {
      for (const url of [URLS!.backup!, URLS!.restore!, URLS!.app]) {
        const password = decodeURIComponent(new URL(url).password);
        if (password) expect(`${r.out}\n${r.err}`.includes(password)).toBe(false);
      }
      expect(`${r.out}\n${r.err}`).not.toMatch(/postgres(ql)?:\/\//);
    };

    beforeAll(async () => {
      home = mkdtempSync(join(tmpdir(), 'flint-nexus-home-'));
      mkdirSync(join(home, '.flint'), { mode: 0o700 });
      backupEnv = join(home, '.flint', 'backup.env');
      key = await enrollTestKey(URLS!);
    });
    afterAll(() => {
      if (home) rmSync(home, { recursive: true, force: true });
    });

    it('switched off (no address): nothing runs, nothing is filed, nothing is recorded, and no database is opened', async () => {
      writeEnv(base());
      // A database address nothing answers on: were it opened, the command would fail.
      const nowhere = { DATABASE_URL: 'postgresql://nobody:nothing@127.0.0.1:1/none' };
      for (const [cmd, action] of [['nexus-backup', 'backup.nexus'], ['nexus-offsite', 'backup.nexus.offsite'], ['nexus-drill', 'restore.drill.nexus']] as const) {
        const auto = cli([cmd, '--auto'], nowhere);
        expect(auto.err).toBe('');
        expect(auto).toMatchObject({ status: 0, out: `${action}: not run (off: no address is set for the Nexus database)\n` });
        const byHand = cli([cmd], nowhere);
        expect(byHand.status).toBe(1);
        expect(byHand.lines).toEqual([...NEXUS_OFF]);
        expect(await cards(action)).toEqual([]);
      }
      expect(await rows()).toEqual([]);
      expect(existsSync(dumps())).toBe(false);
      expect(nexusBackupWanted(home, backupEnv)).toBe(false);
    });

    it('`nexus-setup` refuses a login that could change Nexus and a database that is not there, and writes nothing', async () => {
      const before = () => readFileSync(backupEnv, 'utf8');
      // Flint's own backup address names a login that owns the fixture: it could change it.
      writeEnv({ FLINT_DB_BACKUP_URL: onDatabase(URLS!.restore!, 'postgres'), FLINT_DB_RESTORE_URL: URLS!.restore! });
      const kept = before();
      const writes = cli(['nexus-setup', '--database', fixture]);
      expect(writes.status).toBe(1);
      expect(writes.lines).toEqual([
        'Flint’s backup login holds a right to change the Nexus database, so Flint will not use it there. Nothing was changed.',
        // What it holds, by kind (never by name): here it owns the fixture and everything in it.
        expect.stringMatching(/^What it holds: it owns the database; .*it owns something in the database\.$/),
        'Take that away from it, then run this again.',
      ]);
      expect(before()).toBe(kept);
      noSecrets(writes);
      writeEnv(base());
      const missing = cli(['nexus-setup', '--database', `no_such_${tag}`]);
      expect(missing.status).toBe(1);
      expect(missing.lines[0]).toBe('There is no database by the name in the Nexus address on this Mac.');
      expect(missing.lines.at(-1)).toBe('Nothing was changed.');
      sentencesOrCommands(missing.lines);
      expect(before()).not.toContain('FLINT_NEXUS_BACKUP_URL');
      noSecrets(missing);
      // Flint's own database is not Nexus.
      const own = cli(['nexus-setup', '--database', new URL(URLS!.backup!).pathname.slice(1)]);
      expect(own.status).toBe(1);
      expect(own.lines).toEqual(['Flint did not set it up: the address for Nexus names Flint’s own database, which has its own backup. Nothing was changed.']);
      expect(before()).not.toContain('FLINT_NEXUS_BACKUP_URL');
      // And a word it does not know is refused before anything is read.
      const usage = cli(['nexus-setup', '--url', nexusUrl]);
      expect(usage.status).toBe(1);
      expect(usage.err.trim()).toBe('usage: cli.ts nexus-setup [--database <name>]');
      expect(usage.err).not.toContain(nexusUrl);
    });

    it('`nexus-setup` works the address out from Flint’s own, checks the login, writes one line, and never says the address', async () => {
      writeEnv({ ...base(), FLINT_OFFSITE_DIR: '~/elsewhere' });
      const r = cli(['nexus-setup', '--database', fixture]);
      expect(r.err).toBe('');
      expect(r.status).toBe(0);
      expect(r.lines).toEqual([
        'Flint’s login can read the Nexus database and has no right to change its tables. Flint only reads it.',
        'Nexus’s backup is on. Tonight’s run files its first card in Approvals.',
        'To take a backup now and test it, run these:',
        '  cd ~/flint && pnpm --filter @flint/runtime nexus-backup',
        '  cd ~/flint && pnpm --filter @flint/runtime nexus-drill',
      ]);
      noSecrets(r);
      // One line more, every other line as it was, the file still this user's alone.
      expect(readFileSync(backupEnv, 'utf8')).toBe(`FLINT_DB_BACKUP_URL=${URLS!.backup!}\nFLINT_DB_RESTORE_URL=${URLS!.restore!}\nFLINT_OFFSITE_DIR=~/elsewhere\nFLINT_NEXUS_BACKUP_URL=${nexusUrl}\n`);
      expect(statSync(backupEnv).mode & 0o777).toBe(0o600);
      expect(nexusBackupWanted(home, backupEnv)).toBe(true);
      // Run again (after the passwords were changed, say): the line is replaced, never added twice.
      expect(cli(['nexus-setup', '--database', fixture]).status).toBe(0);
      expect(readFileSync(backupEnv, 'utf8').match(/^FLINT_NEXUS_BACKUP_URL=/gm)).toHaveLength(1);
      writeEnv({ ...base(), FLINT_NEXUS_BACKUP_URL: nexusUrl });
    });

    it('run by the nightly job it waits for a card of its own; nothing is dumped until Will approves it', async () => {
      const waiting = cli(['nexus-backup', '--auto']);
      expect(waiting.err).toBe('');
      expect(waiting).toMatchObject({ status: 0, out: 'backup.nexus: not run (waiting for Will to approve (or promote) it)\n' });
      expect(existsSync(dumps())).toBe(false);
      expect(await rows()).toEqual([]);
      const [card, ...more] = await cards('backup.nexus');
      expect(more).toEqual([]);
      expect(card).toMatchObject({ origin: 'runtime:nexus-backup', templateId: 'nightly.nexus-backup', status: 'pending', tainted: false, destructive: false, sensitivity: 'ops', args: { day: new Date().toISOString().slice(0, 10) } });
      expect(card!.reason).toBe('It waits for your approval each night until you let it run on its own.');
      expect(card!.expiresAt.getTime() - card!.createdAt.getTime()).toBeGreaterThanOrEqual(26 * HOUR - 1000);
      // The weekly test's card lives a week and two hours, like the other restore test's.
      expect(cli(['nexus-drill', '--auto']).out).toBe('restore.drill.nexus: not run (waiting for Will to approve (or promote) it)\n');
      const [drill] = await cards('restore.drill.nexus');
      expect(drill).toMatchObject({ origin: 'runtime:nexus-drill', templateId: 'nightly.nexus-drill', reason: 'It waits for your approval each week until you let it run on its own.' });
      expect(drill!.expiresAt.getTime() - drill!.createdAt.getTime()).toBeGreaterThanOrEqual(7 * DAY + 2 * HOUR - 1000);
      // Approved, tonight's run takes the backup on that card.
      await approveProposal(db, card!.id, await key.approve({ subjectId: card!.id, action: 'backup.nexus', argsDigest: card!.argsDigest }), undefined, 'test');
      const ran = cli(['nexus-backup', '--auto']);
      expect(ran.err).toBe('');
      expect(ran.status).toBe(0);
      // The fixture holds one large object: no backup includes one, and the run says how many it left out.
      expect(ran.out).toMatch(/^backup\.nexus: ok \{"bytes":\d+,"sha256":"[0-9a-f]{64}","tables":2,"pruned":0,"largeObjects":1\}\nNexus holds 1 large object\. No backup includes it, so it was left out\.\n$/);
      expect((await db.proposal.findUniqueOrThrow({ where: { id: card!.id } })).status).toBe('executed');
      expect(await db.auditEntry.findFirst({ where: { action: 'backup.nexus', kind: 'action' }, orderBy: { seq: 'desc' }, select: { actor: true, context: true, outcome: true, correlationId: true } }))
        .toEqual({ actor: 'runtime', context: 'autonomous', outcome: 'ok', correlationId: card!.id });
    });

    it('`nexus-backup`: the dump, its counts and its sealed fingerprint in Nexus’s own folder, and one record of it', async () => {
      const files = readdirSync(dumps()).sort();
      const dump = files.find((f) => /^nexus-.*\.dump$/.test(f))!;
      expect(files).toEqual([dump, `${dump}.counts.json`, `${dump}.sha256`]);
      expect(statSync(dumps()).mode & 0o777).toBe(0o700);
      for (const f of files) expect(statSync(join(dumps(), f)).mode & 0o777, f).toBe(0o600);
      // The fingerprint is sealed with this Mac's key, which is made beside Flint's other state.
      expect(readFileSync(join(dumps(), `${dump}.sha256`), 'utf8')).toMatch(/^[0-9a-f]{64}\ncounts [0-9a-f]{64}\nhmac [0-9a-f]{64}\n$/);
      expect(statSync(join(home, '.flint', 'backup-fingerprint.key')).mode & 0o777).toBe(0o600);
      const recorded = await rows();
      expect(recorded).toEqual([{ location: 'local', path: join(dumps(), dump), status: 'ok', encrypted: false, bytes: BigInt(statSync(join(dumps(), dump)).size), sha256: expect.stringMatching(/^[0-9a-f]{64}$/), restoreOk: null, restoreTestedAt: null }]);
      // Nothing of Flint's own backup was made, touched or recorded by it.
      expect(existsSync(join(home, 'FlintBackups', 'pg'))).toBe(false);
      expect(await db.backupRun.count({ where: { kind: 'pg_dump_flint' } })).toBe(0);
      // By hand it is Will: no card, and another dump with a record of its own.
      await asOwner((c) => c.query('SELECT lo_from_bytea(0, \'another\'::bytea)'));
      const byHand = cli(['nexus-backup']);
      expect(byHand.status).toBe(0);
      expect(byHand.lines.at(-1)).toBe('Nexus holds 2 large objects. No backup includes them, so they were left out.');
      expect(await cards('backup.nexus')).toHaveLength(1);
      expect(await rows({ location: 'local' })).toHaveLength(2);
      expect(await db.auditEntry.findFirst({ where: { action: 'backup.nexus', kind: 'action' }, orderBy: { seq: 'desc' }, select: { actor: true, context: true, outcome: true, correlationId: true } }))
        .toEqual({ actor: 'will:cli', context: 'console', outcome: 'ok', correlationId: null });
      noSecrets(byHand);
    });

    it('`nexus-drill`: the newest dump restored into the scratch database and compared; the result is on that dump’s record', async () => {
      // A record of another kind that happens to name the same file, and is newer: the result is not written there.
      const newest = newestDump(dumps(), 'nexus')!;
      await withClient(URLS!.owner, (c) => c.query(
        `INSERT INTO "BackupRun" (id, kind, location, path, encrypted, status, "startedAt", "finishedAt") VALUES ($1, 'pg_dump_flint', 'local', $2, false, 'ok', now() + interval '1 hour', now() + interval '1 hour')`, [`decoy${tag}`, newest]));
      const r = cli(['nexus-drill']);
      expect(r.err).toBe('');
      expect(r).toMatchObject({ status: 0, out: 'restore.drill.nexus: ok {"tables":2,"mismatches":0}\n' });
      const local = await rows({ location: 'local' });
      expect(local.map((x) => x.restoreOk)).toEqual([null, true]);
      expect(await db.backupRun.findUniqueOrThrow({ where: { id: `decoy${tag}` }, select: { restoreOk: true, restoreTestedAt: true } })).toEqual({ restoreOk: null, restoreTestedAt: null });
      await withClient(URLS!.owner, (c) => c.query(`DELETE FROM "BackupRun" WHERE id = $1`, [`decoy${tag}`]));
      expect(await databases('nexus_restore_test')).toEqual([]);
      // The fixture is as it was.
      expect(await count('"MemoryEntry"')).toBe(ROWS['"MemoryEntry"']);
    });

    it('it keeps the newest 14 dumps of its own, with what is beside them, and never touches a file that is not one', async () => {
      // Thirteen older dumps (sixteen with the two above and tonight's), and one of Flint's own left in the folder by mistake.
      for (let d = 1; d <= 13; d++) {
        const name = `nexus-2026-09-${String(d).padStart(2, '0')}T07-15-00-000Z.dump`;
        for (const tail of ['', '.counts.json', '.sha256']) writeFileSync(join(dumps(), `${name}${tail}`), 'old', { mode: 0o600 });
      }
      writeFileSync(join(dumps(), 'flint-2020-01-01T00-00-00-000Z.dump'), 'not Nexus’s');
      writeFileSync(join(dumps(), 'notes.txt'), 'keep');
      const r = cli(['nexus-backup']);
      expect(r.status).toBe(0);
      expect(r.out).toMatch(/"pruned":2,"largeObjects":2\}\n/);
      const left = readdirSync(dumps());
      expect(left.filter((f) => /^nexus-.*\.dump$/.test(f))).toHaveLength(14);
      expect(left.filter((f) => f.startsWith('nexus-2026-09-01') || f.startsWith('nexus-2026-09-02'))).toEqual([]);
      expect(left).toContain('nexus-2026-09-03T07-15-00-000Z.dump.counts.json');
      expect(left).toContain('flint-2020-01-01T00-00-00-000Z.dump');
      expect(left).toContain('notes.txt');
      for (let d = 3; d <= 13; d++) for (const tail of ['', '.counts.json', '.sha256']) rmSync(join(dumps(), `nexus-2026-09-${String(d).padStart(2, '0')}T07-15-00-000Z.dump${tail}`));
      rmSync(join(dumps(), 'flint-2020-01-01T00-00-00-000Z.dump'));
      rmSync(join(dumps(), 'notes.txt'));
    });

    it('`nexus-offsite`: without Will’s key no copy is written at all; with it, only an encrypted one, with its row counts', async () => {
      const none = cli(['nexus-offsite']);
      expect(none.status).toBe(1);
      expect(none.out).toMatch(/^backup\.nexus\.offsite: FAILED: no age recipient/);
      expect(existsSync(offsite())).toBe(false);
      if (!AGE || !AGE_KEYGEN) return;
      const identity = join(home, 'identity.txt');
      execFileSync(AGE_KEYGEN, ['-o', identity], { stdio: 'ignore' });
      const recipient = /public key: (age1[0-9a-z]+)/.exec(readFileSync(identity, 'utf8'))![1]!;
      const sent = cli(['nexus-offsite'], { FLINT_BACKUP_AGE_RECIPIENT: recipient });
      expect(sent.err).toBe('');
      expect(sent.status).toBe(0);
      expect(sent.out).toMatch(/^backup\.nexus\.offsite: ok \{"bytes":\d+,"sha256":"[0-9a-f]{64}","pruned":0\}\n$/);
      const newest = newestDump(dumps(), 'nexus')!;
      expect(readdirSync(offsite()).sort()).toEqual([`${basename(newest)}.age`, `${basename(newest)}.counts.json.age`]);
      // Encrypted, and it opens to the dump itself with Will's own key.
      const copy = join(offsite(), `${basename(newest)}.age`);
      expect(readFileSync(copy).subarray(0, 22).toString()).toBe('age-encryption.org/v1\n');
      expect(execFileSync(AGE, ['-d', '-i', identity, copy]).equals(readFileSync(newest))).toBe(true);
      expect(JSON.parse(execFileSync(AGE, ['-d', '-i', identity, join(offsite(), `${basename(newest)}.counts.json.age`)], { encoding: 'utf8' }))).toEqual({ 'public."MemoryEntry"': ROWS['"MemoryEntry"'], 'public."Thread"': ROWS['"Thread"'] });
      // Recorded once as an encrypted copy, and sent again it is still one record.
      const recorded = () => rows({ location: 'icloud' });
      expect(await recorded()).toEqual([{ location: 'icloud', path: copy, status: 'ok', encrypted: true, bytes: BigInt(statSync(copy).size), sha256: expect.stringMatching(/^[0-9a-f]{64}$/), restoreOk: null, restoreTestedAt: null }]);
      expect(cli(['nexus-offsite'], { FLINT_BACKUP_AGE_RECIPIENT: recipient }).status).toBe(0);
      expect(await recorded()).toHaveLength(1);
      // Only Nexus's own records say which copies there are to prune. Seven files with copies' names that are on
      // record under ANOTHER kind are not its copies: sending again removes none of them.
      const decoys = Array.from({ length: 7 }, (_, i) => `nexus-2020-01-0${i + 1}T00-00-00-000Z.dump.age`);
      for (const [i, name] of decoys.entries()) {
        writeFileSync(join(offsite(), name), 'not one of its copies');
        await withClient(URLS!.owner, (c) => c.query(
          `INSERT INTO "BackupRun" (id, kind, location, path, encrypted, status, "startedAt", "finishedAt") VALUES ($1, 'pg_dump_flint', 'icloud', $2, true, 'ok', now() - interval '9 days', now() - interval '9 days')`, [`decoy${tag}${i}`, join(offsite(), name)]));
      }
      const again = cli(['nexus-offsite'], { FLINT_BACKUP_AGE_RECIPIENT: recipient });
      expect(again.out).toMatch(/"pruned":0\}\n$/);
      for (const name of decoys) expect(existsSync(join(offsite(), name)), name).toBe(true);
      for (const name of decoys) rmSync(join(offsite(), name));
      await withClient(URLS!.owner, (c) => c.query(`DELETE FROM "BackupRun" WHERE id LIKE $1`, [`decoy${tag}%`]));
      // Its list of copies is its own, beside its own dumps; Flint's own offsite folder and list were not made.
      expect(readFileSync(join(dumps(), 'offsite-copies.txt'), 'utf8')).toBe(`${basename(newest)}.age\n`);
      expect(existsSync(join(home, 'offsite', 'pg')) || existsSync(join(home, 'FlintBackups', 'pg'))).toBe(false);
      expect(readdirSync(join(home, 'offsite'))).toEqual(['nexus']);
    });

    it('an address that is not a database on this Mac: none of Nexus’s steps runs, none files a card, the command says why, and Flint’s own backup is not stopped', async () => {
      const secret = 'hunter2-not-shown';
      writeEnv({ ...base(), FLINT_NEXUS_BACKUP_URL: `postgresql://flint_backup:${secret}@db.example.com:5432/nexus` });
      expect(nexusBackupState(home, backupEnv)).toBe('bad');
      const before = { rows: (await rows()).length, cards: await db.proposal.count({ where: { action: { in: ['backup.nexus', 'backup.nexus.offsite', 'restore.drill.nexus'] } } }) };
      const said = (action: string) => [
        `${action}: not run (FLINT_NEXUS_BACKUP_URL must be a database on this Mac)`,
        'Flint did not back Nexus up: the address set for it must be a database on this Mac.',
        'Set it again with this command:',
        '  cd ~/flint && pnpm --filter @flint/runtime nexus-setup',
      ];
      // A database address nothing answers on: were Flint's own database opened (to ask for a card, say), the command would fail.
      const nowhere = { DATABASE_URL: 'postgresql://nobody:nothing@127.0.0.1:1/none' };
      for (const [cmd, action] of [['nexus-backup', 'backup.nexus'], ['nexus-offsite', 'backup.nexus.offsite'], ['nexus-drill', 'restore.drill.nexus']] as const) {
        // The nightly job: said in its log, and it goes on to the next step.
        const auto = cli([cmd, '--auto'], nowhere);
        expect(auto.err, cmd).toBe('');
        expect(auto.status, cmd).toBe(0);
        expect(auto.lines, cmd).toEqual(said(action));
        // By hand: the same, and the command fails.
        const byHand = cli([cmd]);
        expect(byHand.status, cmd).toBe(1);
        expect(byHand.lines, cmd).toEqual(said(action));
        expect(`${auto.out}${auto.err}${byHand.out}${byHand.err}`, cmd).not.toMatch(new RegExp(`${secret}|example\\.com|postgresql:`));
      }
      // No card was filed for a step that could not run, and nothing was recorded or dumped.
      expect(await db.proposal.count({ where: { action: { in: ['backup.nexus', 'backup.nexus.offsite', 'restore.drill.nexus'] } } })).toBe(before.cards);
      expect(await rows()).toHaveLength(before.rows);
      // Flint's own backup reads the same file, and is not stopped by it.
      const own = cli(['backup']);
      expect(own.err).toBe('');
      expect(own.status).toBe(0);
      expect(own.out).toMatch(/^backup\.local: ok \{"bytes":\d+,"sha256":"[0-9a-f]{64}","tables":\d+,"pruned":0\}\n$/);
      expect(`${own.out}${own.err}`).not.toContain(secret);
    });

    it('a login that could change Nexus, and a database that is not there, are refused with what to run', async () => {
      writeEnv({ ...base(), FLINT_NEXUS_BACKUP_URL: ownerUrl });
      const files = readdirSync(dumps()).length;
      const writes = cli(['nexus-backup']);
      expect(writes.status).toBe(1);
      expect(writes.lines).toEqual([
        expect.stringMatching(/^backup\.nexus: FAILED: the login that reads this database holds a right to change it, so nothing was backed up \(it owns the database; .*it owns something in the database\) \{\}$/),
        'The login in the Nexus address holds a right to change Nexus, so Flint backed nothing up.',
        'Flint reads Nexus only through a login with no right to change it. Set the address again with this command:',
        '  cd ~/flint && pnpm --filter @flint/runtime nexus-setup',
      ]);
      expect(readdirSync(dumps())).toHaveLength(files);
      noSecrets(writes);
      writeEnv({ ...base(), FLINT_NEXUS_BACKUP_URL: onDatabase(URLS!.backup!, `no_such_${tag}`) });
      const missing = cli(['nexus-backup']);
      expect(missing.status).toBe(1);
      expect(missing.lines.slice(1)).toEqual([
        'There is no database by the name in the Nexus address on this Mac.',
        'Set the address again, with the name of the Nexus database:',
        '  cd ~/flint && pnpm --filter @flint/runtime nexus-setup --database <name>',
      ]);
      noSecrets(missing);
      // Not let in: the two grants, by the names in the address.
      await asOwner((c) => c.query(`REVOKE CONNECT ON DATABASE ${fixture} FROM PUBLIC`));
      try {
        writeEnv({ ...base(), FLINT_NEXUS_BACKUP_URL: nexusUrl });
        const shut = cli(['nexus-backup']);
        expect(shut.status).toBe(1);
        expect(shut.lines.slice(1)).toEqual([
          'Flint’s backup login is not let into the Nexus database.',
          'Let it in once with these commands, then run this again:',
          `  psql -d postgres -c 'GRANT CONNECT ON DATABASE ${fixture} TO flint_backup'`,
          "  psql -d postgres -c 'GRANT pg_read_all_data TO flint_backup'",
          'The first lets that login connect to Nexus. The second lets it read every table there and gives it no right to change one.',
        ]);
        noSecrets(shut);
        // The first of them, run by the fixture's owner, is all it takes.
        await asOwner((c) => c.query(`GRANT CONNECT ON DATABASE ${fixture} TO flint_backup`));
        expect(cli(['nexus-backup']).status).toBe(0);
      } finally {
        await asOwner((c) => c.query(`GRANT CONNECT ON DATABASE ${fixture} TO PUBLIC`));
      }
    });

    it('a right Nexus gives to every login is said as Nexus’s to take back, never as something to take away from Flint’s login', async () => {
      writeEnv({ ...base(), FLINT_NEXUS_BACKUP_URL: nexusUrl });
      // As a database carried over from before Postgres 15 is: every login may make things in schema public.
      await asOwner((c) => c.query('GRANT CREATE ON SCHEMA public TO PUBLIC'));
      try {
        const files = readdirSync(dumps()).length;
        const backup = cli(['nexus-backup']);
        expect(backup.status).toBe(1);
        expect(backup.lines).toEqual([
          'backup.nexus: FAILED: the login that reads this database holds a right to change it, so nothing was backed up (every login may make things in a schema) {}',
          'Nexus gives every login a right to change it, so Flint backed nothing up.',
          'Every login there may make things in a schema.',
          'Flint reads Nexus only through a login with no right to change it. The change is on Nexus’s side: once that right is taken back from everyone there, the backup runs again.',
        ]);
        sentencesOrCommands(backup.lines.slice(1));
        expect(readdirSync(dumps())).toHaveLength(files);
        noSecrets(backup);
        // The setup says the same, and writes nothing.
        writeEnv(base());
        const setup = cli(['nexus-setup', '--database', fixture]);
        expect(setup.status).toBe(1);
        expect(setup.lines).toEqual([
          'Nexus gives every login a right to change it, so Flint will not read it yet. Nothing was changed.',
          'Every login there may make things in a schema.',
          'The change is on Nexus’s side: once that right is taken back from everyone there, run this again.',
        ]);
        expect(readFileSync(backupEnv, 'utf8')).not.toContain('FLINT_NEXUS_BACKUP_URL');
        // Neither tells Will to change Flint's login or the address: neither would change anything.
        expect(`${backup.out}${setup.out}`).not.toMatch(/Take that away|Take the first away|Set the address again|nexus-setup/);
        // With a right of the login's own as well, each is said for what it is.
        await asOwner((c) => c.query('GRANT UPDATE ON "Thread" TO flint_backup'));
        const both = cli(['nexus-setup', '--database', fixture]);
        expect(both.status).toBe(1);
        expect(both.lines).toEqual([
          'Flint’s backup login holds a right to change the Nexus database, so Flint will not use it there. Nothing was changed.',
          'What it holds: it owns a table or a view, or holds a right to change, lock or hang a trigger on one; it may change a column of a table.',
          'Nexus also gives every login a right to change it. Every login there may make things in a schema.',
          'Take the first away from Flint’s login. The second is a change on Nexus’s side, for everyone. Then run this again.',
        ]);
        sentencesOrCommands([...setup.lines, ...both.lines]);
      } finally {
        await asOwner((c) => c.query('REVOKE UPDATE ON "Thread" FROM flint_backup'));
        await asOwner((c) => c.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC'));
        writeEnv({ ...base(), FLINT_NEXUS_BACKUP_URL: nexusUrl });
      }
      // Taken back on Nexus's side, the backup runs again with nothing of Flint's changed.
      expect(cli(['nexus-backup']).status).toBe(0);
    });
  });

  describe('a restore test that is refused', () => {
    it('says so in its own words: never the grants that let the backup into Nexus, which would not help it', async () => {
      const home = mkdtempSync(join(tmpdir(), 'flint-nexus-drill-'));
      mkdirSync(join(home, '.flint'), { mode: 0o700 });
      const backupEnv = join(home, '.flint', 'backup.env');
      const restoresAs = (restore: string) => writeFileSync(backupEnv, `FLINT_DB_BACKUP_URL=${URLS!.backup!}\nFLINT_DB_RESTORE_URL=${restore}\nFLINT_NEXUS_BACKUP_URL=${nexusUrl}\n`, { mode: 0o600 });
      restoresAs(URLS!.restore!);
      const cli = (args: string[]) => {
        const r = spawnSync(join(RUNTIME, 'node_modules', '.bin', 'tsx'), ['src/cli.ts', ...args], {
          cwd: RUNTIME, encoding: 'utf8',
          env: { PATH: process.env.PATH ?? '', HOME: home, NODE_ENV: 'test', RUNTIME_ENV_FILE: join(home, 'none.env'), BACKUP_ENV_FILE: backupEnv, DATABASE_URL: URLS!.app, FLINT_TZ: 'UTC' },
        });
        return { status: r.status, lines: r.stdout.trim().split('\n').filter(Boolean), all: `${r.stdout}${r.stderr}` };
      };
      const own = ['The restore test could not use its scratch database, so nothing was tested.', 'Nexus was not opened, and nothing there needs changing.'];
      expect(cli(['nexus-backup']).status).toBe(0);
      const dump = newestDump(join(home, 'FlintBackups', 'nexus'), 'nexus')!;
      // The scratch database is there already and belongs to another login: the restore login may not drop it.
      // (Under this run's own scratch name. The real one is made and dropped only by a restore test itself, which
      // holds its lock while it does: nothing here makes or drops it beside one.)
      await withClient(URLS!.owner, (c) => c.query(`CREATE DATABASE ${SET.scratch}`));
      try {
        const refused = await restoreDrill(dump, URLS!.restore!, tools, SET).then(() => undefined, (e: unknown) => e);
        expect((refused as Error).message).toBe(`must be owner of database ${SET.scratch}`);
        expect(nexusHelp(refused, { backupUrl: nexusUrl }, 'drill')).toEqual(own);
        // The other login's database was left as it was.
        expect(await databases(SET.scratch)).toEqual([SET.scratch]);
      } finally {
        await withClient(URLS!.owner, (c) => c.query(`DROP DATABASE IF EXISTS ${SET.scratch}`));
      }
      // The command itself, refused: here its restore login is one that may not make a database at all. (Were a
      // real test under way on this server, it would be refused a step sooner, at that test's database.)
      restoresAs(URLS!.backup!);
      const r = cli(['nexus-drill']);
      expect(r.status).toBe(1);
      expect(r.lines).toEqual([expect.stringMatching(/^restore\.drill\.nexus: FAILED: (permission denied to create database|must be owner of database nexus_restore_test) \{\}$/), ...own]);
      expect(r.all).not.toMatch(/GRANT|pg_read_all_data|not let into/);
      // With a restore login that may, the same command passes, and a test that only finds a difference gets no advice either.
      restoresAs(URLS!.restore!);
      expect(cli(['nexus-drill']).lines).toEqual(['restore.drill.nexus: ok {"tables":2,"mismatches":0}']);
      rmSync(home, { recursive: true, force: true });
    });
  });

  describe('who may run it', () => {
    let key: Awaited<ReturnType<typeof enrollTestKey>>;
    const expiresAt = new Date(Date.now() + 60 * DAY).toISOString();
    const promote = async (rows: Array<Record<string, unknown>>) => {
      const card = await createProposal(db, { kind: 'policy', origin: 'console', action: 'policy.change', args: { rows }, argsProvenance: {}, tainted: false, sensitivity: 'ops', destructive: false, consequential: true, ttlMinutes: 60 }, 'test');
      await approveProposal(db, card.id, await key.approve({ subjectId: card.id, action: 'policy.change', argsDigest: card.argsDigest }), undefined, 'test');
      await runInternal(db, card.id, undefined, 'UTC', 'test');
    };
    beforeAll(async () => {
      key = await enrollTestKey(URLS!);
    });

    it('a promotion signed for the backups as a group does not cover Nexus’s; one that names each does, under its own cap', async () => {
      const now = new Date();
      // (As on another day: the runs above, on a card, each had the one run a day their action may have.)
      await withClient(URLS!.owner, (c) => c.query(`DELETE FROM "ActionCounter" WHERE action LIKE 'backup.%' OR action LIKE 'restore.drill%'`));
      await promote([{ pattern: 'backup.*', tier: 'alone', dailyCap: 5, expiresAt }, { pattern: 'restore.drill.*', tier: 'alone', dailyCap: 5, expiresAt }]);
      for (const cmd of ['nexus-backup', 'nexus-offsite', 'nexus-drill'] as const) {
        expect(await gate(db, cmd, 'UTC', undefined, now), cmd).toMatchObject({ go: false, why: 'waiting for Will to approve (or promote) it' });
      }
      // Flint's own three are covered by those rows, as they always were.
      expect(await gate(db, 'backup', 'UTC', undefined, now)).toMatchObject({ go: true, why: 'promoted' });
      await promote([
        { pattern: 'backup.nexus', tier: 'alone', dailyCap: 1, expiresAt }, { pattern: 'backup.nexus.offsite', tier: 'alone', dailyCap: 1, expiresAt }, { pattern: 'restore.drill.nexus', tier: 'alone', dailyCap: 1, expiresAt },
      ]);
      for (const [cmd, cap] of [['nexus-backup', 'daily'], ['nexus-offsite', 'daily'], ['nexus-drill', 'weekly']] as const) {
        const later = new Date(now.getTime() + 60_000);
        expect(await gate(db, cmd, 'UTC', undefined, later), cmd).toMatchObject({ go: true, why: 'promoted' });
        // Once a day, or once a week for the test: a second run is held to the cap.
        expect(await gate(db, cmd, 'UTC', undefined, new Date(later.getTime() + 60_000)), cmd).toEqual({ go: false, why: `the ${cap} cap is reached` });
      }
    });

    it('nothing in chat can ask for any of the three', async () => {
      const day = new Date().toISOString().slice(0, 10);
      for (const action of ['backup.nexus', 'backup.nexus.offsite', 'restore.drill.nexus']) {
        await expect(createProposal(db, {
          kind: 'tool_call', origin: 'chat:abc', action, args: { day }, argsProvenance: { day: { source: 'template', ref: 'x', tainted: false } },
          tainted: false, sensitivity: 'ops', destructive: false, consequential: false, ttlMinutes: 60,
        }, 'test'), action).rejects.toThrow(new RegExp(`forbidden: ${action.replace(/\./g, '\\.')} is never asked for from chat`));
      }
    });
  });

  describe('Settings > Health and the watchdog', () => {
    let home: string;
    let config: Config;
    const flint = (name: string) => join(home, '.flint', name);
    const on = () => {
      writeFileSync(flint('backup.env'), `FLINT_DB_BACKUP_URL=${URLS!.backup!}\nFLINT_NEXUS_BACKUP_URL=${nexusUrl}\n`, { mode: 0o600 });
    };
    const off = () => writeFileSync(flint('backup.env'), `FLINT_DB_BACKUP_URL=${URLS!.backup!}\n`, { mode: 0o600 });
    const forget = () => withClient(URLS!.owner, (c) => c.query(`DELETE FROM "BackupRun"`));
    const row = async (now: Date, read: Db = db) => (await checkComponents({ db: read, config, now, sources: [] })).filter((c) => c.component === 'nexus_backup' || c.component === 'restore_drill' || c.component === 'backup');
    const nexus = async (now: Date) => (await row(now)).find((c) => c.component === 'nexus_backup')!;
    const dumpAt = (at: Date, name = at.toISOString().replace(/[:.]/g, '-')) => fileBackup(db, { kind: 'nexus_dump', location: 'local', path: `/x/FlintBackups/nexus/nexus-${name}.dump`, bytes: 1000, sha256: 'a'.repeat(64), startedAt: at });
    const sentAt = (at: Date) => fileBackup(db, { kind: 'nexus_dump', location: 'icloud', path: `/x/icloud/nexus/nexus-${at.toISOString().replace(/[:.]/g, '-')}.dump.age`, bytes: 1000, sha256: 'b'.repeat(64), startedAt: at });
    const tested = (path: string, at: Date, ok: boolean) => withClient(URLS!.owner, (c) => c.query(`UPDATE "BackupRun" SET "restoreTestedAt" = $2, "restoreOk" = $3 WHERE path = $1`, [path, at, ok]));
    const NOW = new Date('2026-10-18T15:00:00Z');
    const ago = (ms: number) => new Date(NOW.getTime() - ms);

    beforeAll(() => {
      home = mkdtempSync(join(tmpdir(), 'flint-nexus-health-'));
      mkdirSync(join(home, '.flint'), { mode: 0o700 });
      config = loadConfig({ DATABASE_URL: URLS!.app, HOME: home, FLINT_TZ: 'UTC' });
    });
    afterAll(() => {
      if (home) rmSync(home, { recursive: true, force: true });
    });

    it('switched off it reads Off, and nothing of Nexus’s backup is looked up at all', async () => {
      await forget();
      await dumpAt(ago(100 * HOUR));
      const asked: unknown[] = [];
      const watching = new Proxy(db, {
        get: (t, k) => (k === 'backupRun'
          ? new Proxy(t.backupRun, { get: (b, m) => (typeof m === 'string' && /^find|^count/.test(m) ? (args: { where?: { kind?: unknown } }) => { asked.push(args?.where?.kind); return (Reflect.get(b, m) as (a: unknown) => unknown).call(b, args); } : Reflect.get(b, m)) })
          : Reflect.get(t, k)),
      });
      for (const state of ['no file', 'no line', 'an empty line'] as const) {
        if (state === 'no file') rmSync(flint('backup.env'), { force: true });
        else if (state === 'no line') off();
        else writeFileSync(flint('backup.env'), 'FLINT_NEXUS_BACKUP_URL=\nFLINT_NEXUS_BACKUP_URL=""\n# FLINT_NEXUS_BACKUP_URL=postgresql://x\n', { mode: 0o600 });
        asked.length = 0;
        expect((await row(NOW, watching)).find((c) => c.component === 'nexus_backup'), state).toEqual({ component: 'nexus_backup', status: 'disabled' });
        expect(asked.length).toBeGreaterThan(0);
        expect(asked.filter((kind) => kind === 'nexus_dump'), state).toEqual([]);
        // The watchdog raises nothing about it either, though an old dump is on record from when it was on.
        expect((await watchdog(db, config, NOW)).filter((r) => r.type.startsWith('nexus'))).toEqual([]);
      }
      expect(nexusBackupWanted(home)).toBe(false);
      expect(nexusBackupState(home)).toBe('off');
    });

    it('an address Flint cannot use: the row says it needs fixing, whatever the last dump’s age, and nothing of Nexus’s backup is looked up', async () => {
      await forget();
      await dumpAt(ago(2 * HOUR));
      const asked: unknown[] = [];
      const watching = new Proxy(db, {
        get: (t, k) => (k === 'backupRun'
          ? new Proxy(t.backupRun, { get: (b, m) => (typeof m === 'string' && /^find|^count/.test(m) ? (args: { where?: { kind?: unknown } }) => { asked.push(args?.where?.kind); return (Reflect.get(b, m) as (a: unknown) => unknown).call(b, args); } : Reflect.get(b, m)) })
          : Reflect.get(t, k)),
      });
      for (const bad of ['postgresql://flint_backup:s3cret@db.example.com:5432/nexus', 'not an address', URLS!.backup!, 'postgresql://flint_backup:s3cret@[::1]:5432/postgres']) {
        writeFileSync(flint('backup.env'), `FLINT_DB_BACKUP_URL=${URLS!.backup!}\nFLINT_NEXUS_BACKUP_URL=${bad}\n`, { mode: 0o600 });
        expect(nexusBackupState(home), bad).toBe('bad');
        asked.length = 0;
        const got = (await row(NOW, watching)).find((c) => c.component === 'nexus_backup');
        expect(got, bad).toEqual({ component: 'nexus_backup', status: 'down', detail: 'The Nexus backup’s address needs fixing. Nothing is backed up until it is set again.' });
        expect(asked.filter((kind) => kind === 'nexus_dump'), bad).toEqual([]);
        expect(JSON.stringify(got)).not.toMatch(/s3cret|example|postgres/);
      }
      expect(noteProblems('Nexus Backup', NEXUS_HEALTH.address)).toEqual([]);
      // Set right again, the row is the backup's own again.
      on();
      expect(nexusBackupState(home)).toBe('on');
      expect(await nexus(NOW)).toEqual({ component: 'nexus_backup', status: 'ok', detail: 'The last Nexus backup is 2 hours old.' });
    });

    it('switched on: no backup yet is an issue; then its age; late after 26 hours and missing after 36; a failure is said at once', async () => {
      on();
      expect(nexusBackupWanted(home)).toBe(true);
      await forget();
      expect(await nexus(NOW)).toEqual({ component: 'nexus_backup', status: 'degraded', detail: 'There’s no Nexus backup yet.' });
      await dumpAt(ago(7 * HOUR));
      expect(await nexus(NOW)).toEqual({ component: 'nexus_backup', status: 'ok', detail: 'The last Nexus backup is 7 hours old.' });
      expect(await nexus(new Date(NOW.getTime() + 20 * HOUR))).toEqual({ component: 'nexus_backup', status: 'degraded', detail: 'The last Nexus backup is 27 hours old.' });
      expect(await nexus(new Date(NOW.getTime() + 30 * HOUR))).toEqual({ component: 'nexus_backup', status: 'down', detail: 'The last Nexus backup is 37 hours old.' });
      // A run that failed since the last good one.
      await fileFailure(db, { kind: 'nexus_dump', location: 'local', path: '/x/FlintBackups/nexus/nexus-failed.dump', startedAt: ago(HOUR) });
      expect(await nexus(NOW)).toEqual({ component: 'nexus_backup', status: 'degraded', detail: 'The last Nexus backup failed.' });
      // A good one after it: its age again.
      await dumpAt(ago(30 * 60_000), 'after');
      expect(await nexus(NOW)).toEqual({ component: 'nexus_backup', status: 'ok', detail: 'The last Nexus backup is 1 hour old.' });
      // Only a failure and no backup at all: it failed and there is none, which is down, never "none yet".
      await forget();
      await fileFailure(db, { kind: 'nexus_dump', location: 'local', path: '/x/FlintBackups/nexus/nexus-failed.dump', startedAt: ago(HOUR) });
      expect(await nexus(NOW)).toEqual({ component: 'nexus_backup', status: 'down', detail: 'The last Nexus backup failed.' });
    });

    it('its offsite copy counts only once Will’s key is here; its test is said when it failed, never ran, or grew old', async () => {
      await forget();
      await dumpAt(ago(2 * HOUR), 'tonight');
      const dump = '/x/FlintBackups/nexus/nexus-tonight.dump';
      expect((await nexus(NOW)).status).toBe('ok');
      // With the key: a copy is expected.
      writeFileSync(flint('backup-age-recipient'), `age1${'q'.repeat(58)}\n`);
      expect(await nexus(NOW)).toEqual({ component: 'nexus_backup', status: 'down', detail: 'The Nexus backup hasn’t gone offsite yet.' });
      await sentAt(ago(30 * HOUR));
      expect(await nexus(NOW)).toEqual({ component: 'nexus_backup', status: 'degraded', detail: 'The offsite copy of the Nexus backup is 30 hours old.' });
      await fileFailure(db, { kind: 'nexus_dump', location: 'icloud', path: '/x/icloud/nexus/nexus-failed.dump.age', startedAt: ago(HOUR) });
      expect(await nexus(NOW)).toEqual({ component: 'nexus_backup', status: 'degraded', detail: 'The last Nexus backup didn’t go offsite.' });
      await sentAt(ago(HOUR / 2));
      expect(await nexus(NOW)).toEqual({ component: 'nexus_backup', status: 'ok', detail: 'The last Nexus backup is 2 hours old.' });
      // Its test: failed is down, and the worst thing is what is said.
      await tested(dump, ago(13 * HOUR), false);
      expect(await nexus(NOW)).toEqual({ component: 'nexus_backup', status: 'down', detail: 'The last Nexus restore test failed today.' });
      await tested(dump, ago(13 * HOUR), true);
      expect(await nexus(NOW)).toEqual({ component: 'nexus_backup', status: 'ok', detail: 'The last Nexus backup is 2 hours old.' });
      await tested(dump, ago(9 * DAY), true);
      expect(await nexus(NOW)).toEqual({ component: 'nexus_backup', status: 'degraded', detail: 'The last Nexus restore test was 9 days ago.' });
      // Never tested: nothing is said in its first week, and then it is.
      await withClient(URLS!.owner, (c) => c.query(`UPDATE "BackupRun" SET "restoreTestedAt" = NULL, "restoreOk" = NULL`));
      expect((await nexus(NOW)).status).toBe('ok');
      await dumpAt(ago(9 * DAY), 'first');
      expect(await nexus(NOW)).toEqual({ component: 'nexus_backup', status: 'degraded', detail: 'No Nexus restore test has run yet.' });
      rmSync(flint('backup-age-recipient'));
      for (const line of [NEXUS_HEALTH.none, NEXUS_HEALTH.failed, NEXUS_HEALTH.age(1), NEXUS_HEALTH.age(40), NEXUS_HEALTH.offsiteNone, NEXUS_HEALTH.offsiteFailed, NEXUS_HEALTH.offsiteAge(30), NEXUS_HEALTH.drillFailed('yesterday'), NEXUS_HEALTH.drillNone, NEXUS_HEALTH.drillLate(9)]) {
        expect(noteProblems('Nexus Backup', line), line).toEqual([]);
      }
    });

    it('Restore Test and Backups are Flint’s own database’s: a Nexus dump or a failed Nexus test never shows there, nor raises their notes', async () => {
      await forget();
      await dumpAt(ago(2 * HOUR), 'tonight');
      await tested('/x/FlintBackups/nexus/nexus-tonight.dump', ago(HOUR), false);
      const got = Object.fromEntries((await row(NOW)).map((c) => [c.component, c]));
      expect(got.restore_drill).toEqual({ component: 'restore_drill', status: 'degraded', detail: 'No restore test has run yet.' });
      expect(got.backup).toEqual({ component: 'backup', status: 'down', detail: 'There’s no backup yet.' });
      expect(got.nexus_backup).toMatchObject({ status: 'down', detail: 'The last Nexus restore test failed today.' });
      const raised = await watchdog(db, config, NOW);
      expect(raised.filter((r) => r.type === 'drill.failed' || r.type === 'backup.stale')).toEqual([]);
    });

    it('the watchdog’s stale-backup rule covers it: once per last good Nexus dump, as an event and a note of its own', async () => {
      await forget();
      const stale = async (now: Date) => (await watchdog(db, config, now)).filter((r) => r.type === 'backup.stale' || r.type === 'nexus_backup.stale');
      // No dump ever: nothing to count from.
      expect(await stale(NOW)).toEqual([]);
      await dumpAt(ago(35 * HOUR), 'old');
      expect(await stale(NOW)).toEqual([]);
      const id = (await db.backupRun.findFirstOrThrow({ where: { kind: 'nexus_dump' }, select: { id: true } })).id;
      const later = new Date(NOW.getTime() + 5 * HOUR);
      expect(await stale(later)).toEqual([{ type: 'nexus_backup.stale', ref: `after:${id}`, occurredAt: later, payload: { hoursSince: 40 } }]);
      // The same last good dump is the same occurrence, however long it lasts.
      expect((await stale(new Date(later.getTime() + DAY)))[0]!.ref).toBe(`after:${id}`);
      // It counts Nexus's dumps and nothing else: a fresh backup of Flint's own database beside a stale Nexus one
      // does not hide it...
      const flintDump = (at: Date, name: string) => fileBackup(db, { kind: 'pg_dump_flint', location: 'local', path: `/x/FlintBackups/pg/flint-${name}.dump`, bytes: 1000, sha256: 'c'.repeat(64), startedAt: at });
      await flintDump(new Date(later.getTime() - HOUR), 'fresh');
      expect((await stale(later)).map((r) => r.type)).toEqual(['nexus_backup.stale']);
      // ...and a fresh Nexus dump beside a stale backup of Flint's own does not hide that one, nor is it taken for it.
      await forget();
      await flintDump(ago(35 * HOUR), 'old');
      await dumpAt(new Date(later.getTime() - HOUR), 'fresh');
      const flintId = (await db.backupRun.findFirstOrThrow({ where: { kind: 'pg_dump_flint' }, select: { id: true } })).id;
      expect(await stale(later)).toEqual([{ type: 'backup.stale', ref: `after:${flintId}`, occurredAt: later, payload: { hoursSince: 40 } }]);
      // The note it becomes: Nexus's own, critical like the rule it shares.
      const v = criticalVerdict(facts({ source: 'runtime', type: 'nexus_backup.stale', payload: { hoursSince: 40 } }));
      expect(v).toMatchObject({ action: 'escalate', critical: true, template: { id: 'nexus_backup_stale', fields: { hoursSince: 40 } } });
      expect(CRITICAL_TEMPLATES.has('nexus_backup_stale')).toBe(true);
      const said = render(v!.template!.id as TemplateId, v!.template!.fields);
      expect(said).toMatchObject({ title: 'Nexus Backups Have Stopped', body: 'The last good Nexus backup is 40 hours old.' });
      expect(noteProblems(said.title, said.body)).toEqual([]);
      // Flint's own stale backup is its own note, as it was, whatever else its event carries.
      expect(criticalVerdict(facts({ source: 'runtime', type: 'backup.stale', payload: { hoursSince: 40 } }))!.template).toEqual({ id: 'backup_stale', fields: { hoursSince: 40 } });
      expect(criticalVerdict(facts({ source: 'runtime', type: 'backup.stale', payload: { hoursSince: 40, what: 'nexus' } }))!.template!.id).toBe('backup_stale');
      // With the address unusable nothing new is dumped, so the rule still stands; switched off, it does not.
      await forget();
      await dumpAt(ago(35 * HOUR), 'old');
      writeFileSync(flint('backup.env'), `FLINT_DB_BACKUP_URL=${URLS!.backup!}\nFLINT_NEXUS_BACKUP_URL=not an address\n`, { mode: 0o600 });
      expect((await stale(later)).map((r) => r.type)).toEqual(['nexus_backup.stale']);
      off();
      expect(await stale(later)).toEqual([]);
      on();
    });

    it('Flint’s own restore criterion counts Flint’s own restore tests: a passing Nexus test, or the MacBook’s of an offsite copy, is not one', async () => {
      await forget();
      const now = new Date();
      const weeks = async () => (await p2Report(db, { tz: 'UTC', home }, now)).criteria.find((c) => c.n === 7)!.values.drillWeeks;
      expect(await weeks()).toBe(0);
      // A Nexus dump, tested and passed this week; and an offsite copy the MacBook tested.
      await dumpAt(new Date(now.getTime() - 2 * HOUR), 'tested');
      await tested('/x/FlintBackups/nexus/nexus-tested.dump', new Date(now.getTime() - HOUR), true);
      await fileBackup(db, { kind: 'pg_dump_flint', location: 'icloud', path: '/x/icloud/pg/flint-sent.dump.age', bytes: 1, sha256: 'd'.repeat(64), startedAt: new Date(now.getTime() - 2 * HOUR) });
      await tested('/x/icloud/pg/flint-sent.dump.age', new Date(now.getTime() - HOUR), true);
      expect(await weeks()).toBe(0);
      // Flint's own dump on this Mac, tested and passed: that is the one it means.
      await fileBackup(db, { kind: 'pg_dump_flint', location: 'local', path: '/x/FlintBackups/pg/flint-tested.dump', bytes: 1, sha256: 'e'.repeat(64), startedAt: new Date(now.getTime() - 2 * HOUR) });
      await tested('/x/FlintBackups/pg/flint-tested.dump', new Date(now.getTime() - HOUR), true);
      expect(await weeks()).toBe(1);
    });

    it('rolling back to an older runtime: the README’s one step clears Nexus’s test results and nothing else', async () => {
      await forget();
      const now = new Date();
      await dumpAt(new Date(now.getTime() - 2 * HOUR), 'tested');
      await tested('/x/FlintBackups/nexus/nexus-tested.dump', new Date(now.getTime() - HOUR), false);
      await fileBackup(db, { kind: 'pg_dump_flint', location: 'local', path: '/x/FlintBackups/pg/flint-tested.dump', bytes: 1, sha256: 'e'.repeat(64), startedAt: new Date(now.getTime() - 2 * HOUR) });
      await tested('/x/FlintBackups/pg/flint-tested.dump', new Date(now.getTime() - 2 * HOUR), true);
      const readme = readFileSync(join(RUNTIME, 'README.md'), 'utf8');
      const sql = /^psql -d flint -c "(UPDATE .* WHERE kind = 'nexus_dump')"$/m.exec(readme)![1]!.replace(/\\"/g, '"');
      await withClient(URLS!.owner, (c) => c.query(sql));
      const left = await db.backupRun.findMany({ orderBy: { kind: 'asc' }, select: { kind: true, restoreOk: true, restoreTestedAt: true, status: true } });
      expect(left).toEqual([
        { kind: 'nexus_dump', restoreOk: null, restoreTestedAt: null, status: 'ok' },
        { kind: 'pg_dump_flint', restoreOk: true, restoreTestedAt: expect.any(Date), status: 'ok' },
      ]);
    });
  });
});
