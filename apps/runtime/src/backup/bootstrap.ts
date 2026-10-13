/**
 * Flint's database roles and databases on a rebuilt Mac (P7). Until now this
 * shape existed only on the Studio (made by hand in P0) and in CI
 * (test/global-setup.ts); a rebuild makes it from here.
 *
 *  - Five roles, none a superuser and none able to make roles: flint_owner
 *    (runs migrations, owns everything; may create databases), flint_app (the
 *    runtime), flint_approver (the server's approval path), flint_backup
 *    (read-only: pg_read_all_data) and flint_restore (may only create the
 *    scratch database a restore drill uses).
 *  - Two databases, both owned by flint_owner: `flint`, and `flint_test` for the
 *    deploy gate's tests. Nobody reaches either by default: "everyone" is taken
 *    off the database and off its public schema the moment it is made, and the
 *    runtime's, the approval and the backup roles are let in by name. (The
 *    migrations say the same, 20261013000150_public_schema_floor; here it holds
 *    from the first moment, before any migration has run.)
 *  - Every password is made here, fresh, and goes to exactly two places: the
 *    server as a SCRAM verifier (so the password itself is in no statement and
 *    no server log), and ~/.flint/secrets.env and backup.env (0600). Nothing
 *    prints one.
 *  - The order keeps a password from being set and then lost: both files are
 *    written first, whole and flushed, under a `.partial` name; then every role
 *    is made or changed in ONE transaction; then the files take their names. A
 *    run that dies in between leaves either the old passwords everywhere, or the
 *    new ones in Postgres and in the `.partial` files.
 *  - The migration owner is made a member of flint_restore, so it can take over
 *    a database that role restored (restore.ts): the restoring role owns
 *    nothing else, and the SQL in a backup runs as it.
 *
 * Refused when any of the roles or the `flint` database is already there: that
 * is a machine with a Flint on it, not a fresh one. `rotate` is the explicit way
 * past that: it gives the existing roles new passwords and rewrites the files.
 * It never drops a role or a database.
 */
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

/** Why the bootstrap did not run: a sentence for Will. */
export class BootstrapRefused extends Error {}

export const ROLES = ['flint_owner', 'flint_app', 'flint_approver', 'flint_backup', 'flint_restore'] as const;
export type Role = (typeof ROLES)[number];
const CREATEDB: ReadonlySet<Role> = new Set(['flint_owner', 'flint_restore']);
export const DATABASES = ['flint', 'flint_test'] as const;

/**
 * The SCRAM-SHA-256 verifier Postgres stores for `password` (RFC 5802, as
 * `psql \password` computes it). Handing the server this instead of the
 * password keeps the password out of the statement and out of any log.
 */
export function scramVerifier(password: string, salt: Buffer = randomBytes(16), iterations = 4096): string {
  const salted = pbkdf2Sync(password.normalize('NFKC'), salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

interface Staged {
  /** Give the staged file its name. */
  commit(): void;
  /** Remove it: nothing changed. */
  discard(): void;
}

/**
 * The new contents of an env file, written whole and flushed under
 * `<file>.partial` (0600), ready to take its name: KEY=value lines set or
 * replaced, every other line kept. A `.partial` already there is replaced only
 * when it is plainly a leftover of this script's own (a plain file of this
 * user's that no one else can read); a link, or one others can read, is
 * refused.
 */
export function stageEnv(file: string, values: Record<string, string>): Staged {
  for (const [k, v] of Object.entries(values)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(k)) throw new Error(`not a setting name: ${k}`);
    if (/[\r\n]/.test(v)) throw new Error(`the value of ${k} has a line break`);
  }
  const dir = join(file, '..');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const kept = existsSync(file)
    ? readFileSync(file, 'utf8').split('\n').filter((line) => {
        const m = /^(?:export\s+)?([A-Z][A-Z0-9_]*)=/.exec(line);
        return !(m && m[1]! in values);
      })
    : [];
  while (kept.length && kept[kept.length - 1] === '') kept.pop();
  const body = [...kept, ...Object.entries(values).map(([k, v]) => `${k}=${v}`)].join('\n');
  const partial = `${file}.partial`;
  let st;
  try {
    st = lstatSync(partial);
  } catch {
    st = undefined;
  }
  if (st) {
    if (!st.isFile() || st.uid !== process.getuid?.() || st.mode & 0o077) {
      throw new BootstrapRefused(`A half-written settings file that is not Flint's own is in the way (${partial.split('/').pop()}). Remove it, then run this again.`);
    }
    rmSync(partial);
  }
  // Made new and never followed: a link put there in the meantime is an error, not a place to write passwords.
  const fd = openSync(partial, 'wx', 0o600);
  try {
    writeSync(fd, `${body}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return {
    commit: () => {
      renameSync(partial, file);
      chmodSync(file, 0o600);
      // The new name itself is flushed, so a power cut does not bring the old file back.
      const d = openSync(dir, 'r');
      try {
        fsyncSync(d);
      } catch {
        // Not every filesystem flushes a folder; the file's own contents are flushed already.
      } finally {
        closeSync(d);
      }
    },
    discard: () => rmSync(partial, { force: true }),
  };
}

/** KEY=value lines set or replaced in an env file; every other line is kept. The file ends 0600, written whole. */
export function upsertEnv(file: string, values: Record<string, string>): void {
  stageEnv(file, values).commit();
}

export interface BootstrapOptions {
  /** A superuser (or a role that may create roles and databases) on the maintenance database. */
  admin: pg.ClientConfig;
  /** Where the roles will connect: this Mac, over TCP. */
  port: number;
  /** ~ : the files go to <home>/.flint. */
  home: string;
  /** Give roles that already exist new passwords instead of refusing. */
  rotate?: boolean;
}

export interface BootstrapResult {
  created: Role[];
  rotated: Role[];
  databases: string[];
  files: string[];
}

export async function bootstrapDb(o: BootstrapOptions): Promise<BootstrapResult> {
  if (!Number.isInteger(o.port) || o.port < 1024 || o.port > 65535) throw new BootstrapRefused('The database port is not a usable one.');
  const dataDir = join(o.home, '.flint');
  if (existsSync(dataDir) && statSync(dataDir).mode & 0o077) chmodSync(dataDir, 0o700);

  const admin = new pg.Client({ ...o.admin, database: o.admin.database ?? 'postgres' });
  // A connection the server drops while it sits idle must not take the process down.
  admin.on('error', () => {});
  await admin.connect();
  const passwords = Object.fromEntries(ROLES.map((r) => [r, randomBytes(24).toString('hex')])) as Record<Role, string>;
  const url = (role: Role, db: string) => `postgresql://${role}:${passwords[role]}@[::1]:${o.port}/${db}`;
  const secrets = join(dataDir, 'secrets.env');
  const backup = join(dataDir, 'backup.env');
  const created: Role[] = [];
  const rotated: Role[] = [];
  const databases: string[] = [];
  const staged: Staged[] = [];
  /** Postgres holds the new passwords: from here the staged files are the only other place they are, and are never removed. */
  let rolesChanged = false;
  try {
    const me = await admin.query<{ able: boolean }>('SELECT rolsuper OR (rolcreaterole AND rolcreatedb) AS able FROM pg_roles WHERE rolname = current_user');
    if (!me.rows[0]?.able) throw new BootstrapRefused('This database login may not create roles and databases.');

    const haveRoles = new Set((await admin.query<{ rolname: string }>('SELECT rolname FROM pg_roles WHERE rolname = ANY($1)', [[...ROLES]])).rows.map((r) => r.rolname));
    const haveDbs = new Set((await admin.query<{ datname: string }>('SELECT datname FROM pg_database WHERE datname = ANY($1)', [[...DATABASES]])).rows.map((r) => r.datname));
    if (!o.rotate && (haveRoles.size > 0 || haveDbs.has('flint'))) {
      throw new BootstrapRefused("Flint's database is already set up on this Mac. Nothing was changed.");
    }

    // 1. The passwords are saved (whole, flushed, under a .partial name) before Postgres is told any of them.
    staged.push(
      stageEnv(secrets, {
        FLINT_DB_URL: url('flint_app', 'flint'),
        FLINT_DB_OWNER_URL: url('flint_owner', 'flint'),
        FLINT_DB_APPROVER_URL: url('flint_approver', 'flint'),
        FLINT_DB_BACKUP_URL: url('flint_backup', 'flint'),
        FLINT_DB_TEST_URL: url('flint_app', 'flint_test'),
        FLINT_DB_TEST_OWNER_URL: url('flint_owner', 'flint_test'),
      }),
    );
    staged.push(
      stageEnv(backup, {
        FLINT_DB_BACKUP_URL: url('flint_backup', 'flint'),
        FLINT_DB_RESTORE_URL: url('flint_restore', 'postgres'),
      }),
    );

    // 2. Every role, in one transaction: all of them get their new password, or none does.
    await admin.query('BEGIN');
    try {
      for (const role of ROLES) {
        const verifier = scramVerifier(passwords[role]);
        // The role names are the fixed identifiers above. The verifier is base64 and punctuation that needs no quoting; checked all the same.
        if (!/^SCRAM-SHA-256\$\d+:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/.test(verifier)) throw new Error('unexpected verifier');
        const attrs = `LOGIN NOSUPERUSER NOCREATEROLE NOREPLICATION NOBYPASSRLS ${CREATEDB.has(role) ? 'CREATEDB' : 'NOCREATEDB'} PASSWORD '${verifier}'`;
        if (haveRoles.has(role)) {
          await admin.query(`ALTER ROLE ${role} ${attrs}`);
          rotated.push(role);
        } else {
          await admin.query(`CREATE ROLE ${role} ${attrs}`);
          created.push(role);
        }
      }
      await admin.query('GRANT pg_read_all_data TO flint_backup');
      // The migration owner may take over what the restoring role made (and gains nothing by it: it may create databases already).
      await admin.query('GRANT flint_restore TO flint_owner');
      await admin.query('COMMIT');
      rolesChanged = true;
    } catch (err) {
      await admin.query('ROLLBACK').catch(() => {});
      throw err;
    }

    // 3. Postgres has them: the files take their names.
    while (staged.length) {
      staged[0]!.commit();
      staged.shift();
    }

    for (const db of DATABASES) {
      if (haveDbs.has(db)) continue;
      await admin.query(`CREATE DATABASE ${db} OWNER flint_owner`);
      // Postgres lets everyone connect to a new database: nobody does to this one, but Flint's own roles, by name.
      await admin.query(`REVOKE ALL ON DATABASE ${db} FROM PUBLIC`);
      await admin.query(`GRANT CONNECT ON DATABASE ${db} TO flint_app, flint_approver, flint_backup`);
      databases.push(db);
    }
  } catch (err) {
    if (!rolesChanged) {
      // Postgres was told none of these passwords: the staged files go, and everything is as it was.
      for (const f of staged) f.discard();
    } else if (staged.length) {
      // Postgres has them and a file could not take its name: the passwords stay in the .partial files, and a rotation replaces both.
      throw new BootstrapRefused('The new passwords are set, but Flint could not put its settings files in place. Run this again with --rotate.');
    }
    throw err;
  } finally {
    await admin.end().catch(() => {});
  }

  // The public schema of each new database belongs to the migration owner, as on the Studio and in CI.
  for (const db of databases) {
    const c = new pg.Client({ ...o.admin, database: db });
    c.on('error', () => {});
    await c.connect();
    try {
      await c.query('ALTER SCHEMA public OWNER TO flint_owner');
      // And nobody uses its public schema by default either (the migrations name who may).
      await c.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
    } finally {
      await c.end().catch(() => {});
    }
  }
  return { created, rotated, databases, files: [secrets, backup] };
}
