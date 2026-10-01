/**
 * Backups of Flint's database and the restore drill (plan P1 exit criterion 8).
 *
 *  - backup.local: `pg_dump -Fc` as flint_backup (read-only: pg_read_all_data)
 *    into ~/FlintBackups/pg, mode 0600, 14 kept. The dump and the per-table row
 *    counts beside it come from ONE exported snapshot, so a drill can compare
 *    exact numbers even while the runtime keeps writing.
 *  - backup.offsite: the same dump, age-encrypted to Will's public key, copied
 *    off the box; refused when there is no recipient (never plaintext).
 *  - restore.drill: restore the newest dump into a scratch database
 *    (flint_restore_test), compare every table's row count with the counts
 *    taken at dump time, drop the scratch database, and record the result.
 *
 * Passwords go to pg_dump/pg_restore through PGPASSWORD, never argv (argv is
 * visible to every process on the Mac).
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

export interface PgTarget {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

/** pg connection facts from a URL (pg's own parser keeps IPv6 brackets). */
export function targetOf(url: string): PgTarget {
  const u = new URL(url);
  return {
    host: u.hostname.replace(/^\[|\]$/g, ''),
    port: u.port ? Number(u.port) : 5432,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.slice(1)),
  };
}

const client = (t: PgTarget) => new pg.Client({ host: t.host, port: t.port, user: t.user, password: t.password, database: t.database });

export interface Tools {
  pgDump: string;
  pgRestore: string;
  age?: string;
}

function run(bin: string, args: string[], password: string, opts: { stdoutFile?: string } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env: { PATH: '/usr/bin:/bin:/opt/homebrew/bin', PGPASSWORD: password, PGCONNECT_TIMEOUT: '10' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => (err = (err + d).slice(-4000)));
    if (opts.stdoutFile) child.stdout.pipe(createWriteStream(opts.stdoutFile, { mode: 0o600 }));
    else child.stdout.resume();
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${bin.split('/').pop()} exited ${code}: ${err.trim().split('\n').pop() ?? ''}`))));
  });
}

async function sha256File(path: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest('hex');
}

/** Row counts of every table in public and flint_part (partitions counted through their parent). */
async function countRows(c: pg.Client): Promise<Record<string, number>> {
  const tables = await c.query<{ name: string }>(`
    SELECT format('%I.%I', n.nspname, c.relname) AS name
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relname <> '_prisma_migrations'
    ORDER BY 1`);
  const out: Record<string, number> = {};
  for (const { name } of tables.rows) {
    out[name] = Number((await c.query<{ n: string }>(`SELECT count(*) AS n FROM ${name}`)).rows[0]!.n);
  }
  return out;
}

export interface DumpResult {
  path: string;
  bytes: number;
  sha256: string;
  counts: Record<string, number>;
}

/** One consistent dump plus its counts. The file appears only when complete. */
export async function dumpDatabase(backupUrl: string, outDir: string, tools: Tools, now: Date): Promise<DumpResult> {
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  chmodSync(outDir, 0o700);
  const t = targetOf(backupUrl);
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const final = join(outDir, `flint-${stamp}.dump`);
  const partial = `${final}.partial`;
  const c = client(t);
  await c.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const snapshot = (await c.query<{ s: string }>('SELECT pg_export_snapshot() AS s')).rows[0]!.s;
    const counts = await countRows(c);
    await run(tools.pgDump, ['-Fc', `--snapshot=${snapshot}`, '-h', t.host, '-p', String(t.port), '-U', t.user, '-d', t.database, '-f', partial], t.password);
    await c.query('COMMIT');
    chmodSync(partial, 0o600);
    renameSync(partial, final);
    writeFileSync(`${final}.counts.json`, JSON.stringify(counts), { mode: 0o600 });
    return { path: final, bytes: statSync(final).size, sha256: await sha256File(final), counts };
  } catch (err) {
    rmSync(partial, { force: true });
    throw err;
  } finally {
    await c.end().catch(() => {});
  }
}

/** Keep the newest `keep` dumps (and their counts files). */
export function pruneDumps(dir: string, keep: number): string[] {
  if (!existsSync(dir)) return [];
  const dumps = readdirSync(dir).filter((f) => /^flint-.*\.dump$/.test(f)).sort();
  const gone = dumps.slice(0, Math.max(0, dumps.length - keep));
  for (const f of gone) {
    rmSync(join(dir, f), { force: true });
    rmSync(join(dir, `${f}.counts.json`), { force: true });
  }
  return gone;
}

/** age-encrypt to Will's public key; never a plaintext fallback. */
export async function encryptTo(path: string, recipient: string, tools: Tools, outDir: string): Promise<{ path: string; bytes: number; sha256: string }> {
  if (!/^age1[0-9a-z]{50,}$/.test(recipient)) throw new Error('the age recipient is not an age public key');
  if (!tools.age || !existsSync(tools.age)) throw new Error('age is not installed (brew install age)');
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, `${path.split('/').pop()}.age`);
  const partial = `${out}.partial`;
  try {
    await run(tools.age, ['-r', recipient, '-o', partial, path], '');
    renameSync(partial, out);
  } catch (err) {
    rmSync(partial, { force: true });
    throw err;
  }
  return { path: out, bytes: statSync(out).size, sha256: await sha256File(out) };
}

export interface DrillResult {
  ok: boolean;
  tables: number;
  mismatches: Array<{ table: string; expected: number; restored: number | null }>;
}

/**
 * Restore `dump` into flint_restore_test as a role that may create databases
 * (flint_restore), compare counts with the counts taken at dump time, and drop
 * it. `adminUrl` names that role and any database it may connect to.
 */
export async function restoreDrill(dump: string, adminUrl: string, tools: Tools): Promise<DrillResult> {
  const expected = JSON.parse(readFileSync(`${dump}.counts.json`, 'utf8')) as Record<string, number>;
  const admin = targetOf(adminUrl);
  const scratch: PgTarget = { ...admin, database: 'flint_restore_test' };
  const c = client(admin);
  await c.connect();
  try {
    await c.query('DROP DATABASE IF EXISTS flint_restore_test');
    await c.query('CREATE DATABASE flint_restore_test');
  } finally {
    await c.end();
  }
  try {
    await run(tools.pgRestore, ['--no-owner', '--no-privileges', '--exit-on-error', '-h', scratch.host, '-p', String(scratch.port), '-U', scratch.user, '-d', scratch.database, dump], scratch.password);
    const r = client(scratch);
    await r.connect();
    let restored: Record<string, number>;
    try {
      restored = await countRows(r);
    } finally {
      await r.end();
    }
    const mismatches = Object.entries(expected)
      .filter(([table, n]) => restored[table] !== n)
      .map(([table, n]) => ({ table, expected: n, restored: restored[table] ?? null }));
    return { ok: mismatches.length === 0 && Object.keys(expected).length > 0, tables: Object.keys(expected).length, mismatches };
  } finally {
    const d = client(admin);
    await d.connect();
    await d.query('DROP DATABASE IF EXISTS flint_restore_test').catch(() => {});
    await d.end();
  }
}

/** The newest dump in `dir`, or undefined. */
export function newestDump(dir: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  const dumps = readdirSync(dir).filter((f) => /^flint-.*\.dump$/.test(f)).sort();
  return dumps.length ? join(dir, dumps[dumps.length - 1]!) : undefined;
}
