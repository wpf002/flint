/**
 * CI only: turn the throwaway Postgres container into the same shape as the
 * Mac's: the four roles (none a superuser), and flint_test owned by flint_owner.
 * Passwords are random per run and never leave this process tree.
 */
import { randomBytes } from 'node:crypto';
import pg from 'pg';

export default async function setup(): Promise<void> {
  const admin = process.env.FLINT_DB_CI_ADMIN_URL;
  if (!admin || process.env.FLINT_DB_TEST_OWNER_URL) return;
  const pw = () => randomBytes(18).toString('hex');
  const roles = { flint_owner: pw(), flint_app: pw(), flint_approver: pw(), flint_backup: pw(), flint_restore: pw() };
  const c = new pg.Client({ connectionString: admin });
  await c.connect();
  try {
    for (const [role, secret] of Object.entries(roles)) {
      const exists = (await c.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])).rowCount;
      // Role names are fixed identifiers above; the password is a literal from randomBytes (hex only).
      await c.query(`${exists ? 'ALTER' : 'CREATE'} ROLE ${role} LOGIN PASSWORD '${secret}'${role === 'flint_owner' || role === 'flint_restore' ? ' CREATEDB' : ''}`);
    }
    await c.query('GRANT pg_read_all_data TO flint_backup');
    await c.query('DROP DATABASE IF EXISTS flint_test');
    await c.query('CREATE DATABASE flint_test OWNER flint_owner');
  } finally {
    await c.end();
  }
  const t = new pg.Client({ connectionString: withDb(admin, 'flint_test') });
  await t.connect();
  try {
    await t.query('ALTER SCHEMA public OWNER TO flint_owner');
  } finally {
    await t.end();
  }
  const url = (role: keyof typeof roles) => {
    const u = new URL(withDb(admin, 'flint_test'));
    u.username = role;
    u.password = roles[role];
    return u.toString();
  };
  process.env.FLINT_DB_TEST_OWNER_URL = url('flint_owner');
  process.env.FLINT_DB_TEST_URL = url('flint_app');
  process.env.FLINT_DB_TEST_APPROVER_URL = url('flint_approver');
  process.env.FLINT_DB_TEST_BACKUP_URL = url('flint_backup');
  const restore = new URL(withDb(admin, 'postgres'));
  restore.username = 'flint_restore';
  restore.password = roles.flint_restore;
  process.env.FLINT_DB_TEST_RESTORE_URL = restore.toString();
}

function withDb(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}
