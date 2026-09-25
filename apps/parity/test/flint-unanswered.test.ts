import { describe, it, expect, afterEach, vi } from 'vitest';
import { FatalError, flintContestant } from '../src/contestants.js';
import { renderMarkdown } from '../src/report.js';

/**
 * When no model answers, the server sends an honest message as `text` and marks
 * it `unanswered`. That message is not an answer: the harness keeps treating
 * the prompt as a Flint failure (not judged, not a loss, retried on resume),
 * exactly as the empty reply it replaced was in earlier runs, so win rates stay
 * comparable across server builds.
 */
describe('flint contestant: the server did not answer', () => {
  const prompt = { id: 'p1', prompt: 'hi', category: 'knowledge' } as never;
  const flint = () =>
    flintContestant({ url: 'http://x', token: 't', frontierModel: 'claude-sonnet-4-6', allowTrainingLog: false, timeoutMs: 1000 });
  const serverSays = (body: Record<string, unknown>) =>
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ brain: 'frontier', model: 'anthropic:claude-opus-5-5', eval: true, ...body })));
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ['refusal', 'refusal', "I can't get you an answer on that one: all 3 models I tried declined it."],
    ['empty', 'complete', 'I came back empty on that one: the model I asked returned nothing.'],
  ])('%s: a (non-fatal) failure naming why, never an answer to judge', async (unanswered, reason, text) => {
    serverSays({ text, reason, unanswered, usage: { input: 10, output: 5 } });
    const err = await flint()
      .answer(prompt, new AbortController().signal)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(FatalError); // one prompt's failure, not a reason to stop the run
    expect((err as Error).message).toMatch(new RegExp(`did not answer.*unanswered=${unanswered}`));
  });

  it('a real answer is unaffected', async () => {
    serverSays({ text: 'Paris.', reason: 'complete', usage: { input: 10, output: 5 } });
    const a = await flint().answer(prompt, new AbortController().signal);
    expect(a.text).toBe('Paris.');
  });

  it('the report lists it under Flint failures and counts the unanswered ones', async () => {
    serverSays({ text: "I can't get you an answer on that one: ...", reason: 'refusal', unanswered: 'refusal' });
    const error = await flint()
      .answer(prompt, new AbortController().signal)
      .then(() => 'answered', (e: unknown) => (e as Error).message);
    const md = renderMarkdown({
      run: 'r',
      promptSet: 'p',
      promptCount: 2,
      contestants: [{ name: 'flint', model: 'f' }],
      answers: [
        { promptId: 'declined', contestant: 'flint', model: 'f', ok: false, error, costUsd: 0, ms: 1, ts: 0 },
        { promptId: 'down', contestant: 'flint', model: 'f', ok: false, error: 'fetch failed', costUsd: 0, ms: 1, ts: 0 },
      ],
      summaries: [],
      spendUsd: 0,
      budgetUsd: 1,
      stoppedForBudget: false,
      notes: [],
    });
    expect(md).toContain('## Flint failures');
    expect(md).toContain('1 of these 2 were not answered by any model');
    expect(md).toMatch(/`declined`: flint did not answer \(unanswered=refusal/);
  });
});
