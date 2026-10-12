/**
 * Flint's database roles and databases on a rebuilt Mac (P7,
 * src/backup/bootstrap.ts), against a throwaway cluster of its own: the five
 * roles and their limits, fresh passwords that reach only the two 0600 files
 * (never a statement, so never the server's log), a refusal on a machine that
 * already has a Flint, and `rotate` as the explicit way past it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { BootstrapRefused, DATABASES, ROLES, bootstrapDb, scramVerifier, upsertEnv } from '../src/backup/bootstrap';
import { targetOf } from '../src/backup/backup';
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
      return { roles: roles.rows, dbs: dbs.rows, schema: schema.rows[0]!.owner, reads: reads.rows[0]!.m };
    });
    expect(who.roles.map((r) => r.rolname)).toEqual([...ROLES].sort());
    for (const r of who.roles) {
      expect(r, r.rolname).toMatchObject({ rolsuper: false, rolcreaterole: false, rolbypassrls: false, rolreplication: false });
      expect(r.rolcreatedb, r.rolname).toBe(r.rolname === 'flint_owner' || r.rolname === 'flint_restore');
    }
    expect(who.dbs).toEqual([{ datname: 'flint', owner: 'flint_owner' }, { datname: 'flint_test', owner: 'flint_owner' }]);
    expect(who.schema).toBe('flint_owner');
    expect(who.reads).toBe(true);
    // The others sign in too, and only the restore role (and the owner) may make a database.
    for (const key of ['FLINT_DB_URL', 'FLINT_DB_APPROVER_URL', 'FLINT_DB_BACKUP_URL', 'FLINT_DB_TEST_URL', 'FLINT_DB_TEST_OWNER_URL']) {
      expect(await connect(first[key]!, async (c) => (await c.query('SELECT 1 AS one')).rows[0].one), key).toBe(1);
    }
    expect(await code(connect(first.FLINT_DB_URL!, (c) => c.query('CREATE DATABASE flint_app_may_not')))).toBe('42501');
    await connect(first['backup:FLINT_DB_RESTORE_URL']!, async (c) => {
      await c.query('CREATE DATABASE flint_restore_test');
      await c.query('DROP DATABASE flint_restore_test');
    });
    // The owner can make tables in its database; the runtime's role cannot.
    await connect(first.FLINT_DB_OWNER_URL!, (c) => c.query('CREATE TABLE survives (id integer)'));
    expect(await code(connect(first.FLINT_DB_URL!, (c) => c.query('CREATE TABLE app_may_not (id integer)')))).toBe('42501');
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
});
