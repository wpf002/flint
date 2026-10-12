/**
 * A goal's review, stage 1, on flint_test (P3 part 3; exit criteria 2 and 6).
 *
 *  - Every review, of every kind, writes exactly one goals prediction with the
 *    goal's id, superseding the open one; its claim names the goal by ref only;
 *    it is counted under its own counter and never claims the ledger's cap.
 *  - A scheduled review answers one due time and moves the goal to its
 *    cadence's next 09:00 local; a second job for the same time does nothing. A
 *    triggered review runs once per trigger and never moves the next review.
 *  - Triggered and requested reviews stop at 12 a day per goal; scheduled ones
 *    are never capped.
 *  - A finish date already past still gets a forecast that resolves ahead.
 *  - A merged pull request, archived by its sync, meets "Is Merged".
 *  - Lock order: the review takes the goal FOR UPDATE before it reads or writes
 *    a plan, a step or a review, at READ COMMITTED; held out, it waits and
 *    holds nothing.
 *  - In the trial week a review is marked shadow; promoted, it is not; a
 *    FORBIDDEN rule runs nothing.
 *  - No goal text in a job, an audit entry, a forecast or a review's summary.
 * Synthetic text only.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { ON_TRACK_COUNTER, goalCodeOf, likelihoodOf, localDay, localWallTime, reviewCounter } from '@flint/policy';
import { phrase } from '../../src/templates/escalations';
import { NO_DB, freshDb, pgConfig, type TestUrls } from '../db';
import { createDb, type Db } from '../../src/db';
import { Invalid, emitPrediction, EmitPredictionIn } from '../../src/ledger/emit';
import { buildDigest } from '../../src/digest';
import { onTrackProbability, onTrackResolveBy } from '../../src/goals/ontrack';
import { ReviewJob, reviewSummary, runReview } from '../../src/goals/review';
import { requestReview } from '../../src/goals/service';
import { DAY, FakeBus, MIN, goalFixture, type GoalFixture } from './fixture';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('the onTrack rule', () => {
  const t0 = new Date('2026-10-12T15:00:00Z');
  const at = (days: number) => new Date(t0.getTime() + days * DAY);
  it('is the checks met against the time gone, less a little per overdue step, never certain', () => {
    const f = { activatedAt: at(-10), horizonAt: at(10), now: t0 };
    // Half the time gone: half the checks met is even.
    expect(onTrackProbability({ ...f, progress: 0.5, overdueSteps: 0 })).toBe(0.5);
    expect(onTrackProbability({ ...f, progress: 1, overdueSteps: 0 })).toBe(0.9);
    expect(onTrackProbability({ ...f, progress: 0, overdueSteps: 0 })).toBe(0.1);
    expect(onTrackProbability({ ...f, progress: 0.5, overdueSteps: 2 })).toBe(0.4);
    // Overdue steps count at most 3; the result stays within 5% and 95%.
    expect(onTrackProbability({ ...f, progress: 0, overdueSteps: 9 })).toBe(0.05);
    expect(onTrackProbability({ activatedAt: at(-1), horizonAt: at(100), now: t0, progress: 1, overdueSteps: 0 })).toBe(0.95);
    // Without a finish date no time is gone: progress alone.
    expect(onTrackProbability({ activatedAt: at(-300), horizonAt: null, now: t0, progress: 0.25, overdueSteps: 0 })).toBe(0.7);
    // The same facts, the same number: a rule, not a model.
    expect(onTrackProbability({ ...f, progress: 1 / 3, overdueSteps: 1 })).toBe(onTrackProbability({ ...f, progress: 1 / 3, overdueSteps: 1 }));
  });
  it('resolves by the finish date, at most 179 days out; a past one a day out or at the next review; none, 90 days', () => {
    expect(onTrackResolveBy(at(30), at(7), t0)).toEqual(at(30));
    expect(onTrackResolveBy(at(400), at(7), t0)).toEqual(at(179));
    expect(onTrackResolveBy(null, at(7), t0)).toEqual(at(90));
    expect(onTrackResolveBy(at(-3), at(7), t0)).toEqual(at(7));
    expect(onTrackResolveBy(at(-3), at(0.2), t0)).toEqual(at(1));
    expect(onTrackResolveBy(new Date(t0.getTime() + 30 * MIN), null, t0)).toEqual(at(1));
  });
  it('the goal template and a goal’s id go together, and only the runtime’s own writer may use them', async () => {
    const noDb = {} as Db;
    const p = { kind: 'binary' as const, probability: 0.5, method: 'rule' as const, domain: 'goals' as const, type: 'deadline_met' as const, evidence: [], resolutionCriteria: 'x', resolver: 'auto_world' as const, resolveBy: new Date(Date.now() + DAY).toISOString(), tainted: false };
    const template = { id: 'goal_on_track' as const, params: { goal: 'goal#abc123', by: '2026-12-01' } };
    // Refused before anything is written: the template without a goal, and a goal with any other claim.
    await expect(emitPrediction(noDb, { ...p, template }, 'runtime:goals')).rejects.toBeInstanceOf(Invalid);
    await expect(emitPrediction(noDb, { ...p, claim: 'a goal is done' }, 'runtime:goals', new Date(), { goalId: 'gotestgoal0001' })).rejects.toBeInstanceOf(Invalid);
    await expect(emitPrediction(noDb, { ...p, template: { id: 'goal_on_track', params: { goal: 'Will’s goal title', by: '2026-12-01' } } }, 'runtime:goals', new Date(), { goalId: 'gotestgoal0001' })).rejects.toBeInstanceOf(Invalid);
    // The HTTP body's contract has neither.
    expect(EmitPredictionIn.safeParse({ ...p, template }).success).toBe(false);
    expect(EmitPredictionIn.safeParse({ ...p, claim: 'x', goalId: 'gotestgoal0001' }).success).toBe(false);
    expect(EmitPredictionIn.safeParse({ ...p, template: { id: 'closed_by', params: { entity: 'issue#abc123' } } }).success).toBe(true);
  });

  it('the panel’s word for a forecast is the one the ledger’s phrase uses for the same number', () => {
    for (let i = 0; i <= 100; i++) {
      const p = i / 100;
      expect(phrase(p, undefined, 'UTC'), String(p)).toBe(`${likelihoodOf(p).replace(/_/g, ' ')}, around ${i}%`);
    }
  });

  it('a summary is sentences made from counts', () => {
    // The checks as the panel says them: the verb follows the count.
    expect(reviewSummary({ met: 2, total: 3, unknown: 0, overdue: 0, dueSoon: 1 })).toBe('2 of 3 checks are met. 1 step is due this week.');
    expect(reviewSummary({ met: 1, total: 3, unknown: 1, overdue: 1, dueSoon: 2 })).toBe('1 of 3 checks is met. Flint can’t tell about 1 of them right now. 1 step is overdue. 2 steps are due this week.');
    expect(reviewSummary({ met: 3, total: 3, unknown: 0, overdue: 0, dueSoon: 0 })).toBe('All of its checks are met.');
    expect(reviewSummary({ met: 1, total: 1, unknown: 0, overdue: 0, dueSoon: 0 })).toBe('Its check is met.');
    expect(reviewSummary({ met: 0, total: 1, unknown: 0, overdue: 0, dueSoon: 0 })).toBe('Its check isn’t met yet.');
    expect(reviewSummary({ met: 0, total: 1, unknown: 1, overdue: 2, dueSoon: 0 })).toBe('Flint can’t tell whether its check is met right now. 2 steps are overdue.');
    for (const c of [{ met: 0, total: 2, unknown: 2, overdue: 3, dueSoon: 3 }, { met: 0, total: 1, unknown: 0, overdue: 0, dueSoon: 0 }]) {
      for (const sentence of reviewSummary(c).match(/[^.]+\./g)!) expect(sentence.trim()).toMatch(/^[A-Z0-9].*\.$/);
    }
  });
  it('a review job is ids and times only, strictly', () => {
    expect(ReviewJob.safeParse({ goalId: 'gotestgoal0001', kind: 'requested' }).success).toBe(true);
    expect(ReviewJob.safeParse({ goalId: 'gotestgoal0001', kind: 'scheduled', dueAt: '2026-10-12T14:00:00.000Z' }).success).toBe(true);
    expect(ReviewJob.safeParse({ goalId: 'gotestgoal0001', kind: 'scheduled' }).success).toBe(false);
    expect(ReviewJob.safeParse({ goalId: 'gotestgoal0001', kind: 'triggered' }).success).toBe(false);
    expect(ReviewJob.safeParse({ goalId: 'gotestgoal0001', kind: 'triggered', triggerEventId: 'A goal’s words' }).success).toBe(false);
    expect(ReviewJob.safeParse({ goalId: 'gotestgoal0001', kind: 'requested', title: 'x' }).success).toBe(false);
  });
});

describe.skipIf(NO_DB)('a goal’s review on flint_test', () => {
  let urls: TestUrls;
  let db: Db;
  let fx: GoalFixture;
  const bus = new FakeBus();
  const review = (job: Parameters<typeof runReview>[1], now = new Date(), tz = 'UTC') => runReview({ db, bus, tz, now: () => now }, job);
  const scheduled = async (goalId: string, now = new Date(), tz = 'UTC') => {
    const g = await db.goal.findUniqueOrThrow({ where: { id: goalId } });
    return review({ goalId, kind: 'scheduled', dueAt: g.nextReviewAt!.toISOString() }, now, tz);
  };
  const forecasts = (goalId: string) => db.prediction.findMany({ where: { goalId }, orderBy: { createdAt: 'asc' } });

  beforeAll(async () => {
    urls = await freshDb();
    db = createDb(urls.app);
    fx = await goalFixture(urls, db);
  });
  afterAll(async () => db?.$disconnect());

  it('every kind of review writes exactly one forecast of its goal, superseding the open one, in the trial week', async () => {
    const g = await fx.activeGoal();
    const first = await scheduled(g.id);
    expect(first).toMatchObject({ outcome: 'reviewed', shadow: true });
    const r1 = await db.goalReview.findFirstOrThrow({ where: { goalId: g.id } });
    expect(r1).toMatchObject({ kind: 'scheduled', shadow: true, reviewer: 'flint:rule', planner: null, diff: null, proposalId: null, progressBefore: 0, progressAfter: 0, summary: 'Its check isn’t met yet.' });
    expect(r1.criteria).toEqual([{ id: 'c1', state: 'unmet' }]);
    let ps = await forecasts(g.id);
    expect(ps).toHaveLength(1);
    expect(ps[0]).toMatchObject({ id: r1.predictionId, status: 'open', domain: 'goals', type: 'deadline_met', method: 'rule', kind: 'binary', resolver: 'auto_world', createdBy: 'runtime:goals', tainted: false });
    // The claim names the goal by ref only, with the finish date's local day; so do its criteria.
    expect(ps[0]!.claim).toBe(`goal#${g.id.slice(-6)} meets its success criteria by ${localDay('UTC', ps[0]!.resolveBy)}`);
    expect(ps[0]!.resolutionCriteria).toContain(`goal#${g.id.slice(-6)}`);
    expect(ps[0]!.evidence).toEqual([{ kind: 'rule', ref: 'goals.on_track.rule.v1' }]);
    expect(ps[0]!.resolverSpec).toEqual({ goalId: g.id, rule: 'goal_done_by' });
    expect(ps[0]!.probability).toBeGreaterThanOrEqual(0.05);
    expect(ps[0]!.probability).toBeLessThanOrEqual(0.95);

    // Will marks his check: a triggered review sees it, and its forecast supersedes the first.
    await db.goal.update({ where: { id: g.id }, data: { criteriaMet: { c1: '2026-10-12' } } });
    expect(await review({ goalId: g.id, kind: 'triggered', triggerEventId: 'version:evtest0001' })).toMatchObject({ outcome: 'reviewed' });
    expect(await review({ goalId: g.id, kind: 'requested' })).toMatchObject({ outcome: 'reviewed' });
    ps = await forecasts(g.id);
    expect(ps.map((p) => p.status)).toEqual(['superseded', 'superseded', 'open']);
    expect(ps[1]!.supersedesId).toBe(ps[0]!.id);
    expect(ps[2]!.supersedesId).toBe(ps[1]!.id);
    expect(ps[2]!.probability).toBeGreaterThan(ps[0]!.probability!);
    const reviews = await db.goalReview.findMany({ where: { goalId: g.id }, orderBy: { createdAt: 'asc' } });
    expect(reviews.map((r) => [r.kind, r.predictionId])).toEqual([['scheduled', ps[0]!.id], ['triggered', ps[1]!.id], ['requested', ps[2]!.id]]);
    expect(reviews[1]).toMatchObject({ progressBefore: 0, progressAfter: 1, summary: 'Its check is met.', triggerEventId: 'version:evtest0001' });
    expect((await db.goal.findUniqueOrThrow({ where: { id: g.id } })).progress).toBe(1);
    // One plan-stage job per review, sent with it: the goal and the review, nothing else.
    const plans = bus.of('goals.plan').filter((j) => j.data.goalId === g.id);
    expect(plans[0]).toMatchObject({ data: { goalId: g.id, reviewId: r1.id }, options: { singletonKey: g.id } });
    expect(Object.keys(plans[0]!.data).sort()).toEqual(['goalId', 'reviewId']);
    expect(plans[0]!.options.db).toBeTruthy();
  });

  it('the forecast has its own counter and never claims the ledger’s daily cap', async () => {
    const day = localDay('UTC', new Date());
    const count = async (action: string) => (await db.actionCounter.findUnique({ where: { action_day: { action, day } } }))?.count ?? 0;
    const before = { own: await count(ON_TRACK_COUNTER), ledger: await count('ledger.prediction.record') };
    const g = await fx.activeGoal();
    await scheduled(g.id);
    expect(await count(ON_TRACK_COUNTER)).toBe(before.own + 1);
    expect(await count('ledger.prediction.record')).toBe(before.ledger);
    // With the ledger's cap used up, a review still records its forecast.
    await fx.owner(`INSERT INTO "ActionCounter" (action, day, count) VALUES ('ledger.prediction.record', $1, 50) ON CONFLICT (action, day) DO UPDATE SET count = 50`, [day]);
    expect(await review({ goalId: g.id, kind: 'requested' })).toMatchObject({ outcome: 'reviewed' });
    expect(await count('ledger.prediction.record')).toBe(50);
    await fx.owner(`UPDATE "ActionCounter" SET count = $2 WHERE action = 'ledger.prediction.record' AND day = $1`, [day, before.ledger]);
  });

  it('a scheduled review moves the goal to its cadence’s next 09:00 local, once per due time; a triggered one never moves it', async () => {
    const tz = 'America/Chicago';
    const g = await fx.activeGoal({ reviewCadence: 'P1D' });
    const due = (await db.goal.findUniqueOrThrow({ where: { id: g.id } })).nextReviewAt!;
    const now = new Date();
    const job = { goalId: g.id, kind: 'scheduled' as const, dueAt: due.toISOString() };
    expect((await review(job, now, tz)).outcome).toBe('reviewed');
    const next = (await db.goal.findUniqueOrThrow({ where: { id: g.id } })).nextReviewAt!;
    // The local day after the due day, at 09:00 in Flint's zone, whatever the offset that day.
    const day = new Date(Date.parse(`${localDay(tz, due)}T00:00:00Z`) + DAY).toISOString().slice(0, 10);
    const want = localWallTime(tz, day, 9, 0);
    expect([want.toISOString(), localWallTime(tz, localDay(tz, new Date(now.getTime() + DAY)), 9, 0).toISOString()]).toContain(next.toISOString());
    expect(next.getTime()).toBeGreaterThan(now.getTime());
    expect(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hourCycle: 'h23' }).format(next)).toBe('09:00');
    const rv = await db.goalReview.findFirstOrThrow({ where: { goalId: g.id } });
    expect(rv.dueAt?.toISOString()).toBe(due.toISOString());
    // The same due time again (a second job, a retry): the goal has moved on, so it does nothing.
    expect((await review(job, now, tz)).outcome).toBe('stale');
    expect(await db.goalReview.count({ where: { goalId: g.id } })).toBe(1);
    expect(await db.prediction.count({ where: { goalId: g.id } })).toBe(1);
    // A triggered or requested review leaves the next review where it is; the same trigger twice is one review.
    expect((await review({ goalId: g.id, kind: 'triggered', triggerEventId: 'step:s1@1760000000000' }, now, tz)).outcome).toBe('reviewed');
    expect((await review({ goalId: g.id, kind: 'triggered', triggerEventId: 'step:s1@1760000000000' }, now, tz)).outcome).toBe('duplicate');
    expect((await db.goal.findUniqueOrThrow({ where: { id: g.id } })).nextReviewAt!.toISOString()).toBe(next.toISOString());
    expect(await db.goalReview.count({ where: { goalId: g.id } })).toBe(2);
  });

  it('triggered and requested reviews stop at 12 a day per goal; a scheduled review is never capped', async () => {
    const g = await fx.activeGoal();
    const other = await fx.activeGoal();
    for (let i = 0; i < 12; i++) expect((await review({ goalId: g.id, kind: i % 2 ? 'requested' : 'triggered', ...(i % 2 ? {} : { triggerEventId: `version:evcap${i}` }) })).outcome).toBe('reviewed');
    expect((await review({ goalId: g.id, kind: 'requested' })).outcome).toBe('capped');
    expect((await review({ goalId: g.id, kind: 'triggered', triggerEventId: 'version:evcap99' })).outcome).toBe('capped');
    expect(await db.goalReview.count({ where: { goalId: g.id } })).toBe(12);
    expect((await db.actionCounter.findUniqueOrThrow({ where: { action_day: { action: reviewCounter(g.id), day: localDay('UTC', new Date()) } } })).count).toBe(12);
    // The cap is the goal's own, and a scheduled review runs whatever it says.
    expect((await review({ goalId: other.id, kind: 'requested' })).outcome).toBe('reviewed');
    expect((await scheduled(g.id)).outcome).toBe('reviewed');
    expect(await db.goalReview.count({ where: { goalId: g.id } })).toBe(13);
  });

  it('a finish date already past still gets a forecast that resolves ahead', async () => {
    const g = await fx.activeGoal({ horizonAt: new Date(Date.now() + 2_500).toISOString() });
    await sleep(2_700);
    expect((await scheduled(g.id)).outcome).toBe('reviewed');
    const [p] = await forecasts(g.id);
    const goal = await db.goal.findUniqueOrThrow({ where: { id: g.id } });
    expect(goal.horizonAt!.getTime()).toBeLessThan(Date.now());
    expect(p!.resolveBy.getTime()).toBeGreaterThan(Date.now() + DAY - MIN);
    expect(p!.resolveBy.getTime()).toBeGreaterThanOrEqual(goal.nextReviewAt!.getTime());
    // All its time is gone and nothing is met: unlikely, and still never certain.
    expect(p!.probability).toBe(0.05);
  });

  it('a merged pull request, archived by its sync, meets “Is Merged”; steps are counted; nothing is said in a goal’s words', async () => {
    const pr = await fx.pullRequest(57, 'open');
    const soon = new Date(Date.now() + 2 * DAY).toISOString();
    const g = await fx.activeGoal({
      successCriteria: [fx.crit('c1', { kind: 'item', entityId: pr, key: 'state', value: 'merged' }), fx.crit('c2', { kind: 'steps', keys: ['s1', 's2'] })],
      links: [{ entityId: pr, role: 'target', watchPaths: ['state'] }],
      plan: { ops: [fx.step('s1', { dueAt: soon }), fx.step('s2')] },
    });
    await scheduled(g.id);
    expect((await db.goalReview.findFirstOrThrow({ where: { goalId: g.id }, orderBy: { createdAt: 'desc' } }))).toMatchObject({
      criteria: [{ id: 'c1', state: 'unmet' }, { id: 'c2', state: 'unmet' }], summary: '0 of 2 checks are met. 1 step is due this week.',
    });
    // GitHub archives a merged pull request: the check reads it as it stands.
    await fx.pullRequest(57, 'merged');
    expect(await db.entity.findUniqueOrThrow({ where: { id: pr } })).toMatchObject({ status: 'archived', state: { state: 'merged' } });
    await review({ goalId: g.id, kind: 'triggered', triggerEventId: `version:${(await fx.latestVersion(pr)).id}` });
    const after = await db.goalReview.findFirstOrThrow({ where: { goalId: g.id }, orderBy: { createdAt: 'desc' } });
    expect(after).toMatchObject({ criteria: [{ id: 'c1', state: 'met' }, { id: 'c2', state: 'unmet' }], progressBefore: 0, progressAfter: 0.5 });
    // Ids, counts and template sentences everywhere a review writes: never a title, a check's words or a step's.
    expect(await fx.everythingButGoals(bus)).not.toContain('CANARY');
    const audit = await db.auditEntry.findFirstOrThrow({ where: { correlationId: after.id, action: 'goal.review.local' } });
    expect(audit).toMatchObject({ actor: 'runtime:goals', context: 'autonomous', kind: 'action', outcome: 'ok', tier: 'approval', decision: 'log' });
    expect(audit.inputs).toMatchObject({ goalId: g.id, reviewId: after.id, kind: 'triggered', met: 1, total: 2, unknown: 0, shadow: true, predictionId: after.predictionId });
  });

  it('a goal that is paused, finished or gone is not reviewed', async () => {
    const g = await fx.activeGoal();
    await db.goal.update({ where: { id: g.id }, data: { status: 'paused' } });
    expect((await review({ goalId: g.id, kind: 'requested' })).outcome).toBe('gone');
    expect((await review({ goalId: 'gonosuchgoal0001', kind: 'requested' })).outcome).toBe('gone');
    expect(await db.goalReview.count({ where: { goalId: g.id } })).toBe(0);
    expect(await db.prediction.count({ where: { goalId: g.id } })).toBe(0);
  });

  it('lock order: the review takes the goal FOR UPDATE first, at READ COMMITTED, and waits for it holding nothing', async () => {
    const g = await fx.activeGoal({ successCriteria: [fx.crit('c1', { kind: 'steps', keys: ['s1'] })], plan: { ops: [fx.step('s1')] } });
    const holder = new pg.Client(pgConfig(urls.owner));
    const prober = new pg.Client(pgConfig(urls.owner));
    await holder.connect();
    await prober.connect();
    try {
      // Another writer (a card being carried out) holds the goal.
      await holder.query('BEGIN');
      await holder.query(`SELECT id FROM "Goal" WHERE id = $1 FOR UPDATE`, [g.id]);
      let settled = false;
      const seen: string[] = [];
      const running = runReview({
        db, bus, tz: 'UTC',
        afterLock: async (tx) => {
          // Inside the review, once it has the goal: its isolation level, and what it holds a lock on so far.
          seen.push((await tx.$queryRaw<Array<{ transaction_isolation: string }>>`SHOW transaction_isolation`)[0]!.transaction_isolation);
          const held = await tx.$queryRaw<Array<{ relname: string; mode: string }>>`
            SELECT c.relname, l.mode FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
            WHERE l.pid = pg_backend_pid() AND l.locktype = 'relation' AND c.relname IN ('Goal', 'Plan', 'PlanStep', 'GoalReview', 'Prediction')`;
          seen.push(held.map((h) => `${h.relname}:${h.mode}`).sort().join(','));
        },
      }, { goalId: g.id, kind: 'requested' }).finally(() => (settled = true));
      await sleep(500);
      // It is waiting on the goal, and holds nothing of the plan, its steps or the reviews: each can be locked at once.
      expect(settled).toBe(false);
      await prober.query('BEGIN');
      await prober.query(`SELECT id FROM "Plan" WHERE "goalId" = $1 AND status = 'active' FOR UPDATE NOWAIT`, [g.id]);
      await prober.query(`SELECT s.id FROM "PlanStep" s JOIN "Plan" p ON p.id = s."planId" WHERE p."goalId" = $1 FOR UPDATE OF s NOWAIT`, [g.id]);
      await prober.query(`LOCK TABLE "GoalReview" IN SHARE ROW EXCLUSIVE MODE NOWAIT`);
      await prober.query('ROLLBACK');
      expect(await db.goalReview.count({ where: { goalId: g.id } })).toBe(0);
      await holder.query('COMMIT');
      expect((await running).outcome).toBe('reviewed');
      expect(seen[0]).toBe('read committed');
      // When it first held the goal it had touched the goal's table alone.
      expect(seen[1]).toBe('Goal:RowShareLock');
    } finally {
      await holder.end();
      await prober.end();
    }
  });

  it('the digest counts the goals reviewed that day and those reviewed late, and says only the counts', async () => {
    const tomorrow = new Date(Date.now() + DAY);
    const before = (await buildDigest(db, 'UTC', tomorrow)).counts;
    const onTime = await fx.activeGoal();
    const late = await fx.activeGoal();
    const waited = await fx.activeGoal();
    const asleep = await fx.activeGoal();
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);
    /** The Goal Reviews rows the health job writes every 5 minutes while reviews are on: Flint was reviewing for the last `minutes`. */
    const reviewingFor = async (minutes: number) => {
      await db.healthCheck.deleteMany({ where: { component: 'goals' } });
      await db.healthCheck.createMany({ data: Array.from({ length: Math.floor(minutes / 5) + 1 }, (_, i) => ({ component: 'goals', status: 'ok', at: new Date(Date.now() - (minutes - 5 * i) * MIN) })) });
    };
    for (const g of [late, waited, asleep]) await db.goal.update({ where: { id: g.id }, data: { nextReviewAt: hoursAgo(2) } });
    // Review finding 7: these two were due two hours ago only because Flint was not reviewing then. Its first check has not
    // run yet (reviews were just turned on, or the Mac just woke), or reviews came on five minutes ago. It catches up at
    // once: neither is late.
    await db.healthCheck.deleteMany({ where: { component: 'goals' } });
    expect((await scheduled(asleep.id)).outcome).toBe('reviewed');
    await reviewingFor(5);
    expect((await scheduled(waited.id)).outcome).toBe('reviewed');
    // This one was due two hours ago and Flint was reviewing all that time (a job that kept dying): it runs now, late.
    await reviewingFor(180);
    expect((await scheduled(onTime.id)).outcome).toBe('reviewed');
    expect((await scheduled(late.id)).outcome).toBe('reviewed');
    const flag = async (goalId: string) => ((await db.auditEntry.findFirstOrThrow({ where: { action: 'goal.review.local', inputs: { path: ['goalId'], equals: goalId } }, orderBy: { seq: 'desc' } })).inputs as { late?: boolean }).late ?? false;
    expect([await flag(onTime.id), await flag(late.id), await flag(waited.id), await flag(asleep.id)]).toEqual([false, true, false, false]);
    // Two reviews of one goal are one goal reviewed.
    expect((await review({ goalId: onTime.id, kind: 'requested' })).outcome).toBe('reviewed');
    const d = await buildDigest(db, 'UTC', tomorrow);
    expect(d.counts.goalsReviewed).toBe(before.goalsReviewed! + 4);
    expect(d.counts.goalsLate).toBe(before.goalsLate! + 1);
    expect(d.body).toMatch(new RegExp(`Flint reviewed ${d.counts.goalsReviewed} goals yesterday, and ${d.counts.goalsLate} (was|were) late\\.`));
    expect(d.body).not.toContain('CANARY');
    expect(d.body.length).toBeLessThanOrEqual(500);
    // Today's digest is about yesterday, when nothing was reviewed: no goals sentence at all.
    expect((await buildDigest(db, 'UTC', new Date())).body).not.toContain('reviewed');
  });

  it('promoted, a review is no longer in its trial week; a FORBIDDEN rule runs nothing', async () => {
    const g = await fx.activeGoal();
    await fx.policy('goal.review.local', 'alone', 20);
    expect(await review({ goalId: g.id, kind: 'requested' })).toMatchObject({ outcome: 'reviewed', shadow: false });
    const rv = await db.goalReview.findFirstOrThrow({ where: { goalId: g.id } });
    expect(rv.shadow).toBe(false);
    expect((await db.auditEntry.findFirstOrThrow({ where: { correlationId: rv.id, action: 'goal.review.local' } }))).toMatchObject({ tier: 'alone', decision: 'act' });
    await fx.policy('goal.review.local', 'forbidden');
    const before = await db.goalReview.count();
    expect((await review({ goalId: g.id, kind: 'requested' })).outcome).toBe('forbidden');
    expect((await scheduled(g.id)).outcome).toBe('forbidden');
    expect(await db.goalReview.count()).toBe(before);
    // Review finding 4: so Review Now does not say yes. It refuses with a sentence, sends no job and audits no request.
    bus.clear();
    const asked = await db.auditEntry.count({ where: { action: 'goal.review.request' } });
    await expect(requestReview(db, bus, g.id, { reviews: true, tz: 'UTC' })).rejects.toMatchObject({ status: 409, message: 'A rule stops goal reviews, so Flint can’t review this goal.' });
    expect(bus.sent).toEqual([]);
    expect(await db.auditEntry.count({ where: { action: 'goal.review.request' } })).toBe(asked);
    expect(goalCodeOf('A rule stops goal reviews, so Flint can’t review this goal.')).toBe('reviewsStopped');
  });
});
