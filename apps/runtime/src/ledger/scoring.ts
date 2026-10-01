/**
 * Scoring (plan P1 ledger). Pure functions, so a reference implementation can
 * check them to 1e-9 on a fixture (exit criterion 5).
 *
 *  - Brier: mean of (p - o)^2 over scored binary predictions.
 *  - Base rate: mean outcome.
 *  - Brier skill score: 1 - Brier / (baseRate * (1 - baseRate)), the
 *    improvement over always forecasting the base rate; undefined when every
 *    outcome is the same (the reference score is 0).
 *  - Reliability: ten equal-width bins of forecast probability, each with its
 *    count, mean forecast and observed frequency.
 * ECE, bootstrap intervals and recalibration wait for P4 (100+ scored per domain).
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

export function score(rows: readonly Scored[]): Scores {
  const n = rows.length;
  const baseRate = n ? rows.filter((r) => r.o).length / n : 0;
  const b = brier(rows);
  const ref = baseRate * (1 - baseRate);
  return { n, brier: b, baseRate, brierSkill: ref > 0 ? 1 - b / ref : null, reliability: reliability(rows) };
}
