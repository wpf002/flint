/**
 * Scoring against an independent reference on a 1,000-row fixture, to 1e-9
 * (plan P1 exit criterion 5). The reference is written the plain way (one pass,
 * BigInt-free, no shared helpers) so a bug in scoring.ts cannot hide in both.
 */
import { describe, it, expect } from 'vitest';
import { brier, reliability, score, type Scored } from '../src/ledger/scoring';
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
  return { brier: brierRef, base, skill: 1 - brierRef / (base * (1 - base)), bins };
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

  it('edge cases: perfect, all-same outcomes, p = 1 lands in the top bin', () => {
    expect(brier([{ p: 1, o: true }, { p: 0, o: false }])).toBe(0);
    expect(score([{ p: 0.7, o: true }, { p: 0.6, o: true }]).brierSkill).toBeNull();
    expect(reliability([{ p: 1, o: true }])[9]!.n).toBe(1);
    expect(score([])).toMatchObject({ n: 0, brier: 0 });
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
