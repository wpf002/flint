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

/**
 * A pg client for `t`. Three things every one of them gets:
 *  - an 'error' listener: a connection Postgres drops while it sits idle is an
 *    'error' event, and one nobody listens for takes the whole process down. With
 *    a listener the next query on it is simply refused;
 *  - a connect timeout, so a server that does not answer is a refusal, not a hang;
 *  - a lock timeout, so a statement that needs a lock someone holds gives up.
 */
export const client = (t: PgTarget): pg.Client => {
  const c = new pg.Client({ host: t.host, port: t.port, user: t.user, password: t.password, database: t.database, connectionTimeoutMillis: 10_000, lock_timeout: 15_000 });
  c.on('error', () => {});
  return c;
};

export interface Tools {
  pgDump: string;
  pgRestore: string;
  age?: string;
}

/**
 * What a Postgres tool said went wrong, reduced to its kind and the object it
 * names. Its own words are never passed on: pg_restore prints the statement that
 * failed ("Command was: ...") and Postgres the row that was refused ("Failing row
 * contains (...)"), and either can be Will's data. Only these fixed shapes, which
 * hold a role, database or object name and nothing else, are kept.
 */
const TOOL_ERRORS: readonly RegExp[] = [
  /password authentication failed for user "[^"\n]{1,63}"/,
  /role "[^"\n]{1,63}" does not exist/,
  /database "[^"\n]{1,63}" does not exist/,
  /database "[^"\n]{1,63}" is being accessed by other users/,
  /(?:relation|schema|function|type|table|sequence|extension|language|constraint|index|trigger|view) "[^"\n]{1,128}" (?:already exists|does not exist)/,
  /permission denied (?:for|to) [a-z ]{1,30}(?:"[^"\n]{1,128}"|[A-Za-z_][A-Za-z0-9_.]{0,128})?/,
  /must be (?:owner of|superuser|a member of|able to SET ROLE)[^:;\n]{0,80}/,
  /server version mismatch/,
  /unsupported version \([0-9.]+\) in file header/,
  /input file (?:appears to be a text format dump|does not appear to be a valid archive|is too short)/,
  /could not open input file/,
  /connection to server [^\n]{0,120} failed/,
  /could not connect to server/,
  /No space left on device/,
  /out of memory/,
  /canceling statement due to (?:lock|statement) timeout/,
];
export function toolError(stderr: string): string {
  for (const shape of TOOL_ERRORS) {
    const m = shape.exec(stderr);
    if (m) return m[0];
  }
  return 'it reported an error';
}

/** A Postgres tool ended with an error: which tool, its exit code, and toolError's summary (never its own text). */
export class ToolFailed extends Error {
  constructor(readonly tool: string, readonly exit: number | null, readonly summary: string) {
    super(`${tool} exited ${exit}: ${summary}`);
  }
}

/**
 * Run pg_dump or pg_restore. A tool that cannot be started at all (not there, not
 * runnable) is a fault and is passed on as it is; one that ran and failed is a
 * ToolFailed, which says what kind of failure and names no data.
 */
export function run(bin: string, args: string[], password: string, opts: { stdoutFile?: string } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env: { PATH: '/usr/bin:/bin:/opt/homebrew/bin', PGPASSWORD: password, PGCONNECT_TIMEOUT: '10' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => (err = (err + d).slice(-8000)));
    if (opts.stdoutFile) child.stdout.pipe(createWriteStream(opts.stdoutFile, { mode: 0o600 }));
    else child.stdout.resume();
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new ToolFailed(bin.split('/').pop() ?? 'tool', code, toolError(err)))));
  });
}

export async function sha256File(path: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest('hex');
}

/** Row counts of every table in public and flint_part (partitions counted through their parent). */
export async function countRows(c: pg.Client): Promise<Record<string, number>> {
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

/**
 * ---- Large objects ------------------------------------------------------------
 * How every dump of Flint's database is taken: the custom format, without large
 * objects. Flint keeps nothing in them. Any role that can connect can make one,
 * though, and pg_dump stops at the first one its own role may not read: one
 * stray object made by the runtime's role would fail every later backup, and
 * the restore test with it (the backup role reads tables, not another role's
 * large objects). Leaving them out is what a role without superuser can do
 * about it: taking away the functions that make them (lo_creat and the rest)
 * needs a superuser, in every database, and a restore into a new database
 * would quietly lose it again. The deploy's own dump before a migration passes
 * the same flag (apps/runtime/install-runtime.sh; a test keeps them in step).
 * A restored database therefore never holds one, which the restore's own
 * comparison expects (catalog.ts counts them).
 */
export const DUMP_FORMAT = ['-Fc', '--no-large-objects'] as const;

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
    await run(tools.pgDump, [...DUMP_FORMAT, `--snapshot=${snapshot}`, '-h', t.host, '-p', String(t.port), '-U', t.user, '-d', t.database, '-f', partial], t.password);
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
    rmSync(join(dir, `${f}.sha256`), { force: true });
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
  const message = String(e?.message ?? '');
  // The restore drill's own scratch database missing is not Will's setup: the drill makes and drops it each
  // run (restoreDrill), and one that vanished mid-run is gone again next week.
  if (/database "flint_restore_test" does not exist/i.test(message)) return false;
  // The write refused (macOS, or a read-only or mistaken folder); a role that cannot sign in or lacks the
  // right; a database that is not there.
  if (typeof e?.code === 'string' && ['EPERM', 'EACCES', 'EROFS', 'ENOTDIR', '28P01', '28000', '3D000', '42501'].includes(e.code)) return true;
  // And what the tools say for the same, or for a tool that does not fit: pg_dump older than the server
  // refuses every night until it is upgraded.
  return /password authentication failed|role "[^"]*" does not exist|database "[^"]*" does not exist|permission denied|server version mismatch|malformed recipient|unknown recipient/i.test(message);
}

/** How every age file begins: what is written offsite starts with it, or is not kept. */
const AGE_HEADER = Buffer.from('age-encryption.org/v1\n');

/**
 * age-encrypt `src` to `recipient`, writing the ciphertext to `dest` and taking
 * its size and hash as it goes by. Nothing is read back from `dest`: launchd may
 * write into iCloud Drive by path, and that is all this asks of it.
 *
 * Nothing is written until the stream has begun as an age file does: its first
 * bytes are held here, and `dest` is not even created before they are seen to be
 * age's header. So a stand-in that passed the dump through (or an age that
 * printed something else) never puts a byte of plaintext in the offsite folder,
 * not even under a partial name. What is written is flushed to disk before it
 * counts.
 */
function seal(age: string, recipient: string, src: string, dest: string): Promise<{ bytes: number; sha256: string }> {
  return new Promise((resolve, reject) => {
    // No -o: age writes the ciphertext to its stdout, which is a pipe here, never a terminal.
    const child = spawn(age, ['-r', recipient, src], { env: { PATH: '/usr/bin:/bin:/opt/homebrew/bin' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const hash = createHash('sha256');
    /** The first bytes, held until they are seen to begin an age file; undefined once the file is open. */
    let held: Buffer[] | undefined = [];
    let heldBytes = 0;
    let fd: number | undefined;
    let out: ReturnType<typeof createWriteStream> | undefined;
    let bytes = 0;
    let err = '';
    let exited = false;
    let written = false;
    let settled = false;
    const end = (failure?: unknown) => {
      if (settled) return;
      settled = true;
      if (failure) {
        child.kill();
        out?.destroy();
      }
      try {
        if (!failure && fd !== undefined) fsyncSync(fd);
      } catch (e) {
        failure = e;
      }
      try {
        if (fd !== undefined) closeSync(fd);
      } catch {
        // Closed already: the result stands.
      }
      if (failure) reject(failure);
      else resolve({ bytes, sha256: hash.digest('hex') });
    };
    const notAge = () => new NeedsSetup('age did not write an age file, so nothing was written');
    child.stdout.on('data', (d: Buffer) => {
      if (settled) return;
      hash.update(d);
      bytes += d.length;
      if (!held) return; // The file is open: the pipe below carries this chunk.
      held.push(d);
      heldBytes += d.length;
      if (heldBytes < AGE_HEADER.length) return;
      if (!Buffer.concat(held).subarray(0, AGE_HEADER.length).equals(AGE_HEADER)) return end(notAge());
      try {
        fd = openSync(dest, 'w', 0o600);
        out = createWriteStream(dest, { fd, autoClose: false });
        out.on('error', end);
        out.on('finish', () => {
          written = true;
          if (exited) end();
        });
        for (const chunk of held) out.write(chunk);
        held = undefined;
        // From here on (this chunk is written already): the rest of the stream, at the file's pace.
        child.stdout.pipe(out);
      } catch (e) {
        end(e);
      }
    });
    child.stderr.on('data', (d) => (err = (err + d).slice(-4000)));
    child.on('error', end);
    child.on('close', (code) => {
      // age's own error is its first line; the last is where to report one.
      const said = err.split('\n').find((l) => l.startsWith('age: error:')) ?? err.trim().split('\n').pop() ?? '';
      if (code !== 0) return end(new Error(`age exited ${code}: ${said}`));
      // It ended before it had written even a header's worth.
      if (!out) return end(notAge());
      // Both must have ended: age (its exit code says the stream is whole) and the file.
      exited = true;
      if (written) end();
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

/** The name a copy's row counts are sent under: `flint-….dump.age` gives `flint-….dump.counts.json.age`. */
const countsOf = (copy: string): string => copy.replace(/\.age$/, '.counts.json.age');

/** A half-written copy younger than this may be another run's, still being written: it is left alone. */
export const STALE_PARTIAL_MS = 3_600_000;

/**
 * Record `name` as tonight's encrypted copy offsite and keep `keep` copies (at
 * least one): tonight's, and the newest of the others. The offsite folder is
 * never listed: launchd may write into iCloud Drive by path, but macOS does not
 * let it list the folder (apps/studio/backup_flint.sh found its own pruning
 * matched nothing there). The copies are tracked by name in `manifest` instead,
 * one to a line.
 *
 *  - Called only after a new copy is safely written, so a night that cannot
 *    encrypt never costs an older copy.
 *  - Tonight's copy is never one of those that may go, whatever its name: an
 *    older dump sent again sorts before every other copy, and it is still the
 *    one just written. Nor is the newest copy that is there, ever.
 *  - Only a copy that is really there counts toward the ones kept: a name on
 *    record whose file is gone (a row for a copy someone removed) never pushes
 *    a real copy out, and is dropped from the manifest.
 *  - A copy's name holds its time, so the oldest are the first by name,
 *    whatever order the manifest is in.
 *  - The manifest heals itself. `recorded` (the names of the copies the
 *    database has a row for) stands in for one that is missing, empty or cut
 *    short, and a copy no record names (its run died before it was recorded)
 *    is found by asking for it by its local dump's name. So a lost manifest
 *    never leaves copies nothing will prune.
 *  - Only names this code writes (flint-*.dump.age) are ever removed, and only
 *    from `offsiteDir`; so is one left half-written (.partial), once it is an
 *    hour old (a younger one may be a run still writing).
 *  - A copy's row counts (flint-*.dump.counts.json.age, sent beside it) go when
 *    it goes, and never before.
 *  - A copy that will not delete stays in the manifest and is tried again.
 *
 * Returns the names of the files it actually removed.
 */
export function pruneOffsite(offsiteDir: string, manifest: string, name: string, keep: number, from: { recorded?: readonly string[]; dumpDir?: string; now?: number } = {}): string[] {
  if (!OFFSITE_COPY.test(name)) throw new Error('not an encrypted copy’s name');
  if (!Number.isInteger(keep) || keep < 1) throw new Error('at least one encrypted copy is kept');
  const there = (file: string): boolean => existsSync(join(offsiteDir, file));
  let listed: string[] = [];
  try {
    listed = readFileSync(manifest, 'utf8').split('\n').map((l) => l.trim());
  } catch {
    // No manifest (a first run, or it was lost): what the database recorded stands in.
  }
  const local = from.dumpDir && existsSync(from.dumpDir) ? readdirSync(from.dumpDir).filter((f) => /^flint-.*\.dump$/.test(f)).map((f) => `${f}.age`).filter((n) => OFFSITE_COPY.test(n)) : [];
  // Every name a copy may be under: on record, or a local dump's. Never tonight's own.
  const names = [...new Set([...listed, ...(from.recorded ?? []), ...local].filter((n) => OFFSITE_COPY.test(n) && n !== name))].sort();
  const others = names.filter(there);
  const mine = there(name);
  // Tonight's copy has its place; the rest go to the newest of the others. (Were tonight's somehow not there,
  // the others would keep every place.) And the newest copy there is, by name, is never removed.
  const places = mine ? keep - 1 : keep;
  const newest = [...others, ...(mine ? [name] : [])].sort().at(-1);
  const kept = new Set([...others.slice(Math.max(0, others.length - places)), ...(newest ? [newest] : [])]);
  const gone: string[] = [];
  const stuck: string[] = [];
  for (const old of others) {
    if (kept.has(old)) continue;
    try {
      rmSync(join(offsiteDir, old), { force: true });
      gone.push(old);
    } catch {
      stuck.push(old);
      continue;
    }
    try {
      rmSync(join(offsiteDir, countsOf(old)), { force: true });
    } catch {
      // Its counts alone are a few hundred bytes of nothing useful; they are tried again with nothing to lose.
    }
  }
  // A half-written copy left by a run that died. One written to within the hour may be a run still going
  // (this one's own was renamed into place): it is left for a later night.
  const before = (from.now ?? Date.now()) - STALE_PARTIAL_MS;
  for (const n of [...names, name]) {
    const half = join(offsiteDir, `${n}.partial`);
    try {
      if (existsSync(half) && statSync(half).mtimeMs < before) rmSync(half, { force: true });
    } catch {
      // Tried again next time.
    }
  }
  const partial = `${manifest}.partial`;
  writeFileSync(partial, [...new Set([...stuck, ...kept, name])].sort().map((n) => `${n}\n`).join(''), { mode: 0o600 });
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
