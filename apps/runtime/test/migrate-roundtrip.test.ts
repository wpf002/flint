/**
 * Every migration goes up, comes back down, and goes up again to exactly the
 * Prisma schema, with exactly the grants in fixtures/grants.json (plan 3.0.6).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NO_DB, URLS, MIGRATIONS, migrationDirs, migrateDown, migrateUp, pgError, prisma, withClient } from './db';
import { grantLines } from '../src/backup/grants';
import { buildReference, catalogLines, checkoutMigrations } from '../src/backup/catalog';
import { p5Kit } from './p5';

const GRANTS_FIXTURE = join(__dirname, 'fixtures', 'grants.json');
const grants = (owner: string): Promise<string[]> => withClient(owner, (c) => grantLines(c, { everyone: true }));

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

  const P5 = '20261014000100_p5_assets';
  const runDown = (dir: string) => withClient(owner, (c) => c.query(readFileSync(join(MIGRATIONS, dir, 'down.sql'), 'utf8')));
  /** A function as the catalog has it: its body, and the settings and grants a down.sql must put back with it. */
  const functionsNamed = (names: string[]) => withClient(owner, async (c) => (await c.query(
    `SELECT p.proname, p.prosrc, p.provolatile, p.prosecdef, array_to_string(p.proconfig, ';') AS config,
            EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0) AS public
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = ANY ($1) ORDER BY 1`, [names])).rows);

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
    expect(await pgError(runDown(P5))).toMatchObject(refusedFor(1));
    // Running, and under any of the names a P5 guard acts on (a reviewer's or the Hive's dispatch among them).
    const running = await k.card('hive.dispatch_job', { taskId: 'tanone2' });
    const review = await k.card('review.local', { taskId: 'tanone3' }, { stage: 'approved' });
    expect(await pgError(runDown(P5))).toMatchObject(refusedFor(3));
    expect(await there()).toBe(true);
    // Each ends: the first fails, the second finishes, the third fails too. A card of another kind that is approved was never P5's to hold.
    await k.app(`UPDATE "Proposal" SET status = 'failed', error = 'Synthetic end', "executedAt" = now() WHERE id = ANY ($1)`, [[approved.pid, review.pid]]);
    await k.finish(running.pid);
    await k.card('world.sync.git', { source: 'git' }, { kind: 'tool_call', stage: 'approved' });
    // (The next test runs it, on this state.)
    expect((await withClient(owner, async (c) => (await c.query(
      `SELECT count(*)::int AS n FROM "Proposal" WHERE status IN ('approved', 'executing') AND (kind IN ('task', 'spend') OR action ~ '^(task[.]|asset[.]enable$|review[.])' OR action = 'hive.dispatch_job')`)).rows[0].n))).toBe(0);
  });

  // A migration's down.sql, then a deploy, gives back exactly the schema: migrate status lists it as not
  // applied, what it did is undone, and the redeploy diffs empty. The newest is the one a rollback undoes, and
  // its down.sql runs alone; one before it runs after the newer ones' (newest first). (A much older migration's
  // down.sql alone no longer can: p1_ledger's would recreate Prediction without the columns P3 and P4 add.)
  const rollsBack = async (target: string): Promise<void> => {
    // Something true only while the target migration is applied, to see it go and come back. A new migration names its own here.
    // (P4 part 3's: its two columns, how many of a forecast's steps were filled in and where each number was read to. P5's: its first table.)
    const applied: Record<string, string> = {
      '20261014000000_p4_forecast_inputs': `(SELECT count(*) = 2 FROM information_schema.columns WHERE table_schema = 'public'
        AND ((table_name = 'ForecastRun' AND column_name = 'filled') OR (table_name = 'MetricSeries' AND column_name = 'readTo')))`,
      [P5]: `(SELECT to_regclass('public."Asset"') IS NOT NULL)`,
      '20261015000000_p7_resilience': `to_regclass('public."BackupRun_kind_location_path_key"') IS NOT NULL`,
    };
    expect(applied[target], `say what ${target} makes true`).toBeTruthy();
    const there = async () => withClient(owner, async (c) => (await c.query<{ t: boolean }>(`SELECT ${applied[target]} AS t`)).rows[0]!.t);
    expect(await there()).toBe(true);
    // P5 replaced one of P3's functions. While it is applied, plan_step_guard is P3's body with P5's one rule added before its last line.
    const p3 = readFileSync(join(MIGRATIONS, '20261009000000_p3_goals', 'migration.sql'), 'utf8');
    const p3From = p3.indexOf('AS $$', p3.indexOf('CREATE FUNCTION plan_step_guard()')) + 'AS $$'.length;
    const p3Body = p3.slice(p3From, p3.indexOf('\n$$;', p3From) + 1);
    if (target === P5) {
      const during = (await functionsNamed(['plan_step_guard']))[0]!.prosrc as string;
      const lastLine = '  RETURN NEW;\nEND;\n';
      expect(p3Body.endsWith(lastLine)).toBe(true);
      expect(during.startsWith(p3Body.slice(0, -lastLine.length))).toBe(true);
      expect(during.endsWith(lastLine)).toBe(true);
      expect(during).toContain(`NEW."kind" = 'asset_task'`);
    }
    // Everything newer goes first, newest first, as a rollback past it would run them.
    for (const newer of migrationDirs().filter((d) => d > target).reverse()) await runDown(newer);
    await withClient(owner, (c) => c.query(readFileSync(join(MIGRATIONS, target, 'down.sql'), 'utf8')));
    expect(await there()).toBe(false);
    // Nothing else of the schema went with it.
    if (target === '20261014000000_p4_forecast_inputs') {
      expect((await objects(owner)).tables).toEqual(expect.arrayContaining(['public.ForecastRun', 'public.MetricSeries']));
      expect(await withClient(owner, async (c) => (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema = 'public' AND column_name IN ('filled', 'readTo')`)).rows[0]!.n)).toBe(0);
    }
    // Run again on what it left (the state a rollback half done would be in): it tolerates that, as its header says.
    await withClient(owner, (c) => c.query(readFileSync(join(MIGRATIONS, target, 'down.sql'), 'utf8')));
    if (target === P5) {
      // Its down.sql puts P3's own body back to the letter (as P3's migration wrote it), with the settings and
      // grants it had, and takes away everything it added to older tables.
      const restored = await functionsNamed(['plan_step_guard']);
      expect(restored.map((r) => [r.proname, r.provolatile, r.prosecdef, r.config, r.public])).toEqual([
        ['plan_step_guard', 'v', false, 'search_path=public, pg_temp', false],
      ]);
      expect(restored[0]!.prosrc).toBe(p3Body);
      const leftovers = await withClient(owner, async (c) => (await c.query(
        `SELECT (SELECT count(*)::int FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('Proposal_valid_p5', 'Proposal_review_guard', 'Proposal_review_floor',
                   'Proposal_p5_digest_check', 'Entity_forgotten_p5', 'Resolution_for_task', 'Task_step_undone', 'Approval_clock', 'Approval_signed_for')) AS triggers,
                (SELECT count(*)::int FROM information_schema.columns WHERE table_schema = 'public'
                   AND ((table_name = 'Proposal' AND column_name IN ('reviewId', 'reviewRequired')) OR (table_name = 'Approval' AND column_name = 'signedFor'))) AS columns,
                (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'
                   AND c.relname IN ('Asset', 'Task', 'TaskOutput', 'Review', 'ReviewGate', 'TaskApprovalUse', 'review_coverage', 'review_gate_violations', 'Proposal_reviewId_idx', 'Approval_signedFor_createdAt_idx')) AS relations,
                (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'
                   AND (p.proname ~ '^(p5|asset|task|review)_' OR p.proname IN ('proposal_review_floor', 'proposal_review_guard', 'entity_forgotten_p5', 'resolution_task_check', 'approval_clock', 'approval_signed_for'))) AS functions,
                (SELECT count(*)::int FROM pgboss.queue WHERE name IN ('tasks.tick', 'tasks.run', 'tasks.check', 'reviews.run')) AS queues`)).rows[0]);
      expect(leftovers).toEqual({ triggers: 0, columns: 0, relations: 0, functions: 0, queues: 0 });
      // Nothing of the migrations before it went: P4's two columns, the policy floor's rules, and what P4 gave P3's helpers.
      expect(await withClient(owner, async (c) => (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema = 'public' AND column_name IN ('filled', 'readTo')`)).rows[0]!.n)).toBe(2);
      expect(await withClient(owner, async (c) => (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgname IN ('Proposal_policy_floor', 'Proposal_clock', 'HealthCheck_clock') AND NOT tgisinternal`)).rows[0]!.n)).toBe(3);
      expect((await functionsNamed(['p3_bind_approval']))[0]!.prosrc).toContain('pg_trigger_depth()');
    }
    const status = await prisma(['migrate', 'status'], owner);
    expect(status.stdout + status.stderr).toMatch(new RegExp(`not yet been applied:[\\s\\S]*${target}`));
    await migrateUp(owner);
    expect(await there()).toBe(true);
    const diff = await prisma(['migrate', 'diff', '--from-url', owner, '--to-schema-datamodel', 'prisma/schema.prisma', '--exit-code'], owner);
    expect(diff.code, diff.stdout + diff.stderr).toBe(0);
    // Re-applied on top of P3's body: P5's rule is back.
    if (target === P5) expect((await functionsNamed(['plan_step_guard']))[0]!.prosrc).toContain(`NEW."kind" = 'asset_task'`);
  
  };

  // P5 first, on the cards the test above left (each ended): its own checks are in the steps above.
  it('P5\'s down.sql, after the newer one\'s, then deploy, re-applies it: P3\'s plan_step_guard is back to the letter in between', async () => {
    expect(migrationDirs().at(-1)).not.toBe(P5);
    await rollsBack(P5);
  });

  it('the newest migration\'s down.sql, then deploy, re-applies it (the documented rollback)', async () => {
    await rollsBack(migrationDirs().at(-1)!);
  });

  // P7's one change, on rows that are there: a file recorded twice does not stop the migration (it keeps one record of
  // it and goes on); the kind named for a host Nexus has left is renamed, and gets its name back on the way down.
  it('P7: a backup recorded twice is settled, never a stopped deploy; the Nexus kind is renamed, and renamed back', async () => {
    const P7 = '20261015000000_p7_resilience';
    const sql = (file: string) => readFileSync(join(MIGRATIONS, P7, file), 'utf8');
    const row = (id: string, kind: string, path: string, status = 'ok', at = 'now()') =>
      `INSERT INTO "BackupRun" ("id", "kind", "location", "path", "encrypted", "status", "startedAt") VALUES ('${id}', '${kind}', 'local', '${path}', false, '${status}', ${at})`;
    await withClient(owner, async (c) => {
      await c.query(sql('down.sql'));
      try {
        await c.query(row('p7-a', 'pg_dump_flint', '/b/one.dump', 'ok', `now() - interval '2 days'`));
        await c.query(row('p7-b', 'pg_dump_flint', '/b/one.dump', 'ok', `now() - interval '1 day'`));
        await c.query(row('p7-c', 'pg_dump_flint', '/b/one.dump', 'failed'));
        await c.query(row('p7-n', 'nexus_railway_dump', '/b/nexus.dump'));
        await c.query(row('p7-other', 'pg_dump_flint', '/b/two.dump'));
        await c.query(sql('migration.sql'));
        // One record of the file that had three: the newest good one, never the failure that came after it.
        expect((await c.query(`SELECT "id" FROM "BackupRun" WHERE "id" LIKE 'p7-%' ORDER BY 1`)).rows.map((r) => r.id)).toEqual(['p7-b', 'p7-n', 'p7-other']);
        expect((await c.query(`SELECT "kind" FROM "BackupRun" WHERE "id" = 'p7-n'`)).rows).toEqual([{ kind: 'nexus_dump' }]);
        expect((await c.query(`SELECT to_regclass('public."BackupRun_kind_location_path_key"') AS t`)).rows[0].t).not.toBeNull();
        // From here one file is one row, and the earlier name of the kind is refused.
        expect((await pgError(c.query(row('p7-d', 'pg_dump_flint', '/b/one.dump')))).code).toBe('23505');
        expect((await pgError(c.query(row('p7-e', 'nexus_railway_dump', '/b/other.dump')))).code).toBe('23514');
        // Run on rows that are already one to a file, it removes nothing.
        await c.query(sql('down.sql'));
        expect((await c.query(`SELECT "kind" FROM "BackupRun" WHERE "id" = 'p7-n'`)).rows).toEqual([{ kind: 'nexus_railway_dump' }]);
        await c.query(sql('migration.sql'));
        expect((await c.query(`SELECT count(*)::int AS n FROM "BackupRun" WHERE "id" LIKE 'p7-%'`)).rows[0].n).toBe(3);
        await c.query(sql('down.sql'));
      } finally {
        await c.query(`DELETE FROM "BackupRun" WHERE "id" LIKE 'p7-%'`);
      }
    });
    // Prisma's own record of it went with the rollback: the deploy puts the migration back.
    await migrateUp(owner);
    const diff = await prisma(['migrate', 'diff', '--from-url', owner, '--to-schema-datamodel', 'prisma/schema.prisma', '--exit-code'], owner);
    expect(diff.code, diff.stdout + diff.stderr).toBe(0);
  });

  // The floor: nobody reaches a Flint database, or its public schema, by default. The Mac Flint runs on had this
  // done by hand at first setup, so the migration must change nothing there, and its down.sql must give back
  // exactly what a database built without it has (a restore compares the two, line by line).
  describe('the public schema floor', () => {
    const FLOOR = '20261013000150_public_schema_floor';
    const sql = (file: string) => readFileSync(join(MIGRATIONS, FLOOR, file), 'utf8');
    /** Who holds what on the public schema and on the database itself, the owner's own left out: `who=rights`, sorted. */
    const acl = () => withClient(owner, async (c) => (await c.query<{ on: string; who: string; rights: string }>(
      `SELECT 'schema' AS on, CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS who, string_agg(a.privilege_type, ',' ORDER BY a.privilege_type) AS rights
       FROM pg_namespace n, LATERAL aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a WHERE n.nspname = 'public' AND a.grantee <> n.nspowner GROUP BY 1, 2
       UNION ALL
       SELECT 'database', CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END, string_agg(a.privilege_type, ',' ORDER BY a.privilege_type)
       FROM pg_database d, LATERAL aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) a WHERE d.datname = current_database() AND a.grantee <> d.datdba GROUP BY 1, 2
       ORDER BY 1, 2`)).rows.map((r) => `${r.on} ${r.who}=${r.rights}`));
    const FLOORED = [
      'database flint_app=CONNECT', 'database flint_approver=CONNECT', 'database flint_backup=CONNECT',
      'schema flint_app=USAGE', 'schema flint_approver=USAGE', 'schema flint_backup=USAGE',
    ];

    it('everyone holds nothing on the public schema or the database; each of Flint\'s roles holds what it needs, by name', async () => {
      expect(await acl()).toEqual(FLOORED);
      // And each role still does its work: the runtime's and the approval path's read their tables, the backup role reads everything.
      await withClient(URLS!.app, (c) => c.query('SELECT 1 FROM "Proposal" LIMIT 1'));
      await withClient(URLS!.approver, (c) => c.query('SELECT 1 FROM "ApprovalCredential" LIMIT 1'));
      if (URLS!.backup) await withClient(URLS!.backup, (c) => c.query('SELECT 1 FROM "AuditEntry" LIMIT 1'));
    });

    it('changes nothing on a database that already has it (the one it was written from), however often it runs', async () => {
      const before = await acl();
      await withClient(owner, (c) => c.query(sql('migration.sql')));
      await withClient(owner, (c) => c.query(sql('migration.sql')));
      expect(await acl()).toEqual(before);
      expect(await grants(owner)).toEqual(JSON.parse(readFileSync(GRANTS_FIXTURE, 'utf8')));
    });

    it('its down.sql gives back exactly what a database built without it has, the database\'s own rights included', async () => {
      const all = checkoutMigrations(MIGRATIONS);
      await migrateDown(owner);
      const without = await withClient(owner, async (c) => {
        await buildReference(c, all.filter((m) => m.name < FLOOR));
        return { lines: await catalogLines(c), acl: await acl() };
      });
      // What a database built before the floor had: everyone may use the schema and connect, and no role is named on the database.
      expect(without.acl).toEqual(['database PUBLIC=CONNECT', 'schema PUBLIC=USAGE', 'schema flint_app=USAGE', 'schema flint_approver=USAGE']);
      await migrateDown(owner);
      await migrateUp(owner);
      try {
        const rolledBack = await withClient(owner, async (c) => {
          for (const d of migrationDirs().filter((x) => x >= FLOOR).reverse()) await c.query(readFileSync(join(MIGRATIONS, d, 'down.sql'), 'utf8'));
          return { lines: await catalogLines(c), acl: await acl() };
        });
        expect(rolledBack.acl).toEqual(without.acl);
        expect({ gone: without.lines.filter((l) => !rolledBack.lines.includes(l)), left: rolledBack.lines.filter((l) => !without.lines.includes(l)) }).toEqual({ gone: [], left: [] });
      } finally {
        // Whatever it found, the tests after this one get the whole schema back.
        await migrateUp(owner);
      }
      expect(await acl()).toEqual(FLOORED);
    });
  });

  // The one before it: P3's policy floor, a migration of rules only (three triggers and their functions). Its
  // down.sql, with the newest already rolled back: what it made goes, and nothing else of the schema does.
  it('the policy floor\'s down.sql takes its triggers and functions away, and nothing else', async () => {
    const POLICY = '20261013000100_p3_policy_floor';
    const there = async () => withClient(owner, async (c) => (await c.query(
      `SELECT string_agg(tgname, ',' ORDER BY tgname) AS t FROM pg_trigger WHERE tgname IN ('Proposal_policy_floor', 'Proposal_clock', 'HealthCheck_clock') AND NOT tgisinternal`)).rows[0].t as string | null);
    expect(await there()).toBe('HealthCheck_clock,Proposal_clock,Proposal_policy_floor');
    try {
      await withClient(owner, async (c) => {
        for (const d of migrationDirs().filter((x) => x >= POLICY).reverse()) await c.query(readFileSync(join(MIGRATIONS, d, 'down.sql'), 'utf8'));
      });
      expect(await there()).toBeNull();
      // Its functions go with it, and nothing else of the schema does.
      expect((await objects(owner)).functions.filter((f) => /proposal_policy_floor|row_clock/.test(f))).toEqual([]);
      expect((await objects(owner)).tables).toContain('public.Proposal');
      expect((await objects(owner)).tables).toContain('public.ForecastRun');
      const status = await prisma(['migrate', 'status'], owner);
      expect(status.stdout + status.stderr).toMatch(new RegExp(`not yet been applied:[\\s\\S]*${POLICY}`));
      // Run twice, it is still a no-op (every statement tolerates a half-applied state).
      await withClient(owner, (c) => c.query(readFileSync(join(MIGRATIONS, POLICY, 'down.sql'), 'utf8')));
    } finally {
      await migrateUp(owner);
    }
    expect(await there()).toBe('HealthCheck_clock,Proposal_clock,Proposal_policy_floor');
  });

  // P4 also hardened three of P3's functions: its down.sql puts P3's own bodies back to the letter (as P3's
  // migration wrote them), and takes away the trigger and the checks it added to older tables.
  it('P4\'s down.sql puts P3\'s own function bodies back to the letter, and leaves none of its own', async () => {
    const P4 = '20261013000000_p4_forecasts';
    try {
      await withClient(owner, async (c) => {
        for (const d of migrationDirs().filter((x) => x >= P4).reverse()) await c.query(readFileSync(join(MIGRATIONS, d, 'down.sql'), 'utf8'));
      });
      expect(await withClient(owner, async (c) => (await c.query(`SELECT to_regclass('public."ForecastRun"') AS t`)).rows[0].t)).toBeNull();
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
    } finally {
      await migrateUp(owner);
    }
    const diff = await prisma(['migrate', 'diff', '--from-url', owner, '--to-schema-datamodel', 'prisma/schema.prisma', '--exit-code'], owner);
    expect(diff.code, diff.stdout + diff.stderr).toBe(0);
  });

  // A rolled-back database is one a backup may be taken of, and a restore compares what it restored with what
  // the checkout's migrations build (src/backup/catalog.ts). So a down.sql leaves exactly what an install
  // without its migration has: the same tables, columns, checks, indexes, triggers, functions and grants.
  // Held for every migration from P4 on (the older ones predate the comparison, and two keep a wider list on
  // purpose for rows that are never deleted).
  const COMPARED_SINCE = '20261013000000_p4_forecasts';
  it.each(migrationDirs().filter((d) => d >= COMPARED_SINCE))('%s: its down.sql leaves exactly what an install without it has', async (name) => {
    const all = checkoutMigrations(MIGRATIONS);
    await migrateDown(owner);
    const without = await withClient(owner, async (c) => {
      await buildReference(c, all.filter((m) => m.name < name));
      return catalogLines(c);
    });
    await migrateDown(owner);
    await migrateUp(owner);
    try {
      const rolledBack = await withClient(owner, async (c) => {
        for (const d of migrationDirs().filter((x) => x >= name).reverse()) await c.query(readFileSync(join(MIGRATIONS, d, 'down.sql'), 'utf8'));
        return catalogLines(c);
      });
      expect({ gone: without.filter((l) => !rolledBack.includes(l)), left: rolledBack.filter((l) => !without.includes(l)) }).toEqual({ gone: [], left: [] });
    } finally {
      // Whatever it found, the tests after this one get the whole schema back.
      await migrateUp(owner);
    }
  });

  // The one thing P4's rollback cannot put back: once a forecast is on record as `statistical` (never before Will
  // signs the card that turns a number on), the list of methods has to go on allowing it, because a prediction
  // is never deleted. The row stays, the wider list stays with it, and nothing else differs.
  it('P4\'s down.sql keeps allowing a statistical prediction that is on record, and nothing else differs', async () => {
    const P4 = '20261013000000_p4_forecasts';
    const all = checkoutMigrations(MIGRATIONS);
    await migrateDown(owner);
    const without = await withClient(owner, async (c) => {
      await buildReference(c, all.filter((m) => m.name < P4));
      return catalogLines(c);
    });
    await migrateDown(owner);
    await migrateUp(owner);
    try {
      const rolledBack = await withClient(owner, async (c) => {
        // On record as the forecast job would have left it; its guards are P4's own subject, so they are stepped around here.
        await c.query(`ALTER TABLE "Prediction" DISABLE TRIGGER USER`);
        await c.query(
          `INSERT INTO "Prediction" ("id", "claim", "method", "domain", "type", "evidence", "resolutionCriteria", "resolver", "resolveBy", "createdBy", "probability")
           VALUES ('p-statistical', 'a number crosses a line', 'statistical', 'services', 'threshold_cross', '[]', 'the number, read on the day', 'auto_metric', now() + interval '1 day', 'runtime:forecast', 0.5)`);
        await c.query(`ALTER TABLE "Prediction" ENABLE TRIGGER USER`);
        for (const d of migrationDirs().filter((x) => x >= P4).reverse()) await c.query(readFileSync(join(MIGRATIONS, d, 'down.sql'), 'utf8'));
        expect((await c.query(`SELECT "method" FROM "Prediction" WHERE "id" = 'p-statistical'`)).rows).toEqual([{ method: 'statistical' }]);
        return catalogLines(c);
      });
      const check = (lines: string[]) => lines.filter((l) => l.startsWith('constraint|public.Prediction|Prediction_method_check|'));
      expect(check(rolledBack).join()).toContain(`'statistical'`);
      expect(check(without).join()).not.toContain(`'statistical'`);
      const rest = (lines: string[]) => lines.filter((l) => !check(lines).includes(l));
      expect({ gone: rest(without).filter((l) => !rolledBack.includes(l)), left: rest(rolledBack).filter((l) => !without.includes(l)) }).toEqual({ gone: [], left: [] });
    } finally {
      // The row is a test's: take it away (its guards say never, which is why they are stepped around), then the whole schema back.
      await withClient(owner, async (c) => {
        await c.query(`ALTER TABLE "Prediction" DISABLE TRIGGER USER`);
        await c.query(`DELETE FROM "Prediction" WHERE "id" = 'p-statistical'`);
        await c.query(`ALTER TABLE "Prediction" ENABLE TRIGGER USER`);
      });
      await migrateUp(owner);
    }
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
