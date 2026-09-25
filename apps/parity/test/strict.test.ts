import { describe, it, expect } from 'vitest';
import {
  answerRate,
  latestAnswers,
  renderMarkdown,
  rerenderReport,
  strictCompetitorsFor,
  strictSummarize,
  summarize,
  type AnswerRow,
  type JudgmentRow,
} from '../src/report.js';

const ans = (promptId: string, contestant: string, ok: boolean, model = `${contestant}-model`, ts = 0): AnswerRow => ({
  promptId,
  contestant,
  model,
  ok,
  ...(ok ? { text: 'x' } : { error: 'flint returned an empty answer' }),
  costUsd: 0,
  ms: 1,
  ts,
});

const verdict = (promptId: string, outcome: 'win' | 'loss' | 'tie', subject = 'flint'): JudgmentRow => ({
  subject,
  promptId,
  category: 'knowledge',
  competitor: 'openai',
  competitorModel: 'openai-model',
  judgeModel: 'judge',
  flintIsA: true,
  ok: true,
  outcome,
  verdict: outcome === 'tie' ? 'TIE' : outcome === 'win' ? 'A' : 'B',
  costUsd: 0,
  ts: 0,
});

const contestants = [
  { name: 'flint', model: 'flint-model' },
  { name: 'openai', model: 'openai-model' },
];

describe('answerRate', () => {
  it('counts each prompt once: answered if any attempt succeeded', () => {
    const rows = [ans('a', 'flint', true), ans('b', 'flint', false), ans('b', 'flint', true), ans('c', 'flint', false), ans('c', 'flint', false), ans('a', 'openai', true)];
    expect(answerRate(rows, 'flint')).toEqual({ answered: 2, failed: 1, rate: 2 / 3 });
    expect(answerRate(rows, 'openai')).toEqual({ answered: 1, failed: 0, rate: 1 });
    expect(answerRate(rows, 'claude')).toEqual({ answered: 0, failed: 0, rate: undefined });
  });

  it('latestAnswers keeps the success over a later failure, and the latest failure otherwise', () => {
    const rows = [ans('a', 'flint', true, 'm', 1), ans('a', 'flint', false, 'm', 2), ans('b', 'flint', false, 'm', 1), { ...ans('b', 'flint', false, 'm', 2), error: 'timeout' }];
    const latest = latestAnswers(rows);
    expect(latest.find((r) => r.promptId === 'a')!.ok).toBe(true);
    expect(latest.find((r) => r.promptId === 'b')!.error).toBe('timeout');
  });
});

describe('strictSummarize (a Flint failure counts as a loss)', () => {
  it('adds a loss for each prompt Flint failed that the competitor answered', () => {
    const judged = [verdict('j1', 'win'), verdict('j2', 'win'), verdict('j3', 'loss'), verdict('j4', 'tie')];
    const answers = latestAnswers([
      ...['j1', 'j2', 'j3', 'j4'].flatMap((id) => [ans(id, 'flint', true), ans(id, 'openai', true)]),
      // Flint failed, openai answered: two strict losses.
      ans('f1', 'flint', false),
      ans('f1', 'openai', true),
      ans('f2', 'flint', false),
      ans('f2', 'openai', true),
      // Both failed: nobody to lose to.
      ans('f3', 'flint', false),
      ans('f3', 'openai', false),
      // Flint answered, openai failed: not judged, and NOT a Flint win.
      ans('c1', 'flint', true),
      ans('c1', 'openai', false),
      // Flint failed first but succeeded on a retry: not a failure.
      ans('r1', 'flint', false),
      ans('r1', 'flint', true),
      ans('r1', 'openai', true),
    ]);
    const summaries = summarize(judged);
    const [s] = strictSummarize({ summaries, answers, subject: 'flint', competitors: contestants });
    expect(summaries[0]!.total).toEqual({ wins: 2, losses: 1, ties: 1 });
    expect(s).toMatchObject({ competitor: 'openai', competitorModel: 'openai-model', flintFailures: 2, n: 6 });
    expect(s!.total).toEqual({ wins: 2, losses: 3, ties: 1 });
    expect(s!.winRate).toBeCloseTo(2.5 / 6, 10);
  });

  it('shows a Flint that failed everything as 0-N, even with no verdicts at all', () => {
    const answers = ['a', 'b', 'c', 'd', 'e', 'f'].flatMap((id) => [ans(id, 'flint', false), ans(id, 'openai', true)]);
    const [s] = strictSummarize({ summaries: [], answers, subject: 'flint', competitors: contestants });
    expect(s!.total).toEqual({ wins: 0, losses: 6, ties: 0 });
    expect(s!.flintFailures).toBe(6);
    expect(s!.signal).toBe('SIGNIFICANT'); // 0-6: p = 2/64
    expect(s!.verdict).toMatch(/Flint behind/);
  });

  it("only counts the report's own subject and prompts, and the competitor's judged model", () => {
    const answers = [
      ans('a', 'flint#v2', false), // a variant's failure is not plain Flint's
      ans('a', 'openai', true),
      ans('b', 'flint', false), // outside the prompt set
      ans('b', 'openai', true),
      ans('c', 'flint', false),
      ans('c', 'openai', true, 'gpt-4o'), // answered by a different model than the one judged
      ans('d', 'flint', false),
      ans('d', 'openai', true),
    ];
    const [s] = strictSummarize({ summaries: [], answers, subject: 'flint', competitors: contestants, promptIds: new Set(['a', 'c', 'd']) });
    expect(s!.flintFailures).toBe(1);
    const [v] = strictSummarize({ summaries: [], answers, subject: 'flint#v2', competitors: contestants });
    expect(v!.flintFailures).toBe(1);
  });

  it('never treats another Flint in the contestants list (run.json) as a competitor', () => {
    const answers = [ans('a', 'flint-local@qwen3:14b', false), ans('a', 'flint', true, 'flint-model'), ans('a', 'openai', true)];
    const out = strictSummarize({
      summaries: [],
      answers,
      subject: 'flint-local@qwen3:14b',
      competitors: [{ name: 'flint', model: 'flint-model' }, ...contestants.slice(1)],
    });
    expect(out.map((s) => s.competitor)).toEqual(['openai']);
  });

  it('is identical to the normal tally when Flint never failed', () => {
    const judged = [verdict('a', 'win'), verdict('b', 'loss')];
    const answers = ['a', 'b'].flatMap((id) => [ans(id, 'flint', true), ans(id, 'openai', true)]);
    const summaries = summarize(judged);
    const [s] = strictSummarize({ summaries, answers, subject: 'flint', competitors: contestants });
    expect(s!.total).toEqual(summaries[0]!.total);
    expect(s!.flintFailures).toBe(0);
  });
});

describe('report: answer rate and the strict line', () => {
  const judged = [verdict('a', 'win'), verdict('b', 'win'), verdict('c', 'loss')];
  const answers = latestAnswers([
    ...['a', 'b', 'c'].flatMap((id) => [ans(id, 'flint', true, 'flint-model'), ans(id, 'openai', true)]),
    ans('d', 'flint', false, 'flint-model'),
    ans('d', 'openai', true),
  ]);
  const md = renderMarkdown({
    run: 'r',
    promptSet: 'p',
    promptCount: 4,
    contestants,
    answers,
    summaries: summarize(judged),
    spendUsd: 0,
    budgetUsd: 1,
    stoppedForBudget: false,
    notes: [],
    judgeModel: 'judge',
  });

  it('shows each contestant’s answer rate', () => {
    expect(md).toContain('| contestant | model | answered | failed | answer rate | spend |');
    expect(md).toContain('| flint | `flint-model` | 3 | 1 | 75.0% | $0.00 |');
    expect(md).toContain('| openai | `openai-model` | 4 | 0 | 100.0% | $0.00 |');
  });

  it("keeps today's tally and adds the strict line next to it", () => {
    expect(md).toContain('| openai (`openai-model`) | 2 | 1 | 0 | 66.7% |');
    expect(md).toContain('### Strict: a Flint failure counts as a loss');
    expect(md).toContain('| openai (`openai-model`) | 2 | 2 | 1 | 0 | 50.0% |');
    expect(md.indexOf('## Head to head')).toBeLessThan(md.indexOf('### Strict'));
    expect(md).toContain('Judge: `judge`.');
    expect(md).toContain('## Flint failures');
    expect(md).toContain('the strict line counts each one');
  });

  it('limits the strict line to the competitors given (report: the ones with verdicts)', () => {
    const all = [...contestants, { name: 'claude', model: 'claude-model' }];
    const rows = latestAnswers([
      ...['a', 'b', 'c'].flatMap((id) => [ans(id, 'flint', true, 'flint-model'), ans(id, 'openai', true), ans(id, 'claude', true)]),
      ans('d', 'flint', false, 'flint-model'),
      ans('d', 'openai', true),
      ans('d', 'claude', true),
    ]);
    const input = {
      run: 'r',
      promptSet: 'p',
      promptCount: 4,
      contestants: all,
      answers: rows,
      summaries: summarize(judged),
      spendUsd: 0,
      budgetUsd: 1,
      stoppedForBudget: false,
      notes: [],
    };
    // Without a list, every competitor in `contestants` gets a strict row, even one never judged against.
    expect(renderMarkdown(input)).toContain('| claude (`claude-model`) | 0 | 1 | 1 | 0 |');
    const limited = renderMarkdown({ ...input, strictCompetitors: [{ name: 'openai', model: 'openai-model' }] });
    expect(limited).not.toContain('| claude (`claude-model`) | 0 | 1 | 1 | 0 |');
    expect(limited).toContain('| openai (`openai-model`) | 2 | 2 | 1 | 0 | 50.0% |');
  });

  it('shows the strict line even before any verdict exists', () => {
    const only = renderMarkdown({
      run: 'r',
      promptSet: 'p',
      promptCount: 1,
      contestants,
      answers: [ans('d', 'flint', false), ans('d', 'openai', true)],
      summaries: [],
      spendUsd: 0,
      budgetUsd: 1,
      stoppedForBudget: false,
      notes: [],
    });
    expect(only).toContain('_No judgments yet._');
    expect(only).toContain('| openai (`openai-model`) | 0 | 1 | 1 | 0 | 0.0% |');
  });
});

describe('`report` (rerenderReport): the strict line for a re-rendered subject', () => {
  const ids = ['p1', 'p2', 'p3', 'p4', 'p5'];
  // A run started with flint, openai and claude; a later bake-off candidate faced openai only.
  const meta = {
    promptSet: 'set.jsonl',
    promptIds: ids,
    contestants: [
      { name: 'flint', model: 'flint-model' },
      { name: 'openai', model: 'openai-model' },
      { name: 'claude', model: 'claude-model' },
    ],
    judgeModel: 'judge',
  };
  const cand = 'flint-local@cand:7b';
  const vs = (promptId: string, competitor: string, outcome: 'win' | 'loss', subject = cand): JudgmentRow => ({
    ...verdict(promptId, outcome, subject),
    competitor,
    competitorModel: `${competitor}-model`,
  });
  const competitorsAnswered = ids.flatMap((id) => [ans(id, 'openai', true), ans(id, 'claude', true)]);

  it('shows 0-N for a subject that failed every prompt, with no verdicts at all (as `run` writes it)', () => {
    const answers = [...competitorsAnswered, ...ids.map((id) => ans(id, cand, false, 'flint-model'))];
    const md = rerenderReport({ run: 'r', meta, answers, judgments: [], subject: cand, judgeModel: 'judge' });
    expect(md).toContain('_No judgments yet._');
    expect(md).toContain('### Strict: a Flint failure counts as a loss');
    expect(md).toContain('| openai (`openai-model`) | 0 | 5 | 5 | 0 | 0.0% |');
    // The same data rendered the way `run` does (every competitor of the invocation) gives the same line.
    const asRun = renderMarkdown({
      run: 'r',
      promptSet: 'set.jsonl',
      promptCount: 5,
      contestants: [{ name: cand, model: 'flint-model' }, meta.contestants[1]!],
      answers: latestAnswers(answers),
      summaries: [],
      spendUsd: 0,
      budgetUsd: 1,
      stoppedForBudget: false,
      notes: [],
      subject: cand,
      promptIds: new Set(ids),
    });
    expect(asRun).toContain('| openai (`openai-model`) | 0 | 5 | 5 | 0 | 0.0% |');
  });

  it('leaves out a competitor the subject answered alongside but was never judged against (its line would be failures only)', () => {
    const answers = [
      ...competitorsAnswered,
      ...['p1', 'p2', 'p3'].map((id) => ans(id, cand, true, 'flint-model')),
      ...['p4', 'p5'].map((id) => ans(id, cand, false, 'flint-model')),
    ];
    const judgments = [vs('p1', 'openai', 'win'), vs('p2', 'openai', 'win'), vs('p3', 'openai', 'loss')];
    const md = rerenderReport({ run: 'r', meta, answers, judgments, subject: cand, judgeModel: 'judge' });
    expect(md).toContain('| openai (`openai-model`) | 2 | 3 | 2 | 0 | 40.0% |');
    expect(md).not.toMatch(/\| claude \(`claude-model`\) \| \d/);
  });

  it('only counts verdicts of the judge being rendered', () => {
    const answers = [...competitorsAnswered, ...ids.map((id) => ans(id, cand, true, 'flint-model'))];
    const judgments = [vs('p1', 'openai', 'win'), { ...vs('p2', 'openai', 'win'), judgeModel: 'judge+grounded' }];
    const md = rerenderReport({ run: 'r', meta, answers, judgments, subject: cand, judgeModel: 'judge+grounded' });
    expect(md).toContain('Judge: `judge+grounded`.');
    expect(md).toContain('| openai (`openai-model`) | 1 | 0 | 0 | 100.0% |');
    expect(md).toContain('Grounded judge (--judge-grounding)');
  });

  it('strictCompetitorsFor: judged competitors, plus those with nothing to judge', () => {
    const answers = latestAnswers([
      ans('p1', cand, true, 'flint-model'),
      ans('p2', cand, false, 'flint-model'),
      ans('p1', 'openai', true),
      ans('p1', 'claude', true), // answered alongside, never judged against: out
      ans('p2', 'perplexity', true), // never answered alongside: in (the failure is its whole tally)
      ans('p1', 'flint', true, 'flint-model'), // another Flint: never a competitor
    ]);
    const out = strictCompetitorsFor({ subject: cand, answers, judgments: [vs('p1', 'openai', 'win')], contestants: meta.contestants });
    expect(out).toEqual([
      { name: 'openai', model: 'openai-model' },
      { name: 'perplexity', model: 'perplexity-model' },
    ]);
  });
});
