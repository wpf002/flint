/**
 * The local forecaster, `fc.v1` (P4 part 3): classic forecasters with ranges
 * from their own backtest errors, in plain TypeScript. No outside service, no
 * model, no dependency, no clock and no chance: the same numbers in give the
 * same forecast out, so it is tested against hand-computed fixtures and against
 * simulated series with fixed seeds (test/predict/forecast-sim.test.ts).
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
 *  4. The verdict. The winner of each set is picked on the same backtest that
 *     scores it, and on a short one the best of several looks better than it
 *     is. So `beatsNaive` is null (too short to tell) until the history is 56
 *     daily steps or 26 weekly ones. From then on the best model must beat the
 *     best naive by 5%, and by more than chance: its fold-by-fold gain must
 *     average at least 1.28 standard errors above zero.
 *  5. The forecaster used: the best model when it beat naive, else the best
 *     naive. A forecast that did not beat naive is recorded as a base rate.
 *  6. Point and range. The range is the point plus the lower and upper
 *     empirical quantiles of that forecaster's SIGNED backtest errors, with the
 *     finite-sample correction (the ceil((k + 1) p)-th of k). A range needs 10
 *     errors behind it: with fewer, none is stated, for that step or any later
 *     one (so the first forecast of a number needs 24 days, or 19 weeks).
 *     Nothing goes below 0; ranges are rounded outward to the unit's step.
 *  7. Weekdays. One pool of errors serves a number badly when its weekdays
 *     differ: quiet days get a range far too wide and busy ones one too narrow.
 *     So the errors can be put at the target weekday's own size (onWeekday).
 *     Whether to is decided on the series itself: the backtest is replayed both
 *     ways and the weekday's way is used when its ranges scored better.
 *  8. The yes/no question: is the value above the median of the last 28? Its
 *     chance is the share of recent values above that (the last 56): plain,
 *     and never more than the series has shown. The forecaster's own errors
 *     (the forecast moved by each past error) are used instead only when three
 *     things hold on this series' backtest: the forecast beat the series' own
 *     typical value; that sharper chance, replayed night by night, scored
 *     better (Brier) by the margin; and it never claims more than its record
 *     supports (the share of its past such calls that came true, counted as if
 *     four more had come in, one right and three wrong: it takes 26 right in a
 *     row to say 90%). Kept within 5% and 95%.
 *  9. A series whose last 28 values are all equal is steady: a flat line, no
 *     verdict, and no question worth asking.
 * 10. Every number it returns is finite, or it throws.
 */

export const FC_VERSION = 'fc.v1';
export const LEVEL = 0.8;
/** The fewest backtest folds a verdict is made from. */
export const MIN_FOLDS = 8;
/** A range is stated only with this many of the forecaster's own errors behind it. With 10, the 80% range is their least to their greatest. */
export const MIN_ERRORS = 10;
/** The best model must beat the best naive by this share of its error, and the sharper of two question samples the plainer one by the same. */
export const MARGIN = 0.05;
/** ...and by more than chance: the mean of the fold-by-fold gain must be this many of its standard errors above zero (about nine chances in ten that the edge is real). */
export const SURE = 1.28;
/**
 * The history a model needs before it may be kept over a plain guess: 56 daily steps, 26 weekly ones. The winner is
 * picked on the same backtest that scores it, and on a short one the best of several looks better than it is.
 */
export const modelHistory = (m: number): number => (m > 1 ? 56 : 26);
/** A weekday's own error size is used once every weekday has this many errors. */
export const MIN_PER_WEEKDAY = 2;
/** How much a weekday's own error size leans on the size of all of them: as if it had half an error more, of the usual size. */
export const WEEKDAY_LEAN = 0.5;
/** The weekday's way must have been replayed over at least this many nights before it can be chosen. */
export const WEEKDAY_NIGHTS = 4;
/** The question's sharper chance is replayed from the night the forecaster had this many errors behind it. */
export const MIN_PRIOR = 5;
/**
 * The record a sharper chance starts with: as if four calls had already come in, one right and three wrong. So it
 * takes 26 right in a row before it may say 90%, and a lucky streak of a dozen on a number that is right three times
 * in four cannot.
 */
export const RECORD = { right: 1, wrong: 3 } as const;
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
/** Is one forecaster's edge over another more than chance? The fold-by-fold gain (the first's absolute error less the second's) has a mean at least SURE standard errors above zero. */
export function sure(naive: readonly number[], model: readonly number[]): boolean {
  const d = naive.map((e, i) => Math.abs(e) - Math.abs(model[i]!));
  const k = d.length;
  if (k < 2) return false;
  const mu = mean(d);
  const sd = Math.sqrt(d.reduce((t, x) => t + (x - mu) ** 2, 0) / (k - 1));
  return mu > 0 && (sd === 0 || mu / (sd / Math.sqrt(k)) >= SURE);
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

/**
 * A forecaster's errors as they would be on the target's weekday. One pool of errors serves every weekday badly when
 * some weekdays are quiet and some busy: the quiet days get a range far too wide, the busy ones one too narrow. So each
 * error is measured against the usual size of an error on its own weekday, and the pool is put back at the target
 * weekday's size. All of the errors stay behind the range; only their size follows the weekday. Once every weekday
 * has MIN_PER_WEEKDAY errors; before that, and for a series with no season, the errors come back as they are.
 * `first` is the position in the series of the first error's target.
 */
export function onWeekday(errors: readonly number[], first: number, m: number, target: number): number[] {
  if (m < 2 || !errors.length) return [...errors];
  const by = Array.from({ length: m }, () => ({ n: 0, abs: 0 }));
  errors.forEach((e, f) => {
    const b = by[(first + f) % m]!;
    b.n += 1;
    b.abs += Math.abs(e);
  });
  const usual = mean(errors.map(Math.abs));
  if (!(usual > 0) || by.some((b) => b.n < MIN_PER_WEEKDAY)) return [...errors];
  const size = by.map((b) => (b.abs + WEEKDAY_LEAN * usual) / (b.n + WEEKDAY_LEAN));
  const at = ((target % m) + m) % m;
  // The target weekday's size rests on a handful of errors, and a size guessed too small is a range too narrow: it is
  // widened for how few there are (by the root of one and one over their number).
  const to = size[at]! * Math.sqrt(1 + 1 / by[at]!.n);
  return errors.map((e, f) => (e / size[(first + f) % m]!) * to);
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
  /** The range follows the weekday's own error size (it scored better that way on this series). */
  weekday: boolean;
  steps: ForecastStep[];
  /** The yes/no question for step 1; absent when steady, and when step 1 has no range. `from`: its chance is the share of recent values above the threshold, or (earned on this series) of the forecast moved by each past error. */
  question?: { threshold: number; probability: number; from: 'recent' | 'errors' };
}

export interface ForecastOptions {
  /** The season: 7 for a daily series, 1 for a weekly one. */
  m: number;
  unit: ForecastUnit;
  level?: number;
  steps?: number;
}

const clamp = (p: number): number => Math.min(0.95, Math.max(0.05, p));
const shareAbove = (sample: readonly number[], threshold: number): number => sample.filter((v) => v > threshold).length / sample.length;

/** How wrong a range was (the interval score): its width, and twice-over-alpha times how far outside it the value fell. */
function rangeLoss(lo: number, hi: number, value: number, level: number): number {
  const k = 2 / (1 - level);
  return hi - lo + k * Math.max(0, lo - value) + k * Math.max(0, value - hi);
}

/**
 * Has the weekday's own error size earned its place on this series? The backtest is replayed: at each fold, with only
 * the errors before it, a range is made both ways (all the errors as they are; the errors at the target weekday's
 * size) and scored. The weekday's way is used when it scored better.
 */
function weekdayEarned(errors: readonly number[], start: number, m: number, level: number): boolean {
  if (m < 2) return false;
  let plain = 0;
  let sized = 0;
  let k = 0;
  for (let f = Math.max(MIN_ERRORS, m * MIN_PER_WEEKDAY); f < errors.length; f++) {
    const prior = errors.slice(0, f);
    const a = ends(prior, level);
    const b = ends(onWeekday(prior, start, m, start + f), level);
    // Each error is the value less the forecast, so a range around the forecast is a range of errors.
    plain += rangeLoss(a.lo, a.hi, errors[f]!, level);
    sized += rangeLoss(b.lo, b.hi, errors[f]!, level);
    k += 1;
  }
  return k >= WEEKDAY_NIGHTS && sized < plain;
}

/**
 * May the forecaster's own errors speak for the yes/no question, and how far? The sharper chance is the share of
 * (forecast + each past error) above the threshold: right for a number that wanders from where it was, badly wrong for
 * one that is mostly zero with rare bursts (the night after a burst it would say 95% for what happens one night in
 * ten). So it speaks only when all of this holds on the series' own backtest:
 *  - the forecast beat the series' typical value (the median of the last 28, which is the threshold itself), by the
 *    margin and by more than chance;
 *  - replayed night by night, each night with only what was known then, it scored better (Brier) than the share of
 *    recent values, by the margin.
 * And it never claims more than its record supports: `cap` is the share of the nights it said "more likely than not"
 * that came true, `floor` one less the share of its other nights that did not, each counted with RECORD's four
 * made-up calls. A sharper chance with a short or a patchy record cannot say 90%.
 */
function sharper(y: readonly number[], errors: readonly number[], start: number, m: number, weekday: boolean): { use: boolean; cap: number; floor: number } {
  const sharp: number[] = [];
  const plain: number[] = [];
  const yes = { said: 0, right: 0 };
  const no = { said: 0, right: 0 };
  const cap = (): number => (yes.right + RECORD.right) / (yes.said + RECORD.right + RECORD.wrong);
  const floor = (): number => 1 - (no.right + RECORD.right) / (no.said + RECORD.right + RECORD.wrong);
  for (let f = Math.max(MIN_PRIOR, weekday ? m * MIN_PER_WEEKDAY : 0); f < errors.length; f++) {
    const t = start + f;
    const then = y.slice(0, t);
    const threshold = median(then.slice(-28));
    const point = y[t]! - errors[f]!;
    const prior = errors.slice(0, f);
    const raw = shareAbove((weekday ? onWeekday(prior, start, m, t) : prior).map((e) => Math.max(0, point + e)), threshold);
    const came = y[t]! > threshold ? 1 : 0;
    // Scored as it would have been said that night: held to its record up to then.
    sharp.push((clamp(Math.min(cap(), Math.max(floor(), raw))) - came) ** 2);
    plain.push((clamp(shareAbove(then.slice(-56), threshold)) - came) ** 2);
    if (raw > 0.5) {
      yes.said += 1;
      yes.right += came;
    } else {
      no.said += 1;
      no.right += 1 - came;
    }
  }
  const record = { cap: cap(), floor: floor() };
  if (sharp.length < MIN_FOLDS) return { use: false, ...record };
  const typical = errors.map((_, f) => y[start + f]! - median(y.slice(Math.max(0, start + f - 28), start + f)));
  const knows = mae(errors) < (1 - MARGIN) * mae(typical) && sure(typical, errors);
  return { use: knows && mean(sharp) < (1 - MARGIN) * mean(plain), ...record };
}

/** A forecast of the next steps of `y`. `y` needs 2 values or more; the caller decides what is enough history. */
export function forecast(y: readonly number[], o: ForecastOptions): Forecast {
  if (y.length < 2 || y.some((v) => !Number.isFinite(v))) throw new Error('a forecast needs two finite values or more');
  const level = o.level ?? LEVEL;
  const m = Math.max(1, Math.floor(o.m));
  const n = y.length;
  const recent = y.slice(-28);
  const steady = recent.every((v) => v === recent[0]);
  const scale = scaleOf(y);
  const one = backtest(y, 1, m);
  const folds = one.last.length;
  const start = Math.max(1, minTrain(n, m));
  const naive = folds ? best(NAIVE_NAMES, one) : 'last';
  const model = folds ? best(modelNames(m), one) : undefined;
  const naiveMae = folds ? mae(one[naive]) : null;
  const modelMae = folds && model ? mae(one[model]) : null;
  // Too short to tell until the history is long enough for a model to be believed (and never for a flat line).
  const beatsNaive = steady || naiveMae === null || modelMae === null || !model || n < modelHistory(m) ? null
    : verdict(naiveMae, modelMae, folds) === true && sure(one[naive], one[model]);
  const pick: CandidateName = beatsNaive && model ? model : naive;
  const weekday = weekdayEarned(one[pick], start, m, level);

  // Only steps with enough of the forecaster's own errors behind them get a range, so only those are said.
  const steps: ForecastStep[] = [];
  let first: number[] = [];
  for (let h = 1; h <= (o.steps ?? STEPS); h++) {
    const errors = h === 1 ? one[pick] : backtest(y, h, m, [pick])[pick];
    if (errors.length < MIN_ERRORS) break;
    const point = ALL[pick](y, h, m);
    const sample = weekday ? onWeekday(errors, start + h - 1, m, n + h - 1) : errors;
    if (h === 1) first = sample;
    const e = ends(sample, level);
    steps.push({ h, ...shaped(point, point + e.lo, point + e.hi, o.unit) });
  }

  const out: Forecast = {
    version: FC_VERSION, level, pick, naive, ...(model ? { model } : {}), folds, beatsNaive,
    naiveMase: scale > 0 && naiveMae !== null ? naiveMae / scale : null,
    modelMase: scale > 0 && modelMae !== null ? modelMae / scale : null,
    scale, steady, weekday, steps,
  };
  if (!steady && steps.length) {
    const threshold = tidy(median(recent));
    const point = ALL[pick](y, 1, m);
    const s = sharper(y, one[pick], start, m, weekday);
    const share = s.use ? Math.min(s.cap, Math.max(s.floor, shareAbove(first.map((e) => Math.max(0, point + e)), threshold))) : shareAbove(y.slice(-56), threshold);
    out.question = { threshold, probability: Math.round(clamp(share) * 100) / 100, from: s.use ? 'errors' : 'recent' };
  }
  // Nothing that is not a number leaves here (values near the largest a float holds overflow in the sums).
  const numbers = [scale, out.naiveMase ?? 0, out.modelMase ?? 0, ...steps.flatMap((x) => [x.mean, x.lo, x.hi]), out.question?.threshold ?? 0, out.question?.probability ?? 0];
  if (numbers.some((v) => !Number.isFinite(v))) throw new Error('a forecast came out with a value that is not a number');
  return out;
}

/** What makes a series ready to forecast, and the values to forecast from. */
export interface Prepared {
  ok: boolean;
  /**
   * Why not. `late`: the number for the step just before the one being forecast is not in, and a forecast is never
   * made from a made-up latest value. `too_short`: too few steps, or too many of them filled in (`missing`: how many
   * more are needed, when that is what it is).
   */
  why?: 'too_short' | 'late';
  missing?: number;
  /** The values, oldest first, gaps of one or two steps filled. */
  values: number[];
  /** How many of them were filled in. */
  filled: number;
  /** The index (in steps) of the first value. */
  first: number;
}

/** The fewest steps a forecast is made from: enough for MIN_ERRORS backtest errors, so that its first step has a range. 24 days, or 19 weeks. */
export function minHistory(m: number): number {
  const season = Math.max(1, Math.floor(m));
  let n = 2;
  while (n - Math.max(1, minTrain(n, season)) < MIN_ERRORS) n += 1;
  return n;
}
/** The most history a forecast reads. */
export const MAX_HISTORY = 400;
/** A gap of this many steps or fewer is filled; a longer one cuts the history there. */
export const MAX_GAP = 2;
/** At most this share of the history used may be filled in: one step in five. */
export const MAX_FILLED = 0.2;

/**
 * Values by step index (0 = the first step ever, `target` = the step being
 * forecast) made into an unbroken history ending at target - 1.
 *  - The number for target - 1 must be there. A forecast leans hardest on its
 *    latest value, so it is never made from one that was filled in: the number
 *    is `late`, and waits a night.
 *  - A gap of one or two steps further back is filled with the value one
 *    season before (the previous value when there is none); a longer gap cuts
 *    the history: only what came after it is used.
 *  - Filled values are at most a fifth of what is used: older steps are let go
 *    until they are, and if what is left is too short, so is the history.
 *  - At most the last 400 steps.
 */
export function prepare(points: ReadonlyMap<number, number>, target: number, m: number): Prepared {
  const known = [...points.keys()].filter((i) => i < target && Number.isFinite(points.get(i))).sort((a, b) => a - b);
  const need = minHistory(m);
  const last = known[known.length - 1];
  if (last === undefined) return { ok: false, why: 'too_short', missing: need, values: [], filled: 0, first: target };
  if (last !== target - 1) return { ok: false, why: 'late', values: [], filled: 0, first: target };
  // Walk back from the latest number until a gap too long to fill.
  let first = last;
  for (let i = known.length - 2; i >= 0; i--) {
    if (first - known[i]! - 1 > MAX_GAP) break;
    first = known[i]!;
  }
  // At most the last 400 steps, starting on a number that is there (never on a gap); and from the earliest such start
  // that leaves no more than a fifth of the steps to fill.
  const have = new Set(known);
  const starts = known.filter((i) => i >= Math.max(first, target - MAX_HISTORY));
  first = starts.find((i) => {
    const steps = target - i;
    const real = starts.filter((k) => k >= i).length;
    return steps - real <= steps * MAX_FILLED;
  })!;
  const values: number[] = [];
  let filled = 0;
  for (let i = first; i < target; i++) {
    if (have.has(i)) values.push(points.get(i)!);
    else {
      const at = values.length;
      values.push(at - m >= 0 ? values[at - m]! : values[at - 1]!);
      filled += 1;
    }
  }
  if (values.length < need) return { ok: false, why: 'too_short', missing: need - values.length, values, filled, first };
  return { ok: true, values, filled, first };
}
