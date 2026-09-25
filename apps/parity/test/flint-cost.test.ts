import { describe, it, expect, afterEach, vi } from 'vitest';
import { BudgetGuard } from '../src/budget.js';
import { FatalError, costOfFailure, flintContestant, flintReplayCost, type Contestant } from '../src/contestants.js';
import { costOf } from '../src/pricing.js';
import type { EvalPrompt } from '../src/prompts.js';
import { answerOne } from '../src/steps.js';

/**
 * What a Flint replay costs, and that every replay's cost lands under the eval
 * budget (and so the shared daily one, through BudgetGuard's onSettle), whether
 * it answered or not.
 */
const prompt = { id: 'p1', prompt: 'hi', category: 'knowledge' } as unknown as EvalPrompt;
const USAGE = { input: 2000, output: 1500, cacheRead: 12000 };
const flint = (over: Partial<Parameters<typeof flintContestant>[0]> = {}) =>
  flintContestant({ url: 'http://x', token: 't', frontierModel: 'claude-sonnet-4-6', allowTrainingLog: false, timeoutMs: 1000, restartWaitMs: 0, ...over });
const serverSays = (body: Record<string, unknown>, status = 200) =>
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ brain: 'frontier', model: 'anthropic:claude-opus-5-5', eval: true, ...body }), { status }));
const failure = (c: Contestant) =>
  c.answer(prompt, new AbortController().signal).then(
    () => undefined,
    (e: unknown) => e as Error,
  );

afterEach(() => vi.unstubAllGlobals());

describe('flintReplayCost', () => {
  it("prices an older server's brain label at the answering model's list price, not the unlisted rate", () => {
    const opus = flintReplayCost({ brain: 'frontier', model: 'anthropic:claude-opus-5-5', usage: USAGE }, 'claude-sonnet-4-6');
    expect(opus).toBeCloseTo((2000 * 4 + 1500 * 20 + 12000 * 0.2) / 1e6, 9); // $0.0404, not the $0.235 the label cost
    // An OpenAI last resort is priced as OpenAI (its input includes the cached part).
    const gpt = flintReplayCost({ brain: 'frontier', model: 'openai:gpt-5', usage: { input: 10_000, output: 1000, cacheRead: 4000 } }, 'x');
    expect(gpt).toBeCloseTo(costOf('openai', 'gpt-5', { input: 10_000, output: 1000, cacheRead: 4000 }), 9);
    // Free brains cost nothing.
    expect(flintReplayCost({ brain: 'local', model: 'muse-glimmer:30b', usage: USAGE }, 'x')).toBe(0);
    expect(flintReplayCost({ brain: 'frontier', model: 'ollama:qwen2.5:72b', usage: USAGE }, 'x')).toBe(0);
  });

  it("takes the server's own cost when it sends one (fallback attempts and searches included)", () => {
    expect(flintReplayCost({ brain: 'frontier', model: 'anthropic:claude-opus-5-5', usage: USAGE, costUsd: 0.113 }, 'x')).toBe(0.113);
    expect(flintReplayCost({ brain: 'local', costUsd: 0.05 }, 'x')).toBe(0.05); // frontier tried and failed, then local answered
  });
});

describe('flint contestant: the cost of every replay', () => {
  it('an answer carries the cost the server reports', async () => {
    serverSays({ text: 'Paris.', reason: 'complete', usage: USAGE, costUsd: 0.07 });
    expect((await flint().answer(prompt, new AbortController().signal)).costUsd).toBe(0.07);
  });

  it('an answer from an older server is priced from its usage at list price', async () => {
    serverSays({ text: 'Paris.', reason: 'complete', usage: USAGE });
    expect((await flint().answer(prompt, new AbortController().signal)).costUsd).toBeCloseTo(0.0404, 9);
  });

  it('an unanswered replay is still a failure, and carries what it cost', async () => {
    serverSays({ text: "I can't get you an answer on that one.", reason: 'refusal', unanswered: 'refusal', usage: USAGE, costUsd: 0.21 });
    const err = await failure(flint());
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(FatalError);
    expect(err!.message).toMatch(/did not answer.*unanswered=refusal/);
    expect(costOfFailure(err)).toBe(0.21);
  });

  it('an answer made without a paid search refused for budget is not judged, and carries its cost', async () => {
    serverSays({ text: 'From memory: ...', reason: 'complete', usage: USAGE, costUsd: 0.03, budgetBlocked: ['web.web_search'] });
    const err = await failure(flint());
    expect(err).not.toBeInstanceOf(FatalError); // one prompt, retried on resume; not a reason to stop the run
    expect(err!.message).toMatch(/flint answered without web\.web_search .*not judged/);
    expect(costOfFailure(err)).toBe(0.03);
  });

  it('a server error carries the cost the server reports, or (an older server) the estimate', async () => {
    serverSays({ error: 'flint failed: boom', costUsd: 0.12 }, 500);
    expect(costOfFailure(await failure(flint()))).toBe(0.12);
    serverSays({ error: 'frontier failed: overloaded' }, 502);
    const c = flint();
    expect(costOfFailure(await failure(c))).toBeCloseTo(c.estimate(prompt), 9);
    // A 4xx refusal ran nothing.
    serverSays({ error: "Today's Claude budget is spent, and the local brain can't read images or PDFs." }, 422);
    expect(costOfFailure(await failure(flint()))).toBe(0);
  });
});

describe('answerOne charges what a failed call cost', () => {
  const contestant = (answer: Contestant['answer']): Contestant => ({ name: 'flint', model: 'flint@x', estimate: () => 0.05, answer });
  const guarded = () => {
    const settled: number[] = [];
    const budget = new BudgetGuard(10, (usd) => settled.push(usd)); // onSettle: the shared daily eval ledger
    return { budget, settled, reserve: (e: number) => budget.reserve(e) };
  };

  it('a failure that reports its cost: charged in full, and recorded on the row', async () => {
    const g = guarded();
    const r = await answerOne({
      contestant: contestant(async () => {
        throw Object.assign(new Error('flint did not answer (unanswered=refusal)'), { costUsd: 0.21 });
      }),
      prompt,
      signal: new AbortController().signal,
      reserve: g.reserve,
    });
    expect(r).toMatchObject({ kind: 'failed', row: { ok: false, costUsd: 0.21 } });
    expect(g.budget.spent).toBeCloseTo(0.21, 9);
    expect(g.settled).toEqual([0.21]);
  });

  it('a request cut off by its own timeout: charged the estimate (the server ran, and billed, until it was cut off)', async () => {
    const g = guarded();
    const r = await answerOne({
      contestant: contestant(async () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      }),
      prompt,
      signal: new AbortController().signal,
      reserve: g.reserve,
    });
    expect(r).toMatchObject({ kind: 'failed', row: { costUsd: 0.05 } });
    expect(g.budget.spent).toBeCloseTo(0.05, 9);
  });

  it('a call the run itself aborted: nothing recorded, but the estimate is charged', async () => {
    const g = guarded();
    const ac = new AbortController();
    const r = answerOne({
      contestant: contestant(
        (_p, signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')));
          }),
      ),
      prompt,
      signal: ac.signal,
      reserve: g.reserve,
    });
    ac.abort();
    expect(await r).toEqual({ kind: 'aborted' });
    expect(g.budget.spent).toBeCloseTo(0.05, 9);
  });

  it('a fatal error still charges what the call cost', async () => {
    const g = guarded();
    const r = await answerOne({
      contestant: contestant(async () => {
        throw Object.assign(new FatalError('asked for localOnly but brain=frontier answered'), { costUsd: 0.09 });
      }),
      prompt,
      signal: new AbortController().signal,
      reserve: g.reserve,
    });
    expect(r.kind).toBe('fatal');
    expect(g.budget.spent).toBeCloseTo(0.09, 9);
  });

  it('a request that never reached the server costs nothing', async () => {
    const g = guarded();
    const r = await answerOne({
      contestant: contestant(async () => {
        throw new TypeError('fetch failed');
      }),
      prompt,
      signal: new AbortController().signal,
      reserve: g.reserve,
    });
    expect(r).toMatchObject({ kind: 'failed', row: { costUsd: 0 } });
    expect(g.budget.spent).toBe(0);
  });

  it('end to end: an unanswered replay from the server is charged its reported cost', async () => {
    serverSays({ text: 'no', reason: 'refusal', unanswered: 'refusal', usage: USAGE, costUsd: 0.18 });
    const g = guarded();
    const r = await answerOne({ contestant: flint(), prompt, signal: new AbortController().signal, reserve: g.reserve });
    expect(r).toMatchObject({ kind: 'failed', row: { costUsd: 0.18 } });
    expect(g.settled).toEqual([0.18]);
  });

  // Flint tasks: a server that ignores the eval overrides stops the run, but the
  // replay it ran was still billed, so it still lands on the budget and the daily ledger.
  it('end to end: a server that ignored groundingChars stops the run, and is charged its reported cost', async () => {
    serverSays({ text: 'hi', reason: 'complete', usage: USAGE, costUsd: 0.42, groundingChars: 800 });
    const g = guarded();
    const r = await answerOne({ contestant: flint({ groundingChars: 4000 }), prompt, signal: new AbortController().signal, reserve: g.reserve });
    expect(r.kind).toBe('fatal');
    expect(g.settled).toEqual([0.42]);
    expect(g.budget.spent).toBeCloseTo(0.42, 9);
  });

  it('end to end: a server that ignored recall: false stops the run, and is charged its reported cost', async () => {
    serverSays({ text: 'hi', reason: 'complete', usage: USAGE, costUsd: 0.42, recall: true });
    const g = guarded();
    const r = await answerOne({ contestant: flint({ withholdMemory: () => true }), prompt, signal: new AbortController().signal, reserve: g.reserve });
    expect(r.kind).toBe('fatal');
    expect(g.settled).toEqual([0.42]);
    expect(g.budget.spent).toBeCloseTo(0.42, 9);
  });
});
