/**
 * The local forecaster against hand-computed fixtures (P4 part 3): each
 * candidate, the backtest, MASE, the verdict (false, null and the 5% margin),
 * the ranges with their finite-sample correction, the floors, and what makes a
 * history ready. Pure: the same input gives the same output.
 */
import { describe, it, expect } from 'vitest';
import {
  FC_VERSION, LEVEL, MARGIN, MAX_GAP, MAX_HISTORY, MIN_FOLDS, MODEL, NAIVE, SES_ALPHAS, STEP, STEPS,
  backtest, ends, forecast, median, minHistory, minTrain, prepare, profile, scaleOf, sesLevel, slope, verdict,
} from '../../src/predict/forecast';

const range = <T>(n: number, f: (i: number) => T): T[] => Array.from({ length: n }, (_, i) => f(i));
/** A seeded generator, for inputs that are random and the same on every run. */
function rng(seed: number): () => number {
  let x = seed >>> 0;
  return () => ((x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

describe('the forecaster\'s parts, by hand', () => {
  it('the constants are the method\'s: an 80% range, 8 folds for a verdict, a 5% margin, seven steps', () => {
    expect([FC_VERSION, LEVEL, MIN_FOLDS, MARGIN, STEPS, MAX_GAP, MAX_HISTORY]).toEqual(['fc.v1', 0.8, 8, 0.05, 7, 2, 400]);
    expect([...SES_ALPHAS]).toEqual([0.1, 0.2, 0.3, 0.5, 0.7, 0.9]);
    expect(STEP).toEqual({ count: 1, minutes: 1, usd: 0.01, hours: 0.01 });
    expect([minHistory(7), minHistory(1)]).toEqual([14, 8]);
  });

  it('the naive set: the last value, the same step a season ago, the mean of the last 28', () => {
    expect(NAIVE.last([3, 5, 4], 1, 7)).toBe(4);
    const ten = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    // One step ahead of ten daily values is the value seven back from it: the 4th.
    expect(NAIVE.seasonal(ten, 1, 7)).toBe(4);
    expect(NAIVE.seasonal(ten, 2, 7)).toBe(5);
    expect(NAIVE.seasonal(ten, 8, 7)).toBe(4);
    // Less than a season of history: the last value.
    expect(NAIVE.seasonal([3, 5, 4], 1, 7)).toBe(4);
    // With no season (weekly), a season ago is the last value.
    expect(NAIVE.seasonal(ten, 1, 1)).toBe(10);
    // 1..30: the last 28 are 3..30, whose mean is 16.5.
    expect(NAIVE.mean28(range(30, (i) => i + 1), 1, 7)).toBe(16.5);
    expect(NAIVE.mean28([2, 4], 1, 7)).toBe(3);
  });

  it('simple exponential smoothing: the alpha with the least in-sample error; a tie goes to the smallest', () => {
    // 0, 10, 10, 10. At alpha 0.9 the level goes 0, 9, 9.9, 9.99 and the squared errors are 100, 1, 0.01: the least.
    expect(sesLevel([0, 10, 10, 10])).toBeCloseTo(9.99, 12);
    // Two values: every alpha has the same error (100), so the first, 0.1: 0.1 x 20 + 0.9 x 10.
    expect(sesLevel([10, 20])).toBeCloseTo(11, 12);
    expect(sesLevel([7, 7, 7, 7])).toBe(7);
    expect(MODEL.ses([0, 10, 10, 10], 3, 7)).toBeCloseTo(9.99, 12);
  });

  it('the slope, drift, and the smoothed level plus half the recent slope', () => {
    expect(slope([1, 3, 5, 7])).toBe(2);
    expect(slope([5, 5, 5])).toBe(0);
    expect(slope([4])).toBe(0);
    // 2, 4, 9: the average step is (9 - 2) / 2 = 3.5.
    expect(MODEL.drift([2, 4, 9], 1, 7)).toBe(12.5);
    expect(MODEL.drift([2, 4, 9], 2, 7)).toBe(16);
    // 1, 3, 5, 7: alpha 0.9 ends at 6.778; half the slope of 2 is 1.
    expect(sesLevel([1, 3, 5, 7])).toBeCloseTo(6.778, 12);
    expect(MODEL.sesDrift([1, 3, 5, 7], 1, 7)).toBeCloseTo(7.778, 12);
    expect(MODEL.sesDrift([1, 3, 5, 7], 3, 7)).toBeCloseTo(9.778, 12);
  });

  it('weekly-profile smoothing: the median profile comes out, the rest is smoothed, the target\'s place goes back in', () => {
    // A season of 3: 1, 2, 3, 2, 3, 4. The mean is 2.5; each place's median offset is -1, 0, 1.
    const y = [1, 2, 3, 2, 3, 4];
    expect(profile(y, 3)).toEqual([-1, 0, 1]);
    // Without the profile: 2, 2, 2, 3, 3, 3, which alpha 0.9 smooths to 2.999. The next step is place 0: -1.
    expect(MODEL.seasonalSes(y, 1, 3)).toBeCloseTo(1.999, 12);
    expect(MODEL.seasonalSes(y, 2, 3)).toBeCloseTo(2.999, 12);
    expect(MODEL.seasonalSes(y, 3, 3)).toBeCloseTo(3.999, 12);
    // Under two seasons, or with no season at all, it is plain smoothing.
    expect(MODEL.seasonalSes([1, 2, 3, 2, 3], 1, 3)).toBe(sesLevel([1, 2, 3, 2, 3]));
    expect(MODEL.seasonalSes(y, 1, 1)).toBe(sesLevel(y));
  });

  it('the scale is the mean absolute one-step change; the median is the middle', () => {
    expect(scaleOf([1, 3, 2, 6])).toBeCloseTo(7 / 3, 12);
    expect(scaleOf([4, 4, 4])).toBe(0);
    expect(scaleOf([4])).toBe(0);
    expect([median([3, 1, 2]), median([4, 1, 3, 2]), median([5])]).toEqual([2, 2.5, 5]);
  });

  it('the rolling backtest starts at max(2m, n/2) values and makes one signed error per origin', () => {
    expect([minTrain(30, 7), minTrain(20, 7), minTrain(100, 7), minTrain(30, 1), minTrain(8, 1)]).toEqual([15, 14, 50, 15, 4]);
    // 10, 12, 14, ...: the last value is always 2 behind, at one step and 4 behind at two.
    const y = range(30, (i) => 10 + 2 * i);
    const one = backtest(y, 1, 7);
    expect(one.last).toHaveLength(15);
    expect(new Set(one.last)).toEqual(new Set([2]));
    expect(new Set(one.seasonal)).toEqual(new Set([14]));
    // Drift is exact on a line.
    expect(new Set(one.drift)).toEqual(new Set([0]));
    const two = backtest(y, 2, 7);
    expect(two.last).toHaveLength(14);
    expect(new Set(two.last)).toEqual(new Set([4]));
    // Only the forecasters asked for are run.
    expect(backtest(y, 1, 7, ['last']).drift).toEqual([]);
    expect(backtest([1, 2, 3], 1, 7).last).toEqual([]);
  });

  it('the verdict: null under 8 folds, and only a model under 95% of the naive error beats it', () => {
    expect(verdict(1, 0, 7)).toBeNull();
    expect(verdict(1, 0, 8)).toBe(true);
    expect(verdict(1, 0.94, 8)).toBe(true);
    expect(verdict(1, 0.95, 8)).toBe(false);
    expect(verdict(1, 0.96, 8)).toBe(false);
    expect(verdict(1, 1.5, 200)).toBe(false);
    // A perfect naive forecast cannot be beaten.
    expect(verdict(0, 0, 20)).toBe(false);
  });

  it('a range\'s ends are empirical quantiles with the finite-sample correction: the ceil((k + 1) p)-th of k', () => {
    const errors = (k: number) => range(k, (i) => i - (k - 1) / 2);
    // 9 errors, -4..4, at 80%: the upper end is the ceil(10 x 0.9) = 9th, the lower its mirror, the 1st.
    expect(ends(errors(9), 0.8)).toEqual({ lo: -4, hi: 4 });
    // 19 errors, -9..9: the 18th and the 2nd.
    expect(ends(errors(19), 0.8)).toEqual({ lo: -8, hi: 8 });
    // 8 errors: ceil(9 x 0.9) = 9 is past the end, so the largest and the smallest.
    expect(ends(errors(8), 0.8)).toEqual({ lo: -3.5, hi: 3.5 });
    // 99 errors: the 90th and the 10th. Without the correction it would be the 89th.
    expect(ends(errors(99), 0.8)).toEqual({ lo: -40, hi: 40 });
    // A 50% range of 19: the 15th and the 5th.
    expect(ends(errors(19), 0.5)).toEqual({ lo: -5, hi: 5 });
    // The order the errors arrive in does not matter.
    expect(ends([3, -1, 4, -4, 0, 2, -2, 1, -3], 0.8)).toEqual({ lo: -4, hi: 4 });
  });
});

describe('a forecast, end to end', () => {
  it('a line: drift is exact, so it beats naive; the method would be statistical', () => {
    const y = range(30, (i) => 10 + 2 * i);
    const f = forecast(y, { m: 7, unit: 'count' });
    expect(f).toMatchObject({ version: 'fc.v1', level: 0.8, pick: 'drift', naive: 'last', model: 'drift', folds: 15, beatsNaive: true, steady: false, scale: 2 });
    // The best naive (the last value) is off by 2 every time: 2 over a scale of 2. The model is never off.
    expect(f.naiveMase).toBe(1);
    expect(f.modelMase).toBe(0);
    // Its errors were all 0, so each step's range is its point.
    expect(f.steps).toEqual(range(7, (i) => ({ h: i + 1, mean: 70 + 2 * i, lo: 70 + 2 * i, hi: 70 + 2 * i })));
    // The question: above the median of the last 28 (14..68: 41)? Every sample says yes, and Flint never says more than 95%.
    expect(f.question).toEqual({ threshold: 41, probability: 0.95 });
  });

  it('a pure weekly pattern: the same weekday last week is exact, so no model can beat it; the method would be base_rate', () => {
    const week = [5, 5, 5, 5, 5, 0, 0];
    const y = range(56, (i) => week[i % 7]!);
    const f = forecast(y, { m: 7, unit: 'count' });
    expect(f).toMatchObject({ pick: 'seasonal', naive: 'seasonal', model: 'seasonalSes', folds: 28, beatsNaive: false, steady: false, naiveMase: 0 });
    // The weekly profile is exact here too. Equal is not better: a perfect naive forecast is never beaten.
    expect(f.modelMase).toBe(0);
    // 15 changes of 5 in 55 steps.
    expect(f.scale).toBeCloseTo(75 / 55, 12);
    expect(f.steps.map((s) => s.mean)).toEqual(week);
    for (const s of f.steps) expect([s.lo, s.hi]).toEqual([s.mean, s.mean]);
    // Above 5 (the median)? Never: 5%, not 0.
    expect(f.question).toEqual({ threshold: 5, probability: 0.05 });
  });

  it('too short to tell: under 8 folds the verdict is null, the best naive is used, and the range is where the series has been', () => {
    const y = range(20, (i) => i + 1);
    const f = forecast(y, { m: 7, unit: 'count' });
    expect(f).toMatchObject({ pick: 'last', naive: 'last', folds: 6, beatsNaive: null, steady: false });
    // The last value, 20. Of 1..20 at 80%, the 19th and the 2nd: 2 to 19, widened to hold the point.
    expect(f.steps[0]).toEqual({ h: 1, mean: 20, lo: 2, hi: 20 });
    // Above 10.5? Ten of the twenty values were.
    expect(f.question).toEqual({ threshold: 10.5, probability: 0.5 });
    // The scores are still said: the last value was off by 1 over a scale of 1.
    expect(f.naiveMase).toBe(1);
  });

  it('a steady series: a flat line, no verdict and no question (a range of 0 to 0 would be right every day and flatter every score)', () => {
    const f = forecast(range(40, () => 3), { m: 7, unit: 'count' });
    expect(f).toMatchObject({ steady: true, beatsNaive: null, scale: 0, naiveMase: null, modelMase: null });
    expect(f.question).toBeUndefined();
    expect(f.steps).toEqual(range(7, (i) => ({ h: i + 1, mean: 3, lo: 3, hi: 3 })));
    // Zero for a month after a busy spring is steady too: only the last 28 count.
    const quiet = forecast([...range(30, (i) => 5 + (i % 3)), ...range(28, () => 0)], { m: 7, unit: 'usd' });
    expect(quiet.steady).toBe(true);
    expect(quiet.question).toBeUndefined();
    expect(quiet.beatsNaive).toBeNull();
    // 27 the same and one different is not steady.
    expect(forecast([...range(30, () => 0), 1, ...range(27, () => 0)], { m: 7, unit: 'count' }).steady).toBe(false);
  });

  it('nothing goes below 0, a count\'s range is whole numbers rounded outward, and dollars are to the cent', () => {
    // Mostly zero with bursts: the errors reach well below the point.
    const bursts = range(60, (i) => (i % 9 === 4 ? 30 + (i % 5) : 0));
    const f = forecast(bursts, { m: 7, unit: 'minutes' });
    for (const s of f.steps) {
      expect(s.lo).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(s.lo) && Number.isInteger(s.hi) && Number.isInteger(s.mean)).toBe(true);
    }
    const dollars = forecast(range(40, (i) => 1.234 + 0.317 * (i % 5)), { m: 7, unit: 'usd' });
    for (const s of dollars.steps) for (const v of [s.mean, s.lo, s.hi]) expect(Math.abs(v * 100 - Math.round(v * 100))).toBeLessThan(1e-6);
    // Outward: a range of 2.2 to 3.7 counts is 2 to 4, never 3 to 3.
    const frac = forecast(range(20, (i) => 2.2 + 1.5 * (i % 2)), { m: 1, unit: 'count' });
    expect(frac.steps[0]!.lo).toBeLessThanOrEqual(2);
    expect(frac.steps[0]!.hi).toBeGreaterThanOrEqual(4);
  });

  it('the same input gives the same output, and the input is not changed', () => {
    const rand = rng(7);
    const y = range(120, (i) => Math.round((i % 7 < 5 ? 4 : 1) * (0.5 + rand()) * 100) / 100);
    const copy = [...y];
    const a = forecast(y, { m: 7, unit: 'usd' });
    const b = forecast(y, { m: 7, unit: 'usd' });
    expect(a).toEqual(b);
    expect(y).toEqual(copy);
    expect(JSON.stringify(a)).toBe(JSON.stringify(forecast([...y], { m: 7, unit: 'usd' })));
  });

  it('on random inputs: lower <= point <= upper, a probability within 5% and 95%, finite numbers, scores that agree with the verdict', () => {
    const rand = rng(20261013);
    for (let trial = 0; trial < 200; trial++) {
      const n = 14 + Math.floor(rand() * 150);
      const kind = trial % 5;
      const y = range(n, (i) => {
        const dow = i % 7;
        if (kind === 0) return Math.round((dow >= 5 ? 0.6 : 3.5) * 2 * rand());
        if (kind === 1) return Math.round(Math.max(0, (dow >= 5 ? 0.2 : 1.2) * (0.5 + rand())) * 100) / 100;
        if (kind === 2) return rand() < 0.12 ? Math.round(5 + 60 * rand()) : 0;
        if (kind === 3) return Math.round(10 + 0.3 * i + 2 * (rand() - 0.5));
        return Math.round(rand() * 8 * 2) / 2;
      });
      const unit = (['count', 'usd', 'minutes', 'count', 'hours'] as const)[kind]!;
      const f = forecast(y, { m: trial % 3 === 0 ? 1 : 7, unit });
      expect(f.steps).toHaveLength(7);
      for (const s of f.steps) {
        expect(Number.isFinite(s.mean) && Number.isFinite(s.lo) && Number.isFinite(s.hi), `trial ${trial}`).toBe(true);
        expect(s.lo, `trial ${trial}`).toBeLessThanOrEqual(s.mean);
        expect(s.mean, `trial ${trial}`).toBeLessThanOrEqual(s.hi);
        expect(s.lo, `trial ${trial}`).toBeGreaterThanOrEqual(0);
      }
      if (f.question) {
        expect(f.question.probability, `trial ${trial}`).toBeGreaterThanOrEqual(0.05);
        expect(f.question.probability, `trial ${trial}`).toBeLessThanOrEqual(0.95);
        expect(Number.isFinite(f.question.threshold)).toBe(true);
      } else expect(f.steady).toBe(true);
      // The record a run keeps: a verdict has both scores, and a win has the lower one (the database checks the same).
      if (f.beatsNaive !== null) {
        expect(f.folds).toBeGreaterThanOrEqual(8);
        expect(f.naiveMase !== null && f.modelMase !== null, `trial ${trial}`).toBe(true);
        if (f.beatsNaive) expect(f.modelMase!).toBeLessThan(f.naiveMase!);
      }
      if (f.beatsNaive) expect(Object.keys(MODEL)).toContain(f.pick);
      else expect(Object.keys(NAIVE)).toContain(f.pick);
    }
  });

  it('refuses what is not a series: fewer than two values, or a value that is not a number', () => {
    expect(() => forecast([4], { m: 7, unit: 'count' })).toThrow('a forecast needs two finite values or more');
    expect(() => forecast([4, Number.NaN, 5], { m: 7, unit: 'count' })).toThrow();
    expect(() => forecast([4, Infinity], { m: 7, unit: 'count' })).toThrow();
  });
});

describe('what makes a history ready', () => {
  const points = (entries: Array<[number, number]>) => new Map(entries);
  const run = (from: number, to: number, f: (i: number) => number = (i) => i) => range(to - from, (j) => [from + j, f(from + j)] as [number, number]);

  it('14 days (8 weeks) of numbers up to the step before the one being forecast', () => {
    expect(prepare(points(run(0, 14)), 14, 7)).toEqual({ ok: true, values: range(14, (i) => i), filled: 0, first: 0 });
    expect(prepare(points(run(0, 13)), 13, 7)).toMatchObject({ ok: false, why: 'too_short', missing: 1 });
    expect(prepare(points([]), 5, 7)).toMatchObject({ ok: false, why: 'too_short', missing: 14 });
    expect(prepare(points(run(0, 8)), 8, 1)).toMatchObject({ ok: true, filled: 0 });
    expect(prepare(points(run(0, 7)), 7, 1)).toMatchObject({ ok: false, why: 'too_short', missing: 1 });
    // Numbers at or after the step being forecast are not history.
    expect(prepare(points(run(0, 20)), 14, 7).values).toEqual(range(14, (i) => i));
  });

  it('the latest number may be one step late (it is filled with the same weekday last week); older than that, the series is stale', () => {
    const late = prepare(points(run(0, 20)), 21, 7);
    expect(late).toMatchObject({ ok: true, filled: 1, first: 0 });
    expect(late.values).toHaveLength(21);
    expect(late.values[20]).toBe(13);
    expect(prepare(points(run(0, 20)), 22, 7)).toMatchObject({ ok: false, why: 'stale' });
    // A weekly series has no weekday: the previous value.
    expect(prepare(points(run(0, 9)), 10, 1).values[9]).toBe(8);
  });

  it('a gap of one or two steps is filled and counted; a longer one cuts the history there', () => {
    const gappy = points([...run(0, 10), ...run(12, 30)]);
    const p = prepare(gappy, 30, 7);
    expect(p).toMatchObject({ ok: true, filled: 2, first: 0 });
    // Steps 10 and 11 take the values of 3 and 4 (a week before).
    expect(p.values.slice(9, 13)).toEqual([9, 3, 4, 12]);
    // A three-step gap: only what came after it.
    const cut = prepare(points([...run(0, 10), ...run(13, 30)]), 30, 7);
    expect(cut).toMatchObject({ ok: true, filled: 0, first: 13 });
    expect(cut.values).toEqual(range(17, (i) => 13 + i));
    // And what came after may be too short.
    expect(prepare(points([...run(0, 20), ...run(23, 30)]), 30, 7)).toMatchObject({ ok: false, why: 'too_short', missing: 7, first: 23 });
    // A gap with no week before it takes the previous value.
    expect(prepare(points([...run(0, 3), ...run(4, 20)]), 20, 7).values.slice(2, 5)).toEqual([2, 2, 4]);
  });

  it('at most the last 400 steps, starting on a number that is there', () => {
    const long = prepare(points(run(0, 600)), 600, 7);
    expect(long).toMatchObject({ ok: true, first: 200 });
    expect(long.values).toHaveLength(400);
    const holed = points(run(0, 600).filter(([i]) => i !== 200));
    const p = prepare(holed, 600, 7);
    expect(p).toMatchObject({ ok: true, first: 201, filled: 0 });
    expect(p.values).toHaveLength(399);
  });
});
