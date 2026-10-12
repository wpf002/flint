/**
 * Scoring (the ledger). Pure functions, so a reference implementation can
 * check them to 1e-9 on a fixture.
 *
 * Yes/no predictions:
 *  - Brier: mean of (p - o)^2 over scored binary predictions.
 *  - Base rate: mean outcome.
 *  - Brier skill score: 1 - Brier / (baseRate * (1 - baseRate)), the
 *    improvement over always forecasting the base rate; undefined when every
 *    outcome is the same (the reference score is 0).
 *  - Reliability: ten equal-width bins of forecast probability, each with its
 *    count, mean forecast and observed frequency.
 *  - ECE (expected calibration error): over the bins, (n_bin / n) x |mean
 *    forecast - observed frequency|, summed. The same sum from stored bins is
 *    the reliability gap. The snapshot stores ECE only at 100 scored or more.
 * Ranges (P4):
 *  - Coverage: the share of ranges that held (lower <= value <= upper).
 *  - Pinball loss: for each range, the mean of the two quantile losses at its
 *    ends (the quantiles (1 - level) / 2 and (1 + level) / 2), divided by its
 *    run's scale, so dollars and counts can share a group. A range whose scale
 *    is missing or 0 is left out and counted.
 * The interval around a Brier score is in bootstrap.ts. Recalibration waits for
 * real data (200 scored in a domain).
 */
export interface Scored {
  p: number;
  o: boolean;
}

export interface Bin {
  lo: number;
  hi: number;
  n: number;
  meanP: number | null;
  freq: number | null;
}

export interface Scores {
  n: number;
  brier: number;
  baseRate: number;
  brierSkill: number | null;
  reliability: Bin[];
  /** Null with nothing scored. Whether it is stored is the snapshot's rule (100 scored). */
  ece: number | null;
}

/** A resolved range: its ends and level, the value the series took, and its run's scale (the MASE scale). */
export interface ScoredRange {
  lower: number;
  upper: number;
  level: number;
  value: number;
  scale: number | null;
}

export interface RangeScores {
  n: number;
  /** The share of ranges that held; null with none. */
  coverage: number | null;
  /** Mean scaled pinball loss over the ranges that have a scale; null with none. */
  pinball: number | null;
  /** Ranges left out of the pinball loss: no scale, or a scale of 0. */
  unscaled: number;
}

/** Kahan-compensated sum, so 1,000 rows agree with a reference to well within 1e-9. */
function sum(xs: Iterable<number>): number {
  let s = 0;
  let c = 0;
  for (const x of xs) {
    const y = x - c;
    const t = s + y;
    c = t - s - y;
    s = t;
  }
  return s;
}

export function brier(rows: readonly Scored[]): number {
  if (rows.length === 0) return 0;
  return sum(rows.map((r) => (r.p - (r.o ? 1 : 0)) ** 2)) / rows.length;
}

export function reliability(rows: readonly Scored[], bins = 10): Bin[] {
  const out: Bin[] = [];
  for (let i = 0; i < bins; i++) {
    const lo = i / bins;
    const hi = (i + 1) / bins;
    const inBin = rows.filter((r) => r.p >= lo && (i === bins - 1 ? r.p <= hi : r.p < hi));
    out.push({
      lo,
      hi,
      n: inBin.length,
      meanP: inBin.length ? sum(inBin.map((r) => r.p)) / inBin.length : null,
      freq: inBin.length ? inBin.filter((r) => r.o).length / inBin.length : null,
    });
  }
  return out;
}

/**
 * The weighted gap between what was said and what happened, from bins: the sum
 * over the bins that hold anything of (n_bin / n) x |mean forecast - observed
 * frequency|. Null when the bins are empty. ECE is this, from freshly made bins.
 */
export function reliabilityGap(bins: readonly Pick<Bin, 'n' | 'meanP' | 'freq'>[]): number | null {
  const n = bins.reduce((t, b) => t + b.n, 0);
  if (!n) return null;
  return sum(bins.filter((b) => b.n > 0 && b.meanP !== null && b.freq !== null).map((b) => (b.n / n) * Math.abs(b.meanP! - b.freq!)));
}

export function ece(rows: readonly Scored[], bins = 10): number | null {
  return reliabilityGap(reliability(rows, bins));
}

export function score(rows: readonly Scored[]): Scores {
  const n = rows.length;
  const baseRate = n ? rows.filter((r) => r.o).length / n : 0;
  const b = brier(rows);
  const ref = baseRate * (1 - baseRate);
  const bins = reliability(rows);
  return { n, brier: b, baseRate, brierSkill: ref > 0 ? 1 - b / ref : null, reliability: bins, ece: reliabilityGap(bins) };
}

/** The share of ranges that held: lower <= value <= upper. Null with none. */
export function intervalCoverage(rows: readonly Pick<ScoredRange, 'lower' | 'upper' | 'value'>[]): number | null {
  if (rows.length === 0) return null;
  return rows.filter((r) => r.lower <= r.value && r.value <= r.upper).length / rows.length;
}

/** The quantile (pinball) loss of saying `q` for the quantile `tau`, when the value came out as `value`. Never negative. */
export function quantileLoss(value: number, q: number, tau: number): number {
  return value >= q ? tau * (value - q) : (1 - tau) * (q - value);
}

/** One range's pinball loss, unscaled: the mean of the quantile losses at its two ends. */
export function rangeLoss(r: Pick<ScoredRange, 'lower' | 'upper' | 'level' | 'value'>): number {
  return (quantileLoss(r.value, r.lower, (1 - r.level) / 2) + quantileLoss(r.value, r.upper, (1 + r.level) / 2)) / 2;
}

export function scoreRanges(rows: readonly ScoredRange[]): RangeScores {
  const scaled = rows.filter((r) => r.scale !== null && Number.isFinite(r.scale) && r.scale > 0);
  return {
    n: rows.length,
    coverage: intervalCoverage(rows),
    pinball: scaled.length ? sum(scaled.map((r) => rangeLoss(r) / r.scale!)) / scaled.length : null,
    unscaled: rows.length - scaled.length,
  };
}
