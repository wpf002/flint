import { describe, expect, it } from 'vitest';
import { bootstrapMeanCI, pairScores, signTestOneSidedP, strictScores, subjectStats, type PromptScore } from '../src/paired.js';
import type { AnswerRow, JudgmentRow } from '../src/report.js';

const scoreMap = (xs: Array<[string, number, string?]>): Map<string, PromptScore> =>
  new Map(xs.map(([id, s, cat]) => [id, { promptId: id, category: cat ?? 'knowledge', score: s as 0 | 0.5 | 1, failed: false }]));

describe('signTestOneSidedP', () => {
  it('matches the calibration numbers the gate is designed around', () => {
    // A real +9 points: 12 better, 3 worse.
    expect(signTestOneSidedP(12, 3)).toBeCloseTo(576 / 32768, 10);
    // qwen3.8:27b vs muse-glimmer:30b in 20260924-tiered: 31 better, 18 worse.
    expect(signTestOneSidedP(31, 18)).toBeCloseTo(0.0427, 3);
    expect(signTestOneSidedP(0, 0)).toBe(1);
    expect(signTestOneSidedP(0, 5)).toBe(1);
    expect(signTestOneSidedP(5, 0)).toBeCloseTo(1 / 32, 10);
  });
});

describe('bootstrapMeanCI', () => {
  it('is reproducible and brackets the mean', () => {
    const xs = [...Array(12).fill(1), ...Array(3).fill(-1), ...Array(85).fill(0)];
    const a = bootstrapMeanCI(xs, 0.9, 2000, 7);
    expect(bootstrapMeanCI(xs, 0.9, 2000, 7)).toEqual(a);
    expect(a[0]).toBeLessThan(0.09);
    expect(a[1]).toBeGreaterThan(0.09);
    expect(a[0]).toBeGreaterThan(0);
  });

  it('is a two-sided interval at the level asked for, not a narrower one', () => {
    // 50 ones and 50 zeros: the bootstrap mean is ~ Normal(0.5, 0.05), so a 90% interval is
    // about ±1.645 sd = ±0.082 (an 80% one would be ±0.064). The lower end is the 5th percentile.
    const xs = [...Array(50).fill(1), ...Array(50).fill(0)];
    const [lo, hi] = bootstrapMeanCI(xs, 0.9, 10_000, 3);
    expect(0.5 - lo).toBeGreaterThan(0.075);
    expect(0.5 - lo).toBeLessThan(0.09);
    expect(hi - 0.5).toBeGreaterThan(0.075);
    expect(hi - 0.5).toBeLessThan(0.09);
  });

  it('is [0, 0] for nothing', () => {
    expect(bootstrapMeanCI([], 0.9, 100, 1)).toEqual([0, 0]);
  });
});

describe('pairScores', () => {
  it('pairs on shared prompts and counts better / worse / same', () => {
    const base = scoreMap([
      ['a', 0],
      ['b', 1],
      ['c', 0.5],
      ['d', 0],
      ['only-base', 1],
    ]);
    const cand = scoreMap([
      ['a', 1],
      ['b', 0.5],
      ['c', 0.5],
      ['d', 0.5],
      ['only-cand', 0],
    ]);
    const r = pairScores(base, cand, { resamples: 500 });
    expect(r).toMatchObject({ n: 4, better: 2, worse: 1, same: 1, onlyBaseline: 1, onlyCandidate: 1 });
    expect(r.baselineRate).toBeCloseTo(1.5 / 4);
    expect(r.candidateRate).toBeCloseTo(2.5 / 4);
    expect(r.delta).toBeCloseTo(0.25);
    expect(r.p).toBeCloseTo(signTestOneSidedP(2, 1));
  });

  it('breaks the pairing down by category', () => {
    const r = pairScores(scoreMap([['a', 0, 'research'], ['b', 1, 'coding']]), scoreMap([['a', 1, 'research'], ['b', 0, 'coding']]), { resamples: 100 });
    expect(r.byCategory.research).toMatchObject({ n: 1, better: 1, delta: 1 });
    expect(r.byCategory.coding).toMatchObject({ n: 1, worse: 1, delta: -1 });
  });
});

const J = 'panel:anthropic:claude-opus-5-5+openai:gpt-5';
const judgment = (subject: string, promptId: string, outcome: 'win' | 'loss' | 'tie' | undefined, extra: Partial<JudgmentRow> = {}): JudgmentRow => ({
  subject,
  promptId,
  category: 'knowledge',
  competitor: 'openai',
  competitorModel: 'gpt-5',
  judgeModel: J,
  flintIsA: true,
  ok: outcome !== undefined,
  ...(outcome ? { outcome } : { error: 'bad json' }),
  costUsd: 0,
  ts: 1,
  ...extra,
});
const answer = (contestant: string, promptId: string, ok: boolean, ms = 1000, model = contestant === 'openai' ? 'gpt-5' : 'flint@x'): AnswerRow => ({
  promptId,
  contestant,
  model,
  ok,
  costUsd: 0,
  ms,
  ts: 1,
});

describe('strictScores', () => {
  const prompts = ['p1', 'p2', 'p3', 'p4', 'p5'].map((id) => ({ id, category: 'knowledge' }));
  const answers = [
    ...prompts.map((p) => answer('openai', p.id, p.id !== 'p5')),
    answer('flint-local', 'p1', true),
    answer('flint-local', 'p2', true),
    answer('flint-local', 'p3', false),
    answer('flint-local', 'p4', true),
    answer('flint-local', 'p5', false),
  ];
  const judgments = [
    judgment('flint-local', 'p1', 'win'),
    judgment('flint-local', 'p2', 'tie'),
    judgment('flint-local', 'p4', undefined),
    // Another judge's and another subject's verdicts never leak in.
    judgment('flint-local', 'p4', 'win', { judgeModel: 'claude-opus-5-5' }),
    judgment('flint-local@x', 'p4', 'win'),
  ];

  it('scores win 1, tie 0.5, failure-while-the-competitor-answered 0; judge errors and the rest are left out', () => {
    const s = strictScores({ subject: 'flint-local', competitor: 'openai', competitorModel: 'gpt-5', judgeModel: J, answers, judgments, prompts });
    expect([...s.scores.values()].map((x) => [x.promptId, x.score, x.failed])).toEqual([
      ['p1', 1, false],
      ['p2', 0.5, false],
      ['p3', 0, true],
    ]);
    expect(s.judgeErrors).toBe(1); // p4
    expect(s.unscored).toBe(1); // p5: both failed, nothing to hold against Flint
  });

  it('takes the latest successful verdict over an earlier error', () => {
    const s = strictScores({
      subject: 'flint-local',
      competitor: 'openai',
      competitorModel: 'gpt-5',
      judgeModel: J,
      answers,
      judgments: [...judgments, judgment('flint-local', 'p4', 'loss', { ts: 2 })],
      prompts,
    });
    expect(s.scores.get('p4')?.score).toBe(0);
    expect(s.judgeErrors).toBe(0);
  });
});

describe('subjectStats', () => {
  it('answer rate over the latest row per prompt, median latency over answers', () => {
    const rows = [answer('s', 'a', false, 5), answer('s', 'a', true, 3000), answer('s', 'b', true, 1000), answer('s', 'c', false, 9), answer('s', 'd', true, 2000)];
    const st = subjectStats(rows, 's', new Set(['a', 'b', 'c', 'd']));
    expect(st).toEqual({ answered: 3, failed: 1, answerRate: 0.75, medianMs: 2000 });
  });
});
