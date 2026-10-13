/**
 * The forecaster on whole simulated series, "as lived" (P4 part 3): a number
 * grows a day at a time; every night a one-step forecast is made from what is
 * there, and scored against the next day. Fixed seeds, so every count below is
 * the same on every run. No clock, no database.
 *
 * The shapes are the ones the review of this part measured the first version
 * on, and found it wanting:
 *
 *   rare bursts        mostly 0, a burst one day in ten (service downtime)
 *   sparse counts      0 most days, sometimes 1 or 2 (deploys)
 *   patternless        counts, dollars and hours with nothing to find
 *   weekday            busy weekdays and quiet weekends: in the level (counts,
 *                      dollars), in the spread only (hours), or both (a calendar)
 *   random walk        tomorrow is near today (open threads)
 *   trend              a slow climb
 *   weekly             a weekly count with nothing to find, and a weekly walk
 *
 * What is held, each with what the first version did (120 series a shape):
 *
 *  1. The yes/no question. When it says 90% or more, the event comes true at
 *     least 80% of the time, on every shape. (Before: 10% on bursts, 26% on
 *     sparse counts, 32 to 56% on patternless, 68 to 77% on weekday shapes.) On
 *     shapes where 90% is never warranted it is now not said. On bursts its
 *     Brier score is that of always saying the base rate. (Before: 0.156
 *     against 0.092.)
 *  2. A model is kept over a plain guess, at the minimum history that allows
 *     it, in under 10% of runs on shapes with nothing to find. (Before, at day
 *     22: 6 to 19%; at week 15: 23%.) And it still is kept where there is
 *     something to find.
 *  3. A range is stated only with 10 errors behind it. (Before: from 8, whose
 *     least to greatest is 7 chances in 9; and before that from the values.)
 *  4. On weekday shapes the "80% range" holds between 72% and 92% of the time
 *     on busy days and on quiet days alike, after day 56. (Before: 75% busy,
 *     97 to 100% quiet.)
 *  5. Overall an "80% range" holds about 80% of the time or more, on every shape.
 */
import { describe, it, expect } from 'vitest';
import { MIN_ERRORS, forecast, minHistory, modelHistory, type ForecastUnit } from '../../src/predict/forecast';

/** A seeded generator (mulberry32): the same stream on every run. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (r: () => number): number => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
function pois(lam: number, r: () => number): number {
  const L = Math.exp(-lam);
  let k = 0;
  let p = 1;
  for (;;) {
    p *= r();
    if (p <= L) return k;
    k += 1;
  }
}
const cents = (x: number): number => Math.round(x * 100) / 100;
/** A week's levels: five busy days, a quiet Saturday, a quieter Sunday. */
const WEEK = [5, 6, 7, 6, 4, 1, 0.3];

type Gen = (n: number, r: () => number, off: number) => number[];
interface Shape {
  m: number;
  unit: ForecastUnit;
  len: number;
  gen: Gen;
  /** For weekday shapes: is this place in the week a busy day? */
  busy?: (place: number) => boolean;
}
const weekdays = (place: number): boolean => place < 5;
const SHAPES = {
  bursts: { m: 7, unit: 'minutes', len: 101, gen: (n, r) => Array.from({ length: n }, () => (r() < 0.1 ? Math.round(Math.exp(3 + 1.2 * gauss(r))) : 0)) },
  sparseCounts: { m: 7, unit: 'count', len: 101, gen: (n, r) => Array.from({ length: n }, () => pois(0.3, r)) },
  patternlessCounts: { m: 7, unit: 'count', len: 101, gen: (n, r) => Array.from({ length: n }, () => pois(3, r)) },
  patternlessDollars: { m: 7, unit: 'usd', len: 101, gen: (n, r) => Array.from({ length: n }, () => cents(2 * Math.exp(0.6 * gauss(r)))) },
  patternlessHours: { m: 7, unit: 'hours', len: 101, gen: (n, r) => Array.from({ length: n }, () => cents(Math.max(0, 5 + 1.5 * gauss(r)))) },
  weekdayCounts: { m: 7, unit: 'count', len: 101, busy: weekdays, gen: (n, r, off) => Array.from({ length: n }, (_, i) => pois(WEEK[(i + off) % 7]!, r)) },
  weekdayDollars: { m: 7, unit: 'usd', len: 101, busy: weekdays, gen: (n, r, off) => Array.from({ length: n }, (_, i) => cents(WEEK[(i + off) % 7]! * Math.exp(0.5 * gauss(r)))) },
  weekdayNoise: { m: 7, unit: 'hours', len: 101, busy: weekdays, gen: (n, r, off) => Array.from({ length: n }, (_, i) => cents(Math.max(0, 4 + ((i + off) % 7 < 5 ? 2.5 : 0.2) * gauss(r)))) },
  calendarLike: { m: 7, unit: 'hours', len: 101, busy: weekdays, gen: (n, r, off) => Array.from({ length: n }, (_, i) => ((i + off) % 7 < 5 ? cents(Math.max(0, 3.5 + 1.5 * gauss(r))) : r() < 0.15 ? cents(1 + r()) : 0)) },
  randomWalk: { m: 7, unit: 'count', len: 101, gen: (n, r) => walk(n, r, 20, 1.2) },
  trend: { m: 7, unit: 'count', len: 101, gen: (n, r) => Array.from({ length: n }, (_, i) => Math.max(0, Math.round(3 + 0.15 * i + 2 * gauss(r)))) },
  weeklyCounts: { m: 1, unit: 'count', len: 61, gen: (n, r) => Array.from({ length: n }, () => pois(20, r)) },
  weeklyWalk: { m: 1, unit: 'count', len: 61, gen: (n, r) => walk(n, r, 30, 4) },
} as const satisfies Record<string, Shape>;
function walk(n: number, r: () => number, from: number, sd: number): number[] {
  const y = [from];
  for (let i = 1; i < n; i++) y.push(Math.max(0, y[i - 1]! + Math.round(sd * gauss(r))));
  return y;
}
type ShapeName = keyof typeof SHAPES;
const NAMES = Object.keys(SHAPES) as ShapeName[];
const seedOf = (name: string): number => 20261012 + [...name].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) | 0, 7);

interface Lived {
  /** Nights with a question; its Brier score; the Brier score of always saying the base rate (the share of the last 56 values above the same threshold). */
  asked: number;
  brier: number;
  baseBrier: number;
  /** Nights it said 90% or more, and how many of those came true. */
  said90: number;
  true90: number;
  /** Nights it said 10% or less, and how many came true. */
  said10: number;
  true10: number;
  /** How often the event happened at all. */
  rate: number;
  /** Ranges stated, and held. */
  ranges: number;
  held: number;
  /** The same on busy days and on quiet days, after day 56 (weekday shapes). */
  busy: { n: number; held: number };
  quiet: { n: number; held: number };
  /** Nights the forecaster's own errors spoke for the question. */
  fromErrors: number;
}

/** One shape, lived: `series` series, a forecast every night from the first night one is possible. */
function live(name: ShapeName, series: number): Lived {
  const s: Shape = SHAPES[name];
  const r = rng(seedOf(name));
  const o: Lived = { asked: 0, brier: 0, baseBrier: 0, said90: 0, true90: 0, said10: 0, true10: 0, rate: 0, ranges: 0, held: 0, busy: { n: 0, held: 0 }, quiet: { n: 0, held: 0 }, fromErrors: 0 };
  let happened = 0;
  for (let k = 0; k < series; k++) {
    const off = Math.floor(r() * 7);
    const full = s.gen(s.len, r, off);
    for (let n = minHistory(s.m); n < s.len; n++) {
      const y = full.slice(0, n);
      const f = forecast(y, { m: s.m, unit: s.unit, steps: 1 });
      const actual = full[n]!;
      const step = f.steps[0];
      if (step && !f.steady) {
        const held = actual >= step.lo && actual <= step.hi;
        o.ranges += 1;
        if (held) o.held += 1;
        if (n >= 56 && s.busy) {
          const side = s.busy((n + off) % 7) ? o.busy : o.quiet;
          side.n += 1;
          if (held) side.held += 1;
        }
      }
      if (f.question) {
        const p = f.question.probability;
        const came = actual > f.question.threshold ? 1 : 0;
        const recent = y.slice(-56);
        const base = Math.round(Math.min(0.95, Math.max(0.05, recent.filter((v) => v > f.question!.threshold).length / recent.length)) * 100) / 100;
        o.asked += 1;
        happened += came;
        o.brier += (p - came) ** 2;
        o.baseBrier += (base - came) ** 2;
        if (p >= 0.9) {
          o.said90 += 1;
          o.true90 += came;
        }
        if (p <= 0.1) {
          o.said10 += 1;
          o.true10 += came;
        }
        if (f.question.from === 'errors') o.fromErrors += 1;
      }
    }
  }
  o.brier /= Math.max(1, o.asked);
  o.baseBrier /= Math.max(1, o.asked);
  o.rate = happened / Math.max(1, o.asked);
  return o;
}

/** How often a model is kept over the plain guess with exactly `n` steps of history. */
function kept(name: ShapeName, n: number, series: number): number {
  const s: Shape = SHAPES[name];
  const r = rng(seedOf(name) + 1);
  let count = 0;
  for (let k = 0; k < series; k++) {
    const y = s.gen(n, r, Math.floor(r() * 7));
    if (forecast(y, { m: s.m, unit: s.unit, steps: 1 }).beatsNaive === true) count += 1;
  }
  return count / series;
}

describe('the forecaster, as lived on simulated series', () => {
  const SERIES = 60;
  const lived = new Map<ShapeName, Lived>();
  const of = (name: ShapeName): Lived => {
    if (!lived.has(name)) lived.set(name, live(name, SERIES));
    return lived.get(name)!;
  };
  const NOTHING_TO_FIND: ShapeName[] = ['bursts', 'sparseCounts', 'patternlessCounts', 'patternlessDollars', 'patternlessHours', 'weekdayNoise'];
  const WEEKDAY: ShapeName[] = ['weekdayCounts', 'weekdayDollars', 'weekdayNoise', 'calendarLike'];

  it('when the question says 90% or more, it comes true at least 80% of the time, on every shape', () => {
    for (const name of NAMES) {
      const o = of(name);
      expect(o.asked, name).toBeGreaterThan(1000);
      if (o.said90) expect(o.true90 / o.said90, `${name}: said 90%+ on ${o.said90} nights, ${o.true90} came true`).toBeGreaterThanOrEqual(0.8);
    }
  }, 120_000);

  it('where 90% is never warranted it is hardly ever said; where it is, it still is', () => {
    // On none of these does the event happen 90% of the time on any kind of day.
    for (const name of [...NOTHING_TO_FIND, 'weekdayCounts', 'weekdayDollars', 'calendarLike'] as ShapeName[]) {
      const o = of(name);
      expect(o.said90 / o.asked, `${name}: ${o.said90} of ${o.asked}`).toBeLessThan(0.005);
    }
    // A walk is often well clear of its own recent median, and once the forecaster has the record for it (26 right
    // calls in a row) it says so, at both ends, and is right. In 100 days that is one night in twenty or more.
    const walk = of('randomWalk');
    expect((walk.said90 + walk.said10) / walk.asked).toBeGreaterThan(0.05);
    expect(walk.true90 / walk.said90).toBeGreaterThanOrEqual(0.9);
    expect(walk.true10 / walk.said10).toBeLessThanOrEqual(0.1);
    // In 60 weeks a weekly walk barely gets there; what it says is right.
    const weekly = of('weeklyWalk');
    if (weekly.said90) expect(weekly.true90 / weekly.said90).toBeGreaterThanOrEqual(0.9);
  }, 120_000);

  it('on rare bursts the question is no worse than always saying the base rate, and never says 95% the night after one', () => {
    const o = of('bursts');
    // The event (any downtime at all) happens about one night in ten.
    expect(o.rate).toBeGreaterThan(0.07);
    expect(o.rate).toBeLessThan(0.13);
    // The base rate as it can be known on the night: the share of recent nights with a burst. The forecaster's own
    // errors spoke on a handful of nights at most, so its score is that one's (to within half of one percent of it).
    expect(o.fromErrors / o.asked).toBeLessThan(0.005);
    expect(o.brier).toBeLessThanOrEqual(o.baseBrier * 1.005);
    // Nothing that has to learn the rate can match a forecaster that was told it; this one is within a twentieth of
    // always saying exactly 10%. (The first version scored 0.156, three quarters worse.)
    const told = 0.1 ** 2 * (1 - o.rate) + 0.9 ** 2 * o.rate;
    expect(o.brier).toBeLessThanOrEqual(told * 1.05);
    expect(o.said90).toBe(0);
  }, 120_000);

  it('where the forecast knows something, the question says more than the base rate does', () => {
    for (const name of ['randomWalk', 'weeklyWalk', 'trend', 'weekdayCounts', 'weekdayDollars', 'calendarLike'] as ShapeName[]) {
      const o = of(name);
      expect(o.brier, name).toBeLessThan(o.baseBrier * 0.97);
    }
    expect(of('randomWalk').brier).toBeLessThan(of('randomWalk').baseBrier * 0.6);
    // Where it knows nothing, it says the base rate, near enough.
    for (const name of NOTHING_TO_FIND) expect(of(name).brier, name).toBeLessThanOrEqual(of(name).baseBrier * 1.01);
  }, 120_000);

  it('a model is kept over a plain guess, at the least history that allows it, in under 10% of runs with nothing to find', () => {
    for (const name of ['bursts', 'sparseCounts', 'patternlessCounts', 'patternlessDollars', 'patternlessHours', 'weekdayNoise', 'randomWalk'] as ShapeName[]) {
      expect(kept(name, modelHistory(7), 400), name).toBeLessThan(0.1);
      // A day sooner it is never kept: too short to tell.
      expect(kept(name, modelHistory(7) - 1, 40), name).toBe(0);
    }
    for (const name of ['weeklyCounts', 'weeklyWalk'] as ShapeName[]) {
      expect(kept(name, modelHistory(1), 400), name).toBeLessThan(0.1);
      expect(kept(name, modelHistory(1) - 1, 40), name).toBe(0);
    }
    // Where there is something to find, it is found: often at the least history, and more often with more.
    expect(kept('trend', modelHistory(7), 400)).toBeGreaterThan(0.35);
    expect(kept('trend', 100, 200)).toBeGreaterThan(0.6);
    expect(kept('calendarLike', 100, 200)).toBeGreaterThan(0.4);
  }, 120_000);

  it('a range is stated only with 10 errors behind it: none before day 24 (week 19), one from then on', () => {
    for (const name of ['patternlessHours', 'weeklyCounts'] as ShapeName[]) {
      const s: Shape = SHAPES[name];
      const y = s.gen(s.len, rng(seedOf(name) + 2), 0);
      const least = minHistory(s.m);
      for (let n = 2; n < least; n++) expect(forecast(y.slice(0, n), { m: s.m, unit: s.unit }).steps, `${name} at ${n}`).toEqual([]);
      const f = forecast(y.slice(0, least), { m: s.m, unit: s.unit });
      expect(f.folds).toBe(MIN_ERRORS);
      expect(f.steps).toHaveLength(1);
    }
    expect([minHistory(7), minHistory(1)]).toEqual([24, 19]);
  });

  it('on weekday shapes the 80% range holds between 72% and 92% of the time on busy days and on quiet days alike, after day 56', () => {
    for (const name of ['weekdayDollars', 'weekdayNoise', 'calendarLike'] as ShapeName[]) {
      const o = of(name);
      expect(o.busy.n, name).toBeGreaterThan(1000);
      expect(o.quiet.n, name).toBeGreaterThan(400);
      for (const [side, days] of [['busy', o.busy], ['quiet', o.quiet]] as const) {
        expect(days.held / days.n, `${name}, ${side} days: ${days.held} of ${days.n}`).toBeGreaterThanOrEqual(0.72);
        expect(days.held / days.n, `${name}, ${side} days: ${days.held} of ${days.n}`).toBeLessThanOrEqual(0.92);
      }
    }
    // Whole counts cannot be cut finer than a whole number: a Sunday that is 0 three weeks in four, and 1 most of the
    // rest, has no range between 74% and 96%. Its busy days are held to the same band; its quiet days only from below.
    const counts = of('weekdayCounts');
    expect(counts.busy.held / counts.busy.n).toBeGreaterThanOrEqual(0.72);
    expect(counts.busy.held / counts.busy.n).toBeLessThanOrEqual(0.92);
    expect(counts.quiet.held / counts.quiet.n).toBeGreaterThanOrEqual(0.72);
  }, 120_000);

  it('an 80% range holds about 80% of the time or more, on every shape', () => {
    for (const name of NAMES) {
      const o = of(name);
      expect(o.held / o.ranges, `${name}: ${o.held} of ${o.ranges}`).toBeGreaterThanOrEqual(0.78);
    }
  }, 120_000);

  it('the whole table (printed with FC_SIM_PRINT=1, for the README)', () => {
    const pct = (a: number, b: number): string => (b ? `${((100 * a) / b).toFixed(1)}%` : '-');
    const lines = NAMES.map((name) => {
      const o = of(name);
      return [
        name.padEnd(20), `asked ${o.asked}`, `said 90%+ ${o.said90} (${pct(o.true90, o.said90)} true)`, `said 10%- ${o.said10} (${pct(o.true10, o.said10)} true)`,
        `Brier ${o.brier.toFixed(4)} vs base ${o.baseBrier.toFixed(4)}`, `own errors ${pct(o.fromErrors, o.asked)}`, `range held ${pct(o.held, o.ranges)}`,
        ...(o.busy.n ? [`busy ${pct(o.busy.held, o.busy.n)} quiet ${pct(o.quiet.held, o.quiet.n)}`] : []),
      ].join(' | ');
    });
    if (process.env.FC_SIM_PRINT) console.log(lines.join('\n'));
    expect(lines).toHaveLength(NAMES.length);
    for (const name of NAMES) expect(Number.isFinite(of(name).brier) && of(name).ranges > 0, name).toBe(true);
  }, 120_000);
});
