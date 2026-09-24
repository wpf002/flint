import { describe, it, expect } from 'vitest';
import type { GenerateArgs, ProviderAdapter } from '@flint/core';
import { BudgetGuard } from '../src/budget.js';
import { flintIsA, outcomeFor, type Outcome } from '../src/judge.js';
import {
  consensus,
  judgeWithPanel,
  panelId,
  panelistFlintIsA,
  parseJudgePanel,
  verdictFor,
  type Panelist,
} from '../src/panel.js';
import type { EvalPrompt } from '../src/prompts.js';
import { cachedJudgments, latestJudgments, renderMarkdown, summarize, type JudgmentRow } from '../src/report.js';

const prompt: EvalPrompt = { id: 'p1', prompt: 'q', category: 'knowledge', source: 'organic', conversationId: 'c', sourceTs: 0, tools: [] };

/**
 * A judge that prefers a fixed side of the argument: 'flint' / 'comp' / 'tie',
 * reading which slot Flint's answer is in from the answers themselves.
 */
function judge(name: string, prefers: 'flint' | 'comp' | 'tie' | 'error'): ProviderAdapter & { calls: GenerateArgs[] } {
  const calls: GenerateArgs[] = [];
  return {
    name,
    calls,
    getCapabilities: () => ({ toolCalling: 'native', structuredOutput: 'native', streaming: 'full', maxContextTokens: 1, maxOutputTokens: 1 }),
    estimateTokens: () => 0,
    async generate(args) {
      calls.push(args);
      const msg = String(args.messages[0]!.content);
      const flintInA = /<answer_a>\nFLINT/.test(msg);
      let text: string;
      if (prefers === 'error') text = 'not json';
      else if (prefers === 'tie') text = '{"verdict":"TIE","reason":"same"}';
      else text = JSON.stringify({ verdict: (prefers === 'flint') === flintInA ? 'A' : 'B', reason: `${name} likes ${prefers}` });
      return { message: { id: 'm', role: 'assistant', content: text, timestamp: 0 }, usage: { input: 1000, output: 100 }, reason: 'complete' };
    },
    // eslint-disable-next-line require-yield
    async *stream() {
      throw new Error('unused');
    },
  };
}

const panelOf = (a: ProviderAdapter, b: ProviderAdapter): Panelist[] => [
  { vendor: 'anthropic', model: 'claude-opus-5-5', id: 'anthropic:claude-opus-5-5', provider: a },
  { vendor: 'openai', model: 'gpt-5', id: 'openai:gpt-5', provider: b },
];

const run = (panel: Panelist[], budget = new BudgetGuard(10)) =>
  judgeWithPanel({
    panel,
    reserve: (e) => budget.reserve(e),
    judgeMaxTokens: 4096,
    prompt,
    competitor: 'openai',
    flintAnswer: 'FLINT answer',
    competitorAnswer: 'COMP answer',
    seed: 1,
    now: new Date(0),
    signal: new AbortController().signal,
  });

describe('parseJudgePanel / panelId', () => {
  it('parses provider:model pairs and gives an order-independent id', () => {
    const a = parseJudgePanel('openai:gpt-5, anthropic:claude-opus-5-5');
    expect(a.map((p) => p.id)).toEqual(['anthropic:claude-opus-5-5', 'openai:gpt-5']);
    expect(panelId(a)).toBe('panel:anthropic:claude-opus-5-5+openai:gpt-5');
    expect(panelId(parseJudgePanel('anthropic:claude-opus-5-5,openai:gpt-5'))).toBe(panelId(a));
  });

  it('rejects malformed, unsupported, duplicated and single-judge panels', () => {
    expect(() => parseJudgePanel('claude-opus-5-5,openai:gpt-5')).toThrow(/provider:model/);
    expect(() => parseJudgePanel('perplexity:sonar,openai:gpt-5')).toThrow(/isn't supported/);
    expect(() => parseJudgePanel('openai:gpt-5,openai:gpt-5')).toThrow(/twice/);
    expect(() => parseJudgePanel('openai:gpt-5')).toThrow(/at least two/);
    expect(() => parseJudgePanel('openai:')).toThrow(/provider:model/);
  });
});

describe('consensus', () => {
  it('counts a win or loss only when every panelist agrees', () => {
    expect(consensus(['win', 'win'])).toEqual({ outcome: 'win', agreed: true });
    expect(consensus(['loss', 'loss', 'loss'])).toEqual({ outcome: 'loss', agreed: true });
    expect(consensus(['tie', 'tie'])).toEqual({ outcome: 'tie', agreed: true });
  });

  it('scores any disagreement as a tie (a split)', () => {
    const splits: Outcome[][] = [['win', 'loss'], ['win', 'tie'], ['tie', 'loss'], ['win', 'win', 'loss']];
    for (const s of splits) expect(consensus(s), s.join()).toEqual({ outcome: 'tie', agreed: false });
  });

  it('verdictFor inverts outcomeFor', () => {
    for (const o of ['win', 'loss', 'tie'] as const) for (const a of [true, false]) expect(outcomeFor(verdictFor(o, a), a)).toBe(o);
  });
});

describe('per-panelist A/B order', () => {
  it('is deterministic per (prompt, competitor, seed, judge)', () => {
    expect(panelistFlintIsA('p', 'openai', 1, 'openai:gpt-5')).toBe(panelistFlintIsA('p', 'openai', 1, 'openai:gpt-5'));
  });

  it('is independent across judges and balanced', () => {
    let differ = 0;
    let aCount = 0;
    const N = 400;
    for (let i = 0; i < N; i++) {
      const x = panelistFlintIsA(`p${i}`, 'openai', 1, 'anthropic:claude-opus-5-5');
      const y = panelistFlintIsA(`p${i}`, 'openai', 1, 'openai:gpt-5');
      if (x !== y) differ++;
      if (x) aCount++;
    }
    // Independent coin flips differ about half the time; identical orders would differ never.
    expect(differ).toBeGreaterThan(N * 0.4);
    expect(differ).toBeLessThan(N * 0.6);
    expect(aCount).toBeGreaterThan(N * 0.4);
    expect(aCount).toBeLessThan(N * 0.6);
  });

  it('each panelist actually sees its own order', async () => {
    const a = judge('a', 'flint');
    const b = judge('b', 'flint');
    const r = await run(panelOf(a, b));
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    for (const [i, adapter] of [a, b].entries()) {
      const v = r.panel[i]!;
      const msg = String(adapter.calls[0]!.messages[0]!.content);
      expect(/<answer_a>\nFLINT/.test(msg)).toBe(v.flintIsA);
      expect(v.flintIsA).toBe(panelistFlintIsA('p1', 'openai', 1, v.judge));
    }
  });
});

describe('judgeWithPanel', () => {
  it('agreeing judges: the shared outcome, with every verdict kept', async () => {
    const r = await run(panelOf(judge('a', 'flint'), judge('b', 'flint')));
    expect(r).toMatchObject({ kind: 'ok', outcome: 'win', agreed: true });
    if (r.kind !== 'ok') return;
    expect(r.panel.map((v) => [v.judge, v.outcome])).toEqual([
      ['anthropic:claude-opus-5-5', 'win'],
      ['openai:gpt-5', 'win'],
    ]);
    expect(r.panel[0]!.reason).toBe('a likes flint');
    expect(r.costUsd).toBeCloseTo(r.panel[0]!.costUsd + r.panel[1]!.costUsd, 10);
  });

  it('disagreeing judges: a split tie', async () => {
    const r = await run(panelOf(judge('a', 'flint'), judge('b', 'comp')));
    expect(r).toMatchObject({ kind: 'ok', outcome: 'tie', agreed: false });
    if (r.kind === 'ok') expect(r.panel.map((v) => v.outcome)).toEqual(['win', 'loss']);
  });

  it('a panelist error makes the pair a judge error, not a tie, and still charges the budget', async () => {
    const budget = new BudgetGuard(10);
    const r = await run(panelOf(judge('a', 'flint'), judge('b', 'error')), budget);
    expect(r.kind).toBe('error');
    if (r.kind !== 'error') return;
    expect(r.error).toMatch(/^openai:gpt-5: /);
    expect(r.panel.map((v) => v.judge)).toEqual(['anthropic:claude-opus-5-5']);
    expect(budget.spent).toBeCloseTo(r.costUsd, 10);
    expect(r.costUsd).toBeGreaterThan(r.panel[0]!.costUsd); // the failed judge's two attempts are paid for too
    expect(budget.reserved).toBeCloseTo(0, 10);
  });

  it('reserves every panelist before calling any; a refusal calls nobody', async () => {
    const a = judge('a', 'flint');
    const b = judge('b', 'flint');
    const budget = new BudgetGuard(0.02); // room for the Opus reservation, not the GPT-5 one after it
    const r = await run(panelOf(a, b), budget);
    expect(r.kind).toBe('refused');
    expect(a.calls.length + b.calls.length).toBe(0);
    expect(budget.reserved).toBe(0);
    expect(budget.spent).toBe(0);
  });

  it('settles every reservation to the real cost', async () => {
    const budget = new BudgetGuard(10);
    const r = await run(panelOf(judge('a', 'tie'), judge('b', 'tie')), budget);
    expect(r).toMatchObject({ kind: 'ok', outcome: 'tie', agreed: true });
    expect(budget.reserved).toBeCloseTo(0, 10);
    // 1000 in / 100 out at opus-5-5 ($4/$20) + gpt-5 ($1.25/$10)
    expect(budget.spent).toBeCloseTo((1000 * 4 + 100 * 20 + 1000 * 1.25 + 100 * 10) / 1e6, 10);
  });
});

describe('single judge vs panel rows', () => {
  const row = (judgeModel: string, extra: Partial<JudgmentRow> = {}): JudgmentRow => ({
    subject: 'flint',
    promptId: 'p1',
    category: 'knowledge',
    competitor: 'openai',
    competitorModel: 'gpt-5',
    judgeModel,
    flintIsA: flintIsA('p1', 'openai', 1),
    ok: true,
    verdict: 'A',
    outcome: 'win',
    costUsd: 0,
    ts: 0,
    ...extra,
  });
  const PANEL = 'panel:anthropic:claude-opus-5-5+openai:gpt-5';

  it('never share a resume-cache entry', () => {
    const rows = [row('claude-opus-5-5'), row(PANEL, { outcome: 'tie', agreed: false, panel: [] })];
    const single = cachedJudgments(rows, 'claude-opus-5-5', 'flint');
    const panel = cachedJudgments(rows, PANEL, 'flint');
    expect(single.size).toBe(1);
    expect(panel.size).toBe(1);
    expect([...single.values()][0]!.judgeModel).toBe('claude-opus-5-5');
    expect([...panel.values()][0]!.judgeModel).toBe(PANEL);
    expect([...single.keys()][0]).not.toBe([...panel.keys()][0]);
    // A panel with a different membership is a different judge too.
    expect(cachedJudgments(rows, 'panel:anthropic:claude-opus-5-5+openai:gpt-5-mini', 'flint').size).toBe(0);
  });

  it('a failed panel row is not cached (retried on resume) but still reported as a judge error', () => {
    const { verdict: _v, outcome: _o, ...failed } = row(PANEL, { ok: false, error: 'openai:gpt-5: boom' });
    const rows: JudgmentRow[] = [failed];
    expect(cachedJudgments(rows, PANEL, 'flint').size).toBe(0);
    const [s] = summarize(latestJudgments(rows, PANEL, 'flint'));
    expect(s!.judgeErrors).toBe(1);
    expect(s!.n).toBe(0);
  });

  it('report shows per-competitor panel agreement and the consensus rule', () => {
    const rows = [
      row(PANEL, { promptId: 'a', outcome: 'win', agreed: true, panel: [] }),
      row(PANEL, { promptId: 'b', outcome: 'tie', agreed: false, panel: [] }),
      row(PANEL, { promptId: 'c', outcome: 'tie', agreed: false, panel: [] }),
      row(PANEL, { promptId: 'd', outcome: 'loss', agreed: true, panel: [] }),
    ];
    const summaries = summarize(latestJudgments(rows, PANEL, 'flint'));
    expect(summaries[0]!.panelAgreement).toEqual({ agreed: 2, n: 4 });
    expect(summaries[0]!.judgeModel).toBe(PANEL);
    const md = renderMarkdown({
      run: 'r',
      promptSet: 's',
      promptCount: 4,
      contestants: [],
      answers: [],
      summaries,
      spendUsd: 0,
      budgetUsd: 1,
      stoppedForBudget: false,
      notes: [],
    });
    expect(md).toContain('### Panel agreement');
    expect(md).toContain('| openai | `panel:anthropic:claude-opus-5-5+openai:gpt-5` | 2 | 4 | 50.0% |');
    expect(md).toContain('Consensus rule');
    // Single-judge summaries have no agreement section.
    expect(summarize([row('claude-opus-5-5')])[0]!.panelAgreement).toBeUndefined();
  });
});
