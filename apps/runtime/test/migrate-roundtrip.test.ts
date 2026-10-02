/**
 * Every migration goes up, comes back down, and goes up again to exactly the
 * Prisma schema, with exactly the grants in fixtures/grants.json (plan 3.0.6).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NO_DB, URLS, MIGRATIONS, migrationDirs, migrateDown, migrateUp, prisma, withClient } from './db';

const GRANTS_FIXTURE = join(__dirname, 'fixtures', 'grants.json');

const ROLES = "('flint_app', 'flint_approver', 'flint_backup')";

/**
 * Every privilege the application roles hold in this database, sorted: tables
 * and columns in public AND flint_part (where the audit rows live), sequences,
 * functions, the two schemas, and the database itself (TEMP matters: a temp
 * table could shadow a governance table).
 */
async function grants(owner: string): Promise<string[]> {
  return withClient(owner, async (c) => {
    const q = async (sql: string) => (await c.query<{ g: string }>(sql)).rows.map((r) => r.g);
    return [
      ...(await q(`
        SELECT grantee || ' ' || privilege_type || ' ' || table_schema || '.' || table_name AS g
        FROM information_schema.role_table_grants
        WHERE table_schema IN ('public', 'flint_part', 'pgboss') AND grantee IN ('flint_app', 'flint_approver', 'flint_backup', 'PUBLIC')`)),
      ...(await q(`
        SELECT grantee || ' ' || privilege_type || ' ' || table_schema || '.' || table_name || '.' || column_name AS g
        FROM information_schema.column_privileges p
        WHERE table_schema IN ('public', 'flint_part', 'pgboss') AND grantee IN ('flint_app', 'flint_approver', 'flint_backup', 'PUBLIC')
          AND NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants t
                          WHERE t.grantee = p.grantee AND t.table_schema = p.table_schema AND t.table_name = p.table_name AND t.privilege_type = p.privilege_type)`)),
      ...(await q(`
        SELECT r.rolname || ' ' || pr.p || ' sequence ' || c.relname AS g
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        CROSS JOIN pg_roles r CROSS JOIN (VALUES ('USAGE'), ('SELECT'), ('UPDATE')) AS pr(p)
        WHERE c.relkind = 'S' AND n.nspname IN ('public', 'flint_part', 'pgboss') AND r.rolname IN ${ROLES}
          AND has_sequence_privilege(r.oid, c.oid, pr.p)`)),
      ...(await q(`
        SELECT r.rolname || ' EXECUTE ' || p.proname AS g
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace CROSS JOIN pg_roles r
        WHERE n.nspname = 'public' AND r.rolname IN ${ROLES} AND has_function_privilege(r.oid, p.oid, 'EXECUTE')`)),
      ...(await q(`
        SELECT 'PUBLIC EXECUTE ' || p.proname AS g
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND (p.proacl IS NULL OR EXISTS (
          SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'))`)),
      ...(await q(`
        SELECT r.rolname || ' ' || pr.p || ' schema ' || s.nspname AS g
        FROM pg_namespace s CROSS JOIN pg_roles r CROSS JOIN (VALUES ('USAGE'), ('CREATE')) AS pr(p)
        WHERE s.nspname IN ('public', 'flint_part', 'pgboss') AND r.rolname IN ${ROLES} AND has_schema_privilege(r.oid, s.oid, pr.p)`)),
      ...(await q(`
        SELECT r.rolname || ' ' || pr.p || ' database' AS g
        FROM pg_roles r CROSS JOIN (VALUES ('CREATE'), ('TEMP'), ('CONNECT')) AS pr(p)
        WHERE r.rolname IN ${ROLES} AND has_database_privilege(r.oid, current_database(), pr.p)`)),
    ]
      // pg-boss's queue-stats partitions are named by the day they were made.
      .map((g) => g.replace(/queue_stats_\d{8}/g, 'queue_stats_<day>'))
      .sort();
  });
}

async function objects(owner: string): Promise<{ tables: string[]; functions: string[]; schemas: string[] }> {
  return withClient(owner, async (c) => ({
    tables: (await c.query(`SELECT schemaname || '.' || tablename AS t FROM pg_tables WHERE schemaname IN ('public', 'flint_part', 'pgboss') ORDER BY 1`)).rows.map((r) => r.t.replace(/queue_stats_\d{8}/, 'queue_stats_<day>')),
    functions: (await c.query(`SELECT n.nspname || '.' || proname AS f FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname IN ('public', 'pgboss') ORDER BY 1`)).rows.map((r) => r.f),
    schemas: (await c.query(`SELECT nspname FROM pg_namespace WHERE nspname IN ('flint_part', 'pgboss') ORDER BY 1`)).rows.map((r) => r.nspname),
  }));
}

describe('migrations', () => {
  it('every migration has a down.sql (install-runtime refuses one without)', () => {
    const dirs = migrationDirs();
    expect(dirs.length).toBeGreaterThanOrEqual(3);
    for (const d of dirs) expect(existsSync(join(MIGRATIONS, d, 'down.sql')), d).toBe(true);
  });
});

describe.skipIf(NO_DB)('migration round trip (flint_test)', () => {
  const owner = URLS?.owner ?? '';

  beforeAll(async () => {
    await migrateDown(owner);
  });

  it('up, down, up again, to an empty diff and the same grants', async () => {
    await migrateUp(owner);
    const first = await grants(owner);
    const shape = await objects(owner);
    expect(shape.schemas).toEqual(['flint_part', 'pgboss']);
    expect(shape.tables).toContain('flint_part.AuditEntry_default');
    expect(shape.tables).toContain('pgboss.job_common');

    await migrateDown(owner);
    const empty = await objects(owner);
    expect(empty).toEqual({ tables: [], functions: [], schemas: [] });

    await migrateUp(owner);
    const diff = await prisma(['migrate', 'diff', '--from-url', owner, '--to-schema-datamodel', 'prisma/schema.prisma', '--exit-code'], owner);
    expect(diff.code, diff.stdout + diff.stderr).toBe(0);
    expect(await grants(owner)).toEqual(first);
    expect(await objects(owner)).toEqual(shape);
  });

  // A change to a grant is a security change: it shows up as a diff to
  // fixtures/grants.json in review. FLINT_UPDATE_GRANTS=1 rewrites the fixture.
  it('one migration\'s down.sql, then deploy, re-applies it (the documented rollback)', async () => {
    await withClient(owner, (c) => c.query(readFileSync(join(MIGRATIONS, '20261001000200_p1_ledger', 'down.sql'), 'utf8')));
    expect(await withClient(owner, async (c) => (await c.query(`SELECT to_regclass('public."Prediction"') AS t`)).rows[0].t)).toBeNull();
    const status = await prisma(['migrate', 'status'], owner);
    expect(status.stdout + status.stderr).toMatch(/20261001000200_p1_ledger/);
    await migrateUp(owner);
    expect(await withClient(owner, async (c) => (await c.query(`SELECT to_regclass('public."Prediction"') AS t`)).rows[0].t)).toBe('"Prediction"');
    const diff = await prisma(['migrate', 'diff', '--from-url', owner, '--to-schema-datamodel', 'prisma/schema.prisma', '--exit-code'], owner);
    expect(diff.code, diff.stdout + diff.stderr).toBe(0);
  });

  it('the grants are exactly the reviewed ones', async () => {
    const got = await grants(owner);
    if (process.env.FLINT_UPDATE_GRANTS === '1') writeFileSync(GRANTS_FIXTURE, `${JSON.stringify(got, null, 2)}\n`);
    const want = JSON.parse(readFileSync(GRANTS_FIXTURE, 'utf8')) as string[];
    expect(got).toEqual(want);
  });

  it('no application role owns anything or is a superuser', async () => {
    await withClient(owner, async (c) => {
      const r = await c.query(`
        SELECT rolname, rolsuper, rolcreaterole, rolbypassrls FROM pg_roles
        WHERE rolname IN ('flint_owner', 'flint_app', 'flint_approver', 'flint_backup') ORDER BY 1`);
      for (const row of r.rows) expect(row, row.rolname).toMatchObject({ rolsuper: false, rolcreaterole: false, rolbypassrls: false });
      const owned = await c.query(`
        SELECT c.relname, pg_get_userbyid(c.relowner) AS owner FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname IN ('public', 'flint_part', 'pgboss') AND pg_get_userbyid(c.relowner) <> 'flint_owner'`);
      expect(owned.rows).toEqual([]);
      // The runtime runs no DDL: it may create nothing, anywhere (pg-boss's schema included).
      const create = await c.query(`
        SELECT n.nspname FROM pg_namespace n
        WHERE n.nspname IN ('public', 'flint_part', 'pgboss') AND has_schema_privilege('flint_app', n.oid, 'CREATE')`);
      expect(create.rows).toEqual([]);
    });
  });
});
