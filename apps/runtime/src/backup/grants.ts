/**
 * Every privilege the application roles hold in a Flint database, as one sorted
 * list. Two readers:
 *  - the migration round-trip test pins it to test/fixtures/grants.json, so a
 *    change to a grant shows up in review;
 *  - a restore compares a restored copy's list with the list of a database built
 *    from this checkout's own migrations (./catalog.ts), and refuses any
 *    difference.
 */
import type pg from 'pg';

const ROLES = "('flint_app', 'flint_approver', 'flint_backup')";
const SCHEMAS = "('public', 'flint_part', 'pgboss')";
/** The table privileges the SQL standard knows (the ones the information schema lists). */
const TABLE_PRIVILEGES = "('SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER')";
const GRANTEE = "CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END";
/** Granted to everyone, or to one of the application roles. */
const WHO = `(a.grantee = 0 OR a.grantee IN (SELECT oid FROM pg_roles WHERE rolname IN ${ROLES}))`;

/**
 * Every privilege the application roles hold in this database, sorted: tables
 * and columns in public AND flint_part (where the audit rows live), sequences,
 * functions, the two schemas, and the database itself (TEMP matters: a temp
 * table could shadow a governance table).
 */
export async function grantLines(c: pg.Client, o: { everyone?: boolean } = {}): Promise<string[]> {
  const q = async (sql: string) => (await c.query<{ g: string }>(sql)).rows.map((r) => r.g);
  // What everyone (PUBLIC) holds on the schemas and on the database itself: nothing, since the floor migration.
  // Listed for the reviewed fixture, where a line here would be a right every role on the server has. (A
  // restore's comparison does not ask for it: it reads each schema's privileges entry by entry, and sets the
  // database's own from a reference.)
  const everyone = o.everyone
    ? [
        ...(await q(`
          SELECT 'PUBLIC ' || pr.p || ' schema ' || s.nspname AS g
          FROM pg_namespace s CROSS JOIN (VALUES ('USAGE'), ('CREATE')) AS pr(p)
          WHERE s.nspname IN ${SCHEMAS} AND has_schema_privilege('public', s.oid, pr.p)`)),
        ...(await q(`
          SELECT 'PUBLIC ' || pr.p || ' database' AS g
          FROM (VALUES ('CREATE'), ('TEMP'), ('CONNECT')) AS pr(p)
          WHERE has_database_privilege('public', current_database(), pr.p)`)),
      ]
    : [];
  return [
    ...everyone,
    // Read from the catalog itself: the information schema gives the same rows and takes fifty times as long.
    ...(await q(`
      SELECT ${GRANTEE} || ' ' || a.privilege_type || ' ' || n.nspname || '.' || c.relname AS g
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace, LATERAL aclexplode(c.relacl) a
      WHERE n.nspname IN ${SCHEMAS} AND c.relkind IN ('r', 'v', 'f', 'p') AND c.relacl IS NOT NULL
        AND a.privilege_type IN ${TABLE_PRIVILEGES} AND ${WHO}`)),
    // A privilege on a column alone (one the whole table does not already give).
    ...(await q(`
      SELECT ${GRANTEE} || ' ' || a.privilege_type || ' ' || n.nspname || '.' || c.relname || '.' || t.attname AS g
      FROM pg_attribute t JOIN pg_class c ON c.oid = t.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace, LATERAL aclexplode(t.attacl) a
      WHERE n.nspname IN ${SCHEMAS} AND c.relkind IN ('r', 'v', 'f', 'p') AND t.attacl IS NOT NULL AND NOT t.attisdropped AND t.attnum > 0 AND ${WHO}
        AND NOT EXISTS (SELECT 1 FROM aclexplode(c.relacl) w WHERE w.grantee = a.grantee AND w.privilege_type = a.privilege_type)`)),
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
}
