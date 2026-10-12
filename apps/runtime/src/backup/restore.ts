/**
 * Putting Flint's database back from a backup (P7):
 *
 *  - restoreIntoEmpty: on a rebuilt Mac, into the empty database the rebuild
 *    just made. Refused if that database holds anything.
 *  - restoreProduction (the action `restore.production`): over the production
 *    database, run by Will at the keyboard. The backup is restored and checked
 *    in a database of its own first, so the one in use is not touched until the
 *    copy has passed every check. Then the two swap names: nothing is dropped,
 *    and the database that was in use stays as `<name>_damaged_<time>`.
 *
 * Both restore as the migration owner (flint_owner), never as a superuser: a
 * backup is a file, and a file that was tampered with should be able to do no
 * more than a database owner can. What comes back is owned by flint_owner, with
 * the grants the backup recorded.
 *
 * Nothing signed before the backup was taken may act after it: every unused
 * approval is marked used, and every card that was approved but had not finished
 * is marked failed, so Will is asked again.
 *
 * Passwords go to pg_restore through PGPASSWORD, never argv, and nothing here
 * logs a URL.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statfsSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import pg from 'pg';
import { client, countRows, dumpDatabase, run, sha256File, targetOf, type PgTarget, type Tools } from './backup.js';

/** Why a restore did not start, or stopped before it changed anything: a sentence for Will. */
export class RestoreRefused extends Error {}

/** A nightly dump's name (dumpDatabase writes it): the only kind restored here. */
const DUMP_NAME = /^flint-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.dump$/;
/** A counts key as countRows writes it: `public."Proposal"` or `public.lower_name`. */
const COUNT_KEY = /^public\.("[A-Za-z_][A-Za-z0-9_]{0,62}"|[a-z_][a-z0-9_]{0,62})$/;
/** A database name this module may create, rename or drop: lower case, no quoting needed. */
const DB_NAME = /^[a-z][a-z0-9_]{0,62}$/;

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The fingerprint file beside a dump: its sha256, written when the dump was. */
export function writeDumpHash(dump: string, sha256: string): void {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('not a sha256');
  writeFileSync(`${dump}.sha256`, `${sha256}\n`, { mode: 0o600 });
}

export interface DumpCheck {
  path: string;
  bytes: number;
  sha256: string;
  /** `matches`: the file is byte for byte what was written. `none`: no fingerprint was kept for it. */
  fingerprint: 'matches' | 'none';
  /** Row counts taken in the dump's own snapshot; undefined when the file came without them and that was allowed. */
  counts?: Record<string, number>;
  /** When the dump was taken (its name says). */
  takenAt: Date;
}

export interface DumpCheckOptions {
  /** The sha256 recorded when the dump was taken, used when no `.sha256` sits beside it. */
  expectedSha256?: string;
  /**
   * Accept a dump with no counts file (an offsite copy made before the counts
   * went offsite too). A counts file that is there must still be readable.
   */
  countsOptional?: boolean;
}

/**
 * Is this file a whole, untouched nightly dump? Checked before anything is
 * restored: its name, that it is a plain file only its owner can change, its
 * fingerprint (the `.sha256` beside it, else `expectedSha256` from the BackupRun
 * row), that pg_restore can read its table of contents, and its counts file.
 */
export async function checkDump(dump: string, tools: Tools, opts: DumpCheckOptions = {}): Promise<DumpCheck> {
  if (!dump.startsWith('/')) throw new RestoreRefused('The backup must be named by its full path.');
  const named = DUMP_NAME.exec(basename(dump));
  if (!named) throw new RestoreRefused("That is not one of Flint's nightly database backups.");
  const takenAt = new Date(`${named[1]}T${named[2]}:${named[3]}:${named[4]}.${named[5]}Z`);
  if (Number.isNaN(takenAt.getTime())) throw new RestoreRefused("That is not one of Flint's nightly database backups.");
  let st;
  try {
    st = lstatSync(dump);
  } catch {
    throw new RestoreRefused('That backup file does not exist.');
  }
  if (!st.isFile()) throw new RestoreRefused('That backup is not a plain file.');
  if (st.mode & 0o022) throw new RestoreRefused('Someone other than you could have changed that backup file, so Flint will not restore it.');
  if (st.size === 0) throw new RestoreRefused('That backup file is empty.');

  const sha256 = await sha256File(dump);
  const sidecar = `${dump}.sha256`;
  const recorded = existsSync(sidecar) ? readFileSync(sidecar, 'utf8').trim() : opts.expectedSha256;
  if (recorded !== undefined && !/^[0-9a-f]{64}$/.test(recorded)) throw new RestoreRefused('The fingerprint saved with that backup is not readable.');
  if (recorded !== undefined && recorded !== sha256) throw new RestoreRefused('That backup file has changed since it was written. Choose another backup.');

  try {
    await run(tools.pgRestore, ['--list', dump], '');
  } catch {
    throw new RestoreRefused('That backup file is damaged. Choose another backup.');
  }

  const fingerprint = recorded === undefined ? 'none' : 'matches';
  const countsFile = `${dump}.counts.json`;
  if (!existsSync(countsFile)) {
    if (!opts.countsOptional) throw new RestoreRefused('That backup has no row counts beside it, so Flint could not check what it restored.');
    return { path: dump, bytes: st.size, sha256, fingerprint, takenAt };
  }
  let counts: Record<string, number>;
  try {
    counts = JSON.parse(readFileSync(countsFile, 'utf8')) as Record<string, number>;
  } catch {
    throw new RestoreRefused('The row counts beside that backup are not readable.');
  }
  const entries = counts && typeof counts === 'object' && !Array.isArray(counts) ? Object.entries(counts) : [];
  if (entries.length === 0 || entries.some(([k, n]) => !COUNT_KEY.test(k) || !Number.isSafeInteger(n) || n < 0)) {
    throw new RestoreRefused('The row counts beside that backup are not readable.');
  }
  return { path: dump, bytes: st.size, sha256, fingerprint, counts, takenAt };
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

/** How many tables, views and sequences the database holds outside Postgres's own schemas. */
async function userObjects(c: pg.Client): Promise<number> {
  const r = await c.query<{ n: string }>(`
    SELECT count(*) AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname !~ '^pg_' AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')`);
  return Number(r.rows[0]!.n);
}

/**
 * pg_restore `dump` into `target` (the migration owner, on an EMPTY database),
 * then take TEMP away from everyone as the first migration does: that setting
 * lives on the database, and a dump does not carry it.
 */
export async function restoreInto(dump: string, target: PgTarget, tools: Tools): Promise<void> {
  if (await withClient(target, userObjects)) throw new RestoreRefused('The database to restore into is not empty.');
  await run(tools.pgRestore, ['--no-owner', '--exit-on-error', '-h', target.host, '-p', String(target.port), '-U', target.user, '-d', target.database, dump], target.password);
  await withClient(target, async (c) => {
    await c.query(`DO $$
      BEGIN
        EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
        EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM flint_app, flint_approver, flint_backup', current_database());
      END;
    $$`);
  });
}

export interface MigrationState {
  /** Applied in the database and known to this checkout. */
  applied: string[];
  /** In this checkout, not yet in the database. */
  pending: string[];
  /** In the database, unknown to this checkout: the backup is from a newer Flint. */
  unknown: string[];
  /** Started and never finished. */
  unfinished: string[];
}

/** The migration directories of this checkout, oldest first. */
export function migrationNames(migrationsDir: string): string[] {
  return readdirSync(migrationsDir).filter((d) => /^\d{14}_[a-z0-9_]+$/.test(d)).sort();
}

async function migrationState(c: pg.Client, migrationsDir: string): Promise<MigrationState> {
  const known = migrationNames(migrationsDir);
  const has = (await c.query<{ t: string | null }>(`SELECT to_regclass('public._prisma_migrations') AS t`)).rows[0]!.t;
  const rows = has
    ? (await c.query<{ name: string; done: boolean; rolled: boolean }>(
        `SELECT migration_name AS name, finished_at IS NOT NULL AS done, rolled_back_at IS NOT NULL AS rolled FROM _prisma_migrations ORDER BY started_at`,
      )).rows
    : [];
  const live = rows.filter((r) => !r.rolled);
  const done = new Set(live.filter((r) => r.done).map((r) => r.name));
  return {
    applied: known.filter((k) => done.has(k)),
    pending: known.filter((k) => !done.has(k)),
    unknown: [...done].filter((n) => !known.includes(n)).sort(),
    unfinished: live.filter((r) => !r.done).map((r) => r.name),
  };
}

export interface Verified {
  ok: boolean;
  tables: number;
  mismatches: Array<{ table: string; expected: number; restored: number | null }>;
  /** What is wrong, each a short phrase; empty when nothing is. */
  problems: string[];
  migrations: MigrationState;
}

/**
 * Is the restored database what the backup said it was, and safe to run on?
 *  - every table's row count equals the count taken in the dump's snapshot
 *    (`counts` undefined skips this: after a migration the tables have changed);
 *  - everything is owned by the migration owner, and no application role is a
 *    superuser, may create roles or databases, or skips row security;
 *  - the application roles hold the privileges the runtime needs and none of the
 *    ones the governance rules deny them;
 *  - the migrations it holds are ones this checkout knows, each finished.
 */
export async function verifyRestored(target: PgTarget, counts: Record<string, number> | undefined, migrationsDir: string): Promise<Verified> {
  return withClient(target, async (c) => {
    const problems: string[] = [];
    let mismatches: Verified['mismatches'] = [];
    if (counts) {
      const restored = await countRows(c);
      mismatches = Object.entries(counts)
        .filter(([table, n]) => restored[table] !== n)
        .map(([table, n]) => ({ table, expected: n, restored: restored[table] ?? null }));
      const extra = Object.keys(restored).filter((t) => !(t in counts));
      if (mismatches.length) problems.push(`row counts differ in ${mismatches.length} table(s)`);
      if (extra.length) problems.push(`${extra.length} table(s) the backup did not list`);
    }

    const strangers = Number((await c.query<{ n: string }>(`
      SELECT count(*) AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname !~ '^pg_' AND c.relowner <> current_user::regrole`)).rows[0]!.n);
    if (strangers) problems.push(`${strangers} object(s) not owned by the migration owner`);

    const roles = await c.query<{ rolname: string }>(`
      SELECT rolname FROM pg_roles
      WHERE rolname IN ('flint_app', 'flint_approver', 'flint_backup') AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolbypassrls)`);
    for (const r of roles.rows) problems.push(`${r.rolname} has more power than an application role may`);
    const present = (await c.query<{ rolname: string }>(`SELECT rolname FROM pg_roles WHERE rolname IN ('flint_app', 'flint_approver', 'flint_backup')`)).rows.map((r) => r.rolname);
    for (const role of ['flint_app', 'flint_approver', 'flint_backup']) if (!present.includes(role)) problems.push(`the role ${role} does not exist`);

    if (present.length === 3) {
      // [role, privilege, table, must it hold it?]: the governance rules, as the grants enforce them.
      const table: Array<[string, string, string, boolean]> = [
        ['flint_app', 'SELECT', '"Proposal"', true],
        ['flint_app', 'INSERT', '"Proposal"', true],
        ['flint_app', 'INSERT', '"AuditEntry"', true],
        ['flint_app', 'SELECT', '"Approval"', true],
        ['flint_approver', 'INSERT', '"Approval"', true],
        ['flint_backup', 'SELECT', '"Proposal"', true],
        ['flint_app', 'INSERT', '"Approval"', false],
        ['flint_app', 'UPDATE', '"AuditEntry"', false],
        ['flint_app', 'DELETE', '"AuditEntry"', false],
        ['flint_app', 'DELETE', '"Proposal"', false],
        ['flint_approver', 'SELECT', '"Proposal"', false],
        ['flint_backup', 'INSERT', '"AuditEntry"', false],
      ];
      for (const [role, privilege, name, must] of table) {
        const r = await c.query<{ held: boolean | null }>(
          `SELECT CASE WHEN to_regclass($3) IS NULL THEN NULL ELSE has_table_privilege($1, to_regclass($3), $2) END AS held`,
          [role, privilege, `public.${name}`],
        );
        const held = r.rows[0]!.held;
        if (held === null) problems.push(`the table ${name} is missing`);
        else if (held !== must) problems.push(`${role} ${must ? 'cannot' : 'can'} ${privilege} ${name}`);
      }
      const loose = await c.query<{ rolname: string; what: string }>(`
        SELECT r.rolname, 'TEMP' AS what FROM pg_roles r
         WHERE r.rolname IN ('flint_app', 'flint_approver', 'flint_backup') AND has_database_privilege(r.oid, current_database(), 'TEMP')
        UNION ALL
        SELECT r.rolname, 'CREATE in ' || n.nspname FROM pg_roles r CROSS JOIN pg_namespace n
         WHERE r.rolname IN ('flint_app', 'flint_approver', 'flint_backup') AND n.nspname IN ('public', 'flint_part', 'pgboss')
           AND has_schema_privilege(r.oid, n.oid, 'CREATE')`);
      for (const r of loose.rows) problems.push(`${r.rolname} holds ${r.what}`);
    }

    const migrations = await migrationState(c, migrationsDir);
    if (migrations.applied.length === 0) problems.push('no Flint migration is recorded');
    if (migrations.unknown.length) problems.push(`the backup is from a newer Flint than this copy of the code (${migrations.unknown.length} migration(s) it does not know)`);
    if (migrations.unfinished.length) problems.push(`${migrations.unfinished.length} migration(s) never finished`);

    return { ok: problems.length === 0, tables: counts ? Object.keys(counts).length : 0, mismatches, problems, migrations };
  });
}

/** What Will reads on a card that was approved before the backup and so did not run. */
export const VOIDED_BY_RESTORE = 'This was approved before the database was restored from a backup, so it did not run. Approve it again.';

/**
 * Nothing signed before the backup may act after it: every unused approval is
 * marked used, and every card that was approved (or had started) and not
 * finished is marked failed. Both are moves the governance triggers allow.
 */
export async function voidSignedWork(target: PgTarget): Promise<{ approvals: number; proposals: number }> {
  return withClient(target, async (c) => {
    await c.query('BEGIN');
    try {
      const a = await c.query(`UPDATE "Approval" SET "consumedAt" = now() WHERE "consumedAt" IS NULL`);
      const p = await c.query(`UPDATE "Proposal" SET status = 'failed', error = $1, "executedAt" = now() WHERE status IN ('approved', 'executing')`, [VOIDED_BY_RESTORE]);
      await c.query('COMMIT');
      return { approvals: a.rowCount ?? 0, proposals: p.rowCount ?? 0 };
    } catch (err) {
      await c.query('ROLLBACK').catch(() => {});
      throw err;
    }
  });
}

type AuditInputs = Record<string, string | number | boolean | null>;

/**
 * The restore's own audit entry, written as the runtime's role (flint_app): if
 * the restored grants did not let the runtime write its audit trail, this fails
 * and the restore with it. Ids, hashes and numbers only.
 */
async function auditRestore(app: PgTarget, inputs: AuditInputs, now: Date): Promise<void> {
  for (const v of Object.values(inputs)) if (typeof v === 'string' && v.length > 200) throw new Error('an audit input is over 200 characters');
  await withClient(app, (c) =>
    c.query(
      `INSERT INTO "AuditEntry" (id, at, actor, context, kind, action, tier, inputs, decision, outcome)
       VALUES ($1, $2, 'will:cli', 'console', 'action', 'restore.production', 'approval', $3, 'act', 'ok')`,
      [`au${now.getTime().toString(36)}${Math.random().toString(36).slice(2, 12)}`, now, JSON.stringify(inputs)],
    ),
  );
}

export interface RestoreResult {
  /** The backup that was restored. */
  dump: string;
  sha256: string;
  fingerprint: DumpCheck['fingerprint'];
  /** Tables whose row counts were compared with the backup's own; 0 when it came without counts. */
  tables: number;
  /** Migrations this checkout has that the backup did not (applied by restoreProduction; left for the installer by a rebuild). */
  pending: string[];
  approvals: number;
  proposals: number;
  seconds: number;
  /** A rebuild run again: this same backup was already restored here, so nothing was done. */
  already?: boolean;
}

export interface EmptyRestore {
  dump: string;
  /** flint_owner, on the empty database. */
  owner: string;
  /** flint_app, on the same database. */
  app: string;
  tools: Tools;
  migrationsDir: string;
  now?: Date;
}

/**
 * A rebuilt Mac: restore `dump` into the empty database, check it, void what was
 * signed, and write the audit entry. Migrations the backup lacks are left for
 * the runtime's installer, which takes its own copy before applying them.
 */
export async function restoreIntoEmpty(o: EmptyRestore): Promise<RestoreResult> {
  const started = Date.now();
  const now = o.now ?? new Date();
  const owner = targetOf(o.owner);
  // An offsite copy made before the counts went offsite too has none: its structure, owners, grants and migrations are still checked.
  const check = await checkDump(o.dump, o.tools, { countsOptional: true });
  // A rebuild that stopped later and is run again: the database already holds exactly this backup
  // (its own audit entry says so, by fingerprint). Anything else in a database that is not empty is refused.
  if (await withClient(owner, (c) => alreadyRestored(c, check.sha256))) {
    const v = await verifyRestored(owner, undefined, o.migrationsDir);
    if (!v.ok) throw new RestoreRefused(`The database restored earlier does not pass its checks: ${v.problems.join('; ')}.`);
    return { dump: o.dump, sha256: check.sha256, fingerprint: check.fingerprint, tables: 0, pending: v.migrations.pending, approvals: 0, proposals: 0, seconds: 0, already: true };
  }
  await restoreInto(o.dump, owner, o.tools);
  const v = await verifyRestored(owner, check.counts, o.migrationsDir);
  if (!v.ok) throw new RestoreRefused(`The restored database did not pass its checks: ${v.problems.join('; ')}.`);
  const voided = await voidSignedWork(owner);
  const seconds = Math.round((Date.now() - started) / 1000);
  await auditRestore(targetOf(o.app), { mode: 'rebuild', sha256: check.sha256, tables: v.tables, pending: v.migrations.pending.length, approvals: voided.approvals, proposals: voided.proposals, seconds }, now);
  return { dump: o.dump, sha256: check.sha256, fingerprint: check.fingerprint, tables: v.tables, pending: v.migrations.pending, ...voided, seconds };
}

/** Did an earlier rebuild already restore the backup with this fingerprint into this database? */
async function alreadyRestored(c: pg.Client, sha256: string): Promise<boolean> {
  const has = (await c.query<{ t: string | null }>(`SELECT to_regclass('public."AuditEntry"') AS t`)).rows[0]!.t;
  if (!has) return false;
  const r = await c.query(`SELECT 1 FROM "AuditEntry" WHERE action = 'restore.production' AND inputs->>'mode' = 'rebuild' AND inputs->>'sha256' = $1 LIMIT 1`, [sha256]);
  return (r.rowCount ?? 0) > 0;
}

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
}

export interface ProductionRestore {
  dump: string;
  /** flint_owner on the production database. */
  owner: string;
  /** flint_app on the production database. */
  app: string;
  /** flint_backup on the production database: the copy taken first. */
  backup?: string;
  /** Where that copy goes (~/FlintBackups/pre-restore). */
  copyDir: string;
  /** Restore although the copy of the current database could not be taken. */
  withoutCopy?: boolean;
  tools: Tools;
  migrationsDir: string;
  /** Apply this checkout's pending migrations to the database at `ownerUrl` (prisma migrate deploy). */
  migrate(ownerUrl: string): Promise<void>;
  /** Will's typed confirmation; false leaves everything as it was. Not asked for a trial run. */
  confirm(summary: RestoreSummary): Promise<boolean>;
  /**
   * A trial run: restore beside the database in use, run every check, then drop
   * the copy. Nothing is renamed, the runtime is not stopped, no copy of the
   * current database is taken, and nothing is asked. It says how long a real
   * restore would take.
   */
  checkOnly?: boolean;
  stopRuntime(): Promise<void>;
  startRuntime(): Promise<void>;
  /** The sha256 recorded when the dump was taken (its BackupRun row), when the database can still say. */
  recordedSha256?(dump: string): Promise<string | undefined>;
  say(line: string): void;
  now?: Date;
  /** How long to wait for other sessions to leave the production database (default 60 s). */
  drainMs?: number;
}

export interface ProductionResult extends RestoreResult {
  /** A trial run: the copy passed and was dropped; nothing changed. */
  checkedOnly?: boolean;
  database: string;
  /** The database that was in use, kept under this name. */
  keptAs: string;
  /** The copy of it taken first, when one could be. */
  copy?: string;
  /** False when the restore is done and the runtime did not start again by itself. */
  runtimeStarted?: boolean;
}

const withDatabase = (t: PgTarget, database: string): PgTarget => ({ ...t, database });
const urlOf = (base: string, database: string): string => {
  const u = new URL(base);
  u.pathname = `/${database}`;
  return u.toString();
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A session on the cluster's maintenance database, where databases are created and renamed from. */
async function maintenance<T>(owner: PgTarget, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  let last: unknown;
  for (const database of ['postgres', 'template1']) {
    const c = client(withDatabase(owner, database));
    try {
      await c.connect();
    } catch (err) {
      last = err;
      continue;
    }
    try {
      return await fn(c);
    } finally {
      await c.end().catch(() => {});
    }
  }
  throw new RestoreRefused(`Flint could not reach the database server (${message(last).slice(0, 120)}).`);
}

/**
 * `restore.production`: replace the production database with `dump`.
 *
 * Refused, with nothing changed, when: the dump fails checkDump; Will does not
 * confirm; the copy of the current database cannot be taken (unless
 * `withoutCopy`); the disk has no room; the restored copy fails any check, or
 * its pending migrations fail; or something will not let go of the production
 * database. Only after all of that do the two databases swap names.
 */
export async function restoreProduction(o: ProductionRestore): Promise<ProductionResult> {
  const started = Date.now();
  const now = o.now ?? new Date();
  const owner = targetOf(o.owner);
  const database = owner.database;
  if (!DB_NAME.test(database)) throw new RestoreRefused("The production database's name is not one Flint can rename.");
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'z').toLowerCase();
  const scratch = `${database}_restoring_${stamp}`;
  const keptAs = `${database}_damaged_${stamp}`;
  if (!DB_NAME.test(scratch) || !DB_NAME.test(keptAs)) throw new RestoreRefused("The production database's name is too long to keep a copy under.");

  // 1. The backup itself. The database's own record of its fingerprint, when it can still be asked.
  const recorded = o.recordedSha256 ? await o.recordedSha256(o.dump).catch(() => undefined) : undefined;
  const check = await checkDump(o.dump, o.tools, recorded ? { expectedSha256: recorded } : {});
  const counts = check.counts;
  if (!counts) throw new RestoreRefused('That backup has no row counts beside it, so Flint could not check what it restored.');

  // 2. Room: the restored copy sits beside the database it replaces until Will drops the old one.
  const free = statfsSync(dirname(o.dump));
  if (free.bavail * free.bsize < check.bytes * 8 + 256 * 1024 * 1024) throw new RestoreRefused('This Mac does not have enough free space to restore safely.');

  // 3. No name this run needs may be taken already.
  await maintenance(owner, async (c) => {
    const taken = await c.query<{ datname: string }>('SELECT datname FROM pg_database WHERE datname = ANY($1)', [[scratch, keptAs]]);
    if (taken.rowCount) throw new RestoreRefused('A restore from this same second is already there. Wait a moment and run this again.');
    const exists = await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
    if (!exists.rowCount) throw new RestoreRefused('There is no production database to replace. A rebuild restores into an empty one.');
  });

  // 4. Will's word.
  const summary: RestoreSummary = { name: basename(o.dump), takenAt: check.takenAt, bytes: check.bytes, tables: Object.keys(counts).length, fingerprint: check.fingerprint, database, keptAs };
  if (!o.checkOnly && !(await o.confirm(summary))) throw new RestoreRefused('Nothing was changed.');

  // 5. A copy of the database as it is now, taken with the read-only backup role.
  let copy: string | undefined;
  if (o.checkOnly) {
    // A trial run changes nothing, so there is nothing to copy first.
  } else if (o.backup) {
    try {
      mkdirSync(o.copyDir, { recursive: true, mode: 0o700 });
      const d = await dumpDatabase(o.backup, o.copyDir, o.tools, now);
      writeDumpHash(d.path, d.sha256);
      copy = d.path;
      o.say('Flint copied the current database first.');
    } catch {
      if (!o.withoutCopy) throw new RestoreRefused('Flint could not copy the current database first, so it stopped. Nothing was changed.');
      o.say('Flint could not copy the current database first. It is kept under another name all the same.');
    }
  } else if (!o.withoutCopy) {
    throw new RestoreRefused('Flint has no way to copy the current database first, so it stopped. Nothing was changed.');
  }

  // 6. Restore beside it, and check everything there.
  const scratchOwner = withDatabase(owner, scratch);
  const dropScratch = () => maintenance(owner, (c) => c.query(`DROP DATABASE IF EXISTS ${scratch}`)).catch(() => undefined);
  await maintenance(owner, (c) => c.query(`CREATE DATABASE ${scratch}`));
  let verified: Verified;
  let voided: { approvals: number; proposals: number };
  let pending: string[];
  try {
    await restoreInto(o.dump, scratchOwner, o.tools);
    verified = await verifyRestored(scratchOwner, counts, o.migrationsDir);
    if (!verified.ok) throw new RestoreRefused(`The restored copy did not pass its checks: ${verified.problems.join('; ')}.`);
    pending = verified.migrations.pending;
    if (pending.length) {
      await o.migrate(urlOf(o.owner, scratch));
      const after = await verifyRestored(scratchOwner, undefined, o.migrationsDir);
      if (!after.ok || after.migrations.pending.length) {
        throw new RestoreRefused(`The restored copy could not be brought up to date: ${[...after.problems, ...(after.migrations.pending.length ? ['migrations still pending'] : [])].join('; ')}.`);
      }
    }
    voided = await voidSignedWork(scratchOwner);
    await auditRestore(withDatabase(targetOf(o.app), scratch), {
      mode: 'production', sha256: check.sha256, fingerprint: check.fingerprint, tables: verified.tables, pending: pending.length,
      approvals: voided.approvals, proposals: voided.proposals, copied: copy !== undefined, keptAs,
    }, now);
  } catch (err) {
    await dropScratch();
    if (err instanceof RestoreRefused) throw new RestoreRefused(`${err.message} Nothing was changed.`);
    throw new RestoreRefused(`The backup could not be restored (${message(err).slice(0, 200)}). Nothing was changed.`);
  }
  // A trial run ends here: the copy passed every check, so it is dropped and nothing has changed.
  if (o.checkOnly) {
    await dropScratch();
    return {
      dump: o.dump, sha256: check.sha256, fingerprint: check.fingerprint, tables: verified.tables, pending, ...voided,
      seconds: Math.round((Date.now() - started) / 1000), database, keptAs, checkedOnly: true,
    };
  }
  o.say('The backup restored and passed its checks.');

  // 7. The swap. From here the runtime is down until the new database has the name.
  try {
    await o.stopRuntime();
  } catch (err) {
    await dropScratch();
    await o.startRuntime().catch(() => undefined);
    throw new RestoreRefused(`${err instanceof RestoreRefused ? err.message : 'The runtime could not be stopped.'} Nothing was changed.`);
  }
  /** 0: nothing renamed. 1: the old database has its kept name. 2: the new one has the production name (done). */
  let stage = 0;
  const deadline = () => Date.now() + (o.drainMs ?? 60_000);
  /** Wait until nothing but this session is connected to `name` (a closed session takes a moment to go). */
  const idle = async (c: pg.Client, name: string, until: number): Promise<boolean> => {
    for (;;) {
      const busy = await c.query('SELECT 1 FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [name]);
      if (!busy.rowCount) return true;
      if (Date.now() > until) return false;
      await sleep(250);
    }
  };
  try {
    await maintenance(owner, async (c) => {
      await c.query(`ALTER DATABASE ${database} ALLOW_CONNECTIONS false`);
      if (!(await idle(c, database, deadline()))) {
        throw new RestoreRefused('Something is still using the database, so Flint stopped. Quit anything else that is connected to it and run this again.');
      }
      if (!(await idle(c, scratch, deadline()))) throw new Error('the restored copy is still in use');
      await c.query(`ALTER DATABASE ${database} RENAME TO ${keptAs}`);
      stage = 1;
      await c.query(`ALTER DATABASE ${scratch} RENAME TO ${database}`);
      stage = 2;
      // The kept copy can be opened again (to look at, or to copy out of); nothing is configured to use its name.
      await c.query(`ALTER DATABASE ${keptAs} ALLOW_CONNECTIONS true`).catch(() => undefined);
    });
  } catch (err) {
    if (stage < 2) {
      // Put the name back, let the runtime at it again, and remove the copy that never went live.
      await maintenance(owner, async (c) => {
        if (stage === 1) await c.query(`ALTER DATABASE ${keptAs} RENAME TO ${database}`);
        await c.query(`ALTER DATABASE ${database} ALLOW_CONNECTIONS true`);
      }).catch(() => undefined);
      await dropScratch();
      await o.startRuntime().catch(() => undefined);
      if (err instanceof RestoreRefused) throw new RestoreRefused(`${err.message} Nothing was changed.`);
      throw new RestoreRefused(`The databases could not be swapped (${message(err).slice(0, 200)}). Nothing was changed.`);
    }
  }
  // The databases are swapped whatever happens now: a runtime that will not start is reported, not undone.
  const runtimeStarted = await o.startRuntime().then(() => true, () => false);

  return {
    dump: o.dump, sha256: check.sha256, fingerprint: check.fingerprint, tables: verified.tables, pending, ...voided,
    seconds: Math.round((Date.now() - started) / 1000), database, keptAs, runtimeStarted, ...(copy ? { copy } : {}),
  };
}
