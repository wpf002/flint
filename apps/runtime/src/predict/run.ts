/**
 * The forecast runner (P4 part 3; queues forecast.series and forecast.run):
 * each night, the numbers Will turned on get their value for the day that just
 * ended, and then a forecast for the day (or week) now beginning. Everything is
 * computed on this Mac, in this process: no outside service, no model, no
 * fetch.
 *
 * For each number that is on:
 *  1. Its history is read and made ready (forecast.ts: 24 days or 19 weeks,
 *     short gaps filled, never more than a fifth of it). The number for the
 *     step just ended must be in: a forecast is never made from a made-up
 *     latest value, so without it the number is late and waits a night. Not
 *     ready: nothing is recorded.
 *  2. One run per input. The run's digest is its input (the series, the values
 *     used, the level, the method's version), and the database keeps one ok
 *     run per series and digest: a second pass over the same numbers, the same
 *     night or any night of the same week, records nothing. A new day's number
 *     is a new input, so each night's forecast is a new run.
 *  3. One scored forecast per number and step: when an open forecast of this
 *     step is already there (a weekly number whose history changed mid-week),
 *     no second one is made.
 *  4. One claim of forecast.local's daily cap per run (the forecast's two
 *     predictions do not use the cap chat and triage record under).
 *  5. In one transaction: the run (with how many of its steps were filled in),
 *     and unless the number is steady, its range and its yes/no question, each
 *     carrying the rule the sweep settles it by. The method follows the run:
 *     `statistical` only when it beat a plain guess, `base_rate` otherwise
 *     (the database refuses any other pairing).
 *
 * What goes wrong is told apart. A write the database refuses (the number was
 * turned off or forgotten meanwhile, or another run got there first) is
 * `refused`: counted, not retried. Anything else (the arithmetic, a lost
 * connection, a bug) is `failed`: a failed run is recorded where one can be,
 * with a code and nothing else, and the same input is not tried or claimed for
 * again. Health shows both.
 *
 * One audit entry per job run: counts and series keys, never a value. Log
 * lines the same.
 */
import { randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { CODE_TABLE, addLocalDays, digestOf, localDay, localDayBounds, resolveTier, runsInShadow, type Cap, type PolicyRow } from '@flint/policy';
import type { Db, Tx } from '../db.js';
import { failureOf, sqlState } from '../dbcodes.js';
import { appendAudit } from '../governance/audit.js';
import { claim } from '../governance/counters.js';
import { activePolicies } from '../governance/proposals.js';
import { FORECAST_WRITER, emitPrediction } from '../ledger/emit.js';
import { FC_VERSION, LEVEL, STEPS, forecast, prepare, type Forecast } from './forecast.js';
import { materialise, stepDay, stepIndex, weekOf, type MetricsDeps } from './metrics.js';
import { stepEnd } from './resolvers.js';
import { FORECAST_SERIES, freqOf, type ForecastSeriesDef } from './series.js';

/** The policy actions of the two jobs. */
export const SERIES_ACTION = 'forecast.series.build';
export const RUN_ACTION = 'forecast.local';
/** The actor on their audit entries (the forecast writer). */
export const FORECAST_ACTOR = FORECAST_WRITER;
/** Where a run was made: this Mac, by this method. */
export const FORECAST_ENDPOINT = `local:${FC_VERSION}`;
/** A forecast is due this long after its step ends: once the night's numbers are in (03:30), in time for the 03:40 sweep. */
export const DUE_AFTER_MS = 3.5 * 3_600_000;
/** What a failed run says of itself: a code, never a message. */
export const RUN_FAILED = 'forecast_failed';

const RANGE_CRITERIA = 'The series’ own number for that step is inside the range, ends included, as Flint records it once the step is over.';
const QUESTION_CRITERIA = 'The series’ own number for that step is above the threshold, as Flint records it once the step is over.';

/**
 * Did the database refuse the write: a guard or a constraint said no (the number was turned off or forgotten since it
 * was read, the run is already there)? Those are its answers. Anything else it or the code threw is a failure.
 */
export function refusedByDb(err: unknown): boolean {
  const state = sqlState(err);
  return state !== undefined && (state.startsWith('23') || state === '42501' || state === 'P0001' || state === '40001');
}

interface Standing {
  may: boolean;
  tier: 'alone' | 'approval' | 'forbidden';
  cap?: Cap;
}
function standing(action: string, policies: readonly PolicyRow[], now: Date): Standing {
  const t = resolveTier(action, { context: 'autonomous', tainted: false, policies, now });
  const cap = t.cap ?? CODE_TABLE[action]?.cap;
  return { may: t.tier === 'alone' || (t.tier === 'approval' && runsInShadow(action)), tier: t.tier, ...(cap ? { cap } : {}) };
}

/** The numbers that are on, with what the registry says each is; a forgotten one, or one the registry does not know, is left out. */
async function seriesOn(db: Db): Promise<ForecastSeriesDef[]> {
  const on = await db.forecastSeries.findMany({ where: { on: true }, select: { seriesKey: true, series: { select: { description: true, freq: true } } }, orderBy: { seriesKey: 'asc' } });
  return on.flatMap((s) => {
    const def = FORECAST_SERIES.find((d) => d.key === s.seriesKey);
    return def && s.series.description !== '[forgotten]' && s.series.freq === freqOf(def) ? [def] : [];
  });
}

export interface SeriesCounts {
  /** Numbers that are on. */
  on: number;
  /** Points written. */
  written: number;
  /** Days left missing because the runtime was down. */
  down: number;
  /** Numbers whose value could not be built. */
  failed: number;
  /** False when a rule forbids the job. */
  ran: boolean;
}

/** The night's numbers: every step that is over, for each number that is on. */
export async function runSeries(d: MetricsDeps & { log?: (msg: string) => void }): Promise<SeriesCounts> {
  const now = d.now ?? new Date();
  const s = standing(SERIES_ACTION, await activePolicies(d.db, now), now);
  const defs = await seriesOn(d.db);
  const counts: SeriesCounts = { on: defs.length, written: 0, down: 0, failed: 0, ran: s.may };
  let failedKeys: string[] = [];
  if (s.may) {
    const m = await materialise({ ...d, now }, defs.map((x) => x.key));
    counts.written = Object.values(m.written).reduce((a, b) => a + b, 0);
    counts.down = m.down;
    counts.failed = m.failed.length;
    failedKeys = m.failed;
    if (m.failed.length) d.log?.(`forecast: ${m.failed.length} number(s) could not be built: ${m.failed.join(', ')}`);
  }
  await appendAudit(d.db, [{
    actor: FORECAST_ACTOR, context: 'autonomous', kind: 'action', action: SERIES_ACTION, tier: s.tier, outcome: s.may ? 'ok' : 'skipped',
    inputs: { on: counts.on, written: counts.written, down: counts.down, failed: counts.failed, ...(failedKeys.length ? { failedSeries: failedKeys.slice(0, 20) } : {}) },
  }]);
  return counts;
}

export interface RunCounts {
  /** Numbers that are on. */
  on: number;
  /** Runs recorded with a forecast (their two predictions with them). */
  ran: number;
  /** Runs recorded for a number that has not changed: a flat line, no predictions. */
  steady: number;
  /** Numbers already forecast from the same input. */
  same: number;
  /** Numbers without enough history yet. */
  waiting: number;
  /** Numbers whose value for the step just ended is not in: not forecast from a made-up one. They wait a night. */
  late: number;
  /** Numbers left for tomorrow: the daily cap was reached. */
  capped: number;
  /** Writes the database refused (the number was turned off meanwhile): not retried. */
  refused: number;
  /** Forecasts that failed: the arithmetic, a lost connection, a bug (a failed run is recorded where one can be). */
  failed: number;
  /** Predictions recorded. */
  predictions: number;
  /** False when a rule forbids forecasting, or recording a prediction. */
  allowed: boolean;
}

const newId = (prefix: string, now: Date) => `${prefix}${now.getTime().toString(36)}${randomBytes(6).toString('hex')}`;

/** A number's history as the forecaster reads it: values by step index, up to the step before the target. (The panel's view reads it the same way.) */
export async function history(db: Db, tz: string, def: ForecastSeriesDef, targetDay: string): Promise<Map<number, number>> {
  const target = stepIndex(def, targetDay);
  const from = localDayBounds(tz, addLocalDays(targetDay, -(def.step === 'day' ? 1 : 7) * 420)).start;
  const rows = await db.metricPoint.findMany({ where: { seriesKey: def.key, at: { gte: from, lt: localDayBounds(tz, targetDay).start } }, select: { at: true, value: true } });
  const out = new Map<number, number>();
  for (const r of rows) {
    const i = stepIndex(def, localDay(tz, r.at));
    if (i < target) out.set(i, r.value);
  }
  return out;
}

/** The run's row and, unless the number is steady, its two predictions. One transaction. */
async function record(tx: Tx, def: ForecastSeriesDef, f: Forecast, o: { tz: string; now: Date; targetDay: string; digest: string; latencyMs: number; filled: number }): Promise<number> {
  const at = localDayBounds(o.tz, o.targetDay).start;
  const stepDays = def.step === 'day' ? 1 : 7;
  const runId = newId('fr', o.now);
  await tx.forecastRun.create({
    data: {
      id: runId, seriesKey: def.key, provider: 'local', endpoint: FORECAST_ENDPOINT, requestDigest: o.digest, horizon: f.steps.length, level: f.level,
      beatsNaive: f.beatsNaive, naiveMase: f.naiveMase, modelMase: f.modelMase, scale: f.scale,
      points: f.steps.map((s) => ({ at: localDayBounds(o.tz, addLocalDays(o.targetDay, (s.h - 1) * stepDays)).start.toISOString(), mean: s.mean, lo: s.lo, hi: s.hi })) as Prisma.InputJsonArray,
      filled: o.filled, latencyMs: o.latencyMs, ok: true,
    },
  });
  if (f.steady || !f.question) return 0;
  const first = f.steps[0]!;
  // The step's end in the zone the forecast is made in. It goes into the rule, so the sweep settles this step and no other even if Flint's zone has changed by then.
  const end = stepEnd(o.tz, at, freqOf(def))!;
  const common = {
    method: f.beatsNaive === true ? ('statistical' as const) : ('base_rate' as const),
    domain: def.domain, evidence: [{ kind: 'forecast_run', ref: runId }], resolver: 'auto_metric' as const,
    resolveBy: new Date(end.getTime() + DUE_AFTER_MS).toISOString(), tainted: false, unit: def.unit, seriesKey: def.key, forecastRunId: runId,
  };
  await emitPrediction(tx, {
    ...common, kind: 'interval', type: 'trend', template: { id: 'series_range', params: { series: def.key, lo: first.lo, hi: first.hi, on: o.targetDay } },
    pointEstimate: first.mean, lower: first.lo, upper: first.hi, level: f.level,
    resolutionCriteria: RANGE_CRITERIA, resolverSpec: { seriesKey: def.key, at: at.toISOString(), end: end.toISOString(), op: 'range' },
  }, FORECAST_WRITER, o.now);
  await emitPrediction(tx, {
    ...common, kind: 'binary', type: 'threshold_cross', probability: f.question.probability, template: { id: 'series_above', params: { series: def.key, value: f.question.threshold, on: o.targetDay } },
    resolutionCriteria: QUESTION_CRITERIA, resolverSpec: { seriesKey: def.key, at: at.toISOString(), end: end.toISOString(), op: 'above', value: f.question.threshold },
  }, FORECAST_WRITER, o.now);
  return 2;
}

export interface RunDeps {
  db: Db;
  tz: string;
  now?: Date;
  log?: (msg: string) => void;
  /** Test seam: called after a number's forecast is computed, before it is written. */
  hooks?: { beforeRecord?: (key: string) => Promise<void> };
}

/** Tonight's forecasts: one run for each number that is on and ready. */
export async function runForecasts(d: RunDeps): Promise<RunCounts> {
  const now = d.now ?? new Date();
  const log = d.log ?? (() => {});
  const policies = await activePolicies(d.db, now);
  const run = standing(RUN_ACTION, policies, now);
  // A forecast's predictions are predictions: a rule that forbids recording one forbids these too (they do not use its cap).
  const recordMay = standing('ledger.prediction.record', policies, now);
  const defs = await seriesOn(d.db);
  const c: RunCounts = { on: defs.length, ran: 0, steady: 0, same: 0, waiting: 0, late: 0, capped: 0, refused: 0, failed: 0, predictions: 0, allowed: run.may && recordMay.may };
  const failedKeys: string[] = [];
  if (c.allowed) {
    const today = localDay(d.tz, now);
    for (const [i, def] of defs.entries()) {
      const targetDay = def.step === 'day' ? today : weekOf(today);
      const m = def.step === 'day' ? 7 : 1;
      /** Once the input is known: its digest, so a failure can be recorded against it and not tried again. */
      let digest: string | undefined;
      const started = performance.now();
      try {
        const ready = prepare(await history(d.db, d.tz, def, targetDay), stepIndex(def, targetDay), m);
        if (!ready.ok) {
          if (ready.why === 'late') c.late += 1;
          else c.waiting += 1;
          continue;
        }
        // The input, whole: what this forecast is of, from which numbers, by which method. Never logged, only digested.
        digest = digestOf({ v: FC_VERSION, series: def.key, step: def.step, unit: def.unit, first: stepDay(def, ready.first), values: ready.values, level: LEVEL, steps: STEPS });
        const before = await d.db.forecastRun.findFirst({ where: { seriesKey: def.key, requestDigest: digest }, orderBy: { ok: 'desc' }, select: { ok: true } });
        if (before?.ok) {
          c.same += 1;
          continue;
        }
        // This input failed before, and it is the same input: said again as failed, with no second claim and no second row.
        if (before) {
          c.failed += 1;
          failedKeys.push(def.key);
          continue;
        }
        // One scored forecast per number and step: an open one of this step is already there (made from an earlier
        // reading of the same history). A second would be scored beside it.
        const at = localDayBounds(d.tz, targetDay).start.toISOString();
        if (await d.db.prediction.findFirst({ where: { seriesKey: def.key, createdBy: FORECAST_WRITER, status: 'open', resolverSpec: { path: ['at'], equals: at } }, select: { id: true } })) {
          c.same += 1;
          continue;
        }
        if (run.cap && (await claim(d.db, RUN_ACTION, run.cap, d.tz, now)) === null) {
          c.capped += defs.length - i;
          break;
        }
        const f = forecast(ready.values, { m, unit: def.unit });
        // From the least history on, the first step has its range; without one there is nothing to say yet.
        if (!f.steps.length) {
          c.waiting += 1;
          continue;
        }
        const latencyMs = Math.max(0, Math.round(performance.now() - started));
        await d.hooks?.beforeRecord?.(def.key);
        c.predictions += await d.db.$transaction((tx: Tx) => record(tx, def, f, { tz: d.tz, now, targetDay, digest: digest!, latencyMs, filled: ready.filled }));
        if (f.steady) c.steady += 1;
        else c.ran += 1;
      } catch (err) {
        if (refusedByDb(err)) {
          // The database refused it (the number was turned off or forgotten since it was read): its class and the key, never a value.
          c.refused += 1;
          log(`forecast: ${def.key} was not recorded: ${failureOf(err)}`);
          continue;
        }
        // Anything else is a failure, and is said as one: counted, logged by its class, and where the input is known,
        // recorded as a failed run (a code and nothing else) so the same input is not tried again.
        c.failed += 1;
        failedKeys.push(def.key);
        log(`forecast: ${def.key} failed: ${failureOf(err)}`);
        if (digest) {
          await d.db.forecastRun
            .create({ data: { id: newId('fr', now), seriesKey: def.key, provider: 'local', endpoint: FORECAST_ENDPOINT, requestDigest: digest, horizon: STEPS, level: LEVEL, points: [], latencyMs: Math.max(0, Math.round(performance.now() - started)), ok: false, error: RUN_FAILED } })
            .catch((again: unknown) => log(`forecast: ${def.key}'s failed run was not recorded: ${failureOf(again)}`));
        }
      }
    }
  }
  await appendAudit(d.db, [{
    actor: FORECAST_ACTOR, context: 'autonomous', kind: 'action', action: RUN_ACTION, tier: run.tier, outcome: c.allowed ? 'ok' : 'skipped',
    inputs: {
      on: c.on, ran: c.ran, steady: c.steady, same: c.same, waiting: c.waiting, late: c.late, capped: c.capped, refused: c.refused, failed: c.failed, predictions: c.predictions,
      recordTier: recordMay.tier, ...(failedKeys.length ? { failedSeries: failedKeys.slice(0, 20) } : {}),
    },
  }]);
  return c;
}
