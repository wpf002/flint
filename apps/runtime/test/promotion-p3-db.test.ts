/**
 * P3's promotion tables on flint_test (part 4).
 *
 * p3, goal reviews out of their trial week:
 *  - its only row is goal.review.local, ALONE, 20 a day;
 *  - refused before 7 days since Flint's first review; then until the week was
 *    lived: reviews on for each of the 7 days before today, by the health
 *    check's own Goal Reviews rows (a day with nothing due counts; a day the
 *    planner was off, or a rule stopped reviews, for any part of does not), no
 *    review over 24 hours late, no goal that late now, and the local model
 *    having answered. Late is time waited while Flint was reviewing, as part 3
 *    counts it: a review that was due while reviews were off was waiting;
 *  - the card says what signing lets happen and what the week measured, in
 *    sentences of numbers only; filing it again is the same card;
 *  - signed, reviews resolve to ALONE and are no longer marked as trial.
 * p3c, goals suggested from chat, in its own later table:
 *  - its only row is goal.propose, ALONE, 3 a day; it needs 14 days of chat's
 *    suggestion cards, not 7.
 * The six signed goal and plan actions (and the Nexus write) are in no table
 * and are never ALONE, whatever is signed.
 * Synthetic text only.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { CODE_TABLE, GOAL_SIGNED_ACTIONS, digestOf, resolveTier } from '@flint/policy';
import { NO_DB, freshDb, withClient, type TestUrls } from './db';
import { createDb, type Db } from '../src/db';
import { activePolicies, approveProposal, expireProposals, Refused, rejectProposal } from '../src/governance/proposals';
import { PolicyArgs, runInternal } from '../src/governance/internal';
import { NEVER_PROMOTED, P1_PROMOTIONS, P25_PROMOTIONS, P26_PROMOTIONS, P2_PROMOTIONS, P3C_PROMOTIONS, P3C_SHADOW_DAYS, P3_PROMOTIONS, PHASES_LIST, SHADOW_DAYS, promotionTable } from '../src/governance/promotion';
import { runPlan } from '../src/goals/batch';
import { REVIEWS_STOPPED } from '../src/goals/late';
import { reviewStanding, runReview } from '../src/goals/review';
import type { ReplyOp } from '../src/goals/steps';
import { CANARY, DAY, FakeBus, goalFixture, type GoalFixture } from './goals/fixture';
import { HOUR, daysBefore, goalReviewsRan, moveReview, noon, reviewing } from './goals/weeks';

const OLLAMA = { url: 'http://127.0.0.1:11434', model: 'muse-glimmer:30b' };
const op = (over: Partial<ReplyOp> = {}): ReplyOp => ({ op: 'none', step: '', template: 'none', ref: '', criterion: '', dueInDays: -1, status: 'none', after: '', ...over });
/** A stub Ollama that answers with these operations. No network. */
const model = (ops: ReplyOp[]) => (async () => new Response(JSON.stringify({ model: 'm', message: { role: 'assistant', content: JSON.stringify({ reasonCode: 'slipping', ops }) }, done: true, done_reason: 'stop', prompt_eval_count: 10, eval_count: 5 }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

describe('P3’s tables, as written', () => {
  it('p3 promotes goal.review.local alone, 20 a day; p3c promotes goal.propose alone, 3 a day, after 14 days', () => {
    expect(P3_PROMOTIONS).toEqual([{ pattern: 'goal.review.local', dailyCap: 20 }]);
    expect(P3C_PROMOTIONS).toEqual([{ pattern: 'goal.propose', dailyCap: 3 }]);
    expect([SHADOW_DAYS, P3C_SHADOW_DAYS]).toEqual([7, 14]);
    expect(PHASES_LIST).toEqual(['p1', 'p2', 'p25', 'p26', 'p3', 'p3c']);
    // Each row is an action the code table lets a signed row promote, and the cap it asks is the code's own or tighter.
    for (const r of [...P3_PROMOTIONS, ...P3C_PROMOTIONS]) expect(CODE_TABLE[r.pattern], r.pattern).toMatchObject({ tier: 'approval', promotable: true });
    expect(CODE_TABLE['goal.review.local']!.cap).toEqual({ limit: 20, period: 'day' });
  });

  it('no signed goal or plan action (nor the Nexus write) is in any table, P3’s included, whatever is asked', () => {
    const never = [...GOAL_SIGNED_ACTIONS, 'nexus.remember_goal_decision'];
    expect(GOAL_SIGNED_ACTIONS).toEqual(['goal.activate', 'goal.criteria_change', 'goal.horizon_change', 'goal.done', 'goal.abandon', 'plan.change']);
    for (const a of never) {
      expect(NEVER_PROMOTED.has(a), a).toBe(true);
      expect(CODE_TABLE[a], a).toMatchObject({ promotable: false });
      for (const rows of [P1_PROMOTIONS, P2_PROMOTIONS, P25_PROMOTIONS, P26_PROMOTIONS, P3_PROMOTIONS, P3C_PROMOTIONS]) expect(rows.map((r) => r.pattern), a).not.toContain(a);
    }
    // Nor any wildcard that would cover one.
    for (const rows of [P3_PROMOTIONS, P3C_PROMOTIONS]) for (const r of rows) expect(r.pattern).toMatch(/^[a-z]+(\.[a-z_]+)+$/);
  });
});

describe.skipIf(NO_DB)('the P3 promotion table on flint_test', () => {
  let urls: TestUrls;
  let db: Db;
  let fx: GoalFixture;
  const bus = new FakeBus();
  const TZ = 'UTC';
  /**
   * "Now" for every measurement here: a few minutes ahead of the clock, so each review the tests make (stamped by the
   * database's own clock) is already in the past, and the days counted do not move while the tests run.
   */
  let now: Date;
  let week: string[];
  const table = (over: Parameters<typeof promotionTable>[1] = {}) => promotionTable(db, { phase: 'p3', tz: TZ, now, ...over });
  const refusal = async (p: Promise<unknown>) => {
    const err = await p.then(() => undefined, (e: unknown) => e);
    if (!(err instanceof Refused)) throw new Error(`not refused: ${String(err)}`);
    return `${err.status}: ${err.message}`;
  };
  async function reviewed(goalId: string, kind: 'requested' | 'scheduled' = 'requested'): Promise<string> {
    const g = await db.goal.findUniqueOrThrow({ where: { id: goalId } });
    const r = await runReview({ db, bus, tz: TZ }, kind === 'scheduled' ? { goalId, kind, dueAt: g.nextReviewAt!.toISOString() } : { goalId, kind });
    if (r.outcome !== 'reviewed') throw new Error(`not reviewed: ${r.outcome}`);
    return r.reviewId;
  }
  let a: { id: string; title: string };
  let b: { id: string; title: string };

  beforeAll(async () => {
    urls = await freshDb();
    db = createDb(urls.app);
    fx = await goalFixture(urls, db);
    a = await fx.activeGoal({ plan: { ops: [fx.step('s1'), fx.step('s2', { dueAt: new Date(Date.now() + 2 * DAY).toISOString() })] } });
    b = await fx.activeGoal();
    now = new Date(Date.now() + 5 * 60_000);
    week = daysBefore(TZ, now, 7);
  });
  afterAll(async () => db?.$disconnect());

  it('is refused before Flint has reviewed a goal, and before 7 days since its first review', async () => {
    expect(await refusal(table())).toBe('409: the shadow week is not over: 0 of 7 days of goal reviews');
    const first = await reviewed(a.id, 'scheduled');
    expect(await refusal(table())).toBe('409: the shadow week is not over: 0.0 of 7 days of goal reviews');
    await moveReview(urls, first, new Date(now.getTime() - 3 * DAY), new Date(now.getTime() - 3 * DAY - 60_000));
    expect(await refusal(table())).toMatch(/^409: the shadow week is not over: 3\.0 of 7 days of goal reviews$/);
    // Eight days ago: the trial began before the 7 whole days that must have been lived.
    await moveReview(urls, first, new Date(now.getTime() - 8 * DAY), new Date(now.getTime() - 8 * DAY - 60_000));
  });

  it('then until reviews were on for each of the 7 days before today, by the health check’s rows: a day with nothing due counts, a day they were off or stopped for any part of does not', async () => {
    const [d1, d2, d3, d4, d5, d6, d7] = week as [string, string, string, string, string, string, string];
    const said = (n: number, not: string[]) => `409: the shadow week does not count yet: goal reviews were on all day on ${n} of the 7 days before today (not on ${[...not].sort().join(', ')})`;
    // Begun eight days ago, and nothing since: the week was not lived.
    expect(await refusal(table())).toBe(said(0, week));
    // The health check found Goal Reviews on, on five of the days. No review was due on any of them: a weekly goal has none on most days.
    await goalReviewsRan(db, [d1, d2, d4, d6, d7]);
    expect(await refusal(table())).toBe(said(5, [d3, d5]));
    // A review that ran on a day is not the record of it: the health check's rows are (lateness is counted from the same rows).
    await moveReview(urls, await reviewed(b.id), noon(d5));
    expect(await refusal(table())).toBe(said(5, [d3, d5]));
    await goalReviewsRan(db, [d5]);
    expect(await refusal(table())).toBe(said(6, [d3]));
    // A day the planner was off for part of (Health said disabled at noon) is not a day they were on, whatever else it found.
    await goalReviewsRan(db, [d3], 'disabled');
    await db.healthCheck.create({ data: { component: 'goals', status: 'ok', at: new Date(noon(d3).getTime() + 6 * HOUR) } });
    expect(await refusal(table())).toBe(said(6, [d3]));
    // Nor does a review that ran that day make up for it.
    const onD3 = await reviewed(b.id);
    await moveReview(urls, onD3, new Date(noon(d3).getTime() + 7 * HOUR));
    expect(await refusal(table())).toBe(said(6, [d3]));
    // Nor is a day a rule stopped reviews for part of: Health says so in one fixed sentence, on a degraded row.
    await db.healthCheck.deleteMany({ where: { component: 'goals', status: 'disabled' } });
    await goalReviewsRan(db, [d3], 'degraded', REVIEWS_STOPPED);
    expect(await refusal(table())).toBe(said(6, [d3]));
    // Had they been on every time Health looked that day (degraded for any other reason counts: on, with an issue), the week is whole.
    await db.healthCheck.deleteMany({ where: { component: 'goals', detail: REVIEWS_STOPPED } });
    await goalReviewsRan(db, [d3], 'degraded', 'A goal’s review is over an hour late.');
    expect(await refusal(table())).not.toContain('all day');
    // Another component's checks say nothing about reviews.
    await db.healthCheck.create({ data: { component: 'triage', status: 'disabled', at: noon(d2) } });
    expect(await refusal(table())).not.toContain('all day');
  });

  it('then while a review ran over 24 hours late, or a goal is that late now: late is time waited while Flint was reviewing', async () => {
    const stuck = (goalId: string, at: Date) => withClient(urls.owner, async (c) => {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('flint.actor', 'runtime:goals', true)`);
      await c.query('UPDATE "Goal" SET "nextReviewAt" = $2 WHERE id = $1', [goalId, at]);
      await c.query('COMMIT');
    });
    // Goal b's scheduled review ran two days ago, 30 hours after it was due.
    const late = await reviewed(b.id, 'scheduled');
    const ranAt = new Date(now.getTime() - 2 * DAY);
    const due = new Date(ranAt.getTime() - 30 * HOUR);
    await moveReview(urls, late, ranAt, due);
    // The health check has a row or two a day so far and no stretch of reviewing: for all the record says, reviews
    // were off or the Mac was asleep while it waited. It was waiting, not late.
    expect(await refusal(table())).not.toContain('late');
    // Flint was reviewing for all of those 30 hours: late, and the week does not count.
    await reviewing(db, due, ranAt);
    expect(await refusal(table())).toBe('409: the shadow week does not count yet: 1 review ran over 24 hours late');
    // 23 hours is late for the panel, and not an outage.
    await moveReview(urls, late, ranAt, new Date(ranAt.getTime() - 23 * HOUR));
    expect(await refusal(table())).not.toContain('late');

    // A goal whose review has been due for 30 hours right now. With no reviewing on record for them, it is waiting.
    const next = (await db.goal.findUniqueOrThrow({ where: { id: a.id } })).nextReviewAt!;
    await stuck(a.id, new Date(now.getTime() - 30 * HOUR));
    expect(await refusal(table())).not.toContain('past a review');
    // Flint was reviewing all that time and never reached it (reviews are stuck): what Settings > Health shows as down.
    await reviewing(db, new Date(now.getTime() - 30 * HOUR), now);
    expect(await refusal(table())).toBe('409: the shadow week does not count yet: 1 goal is over 24 hours past a review');
    await stuck(a.id, next);

    // A review that ran two hours late is late for the digest (its audit entry says so) and no outage: the week
    // still counts, and the card will say it.
    await stuck(b.id, new Date(Date.now() - 2 * HOUR));
    const slow = await reviewed(b.id, 'scheduled');
    expect(((await db.auditEntry.findFirstOrThrow({ where: { correlationId: slow, action: 'goal.review.local' } })).inputs as { late?: boolean }).late).toBe(true);
    expect(await refusal(table())).not.toContain('late');
  });

  it('then until the local model has answered a review', async () => {
    expect(await refusal(table())).toBe('409: the shadow week does not count yet: the local model has not answered a review yet');
    // A review whose plan stage found no model (none configured) is not an answer.
    const off = await reviewed(a.id);
    expect(await runPlan({ db, bus, config: { tz: TZ }, load: async () => 'proceed' }, { goalId: a.id, reviewId: off })).toMatchObject({ outcome: 'none', why: 'off' });
    expect(await refusal(table())).toContain('the local model has not answered a review yet');
    // One it answered: in the trial week its suggestions are recorded, and no card is filed.
    const answered = await reviewed(a.id);
    const out = await runPlan(
      { db, bus, config: { tz: TZ, ollama: OLLAMA }, load: async () => 'proceed', fetch: model([op({ op: 'set_status', step: 's2', status: 'blocked' }), op({ op: 'add_step', template: 'review_progress', dueInDays: 3 })]) },
      { goalId: a.id, reviewId: answered },
    );
    expect(out).toEqual({ outcome: 'planned', reviewId: answered, suggested: 2, filed: 0, kept: 0 });
    expect(await db.proposal.count({ where: { action: 'plan.change', origin: 'runtime:goals' } })).toBe(0);
  });

  it('after the week: one row, goal.review.local ALONE at 20 a day; the card says what signing lets happen and what the week measured, in numbers', async () => {
    const t = await table();
    expect(t.deduped).toBe(false);
    expect(PolicyArgs.safeParse({ rows: t.rows }).success).toBe(true);
    expect(t.rows).toEqual([{ pattern: 'goal.review.local', tier: 'alone', dailyCap: 20, reason: 'P3 promotion table, after the shadow week', expiresAt: t.rows[0]!.expiresAt }]);
    // 175 days from the start of today: inside the 180 a policy row may last.
    expect(Date.parse(t.rows[0]!.expiresAt) - Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toBe(175 * DAY);
    const card = await db.proposal.findUniqueOrThrow({ where: { id: t.proposalId } });
    expect(card).toMatchObject({ kind: 'policy', origin: 'cli', action: 'policy.change', templateId: 'p3.promotion', tainted: false, sensitivity: 'ops', consequential: true, status: 'pending' });
    // In the last 7 days: b's two reviews on quiet days, b's two scheduled ones, and a's two today. The first review, 8 days ago, is
    // before the week. Late is the digest's count (over an hour): the one that ran two hours late.
    expect(card.reason).toMatch(/^This lets Flint review your goals and send its plan suggestions as cards without asking until [A-Z][a-z]{2} \d{1,2}, \d{4}\. This week Flint reviewed your goals 6 times, and 1 was late\. The local model answered 1\. It would have suggested 2 changes\.$/);
    // Numbers only: no goal's words, no id.
    expect(card.reason).not.toContain(CANARY);
    for (const id of [a.id, b.id]) expect(JSON.stringify([card.reason, card.args, card.argsProvenance])).not.toContain(id);
  });

  it('filing it again, later and after more reviews, is the same card; a dropped row leaves nothing to promote', async () => {
    const first = await db.proposal.findFirstOrThrow({ where: { templateId: 'p3.promotion', status: 'pending' } });
    await reviewed(b.id);
    expect(await table({ now: new Date(now.getTime() + 90_000) })).toMatchObject({ proposalId: first.id, deduped: true });
    expect(await db.proposal.count({ where: { templateId: 'p3.promotion' } })).toBe(1);
    expect(await refusal(table({ drop: ['goal.review.local'] }))).toBe('400: nothing left to promote');
  });

  it('signed: reviews resolve to ALONE at 20 a day and leave their trial week; every signed goal and plan action still asks', async () => {
    expect(await reviewStanding(db, new Date())).toMatchObject({ may: true, shadow: true, tier: 'approval' });
    const card = await db.proposal.findFirstOrThrow({ where: { templateId: 'p3.promotion', status: 'pending' } });
    await approveProposal(db, card.id, await fx.key.approve({ subjectId: card.id, action: 'policy.change', argsDigest: card.argsDigest }), undefined, 'test');
    expect(await runInternal(db, card.id, undefined, TZ, 'test')).toEqual({ rows: 1 });
    const policies = await activePolicies(db);
    expect(resolveTier('goal.review.local', { context: 'autonomous', tainted: false, policies })).toMatchObject({ tier: 'alone', cap: { limit: 20, period: 'day' } });
    expect(await reviewStanding(db, new Date())).toMatchObject({ may: true, shadow: false, tier: 'alone', cap: { limit: 20, period: 'day' } });
    // The next review is for real: not marked as trial.
    const real = await reviewed(b.id);
    expect((await db.goalReview.findUniqueOrThrow({ where: { id: real } })).shadow).toBe(false);
    // Nothing else moved: the six signed actions, the Nexus write and chat's suggestions.
    for (const action of [...NEVER_PROMOTED, 'goal.propose', 'world.commitment.from_chat']) {
      for (const context of ['autonomous', 'chat', 'console'] as const) expect(resolveTier(action, { context, tainted: false, policies }).tier, `${action} in ${context}`).not.toBe('alone');
    }
    expect(Number((await withClient(urls.owner, (c) => c.query(`SELECT count(*) AS n FROM "ActionPolicy" WHERE tier = 'alone'`))).rows[0].n)).toBe(1);
    // Once promoted, the week's sentence says what reviews suggested, no longer what they would have.
    const again = await table({ now: new Date(now.getTime() + 120_000) });
    expect(again.deduped).toBe(false);
    expect((await db.proposal.findUniqueOrThrow({ where: { id: again.proposalId } })).reason).toMatch(/This week Flint reviewed your goals 8 times, and 1 was late\. The local model answered 1\. It suggested 2 changes\.$/);
  });
});

describe.skipIf(NO_DB)('the later table, for goals suggested from chat (p3c)', () => {
  let urls: TestUrls;
  let db: Db;
  let fx: GoalFixture;
  const table = (over: Parameters<typeof promotionTable>[1] = {}) => promotionTable(db, { phase: 'p3c', tz: 'UTC', ...over });
  let n = 0;
  /** A goal chat suggested, as chat files it (Will's own quoted words), dated in the past: the database refuses a card born expired. */
  const suggested = (daysAgo: number, ttlDays = 7) => {
    const at = new Date(Date.now() - daysAgo * DAY);
    const cardId = `prp3c${++n}${Math.random().toString(36).slice(2, 8)}`;
    const args = { title: `${CANARY} suggested ${n}`, quote: `${CANARY} I want to run a half marathon` };
    return withClient(urls.owner, (c) => c.query(
      `INSERT INTO "Proposal" (id, kind, origin, action, args, "argsDigest", "argsProvenance", tainted, sensitivity, reason, "expiresAt", "createdAt")
       VALUES ($1, 'goal', 'chat:t1', 'goal.propose', $2::jsonb, $3, $4::jsonb, false, 'personal', 'Approving adds it to your suggested goals.', $5, $6)`,
      [cardId, JSON.stringify(args), digestOf(args), JSON.stringify({ quote: { source: 'will', tainted: false }, title: { source: 'model', tainted: false } }), new Date(at.getTime() + ttlDays * DAY), at],
    )).then(() => cardId);
  };

  beforeAll(async () => {
    urls = await freshDb();
    db = createDb(urls.app);
    fx = await goalFixture(urls, db);
  });
  afterAll(async () => db?.$disconnect());

  it('needs 14 days of chat’s suggestion cards, not 7', async () => {
    await expect(table()).rejects.toThrow(/the shadow weeks are not over: 0 of 14 days of chat suggestions/);
    await suggested(8, 1);
    await expect(table()).rejects.toThrow(/the shadow weeks are not over: 8\.0 of 14 days of chat suggestions/);
    // A week of goal reviews is not its evidence, and a week of its cards is not the reviews'.
    await expect(promotionTable(db, { phase: 'p3', tz: 'UTC' })).rejects.toThrow(/the shadow week is not over: 0 of 7 days of goal reviews/);
  });

  it('after two weeks: one row, goal.propose ALONE at 3 a day; the card counts what Will did with the suggestions', async () => {
    await suggested(15, 1);
    const waiting = await suggested(1);
    const turnedDown = await suggested(2);
    await rejectProposal(db, turnedDown, {}, undefined, 'will:console');
    expect(await expireProposals(db)).toBe(2);
    const t = await table();
    expect(PolicyArgs.safeParse({ rows: t.rows }).success).toBe(true);
    expect(t.rows).toEqual([{ pattern: 'goal.propose', tier: 'alone', dailyCap: 3, reason: 'P3 chat promotion table, after the shadow weeks', expiresAt: t.rows[0]!.expiresAt }]);
    const card = await db.proposal.findUniqueOrThrow({ where: { id: t.proposalId } });
    expect(card).toMatchObject({ templateId: 'p3c.promotion', kind: 'policy', origin: 'cli', consequential: true });
    // In the last 14 days: the one 8 days ago (expired), the one rejected, the one still waiting. The first, 15 days ago, is before them.
    expect(card.reason).toMatch(/^This lets Flint suggest goals from your chats without asking until [A-Z][a-z]{2} \d{1,2}, \d{4}\. In the last 2 weeks Flint suggested 3 goals from chat: you approved 0, rejected 1, and 1 expired\.$/);
    expect(card.reason).not.toContain(CANARY);
    expect(await db.proposal.findUniqueOrThrow({ where: { id: waiting } })).toMatchObject({ status: 'pending' });
    expect(await table({ now: new Date(Date.now() + 60_000) })).toMatchObject({ proposalId: t.proposalId, deduped: true });
  });

  it('signed: a goal suggested from chat lands without asking, 3 a day; starting it is still Will’s signature, and reviews stay in their trial week', async () => {
    const card = await db.proposal.findFirstOrThrow({ where: { templateId: 'p3c.promotion', status: 'pending' } });
    await approveProposal(db, card.id, await fx.key.approve({ subjectId: card.id, action: 'policy.change', argsDigest: card.argsDigest }), undefined, 'test');
    expect(await runInternal(db, card.id, undefined, 'UTC', 'test')).toEqual({ rows: 1 });
    const policies = await activePolicies(db);
    expect(resolveTier('goal.propose', { context: 'chat', tainted: false, policies })).toMatchObject({ tier: 'alone', cap: { limit: 3, period: 'day' } });
    expect(resolveTier('goal.propose', { context: 'autonomous', tainted: false, policies }).tier).toBe('forbidden');
    expect(resolveTier('goal.review.local', { context: 'autonomous', tainted: false, policies }).tier).toBe('approval');
    for (const action of NEVER_PROMOTED) for (const context of ['autonomous', 'chat', 'console'] as const) expect(resolveTier(action, { context, tainted: false, policies }).tier, action).not.toBe('alone');
  });
});
