/**
 * The goal jobs on the real job bus (pg-boss on flint_test), as the runtime
 * registers them: with the planner on, the tick is scheduled every 2 minutes
 * in Flint's zone, and a tick's send becomes a review and then its plan stage,
 * each job carrying ids and times only; with the planner off (the default),
 * nothing is scheduled and nothing is worked.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NO_DB, freshDb, withClient, type TestUrls } from '../db';
import { createDb, type Db } from '../../src/db';
import { loadConfig } from '../../src/config';
import { startBus, type Bus } from '../../src/bus';
import { goalJobs, jobSpecs, startJobs, type JobContext } from '../../src/jobs';
import { goalFixture, type GoalFixture } from './fixture';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(read: () => Promise<T | null | undefined | false>, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await sleep(150);
  }
}

describe.skipIf(NO_DB)('the goal jobs on pg-boss', () => {
  let urls: TestUrls;
  let db: Db;
  let fx: GoalFixture;
  let bus: Bus;
  const logged: string[] = [];
  const owner = (sql: string, params: unknown[] = []) => withClient(urls.owner, (c) => c.query(sql, params));
  const ctx = (planner: 'on' | 'off'): JobContext => ({
    db, bus, sources: [], log: (m) => void logged.push(m),
    config: loadConfig({ DATABASE_URL: urls.app, HOME: '/tmp', FLINT_TZ: 'America/Chicago', FLINT_PLANNER: planner }),
  });

  beforeAll(async () => {
    urls = await freshDb();
    db = createDb(urls.app);
    fx = await goalFixture(urls, db);
    bus = await startBus(urls.app, () => {});
  });
  afterAll(async () => {
    await bus?.boss.stop({ graceful: false }).catch(() => {});
    await db?.$disconnect();
    if (urls) {
      await owner(`DELETE FROM pgboss.job`);
      await owner(`DELETE FROM pgboss.schedule`);
    }
  });

  it('planner on: the tick is scheduled, and a due goal goes tick, review, plan stage, with ids only in every job', async () => {
    const c = ctx('on');
    await startJobs(c, goalJobs(c));
    expect((await bus.boss.getSchedules()).map((s) => [s.name, s.cron, s.timezone])).toEqual([['goals.tick', '*/2 * * * *', 'America/Chicago']]);
    const g = await fx.activeGoal();
    // The cron's own send, made now rather than waited for.
    await bus.boss.send('goals.tick', null);
    const review = await until(() => db.goalReview.findFirst({ where: { goalId: g.id } }));
    expect(review).toMatchObject({ kind: 'scheduled', shadow: true });
    // No local model is configured here: the plan stage says so, and the review already stands.
    const planned = await until(async () => (await db.goalReview.findUniqueOrThrow({ where: { id: review.id } })).planner);
    expect(planned).toBe('none:off');
    const goal = await db.goal.findUniqueOrThrow({ where: { id: g.id } });
    expect(goal.nextReviewAt!.getTime()).toBeGreaterThan(Date.now());
    // 09:00 in Flint's zone.
    expect(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit', hourCycle: 'h23' }).format(goal.nextReviewAt!)).toBe('09:00');
    expect(await db.prediction.count({ where: { goalId: g.id, status: 'open' } })).toBe(1);
    // What pg-boss holds of them (outside retention and forget): ids and times, never a goal's words.
    const jobs = (await owner(`SELECT name, data::text AS data, output::text AS output, singleton_key FROM pgboss.job WHERE name LIKE 'goals.%' ORDER BY created_on`)).rows as Array<{ name: string; data: string | null; output: string | null; singleton_key: string | null }>;
    // (The cron itself may fire once more while this runs: any number of ticks, one review, one plan stage.)
    expect(jobs[0]!.name).toBe('goals.tick');
    const work = jobs.filter((j) => j.name !== 'goals.tick');
    expect(work.map((j) => j.name)).toEqual(['goals.review', 'goals.plan']);
    expect(JSON.parse(work[0]!.data!)).toEqual({ goalId: g.id, kind: 'scheduled', dueAt: expect.any(String) });
    expect(JSON.parse(work[1]!.data!)).toEqual({ goalId: g.id, reviewId: review.id });
    expect([work[0]!.singleton_key, work[1]!.singleton_key]).toEqual([g.id, g.id]);
    expect(JSON.stringify(jobs)).not.toContain('CANARY');
    // A log line says counts only.
    expect(logged.join('\n')).not.toContain('CANARY');
    expect(logged.some((l) => /^goals: \d+ scheduled and \d+ triggered review\(s\) sent/.test(l))).toBe(true);
  });

  it('planner off (the default): nothing is scheduled, and the whole job set has no goal job', async () => {
    const c = ctx('off');
    expect(goalJobs(c)).toEqual([]);
    expect(jobSpecs(c).map((s) => s.queue).filter((q) => q.startsWith('goals.'))).toEqual([]);
    expect(jobSpecs(ctx('on')).map((s) => s.queue).filter((q) => q.startsWith('goals.'))).toEqual(['goals.tick', 'goals.review', 'goals.plan']);
    // Starting the job set with the planner off takes the tick's schedule away.
    await startJobs(c, goalJobs(c));
    expect(await bus.boss.getSchedules()).toEqual([]);
  });
});
