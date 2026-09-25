import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  FatalError,
  STYLE_VARIANT_MAX_LEN,
  assertStyleVariantName,
  assertStyleVariantSupported,
  flintContestant,
  flintContestantName,
  flintHealth,
  flintVariantFlag,
} from '../src/contestants.js';
import { cachedJudgments, isFlintName, reportFileName, type JudgmentRow } from '../src/report.js';

const prompt = { id: 'p1', prompt: 'hi', category: 'knowledge' } as never;
const base = { url: 'http://x', token: 't', frontierModel: 'claude-sonnet-4-6', allowTrainingLog: false, timeoutMs: 1000 };
const signal = () => new AbortController().signal;

/** A stub /generate that records the request body and answers with `reply`. */
function stubGenerate(reply: Record<string, unknown>, status = 200): { sent: () => Record<string, unknown> } {
  let sent: Record<string, unknown> = {};
  vi.stubGlobal('fetch', async (_u: string, init: { body: string }) => {
    sent = JSON.parse(init.body);
    return new Response(JSON.stringify(reply), { status });
  });
  return { sent: () => sent };
}

describe('--flint-variant: contestant naming', () => {
  it('appends #<variant> only when a variant is given, so cached answers keep matching', () => {
    expect(flintContestantName({ styleVariant: 'v2' })).toBe('flint#v2');
    expect(flintContestantName({ styleVariant: 'v1' })).toBe('flint#v1');
    expect(flintContestantName({ localOnly: true, styleVariant: 'local-v1' })).toBe('flint-local#local-v1');
    expect(flintContestantName({ localOnly: true, localModel: 'qwen3:14b', styleVariant: 'local-v1' })).toBe('flint-local@qwen3:14b#local-v1');
    expect(flintContestantName({ localOnly: true, localModel: 'muse-glimmer:30b', localThink: false, styleVariant: 'local-v1' })).toBe(
      'flint-local@muse-glimmer:30b~nothink#local-v1',
    );
    // Unchanged without it.
    expect(flintContestantName({})).toBe('flint');
    expect(flintContestantName({ localOnly: true, localModel: 'muse-glimmer:30b', localThink: false })).toBe('flint-local@muse-glimmer:30b~nothink');
    expect(flintContestantName({ styleVariant: undefined })).toBe('flint');
  });

  it('names the contestant built with the flag the same way', () => {
    expect(flintContestant({ ...base, styleVariant: 'v2' }).name).toBe('flint#v2');
    expect(flintContestant({ ...base, localOnly: true, styleVariant: 'local-v1' }).name).toBe('flint-local#local-v1');
    expect(flintContestant({ ...base, localModel: 'muse-glimmer:30b', localThink: false, styleVariant: 'local-v1' }).name).toBe(
      'flint-local@muse-glimmer:30b~nothink#local-v1',
    );
    expect(flintContestant({ ...base }).name).toBe('flint');
  });

  it('is still a Flint subject, never a competitor', () => {
    for (const n of ['flint', 'flint#v2', 'flint-local', 'flint-local#local-v1', 'flint-local@qwen3:14b~think#local-v1']) expect(isFlintName(n), n).toBe(true);
    for (const n of ['openai', 'claude', 'perplexity']) expect(isFlintName(n), n).toBe(false);
  });

  it('gets its own filename-safe report, with # as +', () => {
    expect(reportFileName('flint#v2')).toBe('report-flint+v2.md');
    expect(reportFileName('flint-local#local-v1')).toBe('report-flint-local+local-v1.md');
    expect(reportFileName('flint-local@muse-glimmer:30b~nothink#local-v1')).toBe('report-flint-local@muse-glimmer_30b~nothink+local-v1.md');
    expect(reportFileName('flint-local@hf.co/org/repo:Q4_K_M#v2')).toBe('report-flint-local@hf.co_org_repo_Q4_K_M+v2.md');
    for (const s of ['flint#v2', 'flint-local@a/b:c~think#local-v1']) expect(reportFileName(s)).not.toMatch(/[#/:\s]/);
    // A variant's report never collides with the plain one's.
    expect(reportFileName('flint#v1')).not.toBe(reportFileName('flint'));
    expect(reportFileName('flint-local@qwen3:14b#v2')).not.toBe(reportFileName('flint-local@qwen3:14b_v2'));
    // Existing names are untouched.
    expect(reportFileName('flint-local@qwen3.8:27b~nothink')).toBe('report-flint-local@qwen3.8_27b~nothink.md');
  });

  it("gives a grounded judge's report its own file, so a grounded pass never overwrites the ungrounded one", () => {
    expect(reportFileName('flint', 'claude-opus-5-5+grounded')).toBe('report+grounded.md');
    expect(reportFileName('flint#v2', 'claude-opus-5-5+grounded')).toBe('report+grounded-flint+v2.md');
    expect(reportFileName('flint-local@muse-glimmer:30b~nothink#local-v1', 'panel:anthropic:claude-opus-5-5+openai:gpt-5+grounded')).toBe(
      'report+grounded-flint-local@muse-glimmer_30b~nothink+local-v1.md',
    );
    // Ungrounded judges (a model or a panel) keep today's names.
    expect(reportFileName('flint', 'claude-opus-5-5')).toBe('report.md');
    expect(reportFileName('flint#v2', 'panel:anthropic:claude-opus-5-5+openai:gpt-5')).toBe('report-flint+v2.md');
    // No grounded name equals any ungrounded one, even for a variant called "grounded".
    const subjects = ['flint', 'flint#v2', 'flint#grounded', 'flint-local', 'flint-local@m:1', 'flint-local@m:1#grounded'];
    const plain = new Set(subjects.map((s) => reportFileName(s, 'j')));
    for (const s of subjects) expect(plain.has(reportFileName(s, 'j+grounded')), s).toBe(false);
  });

  it("keeps a variant's verdicts apart from plain Flint's", () => {
    const row = (subject: string): JudgmentRow => ({
      subject,
      promptId: 'p1',
      category: 'knowledge',
      competitor: 'openai',
      competitorModel: 'gpt-5',
      judgeModel: 'j',
      flintIsA: true,
      ok: true,
      verdict: 'A',
      outcome: 'win',
      costUsd: 0,
      ts: 0,
    });
    const rows = [row('flint'), row('flint#v2')];
    expect([...cachedJudgments(rows, 'j', 'flint#v2').values()].map((r) => r.subject)).toEqual(['flint#v2']);
    expect([...cachedJudgments(rows, 'j', 'flint').values()].map((r) => r.subject)).toEqual(['flint']);
    expect(cachedJudgments(rows, 'j', 'flint#v1').size).toBe(0);
  });
});

describe('--flint-variant: flag parsing', () => {
  it('accepts variant names and trims them', () => {
    expect(flintVariantFlag(undefined)).toBeUndefined();
    expect(flintVariantFlag(' v2 ')).toBe('v2');
    for (const v of ['v1', 'v2', 'local-v1', 'v2.1', 'A_b']) expect(() => assertStyleVariantName(v), v).not.toThrow();
  });

  it("refuses anything that isn't a plain name (it goes into file names and the contestant name)", () => {
    for (const bad of ['', ' ', 'v 2', 'v#2', 'v/2', 'v:2', 'v~2', 'v@2', '-v2', '.v2', 'x'.repeat(STYLE_VARIANT_MAX_LEN + 1)]) {
      expect(() => flintVariantFlag(bad), JSON.stringify(bad)).toThrow(/--flint-variant/);
    }
    expect(() => flintContestant({ ...base, styleVariant: 'v#2' })).toThrow(/--flint-variant/);
  });
});

describe('--flint-variant: request and echo', () => {
  afterEach(() => vi.unstubAllGlobals());
  const ok = (extra: Record<string, unknown>) => ({ text: 'hello', brain: 'frontier', model: 'claude-opus-5-5', eval: true, ...extra });

  it('sends styleVariant with eval', async () => {
    const s = stubGenerate(ok({ styleVariant: 'v2' }));
    const a = await flintContestant({ ...base, styleVariant: 'v2' }).answer(prompt, signal());
    expect(s.sent()).toEqual({ prompt: 'hi', eval: true, styleVariant: 'v2' });
    expect(a.text).toBe('hello');
    expect(a.meta?.styleVariant).toBe('v2');
  });

  it('sends it with the local-model and think overrides too', async () => {
    const s = stubGenerate({ text: 'x', brain: 'local', model: 'muse-glimmer:30b', eval: true, localThink: false, styleVariant: 'local-v1' });
    await flintContestant({ ...base, localModel: 'muse-glimmer:30b', localThink: false, styleVariant: 'local-v1' }).answer(prompt, signal());
    expect(s.sent()).toEqual({ prompt: 'hi', eval: true, localOnly: true, localModel: 'muse-glimmer:30b', localThink: false, styleVariant: 'local-v1' });
  });

  it('sends no styleVariant without the flag (the request is exactly as before)', async () => {
    const s = stubGenerate(ok({}));
    await flintContestant({ ...base }).answer(prompt, signal());
    expect(s.sent()).toEqual({ prompt: 'hi', eval: true });
  });

  it('stops the run when the server does not echo the variant it was asked for', async () => {
    stubGenerate(ok({}));
    await expect(flintContestant({ ...base, styleVariant: 'v2' }).answer(prompt, signal())).rejects.toBeInstanceOf(FatalError);
    stubGenerate(ok({ styleVariant: 'v1' }));
    await expect(flintContestant({ ...base, styleVariant: 'v2' }).answer(prompt, signal())).rejects.toThrow(/asked for styleVariant v2 but the server answered with v1/);
    // An empty answer from a server that did not honour it is still a mismatch, not a per-prompt failure.
    stubGenerate(ok({ text: '' }));
    await expect(flintContestant({ ...base, styleVariant: 'v2' }).answer(prompt, signal())).rejects.toBeInstanceOf(FatalError);
  });

  it('stops the run on an HTTP 400 (the server refused the request shape, e.g. an unknown variant)', async () => {
    stubGenerate({ error: 'unknown styleVariant "v9"' }, 400);
    const err = await flintContestant({ ...base, styleVariant: 'v9' })
      .answer(prompt, signal())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FatalError);
    expect(String((err as Error).message)).toMatch(/HTTP 400: unknown styleVariant/);
  });

  it('a server error or empty answer is still a per-prompt failure, not a stop', async () => {
    stubGenerate({ error: 'boom' }, 500);
    const e500 = await flintContestant({ ...base, styleVariant: 'v2' }).answer(prompt, signal()).catch((e: unknown) => e);
    expect(e500).toBeInstanceOf(Error);
    expect(e500).not.toBeInstanceOf(FatalError);
    stubGenerate(ok({ text: '  ', styleVariant: 'v2' }));
    const empty = await flintContestant({ ...base, styleVariant: 'v2' }).answer(prompt, signal()).catch((e: unknown) => e);
    expect(empty).not.toBeInstanceOf(FatalError);
    expect(String((empty as Error).message)).toMatch(/empty answer/);
  });
});

describe('--flint-variant: /health preflight', () => {
  const health = (body: Record<string, unknown>) =>
    (async (url: string) => {
      expect(url).toBe('http://x/health');
      return new Response(JSON.stringify(body));
    }) as unknown as typeof fetch;

  it('fails clearly against a server without style variants (until the server side lands)', async () => {
    const h = await flintHealth('http://x/', health({ ok: true, evalMode: true, localModelOverride: true }));
    expect(h).toBeDefined();
    expect(() => assertStyleVariantSupported(h!, 'v2', 'http://x')).toThrow(/doesn't support style variants \(\/health has no styleVariants\)/);
  });

  it('passes a variant the server lists, and names the ones it has otherwise', async () => {
    const h = await flintHealth('http://x', health({ ok: true, evalMode: true, styleVariants: ['v1', 'v2', 'local-v1'] }));
    expect(() => assertStyleVariantSupported(h!, 'v2', 'http://x')).not.toThrow();
    expect(() => assertStyleVariantSupported(h!, 'local-v1', 'http://x')).not.toThrow();
    expect(() => assertStyleVariantSupported(h!, 'v3', 'http://x')).toThrow(/doesn't know that variant \(it has: v1, v2, local-v1\)/);
  });

  it('is undefined when the server is down', async () => {
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    expect(await flintHealth('http://x', down)).toBeUndefined();
  });
});
