/**
 * The forecast runner on flint_test (P4 part 3): what a night's run records
 * for the numbers Will turned on.
 *
 *  - Only numbers that are on, and only ones with enough history.
 *  - One run per input: a second pass records nothing.
 *  - The method follows the run: `statistical` only when it beat a plain guess,
 *    `base_rate` otherwise, and the database refuses a mismatch.
 *  - One claim of forecast.local's cap per run; the cap chat and triage record
 *    predictions under is not touched.
 *  - Each prediction carries the rule the sweep settles it by.
 *  - A steady number gets a run and no predictions.
 *  - No network: a spy on fetch sees no call.
 *  - Audit entries and log lines hold counts and series keys, never a value.
 * Synthetic numbers; Flint's zone is UTC here.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { localDay } from '@flint/policy';
import { NO_DB, freshDb, id, type TestUrls } from '../db';
import { CANARY, DAY, HOUR, TZ, dayStart, ledgerKit, type LedgerKit } from '../ledger/kit';
import { goalFixture, type GoalFixture } from '../goals/fixture';
import { forecastSeries, freqOf } from '../../src/predict/series';
import { forecast } from '../../src/predict/forecast';
import { DUE_AFTER_MS, FORECAST_ENDPOINT, runForecasts, runSeries } from '../../src/predict/run';
import { ResolverSpec, verdictFor, type DuePrediction } from '../../src/predict/resolvers';
import { weekOf } from '../../src/predict/metrics';

describe.skipIf(NO_DB)('the forecast runner on flint_test', () => {
  let urls: TestUrls;
  let k: LedgerKit;
  let g: GoalFixture;
  const said: string[] = [];
  const run = (over: Partial<Parameters<typeof runForecasts>[0]> = {}) => runForecasts({ db: k.db, tz: TZ, log: (m) => void said.push(m), ...over });
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
  const runs = async (key: string) => (await k.owner(`SELECT * FROM "ForecastRun" WHERE "seriesKey" = $1 ORDER BY "createdAt"`, [key])).rows;
  const predictions = async (key: string) => (await k.owner(`SELECT * FROM "Prediction" WHERE "seriesKey" = $1 ORDER BY kind DESC, "createdAt"`, [key])).rows;
  const counter = async (action: string) => (await k.owner(`SELECT coalesce(sum(count), 0)::int AS n FROM "ActionCounter" WHERE action = $1`, [action])).rows[0].n as number;
  const audits = async (action: string) => (await k.owner(`SELECT actor, context, kind, action, tier, outcome, inputs, reasoning, "outcomeDetail" FROM "AuditEntry" WHERE action = $1 ORDER BY seq DESC`, [action])).rows;
  const line = (n: number) => Array.from({ length: n }, (_, i) => 10 + 2 * i);
  const week = [5, 5, 5, 5, 5, 0, 0];

  beforeAll(async () => {
    urls = await freshDb();
    k = await ledgerKit(urls);
    g = await goalFixture(urls, k.db);
  });
  afterAll(async () => k?.db.$disconnect());

  it('a night\'s run: a run and two predictions for each number that is on and ready; nothing for one that is off, short or stale', async () => {
    const fetched = vi.spyOn(globalThis, 'fetch');
    // A rising line (a model is exact on it): statistical.
    const deploys = await number('daily.deploys.count');
    await days(deploys, line(30));
    // A pure weekly pattern (last week is exact, so no model beats it): base_rate.
    const hours = await number('daily.calendar.hours');
    await days(hours, Array.from({ length: 56 }, (_, i) => week[i % 7]!));
    // Twenty days of dollars: too short to tell, so base_rate. Its numbers carry the canary.
    const spend = await number('daily.spend.anthropic.usd');
    await days(spend, Array.from({ length: 20 }, (_, i) => Math.round((CANARY / 1000 + i * 0.37) * 100) / 100));
    // A number that has not changed in a month: steady.
    const downtime = await number('daily.services.incident_minutes');
    await days(downtime, Array.from({ length: 30 }, () => 0));
    // Not ready: ten days of history; and one whose latest number is three days old.
    const threads = await number('daily.threads.open');
    await days(threads, line(10));
    const stale = await number('daily.spend.openai.usd');
    await days(stale, line(30), 3);
    // Ready, but never turned on.
    const off = await number('daily.spend.tavily.usd', false);
    await days(off, line(30));
    said.length = 0;
    const before = Date.now();
    const c = await run();
    expect(c).toEqual({ on: 6, ran: 3, steady: 1, same: 0, waiting: 2, capped: 0, refused: 0, failed: 0, predictions: 6, allowed: true });
    expect(fetched).not.toHaveBeenCalled();
    fetched.mockRestore();
    expect(said).toEqual([]);

    // The run: made on this Mac, by this method, seven steps from today.
    const today = dayStart(0);
    const [r] = await runs(deploys);
    expect(r).toMatchObject({ provider: 'local', endpoint: 'local:fc.v1', horizon: 7, level: 0.8, beatsNaive: true, naiveMase: 1, modelMase: 0, scale: 2, ok: true, error: null });
    expect(FORECAST_ENDPOINT).toBe('local:fc.v1');
    expect(r.requestDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(r.points).toEqual(Array.from({ length: 7 }, (_, i) => ({ at: dayStart(-i).toISOString(), mean: 70 + 2 * i, lo: 70 + 2 * i, hi: 70 + 2 * i })));
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
    expect(r.createdAt.getTime()).toBeGreaterThanOrEqual(before - 5);

    // Its two predictions: a range and a question about today, each with the rule the sweep settles it by.
    const [range, question] = await predictions(deploys);
    const due = new Date(dayStart(-1).getTime() + DUE_AFTER_MS);
    expect(range).toMatchObject({
      kind: 'interval', method: 'statistical', domain: 'deploys', type: 'trend', resolver: 'auto_metric', unit: 'count', forecastRunId: r.id, createdBy: 'runtime:forecast', tainted: false,
      probability: null, pointEstimate: 70, lower: 70, upper: 70, level: 0.8, status: 'open', goalId: null, subjectEntityId: null,
      claim: `daily.deploys.count is between 70 and 70 on ${localDay(TZ, today)}`,
      resolverSpec: { seriesKey: deploys, at: today.toISOString(), op: 'range' }, evidence: [{ kind: 'forecast_run', ref: r.id }],
    });
    expect(range.resolveBy.toISOString()).toBe(due.toISOString());
    expect(question).toMatchObject({
      kind: 'binary', method: 'statistical', domain: 'deploys', type: 'threshold_cross', resolver: 'auto_metric', unit: 'count', forecastRunId: r.id, createdBy: 'runtime:forecast',
      probability: 0.95, pointEstimate: null, lower: null, upper: null, level: null,
      claim: 'daily.deploys.count is above 41 at the resolve time', resolverSpec: { seriesKey: deploys, at: today.toISOString(), op: 'above', value: 41 },
    });
    expect(question.resolveBy.toISOString()).toBe(due.toISOString());
    for (const p of [range, question]) expect(ResolverSpec.safeParse(p.resolverSpec).success).toBe(true);

    // The method follows the run.
    expect((await runs(hours))[0]).toMatchObject({ beatsNaive: false, naiveMase: 0 });
    expect((await predictions(hours)).map((p) => [p.kind, p.method, p.domain, p.unit])).toEqual([['interval', 'base_rate', 'calendar', 'hours'], ['binary', 'base_rate', 'calendar', 'hours']]);
    expect((await runs(spend))[0]).toMatchObject({ beatsNaive: null });
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
    // Not ready, and not on: nothing at all.
    for (const key of [threads, stale, off]) {
      expect(await runs(key), key).toEqual([]);
      expect(await predictions(key), key).toEqual([]);
    }
  });

  it('what it recorded is what the forecaster says for those numbers, to the digit', async () => {
    const spend = 'daily.spend.anthropic.usd';
    const values = Array.from({ length: 20 }, (_, i) => Math.round((CANARY / 1000 + i * 0.37) * 100) / 100);
    const f = forecast(values, { m: 7, unit: 'usd' });
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
    expect(again).toEqual({ on: 6, ran: 0, steady: 0, same: 4, waiting: 2, capped: 0, refused: 0, failed: 0, predictions: 0, allowed: true });
    expect((await k.owner(`SELECT count(*)::int AS n FROM "ForecastRun"`)).rows[0].n).toBe(before.runs);
    expect((await k.owner(`SELECT count(*)::int AS n FROM "Prediction"`)).rows[0].n).toBe(before.predictions);
    expect(await counter('forecast.local')).toBe(4);
    // And by hand: a second ok run from the same input is refused by the database itself.
    const r = (await runs('daily.deploys.count'))[0];
    expect(await k.code(k.run('daily.deploys.count', { requestDigest: r.requestDigest }))).toBe('23505');
    // A new number in the history is a new input: a new run.
    const threads = 'daily.threads.open';
    await days(threads, [3, 4, 5, 6], 11);
    const next = await run();
    expect(next).toMatchObject({ ran: 1, same: 4, waiting: 1 });
    expect(await runs(threads)).toHaveLength(1);
    expect(await counter('forecast.local')).toBe(5);
  });

  it('a weekly number is forecast once a week: the week now running, from the weeks that are over', async () => {
    const commits = await number('weekly.commits.flint.count');
    const monday = weekOf(localDay(TZ, new Date()));
    const mondayStart = new Date(`${monday}T00:00:00.000Z`);
    // Ten whole weeks, the last one ending yesterday or earlier.
    for (let w = 1; w <= 10; w++) await k.point(commits, new Date(mondayStart.getTime() - w * 7 * DAY), 20 + (w % 3));
    expect(await run()).toMatchObject({ ran: 1 });
    const [r] = await runs(commits);
    expect(r.points).toHaveLength(7);
    expect(r.points[0].at).toBe(mondayStart.toISOString());
    expect(r.points[1].at).toBe(new Date(mondayStart.getTime() + 7 * DAY).toISOString());
    const [range] = await predictions(commits);
    expect(range).toMatchObject({ domain: 'repos', unit: 'count', resolverSpec: { seriesKey: commits, at: mondayStart.toISOString(), end: new Date(mondayStart.getTime() + 7 * DAY).toISOString(), op: 'range' } });
    // Due once the week is over and its number is in.
    expect(range.resolveBy.toISOString()).toBe(new Date(mondayStart.getTime() + 7 * DAY + DUE_AFTER_MS).toISOString());
    // Any other night this week it is the same input: nothing more.
    expect(await run()).toMatchObject({ ran: 0 });
    expect(await runs(commits)).toHaveLength(1);
  });

  it('the rule on each prediction is one the sweep settles: with tomorrow\'s number in, the range gets its value and the question its answer', async () => {
    const deploys = 'daily.deploys.count';
    const [range, question] = await predictions(deploys);
    // Each as the sweep itself reads it (kit.ts `due`).
    const verdict = async (p: Record<string, unknown>, now: Date, tz = TZ) => {
      const due: DuePrediction = await k.due(p.id as string);
      return k.db.$transaction((tx) => verdictFor(tx, due, { tz, now }));
    };
    // Tonight, before the day is over: not yet. Tomorrow morning with no number: it waits for it.
    expect(await verdict(range, new Date())).toEqual({ verdict: 'wait', why: 'step_not_over' });
    const tomorrow = new Date(dayStart(-1).getTime() + 4 * HOUR);
    expect(await verdict(range, tomorrow)).toEqual({ verdict: 'wait', why: 'no_point' });
    // Today's number arrives (the materialiser writes it the next night).
    await k.point(deploys, dayStart(0), 72);
    expect(await verdict(range, tomorrow)).toMatchObject({ verdict: 'resolve', resolvedBy: 'auto_metric', outcomeValue: 72, outcome: null, eventAt: dayStart(-1) });
    expect(await verdict(question, tomorrow)).toMatchObject({ verdict: 'resolve', resolvedBy: 'auto_metric', outcome: true, eventAt: dayStart(-1) });
    // Each rule carries its step's own end, as it was in the zone the forecast was made in. So a zone changed since
    // cannot move the step: settled in Auckland (13 hours ahead), it is still today's UTC day, ending at tomorrow's midnight.
    for (const p of [range, question]) {
      expect(p.resolverSpec).toMatchObject({ at: dayStart(0).toISOString(), end: dayStart(-1).toISOString() });
      expect(ResolverSpec.safeParse(p.resolverSpec).success).toBe(true);
    }
    expect(await verdict(range, tomorrow, 'Pacific/Auckland')).toMatchObject({ verdict: 'resolve', outcomeValue: 72, eventAt: dayStart(-1) });
    expect(await verdict(question, tomorrow, 'Pacific/Auckland')).toMatchObject({ verdict: 'resolve', outcome: true, eventAt: dayStart(-1) });
    // Every prediction the forecaster has written carries one.
    expect((await k.owner(`SELECT count(*)::int AS n FROM "Prediction" WHERE "createdBy" = 'runtime:forecast' AND NOT ("resolverSpec" ? 'end')`)).rows[0].n).toBe(0);
    expect((await k.owner(`SELECT count(*)::int AS n FROM "Prediction" WHERE "createdBy" = 'runtime:forecast'`)).rows[0].n).toBeGreaterThan(0);
    await k.past('MetricPoint', 'USER', (q) => q(`DELETE FROM "MetricPoint" WHERE "seriesKey" = $1 AND at = $2`, [deploys, dayStart(0)]));
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
    // Off now: the next pass does not read it at all (seven others are on).
    expect(await run()).toMatchObject({ on: 7, refused: 0, ran: 0 });
  });

  it('the daily cap stops the night where it is reached; a rule that forbids forecasting, or recording predictions, stops it all', async () => {
    // Two more numbers that are ready, and a cap of one more run today than was already claimed.
    const a = await number('weekly.commits.nexus.count');
    const b = await number('weekly.commits.trident.count');
    const monday = new Date(`${weekOf(localDay(TZ, new Date()))}T00:00:00.000Z`);
    for (const key of [a, b]) for (let w = 1; w <= 10; w++) await k.point(key, new Date(monday.getTime() - w * 7 * DAY), 3 + (w % 4));
    const claimed = await counter('forecast.local');
    await g.policy('forecast.local', 'alone', claimed + 1);
    const c = await run();
    expect(c).toMatchObject({ ran: 1, capped: 1, allowed: true });
    expect(await counter('forecast.local')).toBe(claimed + 1);
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
    const before = (await k.owner(`SELECT count(*)::int AS n FROM "MetricPoint" WHERE "seriesKey" = 'daily.spend.tavily.usd'`)).rows[0].n;
    const c = await runSeries({ db: k.db, tz: TZ });
    expect(fetched).not.toHaveBeenCalled();
    fetched.mockRestore();
    expect(c).toMatchObject({ ran: true, failed: 0 });
    expect(c.on).toBeGreaterThanOrEqual(6);
    // (daily.deploys.count already had numbers through yesterday from the tests above: nothing before its first is filled in.)
    expect((await k.owner(`SELECT count(*)::int AS n FROM "MetricPoint" WHERE "seriesKey" = 'daily.spend.tavily.usd'`)).rows[0].n).toBe(before);
    const [entry] = await audits('forecast.series.build');
    expect(entry).toMatchObject({ actor: 'runtime:forecast', context: 'autonomous', kind: 'action', tier: 'approval', outcome: 'ok', reasoning: null, outcomeDetail: null });
    expect(Object.keys(entry.inputs).sort()).toEqual(['down', 'failed', 'on', 'written']);
    await g.policy('forecast.series.build', 'forbidden');
    expect(await runSeries({ db: k.db, tz: TZ })).toMatchObject({ ran: false, written: 0 });
    expect((await audits('forecast.series.build'))[0]).toMatchObject({ tier: 'forbidden', outcome: 'skipped' });
  });

  it('audit entries hold counts and series keys only: never a value, a claim or a range', async () => {
    const entries = await audits('forecast.local');
    expect(entries.length).toBeGreaterThanOrEqual(6);
    for (const e of entries) {
      expect(e).toMatchObject({ actor: 'runtime:forecast', context: 'autonomous', kind: 'action', reasoning: null, outcomeDetail: null });
      expect(Object.keys(e.inputs).sort()).toEqual(['capped', 'failed', 'on', 'predictions', 'ran', 'recordTier', 'refused', 'same', 'steady', 'waiting']);
      for (const [name, v] of Object.entries(e.inputs)) expect(typeof v, name).toBe(name === 'recordTier' ? 'string' : 'number');
    }
    expect(JSON.stringify([entries, await audits('forecast.series.build')])).not.toMatch(/31337|313\.37|31\.34|4242|between|above/);
    expect(await counter('ledger.prediction.record')).toBe(0);
  });
});
