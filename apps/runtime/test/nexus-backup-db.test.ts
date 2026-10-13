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
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { noteProblems } from '@flint/policy';
import { NO_DB, URLS, freshDb, withClient } from './db';
import { enrollTestKey } from './sign';
import { createDb, type Db } from '../src/db';
import { loadConfig, nexusBackupWanted, type Config } from '../src/config';
import { FLINT_SET, NEXUS_SET, NotReadOnly, canWrite, checkedSet, client, countRows, dumpDatabase, needsSetup, newestDump, pruneDumps, pruneOffsite, restoreDrill, targetOf, type BackupSet, type Tools } from '../src/backup/backup';
import { NEXUS_OFF, nexusHelp, nexusSetup, nexusSetupArgs } from '../src/backup/nexus';
import { fileBackup, fileFailure } from '../src/backup/record';
import { checkDump, RestoreRefused } from '../src/backup/restore';
import { ACTION, STEP, forNexus, gate } from '../src/backup/nightly';
import { approveProposal, createProposal } from '../src/governance/proposals';
import { runInternal } from '../src/governance/internal';
import { NEXUS_HEALTH, checkComponents } from '../src/health/checks';
import { watchdog } from '../src/health/watchdog';
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
    expect(NEXUS_SET).toEqual({ prefix: 'nexus', schemas: ['public'], scratch: 'nexus_restore_test', kind: 'nexus_dump', readOnly: true });
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
      [new NotReadOnly(), /^The login in the Nexus address could change Nexus, so Flint backed nothing up\.$/],
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
      'The first lets that login connect to Nexus. The second lets it read every table there and change none.',
    ]);
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
    // A login that could write is a setup problem, never "tries again tonight"; the scratch database missing is not.
    expect(needsSetup(new NotReadOnly())).toBe(true);
    expect(needsSetup(new Error('database "nexus_restore_test" does not exist'))).toBe(false);
    expect(needsSetup(new Error('database "nexus" does not exist'))).toBe(true);
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
        await c.query(`DROP DATABASE IF EXISTS ${SET.scratch}`).catch(() => {});
        await c.query(`DROP DATABASE IF EXISTS ${NEXUS_SET.scratch}`).catch(() => {});
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
      try {
        const r = await restoreDrill(dump, URLS!.restore!, tools, SET);
        expect(r).toEqual({ ok: true, tables: 2, mismatches: [] });
        expect(await databases(`${SET.scratch}%`)).toEqual([]);
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
        'Flint’s backup login could change the Nexus database, so Flint will not use it there. Nothing was changed.',
        'Take away what lets it write in Nexus, then run this again.',
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
        'Flint can read the Nexus database and cannot change it.',
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
      expect(ran.out).toMatch(/^backup\.nexus: ok \{"bytes":\d+,"sha256":"[0-9a-f]{64}","tables":2,"pruned":0\}\n$/);
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
      const byHand = cli(['nexus-backup']);
      expect(byHand.status).toBe(0);
      expect(await cards('backup.nexus')).toHaveLength(1);
      expect(await rows({ location: 'local' })).toHaveLength(2);
      expect(await db.auditEntry.findFirst({ where: { action: 'backup.nexus', kind: 'action' }, orderBy: { seq: 'desc' }, select: { actor: true, context: true, outcome: true, correlationId: true } }))
        .toEqual({ actor: 'will:cli', context: 'console', outcome: 'ok', correlationId: null });
      noSecrets(byHand);
    });

    it('`nexus-drill`: the newest dump restored into the scratch database and compared; the result is on that dump’s record', async () => {
      const r = cli(['nexus-drill']);
      expect(r.err).toBe('');
      expect(r).toMatchObject({ status: 0, out: 'restore.drill.nexus: ok {"tables":2,"mismatches":0}\n' });
      const local = await rows({ location: 'local' });
      expect(local.map((x) => x.restoreOk)).toEqual([null, true]);
      expect(await databases('nexus_restore_test')).toEqual([]);
      // The fixture is as it was.
      expect(await count('"MemoryEntry"')).toBe(ROWS['"MemoryEntry"']);
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
      // Its list of copies is its own, beside its own dumps; Flint's own offsite folder and list were not made.
      expect(readFileSync(join(dumps(), 'offsite-copies.txt'), 'utf8')).toBe(`${basename(newest)}.age\n`);
      expect(existsSync(join(home, 'offsite', 'pg')) || existsSync(join(home, 'FlintBackups', 'pg'))).toBe(false);
      expect(readdirSync(join(home, 'offsite'))).toEqual(['nexus']);
    });

    it('an address that is not a database on this Mac stops Nexus’s backup with why, and never Flint’s own', async () => {
      const secret = 'hunter2-not-shown';
      writeEnv({ ...base(), FLINT_NEXUS_BACKUP_URL: `postgresql://flint_backup:${secret}@db.example.com:5432/nexus` });
      const before = (await rows()).length;
      const r = cli(['nexus-backup']);
      expect(r.status).toBe(1);
      expect(r.lines).toEqual([
        'backup.nexus: FAILED: FLINT_NEXUS_BACKUP_URL must be a database on this Mac {}',
        'Flint did not back Nexus up: the address set for it must be a database on this Mac.',
        'Set it again with this command:',
        '  cd ~/flint && pnpm --filter @flint/runtime nexus-setup',
      ]);
      expect(`${r.out}${r.err}`).not.toMatch(new RegExp(`${secret}|example\\.com`));
      // The failed run is on record (Health says it at once), with nothing dumped.
      const failed = await rows({ status: 'failed', location: 'local' });
      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatchObject({ location: 'local', encrypted: false, bytes: null });
      expect(await rows()).toHaveLength(before + 1);
      // Flint's own backup reads the same file, and is not stopped by it.
      const own = cli(['backup']);
      expect(own.err).toBe('');
      expect(own.status).toBe(0);
      expect(own.out).toMatch(/^backup\.local: ok /);
      expect(`${own.out}${own.err}`).not.toContain(secret);
    });

    it('a login that could change Nexus, and a database that is not there, are refused with what to run', async () => {
      writeEnv({ ...base(), FLINT_NEXUS_BACKUP_URL: ownerUrl });
      const files = readdirSync(dumps()).length;
      const writes = cli(['nexus-backup']);
      expect(writes.status).toBe(1);
      expect(writes.lines).toEqual([
        'backup.nexus: FAILED: the login that reads this database could also change it, so nothing was backed up {}',
        'The login in the Nexus address could change Nexus, so Flint backed nothing up.',
        'Flint reads Nexus only through a login that can change nothing there. Set the address again with this command:',
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
          'The first lets that login connect to Nexus. The second lets it read every table there and change none.',
        ]);
        noSecrets(shut);
        // The first of them, run by the fixture's owner, is all it takes.
        await asOwner((c) => c.query(`GRANT CONNECT ON DATABASE ${fixture} TO flint_backup`));
        expect(cli(['nexus-backup']).status).toBe(0);
      } finally {
        await asOwner((c) => c.query(`GRANT CONNECT ON DATABASE ${fixture} TO PUBLIC`));
      }
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
        expect((await watchdog(db, config, NOW)).filter((r) => r.ref.startsWith('nexus:'))).toEqual([]);
      }
      expect(nexusBackupWanted(home)).toBe(false);
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

    it('the watchdog’s stale-backup rule covers it: once per last good dump, with a note of its own', async () => {
      await forget();
      const stale = async (now: Date) => (await watchdog(db, config, now)).filter((r) => r.type === 'backup.stale');
      // No dump ever: nothing to count from.
      expect(await stale(NOW)).toEqual([]);
      await dumpAt(ago(35 * HOUR), 'old');
      expect(await stale(NOW)).toEqual([]);
      const id = (await db.backupRun.findFirstOrThrow({ where: { kind: 'nexus_dump' }, select: { id: true } })).id;
      const later = new Date(NOW.getTime() + 5 * HOUR);
      expect(await stale(later)).toEqual([{ type: 'backup.stale', ref: `nexus:after:${id}`, occurredAt: later, payload: { hoursSince: 40, what: 'nexus' } }]);
      // The same last good dump is the same occurrence, however long it lasts.
      expect((await stale(new Date(later.getTime() + DAY)))[0]!.ref).toBe(`nexus:after:${id}`);
      // The note it becomes: Nexus's own, critical like the rule it shares.
      const v = criticalVerdict(facts({ source: 'runtime', type: 'backup.stale', payload: { hoursSince: 40, what: 'nexus' } }));
      expect(v).toMatchObject({ action: 'escalate', critical: true, template: { id: 'nexus_backup_stale', fields: { hoursSince: 40 } } });
      expect(CRITICAL_TEMPLATES.has('nexus_backup_stale')).toBe(true);
      const said = render(v!.template!.id as TemplateId, v!.template!.fields);
      expect(said).toMatchObject({ title: 'Nexus Backups Have Stopped', body: 'The last good Nexus backup is 40 hours old.' });
      expect(noteProblems(said.title, said.body)).toEqual([]);
      // Flint's own stale backup is still its own note, whatever else the event carries.
      expect(criticalVerdict(facts({ source: 'runtime', type: 'backup.stale', payload: { hoursSince: 40 } }))!.template).toEqual({ id: 'backup_stale', fields: { hoursSince: 40 } });
      expect(criticalVerdict(facts({ source: 'runtime', type: 'backup.stale', payload: { hoursSince: 40, what: 'database' } }))!.template!.id).toBe('backup_stale');
      // A fresh dump ends it.
      await dumpAt(new Date(later.getTime() - HOUR), 'fresh');
      expect(await stale(later)).toEqual([]);
    });
  });
});
