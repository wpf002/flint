import { describe, it, expect } from 'vitest';
import { baselineOf } from '../scripts/route-baseline';

const line = (o: Record<string, unknown>) => `[route] ${JSON.stringify({ ts: '2026-10-01T12:00:00.000Z', path: 'chat', tier: 'routine', brain: 'local', outcome: 'answered', ms: 1000, ...o })}`;

describe('the chat baseline', () => {
  it('computes p95 and the recall fallback rate from chat turns; skips eval and /generate', () => {
    const lines = [
      ...Array.from({ length: 19 }, (_, i) => line({ ms: (i + 1) * 100, recall: i < 2 ? 'lexical' : 'semantic', ts: `2026-10-0${1 + (i % 8)}T12:00:00.000Z` })),
      line({ ms: 60_000, recall: 'timeout' }),
      line({ ms: 99_999, eval: true, recall: 'error' }),
      line({ ms: 99_999, path: 'generate', recall: 'error' }),
      line({ ms: 500, recall: 'none' }),
      'not a route line',
      '[route] {broken',
    ].join('\n');
    const b = baselineOf(lines)!;
    expect(b.n).toBe(21);
    expect(b.p95Ms).toBe(1900);
    // 3 of the 20 that recalled fell back (2 lexical, 1 timeout); "none" did not recall.
    expect(b.recallFallbackRate).toBeCloseTo(3 / 20);
    expect(b.from).toBe('2026-10-01T12:00:00.000Z');
    expect(b.to).toBe('2026-10-08T12:00:00.000Z');
    expect(baselineOf('[route] {"path":"generate","ms":5,"ts":"2026-10-01T00:00:00Z"}')).toBeUndefined();
  });
});
