/**
 * Restoring Flint's database from a backup (P7, src/backup/restore.ts), against
 * a throwaway cluster of its own with a real `flint` database in it:
 *
 *  - a dump is checked before anything is restored (name, plain file, only its
 *    owner may change it, fingerprint, readable by pg_restore, counts);
 *  - restore.production restores beside the database in use, checks the copy,
 *    and only then swaps names: the old database is kept, nothing is dropped;
 *  - what was signed before the backup cannot act after it;
 *  - every refusal (not confirmed, the copy of the current database could not be
 *    taken, a failed check, a backup from a newer Flint, something still
 *    connected) leaves the production database exactly as it was;
 *  - a rebuild's restore goes only into an empty database;
 *  - the command itself is Will's: no --auto, and no answer piped in for him.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import pg from 'pg';
import { bootstrapDb } from '../src/backup/bootstrap';
import { dumpDatabase, targetOf } from '../src/backup/backup';
import {
  RestoreRefused, VOIDED_BY_RESTORE, checkDump, migrationNames, restoreInto, restoreIntoEmpty, restoreProduction, verifyRestored, writeDumpHash,
  type ProductionRestore,
} from '../src/backup/restore';
import { restoreProductionCommand, runtimeAgent, summaryLines, terminal } from '../src/backup/restore-cli';
import type { RestoreConfig } from '../src/config';
import { MIGRATIONS, RUNTIME, id, migrationDirs, prisma } from './db';
import { GRANTS_FIXTURE, grants } from './grants';
import { enrollTestKey } from './sign';
import { NO_CLUSTER, readEnv, startScratchCluster, type ScratchCluster } from './scratch-cluster';

/** A temp directory of this file's own, removed when the file ends (these hold dumps and settings files). */
const scratch: string[] = [];
const scratchDir = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(d);
  return d;
};
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

const DIGEST = 'a'.repeat(64);
const onDb = (url: string, db: string): string => {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
};
const connect = async <T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> => {
  const t = targetOf(url);
  const c = new pg.Client({ host: t.host, port: t.port, user: t.user, password: t.password, database: t.database });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
};
const migrate = async (ownerUrl: string): Promise<void> => {
  const r = await prisma(['migrate', 'deploy'], ownerUrl);
  if (r.code !== 0) throw new Error(`prisma migrate deploy failed: ${r.stdout}${r.stderr}`);
};

describe('the command is Will’s alone', () => {
  const config = { home: '/nonexistent', tz: 'America/Chicago', ownerUrl: '', appUrl: '', dumpDir: '/nonexistent/pg', copyDir: '/nonexistent/pre', tools: { pgDump: 'x', pgRestore: 'x' }, path: '' } as RestoreConfig;
  const said: string[] = [];
  const io = { say: (l: string) => said.push(l), ask: async () => 'RESTORE', uid: 501 };

  it('there is no --auto: Flint never restores its database on its own', async () => {
    await expect(restoreProductionCommand(['--auto'], config, io)).rejects.toThrow(/never restores its database on its own/);
  });

  it('with no one at a keyboard it refuses: nothing can be piped in to answer for him', async () => {
    await expect(restoreProductionCommand([], config, { say: io.say, uid: 501 })).rejects.toThrow(RestoreRefused);
    await expect(restoreProductionCommand([], config, { say: io.say, uid: 501 })).rejects.toThrow(/Run this yourself in Terminal/);
    // A pipe is not a terminal, at either end.
    const pipe = { isTTY: false } as NodeJS.ReadStream;
    const tty = { isTTY: true } as NodeJS.ReadStream;
    expect(terminal(pipe, tty as unknown as NodeJS.WriteStream)).toBeUndefined();
    expect(terminal(tty, pipe as unknown as NodeJS.WriteStream)).toBeUndefined();
    expect(terminal(tty, tty as unknown as NodeJS.WriteStream)).toBeTypeOf('function');
  });

  it('it takes --dump <file>, --without-copy and --check, and nothing else', async () => {
    for (const bad of [['--yes'], ['--force'], ['stray'], ['--dump'], ['--dump', '--without-copy'], ['--check', '--now']]) {
      await expect(restoreProductionCommand(bad, config, io), bad.join(' ')).rejects.toThrow(/only options/);
    }
  });

  it('what Will reads before he types RESTORE is whole sentences, and names where the old database goes', () => {
    const now = new Date('2026-10-12T15:00:00Z');
    const lines = summaryLines({ name: 'flint-x.dump', takenAt: new Date('2026-10-12T07:15:00Z'), bytes: 1, tables: 31, fingerprint: 'matches', database: 'flint', keptAs: 'flint_damaged_20261012t150000z' }, 'America/Chicago', now);
    expect(lines[0]).toBe('The backup is from Monday, October 12 at 2:15 AM. It is 8 hours old.');
    expect(lines.join(' ')).toContain('flint_damaged_20261012t150000z');
    for (const l of lines) expect(l, l).toMatch(/^[A-Z].*\.$/);
    const none = summaryLines({ name: 'x', takenAt: now, bytes: 1, tables: 3, fingerprint: 'none', database: 'flint', keptAs: 'k' }, 'UTC', now);
    expect(none[0]).toMatch(/less than an hour old/);
    expect(none[1]).toMatch(/No fingerprint was saved/);
  });

  it('the runtime is stopped and started through launchctl with fixed arguments', async () => {
    const home = scratchDir('flint-agent-');
    mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true });
    writeFileSync(join(home, 'Library', 'LaunchAgents', 'com.flint.runtime.plist'), '');
    const calls: string[][] = [];
    let loaded = true;
    const exec = async (bin: string, args: string[]) => {
      calls.push([bin, ...args]);
      if (args[0] === 'print') {
        if (!loaded) throw new Error('not loaded');
        return '';
      }
      if (args[0] === 'bootout') loaded = false;
      if (args[0] === 'bootstrap') loaded = true;
      return '';
    };
    const agent = runtimeAgent(home, 501, exec, async () => {});
    await agent.stop();
    expect(calls).toEqual([
      ['/bin/launchctl', 'print', 'gui/501/com.flint.runtime'],
      ['/bin/launchctl', 'bootout', 'gui/501/com.flint.runtime'],
      ['/bin/launchctl', 'print', 'gui/501/com.flint.runtime'],
    ]);
    calls.length = 0;
    await agent.start();
    expect(calls).toEqual([
      ['/bin/launchctl', 'print', 'gui/501/com.flint.runtime'],
      ['/bin/launchctl', 'bootstrap', 'gui/501', join(home, 'Library', 'LaunchAgents', 'com.flint.runtime.plist')],
    ]);
    // Already stopped: nothing to boot out. Never stops: the swap does not happen.
    calls.length = 0;
    loaded = false;
    await agent.stop();
    expect(calls).toHaveLength(1);
    const stuck = runtimeAgent(home, 501, async (_b, a) => (a[0] === 'print' ? '' : ''), async () => {});
    await expect(stuck.stop()).rejects.toThrow(/did not stop/);
  });
});

describe.skipIf(NO_CLUSTER)('restore (a throwaway cluster)', () => {
  let cluster: ScratchCluster;
  let home: string;
  let urls: { owner: string; app: string; approver: string; backup: string };
  let dumpDir: string;
  let copyDir: string;
  let dump = '';
  let ids: { pending: string; approved: string; executing: string; executed: string };
  let n = 0;

  /** A pending proposal, as the runtime would create it. */
  const proposal = async (app: string, pid = id('prop')): Promise<string> => {
    await connect(app, (c) =>
      c.query(
        `INSERT INTO "Proposal" (id, kind, origin, action, args, "argsDigest", "argsProvenance", "expiresAt")
         VALUES ($1, 'tool_call', 'console', 'world.sync.github', '{"a":1}', $2, '{}', now() + interval '1 hour')`,
        [pid, DIGEST],
      ),
    );
    return pid;
  };
  const statusOf = (owner: string, pid: string) =>
    connect(owner, async (c) => (await c.query<{ status: string; error: string | null }>('SELECT status, error FROM "Proposal" WHERE id = $1', [pid])).rows[0]);
  const databases = () => connect(urls.owner, async (c) => (await c.query<{ datname: string }>(`SELECT datname FROM pg_database WHERE datname LIKE 'flint%' ORDER BY 1`)).rows.map((r) => r.datname));

  /** A production database of its own for one scenario: the dump restored under `name`, plus one row made "after the backup". */
  const production = async (from = dump): Promise<{ name: string; owner: string; app: string; backup: string; marker: string }> => {
    const name = `flint_s${++n}`;
    await connect(onDb(urls.owner, 'postgres'), (c) => c.query(`CREATE DATABASE ${name}`));
    await restoreInto(from, targetOf(onDb(urls.owner, name)), cluster.tools);
    const marker = await proposal(onDb(urls.app, name), id('after'));
    return { name, owner: onDb(urls.owner, name), app: onDb(urls.app, name), backup: onDb(urls.backup, name), marker };
  };

  const calls: string[] = [];
  const said: string[] = [];
  const options = (p: { owner: string; app: string; backup: string }, over: Partial<ProductionRestore> = {}): ProductionRestore => ({
    dump,
    owner: p.owner,
    app: p.app,
    backup: p.backup,
    copyDir,
    tools: cluster.tools,
    migrationsDir: MIGRATIONS,
    migrate,
    confirm: async () => true,
    stopRuntime: async () => void calls.push('stop'),
    startRuntime: async () => void calls.push('start'),
    say: (l) => said.push(l),
    drainMs: 20_000,
    ...over,
  });

  beforeAll(async () => {
    cluster = await startScratchCluster();
    home = scratchDir('flint-restore-');
    dumpDir = join(home, 'FlintBackups', 'pg');
    copyDir = join(home, 'FlintBackups', 'pre-restore');
    await bootstrapDb({ admin: cluster.admin, port: cluster.port, home });
    const env = readEnv(join(home, '.flint', 'secrets.env'));
    urls = { owner: env.FLINT_DB_OWNER_URL!, app: env.FLINT_DB_URL!, approver: env.FLINT_DB_APPROVER_URL!, backup: env.FLINT_DB_BACKUP_URL! };
    await migrate(urls.owner);

    // What the database held when the backup was taken: one card of each kind, and one approval not yet used.
    const key = await enrollTestKey({ owner: urls.owner, app: urls.app, approver: urls.approver });
    const approve = async (pid: string) => {
      const approvalId = await key.approve({ subjectId: pid, action: 'world.sync.github', argsDigest: DIGEST });
      await connect(urls.app, (c) => c.query(`UPDATE "Proposal" SET status = 'approved', "approvalId" = $2 WHERE id = $1`, [pid, approvalId]));
    };
    ids = { pending: await proposal(urls.app), approved: await proposal(urls.app), executing: await proposal(urls.app), executed: await proposal(urls.app) };
    await approve(ids.approved);
    await approve(ids.executing);
    await approve(ids.executed);
    await connect(urls.app, async (c) => {
      await c.query(`UPDATE "Proposal" SET status = 'executing' WHERE id = ANY($1)`, [[ids.executing, ids.executed]]);
      await c.query(`UPDATE "Proposal" SET status = 'executed', "executedAt" = now(), result = '{}' WHERE id = $1`, [ids.executed]);
    });
    await key.approve({ subjectId: ids.pending, action: 'world.sync.github', argsDigest: DIGEST }); // signed, not yet used

    const d = await dumpDatabase(urls.backup, dumpDir, cluster.tools, new Date('2026-10-12T07:15:00.123Z'));
    writeDumpHash(d.path, d.sha256);
    dump = d.path;
    // ...and one thing that happened after it, which a restore leaves out.
    await proposal(urls.app, 'afterbackup');
  });
  afterAll(() => cluster?.stop());

  describe('a dump is checked before anything is restored', () => {
    const copyOf = (name = 'flint-2026-10-11T07-15-00-000Z.dump', withHash = true) => {
      const dir = scratchDir('flint-dump-');
      const to = join(dir, name);
      cpSync(dump, to);
      chmodSync(to, 0o600);
      cpSync(`${dump}.counts.json`, `${to}.counts.json`);
      if (withHash) cpSync(`${dump}.sha256`, `${to}.sha256`);
      return to;
    };

    it('a whole dump passes, and says when it was taken and that it is unchanged', async () => {
      const c = await checkDump(dump, cluster.tools);
      expect(c.fingerprint).toBe('matches');
      expect(c.takenAt.toISOString()).toBe('2026-10-12T07:15:00.123Z');
      expect(c.sha256).toBe(readFileSync(`${dump}.sha256`, 'utf8').trim());
      expect(Object.keys(c.counts!)).toContain('public."Proposal"');
      expect(c.counts!['public."Proposal"']).toBe(4);
    });

    it('refuses a file that is not a nightly dump, is missing, is a link, or that others may write', async () => {
      await expect(checkDump('flint-2026-10-11T07-15-00-000Z.dump', cluster.tools)).rejects.toThrow(/full path/);
      await expect(checkDump(copyOf('other.dump'), cluster.tools)).rejects.toThrow(/not one of Flint's nightly/);
      await expect(checkDump(copyOf('flint-2026-13-45T99-99-99-000Z.dump'), cluster.tools)).rejects.toThrow(/not one of Flint's nightly/);
      await expect(checkDump(join(dumpDir, 'flint-2026-10-01T07-15-00-000Z.dump'), cluster.tools)).rejects.toThrow(/does not exist/);
      const real = copyOf();
      const link = join(scratchDir('flint-dump-'), basename(real));
      symlinkSync(real, link);
      await expect(checkDump(link, cluster.tools)).rejects.toThrow(/not a plain file/);
      chmodSync(real, 0o664);
      await expect(checkDump(real, cluster.tools)).rejects.toThrow(/could have changed/);
    });

    it('refuses a dump that changed since it was written (its own fingerprint, or the one the database recorded)', async () => {
      const changed = copyOf();
      writeFileSync(changed, Buffer.concat([readFileSync(changed), Buffer.from('x')]), { mode: 0o600 });
      await expect(checkDump(changed, cluster.tools)).rejects.toThrow(/has changed since it was written/);
      const noSidecar = copyOf(undefined, false);
      await expect(checkDump(noSidecar, cluster.tools, { expectedSha256: 'f'.repeat(64) })).rejects.toThrow(/has changed since it was written/);
      expect((await checkDump(noSidecar, cluster.tools, { expectedSha256: readFileSync(`${dump}.sha256`, 'utf8').trim() })).fingerprint).toBe('matches');
      expect((await checkDump(noSidecar, cluster.tools)).fingerprint).toBe('none');
      writeFileSync(`${noSidecar}.sha256`, 'not a hash\n');
      await expect(checkDump(noSidecar, cluster.tools)).rejects.toThrow(/fingerprint saved with that backup is not readable/);
    });

    it('refuses a damaged or empty dump, and one without readable counts', async () => {
      const cut = copyOf(undefined, false);
      truncateSync(cut, 200);
      await expect(checkDump(cut, cluster.tools)).rejects.toThrow(/damaged/);
      truncateSync(cut, 0);
      await expect(checkDump(cut, cluster.tools)).rejects.toThrow(/empty/);
      const noCounts = copyOf();
      rmSync(`${noCounts}.counts.json`);
      await expect(checkDump(noCounts, cluster.tools)).rejects.toThrow(/no row counts/);
      expect((await checkDump(noCounts, cluster.tools, { countsOptional: true })).counts).toBeUndefined();
      for (const bad of ['not json', '[]', '{}', '{"public.\\"Proposal\\"": -1}', '{"public.x; DROP TABLE y": 1}', '{"public.\\"Proposal\\"": "4"}']) {
        writeFileSync(`${noCounts}.counts.json`, bad);
        await expect(checkDump(noCounts, cluster.tools, { countsOptional: true }), bad).rejects.toThrow(/row counts beside that backup are not readable/);
      }
    });
  });

  describe('restore.production', () => {
    it('restores beside the database in use, checks the copy, swaps the names, and keeps the old database', async () => {
      calls.length = 0;
      said.length = 0;
      const before = await databases();
      const r = await restoreProduction(options(urls, { now: new Date('2026-10-12T15:00:00Z') }));
      expect(r).toMatchObject({ database: 'flint', keptAs: 'flint_damaged_20261012t150000z', fingerprint: 'matches', pending: [], approvals: 1, proposals: 2, runtimeStarted: true });
      expect(r.tables).toBeGreaterThan(15);
      expect(calls).toEqual(['stop', 'start']);
      expect(said).toEqual(['Flint copied the current database first.', 'The backup restored and passed its checks.']);
      expect(await databases()).toEqual([...before, 'flint_damaged_20261012t150000z'].sort());

      // The production name now holds the backup: what came after it is gone from there...
      expect(await statusOf(urls.owner, 'afterbackup')).toBeUndefined();
      // ...and kept, untouched, under the other name.
      const kept = onDb(urls.owner, r.keptAs);
      expect(await statusOf(kept, 'afterbackup')).toMatchObject({ status: 'pending' });
      expect(await statusOf(kept, ids.approved)).toMatchObject({ status: 'approved' });

      // Nothing signed before the backup can act after it; what was only waiting still waits, and what had finished stays finished.
      expect(await statusOf(urls.owner, ids.approved)).toEqual({ status: 'failed', error: VOIDED_BY_RESTORE });
      expect(await statusOf(urls.owner, ids.executing)).toEqual({ status: 'failed', error: VOIDED_BY_RESTORE });
      expect(await statusOf(urls.owner, ids.pending)).toMatchObject({ status: 'pending' });
      expect(await statusOf(urls.owner, ids.executed)).toMatchObject({ status: 'executed' });
      expect(await connect(urls.owner, async (c) => (await c.query(`SELECT count(*)::int AS n FROM "Approval" WHERE "consumedAt" IS NULL`)).rows[0].n)).toBe(0);

      // Its own audit entry, written as the runtime's role: ids, hashes and numbers.
      const audit = await connect(urls.app, async (c) => (await c.query(`SELECT actor, context, kind, tier, decision, outcome, inputs FROM "AuditEntry" WHERE action = 'restore.production'`)).rows);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actor: 'will:cli', context: 'console', kind: 'action', tier: 'approval', decision: 'act', outcome: 'ok' });
      expect(audit[0].inputs).toMatchObject({ mode: 'production', sha256: r.sha256, fingerprint: 'matches', approvals: 1, proposals: 2, copied: true, keptAs: r.keptAs });

      // The copy taken first: a dump of the database as it was, 0600, with its counts and fingerprint.
      expect(r.copy).toBe(join(copyDir, 'flint-2026-10-12T15-00-00-000Z.dump'));
      expect(statSync(r.copy!).mode & 0o777).toBe(0o600);
      expect(statSync(copyDir).mode & 0o777).toBe(0o700);
      expect(existsSync(`${r.copy}.counts.json`) && existsSync(`${r.copy}.sha256`)).toBe(true);
      expect((await checkDump(r.copy!, cluster.tools)).counts!['public."Proposal"']).toBe(5);
    });

    it('the restored database has exactly the reviewed grants, owned by the migration owner', async () => {
      expect(await grants(urls.owner)).toEqual(JSON.parse(readFileSync(GRANTS_FIXTURE, 'utf8')));
      const v = await verifyRestored(targetOf(urls.owner), undefined, MIGRATIONS);
      expect(v).toMatchObject({ ok: true, problems: [] });
      expect(v.migrations).toEqual({ applied: migrationNames(MIGRATIONS), pending: [], unknown: [], unfinished: [] });
      expect(migrationNames(MIGRATIONS)).toEqual(migrationDirs());
      // The runtime's role can do its work in it, and no more than its work.
      await proposal(urls.app);
      await expect(connect(urls.app, (c) => c.query(`DELETE FROM "AuditEntry"`))).rejects.toThrow(/permission denied/);
      await expect(connect(urls.app, (c) => c.query(`CREATE TEMP TABLE t (id integer)`))).rejects.toThrow(/permission denied/);
    });

    it('a trial run (--check) restores and checks beside the database in use, then drops the copy: nothing changes and nothing is asked', async () => {
      const p = await production();
      calls.length = 0;
      said.length = 0;
      const before = await databases();
      const copies = readdirSync(copyDir).length;
      let asked = false;
      const r = await restoreProduction(options(p, { checkOnly: true, confirm: async () => { asked = true; return false; }, now: new Date('2026-10-12T15:00:30Z') }));
      expect(r).toMatchObject({ checkedOnly: true, fingerprint: 'matches', pending: [] });
      expect(r.tables).toBeGreaterThan(15);
      expect(r.copy).toBeUndefined();
      expect(asked).toBe(false);
      expect(calls).toEqual([]);
      expect(said).toEqual([]);
      expect(await databases()).toEqual(before);
      expect(readdirSync(copyDir)).toHaveLength(copies);
      // The database in use is exactly as it was: what came after the backup is still there, and nothing signed was voided.
      expect(await statusOf(p.owner, p.marker)).toMatchObject({ status: 'pending' });
      expect(await statusOf(p.owner, ids.approved)).toMatchObject({ status: 'approved' });
      expect(await connect(p.owner, async (c) => (await c.query(`SELECT count(*)::int AS n FROM "AuditEntry" WHERE action = 'restore.production'`)).rows[0].n)).toBe(0);
      // A backup that would not pass is caught by the trial too.
      await expect(restoreProduction(options(p, { checkOnly: true, migrationsDir: scratchDir('flint-migrations-'), now: new Date('2026-10-12T15:00:40Z') }))).rejects.toThrow(/did not pass its checks/);
      expect(await databases()).toEqual(before);
    });

    it('a runtime that will not start again afterwards is reported, and the restore stands', async () => {
      const p = await production();
      const r = await restoreProduction(options(p, { now: new Date('2026-10-12T15:00:45Z'), startRuntime: async () => { throw new Error('launchctl bootstrap failed'); } }));
      expect(r.runtimeStarted).toBe(false);
      expect(await statusOf(p.owner, p.marker)).toBeUndefined();
      expect(await statusOf(onDb(urls.owner, r.keptAs), p.marker)).toMatchObject({ status: 'pending' });
    });

    it('a runtime that will not stop: the copy is dropped and nothing is changed', async () => {
      const p = await production();
      calls.length = 0;
      const before = await databases();
      await expect(restoreProduction(options(p, { now: new Date('2026-10-12T15:00:50Z'), stopRuntime: async () => { calls.push('stop'); throw new RestoreRefused('The runtime did not stop, so Flint did not swap the databases.'); } })))
        .rejects.toThrow('The runtime did not stop, so Flint did not swap the databases. Nothing was changed.');
      expect(calls).toEqual(['stop', 'start']);
      expect(await databases()).toEqual(before);
      expect(await statusOf(p.owner, p.marker)).toMatchObject({ status: 'pending' });
    });

    it('not confirmed: nothing is changed, and the runtime is never stopped', async () => {
      const p = await production();
      calls.length = 0;
      const before = await databases();
      const copies = readdirSync(copyDir).length;
      await expect(restoreProduction(options(p, { confirm: async () => false }))).rejects.toThrow('Nothing was changed.');
      expect(calls).toEqual([]);
      expect(await databases()).toEqual(before);
      expect(await statusOf(p.owner, p.marker)).toMatchObject({ status: 'pending' });
      // Not even the copy of the current database is taken before he says yes.
      expect(readdirSync(copyDir)).toHaveLength(copies);
    });

    it('a copy of the current database that cannot be taken stops it, unless Will said to go on without', async () => {
      const p = await production();
      calls.length = 0;
      const badBackup = (() => {
        const u = new URL(p.backup);
        u.password = 'wrong';
        return u.toString();
      })();
      const before = await databases();
      await expect(restoreProduction(options(p, { backup: badBackup, now: new Date('2026-10-12T15:01:00Z') }))).rejects.toThrow(/could not copy the current database first, so it stopped. Nothing was changed/);
      await expect(restoreProduction(options({ ...p, backup: undefined as unknown as string }, { now: new Date('2026-10-12T15:01:30Z') }))).rejects.toThrow(/no way to copy the current database first/);
      expect(calls).toEqual([]);
      expect(await databases()).toEqual(before);
      expect(await statusOf(p.owner, p.marker)).toMatchObject({ status: 'pending' });

      said.length = 0;
      const r = await restoreProduction(options(p, { backup: badBackup, withoutCopy: true, now: new Date('2026-10-12T15:02:00Z') }));
      expect(r.copy).toBeUndefined();
      expect(said[0]).toMatch(/could not copy the current database first. It is kept under another name all the same/);
      expect(await statusOf(p.owner, p.marker)).toBeUndefined();
      expect(await statusOf(onDb(urls.owner, r.keptAs), p.marker)).toMatchObject({ status: 'pending' });
    });

    it('a restored copy that fails its checks is dropped, and the original is left in place', async () => {
      const p = await production();
      const dir = scratchDir('flint-dump-');
      const off = join(dir, basename(dump));
      cpSync(dump, off);
      chmodSync(off, 0o600);
      cpSync(`${dump}.sha256`, `${off}.sha256`);
      const counts = JSON.parse(readFileSync(`${dump}.counts.json`, 'utf8')) as Record<string, number>;
      counts['public."Proposal"'] = counts['public."Proposal"']! + 1;
      writeFileSync(`${off}.counts.json`, JSON.stringify(counts));
      calls.length = 0;
      const before = await databases();
      await expect(restoreProduction(options(p, { dump: off, now: new Date('2026-10-12T15:03:00Z') }))).rejects.toThrow(/did not pass its checks: row counts differ in 1 table\(s\)\. Nothing was changed\./);
      expect(calls).toEqual([]);
      expect(await databases()).toEqual(before);
      expect(await statusOf(p.owner, p.marker)).toMatchObject({ status: 'pending' });
    });

    it('a backup from a newer Flint than this copy of the code is refused', async () => {
      const p = await production();
      const older = scratchDir('flint-migrations-');
      for (const d of migrationDirs().slice(0, -1)) mkdirSync(join(older, d));
      const before = await databases();
      await expect(restoreProduction(options(p, { migrationsDir: older, now: new Date('2026-10-12T15:04:00Z') }))).rejects.toThrow(/from a newer Flint than this copy of the code.*Nothing was changed/);
      expect(await databases()).toEqual(before);
      expect(await statusOf(p.owner, p.marker)).toMatchObject({ status: 'pending' });
    });

    it('a backup from before a database update is brought up to date before it goes live', async () => {
      // A database one migration behind: the newest migration's own down.sql, then a dump of that.
      const old = await production();
      const newest = migrationDirs().at(-1)!;
      await connect(old.owner, (c) => c.query(readFileSync(join(MIGRATIONS, newest, 'down.sql'), 'utf8')));
      const olderDumps = join(home, 'older');
      const d = await dumpDatabase(old.backup, olderDumps, cluster.tools, new Date('2026-10-10T07:15:00.000Z'));
      writeDumpHash(d.path, d.sha256);

      const p = await production();
      const r = await restoreProduction(options(p, { dump: d.path, now: new Date('2026-10-12T15:05:00Z') }));
      expect(r.pending).toEqual([newest]);
      const v = await verifyRestored(targetOf(p.owner), undefined, MIGRATIONS);
      expect(v.ok).toBe(true);
      expect(v.migrations.pending).toEqual([]);
      // A failing update leaves the original in place.
      const q = await production();
      const before = await databases();
      await expect(restoreProduction(options(q, { dump: d.path, now: new Date('2026-10-12T15:06:00Z'), migrate: async () => { throw new Error('a database update failed (P3018)'); } }))).rejects.toThrow(/could not be restored \(a database update failed \(P3018\)\)\. Nothing was changed/);
      expect(await databases()).toEqual(before);
      expect(await statusOf(q.owner, q.marker)).toMatchObject({ status: 'pending' });
    });

    it('something still connected: it stops, puts everything back, and starts the runtime again', async () => {
      const p = await production();
      calls.length = 0;
      const before = await databases();
      const t = targetOf(p.app);
      const held = new pg.Client({ host: t.host, port: t.port, user: t.user, password: t.password, database: t.database });
      await held.connect();
      try {
        await expect(restoreProduction(options(p, { drainMs: 1500, now: new Date('2026-10-12T15:07:00Z') }))).rejects.toThrow(/Something is still using the database, so Flint stopped\..*Nothing was changed\./);
      } finally {
        await held.end();
      }
      expect(calls).toEqual(['stop', 'start']);
      expect(await databases()).toEqual(before);
      // The database takes connections again, and still holds what it held.
      expect(await statusOf(p.owner, p.marker)).toMatchObject({ status: 'pending' });
      expect(await connect(p.app, async (c) => (await c.query('SELECT 1 AS one')).rows[0].one)).toBe(1);
    });

    it('refuses when there is no such database to replace, and when this second’s names are taken', async () => {
      await expect(restoreProduction(options({ owner: onDb(urls.owner, 'flint_nowhere'), app: onDb(urls.app, 'flint_nowhere'), backup: urls.backup }))).rejects.toThrow(/no production database to replace/);
      const p = await production();
      const now = new Date('2026-10-12T15:08:00Z');
      await connect(onDb(urls.owner, 'postgres'), (c) => c.query(`CREATE DATABASE ${p.name}_damaged_20261012t150800z`));
      await expect(restoreProduction(options(p, { now }))).rejects.toThrow(/already there/);
      await expect(restoreProduction(options({ ...p, owner: onDb(p.owner, 'Bad-Name') }))).rejects.toThrow(/not one Flint can rename/);
    });
  });

  describe('a rebuild restores only into an empty database', () => {
    it('restores, checks, sets signed work aside and writes its audit entry; then refuses the same database, now full', async () => {
      await connect(onDb(urls.owner, 'postgres'), (c) => c.query('CREATE DATABASE flint_fresh'));
      const o = { dump, owner: onDb(urls.owner, 'flint_fresh'), app: onDb(urls.app, 'flint_fresh'), tools: cluster.tools, migrationsDir: MIGRATIONS };
      const r = await restoreIntoEmpty(o);
      expect(r).toMatchObject({ fingerprint: 'matches', pending: [], approvals: 1, proposals: 2 });
      expect(r.tables).toBeGreaterThan(15);
      expect(await statusOf(o.owner, ids.approved)).toEqual({ status: 'failed', error: VOIDED_BY_RESTORE });
      expect(await connect(o.app, async (c) => (await c.query(`SELECT inputs->>'mode' AS mode FROM "AuditEntry" WHERE action = 'restore.production'`)).rows)).toEqual([{ mode: 'rebuild' }]);
      expect(await grants(o.owner)).toEqual(JSON.parse(readFileSync(GRANTS_FIXTURE, 'utf8')));
      // Run again with the same backup (a rebuild that stopped later and was restarted): nothing is done, and it says so.
      const again = await restoreIntoEmpty(o);
      expect(again).toMatchObject({ already: true, approvals: 0, proposals: 0 });
      expect(await connect(o.app, async (c) => (await c.query(`SELECT count(*)::int AS n FROM "AuditEntry" WHERE action = 'restore.production'`)).rows[0].n)).toBe(1);
      // Any other backup into a database that is not empty is refused.
      const other = join(scratchDir('flint-dump-'), 'flint-2026-10-09T07-15-00-000Z.dump');
      writeFileSync(other, Buffer.concat([readFileSync(dump), Buffer.from('\n')]), { mode: 0o600 });
      await expect(restoreIntoEmpty({ ...o, dump: other })).rejects.toThrow(/not empty/);
    });

    it('an offsite copy that came without its counts still restores, and says its sizes were not compared', async () => {
      const dir = scratchDir('flint-dump-');
      const bare = join(dir, basename(dump));
      cpSync(dump, bare);
      chmodSync(bare, 0o600);
      await connect(onDb(urls.owner, 'postgres'), (c) => c.query('CREATE DATABASE flint_bare'));
      const r = await restoreIntoEmpty({ dump: bare, owner: onDb(urls.owner, 'flint_bare'), app: onDb(urls.app, 'flint_bare'), tools: cluster.tools, migrationsDir: MIGRATIONS });
      expect(r).toMatchObject({ tables: 0, fingerprint: 'none' });
    });
  });

  describe('the commands, as they are run', () => {
    const cli = (args: string[], env: Record<string, string>) =>
      spawnSync(join(RUNTIME, 'node_modules', '.bin', 'tsx'), ['src/cli.ts', ...args], {
        cwd: RUNTIME, encoding: 'utf8', input: 'RESTORE\n',
        env: { PATH: process.env.PATH ?? '', HOME: home, ...env },
      });

    it('restore-production --check runs with no one at the keyboard, changes nothing, and says how long a restore takes', async () => {
      const before = await databases();
      const r = cli(['restore-production', '--check', '--dump', basename(dump)], {});
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      const lines = r.stdout.trim().split('\n');
      expect(lines[0]).toMatch(new RegExp(`^The backup ${basename(dump).replace(/\./g, '\\.')} restores and passes every check\\. A real restore would take about \\d+ seconds?\\.$`));
      expect(lines[1]).toBe('This was a trial run. Nothing was changed.');
      expect(await databases()).toEqual(before);
    });

    it('restore-production with RESTORE piped in refuses, prints one sentence, and changes nothing', async () => {
      const before = await databases();
      const r = cli(['restore-production'], {});
      expect(r.status).toBe(1);
      expect(r.stdout.trim()).toBe('Run this yourself in Terminal: it asks you to confirm before it changes anything.');
      expect(r.stderr).toBe('');
      expect(await databases()).toEqual(before);
    });

    it('restore-empty restores into an empty database named by the settings files, and never prints a URL or a password', async () => {
      await connect(onDb(urls.owner, 'postgres'), (c) => c.query('CREATE DATABASE flint_cli'));
      const r = cli(['restore-empty', '--dump', dump], { FLINT_DB_OWNER_URL: onDb(urls.owner, 'flint_cli'), FLINT_DB_URL: onDb(urls.app, 'flint_cli') });
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      const lines = r.stdout.trim().split('\n');
      expect(lines[0]).toMatch(/^The database restored and passed its checks: \d+ tables match the backup's own counts\.$/);
      for (const l of lines) expect(l, l).toMatch(/^[A-Z].*\.$/);
      for (const secret of [targetOf(urls.owner).password, targetOf(urls.app).password, 'postgresql://']) expect(r.stdout.includes(secret)).toBe(false);
      const again = cli(['restore-empty', '--dump', dump], { FLINT_DB_OWNER_URL: onDb(urls.owner, 'flint_cli'), FLINT_DB_URL: onDb(urls.app, 'flint_cli') });
      expect(again.status).toBe(0);
      expect(again.stdout.trim()).toBe('The database already holds this backup from an earlier run, and it passes its checks.');
      // A database that holds something else is refused in one sentence.
      await connect(onDb(urls.owner, 'postgres'), (c) => c.query('CREATE DATABASE flint_other'));
      await connect(onDb(urls.owner, 'flint_other'), (c) => c.query('CREATE TABLE something (id integer)'));
      const refused = cli(['restore-empty', '--dump', dump], { FLINT_DB_OWNER_URL: onDb(urls.owner, 'flint_other'), FLINT_DB_URL: onDb(urls.app, 'flint_other') });
      expect(refused.status).toBe(1);
      expect(refused.stdout.trim()).toBe('The database to restore into is not empty.');
    });

    it('a settings file that names another machine’s database is refused by name, never by value', () => {
      const r = cli(['restore-empty', '--dump', dump], { FLINT_DB_OWNER_URL: 'postgresql://flint_owner:hunter2@db.example.com:5432/flint' });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/restore config is invalid: FLINT_DB_OWNER_URL: must be a database on this Mac/);
      expect(r.stdout + r.stderr).not.toContain('hunter2');
    });
  });
});
