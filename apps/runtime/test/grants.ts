/**
 * Every privilege the application roles hold in a Flint database, as one sorted
 * list: what the migration round-trip test pins to fixtures/grants.json, and
 * what a restored database must come back with (restore-production-db.test.ts).
 */
import { join } from 'node:path';
import { withClient } from './db';

export const GRANTS_FIXTURE = join(__dirname, 'fixtures', 'grants.json');

const ROLES = "('flint_app', 'flint_approver', 'flint_backup')";

/**
 * Every privilege the application roles hold in this database, sorted: tables
 * and columns in public AND flint_part (where the audit rows live), sequences,
 * functions, the two schemas, and the database itself (TEMP matters: a temp
 * table could shadow a governance table).
 */
export async function grants(owner: string): Promise<string[]> {
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
