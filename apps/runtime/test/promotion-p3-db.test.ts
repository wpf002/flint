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
 *  - it is refused while reviews are off or stopped right now, too;
 *  - the card says what signing lets happen and what the week measured, in
 *    sentences of numbers only, counted over the very window the gate
 *    counted; filing it again is the same card;
 *  - a waiting card that only looks like the table's (another cap, another
 *    filer, an evidence sentence of its own) is never handed back as the
 *    table's own;
 *  - signed, reviews resolve to ALONE and are no longer marked as trial.
 * p3c, goals suggested from chat, in its own later table:
 *  - its only row is goal.propose, ALONE, 3 a day; it needs 14 days of chat's
 *    suggestion cards, not 7, and some of them inside those 14 days.
 * The six signed goal and plan actions (and the Nexus write) are in no table
 * and are never ALONE, whatever is signed.
 * A policy change always asks on its own, and the rows a gate counts are dated
 * by the database: both are the database's rules (p3_policy_floor).
 *
 * Every gate test runs twice: in UTC, and in America/Chicago at ten to
 * midnight, where a day counted in UTC is not Will's day.
 * Synthetic text only.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { CODE_TABLE, GOAL_SIGNED_ACTIONS, digestOf, localDay, localDayBounds, localWallTime, noteProblems, resolveTier } from '@flint/policy';
import { NO_DB, freshDb, healthRows, pgError, withClient, type TestUrls } from './db';
import { createDb, type Db } from '../src/db';
import { activePolicies, approveProposal, createProposal, expireProposals, Refused, rejectProposal } from '../src/governance/proposals';
import { PolicyArgs, runInternal } from '../src/governance/internal';
import { NEVER_PROMOTED, P1_PROMOTIONS, P25_PROMOTIONS, P26_PROMOTIONS, P2_PROMOTIONS, P3C_PROMOTIONS, P3C_SHADOW_DAYS, P3_PROMOTIONS, PHASES_LIST, SHADOW_DAYS, promotionTable } from '../src/governance/promotion';
import { runPlan } from '../src/goals/batch';
import { REVIEWS_STOPPED } from '../src/goals/late';
import { reviewStanding, runReview } from '../src/goals/review';
import type { ReplyOp } from '../src/goals/steps';
import { CANARY, DAY, FakeBus, goalFixture, type GoalFixture } from './goals/fixture';
import { daysNotRunning, reviewsNow, windowStart } from '../src/goals/measures';
import { HOUR, daysBefore, moveReview, reviewing } from './goals/weeks';

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

/** Ten to midnight tonight in `tz`: the gate is asked late in Will's day, when a UTC day and his are furthest apart. */
function tonight(tz: string): Date {
  const at = localWallTime(tz, localDay(tz, new Date(Date.now() + 10 * 60_000)), 23, 50);
  // (Run in the last ten minutes of the day, it is ten to midnight tomorrow.)
  return at.getTime() > Date.now() + 5 * 60_000 ? at : new Date(at.getTime() + DAY);
}
const refusal = async (p: Promise<unknown>) => {
  const err = await p.then(() => undefined, (e: unknown) => e);
  if (!(err instanceof Refused)) throw new Error(`not refused: ${String(err)}`);
  return `${err.status}: ${err.message}`;
};
/** "Oct 5", as the card says the day a count starts. */
const dayWords = (tz: string, at: Date) => new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric' }).format(at);

describe.skipIf(NO_DB).each(['UTC', 'America/Chicago'])('the P3 promotion table on flint_test, in %s', (TZ) => {
  let urls: TestUrls;
  let db: Db;
  let fx: GoalFixture;
  const bus = new FakeBus();
  /** "Now" for every measurement here: ten to midnight tonight in TZ. Every review the tests make (stamped by the database's own clock) is before it. */
  let now: Date;
  let week: string[];
  let since: Date;
  const table = (over: Partial<Parameters<typeof promotionTable>[1]> = {}) => promotionTable(db, { phase: 'p3', tz: TZ, now, ...over });
  /** A time on one of Will's days, by his own clock. */
  const at = (day: string, hh: number, mm = 0) => localWallTime(TZ, day, hh, mm);
  const goalsCheck = (when: Date, status: string, detail?: string) => healthRows(urls, [{ component: 'goals', status, at: when, ...(detail ? { detail } : {}) }]);
  /** The health check's latest word on goal reviews, a minute before `now`. */
  async function checkedNow(status: 'ok' | 'disabled' | 'degraded' | null, detail?: string): Promise<void> {
    await withClient(urls.owner, (c) => c.query(`DELETE FROM "HealthCheck" WHERE component = 'goals' AND at > $1`, [new Date(now.getTime() - 20 * 60_000)]));
    if (status) await goalsCheck(new Date(now.getTime() - 60_000), status, detail);
  }
  async function reviewed(goalId: string, kind: 'requested' | 'scheduled' = 'requested'): Promise<string> {
    const g = await db.goal.findUniqueOrThrow({ where: { id: goalId } });
    const r = await runReview({ db, bus, tz: TZ }, kind === 'scheduled' ? { goalId, kind, dueAt: g.nextReviewAt!.toISOString() } : { goalId, kind });
    if (r.outcome !== 'reviewed') throw new Error(`not reviewed: ${r.outcome}`);
    return r.reviewId;
  }
  const due = (goalId: string, when: Date) => db.goal.update({ where: { id: goalId }, data: { nextReviewAt: when } });
  let a: { id: string; title: string };
  let b: { id: string; title: string };

  beforeAll(async () => {
    urls = await freshDb();
    db = createDb(urls.app);
    fx = await goalFixture(urls, db);
    a = await fx.activeGoal({ plan: { ops: [fx.step('s1'), fx.step('s2', { dueAt: new Date(Date.now() + 2 * DAY).toISOString() })] } });
    b = await fx.activeGoal();
    now = tonight(TZ);
    week = daysBefore(TZ, now, 7);
    since = localDayBounds(TZ, week[6]!).start;
  });
  afterAll(async () => db?.$disconnect());

  it('is refused before Flint has reviewed a goal, and before 7 days since its first review', async () => {
    expect(await refusal(table())).toBe('409: the shadow week is not over: 0 of 7 days of goal reviews');
    const first = await reviewed(a.id, 'scheduled');
    expect(await refusal(table())).toMatch(/^409: the shadow week is not over: [01]\.\d of 7 days of goal reviews$/);
    await moveReview(urls, first, new Date(now.getTime() - 3 * DAY), new Date(now.getTime() - 3 * DAY - 60_000));
    expect(await refusal(table())).toBe('409: the shadow week is not over: 3.0 of 7 days of goal reviews');
    // Nine days ago: the trial began before the 7 whole days that must have been lived.
    await moveReview(urls, first, new Date(now.getTime() - 9 * DAY), new Date(now.getTime() - 9 * DAY - 60_000));
  });

  it('then until reviews were on for each of the 7 days before today, by the health check’s rows and by Will’s own days', async () => {
    const [d1, d2, d3, d4, d5, d6, d7] = week as [string, string, string, string, string, string, string];
    const said = (n: number, not: string[]) => `409: the shadow week does not count yet: goal reviews were on all day on ${n} of the 7 days before today (not on ${[...not].sort().join(', ')})`;
    // Begun nine days ago, and nothing since: the week was not lived.
    expect(await refusal(table())).toBe(said(0, week));
    // The health check found Goal Reviews on, on five of the days. No review was due on any of them: a weekly goal has none on most days.
    await healthRows(urls, [d1, d2, d4, d6, d7].map((d) => ({ component: 'goals', status: 'ok', at: at(d, 12) })));
    expect(await refusal(table())).toBe(said(5, [d3, d5]));
    // A review that ran on a day is not the record of it: the health check's rows are (lateness is counted from the same rows).
    await moveReview(urls, await reviewed(b.id), at(d5, 12));
    expect(await refusal(table())).toBe(said(5, [d3, d5]));
    // A day is Will's day. A check at half past eleven at night is that day's, whatever day it is in UTC by then...
    await goalsCheck(at(d5, 23, 30), 'ok');
    expect(await refusal(table())).toBe(said(6, [d3]));
    // ...and one ten minutes into the next day is not the day before's.
    await goalsCheck(new Date(at(d3, 23, 59).getTime() + 11 * 60_000), 'ok');
    expect(await refusal(table())).toBe(said(6, [d3]));
    // A day the planner was off for part of (Health said disabled late that evening) is not a day they were on, whatever else it found.
    await goalsCheck(at(d3, 12), 'ok');
    await goalsCheck(at(d3, 23, 40), 'disabled');
    expect(await refusal(table())).toBe(said(6, [d3]));
    // Nor does a review that ran that day make up for it.
    await moveReview(urls, await reviewed(b.id), at(d3, 19));
    expect(await refusal(table())).toBe(said(6, [d3]));
    // Nor is a day a rule stopped reviews for part of: Health says so in one fixed sentence, on a degraded row.
    await withClient(urls.owner, (c) => c.query(`DELETE FROM "HealthCheck" WHERE component = 'goals' AND status = 'disabled'`));
    await goalsCheck(at(d3, 23, 40), 'degraded', REVIEWS_STOPPED);
    expect(await refusal(table())).toBe(said(6, [d3]));
    // Had they been on every time Health looked that day (degraded for any other reason counts: on, with an issue), the week is whole.
    await withClient(urls.owner, (c) => c.query(`DELETE FROM "HealthCheck" WHERE component = 'goals' AND detail = $1`, [REVIEWS_STOPPED]));
    await goalsCheck(at(d3, 23, 40), 'degraded', 'A goal’s review is over an hour late.');
    expect(await refusal(table())).not.toContain('all day');
    // Another component's checks say nothing about reviews.
    await healthRows(urls, [{ component: 'triage', status: 'disabled', at: at(d2, 12) }]);
    expect((await daysNotRunning(db, TZ, now, 7)).missing).toEqual([]);
    // The window both the gate and the card count from: the start of the first of those days, by Will's clock.
    expect((await daysNotRunning(db, TZ, now, 7)).since.toISOString()).toBe(since.toISOString());
    expect(windowStart(TZ, now, 7).toISOString()).toBe(since.toISOString());
  });

  it('then while reviews are off or stopped right now, or the health check has stopped looking: the gate looks at today too', async () => {
    await checkedNow(null);
    expect(await reviewsNow(db, now)).toBe('unknown');
    expect(await refusal(table())).toBe('409: the shadow week does not count yet: the health check has not looked at goal reviews in the last 15 minutes');
    // Switched off a minute ago: a week that was lived is not a reason to promote reviews that are off.
    await checkedNow('disabled');
    expect(await refusal(table())).toBe('409: the shadow week does not count yet: goal reviews are off right now');
    await checkedNow('degraded', REVIEWS_STOPPED);
    expect(await refusal(table())).toBe('409: the shadow week does not count yet: a rule stops goal reviews right now');
    // A check from 16 minutes ago says nothing about now.
    await checkedNow(null);
    await goalsCheck(new Date(now.getTime() - 16 * 60_000), 'ok');
    expect(await refusal(table())).toContain('has not looked at goal reviews in the last 15 minutes');
    await checkedNow('ok');
    expect(await reviewsNow(db, now)).toBe('on');
    expect(await refusal(table())).not.toMatch(/right now|15 minutes/);
  });

  it('then while a review ran over 24 hours late, or a goal is that late now: late is time waited while Flint was reviewing, as the review itself recorded', async () => {
    const real = () => new Date();
    const marks = async (reviewId: string) => (await db.auditEntry.findFirstOrThrow({ where: { correlationId: reviewId, action: 'goal.review.local' }, orderBy: { seq: 'asc' } })).inputs as { late?: boolean; lateOverDay?: boolean };
    // Goal b's review was due 30 hours ago, and for all the record says reviews were off or the Mac asleep
    // meanwhile (a check or two a day, no stretch of reviewing). It runs now: it was waiting, not late.
    await due(b.id, new Date(Date.now() - 30 * HOUR));
    const waited = await reviewed(b.id, 'scheduled');
    expect(await marks(waited)).not.toHaveProperty('late');
    expect(await refusal(table())).not.toContain('late');
    // Due 30 hours ago again, and this time Flint was reviewing for all of them: it runs late, and its own audit entry says by how much.
    await due(b.id, new Date(Date.now() - 30 * HOUR));
    await reviewing(urls, new Date(Date.now() - 30 * HOUR), real());
    const late = await reviewed(b.id, 'scheduled');
    expect(await marks(late)).toMatchObject({ late: true, lateOverDay: true });
    expect(await refusal(table())).toBe('409: the shadow week does not count yet: 1 review ran over 24 hours late');
    // The mark is the review's own: it stands when retention has deleted the health rows the wait was counted from.
    await withClient(urls.owner, (c) => c.query(`DELETE FROM "HealthCheck" WHERE component = 'goals' AND at > $1 AND at < $2`, [new Date(Date.now() - 31 * HOUR), new Date(Date.now() - 20 * 60_000)]));
    await healthRows(urls, [...new Set([localDay(TZ, new Date(Date.now() - 30 * HOUR)), localDay(TZ, new Date(Date.now() - 6 * HOUR)), localDay(TZ, real())])].filter((d) => week.includes(d)).map((d) => ({ component: 'goals', status: 'ok', at: at(d, 12) })));
    expect(await refusal(table())).toBe('409: the shadow week does not count yet: 1 review ran over 24 hours late');
    // It ages out of the week.
    await moveReview(urls, late, new Date(since.getTime() - HOUR));
    expect(await refusal(table())).not.toContain('late');

    // A goal whose review has been due for 30 hours right now. With no reviewing on record for them, it is waiting.
    const next = (await db.goal.findUniqueOrThrow({ where: { id: a.id } })).nextReviewAt!;
    await due(a.id, new Date(now.getTime() - 30 * HOUR));
    expect(await refusal(table())).not.toContain('past a review');
    // Flint was reviewing all that time and never reached it (reviews are stuck): what Settings > Health shows as down.
    await reviewing(urls, new Date(now.getTime() - 30 * HOUR), new Date(now.getTime() - 60_000));
    expect(await refusal(table())).toBe('409: the shadow week does not count yet: 1 goal is over 24 hours past a review');
    await due(a.id, next);

    // A review that ran two hours late is late for the digest (its audit entry says so) and no outage: the week
    // still counts, and the card will say it.
    await due(b.id, new Date(Date.now() - 2 * HOUR));
    const slow = await reviewed(b.id, 'scheduled');
    expect(await marks(slow)).toEqual(expect.objectContaining({ late: true }));
    expect(await marks(slow)).not.toHaveProperty('lateOverDay');
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
    // It ran ten minutes into the first of the 7 days: over seven days ago by the clock, and inside the week the gate counts.
    await moveReview(urls, answered, new Date(since.getTime() + 10 * 60_000));
    expect(now.getTime() - (since.getTime() + 10 * 60_000)).toBeGreaterThan(7 * DAY);
  });

  it('after the week: one row, goal.review.local ALONE at 20 a day; the card counts what the gate counted, from the same moment', async () => {
    const t = await table();
    expect(t.deduped).toBe(false);
    expect(PolicyArgs.safeParse({ rows: t.rows }).success).toBe(true);
    expect(t.rows).toEqual([{ pattern: 'goal.review.local', tier: 'alone', dailyCap: 20, reason: 'P3 promotion table, after the shadow week', expiresAt: t.rows[0]!.expiresAt }]);
    // 175 days from the start of today: inside the 180 a policy row may last.
    expect(Date.parse(t.rows[0]!.expiresAt) - Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toBe(175 * DAY);
    const card = await db.proposal.findUniqueOrThrow({ where: { id: t.proposalId } });
    expect(card).toMatchObject({ kind: 'policy', origin: 'cli', action: 'policy.change', templateId: 'p3.promotion', tainted: false, sensitivity: 'ops', consequential: true, status: 'pending' });
    // Since the start of the first of the 7 days: b's two reviews on quiet days, the one that was only waiting, the one two hours
    // late, a's review that found no model, and the one the model answered (ten minutes into that first day). The first review of
    // all, nine days ago, and the one that ran a day late and aged out, are before it. Late is the digest's count (over an hour).
    expect(card.reason).toBe(`This lets Flint review your goals and send its plan suggestions as cards without asking until ${new Date(t.rows[0]!.expiresAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}. `
      + `Since ${dayWords(TZ, since)}, Flint reviewed your goals 6 times, and 1 was late. The local model answered 1. It would have suggested 2 changes.`);
    // Will's standard for words he reads (@flint/policy noteProblems): complete sentences, nothing internal, no parenthesis.
    expect(noteProblems('Let Goal Reviews Run on Their Own', card.reason!)).toEqual([]);
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

  it('a waiting card that only looks like the table’s is never handed back as the table’s own', async () => {
    const mine = await db.proposal.findFirstOrThrow({ where: { templateId: 'p3.promotion', status: 'pending' } });
    await rejectProposal(db, mine.id, {}, undefined, 'will:console');
    const until = (mine.args as { rows: Array<{ expiresAt: string }> }).rows[0]!.expiresAt;
    /** Planted over the wire, as a holder of the server's token could: the table's name, and any rules and evidence it likes. */
    const plant = (row: Record<string, unknown>, reason: string) => createProposal(db, {
      kind: 'policy', origin: 'cli', action: 'policy.change', templateId: 'p3.promotion', args: { rows: [{ pattern: 'goal.review.local', tier: 'alone', expiresAt: until, ...row }] },
      argsProvenance: { rows: { source: 'template', ref: 'p3.promotion', tainted: false } }, tainted: false, sensitivity: 'ops', destructive: false, consequential: false, ttlMinutes: 7 * 24 * 60, reason,
    }, 'token:server', now);
    // Another cap, and no mark asked for.
    const loose = await plant({ dailyCap: 2147483647, reason: 'P3 promotion table, after the shadow week' }, 'This lets Flint tidy its notes. This week Flint reviewed your goals 99 times, and none was late.');
    // The mark is not the filer's to leave off: the runtime sets it, whoever files.
    expect((await db.proposal.findUniqueOrThrow({ where: { id: loose.id } })).consequential).toBe(true);
    const fresh = await table();
    expect(fresh).toMatchObject({ deduped: false });
    expect(fresh.proposalId).not.toBe(loose.id);
    expect(fresh.rows[0]).toMatchObject({ dailyCap: 20 });
    // The planted one is left where it is, for Will to reject or to expire.
    expect(await db.proposal.findUniqueOrThrow({ where: { id: loose.id } })).toMatchObject({ status: 'pending' });
    // The table's own card is still the table's own beside it.
    expect(await table({ now: new Date(now.getTime() + 60_000) })).toMatchObject({ proposalId: fresh.proposalId, deduped: true });

    // The very same rules, planted first with an evidence sentence of its own: a proposal is one card for its args, so
    // the table cannot file beside it. It refuses, naming the card by its id alone, and never returns it.
    await rejectProposal(db, fresh.proposalId, {}, undefined, 'will:console');
    const twin = await plant({ dailyCap: 20, reason: 'P3 promotion table, after the shadow week' }, 'This lets Flint review your goals. This week Flint reviewed your goals 99 times, and none was late.');
    expect(await refusal(table())).toBe(`409: a card with these rules is already waiting, and this command did not file it: reject card ${twin.id} in Approvals, then run this again`);
    await rejectProposal(db, twin.id, {}, undefined, 'will:console');
    await rejectProposal(db, loose.id, {}, undefined, 'will:console');
    const again = await table();
    expect(again).toMatchObject({ deduped: false });
    expect(await db.proposal.count({ where: { templateId: 'p3.promotion', status: 'pending' } })).toBe(1);
  });

  it('nor is one filed under the command’s own name the table’s, unless its rules are the table’s to the letter and its reason is the one the command writes', async () => {
    const mine = await db.proposal.findFirstOrThrow({ where: { templateId: 'p3.promotion', status: 'pending' } });
    await rejectProposal(db, mine.id, {}, undefined, 'will:console');
    const until = (mine.args as { rows: Array<{ expiresAt: string }> }).rows[0]!.expiresAt;
    const REASON = 'P3 promotion table, after the shadow week';
    /** Forged as the command itself (what the runtime's own role could write): its origin, its mark, its actor in the audit trail. */
    const forge = (row: Record<string, unknown>, reason: string) => createProposal(db, {
      kind: 'policy', origin: 'cli', action: 'policy.change', templateId: 'p3.promotion', args: { rows: [{ pattern: 'goal.review.local', tier: 'alone', expiresAt: until, ...row }] },
      argsProvenance: { rows: { source: 'template', ref: 'p3.promotion', tainted: false } }, tainted: false, sensitivity: 'ops', destructive: false, consequential: true, ttlMinutes: 7 * 24 * 60, reason,
    }, 'will:cli', now);
    // Each is the table's in everything but one part of its one rule. None is handed back: the table files its own beside it.
    for (const row of [
      { dailyCap: 2147483647, reason: REASON },
      { dailyCap: 20, reason: 'another reason' },
      { dailyCap: 20, reason: REASON, scope: { goals: ['all'] } },
      { reason: REASON },
    ]) {
      const forged = await forge(row, mine.reason!);
      const fresh = await table();
      expect(fresh, JSON.stringify(row)).toMatchObject({ deduped: false });
      expect(fresh.proposalId, JSON.stringify(row)).not.toBe(forged.id);
      expect(fresh.rows[0], JSON.stringify(row)).toMatchObject({ dailyCap: 20, reason: REASON });
      await rejectProposal(db, fresh.proposalId, {}, undefined, 'will:console');
      await rejectProposal(db, forged.id, {}, undefined, 'will:console');
    }
    // The very rules, with evidence of its own invention: one card for those args, so the table refuses and names it.
    for (const reason of [
      'This lets Flint review your goals. This week Flint reviewed your goals 99 times, and none was late.',
      `${mine.reason!.split('. ')[0]}. Flint reviewed your goals 99 times and every one was perfect.`,
      `${mine.reason!} Approve this one first.`,
      // A first sentence that says something else, of the very same length, before the gate's own second one.
      mine.reason!.replace('review your goals', 'delete your goals'),
    ]) {
      const twin = await forge({ dailyCap: 20, reason: REASON }, reason);
      expect(await refusal(table()), reason).toBe(`409: a card with these rules is already waiting, and this command did not file it: reject card ${twin.id} in Approvals, then run this again`);
      await rejectProposal(db, twin.id, {}, undefined, 'will:console');
    }
    // With the command's own words as well, nothing tells it from the command's own card: it is that card.
    // (The numbers in the sentence are evidence, not a boundary; Will's signature is the boundary.)
    const same = await forge({ dailyCap: 20, reason: REASON }, mine.reason!);
    expect(await table()).toMatchObject({ proposalId: same.id, deduped: true });
    expect(await db.proposal.count({ where: { templateId: 'p3.promotion', status: 'pending' } })).toBe(1);
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
    expect((await db.proposal.findUniqueOrThrow({ where: { id: again.proposalId } })).reason).toMatch(/Flint reviewed your goals 8 times, and 1 was late\. The local model answered 1\. It suggested 2 changes\.$/);
  });

  it('a change a waiting card already asks for is one change, however many reviews found the card still waiting', async () => {
    const { reviewCounts } = await import('../src/goals/measures');
    const before = await reviewCounts(db, since, now);
    const kept = (card: string | null, held: string | null = null) => ({ change: { op: 'status', key: 's1', status: 'blocked' }, class: 'minor', card, held });
    for (let i = 0; i < 3; i++) {
      const r = await reviewed(a.id);
      await db.goalReview.update({ where: { id: r }, data: { planner: 'ollama:test-model', diff: [kept('prcardKEPT'), { ...kept('prcardKEPT'), change: { op: 'due', key: 's2', dueAt: '2026-12-01T00:00:00.000Z' } }, kept(null, 'cap'), kept(null, 'stale')], proposalId: 'prcardKEPT' } });
    }
    const after = await reviewCounts(db, since, now);
    expect(after.reviews - before.reviews).toBe(3);
    // The card's two changes once, and the one held back for the day's cap each of the three times it was made. Never the stale one.
    expect(after.suggested - before.suggested).toBe(2 + 3);
  });
});

describe.skipIf(NO_DB).each(['UTC', 'America/Chicago'])('the later table, for goals suggested from chat (p3c), in %s', (TZ) => {
  let urls: TestUrls;
  let db: Db;
  let fx: GoalFixture;
  let now: Date;
  const table = (over: Partial<Parameters<typeof promotionTable>[1]> = {}) => promotionTable(db, { phase: 'p3c', tz: TZ, now, ...over });
  let n = 0;
  /** A goal chat suggested, as chat files it (Will's own quoted words), dated in the past by the owner: the database dates the runtime's own cards itself. */
  const suggested = (ago: number, ttlDays = 7) => {
    const made = new Date(now.getTime() - ago);
    const cardId = `prp3c${++n}${Math.random().toString(36).slice(2, 8)}`;
    const args = { title: `${CANARY} suggested ${n}`, quote: `${CANARY} I want to run a half marathon` };
    return withClient(urls.owner, (c) => c.query(
      `INSERT INTO "Proposal" (id, kind, origin, action, args, "argsDigest", "argsProvenance", tainted, sensitivity, reason, "expiresAt", "createdAt")
       VALUES ($1, 'goal', 'chat:t1', 'goal.propose', $2::jsonb, $3, $4::jsonb, false, 'personal', 'Approving adds it to your suggested goals.', $5, $6)`,
      [cardId, JSON.stringify(args), digestOf(args), JSON.stringify({ quote: { source: 'will', tainted: false }, title: { source: 'model', tainted: false } }), new Date(made.getTime() + ttlDays * DAY), made],
    )).then(() => cardId);
  };

  beforeAll(async () => {
    urls = await freshDb();
    db = createDb(urls.app);
    fx = await goalFixture(urls, db);
    now = tonight(TZ);
  });
  afterAll(async () => db?.$disconnect());

  it('needs 14 days of chat’s suggestion cards, not 7', async () => {
    expect(await refusal(table())).toBe('409: the shadow weeks are not over: 0 of 14 days of chat suggestions');
    await suggested(8 * DAY, 1);
    expect(await refusal(table())).toBe('409: the shadow weeks are not over: 8.0 of 14 days of chat suggestions');
    // A week of goal reviews is not its evidence, and a week of its cards is not the reviews'.
    expect(await refusal(promotionTable(db, { phase: 'p3', tz: TZ, now }))).toBe('409: the shadow week is not over: 0 of 7 days of goal reviews');
  });

  it('the runtime’s own role cannot date a card into the past to open the gate: the database dates what it files', async () => {
    const args = { title: `${CANARY} backdated`, quote: `${CANARY} I want to backdate a card` };
    await withClient(urls.app, (c) => c.query(
      `INSERT INTO "Proposal" (id, kind, origin, action, args, "argsDigest", "argsProvenance", tainted, sensitivity, reason, "expiresAt", "createdAt")
       VALUES ('prbackdated1', 'goal', 'chat:forged', 'goal.propose', $1::jsonb, $2, $3::jsonb, false, 'personal', 'x', now() + interval '1 hour', now() - interval '30 days')`,
      [JSON.stringify(args), digestOf(args), JSON.stringify({ quote: { source: 'will', tainted: false } })],
    ));
    const row = await db.proposal.findUniqueOrThrow({ where: { id: 'prbackdated1' } });
    expect(Math.abs(row.createdAt.getTime() - Date.now())).toBeLessThan(60_000);
    expect(await refusal(table())).toBe('409: the shadow weeks are not over: 8.0 of 14 days of chat suggestions');
    // Nor a health check: a week of "reviews were on" cannot be written in an afternoon.
    await db.healthCheck.create({ data: { component: 'goals', status: 'ok', detail: 'one', at: new Date(Date.now() - 8 * DAY) } });
    await db.healthCheck.createMany({ data: [3, 4, 5].map((d) => ({ component: 'goals', status: 'ok', detail: 'many', at: new Date(Date.now() - d * DAY) })) });
    const written = await db.healthCheck.findMany({ where: { component: 'goals' }, select: { at: true, detail: true } });
    expect(written).toHaveLength(4);
    for (const w of written) expect(Math.abs(w.at.getTime() - Date.now())).toBeLessThan(60_000);
    // The rows of one statement share their time, as one health run's checks always have.
    expect(new Set(written.filter((w) => w.detail === 'many').map((w) => w.at.getTime())).size).toBe(1);
    await withClient(urls.owner, (c) => c.query(`DELETE FROM "HealthCheck" WHERE component = 'goals'`));
  });

  it('a card two weeks old opens the gate only with suggestions inside those two weeks: an old one alone is not two weeks of evidence', async () => {
    // Sixteen days ago, and nothing since but the forged one above, which is rejected (the gate is not asked to count it).
    await rejectProposal(db, 'prbackdated1', {}, undefined, 'will:console');
    const old = await suggested(16 * DAY, 1);
    expect(old).toBeTruthy();
    // The 8-day-old card and the forged one are inside the window; take them out of it to see the gate alone.
    await withClient(urls.owner, async (c) => {
      await c.query('ALTER TABLE "Proposal" DISABLE TRIGGER "Proposal_transition"');
      await c.query(`UPDATE "Proposal" SET "createdAt" = $1, "expiresAt" = $2 WHERE action = 'goal.propose' AND id <> $3`, [new Date(now.getTime() - 20 * DAY), new Date(now.getTime() - 19 * DAY), old]);
      await c.query('ALTER TABLE "Proposal" ENABLE TRIGGER "Proposal_transition"');
    });
    expect(await refusal(table())).toBe('409: the shadow weeks do not count yet: Flint suggested no goals from chat in the last 14 days');
  });

  it('after two weeks: one row, goal.propose ALONE at 3 a day; the card counts what Will did with the suggestions, the one that opened the gate among them', async () => {
    // Fourteen days and an hour ago: old enough to open the gate, and inside the 14 days the gate and the card count.
    const opener = await suggested(14 * DAY + HOUR, 1);
    const waiting = await suggested(1 * DAY);
    const turnedDown = await suggested(2 * DAY);
    await rejectProposal(db, turnedDown, {}, undefined, 'will:console');
    expect(await expireProposals(db)).toBeGreaterThanOrEqual(1);
    expect(await db.proposal.findUniqueOrThrow({ where: { id: opener } })).toMatchObject({ status: 'expired' });
    const t = await table();
    expect(PolicyArgs.safeParse({ rows: t.rows }).success).toBe(true);
    expect(t.rows).toEqual([{ pattern: 'goal.propose', tier: 'alone', dailyCap: 3, reason: 'P3 chat promotion table, after the shadow weeks', expiresAt: t.rows[0]!.expiresAt }]);
    const card = await db.proposal.findUniqueOrThrow({ where: { id: t.proposalId } });
    expect(card).toMatchObject({ templateId: 'p3c.promotion', kind: 'policy', origin: 'cli', consequential: true });
    // In the 14 days: the opener (expired), the one rejected, the one still waiting. The older ones are before them.
    const since = windowStart(TZ, now, 14);
    expect(card.reason).toBe(`This lets Flint suggest goals from your chats without asking until ${new Date(t.rows[0]!.expiresAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}. `
      + `Since ${dayWords(TZ, since)}, Flint suggested 3 goals from chat: you approved 0, rejected 1, and 1 expired.`);
    expect(noteProblems('Let Flint Suggest Goals from Chat', card.reason!)).toEqual([]);
    expect(card.reason).not.toContain(CANARY);
    expect(await db.proposal.findUniqueOrThrow({ where: { id: waiting } })).toMatchObject({ status: 'pending' });
    expect(await table({ now: new Date(now.getTime() + 60_000) })).toMatchObject({ proposalId: t.proposalId, deduped: true });
  });

  it('a planted card with its own cap and no mark is not the table: the database refuses the unmarked one outright, and the table files its own beside the other', async () => {
    const mine = await db.proposal.findFirstOrThrow({ where: { templateId: 'p3c.promotion', status: 'pending' } });
    const rows = [{ pattern: 'goal.propose', tier: 'alone', dailyCap: 2147483647, expiresAt: (mine.args as { rows: Array<{ expiresAt: string }> }).rows[0]!.expiresAt }];
    // As the runtime's own database role, straight into the table: a policy change that does not ask on its own.
    const raw = (consequential: boolean, id: string) => withClient(urls.app, (c) => c.query(
      `INSERT INTO "Proposal" (id, kind, origin, action, "templateId", args, "argsDigest", "argsProvenance", tainted, sensitivity, destructive, consequential, reason, "expiresAt")
       VALUES ($1, 'policy', 'cli', 'policy.change', 'p3c.promotion', $2::jsonb, $3, '{}'::jsonb, false, 'ops', false, $4, 'This lets Flint tidy its notes.', now() + interval '7 days')`,
      [id, JSON.stringify({ rows }), digestOf({ rows }), consequential],
    ));
    const refused = await pgError(raw(false, 'prplantedc0'));
    expect(refused.code).toBe('23514');
    expect(refused.message).toBe('proposal prplantedc0: a policy change always asks on its own');
    // The owner is refused the same: the rule is the table's, not a role's.
    expect((await pgError(withClient(urls.owner, (c) => c.query(
      `INSERT INTO "Proposal" (id, kind, origin, action, args, "argsDigest", "argsProvenance", "expiresAt") VALUES ('prplantedc9', 'policy', 'cli', 'policy.change', $1::jsonb, $2, '{}'::jsonb, now() + interval '1 day')`,
      [JSON.stringify({ rows }), digestOf({ rows })],
    )))).code).toBe('23514');
    // Marked, it lands: and the table still does not take it for its own (another cap, and not filed by this command).
    await raw(true, 'prplantedc1');
    await rejectProposal(db, mine.id, {}, undefined, 'will:console');
    const fresh = await table();
    expect(fresh.deduped).toBe(false);
    expect(fresh.proposalId).not.toBe('prplantedc1');
    expect(fresh.rows).toEqual([{ pattern: 'goal.propose', tier: 'alone', dailyCap: 3, reason: 'P3 chat promotion table, after the shadow weeks', expiresAt: fresh.rows[0]!.expiresAt }]);
    await rejectProposal(db, 'prplantedc1', {}, undefined, 'will:console');
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
