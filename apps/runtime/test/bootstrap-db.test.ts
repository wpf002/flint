/**
 * Flint's database roles and databases on a rebuilt Mac (P7,
 * src/backup/bootstrap.ts), against a throwaway cluster of its own: the five
 * roles and their limits, fresh passwords that reach only the two 0600 files
 * (never a statement, so never the server's log), a refusal on a machine that
 * already has a Flint, and `rotate` as the explicit way past it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { BootstrapRefused, DATABASES, ROLES, bootstrapDb, scramVerifier, stageEnv, upsertEnv } from '../src/backup/bootstrap';
import { targetOf } from '../src/backup/backup';
import { NO_CLUSTER, RUNTIME, readEnv, startScratchCluster, type ScratchCluster } from './scratch-cluster';

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
const code = async (p: Promise<unknown>): Promise<string | undefined> => p.then(() => undefined, (e: { code?: string }) => e.code ?? 'error');

describe('settings files', () => {
  it('upsertEnv replaces the named keys, keeps every other line, and leaves the file 0600', () => {
    const file = join(scratchDir('flint-env-'), '.flint', 'secrets.env');
    upsertEnv(file, { FLINT_DB_URL: 'one' });
    writeFileSync(file, '# a note\nKEEP_ME=1\nFLINT_DB_URL=old\nexport FLINT_DB_OWNER_URL=old\n', { mode: 0o644 });
    upsertEnv(file, { FLINT_DB_URL: 'new', FLINT_DB_OWNER_URL: 'owner' });
    expect(readFileSync(file, 'utf8')).toBe('# a note\nKEEP_ME=1\nFLINT_DB_URL=new\nFLINT_DB_OWNER_URL=owner\n');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(file, '..')).mode & 0o777).toBe(0o700);
    expect(() => upsertEnv(file, { 'bad name': 'x' })).toThrow(/not a setting name/);
    expect(() => upsertEnv(file, { GOOD: 'a\nINJECTED=1' })).toThrow(/line break/);
  });

  it('new contents are staged whole under a .partial name, and take the file’s name only when told to', () => {
    const file = join(scratchDir('flint-env-'), '.flint', 'backup.env');
    upsertEnv(file, { OLD: '1' });
    const staged = stageEnv(file, { NEW: '2' });
    expect(readFileSync(file, 'utf8')).toBe('OLD=1\n');
    expect(readFileSync(`${file}.partial`, 'utf8')).toBe('OLD=1\nNEW=2\n');
    expect(statSync(`${file}.partial`).mode & 0o777).toBe(0o600);
    staged.discard();
    expect(existsSync(`${file}.partial`)).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe('OLD=1\n');
    stageEnv(file, { NEW: '2' }).commit();
    expect(readFileSync(file, 'utf8')).toBe('OLD=1\nNEW=2\n');
    expect(existsSync(`${file}.partial`)).toBe(false);
  });

  it('a .partial already there is replaced only when it is plainly a leftover of Flint’s own: a link, or one others can read, is refused', () => {
    const dir = join(scratchDir('flint-env-'), '.flint');
    const file = join(dir, 'secrets.env');
    upsertEnv(file, { A: '1' });
    // Its own leftover, from a run that died: replaced.
    writeFileSync(`${file}.partial`, 'half', { mode: 0o600 });
    stageEnv(file, { B: '2' }).commit();
    expect(readFileSync(file, 'utf8')).toBe('A=1\nB=2\n');
    // A link put where the passwords would be written: refused, and what it points at is untouched.
    const elsewhere = join(dir, 'elsewhere');
    writeFileSync(elsewhere, 'theirs');
    symlinkSync(elsewhere, `${file}.partial`);
    expect(() => stageEnv(file, { C: '3' })).toThrow(BootstrapRefused);
    expect(() => stageEnv(file, { C: '3' })).toThrow(/half-written settings file that is not Flint's own is in the way \(secrets\.env\.partial\)/);
    expect(readFileSync(elsewhere, 'utf8')).toBe('theirs');
    rmSync(`${file}.partial`);
    // One others can read.
    writeFileSync(`${file}.partial`, 'loose', { mode: 0o644 });
    expect(() => stageEnv(file, { C: '3' })).toThrow(/is in the way/);
    expect(readFileSync(file, 'utf8')).toBe('A=1\nB=2\n');
  });

  it('a SCRAM verifier is the stored form of a password, never the password', () => {
    const v = scramVerifier('correct horse', Buffer.alloc(16, 7));
    expect(v).toMatch(/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    expect(v).not.toContain('correct horse');
    expect(scramVerifier('correct horse', Buffer.alloc(16, 7))).toBe(v);
    expect(scramVerifier('another', Buffer.alloc(16, 7))).not.toBe(v);
  });
});

describe.skipIf(NO_CLUSTER)('bootstrap-db (a throwaway cluster)', () => {
  let cluster: ScratchCluster;
  let home: string;
  let first: Record<string, string>;

  beforeAll(async () => {
    cluster = await startScratchCluster();
    home = scratchDir('flint-home-');
  });
  afterAll(() => cluster?.stop());

  it('makes the five roles and both databases, and writes the URLs to two 0600 files', async () => {
    const dataDir = join(home, '.flint');
    upsertEnv(join(dataDir, 'secrets.env'), { FLINT_TOKEN: 'kept' });
    const r = await bootstrapDb({ admin: cluster.admin, port: cluster.port, home });
    expect(r.created).toEqual([...ROLES]);
    expect(r.rotated).toEqual([]);
    expect(r.databases).toEqual([...DATABASES]);
    for (const f of ['secrets.env', 'backup.env']) expect(statSync(join(dataDir, f)).mode & 0o777, f).toBe(0o600);
    expect(statSync(dataDir).mode & 0o777).toBe(0o700);
    first = { ...readEnv(join(dataDir, 'secrets.env')), ...Object.fromEntries(Object.entries(readEnv(join(dataDir, 'backup.env'))).map(([k, v]) => [`backup:${k}`, v])) };
    expect(Object.keys(readEnv(join(dataDir, 'secrets.env'))).sort()).toEqual(
      ['FLINT_DB_APPROVER_URL', 'FLINT_DB_BACKUP_URL', 'FLINT_DB_OWNER_URL', 'FLINT_DB_TEST_OWNER_URL', 'FLINT_DB_TEST_URL', 'FLINT_DB_URL', 'FLINT_TOKEN'],
    );
    expect(first.FLINT_TOKEN).toBe('kept');
    expect(Object.keys(readEnv(join(dataDir, 'backup.env'))).sort()).toEqual(['FLINT_DB_BACKUP_URL', 'FLINT_DB_RESTORE_URL']);
    // Every URL names this Mac on the given port, and each role has its own password.
    const urls = Object.entries(first).filter(([k]) => k.includes('_DB_')).map(([, v]) => v);
    for (const u of urls) expect(u).toMatch(new RegExp(`^postgresql://flint_[a-z]+:[0-9a-f]{48}@\\[::1\\]:${cluster.port}/(flint|flint_test|postgres)$`));
    expect(new Set([first.FLINT_DB_URL, first.FLINT_DB_OWNER_URL, first.FLINT_DB_APPROVER_URL, first.FLINT_DB_BACKUP_URL, first['backup:FLINT_DB_RESTORE_URL']].map((u) => targetOf(u!).password)).size).toBe(5);
  });

  it('each role signs in with its new password and has exactly its powers', async () => {
    const who = await connect(first.FLINT_DB_OWNER_URL!, async (c) => {
      const roles = await c.query<{ rolname: string; rolsuper: boolean; rolcreaterole: boolean; rolcreatedb: boolean; rolbypassrls: boolean; rolreplication: boolean }>(
        `SELECT rolname, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls, rolreplication FROM pg_roles WHERE rolname LIKE 'flint\\_%' ORDER BY 1`,
      );
      const dbs = await c.query<{ datname: string; owner: string }>(`SELECT datname, pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname IN ('flint', 'flint_test') ORDER BY 1`);
      const schema = await c.query<{ owner: string }>(`SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = 'public'`);
      const reads = await c.query<{ m: boolean }>(`SELECT pg_has_role('flint_backup', 'pg_read_all_data', 'MEMBER') AS m`);
      // Who is a member of whom among Flint's own roles: only the owner, of the role that restores backups.
      const members = await c.query<{ member: string; of: string }>(
        `SELECT m.rolname AS member, r.rolname AS of FROM pg_auth_members a JOIN pg_roles r ON r.oid = a.roleid JOIN pg_roles m ON m.oid = a.member WHERE m.rolname LIKE 'flint\\_%' AND r.rolname LIKE 'flint\\_%'`,
      );
      return { roles: roles.rows, dbs: dbs.rows, schema: schema.rows[0]!.owner, reads: reads.rows[0]!.m, members: members.rows };
    });
    expect(who.roles.map((r) => r.rolname)).toEqual([...ROLES].sort());
    for (const r of who.roles) {
      expect(r, r.rolname).toMatchObject({ rolsuper: false, rolcreaterole: false, rolbypassrls: false, rolreplication: false });
      expect(r.rolcreatedb, r.rolname).toBe(r.rolname === 'flint_owner' || r.rolname === 'flint_restore');
    }
    expect(who.dbs).toEqual([{ datname: 'flint', owner: 'flint_owner' }, { datname: 'flint_test', owner: 'flint_owner' }]);
    expect(who.schema).toBe('flint_owner');
    expect(who.reads).toBe(true);
    // The migration owner can take over what the restoring role makes (restore.ts), and no role is a member of the owner.
    expect(who.members).toEqual([{ member: 'flint_owner', of: 'flint_restore' }]);
    // The others sign in too, and only the restore role (and the owner) may make a database.
    for (const key of ['FLINT_DB_URL', 'FLINT_DB_APPROVER_URL', 'FLINT_DB_BACKUP_URL', 'FLINT_DB_TEST_URL', 'FLINT_DB_TEST_OWNER_URL']) {
      expect(await connect(first[key]!, async (c) => (await c.query('SELECT 1 AS one')).rows[0].one), key).toBe(1);
    }
    expect(await code(connect(first.FLINT_DB_URL!, (c) => c.query('CREATE DATABASE flint_app_may_not')))).toBe('42501');
    await connect(first['backup:FLINT_DB_RESTORE_URL']!, async (c) => {
      await c.query('CREATE DATABASE flint_restore_test');
      await c.query('DROP DATABASE flint_restore_test');
    });
    // Nobody reaches a new database, or its public schema, by default: everyone holds nothing on either, from the first
    // moment (before any migration has run), and the three roles that work in it are let in by name.
    for (const key of ['FLINT_DB_OWNER_URL', 'FLINT_DB_TEST_OWNER_URL']) {
      const held = await connect(first[key]!, async (c) => (await c.query<{ r: string }>(
        `SELECT 'database ' || CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END || '=' || a.privilege_type AS r
         FROM pg_database d, LATERAL aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) a WHERE d.datname = current_database() AND a.grantee <> d.datdba
         UNION ALL
         SELECT 'schema ' || CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END || '=' || a.privilege_type
         FROM pg_namespace n, LATERAL aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a WHERE n.nspname = 'public' AND a.grantee <> n.nspowner
         ORDER BY 1`)).rows.map((x) => x.r));
      expect(held, key).toEqual(['database flint_app=CONNECT', 'database flint_approver=CONNECT', 'database flint_backup=CONNECT']);
    }
    // A role that is none of Flint's own cannot connect to it at all.
    const asAdmin = async (sql: string): Promise<void> => {
      const c = new pg.Client(cluster.admin);
      await c.connect();
      try {
        await c.query(sql);
      } finally {
        await c.end();
      }
    };
    await asAdmin(`CREATE ROLE someone_else LOGIN PASSWORD 'not-a-secret-of-anyones'`);
    try {
      const stranger = new URL(first.FLINT_DB_URL!);
      stranger.username = 'someone_else';
      stranger.password = 'not-a-secret-of-anyones';
      expect(await code(connect(stranger.toString(), (c) => c.query('SELECT 1')))).toBe('42501');
    } finally {
      await asAdmin('DROP ROLE someone_else');
    }
    // The owner can make tables in its database; the runtime's role cannot.
    await connect(first.FLINT_DB_OWNER_URL!, (c) => c.query('CREATE TABLE survives (id integer)'));
    // (Before any migration has named it there, the runtime's role has no schema at all to make one in; named outright, it is refused.)
    expect(await code(connect(first.FLINT_DB_URL!, (c) => c.query('CREATE TABLE app_may_not (id integer)')))).toBe('3F000');
    expect(await code(connect(first.FLINT_DB_URL!, (c) => c.query('CREATE TABLE public.app_may_not (id integer)')))).toBe('42501');
  });

  it('no password is in any statement the server saw', () => {
    const log = cluster.log();
    expect(log).toMatch(/CREATE ROLE flint_owner .*PASSWORD 'SCRAM-SHA-256\$4096:/);
    for (const [k, v] of Object.entries(first)) {
      if (!k.includes('_DB_')) continue;
      expect(log.includes(targetOf(v).password), k).toBe(false);
    }
  });

  it('refuses a Mac that already has a Flint database, changing nothing', async () => {
    await expect(bootstrapDb({ admin: cluster.admin, port: cluster.port, home })).rejects.toThrow(BootstrapRefused);
    await expect(bootstrapDb({ admin: cluster.admin, port: cluster.port, home })).rejects.toThrow(/already set up/);
    expect(readEnv(join(home, '.flint', 'secrets.env')).FLINT_DB_URL).toBe(first.FLINT_DB_URL);
    expect(await connect(first.FLINT_DB_URL!, async (c) => (await c.query('SELECT 1 AS one')).rows[0].one)).toBe(1);
  });

  it('refuses a login that may not create roles, and an unusable port', async () => {
    const app = targetOf(first.FLINT_DB_URL!);
    await expect(bootstrapDb({ admin: { host: app.host, port: app.port, user: app.user, password: app.password, database: 'postgres' }, port: cluster.port, home, rotate: true })).rejects.toThrow(/may not create roles/);
    await expect(bootstrapDb({ admin: cluster.admin, port: 80, home })).rejects.toThrow(/port/);
  });

  it('rotate gives every role a new password, keeps the databases and what is in them, and drops nothing', async () => {
    const r = await bootstrapDb({ admin: cluster.admin, port: cluster.port, home, rotate: true });
    expect(r.created).toEqual([]);
    expect(r.rotated).toEqual([...ROLES]);
    expect(r.databases).toEqual([]);
    const now = readEnv(join(home, '.flint', 'secrets.env'));
    expect(now.FLINT_DB_URL).not.toBe(first.FLINT_DB_URL);
    expect(now.FLINT_TOKEN).toBe('kept');
    // The old password is dead; the new one works; the table made before is still there.
    expect(await code(connect(first.FLINT_DB_OWNER_URL!, (c) => c.query('SELECT 1')))).toBe('28P01');
    expect(await connect(now.FLINT_DB_OWNER_URL!, async (c) => (await c.query(`SELECT to_regclass('public.survives') IS NOT NULL AS there`)).rows[0].there)).toBe(true);
  });

  it('every role changes in one transaction: a failure part-way changes no password, and leaves no half-written file', async () => {
    const before = { ...readEnv(join(home, '.flint', 'secrets.env')), ...readEnv(join(home, '.flint', 'backup.env')) };
    // A login that may create roles and databases, and may change only the first two of Flint's roles.
    const limited = { ...cluster.admin, user: 'limited_admin', password: 'limited-admin-test-only' };
    const adminClient = new pg.Client(cluster.admin);
    await adminClient.connect();
    try {
      await adminClient.query(`CREATE ROLE limited_admin LOGIN CREATEROLE CREATEDB PASSWORD 'limited-admin-test-only'`);
      await adminClient.query('GRANT flint_owner, flint_app TO limited_admin WITH ADMIN OPTION');
    } finally {
      await adminClient.end();
    }
    const err = await bootstrapDb({ admin: limited, port: cluster.port, home, rotate: true }).then(() => undefined, (e: { code?: string }) => e);
    expect(err?.code).toBe('42501');
    // The two it could change were changed inside the transaction, and are back as they were: every old password still works.
    for (const key of ['FLINT_DB_OWNER_URL', 'FLINT_DB_URL', 'FLINT_DB_APPROVER_URL', 'FLINT_DB_BACKUP_URL', 'FLINT_DB_RESTORE_URL']) {
      expect(await connect(before[key]!, async (c) => (await c.query('SELECT 1 AS one')).rows[0].one), key).toBe(1);
    }
    expect({ ...readEnv(join(home, '.flint', 'secrets.env')), ...readEnv(join(home, '.flint', 'backup.env')) }).toEqual(before);
    for (const f of ['secrets.env.partial', 'backup.env.partial']) expect(existsSync(join(home, '.flint', f)), f).toBe(false);
  });

  // macOS only: the file is made immutable (chflags uchg), which is how a rename is made to fail there.
  it.skipIf(process.platform !== 'darwin')('if a file cannot take its name after the passwords are set, they are still on disk, and it says to rotate', async () => {
    const dataDir = join(home, '.flint');
    const backupEnv = join(dataDir, 'backup.env');
    // backup.env can be read and cannot be replaced: the new one is staged beside it, and the rename onto it fails.
    spawnSync('/usr/bin/chflags', ['uchg', backupEnv]);
    try {
      await expect(bootstrapDb({ admin: cluster.admin, port: cluster.port, home, rotate: true })).rejects.toThrow('The new passwords are set, but Flint could not put its settings files in place. Run this again with --rotate.');
      // The new passwords are in Postgres and in the staged file, which is the owner's alone.
      const staged = readEnv(`${backupEnv}.partial`);
      expect(statSync(`${backupEnv}.partial`).mode & 0o777).toBe(0o600);
      expect(await connect(staged.FLINT_DB_RESTORE_URL!, async (c) => (await c.query('SELECT 1 AS one')).rows[0].one)).toBe(1);
      expect(await connect(readEnv(join(dataDir, 'secrets.env')).FLINT_DB_OWNER_URL!, async (c) => (await c.query('SELECT 1 AS one')).rows[0].one)).toBe(1);
    } finally {
      spawnSync('/usr/bin/chflags', ['nouchg', backupEnv]);
    }
    // Rotating again puts everything right, replacing its own leftover.
    await bootstrapDb({ admin: cluster.admin, port: cluster.port, home, rotate: true });
    expect(existsSync(`${backupEnv}.partial`)).toBe(false);
    expect(await connect(readEnv(backupEnv).FLINT_DB_RESTORE_URL!, async (c) => (await c.query('SELECT 1 AS one')).rows[0].one)).toBe(1);
  });

  it('the command prints sentences, never a password, and after a rotation says the services must be installed again', () => {
    const r = spawnSync(join(RUNTIME, 'node_modules', '.bin', 'tsx'), ['scripts/bootstrap-db.ts', '--port', String(cluster.port), '--rotate'], {
      cwd: RUNTIME, encoding: 'utf8',
      // The login goes through the standard PG* variables, never the command line.
      env: { PATH: process.env.PATH ?? '', HOME: home, PGHOST: '::1', PGPORT: String(cluster.port), PGUSER: String(cluster.admin.user), PGPASSWORD: String(cluster.admin.password), PGDATABASE: 'postgres' },
    });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const lines = r.stdout.trim().split('\n');
    expect(lines).toEqual([
      "Flint's database has its 5 roles, each with a new password.",
      "The new passwords are saved in Flint's own settings files, which only you can read.",
      "Flint's services keep the old passwords until they are installed again.",
    ]);
    const now = readEnv(join(home, '.flint', 'secrets.env'));
    for (const key of ['FLINT_DB_OWNER_URL', 'FLINT_DB_URL']) expect(r.stdout.includes(targetOf(now[key]!).password), key).toBe(false);
  });
});
