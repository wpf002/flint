/**
 * The Predictions panel's views (P4 part 4): what each number's forecast says
 * today, one number open, and how Flint's predictions have done. Read-only.
 *
 * Every sentence is made in predict/phrasing.ts from the row's own numbers, and
 * a state that has no number says so in words. Where a number stands is read
 * the way the nightly runner reads it (the same history, the same `prepare`),
 * so the panel never says "waiting" for a number the runner would forecast, nor
 * shows a range the runner did not record:
 *  - a run recorded for the step now under way: its range, as a forecast when
 *    it beat a plain guess, as "no reliable trend" when it did not, and as
 *    "too early to tell" when the history is too short to judge either way
 *    (the run's verdict is null); a run with no predictions is a steady
 *    number, said with how many of its latest steps are the same and never
 *    more than there are;
 *  - no such run: last night's failed, or the latest number is not in
 *    (waiting), or there is not enough history yet, or none at all, or it is
 *    ready and forecast tonight.
 *
 * These views hold a series' values in words (spend and calendar hours among
 * them). They go to Will's console only, over the runtime's `proposals` scope:
 * nothing here writes a log line, an audit entry or a note.
 */
import { ACCURACY_MIN, localDay, localDayBounds, type AccuracyArea, type AccuracyView, type ForecastRow, type PanelFact, type PredictionsPage, type SeriesView } from '@flint/policy';
import { z } from 'zod';
import type { Db } from '../db.js';
import { FORECAST_WRITER } from '../ledger/emit.js';
import { reliabilityGap, type Bin } from '../ledger/scoring.js';
import { MIN_SCORED } from '../ledger/calibration.js';
import { announcedSince, predictionsStarted } from '../ledger/sweep.js';
import { LEVEL, minHistory, prepare, type ForecastUnit } from './forecast.js';
import { stepIndex, weekOf } from './metrics.js';
import {
  PANEL,
  aboutValue,
  aboveLabel,
  calledSays,
  chanceSays,
  chanceValue,
  earlySays,
  errorScoreSays,
  expectSays,
  gapSays,
  noTrendSays,
  rangesHeldSays,
  recordSays,
  scoredValue,
  shortSays,
  steadySays,
  stepLabel,
  stepRangeSays,
  tooFewSays,
  unsettledSays,
  waitingSays,
} from './phrasing.js';
import { history } from './run.js';
import { questionsWaiting } from './questions.js';
import { FORECAST_SERIES, forecastSeries, freqOf, type ForecastSeriesDef } from './series.js';

export interface ViewDeps {
  tz: string;
  /** Predictions may run on this Mac (FLINT_PREDICT is on). */
  predict: boolean;
  now?: Date;
}

/** The action Will signs to turn numbers on. */
const ENABLE = 'forecast.series.enable';
/** How many of a number's latest ranges its record counts. */
export const RECORD_RANGES = 30;

/** A run's steps as it stored them. Anything else is a run this view cannot read, and says nothing of. */
const Points = z.array(z.object({ at: z.string().datetime({ offset: true }), mean: z.number().finite(), lo: z.number().finite(), hi: z.number().finite() })).min(1).max(64);
type Points = z.infer<typeof Points>;

/** What a number is, for the Turn On sheet: the registry's own description, as a sentence. */
const aboutOf = (def: ForecastSeriesDef): string => `This is ${def.description.charAt(0).toLowerCase()}${def.description.slice(1)}`;

interface Standing {
  state: ForecastRow['state'];
  value: string;
  says: string;
  /** The run behind a range (or a plain guess's range): its steps, level and id. `beatsNaive`: the run's own verdict (null: too early to tell). */
  run?: { id: string; level: number; beatsNaive: boolean | null; points: Points };
}

/** Which numbers are on, as the runner reads it: on, not forgotten, and stored at the step the registry says. */
async function switches(db: Db): Promise<Set<string>> {
  const rows = await db.forecastSeries.findMany({ where: { on: true }, select: { seriesKey: true, series: { select: { description: true, freq: true } } } });
  const on = new Set<string>();
  for (const r of rows) {
    const def = forecastSeries(r.seriesKey);
    if (def && r.series.description !== '[forgotten]' && r.series.freq === freqOf(def)) on.add(def.key);
  }
  return on;
}

/** Where one number stands now. */
async function standingOf(db: Db, def: ForecastSeriesDef, on: boolean, tz: string, now: Date): Promise<Standing> {
  if (!on) return { state: 'off', value: PANEL.values.off, says: PANEL.off };
  const today = localDay(tz, now);
  const targetDay = def.step === 'day' ? today : weekOf(today);
  const at = localDayBounds(tz, targetDay).start;
  const unit = def.unit as ForecastUnit;
  // The run made for the step now under way: the one whose first step starts when this step did.
  const run = await db.forecastRun.findFirst({
    where: { seriesKey: def.key, ok: true, points: { path: ['0', 'at'], equals: at.toISOString() } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, level: true, beatsNaive: true, points: true, _count: { select: { predictions: true } } },
  });
  const points = run ? Points.safeParse(run.points) : undefined;
  const m = def.step === 'day' ? 7 : 1;
  if (run && points?.success) {
    // A run with nothing to score is a steady number's: a flat line, and nothing to ask. It says how many of its
    // latest steps are the same, counted from the history itself (at most the 28 it is judged over).
    if (run._count.predictions === 0) {
      const ready = prepare(await history(db, tz, def, targetDay), stepIndex(def, targetDay), m);
      let same = 0;
      if (ready.ok) for (let i = ready.values.length - 1; i >= 0 && ready.values[i] === ready.values[ready.values.length - 1] && same < 28; i--) same += 1;
      return { state: 'steady', value: PANEL.values.steady, says: steadySays(def.step, ready.ok ? same : undefined) };
    }
    const first = points.data[0]!;
    const range = { lower: first.lo, upper: first.hi, level: run.level, unit };
    const kept = { id: run.id, level: run.level, beatsNaive: run.beatsNaive, points: points.data };
    if (run.beatsNaive === true) return { state: 'range', value: aboutValue(first.mean, unit), says: expectSays({ ...range, point: first.mean }), run: kept };
    // Null is not "did not beat a plain guess": the history is too short to tell (under 56 days, or 26 weeks).
    return run.beatsNaive === null
      ? { state: 'early', value: PANEL.values.early, says: earlySays(range), run: kept }
      : { state: 'no_trend', value: PANEL.values.noTrend, says: noTrendSays(range), run: kept };
  }
  // No forecast of this step. Last night's failed; or it is not ready, and why; or it is, and the next run makes it.
  if (await db.forecastRun.findFirst({ where: { seriesKey: def.key, ok: false, createdAt: { gte: at } }, select: { id: true } })) {
    return { state: 'failed', value: PANEL.values.failed, says: PANEL.failed };
  }
  const values = await history(db, tz, def, targetDay);
  if (!values.size) return { state: 'no_data', value: PANEL.values.noData, says: PANEL.noData };
  const ready = prepare(values, stepIndex(def, targetDay), m);
  if (!ready.ok) {
    if (ready.why === 'late') return { state: 'waiting', value: PANEL.values.waiting, says: waitingSays(def.step) };
    const need = minHistory(m);
    return { state: 'short', value: PANEL.values.short, says: shortSays(def.step, need, Math.max(0, need - (ready.missing ?? need))) };
  }
  return { state: 'tonight', value: PANEL.values.tonight, says: PANEL.tonight };
}

const rowOf = (def: ForecastSeriesDef, on: boolean, s: Standing): ForecastRow => ({ key: def.key, name: def.name, about: aboutOf(def), step: def.step, on, state: s.state, value: s.value, says: s.says });

/** The Turn On Predictions cards that wait for Will's signature, each with the numbers it names. */
async function waitingCards(db: Db, now: Date): Promise<Array<{ id: string; series: string[] }>> {
  const cards = await db.proposal.findMany({ where: { status: 'pending', action: ENABLE, expiresAt: { gt: now } }, orderBy: { createdAt: 'asc' }, take: 20, select: { id: true, args: true } });
  return cards.map((c) => {
    const series = (c.args as { series?: unknown } | null)?.series;
    return { id: c.id, series: Array.isArray(series) ? series.filter((k): k is string => typeof k === 'string') : [] };
  });
}

/** May the header show a dot for questions: only once Will has let Flint ask on its own (the sweep's own reading: announcedSince). */
export async function questionsAnnounced(db: Db, now = new Date()): Promise<boolean> {
  return (await announcedSince(db, now)) !== null;
}

/** The Forecasts tab. */
export async function predictionsPage(db: Db, d: ViewDeps): Promise<PredictionsPage> {
  const now = d.now ?? new Date();
  const on = await switches(db);
  const state: PredictionsPage['state'] = !d.predict ? 'off_here' : on.size ? 'on' : 'off';
  const numbers: ForecastRow[] = [];
  for (const def of FORECAST_SERIES) {
    // With nothing running, no number is read: each row says only that its forecasts are off.
    const live = state === 'on' && on.has(def.key);
    numbers.push(rowOf(def, live, await standingOf(db, def, live, d.tz, now)));
  }
  const cards = await waitingCards(db, now);
  // Switched off on this Mac, nothing can be answered here: nothing is said to wait (as the console's own check says).
  const [questions, announce] = d.predict ? [await questionsWaiting(db, now), await questionsAnnounced(db, now)] : [0, false];
  return { state, numbers, waiting: cards.map((c) => ({ id: c.id, numbers: c.series.length })), questions, announce };
}

/** One number, open. Undefined for a key outside the registry. */
export async function seriesView(db: Db, key: string, d: ViewDeps): Promise<SeriesView | undefined> {
  const def = forecastSeries(key);
  if (!def) return undefined;
  const now = d.now ?? new Date();
  const unit = def.unit as ForecastUnit;
  const live = d.predict && (await switches(db)).has(def.key);
  const s = await standingOf(db, def, live, d.tz, now);
  const forecast: PanelFact[] = [];
  let chance: PanelFact | null = null;
  if (s.run) {
    const run = s.run;
    run.points.slice(0, 8).forEach((p, i) => {
      forecast.push({
        label: i === 0 ? (def.step === 'day' ? 'Today' : 'This Week') : stepLabel(new Date(p.at), d.tz, def.step),
        value: run.beatsNaive === true ? aboutValue(p.mean, unit) : run.beatsNaive === null ? PANEL.values.early : PANEL.values.noTrend,
        says: stepRangeSays({ lower: p.lo, upper: p.hi, level: run.level, unit }, run.beatsNaive === true),
      });
    });
    // The run's yes/no question: the chance its first step runs above a value.
    const q = await db.prediction.findFirst({ where: { forecastRunId: run.id, kind: 'binary', createdBy: FORECAST_WRITER }, select: { probability: true, resolverSpec: true } });
    const threshold = (q?.resolverSpec as { value?: unknown } | null)?.value;
    if (q && q.probability !== null && typeof threshold === 'number' && Number.isFinite(threshold)) {
      chance = { label: aboveLabel(threshold, unit), value: chanceValue(q.probability), says: chanceSays(q.probability, def.step, threshold, unit) };
    }
  }
  // How its latest ranges held: each against the number the series took.
  const settled = await db.prediction.findMany({
    where: { seriesKey: def.key, kind: 'interval', createdBy: FORECAST_WRITER, status: { not: 'void' }, resolution: { is: { outcomeValue: { not: null } } } },
    orderBy: { resolveBy: 'desc' },
    take: RECORD_RANGES,
    select: { lower: true, upper: true, resolution: { select: { outcomeValue: true } } },
  });
  const held = settled.filter((p) => p.lower !== null && p.upper !== null && p.resolution!.outcomeValue! >= p.lower && p.resolution!.outcomeValue! <= p.upper).length;
  const cards = await waitingCards(db, now);
  return { number: rowOf(def, live, s), forecast, chance, record: recordSays(held, settled.length), waiting: cards.some((c) => c.series.includes(def.key)), offHere: !d.predict };
}

/** The areas Flint predicts in, as the console names them, in the order it lists them. */
export const AREAS: ReadonlyArray<readonly [string, string]> = [
  ['spend', 'Spend'], ['deploys', 'Deploys'], ['repos', 'Repos'], ['services', 'Services'], ['projects', 'Projects'], ['calendar', 'Calendar'],
  ['goals', 'Goals'], ['triage', 'Triage'], ['recommendation', 'Advice'], ['assets', 'Assets'], ['selfmod', 'Self Changes'],
];

const StoredBin = z.object({ n: z.number().int().min(0), meanP: z.number().min(0).max(1).nullable(), freq: z.number().min(0).max(1).nullable() }).passthrough();
const pctOf = (x: number): number => Math.round(x * 100);

interface Snapshot {
  kind: string;
  n: number;
  nExpired: number;
  nConditionUnmet: number;
  nVoid: number;
  nLateSuperseded: number;
  brier: number | null;
  baseRate: number | null;
  reliability: unknown;
  intervalCoverage: number | null;
  brierCiLow: number | null;
  brierCiHigh: number | null;
}

/** One area's lines, from its groups' scores pooled by how many results each holds. */
function areaOf(name: string, rows: readonly Snapshot[]): AccuracyArea {
  const yesNo = rows.filter((r) => r.kind === 'binary' && r.n > 0 && r.brier !== null && r.baseRate !== null);
  const ranges = rows.filter((r) => r.kind === 'interval' && r.n > 0 && r.intervalCoverage !== null);
  const bn = yesNo.reduce((t, r) => t + r.n, 0);
  const rn = ranges.reduce((t, r) => t + r.n, 0);
  const lines: string[] = [];
  if (bn >= ACCURACY_MIN) {
    // The ten bins of stated chance, pooled across the area's groups.
    const bins: Array<Pick<Bin, 'n' | 'meanP' | 'freq'>> = Array.from({ length: 10 }, () => ({ n: 0, meanP: null, freq: null }));
    for (const r of yesNo) {
      const stored = z.array(StoredBin).safeParse(r.reliability);
      if (!stored.success) continue;
      stored.data.slice(0, 10).forEach((b, i) => {
        if (!b.n || b.meanP === null || b.freq === null) return;
        const into = bins[i]!;
        const n = into.n + b.n;
        into.meanP = ((into.meanP ?? 0) * into.n + b.meanP * b.n) / n;
        into.freq = ((into.freq ?? 0) * into.n + b.freq * b.n) / n;
        into.n = n;
      });
    }
    // What Flint said most often, and how often that happened.
    const fullest = bins.reduce<Pick<Bin, 'n' | 'meanP' | 'freq'> | undefined>((best, b) => (b.n > 0 && (!best || b.n >= best.n) ? b : best), undefined);
    if (fullest && fullest.meanP !== null && fullest.freq !== null) lines.push(calledSays(pctOf(fullest.meanP), pctOf(fullest.freq), fullest.n));
    const brier = yesNo.reduce((t, r) => t + r.brier! * r.n, 0) / bn;
    const rate = yesNo.reduce((t, r) => t + r.baseRate! * r.n, 0) / bn;
    // Against always guessing the usual rate; unsaid when everything happened or nothing did (there is no guess to beat).
    if (rate > 0 && rate < 1) lines.push(brier < rate * (1 - rate) ? PANEL.better : PANEL.noBetter);
    if (bn >= MIN_SCORED) {
      // The likely range is one group's own: said only when the area is that one group.
      const only = yesNo.length === 1 && yesNo[0]!.brierCiLow !== null && yesNo[0]!.brierCiHigh !== null ? yesNo[0]! : undefined;
      lines.push(only ? errorScoreSays(brier, only.brierCiLow!, only.brierCiHigh!) : errorScoreSays(brier));
      const gap = reliabilityGap(bins);
      if (gap !== null) lines.push(gapSays(pctOf(gap)));
    }
  } else if (bn > 0) lines.push(tooFewSays('binary', bn, ACCURACY_MIN));
  if (rn >= ACCURACY_MIN) lines.push(rangesHeldSays(LEVEL, pctOf(ranges.reduce((t, r) => t + r.intervalCoverage! * r.n, 0) / rn), rn));
  else if (rn > 0) lines.push(tooFewSays('range', rn, ACCURACY_MIN));
  if (!lines.length) lines.push(PANEL.noResults);
  return { name, value: scoredValue(bn + rn), lines };
}

/**
 * The Accuracy tab, from the latest night's scores: counts and shares by area, never a prediction's words or a number
 * it was about. `scoring`: whether anything scores them now, so the panel never says "each night" of a job that
 * is not running (switched off on this Mac, or never turned on).
 */
export async function accuracyView(db: Db, d: Pick<ViewDeps, 'predict'>): Promise<AccuracyView> {
  const scoring: AccuracyView['scoring'] = !d.predict ? 'off_here' : (await predictionsStarted(db)) ? 'on' : 'not_started';
  const latest = await db.calibrationSnapshot.findFirst({ orderBy: { windowEnd: 'desc' }, select: { windowEnd: true } });
  if (!latest) return { scored: false, scoring, areas: [], unsettled: [] };
  const rows = await db.calibrationSnapshot.findMany({ where: { windowEnd: latest.windowEnd } });
  const areas = AREAS.flatMap(([domain, name]) => {
    const own = rows.filter((r) => r.domain === domain);
    return own.length ? [areaOf(name, own)] : [];
  });
  const sum = (f: (r: (typeof rows)[number]) => number) => rows.reduce((t, r) => t + f(r), 0);
  const left: Array<['expired' | 'late' | 'declined' | 'void', number]> = [
    ['expired', sum((r) => r.nExpired)], ['late', sum((r) => r.nLateSuperseded)], ['declined', sum((r) => r.nConditionUnmet)], ['void', sum((r) => r.nVoid)],
  ];
  return { scored: true, scoring, areas, unsettled: left.filter(([, n]) => n > 0).map(([kind, n]) => unsettledSays(kind, n)) };
}
