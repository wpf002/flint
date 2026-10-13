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
 *
 * The same three steps back up Nexus's database (P7; backup.nexus,
 * backup.nexus.offsite, restore.drill.nexus). What differs is a BackupSet: how
 * a dump's name begins, which schemas are counted, the scratch database a drill
 * restores into, and that the login which reads Nexus must not be able to
 * change it (readOnly, below).
 */
import { spawn, type ChildProcess } from 'node:child_process';
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
 * A step's tool, or the step as a whole, ran past the time its set allows
 * (StepLimits) and was stopped. Another night may go better: not a setup problem.
 */
export class TookTooLong extends Error {
  constructor(readonly tool: string, readonly ms: number) {
    const n = ms >= 60_000 ? Math.round(ms / 60_000) : Math.max(1, Math.round(ms / 1000));
    super(`${tool} was stopped because it ran longer than ${n} ${ms >= 60_000 ? 'minute' : 'second'}${n === 1 ? '' : 's'}`);
  }
}

/**
 * Stop a tool that heads a process group of its own (spawn's `detached`), and
 * with it everything it started: a helper it forked would otherwise live on,
 * holding the pipes this side reads and the file it was writing.
 *
 * Only while the tool itself has not been seen to end. Until then its number
 * is its own and its group's; afterwards the system may give that number to
 * another process, and a signal sent to it would stop a stranger.
 */
function stopGroup(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    // No group by its number yet (it had only just been started): the tool alone, then.
    child.kill('SIGKILL');
  }
}

/** The signals that end this process from outside. */
const ENDINGS = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const;

/**
 * A tool in a group of its own is no longer stopped along with this process by
 * whoever stops it (launchd ends a job's own group, Ctrl-C the terminal's). So
 * while one runs, this process's end is its end too: when it exits, and on the
 * signals that end it. Returns what takes that watch off again.
 */
function endsWithThis(child: ChildProcess): () => void {
  const stop = (): void => stopGroup(child);
  const onSignal = (signal: NodeJS.Signals): void => {
    stop();
    off();
    // With nobody else listening for it, the signal does what it would have done.
    if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
  };
  const off = (): void => {
    process.off('exit', stop);
    for (const s of ENDINGS) process.off(s, onSignal);
  };
  process.on('exit', stop);
  for (const s of ENDINGS) process.on(s, onSignal);
  return off;
}

/**
 * Run pg_dump or pg_restore. A tool that cannot be started at all (not there, not
 * runnable) is a fault and is passed on as it is; one that ran and failed is a
 * ToolFailed, which says what kind of failure and names no data.
 *
 * With `timeoutMs` the tool heads a process group of its own. One still running
 * then is killed outright with everything it started, and the run fails as
 * TookTooLong at that moment: it does not wait for the tool's pipes to close,
 * which a helper the tool left behind could hold open for as long as it liked.
 * Without it the tool is run exactly as it always was.
 */
export function run(bin: string, args: string[], password: string, opts: { stdoutFile?: string; timeoutMs?: number } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const limited = opts.timeoutMs !== undefined;
    const child = spawn(bin, args, { env: { PATH: '/usr/bin:/bin:/opt/homebrew/bin', PGPASSWORD: password, PGCONNECT_TIMEOUT: '10' }, stdio: ['ignore', 'pipe', 'pipe'], ...(limited ? { detached: true } : {}) });
    const tool = bin.split('/').pop() ?? 'tool';
    const untie = limited ? endsWithThis(child) : undefined;
    let err = '';
    let settled = false;
    const settle = (failure?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(clock);
      untie?.();
      if (failure === undefined) resolve();
      else reject(failure);
    };
    const clock = opts.timeoutMs === undefined ? undefined : setTimeout(() => {
      stopGroup(child);
      child.stdout.destroy();
      child.stderr.destroy();
      settle(new TookTooLong(tool, opts.timeoutMs!));
    }, opts.timeoutMs);
    child.stderr.on('data', (d) => (err = (err + d).slice(-8000)));
    if (opts.stdoutFile) child.stdout.pipe(createWriteStream(opts.stdoutFile, { mode: 0o600 }));
    else child.stdout.resume();
    child.on('error', settle);
    child.on('close', (code) => settle(code === 0 ? undefined : new ToolFailed(tool, code, toolError(err))));
  });
}

/**
 * Which database a backup is of, in the names that keep one set's files apart
 * from another's. Nothing here comes from a setting or a request: there are two
 * sets, both written below.
 */
export interface BackupSet {
  /** How a dump's file name begins: `flint` gives flint-<time>.dump. Small letters only. */
  prefix: string;
  /** The schemas whose tables are counted with the dump and compared by a drill. */
  schemas: readonly string[];
  /** The scratch database a drill restores into and drops. Its name ends `_restore_test`, so it is never a database anyone keeps. */
  scratch: string;
  /** What its records are filed under (BackupRun.kind). */
  kind: 'pg_dump_flint' | 'nexus_dump';
  /**
   * The login that dumps it must hold no right to change it: checked before
   * each dump, in the dump's own connection (writeRights says what is looked
   * for, and what no check of rights can rule out), and a login that holds
   * one is refused (NotReadOnly). Nexus's database is not Flint's to change.
   */
  readOnly?: boolean;
  /**
   * How long its steps may wait and run, for a database someone else is using
   * and changing: nothing there may hold Flint's night up. Flint's own set has
   * none, and its commands are word for word what they were.
   */
  limits?: StepLimits;
}

/**
 * Each of these but the last is per tool and per statement: a limit on ONE
 * tool's run or ONE statement. A step has several of each: a dump counts every
 * table with a statement of its own before pg_dump runs, an offsite copy runs
 * age twice (the dump, then its row counts), and a restore test waits,
 * restores and then counts. `stepMs` is the limit on a whole step, whatever
 * its parts add up to (StepClock).
 */
export interface StepLimits {
  /** How long pg_dump waits for a lock someone holds in that database, before it gives up (its --lock-wait-timeout). */
  lockWaitMs: number;
  /** The most one run of pg_dump may take, and any one statement before it (the check of the login, each table's count). */
  dumpMs: number;
  /** The most one run of age may take. */
  offsiteMs: number;
  /** The most one run of pg_restore may take, and any one statement of the comparison after it. */
  drillMs: number;
  /** How long a restore test waits for another one that is using the same scratch database, before it says so and ends. */
  drillWaitMs: number;
  /**
   * The most a whole step may take: the backup, the offsite copy or the restore
   * test, from its first statement to its last. Each tool and statement in it
   * is given its own limit or what is left of this one, whichever is less, so
   * a step can never outlast the night however many parts it has.
   */
  stepMs: number;
}

/**
 * One step's time, counted from when it began (StepLimits.stepMs). Each part
 * of the step asks it how long that part may take.
 */
export class StepClock {
  private readonly ends: number;
  constructor(private readonly ms: number, readonly what: string) {
    this.ends = Date.now() + ms;
  }
  /** Whether the step's time is up. (A timer may fire a moment before its time: the last few milliseconds count as up.) */
  get over(): boolean {
    return Date.now() >= this.ends - 20;
  }
  /** The step ran too long: said of the step itself, whichever part it was in. */
  late(): TookTooLong {
    return new TookTooLong(this.what, this.ms);
  }
  /** What one part may take, in whole milliseconds: its own limit, or what is left of the step's when that is less. With nothing left the step ends here. */
  left(ms: number): number {
    const left = Math.floor(this.ends - Date.now());
    if (left <= 0) throw this.late();
    return Math.max(1, Math.min(Math.trunc(ms), left));
  }
}

/** The clock for one step of a set that has limits; none for Flint's own set, whose steps run as they always have. */
export const stepClock = (set: BackupSet, what: string): StepClock | undefined => (set.limits ? new StepClock(set.limits.stepMs, what) : undefined);

/** Run a step under its clock. Once the step's time is up, whatever ended it is said as the step having run too long. */
export async function withinStep<T>(clock: StepClock | undefined, step: () => Promise<T>): Promise<T> {
  if (!clock) return step();
  try {
    return await step();
  } catch (err) {
    throw clock.over ? clock.late() : err;
  }
}

export const FLINT_SET: BackupSet = { prefix: 'flint', schemas: ['public'], scratch: 'flint_restore_test', kind: 'pg_dump_flint' };
/** Nexus keeps everything in `public` (its own migrations make no other schema). */
export const NEXUS_SET: BackupSet = {
  prefix: 'nexus', schemas: ['public'], scratch: 'nexus_restore_test', kind: 'nexus_dump', readOnly: true,
  limits: { lockWaitMs: 15_000, dumpMs: 20 * 60_000, offsiteMs: 20 * 60_000, drillMs: 30 * 60_000, drillWaitMs: 2 * 60_000, stepMs: 60 * 60_000 },
};

/** A set's names are built into file patterns and statements, so each is held to its shape first. */
export function checkedSet(set: BackupSet): BackupSet {
  if (!/^[a-z]{2,16}$/.test(set.prefix)) throw new Error('a backup set’s prefix is small letters only');
  if (!set.schemas.length || set.schemas.some((n) => !/^[a-z_][a-z0-9_]{0,62}$/.test(n))) throw new Error('a backup set names at least one schema, each a plain name');
  if (!/^[a-z]{2,16}_restore_test(_[a-z0-9]{1,24})?$/.test(set.scratch)) throw new Error('a backup set’s scratch database is named <something>_restore_test');
  if (set.limits && Object.values(set.limits).some((ms) => !Number.isInteger(ms) || ms < 100 || ms > 24 * 3_600_000)) throw new Error('a backup set’s limits are whole milliseconds, under a day');
  return set;
}

/** A dump's file name in a set: its prefix, its time, `.dump`. */
const dumpName = (prefix: string): RegExp => new RegExp(`^${prefix}-.*\\.dump$`);

export async function sha256File(path: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest('hex');
}

/**
 * Row counts of every table in the named schemas (`public` for Flint: its
 * partitions are counted through their parent). `each`, when given, is run
 * before every statement here (a set with limits sets that statement's time
 * limit with it); Flint's own counting passes none.
 */
export async function countRows(c: pg.Client, schemas: readonly string[] = FLINT_SET.schemas, each?: () => Promise<unknown>): Promise<Record<string, number>> {
  await each?.();
  const tables = await c.query<{ name: string }>(`
    SELECT format('%I.%I', n.nspname, c.relname) AS name
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = ANY($1) AND c.relkind IN ('r', 'p') AND c.relname <> '_prisma_migrations'
    ORDER BY 1`, [[...schemas]]);
  const out: Record<string, number> = {};
  for (const { name } of tables.rows) {
    await each?.();
    out[name] = Number((await c.query<{ n: string }>(`SELECT count(*) AS n FROM ${name}`)).rows[0]!.n);
  }
  return out;
}

export interface DumpResult {
  path: string;
  bytes: number;
  sha256: string;
  counts: Record<string, number>;
  /** How many large objects the database held, which no dump includes (DUMP_FORMAT). Counted only for a set that is not Flint's own. */
  largeObjects?: number;
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

/** The file a dump taken at `now` is written to (its name is its set's prefix and its time). */
export const dumpPathAt = (outDir: string, now: Date, prefix: string = FLINT_SET.prefix): string => join(outDir, `${prefix}-${now.toISOString().replace(/[:.]/g, '-')}.dump`);

/**
 * What a login holds that would let it change the database it is asked to
 * back up, each as a few words. The names are fixed here; none holds a role's
 * or an object's name.
 */
export const WRITE_RIGHTS = {
  attribute: 'it is a superuser, may pass row security, may make roles or may replicate',
  role: 'it belongs to one of Postgres’s own roles that is not read-only',
  ownsDatabase: 'it owns the database',
  createInDatabase: 'it may make schemas in the database',
  schema: 'it owns a schema or may make things in one',
  table: 'it owns a table or a view, or holds a right to change, lock or hang a trigger on one',
  column: 'it may change a column of a table',
  sequence: 'it owns a sequence or may advance one',
  routine: 'it owns a function',
  type: 'it owns a type',
  foreign: 'it owns or may use a foreign server or a foreign data wrapper',
  largeObject: 'it owns a large object or may change one',
  grantOption: 'it may hand a right of its own on to another login',
  owner: 'it owns something in the database',
} as const;
export type WriteRight = keyof typeof WRITE_RIGHTS;

/**
 * The kinds a database can give to every login at once (Postgres's PUBLIC),
 * each as what every login may then do. A right held this way is not the
 * backup login's to give up: the database's own side takes it back from
 * everyone, or it stays (openRights).
 */
export const EVERYONE_RIGHTS = {
  createInDatabase: 'make schemas in the database',
  schema: 'make things in a schema',
  table: 'change, lock or hang a trigger on a table or a view',
  column: 'change a column of a table',
  sequence: 'advance a sequence',
  foreign: 'use a foreign server or a foreign data wrapper',
  largeObject: 'change a large object',
} as const satisfies Partial<Record<WriteRight, string>>;
export type EveryoneRight = keyof typeof EVERYONE_RIGHTS;

/**
 * The login may change the database it is asked to back up. Never tried again
 * as it is: its setup needs fixing (needsSetup, below). `rights` says which
 * kinds of right were found (WRITE_RIGHTS), never whose or on what; `everyone`
 * says which of those kinds the database gives to every login (EVERYONE_RIGHTS),
 * so what is said about it can say whose change it is.
 */
export class NotReadOnly extends Error {
  readonly everyone: readonly EveryoneRight[];
  constructor(readonly rights: readonly WriteRight[] = [], everyone: readonly WriteRight[] = []) {
    const open = rights.filter((r): r is EveryoneRight => r in EVERYONE_RIGHTS && everyone.includes(r));
    super(`the login that reads this database holds a right to change it, so nothing was backed up${rights.length ? ` (${rights.map((r) => ((open as readonly WriteRight[]).includes(r) ? `every login may ${EVERYONE_RIGHTS[r as EveryoneRight]}` : WRITE_RIGHTS[r])).join('; ')})` : ''}`);
    this.everyone = open;
  }
  /** The kinds found that are the login's own to give up: every kind but the ones the database gives to everyone. */
  get own(): WriteRight[] {
    return this.rights.filter((r) => !(this.everyone as readonly WriteRight[]).includes(r));
  }
}

/**
 * Postgres's own roles a read-only login may belong to: reading every table,
 * and reading the server's own statistics and settings. Any other of them
 * (writing every table, maintaining them, signalling other sessions, reading
 * or writing the server's files, and whatever a later Postgres adds) is not
 * read-only. pg_database_owner is not listed and not refused by name: it means
 * "owns this database", which is asked on its own below.
 */
const READ_ONLY_ROLES = ['pg_read_all_data', 'pg_monitor', 'pg_read_all_settings', 'pg_read_all_stats', 'pg_stat_scan_tables'] as const;

/**
 * Every kind of right the login on `c` holds that would let it change the
 * database it is connected to; empty when it holds none. Asked of the server's
 * own records of who may do what, in the connection the dump is counted on: no
 * table is read for it.
 *
 * It is asked of EVERY role the login is a member of, not only the ones whose
 * rights it has without asking: a membership it can only use through SET ROLE,
 * or only hand on to itself (ADMIN), is one command away from the same rights.
 * For each of those roles:
 *  - an attribute that passes every check (superuser, BYPASSRLS), makes roles
 *    or replicates;
 *  - one of Postgres's own roles that is not read-only;
 *  - owning the database, or leave to make schemas in it;
 *  - owning a schema, or leave to make things in one;
 *  - owning a table, view or foreign table, or any right on one but reading:
 *    INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN (which
 *    locks, rewrites and reindexes);
 *  - INSERT, UPDATE or REFERENCES on any one column;
 *  - owning a sequence, or USAGE or UPDATE on one (either moves it on);
 *  - owning a foreign server or a foreign data wrapper, or USAGE on one (which
 *    is leave to point the database at another one);
 *  - owning a large object, or UPDATE on one;
 *  - a right of any kind that it may hand on to another login (WITH GRANT
 *    OPTION), reading included: handing it on changes who may do what;
 *  - owning a function, a type, or anything else in the database (the
 *    server's record of who owns what covers extensions, operators and the
 *    rest).
 * Rights given to everyone (PUBLIC) count as the login's own; openRights says
 * which kinds are held that way.
 *
 * What this does NOT rule out, because Postgres gives it to every login that
 * can connect: calling a function its owner opened to everyone (one that runs
 * with its owner's rights can then write), making temporary tables, making a
 * large object of its own, sending a notification (NOTIFY), and the ordinary
 * read locks a dump takes while it runs.
 */
export async function writeRights(c: pg.Client): Promise<WriteRight[]> {
  return rightsOf(c, `
      SELECT g.oid, g.rolname, g.rolsuper, g.rolbypassrls, g.rolcreaterole, g.rolreplication
        FROM pg_roles g
       WHERE pg_has_role(current_user, g.oid, 'MEMBER') OR pg_has_role(current_user, g.oid, 'MEMBER WITH ADMIN OPTION')`, 'me.oid');
}

/**
 * Which kinds of right to change the database it gives to every login
 * (PUBLIC): the same questions as writeRights, asked of everyone instead of
 * the login. CREATE in schema public is one, in a database carried over from
 * before Postgres 15. Such a right is no login's own to give up.
 */
export async function openRights(c: pg.Client): Promise<EveryoneRight[]> {
  // Postgres's name for everyone, as its own has_..._privilege functions take it; 0 is how its records write it.
  const held = await rightsOf(c, `SELECT 0::oid AS oid, 'public'::name AS rolname, false AS rolsuper, false AS rolbypassrls, false AS rolcreaterole, false AS rolreplication`, `'public'::name`);
  return held.filter((k): k is EveryoneRight => k in EVERYONE_RIGHTS);
}

/**
 * The questions themselves, asked of the roles `me` selects (each with its oid,
 * name and attributes). `who` is how one of them is named to Postgres's own
 * has_..._privilege functions: its oid, or the name `public`.
 */
async function rightsOf(c: pg.Client, me: string, who: string): Promise<WriteRight[]> {
  const { rows } = await c.query<Record<WriteRight, boolean | null>>(`
    WITH me AS (${me}
    ), db AS (
      SELECT d.oid, d.datdba, d.datacl FROM pg_database d WHERE d.datname = current_database()
    ), nsp AS (
      SELECT n.oid, n.nspowner, n.nspacl FROM pg_namespace n WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
    ), given AS (
      -- Every right on record in this database that its holder may hand on.
                SELECT x.grantee FROM db, aclexplode(db.datacl) x WHERE x.is_grantable
      UNION ALL SELECT x.grantee FROM nsp, aclexplode(nsp.nspacl) x WHERE x.is_grantable
      UNION ALL SELECT x.grantee FROM pg_class r JOIN nsp ON nsp.oid = r.relnamespace, aclexplode(r.relacl) x WHERE x.is_grantable
      UNION ALL SELECT x.grantee FROM pg_attribute a JOIN pg_class r ON r.oid = a.attrelid JOIN nsp ON nsp.oid = r.relnamespace, aclexplode(a.attacl) x WHERE x.is_grantable
      UNION ALL SELECT x.grantee FROM pg_proc p JOIN nsp ON nsp.oid = p.pronamespace, aclexplode(p.proacl) x WHERE x.is_grantable
      UNION ALL SELECT x.grantee FROM pg_type t JOIN nsp ON nsp.oid = t.typnamespace, aclexplode(t.typacl) x WHERE x.is_grantable
      UNION ALL SELECT x.grantee FROM pg_language l, aclexplode(l.lanacl) x WHERE x.is_grantable
      UNION ALL SELECT x.grantee FROM pg_largeobject_metadata m, aclexplode(m.lomacl) x WHERE x.is_grantable
      UNION ALL SELECT x.grantee FROM pg_foreign_server f, aclexplode(f.srvacl) x WHERE x.is_grantable
      UNION ALL SELECT x.grantee FROM pg_foreign_data_wrapper w, aclexplode(w.fdwacl) x WHERE x.is_grantable
    )
    SELECT
      EXISTS (SELECT 1 FROM me WHERE rolsuper OR rolbypassrls OR rolcreaterole OR rolreplication) AS "attribute",
      EXISTS (SELECT 1 FROM me WHERE rolname ~ '^pg_' AND rolname <> 'pg_database_owner' AND rolname <> ALL ($1::text[])) AS "role",
      EXISTS (SELECT 1 FROM db JOIN me ON me.oid = db.datdba) AS "ownsDatabase",
      EXISTS (SELECT 1 FROM db, me WHERE has_database_privilege(${who}, db.oid, 'CREATE')) AS "createInDatabase",
      EXISTS (SELECT 1 FROM nsp, me WHERE nsp.nspowner = me.oid OR has_schema_privilege(${who}, nsp.oid, 'CREATE')) AS "schema",
      EXISTS (SELECT 1 FROM pg_class r JOIN nsp ON nsp.oid = r.relnamespace, me
               WHERE r.relkind IN ('r', 'p', 'v', 'm', 'f')
                 AND (r.relowner = me.oid OR has_table_privilege(${who}, r.oid, 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'))) AS "table",
      EXISTS (SELECT 1 FROM pg_class r JOIN nsp ON nsp.oid = r.relnamespace, me
               WHERE r.relkind IN ('r', 'p', 'v', 'm', 'f') AND has_any_column_privilege(${who}, r.oid, 'INSERT, UPDATE, REFERENCES')) AS "column",
      EXISTS (SELECT 1 FROM pg_class r JOIN nsp ON nsp.oid = r.relnamespace, me
               WHERE r.relkind = 'S' AND (r.relowner = me.oid OR has_sequence_privilege(${who}, r.oid, 'USAGE, UPDATE'))) AS "sequence",
      EXISTS (SELECT 1 FROM pg_proc p JOIN nsp ON nsp.oid = p.pronamespace JOIN me ON me.oid = p.proowner) AS "routine",
      EXISTS (SELECT 1 FROM pg_type t JOIN nsp ON nsp.oid = t.typnamespace JOIN me ON me.oid = t.typowner) AS "type",
      (EXISTS (SELECT 1 FROM pg_foreign_server f, me WHERE f.srvowner = me.oid OR has_server_privilege(${who}, f.oid, 'USAGE'))
        OR EXISTS (SELECT 1 FROM pg_foreign_data_wrapper w, me WHERE w.fdwowner = me.oid OR has_foreign_data_wrapper_privilege(${who}, w.oid, 'USAGE'))) AS "foreign",
      -- (Postgres 17 has no has_..._privilege for a large object: its own list of who may do what is read instead. 0 there is everyone.)
      EXISTS (SELECT 1 FROM pg_largeobject_metadata m, me
               WHERE m.lomowner = me.oid
                  OR EXISTS (SELECT 1 FROM aclexplode(m.lomacl) x WHERE x.privilege_type = 'UPDATE' AND x.grantee IN (me.oid, 0))) AS "largeObject",
      EXISTS (SELECT 1 FROM given JOIN me ON me.oid = given.grantee) AS "grantOption",
      EXISTS (SELECT 1 FROM pg_shdepend s JOIN db ON db.oid = s.dbid JOIN me ON me.oid = s.refobjid
               WHERE s.refclassid = 'pg_authid'::regclass AND s.deptype = 'o') AS "owner"`, [[...READ_ONLY_ROLES]]);
  const said = rows[0];
  // No answer at all is not "no rights": the check then counts as failed, and nothing is dumped.
  if (!said) return ['attribute'];
  return (Object.keys(WRITE_RIGHTS) as WriteRight[]).filter((k) => said[k] !== false);
}

/** Whether the login on `c` holds any right that would let it change the database it is connected to (writeRights). */
export async function canWrite(c: pg.Client): Promise<boolean> {
  return (await writeRights(c)).length > 0;
}

/**
 * One consistent dump plus its counts. The file appears only when complete.
 * For a set with limits the whole of it is one step under one clock, and each
 * statement and the tool is given its own limit or what is left of the step's.
 */
export async function dumpDatabase(backupUrl: string, outDir: string, tools: Tools, now: Date, of: BackupSet = FLINT_SET): Promise<DumpResult> {
  const set = checkedSet(of);
  const clock = stepClock(set, 'the backup');
  return withinStep(clock, () => dumpWithin(clock, backupUrl, outDir, tools, now, set));
}

async function dumpWithin(clock: StepClock | undefined, backupUrl: string, outDir: string, tools: Tools, now: Date, set: BackupSet): Promise<DumpResult> {
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  chmodSync(outDir, 0o700);
  const t = targetOf(backupUrl);
  const final = dumpPathAt(outDir, now, set.prefix);
  const partial = `${final}.partial`;
  const c = client(t);
  await c.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const limits = clock && set.limits;
    // No one statement here outlasts its own limit, nor all of them the step's: the limit is set again before each.
    // (Waiting on a lock ends sooner: client().) It sets no snapshot: the transaction's is still its first query's.
    const paced = limits ? () => c.query(`SET LOCAL statement_timeout = ${clock.left(limits.dumpMs)}`) : undefined;
    if (set.readOnly) {
      await paced?.();
      const rights = await writeRights(c);
      if (rights.length) throw new NotReadOnly(rights, await openRights(c));
    }
    await paced?.();
    const snapshot = (await c.query<{ s: string }>('SELECT pg_export_snapshot() AS s')).rows[0]!.s;
    const counts = await countRows(c, set.schemas, paced);
    // Said, never dumped: what is left out of this database's backup.
    await paced?.();
    const largeObjects = set.readOnly ? Number((await c.query<{ n: string }>('SELECT count(*) AS n FROM pg_largeobject_metadata')).rows[0]!.n) : undefined;
    // In a database others are changing, pg_dump gives up on a lock someone holds instead of waiting on it all night.
    const patient = limits ? [`--lock-wait-timeout=${Math.trunc(limits.lockWaitMs)}`] : [];
    await run(tools.pgDump, [...DUMP_FORMAT, ...patient, `--snapshot=${snapshot}`, '-h', t.host, '-p', String(t.port), '-U', t.user, '-d', t.database, '-f', partial], t.password, limits ? { timeoutMs: clock.left(limits.dumpMs) } : {});
    await c.query('COMMIT');
    chmodSync(partial, 0o600);
    renameSync(partial, final);
    writeFileSync(`${final}.counts.json`, JSON.stringify(counts), { mode: 0o600 });
    return { path: final, bytes: statSync(final).size, sha256: await sha256File(final), counts, ...(largeObjects === undefined ? {} : { largeObjects }) };
  } catch (err) {
    rmSync(partial, { force: true });
    throw err;
  } finally {
    await c.end().catch(() => {});
  }
}

/** Keep the newest `keep` dumps of a set (and their counts and fingerprint files). Only that set's own names are ever removed. */
export function pruneDumps(dir: string, keep: number, prefix: string = FLINT_SET.prefix): string[] {
  if (!existsSync(dir)) return [];
  const mine = dumpName(checkedSet({ ...FLINT_SET, prefix }).prefix);
  const dumps = readdirSync(dir).filter((f) => mine.test(f)).sort();
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
  // (A tool stopped for taking too long, and a restore test held up by another one, are not: neither says
  // anything below takes for a setup problem, and another night may go better.)
  if (err instanceof NeedsSetup || err instanceof NotReadOnly) return true;
  const e = err as { code?: unknown; message?: unknown } | null;
  const message = String(e?.message ?? '');
  // The restore drill's own scratch database missing is not Will's setup: the drill makes and drops it each
  // run (restoreDrill), and one that vanished mid-run is gone again next week.
  if (/database "[a-z]{2,16}_restore_test(_[a-z0-9]{1,24})?" does not exist/i.test(message)) return false;
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
function seal(age: string, recipient: string, src: string, dest: string, timeoutMs?: number): Promise<{ bytes: number; sha256: string }> {
  return new Promise((resolve, reject) => {
    // No -o: age writes the ciphertext to its stdout, which is a pipe here, never a terminal.
    // With a limit it heads a process group of its own (as a limited pg_dump does: run), so it is stopped with whatever it started.
    const limited = timeoutMs !== undefined;
    const child = spawn(age, ['-r', recipient, src], { env: { PATH: '/usr/bin:/bin:/opt/homebrew/bin' }, stdio: ['ignore', 'pipe', 'pipe'], ...(limited ? { detached: true } : {}) });
    const untie = limited ? endsWithThis(child) : undefined;
    // Past its set's limit it is stopped where it stands (end stops it), and what it had written goes with it (encryptTo).
    const clock = timeoutMs === undefined ? undefined : setTimeout(() => end(new TookTooLong('age', timeoutMs)), timeoutMs);
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
      clearTimeout(clock);
      untie?.();
      if (failure) {
        if (limited) stopGroup(child);
        else child.kill();
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
export async function encryptTo(path: string, recipient: string, tools: Tools, outDir: string, timeoutMs?: number): Promise<{ path: string; bytes: number; sha256: string }> {
  if (!/^age1[0-9a-z]{50,}$/.test(recipient)) throw new NeedsSetup('the age recipient is not an age public key');
  if (!tools.age || !existsSync(tools.age)) throw new NeedsSetup('age is not installed (brew install age)');
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, `${basename(path)}.age`);
  const partial = `${out}.partial`;
  try {
    const sealed = await seal(tools.age, recipient, path, partial, timeoutMs);
    renameSync(partial, out);
    return { path: out, ...sealed };
  } catch (err) {
    rmSync(partial, { force: true });
    throw err;
  }
}

/** An encrypted copy's name in a set, as encryptTo writes it: the only kind of file pruneOffsite removes. */
const offsiteCopy = (prefix: string): RegExp => new RegExp(`^${prefix}-[0-9A-Za-z-]+\\.dump\\.age$`);

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
export function pruneOffsite(offsiteDir: string, manifest: string, name: string, keep: number, from: { recorded?: readonly string[]; dumpDir?: string; now?: number; prefix?: string } = {}): string[] {
  // One set's copies only: another set's names in the same folder, manifest or list are passed over, never removed.
  const prefix = checkedSet({ ...FLINT_SET, prefix: from.prefix ?? FLINT_SET.prefix }).prefix;
  const OFFSITE_COPY = offsiteCopy(prefix);
  const localDump = dumpName(prefix);
  if (!OFFSITE_COPY.test(name)) throw new Error('not an encrypted copy’s name');
  if (!Number.isInteger(keep) || keep < 1) throw new Error('at least one encrypted copy is kept');
  const there = (file: string): boolean => existsSync(join(offsiteDir, file));
  let listed: string[] = [];
  try {
    listed = readFileSync(manifest, 'utf8').split('\n').map((l) => l.trim());
  } catch {
    // No manifest (a first run, or it was lost): what the database recorded stands in.
  }
  const local = from.dumpDir && existsSync(from.dumpDir) ? readdirSync(from.dumpDir).filter((f) => localDump.test(f)).map((f) => `${f}.age`).filter((n) => OFFSITE_COPY.test(n)) : [];
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
 * Another restore test is using the same scratch database, and did not finish
 * within the time this one may wait (StepLimits.drillWaitMs): this one ran
 * nothing. Not a setup problem: next time it will be free.
 */
export class DrillBusy extends Error {
  constructor() {
    super('another restore test was using the scratch database, so this one did not run');
  }
}

/**
 * What a restore test of a set with limits locks for as long as it has its
 * scratch database (pg_advisory_lock(hashtext(this)), on the restore login's
 * own connection). Anything else that makes or drops a database of that name
 * takes the same lock, in the same database, first.
 */
export const drillLockKey = (set: BackupSet): string => `restore test ${set.scratch}`;

/**
 * Restore `dump` into its set's scratch database (flint_restore_test, or
 * nexus_restore_test) as a role that may create databases (flint_restore),
 * compare counts with the counts taken at dump time, and drop it. `adminUrl`
 * names that role and any database it may connect to. Nothing but the scratch
 * database is touched: the database the dump was taken from is never opened.
 *
 * A set with limits (Nexus's) runs one test at a time: it holds a lock named
 * for its scratch database, on the restore login's own connection, from before
 * the scratch database is made until it is dropped. A second test (a deploy's
 * own check of this code, say) waits its turn, and says so if the wait is too
 * long, instead of dropping the database under the first. Its pg_restore is
 * stopped if it runs past the set's limit, and the scratch database is then
 * dropped with whatever is still connected to it (WITH (FORCE): a session the
 * restore login itself left there, from a run that was stopped, must not keep
 * the database or fail every later test). The whole of it is one step under
 * one clock; dropping what it made has a minute of its own after that.
 * Flint's own test runs as it always has.
 */
export async function restoreDrill(dump: string, adminUrl: string, tools: Tools, of: BackupSet = FLINT_SET): Promise<DrillResult> {
  const set = checkedSet(of);
  const clock = stepClock(set, 'the restore test');
  return withinStep(clock, () => drillWithin(clock, dump, adminUrl, tools, set));
}

async function drillWithin(clock: StepClock | undefined, dump: string, adminUrl: string, tools: Tools, set: BackupSet): Promise<DrillResult> {
  const expected = JSON.parse(readFileSync(`${dump}.counts.json`, 'utf8')) as Record<string, number>;
  const admin = targetOf(adminUrl);
  // Its shape is checked (checkedSet), and it is quoted all the same.
  const name = `"${set.scratch}"`;
  if (admin.database === set.scratch) throw new Error('the restore login’s own database is the scratch database');
  const scratch: PgTarget = { ...admin, database: set.scratch };
  const limits = clock && set.limits;
  /** The restore and the comparison, once the scratch database is there. */
  const restoreAndCompare = async (): Promise<DrillResult> => {
    await run(tools.pgRestore, ['--no-owner', '--no-privileges', '--exit-on-error', '-h', scratch.host, '-p', String(scratch.port), '-U', scratch.user, '-d', scratch.database, dump], scratch.password, limits ? { timeoutMs: clock.left(limits.drillMs) } : {});
    const r = client(scratch);
    await r.connect();
    let restored: Record<string, number>;
    try {
      // Each statement of the comparison has its own limit, or what is left of the step's.
      restored = await countRows(r, set.schemas, limits ? () => r.query(`SET statement_timeout = ${clock.left(limits.drillMs)}`) : undefined);
    } finally {
      await r.end();
    }
    const mismatches = Object.entries(expected)
      .filter(([table, n]) => restored[table] !== n)
      .map(([table, n]) => ({ table, expected: n, restored: restored[table] ?? null }));
    return { ok: mismatches.length === 0 && Object.keys(expected).length > 0, tables: Object.keys(expected).length, mismatches };
  };

  if (limits) {
    // One connection for the whole test, holding the lock: it is released when the connection ends, however that is.
    const c = client(admin);
    await c.connect();
    try {
      await c.query(`SET lock_timeout = ${clock.left(limits.drillWaitMs)}`);
      try {
        await c.query('SELECT pg_advisory_lock(hashtext($1))', [drillLockKey(set)]);
      } catch (err) {
        if ((err as { code?: unknown } | null)?.code === '55P03') throw new DrillBusy();
        throw err;
      }
      await c.query('SET lock_timeout = 15000');
      await c.query(`SET statement_timeout = ${clock.left(limits.drillMs)}`);
      // FORCE: whatever is still connected to a scratch database an earlier run left (its own stray session) goes with it.
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await c.query(`CREATE DATABASE ${name}`);
      try {
        return await restoreAndCompare();
      } finally {
        // The step's time may be up by now: dropping what it made has a minute of its own.
        // FORCE: a pg_restore that was stopped may still be connected for a moment, and must not keep the database there.
        await c.query('SET statement_timeout = 60000').catch(() => {});
        await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => {});
      }
    } finally {
      await c.end().catch(() => {});
    }
  }

  const c = client(admin);
  await c.connect();
  try {
    await c.query(`DROP DATABASE IF EXISTS ${name}`);
    await c.query(`CREATE DATABASE ${name}`);
  } finally {
    await c.end();
  }
  try {
    return await restoreAndCompare();
  } finally {
    const d = client(admin);
    await d.connect();
    await d.query(`DROP DATABASE IF EXISTS ${name}`).catch(() => {});
    await d.end();
  }
}

/** The newest dump of a set in `dir`, or undefined. */
export function newestDump(dir: string, prefix: string = FLINT_SET.prefix): string | undefined {
  if (!existsSync(dir)) return undefined;
  const mine = dumpName(checkedSet({ ...FLINT_SET, prefix }).prefix);
  const dumps = readdirSync(dir).filter((f) => mine.test(f)).sort();
  return dumps.length ? join(dir, dumps[dumps.length - 1]!) : undefined;
}
