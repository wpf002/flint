/**
 * Every migration goes up, comes back down, and goes up again to exactly the
 * Prisma schema, with exactly the grants in fixtures/grants.json (plan 3.0.6).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NO_DB, URLS, MIGRATIONS, migrationDirs, migrateDown, migrateUp, pgError, prisma, withClient } from './db';
import { grantLines } from '../src/backup/grants';
import { p5Kit } from './p5';

const GRANTS_FIXTURE = join(__dirname, 'fixtures', 'grants.json');
const grants = (owner: string): Promise<string[]> => withClient(owner, (c) => grantLines(c));

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

  /** A function's body as P3's migration wrote it (what a later migration's down.sql must put back). */
  const p3 = readFileSync(join(MIGRATIONS, '20261009000000_p3_goals', 'migration.sql'), 'utf8');
  const bodyOf = (signature: string) => {
    const from = p3.indexOf('AS $$', p3.indexOf(`CREATE FUNCTION ${signature}`)) + 'AS $$'.length;
    return p3.slice(from, p3.indexOf('\n$$;', from) + 1);
  };
  const functionsNamed = (names: string[]) => withClient(owner, async (c) => (await c.query(
    `SELECT p.proname, p.prosrc, p.provolatile, p.prosecdef, array_to_string(p.proconfig, ';') AS config,
            EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0) AS public
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = ANY ($1) ORDER BY 1`, [names])).rows);
  const runDown = (dir: string) => withClient(owner, (c) => c.query(readFileSync(join(MIGRATIONS, dir, 'down.sql'), 'utf8')));
  const emptyDiff = async () => {
    const diff = await prisma(['migrate', 'diff', '--from-url', owner, '--to-schema-datamodel', 'prisma/schema.prisma', '--exit-code'], owner);
    expect(diff.code, diff.stdout + diff.stderr).toBe(0);
  };

  // P5's down.sql drops the record of which approvals its cards used. A card that is approved or running
  // could then act once more after a re-deploy, so the rollback refuses to start while one is: nothing is
  // dropped, and it runs once each such card has finished, failed or expired.
  it('P5\'s down.sql refuses to run while a task, asset or review card is approved or running, and drops nothing', async () => {
    const k = await p5Kit(URLS!);
    const refusedFor = (n: number) => ({ code: '55000', message: `p5_assets is not rolled back while ${n} task, asset or review card(s) are approved or running: let each finish, fail or expire first` });
    const there = async () => withClient(owner, async (c) => (await c.query(`SELECT to_regclass('public."TaskApprovalUse"') IS NOT NULL AND to_regprocedure('resolution_task_check()') IS NOT NULL AS ok`)).rows[0].ok);
    // A card that only waits holds nothing back: nobody signed it, so nothing of it could be used twice.
    await k.card('task.cancel', { taskId: 'tanone1' }, { stage: 'pending' });
    const approved = await k.card('asset.enable', { assetId: 'asnone' }, { stage: 'approved' });
    expect(await pgError(runDown('20261014000000_p5_assets'))).toMatchObject(refusedFor(1));
    // Running, and under any of the names a P5 guard acts on (a reviewer's or the Hive's dispatch among them).
    const running = await k.card('hive.dispatch_job', { taskId: 'tanone2' });
    const review = await k.card('review.local', { taskId: 'tanone3' }, { stage: 'approved' });
    expect(await pgError(runDown('20261014000000_p5_assets'))).toMatchObject(refusedFor(3));
    expect(await there()).toBe(true);
    // Each ends: the first fails, the second finishes, the third fails too. A card of another kind that is approved was never P5's to hold.
    await k.app(`UPDATE "Proposal" SET status = 'failed', error = 'Synthetic end', "executedAt" = now() WHERE id = ANY ($1)`, [[approved.pid, review.pid]]);
    await k.finish(running.pid);
    await k.card('world.sync.git', { source: 'git' }, { kind: 'tool_call', stage: 'approved' });
    // (The next test runs it, on this state.)
    expect((await withClient(owner, async (c) => (await c.query(
      `SELECT count(*)::int AS n FROM "Proposal" WHERE status IN ('approved', 'executing') AND (kind IN ('task', 'spend') OR action ~ '^(task[.]|asset[.]enable$|review[.])' OR action = 'hive.dispatch_job')`)).rows[0].n))).toBe(0);
  });

  // The newest migration is the one a rollback undoes (P5: p5_assets). Its
  // down.sql alone, then a deploy, gives back exactly the schema: migrate status
  // lists it as not applied, what it made is gone, and the redeploy diffs empty.
  // (An older migration's down.sql alone no longer can: p1_ledger's would recreate
  // Prediction without the columns P3 and P4 add.)
  it('the newest migration\'s down.sql, then deploy, re-applies it (the documented rollback)', async () => {
    const newest = migrationDirs().at(-1)!;
    // What the newest migration makes, to see it go and come back. A new migration names its own here.
    const made: Record<string, string> = { '20261014000000_p5_assets': 'Asset' };
    expect(made[newest], `name a table ${newest} makes`).toBeTruthy();
    const table = async () => withClient(owner, async (c) => (await c.query(`SELECT to_regclass($1) AS t`, [`public."${made[newest]}"`])).rows[0].t);
    expect(await table()).not.toBeNull();
    // While P5 is applied, plan_step_guard is P3's body with P5's one rule added before its last line.
    const during = (await functionsNamed(['plan_step_guard']))[0]!.prosrc as string;
    const p3Body = bodyOf('plan_step_guard()');
    const lastLine = '  RETURN NEW;\nEND;\n';
    expect(p3Body.endsWith(lastLine)).toBe(true);
    expect(during.startsWith(p3Body.slice(0, -lastLine.length))).toBe(true);
    expect(during.endsWith(lastLine)).toBe(true);
    expect(during).toContain(`NEW."kind" = 'asset_task'`);
    await runDown(newest);
    expect(await table()).toBeNull();
    // Run again on what it left (the state a rollback half done would be in): it tolerates that, as its header says.
    await runDown(newest);
    // P5 replaced one of P3's functions: its down.sql puts P3's own body back to the letter (as P3's migration
    // wrote it), with the settings and grants it had, and takes away everything it added to older tables.
    const restored = await functionsNamed(['plan_step_guard']);
    expect(restored.map((r) => [r.proname, r.provolatile, r.prosecdef, r.config, r.public])).toEqual([
      ['plan_step_guard', 'v', false, 'search_path=public, pg_temp', false],
    ]);
    expect(restored[0]!.prosrc).toBe(p3Body);
    const leftovers = await withClient(owner, async (c) => (await c.query(
      `SELECT (SELECT count(*)::int FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('Proposal_valid_p5', 'Proposal_review_guard', 'Proposal_review_floor',
                 'Proposal_p5_digest_check', 'Entity_forgotten_p5', 'Resolution_for_task', 'Task_step_undone', 'Approval_clock')) AS triggers,
              (SELECT count(*)::int FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'Proposal' AND column_name IN ('reviewId', 'reviewRequired')) AS columns,
              (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'
                 AND c.relname IN ('Asset', 'Task', 'TaskOutput', 'Review', 'ReviewGate', 'TaskApprovalUse', 'review_coverage', 'review_gate_violations', 'Proposal_reviewId_idx')) AS relations,
              (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'
                 AND (p.proname ~ '^(p5|asset|task|review)_' OR p.proname IN ('proposal_review_floor', 'proposal_review_guard', 'entity_forgotten_p5', 'resolution_task_check', 'approval_clock'))) AS functions,
              (SELECT count(*)::int FROM pgboss.queue WHERE name IN ('tasks.tick', 'tasks.run', 'tasks.check', 'reviews.run')) AS queues`)).rows[0]);
    expect(leftovers).toEqual({ triggers: 0, columns: 0, relations: 0, functions: 0, queues: 0 });
    // What P4 gave P3's helpers is still there: P5's rollback touches nothing of P4's.
    expect((await functionsNamed(['p3_bind_approval']))[0]!.prosrc).toContain('pg_trigger_depth()');
    const status = await prisma(['migrate', 'status'], owner);
    expect(status.stdout + status.stderr).toMatch(new RegExp(`not yet been applied:[\\s\\S]*${newest}`));
    await migrateUp(owner);
    expect(await table()).not.toBeNull();
    await emptyDiff();
  });

  // A rollback goes newest first. P4 hardened three of P3's functions: after P5's down.sql, P4's puts P3's own
  // bodies back to the letter (as P3's migration wrote them), and takes away the trigger and the checks it added
  // to older tables. A deploy then re-applies both.
  it('P4\'s down.sql, after P5\'s, puts P3\'s helpers back to the letter; a deploy re-applies both', async () => {
    await runDown('20261014000000_p5_assets');
    await runDown('20261013000000_p4_forecasts');
    expect(await withClient(owner, async (c) => (await c.query(`SELECT to_regclass('public."ForecastRun"') AS t`)).rows[0].t)).toBeNull();
    await runDown('20261013000000_p4_forecasts');
    const restored = await functionsNamed(['p3_signed_proposal', 'p3_bind_approval', 'goal_entity_guard', 'plan_step_guard']);
    expect(restored.map((r) => [r.proname, r.provolatile, r.prosecdef, r.config, r.public])).toEqual([
      ['goal_entity_guard', 'v', false, 'search_path=public, pg_temp', false],
      ['p3_bind_approval', 'v', true, 'search_path=public, pg_temp', false],
      ['p3_signed_proposal', 's', false, 'search_path=public, pg_temp', false],
      ['plan_step_guard', 'v', false, 'search_path=public, pg_temp', false],
    ]);
    expect(restored.find((r) => r.proname === 'p3_signed_proposal')!.prosrc).toBe(bodyOf('p3_signed_proposal(p_approval text, p_goal text, p_actions text[])'));
    expect(restored.find((r) => r.proname === 'p3_bind_approval')!.prosrc).toBe(bodyOf('p3_bind_approval(p_approval text, p_goal text, p_action text)'));
    expect(restored.find((r) => r.proname === 'goal_entity_guard')!.prosrc).toBe(bodyOf('goal_entity_guard()'));
    expect(restored.find((r) => r.proname === 'plan_step_guard')!.prosrc).toBe(bodyOf('plan_step_guard()'));
    const leftovers = await withClient(owner, async (c) => (await c.query(
      `SELECT (SELECT count(*)::int FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('GoalEntity_bind', 'MetricPoint_valid', 'MetricSeries_guard', 'Prediction_valid', 'Prediction_valid_forecast',
                 'Prediction_valid_update', 'Resolution_valid', 'Resolution_will_check', 'Proposal_digest_check_forecast')) AS triggers,
              (SELECT count(*)::int FROM pg_constraint WHERE conname IN ('MetricSeries_money_check', 'MetricSeries_calendar_check', 'MetricSeries_onbox_check')) AS checks,
              (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'
                 AND (p.proname ~ '^(p4|forecast)_' OR p.proname IN ('metric_series_guard', 'metric_point_valid', 'prediction_valid', 'prediction_update_valid',
                      'prediction_forecast_check', 'prediction_question_guard', 'resolution_valid', 'resolution_will_check'))) AS functions`)).rows[0]);
    expect(leftovers).toEqual({ triggers: 0, checks: 0, functions: 0 });
    const status = await prisma(['migrate', 'status'], owner);
    expect(status.stdout + status.stderr).toMatch(/not yet been applied:[\s\S]*20261013000000_p4_forecasts[\s\S]*20261014000000_p5_assets/);
    await migrateUp(owner);
    await emptyDiff();
    // Re-applied in order: P5's rule is back on top of P3's body.
    expect((await functionsNamed(['plan_step_guard']))[0]!.prosrc).toContain(`NEW."kind" = 'asset_task'`);
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
