/**
 * The goal tick on flint_test (P3 part 3; exit criterion 3), on a fake clock:
 * the tick and the review take the time they are given, and the bus is a
 * stand-in that keeps what was sent.
 *
 *  - A change on a watched field at t0 is a review (kind triggered, trigger
 *    version:<id>) by t0 + 10 minutes: at worst 2 minutes to the tick and 60
 *    seconds of waiting, then stage 1.
 *  - A change to a field nobody watches, or to the name, sets nothing off, and
 *    the cursor still moves. Archived, restored, merged and forgotten always
 *    set a review off. The same version never does twice.
 *  - The cursor moves in the same transaction as the send: a send that fails
 *    leaves it where it was, and the change is seen again.
 *  - A step due within 48 hours sets a review off; so does a forecast about a
 *    linked item that came false (never the goal's own onTrack forecast). One
 *    review answers every trigger that was there when it ran: three steps due
 *    the same day, or a change, a false forecast and a due step together, are
 *    one review. A new plan version, or a moved due time, is a new trigger.
 *  - Late is counted in reviewing time, from the Goal Reviews rows the health
 *    job keeps: never from this process's memory, so it adds up across restarts
 *    and nights.
 *  - Past a goal's 12 a day, a change is left to the next scheduled review.
 *  - A scheduled review is sent when the goal's time has come, once, with its
 *    due time; a job that died is sent again by the next tick.
 *  - Lock order: the tick takes the goal FOR UPDATE before it reads a link or
 *    moves a cursor; a goal someone else holds is left for the next tick.
 *  - With the planner off, nothing is scheduled. A FORBIDDEN rule sends nothing.
 * Synthetic text only.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { NO_DB, freshDb, id, pgConfig, pgError, type TestUrls } from '../db';
import { createDb, type Db } from '../../src/db';
import { loadConfig } from '../../src/config';
import { goalJobs, type JobContext } from '../../src/jobs';
import { emitPrediction } from '../../src/ledger/emit';
import { ReviewJob, runReview } from '../../src/goals/review';
import { COALESCE_SECONDS, TICK_CRON, TICK_SECONDS, tick } from '../../src/goals/tick';
import { EVIDENCE_GAP_MS, REVIEWS_STOPPED, reviewingLog, reviewingMs, waitedMs } from '../../src/goals/late';
import { CANARY, DAY, FakeBus, MIN, goalFixture, type GoalFixture } from './fixture';
import { pastRows } from '../ledger/kit';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(NO_DB)('the goal tick on flint_test', () => {
  let urls: TestUrls;
  let db: Db;
  let fx: GoalFixture;
  const bus = new FakeBus();
  const run = (now = new Date(), b: FakeBus = bus) => tick({ db, bus: b, tz: 'UTC', now: () => now });
  const reviewJobs = (goalId: string, b: FakeBus = bus) => b.of('goals.review').filter((j) => j.data.goalId === goalId);
  const cursor = async (goalId: string, entityId: string) => (await db.goalEntity.findUniqueOrThrow({ where: { goalId_entityId: { goalId, entityId } } })).seenVersion;
  /** Review every goal whose time has come, so only what a test sets up is due. */
  async function settle(now = new Date()) {
    for (const g of await db.goal.findMany({ where: { status: 'active', nextReviewAt: { lte: now } } })) {
      await runReview({ db, bus: new FakeBus(), tz: 'UTC', now: () => now }, { goalId: g.id, kind: 'scheduled', dueAt: g.nextReviewAt!.toISOString() });
    }
  }
  /** A goal watching one pull request's state, already reviewed once (so no scheduled review is due). */
  async function watching(n: number, over: Record<string, unknown> = {}) {
    const pr = await fx.pullRequest(n, 'open');
    const g = await fx.activeGoal({ successCriteria: [fx.crit('c1', { kind: 'item', entityId: pr, key: 'state', value: 'merged' })], links: [{ entityId: pr, role: 'target', watchPaths: ['state'] }], ...over });
    await settle();
    return { ...g, pr };
  }

  beforeAll(async () => {
    urls = await freshDb();
    db = createDb(urls.app);
    fx = await goalFixture(urls, db);
  });
  afterAll(async () => db?.$disconnect());
  beforeEach(() => bus.clear());

  it('a goal whose time has come gets its scheduled review, once, with its due time; a job that died is sent again', async () => {
    const g = await fx.activeGoal();
    const due = (await db.goal.findUniqueOrThrow({ where: { id: g.id } })).nextReviewAt!;
    const first = await run();
    expect(first.due).toBeGreaterThanOrEqual(1);
    const [job] = reviewJobs(g.id);
    expect(job).toEqual({ queue: 'goals.review', data: { goalId: g.id, kind: 'scheduled', dueAt: due.toISOString() }, options: { singletonKey: g.id } });
    expect(ReviewJob.safeParse(job!.data).success).toBe(true);
    // While that job waits, another tick sends nothing more for the goal.
    await run();
    expect(reviewJobs(g.id)).toHaveLength(1);
    // The job died without reviewing (a crash): the goal is still due, so the next tick heals it.
    bus.take('goals.review');
    await run();
    expect(reviewJobs(g.id)).toHaveLength(2);
    // Reviewed, it is not due again until its next time.
    await settle();
    bus.clear();
    await run();
    expect(reviewJobs(g.id)).toEqual([]);
    await run(new Date(Date.now() + 8 * DAY));
    expect(reviewJobs(g.id)).toHaveLength(1);
  });

  it('exit 3: a change on a watched field is a review within 10 minutes, on the tick’s own schedule', async () => {
    const g = await watching(101);
    // The tick's schedule, as the runtime registers it: every 2 minutes.
    const specs = goalJobs({ db, bus, sources: [], log: () => {}, config: loadConfig({ DATABASE_URL: urls.app, HOME: '/tmp', FLINT_TZ: 'UTC', FLINT_PLANNER: 'on' }) } as unknown as JobContext);
    expect(specs.find((s) => s.queue === 'goals.tick')!.cron).toBe('*/2 * * * *');
    expect([TICK_CRON, TICK_SECONDS]).toEqual(['*/2 * * * *', 120]);
    const TICK_MS = TICK_SECONDS * 1000;

    // t0: the pull request merges (its sync archives it), just after a tick ran.
    await fx.pullRequest(101, 'merged');
    const version = await fx.latestVersion(g.pr);
    expect(version).toMatchObject({ changeKind: 'archived', version: 2 });
    const t0 = version.recordedAt;
    expect(await cursor(g.id, g.pr)).toBe(1);

    // The next tick, a full interval later, finds it and sends the review to start after the wait.
    const tickAt = new Date(t0.getTime() + TICK_MS);
    expect(await run(tickAt)).toMatchObject({ triggered: 1 });
    const [job] = reviewJobs(g.id);
    expect(job).toMatchObject({ data: { goalId: g.id, kind: 'triggered', triggerEventId: `version:${version.id}` }, options: { singletonKey: g.id, startAfter: COALESCE_SECONDS } });
    expect(job!.options.db).toBeTruthy();
    expect(await cursor(g.id, g.pr)).toBe(2);

    // The job starts when its wait is over; stage 1 is database work.
    const startAt = new Date(tickAt.getTime() + job!.options.startAfter! * 1000);
    const began = Date.now();
    const out = await runReview({ db, bus, tz: 'UTC', now: () => startAt }, ReviewJob.parse(bus.take('goals.review')!.data));
    const doneAt = new Date(startAt.getTime() + (Date.now() - began));
    expect(out.outcome).toBe('reviewed');
    expect(doneAt.getTime() - t0.getTime()).toBeLessThan(10 * MIN);
    expect(doneAt.getTime() - t0.getTime()).toBeLessThan(4 * MIN);
    const review = await db.goalReview.findFirstOrThrow({ where: { goalId: g.id, kind: 'triggered' } });
    expect(review).toMatchObject({ triggerEventId: `version:${version.id}`, criteria: [{ id: 'c1', state: 'met' }], progressAfter: 1 });
    // The same version never sets off a second review.
    bus.clear();
    expect(await run(new Date(tickAt.getTime() + TICK_MS))).toMatchObject({ triggered: 0 });
    expect(reviewJobs(g.id)).toEqual([]);
  });

  it('a field nobody watches, or the name, sets nothing off and the cursor still moves; restored does', async () => {
    const g = await watching(102);
    // Its title changes (the name, and state.title): not watched, and a name never is.
    await fx.pullRequest(102, 'open', `${CANARY} a new PR title`);
    expect((await fx.latestVersion(g.pr)).patch).toHaveProperty('name');
    expect(await run()).toMatchObject({ triggered: 0 });
    expect(reviewJobs(g.id)).toEqual([]);
    expect(await cursor(g.id, g.pr)).toBe(2);
    // A field outside the watch list changes: nothing either.
    await fx.pullRequest(102, 'open', `${CANARY} a new PR title`, { draft: true });
    await run();
    expect(reviewJobs(g.id)).toEqual([]);
    expect(await cursor(g.id, g.pr)).toBe(3);
    // Closed (archived), then reopened (restored): each sets a review off, whatever is watched.
    await fx.pullRequest(102, 'closed', `${CANARY} a new PR title`);
    expect((await fx.latestVersion(g.pr)).changeKind).toBe('archived');
    await run();
    expect(reviewJobs(g.id)).toHaveLength(1);
    bus.clear();
    await fx.pullRequest(102, 'open', `${CANARY} a new PR title`);
    const restored = await fx.latestVersion(g.pr);
    expect(restored.changeKind).toBe('restored');
    await run();
    expect(reviewJobs(g.id).map((j) => j.data.triggerEventId)).toEqual([`version:${restored.id}`]);
  });

  it('merged and forgotten set a review off too, with nothing watched', async () => {
    for (const kind of ['merged', 'forgotten'] as const) {
      const pr = await fx.pullRequest(kind === 'merged' ? 103 : 104, 'open');
      // A link that watches no field at all.
      const g = await fx.activeGoal({ links: [{ entityId: pr, role: 'watch', watchPaths: [] }] });
      await settle();
      bus.clear();
      await run();
      expect(reviewJobs(g.id)).toEqual([]);
      // The item's next version, as a merge or a forget writes it (its row, without doing either).
      const vid = id('ev');
      await fx.owner(`UPDATE "Entity" SET version = version + 1 WHERE id = $1`, [pr]);
      await fx.owner(`INSERT INTO "EntityVersion" (id, "entityId", version, "changeKind", actor, "validFrom") SELECT $2, id, version, $3, 'test', now() FROM "Entity" WHERE id = $1`, [pr, vid, kind]);
      await run();
      expect(reviewJobs(g.id).map((j) => j.data.triggerEventId), kind).toEqual([`version:${vid}`]);
    }
  });

  it('the cursor moves with the send: a send that fails leaves it, and the change is seen again', async () => {
    const g = await watching(105);
    await fx.pullRequest(105, 'merged');
    const failing = new FakeBus();
    failing.boss.send = (async () => {
      throw new Error('the bus is down');
    }) as unknown as typeof failing.boss.send;
    await expect(run(new Date(), failing)).rejects.toThrow('the bus is down');
    expect(await cursor(g.id, g.pr)).toBe(1);
    // The next tick, with the bus back, sees the same version.
    await run();
    expect(reviewJobs(g.id)).toHaveLength(1);
    expect(await cursor(g.id, g.pr)).toBe(2);
  });

  it('a version that commits late is still seen: the cursor is a version number, not a time', async () => {
    const g = await watching(111);
    const late = new pg.Client(pgConfig(urls.owner));
    await late.connect();
    try {
      // A sync's transaction writes the item's next version (its recordedAt is when the transaction began), and does not commit yet.
      const vid = id('ev');
      await late.query('BEGIN');
      await late.query(`UPDATE "Entity" SET version = version + 1, state = jsonb_set(state, '{state}', '"closed"') WHERE id = $1`, [g.pr]);
      await late.query(`INSERT INTO "EntityVersion" (id, "entityId", version, "changeKind", patch, actor, "validFrom", "recordedAt") SELECT $2, id, version, 'updated', '{"state":["open","closed"]}'::jsonb, 'test', now(), now() FROM "Entity" WHERE id = $1`, [g.pr, vid]);
      // A tick runs meanwhile: it cannot see the version, and leaves the cursor where it was.
      await sleep(30);
      const ticked = new Date();
      expect(await run(ticked)).toMatchObject({ triggered: 0 });
      expect(await cursor(g.id, g.pr)).toBe(1);
      await late.query('COMMIT');
      // The next tick sees it, although it was recorded before the tick that missed it (a time cursor would have skipped it).
      const v = await db.entityVersion.findUniqueOrThrow({ where: { id: vid } });
      expect(v.recordedAt.getTime()).toBeLessThan(ticked.getTime());
      expect(await run()).toMatchObject({ triggered: 1 });
      expect(reviewJobs(g.id).map((j) => j.data.triggerEventId)).toEqual([`version:${vid}`]);
      expect(await cursor(g.id, g.pr)).toBe(2);
    } finally {
      await late.end();
    }
  });

  it('a step due within 48 hours sets a review off once; a new plan version or a moved due time is a new trigger', async () => {
    const dueAt = new Date(Date.now() + 30 * 3_600_000).toISOString();
    const far = new Date(Date.now() + 20 * DAY).toISOString();
    const g = await fx.activeGoal({ successCriteria: [fx.crit('c1', { kind: 'steps', keys: ['s1'] })], plan: { ops: [fx.step('s1', { dueAt }), fx.step('s2', { dueAt: far })] } });
    await settle();
    bus.clear();
    // The goal's first review ran after its plan went active, with s1 already within 48 hours: it answered s1's trigger.
    await run();
    expect(reviewJobs(g.id)).toEqual([]);
    // A new plan version (Will adds a step): the plan changed with a step due soon, so one review, named by step, time and version.
    await fx.fileSignRun('plan.change', { goalId: g.id, goalTitle: g.title, ops: [fx.step('s3')] });
    expect((await db.plan.findFirstOrThrow({ where: { goalId: g.id, status: 'active' } })).version).toBe(2);
    await run();
    expect(reviewJobs(g.id).map((j) => [j.data.kind, j.data.triggerEventId, j.options.startAfter])).toEqual([['triggered', `step:s1@${Date.parse(dueAt)}.v2`, COALESCE_SECONDS]]);
    expect(ReviewJob.safeParse(reviewJobs(g.id)[0]!.data).success).toBe(true);
    expect((await runReview({ db, bus, tz: 'UTC' }, ReviewJob.parse(bus.take('goals.review')!.data))).outcome).toBe('reviewed');
    bus.clear();
    await run();
    expect(reviewJobs(g.id)).toEqual([]);
    // Its due time moves (still within 48 hours), in a new version: a new trigger, and its review is never refused as a duplicate.
    const moved = new Date(Date.now() + 40 * 3_600_000).toISOString();
    await fx.fileSignRun('plan.change', { goalId: g.id, goalTitle: g.title, ops: [{ op: 'set', key: 's1', from: { title: `${CANARY} step s1`, dueAt }, to: { dueAt: moved } }] });
    await run();
    expect(reviewJobs(g.id).map((j) => j.data.triggerEventId)).toEqual([`step:s1@${Date.parse(moved)}.v3`]);
    expect((await runReview({ db, bus, tz: 'UTC' }, ReviewJob.parse(bus.take('goals.review')!.data))).outcome).toBe('reviewed');
    // A done step sets nothing off.
    await fx.fileSignRun('plan.change', { goalId: g.id, goalTitle: g.title, ops: [fx.step('s4')] });
    const plan = await db.plan.findFirstOrThrow({ where: { goalId: g.id, status: 'active' } });
    await db.planStep.update({ where: { planId_key: { planId: plan.id, key: 's1' } }, data: { status: 'done', doneAt: new Date() } });
    bus.clear();
    await run();
    expect(reviewJobs(g.id)).toEqual([]);
  });

  it('review finding 3: three steps that come within 48 hours together are ONE review, not one each', async () => {
    // Due 48 hours and 3 seconds from now: not within 48 hours yet, and they will be in a moment (the real clock: a review's row is written at the database's own time).
    const soon = new Date(Date.now() + 48 * 3_600_000 + 3_000).toISOString();
    const g = await fx.activeGoal({ plan: { ops: [fx.step('s1', { dueAt: soon }), fx.step('s2', { dueAt: soon }), fx.step('s3', { dueAt: soon }), fx.step('s4', { dueAt: new Date(Date.now() + 60 * 3_600_000).toISOString() })] } });
    await settle();
    bus.clear();
    await run();
    expect(reviewJobs(g.id)).toEqual([]);
    await sleep(Math.max(0, Date.parse(soon) - 48 * 3_600_000 - Date.now()) + 300);
    const forecasts = await db.prediction.count({ where: { goalId: g.id } });
    const sent: string[] = [];
    // Six ticks: the first sends one job for the three steps; after its review, no tick sends another.
    for (let i = 0; i < 6; i++) {
      bus.clear();
      await run();
      const jobs = reviewJobs(g.id);
      for (const j of jobs) {
        sent.push(String(j.data.triggerEventId));
        expect((await runReview({ db, bus, tz: 'UTC' }, ReviewJob.parse(j.data))).outcome).toBe('reviewed');
      }
    }
    expect(sent).toEqual([`step:s1@${Date.parse(soon)}.v1`]);
    expect(await db.goalReview.count({ where: { goalId: g.id, kind: 'triggered' } })).toBe(1);
    expect(await db.prediction.count({ where: { goalId: g.id } })).toBe(forecasts + 1);
  });

  it('review finding 3: a change, a false forecast and a due step together are one review', async () => {
    const dueAt = new Date(Date.now() + 30 * 3_600_000).toISOString();
    const pr = await fx.pullRequest(121, 'open');
    const g = await fx.activeGoal({
      successCriteria: [fx.crit('c1', { kind: 'item', entityId: pr, key: 'state', value: 'merged' })], links: [{ entityId: pr, role: 'target', watchPaths: ['state'] }],
      plan: { ops: [fx.step('s1')] },
    });
    await settle();
    const p = await emitPrediction(db, {
      template: { id: 'closed_by', params: { entity: `pull_request#${pr.slice(-6)}` } }, kind: 'binary', probability: 0.6, method: 'rule', domain: 'repos', type: 'event_occurs',
      evidence: [], resolutionCriteria: 'Synthetic test criteria.', resolver: 'auto_world', resolveBy: new Date(Date.now() + DAY).toISOString(), subjectEntityId: pr, tainted: false,
    }, 'runtime:test');
    // All three at once: the item merges, the forecast about it comes false, and Will's plan change gives s1 a due time 30 hours out.
    await fx.pullRequest(121, 'merged');
    await fx.owner(`INSERT INTO "Resolution" (id, "predictionId", outcome, "eventAt", "resolvedBy") VALUES ($1, $2, false, now(), 'auto_world')`, [id('rs'), p.id]);
    await fx.fileSignRun('plan.change', { goalId: g.id, goalTitle: g.title, ops: [{ op: 'set', key: 's1', from: { title: `${CANARY} step s1`, dueAt: null }, to: { dueAt } }] });
    bus.clear();
    const before = await db.goalReview.count({ where: { goalId: g.id } });
    for (let i = 0; i < 5; i++) {
      await run();
      // A worker takes every job that waits; this goal's review runs.
      for (let job = bus.take('goals.review'); job; job = bus.take('goals.review')) {
        if (job.data.goalId === g.id) expect((await runReview({ db, bus, tz: 'UTC' }, ReviewJob.parse(job.data))).outcome).toBe('reviewed');
      }
    }
    expect(reviewJobs(g.id).map((j) => String(j.data.triggerEventId).split(':')[0])).toEqual(['version']);
    expect(await db.goalReview.count({ where: { goalId: g.id } })).toBe(before + 1);
  });

  it('a result written late about something long past sets no review off: the first check of old predictions is news to nobody', async () => {
    const g = await watching(141);
    // Two predictions about the goal's item, made and due long ago, both settled just now (as the first sweep after
    // predictions are turned on settles them): one about 20 days ago, one about 3 days ago.
    const settle = async (dueAgo: number) => {
      const p = id('pd');
      await pastRows(urls, 'Prediction', ['Prediction_insert_check'], (q) => q(
        `INSERT INTO "Prediction" (id, claim, kind, probability, method, domain, type, evidence, "resolutionCriteria", resolver, "resolveBy", "createdAt", "createdBy", tainted, "subjectEntityId")
         VALUES ($1, 'a synthetic claim', 'binary', 0.6, 'rule', 'repos', 'event_occurs', '[]'::jsonb, 'synthetic criteria', 'auto_world', $2, $3, 'test', false, $4)`,
        [p, new Date(Date.now() - dueAgo), new Date(Date.now() - dueAgo - DAY), g.pr]));
      const rid = id('rs');
      await fx.owner(`INSERT INTO "Resolution" (id, "predictionId", outcome, "eventAt", "resolvedBy") VALUES ($1, $2, false, $3, 'auto_world')`, [rid, p, new Date(Date.now() - dueAgo)]);
      return rid;
    };
    await settle(20 * DAY);
    await run();
    expect(reviewJobs(g.id)).toEqual([]);
    // One about last week is still news.
    const recent = await settle(3 * DAY);
    await run();
    expect(reviewJobs(g.id).map((j) => j.data.triggerEventId)).toEqual([`resolution:${recent}`]);
    // Its review runs, so nothing of this goal's is left waiting for the tests below.
    await runReview({ db, bus, tz: 'UTC' }, ReviewJob.parse(reviewJobs(g.id)[0]!.data));
    bus.clear();
    await run();
    expect(reviewJobs(g.id)).toEqual([]);
  });

  it('a forecast that came false, about the goal’s item, sets a review off once', async () => {
    const g = await watching(106);
    const p = await emitPrediction(db, {
      template: { id: 'closed_by', params: { entity: `pull_request#${g.pr.slice(-6)}` } }, kind: 'binary', probability: 0.6, method: 'rule', domain: 'repos', type: 'event_occurs',
      evidence: [], resolutionCriteria: 'Synthetic test criteria.', resolver: 'auto_world', resolveBy: new Date(Date.now() + DAY).toISOString(), subjectEntityId: g.pr, tainted: false,
    }, 'runtime:test');
    await run();
    expect(reviewJobs(g.id)).toEqual([]);
    const rid = id('rs');
    await fx.owner(`INSERT INTO "Resolution" (id, "predictionId", outcome, "eventAt", "resolvedBy") VALUES ($1, $2, false, now(), 'auto_world')`, [rid, p.id]);
    await run();
    expect(reviewJobs(g.id).map((j) => j.data.triggerEventId)).toEqual([`resolution:${rid}`]);
    await runReview({ db, bus, tz: 'UTC' }, ReviewJob.parse(bus.take('goals.review')!.data));
    bus.clear();
    await run();
    expect(reviewJobs(g.id)).toEqual([]);
    // Two more come false before the next tick: one review answers both.
    const again = [id('rs'), id('rs')];
    for (const r of again) {
      const more = await emitPrediction(db, {
        template: { id: 'closed_by', params: { entity: `pull_request#${g.pr.slice(-6)}` } }, kind: 'binary', probability: 0.5 + again.indexOf(r) / 10, method: 'rule', domain: 'repos', type: 'event_occurs',
        evidence: [], resolutionCriteria: 'Synthetic test criteria.', resolver: 'auto_world', resolveBy: new Date(Date.now() + (2 + again.indexOf(r)) * DAY).toISOString(), subjectEntityId: g.pr, tainted: false,
      }, 'runtime:test');
      await fx.owner(`INSERT INTO "Resolution" (id, "predictionId", outcome, "eventAt", "resolvedBy") VALUES ($1, $2, false, now(), 'auto_world')`, [r, more.id]);
    }
    await run();
    expect(reviewJobs(g.id)).toHaveLength(1);
    await runReview({ db, bus, tz: 'UTC' }, ReviewJob.parse(bus.take('goals.review')!.data));
    bus.clear();
    await run();
    expect(reviewJobs(g.id)).toEqual([]);
    // A forecast that came true sets nothing off.
    const other = await watching(107);
    const q = await emitPrediction(db, {
      template: { id: 'closed_by', params: { entity: `pull_request#${other.pr.slice(-6)}` } }, kind: 'binary', probability: 0.6, method: 'rule', domain: 'repos', type: 'event_occurs',
      evidence: [], resolutionCriteria: 'Synthetic test criteria.', resolver: 'auto_world', resolveBy: new Date(Date.now() + DAY).toISOString(), subjectEntityId: other.pr, tainted: false,
    }, 'runtime:test');
    await fx.owner(`INSERT INTO "Resolution" (id, "predictionId", outcome, "eventAt", "resolvedBy") VALUES ($1, $2, true, now(), 'auto_world')`, [id('rs'), q.id]);
    await run();
    expect(reviewJobs(other.id)).toEqual([]);
  });

  it('review finding 3: a goal’s own onTrack forecast coming false sets nothing off (a goal past its date would review itself every day)', async () => {
    // Every review writes the goal's forecast. Past the finish date each is for a day ahead, and comes false when that day does.
    const pr = await fx.pullRequest(122, 'open');
    const g = await fx.activeGoal({ links: [{ entityId: pr, role: 'watch', watchPaths: ['state'] }] });
    await settle();
    const own = await db.prediction.findFirstOrThrow({ where: { goalId: g.id, status: 'open' } });
    expect(own).toMatchObject({ domain: 'goals', createdBy: 'runtime:goals', subjectEntityId: null });
    await fx.owner(`INSERT INTO "Resolution" (id, "predictionId", outcome, "eventAt", "resolvedBy") VALUES ($1, $2, false, now(), 'auto_world')`, [id('rs'), own.id]);
    bus.clear();
    await run();
    await run();
    expect(reviewJobs(g.id)).toEqual([]);
    expect(await db.goalReview.count({ where: { goalId: g.id } })).toBe(1);
  });

  it('review findings 7 and R3: a review’s wait is counted in reviewing time, from the rows the health job keeps', async () => {
    const t0 = new Date(Date.now() - 4 * DAY);
    const at = (min: number) => new Date(t0.getTime() + min * MIN);
    const every5 = (from: number, to: number) => Array.from({ length: Math.floor((to - from) / 5) + 1 }, (_, i) => at(from + 5 * i));
    // Checks 5 minutes apart are one stretch: a review due at its start has waited its whole length, and up to now when the last check is recent.
    expect(reviewingMs(every5(0, 60), at(0), at(60))).toBe(60 * MIN);
    expect(reviewingMs(every5(0, 60), at(0), at(63))).toBe(63 * MIN);
    expect(reviewingMs(every5(0, 60), at(20), at(60))).toBe(40 * MIN);
    expect(reviewingMs(every5(0, 60), at(-300), at(60))).toBe(60 * MIN);
    // No check at all (reviews just turned on), or none since it came due: it has waited nothing.
    expect(reviewingMs([], at(-300), at(60))).toBe(0);
    expect(reviewingMs(every5(0, 60), at(61), at(62))).toBe(1 * MIN);
    expect(reviewingMs(every5(0, 60), at(0), at(60 + 13))).toBe(60 * MIN);
    // A gap over 12 minutes (the Mac asleep, the runtime down) counts for nothing; a deploy's few minutes do.
    expect(EVIDENCE_GAP_MS).toBe(12 * MIN);
    const night = [...every5(0, 60), ...every5(600, 660)];
    expect(reviewingMs(night, at(0), at(660))).toBe(120 * MIN);
    expect(reviewingMs([...every5(0, 30), ...every5(38, 60)], at(0), at(60))).toBe(60 * MIN);
    // A day of reviewing spread over three nights is a day: this is what lets a review stuck for days show as down.
    const days = [0, 1, 2].flatMap((d) => every5(d * 1440, d * 1440 + 600));
    expect(reviewingMs(days, at(0), at(2 * 1440 + 600))).toBe(30 * 60 * MIN);

    // The log is what the health job wrote for Goal Reviews with reviews on: not `disabled`, and not stopped by a rule.
    await db.healthCheck.deleteMany({ where: { component: 'goals' } });
    await db.healthCheck.createMany({ data: [
      ...every5(0, 30).map((t) => ({ component: 'goals', status: 'ok', at: t })),
      ...every5(35, 60).map((t) => ({ component: 'goals', status: 'disabled', at: t })),
      ...every5(65, 90).map((t) => ({ component: 'goals', status: 'degraded', detail: REVIEWS_STOPPED, at: t })),
      ...every5(95, 120).map((t) => ({ component: 'goals', status: 'degraded', detail: 'A goal’s review is over an hour late.', at: t })),
      { component: 'backup', status: 'ok', at: at(45) }, { component: 'goals.deferral', status: 'degraded', at: at(50) },
    ] });
    try {
      const log = await reviewingLog(db, at(0), at(120));
      expect(log.map((d) => (d.getTime() - t0.getTime()) / MIN)).toEqual([0, 5, 10, 15, 20, 25, 30, 95, 100, 105, 110, 115, 120]);
      expect(reviewingMs(log, at(0), at(120))).toBe(55 * MIN);
      // One read for several due times, and none when nothing has been due for an hour.
      expect(await waitedMs(db, [at(0), null, at(100), at(119)], at(120))).toEqual([55 * MIN, 0, 0, 0]);
      expect(await waitedMs(db, [at(0), at(20)], at(200))).toEqual([55 * MIN, 35 * MIN]);
      // Nothing here is this process's memory: a runtime that just started reads the same rows, and so the same wait.
      const other = createDb(urls.app);
      try {
        expect(await waitedMs(other, [at(0)], at(120))).toEqual([55 * MIN]);
      } finally {
        await other.$disconnect();
      }
    } finally {
      await db.healthCheck.deleteMany({ where: { component: { in: ['goals', 'goals.deferral', 'backup'] }, at: { lt: new Date(Date.now() - DAY) } } });
    }
  });

  it('past a goal’s 12 a day, a change is left to the next scheduled review: the cursor moves and nothing is sent', async () => {
    const g = await watching(108);
    for (let i = 0; i < 12; i++) await runReview({ db, bus: new FakeBus(), tz: 'UTC' }, { goalId: g.id, kind: 'requested' });
    await fx.pullRequest(108, 'merged');
    expect(await run()).toMatchObject({ triggered: 0, capped: 1 });
    expect(reviewJobs(g.id)).toEqual([]);
    expect(await cursor(g.id, g.pr)).toBe(2);
    // The next scheduled review, never capped, sees the merge.
    const now = new Date(Date.now() + 8 * DAY);
    await run(now);
    const job = reviewJobs(g.id).find((j) => j.data.kind === 'scheduled')!;
    expect(job).toBeTruthy();
  });

  it('lock order: the tick takes the goal FOR UPDATE before it reads a link or moves a cursor', async () => {
    const g = await watching(109);
    await fx.pullRequest(109, 'merged');
    const holder = new pg.Client(pgConfig(urls.owner));
    const prober = new pg.Client(pgConfig(urls.owner));
    await holder.connect();
    await prober.connect();
    try {
      // Someone else holds the goal (a card being carried out): the tick leaves it for the next one, untouched.
      await holder.query('BEGIN');
      await holder.query(`SELECT id FROM "Goal" WHERE id = $1 FOR UPDATE`, [g.id]);
      expect(await run()).toMatchObject({ triggered: 0, busy: 1 });
      expect(await cursor(g.id, g.pr)).toBe(1);
      expect(reviewJobs(g.id)).toEqual([]);
      await holder.query('COMMIT');

      // While the tick moves the cursor and sends, it holds the goal: no one else can take it.
      const slow = new FakeBus();
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let sending = false;
      const send = slow.boss.send.bind(slow.boss);
      slow.boss.send = (async (...a: Parameters<typeof send>) => {
        sending = true;
        await gate;
        return send(...a);
      }) as typeof slow.boss.send;
      const ticking = run(new Date(), slow);
      while (!sending) await sleep(20);
      const refused = await pgError(prober.query(`SELECT id FROM "Goal" WHERE id = $1 FOR UPDATE NOWAIT`, [g.id]));
      expect(refused.code).toBe('55P03');
      // Its cursor write is not visible yet: it commits with the send.
      expect(await cursor(g.id, g.pr)).toBe(1);
      release();
      expect(await ticking).toMatchObject({ triggered: 1 });
      expect(await cursor(g.id, g.pr)).toBe(2);
      await prober.query(`SELECT id FROM "Goal" WHERE id = $1 FOR UPDATE NOWAIT`, [g.id]);
    } finally {
      await holder.end();
      await prober.end();
    }
  });

  it('job data is ids and times only, and nothing a tick wrote holds a goal’s words', async () => {
    await watching(110);
    await fx.pullRequest(110, 'merged');
    await run();
    for (const j of bus.sent) expect(Object.keys(j.data).every((k) => ['goalId', 'kind', 'triggerEventId', 'dueAt'].includes(k))).toBe(true);
    expect(await fx.everythingButGoals(bus)).not.toContain('CANARY');
  });

  it('with the planner off, nothing is scheduled; a FORBIDDEN rule sends nothing', async () => {
    const ctx = (planner: string | undefined) => ({ db, bus, sources: [], log: () => {}, config: loadConfig({ DATABASE_URL: urls.app, HOME: '/tmp', FLINT_TZ: 'UTC', ...(planner !== undefined ? { FLINT_PLANNER: planner } : {}) }) }) as unknown as JobContext;
    for (const off of [undefined, '', 'off', ' Off ', 'true', '1']) expect(goalJobs(ctx(off)), String(off)).toEqual([]);
    expect(goalJobs(ctx(' ON ')).map((s) => [s.queue, s.cron])).toEqual([['goals.tick', '*/2 * * * *'], ['goals.review', undefined], ['goals.plan', undefined]]);

    const g = await fx.activeGoal();
    await fx.policy('goal.review.local', 'forbidden');
    bus.clear();
    expect(await run()).toEqual({ due: 0, triggered: 0, capped: 0, busy: 0, forbidden: true });
    expect(reviewJobs(g.id)).toEqual([]);
  });
});
