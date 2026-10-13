/**
 * The local forecaster against hand-computed fixtures (P4 part 3): each
 * candidate, the backtest, MASE, the verdict (false, null, the 5% margin, more
 * than chance, and the history a model needs), the ranges with their
 * finite-sample correction and the 10 errors one needs, the weekday's own
 * error size, where the question's chance comes from, the floors, and what
 * makes a history ready. Pure: the same input gives the same output. How it
 * does on whole simulated series is forecast-sim.test.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  FC_VERSION, LEVEL, MARGIN, MAX_FILLED, MAX_GAP, MAX_HISTORY, MIN_ERRORS, MIN_FOLDS, MIN_PER_WEEKDAY, MIN_PRIOR, MODEL, NAIVE, RECORD, SES_ALPHAS, STEP, STEPS, SURE,
  WEEKDAY_LEAN, WEEKDAY_NIGHTS,
  backtest, ends, forecast, median, minHistory, minTrain, modelHistory, onWeekday, prepare, profile, scaleOf, sesLevel, slope, sure, verdict,
} from '../../src/predict/forecast';

const range = <T>(n: number, f: (i: number) => T): T[] => Array.from({ length: n }, (_, i) => f(i));
/** A seeded generator, for inputs that are random and the same on every run. */
function rng(seed: number): () => number {
  let x = seed >>> 0;
  return () => ((x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

describe('the forecaster\'s parts, by hand', () => {
  it('the constants are the method\'s: an 80% range from 10 errors or more, a 5% margin and 1.28 standard errors, 56 days or 26 weeks for a model, seven steps', () => {
    expect([FC_VERSION, LEVEL, MIN_FOLDS, MIN_ERRORS, MARGIN, SURE, STEPS, MAX_GAP, MAX_HISTORY, MAX_FILLED]).toEqual(['fc.v1', 0.8, 8, 10, 0.05, 1.28, 7, 2, 400, 0.2]);
    expect([...SES_ALPHAS]).toEqual([0.1, 0.2, 0.3, 0.5, 0.7, 0.9]);
    expect(STEP).toEqual({ count: 1, minutes: 1, usd: 0.01, hours: 0.01 });
    expect([modelHistory(7), modelHistory(1)]).toEqual([56, 26]);
    expect([MIN_PER_WEEKDAY, WEEKDAY_LEAN, WEEKDAY_NIGHTS, MIN_PRIOR, RECORD]).toEqual([2, 0.5, 4, 5, { right: 1, wrong: 3 }]);
    // The first forecast of a number: the fewest steps that leave 10 backtest errors. 24 days (24 - 14), 19 weeks (19 - 9).
    expect([minHistory(7), minHistory(1)]).toEqual([24, 19]);
    for (const m of [7, 1]) {
      const n = minHistory(m);
      expect(backtest(range(n, (i) => i), 1, m).last).toHaveLength(MIN_ERRORS);
      expect(backtest(range(n - 1, (i) => i), 1, m).last).toHaveLength(MIN_ERRORS - 1);
    }
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
    // The average step is over the whole history, however long: 0, then thirty-nine 100s, is 100 / 39 a step.
    expect(MODEL.drift([0, ...range(39, () => 100)], 1, 7)).toBeCloseTo(100 + 100 / 39, 12);
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

  it('more than chance: the fold-by-fold gain must average 1.28 of its standard errors above zero', () => {
    // The model's error is smaller by 1, 2, 1, 2, ...: a mean gain of 1.5 with a standard error of about 0.13.
    expect(sure(range(16, () => 3), range(16, (i) => 2 - (i % 2)))).toBe(true);
    // Smaller on average, but by luck: gains of 9, then fifteen of -0.5. Mean 0.09, standard error 0.59.
    expect(sure([10, ...range(15, () => 1)], [1, ...range(15, () => 1.5)])).toBe(false);
    // A gain that is the same every fold is as sure as it gets; no gain, or a loss, is not.
    expect(sure(range(10, () => 2), range(10, () => 1))).toBe(true);
    expect(sure(range(10, () => 2), range(10, () => 2))).toBe(false);
    expect(sure(range(10, () => 1), range(10, () => 2))).toBe(false);
    // Signs do not matter: it is the size of each error.
    expect(sure(range(10, (i) => (i % 2 ? 3 : -3)), range(10, (i) => (i % 2 ? -1 : 1)))).toBe(true);
    // Exactly at the line: gains 0 and 2 alternating over 16 folds have mean 1 and standard error 0.2582: 3.87 of them.
    expect(sure(range(16, () => 2), range(16, (i) => (i % 2 ? 0 : 2)))).toBe(true);
    expect(sure([1], [0])).toBe(false);
  });

  it('the weekday\'s own error size: each error is measured against its own weekday\'s usual size, and put at the target\'s', () => {
    // A season of 2. Place 0 errs by 1, place 1 by 10. The usual size of all four is 5.5.
    const errors = [1, 10, -1, -10];
    // Each place leans half an error on the usual size: (2 + 0.5 x 5.5) / 2.5 = 1.9 and (20 + 2.75) / 2.5 = 9.1.
    // For a target at place 0 the size is 1.9, widened for resting on two errors: by sqrt(1 + 1/2). So an error of 1
    // at place 0 (the usual size there, near enough) comes out as sqrt(1.5), and the 10 from place 1 not much larger.
    const wide = Math.sqrt(1.5);
    const at0 = onWeekday(errors, 0, 2, 4);
    expect(at0[0]).toBeCloseTo(wide, 12);
    expect(at0[1]).toBeCloseTo((10 / 9.1) * 1.9 * wide, 12);
    expect(at0[2]).toBeCloseTo(-wide, 12);
    // For a target at place 1 the same errors are about five times the size.
    const at1 = onWeekday(errors, 0, 2, 5);
    expect(at1[1]).toBeCloseTo(10 * wide, 12);
    expect(at1[0]).toBeCloseTo((1 / 1.9) * 9.1 * wide, 12);
    // Where the first error sits in the season is what `first` says: the same errors, starting one place on.
    expect(onWeekday(errors, 1, 2, 5)[0]).toBeCloseTo(wide, 12);
    // A weekday with fewer than two errors, a series with no season, or errors that are all 0: as they are.
    expect(onWeekday([1, 10, -1], 0, 2, 4)).toEqual([1, 10, -1]);
    expect(onWeekday(errors, 0, 1, 4)).toEqual(errors);
    expect(onWeekday([0, 0, 0, 0], 0, 2, 4)).toEqual([0, 0, 0, 0]);
    // The input is not changed.
    expect(errors).toEqual([1, 10, -1, -10]);
  });

  it('a range\'s ends are empirical quantiles with the finite-sample correction: the ceil((k + 1) p)-th of k', () => {
    const errors = (k: number) => range(k, (i) => i - (k - 1) / 2);
    // 9 errors, -4..4, at 80%: the upper end is the ceil(10 x 0.9) = 9th, the lower its mirror, the 1st.
    expect(ends(errors(9), 0.8)).toEqual({ lo: -4, hi: 4 });
    // 19 errors, -9..9: the 18th and the 2nd.
    expect(ends(errors(19), 0.8)).toEqual({ lo: -8, hi: 8 });
    // 8 errors: ceil(9 x 0.9) = 9 is past the end, so the largest and the smallest: 7 chances in 9, short of 80%. So a
    // range is stated only from 10 errors, whose least to greatest is 9 chances in 11.
    expect(ends(errors(8), 0.8)).toEqual({ lo: -3.5, hi: 3.5 });
    expect(ends(errors(10), 0.8)).toEqual({ lo: -4.5, hi: 4.5 });
    expect((MIN_ERRORS - 1) / (MIN_ERRORS + 1)).toBeGreaterThanOrEqual(0.8);
    expect((MIN_ERRORS - 3) / (MIN_ERRORS - 1)).toBeLessThan(0.8);
    // 99 errors: the 90th and the 10th. Without the correction it would be the 89th.
    expect(ends(errors(99), 0.8)).toEqual({ lo: -40, hi: 40 });
    // A 50% range of 19: the 15th and the 5th.
    expect(ends(errors(19), 0.5)).toEqual({ lo: -5, hi: 5 });
    // The order the errors arrive in does not matter.
    expect(ends([3, -1, 4, -4, 0, 2, -2, 1, -3], 0.8)).toEqual({ lo: -4, hi: 4 });
  });
});

describe('a forecast, end to end', () => {
  it('a line, 60 days of it: drift is exact, so it beats naive; the method would be statistical', () => {
    const y = range(60, (i) => 10 + 2 * i);
    const f = forecast(y, { m: 7, unit: 'count' });
    expect(f).toMatchObject({ version: 'fc.v1', level: 0.8, pick: 'drift', naive: 'last', model: 'drift', folds: 30, beatsNaive: true, steady: false, weekday: false, scale: 2 });
    // The best naive (the last value) is off by 2 every time: 2 over a scale of 2. The model is never off.
    expect(f.naiveMase).toBe(1);
    expect(f.modelMase).toBe(0);
    // Its errors were all 0, so each step's range is its point.
    expect(f.steps).toEqual(range(7, (i) => ({ h: i + 1, mean: 130 + 2 * i, lo: 130 + 2 * i, hi: 130 + 2 * i })));
    // The question: above the median of the last 28 (74..128: 101)? Its own errors may speak (it knows far more than the
    // typical value, and replayed it scored better), and every one says yes. But it has only made 25 such calls, all
    // right: with the four it starts with (one right, three wrong) that is 26 of 29, and it says no more than that.
    expect(f.question).toEqual({ threshold: 101, probability: 0.9, from: 'errors' });
    expect(26 / 29).toBeCloseTo(0.8966, 4);
    // 26 right in a row is what 90% takes: 27 of 30.
    expect([(25 + RECORD.right) / (25 + RECORD.right + RECORD.wrong) < 0.9, (26 + RECORD.right) / (26 + RECORD.right + RECORD.wrong) >= 0.9]).toEqual([true, true]);
  });

  it('the same line with 55 days: too short for a model to be believed, however well it did; the answer is the plain guess', () => {
    const f = forecast(range(55, (i) => 10 + 2 * i), { m: 7, unit: 'count' });
    expect(f).toMatchObject({ pick: 'last', naive: 'last', model: 'drift', folds: 28, beatsNaive: null, naiveMase: 1, modelMase: 0 });
    // The last value (118), which has been 2 low every time: 118 to 120.
    expect(f.steps[0]).toEqual({ h: 1, mean: 118, lo: 118, hi: 120 });
    // Each later step has its own errors, not the first step's: three steps on, the last value has been 6 low every time.
    expect(f.steps[2]).toEqual({ h: 3, mean: 118, lo: 118, hi: 124 });
    expect(f.steps[6]).toEqual({ h: 7, mean: 118, lo: 118, hi: 132 });
    // A weekly number needs 26 weeks.
    expect(forecast(range(25, (i) => 10 + 2 * i), { m: 1, unit: 'count' }).beatsNaive).toBeNull();
    expect(forecast(range(26, (i) => 10 + 2 * i), { m: 1, unit: 'count' })).toMatchObject({ beatsNaive: true, pick: 'drift' });
  });

  it('a model that did better by luck is not kept: better by the margin, but not by more than chance', () => {
    // A level of 20 with one jump the model happened to catch... is not built by hand easily; this is the rule's two halves.
    const rand = rng(91);
    // Patternless: 80 days of noise around 20. Whatever wins the backtest, the verdict is not "beat a plain guess".
    let kept = 0;
    for (let s = 0; s < 40; s++) if (forecast(range(80, () => Math.round(20 + 10 * (rand() - 0.5))), { m: 7, unit: 'count' }).beatsNaive === true) kept += 1;
    expect(kept).toBeLessThanOrEqual(3);
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
    // Above 5 (the median)? Never: 5%, not 0. Said from the recent values: its own errors would say 0 as well, and
    // a "never" with no record behind it does not outscore that.
    expect(f.question).toEqual({ threshold: 5, probability: 0.05, from: 'recent' });
  });

  it('a range needs 10 errors behind it: with fewer, none is stated and nothing is asked; with exactly 10, only the first step has one', () => {
    // 20 days: 6 errors.
    const short = forecast(range(20, (i) => i + 1), { m: 7, unit: 'count' });
    expect(short).toMatchObject({ pick: 'last', naive: 'last', folds: 6, beatsNaive: null, steady: false, steps: [] });
    expect(short.question).toBeUndefined();
    // The scores are still said: the last value was off by 1 over a scale of 1.
    expect(short.naiveMase).toBe(1);
    // 24 days: 10 errors at one step, 9 at two. The last value, 24, has been 1 low every time.
    const f = forecast(range(24, (i) => i + 1), { m: 7, unit: 'count' });
    expect(f.folds).toBe(10);
    expect(f.steps).toEqual([{ h: 1, mean: 24, lo: 24, hi: 25 }]);
    // Above 12.5? Twelve of the 24 values were. Its own errors have not been replayed over enough nights to speak.
    expect(f.question).toEqual({ threshold: 12.5, probability: 0.5, from: 'recent' });
    // 40 days: 20 errors at one step and 14 at seven, so all seven steps.
    expect(forecast(range(40, (i) => i + 1), { m: 7, unit: 'count' }).steps).toHaveLength(7);
    // 30 days: 15 errors at one step, 10 at six, 9 at seven.
    expect(forecast(range(30, (i) => i + 1), { m: 7, unit: 'count' }).steps).toHaveLength(6);
  });

  it('mostly zero with rare bursts: the night after a burst the chance is what the series has shown, never 95%', () => {
    // 90 days, a burst every ninth day or so. The last day was one.
    const y = range(90, (i) => (i % 9 === 8 ? 40 + (i % 7) : 0));
    expect(y[89]).toBeGreaterThan(0);
    const f = forecast(y, { m: 7, unit: 'minutes' });
    // "The last value" would forecast another burst, and every one of its past errors keeps that above 0.
    expect(f.question).toMatchObject({ threshold: 0, from: 'recent' });
    // Of the last 56 days, 7 had a burst: one in eight.
    expect(f.question!.probability).toBe(0.13);
  });

  it('a number that wanders from where it was: its own errors speak, and say no more than their record', () => {
    // A slow climb with a wobble: tomorrow is near today, far above the median of the last 28.
    const y = range(120, (i) => 50 + i + (i % 3));
    const f = forecast(y, { m: 7, unit: 'count' });
    expect(f.question!.from).toBe('errors');
    expect(f.question!.probability).toBeGreaterThanOrEqual(0.9);
    expect(f.question!.probability).toBeLessThanOrEqual(0.95);
    // With a short record it holds back: the same climb at 26 days has been replayed over 7 nights, one short of 8, and says what was seen.
    expect(forecast(y.slice(0, 26), { m: 7, unit: 'count' }).question!.from).toBe('recent');
    expect(forecast(y.slice(0, 27), { m: 7, unit: 'count' }).question!.from).toBe('errors');
  });

  it('weekdays that differ: once the weekday\'s way has scored better, a quiet day gets a narrow range and a busy day a wide one', () => {
    const rand = rng(8);
    // Busy weekdays swing by several hours; weekends hardly move.
    const y = range(98, (i) => Math.round((4 + (i % 7 < 5 ? 5 * (rand() - 0.5) : 0.2 * (rand() - 0.5))) * 100) / 100);
    // 98 days end on a Sunday (place 6), so the next day is a Monday (place 0) and the sixth step is a Saturday.
    const f = forecast(y, { m: 7, unit: 'hours' });
    expect(f.weekday).toBe(true);
    const width = (h: number) => f.steps[h - 1]!.hi - f.steps[h - 1]!.lo;
    expect(width(1)).toBeGreaterThan(2 * width(6));
    expect(width(6)).toBeLessThan(1.2);
    // A number with no weekday in it keeps one pool of errors.
    expect(forecast(range(98, () => Math.round(4 + 5 * (rand() - 0.5))), { m: 7, unit: 'count' }).weekday).toBe(false);
    // A weekly number has no weekdays.
    expect(forecast(range(40, () => Math.round(20 + 5 * (rand() - 0.5))), { m: 1, unit: 'count' }).weekday).toBe(false);
  });

  it('every number that comes out is finite, or nothing comes out', () => {
    // Values near the largest a float holds: the sums overflow.
    const huge = range(40, (i) => (i % 2 ? 1.7e308 : 1e308));
    expect(() => forecast(huge, { m: 7, unit: 'count' })).toThrow('a forecast came out with a value that is not a number');
    // Large but sound values are fine.
    const big = forecast(range(40, (i) => 1e15 + i * 1e9), { m: 7, unit: 'count' });
    for (const st of big.steps) expect(Number.isFinite(st.mean) && Number.isFinite(st.lo) && Number.isFinite(st.hi)).toBe(true);
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
    // Outward: a range of about 2.6 to 3.4 counts is 2 to 4. Rounded to the nearest it would be 3 to 3, and hold nothing.
    const frac = forecast(range(20, (i) => 2.6 + 0.8 * (i % 2)), { m: 1, unit: 'count' });
    expect(frac.pick).toBe('mean28');
    expect(frac.steps[0]).toEqual({ h: 1, mean: 3, lo: 2, hi: 4 });
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
      const m = trial % 3 === 0 ? 1 : 7;
      const f = forecast(y, { m, unit });
      // A step is said only with 10 errors behind it: from the minimum history on there is at least the first.
      expect(f.steps.length, `trial ${trial}`).toBeLessThanOrEqual(7);
      if (n >= minHistory(m)) expect(f.steps.length, `trial ${trial}`).toBeGreaterThanOrEqual(1);
      else expect(f.steps, `trial ${trial}`).toEqual([]);
      expect(f.steps.map((x) => x.h)).toEqual(range(f.steps.length, (i) => i + 1));
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
        expect(['recent', 'errors']).toContain(f.question.from);
      } else expect(f.steady || f.steps.length === 0, `trial ${trial}`).toBe(true);
      // The record a run keeps: a verdict has both scores, and a win has the lower one (the database checks the same).
      if (f.beatsNaive !== null) {
        expect(n, `trial ${trial}`).toBeGreaterThanOrEqual(modelHistory(m));
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

  it('24 days (19 weeks) of numbers up to the step before the one being forecast', () => {
    expect(prepare(points(run(0, 24)), 24, 7)).toEqual({ ok: true, values: range(24, (i) => i), filled: 0, first: 0 });
    expect(prepare(points(run(0, 23)), 23, 7)).toMatchObject({ ok: false, why: 'too_short', missing: 1 });
    expect(prepare(points([]), 5, 7)).toMatchObject({ ok: false, why: 'too_short', missing: 24 });
    expect(prepare(points(run(0, 19)), 19, 1)).toMatchObject({ ok: true, filled: 0 });
    expect(prepare(points(run(0, 18)), 18, 1)).toMatchObject({ ok: false, why: 'too_short', missing: 1 });
    // Numbers at or after the step being forecast are not history.
    expect(prepare(points(run(0, 30)), 24, 7).values).toEqual(range(24, (i) => i));
  });

  it('the latest number must be there: a forecast is never made from a filled-in latest value; the number is late, and waits', () => {
    // Yesterday's number is missing (review finding 5: a rising line with yesterday missing was forecast from last week's value).
    expect(prepare(points(run(0, 30)), 31, 7)).toEqual({ ok: false, why: 'late', values: [], filled: 0, first: 31 });
    expect(prepare(points(run(0, 30)), 32, 7)).toMatchObject({ ok: false, why: 'late' });
    expect(prepare(points(run(0, 30)), 400, 7)).toMatchObject({ ok: false, why: 'late' });
    // The night it arrives, the number is ready again, with the day before it filled.
    expect(prepare(points([...run(0, 30), [31, 31]]), 32, 7)).toMatchObject({ ok: true, filled: 1 });
    // A weekly number the same.
    expect(prepare(points(run(0, 25)), 26, 1)).toMatchObject({ ok: false, why: 'late' });
  });

  it('a gap of one or two steps further back is filled and counted; a longer one cuts the history there', () => {
    const gappy = points([...run(0, 10), ...run(12, 40)]);
    const p = prepare(gappy, 40, 7);
    expect(p).toMatchObject({ ok: true, filled: 2, first: 0 });
    // Steps 10 and 11 take the values of 3 and 4 (a week before).
    expect(p.values.slice(9, 13)).toEqual([9, 3, 4, 12]);
    // A three-step gap: only what came after it.
    const cut = prepare(points([...run(0, 10), ...run(13, 40)]), 40, 7);
    expect(cut).toMatchObject({ ok: true, filled: 0, first: 13 });
    expect(cut.values).toEqual(range(27, (i) => 13 + i));
    // And what came after may be too short.
    expect(prepare(points([...run(0, 20), ...run(23, 40)]), 40, 7)).toMatchObject({ ok: false, why: 'too_short', missing: 7, first: 23 });
    // A gap with no week before it takes the previous value.
    expect(prepare(points([...run(0, 3), ...run(4, 30)]), 30, 7).values.slice(2, 5)).toEqual([2, 2, 4]);
  });

  it('filled values are at most a fifth of the history used: older steps are let go until they are, or the history is too short', () => {
    // One number in three is there for the first 60 steps, then 40 whole ones (review finding 5: 66 of 100 steps were fill).
    const sparse = points([...run(0, 60).filter(([i]) => i % 3 === 0), ...run(60, 100)]);
    const p = prepare(sparse, 100, 7);
    expect(p.ok).toBe(true);
    expect(p.filled).toBeLessThanOrEqual(p.values.length * MAX_FILLED);
    // It starts on a number that is there, and keeps as much as the fifth allows: 40 whole steps carry 10 filled ones.
    expect(p).toMatchObject({ first: 45, filled: 10 });
    expect(p.values).toHaveLength(55);
    // One number in three all the way: nothing long enough is whole enough.
    const thin = prepare(points([...run(0, 100).filter(([i]) => i % 3 === 0 || i >= 98)]), 100, 7);
    expect(thin).toMatchObject({ ok: false, why: 'too_short' });
    expect(thin.values.length).toBeLessThan(24);
    // Exactly a fifth is allowed: 20 whole steps, 5 filled in two gaps and a single, 5 whole.
    const fifth = prepare(points(([...run(0, 8), ...run(10, 16), ...run(18, 24), [25, 25], ...run(26, 30)] as Array<[number, number]>).filter(([i]) => i !== 24)), 30, 7);
    expect(fifth).toMatchObject({ ok: true, first: 0 });
    expect(fifth.filled / fifth.values.length).toBeLessThanOrEqual(MAX_FILLED);
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
