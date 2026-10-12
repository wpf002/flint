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
 *    deploy gate's tests.
 *  - Every password is made here, fresh, and goes to exactly two places: the
 *    server as a SCRAM verifier (so the password itself is in no statement and
 *    no server log), and ~/.flint/secrets.env and backup.env (0600). Nothing
 *    prints one.
 *
 * Refused when any of the roles or the `flint` database is already there: that
 * is a machine with a Flint on it, not a fresh one. `rotate` is the explicit way
 * past that: it gives the existing roles new passwords and rewrites the files.
 * It never drops a role or a database.
 */
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
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

/** KEY=value lines set or replaced in an env file; every other line is kept. The file ends 0600, written whole. */
export function upsertEnv(file: string, values: Record<string, string>): void {
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
  writeFileSync(partial, `${body}\n`, { mode: 0o600 });
  chmodSync(partial, 0o600);
  renameSync(partial, file);
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
  await admin.connect();
  const passwords = Object.fromEntries(ROLES.map((r) => [r, randomBytes(24).toString('hex')])) as Record<Role, string>;
  const created: Role[] = [];
  const rotated: Role[] = [];
  const databases: string[] = [];
  try {
    const me = await admin.query<{ able: boolean }>('SELECT rolsuper OR (rolcreaterole AND rolcreatedb) AS able FROM pg_roles WHERE rolname = current_user');
    if (!me.rows[0]?.able) throw new BootstrapRefused('This database login may not create roles and databases.');

    const haveRoles = new Set((await admin.query<{ rolname: string }>('SELECT rolname FROM pg_roles WHERE rolname = ANY($1)', [[...ROLES]])).rows.map((r) => r.rolname));
    const haveDbs = new Set((await admin.query<{ datname: string }>('SELECT datname FROM pg_database WHERE datname = ANY($1)', [[...DATABASES]])).rows.map((r) => r.datname));
    if (!o.rotate && (haveRoles.size > 0 || haveDbs.has('flint'))) {
      throw new BootstrapRefused("Flint's database is already set up on this Mac. Nothing was changed.");
    }

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

    for (const db of DATABASES) {
      if (haveDbs.has(db)) continue;
      await admin.query(`CREATE DATABASE ${db} OWNER flint_owner`);
      databases.push(db);
    }
  } finally {
    await admin.end().catch(() => {});
  }

  // The public schema of each new database belongs to the migration owner, as on the Studio and in CI.
  for (const db of databases) {
    const c = new pg.Client({ ...o.admin, database: db });
    await c.connect();
    try {
      await c.query('ALTER SCHEMA public OWNER TO flint_owner');
    } finally {
      await c.end().catch(() => {});
    }
  }

  const url = (role: Role, db: string) => `postgresql://${role}:${passwords[role]}@[::1]:${o.port}/${db}`;
  const secrets = join(dataDir, 'secrets.env');
  const backup = join(dataDir, 'backup.env');
  upsertEnv(secrets, {
    FLINT_DB_URL: url('flint_app', 'flint'),
    FLINT_DB_OWNER_URL: url('flint_owner', 'flint'),
    FLINT_DB_APPROVER_URL: url('flint_approver', 'flint'),
    FLINT_DB_BACKUP_URL: url('flint_backup', 'flint'),
    FLINT_DB_TEST_URL: url('flint_app', 'flint_test'),
    FLINT_DB_TEST_OWNER_URL: url('flint_owner', 'flint_test'),
  });
  upsertEnv(backup, {
    FLINT_DB_BACKUP_URL: url('flint_backup', 'flint'),
    FLINT_DB_RESTORE_URL: url('flint_restore', 'postgres'),
  });
  return { created, rotated, databases, files: [secrets, backup] };
}
