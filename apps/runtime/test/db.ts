/**
 * The scratch database the runtime's tests run against: flint_test, never flint.
 *
 * Where the URLs come from, in order:
 *  1. FLINT_DB_TEST_OWNER_URL / FLINT_DB_TEST_URL / FLINT_DB_TEST_APPROVER_URL in
 *     the environment;
 *  2. in the deploy gate only (FLINT_DEPLOY_GATE=1, set by install-runtime.sh),
 *     those keys (and only those) read from ~/.flint/secrets.env, the approver's
 *     derived from FLINT_DB_APPROVER_URL with the database swapped;
 *  3. in CI, set by global-setup.ts after it creates the roles in the throwaway
 *     Postgres container.
 * With none of them the database tests are skipped, except in CI and the gate,
 * where that is a failure.
 *
 * The gate is the only run that may read this Mac's own settings. A test run
 * started by hand with no URLs in its environment used to fall back to them and
 * reset the gate's database under it, which failed a deploy. It now gets none.
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
  const file = env.FLINT_DB_TEST_OWNER_URL || env.FLINT_DEPLOY_GATE !== '1' ? {} : fromSecrets();
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

/**
 * P5's down.sql refuses to run while a task, asset or review card is approved
 * or running: that card's one use is on record only in a table it drops. A test
 * database is reset whatever a test left behind, so those cards are failed
 * first, as they would end before a real rollback. A database without P5 has
 * none.
 */
export async function settleCards(owner: string): Promise<void> {
  await withClient(owner, async (c) => {
    const { rows } = await c.query(`SELECT to_regclass('public."TaskApprovalUse"') IS NOT NULL AND to_regclass('public."Proposal"') IS NOT NULL AS p5`);
    if (!rows[0].p5) return;
    await c.query(
      `UPDATE "Proposal" SET status = 'failed', error = 'ended by a test reset', "executedAt" = now()
       WHERE status IN ('approved', 'executing') AND (kind IN ('task', 'spend') OR action ~ '^(task[.]|asset[.]enable$|review[.])' OR action = 'hive.dispatch_job')`,
    );
  });
}

/** Run every down.sql, newest first, and forget the migration history. */
export async function migrateDown(owner: string): Promise<void> {
  await settleCards(owner);
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
 * Remove the large objects a stopped test left in flint_test, and say how many.
 * Two tests make one each (a backup never includes them, and Health says so),
 * and each removes its own when it ends; one killed in between left it, and
 * every later run then read "the database holds a large object". Only its
 * maker may remove one, so each role removes its own.
 */
export async function unlinkLargeObjects(urls: TestUrls): Promise<number> {
  let gone = 0;
  for (const url of [urls.owner, urls.app, urls.approver, urls.backup]) {
    if (!url) continue;
    gone += await withClient(url, async (c) => (await c.query('SELECT lo_unlink(oid) FROM pg_largeobject_metadata WHERE lomowner = current_user::regrole')).rowCount ?? 0);
  }
  return gone;
}

/**
 * An empty, fully migrated flint_test, whoever used it last. The round-trip
 * test calls migrateDown alone, so a down.sql that misses its own objects
 * still fails there; here anything left over is dropped and named, and so is
 * a large object a stopped test left (unlinkLargeObjects).
 */
export async function freshDb(): Promise<TestUrls> {
  if (!URLS) throw new Error('no test database');
  await migrateDown(URLS.owner);
  const left = await dropLeftovers(URLS.owner);
  const large = await unlinkLargeObjects(URLS);
  if (large) left.push(counted(large, 'large object'));
  if (left.length) console.warn(`[freshDb] dropped what an earlier run left behind (another branch's migrations, a stopped test?): ${left.join(', ')}`);
  await migrateUp(URLS.owner);
  return URLS;
}
const counted = (n: number, what: string): string => `${n} ${what}${n === 1 ? '' : 's'}`;

/** The migration that holds a goal from chat to a signed card or rule (P3 part 5's floor). */
export const CHAT_GOAL_FLOOR = '20261015000100_p3_chat_goal_floor';

/**
 * A database without that floor for the length of `fn`: its own down.sql (the
 * documented rollback), then a deploy puts it back, whatever `fn` did. What a
 * runtime ahead of its database meets after a rollback or an older restore.
 */
export async function withoutChatGoalFloor<T>(owner: string, fn: () => Promise<T>): Promise<T> {
  await withClient(owner, (c) => c.query(readFileSync(join(MIGRATIONS, CHAT_GOAL_FLOOR, 'down.sql'), 'utf8')));
  try {
    return await fn();
  } finally {
    await migrateUp(owner);
  }
}

/** The migration that keeps the runtime's role from switching off a policy row that holds an action back. */
export const POLICY_OFF_GUARD = '20261015000200_policy_off_guard';

/**
 * A database without that guard for the length of `fn`: its own down.sql (the
 * documented rollback), then a deploy puts it back, whatever `fn` did. What the
 * rows made before the guard were made under.
 */
export async function withoutPolicyOffGuard<T>(owner: string, fn: () => Promise<T>): Promise<T> {
  await withClient(owner, (c) => c.query(readFileSync(join(MIGRATIONS, POLICY_OFF_GUARD, 'down.sql'), 'utf8')));
  try {
    return await fn();
  } finally {
    await migrateUp(owner);
  }
}

/**
 * Health checks dated as a test needs them (hours ago, a day last August). The
 * database dates the runtime's own rows itself (HealthCheck_clock, P3 part 4),
 * so a row in the past is written as the owner, the way a goal review is moved
 * in time (test/goals/weeks.ts): no runtime role can.
 */
export async function healthRows(urls: Pick<TestUrls, 'owner'>, rows: ReadonlyArray<{ component: string; status: string; detail?: string | null; at: Date }>): Promise<void> {
  if (!rows.length) return;
  await withClient(urls.owner, async (c) => {
    for (let i = 0; i < rows.length; i += 500) {
      const part = rows.slice(i, i + 500);
      await c.query(
        `INSERT INTO "HealthCheck" (id, component, status, detail, at) SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::timestamptz[])`,
        [part.map(() => id('hc')), part.map((r) => r.component), part.map((r) => r.status), part.map((r) => r.detail ?? null), part.map((r) => r.at)],
      );
    }
  });
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
