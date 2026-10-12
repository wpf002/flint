/**
 * The local forecaster, `fc.v1` (P4 part 3): classic forecasters with ranges
 * from their own backtest errors, in plain TypeScript. No outside service, no
 * model, no dependency, no clock and no chance: the same numbers in give the
 * same forecast out, so it is tested against hand-computed fixtures.
 *
 * Input: one series as ordered values at a fixed step (a local day, or a local
 * week), the season `m` (7 for daily, 1 for weekly) and a level (0.8).
 *
 *  1. Candidates. Naive: the last value; the same step one season ago; the
 *     mean of the last 28. Models: simple exponential smoothing (alpha from a
 *     fixed grid by in-sample error); weekly-profile smoothing (take out the
 *     median weekday profile, smooth, put the target weekday back; needs two
 *     seasons); drift (the last value plus the average step); the smoothed
 *     level plus half the recent slope.
 *  2. Rolling backtest. For every origin t from max(2m, n/2) to n - h, each
 *     candidate forecasts step t + h from the first t values.
 *  3. MASE. Scale = the mean absolute one-step change of the whole series.
 *     naiveMase and modelMase are the best naive's and the best model's mean
 *     absolute backtest error over that scale.
 *  4. The verdict. `beatsNaive` is null with fewer than 8 folds (too short to
 *     tell); otherwise the best model must beat the best naive by 5%. The
 *     margin and the three-way naive set are there because picking the best of
 *     several on a short backtest flatters the winner.
 *  5. The forecaster used: the best model when it beat naive, else the best
 *     naive. A forecast that did not beat naive is recorded as a base rate.
 *  6. Point and range. The range is the point plus the lower and upper
 *     empirical quantiles of that forecaster's SIGNED backtest errors, with the
 *     finite-sample correction (the ceil((k + 1) p)-th of k). With fewer than
 *     8 folds: the quantiles of the last 56 values. Nothing goes below 0;
 *     ranges are rounded outward to the unit's step.
 *  7. The yes/no question: is the value above the median of the last 28?
 *     P = the share of the forecaster's predictive sample above it (the point
 *     plus each backtest error; for the 28-value mean, and with fewer than 8
 *     folds, the last 56 values themselves), kept within 5% and 95%.
 *  8. A series whose last 28 values are all equal is steady: a flat line, no
 *     verdict, and no question worth asking.
 */

export const FC_VERSION = 'fc.v1';
export const LEVEL = 0.8;
/** The fewest backtest folds a verdict, and a range from errors, are made from. */
export const MIN_FOLDS = 8;
/** The best model must beat the best naive by this share of its error. */
export const MARGIN = 0.05;
export const SES_ALPHAS = [0.1, 0.2, 0.3, 0.5, 0.7, 0.9] as const;
/** How many steps ahead a run says (only the first becomes a prediction). */
export const STEPS = 7;

export type NaiveName = 'last' | 'seasonal' | 'mean28';
export type ModelName = 'ses' | 'seasonalSes' | 'drift' | 'sesDrift';
export type CandidateName = NaiveName | ModelName;
export type ForecastUnit = 'usd' | 'count' | 'minutes' | 'hours';

const mean = (a: readonly number[]): number => a.reduce((x, y) => x + y, 0) / a.length;
export function median(a: readonly number[]): number {
  const s = [...a].sort((x, y) => x - y);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** The level simple exponential smoothing ends at, with the alpha (from the grid) that had the least in-sample squared error. */
export function sesLevel(y: readonly number[]): number {
  let best: { sse: number; level: number } | undefined;
  for (const a of SES_ALPHAS) {
    let level = y[0]!;
    let sse = 0;
    for (let i = 1; i < y.length; i++) {
      sse += (y[i]! - level) ** 2;
      level = a * y[i]! + (1 - a) * level;
    }
    if (!best || sse < best.sse) best = { sse, level };
  }
  return best!.level;
}

/** The least-squares slope of the values against their position. */
export function slope(y: readonly number[]): number {
  const n = y.length;
  if (n < 2) return 0;
  const mx = (n - 1) / 2;
  const my = mean(y);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - mx) * (y[i]! - my);
    den += (i - mx) ** 2;
  }
  return den ? num / den : 0;
}

/** The median weekday profile: for each position in the season, the median of (value - overall mean). */
export function profile(y: readonly number[], m: number): number[] {
  const overall = mean(y);
  const by: number[][] = Array.from({ length: m }, () => []);
  y.forEach((v, i) => by[i % m]!.push(v - overall));
  return by.map((a) => (a.length ? median(a) : 0));
}

type Forecaster = (y: readonly number[], h: number, m: number) => number;

export const NAIVE: Record<NaiveName, Forecaster> = {
  last: (y) => y[y.length - 1]!,
  seasonal: (y, h, m) => (y.length >= m ? y[y.length - m + ((h - 1) % m)]! : y[y.length - 1]!),
  mean28: (y) => mean(y.slice(-28)),
};

export const MODEL: Record<ModelName, Forecaster> = {
  ses: (y) => sesLevel(y),
  seasonalSes: (y, h, m) => {
    if (m < 2 || y.length < 2 * m) return sesLevel(y);
    const p = profile(y, m);
    return sesLevel(y.map((v, i) => v - p[i % m]!)) + p[(y.length - 1 + h) % m]!;
  },
  drift: (y, h) => (y.length < 2 ? y[y.length - 1]! : y[y.length - 1]! + (h * (y[y.length - 1]! - y[0]!)) / (y.length - 1)),
  sesDrift: (y, h) => sesLevel(y) + (h * slope(y.slice(-28))) / 2,
};

const ALL: Record<CandidateName, Forecaster> = { ...NAIVE, ...MODEL };
const NAIVE_NAMES = Object.keys(NAIVE) as NaiveName[];
/** With no season (weekly series) the weekly profile is plain smoothing: it is left out, not counted twice. */
const modelNames = (m: number): ModelName[] => (Object.keys(MODEL) as ModelName[]).filter((k) => m > 1 || k !== 'seasonalSes');

/** Where the rolling backtest starts: the first origin has max(2m, n/2) values behind it. */
export const minTrain = (n: number, m: number): number => Math.max(2 * m, Math.floor(n / 2));

/** Each candidate's signed errors (actual - forecast) at horizon h, one per origin (only `names`, when given). */
export function backtest(y: readonly number[], h: number, m: number, names: readonly CandidateName[] = Object.keys(ALL) as CandidateName[]): Record<CandidateName, number[]> {
  const out = Object.fromEntries((Object.keys(ALL) as CandidateName[]).map((k) => [k, [] as number[]])) as Record<CandidateName, number[]>;
  for (let t = Math.max(1, minTrain(y.length, m)); t + h <= y.length; t++) {
    const train = y.slice(0, t);
    const actual = y[t + h - 1]!;
    for (const k of names) out[k].push(actual - ALL[k](train, h, m));
  }
  return out;
}

/** The mean absolute one-step change: what an error is measured against. */
export function scaleOf(y: readonly number[]): number {
  if (y.length < 2) return 0;
  let s = 0;
  for (let i = 1; i < y.length; i++) s += Math.abs(y[i]! - y[i - 1]!);
  return s / (y.length - 1);
}

const mae = (errors: readonly number[]): number => mean(errors.map(Math.abs));

/**
 * Did the best model beat the best naive forecast? Null with fewer than 8
 * folds: too short to tell. Otherwise only by the margin: its mean absolute
 * error must be under 95% of the naive one's.
 */
export function verdict(naiveMae: number, modelMae: number, folds: number): boolean | null {
  if (folds < MIN_FOLDS) return null;
  return modelMae < (1 - MARGIN) * naiveMae;
}
/** The first of `names` with the least mean absolute error (ties go to the earlier name: the simpler one). */
function best<T extends CandidateName>(names: readonly T[], errors: Record<CandidateName, number[]>): T {
  return names.reduce((a, b) => (mae(errors[b]) < mae(errors[a]) ? b : a));
}

/**
 * The two ends of a sample at a level, with the finite-sample correction: the
 * upper end is the ceil((k + 1) (1 + level) / 2)-th smallest of k, and the
 * lower end its mirror, so the range holds at least `level` of the time when
 * the future looks like the sample.
 */
export function ends(sample: readonly number[], level: number): { lo: number; hi: number } {
  const s = [...sample].sort((a, b) => a - b);
  const k = s.length;
  const hiAt = Math.min(k, Math.max(1, Math.ceil(((k + 1) * (1 + level)) / 2)));
  const loAt = k + 1 - hiAt;
  return { lo: s[loAt - 1]!, hi: s[hiAt - 1]! };
}

/** What a unit's values are rounded to: whole counts and minutes, cents, hundredths of an hour. */
export const STEP: Record<ForecastUnit, number> = { count: 1, minutes: 1, usd: 0.01, hours: 0.01 };
/** To six places, and never a negative zero. */
const tidy = (x: number): number => Math.round(x * 1e6) / 1e6 + 0;
/** A range's ends rounded outward and its middle to the nearest step; nothing below 0. */
function shaped(point: number, lo: number, hi: number, unit: ForecastUnit): { mean: number; lo: number; hi: number } {
  const step = STEP[unit];
  const p = Math.max(0, point);
  const l = Math.max(0, Math.min(lo, p));
  const u = Math.max(0, Math.max(hi, p));
  return { mean: tidy(Math.round(p / step) * step), lo: tidy(Math.floor(l / step + 1e-9) * step), hi: tidy(Math.ceil(u / step - 1e-9) * step) };
}

export interface ForecastStep {
  /** Steps ahead, from 1. */
  h: number;
  mean: number;
  lo: number;
  hi: number;
}

export interface Forecast {
  version: typeof FC_VERSION;
  level: number;
  /** The forecaster used. */
  pick: CandidateName;
  /** The best naive and the best model at one step ahead (the model is undefined when the backtest had no folds). */
  naive: NaiveName;
  model?: ModelName;
  folds: number;
  /** Null: too short to tell (fewer than 8 folds), or steady. */
  beatsNaive: boolean | null;
  naiveMase: number | null;
  modelMase: number | null;
  scale: number;
  /** The last 28 values are all the same: a flat line, and nothing to ask. */
  steady: boolean;
  steps: ForecastStep[];
  /** The yes/no question for step 1; absent when steady. */
  question?: { threshold: number; probability: number };
}

export interface ForecastOptions {
  /** The season: 7 for a daily series, 1 for a weekly one. */
  m: number;
  unit: ForecastUnit;
  level?: number;
  steps?: number;
}

/** A forecast of the next steps of `y`. `y` needs 2 values or more; the caller decides what is enough history. */
export function forecast(y: readonly number[], o: ForecastOptions): Forecast {
  if (y.length < 2 || y.some((v) => !Number.isFinite(v))) throw new Error('a forecast needs two finite values or more');
  const level = o.level ?? LEVEL;
  const m = Math.max(1, Math.floor(o.m));
  const recent = y.slice(-28);
  const steady = recent.every((v) => v === recent[0]);
  const scale = scaleOf(y);
  const one = backtest(y, 1, m);
  const folds = one.last.length;
  const naive = folds ? best(NAIVE_NAMES, one) : 'last';
  const model = folds ? best(modelNames(m), one) : undefined;
  const naiveMae = folds ? mae(one[naive]) : null;
  const modelMae = folds && model ? mae(one[model]) : null;
  const beatsNaive = steady || naiveMae === null || modelMae === null ? null : verdict(naiveMae, modelMae, folds);
  const pick: CandidateName = beatsNaive && model ? model : naive;
  const window = y.slice(-56);

  const steps: ForecastStep[] = [];
  for (let h = 1; h <= (o.steps ?? STEPS); h++) {
    const point = ALL[pick](y, h, m);
    const errors = h === 1 ? one[pick] : backtest(y, h, m, [pick])[pick];
    // A range from the forecaster's own errors when there are enough of them; else from where the series has been.
    const range = errors.length >= MIN_FOLDS ? { lo: point + ends(errors, level).lo, hi: point + ends(errors, level).hi } : ends(window, level);
    steps.push({ h, ...shaped(point, range.lo, range.hi, o.unit) });
  }

  const out: Forecast = {
    version: FC_VERSION, level, pick, naive, ...(model ? { model } : {}), folds, beatsNaive,
    naiveMase: scale > 0 && naiveMae !== null ? naiveMae / scale : null,
    modelMase: scale > 0 && modelMae !== null ? modelMae / scale : null,
    scale, steady, steps,
  };
  if (!steady) {
    const threshold = tidy(median(recent));
    // The forecaster's predictive sample for the next step: its point moved by each error it made; or, for the mean of
    // the last 28 (and with too few folds), the last 56 values themselves, which is honest for a lumpy series.
    const point = ALL[pick](y, 1, m);
    const sample = folds >= MIN_FOLDS && pick !== 'mean28' ? one[pick].map((e) => Math.max(0, point + e)) : window;
    const share = sample.filter((v) => v > threshold).length / sample.length;
    out.question = { threshold, probability: Math.round(Math.min(0.95, Math.max(0.05, share)) * 100) / 100 };
  }
  return out;
}

/** What makes a series ready to forecast, and the values to forecast from. */
export interface Prepared {
  ok: boolean;
  /** Why not: too few steps (and how many more are needed), or its latest number is too old. */
  why?: 'too_short' | 'stale';
  missing?: number;
  /** The values, oldest first, gaps of one or two steps filled. */
  values: number[];
  /** How many of them were filled in. */
  filled: number;
  /** The index (in steps) of the first value. */
  first: number;
}

/** The fewest steps a forecast is made from: 14 days, or 8 weeks. */
export const minHistory = (m: number): number => (m > 1 ? 14 : 8);
/** The most history a forecast reads. */
export const MAX_HISTORY = 400;
/** A gap of this many steps or fewer is filled; a longer one cuts the history there. */
export const MAX_GAP = 2;

/**
 * Values by step index (0 = the first step ever, `target` = the step being
 * forecast) made into an unbroken history ending at target - 1. The latest
 * number may be one step late (it is filled); older than that, the series is
 * stale. A gap of one or two steps is filled with the value one season before
 * (the previous value when there is none); a longer gap cuts the history: only
 * what came after it is used. At most the last 400 steps.
 */
export function prepare(points: ReadonlyMap<number, number>, target: number, m: number): Prepared {
  const known = [...points.keys()].filter((i) => i < target && Number.isFinite(points.get(i))).sort((a, b) => a - b);
  const need = minHistory(m);
  const last = known[known.length - 1];
  if (last === undefined) return { ok: false, why: 'too_short', missing: need, values: [], filled: 0, first: target };
  if (target - 1 - last > 1) return { ok: false, why: 'stale', values: [], filled: 0, first: target };
  // Walk back from the latest number until a gap too long to fill.
  let first = last;
  for (let i = known.length - 2; i >= 0; i--) {
    if (first - known[i]! - 1 > MAX_GAP) break;
    first = known[i]!;
  }
  // At most the last 400 steps, starting on a number that is there (never on a gap).
  first = known.find((i) => i >= Math.max(first, target - MAX_HISTORY))!;
  const values: number[] = [];
  let filled = 0;
  for (let i = first; i < target; i++) {
    const v = points.get(i);
    if (v !== undefined && Number.isFinite(v)) values.push(v);
    else {
      const at = values.length;
      values.push(at - m >= 0 ? values[at - m]! : values[at - 1]!);
      filled += 1;
    }
  }
  if (values.length < need) return { ok: false, why: 'too_short', missing: need - values.length, values, filled, first };
  return { ok: true, values, filled, first };
}
