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
 *  - A step due within 48 hours sets a review off once per step and due time,
 *    across plan versions. A forecast that came false does once.
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
import { COALESCE_SECONDS, tick } from '../../src/goals/tick';
import { CANARY, DAY, FakeBus, MIN, goalFixture, type GoalFixture } from './fixture';

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
    const TICK_MS = 2 * MIN;

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

  it('a step due within 48 hours sets a review off once per step and due time, across plan versions', async () => {
    const dueAt = new Date(Date.now() + 30 * 3_600_000).toISOString();
    const far = new Date(Date.now() + 20 * DAY).toISOString();
    const g = await fx.activeGoal({ successCriteria: [fx.crit('c1', { kind: 'steps', keys: ['s1'] })], plan: { ops: [fx.step('s1', { dueAt }), fx.step('s2', { dueAt: far })] } });
    await settle();
    bus.clear();
    await run();
    const trigger = `step:s1@${Date.parse(dueAt)}`;
    expect(reviewJobs(g.id).map((j) => [j.data.kind, j.data.triggerEventId, j.options.startAfter])).toEqual([['triggered', trigger, COALESCE_SECONDS]]);
    await runReview({ db, bus, tz: 'UTC' }, ReviewJob.parse(bus.take('goals.review')!.data));
    bus.clear();
    await run();
    expect(reviewJobs(g.id)).toEqual([]);
    // A new plan version copies the step: the same step and due time is the same trigger.
    await fx.fileSignRun('plan.change', { goalId: g.id, goalTitle: g.title, ops: [fx.step('s3')] });
    expect((await db.plan.findFirstOrThrow({ where: { goalId: g.id, status: 'active' } })).version).toBe(2);
    await run();
    expect(reviewJobs(g.id)).toEqual([]);
    // Its due time moves (still within 48 hours): a new trigger. A done step sets nothing off.
    const moved = new Date(Date.now() + 40 * 3_600_000).toISOString();
    await fx.fileSignRun('plan.change', { goalId: g.id, goalTitle: g.title, ops: [{ op: 'set', key: 's1', from: { title: `${CANARY} step s1`, dueAt }, to: { dueAt: moved } }] });
    await run();
    expect(reviewJobs(g.id).map((j) => j.data.triggerEventId)).toEqual([`step:s1@${Date.parse(moved)}`]);
    await runReview({ db, bus, tz: 'UTC' }, ReviewJob.parse(bus.take('goals.review')!.data));
    const plan = await db.plan.findFirstOrThrow({ where: { goalId: g.id, status: 'active' } });
    await db.planStep.update({ where: { planId_key: { planId: plan.id, key: 's1' } }, data: { status: 'done', doneAt: new Date() } });
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
