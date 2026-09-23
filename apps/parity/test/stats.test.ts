import { describe, it, expect } from 'vitest';
import { binomPmfHalf, signTestP, signalOf } from '../src/stats.js';

describe('sign test', () => {
  it('matches hand-computed binomial values', () => {
    expect(binomPmfHalf(4, 2)).toBeCloseTo(6 / 16, 12);
    // 9-1: 2 * (C(10,0)+C(10,1)) / 1024 = 22/1024
    expect(signTestP(9, 1)).toBeCloseTo(22 / 1024, 12);
    expect(signTestP(1, 9)).toBeCloseTo(22 / 1024, 12);
    expect(signTestP(5, 5)).toBe(1);
    expect(signTestP(0, 0)).toBe(1);
  });

  it('stays finite for a full-size run', () => {
    const p = signTestP(170, 130);
    expect(p).toBeGreaterThan(0.01);
    expect(p).toBeLessThan(0.05);
  });

  it('labels signals like eval_judge.py', () => {
    expect(signalOf(3, 0).signal).toBe('NOISE'); // too few decisive games
    expect(signalOf(9, 1).signal).toBe('SIGNIFICANT');
    expect(signalOf(12, 8).signal).toBe('NOISE'); // p ≈ 0.50
    expect(signalOf(30, 20).signal).toBe('weak'); // p ≈ 0.20
    expect(signalOf(20, 40).signal).toBe('SIGNIFICANT'); // direction doesn't matter
  });
});
