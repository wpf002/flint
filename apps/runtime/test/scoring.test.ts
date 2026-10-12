/**
 * Scoring against an independent reference on a 1,000-row fixture, to 1e-9.
 * The reference is written the plain way (one pass, BigInt-free, no shared
 * helpers) so a bug in scoring.ts cannot hide in both. P4 adds ECE and, for
 * ranges, coverage and the pinball loss: each against hand-computed values,
 * then against the reference on 1,000 rows.
 */
import { describe, it, expect } from 'vitest';
import { brier, ece, intervalCoverage, quantileLoss, rangeLoss, reliability, reliabilityGap, score, scoreRanges, type Scored, type ScoredRange } from '../src/ledger/scoring';
import { periodKey } from '../src/governance/counters';

/** Deterministic fixture: a seeded LCG, forecasts roughly calibrated with noise. */
function fixture(n = 1000, seed = 20261001): Scored[] {
  let x = seed;
  const rand = () => ((x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  return Array.from({ length: n }, () => {
    const p = Math.round((0.05 + rand() * 0.9) * 1000) / 1000;
    return { p, o: rand() < p + (rand() - 0.5) * 0.2 };
  });
}

function reference(rows: Scored[]) {
  let sq = 0;
  let pos = 0;
  for (const r of rows) {
    sq += (r.p - (r.o ? 1 : 0)) * (r.p - (r.o ? 1 : 0));
    if (r.o) pos += 1;
  }
  const brierRef = sq / rows.length;
  const base = pos / rows.length;
  const bins = [];
  for (let i = 0; i < 10; i++) {
    let n = 0;
    let sp = 0;
    let so = 0;
    for (const r of rows) {
      const b = Math.min(9, Math.floor(r.p * 10));
      if (b === i) {
        n++;
        sp += r.p;
        so += r.o ? 1 : 0;
      }
    }
    bins.push({ n, meanP: n ? sp / n : null, freq: n ? so / n : null });
  }
  let gap = 0;
  for (const b of bins) if (b.n) gap += (b.n / rows.length) * Math.abs(b.meanP! - b.freq!);
  return { brier: brierRef, base, skill: 1 - brierRef / (base * (1 - base)), bins, ece: gap };
}

/** Deterministic ranges: a seeded LCG; about four in five hold; one in fifty has no scale, one in fifty a scale of 0. */
function rangeFixture(n = 1000, seed = 20261013): ScoredRange[] {
  let x = seed;
  const rand = () => ((x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  return Array.from({ length: n }, (_, i) => {
    const mid = Math.round(rand() * 2000) / 10;
    const half = Math.round((1 + rand() * 20) * 10) / 10;
    const value = Math.round((mid + (rand() - 0.5) * half * 2.5) * 10) / 10;
    const scale = i % 50 === 7 ? null : i % 50 === 13 ? 0 : Math.round((0.5 + rand() * 9) * 100) / 100;
    return { lower: mid - half, upper: mid + half, level: i % 3 === 0 ? 0.5 : 0.8, value, scale };
  });
}

function rangeReference(rows: ScoredRange[]) {
  let held = 0;
  let loss = 0;
  let scaled = 0;
  for (const r of rows) {
    if (r.value >= r.lower && r.value <= r.upper) held += 1;
    if (r.scale === null || r.scale === 0) continue;
    const lo = (1 - r.level) / 2;
    const hi = (1 + r.level) / 2;
    const atLower = r.value >= r.lower ? lo * (r.value - r.lower) : (1 - lo) * (r.lower - r.value);
    const atUpper = r.value >= r.upper ? hi * (r.value - r.upper) : (1 - hi) * (r.upper - r.value);
    loss += (atLower + atUpper) / 2 / r.scale;
    scaled += 1;
  }
  return { coverage: held / rows.length, pinball: loss / scaled, unscaled: rows.length - scaled };
}

describe('scoring', () => {
  const rows = fixture();
  const ref = reference(rows);
  const s = score(rows);

  it('Brier, base rate and skill match the reference to 1e-9', () => {
    expect(s.n).toBe(1000);
    expect(Math.abs(s.brier - ref.brier)).toBeLessThan(1e-9);
    expect(Math.abs(s.baseRate - ref.base)).toBeLessThan(1e-9);
    expect(Math.abs(s.brierSkill! - ref.skill)).toBeLessThan(1e-9);
  });

  it('reliability bins match the reference to 1e-9', () => {
    s.reliability.forEach((b, i) => {
      const r = ref.bins[i]!;
      expect(b.n, `bin ${i}`).toBe(r.n);
      if (r.n) {
        expect(Math.abs(b.meanP! - r.meanP!)).toBeLessThan(1e-9);
        expect(Math.abs(b.freq! - r.freq!)).toBeLessThan(1e-9);
      } else {
        expect(b.meanP).toBeNull();
      }
    });
    expect(s.reliability.reduce((t, b) => t + b.n, 0)).toBe(1000);
  });

  it('ECE matches the reference to 1e-9, and is the reliability gap of the stored bins', () => {
    expect(Math.abs(s.ece! - ref.ece)).toBeLessThan(1e-9);
    expect(Math.abs(ece(rows)! - ref.ece)).toBeLessThan(1e-9);
    // The gap is computed from bins alone (the note and the phrase table read stored snapshots, not rows).
    expect(reliabilityGap(JSON.parse(JSON.stringify(s.reliability)))).toBe(s.ece);
    expect(s.ece!).toBeGreaterThan(0);
    expect(s.ece!).toBeLessThan(1);
  });

  it('ECE against a hand-computed value: three bins, weighted by how many predictions each holds', () => {
    const said = (p: number, outcomes: boolean[]) => outcomes.map((o) => ({ p, o }));
    const hand = [...said(0.2, [true, false, false, false]), ...said(0.7, [true, true, true, false, false]), ...said(0.95, [true])];
    // 0.2: 1 of 4 came true (0.25), gap 0.05, weight 0.4. 0.7: 3 of 5 (0.6), gap 0.1, weight 0.5. 0.95: 1 of 1, gap 0.05, weight 0.1.
    expect(ece(hand)).toBeCloseTo(0.4 * 0.05 + 0.5 * 0.1 + 0.1 * 0.05, 12);
    expect(ece(hand)).toBeCloseTo(0.075, 12);
    // Perfectly calibrated bins have no gap; nothing scored has no ECE at all.
    expect(ece([...said(0.5, [true, false]), ...said(0.25, [true, false, false, false])])).toBeCloseTo(0, 12);
    expect(ece([])).toBeNull();
    expect(score([]).ece).toBeNull();
    expect(reliabilityGap([])).toBeNull();
  });

  it('edge cases: perfect, all-same outcomes, p = 1 lands in the top bin', () => {
    expect(brier([{ p: 1, o: true }, { p: 0, o: false }])).toBe(0);
    expect(score([{ p: 0.7, o: true }, { p: 0.6, o: true }]).brierSkill).toBeNull();
    expect(reliability([{ p: 1, o: true }])[9]!.n).toBe(1);
    expect(score([])).toMatchObject({ n: 0, brier: 0 });
  });
});

describe('scoring ranges (P4)', () => {
  it('coverage and the pinball loss against hand-computed values', () => {
    // An 80% range says its lower end is the 10% point and its upper end the 90% point.
    const inside: ScoredRange = { lower: 2, upper: 6, level: 0.8, value: 4, scale: 2 };
    const above: ScoredRange = { lower: 2, upper: 6, level: 0.8, value: 9, scale: 2 };
    const below: ScoredRange = { lower: 10, upper: 20, level: 0.8, value: 8, scale: 4 };
    const steady: ScoredRange = { lower: 0, upper: 0, level: 0.8, value: 0, scale: 0 };
    const half: ScoredRange = { lower: 1, upper: 3, level: 0.5, value: 3, scale: 1 };
    // The quantile loss: tau x the miss when the value is at or above what was said, (1 - tau) x the miss when below.
    expect(quantileLoss(4, 2, 0.1)).toBeCloseTo(0.2, 12);
    expect(quantileLoss(4, 6, 0.9)).toBeCloseTo(0.2, 12);
    expect(quantileLoss(9, 2, 0.1)).toBeCloseTo(0.7, 12);
    expect(quantileLoss(9, 6, 0.9)).toBeCloseTo(2.7, 12);
    expect(quantileLoss(8, 10, 0.1)).toBeCloseTo(1.8, 12);
    expect(quantileLoss(8, 20, 0.9)).toBeCloseTo(1.2, 12);
    expect(quantileLoss(5, 5, 0.3)).toBe(0);
    // One range: the mean of its two ends' losses.
    expect(rangeLoss(inside)).toBeCloseTo(0.2, 12);
    expect(rangeLoss(above)).toBeCloseTo(1.7, 12);
    expect(rangeLoss(below)).toBeCloseTo(1.5, 12);
    expect(rangeLoss(half)).toBeCloseTo(0.25, 12);
    // Together: 3 of 5 held (the ends count as inside); each loss over its own scale; the one with no scale left out and counted.
    const r = scoreRanges([inside, above, below, steady, half]);
    expect(r.n).toBe(5);
    expect(r.coverage).toBeCloseTo(3 / 5, 12);
    expect(r.pinball).toBeCloseTo((0.2 / 2 + 1.7 / 2 + 1.5 / 4 + 0.25 / 1) / 4, 12);
    expect(r.pinball).toBeCloseTo(0.39375, 12);
    expect(r.unscaled).toBe(1);
    expect(intervalCoverage([inside, above])).toBe(0.5);
  });

  it('a wider range is not free: it holds more often and its loss still grows with its width', () => {
    const narrow = scoreRanges([{ lower: 3, upper: 5, level: 0.8, value: 4, scale: 1 }]);
    const wide = scoreRanges([{ lower: 0, upper: 100, level: 0.8, value: 4, scale: 1 }]);
    expect([narrow.coverage, wide.coverage]).toEqual([1, 1]);
    expect(wide.pinball!).toBeGreaterThan(narrow.pinball! * 10);
    // And a miss costs more the further off it is.
    const near = rangeLoss({ lower: 3, upper: 5, level: 0.8, value: 6 });
    const far = rangeLoss({ lower: 3, upper: 5, level: 0.8, value: 60 });
    expect(far).toBeGreaterThan(near * 10);
  });

  it('nothing scored has no coverage and no loss; no usable scale has coverage and no loss', () => {
    expect(scoreRanges([])).toEqual({ n: 0, coverage: null, pinball: null, unscaled: 0 });
    for (const scale of [null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(scoreRanges([{ lower: 1, upper: 2, level: 0.8, value: 1.5, scale }]), String(scale)).toEqual({ n: 1, coverage: 1, pinball: null, unscaled: 1 });
    }
  });

  it('the 1,000-range fixture matches its reference to 1e-9', () => {
    const rows = rangeFixture();
    const ref = rangeReference(rows);
    const r = scoreRanges(rows);
    expect(r.n).toBe(1000);
    expect(Math.abs(r.coverage! - ref.coverage)).toBeLessThan(1e-9);
    expect(Math.abs(r.pinball! - ref.pinball)).toBeLessThan(1e-9);
    expect(r.unscaled).toBe(ref.unscaled);
    expect(r.unscaled).toBe(40);
    // The fixture is a plausible one: most ranges hold, not all.
    expect(r.coverage!).toBeGreaterThan(0.6);
    expect(r.coverage!).toBeLessThan(0.95);
    expect(r.pinball!).toBeGreaterThan(0);
  });
});

describe('cap periods', () => {
  it('days are local to Flint\'s time zone', () => {
    // 03:00 UTC on Oct 2 is still Oct 1 in New York.
    expect(periodKey({ period: 'day' }, 'America/New_York', new Date('2026-10-02T03:00:00Z'))).toBe('2026-10-01');
  });
  it('weeks are ISO weeks', () => {
    expect(periodKey({ period: 'week' }, 'UTC', new Date('2026-10-01T12:00:00Z'))).toBe('2026-W40');
    expect(periodKey({ period: 'week' }, 'UTC', new Date('2027-01-01T12:00:00Z'))).toBe('2026-W53');
    expect(periodKey({ period: 'week' }, 'UTC', new Date('2026-01-01T12:00:00Z'))).toBe('2026-W01');
  });
});
