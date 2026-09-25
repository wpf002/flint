import { describe, it, expect, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { GenerateArgs, ProviderAdapter } from '@flint/core';
import { BudgetGuard } from '../src/budget.js';
import { FatalError, flintContestant } from '../src/contestants.js';
import {
  GROUNDED_SUFFIX,
  groundedJudgeId,
  groundingBlock,
  groundingChars,
  parseGrounding,
  splitGroundedJudgeId,
  type FlintGrounding,
} from '../src/grounding.js';
import { JUDGE_SYSTEM, judgePair, judgeUserMessage } from '../src/judge.js';
import { chooseGroundedJudge, chooseJudge, judgeWithPanel, parseJudgePanel, type Panelist } from '../src/panel.js';
import type { EvalPrompt } from '../src/prompts.js';
import { cachedJudgments, latestJudgments, type JudgmentRow } from '../src/report.js';

const prompt: EvalPrompt = { id: 'p1', prompt: "what's my dog's name?", category: 'knowledge', source: 'organic', conversationId: 'c', sourceTs: 0, tools: [] };
const G: FlintGrounding = {
  memory: ['Will has a dog named Juno'],
  tools: [
    { name: 'web_search', isError: false, excerpt: 'Dallas: 72°F, sunny' },
    { name: 'vantage.score', isError: true, excerpt: 'rate limited' },
  ],
};

/** A judge that records what it was sent and always says TIE. */
function recorder(): ProviderAdapter & { calls: GenerateArgs[] } {
  const calls: GenerateArgs[] = [];
  return {
    name: 'rec',
    calls,
    getCapabilities: () => ({ toolCalling: 'native', structuredOutput: 'native', streaming: 'full', maxContextTokens: 1, maxOutputTokens: 1 }),
    estimateTokens: () => 0,
    async generate(args) {
      calls.push(args);
      return { message: { id: 'm', role: 'assistant', content: '{"verdict":"TIE","reason":"same"}', timestamp: 0 }, usage: { input: 10, output: 5 }, reason: 'complete' };
    },
    // eslint-disable-next-line require-yield
    async *stream() {
      throw new Error('unused');
    },
  };
}

describe('parseGrounding', () => {
  it('reads the eval response field', () => {
    expect(parseGrounding(G)).toEqual(G);
    expect(parseGrounding({ memory: [], tools: [] })).toEqual({ memory: [], tools: [] });
  });

  it('is undefined for a server that sends none, or something else', () => {
    for (const bad of [undefined, null, 'x', [], {}, { memory: [] }, { tools: [] }, { memory: 'a', tools: [] }]) {
      expect(parseGrounding(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });

  it('drops malformed entries and cuts excerpts to 800 chars', () => {
    const g = parseGrounding({
      memory: ['ok', 3, null],
      tools: [{ name: 'a', isError: 'yes', excerpt: 'x'.repeat(2000) }, { isError: true }, null, { name: 'b' }],
    });
    expect(g!.memory).toEqual(['ok']);
    expect(g!.tools).toEqual([
      { name: 'a', isError: false, excerpt: 'x'.repeat(800) },
      { name: 'b', isError: false, excerpt: '' },
    ]);
  });
});

describe('the judge prompt', () => {
  const now = new Date('2026-09-24T12:00:00Z');

  it('is unchanged without grounding (system prompt and user message)', () => {
    // The default judge must not move: a hash of the system prompt as it was, and the old message format.
    expect(createHash('sha256').update(JUDGE_SYSTEM).digest('hex')).toBe('a091a070e9b896400ee76e78235e02cb07c8682cc3b7b585db446c8f59307533');
    const legacy = [
      'Date of this evaluation: 2026-09-24. Request category: knowledge.',
      '',
      "<request>\nwhat's my dog's name?\n</request>",
      '',
      '<answer_a>\nJuno.\n</answer_a>',
      '',
      '<answer_b>\nI do not know.\n</answer_b>',
      '',
      'Which answer serves Will better? Reply with the JSON object only.',
    ].join('\n');
    expect(judgeUserMessage(prompt, 'Juno.', 'I do not know.', now)).toBe(legacy);
    expect(judgeUserMessage(prompt, 'Juno.', 'I do not know.', now, undefined)).toBe(legacy);
  });

  it('with grounding, shows the context between the request and the answers, without saying which slot is Flint', () => {
    const msg = judgeUserMessage(prompt, 'Juno.', 'I do not know.', now, G);
    expect(msg).toContain('Context Flint had access to (the other assistant did not)');
    expect(msg).toContain('- Will has a dog named Juno');
    expect(msg).toContain('<tool name="web_search" status="ok">\nDallas: 72°F, sunny\n</tool>');
    expect(msg).toContain('<tool name="vantage.score" status="error">\nrate limited\n</tool>');
    expect(msg).toMatch(/supports is grounded, not a fabrication/);
    expect(msg.indexOf('</request>')).toBeLessThan(msg.indexOf('<flint_context>'));
    expect(msg.indexOf('</flint_context>')).toBeLessThan(msg.indexOf('<answer_a>'));
    expect(msg).not.toMatch(/Answer A is Flint|Answer B is Flint|Flint's answer is [AB]/i);
    expect(msg.endsWith('Which answer serves Will better? Reply with the JSON object only.')).toBe(true);
  });

  it('says so when Flint had no memory and called no tools', () => {
    const block = groundingBlock({ memory: [], tools: [] });
    expect(block).toContain('(none recalled)');
    expect(block).toContain('(no tools called)');
  });

  it('judgePair sends the grounded message with the same system prompt', async () => {
    const p = recorder();
    await judgePair({ provider: p, model: 'm', maxTokens: 100, prompt, answerA: 'A', answerB: 'B', now, signal: new AbortController().signal, grounding: G });
    expect(p.calls[0]!.system).toBe(JUDGE_SYSTEM);
    expect(String(p.calls[0]!.messages[0]!.content)).toBe(judgeUserMessage(prompt, 'A', 'B', now, G));
    const plain = recorder();
    await judgePair({ provider: plain, model: 'm', maxTokens: 100, prompt, answerA: 'A', answerB: 'B', now, signal: new AbortController().signal });
    expect(String(plain.calls[0]!.messages[0]!.content)).not.toContain('flint_context');
  });

  it('every panelist sees the grounding, and the budget reserves for it', async () => {
    const a = recorder();
    const b = recorder();
    const panel: Panelist[] = [
      { vendor: 'anthropic', model: 'claude-opus-5-5', id: 'anthropic:claude-opus-5-5', provider: a },
      { vendor: 'openai', model: 'gpt-5', id: 'openai:gpt-5', provider: b },
    ];
    const reserved: number[] = [];
    const run = (grounding?: FlintGrounding) => {
      const budget = new BudgetGuard(10);
      return judgeWithPanel({
        panel,
        reserve: (e) => {
          reserved.push(e);
          return budget.reserve(e);
        },
        judgeMaxTokens: 4096,
        prompt,
        competitor: 'openai',
        flintAnswer: 'FLINT',
        competitorAnswer: 'COMP',
        seed: 1,
        now,
        signal: new AbortController().signal,
        grounding,
      });
    };
    await run(G);
    for (const p of [a, b]) expect(String(p.calls[0]!.messages[0]!.content)).toContain('- Will has a dog named Juno');
    await run(undefined);
    expect(String(a.calls[1]!.messages[0]!.content)).not.toContain('flint_context');
    expect(reserved[0]!).toBeGreaterThan(reserved[2]!);
    expect(groundingChars(G)).toBeGreaterThan(0);
    expect(groundingChars(undefined)).toBe(0);
  });
});

describe('grounded judge id', () => {
  it('is the judge plus +grounded, idempotently, for a model or a panel', () => {
    expect(GROUNDED_SUFFIX).toBe('+grounded');
    expect(groundedJudgeId('claude-opus-5-5')).toBe('claude-opus-5-5+grounded');
    expect(groundedJudgeId('claude-opus-5-5+grounded')).toBe('claude-opus-5-5+grounded');
    const panel = 'panel:anthropic:claude-opus-5-5+openai:gpt-5';
    expect(splitGroundedJudgeId(groundedJudgeId(panel))).toEqual({ base: panel, grounded: true });
    expect(splitGroundedJudgeId(panel)).toEqual({ base: panel, grounded: false });
  });

  it('keeps grounded verdicts apart from ungrounded ones', () => {
    const row = (judgeModel: string, outcome: 'win' | 'loss'): JudgmentRow => ({
      subject: 'flint',
      promptId: 'p1',
      category: 'knowledge',
      competitor: 'openai',
      competitorModel: 'gpt-5',
      judgeModel,
      flintIsA: true,
      ok: true,
      verdict: outcome === 'win' ? 'A' : 'B',
      outcome,
      costUsd: 0,
      ts: 0,
    });
    const rows = [row('claude-opus-5-5', 'loss'), row('claude-opus-5-5+grounded', 'win')];
    expect([...cachedJudgments(rows, 'claude-opus-5-5', 'flint').values()].map((r) => r.outcome)).toEqual(['loss']);
    expect([...cachedJudgments(rows, 'claude-opus-5-5+grounded', 'flint').values()].map((r) => r.outcome)).toEqual(['win']);
    expect(latestJudgments(rows, 'claude-opus-5-5+grounded', 'flint')).toHaveLength(1);
  });
});

describe('chooseGroundedJudge', () => {
  const defaults = { judgeModel: 'claude-opus-5', judgePanel: '' };
  const tiered = { judgeModel: 'claude-opus-5-5' };
  const PANEL = 'panel:anthropic:claude-opus-5-5+openai:gpt-5';

  it('without the flag, is chooseJudge exactly (same id, not grounded)', () => {
    for (const opts of [{ defaults }, { resumed: tiered, defaults }, { judgeModel: 'claude-sonnet-5', defaults }, { judgePanel: 'anthropic:claude-opus-5-5,openai:gpt-5', defaults }]) {
      const plain = chooseJudge(opts);
      expect(chooseGroundedJudge(opts)).toEqual({ ...plain, model: plain.judgeModel, grounded: false });
    }
  });

  it('with --judge-grounding, suffixes the id but calls the real model', () => {
    const j = chooseGroundedJudge({ judgeGrounding: true, resumed: tiered, defaults });
    expect(j).toMatchObject({ judgeModel: 'claude-opus-5-5+grounded', model: 'claude-opus-5-5', grounded: true, from: 'run' });
    const p = chooseGroundedJudge({ judgeGrounding: true, judgePanel: 'openai:gpt-5,anthropic:claude-opus-5-5', defaults });
    expect(p).toMatchObject({ judgeModel: `${PANEL}+grounded`, model: PANEL, grounded: true, from: 'flag' });
    expect(p.panel).toEqual(parseJudgePanel('anthropic:claude-opus-5-5,openai:gpt-5'));
  });

  it("a resumed run whose own judge is grounded stays grounded, and its panel still parses", () => {
    expect(chooseGroundedJudge({ resumed: { judgeModel: 'claude-opus-5-5+grounded' }, defaults })).toMatchObject({
      judgeModel: 'claude-opus-5-5+grounded',
      model: 'claude-opus-5-5',
      grounded: true,
      from: 'run',
    });
    const want = parseJudgePanel('anthropic:claude-opus-5-5,openai:gpt-5');
    for (const resumed of [{ judgeModel: `${PANEL}+grounded` }, { judgeModel: `${PANEL}+grounded`, judgePanel: ['anthropic:claude-opus-5-5', 'openai:gpt-5'] }]) {
      expect(chooseGroundedJudge({ resumed, defaults })).toEqual({ judgeModel: `${PANEL}+grounded`, model: PANEL, panel: want, grounded: true, from: 'run' });
    }
  });

  it('an explicit judge flag on a grounded run is ungrounded unless --judge-grounding is given too', () => {
    const resumed = { judgeModel: 'claude-opus-5-5+grounded' };
    expect(chooseGroundedJudge({ judgeModel: 'claude-opus-5-5', resumed, defaults })).toMatchObject({ judgeModel: 'claude-opus-5-5', grounded: false });
    expect(chooseGroundedJudge({ judgeModel: 'claude-opus-5-5', judgeGrounding: true, resumed, defaults })).toMatchObject({
      judgeModel: 'claude-opus-5-5+grounded',
      grounded: true,
    });
  });

  it('refuses a --judge-model that already carries the suffix (it would be sent to the API)', () => {
    expect(() => chooseGroundedJudge({ judgeModel: 'claude-opus-5-5+grounded', defaults })).toThrow(/--judge-grounding/);
  });
});

describe('Flint answers carry their grounding', () => {
  afterEach(() => vi.unstubAllGlobals());
  const base = { url: 'http://x', token: 't', frontierModel: 'claude-sonnet-4-6', allowTrainingLog: false, timeoutMs: 1000 };
  const reply = (extra: Record<string, unknown>) => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ text: 'Juno.', brain: 'frontier', model: 'claude-opus-5-5', eval: true, ...extra })));
  };

  it('stores the grounding the server sent, whether or not the judge will use it', async () => {
    reply({ grounding: G });
    expect((await flintContestant(base).answer(prompt, new AbortController().signal)).grounding).toEqual(G);
    reply({ grounding: G });
    expect((await flintContestant({ ...base, requireGrounding: true }).answer(prompt, new AbortController().signal)).grounding).toEqual(G);
  });

  it('without the flag, a server that sends none is fine', async () => {
    reply({});
    const a = await flintContestant(base).answer(prompt, new AbortController().signal);
    expect(a.text).toBe('Juno.');
    expect(a).not.toHaveProperty('grounding');
  });

  it('with --judge-grounding, a server that sends none stops the run', async () => {
    reply({});
    await expect(flintContestant({ ...base, requireGrounding: true }).answer(prompt, new AbortController().signal)).rejects.toBeInstanceOf(FatalError);
    reply({ grounding: 'nope' });
    await expect(flintContestant({ ...base, requireGrounding: true }).answer(prompt, new AbortController().signal)).rejects.toThrow(/--judge-grounding/);
  });
});
