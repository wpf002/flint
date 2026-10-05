/**
 * The scratch database the runtime's tests run against: flint_test, never flint.
 *
 * Where the URLs come from, in order:
 *  1. FLINT_DB_TEST_OWNER_URL / FLINT_DB_TEST_URL / FLINT_DB_TEST_APPROVER_URL in
 *     the environment;
 *  2. on the Mac, those keys (and only those) read from ~/.flint/secrets.env, the
 *     approver's derived from FLINT_DB_APPROVER_URL with the database swapped;
 *  3. in CI, set by global-setup.ts after it creates the roles in the throwaway
 *     Postgres container.
 * With none of them the database tests are skipped, except in CI, where that is
 * a failure.
 */
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import pg from 'pg';

const run = promisify(execFile);
export const RUNTIME = join(__dirname, '..');
export const MIGRATIONS = join(RUNTIME, 'prisma', 'migrations');
const PRISMA = join(RUNTIME, 'node_modules', '.bin', 'prisma');

function fromSecrets(): Record<string, string> {
  const file = join(homedir(), '.flint', 'secrets.env');
  if (!existsSync(file)) return {};
  const want = new Set(['FLINT_DB_TEST_OWNER_URL', 'FLINT_DB_TEST_URL', 'FLINT_DB_APPROVER_URL', 'FLINT_DB_BACKUP_URL', 'FLINT_DB_RESTORE_URL']);
  const out: Record<string, string> = {};
  const backupEnv = join(homedir(), '.flint', 'backup.env');
  const lines = readFileSync(file, 'utf8').split('\n').concat(existsSync(backupEnv) ? readFileSync(backupEnv, 'utf8').split('\n') : []);
  for (const line of lines) {
    const m = line.match(/^(?:export\s+)?([A-Z_]+)=(.*)$/);
    if (m && want.has(m[1]!)) out[m[1]!] = m[2]!.trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

/** The same URL pointed at another database. */
export function withDatabase(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

export interface TestUrls {
  owner: string;
  app: string;
  approver: string;
  /** flint_backup on flint_test, and flint_restore (CREATEDB only), when configured. */
  backup?: string;
  restore?: string;
}

export function testUrls(): TestUrls | undefined {
  const env = process.env;
  const file = env.FLINT_DB_TEST_OWNER_URL ? {} : fromSecrets();
  const owner = env.FLINT_DB_TEST_OWNER_URL ?? file.FLINT_DB_TEST_OWNER_URL;
  const app = env.FLINT_DB_TEST_URL ?? file.FLINT_DB_TEST_URL;
  const approverBase = env.FLINT_DB_TEST_APPROVER_URL ?? (file.FLINT_DB_APPROVER_URL && withDatabase(file.FLINT_DB_APPROVER_URL, 'flint_test'));
  if (!owner || !app || !approverBase) return undefined;
  for (const u of [owner, app, approverBase]) {
    if (new URL(u).pathname !== '/flint_test') throw new Error('runtime tests only ever touch the flint_test database');
  }
  const backup = env.FLINT_DB_TEST_BACKUP_URL ?? (file.FLINT_DB_BACKUP_URL && withDatabase(file.FLINT_DB_BACKUP_URL, 'flint_test'));
  const restore = env.FLINT_DB_TEST_RESTORE_URL ?? file.FLINT_DB_RESTORE_URL;
  return { owner, app, approver: approverBase, ...(backup ? { backup } : {}), ...(restore ? { restore } : {}) };
}

export const URLS = testUrls();
// In CI and in the deploy gate (FLINT_REQUIRE_DB), a missing database is a failure, never a silent skip.
if (!URLS && (process.env.FLINT_CI || process.env.FLINT_REQUIRE_DB)) throw new Error('the flint_test database is required here (see test/db.ts)');
/** `describe.skipIf(NO_DB)` for database tests. */
export const NO_DB = !URLS;

/**
 * A pg config from a URL. pg's own URL parser keeps the brackets of an IPv6 host
 * (`[::1]`) and then fails to resolve it; Postgres listens only on ::1 here.
 */
export function pgConfig(url: string): pg.ClientConfig {
  const u = new URL(url);
  return {
    host: u.hostname.replace(/^\[|\]$/g, ''),
    port: u.port ? Number(u.port) : 5432,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.slice(1)),
  };
}

export async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client(pgConfig(url));
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** Migration directories, oldest first. */
export function migrationDirs(): string[] {
  return readdirSync(MIGRATIONS).filter((d) => /^\d{14}_/.test(d)).sort();
}

export async function prisma(args: string[], url: string): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await run(PRISMA, args, {
      cwd: RUNTIME,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', DATABASE_URL: url, PRISMA_HIDE_UPDATE_MESSAGE: '1' },
      maxBuffer: 16 * 1024 * 1024,
    });
    return { stdout, stderr, code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; code?: number };
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', code: typeof err.code === 'number' ? err.code : 1 };
  }
}

/** Run every down.sql, newest first, and forget the migration history. */
export async function migrateDown(owner: string): Promise<void> {
  await withClient(owner, async (c) => {
    for (const d of migrationDirs().reverse()) {
      await c.query(readFileSync(join(MIGRATIONS, d, 'down.sql'), 'utf8'));
    }
    await c.query('DROP TABLE IF EXISTS _prisma_migrations');
  });
}

export async function migrateUp(owner: string): Promise<void> {
  const r = await prisma(['migrate', 'deploy'], owner);
  if (r.code !== 0) throw new Error(`prisma migrate deploy failed:\n${r.stdout}\n${r.stderr}`);
}

/**
 * What the migrations' down.sql left behind: objects the migration owner made
 * in flint_test under another branch's migrations (a feature branch's tests and
 * the deploy gate share the database; on 2026-10-04 a branch's leftovers failed
 * main's gate). Statements in order: owned schemas other than public, then the
 * public schema's owned relations, routines and types, never an extension's.
 */
const LEFTOVERS_SQL = `
  SELECT 'schema' AS kind, n.nspname AS name, format('DROP SCHEMA IF EXISTS %I CASCADE', n.nspname) AS stmt, 0 AS ord
    FROM pg_namespace n
   WHERE n.nspowner = current_user::regrole AND n.nspname <> 'public'
  UNION ALL
  SELECT CASE c.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized view' WHEN 'S' THEN 'sequence' ELSE 'table' END, c.relname,
         format('DROP %s IF EXISTS public.%I CASCADE',
                CASE c.relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' WHEN 'S' THEN 'SEQUENCE' WHEN 'f' THEN 'FOREIGN TABLE' ELSE 'TABLE' END, c.relname), 1
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f') AND c.relowner = current_user::regrole
     AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype IN ('e', 'a', 'i'))
  UNION ALL
  SELECT 'routine', p.oid::regprocedure::text, format('DROP ROUTINE IF EXISTS %s CASCADE', p.oid::regprocedure), 2
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proowner = current_user::regrole
     AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
  UNION ALL
  SELECT 'type', t.typname, format('DROP TYPE IF EXISTS public.%I CASCADE', t.typname), 3
    FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
   WHERE n.nspname = 'public' AND t.typowner = current_user::regrole AND t.typtype IN ('e', 'd', 'r', 'c')
     AND (t.typtype <> 'c' OR EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = t.typrelid AND c.relkind = 'c'))
     AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_type'::regclass AND d.objid = t.oid AND d.deptype = 'e')
  ORDER BY ord, name`;

/** Drop what the migrations' down.sql left behind (LEFTOVERS_SQL), and name it. */
export async function dropLeftovers(owner: string): Promise<string[]> {
  return withClient(owner, async (c) => {
    const { rows } = await c.query<{ kind: string; name: string; stmt: string }>(LEFTOVERS_SQL);
    for (const r of rows) await c.query(r.stmt);
    return rows.map((r) => `${r.kind} ${r.name}`);
  });
}

/**
 * An empty, fully migrated flint_test, whoever used it last. The round-trip
 * test calls migrateDown alone, so a down.sql that misses its own objects
 * still fails there; here anything left over is dropped and named.
 */
export async function freshDb(): Promise<TestUrls> {
  if (!URLS) throw new Error('no test database');
  await migrateDown(URLS.owner);
  const left = await dropLeftovers(URLS.owner);
  if (left.length) console.warn(`[freshDb] dropped what down.sql left behind (another branch's migrations?): ${left.join(', ')}`);
  await migrateUp(URLS.owner);
  return URLS;
}

let n = 0;
/** A unique id for a test row. */
export const id = (prefix = 't'): string => `${prefix}${Date.now().toString(36)}${(n++).toString(36)}${Math.random().toString(36).slice(2, 8)}`;
export const HEX = (c: string): string => c.repeat(64).slice(0, 64);

/** Run fn and return the Postgres error it throws (or fail if it does not). */
export async function pgError(p: Promise<unknown>): Promise<{ message: string; code?: string }> {
  try {
    await p;
  } catch (e) {
    return e as { message: string; code?: string };
  }
  throw new Error('expected a database error, got success');
}
