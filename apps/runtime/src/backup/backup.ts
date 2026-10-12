/**
 * Backups of Flint's database and the restore drill (plan P1 exit criterion 8).
 *
 *  - backup.local: `pg_dump -Fc` as flint_backup (read-only: pg_read_all_data)
 *    into ~/FlintBackups/pg, mode 0600, 14 kept. The dump and the per-table row
 *    counts beside it come from ONE exported snapshot, so a drill can compare
 *    exact numbers even while the runtime keeps writing.
 *  - backup.offsite: the same dump, age-encrypted to Will's public key, copied
 *    off the box (iCloud Drive's FlintBackups/pg unless FLINT_OFFSITE_DIR names
 *    another folder); refused when there is no recipient (never plaintext). The
 *    newest 7 copies are kept there, tracked by name.
 *  - restore.drill: restore the newest dump into a scratch database
 *    (flint_restore_test), compare every table's row count with the counts
 *    taken at dump time, drop the scratch database, and record the result.
 *
 * Passwords go to pg_dump/pg_restore through PGPASSWORD, never argv (argv is
 * visible to every process on the Mac).
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, createReadStream, createWriteStream, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
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

/**
 * A failure another try cannot change: no key, no `age`, nowhere to send the
 * copy, a write macOS refuses. The job's note says its setup needs fixing
 * instead of promising to try again (needsSetup; apps/runtime/src/cli.ts).
 */
export class NeedsSetup extends Error {}

/** Whether a nightly job failed for a reason that stays until someone fixes its setup. */
export function needsSetup(err: unknown): boolean {
  if (err instanceof NeedsSetup) return true;
  const e = err as { code?: unknown; message?: unknown } | null;
  // The write refused (macOS, or a read-only or mistaken folder); a role that cannot sign in or lacks the
  // right; a database that is not there.
  if (typeof e?.code === 'string' && ['EPERM', 'EACCES', 'EROFS', 'ENOTDIR', '28P01', '28000', '3D000', '42501'].includes(e.code)) return true;
  return /password authentication failed|role "[^"]*" does not exist|database "[^"]*" does not exist|permission denied|malformed recipient|unknown recipient/i.test(String(e?.message ?? ''));
}

/** How every age file begins: what is written offsite starts with it, or is not kept. */
const AGE_HEADER = Buffer.from('age-encryption.org/v1\n');

/**
 * age-encrypt `src` to `recipient`, writing the ciphertext to `dest` and taking
 * its size and hash as it goes by. Nothing is read back from `dest`: launchd may
 * write into iCloud Drive by path, and that is all this asks of it. What is
 * written must begin as an age file does (a stand-in that passed the dump
 * through would not), and it is flushed to disk before it counts.
 */
function seal(age: string, recipient: string, src: string, dest: string): Promise<{ bytes: number; sha256: string }> {
  return new Promise((resolve, reject) => {
    let fd: number;
    try {
      fd = openSync(dest, 'w', 0o600);
    } catch (err) {
      reject(err);
      return;
    }
    // No -o: age writes the ciphertext to its stdout, which is a pipe here, never a terminal.
    const child = spawn(age, ['-r', recipient, src], { env: { PATH: '/usr/bin:/bin:/opt/homebrew/bin' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = createWriteStream(dest, { fd, autoClose: false });
    const hash = createHash('sha256');
    const head: Buffer[] = [];
    let headBytes = 0;
    let bytes = 0;
    let err = '';
    let exited: number | null | undefined;
    let written = false;
    let settled = false;
    const end = (failure?: unknown) => {
      if (settled) return;
      settled = true;
      try {
        if (!failure) fsyncSync(fd);
      } catch (e) {
        failure = e;
      }
      try {
        closeSync(fd);
      } catch {
        // Closed already: the result stands.
      }
      if (failure) reject(failure);
      else resolve({ bytes, sha256: hash.digest('hex') });
    };
    // Both must have ended: age (its exit code says whether the stream is whole) and the file.
    const settle = () => {
      if (exited === undefined || !written) return;
      // age's own error is its first line; the last is where to report one.
      const said = err.split('\n').find((l) => l.startsWith('age: error:')) ?? err.trim().split('\n').pop() ?? '';
      if (exited !== 0) end(new Error(`age exited ${exited}: ${said}`));
      else if (!Buffer.concat(head).subarray(0, AGE_HEADER.length).equals(AGE_HEADER)) end(new NeedsSetup('age did not write an age file, so nothing was kept'));
      else end();
    };
    child.stdout.on('data', (d: Buffer) => {
      hash.update(d);
      bytes += d.length;
      if (headBytes < AGE_HEADER.length) {
        head.push(d);
        headBytes += d.length;
      }
    });
    child.stdout.pipe(out);
    child.stderr.on('data', (d) => (err = (err + d).slice(-4000)));
    child.on('error', end);
    out.on('error', (e) => {
      child.kill();
      end(e);
    });
    out.on('finish', () => {
      written = true;
      settle();
    });
    child.on('close', (code) => {
      exited = code;
      settle();
    });
  });
}

/**
 * age-encrypt to Will's public key into `outDir`; never a plaintext fallback.
 * The copy appears under its name only once it is whole, and only ciphertext
 * is ever written there.
 */
export async function encryptTo(path: string, recipient: string, tools: Tools, outDir: string): Promise<{ path: string; bytes: number; sha256: string }> {
  if (!/^age1[0-9a-z]{50,}$/.test(recipient)) throw new NeedsSetup('the age recipient is not an age public key');
  if (!tools.age || !existsSync(tools.age)) throw new NeedsSetup('age is not installed (brew install age)');
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, `${basename(path)}.age`);
  const partial = `${out}.partial`;
  try {
    const sealed = await seal(tools.age, recipient, path, partial);
    renameSync(partial, out);
    return { path: out, ...sealed };
  } catch (err) {
    rmSync(partial, { force: true });
    throw err;
  }
}

/** An encrypted copy's name, as encryptTo writes it: the only kind of file pruneOffsite removes. */
const OFFSITE_COPY = /^flint-[0-9A-Za-z-]+\.dump\.age$/;

/**
 * Record `name` as the newest encrypted copy offsite and keep the newest `keep`
 * (at least one). The offsite folder is never listed: launchd may write into
 * iCloud Drive by path, but macOS does not let it list the folder
 * (apps/studio/backup_flint.sh found its own pruning matched nothing there).
 * The copies are tracked by name in `manifest` instead, one to a line.
 *
 *  - Called only after a new copy is safely written, so a night that cannot
 *    encrypt never costs an older copy.
 *  - A copy's name holds its time, so the oldest are the first by name,
 *    whatever order the manifest is in.
 *  - The manifest heals itself. `recorded` (the names of the copies the
 *    database has a row for) stands in for one that is missing, empty or cut
 *    short, and a copy no record names (its run died before it was recorded)
 *    is found by asking for it by its local dump's name. So a lost manifest
 *    never leaves copies nothing will prune.
 *  - Only names this code writes (flint-*.dump.age) are ever removed, and only
 *    from `offsiteDir`; so is one left half-written (.partial).
 *  - A copy that will not delete stays in the manifest and is tried again.
 *
 * Returns the names of the files it actually removed.
 */
export function pruneOffsite(offsiteDir: string, manifest: string, name: string, keep: number, from: { recorded?: readonly string[]; dumpDir?: string } = {}): string[] {
  if (!OFFSITE_COPY.test(name)) throw new Error('not an encrypted copy’s name');
  if (!Number.isInteger(keep) || keep < 1) throw new Error('at least one encrypted copy is kept');
  const there = (file: string): boolean => existsSync(join(offsiteDir, file));
  let listed: string[] = [];
  try {
    listed = readFileSync(manifest, 'utf8').split('\n').map((l) => l.trim());
  } catch {
    // No manifest (a first run, or it was lost): what the database recorded stands in.
  }
  const local = from.dumpDir && existsSync(from.dumpDir) ? readdirSync(from.dumpDir).filter((f) => /^flint-.*\.dump$/.test(f)).map((f) => `${f}.age`) : [];
  const known = new Set([...listed, ...(from.recorded ?? []), name].filter((n) => OFFSITE_COPY.test(n)));
  // A copy with no record at all counts only if it is really there.
  for (const n of local) if (OFFSITE_COPY.test(n) && !known.has(n) && there(n)) known.add(n);
  const all = [...known].sort();
  const gone: string[] = [];
  const stuck: string[] = [];
  for (const old of all.slice(0, -keep)) {
    try {
      const was = there(old);
      rmSync(join(offsiteDir, old), { force: true });
      if (was) gone.push(old);
    } catch {
      stuck.push(old);
    }
  }
  // A half-written copy left by a run that died (never this run's: its own was renamed into place).
  for (const n of new Set([...all, ...local.filter((x) => OFFSITE_COPY.test(x))])) {
    try {
      if (there(`${n}.partial`)) rmSync(join(offsiteDir, `${n}.partial`), { force: true });
    } catch {
      // Tried again next time.
    }
  }
  const partial = `${manifest}.partial`;
  writeFileSync(partial, [...stuck, ...all.slice(-keep)].map((n) => `${n}\n`).join(''), { mode: 0o600 });
  renameSync(partial, manifest);
  return gone;
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
