import { describe, it, expect } from 'vitest';
import type { ProviderAdapter, GenerateArgs } from '@flint/core';
import { JudgeParseError, flintIsA, judgePair, outcomeFor, parseJudgeOutput } from '../src/judge.js';
import type { EvalPrompt } from '../src/prompts.js';

describe('parseJudgeOutput', () => {
  it('accepts a bare object and a ```json fence', () => {
    expect(parseJudgeOutput('{"verdict":"A","reason":"cites the real score"}')).toEqual({ verdict: 'A', reason: 'cites the real score' });
    expect(parseJudgeOutput('```json\n{"verdict": "TIE", "reason": "same"}\n```').verdict).toBe('TIE');
    expect(parseJudgeOutput('  {"verdict":"B"}  ')).toEqual({ verdict: 'B', reason: '' });
  });

  it('rejects anything it would have to guess at', () => {
    for (const bad of [
      'A',
      'A is better.',
      '{"verdict":"a"}',
      '{"verdict":"Tie"}',
      '{"verdict":"A/B"}',
      '{"winner":"A"}',
      'Sure! {"verdict":"A"}',
      '{"verdict":"A"} because it is shorter',
      '{"verdict":"A"}{"verdict":"B"}',
      '[{"verdict":"A"}]',
      '',
    ]) {
      expect(() => parseJudgeOutput(bad), bad).toThrow(JudgeParseError);
    }
  });
});

describe('position randomization', () => {
  it('is stable per (prompt, competitor, seed) and roughly balanced', () => {
    expect(flintIsA('abc', 'openai', 1)).toBe(flintIsA('abc', 'openai', 1));
    let a = 0;
    for (let i = 0; i < 400; i++) if (flintIsA(`p${i}`, 'claude', 1)) a++;
    expect(a).toBeGreaterThan(160);
    expect(a).toBeLessThan(240);
  });

  it('maps a verdict back to Flint’s side', () => {
    expect(outcomeFor('A', true)).toBe('win');
    expect(outcomeFor('A', false)).toBe('loss');
    expect(outcomeFor('B', false)).toBe('win');
    expect(outcomeFor('TIE', true)).toBe('tie');
  });
});

describe('judgePair', () => {
  const prompt: EvalPrompt = { id: 'p1', prompt: 'q', category: 'knowledge', source: 'organic', conversationId: 'c', sourceTs: 0, tools: [] };
  const fake = (replies: string[]): ProviderAdapter & { calls: GenerateArgs[] } => {
    const calls: GenerateArgs[] = [];
    return {
      name: 'fake',
      calls,
      getCapabilities: () => ({ toolCalling: 'native', structuredOutput: 'native', streaming: 'full', maxContextTokens: 1, maxOutputTokens: 1 }),
      estimateTokens: () => 0,
      async generate(args) {
        calls.push(args);
        const text = replies[calls.length - 1] ?? '';
        return { message: { id: 'm', role: 'assistant', content: text, timestamp: 0 }, usage: { input: 100, output: 10 }, reason: 'complete' };
      },
      // eslint-disable-next-line require-yield
      async *stream() {
        throw new Error('unused');
      },
    };
  };
  const base = { model: 'claude-x', maxTokens: 100, prompt, answerA: 'a', answerB: 'b', now: new Date(0), signal: new AbortController().signal };

  it('retries once on an unparseable reply and sums usage', async () => {
    const provider = fake(['I think A.', '{"verdict":"B","reason":"ok"}']);
    const r = await judgePair({ ...base, provider });
    expect(r.verdict).toBe('B');
    expect(r.attempts).toBe(2);
    expect(r.usage).toEqual({ input: 200, output: 20 });
  });

  it('gives up after two bad replies, carrying the usage for the budget', async () => {
    const provider = fake(['nope', 'still nope']);
    await expect(judgePair({ ...base, provider })).rejects.toMatchObject({ usage: { input: 200, output: 20 } });
  });
});
