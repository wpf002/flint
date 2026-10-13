/**
 * Putting Flint's database back from a backup (P7).
 *
 * One path, two callers:
 *  - `restore.production`: over the production database, by Will at the keyboard;
 *  - a rebuild: into the empty database `bootstrap-db` just made on a new Mac
 *    (apps/studio/rebuild.sh passes `--from-rebuild`).
 *
 * The steps, in order. Nothing in use is touched before step 9.
 *
 *  1. One restore at a time (an advisory lock), and no update while it runs
 *     (the deploy hold file). The state the last run left is read first: a
 *     production database that is closed, or missing, is said in plain words
 *     with the command that repairs it.
 *  2. The setup this needs is checked (who owns what, who may sign in).
 *  3. The backup file is checked: a nightly dump, Will's own, unchanged since it
 *     was written (EVERY fingerprint recorded for it must match), readable.
 *     Without a recorded fingerprint nothing is restored unless Will says so.
 *  4. It is restored into a database of its own, by a role that owns nothing
 *     else (flint_restore): the SQL in a backup file runs as that role, which
 *     can reach no other database. What that role may still change about
 *     itself (its password, its stored settings, databases it makes) is looked
 *     at again after every pg_restore and put back; a file that did any of it
 *     is refused.
 *  5. The copy is compared, object by object, with a database built from this
 *     checkout's own migrations (./catalog.ts): tables, triggers, functions,
 *     every privilege. Any difference is a refusal that names the object.
 *     Until it has passed, the copy is read only as flint_restore, with nothing
 *     on the search path: a view or a function a backup defines never runs as
 *     the migration owner.
 *  6. Only then is it handed to the migration owner, and brought up to date.
 *     What the copy's owner could set on the database itself (a stored
 *     setting, a connection limit, the template mark) is cleared first.
 *  7. What Will took away after the backup is carried forward, what was signed
 *     and not finished is set aside, and every promotion is checked against
 *     his signature (./carry.ts).
 *  8. Will confirms, having read what is in force afterwards. A trial run
 *     (`--check`) drops the copy here instead.
 *  9. The swap: the runtime is stopped, the production database is closed to
 *     new connections, and the two databases change names in ONE transaction.
 *     Nothing is dropped: the database that was in use stays as
 *     `<name>_damaged_<time>`, closed, until Will removes it.
 *
 * If the swap fails or is interrupted, what happens next is decided by reading
 * the catalog, never by what this process believes it did: production is
 * opened again under its name and the runtime started, or, when that cannot be
 * confirmed, the copy is kept and the real state is said with the commands
 * that fix it. "Nothing was changed" is printed only when that was confirmed.
 *
 * Passwords go to pg_restore through PGPASSWORD, never argv; nothing here logs
 * a URL, and a tool's own error text is never passed on (backup.ts, toolError).
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statfsSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { WebAuthnRelyingParty } from '@flint/policy';
import pg from 'pg';
import { failureOf } from '../dbcodes.js';
import { client, countRows, dumpDatabase, run, sha256File, targetOf, ToolFailed, type PgTarget, type Tools } from './backup.js';
import { scramVerifier } from './bootstrap.js';
import { carryForward, readCurrent, type CarryReport, type CurrentFacts } from './carry.js';
import {
  LEGEND, OWNER, buildReference, catalogLines, checkoutMigrations, compareWithReference, counted, differenceLines, differenceSentence, migrationState, ownedByOthers, straySentence,
  type CatalogDifference, type Migration, type MigrationState,
} from './catalog.js';

export { VOIDED_BY_RESTORE } from './carry.js';

/**
 * Why a restore did not start, or stopped: a sentence for Will, then (in
 * `lines`) more sentences and any command he should run, each command on a line
 * of its own.
 */
export class RestoreRefused extends Error {
  readonly lines: string[];
  /** Where it stopped, for the record: a word, never data. */
  readonly stage: string;
  /** The runtime was stopped and did not start again. */
  readonly runtimeDown: boolean;
  /** Its sentence already says what was changed and what was not: "Nothing was changed" is never added to it. */
  readonly asIs: boolean;
  constructor(message: string, o: { lines?: string[]; stage?: string; runtimeDown?: boolean; asIs?: boolean } = {}) {
    super(message);
    this.lines = o.lines ?? [];
    this.stage = o.stage ?? 'refused';
    this.runtimeDown = o.runtimeDown ?? false;
    this.asIs = o.asIs ?? false;
  }
}

/** A nightly dump's name (dumpDatabase writes it): the only kind restored here. */
const DUMP_NAME = /^flint-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.dump$/;
/** A counts key as countRows writes it: `public."Proposal"` or `public.lower_name`. */
const COUNT_KEY = /^public\.("[A-Za-z_][A-Za-z0-9_]{0,62}"|[a-z_][a-z0-9_]{0,62})$/;
/** A database name this module may create, rename or drop: lower case, no quoting needed. */
const DB_NAME = /^[a-z][a-z0-9_]{0,62}$/;
/** Never a production name: Postgres's own databases. */
const RESERVED = new Set(['postgres', 'template0', 'template1']);
/** The time in a kept or scratch database's name: `20261012t150000z`. */
const STAMP = /(\d{4})(\d{2})(\d{2})t(\d{2})(\d{2})(\d{2})z$/;
const HEX64 = /^[0-9a-f]{64}$/;
/** How long a kept database, and a copy taken before a restore, is kept before a later restore removes it. */
export const KEEP_DAYS = 14;
/** Two numbers no other program on this cluster takes an advisory lock on: "FLNT", and this job. */
const LOCK = [0x464c4e54, 7] as const;
/** What repairs a database an earlier run left closed or renamed, and starts a runtime it left stopped. */
export const REPAIR = '  ~/flint/apps/studio/restore_database.sh --repair';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const quote = (name: string): string => `"${name.replace(/"/g, '""')}"`;
const withDatabase = (t: PgTarget, database: string): PgTarget => ({ ...t, database });
const urlOf = (base: string, database: string): string => {
  const u = new URL(base);
  u.pathname = `/${database}`;
  return u.toString();
};

/** What went wrong, as a class and a code: never a tool's or a database's own words (they can quote a row). */
export function reasonOf(err: unknown): string {
  if (err instanceof RestoreRefused) return err.stage;
  if (err instanceof ToolFailed) return `${err.tool}: ${err.summary}`;
  return failureOf(err);
}

async function withClient<T>(t: PgTarget, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = client(t);
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// The fingerprint beside a dump

/**
 * The key that seals fingerprint files (~/.flint/backup-fingerprint.key, 0600):
 * 32 random bytes, made the first time a backup is written. Without it a
 * fingerprint file proves nothing, since whoever can change a dump can write a
 * new hash beside it. Returns undefined when there is none (and `create` is
 * false), or when the file is not a plain one only its owner can read.
 */
function fingerprintKey(keyFile: string, create: boolean): Buffer | undefined {
  const read = (): Buffer | undefined => {
    let st;
    try {
      st = lstatSync(keyFile);
    } catch {
      return undefined;
    }
    if (!st.isFile() || st.uid !== process.getuid?.() || st.mode & 0o077) return undefined;
    const hex = readFileSync(keyFile, 'utf8').trim();
    return HEX64.test(hex) ? Buffer.from(hex, 'hex') : undefined;
  };
  const have = read();
  if (have || !create || existsSync(keyFile)) return have;
  mkdirSync(dirname(keyFile), { recursive: true, mode: 0o700 });
  try {
    const fd = openSync(keyFile, 'wx', 0o600);
    try {
      writeSync(fd, `${randomBytes(32).toString('hex')}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Another run made it first: read theirs.
  }
  return read();
}

const hashOf = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');
/** What the key signs: the dump's name (which holds its time), its hash, and the hash of the counts beside it. */
const seal = (key: Buffer, name: string, sha256: string, counts: string): string =>
  createHmac('sha256', key).update(`flint dump fingerprint v1\n${name}\n${sha256}\n${counts}\n`).digest('hex');

/**
 * Write the fingerprint file beside a dump: its sha256, the sha256 of its counts
 * file, and both sealed with the key in `keyFile` (made if it is not there).
 * 0600, like the dump.
 */
export function writeDumpHash(dump: string, sha256: string, keyFile: string): void {
  if (!HEX64.test(sha256)) throw new Error('not a sha256');
  const key = fingerprintKey(keyFile, true);
  if (!key) throw new Error('the fingerprint key is not a file only its owner can read');
  const countsFile = `${dump}.counts.json`;
  const counts = existsSync(countsFile) ? hashOf(countsFile) : '-';
  writeFileSync(`${dump}.sha256`, `${sha256}\ncounts ${counts}\nhmac ${seal(key, basename(dump), sha256, counts)}\n`, { mode: 0o600 });
}

export interface DumpCheck {
  path: string;
  bytes: number;
  sha256: string;
  /** `matches`: a fingerprint recorded when the dump was written matches it. `none`: none was recorded, and that was allowed. */
  fingerprint: 'matches' | 'none';
  /** Row counts taken in the dump's own snapshot; undefined when the file came without them and that was allowed. */
  counts?: Record<string, number>;
  /** When the dump was taken (its name says). */
  takenAt: Date;
}

export interface DumpCheckOptions {
  /** The key fingerprint files are sealed with. Without it the file beside a dump is compared but does not count as recorded. */
  keyFile?: string;
  /**
   * Fingerprints recorded somewhere else when the dump was written: its
   * BackupRun rows, or the one a rebuild's bundle lists. EVERY one must match.
   */
  recorded?: readonly string[];
  /** Go on although no fingerprint was recorded anywhere (Will's `--without-fingerprint`). */
  withoutFingerprint?: boolean;
  /** Accept a dump with no counts file (an offsite copy made before the counts went offsite too). */
  countsOptional?: boolean;
}

/**
 * Is this file a whole, untouched nightly dump? Checked before anything reads
 * it, pg_restore included: its name, that it is a plain file of Will's own that
 * no one else may change, and its fingerprint against every record of it. Then
 * that pg_restore can read its table of contents, and its counts file.
 */
export async function checkDump(dump: string, tools: Tools, opts: DumpCheckOptions = {}): Promise<DumpCheck> {
  if (!dump.startsWith('/')) throw new RestoreRefused('The backup must be named by its full path.', { stage: 'dump' });
  const named = DUMP_NAME.exec(basename(dump));
  const notOurs = () => new RestoreRefused("That is not one of Flint's nightly database backups.", { stage: 'dump' });
  if (!named) throw notOurs();
  const takenAt = new Date(`${named[1]}T${named[2]}:${named[3]}:${named[4]}.${named[5]}Z`);
  if (Number.isNaN(takenAt.getTime())) throw notOurs();
  let st;
  try {
    st = lstatSync(dump);
  } catch {
    throw new RestoreRefused('That backup file does not exist.', { stage: 'dump' });
  }
  if (!st.isFile()) throw new RestoreRefused('That backup is not a plain file.', { stage: 'dump' });
  if (st.uid !== process.getuid?.()) throw new RestoreRefused('That backup file is not yours, so Flint will not restore it.', { stage: 'dump' });
  if (st.mode & 0o022) throw new RestoreRefused('Someone other than you could have changed that backup file, so Flint will not restore it.', { stage: 'dump' });
  if (st.size === 0) throw new RestoreRefused('That backup file is empty.', { stage: 'dump' });

  const sha256 = await sha256File(dump);
  const changed = () => new RestoreRefused('That backup file has changed since it was written. Choose another backup.', { stage: 'fingerprint' });
  let recorded = 0;

  // 1. The file beside it. Its hash must match whatever else is true of it; it counts as a record only when this Mac's key sealed it.
  const sidecar = `${dump}.sha256`;
  const countsFile = `${dump}.counts.json`;
  if (existsSync(sidecar)) {
    const unreadable = () => new RestoreRefused('The fingerprint saved with that backup is not readable.', { stage: 'fingerprint' });
    if (!lstatSync(sidecar).isFile()) throw unreadable();
    const [first, ...rest] = readFileSync(sidecar, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
    if (!first || !HEX64.test(first)) throw unreadable();
    if (first !== sha256) throw changed();
    const field = (name: string): string | undefined => rest.find((l) => l.startsWith(`${name} `))?.slice(name.length + 1);
    const mac = field('hmac');
    const counts = field('counts');
    const key = opts.keyFile ? fingerprintKey(opts.keyFile, false) : undefined;
    if (mac !== undefined && key) {
      if (!HEX64.test(mac) || counts === undefined || !(counts === '-' || HEX64.test(counts))) throw unreadable();
      const want = Buffer.from(seal(key, basename(dump), sha256, counts), 'hex');
      const sealed = timingSafeEqual(want, Buffer.from(mac, 'hex'));
      // A seal this Mac's key did not make is a refusal, unless Will has said to go on without a fingerprint: then it
      // is no record at all. (The key is made new when Flint is rebuilt on the same Mac, and the dumps from before
      // are still his: without this, losing the key would leave every one of them unrestorable.)
      if (!sealed && !opts.withoutFingerprint) {
        throw new RestoreRefused("The fingerprint saved with that backup was not written by this Mac's Flint. Choose another backup.", {
          stage: 'fingerprint',
          lines: ["If this Mac's Flint was rebuilt since that backup, its fingerprints can no longer be checked. To restore it all the same, add --without-fingerprint to the command."],
        });
      }
      if (sealed) {
        const countsNow = existsSync(countsFile) ? hashOf(countsFile) : '-';
        if (counts !== countsNow) throw new RestoreRefused('The row counts beside that backup have changed since they were written. Choose another backup.', { stage: 'fingerprint' });
        recorded += 1;
      }
    }
  }
  // 2. Every other record of it.
  for (const r of opts.recorded ?? []) {
    if (!HEX64.test(r)) throw new RestoreRefused('A fingerprint recorded for that backup is not readable.', { stage: 'fingerprint' });
    if (r !== sha256) throw changed();
    recorded += 1;
  }
  if (recorded === 0 && !opts.withoutFingerprint) {
    throw new RestoreRefused('No fingerprint was recorded for that backup, so Flint cannot tell whether it has been changed. Nothing was restored.', {
      stage: 'fingerprint',
      lines: ['To restore it all the same, add --without-fingerprint to the command.'],
    });
  }

  try {
    await run(tools.pgRestore, ['--list', dump], '');
  } catch (err) {
    // A tool that could not be started at all is a fault of this Mac, not of the file.
    if (!(err instanceof ToolFailed)) throw err;
    if (/unsupported version/.test(err.summary)) {
      throw new RestoreRefused('That backup was made by a newer Postgres than this Mac has, so it cannot be read here. Update Postgres, then run this again.', { stage: 'dump' });
    }
    throw new RestoreRefused('That backup file is damaged. Choose another backup.', { stage: 'dump' });
  }

  const fingerprint = recorded > 0 ? 'matches' : 'none';
  if (!existsSync(countsFile)) {
    if (!opts.countsOptional) throw new RestoreRefused('That backup has no row counts beside it, so Flint could not check what it restored.', { stage: 'dump' });
    return { path: dump, bytes: st.size, sha256, fingerprint, takenAt };
  }
  const unreadable = () => new RestoreRefused('The row counts beside that backup are not readable.', { stage: 'dump' });
  let counts: Record<string, number>;
  try {
    counts = JSON.parse(readFileSync(countsFile, 'utf8')) as Record<string, number>;
  } catch {
    throw unreadable();
  }
  const entries = counts && typeof counts === 'object' && !Array.isArray(counts) ? Object.entries(counts) : [];
  if (entries.length === 0 || entries.some(([k, n]) => !COUNT_KEY.test(k) || !Number.isSafeInteger(n) || n < 0)) throw unreadable();
  return { path: dump, bytes: st.size, sha256, fingerprint, counts, takenAt };
}

// ---------------------------------------------------------------------------
// The roles and the reference

const APP_ROLES = ['flint_app', 'flint_approver', 'flint_backup'] as const;

/**
 * What is wrong with the cluster's roles for a restore, each a short phrase;
 * empty when nothing is. `restorer` is the role that will restore the copy.
 */
export async function roleProblems(c: pg.Client, restorer: string): Promise<string[]> {
  const rows = (await c.query<{ rolname: string; rolsuper: boolean; rolcreaterole: boolean; rolcreatedb: boolean; rolbypassrls: boolean }>(
    'SELECT rolname, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls FROM pg_roles WHERE rolname = ANY($1)',
    [[OWNER, restorer, ...APP_ROLES]],
  )).rows;
  const by = new Map(rows.map((r) => [r.rolname, r]));
  const problems: string[] = [];
  for (const role of [OWNER, restorer, ...APP_ROLES]) if (!by.has(role)) problems.push(`the role ${role} does not exist`);
  for (const role of APP_ROLES) {
    const r = by.get(role);
    if (r && (r.rolsuper || r.rolcreaterole || r.rolcreatedb || r.rolbypassrls)) problems.push(`${role} has more power than an application role may`);
  }
  const owner = by.get(OWNER);
  if (owner && !owner.rolcreatedb) problems.push(`${OWNER} may not create databases`);
  if (owner && (owner.rolsuper || owner.rolcreaterole || owner.rolbypassrls)) problems.push(`${OWNER} has more power than the migration owner may`);
  const r = by.get(restorer);
  if (r && (r.rolsuper || r.rolcreaterole || r.rolbypassrls)) problems.push(`${restorer} has more power than a role that restores backups may`);
  if (r && !r.rolcreatedb) problems.push(`${restorer} may not create databases`);
  if (restorer === OWNER || (APP_ROLES as readonly string[]).includes(restorer)) problems.push('the role that restores backups must be one of its own');
  return problems;
}

interface Grant {
  /** A role's name, or null for everyone (PUBLIC). */
  grantee: string | null;
  privilege: string;
  grantable: boolean;
}
const DB_PRIVILEGES = new Set(['CONNECT', 'TEMPORARY', 'CREATE']);

/** The privileges on a database itself, its owner's own left out. */
async function databaseGrants(c: pg.Client, database: string): Promise<Grant[]> {
  return (await c.query<Grant>(
    `SELECT CASE WHEN a.grantee = 0 THEN NULL ELSE pg_get_userbyid(a.grantee) END AS grantee, a.privilege_type AS privilege, a.is_grantable AS grantable
     FROM pg_database d, LATERAL aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) a
     WHERE d.datname = $1 AND a.grantee <> d.datdba`,
    [database],
  )).rows.filter((g) => DB_PRIVILEGES.has(g.privilege));
}

/** A database built from this checkout's migrations: every line that says how it behaves, and the privileges on the database itself. */
interface Reference {
  lines: string[];
  /** The same lines read before the dump and restore: how a database that has never been through one reads. */
  raw: string[];
  grants: Grant[];
}
/** Kept for this process: the same migrations on the same server always give the same reference. */
const references = new Map<string, Reference>();

/**
 * The reference for `applied`: a database of its own (`name`), made as the
 * migration owner from the bare template and built from this checkout's
 * migrations; then dumped and restored once, so that it is compared like with
 * like. (Postgres does not write an expression back exactly as it was typed: a
 * CHECK or a view that has been through a dump reads slightly differently from
 * one that has not, and every backup has been through one.) Read, and dropped.
 */
async function referenceOf(main: pg.Client, owner: PgTarget, name: string, applied: readonly Migration[], locale: string, tools: Tools, stopIfAsked: () => void = () => {}): Promise<Reference> {
  const key = `${owner.host}:${owner.port}|${createHash('sha256').update(applied.map((m) => `${m.name}:${m.checksum}`).join('\n')).digest('hex')}`;
  const have = references.get(key);
  if (have) return have;
  const fresh = async (): Promise<void> => {
    await main.query(`DROP DATABASE IF EXISTS ${name}`);
    await main.query(`CREATE DATABASE ${name} TEMPLATE template0${locale}`);
    // As on a Mac bootstrap-db set up: the public schema belongs to the migration owner.
    await withClient(withDatabase(owner, name), (c) => c.query(`ALTER SCHEMA public OWNER TO ${OWNER}`));
  };
  const dir = mkdtempSync(join(tmpdir(), 'flint-reference-'));
  const on = ['-h', owner.host, '-p', String(owner.port), '-U', owner.user, '-d', name];
  try {
    // Between the steps: was this run asked to stop? (It throws, and what was made so far is removed below.)
    await fresh();
    await withClient(withDatabase(owner, name), (c) => buildReference(c, applied));
    stopIfAsked();
    // The privileges on the database itself are set by the first migration and live on the cluster: read before the round trip.
    const grants = await databaseGrants(main, name);
    const raw = await withClient(withDatabase(owner, name), catalogLines);
    const file = join(dir, 'reference.dump');
    stopIfAsked();
    await run(tools.pgDump, ['-Fc', '--schema-only', ...on, '-f', file], owner.password);
    stopIfAsked();
    await fresh();
    await run(tools.pgRestore, ['--no-owner', '--exit-on-error', ...on, file], owner.password);
    stopIfAsked();
    await setDatabaseGrants(main, name, grants);
    const made = { lines: await withClient(withDatabase(owner, name), catalogLines), raw, grants };
    references.set(key, made);
    return made;
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await main.query(`DROP DATABASE IF EXISTS ${name}`).catch(() => undefined);
  }
}

/**
 * Make the privileges on `database` exactly `grants`: for everyone, for the
 * application roles, for every role named in `grants`, and for EVERY role that
 * holds anything on it now. The last is what makes it exact: a backup's SQL
 * runs as the owner of its own copy and can give a right on that copy to any
 * role already on the server, and the hand-over would pass that right on to
 * the database in use. The owner's own rights are made whole again too.
 */
async function setDatabaseGrants(main: pg.Client, database: string, grants: readonly Grant[]): Promise<void> {
  const held = (await databaseGrants(main, database)).map((g) => g.grantee);
  const who = new Set<string | null>([null, ...APP_ROLES, ...grants.map((g) => g.grantee), ...held]);
  for (const g of who) await main.query(`REVOKE ALL ON DATABASE ${database} FROM ${g === null ? 'PUBLIC' : quote(g)} CASCADE`);
  const owner = (await main.query<{ owner: string }>('SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = $1', [database])).rows[0]?.owner;
  if (owner) await main.query(`GRANT ALL ON DATABASE ${database} TO ${quote(owner)}`);
  for (const g of grants) await main.query(`GRANT ${g.privilege} ON DATABASE ${database} TO ${g.grantee === null ? 'PUBLIC' : quote(g.grantee)}${g.grantable ? ' WITH GRANT OPTION' : ''}`);
}

/**
 * What `verifyRestored` compares a copy with: the reference for the migrations
 * the copy records, built (once) as the migration owner at `ownerUrl` under the
 * database name `name`, through the maintenance session `main`.
 */
export function referenceBuilder(main: pg.Client, ownerUrl: string, name: string, tools: Tools): (applied: readonly Migration[]) => Promise<string[]> {
  if (!DB_NAME.test(name)) throw new Error('not a database name');
  return async (applied) => (await referenceOf(main, targetOf(ownerUrl), name, applied, '', tools)).lines;
}

export interface Verified {
  ok: boolean;
  tables: number;
  mismatches: Array<{ table: string; expected: number; restored: number | null }>;
  /** What is wrong, each a short phrase; empty when nothing is. */
  problems: string[];
  migrations: MigrationState;
  /** Every way it is not built as this checkout builds a database, when there is any: the whole list, grouped. */
  difference?: CatalogDifference;
  /** Migrations it already has in place though its record does not list them (catalog.ts, ALREADY_BY_HAND). */
  byHand: string[];
}

/**
 * Is the copy `c` is connected to what the backup said it was, and built as
 * this checkout builds a Flint database?
 *  - every table's row count equals the count taken in the dump's snapshot
 *    (`counts` undefined skips this: after a migration the tables have changed);
 *  - the migrations it records are this checkout's own, each finished;
 *  - everything that decides how it behaves equals the reference `reference`
 *    gives for those migrations (./catalog.ts);
 *  - when `owner` is given: everything in it belongs to that role, and the roles
 *    in `strangers` hold and have granted nothing.
 */
export async function verifyRestored(
  c: pg.Client,
  o: { counts?: Record<string, number>; migrationsDir: string; reference(applied: readonly Migration[]): Promise<string[]>; owner?: string; strangers?: readonly string[] },
): Promise<Verified> {
  const problems: string[] = [];
  let mismatches: Verified['mismatches'] = [];
  if (o.counts) {
    const restored = await countRows(c);
    mismatches = Object.entries(o.counts)
      .filter(([table, n]) => restored[table] !== n)
      .map(([table, n]) => ({ table, expected: n, restored: restored[table] ?? null }));
    const extra = Object.keys(restored).filter((t) => !(t in o.counts!));
    if (mismatches.length) problems.push(`row counts differ in ${counted(mismatches.length, 'table')}`);
    if (extra.length) problems.push(`it holds ${counted(extra.length, 'table')} the backup did not list`);
  }
  const migrations = await migrationState(c, o.migrationsDir);
  problems.push(...migrations.problems);
  // A record that is not ours gives no reference to compare with: it is refused on that alone.
  let difference: CatalogDifference | undefined;
  let byHand: string[] = [];
  if (migrations.problems.length === 0) {
    const compared = await compareWithReference(await catalogLines(c), migrations, o.migrationsDir, o.reference);
    byHand = compared.byHand;
    if (compared.difference.objects.length) {
      difference = compared.difference;
      problems.push(`it is not built the way this copy of Flint builds its database (${differenceSentence(difference)})`);
    }
  }
  if (o.owner) {
    const others = await ownedByOthers(c, o.owner, o.strangers ?? []);
    if (others.length) problems.push(`${counted(others.length, 'thing')} in it ${others.length === 1 ? 'does' : 'do'} not belong to the migration owner, ${others.length > 3 ? 'among them' : 'namely'} ${listed(others.slice(0, 3))}`);
  }
  return { ok: problems.length === 0, tables: o.counts ? Object.keys(o.counts).length : 0, mismatches, problems, migrations, ...(difference ? { difference } : {}), byHand };
}

/** The whole list behind "not built the way this copy of Flint builds its database", when the sentence had to cut it short. */
const fullList = (v: Verified): string[] => (v.difference && v.difference.objects.length > 3 ? [LEGEND, 'Every difference:', ...differenceLines(v.difference)] : []);

// ---------------------------------------------------------------------------
// The database's own settings (they live on the cluster, and a dump does not carry them)

/** Who the migrations decide for; everyone else's privileges on the database are Will's own additions. */
const SPEC_GRANTEES = new Set<string | null>([null, ...APP_ROLES]);
const grantKey = (g: Grant): string => `${g.grantee ?? 'everyone'} ${g.privilege}`;

/**
 * Give `copy` the privileges the migrations give a Flint database (`spec`, read
 * from a reference) for everyone and the application roles, plus whatever else
 * `production` grants to other roles (Will's own additions). Gives back the
 * whole list it set: what the copy must hold, and all it may.
 */
async function carryDatabaseGrants(main: pg.Client, copy: string, spec: readonly Grant[], production: readonly Grant[] | undefined, skip: readonly string[]): Promise<Grant[]> {
  const wanted = [
    ...spec.filter((g) => SPEC_GRANTEES.has(g.grantee)),
    ...(production ?? []).filter((g) => !SPEC_GRANTEES.has(g.grantee) && !skip.includes(g.grantee!)),
  ];
  await setDatabaseGrants(main, copy, wanted);
  return wanted;
}

/** The rights in `held` that `wanted` does not list, exactly as held (a right to pass one on counts). */
export function grantsBeyond(wanted: readonly Grant[], held: readonly Grant[]): Grant[] {
  const listed = new Set(wanted.map((g) => `${grantKey(g)} ${g.grantable}`));
  return held.filter((g) => !listed.has(`${grantKey(g)} ${g.grantable}`));
}

/** A role's name as a sentence can hold it. */
const plainRole = (name: string | null): string => (name === null ? 'everyone' : name.replace(/[^\w.]/g, '?').slice(0, 63));
/** "CONNECT", "CONNECT and CREATE", "CONNECT, CREATE and TEMPORARY". */
const listed = (xs: readonly string[]): string => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/** How the two voices differ: a restore that is happening, and a comparison that says what one would do. */
const VOICES = {
  restore: { where: 'The database in use gives', lacks: 'The database in use does not give', follows: 'The restored database follows Flint\'s setup.', has: 'The restored database gives it.', keeps: 'The restored database keeps' },
  compare: { where: 'This database gives', lacks: 'This database does not give', follows: 'A restored database follows Flint\'s setup.', has: 'A restored database gives it.', keeps: 'A restored database keeps' },
} as const;

/**
 * Where the database in use differs from what the restored one WILL have once
 * it is in use (`end`: Flint's own setup for this checkout's whole list of
 * migrations, the pending ones included), as sentences. Said about the end
 * state and nothing before it: a right the copy has for a moment, until a
 * pending update takes it away, is nothing Will is left with.
 *
 * And every right on the database itself that another role holds there: no
 * part of Flint's setup, so Will's own addition, which a restore carries over.
 * It is said by name, so that a role he did not mean to let in is one he sees.
 */
function databaseGrantNotes(end: readonly Grant[], production: readonly Grant[] | undefined, skip: readonly string[], voice: keyof typeof VOICES = 'restore'): string[] {
  if (!production) return [];
  const v = VOICES[voice];
  const endKeys = new Map(end.filter((g) => SPEC_GRANTEES.has(g.grantee)).map((g) => [grantKey(g), g]));
  // What Flint's setup decides: everyone, the application roles, and the roles a restore itself works as (which get nothing).
  const flints = (g: Grant): boolean => SPEC_GRANTEES.has(g.grantee) || skip.includes(g.grantee ?? '');
  const prod = production.filter(flints);
  const prodKeys = new Set(prod.map(grantKey));
  const notes: string[] = [];
  for (const g of prod) if (!endKeys.has(grantKey(g))) notes.push(`${v.where} ${plainRole(g.grantee)} the privilege ${g.privilege}, which Flint's own setup does not. ${v.follows}`);
  for (const [k, g] of endKeys) if (!prodKeys.has(k)) notes.push(`${v.lacks} ${plainRole(g.grantee)} the privilege ${g.privilege}, which Flint's own setup does. ${v.has}`);
  const theirs = production.filter((g) => !flints(g));
  for (const role of [...new Set(theirs.map((g) => g.grantee!))].sort()) {
    const of = theirs.filter((g) => g.grantee === role);
    const privileges = [...new Set(of.map((g) => g.privilege))].sort();
    const one = privileges.length === 1;
    const passes = of.some((g) => g.grantable) ? `, with the right to pass ${one ? 'it' : 'them'} on` : '';
    notes.push(`${v.where} the role ${plainRole(role)} the privilege${one ? '' : 's'} ${listed(privileges)}${passes}, which ${one ? 'is' : 'are'} no part of Flint's own setup. ${v.keeps} ${one ? 'it' : 'them'} as your own addition.`);
  }
  return notes;
}

/** Settings whose value is a list of names, which Postgres wants unquoted as a whole (as pg_dump writes them). */
const LIST_SETTINGS = new Set(['search_path', 'temp_tablespaces', 'session_preload_libraries', 'local_preload_libraries']);

/**
 * Copy the settings stored for the production database (ALTER DATABASE ... SET)
 * onto `copy`. One stored for a single role there needs a superuser to copy, so
 * it is reported instead, like any setting that does not copy.
 */
async function carryDatabaseSettings(main: pg.Client, production: string, copy: string): Promise<string[]> {
  const rows = (await main.query<{ role: string | null; config: string[] }>(
    `SELECT CASE WHEN s.setrole = 0 THEN NULL ELSE pg_get_userbyid(s.setrole) END AS role, s.setconfig AS config
     FROM pg_db_role_setting s JOIN pg_database d ON d.oid = s.setdatabase WHERE d.datname = $1`,
    [production],
  )).rows;
  const notes: string[] = [];
  const left = (name: string, role: string | null) =>
    notes.push(`The database in use has a setting Flint could not copy to the restored one: ${name.replace(/[^\w.]/g, '?').slice(0, 60)}${role ? ` for ${role.replace(/[^\w]/g, '?').slice(0, 63)}` : ''}. Set it again afterwards if you still want it.`);
  for (const row of rows) {
    for (const entry of row.config ?? []) {
      const at = entry.indexOf('=');
      const name = at > 0 ? entry.slice(0, at) : '';
      const value = at > 0 ? entry.slice(at + 1) : '';
      if (!/^[a-z_][a-z0-9_.]{0,62}$/.test(name) || row.role !== null) {
        left(name || 'one', row.role);
        continue;
      }
      // A list of names goes in as it is stored, and only when it is nothing but names; anything else as one quoted value.
      const literal = LIST_SETTINGS.has(name) ? (/^[A-Za-z0-9_$", ]*$/.test(value) ? value : undefined) : `'${value.replace(/'/g, "''")}'`;
      try {
        if (literal === undefined || /[\0\n\r]/.test(value)) throw new Error('not copied');
        await main.query(`ALTER DATABASE ${copy} SET ${name} = ${literal}`);
      } catch {
        left(name, null);
      }
    }
  }
  return notes;
}

// ---------------------------------------------------------------------------
// The cluster, as it is

interface DbRow {
  /** The database's own id: it stays the same when the name changes. */
  oid: string;
  datname: string;
  open: boolean;
  owner: string;
}
interface ClusterState {
  production?: DbRow;
  /** Kept databases (`<name>_damaged_<time>`), oldest first. */
  kept: DbRow[];
  /** Copies and references left by a run that did not finish. */
  stale: DbRow[];
}

async function clusterState(c: pg.Client, database: string): Promise<ClusterState> {
  const rows = (await c.query<DbRow>(
    `SELECT oid::text AS oid, datname, datallowconn AS open, pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = $1 OR left(datname, $2) = $3 ORDER BY datname`,
    [database, database.length + 1, `${database}_`],
  )).rows;
  const named = (kind: string) => rows.filter((r) => new RegExp(`^${database}_${kind}_\\d{8}t\\d{6}z$`).test(r.datname));
  return { ...(rows.find((r) => r.datname === database) ? { production: rows.find((r) => r.datname === database)! } : {}), kept: named('damaged'), stale: [...named('restoring'), ...named('reference')] };
}

/** A session on the cluster's maintenance database, where databases are created and renamed from. */
async function maintenance(t: PgTarget): Promise<pg.Client> {
  let last: unknown;
  for (const database of ['postgres', 'template1']) {
    const c = client(withDatabase(t, database));
    try {
      await c.connect();
      return c;
    } catch (err) {
      last = err;
      await c.end().catch(() => {});
    }
  }
  throw new RestoreRefused(`Flint could not reach the database server (${failureOf(last)}).`, { stage: 'connect' });
}

async function onMaintenance<T>(t: PgTarget, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = await maintenance(t);
  try {
    return await fn(c);
  } finally {
    await c.end().catch(() => {});
  }
}

/**
 * The encoding and locale of `database`, as CREATE DATABASE takes them, so a
 * copy sorts and stores text the same way: whichever of Postgres's three ways
 * of sorting the database was made with (the operating system's, ICU's, or
 * Postgres's own), with the names it was given. `copied` is false when what it
 * has cannot be written into a statement (a name with odd characters, sorting
 * rules of its own): the copy then takes the server's defaults, and a restore
 * and `--compare` both say so.
 */
async function localeOf(c: pg.Client, database: string): Promise<string> {
  return (await localeFacts(c, database)).clause;
}

interface LocaleFacts {
  clause: string;
  /** The clause says everything the database has; false when the copy would take the server's defaults instead. */
  copied: boolean;
  /** In words, for a sentence: `UTF8, sorted by ICU as en-US`. */
  words: string;
}

async function localeFacts(c: pg.Client, database: string): Promise<LocaleFacts> {
  const r = (await c.query<{ enc: string; collate: string; ctype: string; provider: string; locale: string | null; rules: string | null }>(
    `SELECT pg_encoding_to_char(encoding) AS enc, datcollate AS collate, datctype AS ctype, datlocprovider::text AS provider, datlocale AS locale, daticurules AS rules
     FROM pg_database WHERE datname = $1`,
    [database],
  )).rows[0];
  const plain = /^[A-Za-z0-9_.@-]{1,60}$/;
  if (!r) return { clause: '', copied: false, words: 'unknown' };
  const how = r.provider === 'i' ? `ICU as ${r.locale ?? 'its default'}` : r.provider === 'b' ? `Postgres itself as ${r.locale ?? 'its default'}` : `the system as ${r.collate}`;
  const words = `${r.enc}, sorted by ${how}`.replace(/[^\w .,@-]/g, '?').slice(0, 120);
  if (!plain.test(r.enc) || !plain.test(r.collate) || !plain.test(r.ctype)) return { clause: '', copied: false, words };
  const base = ` ENCODING '${r.enc}' LC_COLLATE '${r.collate}' LC_CTYPE '${r.ctype}'`;
  if (r.provider === 'c') return { clause: base, copied: true, words };
  if (!r.locale || !plain.test(r.locale) || r.rules) return { clause: '', copied: false, words };
  if (r.provider === 'i') return { clause: `${base} LOCALE_PROVIDER icu ICU_LOCALE '${r.locale}'`, copied: true, words };
  if (r.provider === 'b') return { clause: `${base} LOCALE_PROVIDER builtin BUILTIN_LOCALE '${r.locale}'`, copied: true, words };
  return { clause: '', copied: false, words };
}

/** Who is connected to `name` besides this session, in words: `flint_app (3 connections)`. */
async function connected(c: pg.Client, name: string): Promise<string[]> {
  const rows = (await c.query<{ who: string | null; app: string | null; n: string }>(
    `SELECT usename AS who, nullif(application_name, '') AS app, count(*) AS n FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid() GROUP BY 1, 2 ORDER BY 1, 2`,
    [name],
  )).rows;
  const safe = (s: string) => s.replace(/[^\w .:@/-]/g, '?').slice(0, 60);
  return rows.map((r) => `${safe(r.who ?? 'an unknown role')}${r.app ? ` (${safe(r.app)})` : ''}, ${r.n} connection${r.n === '1' ? '' : 's'}`);
}

// ---------------------------------------------------------------------------
// The role that restores, before and after a backup's SQL has run as it

/** What the restoring role is on the cluster: the databases it owns, and the settings stored for it (kept as they are stored, never shown). */
interface RestorerState {
  databases: string[];
  settings: Array<{ database: string | null; config: string }>;
}

async function restorerState(c: pg.Client, role: string): Promise<RestorerState> {
  const databases = (await c.query<{ datname: string }>('SELECT datname FROM pg_database WHERE datdba = $1::regrole ORDER BY 1', [role])).rows.map((r) => r.datname);
  const settings = (await c.query<{ database: string | null; config: string }>(
    `SELECT d.datname AS database, array_to_string(s.setconfig, chr(10)) AS config
     FROM pg_db_role_setting s LEFT JOIN pg_database d ON d.oid = s.setdatabase WHERE s.setrole = $1::regrole ORDER BY 1 NULLS FIRST`,
    [role],
  )).rows;
  return { databases, settings };
}

/** Can this role still sign in with the password Flint has saved for it? Undefined: the server could not be asked. */
async function signsIn(t: PgTarget): Promise<boolean | undefined> {
  for (const database of ['postgres', 'template1']) {
    try {
      await withClient(withDatabase(t, database), (c) => c.query('SELECT 1'));
      return true;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === '28P01' || code === '28000') return false;
    }
  }
  return undefined;
}

/**
 * A backup's SQL runs as the role that restores it, in a database of its own.
 * Three things on the cluster are still within that role's reach, because a
 * role may always change them about itself: its password, the settings stored
 * for it, and what databases it makes. So after EVERY pg_restore, passed or
 * failed, each is looked at again and put back:
 *  - its password, through `guard`, a session of its own that was open before
 *    the backup's SQL ran (the verifier is sent, never the password);
 *  - its stored settings, cleared;
 *  - a database it made besides the copy, removed.
 * `changed` says what the backup did, in words; `unfixed` what could not be put
 * back. A Flint backup does none of this: any of it is a refusal.
 */
async function restorerAfter(
  m: pg.Client,
  guard: pg.Client | undefined,
  restorer: PgTarget,
  before: RestorerState,
  copy: string,
): Promise<{ changed: string[]; unfixed: Array<'password' | 'settings' | 'database'> }> {
  const changed: string[] = [];
  const unfixed: Array<'password' | 'settings' | 'database'> = [];
  const role = quote(restorer.user);
  // The guard first (it signed in before anything changed); a new session only if the guard is gone.
  const asRole = async (sql: string): Promise<boolean> => {
    if (guard && (await guard.query(sql).then(() => true, () => false))) return true;
    return onMaintenance(restorer, (c) => c.query(sql)).then(() => true, () => false);
  };

  if ((await signsIn(restorer)) === false) {
    changed.push('its password');
    const verifier = scramVerifier(restorer.password);
    const put = /^SCRAM-SHA-256\$\d+:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/.test(verifier) && (await asRole(`ALTER ROLE ${role} PASSWORD '${verifier}'`));
    if (!put || (await signsIn(restorer)) !== true) unfixed.push('password');
  }

  const key = (st: RestorerState): string => JSON.stringify(st.settings);
  let now = await restorerState(m, restorer.user);
  if (key(now) !== key(before)) {
    changed.push('its own settings');
    await asRole(`ALTER ROLE ${role} RESET ALL`);
    for (const row of now.settings) if (row.database !== null) await asRole(`ALTER ROLE ${role} IN DATABASE ${quote(row.database)} RESET ALL`);
    now = await restorerState(m, restorer.user);
    if (now.settings.length) unfixed.push('settings');
  }

  const made = now.databases.filter((d) => d !== copy && !before.databases.includes(d));
  if (made.length) {
    changed.push(made.length === 1 ? 'a database of its own' : `${made.length} databases of its own`);
    for (const d of made) {
      await m.query(`ALTER DATABASE ${quote(d)} IS_TEMPLATE false`).catch(() => undefined);
      if (!(await m.query(`DROP DATABASE IF EXISTS ${quote(d)}`).then(() => true, () => false)) && !unfixed.includes('database')) unfixed.push('database');
    }
  }
  return { changed, unfixed };
}

// ---------------------------------------------------------------------------
// The restore

export interface RestoreSummary {
  /** The backup's file name. */
  name: string;
  takenAt: Date;
  bytes: number;
  tables: number;
  fingerprint: DumpCheck['fingerprint'];
  /** The database that will be replaced, and the name it will be kept under. */
  database: string;
  keptAs: string;
  /** What will be in force, carried forward and set aside (./carry.ts). */
  report: CarryReport;
  /** Kept databases and copies from more than KEEP_DAYS ago that this restore removes. */
  removing: string[];
}

type AuditInputs = Record<string, string | number | boolean | null>;

export interface RestoreOptions {
  /** `production`: over the database in use. `rebuild`: into the empty one a rebuild made. */
  mode: 'production' | 'rebuild';
  dump: string;
  /** flint_owner on the production database. */
  owner: string;
  /** flint_app on the production database. */
  app: string;
  /** flint_restore, on any database it may connect to: the role the backup is restored as. */
  restore: string;
  /** flint_backup on the production database: the copy taken first. */
  backup?: string;
  /** Where that copy goes (~/FlintBackups/pre-restore). */
  copyDir?: string;
  /** Restore although the copy of the current database could not be taken. */
  withoutCopy?: boolean;
  /** Restore a dump no fingerprint was recorded for. */
  withoutFingerprint?: boolean;
  /** Fingerprints recorded for the dump outside the database (a rebuild's bundle). */
  recorded?: readonly string[];
  /** The key fingerprint files are sealed with. */
  keyFile?: string;
  tools: Tools;
  migrationsDir: string;
  /** Apply this checkout's pending migrations to the database at `ownerUrl` (prisma migrate deploy). */
  migrate(ownerUrl: string): Promise<void>;
  /** Will's typed confirmation; false leaves everything as it was. Not asked for a trial run or a rebuild. */
  confirm?(summary: RestoreSummary): Promise<boolean>;
  /** A trial run: everything up to the confirmation, then the copy is dropped. Nothing in use is touched. */
  checkOnly?: boolean;
  stopRuntime(): Promise<void>;
  /** Start the runtime and return only once it is really running. */
  startRuntime(): Promise<void>;
  /** The passkey settings signatures are verified against. */
  rp?: WebAuthnRelyingParty;
  say(line: string): void;
  /** Names the scratch and kept databases; every time that is recorded is the real one. */
  now?: Date;
  /** How long to wait for other sessions to leave the production database (default 60 s). */
  drainMs?: number;
  /** The file that pauses updates (~/.flint/deploy-hold): made for as long as this runs. */
  holdFile?: string;
  /** Is an update being installed right now? */
  deployRunning?(): Promise<boolean> | boolean;
  /** Where Postgres keeps its data, to measure free space, when the server will not say. */
  dataDir?: string;
  /** Call `handler` when the process is asked to stop; the returned function stops listening. */
  onSignal?(handler: (signal: string) => void): () => void;
  /** End the process after an interruption before the swap (nothing in use was touched). */
  exit?(signal: string): void;
  /** One line for the local record (~/.flint/restore-log.jsonl): ids, hashes, numbers and fixed words. */
  record?(entry: AuditInputs): void;
  /** For tests: runs at a named point (`closed`: production is closed and nothing is renamed; `swapped`: the names have changed). */
  at?(point: 'closed' | 'swapped'): Promise<void> | void;
}

export interface RestoreResult {
  mode: RestoreOptions['mode'];
  /** The backup that was restored. */
  dump: string;
  sha256: string;
  fingerprint: DumpCheck['fingerprint'];
  /** Tables whose row counts were compared with the backup's own; 0 when it came without counts. */
  tables: number;
  /** Migrations this checkout has that the backup did not: applied to the copy. */
  pending: string[];
  report: CarryReport;
  seconds: number;
  database: string;
  /** A trial run: the copy passed and was dropped; nothing changed. */
  checkedOnly?: boolean;
  /** A rebuild run again: this same backup was already restored here, so nothing was done. */
  already?: boolean;
  /** The database that was in use, kept (closed) under this name. */
  keptAs?: string;
  /** The copy of it taken first, when one could be. */
  copy?: string;
  /** False when the restore is done and the runtime did not start again by itself. */
  runtimeStarted?: boolean;
  /** False when the restore is done and its audit entry could not be written. */
  audited?: boolean;
  /** Databases this run could not remove, by name. */
  leftovers: string[];
  /** Kept databases and copies from more than KEEP_DAYS ago, removed. */
  removed: string[];
}

/** An audit entry, written as the runtime's own role, with the time it is written. Ids, hashes, numbers and fixed words only. */
async function audit(app: PgTarget, row: { actor: string; context: string; tier: string | null; decision: string; outcome: string; inputs: AuditInputs }): Promise<void> {
  for (const v of Object.values(row.inputs)) if (typeof v === 'string' && v.length > 200) throw new Error('an audit input is over 200 characters');
  await withClient(app, (c) =>
    c.query(
      `INSERT INTO public."AuditEntry" (id, actor, context, kind, action, tier, inputs, decision, outcome)
       VALUES ($1, $2, $3, 'action', 'restore.production', $4, $5, $6, $7)`,
      [`au${Date.now().toString(36)}${randomBytes(6).toString('hex')}`, row.actor, row.context, row.tier, JSON.stringify(row.inputs), row.decision, row.outcome],
    ),
  );
}
/** Who ran it, truthfully: Will at the keyboard, or the rebuild script with no one asked. */
const actorOf = (mode: RestoreOptions['mode']) => (mode === 'production' ? { actor: 'will:cli', context: 'console', tier: 'approval' } : { actor: 'rebuild', context: 'deploy', tier: null });

/** How many tables, views and sequences the database holds outside Postgres's own schemas. */
async function userObjects(c: pg.Client): Promise<number> {
  const r = await c.query<{ n: string }>(`
    SELECT count(*) AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname !~ '^pg_' AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')`);
  return Number(r.rows[0]!.n);
}

/** Did an earlier rebuild already restore the backup with this fingerprint into this database? */
async function alreadyRestored(c: pg.Client, sha256: string): Promise<boolean> {
  const has = (await c.query<{ t: string | null }>(`SELECT to_regclass('public."AuditEntry"')::text AS t`)).rows[0]!.t;
  if (!has) return false;
  const r = await c.query(`SELECT 1 FROM public."AuditEntry" WHERE action = 'restore.production' AND outcome = 'ok' AND inputs->>'mode' = 'rebuild' AND inputs->>'sha256' = $1 LIMIT 1`, [sha256]);
  return (r.rowCount ?? 0) > 0;
}

/** The file that pauses updates, taken for this run unless one is already there (then it is someone else's, and left alone). */
function takeHold(file: string | undefined): () => void {
  if (!file || !existsSync(dirname(file))) return () => {};
  const mine = `restore ${process.pid} `;
  // A pause left by a restore that is no longer running is nobody's: the deploy job would lift it at its next tick
  // and then install an update across this restore. It is replaced by this run's own. Anyone else's pause (a
  // rollback's, one made by hand, a restore that is still running) is left exactly as it is.
  try {
    const held = /^restore (\d{1,10}) /.exec(readFileSync(file, 'utf8'));
    if (!held) return () => {};
    const pid = Number(held[1]);
    let alive = pid === process.pid;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch (err) {
      // EPERM: there is such a process, and it is someone else's. Anything else: no such process.
      alive = alive || (err as { code?: string }).code === 'EPERM';
    }
    if (alive) return () => {};
    unlinkSync(file);
  } catch {
    // No pause there (the usual case), or it went as it was read.
  }
  try {
    writeFileSync(file, `${mine}${new Date().toISOString()}\n`, { mode: 0o600, flag: 'wx' });
  } catch {
    return () => {};
  }
  return () => {
    try {
      if (readFileSync(file, 'utf8').startsWith(mine)) unlinkSync(file);
    } catch {
      // Gone already.
    }
  };
}

/** Kept databases and pre-restore copies older than KEEP_DAYS, which a later restore removes. */
function oldKept(state: ClusterState, now: number): string[] {
  return state.kept.filter((k) => {
    const m = STAMP.exec(k.datname);
    return m !== null && k.owner === OWNER && now - Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!) > KEEP_DAYS * 86_400_000;
  }).map((k) => k.datname);
}
function oldCopies(copyDir: string | undefined, now: number): string[] {
  if (!copyDir || !existsSync(copyDir)) return [];
  return readdirSync(copyDir).filter((f) => {
    const m = DUMP_NAME.exec(f);
    return m !== null && now - Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`) > KEEP_DAYS * 86_400_000;
  }).sort();
}

/**
 * Restore `o.dump` and put it into use (see the top of this file). Refused,
 * with nothing in use changed, at any step before the swap; after it the
 * database is the backup, whatever else is reported.
 */
export async function restoreDatabase(o: RestoreOptions): Promise<RestoreResult> {
  const started = Date.now();
  const stampAt = o.now ?? new Date();
  const owner = targetOf(o.owner);
  const app = targetOf(o.app);
  const restorer = targetOf(o.restore);
  const database = owner.database;
  if (!DB_NAME.test(database) || RESERVED.has(database)) throw new RestoreRefused("The production database's name is not one Flint can rename.", { stage: 'config' });
  const backup = o.backup ? targetOf(o.backup) : undefined;
  for (const t of [app, restorer, ...(backup ? [backup] : [])]) {
    if (t.host !== owner.host || t.port !== owner.port) throw new RestoreRefused("Flint's database settings do not all name the same database server, so it stopped.", { stage: 'config' });
  }
  if (app.database !== database || (backup && backup.database !== database)) throw new RestoreRefused("Flint's database settings do not all name the same database, so it stopped.", { stage: 'config' });
  const stamp = stampAt.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'z').toLowerCase();
  const scratch = `${database}_restoring_${stamp}`;
  const reference = `${database}_reference_${stamp}`;
  const keptAs = `${database}_damaged_${stamp}`;
  if (![scratch, reference, keptAs].every((n) => DB_NAME.test(n))) throw new RestoreRefused("The production database's name is too long to keep a copy under.", { stage: 'config' });
  const production = o.mode === 'production';
  const who = actorOf(o.mode);
  const notes: string[] = [];
  const leftovers: string[] = [];
  let sha: string | undefined;

  const releaseHold = takeHold(o.holdFile);
  /** Before the swap an interruption ends the run at once: nothing in use was touched, and the copy is removed by the next run. */
  let interrupted: string | undefined;
  let swapping = false;
  const off = o.onSignal?.((signal) => {
    interrupted = signal;
    if (!swapping) {
      releaseHold();
      o.exit?.(signal);
    }
  });

  /** Say it in the record that survives: the database in use when it can be written to, and the local file. */
  let recorded = false;
  const recordAttempt = async (outcome: 'ok' | 'failed' | 'skipped', inputs: AuditInputs): Promise<void> => {
    recorded = true;
    const entry = { mode: o.checkOnly ? 'check' : o.mode, ...(sha ? { sha256: sha } : {}), ...inputs };
    o.record?.({ outcome, ...entry });
    if (production) await audit(app, { ...who, decision: o.checkOnly ? 'log' : 'act', outcome, inputs: entry }).catch(() => undefined);
  };

  let main: pg.Client | undefined;
  try {
    if (await o.deployRunning?.()) throw new RestoreRefused('An update is being installed. Wait for it to finish, then run this again.', { stage: 'deploy' });
    main = await maintenance(owner);
    const locked = (await main.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1, $2) AS ok', [...LOCK])).rows[0]!.ok;
    if (!locked) throw new RestoreRefused('Another restore is running. Wait for it to finish.', { stage: 'lock' });
    const m = main;

    // 1. What the last run left.
    let state = await clusterState(m, database);
    if (!state.production) {
      if (state.kept.length) {
        throw new RestoreRefused(`There is no database named ${database}, and ${state.kept.at(-1)!.datname} is there: an earlier restore was stopped part-way.`, {
          stage: 'state', lines: ['Put it back with this command:', REPAIR],
        });
      }
      throw new RestoreRefused(production ? 'There is no production database to replace. A rebuild restores into an empty one.' : 'There is no database to restore into.', { stage: 'state' });
    }
    if (!state.production.open) {
      throw new RestoreRefused(`The database ${database} is closed to connections: an earlier restore was stopped part-way.`, { stage: 'state', lines: ['Open it again with this command:', REPAIR] });
    }
    const dropDatabase = async (name: string): Promise<boolean> => {
      try {
        // A backup's SQL could have marked its own copy a template, which Postgres will not drop: that mark goes first.
        await m.query(`ALTER DATABASE ${name} IS_TEMPLATE false`).catch(() => undefined);
        await m.query(`DROP DATABASE IF EXISTS ${name}`);
        return true;
      } catch {
        if (!leftovers.includes(name)) leftovers.push(name);
        return false;
      }
    };
    for (const s of state.stale) {
      if (await dropDatabase(s.datname)) o.say(`Flint removed ${s.datname}, left by an earlier restore that did not finish.`);
      else o.say(`Flint could not remove ${s.datname}, left by an earlier restore that did not finish.`);
    }

    // 2. The setup this needs.
    const setup = await roleProblems(m, restorer.user);
    if (state.production.owner !== OWNER) setup.push(`the database ${database} does not belong to ${OWNER}`);
    if (setup.length) throw new RestoreRefused(`Flint's database is not set up for a restore: ${setup.join('; ')}.`, { stage: 'setup' });
    const member = (await m.query<{ ok: boolean }>(`SELECT pg_has_role($1, $2, 'MEMBER') AS ok`, [OWNER, restorer.user])).rows[0]!.ok;
    if (!member) {
      // What it is for: a backup is restored by a role that owns nothing else, and the migration owner then takes over
      // what that role made. The command is printed only when it can be run exactly as printed.
      const plain = /^[a-z_][a-z0-9_]{0,62}$/.test(restorer.user);
      throw new RestoreRefused('A restore needs one database permission that has not been granted on this Mac yet. Nothing was changed.', {
        stage: 'setup',
        lines: plain
          ? ['Grant it once with this command, then run this again:', `  psql -d postgres -c 'GRANT ${restorer.user} TO ${OWNER}'`]
          : ['The role that restores backups has a name Flint cannot put in a command, so it printed none.'],
      });
    }
    for (const role of APP_ROLES) {
      const may = (await m.query<{ ok: boolean }>(`SELECT has_database_privilege($1, $2, 'CONNECT') AS ok`, [role, database])).rows[0]!.ok;
      if (!may) notes.push(`The role ${role} may not connect to the database in use. The restored database follows Flint's own setup.`);
    }
    // The saved passwords must still work: the runtime's, the backup role's, and the role that restores.
    const signIn = async (t: PgTarget, role: string): Promise<void> => {
      try {
        await withClient(t, (c) => c.query('SELECT 1'));
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === '28P01' || code === '28000') throw new RestoreRefused(`Flint's saved settings no longer let the role ${role} sign in to the database, so a restore could not be used. Nothing was changed.`, { stage: 'setup' });
        if (role === restorer.user) throw new RestoreRefused(`The role that restores backups could not reach the database server (${failureOf(err)}).`, { stage: 'setup' });
      }
    };
    if (production) await signIn(app, app.user);
    if (production && backup) await signIn(backup, backup.user);
    await signIn(withDatabase(restorer, m.database ?? 'postgres'), restorer.user);

    // 3. The backup itself, against every record of its fingerprint.
    const rows = production
      ? await withClient(owner, async (c) => (await c.query<{ sha256: string }>(`SELECT sha256 FROM public."BackupRun" WHERE path = $1 AND location = 'local' AND status = 'ok'`, [o.dump])).rows.map((r) => r.sha256)).catch(() => [] as string[])
      : [];
    const check = await checkDump(o.dump, o.tools, {
      ...(o.keyFile ? { keyFile: o.keyFile } : {}), recorded: [...(o.recorded ?? []), ...rows], ...(o.withoutFingerprint ? { withoutFingerprint: true } : {}), countsOptional: !production,
    });
    sha = check.sha256;
    if (production && !check.counts) throw new RestoreRefused('That backup has no row counts beside it, so Flint could not check what it restored.', { stage: 'dump' });

    // A rebuild restores only into the empty database it made. One that already holds this very backup is done.
    if (!production && (await withClient(owner, userObjects)) > 0) {
      if (!(await withClient(owner, (c) => alreadyRestored(c, check.sha256)))) throw new RestoreRefused('The database to restore into is not empty.', { stage: 'not-empty' });
      const again = await withClient(owner, async (c) => verifyRestored(c, { migrationsDir: o.migrationsDir, reference: async (applied) => (await referenceOf(m, owner, reference, applied, '', o.tools)).lines, owner: OWNER, strangers: [restorer.user] }));
      if (!again.ok) throw new RestoreRefused(`The database restored earlier does not pass its checks: ${again.problems.join('; ')}.`, { stage: 'verify' });
      const report = await withClient(owner, (c) => carryForward(c, { ...(o.rp ? { rp: o.rp } : {}), now: new Date() }));
      return { mode: o.mode, dump: o.dump, sha256: check.sha256, fingerprint: check.fingerprint, tables: 0, pending: again.migrations.pending, report, seconds: 0, database, already: true, leftovers, removed: [] };
    }

    // 4. Room: the restored copy sits beside the database it replaces, and a copy of that one is taken first.
    const size = Number((await m.query<{ n: string }>('SELECT pg_database_size($1) AS n', [database])).rows[0]!.n);
    const dataDir = (await m.query<{ d: string }>('SHOW data_directory').then((r) => r.rows[0]?.d, () => undefined)) ?? o.dataDir;
    const free = (dir: string | undefined): number | undefined => {
      try {
        if (!dir || !existsSync(dir)) return undefined;
        const s = statfsSync(dir);
        return s.bavail * s.bsize;
      } catch {
        return undefined;
      }
    };
    const room = free(dataDir);
    if (room !== undefined && room < Math.max(size * 1.25, check.bytes * 8) + 256 * 1024 * 1024) {
      throw new RestoreRefused('This Mac does not have enough free space to restore safely.', { stage: 'space' });
    }
    const willCopy = production && !o.checkOnly && backup !== undefined && o.copyDir !== undefined;
    const copyRoom = willCopy ? free(existsSync(o.copyDir!) ? o.copyDir : dirname(o.copyDir!)) : undefined;
    if (copyRoom !== undefined && copyRoom < check.bytes * 2 + 64 * 1024 * 1024) throw new RestoreRefused('This Mac does not have enough free space to copy the current database first.', { stage: 'space' });

    // No name this run needs may be taken already.
    const taken = await m.query('SELECT 1 FROM pg_database WHERE datname = ANY($1)', [[scratch, reference, keptAs]]);
    if (taken.rowCount) throw new RestoreRefused('A restore from this same second is already there. Wait a moment and run this again.', { stage: 'state' });

    // 5 to 7. Restore beside it, as the role that owns nothing else, and check everything there.
    const locale = await localeOf(m, database);
    const copyOwner = withDatabase(owner, scratch);
    /**
     * Until the copy has passed its checks, what is in it is the backup's own: a view or a function there runs as
     * whoever reads it. So it is read only as the role that restored it, which owns nothing else, and with nothing
     * on the search path (a name of the backup's can stand in for none of Postgres's own).
     */
    const asRestorer = <T>(fn: (c: pg.Client) => Promise<T>): Promise<T> =>
      withClient(withDatabase(restorer, scratch), async (c) => {
        await c.query(`SET search_path = ''`);
        return fn(c);
      });
    let verified: Verified;
    let pending: string[];
    let report: CarryReport;
    let current: CurrentFacts | undefined;
    const readNow = async (): Promise<CurrentFacts | undefined> => (production ? withClient(owner, (c) => readCurrent(c, check.takenAt)).catch(() => undefined) : undefined);
    try {
      await onMaintenance(restorer, (c) => c.query(`CREATE DATABASE ${scratch} TEMPLATE template0${locale}`));
      // What the restoring role is before the backup's SQL runs as it, and a session of its own that signed in before.
      const roleBefore = await restorerState(m, restorer.user);
      const guard = await maintenance(restorer).catch(() => undefined);
      let restoreFailed: unknown;
      let role: Awaited<ReturnType<typeof restorerAfter>>;
      try {
        await run(o.tools.pgRestore, ['--no-owner', '--exit-on-error', '-h', restorer.host, '-p', String(restorer.port), '-U', restorer.user, '-d', scratch, o.dump], restorer.password).catch((err: unknown) => {
          restoreFailed = err ?? new Error('pg_restore failed');
        });
        // Whether it passed or failed: is the restoring role still what it was?
        role = await restorerAfter(m, guard, restorer, roleBefore, scratch);
      } finally {
        await guard?.end().catch(() => {});
      }
      if (role.changed.length) {
        const lines: string[] = [];
        if (role.unfixed.includes('password')) {
          lines.push(
            'Restores, and the weekly restore test, will not work until that role has its password again.',
            'Set it with this command, and type the password from the line FLINT_DB_RESTORE_URL in ~/.flint/backup.env when it asks:',
            `  psql -d postgres -c '\\password ${restorer.user}'`,
          );
        }
        if (role.unfixed.includes('settings')) lines.push('The settings it stored for that role are still there.');
        if (role.unfixed.includes('database')) lines.push('A database it made is still there.');
        throw new RestoreRefused(
          `That file is not one of Flint's backups: restoring it changed the role Flint restores with (${role.changed.join(', ')}). ${role.unfixed.length ? 'Flint could not put all of that back.' : 'Flint put that back.'} The database in use was not touched.`,
          { stage: 'restorer', asIs: true, lines },
        );
      }
      if (restoreFailed) throw restoreFailed;
      // The file that was restored is the file that was checked.
      if ((await sha256File(o.dump)) !== check.sha256) throw new RestoreRefused('The backup file changed while it was being restored.', { stage: 'fingerprint' });

      const referenceFor = async (applied: readonly Migration[]) => (await referenceOf(m, owner, reference, applied, locale, o.tools)).lines;
      // The privileges on the database itself live on the cluster, not in the dump: Flint's own setup, read from a reference.
      const head = await asRestorer((c) => migrationState(c, o.migrationsDir));
      if (head.problems.length) throw new RestoreRefused(`The restored copy did not pass its checks: ${head.problems.join('; ')}.`, { stage: 'verify' });
      const spec = (await referenceOf(m, owner, reference, head.applied, locale, o.tools)).grants;
      // The copy is checked as its own record says it was built, so until it is brought up to date it has the rights
      // on the database itself that go with that record. What it will have in use is set, and said, further down.
      const productionGrants = production ? await databaseGrants(m, database) : undefined;
      await carryDatabaseGrants(m, scratch, spec, productionGrants, [OWNER, restorer.user]);

      // Before it is handed over: counts, the migrations it records, and every object against the reference.
      verified = await asRestorer((c) => verifyRestored(c, { ...(check.counts ? { counts: check.counts } : {}), migrationsDir: o.migrationsDir, reference: referenceFor }));
      if (!verified.ok) throw new RestoreRefused(`The restored copy did not pass its checks: ${verified.problems.join('; ')}.`, { stage: 'verify', lines: fullList(verified) });
      // A database that was tightened by hand before the update that does the same: accepted as it is, and said.
      // What that update does to the database's own rights is not in a backup, so the copy is given it here, from the
      // very reference the copy was accepted against. With that, "changes nothing" is true of the copy in every part:
      // when the update runs further down, it finds each right already as it leaves it.
      if (verified.byHand.length) {
        const early = checkoutMigrations(o.migrationsDir).filter((x) => verified.byHand.includes(x.name));
        const asAccepted = (await referenceOf(m, owner, reference, [...verified.migrations.applied, ...early], locale, o.tools)).grants;
        await carryDatabaseGrants(m, scratch, asAccepted, productionGrants, [OWNER, restorer.user]);
        notes.push('The database this backup is of was already set up as a later update sets it. That update is applied to the restored copy, and changes nothing.');
      }

      // The copy's own properties live on the cluster, where no comparison of its contents sees them, and its owner
      // (the backup's SQL, while it ran) could set them: a stored setting, a connection limit, the template mark.
      // They are cleared before the migration owner first connects to it; production's own settings are carried
      // over at the end (carryDatabaseSettings).
      await m.query(`ALTER DATABASE ${scratch} RESET ALL`);
      await m.query(`ALTER DATABASE ${scratch} WITH CONNECTION LIMIT -1 IS_TEMPLATE false`);

      // Handed to the migration owner. Any other database the restore role owns (a restore drill's) is given straight back.
      await withClient(copyOwner, async (c) => {
        await c.query('BEGIN');
        try {
          const theirs = (await c.query<{ datname: string }>(`SELECT datname FROM pg_database WHERE datdba = $1::regrole AND datname <> current_database()`, [restorer.user])).rows;
          await c.query(`REASSIGN OWNED BY ${quote(restorer.user)} TO ${OWNER}`);
          for (const d of theirs) await c.query(`ALTER DATABASE ${quote(d.datname)} OWNER TO ${quote(restorer.user)}`);
          await c.query(`ALTER SCHEMA public OWNER TO ${OWNER}`);
          await c.query('COMMIT');
        } catch (err) {
          await c.query('ROLLBACK').catch(() => {});
          throw err;
        }
      });
      const handed = await withClient(copyOwner, (c) => verifyRestored(c, { migrationsDir: o.migrationsDir, reference: referenceFor, owner: OWNER, strangers: [restorer.user] }));
      if (!handed.ok) throw new RestoreRefused(`The restored copy did not pass its checks: ${handed.problems.join('; ')}.`, { stage: 'verify', lines: fullList(handed) });
      // And nothing of its own is left on it: no stored setting for anyone, no limit, not a template.
      const own = (await m.query<{ plain: boolean }>(
        `SELECT d.datconnlimit = -1 AND NOT d.datistemplate AND d.datallowconn AND NOT EXISTS (SELECT 1 FROM pg_db_role_setting s WHERE s.setdatabase = d.oid) AS plain FROM pg_database d WHERE d.datname = $1`,
        [scratch],
      )).rows[0];
      if (!own?.plain) throw new RestoreRefused('The restored copy carries settings of its own that Flint could not clear.', { stage: 'verify' });

      // Brought up to date, and checked again against this checkout's whole list.
      pending = verified.migrations.pending;
      if (pending.length) {
        await o.migrate(urlOf(o.owner, scratch));
        const after = await withClient(copyOwner, (c) => verifyRestored(c, { migrationsDir: o.migrationsDir, reference: referenceFor, owner: OWNER, strangers: [restorer.user] }));
        if (!after.ok || after.migrations.pending.length) {
          throw new RestoreRefused(`The restored copy could not be brought up to date: ${[...after.problems, ...(after.migrations.pending.length ? ['migrations still pending'] : [])].join('; ')}.`, { stage: 'migrate' });
        }
      }
      // What goes into use: the rights on the database itself that this checkout's WHOLE list of migrations gives
      // (the updates just applied included), with Will's own additions. Set outright, whatever the updates did on
      // the way, so the end state is one thing: Flint's setup as of now. Only a difference from THAT is said.
      const all = checkoutMigrations(o.migrationsDir);
      const end = pending.length ? (await referenceOf(m, owner, reference, all, locale, o.tools)).grants : spec;
      const wanted = await carryDatabaseGrants(m, scratch, end, productionGrants, [OWNER, restorer.user]);
      // And nothing beyond it: no role holds a right on the copy that is neither Flint's setup nor Will's own addition
      // on the database in use. (Setting the rights takes every other away; this is the check that it did.)
      const beyond = grantsBeyond(wanted, await databaseGrants(m, scratch));
      if (beyond.length) {
        const who = [...new Set(beyond.map((g) => plainRole(g.grantee)))].sort();
        throw new RestoreRefused(
          `The restored copy did not pass its checks: on the database itself, ${listed(who)} ${who.length === 1 ? 'holds' : 'hold'} a right that neither Flint's setup nor the database in use gives.`,
          { stage: 'verify' },
        );
      }
      notes.push(...databaseGrantNotes(end, productionGrants, [OWNER, restorer.user]));
      // The runtime's own role must be able to use it.
      await withClient(withDatabase(app, scratch), (c) => c.query('SELECT 1 FROM public."Proposal" LIMIT 1'));

      current = await readNow();
      report = await withClient(copyOwner, (c) => carryForward(c, { ...(current ? { current } : {}), ...(o.rp ? { rp: o.rp } : {}), now: new Date() }));
      if (production) notes.push(...(await carryDatabaseSettings(m, database, scratch)));
    } catch (err) {
      const dropped = await dropDatabase(scratch);
      const left = dropped ? [] : [`Flint could not remove the copy ${scratch}. The next restore removes it.`];
      // A refusal that says for itself what was changed (the backup's SQL changed the restoring role) is passed on as it is.
      if (err instanceof RestoreRefused && err.asIs) throw new RestoreRefused(err.message, { stage: err.stage, asIs: true, lines: [...err.lines, ...left] });
      if (err instanceof RestoreRefused) throw new RestoreRefused(`${err.message} Nothing was changed.`, { stage: err.stage, lines: [...err.lines, ...left] });
      throw new RestoreRefused(`The backup could not be restored (${reasonOf(err)}). Nothing was changed.`, { stage: 'restore', lines: left });
    }
    for (const n of notes) o.say(n);

    const result = (): Omit<RestoreResult, 'seconds'> => ({
      mode: o.mode, dump: o.dump, sha256: check.sha256, fingerprint: check.fingerprint, tables: verified.tables, pending, report, database, leftovers, removed: [],
    });

    // 8. A trial run ends here: the copy passed every check, so it is dropped and nothing has changed.
    if (o.checkOnly) {
      await dropDatabase(scratch);
      const seconds = Math.round((Date.now() - started) / 1000);
      await recordAttempt('ok', { tables: verified.tables, seconds });
      return { ...result(), seconds, checkedOnly: true };
    }
    if (production) o.say('The backup restored and passed its checks.');

    // Will's word, having read what will be in force.
    const oldDatabases = production ? oldKept(state, Date.now()) : [];
    const oldFiles = production ? oldCopies(o.copyDir, Date.now()) : [];
    const removing = [...oldDatabases, ...oldFiles.map((f) => `the copy ${f}`)];
    if (production) {
      const summary: RestoreSummary = {
        name: basename(o.dump), takenAt: check.takenAt, bytes: check.bytes, tables: verified.tables, fingerprint: check.fingerprint, database, keptAs, report, removing,
      };
      if (!o.confirm || !(await o.confirm(summary))) {
        await dropDatabase(scratch);
        await recordAttempt('skipped', { stage: 'confirm' });
        throw new RestoreRefused('Nothing was changed.', { stage: 'confirm' });
      }
    }

    // A copy of the database as it is now, taken with the read-only backup role.
    let copy: string | undefined;
    if (production) {
      const stop = async (sentence: string): Promise<never> => {
        await dropDatabase(scratch);
        throw new RestoreRefused(sentence, { stage: 'copy' });
      };
      if (backup && o.copyDir) {
        try {
          mkdirSync(o.copyDir, { recursive: true, mode: 0o700 });
          const d = await dumpDatabase(o.backup!, o.copyDir, o.tools, new Date());
          if (o.keyFile) writeDumpHash(d.path, d.sha256, o.keyFile);
          copy = d.path;
          o.say('Flint copied the current database first.');
        } catch {
          if (!o.withoutCopy) await stop('Flint could not copy the current database first, so it stopped. Nothing was changed.');
          o.say('Flint could not copy the current database first. It is kept under another name all the same.');
        }
      } else if (!o.withoutCopy) {
        await stop('Flint has no way to copy the current database first, so it stopped. Nothing was changed.');
      }
    }

    // 9. The swap. From here an interruption is held until the swap is done or undone.
    swapping = true;
    const stopIfAsked = () => {
      if (interrupted) throw new RestoreRefused(`Flint was interrupted (${interrupted}), so it stopped.`, { stage: 'interrupted' });
    };
    const ids = async (c: pg.Client): Promise<Map<string, DbRow>> =>
      new Map((await c.query<DbRow>(`SELECT oid::text AS oid, datname, datallowconn AS open, pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = ANY($1)`, [[database, scratch, keptAs]])).rows.map((r) => [r.oid, r]));
    const before = await ids(m);
    const prodOid = [...before.values()].find((r) => r.datname === database)?.oid;
    const copyOid = [...before.values()].find((r) => r.datname === scratch)?.oid;
    let cause: unknown;
    let stopped = false;
    try {
      if (prodOid === undefined || copyOid === undefined) throw new Error('a database this needs is gone');
      stopIfAsked();
      // Asked again, now that the checks (which take a while) are behind: an update started by hand does not look
      // at the pause, and nothing may be installed across the swap.
      const installing = (): RestoreRefused => new RestoreRefused('An update is being installed, so Flint did not swap the databases.', { stage: 'deploy', lines: ['Wait for it to finish, then run this again.'] });
      if (await o.deployRunning?.()) throw installing();
      try {
        await o.stopRuntime();
        stopped = true;
      } catch (err) {
        stopped = true; // It may be half stopped: it is started again below either way.
        throw err instanceof RestoreRefused ? err : new RestoreRefused('The runtime could not be stopped.', { stage: 'runtime' });
      }
      stopIfAsked();
      // The last word on what Will took away, now that the runtime writes nothing.
      const late = await readNow();
      if (late) {
        const again = await withClient(copyOwner, (c) => carryForward(c, { current: late, ...(o.rp ? { rp: o.rp } : {}), now: new Date() }));
        report = { ...again, approvals: report.approvals, proposals: report.proposals, deliveries: report.deliveries, jobs: report.jobs, revoked: report.revoked + again.revoked, mismatched: report.mismatched + again.mismatched, keysNeverHeld: [...report.keysNeverHeld, ...again.keysNeverHeld],
          policiesOff: report.policiesOff + again.policiesOff, rulesOff: report.rulesOff + again.rulesOff, counters: report.counters + again.counters,
          unsignedPolicies: [...report.unsignedPolicies, ...again.unsignedPolicies], unsignedRules: [...report.unsignedRules, ...again.unsignedRules] };
      }
      // And once more at the last moment before anything in use is touched.
      if (await o.deployRunning?.()) throw installing();
      if (production) o.say('Flint is waiting for everything else to let go of the database. This can take up to a minute.');
      await m.query(`ALTER DATABASE ${database} ALLOW_CONNECTIONS false`);
      await o.at?.('closed');
      const until = Date.now() + (o.drainMs ?? 60_000);
      for (const name of [database, scratch]) {
        for (;;) {
          stopIfAsked();
          const busy = await connected(m, name);
          if (!busy.length) break;
          if (Date.now() > until) {
            throw new RestoreRefused(`Something is still using the database (${busy.join('; ')}), so Flint stopped.`, { stage: 'drain', lines: ['Quit what is connected to it, then run this again.'] });
          }
          await sleep(250);
        }
      }
      stopIfAsked();
      // Both names change together, or neither does. The database that was in use keeps its closed door.
      try {
        await m.query(`BEGIN; ALTER DATABASE ${database} RENAME TO ${keptAs}; ALTER DATABASE ${scratch} RENAME TO ${database}; COMMIT;`);
      } catch (err) {
        await m.query('ROLLBACK').catch(() => undefined);
        throw err;
      }
      await o.at?.('swapped');
    } catch (err) {
      cause = err;
    }

    // What happened is read from the catalog, by the databases' own ids, on a session of its own.
    const settle = async (): Promise<'swapped' | 'original' | 'unknown'> => {
      for (let attempt = 0; attempt < 3; attempt++) {
        let c: pg.Client | undefined;
        try {
          c = await maintenance(owner);
          let now = await ids(c);
          const prod = prodOid === undefined ? undefined : now.get(prodOid);
          const cp = copyOid === undefined ? undefined : now.get(copyOid);
          if (cp?.datname === database && prod?.datname === keptAs) return 'swapped';
          if (prod?.datname === database) {
            if (!prod.open) {
              await c.query(`ALTER DATABASE ${database} ALLOW_CONNECTIONS true`);
              now = await ids(c);
            }
            if (now.get(prodOid!)?.open) return 'original';
          }
          return 'unknown';
        } catch {
          await sleep(500);
        } finally {
          await c?.end().catch(() => {});
        }
      }
      return 'unknown';
    };
    const outcome = await settle();

    if (outcome !== 'swapped') {
      const why = cause instanceof RestoreRefused ? cause.message : `The databases could not be swapped (${reasonOf(cause)}).`;
      const more = cause instanceof RestoreRefused ? cause.lines : [];
      const stage = cause instanceof RestoreRefused ? cause.stage : 'swap';
      // The runtime is started again whatever else is true, and whether it did is said.
      const runtimeUp = !stopped || (await o.startRuntime().then(() => true, () => false));
      if (outcome === 'original') {
        // Only now, with production confirmed back under its name and open, is the copy that never went live removed.
        const dropped = await onMaintenance(owner, (c) => c.query(`DROP DATABASE IF EXISTS ${scratch}`)).then(() => true, () => false);
        const lines = [...more, ...(dropped ? [] : [`Flint could not remove the copy ${scratch}. The next restore removes it.`])];
        await recordAttempt('failed', { stage });
        throw new RestoreRefused(`${why} Nothing was changed.`, { stage, lines, runtimeDown: !runtimeUp });
      }
      // Not confirmed: say what is there, keep the copy, and give the commands.
      const seen = await onMaintenance(owner, (c) => clusterState(c, database)).catch(() => undefined);
      const lines = [...more];
      if (!seen) lines.push('Flint could not reach the database server to see what state it is in.');
      else if (!seen.production) lines.push(`There is no database named ${database} right now.`);
      else if (!seen.production.open) lines.push(`The database ${database} is closed to connections.`);
      if (seen?.stale.some((s) => s.datname === scratch)) lines.push(`The restored copy is still there as ${scratch}.`);
      lines.push('Put things back with this command:', REPAIR, 'If that does not work, open the database by hand with this command:', `  psql -d postgres -c 'ALTER DATABASE ${database} ALLOW_CONNECTIONS true'`);
      await recordAttempt('failed', { stage: 'undo' });
      throw new RestoreRefused(`${why} Flint could not confirm that the database is back as it was.`, { stage: 'undo', lines, runtimeDown: !runtimeUp });
    }

    // The databases are swapped whatever happens now: what follows is reported, never undone.
    const runtimeStarted = await o.startRuntime().then(() => true, () => false);
    const seconds = Math.round((Date.now() - started) / 1000);
    const inputs: AuditInputs = {
      mode: o.mode, sha256: check.sha256, fingerprint: check.fingerprint, tables: verified.tables, pending: pending.length,
      approvals: report.approvals, proposals: report.proposals, revoked: report.revoked + report.mismatched + report.keysNeverHeld.length, switchedOff: report.policiesOff + report.rulesOff + report.unsignedPolicies.length + report.unsignedRules.length,
      currentRead: report.currentRead, copied: copy !== undefined, keptAs, seconds,
    };
    recorded = true;
    o.record?.({ outcome: 'ok', ...inputs });
    const audited = await audit(app, { ...who, decision: 'act', outcome: 'ok', inputs }).then(() => true, () => false);

    // A rebuild's old database was the empty one it made: there is nothing in it to keep.
    const removed: string[] = [];
    if (!production) await dropDatabase(keptAs);
    else {
      for (const name of oldDatabases) if (await dropDatabase(name)) removed.push(name);
      for (const f of oldFiles) {
        for (const suffix of ['', '.counts.json', '.sha256']) rmSync(join(o.copyDir!, `${f}${suffix}`), { force: true });
        removed.push(`the copy ${f}`);
      }
    }
    return { ...result(), seconds, ...(production ? { keptAs } : {}), runtimeStarted, audited, removed, ...(copy ? { copy } : {}) };
  } catch (err) {
    // Every attempt that got this far and did not finish is on record: where it stopped, never why in a tool's words.
    if (!recorded) await recordAttempt('failed', err instanceof RestoreRefused ? { stage: err.stage } : { stage: 'fault', what: reasonOf(err).slice(0, 120) }).catch(() => undefined);
    throw err;
  } finally {
    off?.();
    await main?.end().catch(() => {});
    releaseHold();
  }
}

// ---------------------------------------------------------------------------
// Repair

export interface RepairOptions {
  /** flint_owner on the production database. */
  owner: string;
  /** Will's typed word before a kept database is given the production name back; not asked just to open a closed one. */
  confirm(kept: string): Promise<boolean>;
  startRuntime(): Promise<void>;
  say(line: string): void;
}

/**
 * Put right what a restore that was stopped part-way left: a production
 * database that is closed is opened; one that is missing while a kept copy is
 * there has the newest kept copy renamed back (Will confirms that one); copies
 * that never went live are removed; the runtime is started. Returns false when
 * the runtime did not start.
 */
export async function repairDatabase(o: RepairOptions): Promise<{ did: 'opened' | 'renamed' | 'nothing'; runtimeStarted: boolean }> {
  const owner = targetOf(o.owner);
  const database = owner.database;
  if (!DB_NAME.test(database) || RESERVED.has(database)) throw new RestoreRefused("The production database's name is not one Flint can rename.", { stage: 'config' });
  const c = await maintenance(owner);
  let did: 'opened' | 'renamed' | 'nothing' = 'nothing';
  try {
    const locked = (await c.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1, $2) AS ok', [...LOCK])).rows[0]!.ok;
    if (!locked) throw new RestoreRefused('A restore is running. Wait for it to finish.', { stage: 'lock' });
    let state = await clusterState(c, database);
    if (!state.production) {
      const kept = state.kept.at(-1);
      if (!kept) throw new RestoreRefused(`There is no database named ${database} and no kept copy of it. Rebuild from a backup: docs/RECOVERY.md says how.`, { stage: 'state' });
      o.say(`There is no database named ${database}. The newest kept copy is ${kept.datname}.`);
      if (!(await o.confirm(kept.datname))) throw new RestoreRefused('Nothing was changed.', { stage: 'confirm' });
      await c.query(`ALTER DATABASE ${kept.datname} RENAME TO ${database}`);
      did = 'renamed';
      state = await clusterState(c, database);
    }
    if (state.production && !state.production.open) {
      await c.query(`ALTER DATABASE ${database} ALLOW_CONNECTIONS true`);
      if (did === 'nothing') did = 'opened';
      state = await clusterState(c, database);
    }
    if (!state.production?.open) throw new RestoreRefused(`Flint could not open the database ${database}.`, { stage: 'undo', lines: ['Open it by hand with this command:', `  psql -d postgres -c 'ALTER DATABASE ${database} ALLOW_CONNECTIONS true'`] });
    o.say(did === 'renamed' ? `The database ${database} is back, from the kept copy.` : did === 'opened' ? `The database ${database} is open again.` : `The database ${database} is open. Nothing needed repairing.`);
    for (const s of state.stale) {
      const gone = await c.query(`DROP DATABASE IF EXISTS ${s.datname}`).then(() => true, () => false);
      o.say(gone ? `Flint removed ${s.datname}, a copy that never went into use.` : `Flint could not remove ${s.datname}, a copy that never went into use.`);
    }
  } finally {
    await c.end().catch(() => {});
  }
  const runtimeStarted = await o.startRuntime().then(() => true, () => false);
  return { did, runtimeStarted };
}

// ---------------------------------------------------------------------------
// Compare: how the database in use differs from what this checkout builds

export interface CompareOptions {
  /** flint_owner on the production database. */
  owner: string;
  /** flint_restore, for its name (the role checks) only: it is never signed in as here. */
  restore: string;
  tools: Tools;
  migrationsDir: string;
  say(line: string): void;
  now?: Date;
  /** Call `handler` when the process is asked to stop; the returned function stops listening. */
  onSignal?(handler: (signal: string) => void): () => void;
  /** End the process after an interruption, once what this run made has been removed. */
  exit?(signal: string): void;
}

export interface Comparison {
  /** A backup of this database would pass a restore's comparison. */
  same: boolean;
  /** How many things differ in how the database is built. */
  differences: number;
  /** How many other things a restore would stop at (the roles it needs, who owns the database). */
  stops: number;
  /** Migrations it already has in place by hand (catalog.ts, ALREADY_BY_HAND). */
  byHand: string[];
  /** How many sentences were said about the server-side setup (roles, the database's own rights and settings). */
  notes: number;
  /** The last word, as one sentence: said here when a restore would go through, and left to the caller (as a refusal) when not. */
  verdict: string;
}

/**
 * The last word of a comparison. It counts only what would stop a restore: the
 * differences in how the database is built (listed first), and what was said
 * with "A restore would stop". Everything else that was said stops nothing.
 */
export function compareVerdict(c: { differences: number; stops: number; unreadable?: boolean }): string {
  const built = c.unreadable
    ? 'until its record of updates is one this copy of Flint can follow'
    : `until ${c.differences === 1 ? 'the 1 difference listed first is' : `the ${c.differences} differences listed first are`} settled`;
  const marked = c.stops === 1 ? 'the 1 thing marked so above' : `the ${c.stops} things marked so above`;
  if (c.differences === 0) return c.stops === 0 ? 'A backup of this database would pass the restore\'s comparison.' : `A restore would stop at ${marked}.`;
  return `A restore would refuse a backup of this database ${built}${c.stops ? `, and would stop at ${marked}` : ''}.`;
}

/**
 * Read the database in use and say every way it is not what this checkout
 * builds, without a backup and without restoring anything. It is what a
 * restore's own check compares, taken from the live database instead of from a
 * restored copy: so every difference is listed at once, before one stops a
 * restore.
 *
 * Nothing in the database in use is changed: it is read in sessions that
 * refuse every write. One scratch database is made beside it (the reference,
 * built from this checkout's migrations) and removed again.
 *
 * Said in three parts: what a backup would carry and a restore would refuse
 * (the make-up of the database itself: tables, guards, privileges); what lives
 * on the server and not in a backup (the database's own rights and settings,
 * the roles), which a restore sets or checks itself; and how the copy a restore
 * makes would be created.
 */
export async function compareDatabase(o: CompareOptions): Promise<Comparison> {
  const owner = targetOf(o.owner);
  const restorer = targetOf(o.restore);
  const database = owner.database;
  if (!DB_NAME.test(database) || RESERVED.has(database)) throw new RestoreRefused("The production database's name is not one Flint can compare.", { stage: 'config' });
  const stamp = (o.now ?? new Date()).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'z').toLowerCase();
  const reference = `${database}_reference_${stamp}`;
  if (!DB_NAME.test(reference)) throw new RestoreRefused("The production database's name is too long to build a reference beside.", { stage: 'config' });
  /** Asked to stop: the step in hand finishes, what this run made is removed, and only then does the process end. */
  let interrupted: string | undefined;
  const off = o.onSignal?.((signal) => {
    interrupted ??= signal;
  });
  const stopIfAsked = (): void => {
    if (interrupted) throw new RestoreRefused('Flint was interrupted, so it stopped. Nothing was changed.', { stage: 'interrupted' });
  };
  /** The reference database is this run's own only once the lock is held and its name was seen to be free. */
  let mine = false;
  let m: pg.Client | undefined;
  try {
    m = await maintenance(owner);
    const main = m;
    const locked = (await main.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1, $2) AS ok', [...LOCK])).rows[0]!.ok;
    if (!locked) throw new RestoreRefused('A restore is running. Wait for it to finish.', { stage: 'lock' });
    const state = await clusterState(main, database);
    if (!state.production) throw new RestoreRefused(`There is no database named ${database} to compare.`, { stage: 'state' });
    if (!state.production.open) throw new RestoreRefused(`The database ${database} is closed to connections: an earlier restore was stopped part-way.`, { stage: 'state', lines: ['Open it again with this command:', REPAIR] });
    // What an earlier comparison (or a restore's own reference) left when it was cut short. With the lock held no
    // run is using one, so it is nobody's. A restored copy that never went into use is a restore's to remove.
    const left = state.stale.filter((d) => new RegExp(`^${database}_reference_`).test(d.datname));
    const gone: string[] = [];
    for (const d of left) if (await main.query(`DROP DATABASE IF EXISTS ${d.datname}`).then(() => true, () => false)) gone.push(d.datname);
    if (gone.length) o.say(gone.length === 1 ? `Flint removed ${gone[0]}, a scratch database left by an earlier run that did not finish.` : `Flint removed ${gone.length} scratch databases left by earlier runs that did not finish.`);
    if (gone.length < left.length) o.say(`Flint could not remove ${counted(left.length - gone.length, 'scratch database')} left by an earlier run. The next restore removes ${left.length - gone.length === 1 ? 'it' : 'them'}.`);
    if ((await main.query('SELECT 1 FROM pg_database WHERE datname = $1', [reference])).rowCount) throw new RestoreRefused('A comparison from this same second is already there. Wait a moment and run this again.', { stage: 'state' });
    mine = true;
    stopIfAsked();

    // The database in use, read and never written: every statement of these sessions is refused a write by Postgres itself.
    const readOnly = <T>(fn: (c: pg.Client) => Promise<T>): Promise<T> =>
      withClient(owner, async (c) => {
        await c.query('SET default_transaction_read_only = on');
        await c.query(`SET search_path = ''`);
        return fn(c);
      });
    const migrations = await readOnly((c) => migrationState(c, o.migrationsDir));
    const lines = await readOnly((c) => catalogLines(c));
    // Who owns what. (A right the restoring role holds or gave is in the lines above, as a difference like any other.)
    const strays = await readOnly((c) => ownedByOthers(c, OWNER));

    const locale = await localeFacts(main, database);
    const built = new Map<string, Reference>();
    const referenceFor = async (applied: readonly Migration[]): Promise<Reference> => {
      const key = applied.map((a) => a.name).join(',');
      if (!built.has(key)) {
        stopIfAsked();
        built.set(key, await referenceOf(main, owner, reference, applied, locale.clause, o.tools, stopIfAsked));
      }
      return built.get(key)!;
    };

    // 1. What a backup carries, and a restore compares.
    let differences = 0;
    let byHand: string[] = [];
    const unreadable = migrations.problems.length > 0;
    if (unreadable) {
      differences += migrations.problems.length;
      o.say(`The database's own record of its updates is not one this copy of Flint can follow: ${migrations.problems.join('; ')}.`);
      o.say('A restore would refuse a backup of it for that alone, so nothing else was compared.');
    } else {
      // What Flint's roles hold on the database itself is not in a backup: a restore gives its copy those rights
      // from Flint's own setup, and carries over what other roles hold here. So a restore never finds this
      // database's own list in a copy, and it is no part of the comparison (it is said in the second part, where
      // none of it stops a restore). With one exception, which a restore WOULD find and refuse: a right carried
      // over for another role that one of Flint's roles is a member of, and so holds too, beyond its setup.
      const onDatabase = /^may\|\S+ \S+ database$/;
      const carried = (ls: readonly string[]): string[] => ls.filter((l) => !onDatabase.test(l));
      const setup = new Set((await referenceFor(migrations.pending.length ? checkoutMigrations(o.migrationsDir) : migrations.applied)).lines.filter((l) => onDatabase.test(l)));
      const inherited = (await main.query<{ l: string }>(
        `SELECT DISTINCT 'may|' || r.rolname || ' ' || CASE a.privilege_type WHEN 'TEMPORARY' THEN 'TEMP' ELSE a.privilege_type END || ' database' AS l
         FROM pg_database d, LATERAL aclexplode(d.datacl) a JOIN pg_roles g ON g.oid = a.grantee, pg_roles r
         WHERE d.datname = $1 AND a.grantee <> d.datdba AND r.rolname = ANY($2) AND g.rolname <> ALL($3) AND pg_has_role(r.oid, g.oid, 'USAGE')`,
        [database, [...APP_ROLES], [...APP_ROLES, OWNER, restorer.user]],
      )).rows.map((r) => r.l).filter((l) => !setup.has(l));
      // The database in use has usually never been through a dump (it was built by the migrations themselves), and
      // sometimes has (after a restore): each object may read as either kind of reference has it.
      const compared = await compareWithReference(
        [...carried(lines), ...inherited].sort(), migrations, o.migrationsDir,
        async (applied) => carried((await referenceFor(applied)).lines), async (applied) => carried((await referenceFor(applied)).raw),
      );
      byHand = compared.byHand;
      differences += compared.difference.objects.length;
      const recorded = `It has ${counted(migrations.applied.length, 'update')} on record${migrations.pending.length ? ` and ${migrations.pending.length} still to apply` : ''}.`;
      if (!compared.difference.objects.length) {
        o.say(`The database ${database} is built the way this copy of Flint builds one. ${recorded}`);
        if (byHand.length) o.say('It was already set up as an update that is still to apply sets it, which a restore accepts.');
      } else {
        o.say(`The database ${database} differs from the one this copy of Flint builds in ${counted(compared.difference.objects.length, 'way')}. ${recorded}`);
        o.say(LEGEND);
        for (const line of differenceLines(compared.difference)) o.say(line);
      }
    }
    if (strays.length) {
      o.say(`In it, ${counted(strays.length, 'thing')} ${strays.length === 1 ? 'does' : 'do'} not belong to the migration owner. A restore gives everything to the migration owner, so this stops nothing:`);
      for (const stray of strays.slice(0, 20)) o.say(`  ${straySentence(stray)}`);
      if (strays.length > 20) o.say(`  The same is true of ${strays.length - 20} more.`);
    }
    stopIfAsked();

    // 2. What lives on the server, not in a backup.
    let notes = 0;
    const note = (line: string): void => {
      notes += 1;
      o.say(line);
    };
    let stops = 0;
    const stop = (line: string): void => {
      stops += 1;
      note(line);
    };
    const setup = await roleProblems(main, restorer.user);
    if (state.production.owner !== OWNER) setup.push(`the database ${database} does not belong to ${OWNER}`);
    for (const problem of setup) stop(`A restore would stop at this: ${problem}.`);
    const member = (await main.query<{ ok: boolean | null }>(`SELECT CASE WHEN to_regrole($2) IS NULL THEN NULL ELSE pg_has_role($1, $2, 'MEMBER') END AS ok`, [OWNER, restorer.user])).rows[0]!.ok;
    if (member === false) stop('A restore would stop at this: the migration owner has not been given the restoring role. A restore prints the command for it.');
    // Flint's roles themselves, beyond what a restore checks: what was done to one by hand lives on this server only.
    const plainName = (x: string): string => x.replace(/[^\w.]/g, '?').slice(0, 63);
    const expected: Record<string, readonly string[]> = { flint_backup: ['pg_read_all_data'], [OWNER]: [restorer.user] };
    const roles = (await main.query<{ rolname: string; login: boolean; inherit: boolean; lim: number; expires: boolean; settings: string[] | null; member_of: string[] | null }>(
      `SELECT r.rolname, r.rolcanlogin AS login, r.rolinherit AS inherit, r.rolconnlimit AS lim, r.rolvaliduntil IS NOT NULL AS expires,
              (SELECT array_agg(DISTINCT split_part(x, '=', 1) ORDER BY split_part(x, '=', 1)) FROM pg_db_role_setting s, unnest(s.setconfig) AS x WHERE s.setrole = r.oid AND s.setdatabase = 0) AS settings,
              (SELECT array_agg(g.rolname::text ORDER BY g.rolname) FROM pg_auth_members am JOIN pg_roles g ON g.oid = am.roleid WHERE am.member = r.oid) AS member_of
       FROM pg_roles r WHERE r.rolname = ANY($1) ORDER BY r.rolname`,
      [[OWNER, restorer.user, ...APP_ROLES]],
    )).rows;
    for (const r of roles) {
      const want = expected[r.rolname] ?? [];
      for (const g of r.member_of ?? []) if (!want.includes(g)) note(`The role ${r.rolname} is a member of ${plainName(g)}, which Flint's own setup does not make it.`);
      for (const g of want) if (g !== restorer.user && !(r.member_of ?? []).includes(g)) note(`The role ${r.rolname} is not a member of ${g}, which Flint's own setup makes it.`);
      if (!r.login) note(`The role ${r.rolname} cannot sign in.`);
      if (!r.inherit) note(`The role ${r.rolname} does not take on the rights of the roles it is a member of.`);
      if (r.lim !== -1) note(`The role ${r.rolname} has a connection limit of ${r.lim}.`);
      if (r.expires) note(`The role ${r.rolname} has a password that runs out on a set day.`);
      if (r.settings?.length) note(`The role ${r.rolname} has ${counted(r.settings.length, 'setting')} of its own on this server, ${listed(r.settings.map(plainName))}. No backup holds ${r.settings.length === 1 ? 'it' : 'them'}.`);
    }
    if (!unreadable) {
      // Against what a restored database ENDS with: Flint's setup for this checkout's whole list of updates, the
      // ones still to apply included (a restore applies them before the copy goes into use). So a database that
      // already has what a pending update gives is told nothing, and one that does not is told what will change.
      const end = (await referenceFor(migrations.pending.length ? checkoutMigrations(o.migrationsDir) : migrations.applied)).grants;
      for (const line of databaseGrantNotes(end, await databaseGrants(main, database), [OWNER, restorer.user], 'compare')) note(line);
    }
    const own = (await main.query<{ lim: number; tmpl: boolean; settings: string[] | null; roles: number }>(
      `SELECT d.datconnlimit AS lim, d.datistemplate AS tmpl,
              (SELECT array_agg(DISTINCT split_part(x, '=', 1) ORDER BY split_part(x, '=', 1)) FROM pg_db_role_setting s, unnest(s.setconfig) AS x WHERE s.setdatabase = d.oid AND s.setrole = 0) AS settings,
              (SELECT count(*)::int FROM pg_db_role_setting s WHERE s.setdatabase = d.oid AND s.setrole <> 0) AS roles
       FROM pg_database d WHERE d.datname = $1`,
      [database],
    )).rows[0]!;
    const names = (own.settings ?? []).map((n) => n.replace(/[^\w.]/g, '?').slice(0, 60));
    if (names.length) note(`The database has ${counted(names.length, 'setting')} of its own, ${listed(names)}. A restore carries ${names.length === 1 ? 'it' : 'them'} over.`);
    if (own.roles) note(`The database holds settings stored for ${counted(own.roles, 'role')} by name. A restore cannot copy those, and says so.`);
    if (own.lim !== -1) note(`The database has a connection limit of ${own.lim}. A restored database has none.`);
    if (own.tmpl) note('The database is marked as a template. A restored database is not.');

    // 3. How a restore would make its copy.
    o.say(locale.copied
      ? `A restored copy is made the way this database was: ${locale.words}.`
      : `This database stores text as ${locale.words}, which Flint cannot copy exactly: a restored copy takes the database server's own defaults.`);

    const same = differences === 0;
    const verdict = compareVerdict({ differences, stops, unreadable });
    // The last word when a restore would not go through is the caller's: the command ends on it, as a refusal.
    if (same && stops === 0) {
      o.say(verdict);
      o.say('Nothing was changed.');
    }
    return { same, differences, stops, byHand, notes, verdict };
  } finally {
    off?.();
    // Only what this run made: a database of this name that was there before the lock was held is another run's.
    if (mine) await m?.query(`DROP DATABASE IF EXISTS ${reference}`).catch(() => undefined);
    await m?.end().catch(() => {});
    // After an interruption the process ends here, with nothing of this run left behind.
    if (interrupted) o.exit?.(interrupted);
  }
}
