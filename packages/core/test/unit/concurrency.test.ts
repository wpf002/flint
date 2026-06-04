import { describe, it, expect } from 'vitest';
import { ConcurrencyLimiter } from '../../src/core/concurrency.js';

describe('ConcurrencyLimiter', () => {
  it('never runs more than maxConcurrent tasks at once', async () => {
    const limiter = new ConcurrencyLimiter(2);
    let active = 0;
    let peak = 0;

    const task = () =>
      limiter.run(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
      });

    await Promise.all(Array.from({ length: 8 }, task));
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('releases the slot even when a task throws', async () => {
    const limiter = new ConcurrencyLimiter(1);
    await expect(
      limiter.run(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    // Slot must be free again.
    const ok = await limiter.run(async () => 42);
    expect(ok).toBe(42);
    expect(limiter.inFlight).toBe(0);
  });

  it('rejects an invalid maxConcurrent', () => {
    expect(() => new ConcurrencyLimiter(0)).toThrow();
  });
});
