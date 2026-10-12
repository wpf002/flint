/**
 * Every migration goes up, comes back down, and goes up again to exactly the
 * Prisma schema, with exactly the grants in fixtures/grants.json (plan 3.0.6).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NO_DB, URLS, MIGRATIONS, migrationDirs, migrateDown, migrateUp, prisma, withClient } from './db';
import { GRANTS_FIXTURE, grants } from './grants';

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

  // The test helpers' first run on a new machine (and CI's) starts from a database with nothing in it, and
  // freshDb begins by running every down.sql. Each one tolerates that: a statement on a table, a schema or a
  // queue that is not there is skipped, not failed. (P2, P2.5 and P2.6's did not, until P4 part 1.)
  it('every down.sql runs on an empty database, and a deploy from empty gives the schema (the freshDb bootstrap case)', async () => {
    await migrateDown(owner);
    const empty = { tables: [], functions: [], schemas: [] };
    expect(await objects(owner)).toEqual(empty);
    // Again, on nothing at all: this is what a first freshDb does.
    await migrateDown(owner);
    expect(await objects(owner)).toEqual(empty);
    await withClient(owner, async (c) => {
      expect((await c.query(`SELECT to_regnamespace('pgboss') AS boss, to_regclass('public._prisma_migrations') AS migrations`)).rows[0]).toEqual({ boss: null, migrations: null });
    });
    await migrateUp(owner);
    const diff = await prisma(['migrate', 'diff', '--from-url', owner, '--to-schema-datamodel', 'prisma/schema.prisma', '--exit-code'], owner);
    expect(diff.code, diff.stdout + diff.stderr).toBe(0);
  });

  // The newest migration is the one a rollback undoes (P4: p4_forecasts). Its
  // down.sql alone, then a deploy, gives back exactly the schema: migrate status
  // lists it as not applied, what it made is gone, and the redeploy diffs empty.
  // (An older migration's down.sql alone no longer can: p1_ledger's would recreate
  // Prediction without the columns P3 and P4 add.)
  it('the newest migration\'s down.sql, then deploy, re-applies it (the documented rollback)', async () => {
    const newest = migrationDirs().at(-1)!;
    // What the newest migration makes, to see it go and come back. A new migration names its own here.
    const made: Record<string, string> = { '20261013000000_p4_forecasts': 'ForecastRun' };
    expect(made[newest], `name a table ${newest} makes`).toBeTruthy();
    const table = async () => withClient(owner, async (c) => (await c.query(`SELECT to_regclass($1) AS t`, [`public."${made[newest]}"`])).rows[0].t);
    expect(await table()).not.toBeNull();
    await withClient(owner, (c) => c.query(readFileSync(join(MIGRATIONS, newest, 'down.sql'), 'utf8')));
    expect(await table()).toBeNull();
    // Run again on what it left (the state a rollback half done would be in): it tolerates that, as its header says.
    await withClient(owner, (c) => c.query(readFileSync(join(MIGRATIONS, newest, 'down.sql'), 'utf8')));
    // P4 also hardened three of P3's functions: its down.sql puts P3's own bodies back to the letter (as P3's
    // migration wrote them), and takes away the trigger and the checks it added to older tables.
    const p3 = readFileSync(join(MIGRATIONS, '20261009000000_p3_goals', 'migration.sql'), 'utf8');
    const bodyOf = (signature: string) => {
      const from = p3.indexOf('AS $$', p3.indexOf(`CREATE FUNCTION ${signature}`)) + 'AS $$'.length;
      return p3.slice(from, p3.indexOf('\n$$;', from) + 1);
    };
    const restored = await withClient(owner, async (c) => (await c.query(
      `SELECT p.proname, p.prosrc, p.provolatile, p.prosecdef, array_to_string(p.proconfig, ';') AS config,
              EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0) AS public
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname IN ('p3_signed_proposal', 'p3_bind_approval', 'goal_entity_guard') ORDER BY 1`)).rows);
    expect(restored.map((r) => [r.proname, r.provolatile, r.prosecdef, r.config, r.public])).toEqual([
      ['goal_entity_guard', 'v', false, 'search_path=public, pg_temp', false],
      ['p3_bind_approval', 'v', true, 'search_path=public, pg_temp', false],
      ['p3_signed_proposal', 's', false, 'search_path=public, pg_temp', false],
    ]);
    expect(restored.find((r) => r.proname === 'p3_signed_proposal')!.prosrc).toBe(bodyOf('p3_signed_proposal(p_approval text, p_goal text, p_actions text[])'));
    expect(restored.find((r) => r.proname === 'p3_bind_approval')!.prosrc).toBe(bodyOf('p3_bind_approval(p_approval text, p_goal text, p_action text)'));
    expect(restored.find((r) => r.proname === 'goal_entity_guard')!.prosrc).toBe(bodyOf('goal_entity_guard()'));
    const leftovers = await withClient(owner, async (c) => (await c.query(
      `SELECT (SELECT count(*)::int FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('GoalEntity_bind', 'MetricPoint_valid', 'MetricSeries_guard', 'Prediction_valid', 'Prediction_valid_forecast',
                 'Prediction_valid_update', 'Resolution_valid', 'Resolution_will_check', 'Proposal_digest_check_forecast')) AS triggers,
              (SELECT count(*)::int FROM pg_constraint WHERE conname IN ('MetricSeries_money_check', 'MetricSeries_calendar_check', 'MetricSeries_onbox_check')) AS checks,
              (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'
                 AND (p.proname ~ '^(p4|forecast)_' OR p.proname IN ('metric_series_guard', 'metric_point_valid', 'prediction_valid', 'prediction_update_valid',
                      'prediction_forecast_check', 'prediction_question_guard', 'resolution_valid', 'resolution_will_check'))) AS functions`)).rows[0]);
    expect(leftovers).toEqual({ triggers: 0, checks: 0, functions: 0 });
    const status = await prisma(['migrate', 'status'], owner);
    expect(status.stdout + status.stderr).toMatch(new RegExp(`not yet been applied:[\\s\\S]*${newest}`));
    await migrateUp(owner);
    expect(await table()).not.toBeNull();
    const diff = await prisma(['migrate', 'diff', '--from-url', owner, '--to-schema-datamodel', 'prisma/schema.prisma', '--exit-code'], owner);
    expect(diff.code, diff.stdout + diff.stderr).toBe(0);
  });

  // A change to a grant is a security change: it shows up as a diff to
  // fixtures/grants.json in review. FLINT_UPDATE_GRANTS=1 rewrites the fixture.
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
