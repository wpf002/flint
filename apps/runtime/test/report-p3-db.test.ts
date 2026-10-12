/**
 * The P3 report on flint_test (part 4): each of P3's eight exit criteria,
 * measured from the database as it stands, as numbers.
 *
 *  1. active goals, and how many of their checks Flint reads itself;
 *  2. reviews over 24 hours late in 30 days, counted from Flint's first review:
 *     a goal that was due before reviews ever ran was waiting, not late;
 *  3. how long a watched item's change took to set off its review;
 *  4. plan versions without a signed card behind them, and reviews whose small
 *     changes are on more than one card;
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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GOALS_BLOCK_MAX_TOKENS, GOAL_SAYS, localDay, localDayBounds, previousDay } from '@flint/policy';
import { NO_DB, RUNTIME, freshDb, type TestUrls } from './db';
import { buildApp } from '../src/app';
import type { RuntimeScope } from '../src/config';
import { createDb, type Db } from '../src/db';
import { markProcessed, recordEvent } from '../src/events/record';
import { createProposal } from '../src/governance/proposals';
import { runReview } from '../src/goals/review';
import { p3Report } from '../src/report/p3';
import type { Criterion } from '../src/report/exit';
import { runRollups } from '../src/rollup';
import { CANARY, DAY, FakeBus, MIN, goalFixture, type GoalFixture } from './goals/fixture';
import { HOUR, moveReview } from './goals/weeks';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const SERVER = 'server-token-0123456789abcdef';
const MCP = 'mcp-token-0123456789abcdef01';
const tokens = [
  { name: 'server', sha256: sha(SERVER), scopes: new Set<RuntimeScope>(['events', 'audit', 'proposals', 'world:read', 'ledger', 'counters']) },
  { name: 'runtime-mcp', sha256: sha(MCP), scopes: new Set<RuntimeScope>(['world:read', 'ledger']) },
];
const TZ = 'UTC';

describe('p3-report, the command', () => {
  it('is a script of the runtime, handled by the CLI, and named in its usage beside the promotion table’s phases', () => {
    const pkg = JSON.parse(readFileSync(join(RUNTIME, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['p3-report']).toBe('tsx src/cli.ts p3-report');
    const cli = readFileSync(join(RUNTIME, 'src', 'cli.ts'), 'utf8');
    expect(cli).toContain("if (process.argv[2] === 'p3-report') {");
    expect(cli).toContain('console.log(JSON.stringify(await p3Report(db, { tz: config.tz, planner: config.planner }), null, 2));');
    expect(cli).toMatch(/usage: cli\.ts .*\| p3-report \| promotion-table \[--phase p1\|p2\|p25\|p26\|p3\|p3c\]/);
  });
});

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
      'no suggestion from chat yet: a later part files them (the database already refuses one without a quote)',
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

  it('2 and 6: reviews in the last 30 days, from Flint’s first; a goal that was due before reviews ever ran was waiting, not late', async () => {
    // Reviews turned on ten days ago. g1 was due then; g2 had been due for five days already (it started before reviews did).
    const r1 = await reviewed(g1.id, 'scheduled');
    const r2 = await reviewed(g2.id, 'scheduled');
    await moveReview(urls, r1, ago(10 * DAY), ago(10 * DAY + MIN));
    await moveReview(urls, r2, ago(10 * DAY - MIN), ago(15 * DAY));
    await moveReview(urls, await reviewed(g3.id), ago(4 * DAY));
    expect(await c(2)).toEqual({
      n: 2, name: 'no review more than 24 h late over 30 days', pass: null,
      detail: '3 reviews over 10.0 days (2 scheduled); 0 ran over 24 h late; 0 goals over 24 h past due now (needs 30 days)',
      values: { reviews: 3, scheduled: 2, lateOver24h: 0, overdueNow: 0, days: 10 },
    });
    expect(await c(6)).toMatchObject({ pass: true, detail: '3 reviews; 0 without its goal’s forecast in the ledger', values: { reviews: 3, withoutForecast: 0 } });

    // Yesterday g3's scheduled review ran 25 hours after it was due: that one is late, and the criterion fails at once.
    const r4 = await reviewed(g3.id, 'scheduled');
    await moveReview(urls, r4, ago(DAY), ago(DAY + 25 * HOUR));
    expect(await c(2)).toMatchObject({ pass: false, values: { reviews: 4, scheduled: 3, lateOver24h: 1 } });
    expect((await c(2)).detail).toBe('4 reviews over 10.0 days (3 scheduled); 1 ran over 24 h late; 0 goals over 24 h past due now (needs 30 days)');
    // 23 hours is late for the panel, not for this criterion.
    await moveReview(urls, r4, ago(DAY), ago(DAY + 23 * HOUR));
    expect(await c(2)).toMatchObject({ pass: null, values: { lateOver24h: 0 } });

    // Had reviews begun 31 days ago, g2's five-day wait would have been a late review: the window is what makes it not one.
    await moveReview(urls, r1, ago(31 * DAY), ago(31 * DAY + MIN));
    expect(await c(2)).toMatchObject({ pass: false, values: { reviews: 3, lateOver24h: 1, days: 30 } });
    await moveReview(urls, r2, ago(10 * DAY - MIN), ago(10 * DAY));
    // Thirty days of reviews, none late, none overdue: passed.
    expect(await c(2)).toMatchObject({
      pass: true, detail: '3 reviews over 30.0 days (2 scheduled); 0 ran over 24 h late; 0 goals over 24 h past due now',
      values: { reviews: 3, scheduled: 2, lateOver24h: 0, overdueNow: 0, days: 30 },
    });
    expect(await c(6)).toMatchObject({ pass: true, values: { reviews: 4, withoutForecast: 0 } });
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

  it('4: every plan version has a signed card behind it; a review’s small changes on more than one card fail it', async () => {
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
    // Were a review's small changes ever split across two cards, the criterion would say so.
    const split = await reviewed(g3.id);
    await db.goalReview.update({ where: { id: split }, data: { planner: 'ollama:test-model', diff: [minor('s1', 'prcardC'), minor('s2', 'prcardD')], proposalId: 'prcardC' } });
    expect(await c(4)).toMatchObject({ pass: false, values: { reviewsWithCards: 2, splitMinor: 1 } });
  });

  it('7: suggestions from chat, each resting on Will’s own quoted words (the database refuses any other)', async () => {
    expect(await c(7)).toMatchObject({ pass: null, values: { suggestions: 0, withoutQuote: 0, cleared: 0 } });
    const suggest = (args: Record<string, unknown>, quote: Record<string, unknown> | undefined) => createProposal(db, {
      kind: 'goal', origin: 'chat:c1', action: 'goal.propose', args, argsProvenance: { title: { source: 'model', tainted: false }, ...(quote ? { quote } : {}) } as never,
      tainted: false, sensitivity: 'personal', destructive: false, consequential: false, ttlMinutes: 60,
    }, 'flint');
    await suggest({ title: `${CANARY} run a half marathon`, quote: `${CANARY} I want to run a half marathon` }, { source: 'will', tainted: false });
    // No quote, a quote too short to be one, the model's words as the quote, a quote from a turn that read outside text: none is filed.
    for (const [args, quote] of [
      [{ title: `${CANARY} x` }, undefined],
      [{ title: `${CANARY} x`, quote: 'too short' }, { source: 'will', tainted: false }],
      [{ title: `${CANARY} x`, quote: `${CANARY} the assistant said he should` }, { source: 'model', tainted: false }],
      [{ title: `${CANARY} x`, quote: `${CANARY} I want to do what the page said` }, { source: 'will', tainted: true }],
    ] as const) {
      await expect(suggest(args, quote as Record<string, unknown> | undefined)).rejects.toMatchObject({ status: 400 });
    }
    expect(await c(7)).toEqual({
      n: 7, name: 'nothing is suggested from chat without your own quoted words', pass: true,
      detail: '1 suggestion from chat; 0 without your own quoted words; 0 too old to read',
      values: { suggestions: 1, withoutQuote: 0, cleared: 0 },
    });
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
    expect(GOAL_SAYS.invalid).toBeTruthy();
    expect(lines.join('\n')).not.toContain(CANARY);
  });
});
