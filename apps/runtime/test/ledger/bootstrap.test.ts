/**
 * The interval around a score (P4): seeded, so the same results give the same
 * interval; by cluster, so results that share a day or a goal do not fake a
 * tight one. Checked against a plain copy of the row bootstrap the parity
 * harness uses.
 */
import { describe, it, expect } from 'vitest';
import { LEVEL, MIN_CLUSTERS, RESAMPLES, bootstrapMean, clusterBootstrapMean, seedFrom, seededRng } from '../../src/ledger/bootstrap';

/** Squared errors of yes/no predictions, as a Brier score's terms: deterministic, between 0 and 1. */
function errors(n: number, seed = 20261013): number[] {
  const rand = seededRng(seed);
  return Array.from({ length: n }, () => {
    const p = 0.05 + rand() * 0.9;
    return (p - (rand() < p ? 1 : 0)) ** 2;
  });
}
const mean = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const width = (ci: [number, number] | null) => ci![1] - ci![0];

/** The row bootstrap, written the plain way (the algorithm of apps/parity/src/paired.ts). */
function rowReference(xs: readonly number[], level: number, resamples: number, seed: number): [number, number] {
  const rng = seededRng(seed);
  const means: number[] = [];
  for (let b = 0; b < resamples; b++) {
    let s = 0;
    for (let i = 0; i < xs.length; i++) s += xs[Math.floor(rng() * xs.length)]!;
    means.push(s / xs.length);
  }
  means.sort((a, b) => a - b);
  const tail = (1 - level) / 2;
  const at = (q: number) => means[Math.min(resamples - 1, Math.max(0, Math.floor(q * (resamples - 1))))]!;
  return [at(tail), at(1 - tail)];
}

describe('the bootstrap interval', () => {
  it('is 2,000 resamples at the 90% level, from 10 clusters or more', () => {
    expect([RESAMPLES, LEVEL, MIN_CLUSTERS]).toEqual([2000, 0.9, 10]);
  });

  it('the same seed gives the same interval, every time; another seed gives another', () => {
    const xs = errors(240);
    const days = xs.map((_, i) => `day:${String(Math.floor(i / 8)).padStart(3, '0')}`);
    const a = clusterBootstrapMean(xs, days, { seed: 7 });
    const b = clusterBootstrapMean(xs, days, { seed: 7 });
    expect(a).toEqual(b);
    expect(a![0]).toBeLessThan(mean(xs));
    expect(a![1]).toBeGreaterThan(mean(xs));
    expect(a![0]).toBeGreaterThanOrEqual(0);
    expect(a![1]).toBeLessThanOrEqual(1);
    const other = clusterBootstrapMean(xs, days, { seed: 8 });
    expect(other).not.toEqual(a);
    // Close to it all the same: the seed moves the noise, not the answer.
    expect(Math.abs(other![0] - a![0])).toBeLessThan(0.02);
    expect(Math.abs(other![1] - a![1])).toBeLessThan(0.02);
  });

  it('a seed made from a group\'s name is stable, and differs between groups', () => {
    expect(seedFrom('deploys|trend|statistical|binary')).toBe(seedFrom('deploys|trend|statistical|binary'));
    expect(seedFrom('deploys|trend|statistical|binary')).not.toBe(seedFrom('spend|trend|statistical|binary'));
    expect(Number.isInteger(seedFrom('x'))).toBe(true);
    const first = [seededRng(1)(), seededRng(1)(), seededRng(2)()];
    expect(first[0]).toBe(first[1]);
    expect(first[0]).not.toBe(first[2]);
  });

  it('the order of the rows does not change it', () => {
    const xs = errors(120);
    const days = xs.map((_, i) => `day:${String(i % 15).padStart(3, '0')}`);
    const order = xs.map((_, i) => i).sort((a, b) => ((a * 7919) % 120) - ((b * 7919) % 120));
    expect(clusterBootstrapMean(order.map((i) => xs[i]!), order.map((i) => days[i]!), { seed: 3 })).toEqual(clusterBootstrapMean(xs, days, { seed: 3 }));
  });

  it('with every row its own cluster it is the row bootstrap, to 1e-12', () => {
    const xs = errors(150);
    const ref = rowReference(xs, 0.9, 2000, 11);
    const got = bootstrapMean(xs, { seed: 11 })!;
    expect(Math.abs(got[0] - ref[0])).toBeLessThan(1e-12);
    expect(Math.abs(got[1] - ref[1])).toBeLessThan(1e-12);
    expect(clusterBootstrapMean(xs, xs.map((_, i) => String(i).padStart(9, '0')), { seed: 11, level: 0.9, resamples: 2000 })).toEqual(got);
  });

  it('cluster resampling does not let duplicated clusters fake a tight interval: ten copies of each day\'s result are still thirty days', () => {
    // Thirty days, each with one result; then the same thirty days with that result counted ten times over.
    const perDay = errors(30, 5);
    const days = perDay.map((_, i) => `day:${String(i).padStart(3, '0')}`);
    const copies = perDay.flatMap((v) => Array.from({ length: 10 }, () => v));
    const copyDays = days.flatMap((d) => Array.from({ length: 10 }, () => d));
    const honest = clusterBootstrapMean(perDay, days, { seed: 9 })!;
    const clustered = clusterBootstrapMean(copies, copyDays, { seed: 9 })!;
    // By cluster, three hundred correlated rows say exactly what thirty days say.
    expect(Math.abs(clustered[0] - honest[0])).toBeLessThan(1e-12);
    expect(Math.abs(clustered[1] - honest[1])).toBeLessThan(1e-12);
    // By row, they look like three hundred independent results: an interval about a third as wide, and wrong.
    const byRow = bootstrapMean(copies, { seed: 9 })!;
    expect(width(clustered)).toBeGreaterThan(width(byRow) * 2.5);
    expect(width(byRow)).toBeLessThan(width(honest) / 2.5);
  });

  it('clusters of different sizes weigh as their rows do: the middle of the interval sits at the mean of all the rows', () => {
    const rand = seededRng(21);
    const values: number[] = [];
    const clusters: string[] = [];
    for (let c = 0; c < 40; c++) {
      const size = 1 + Math.floor(rand() * 12);
      const level = rand();
      for (let i = 0; i < size; i++) {
        values.push(Math.min(1, Math.max(0, level + (rand() - 0.5) * 0.1)));
        clusters.push(`goal:${String(c).padStart(3, '0')}`);
      }
    }
    const ci = clusterBootstrapMean(values, clusters, { seed: 4 })!;
    expect(ci[0]).toBeLessThan(mean(values));
    expect(ci[1]).toBeGreaterThan(mean(values));
    expect(Math.abs((ci[0] + ci[1]) / 2 - mean(values))).toBeLessThan(0.03);
  });

  it('there is no interval from too few clusters, or from nothing: three goals do not say how sure a score is', () => {
    const xs = errors(300);
    expect(clusterBootstrapMean(xs, xs.map((_, i) => `goal:${i % 3}`), { seed: 1 })).toBeNull();
    expect(clusterBootstrapMean(xs, xs.map((_, i) => `goal:${i % 9}`), { seed: 1 })).toBeNull();
    expect(clusterBootstrapMean(xs, xs.map((_, i) => `goal:${String(i % 10).padStart(2, '0')}`), { seed: 1 })).not.toBeNull();
    expect(clusterBootstrapMean([], [], { seed: 1 })).toBeNull();
    expect(clusterBootstrapMean(xs.slice(0, 5), ['a', 'b', 'c', 'd', 'e'], { seed: 1, minClusters: 2 })).not.toBeNull();
    expect(() => clusterBootstrapMean([1, 2], ['a'], { seed: 1 })).toThrow('every value has a cluster');
  });

  it('a wider level gives a wider interval, and identical results give none to speak of', () => {
    const xs = errors(200);
    const days = xs.map((_, i) => `day:${String(i % 20).padStart(3, '0')}`);
    expect(width(clusterBootstrapMean(xs, days, { seed: 2, level: 0.99 }))).toBeGreaterThan(width(clusterBootstrapMean(xs, days, { seed: 2, level: 0.5 })));
    const same = clusterBootstrapMean(xs.map(() => 0.25), days, { seed: 2 })!;
    expect(same[0]).toBeCloseTo(0.25, 12);
    expect(same[1]).toBeCloseTo(0.25, 12);
  });
});
