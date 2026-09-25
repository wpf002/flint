/**
 * Is a W–L record distinguishable from a coin flip? Ties are dropped (the sign
 * test's standard treatment) and the decisive games are tested against
 * Binomial(n, 0.5), two-sided, exactly — no normal approximation, because the
 * per-category cells are small.
 *
 * The signal labels match the retired apps/train/mlx/eval_judge.py so the two histories read
 * the same: that script called an edge of 2 coin-flip SDs SIGNIFICANT and 1 SD
 * "weak". Those are p ≈ 0.05 and p ≈ 0.32 two-sided, which is what's used here,
 * computed exactly.
 */

export type Signal = 'SIGNIFICANT' | 'weak' | 'NOISE';

/** log(n choose k), via log-gamma-free summation (n is at most a few hundred). */
function logChoose(n: number, k: number): number {
  const kk = Math.min(k, n - k);
  let s = 0;
  for (let i = 1; i <= kk; i++) s += Math.log(n - kk + i) - Math.log(i);
  return s;
}

/** P(X = k) for X ~ Binomial(n, 0.5). */
export function binomPmfHalf(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  return Math.exp(logChoose(n, k) - n * Math.LN2);
}

/** Exact two-sided sign-test p-value for `wins` successes in `wins + losses` trials. */
export function signTestP(wins: number, losses: number): number {
  const n = wins + losses;
  if (n === 0) return 1;
  const k = Math.min(wins, losses);
  let tail = 0;
  for (let i = 0; i <= k; i++) tail += binomPmfHalf(n, i);
  return Math.min(1, 2 * tail);
}

export const MIN_DECISIVE = 4;

export function signalOf(wins: number, losses: number): { signal: Signal; p: number } {
  const p = signTestP(wins, losses);
  if (wins + losses < MIN_DECISIVE) return { signal: 'NOISE', p };
  if (p < 0.05) return { signal: 'SIGNIFICANT', p };
  if (p < 0.32) return { signal: 'weak', p };
  return { signal: 'NOISE', p };
}

/** Plain-language verdict for one head-to-head. */
export function verdictOf(wins: number, losses: number, signal: Signal): string {
  if (signal === 'NOISE') return 'no detectable difference (could be a coin flip)';
  const dir = wins > losses ? 'Flint ahead' : 'Flint behind';
  return signal === 'SIGNIFICANT' ? `${dir} (significant)` : `${dir} (weak evidence)`;
}
