/**
 * The P3 report on flint_test (part 4): each of P3's eight exit criteria,
 * measured from the database as it stands, as numbers.
 *
 *  1. active goals, and how many of their checks Flint reads itself;
 *  2. reviews over 24 hours late in 30 days, counted from Flint's first review.
 *     Late is time waited while Flint was reviewing, as part 3 counts it, read
 *     from the mark each review left on its own audit entry: a goal that was
 *     due while reviews were off, or the Mac asleep, was waiting, not late. And
 *     reviews must have been on for each whole day counted: a month with
 *     reviews off is a fail, not a clean month;
 *  3. how long a watched item's change took to set off its review;
 *  4. plan versions without a signed card behind them, and reviews that filed
 *     their small changes on more than one card (a card a review found waiting
 *     and kept is the earlier review's);
 *  5. started goals without a signed approval behind their latest change;
 *  6. reviews without their goal's forecast;
 *  7. suggestions from chat without Will's own quoted words;
 *  8. the goals block's size in chat, from the daily rollup and today's turns.
 * A criterion with nothing to measure yet says null, never pass. The report is
 * served on world:read (the scope a model's tools hold), so it carries no goal
 * text and no id: a canary proves it.
 * Synthetic text only.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { GOALS_BLOCK_MAX_TOKENS, digestOf, localDay, localDayBounds, previousDay } from '@flint/policy';
import { NO_DB, RUNTIME, freshDb, healthRows, withClient, type TestUrls, withoutChatGoalFloor } from './db';
import { buildApp } from '../src/app';
import type { RuntimeScope } from '../src/config';
import { createDb, type Db } from '../src/db';
import { markProcessed, recordEvent } from '../src/events/record';
import { rejectProposal } from '../src/governance/proposals';
import { takeCandidate } from '../src/goals/candidates';
import { runReview } from '../src/goals/review';
import { p3Report } from '../src/report/p3';
import type { Criterion } from '../src/report/exit';
import { runRollups } from '../src/rollup';
import { CANARY, DAY, FakeBus, MIN, goalFixture, type GoalFixture } from './goals/fixture';
import { HOUR, daysBefore, goalReviewsRan, moveReview, reviewing } from './goals/weeks';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const SERVER = 'server-token-0123456789abcdef';
const MCP = 'mcp-token-0123456789abcdef01';
const tokens = [
  { name: 'server', sha256: sha(SERVER), scopes: new Set<RuntimeScope>(['events', 'audit', 'proposals', 'world:read', 'ledger', 'counters']) },
  { name: 'runtime-mcp', sha256: sha(MCP), scopes: new Set<RuntimeScope>(['world:read', 'ledger']) },
];
const TZ = 'UTC';

describe.skipIf(NO_DB)('the P3 report on flint_test', () => {
  let urls: TestUrls;
  let db: Db;
  let fx: GoalFixture;
  let app: ReturnType<typeof buildApp>;
  const lines: string[] = [];
  const bus = new FakeBus();
  /** A few minutes ahead of the clock: every review the tests make is already in the past (see goals/weeks.ts). */
  let now: Date;
  const report = async (at: Date = now) => (await p3Report(db, { tz: TZ, planner: true }, at)).criteria;
  const c = async (n: number, at: Date = now): Promise<Criterion> => (await report(at)).find((x) => x.n === n)!;
  async function reviewed(goalId: string, kind: 'requested' | 'scheduled' = 'requested', triggerEventId?: string): Promise<string> {
    const g = await db.goal.findUniqueOrThrow({ where: { id: goalId } });
    const job = triggerEventId ? { goalId, kind: 'triggered' as const, triggerEventId } : kind === 'scheduled' ? { goalId, kind, dueAt: g.nextReviewAt!.toISOString() } : { goalId, kind };
    const r = await runReview({ db, bus, tz: TZ }, job);
    if (r.outcome !== 'reviewed') throw new Error(`not reviewed: ${r.outcome}`);
    return r.reviewId;
  }
  let nEvent = 0;
  const turn = (at: Date, ctxTokens?: Record<string, number>) => db.$transaction(async (tx) => {
    const id = (await recordEvent(tx, {
      source: 'server', sourceRef: `p3r:${nEvent++}:${Math.random()}`, type: 'chat.turn', occurredAt: at, sensitivity: 'ops', tainted: false,
      payload: { brain: 'local', outcome: 'answered', tools: [], ms: 900, tainted: false, ...(ctxTokens ? { ctxTokens } : {}) },
    }, at))!;
    await markProcessed(tx, id, 'applied', at);
  });
  let g1: { id: string; title: string };
  let g2: { id: string; title: string };
  let g3: { id: string; title: string };
  let pr: string;
  const ago = (ms: number) => new Date(now.getTime() - ms);
  /** One statement as the tables' owner with that table's rules switched off: the only way to leave a row the database refuses. */
  const tamper = (table: string, sql: string, params: unknown[] = []) => withClient(urls.owner, async (c0) => {
    await c0.query('BEGIN');
    try {
      await c0.query(`ALTER TABLE "${table}" DISABLE TRIGGER USER`);
      await c0.query(sql, params);
      await c0.query(`ALTER TABLE "${table}" ENABLE TRIGGER USER`);
      await c0.query('COMMIT');
    } catch (err) {
      await c0.query('ROLLBACK');
      throw err;
    }
  });

  beforeAll(async () => {
    urls = await freshDb();
    db = createDb(urls.app);
    fx = await goalFixture(urls, db);
    app = buildApp({ db, config: { tokens, tz: TZ, planner: true }, logger: true, logStream: { write: (l: string) => void lines.push(l) } });
    now = new Date(Date.now() + 5 * MIN);
  });
  afterAll(async () => {
    await app?.close();
    await db?.$disconnect();
  });

  it('with nothing yet: eight criteria, none passed, each saying what it is waiting for', async () => {
    const all = await report();
    expect(all.map((x) => x.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(all.map((x) => x.pass)).toEqual([false, null, null, null, null, null, null, null]);
    expect(all.map((x) => x.detail)).toEqual([
      '0 active goals; 0 of 0 checks read by Flint itself (a step or an item), the rest marked by hand',
      'no review yet',
      'no watched change has set off a review yet; checked by test/goals/tick-db.test.ts in every deploy gate',
      'no plan yet',
      '0 goals started; 0 without a signed approval behind its latest change (the database refuses one: test/p3-guards-db.test.ts in every deploy gate)',
      '0 reviews; 0 without its goal’s forecast in the ledger',
      'no suggestion from chat yet (the server files them once it is told to; the database refuses one without a quote)',
      'no chat turn has carried the goals block yet (FLINT_GOALS_NOW on the server; only turns a local model answers carry it)',
    ]);
    // With reviews switched off, criterion 2 says why there is none.
    expect((await p3Report(db, { tz: TZ }, now)).criteria[1]!.detail).toBe('no review yet: reviews are off (FLINT_PLANNER)');
  });

  it('1 and 5: three active goals pass; their checks are counted, and each started goal has a signed approval behind it', async () => {
    pr = await fx.pullRequest(201, 'open');
    g1 = await fx.activeGoal({
      successCriteria: [fx.crit('c1', { kind: 'item', entityId: pr, key: 'state', value: 'merged' }), fx.crit('c2', { kind: 'steps', keys: ['s1'] })],
      links: [{ entityId: pr, role: 'target', watchPaths: ['state'] }],
      plan: { ops: [fx.step('s1'), fx.step('s2')] },
    });
    g2 = await fx.activeGoal();
    expect(await c(1)).toMatchObject({ pass: false, values: { activeGoals: 2, checks: 3, machineChecks: 2 } });
    g3 = await fx.activeGoal({ successCriteria: [fx.crit('c1'), fx.crit('c2')] });
    expect(await c(1)).toEqual({
      n: 1, name: 'at least 3 active goals, with checks Flint reads itself where it can', pass: true,
      detail: '3 active goals; 2 of 5 checks read by Flint itself (a step or an item), the rest marked by hand',
      values: { activeGoals: 3, checks: 5, machineChecks: 2 },
    });
    expect(await c(5)).toMatchObject({ pass: true, values: { started: 3, unsigned: 0 } });
    // A paused goal is no longer active, and is still a goal Will started with his signature.
    const paused = await fx.activeGoal();
    expect((await app.inject({ method: 'POST', url: `/v1/goals/${paused.id}/pause`, payload: {}, headers: { authorization: `Bearer ${SERVER}` } })).statusCode).toBe(200);
    expect((await c(1)).values).toMatchObject({ activeGoals: 3 });
    expect(await c(5)).toMatchObject({ pass: true, values: { started: 4, unsigned: 0 } });
  });

  it('2 and 6: reviews in the last 30 days, from Flint’s first; late is what each review recorded of its own wait, and reviews must have been on for each day counted', async () => {
    const marks = async (reviewId: string) => (await db.auditEntry.findFirstOrThrow({ where: { correlationId: reviewId, action: 'goal.review.local' }, orderBy: { seq: 'asc' } })).inputs as { late?: boolean; lateOverDay?: boolean };
    const due = (goalId: string, when: Date) => db.goal.update({ where: { id: goalId }, data: { nextReviewAt: when } });
    const days = (n: number) => daysBefore(TZ, now, n);
    // Reviews turned on ten days ago: Flint's first review, and the health check has found them on every day since.
    const r1 = await reviewed(g1.id, 'scheduled');
    await moveReview(urls, r1, ago(10 * DAY), ago(10 * DAY + MIN));
    await goalReviewsRan(urls, days(9));
    // g2 had been due for five days when reviews came on (it started before they did). It runs now: it was waiting, not late.
    await due(g2.id, new Date(Date.now() - 5 * DAY));
    const r2 = await reviewed(g2.id, 'scheduled');
    expect(await marks(r2)).not.toHaveProperty('late');
    await moveReview(urls, await reviewed(g3.id), ago(4 * DAY));
    expect(await c(2)).toEqual({
      n: 2, name: 'no review more than 24 h late over 30 days', pass: null,
      detail: '3 reviews over 10.0 days (2 scheduled); 0 ran over an hour late, 0 over 24 h; 0 goals over 24 h past due now; reviews were on all day on 9 of the 9 days before today (needs 30 days)',
      values: { reviews: 3, scheduled: 2, lateOverHour: 0, lateOver24h: 0, overdueNow: 0, days: 10, daysCounted: 9, daysOn: 9 },
    });
    expect(await c(6)).toMatchObject({ pass: true, detail: '3 reviews; 0 without its goal’s forecast in the ledger', values: { reviews: 3, withoutForecast: 0 } });

    // g3's scheduled review was due two hours ago, and Flint was reviewing all that time: it runs late, as the digest
    // counts late. Over an hour is said, and is no outage.
    await due(g3.id, new Date(Date.now() - 2 * HOUR));
    await reviewing(urls, new Date(Date.now() - 2 * HOUR), new Date());
    const hourLate = await reviewed(g3.id, 'scheduled');
    expect(await marks(hourLate)).toEqual(expect.objectContaining({ late: true }));
    expect(await marks(hourLate)).not.toHaveProperty('lateOverDay');
    expect(await c(2)).toMatchObject({ pass: null, values: { reviews: 4, scheduled: 3, lateOverHour: 1, lateOver24h: 0 } });

    // A goal a day past its review right now, with Flint reviewing all the while, fails it.
    const next = (await db.goal.findUniqueOrThrow({ where: { id: g1.id } })).nextReviewAt!;
    await due(g1.id, ago(30 * HOUR));
    expect(await c(2)).toMatchObject({ pass: null, values: { overdueNow: 0 } });
    await reviewing(urls, ago(30 * HOUR), new Date(now.getTime() - MIN));
    expect(await c(2)).toMatchObject({ pass: false, values: { overdueNow: 1 } });
    await due(g1.id, next);
    expect(await c(2)).toMatchObject({ pass: null, values: { overdueNow: 0 } });

    // Thirty days of reviews, on every day, none a day late, none overdue: passed. (The first review is now before the window.)
    await moveReview(urls, r1, ago(31 * DAY), ago(31 * DAY + MIN));
    expect(await c(2)).toMatchObject({ pass: false, values: { daysCounted: 30, daysOn: 9 } });
    await goalReviewsRan(urls, days(30).slice(9));
    const clean = {
      pass: true, detail: '3 reviews over 30.0 days (2 scheduled); 1 ran over an hour late, 0 over 24 h; 0 goals over 24 h past due now; reviews were on all day on 30 of the 30 days before today',
      values: { reviews: 3, scheduled: 2, lateOverHour: 1, lateOver24h: 0, overdueNow: 0, days: 30, daysCounted: 30, daysOn: 30 },
    };
    expect(await c(2)).toMatchObject(clean);
    expect(await c(6)).toMatchObject({ pass: true, values: { reviews: 4, withoutForecast: 0 } });

    // Due 25 hours ago with Flint reviewing all that time: that one is late by a day, and the criterion fails at once.
    await due(g3.id, new Date(Date.now() - 25 * HOUR));
    await reviewing(urls, new Date(Date.now() - 25 * HOUR), new Date());
    const dayLate = await reviewed(g3.id, 'scheduled');
    expect(await marks(dayLate)).toMatchObject({ late: true, lateOverDay: true });
    expect(await c(2)).toMatchObject({ pass: false, values: { reviews: 4, scheduled: 3, lateOverHour: 2, lateOver24h: 1, daysOn: 30 } });
    expect((await c(2)).detail).toBe('4 reviews over 30.0 days (3 scheduled); 2 ran over an hour late, 1 over 24 h; 0 goals over 24 h past due now; reviews were on all day on 30 of the 30 days before today');
    // The mark is the review's own. Retention deleting the health rows the wait was counted from changes nothing.
    await withClient(urls.owner, (c0) => c0.query(`DELETE FROM "HealthCheck" WHERE component = 'goals' AND at > $1`, [ago(32 * HOUR)]));
    await goalReviewsRan(urls, days(2));
    expect(await c(2)).toMatchObject({ pass: false, values: { lateOver24h: 1, daysOn: 30 } });
    // It ages out of the 30 days, like any review.
    await moveReview(urls, dayLate, ago(40 * DAY));
    expect(await c(2)).toMatchObject(clean);
  });

  it('2: a month with reviews off is a fail, never a clean month: nothing ran late because nothing ran', async () => {
    // The health check found reviews off (FLINT_PLANNER) on every one of the last 30 days, in place of what it found above.
    const on = await withClient(urls.owner, async (c0) => (await c0.query(`DELETE FROM "HealthCheck" WHERE component = 'goals' RETURNING status, detail, at`)).rows as Array<{ status: string; detail: string | null; at: Date }>);
    await goalReviewsRan(urls, daysBefore(TZ, now, 30), 'disabled');
    const off = await c(2);
    expect(off).toMatchObject({ pass: false, values: { lateOver24h: 0, overdueNow: 0, daysCounted: 30, daysOn: 0 } });
    expect(off.detail).toContain('reviews were on all day on 0 of the 30 days before today');
    // So is a month a rule stopped them for, and one the health check never looked in.
    await withClient(urls.owner, (c0) => c0.query(`DELETE FROM "HealthCheck" WHERE component = 'goals'`));
    expect(await c(2)).toMatchObject({ pass: false, values: { daysOn: 0 } });
    // (Back to the month that was lived, for the criteria below.)
    await healthRows(urls, on.map((r) => ({ component: 'goals', status: r.status, detail: r.detail, at: r.at })));
    expect(await c(2)).toMatchObject({ pass: true, values: { daysOn: 30 } });
  });

  it('3: a watched item’s change to its review, in seconds; over 10 minutes fails', async () => {
    expect(await c(3)).toMatchObject({ pass: null, values: { triggered: 0, slowestS: null, over10Min: 0 } });
    // The pull request g1 watches is merged; its sync records the change, and the review it sets off names that version.
    await fx.pullRequest(201, 'merged');
    const v1 = await fx.latestVersion(pr);
    const quick = await reviewed(g1.id, 'requested', `version:${v1.id}`);
    const first = await c(3);
    expect(first).toMatchObject({ pass: true, values: { triggered: 1, over10Min: 0 } });
    expect(first.values.slowestS as number).toBeLessThan(60);
    expect(first.detail).toMatch(/^1 review set off by a watched change in 30 days; the slowest took \d+ s; 0 took over 10 min$/);
    // Three and a half minutes, the tick's worst case: still inside.
    await moveReview(urls, quick, new Date(v1.recordedAt.getTime() + 3.5 * MIN));
    expect(await c(3)).toMatchObject({ pass: true, values: { triggered: 1, slowestS: 210, over10Min: 0 } });
    // A second change whose review took eleven minutes.
    await fx.pullRequest(201, 'closed');
    const v2 = await fx.latestVersion(pr);
    expect(v2.id).not.toBe(v1.id);
    await moveReview(urls, await reviewed(g1.id, 'requested', `version:${v2.id}`), new Date(v2.recordedAt.getTime() + 11 * MIN));
    expect(await c(3)).toMatchObject({
      pass: false, detail: '2 reviews set off by a watched change in 30 days; the slowest took 660 s; 1 took over 10 min',
      values: { triggered: 2, slowestS: 660, over10Min: 1 },
    });
  });

  it('4: every plan version has a signed card behind it; the small changes a review filed on more than one card fail it, a card it kept waiting does not', async () => {
    // g1's plan came with its signed goal card.
    expect(await c(4)).toMatchObject({ pass: true, values: { planVersions: 1, withoutCard: 0, reviewsWithCards: 0, splitMinor: 0 } });
    // Will adds a step: a plan change he signs. The old version is superseded, the new one active; both are counted.
    await fx.fileSignRun('plan.change', { goalId: g1.id, goalTitle: g1.title, ops: [fx.step('s3')] });
    expect(await db.plan.count({ where: { goalId: g1.id } })).toBe(2);
    expect(await c(4)).toMatchObject({ pass: true, values: { planVersions: 2, withoutCard: 0 } });

    // A review whose two small changes went on one card, and its bigger change on a card of its own.
    const minor = (key: string, card: string | null, held: string | null = null) => ({ change: { op: 'status', key, status: 'blocked' }, class: 'minor', card, held });
    const material = (card: string | null, held: string | null = null) => ({ change: { op: 'skip', key: 's2' }, class: 'material', card, held });
    const one = await reviewed(g1.id);
    await db.goalReview.update({ where: { id: one }, data: { planner: 'ollama:test-model', diff: [minor('s1', 'prcardA'), minor('s2', 'prcardA'), material('prcardB')], proposalId: 'prcardA' } });
    // A trial-week review filed nothing: it is not a review with cards.
    const trial = await reviewed(g2.id);
    await db.goalReview.update({ where: { id: trial }, data: { planner: 'ollama:test-model', diff: [minor('s1', null, 'shadow'), material(null, 'shadow')] } });
    expect(await c(4)).toEqual({
      n: 4, name: 'every plan change is a signed card, and a review’s small changes share one', pass: true,
      detail: '2 plan versions, 0 without a signed card behind it; 1 review filed cards, 0 with small changes on more than one',
      values: { planVersions: 2, withoutCard: 0, reviewsWithCards: 1, splitMinor: 0 },
    });
    // The goal's next review found card A still waiting and kept it (a waiting card is Will's, and is not filed again),
    // and filed its one new small change on a card of its own. Each review filed one small card: nothing was split.
    const next = await reviewed(g1.id);
    await db.goalReview.update({ where: { id: next }, data: { planner: 'ollama:test-model', diff: [minor('s1', 'prcardA'), minor('s3', 'prcardE')], proposalId: 'prcardE' } });
    // And a review that only found cards waiting filed none.
    const quiet = await reviewed(g1.id);
    await db.goalReview.update({ where: { id: quiet }, data: { planner: 'ollama:test-model', diff: [minor('s1', 'prcardA'), minor('s3', 'prcardE'), material('prcardB')], proposalId: 'prcardA' } });
    expect(await c(4)).toMatchObject({
      pass: true, detail: '2 plan versions, 0 without a signed card behind it; 2 reviews filed cards, 0 with small changes on more than one',
      values: { reviewsWithCards: 2, splitMinor: 0 },
    });
    // Were the small changes a review filed ever split across two cards, the criterion would say so.
    const split = await reviewed(g3.id);
    await db.goalReview.update({ where: { id: split }, data: { planner: 'ollama:test-model', diff: [minor('s1', 'prcardC'), minor('s2', 'prcardD')], proposalId: 'prcardC' } });
    expect(await c(4)).toMatchObject({ pass: false, values: { reviewsWithCards: 3, splitMinor: 1 } });
    await tamper('GoalReview', `UPDATE "GoalReview" SET diff = '[]'::jsonb WHERE id = $1`, [split]);
    expect(await c(4)).toMatchObject({ pass: true, values: { splitMinor: 0 } });
    // And a plan version with no signed card behind it (the database refuses one; only its owner, with the guards off, can leave one).
    const plan = await db.plan.findFirstOrThrow({ where: { goalId: g1.id, status: 'active' } });
    await tamper('Plan', `UPDATE "Plan" SET "approvalId" = NULL WHERE id = $1`, [plan.id]);
    expect(await c(4)).toMatchObject({ pass: false, detail: expect.stringContaining('2 plan versions, 1 without a signed card behind it'), values: { planVersions: 2, withoutCard: 1 } });
    await tamper('Plan', `UPDATE "Plan" SET "approvalId" = $2 WHERE id = $1`, [plan.id, plan.approvalId]);
    expect(await c(4)).toMatchObject({ pass: true, values: { withoutCard: 0 } });
  });

  it('5 and 6, when they fail: a goal with no signed approval behind it, and a review without its goal’s forecast', async () => {
    // Only the owner, with the guards off, can leave either: the report is what would say so.
    const goal = await db.goal.findUniqueOrThrow({ where: { id: g2.id } });
    await tamper('Goal', `UPDATE "Goal" SET "approvalId" = NULL WHERE id = $1`, [g2.id]);
    const five = await c(5);
    expect(five).toMatchObject({ pass: false, values: { unsigned: 1 } });
    expect(five.detail).toMatch(/^\d+ goals started; 1 without a signed approval behind its latest change/);
    await tamper('Goal', `UPDATE "Goal" SET "approvalId" = $2 WHERE id = $1`, [g2.id, goal.approvalId]);
    expect(await c(5)).toMatchObject({ pass: true, values: { unsigned: 0 } });

    // A review whose forecast is another goal's is a review without its own.
    const mine = await db.goalReview.findFirstOrThrow({ where: { goalId: g1.id }, orderBy: { createdAt: 'desc' } });
    await tamper('Prediction', `UPDATE "Prediction" SET "goalId" = $2 WHERE id = $1`, [mine.predictionId, g3.id]);
    const six = await c(6);
    expect(six).toMatchObject({ pass: false, values: { withoutForecast: 1 } });
    expect(six.detail).toMatch(/^\d+ reviews; 1 without its goal’s forecast in the ledger$/);
    await tamper('Prediction', `UPDATE "Prediction" SET "goalId" = $2 WHERE id = $1`, [mine.predictionId, g1.id]);
    expect(await c(6)).toMatchObject({ pass: true, values: { withoutForecast: 0 } });
  });

  it('7: suggestions from chat, each resting on Will’s own quoted words (the database refuses any other)', async () => {
    expect(await c(7)).toMatchObject({ pass: null, values: { suggestions: 0, withoutQuote: 0, cleared: 0 } });
    // The way one is filed (part 5): the candidates intake, from the server's check of Will's own words.
    expect(await takeCandidate({ db, tz: TZ }, {
      kind: 'goal', text: `${CANARY} run a half marathon`, quote: `${CANARY} I want to run a half marathon`, conversationId: 'c1', turnId: 't1', sourceAt: new Date(Date.now() - MIN).toISOString(),
    })).toEqual({ outcome: 'filed' });
    // No quote, a quote too short to be one, the model's words as the quote, a quote from a turn that read outside text: the
    // database files none of them, whoever asks (here its own runtime role, straight into the table).
    const raw = (args: Record<string, unknown>, provenance: Record<string, unknown>) => withClient(urls.app, (cl) => cl.query(
      `INSERT INTO "Proposal" (id, kind, origin, action, "templateId", args, "argsDigest", "argsProvenance", tainted, sensitivity, reason, "expiresAt")
       VALUES ($1, 'goal', 'chat:c1', 'goal.propose', 'chat.goal', $2::jsonb, $3, $4::jsonb, false, 'personal', 'x', now() + interval '1 hour')`,
      [`prraw${Math.random().toString(36).slice(2, 10)}`, JSON.stringify(args), digestOf(args), JSON.stringify(provenance)],
    )).then(() => 'filed', (e: { code?: string }) => e.code);
    for (const [args, provenance] of [
      [{ title: `${CANARY} x` }, { title: { source: 'model', tainted: false } }],
      [{ title: `${CANARY} x`, quote: 'too short' }, { quote: { source: 'will', tainted: false } }],
      [{ title: `${CANARY} x`, quote: `${CANARY} the assistant said he should` }, { quote: { source: 'model', tainted: false } }],
      [{ title: `${CANARY} x`, quote: `${CANARY} I want to do what the page said` }, { quote: { source: 'will', tainted: true } }],
    ] as const) {
      expect(await raw(args, provenance)).toBe('23514');
    }
    expect(await c(7)).toEqual({
      n: 7, name: 'nothing is suggested from chat without your own quoted words', pass: true,
      detail: '1 suggestion from chat; 0 without your own quoted words; 0 too old to read; you approved 0, made 0 into goals yourself and rejected 0, and 0 expired',
      values: { suggestions: 1, withoutQuote: 0, cleared: 0, approved: 0, madeGoals: 0, rejected: 0, expired: 0, addedAlone: 0 },
    });
    // One that got past the database's rule (only its owner, with the rule off, can file it) fails the criterion: each way a quote can be missing.
    const bare = (id: string, args: Record<string, unknown>, provenance: Record<string, unknown>) => tamper('Proposal',
      `INSERT INTO "Proposal" (id, kind, origin, action, args, "argsDigest", "argsProvenance", tainted, sensitivity, reason, "expiresAt")
       VALUES ($1, 'goal', 'chat:c1', 'goal.propose', $2::jsonb, $3, $4::jsonb, false, 'personal', 'x', now() + interval '1 hour')`,
      [id, JSON.stringify(args), digestOf(args), JSON.stringify(provenance)]);
    await bare('prnoquote1', { title: 'Synthetic no quote' }, { title: { source: 'model', tainted: false } });
    await bare('prnoquote2', { title: 'Synthetic model quote', quote: 'Synthetic words the model wrote itself' }, { quote: { source: 'model', tainted: false } });
    await bare('prnoquote3', { title: 'Synthetic outside quote', quote: 'Synthetic words from a page it read' }, { quote: { source: 'will', tainted: true } });
    expect(await c(7)).toEqual({
      n: 7, name: 'nothing is suggested from chat without your own quoted words', pass: false,
      detail: '4 suggestions from chat; 3 without your own quoted words; 0 too old to read; you approved 0, made 0 into goals yourself and rejected 0, and 0 expired',
      values: { suggestions: 4, withoutQuote: 3, cleared: 0, approved: 0, madeGoals: 0, rejected: 0, expired: 0, addedAlone: 0 },
    });
    // A card whose args retention has cleared can no longer be read: it is counted as too old, not as a miss.
    for (const id of ['prnoquote1', 'prnoquote2']) {
      await rejectProposal(db, id, {}, undefined, 'will:console');
      await db.$executeRaw`UPDATE "Proposal" SET args = NULL, "argsPurgedAt" = now() WHERE id = ${id}`;
    }
    expect(await c(7)).toMatchObject({ pass: false, detail: '4 suggestions from chat; 1 without your own quoted words; 2 too old to read; you approved 0, made 0 into goals yourself and rejected 2, and 0 expired', values: { suggestions: 4, withoutQuote: 1, cleared: 2, rejected: 2 } });
    await rejectProposal(db, 'prnoquote3', {}, undefined, 'will:console');
    await db.$executeRaw`UPDATE "Proposal" SET args = NULL, "argsPurgedAt" = now() WHERE id = 'prnoquote3'`;
    expect(await c(7)).toMatchObject({ pass: true, values: { withoutQuote: 0, cleared: 3 } });
  });

  it('8, and the daily rollup: the goals block’s mean and largest size on the turns that carried it; over 300 fails', async () => {
    const today = localDayBounds(TZ, localDay(TZ, now)).start;
    const yesterday = localDayBounds(TZ, previousDay(localDay(TZ, now))).start;
    // Yesterday: three turns a local model answered with Will's goals, one frontier turn with World now only, one with neither.
    for (const goals of [120, 180, 240]) await turn(new Date(yesterday.getTime() + HOUR), { goals });
    await turn(new Date(yesterday.getTime() + HOUR), { world: 150 });
    await turn(new Date(yesterday.getTime() + HOUR));
    expect(await runRollups(db, TZ, now)).toMatchObject({ day: previousDay(localDay(TZ, now)) });
    const point = async (key: string) => (await db.metricPoint.findUnique({ where: { seriesKey_at: { seriesKey: key, at: yesterday } } }))?.value;
    expect(await point('p3.ctx_tokens.goals')).toBe(180);
    expect(await point('p3.ctx_tokens.goals_max')).toBe(240);
    expect(await point('p2.ctx_tokens.world')).toBe(150);
    expect(await db.metricSeries.findUnique({ where: { key: 'p3.ctx_tokens.goals_max' } })).toMatchObject({ unit: 'tokens', freq: 'D', sensitivity: 'ops' });
    // Rolling the same day up again adds nothing.
    expect((await runRollups(db, TZ, now)).written).toBe(0);
    expect(await c(8)).toEqual({
      n: 8, name: 'the goals block in chat stays within 300 tokens', pass: true,
      detail: '1 day measured in 30; 180 tokens on average, 240 at most (the limit is 300)',
      values: { days: 1, meanTokens: 180, maxTokens: 240, limit: GOALS_BLOCK_MAX_TOKENS },
    });
    // Today's turns count before tonight's rollup reaches them: exactly at the limit still passes.
    await turn(today, { goals: 300 });
    expect(await c(8)).toMatchObject({ pass: true, values: { days: 2, meanTokens: 240, maxTokens: 300 } });
    // A block over the limit, on any turn, fails the criterion.
    await turn(today, { goals: 301 });
    expect(await c(8)).toMatchObject({ pass: false, detail: '2 days measured in 30; 240 tokens on average, 301 at most (the limit is 300)', values: { maxTokens: 301 } });
  });

  it('a day with no goals block writes no point', async () => {
    const dayStart = localDayBounds(TZ, '2026-03-10').start;
    await turn(new Date(dayStart.getTime() + HOUR), { world: 90 });
    await runRollups(db, TZ, new Date(dayStart.getTime() + DAY + 4 * HOUR));
    expect(await db.metricPoint.count({ where: { seriesKey: { startsWith: 'p3.ctx_tokens.' }, at: dayStart } })).toBe(0);
    expect(await db.metricPoint.count({ where: { seriesKey: 'p2.ctx_tokens.world', at: dayStart } })).toBe(1);
  });

  it('numbers only: the whole report holds no goal text, no title, no id and no ref', async () => {
    const full = await p3Report(db, { tz: TZ, planner: true }, now);
    const text = JSON.stringify(full);
    expect(text).not.toContain(CANARY);
    expect(text).not.toContain('goal#');
    const goals = await db.goal.findMany({ select: { id: true, title: true } });
    expect(goals.length).toBeGreaterThan(3);
    for (const g of goals) {
      expect(text).not.toContain(g.id);
      expect(text).not.toContain(g.title);
    }
    for (const r of await db.goalReview.findMany({ select: { id: true, predictionId: true } })) {
      expect(text).not.toContain(r.id);
      expect(text).not.toContain(r.predictionId);
    }
    expect(text).not.toContain(pr);
    // Every measured value is a number, a boolean or null: there is no field a word could ride in.
    for (const x of full.criteria) for (const [k, v] of Object.entries(x.values)) expect(['number', 'boolean'].includes(typeof v) || v === null, `${x.n}.${k}`).toBe(true);
    // The names and details are the report's own fixed words around those numbers.
    for (const x of full.criteria) expect(`${x.name} ${x.detail}`.replace(/[0-9.]+/g, '#')).toMatch(/^[A-Za-z#’' ,;:()<>≥≤%/._-]+$/);
  });

  it('GET /v1/p3/report: world:read, like P2’s and P2.5’s; the runtime connector’s token may read it and still not one goal', async () => {
    const get = (url: string, token: string | null) => app.inject({ method: 'GET', url, headers: token ? { authorization: `Bearer ${token}` } : {} });
    expect((await get('/v1/p3/report', null)).statusCode).toBe(401);
    for (const token of [SERVER, MCP]) {
      const r = await get('/v1/p3/report', token);
      expect(r.statusCode).toBe(200);
      const body = JSON.parse(r.body) as { at: string; criteria: Criterion[] };
      expect(body.criteria.map((x) => x.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      expect(r.body).not.toContain(CANARY);
    }
    // The same token is refused every route that holds a goal's words.
    for (const url of ['/v1/goals/now', '/v1/goals?tab=active', `/v1/goals/${g1.id}`]) {
      const r = await get(url, MCP);
      expect(r.statusCode, url).toBe(403);
      expect(r.body, url).not.toContain(CANARY);
    }
    expect((await get('/v1/goals/now', SERVER)).statusCode).toBe(200);
    expect(lines.join('\n')).not.toContain(CANARY);
  });

  it('p3-report and promotion-table, the commands: run for real against this database, one prints this very report and the other the gate’s own refusal', async () => {
    // A home of its own, so the commands read no settings but the ones given here.
    const home = mkdtempSync(join(tmpdir(), 'flint-cli-'));
    try {
      const env = { PATH: process.env.PATH ?? '', HOME: home, RUNTIME_ENV_FILE: join(home, 'none.env'), DATABASE_URL: urls.app, FLINT_TZ: TZ, FLINT_PLANNER: 'on' };
      const cli = (...args: string[]) => promisify(execFile)(join(RUNTIME, 'node_modules', '.bin', 'tsx'), [join(RUNTIME, 'src', 'cli.ts'), ...args], { cwd: RUNTIME, env })
        .then((r) => ({ code: 0, stdout: r.stdout, stderr: r.stderr }), (e: { code?: number; stdout?: string; stderr?: string }) => ({ code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }));
      const out = await cli('p3-report');
      expect(out.code, out.stderr).toBe(0);
      const printed = JSON.parse(out.stdout) as { at: string; criteria: Criterion[] };
      // What it printed is the report, measured at the moment it says, with the planner as the settings have it.
      expect(printed.criteria).toEqual((await p3Report(db, { tz: TZ, planner: true }, new Date(printed.at))).criteria);
      expect(printed.criteria.map((x) => x.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      expect(out.stdout).not.toContain(CANARY);
      // The promotion table's command asks the gate, and files nothing it refuses: reviews were switched off a moment ago.
      const cards = () => db.proposal.count({ where: { action: 'policy.change' } });
      const before = await cards();
      await healthRows(urls, [{ component: 'goals', status: 'disabled', at: new Date() }]);
      const gate = await cli('promotion-table', '--phase', 'p3');
      expect(gate.code).not.toBe(0);
      expect(gate.stderr).toContain('the shadow week does not count yet: goal reviews are off right now');
      expect(await cards()).toBe(before);
      // Its other table asks its own gate too, now that the database holds a goal from chat to a signed card or rule: two weeks of goal suggestions.
      const later = await cli('promotion-table', '--phase', 'p3c');
      expect(later.code).not.toBe(0);
      expect(later.stderr).toMatch(/the shadow weeks are not over: \d+(\.\d)? of 14 days of goal suggestions from chat/);
      expect(await cards()).toBe(before);
      // Against a database without that guard (rolled back by its own down.sql), the same command files nothing and says why, in one sentence.
      await withoutChatGoalFloor(urls.owner, async () => {
        const refused = await cli('promotion-table', '--phase', 'p3c');
        expect(refused.code).not.toBe(0);
        expect(refused.stderr).toContain('Suggestions from chat stay cards for now: the database does not yet hold a goal Flint adds from chat to a card you signed.');
      });
      expect(await cards()).toBe(before);
      // A phase it does not have is refused by name.
      const unknown = await cli('promotion-table', '--phase', 'p9');
      expect(unknown.code).not.toBe(0);
      expect(unknown.stderr).toContain('promotion-table: --phase is p1, p2, p25, p26, p3, p3c or nexus');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);
});
