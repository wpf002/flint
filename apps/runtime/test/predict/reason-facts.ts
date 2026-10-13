/**
 * A synthetic number for the estimate seam's tests and its recorded cassette:
 * made-up deploy counts with a weekday shape, a threshold, a forecast and a
 * record. Nothing here is a real series' value.
 */
import type { EstimateFacts } from '../../src/predict/reason';

/** 28 days ending Sunday 2026-10-11: weekdays busy, weekends quiet. */
const VALUES = [4, 5, 3, 6, 4, 1, 0, 5, 4, 6, 5, 3, 0, 1, 6, 5, 4, 7, 5, 1, 0, 4, 6, 5, 6, 4, 0, 1];

const day = (i: number): string => new Date(Date.UTC(2026, 8, 14) + i * 86_400_000).toISOString().slice(0, 10);

export const SYNTHETIC_FACTS: EstimateFacts = {
  name: 'Deploys', unit: 'count', step: 'day',
  values: VALUES.map((value, i) => ({ day: day(i), value })),
  on: '2026-10-12',
  threshold: 4,
  forecast: { mean: 4.6, lo: 2, hi: 7, level: 0.8, beatsNaive: true },
  record: { yes: 11, settled: 24 },
};
