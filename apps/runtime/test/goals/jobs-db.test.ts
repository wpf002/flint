/**
 * The goal jobs on the real job bus (pg-boss on flint_test), as the runtime
 * registers them: with the planner on, the tick is scheduled every 2 minutes
 * in Flint's zone, and a tick's send becomes a review and then its plan stage,
 * each job carrying ids and times only; with the planner off (the default),
 * nothing is scheduled and nothing is worked.
 *
 * What only the real bus can show:
 *  - A triggered review is sent with its 60-second wait in the same
 *    transaction as the cursor, pg-boss holds it until then, and from a change
 *    to its review is under 10 minutes at the worst (a full tick interval, the
 *    wait, the worker's pick-up and stage 1).
 *  - A plan stage that yields to chat sends itself again while its own job is
 *    still running (the queue is stately: one waiting, one running per goal),
 *    15 seconds out, and that job runs and finishes the same review.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { NO_DB, freshDb, withClient, type TestUrls } from '../db';
import { createDb, type Db } from '../../src/db';
import { loadConfig } from '../../src/config';
import { startBus, type Bus } from '../../src/bus';
import { goalJobs, jobSpecs, startJobs, type JobContext } from '../../src/jobs';
import { runReview } from '../../src/goals/review';
import { COALESCE_SECONDS, TICK_CRON, TICK_SECONDS, tick } from '../../src/goals/tick';
import { DEFER_SECONDS } from '../../src/goals/batch';
import { FakeBus, goalFixture, type GoalFixture } from './fixture';

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

  it('exit 3 on the real bus: a triggered review waits its 60 seconds in pg-boss, and a change is reviewed in under 10 minutes at the worst', async () => {
    // (The first test's workers are still running, as the runtime's would be.)
    const pr = await fx.pullRequest(131, 'open');
    const g = await fx.activeGoal({ successCriteria: [fx.crit('c1', { kind: 'item', entityId: pr, key: 'state', value: 'merged' })], links: [{ entityId: pr, role: 'target', watchPaths: ['state'] }] });
    // Its first, scheduled review has run: only the change below is waiting for the tick.
    const due = (await db.goal.findUniqueOrThrow({ where: { id: g.id } })).nextReviewAt!;
    expect((await runReview({ db, bus: new FakeBus(), tz: 'UTC' }, { goalId: g.id, kind: 'scheduled', dueAt: due.toISOString() })).outcome).toBe('reviewed');

    await fx.pullRequest(131, 'merged');
    const version = await fx.latestVersion(pr);
    // The tick, as its job runs it (the production wait), on the real bus: the send commits with the cursor.
    const sent = await tick({ db, bus, tz: 'America/Chicago' });
    expect(sent.triggered).toBeGreaterThanOrEqual(1);
    const job = async () => (await owner(
      `SELECT id, state, data::text AS data, singleton_key, extract(epoch FROM (start_after - created_on)) * 1000 AS wait_ms FROM pgboss.job WHERE name = 'goals.review' AND singleton_key = $1 AND data->>'kind' = 'triggered'`, [g.id],
    )).rows[0] as { id: string; state: string; data: string; singleton_key: string; wait_ms: string } | undefined;
    const waiting = (await job())!;
    expect(waiting).toMatchObject({ state: 'created', singleton_key: g.id });
    expect(JSON.parse(waiting.data)).toEqual({ goalId: g.id, kind: 'triggered', triggerEventId: `version:${version.id}` });
    const waitMs = Number(waiting.wait_ms);
    expect(Math.abs(waitMs - COALESCE_SECONDS * 1000)).toBeLessThan(2_000);
    expect((await db.goalEntity.findUniqueOrThrow({ where: { goalId_entityId: { goalId: g.id, entityId: pr } } })).seenVersion).toBe(2);
    // pg-boss holds it: the running worker does not take it before its time.
    await sleep(3_000);
    expect((await job())!.state).toBe('created');
    expect(await db.goalReview.count({ where: { goalId: g.id, kind: 'triggered' } })).toBe(0);
    // Its time comes (brought forward here, so the test does not sit out the minute): the worker takes it and stage 1 runs.
    const released = Date.now();
    await owner(`UPDATE pgboss.job SET start_after = now() WHERE id = $1`, [waiting.id]);
    const review = await until(() => db.goalReview.findFirst({ where: { goalId: g.id, kind: 'triggered' } }));
    const pickUpAndStage1 = review.createdAt.getTime() - released;
    expect(review).toMatchObject({ triggerEventId: `version:${version.id}`, criteria: [{ id: 'c1', state: 'met' }] });
    // The bound, from what the bus itself was given: a full tick interval before the change is seen, the wait pg-boss
    // holds the job for, then the worker's pick-up and stage 1 as just measured.
    expect((await bus.boss.getSchedules()).find((s) => s.name === 'goals.tick')!.cron).toBe(TICK_CRON);
    const worst = TICK_SECONDS * 1000 + waitMs + pickUpAndStage1;
    expect(pickUpAndStage1).toBeLessThan(30_000);
    expect(worst).toBeLessThan(10 * 60_000);
    expect(worst).toBeLessThan(4 * 60_000);
  }, 60_000);

  it('on the real bus: a plan stage that yields to chat sends itself again while its job still runs, 15 seconds out, and that job finishes the review', async () => {
    // A stand-in for the server's load answer and for Ollama, on loopback: chat is busy at first.
    let chatInFlight = 1;
    /** What the stand-in model was sent (another goal's plan stage may be waiting on this worker too). */
    const prompts: string[] = [];
    const local: Server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString('utf8')));
      req.on('end', () => {
        if (req.url === '/api/chat') prompts.push(body);
        res.setHeader('content-type', 'application/json');
        if (req.url === '/internal/load') return void res.end(JSON.stringify({ chatInFlight }));
        // Ollama's own listing: the model runs on it (every local call asks first, model/here.ts).
        if (req.url === '/api/tags') return void res.end(JSON.stringify({ models: [{ name: 'stub-model', model: 'stub-model' }] }));
        // The model: a valid reply that suggests nothing.
        res.end(JSON.stringify({ model: 'stub-model', message: { role: 'assistant', content: JSON.stringify({ reasonCode: 'on_track', ops: [] }) }, done: true, done_reason: 'stop', prompt_eval_count: 10, eval_count: 5 }));
      });
    });
    await new Promise<void>((r) => local.listen(0, '127.0.0.1', r));
    const at = `http://127.0.0.1:${(local.address() as AddressInfo).port}`;
    const busy: JobContext = {
      db, bus, sources: [], log: (m) => void logged.push(m),
      config: loadConfig({ DATABASE_URL: urls.app, HOME: '/tmp', FLINT_TZ: 'America/Chicago', FLINT_PLANNER: 'on', FLINT_TRIAGE_MODEL: 'stub-model', OLLAMA_URL: at, SERVER_INTERNAL_URL: at, SERVER_INTERNAL_TOKEN: 'ab'.repeat(32) }),
    };
    try {
      // The runtime's own plan-stage handler, with a server that says chat is busy, in place of the first test's.
      await bus.boss.offWork('goals.plan');
      const plan = goalJobs(busy).find((s) => s.queue === 'goals.plan')!;
      await bus.boss.work<object>('goals.plan', { batchSize: 1, localConcurrency: 1 }, plan.handler);

      const g = await fx.activeGoal();
      const due = (await db.goal.findUniqueOrThrow({ where: { id: g.id } })).nextReviewAt!;
      // Stage 1 on the real bus: its plan job is sent in the review's own transaction.
      const r = await runReview({ db, bus, tz: 'UTC' }, { goalId: g.id, kind: 'scheduled', dueAt: due.toISOString() });
      if (r.outcome !== 'reviewed') throw new Error(r.outcome);
      const jobs = async () => (await owner(
        `SELECT state, data::text AS data, singleton_key, extract(epoch FROM (start_after - created_on)) * 1000 AS wait_ms, created_on FROM pgboss.job WHERE name = 'goals.plan' AND singleton_key = $1 ORDER BY created_on`, [g.id],
      )).rows as Array<{ state: string; data: string; singleton_key: string; wait_ms: string; created_on: Date }>;
      // The worker ran it, chat was busy, and it sent itself again: accepted while the first job was still active.
      const [first, again] = await until(async () => { const j = await jobs(); return j.length >= 2 && j[0]!.state === 'completed' ? j : null; });
      expect(JSON.parse(first!.data)).toEqual({ goalId: g.id, reviewId: r.reviewId });
      expect(JSON.parse(again!.data)).toEqual({ goalId: g.id, reviewId: r.reviewId, deferrals: 1 });
      expect(again).toMatchObject({ state: 'created', singleton_key: g.id });
      expect(Math.abs(Number(again!.wait_ms) - DEFER_SECONDS * 1000)).toBeLessThan(2_000);
      // The model was not asked, the review still waits for its plan stage, and nothing was claimed.
      expect(prompts).toEqual([]);
      expect((await db.goalReview.findUniqueOrThrow({ where: { id: r.reviewId } })).planner).toBeNull();
      // Chat goes quiet. The second job is not taken before its 15 seconds; then it runs and the review has its answer.
      chatInFlight = 0;
      await sleep(3_000);
      expect((await jobs())[1]!.state).toBe('created');
      const done = await until(async () => { const row = await db.goalReview.findUniqueOrThrow({ where: { id: r.reviewId } }); return row.planner ? row : null; }, 40_000);
      expect(done.planner).toBe('ollama:stub-model');
      expect(Date.now() - again!.created_on.getTime()).toBeGreaterThanOrEqual(DEFER_SECONDS * 1000 - 500);
      // The model was asked once for this goal, and read its words (it is local).
      expect(prompts.filter((b) => b.includes(g.title))).toHaveLength(1);
      expect((await jobs()).map((j) => j.state)).toEqual(['completed', 'completed']);
      expect(JSON.stringify(await jobs())).not.toContain('CANARY');
    } finally {
      await bus.boss.offWork('goals.plan').catch(() => {});
      await new Promise<void>((r) => local.close(() => r()));
    }
  }, 90_000);

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
