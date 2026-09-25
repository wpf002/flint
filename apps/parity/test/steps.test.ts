import { describe, it, expect } from 'vitest';
import type { GenerateArgs, ProviderAdapter } from '@flint/core';
import { BudgetGuard } from '../src/budget.js';
import { FatalError, preflightFlint, type Contestant } from '../src/contestants.js';
import type { FlintGrounding } from '../src/grounding.js';
import { JUDGE_SYSTEM } from '../src/judge.js';
import { chooseGroundedJudge, type Panelist } from '../src/panel.js';
import { costOf } from '../src/pricing.js';
import type { EvalPrompt } from '../src/prompts.js';
import type { AnswerRow } from '../src/report.js';
import { answerOne, judgeOne, pairsToJudge, type JudgeSetup } from '../src/steps.js';

const prompt = (id: string): EvalPrompt => ({ id, prompt: "what's my dog's name?", category: 'knowledge', source: 'organic', conversationId: 'c', sourceTs: 0, tools: [] });
const G: FlintGrounding = { memory: ['Will has a dog named Juno'], tools: [{ name: 'vantage.score', isError: false, excerpt: 'NVDA 81' }] };
const FLINT = { name: 'flint#v2', model: 'flint@http://x' };
const OPENAI = { name: 'openai', model: 'gpt-5' };

const answer = (promptId: string, c: { name: string; model: string }, extra: Partial<AnswerRow> = {}): AnswerRow => ({
  promptId,
  contestant: c.name,
  model: c.model,
  ok: true,
  text: c.name === 'openai' ? 'COMP answer' : 'FLINT answer',
  costUsd: 0,
  ms: 1,
  ts: 0,
  ...extra,
});

/** A judge that records what it was sent and answers `reply`. */
function recorder(reply = '{"verdict":"TIE","reason":"same"}'): ProviderAdapter & { calls: GenerateArgs[] } {
  const calls: GenerateArgs[] = [];
  return {
    name: 'rec',
    calls,
    getCapabilities: () => ({ toolCalling: 'native', structuredOutput: 'native', streaming: 'full', maxContextTokens: 1, maxOutputTokens: 1 }),
    estimateTokens: () => 0,
    async generate(args) {
      calls.push(args);
      return { message: { id: 'm', role: 'assistant', content: reply, timestamp: 0 }, usage: { input: 1000, output: 100 }, reason: 'complete' };
    },
    // eslint-disable-next-line require-yield
    async *stream() {
      throw new Error('unused');
    },
  };
}

const defaults = { judgeModel: 'claude-opus-5', judgePanel: '' };

/** The JudgeSetup `run` builds from chooseGroundedJudge, with a recorder in place of the real providers. */
function setupFor(opts: Parameters<typeof chooseGroundedJudge>[0], providers: () => ProviderAdapter): JudgeSetup {
  const j = chooseGroundedJudge(opts);
  const panel: Panelist[] | undefined = j.panel?.map((p) => ({ ...p, provider: providers() }));
  return { judgeModel: j.judgeModel, model: j.model, grounded: j.grounded, panel, provider: panel ? undefined : providers() };
}

const judgeArgs = (judge: JudgeSetup, flintAnswer: AnswerRow, reserved: number[] = [], budget = new BudgetGuard(10)) => ({
  judge,
  subject: FLINT.name,
  prompt: prompt('p1'),
  competitor: OPENAI,
  flintAnswer,
  competitorAnswer: answer('p1', OPENAI),
  seed: 1,
  now: new Date('2026-09-24T12:00:00Z'),
  signal: new AbortController().signal,
  judgeMaxTokens: 4096,
  reserve: (e: number) => {
    reserved.push(e);
    return budget.reserve(e);
  },
});

describe('judgeOne: the grounded judge end to end', () => {
  it('shows a grounded judge the flint_context, calls and prices the real model, and files the verdict under +grounded', async () => {
    const rec = recorder();
    const judge = setupFor({ judgeModel: 'claude-opus-5-5', judgeGrounding: true, defaults }, () => rec);
    const r = await judgeOne(judgeArgs(judge, answer('p1', FLINT, { grounding: G })));
    expect(rec.calls).toHaveLength(1);
    // The API gets the model, never the verdict id.
    expect(rec.calls[0]!.model).toBe('claude-opus-5-5');
    expect(rec.calls[0]!.system).toBe(JUDGE_SYSTEM);
    const msg = String(rec.calls[0]!.messages[0]!.content);
    expect(msg).toContain('<flint_context>');
    expect(msg).toContain('- Will has a dog named Juno');
    expect(msg).toContain('<tool name="vantage.score" status="ok">\nNVDA 81\n</tool>');
    expect(r).toMatchObject({ kind: 'judged', row: { ok: true, judgeModel: 'claude-opus-5-5+grounded', subject: 'flint#v2', competitor: 'openai', outcome: 'tie' } });
    if (r.kind !== 'judged') throw new Error('not judged');
    expect(r.row.costUsd).toBe(costOf('anthropic', 'claude-opus-5-5', { input: 1000, output: 100 }));
  });

  it('shows an ungrounded judge no context, even when the answer carries grounding', async () => {
    const rec = recorder();
    const judge = setupFor({ judgeModel: 'claude-opus-5-5', defaults }, () => rec);
    const r = await judgeOne(judgeArgs(judge, answer('p1', FLINT, { grounding: G })));
    expect(rec.calls[0]!.model).toBe('claude-opus-5-5');
    expect(String(rec.calls[0]!.messages[0]!.content)).not.toContain('flint_context');
    expect(r).toMatchObject({ kind: 'judged', row: { judgeModel: 'claude-opus-5-5' } });
  });

  it('reserves budget for the grounding the judge is shown', async () => {
    const grounded: number[] = [];
    const plain: number[] = [];
    await judgeOne(judgeArgs(setupFor({ judgeModel: 'claude-opus-5-5', judgeGrounding: true, defaults }, () => recorder()), answer('p1', FLINT, { grounding: G }), grounded));
    await judgeOne(judgeArgs(setupFor({ judgeModel: 'claude-opus-5-5', defaults }, () => recorder()), answer('p1', FLINT, { grounding: G }), plain));
    expect(grounded[0]!).toBeGreaterThan(plain[0]!);
  });

  it('shows every panelist the context, and files the consensus under the grounded panel id', async () => {
    const recs: Array<ReturnType<typeof recorder>> = [];
    const judge = setupFor({ judgePanel: 'anthropic:claude-opus-5-5,openai:gpt-5', judgeGrounding: true, defaults }, () => {
      const r = recorder();
      recs.push(r);
      return r;
    });
    const r = await judgeOne(judgeArgs(judge, answer('p1', FLINT, { grounding: G })));
    expect(recs.map((x) => x.calls[0]!.model).sort()).toEqual(['claude-opus-5-5', 'gpt-5']);
    for (const x of recs) expect(String(x.calls[0]!.messages[0]!.content)).toContain('<flint_context>');
    expect(r).toMatchObject({ kind: 'judged', row: { ok: true, judgeModel: 'panel:anthropic:claude-opus-5-5+openai:gpt-5+grounded', agreed: true } });
  });

  it('refuses to judge grounded an answer with no grounding (it would be an ungrounded verdict under +grounded)', async () => {
    const rec = recorder();
    const judge = setupFor({ judgeModel: 'claude-opus-5-5', judgeGrounding: true, defaults }, () => rec);
    await expect(judgeOne(judgeArgs(judge, answer('p1', FLINT)))).rejects.toThrow(/no grounding/);
    expect(rec.calls).toHaveLength(0);
  });

  it('a budget refusal sends nothing; a judge that never parses is a judge error with its cost', async () => {
    const rec = recorder();
    const judge = setupFor({ judgeModel: 'claude-opus-5-5', defaults }, () => rec);
    expect(await judgeOne(judgeArgs(judge, answer('p1', FLINT), [], new BudgetGuard(0.000001)))).toEqual({ kind: 'refused' });
    expect(rec.calls).toHaveLength(0);
    const bad = recorder('not json');
    const r = await judgeOne(judgeArgs(setupFor({ judgeModel: 'claude-opus-5-5', defaults }, () => bad), answer('p1', FLINT)));
    expect(bad.calls).toHaveLength(2);
    expect(r).toMatchObject({ kind: 'judged', row: { ok: false, costUsd: costOf('anthropic', 'claude-opus-5-5', { input: 2000, output: 200 }) } });
  });
});

describe('pairsToJudge', () => {
  const rows = new Map<string, AnswerRow>();
  const put = (a: AnswerRow) => rows.set(`${a.promptId}|${a.contestant}|${a.model}`, a);
  put(answer('grounded', FLINT, { grounding: G }));
  put(answer('grounded', OPENAI));
  put(answer('old', FLINT)); // answered before the server reported grounding
  put(answer('old', OPENAI));
  put(answer('flint-only', FLINT, { grounding: G }));
  put(answer('done', FLINT, { grounding: G }));
  put(answer('done', OPENAI));
  const prompts = ['grounded', 'old', 'flint-only', 'done', 'nobody'].map(prompt);
  const opts = (grounded: boolean) => ({
    prompts,
    flint: FLINT,
    competitors: [OPENAI],
    answer: (id: string, c: { name: string; model: string }) => rows.get(`${id}|${c.name}|${c.model}`),
    judged: (id: string) => id === 'done',
    grounded,
  });

  it('a grounded judge skips a Flint answer with no grounding, and says which', () => {
    const r = pairsToJudge(opts(true));
    expect(r.pairs.map((x) => x.p.id)).toEqual(['grounded']);
    expect([...r.ungrounded]).toEqual(['old']);
  });

  it('an ungrounded judge takes every pair both sides answered that has no verdict yet', () => {
    const r = pairsToJudge(opts(false));
    expect(r.pairs.map((x) => x.p.id)).toEqual(['grounded', 'old']);
    expect(r.ungrounded.size).toBe(0);
  });
});

describe('answerOne', () => {
  const p = prompt('p1');
  const contestant = (answer: Contestant['answer']): Contestant => ({ name: 'flint', model: 'flint@x', estimate: () => 0.01, answer });
  const budget = () => new BudgetGuard(10);

  it('records an answer with its grounding', async () => {
    const r = await answerOne({ contestant: contestant(async () => ({ text: 'Juno.', costUsd: 0.02, grounding: G })), prompt: p, signal: new AbortController().signal, reserve: (e) => budget().reserve(e) });
    expect(r).toMatchObject({ kind: 'answered', row: { promptId: 'p1', contestant: 'flint', ok: true, text: 'Juno.', costUsd: 0.02, grounding: G } });
  });

  it('records a failure (HTTP 500, empty answer, timeout) as a failed row', async () => {
    const r = await answerOne({
      contestant: contestant(async () => {
        throw new Error('flint HTTP 500: boom');
      }),
      prompt: p,
      signal: new AbortController().signal,
      reserve: (e) => budget().reserve(e),
    });
    expect(r).toMatchObject({ kind: 'failed', row: { ok: false, error: 'flint HTTP 500: boom', costUsd: 0 } });
  });

  it('a request cut off by its own timeout is still a failure (the run was not stopped)', async () => {
    const r = await answerOne({
      contestant: contestant(async () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      }),
      prompt: p,
      signal: new AbortController().signal,
      reserve: (e) => budget().reserve(e),
    });
    expect(r.kind).toBe('failed');
  });

  it('records nothing for a call the run itself aborted (Ctrl-C, or another prompt stopping the run)', async () => {
    const ac = new AbortController();
    const r = answerOne({
      // Like fetch: rejects with an AbortError once the run's signal aborts.
      contestant: contestant(
        (_p, signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')));
          }),
      ),
      prompt: p,
      signal: ac.signal,
      reserve: (e) => budget().reserve(e),
    });
    ac.abort();
    expect(await r).toEqual({ kind: 'aborted' });
  });

  it('a fatal error stops the run and records nothing; so does a budget refusal (without calling)', async () => {
    const fatal = new FatalError('HTTP 400');
    const r = await answerOne({
      contestant: contestant(async () => {
        throw fatal;
      }),
      prompt: p,
      signal: new AbortController().signal,
      reserve: (e) => budget().reserve(e),
    });
    expect(r).toEqual({ kind: 'fatal', error: fatal });
    let called = false;
    const refused = await answerOne({
      contestant: contestant(async () => {
        called = true;
        return { text: 'x', costUsd: 0 };
      }),
      prompt: p,
      signal: new AbortController().signal,
      reserve: () => null,
    });
    expect(refused).toEqual({ kind: 'refused' });
    expect(called).toBe(false);
  });
});

describe('preflightFlint', () => {
  const healthy = { ok: true, evalMode: true, localModelOverride: true, localThinkOverride: true, styleVariants: ['v1', 'v2', 'local-v1'] };
  const serving = (body: Record<string, unknown>) => {
    const urls: string[] = [];
    const fetchFn = (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify(body));
    }) as unknown as typeof fetch;
    return { fetchFn, urls };
  };
  const base = { url: 'http://x', judgeOnly: false, allowTrainingLog: false };

  it('passes a server with everything asked for, and returns its /health', async () => {
    const s = serving(healthy);
    expect(await preflightFlint({ ...base, localModel: 'm:1', localThink: false, styleVariant: 'local-v1', fetchFn: s.fetchFn })).toEqual(healthy);
    expect(s.urls).toEqual(['http://x/health']);
  });

  it('checks the style variant against /health styleVariants', async () => {
    const { styleVariants: _, ...old } = healthy;
    await expect(preflightFlint({ ...base, styleVariant: 'v2', fetchFn: serving(old).fetchFn })).rejects.toThrow(/has no styleVariants/);
    await expect(preflightFlint({ ...base, styleVariant: 'v3', fetchFn: serving(healthy).fetchFn })).rejects.toThrow(/doesn't know that variant/);
    // Without the flag, a server without style variants is fine.
    await expect(preflightFlint({ ...base, fetchFn: serving(old).fetchFn })).resolves.toEqual(old);
  });

  it('refuses a server without eval mode unless --allow-training-log, and each override it lacks', async () => {
    await expect(preflightFlint({ ...base, fetchFn: serving({ ok: true }).fetchFn })).rejects.toThrow(/predates eval mode/);
    await expect(preflightFlint({ ...base, allowTrainingLog: true, fetchFn: serving({ ok: true }).fetchFn })).resolves.toEqual({ ok: true });
    await expect(preflightFlint({ ...base, localModel: 'm:1', fetchFn: serving({ evalMode: true }).fetchFn })).rejects.toThrow(/localModelOverride/);
    await expect(preflightFlint({ ...base, localModel: 'm:1', localThink: true, fetchFn: serving({ evalMode: true, localModelOverride: true }).fetchFn })).rejects.toThrow(
      /localThinkOverride/,
    );
  });

  it("fails when the server is down, and --judge-only doesn't call it at all", async () => {
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await expect(preflightFlint({ ...base, fetchFn: down })).rejects.toThrow(/isn't answering at http:\/\/x\/health/);
    const s = serving({});
    expect(await preflightFlint({ ...base, judgeOnly: true, styleVariant: 'v2', fetchFn: s.fetchFn })).toEqual({});
    expect(s.urls).toEqual([]);
  });
});
