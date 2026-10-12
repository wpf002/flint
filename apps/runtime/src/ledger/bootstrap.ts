/**
 * The interval around a mean score (P4): a seeded percentile bootstrap, so the
 * same results give the same interval every night and on every machine. It is
 * the algorithm the parity harness uses for its verdicts (apps/parity is a
 * separate app, so it is written again here), with one difference: it resamples
 * CLUSTERS, not rows. Twenty forecasts that resolve on the same day, or twenty
 * reviews of the same goal, are not twenty independent results; drawing whole
 * clusters keeps what they share together, so correlated predictions do not
 * fake a tight interval.
 *
 * Pure: no clock, no Math.random, no I/O.
 */
import { createHash } from 'node:crypto';

/** How many resamples an interval is made from, and its level. */
export const RESAMPLES = 2000;
export const LEVEL = 0.9;
/**
 * The fewest clusters an interval is made from. Below it the resamples can
 * only take a handful of values and their spread says little, so there is no
 * interval at all (three goals are not enough to say how sure a score is).
 */
export const MIN_CLUSTERS = 10;

/** mulberry32: a small seeded generator of numbers in [0, 1). */
export function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A stable 32-bit seed from a string (a group's name), so a group's interval does not depend on run order. */
export function seedFrom(s: string): number {
  return createHash('sha256').update(s).digest().readUInt32BE(0);
}

export interface ClusterOptions {
  seed: number;
  level?: number;
  resamples?: number;
  minClusters?: number;
}

/**
 * The percentile interval for the mean of `values`, resampling whole clusters
 * with replacement (`clusters[i]` names the cluster of `values[i]`). Each
 * resample draws as many clusters as there are and takes the mean of every
 * value in them. Null when there are fewer clusters than `minClusters`, or no
 * values. The order of the rows does not matter: clusters are taken in the
 * order of their names.
 */
export function clusterBootstrapMean(values: readonly number[], clusters: readonly string[], o: ClusterOptions): [number, number] | null {
  if (values.length !== clusters.length) throw new Error('every value has a cluster');
  const level = o.level ?? LEVEL;
  const resamples = o.resamples ?? RESAMPLES;
  const by = new Map<string, { sum: number; n: number }>();
  values.forEach((v, i) => {
    const c = by.get(clusters[i]!) ?? { sum: 0, n: 0 };
    c.sum += v;
    c.n += 1;
    by.set(clusters[i]!, c);
  });
  const groups = [...by.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, g]) => g);
  const k = groups.length;
  if (values.length === 0 || k < (o.minClusters ?? MIN_CLUSTERS)) return null;
  const rng = seededRng(o.seed);
  const means = new Float64Array(resamples);
  for (let b = 0; b < resamples; b++) {
    let s = 0;
    let n = 0;
    for (let i = 0; i < k; i++) {
      const g = groups[Math.floor(rng() * k)]!;
      s += g.sum;
      n += g.n;
    }
    means[b] = s / n;
  }
  means.sort();
  const tail = (1 - level) / 2;
  const at = (q: number): number => means[Math.min(resamples - 1, Math.max(0, Math.floor(q * (resamples - 1))))]!;
  return [at(tail), at(1 - tail)];
}

/** The same interval with every row its own cluster: the plain row bootstrap. */
export function bootstrapMean(values: readonly number[], o: ClusterOptions): [number, number] | null {
  return clusterBootstrapMean(values, values.map((_, i) => String(i).padStart(9, '0')), o);
}
