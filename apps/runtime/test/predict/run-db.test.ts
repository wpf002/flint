/**
 * The forecast runner on flint_test (P4 part 3): what a night's run records
 * for the numbers Will turned on.
 *
 *  - Only numbers that are on, with enough history, and with the number for
 *    the step just ended in: never a forecast from a made-up latest value.
 *  - One run per input: a second pass records nothing. The next night is a new
 *    input: a new run, about the new day.
 *  - One scored forecast per number and step.
 *  - The method follows the run: `statistical` only when it beat a plain guess,
 *    `base_rate` otherwise, and the database refuses a mismatch.
 *  - One claim of forecast.local's cap per run; the cap chat and triage record
 *    predictions under is not touched.
 *  - Each prediction carries the rule the sweep settles it by, and is due when
 *    the night's numbers are in.
 *  - A steady number gets a run and no predictions.
 *  - A write the database refuses is a refusal; anything else is a failure,
 *    recorded as a failed run and not tried again.
 *  - No network: a spy on fetch sees no call.
 *  - Audit entries and log lines hold counts and series keys, never a value.
 * Synthetic numbers; Flint's zone is UTC here. The clock is read once for the
 * whole file (NOW): every day and every run is worked out from it, so a
 * midnight passing while the file runs moves nothing.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { localDay, periodKey } from '@flint/policy';
import { NO_DB, freshDb, id, type TestUrls } from '../db';
import { CANARY, DAY, HOUR, MIN, TZ, dayStart as kitDayStart, ledgerKit, type LedgerKit } from '../ledger/kit';
import { goalFixture, type GoalFixture } from '../goals/fixture';
import { forecastSeries, freqOf } from '../../src/predict/series';
import { forecast } from '../../src/predict/forecast';
import { DUE_AFTER_MS, FORECAST_ENDPOINT, RUN_FAILED, refusedByDb, runForecasts, runSeries } from '../../src/predict/run';
import { ResolverSpec, verdictFor, type DuePrediction } from '../../src/predict/resolvers';
import { weekOf } from '../../src/predict/metrics';
import { FORECAST_CRON, SERIES_CRON, SNAPSHOT_CRON, SWEEP_CRON } from '../../src/jobs';

describe('what the runner calls a refusal', () => {
  it('the database saying no (a guard, a constraint) is a refusal; anything else it or the code threw is a failure', () => {
    const prisma = (code: string) => Object.assign(new Error('Raw query failed'), { name: 'PrismaClientKnownRequestError', code: 'P2010', meta: { code } });
    // A check, a unique index, a guard's "not allowed", a guard's plain refusal, and "try again at read committed".
    for (const state of ['23514', '23505', '23503', '42501', 'P0001', '40001']) expect(refusedByDb(prisma(state)), state).toBe(true);
    // A column that is not there is a bug; a lost connection is an outage. Neither is the database's answer about the row.
    for (const state of ['42703', '42601', '08006', '57P01', '53300']) expect(refusedByDb(prisma(state)), state).toBe(false);
    expect(refusedByDb(new Error('boom'))).toBe(false);
    expect(refusedByDb(new TypeError('x is not a function'))).toBe(false);
    expect(refusedByDb(Object.assign(new Error('Can\'t reach database server'), { name: 'PrismaClientInitializationError', code: 'P1001' }))).toBe(false);
    expect(refusedByDb(undefined)).toBe(false);
  });

  it('a forecast is due 3.5 hours after its step ends: when the night\'s numbers are kept, in time for the sweep that follows', () => {
    expect(DUE_AFTER_MS).toBe(3.5 * HOUR);
    const at = (cron: string): number => {
      const [minute, hour] = cron.split(' ');
      return Number(hour) * HOUR + Number(minute) * MIN;
    };
    // 03:30: yesterday's numbers are kept. A forecast about yesterday is due then, not before (its number is not in).
    expect(SERIES_CRON).toBe('30 3 * * *');
    expect(at(SERIES_CRON)).toBe(DUE_AFTER_MS);
    // The sweep runs at :40 of every hour, so the 03:40 one is the first to see it due; the scores follow at 03:45, and
    // tonight's forecasts at 03:50, from the numbers kept at 03:30.
    expect(SWEEP_CRON).toBe('40 * * * *');
    expect(3 * HOUR + Number(SWEEP_CRON.split(' ')[0]) * MIN).toBeGreaterThan(DUE_AFTER_MS);
    expect(3 * HOUR + Number(SWEEP_CRON.split(' ')[0]) * MIN - DUE_AFTER_MS).toBeLessThanOrEqual(10 * MIN);
    expect(at(SNAPSHOT_CRON)).toBeGreaterThan(3 * HOUR + 40 * MIN);
    expect(at(FORECAST_CRON)).toBeGreaterThan(at(SNAPSHOT_CRON));
  });
});

describe.skipIf(NO_DB)('the forecast runner on flint_test', () => {
  let urls: TestUrls;
  let k: LedgerKit;
  let g: GoalFixture;
  /** One clock for the whole file, read once. */
  let NOW = new Date();
  const dayStart = (daysAgo: number) => kitDayStart(daysAgo, NOW);
  const said: string[] = [];
  const run = (over: Partial<Parameters<typeof runForecasts>[0]> = {}) => runForecasts({ db: k.db, tz: TZ, now: NOW, log: (m) => void said.push(m), ...over });
  /** A registered number's row, as the Turn On card makes it, turned on (unless told not to). */
  async function number(key: string, on = true): Promise<string> {
    const d = forecastSeries(key)!;
    await k.series({ key: d.key, unit: d.unit, freq: freqOf(d), sensitivity: d.sensitivity, description: d.description });
    if (on) await k.turnOn([key]);
    return key;
  }
  /** Daily values ending yesterday (the last is yesterday's), oldest first. */
  const days = async (key: string, values: number[], endAgo = 1) => {
    for (const [i, v] of values.entries()) await k.point(key, dayStart(endAgo + values.length - 1 - i), v);
  };
  /** The Monday this week began on, and weekly values for the weeks before it (the last is last week's), oldest first. */
  const monday = () => new Date(`${weekOf(localDay(TZ, NOW))}T00:00:00.000Z`);
  const weeks = async (key: string, values: number[], skip: number[] = []) => {
    for (const [i, v] of values.entries()) {
      const ago = values.length - i;
      if (!skip.includes(ago)) await k.point(key, new Date(monday().getTime() - ago * 7 * DAY), v);
    }
  };
  const runs = async (key: string) => (await k.owner(`SELECT * FROM "ForecastRun" WHERE "seriesKey" = $1 ORDER BY "createdAt", id`, [key])).rows;
  /** A number's predictions, the range first; with `at`, only the ones about the step that starts then. */
  const predictions = async (key: string, at?: Date) =>
    (await k.owner(`SELECT * FROM "Prediction" WHERE "seriesKey" = $1 AND ($2::text IS NULL OR "resolverSpec"->>'at' = $2) ORDER BY kind DESC, "createdAt"`, [key, at ? at.toISOString() : null])).rows;
  const counter = async (action: string) => (await k.owner(`SELECT coalesce(sum(count), 0)::int AS n FROM "ActionCounter" WHERE action = $1`, [action])).rows[0].n as number;
  const audits = async (action: string) => (await k.owner(`SELECT actor, context, kind, action, tier, outcome, inputs, reasoning, "outcomeDetail" FROM "AuditEntry" WHERE action = $1 ORDER BY seq DESC`, [action])).rows;
  const line = (n: number) => Array.from({ length: n }, (_, i) => 10 + 2 * i);
  const week = [5, 5, 5, 5, 5, 0, 0];
  const dollars = Array.from({ length: 30 }, (_, i) => Math.round((CANARY / 1000 + i * 0.37) * 100) / 100);

  beforeAll(async () => {
    urls = await freshDb();
    k = await ledgerKit(urls);
    g = await goalFixture(urls, k.db);
    NOW = new Date();
  });
  afterAll(async () => k?.db.$disconnect());

  it('a night\'s run: a run and two predictions for each number that is on and ready; nothing for one that is off, short, or waiting for yesterday\'s number', async () => {
    const fetched = vi.spyOn(globalThis, 'fetch');
    // A rising line, 60 days of it (a model is exact on it, and 56 days are enough to believe one): statistical.
    const deploys = await number('daily.deploys.count');
    await days(deploys, line(60));
    // A pure weekly pattern (last week is exact, so no model beats it): base_rate.
    const hours = await number('daily.calendar.hours');
    await days(hours, Array.from({ length: 56 }, (_, i) => week[i % 7]!));
    // Thirty days of dollars: too short for a model to be believed, so base_rate. Its numbers carry the canary.
    const spend = await number('daily.spend.anthropic.usd');
    await days(spend, dollars);
    // A number that has not changed in a month: steady.
    const downtime = await number('daily.services.incident_minutes');
    await days(downtime, Array.from({ length: 30 }, () => 0));
    // Not ready: ten days of history.
    const threads = await number('daily.threads.open');
    await days(threads, line(10));
    // Late: thirty days of history, but yesterday's number is not in (the last is from two days ago). It is not
    // forecast from a made-up value (review finding 5): it waits a night.
    const late = await number('daily.spend.openai.usd');
    await days(late, line(30), 2);
    // Ready, but never turned on.
    const off = await number('daily.spend.tavily.usd', false);
    await days(off, line(30));
    said.length = 0;
    const before = Date.now();
    const c = await run();
    expect(c).toEqual({ on: 6, ran: 3, steady: 1, same: 0, waiting: 1, late: 1, capped: 0, refused: 0, failed: 0, predictions: 6, allowed: true });
    expect(fetched).not.toHaveBeenCalled();
    fetched.mockRestore();
    expect(said).toEqual([]);

    // The run: made on this Mac, by this method, seven steps from today, from 60 days with none filled in.
    const today = dayStart(0);
    const [r] = await runs(deploys);
    expect(r).toMatchObject({ provider: 'local', endpoint: 'local:fc.v1', horizon: 7, level: 0.8, beatsNaive: true, naiveMase: 1, modelMase: 0, scale: 2, filled: 0, ok: true, error: null });
    expect(FORECAST_ENDPOINT).toBe('local:fc.v1');
    expect(r.requestDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(r.points).toEqual(Array.from({ length: 7 }, (_, i) => ({ at: dayStart(-i).toISOString(), mean: 130 + 2 * i, lo: 130 + 2 * i, hi: 130 + 2 * i })));
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
    expect(r.createdAt.getTime()).toBeGreaterThanOrEqual(before - 5);

    // Its two predictions: a range and a question about today, each with the rule the sweep settles it by.
    const [range, question] = await predictions(deploys);
    const due = new Date(dayStart(-1).getTime() + DUE_AFTER_MS);
    expect(range).toMatchObject({
      kind: 'interval', method: 'statistical', domain: 'deploys', type: 'trend', resolver: 'auto_metric', unit: 'count', forecastRunId: r.id, createdBy: 'runtime:forecast', tainted: false,
      probability: null, pointEstimate: 130, lower: 130, upper: 130, level: 0.8, status: 'open', goalId: null, subjectEntityId: null,
      claim: `daily.deploys.count is between 130 and 130 on ${localDay(TZ, today)}`,
      resolverSpec: { seriesKey: deploys, at: today.toISOString(), op: 'range' }, evidence: [{ kind: 'forecast_run', ref: r.id }],
    });
    expect(range.resolveBy.toISOString()).toBe(due.toISOString());
    // The question is about the whole day, and says so: "on" the day, never "at the resolve time" (review finding 14).
    expect(question).toMatchObject({
      kind: 'binary', method: 'statistical', domain: 'deploys', type: 'threshold_cross', resolver: 'auto_metric', unit: 'count', forecastRunId: r.id, createdBy: 'runtime:forecast',
      probability: 0.9, pointEstimate: null, lower: null, upper: null, level: null,
      claim: `daily.deploys.count is above 101 on ${localDay(TZ, today)}`, resolverSpec: { seriesKey: deploys, at: today.toISOString(), op: 'above', value: 101 },
    });
    expect(question.resolveBy.toISOString()).toBe(due.toISOString());
    for (const p of [range, question]) expect(ResolverSpec.safeParse(p.resolverSpec).success).toBe(true);
    expect((await k.owner(`SELECT count(*)::int AS n FROM "Prediction" WHERE "createdBy" = 'runtime:forecast' AND claim LIKE '%resolve time%'`)).rows[0].n).toBe(0);

    // The method follows the run.
    expect((await runs(hours))[0]).toMatchObject({ beatsNaive: false, naiveMase: 0 });
    expect((await predictions(hours)).map((p) => [p.kind, p.method, p.domain, p.unit])).toEqual([['interval', 'base_rate', 'calendar', 'hours'], ['binary', 'base_rate', 'calendar', 'hours']]);
    // Thirty days: 15 errors at one step and 10 at six, so six steps are said, and the seventh is not.
    expect((await runs(spend))[0]).toMatchObject({ beatsNaive: null, horizon: 6 });
    expect((await runs(spend))[0].points).toHaveLength(6);
    expect((await predictions(spend)).map((p) => [p.kind, p.method, p.domain, p.unit])).toEqual([['interval', 'base_rate', 'spend', 'usd'], ['binary', 'base_rate', 'spend', 'usd']]);
    // And the database has the last word: the other method on either run is refused.
    for (const [key, wrong] of [[deploys, 'base_rate'], [hours, 'statistical']] as const) {
      const rid = (await runs(key))[0].id as string;
      expect(await k.code(k.question(key, dayStart(0), 'below', 1, { forecastRunId: rid, method: wrong, kind: 'binary' }, { madeAgo: 1000, dueAgo: -DAY })), `${key} as ${wrong}`).toMatch(/42501|23505/);
    }
    expect((await k.owner(`SELECT count(*)::int AS n FROM "Prediction" p JOIN "ForecastRun" r ON r.id = p."forecastRunId" WHERE (p.method = 'statistical') <> coalesce(r."beatsNaive", false)`)).rows[0].n).toBe(0);

    // Steady: a run, a flat line, no verdict, and nothing in the ledger.
    expect((await runs(downtime))[0]).toMatchObject({ ok: true, beatsNaive: null, naiveMase: null, modelMase: null, scale: 0 });
    expect((await runs(downtime))[0].points.every((p: { mean: number; lo: number; hi: number }) => p.mean === 0 && p.lo === 0 && p.hi === 0)).toBe(true);
    expect(await predictions(downtime)).toEqual([]);
    // Not ready, late, and not on: nothing at all.
    for (const key of [threads, late, off]) {
      expect(await runs(key), key).toEqual([]);
      expect(await predictions(key), key).toEqual([]);
    }
  });

  it('what it recorded is what the forecaster says for those numbers, to the digit', async () => {
    const spend = 'daily.spend.anthropic.usd';
    const f = forecast(dollars, { m: 7, unit: 'usd' });
    const [r] = await runs(spend);
    expect(r.points.map((p: { mean: number; lo: number; hi: number }) => [p.mean, p.lo, p.hi])).toEqual(f.steps.map((s) => [s.mean, s.lo, s.hi]));
    const [range, question] = await predictions(spend);
    expect([range.pointEstimate, range.lower, range.upper]).toEqual([f.steps[0]!.mean, f.steps[0]!.lo, f.steps[0]!.hi]);
    expect(question.probability).toBe(f.question!.probability);
    expect(question.resolverSpec.value).toBe(f.question!.threshold);
    expect(range.lower).toBeLessThanOrEqual(range.pointEstimate);
    expect(range.pointEstimate).toBeLessThanOrEqual(range.upper);
  });

  it('one run per input: a second pass the same night records nothing; one cap claim per run, and never the cap predictions are recorded under', async () => {
    const before = { runs: (await k.owner(`SELECT count(*)::int AS n FROM "ForecastRun"`)).rows[0].n, predictions: (await k.owner(`SELECT count(*)::int AS n FROM "Prediction"`)).rows[0].n };
    // The first pass claimed once for each run it recorded (three forecasts and the steady one), and nothing for the rest.
    expect(await counter('forecast.local')).toBe(4);
    expect(await counter('ledger.prediction.record')).toBe(0);
    const again = await run();
    expect(again).toEqual({ on: 6, ran: 0, steady: 0, same: 4, waiting: 1, late: 1, capped: 0, refused: 0, failed: 0, predictions: 0, allowed: true });
    expect((await k.owner(`SELECT count(*)::int AS n FROM "ForecastRun"`)).rows[0].n).toBe(before.runs);
    expect((await k.owner(`SELECT count(*)::int AS n FROM "Prediction"`)).rows[0].n).toBe(before.predictions);
    expect(await counter('forecast.local')).toBe(4);
    // And by hand: a second ok run from the same input is refused by the database itself.
    const r = (await runs('daily.deploys.count'))[0];
    expect(await k.code(k.run('daily.deploys.count', { requestDigest: r.requestDigest }))).toBe('23505');
    // More history is a new input: with 24 days, open threads is ready. Ten errors: one step, and no more.
    const threads = 'daily.threads.open';
    await days(threads, Array.from({ length: 14 }, (_, i) => 3 + (i % 4)), 11);
    const next = await run();
    expect(next).toMatchObject({ ran: 1, same: 4, waiting: 0, late: 1 });
    expect(await runs(threads)).toHaveLength(1);
    expect((await runs(threads))[0]).toMatchObject({ horizon: 1, beatsNaive: null });
    expect(await counter('forecast.local')).toBe(5);
    // The late number's own number arrives (yesterday's): the next pass forecasts it.
    await k.point('daily.spend.openai.usd', dayStart(1), 70);
    expect(await run()).toMatchObject({ ran: 1, same: 5, late: 0 });
    // One day of its history was missing and was filled in (two days ago): the run says so.
    await k.past('MetricPoint', 'USER', (q) => q(`DELETE FROM "MetricPoint" WHERE "seriesKey" = 'daily.spend.openai.usd' AND at = $1`, [dayStart(10)]));
    expect((await runs('daily.spend.openai.usd'))[0]).toMatchObject({ filled: 0, ok: true });
  });

  it('the second night: a day on, with the day\'s number in, a new run about the new day (review finding 3)', async () => {
    const deploys = 'daily.deploys.count';
    const first = (await runs(deploys))[0];
    // (The runs this number has so far: the first night's, and one a test above made by hand.)
    const had = new Set((await runs(deploys)).map((x) => x.id as string));
    const made = async () => (await runs(deploys)).filter((x) => !had.has(x.id as string));
    // Tonight becomes last night: today's number is kept (the line goes on: 130), and the clock is a day on.
    await k.point(deploys, dayStart(0), 130);
    const nextNight = new Date(NOW.getTime() + DAY);
    const tomorrow = dayStart(-1);
    const c = await run({ now: nextNight });
    // Only deploys has its latest number: the others wait for theirs.
    expect(c).toMatchObject({ ran: 1, same: 0, failed: 0, refused: 0 });
    expect(c.late).toBeGreaterThanOrEqual(4);
    expect(await made()).toHaveLength(1);
    const second = (await made())[0]!;
    // A new input (one more day), so a new run: about tomorrow, seven steps from there.
    expect(second.requestDigest).not.toBe(first.requestDigest);
    expect(second.points[0]).toEqual({ at: tomorrow.toISOString(), mean: 132, lo: 132, hi: 132 });
    const [range, question] = await predictions(deploys, tomorrow);
    expect(range).toMatchObject({ kind: 'interval', forecastRunId: second.id, pointEstimate: 132, claim: `daily.deploys.count is between 132 and 132 on ${localDay(TZ, tomorrow)}`, resolverSpec: { at: tomorrow.toISOString(), end: dayStart(-2).toISOString() } });
    expect(question).toMatchObject({ kind: 'binary', forecastRunId: second.id, claim: `daily.deploys.count is above 103 on ${localDay(TZ, tomorrow)}`, resolverSpec: { at: tomorrow.toISOString(), value: 103 } });
    expect(range.resolveBy.toISOString()).toBe(new Date(dayStart(-2).getTime() + DUE_AFTER_MS).toISOString());
    // Last night's forecast is still there, about today, untouched.
    expect(await predictions(deploys, dayStart(0))).toHaveLength(2);
    // A second pass the second night records nothing more.
    expect(await run({ now: nextNight })).toMatchObject({ ran: 0, same: 1 });
    expect(await made()).toHaveLength(1);
    // Back on the first night nothing has changed for it: the same input as before.
    expect(await run()).toMatchObject({ ran: 0 });
    expect(await made()).toHaveLength(1);
  });

  it('a weekly number is forecast once a week: the week now running, from the weeks that are over; and once only, whatever comes in later', async () => {
    const commits = await number('weekly.commits.flint.count');
    // Twenty whole weeks before this one, but the week three weeks back is missing.
    await weeks(commits, Array.from({ length: 20 }, (_, i) => 20 + (i % 3)), [3]);
    // The run is made on this week's Thursday: not a Monday, so "the week" is not "today" on any weekday this runs.
    const thursday = new Date(monday().getTime() + 3 * DAY + 4 * HOUR);
    expect(await run({ now: thursday })).toMatchObject({ ran: 1 });
    const [r] = await runs(commits);
    // 20 weeks: 10 errors, so one step, the week that began on Monday. One of the 20 was filled in, and the run says so.
    expect(r).toMatchObject({ horizon: 1, filled: 1, ok: true });
    expect(r.points).toHaveLength(1);
    expect(r.points[0].at).toBe(monday().toISOString());
    const [range, question] = await predictions(commits);
    expect(range).toMatchObject({
      domain: 'repos', unit: 'count', claim: expect.stringContaining(` on ${localDay(TZ, monday())}`),
      resolverSpec: { seriesKey: commits, at: monday().toISOString(), end: new Date(monday().getTime() + 7 * DAY).toISOString(), op: 'range' },
    });
    expect(question.resolverSpec).toMatchObject({ at: monday().toISOString(), op: 'above' });
    // Due once the week is over and its number is in.
    expect(range.resolveBy.toISOString()).toBe(new Date(monday().getTime() + 7 * DAY + DUE_AFTER_MS).toISOString());
    // Any other night this week it is the same input: nothing more.
    const friday = new Date(thursday.getTime() + DAY);
    expect(await run({ now: friday })).toMatchObject({ ran: 0 });
    expect(await runs(commits)).toHaveLength(1);
    // The missing week's number turns up on Friday: a new input. But this week already has its forecast, open and to be
    // scored: a second one beside it would be scored too (review finding 6). None is made.
    await k.point(commits, new Date(monday().getTime() - 3 * 7 * DAY), 99);
    const claimed = await counter('forecast.local');
    expect(await run({ now: friday })).toMatchObject({ ran: 0, refused: 0, failed: 0 });
    expect(await runs(commits)).toHaveLength(1);
    expect(await predictions(commits)).toHaveLength(2);
    expect(await counter('forecast.local')).toBe(claimed);
  });

  it('the rule on each prediction is one the sweep settles: with tomorrow\'s number in, the range gets its value and the question its answer', async () => {
    const deploys = 'daily.deploys.count';
    const [range, question] = await predictions(deploys, dayStart(0));
    // Each as the sweep itself reads it (kit.ts `due`).
    const verdict = async (p: Record<string, unknown>, now: Date, tz = TZ) => {
      const due: DuePrediction = await k.due(p.id as string);
      return k.db.$transaction((tx) => verdictFor(tx, due, { tz, now }));
    };
    // Tonight, before the day is over: not yet. (Its number is in already, from the second night above: taken out for a moment.)
    expect(await verdict(range, NOW)).toEqual({ verdict: 'wait', why: 'step_not_over' });
    await k.past('MetricPoint', 'USER', (q) => q(`DELETE FROM "MetricPoint" WHERE "seriesKey" = $1 AND at = $2`, [deploys, dayStart(0)]));
    // Tomorrow morning with no number: it waits for it.
    const tomorrow = new Date(dayStart(-1).getTime() + 4 * HOUR);
    expect(await verdict(range, tomorrow)).toEqual({ verdict: 'wait', why: 'no_point' });
    // Today's number arrives (the materialiser writes it the next night).
    await k.point(deploys, dayStart(0), 172);
    expect(await verdict(range, tomorrow)).toMatchObject({ verdict: 'resolve', resolvedBy: 'auto_metric', outcomeValue: 172, outcome: null, eventAt: dayStart(-1) });
    expect(await verdict(question, tomorrow)).toMatchObject({ verdict: 'resolve', resolvedBy: 'auto_metric', outcome: true, eventAt: dayStart(-1) });
    // Each rule carries its step's own end, as it was in the zone the forecast was made in. So a zone changed since
    // cannot move the step: settled in Auckland (13 hours ahead), it is still today's UTC day, ending at tomorrow's midnight.
    for (const p of [range, question]) {
      expect(p.resolverSpec).toMatchObject({ at: dayStart(0).toISOString(), end: dayStart(-1).toISOString() });
      expect(ResolverSpec.safeParse(p.resolverSpec).success).toBe(true);
    }
    expect(await verdict(range, tomorrow, 'Pacific/Auckland')).toMatchObject({ verdict: 'resolve', outcomeValue: 172, eventAt: dayStart(-1) });
    expect(await verdict(question, tomorrow, 'Pacific/Auckland')).toMatchObject({ verdict: 'resolve', outcome: true, eventAt: dayStart(-1) });
    // Every prediction the forecaster has written carries one.
    expect((await k.owner(`SELECT count(*)::int AS n FROM "Prediction" WHERE "createdBy" = 'runtime:forecast' AND NOT ("resolverSpec" ? 'end')`)).rows[0].n).toBe(0);
    expect((await k.owner(`SELECT count(*)::int AS n FROM "Prediction" WHERE "createdBy" = 'runtime:forecast'`)).rows[0].n).toBeGreaterThan(0);
  });

  it('a number turned off between the read and the write is refused by the database, counted, and not retried; the log has its key and a class', async () => {
    const key = await number('daily.spend.perplexity.usd');
    await days(key, Array.from({ length: 30 }, (_, i) => Math.round((CANARY / 100 + (i % 7)) * 100) / 100));
    said.length = 0;
    const c = await run({ hooks: { beforeRecord: async (s) => void (s === key && (await k.inTx((q) => q(`UPDATE "ForecastSeries" SET "on" = false WHERE "seriesKey" = $1`, [key]), { actor: 'will:console' }))) } });
    expect(c).toMatchObject({ refused: 1, ran: 0, failed: 0 });
    expect(await runs(key)).toEqual([]);
    expect(await predictions(key)).toEqual([]);
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(new RegExp(`^forecast: ${key.replace(/\./g, '\\.')} was not recorded: PrismaClient[A-Za-z]+( [A-Z0-9_]+)*$`));
    expect(said.join(' ')).not.toMatch(/31337|313\.37|4242/);
    // Off now: the next pass does not read it at all.
    const on = (await k.owner(`SELECT count(*)::int AS n FROM "ForecastSeries" WHERE "on"`)).rows[0].n as number;
    expect(await run()).toMatchObject({ on, refused: 0, ran: 0 });
  });

  it('a failure is a failure, not a refusal: a failed run is recorded with a code and nothing else, shown in the counts, and the same input is not tried or claimed for again', async () => {
    // A weekly number whose values are near the largest a float holds: the forecaster's sums overflow, and it throws
    // rather than hand back a number that is not one (review finding 12).
    const helm = await number('weekly.commits.helm.count');
    await weeks(helm, Array.from({ length: 20 }, (_, i) => (i % 2 ? 1.7e308 : 1e308)));
    const thursday = new Date(monday().getTime() + 3 * DAY + 4 * HOUR);
    const claimed = await counter('forecast.local');
    said.length = 0;
    const c = await run({ now: thursday });
    expect(c).toMatchObject({ failed: 1, refused: 0 });
    const [r] = await runs(helm);
    expect(r).toMatchObject({ ok: false, error: RUN_FAILED, points: [], beatsNaive: null, naiveMase: null, modelMase: null, scale: null, provider: 'local', endpoint: 'local:fc.v1' });
    expect(RUN_FAILED).toBe('forecast_failed');
    expect(await predictions(helm)).toEqual([]);
    expect(await counter('forecast.local')).toBe(claimed + 1);
    // The log says which number and what kind of failure: never a value (and these values are not small).
    expect(said.filter((l) => l.includes(helm))).toEqual([`forecast: ${helm} failed: Error`]);
    expect((await audits('forecast.local'))[0].inputs).toMatchObject({ failed: 1, failedSeries: [helm] });
    // The next pass: the same input failed before. Said again as failed, with no second row and no second claim.
    const again = await run({ now: thursday });
    expect(again).toMatchObject({ failed: 1, refused: 0 });
    expect(await runs(helm)).toHaveLength(1);
    expect(await counter('forecast.local')).toBe(claimed + 1);
    // Something else going wrong (here, thrown just before the write) is a failure too, never counted as a refusal.
    const trident = await number('weekly.commits.trident.count');
    await weeks(trident, Array.from({ length: 20 }, (_, i) => 3 + (i % 4)));
    said.length = 0;
    const broke = await run({ now: thursday, hooks: { beforeRecord: async (s) => { if (s === trident) throw new TypeError('a bug'); } } });
    expect(broke).toMatchObject({ failed: 2, refused: 0, ran: 0 });
    expect((await runs(trident)).map((x) => [x.ok, x.error])).toEqual([[false, RUN_FAILED]]);
    expect(said).toContain(`forecast: ${trident} failed: TypeError`);
    expect(said.join(' ')).not.toContain('a bug');
    expect(await predictions(trident)).toEqual([]);
    // Turned off again, so the tests below count without them.
    for (const key of [helm, trident]) await k.inTx((q) => q(`UPDATE "ForecastSeries" SET "on" = false WHERE "seriesKey" = $1`, [key]), { actor: 'will:console' });
  });

  it('the daily cap stops the night where it is reached; a rule that forbids forecasting, or recording predictions, stops it all', async () => {
    // Two more numbers that are ready, and a cap of one more run today than was already claimed.
    const a = await number('weekly.commits.nexus.count');
    await weeks(a, Array.from({ length: 20 }, (_, i) => 3 + (i % 4)));
    // (Tavily has had its thirty days since the first test, and was never on.)
    const b = 'daily.spend.tavily.usd';
    await k.turnOn([b]);
    // (The cap is a day's: what was claimed today, not on the other nights the tests above ran.)
    const today = async () => (await k.owner(`SELECT coalesce(sum(count), 0)::int AS n FROM "ActionCounter" WHERE action = 'forecast.local' AND day = $1`, [periodKey({ period: 'day' }, TZ, NOW)])).rows[0].n as number;
    const claimed = await today();
    await g.policy('forecast.local', 'alone', claimed + 1);
    const c = await run();
    expect(c).toMatchObject({ ran: 1, capped: 1, allowed: true });
    expect(await today()).toBe(claimed + 1);
    expect([(await runs(a)).length, (await runs(b)).length].sort()).toEqual([0, 1]);
    expect((await audits('forecast.local'))[0]).toMatchObject({ tier: 'alone', outcome: 'ok', inputs: { capped: 1, ran: 1 } });
    // A rule that forbids recording predictions stops forecasts too, though they never use its cap.
    await g.policy('ledger.prediction.record', 'forbidden');
    const before = (await k.owner(`SELECT count(*)::int AS n FROM "ForecastRun"`)).rows[0].n;
    expect(await run()).toMatchObject({ allowed: false, ran: 0, same: 0, waiting: 0 });
    expect((await audits('forecast.local'))[0]).toMatchObject({ outcome: 'skipped', inputs: { recordTier: 'forbidden', ran: 0 } });
    expect((await k.owner(`SELECT count(*)::int AS n FROM "ForecastRun"`)).rows[0].n).toBe(before);
  });

  it('the night\'s numbers are kept only for numbers that are on; a rule that forbids keeping them stops it', async () => {
    // A deployment seen three days ago and again yesterday, and the runtime up all week.
    await k.db.runtimeInstance.create({ data: { id: id('ri'), gitSha: 'dev', startedAt: dayStart(8), lastBeatAt: new Date() } });
    const { applyObservation } = await import('../../src/world/mapper');
    const dep = (sha: string, at: Date) => k.db.$transaction((tx) => applyObservation(tx, { kind: 'deployment', key: 'deployment:studio:flint', name: 'flint on the Studio', state: { target: 'studio', status: 'success', sha }, source: 'git', externalId: 'studio:flint', observedAt: at, actor: 'source:git' }));
    await dep('a'.repeat(40), new Date(dayStart(3).getTime() + 10 * HOUR));
    await dep('b'.repeat(40), new Date(dayStart(1).getTime() + 10 * HOUR));
    const fetched = vi.spyOn(globalThis, 'fetch');
    const before = (await k.owner(`SELECT count(*)::int AS n FROM "MetricPoint" WHERE "seriesKey" = 'daily.spend.perplexity.usd'`)).rows[0].n;
    const c = await runSeries({ db: k.db, tz: TZ, now: NOW });
    expect(fetched).not.toHaveBeenCalled();
    fetched.mockRestore();
    expect(c).toMatchObject({ ran: true, failed: 0 });
    expect(c.on).toBeGreaterThanOrEqual(6);
    // (daily.deploys.count already had numbers through yesterday from the tests above: nothing before its first is filled in.)
    // A number that is off (perplexity, turned off above) is not read at all.
    expect((await k.owner(`SELECT count(*)::int AS n FROM "MetricPoint" WHERE "seriesKey" = 'daily.spend.perplexity.usd'`)).rows[0].n).toBe(before);
    expect((await k.db.metricSeries.findUniqueOrThrow({ where: { key: 'daily.spend.perplexity.usd' } })).readTo).toBeNull();
    // Each number that is on now remembers where it was read to: the start of today.
    expect((await k.db.metricSeries.findUniqueOrThrow({ where: { key: 'daily.deploys.count' } })).readTo!.toISOString()).toBe(dayStart(0).toISOString());
    const [entry] = await audits('forecast.series.build');
    expect(entry).toMatchObject({ actor: 'runtime:forecast', context: 'autonomous', kind: 'action', tier: 'approval', outcome: 'ok', reasoning: null, outcomeDetail: null });
    expect(Object.keys(entry.inputs).sort()).toEqual(['down', 'failed', 'on', 'written']);
    await g.policy('forecast.series.build', 'forbidden');
    expect(await runSeries({ db: k.db, tz: TZ, now: NOW })).toMatchObject({ ran: false, written: 0 });
    expect((await audits('forecast.series.build'))[0]).toMatchObject({ tier: 'forbidden', outcome: 'skipped' });
  });

  it('audit entries hold counts and series keys only: never a value, a claim or a range', async () => {
    const entries = await audits('forecast.local');
    expect(entries.length).toBeGreaterThanOrEqual(6);
    for (const e of entries) {
      expect(e).toMatchObject({ actor: 'runtime:forecast', context: 'autonomous', kind: 'action', reasoning: null, outcomeDetail: null });
      const { failedSeries, ...counts } = e.inputs as Record<string, unknown>;
      expect(Object.keys(counts).sort()).toEqual(['capped', 'failed', 'late', 'on', 'predictions', 'ran', 'recordTier', 'refused', 'same', 'steady', 'waiting']);
      for (const [name, v] of Object.entries(counts)) expect(typeof v, name).toBe(name === 'recordTier' ? 'string' : 'number');
      // Which numbers failed, by key (a registry key is not a value), and nothing else.
      if (failedSeries !== undefined) for (const key of failedSeries as string[]) expect(forecastSeries(key), key).toBeTruthy();
    }
    expect(JSON.stringify([entries, await audits('forecast.series.build')])).not.toMatch(/31337|313\.37|31\.34|4242|between|above|e\+308/);
    expect(await counter('ledger.prediction.record')).toBe(0);
  });
});
