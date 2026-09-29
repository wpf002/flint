import { describe, it, expect } from 'vitest';
import {
  CSV_HEADER,
  JudgeRefused,
  fixedSubset,
  judgeReplyText,
  judgeWithFallback,
  readVerdict,
  signalOf,
  toCsv,
  toRow,
  todayIsA,
} from '../src/measure';

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

describe('judgeReplyText', () => {
  // Opus 5.5 always thinks, and the thinking comes back ahead of the text.
  // Reading only the first block read the thinking and scored every pair a tie.
  it('reads the verdict after a thinking block', () => {
    const res = { content: [{ type: 'thinking' }, { type: 'text', text: 'B' }], stop_reason: 'end_turn' };
    expect(judgeReplyText(res)).toBe('B');
    expect(readVerdict(judgeReplyText(res), true)).toBe('baseline');
  });

  it('throws, rather than yielding a tie, when the thinking used every token', () => {
    const res = { content: [{ type: 'thinking' }], stop_reason: 'max_tokens' };
    expect(() => judgeReplyText(res)).toThrow(/no verdict.*max_tokens/);
  });

  it('throws on a refusal even if some text came back', () => {
    const res = { content: [{ type: 'text', text: 'A' }], stop_reason: 'refusal' };
    expect(() => judgeReplyText(res)).toThrow(JudgeRefused);
  });

  it('still reads a plain text reply', () => {
    expect(judgeReplyText({ content: [{ type: 'text', text: ' TIE ' }], stop_reason: 'end_turn' })).toBe('TIE');
  });
});

describe('judgeWithFallback', () => {
  const refuse = (costUsd: number) => Object.assign(new JudgeRefused(), { costUsd });

  it('uses the primary when it rules, and never asks the fallback', async () => {
    const asked: string[] = [];
    const r = await judgeWithFallback(
      async (m) => (asked.push(m), { reply: 'A', costUsd: 0.01 }),
      'claude-opus-5-5',
      'claude-sonnet-5',
    );
    expect(r).toEqual({ reply: 'A', costUsd: 0.01, judge: 'claude-opus-5-5' });
    expect(asked).toEqual(['claude-opus-5-5']);
  });

  // The 2026-09-29 run lost an aging-biology prompt to an Opus 5.5 refusal.
  it('asks the fallback after a refusal and bills both calls', async () => {
    const r = await judgeWithFallback(
      async (m) => {
        if (m === 'claude-opus-5-5') throw refuse(0.004);
        return { reply: 'B', costUsd: 0.002 };
      },
      'claude-opus-5-5',
      'claude-sonnet-5',
    );
    expect(r.reply).toBe('B');
    expect(r.judge).toBe('claude-sonnet-5');
    expect(r.costUsd).toBeCloseTo(0.006, 6);
  });

  it('does not retry a failure that is not a refusal', async () => {
    const asked: string[] = [];
    const call = async (m: string) => {
      asked.push(m);
      throw Object.assign(new Error('judge HTTP 529: overloaded'), { costUsd: 0 });
    };
    await expect(judgeWithFallback(call, 'claude-opus-5-5', 'claude-sonnet-5')).rejects.toThrow(/529/);
    expect(asked).toEqual(['claude-opus-5-5']);
  });

  it('with no fallback configured, a refusal stays a refusal', async () => {
    await expect(judgeWithFallback(async () => { throw refuse(0.004); }, 'claude-opus-5-5', '')).rejects.toBeInstanceOf(JudgeRefused);
  });

  it('when the fallback also fails, says so and carries the cost of both', async () => {
    const err = await judgeWithFallback(async () => { throw refuse(0.004); }, 'claude-opus-5-5', 'claude-sonnet-5').catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/claude-opus-5-5 refused, then claude-sonnet-5: the judge refused/);
    expect((err as { costUsd: number }).costUsd).toBeCloseTo(0.008, 6);
  });
});
