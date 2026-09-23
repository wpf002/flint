import { describe, it, expect } from 'vitest';
import { BudgetGuard } from '../src/budget.js';
import { costOf, estimateCost } from '../src/pricing.js';
import { pool } from '../src/util.js';

describe('BudgetGuard', () => {
  it('refuses a reservation that would cross the limit and latches', () => {
    const g = new BudgetGuard(1);
    const a = g.reserve(0.6);
    expect(a).not.toBeNull();
    expect(g.reserve(0.5)).toBeNull(); // 0.6 in flight + 0.5 > 1
    expect(g.exhausted).toBe(true);
    // Latched: even something small is refused once the guard has tripped.
    expect(g.reserve(0.01)).toBeNull();
    a!(0.4);
    expect(g.spent).toBeCloseTo(0.4);
    expect(g.reserved).toBe(0);
  });

  it('charges the actual cost, not the estimate, and settles once', () => {
    const g = new BudgetGuard(10);
    const s = g.reserve(1)!;
    s(0.25);
    s(5);
    expect(g.spent).toBeCloseTo(0.25);
  });

  it('holds under concurrency: in-flight reservations count', async () => {
    const g = new BudgetGuard(1);
    let ran = 0;
    await pool(
      Array.from({ length: 20 }, (_, i) => i),
      8,
      async () => {
        const settle = g.reserve(0.3);
        if (!settle) return;
        ran++;
        await new Promise((r) => setTimeout(r, 5));
        settle(0.3);
      },
      () => g.exhausted,
    );
    expect(ran).toBe(3);
    expect(g.spent).toBeLessThanOrEqual(1);
  });

  it('rejects a nonsense limit', () => {
    expect(() => new BudgetGuard(0)).toThrow();
    expect(() => new BudgetGuard(Number.NaN)).toThrow();
  });
});

describe('pricing', () => {
  it('prices Anthropic cache reads/writes beside uncached input', () => {
    // sonnet-4-6: $3 in, $15 out, $0.30 read, $3.75 write per MTok
    const c = costOf('anthropic', 'claude-sonnet-4-6', { input: 1_000_000, output: 100_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 });
    expect(c).toBeCloseTo(3 + 1.5 + 0.3 + 3.75, 6);
  });

  it('prices OpenAI cached tokens as part of input', () => {
    const c = costOf('openai', 'gpt-5', { input: 1_000_000, output: 0, cacheRead: 400_000 });
    expect(c).toBeCloseTo(0.6 * 1.25 + 0.4 * 0.125, 6);
  });

  it('adds the Perplexity request fee and prices unknown models high', () => {
    expect(costOf('perplexity', 'sonar-pro', { input: 0, output: 0 })).toBeCloseTo(0.014, 6);
    expect(costOf('openai', 'mystery-9', { input: 1_000_000, output: 0 })).toBeGreaterThanOrEqual(10);
  });

  it('estimates grow with prompt length', () => {
    expect(estimateCost('anthropic', 'claude-opus-5', 40_000)).toBeGreaterThan(estimateCost('anthropic', 'claude-opus-5', 40));
  });
});
