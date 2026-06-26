import { describe, it, expect } from 'vitest';
import { evaluateTriggers, selectValues } from '../src/index.js';
import type { Trigger } from '../src/index.js';
import type { Tool } from '@flint/core';

/** A read-only tool whose result is fixed JSON. */
function fixedTool(name: string, result: unknown): Tool {
  return {
    definition: { name, description: '', inputSchema: { type: 'object' }, idempotent: true },
    handler: () => (typeof result === 'string' ? result : JSON.stringify(result)),
  };
}

describe('selectValues', () => {
  it('walks arrays with *', () => {
    expect(selectValues([{ score: 1 }, { score: 2 }], '*.score')).toEqual([1, 2]);
  });
  it('walks nested objects and arrays', () => {
    expect(selectValues({ top: [{ value: 0.9 }] }, 'top.*.value')).toEqual([0.9]);
  });
  it('returns the whole value for an empty path', () => {
    expect(selectValues({ a: 1 }, '')).toEqual([{ a: 1 }]);
  });
});

describe('evaluateTriggers', () => {
  const signals = fixedTool('meridian.bias_summary', [
    { ticker: 'UNH', score: 0.549 },
    { ticker: 'NVDA', score: 0.508 },
    { ticker: 'AAPL', score: 0.249 },
    { ticker: 'TLT', score: -0.315 },
  ]);

  it('fires when a value crosses a threshold (deterministic, no model)', async () => {
    const trig: Trigger = {
      name: 'bullish-breakouts',
      tool: 'meridian.bias_summary',
      select: '*.score',
      when: { op: '>', value: 0.5 },
      alert: 'Strong bullish bias',
    };
    const [r] = await evaluateTriggers([trig], [signals]);
    expect(r?.fired).toBe(true);
    expect(r?.matched).toEqual([0.549, 0.508]); // UNH + NVDA
    expect(r?.alert).toContain('Strong bullish bias');
  });

  it('does NOT fire when nothing crosses', async () => {
    const trig: Trigger = {
      name: 'extreme',
      tool: 'meridian.bias_summary',
      select: '*.score',
      when: { op: '>', value: 0.9 },
      alert: 'extreme',
    };
    const [r] = await evaluateTriggers([trig], [signals]);
    expect(r?.fired).toBe(false);
    expect(r?.alert).toBeUndefined();
  });

  it('reports an error for an unknown tool, without throwing', async () => {
    const trig: Trigger = {
      name: 'missing',
      tool: 'nope.tool',
      select: 'x',
      when: { op: '>', value: 0 },
      alert: 'x',
    };
    const [r] = await evaluateTriggers([trig], [signals]);
    expect(r?.fired).toBe(false);
    expect(r?.error).toMatch(/unknown tool/);
  });

  it('supports < and contains', async () => {
    const bearish: Trigger = {
      name: 'bearish', tool: 'meridian.bias_summary', select: '*.score',
      when: { op: '<', value: -0.3 }, alert: 'bearish',
    };
    const [r] = await evaluateTriggers([bearish], [signals]);
    expect(r?.matched).toEqual([-0.315]); // TLT
  });
});
