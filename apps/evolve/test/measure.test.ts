import { describe, it, expect } from 'vitest';
import { CSV_HEADER, fixedSubset, readVerdict, signalOf, toCsv, toRow, todayIsA } from '../src/measure';

const P = (id: string) => ({ id, prompt: `q-${id}` });

describe('fixedSubset', () => {
  it('is the same set every night regardless of file order', () => {
    const a = fixedSubset([P('c'), P('a'), P('b')], 2).map((p) => p.id);
    const b = fixedSubset([P('b'), P('c'), P('a')], 2).map((p) => p.id);
    expect(a).toEqual(['a', 'b']);
    expect(b).toEqual(['a', 'b']);
  });

  // Documents the limitation that forced the design: this IS displaced by an
  // earlier-sorting addition, which is why only night one uses it and every
  // later night measures the ids the baseline froze.
  it('is displaced by an earlier-sorting addition (night-one use only)', () => {
    const before = fixedSubset([P('a'), P('b'), P('c')], 2).map((p) => p.id);
    const after = fixedSubset([P('a'), P('b'), P('c'), P('a0')], 2).map((p) => p.id);
    expect(before).toEqual(['a', 'b']);
    expect(after).toEqual(['a', 'a0']);
  });
});

describe('todayIsA', () => {
  it('is stable for a given prompt', () => {
    expect(todayIsA('abc')).toBe(todayIsA('abc'));
  });

  it('is not the same for every prompt (position bias cannot sway a run)', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const sides = new Set(ids.map(todayIsA));
    expect(sides.size).toBe(2);
  });
});

describe('readVerdict', () => {
  it('maps the judge letter through the position it was shown in', () => {
    expect(readVerdict('A', true)).toBe('today');
    expect(readVerdict('A', false)).toBe('baseline');
    expect(readVerdict('B', true)).toBe('baseline');
    expect(readVerdict('B', false)).toBe('today');
  });

  it('treats anything else as a tie', () => {
    for (const r of ['TIE', 'tie', '', 'neither', 'both are good']) expect(readVerdict(r, true)).toBe('tie');
  });

  // A judge that declines to pick must not be read as picking. "Both are good"
  // starts with B, and matching on the first letter scored it as a B verdict.
  it('does not read a sentence starting with A or B as a verdict', () => {
    for (const r of ['both are good', 'Answer A and B are equal', 'Neither A nor B']) {
      expect(readVerdict(r, true)).toBe('tie');
    }
  });

  it('still accepts a bare letter with punctuation', () => {
    expect(readVerdict('A.', true)).toBe('today');
    expect(readVerdict(' B ', true)).toBe('baseline');
  });
});

describe('signalOf', () => {
  it('calls a coin flip noise', () => {
    expect(signalOf(10, 10)).toBe('NOISE');
    expect(signalOf(11, 9)).toBe('NOISE');
  });

  it('will not call a verdict on too few decisive comparisons', () => {
    expect(signalOf(3, 0)).toBe('NOISE');
  });

  it('names a real improvement and a real regression', () => {
    expect(signalOf(18, 2)).toBe('BETTER');
    expect(signalOf(2, 18)).toBe('WORSE');
  });
});

describe('toRow', () => {
  it('excludes ties from the rate, so 0.5 means unchanged', () => {
    const r = toRow({ ts: 't', config: 'c', verdicts: ['today', 'baseline', 'tie', 'tie'], costUsd: 0.1 });
    expect(r.winRate).toBe(0.5);
    expect(r.ties).toBe(2);
    expect(r.n).toBe(4);
  });

  it('reports 0.5 rather than dividing by zero when every pair tied', () => {
    expect(toRow({ ts: 't', config: 'c', verdicts: ['tie', 'tie'], costUsd: 0 }).winRate).toBe(0.5);
  });
});

describe('toCsv', () => {
  it('quotes a config containing commas so the columns survive', () => {
    const row = toRow({ ts: '2026-09-28', config: 'hard=a,code=b', verdicts: ['today'], costUsd: 0.5 });
    const line = toCsv(row);
    expect(line).toContain('"hard=a,code=b"');
    expect(CSV_HEADER.split(',').length).toBe(line.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).length);
  });
});

// --- shared ledger ---------------------------------------------------------
import { allowance, dayOf } from '../src/ledger';

describe('allowance', () => {
  it('uses its own cap when the day has room', () => {
    expect(allowance({ ownCap: 0.5, dailyBudget: 10, alreadySpent: 1 })).toBe(0.5);
  });

  // The reason this module exists: a heavy parity day must shrink the nightly
  // measure, not run alongside it under a second, independent ceiling.
  it('is limited by what the shared day has left', () => {
    expect(allowance({ ownCap: 0.5, dailyBudget: 10, alreadySpent: 9.8 })).toBeCloseTo(0.2, 5);
  });

  it('is zero, never negative, once the day is spent', () => {
    expect(allowance({ ownCap: 0.5, dailyBudget: 10, alreadySpent: 10 })).toBe(0);
    expect(allowance({ ownCap: 0.5, dailyBudget: 10, alreadySpent: 12 })).toBe(0);
  });
});

describe('dayOf', () => {
  it('stamps the local calendar day', () => {
    expect(dayOf(new Date(2026, 8, 28, 23, 30))).toBe('2026-09-28');
    expect(dayOf(new Date(2026, 0, 5, 0, 1))).toBe('2026-01-05');
  });
});
