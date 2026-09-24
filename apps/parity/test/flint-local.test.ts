import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HISTORY_HEADER, appendHistory, migrateHistory, reportFileName } from '../src/report.js';
import { FatalError, assertLocalModelName, fetchWhileRestarting, flintContestant, flintContestantName, ollamaHasModel } from '../src/contestants.js';

const V1 =
  'ts,run,prompt_set,competitor,competitor_model,judge_model,n,flint_wins,competitor_wins,ties,flint_win_rate,p_value,signal,judge_errors';

describe('history subject column', () => {
  let dir = '';
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  it('upgrades a v1 file, marking old rows as flint, then appends', () => {
    dir = mkdtempSync(join(tmpdir(), 'parity-hist-'));
    const p = join(dir, 'h.csv');
    writeFileSync(p, `${V1}\nt,r,s,openai,gpt-5,j,10,5,3,2,0.625,0.7,NOISE,0\n`);
    appendHistory(p, ['t2,r,s,openai,gpt-5,j,10,1,8,1,0.111,0.04,SIGNIFICANT,0,flint-local']);
    const lines = readFileSync(p, 'utf8').trim().split('\n');
    expect(lines[0]).toBe(HISTORY_HEADER);
    expect(lines[1]!.endsWith(',flint')).toBe(true);
    expect(lines[2]!.endsWith(',flint-local')).toBe(true);
  });

  it('leaves a current file alone', () => {
    dir = mkdtempSync(join(tmpdir(), 'parity-hist-'));
    const p = join(dir, 'h.csv');
    const body = `${HISTORY_HEADER}\nt,r,s,openai,gpt-5,j,1,1,0,0,1.000,1,NOISE,0,flint\n`;
    writeFileSync(p, body);
    migrateHistory(p);
    expect(readFileSync(p, 'utf8')).toBe(body);
  });
});

describe('flint-local contestant', () => {
  const prompt = { id: 'p1', prompt: 'hi', category: 'knowledge' } as never;
  const mk = (localOnly: boolean) =>
    flintContestant({ url: 'http://x', token: 't', frontierModel: 'claude-sonnet-4-6', allowTrainingLog: false, timeoutMs: 1000, localOnly });
  afterEach(() => vi.unstubAllGlobals());

  it('is a separate, free contestant that asks the server for localOnly', async () => {
    const c = mk(true);
    expect(c.name).toBe('flint-local');
    expect(c.estimate(prompt)).toBe(0);
    let sent: Record<string, unknown> = {};
    vi.stubGlobal('fetch', async (_u: string, init: { body: string }) => {
      sent = JSON.parse(init.body);
      return new Response(JSON.stringify({ text: 'hello', brain: 'local', model: 'qwen2.5:7b', eval: true, usage: { input: 10, output: 5 } }));
    });
    const a = await c.answer(prompt, new AbortController().signal);
    expect(sent).toMatchObject({ prompt: 'hi', eval: true, localOnly: true });
    expect(a.costUsd).toBe(0);
  });

  it('stops the run if a frontier brain answered a local-only request', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ text: 'x', brain: 'frontier', eval: true })));
    await expect(mk(true).answer(prompt, new AbortController().signal)).rejects.toBeInstanceOf(FatalError);
  });

  it('normal flint is unchanged', () => {
    expect(mk(false).name).toBe('flint');
  });
});

describe('fetchWhileRestarting', () => {
  const noSleep = async () => {};
  const refused = () => new TypeError('fetch failed');

  it('waits out a server restart instead of failing the prompt', async () => {
    let n = 0;
    const r = await fetchWhileRestarting(
      async () => {
        if (++n < 4) throw refused();
        return new Response('ok');
      },
      new AbortController().signal,
      120_000,
      noSleep,
    );
    expect(await r.text()).toBe('ok');
    expect(n).toBe(4);
  });

  it('gives up once the wait budget is spent', async () => {
    await expect(
      fetchWhileRestarting(async () => { throw refused(); }, new AbortController().signal, 3000, noSleep),
    ).rejects.toThrow('fetch failed');
  });

  it('does not retry errors from a server that answered', async () => {
    let n = 0;
    await expect(
      fetchWhileRestarting(async () => { n++; throw new Error('HTTP 500'); }, new AbortController().signal, 120_000, noSleep),
    ).rejects.toThrow('HTTP 500');
    expect(n).toBe(1);
  });
});

describe('local-model bake-off contestant', () => {
  const prompt = { id: 'p1', prompt: 'hi', category: 'knowledge' } as never;
  const mk = (localModel: string) =>
    flintContestant({ url: 'http://x', token: 't', frontierModel: 'claude-sonnet-4-6', allowTrainingLog: false, timeoutMs: 1000, localModel });
  afterEach(() => vi.unstubAllGlobals());

  it('is named per candidate, so answers and verdicts stay separate', () => {
    expect(mk('qwen3:14b').name).toBe('flint-local@qwen3:14b');
    expect(flintContestantName({ localOnly: true, localModel: 'gemma3:12b' })).toBe('flint-local@gemma3:12b');
    expect(flintContestantName({ localOnly: true })).toBe('flint-local');
    expect(flintContestantName({})).toBe('flint');
  });

  it('gets a filename-safe report path', () => {
    expect(reportFileName('flint')).toBe('report.md');
    expect(reportFileName('flint-local')).toBe('report-flint-local.md');
    expect(reportFileName('flint-local@qwen3:14b')).toBe('report-flint-local@qwen3_14b.md');
    expect(reportFileName('flint-local@hf.co/bartowski/Qwen3-14B-GGUF:Q4_K_M')).toBe('report-flint-local@hf.co_bartowski_Qwen3-14B-GGUF_Q4_K_M.md');
    expect(reportFileName('flint-local@../../x')).not.toContain('/');
  });

  it('sends localModel with eval + localOnly and is free', async () => {
    const c = mk('qwen3:14b');
    expect(c.estimate(prompt)).toBe(0);
    let sent: Record<string, unknown> = {};
    vi.stubGlobal('fetch', async (_u: string, init: { body: string }) => {
      sent = JSON.parse(init.body);
      return new Response(JSON.stringify({ text: 'hello', brain: 'local', model: 'qwen3:14b', eval: true, usage: { input: 10, output: 5 } }));
    });
    const a = await c.answer(prompt, new AbortController().signal);
    expect(sent).toEqual({ prompt: 'hi', eval: true, localOnly: true, localModel: 'qwen3:14b' });
    expect(a.costUsd).toBe(0);
    expect(a.meta?.model).toBe('qwen3:14b');
  });

  it('stops the run when another model answered (server predates or ignored the override)', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ text: 'x', brain: 'local', model: 'qwen2.5:14b', eval: true })));
    await expect(mk('qwen3:14b').answer(prompt, new AbortController().signal)).rejects.toBeInstanceOf(FatalError);
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ text: 'x', brain: 'local', eval: true })));
    await expect(mk('qwen3:14b').answer(prompt, new AbortController().signal)).rejects.toBeInstanceOf(FatalError);
  });

  it('refuses a name the server would reject', () => {
    expect(() => mk('qwen 14b')).toThrow(/isn't an Ollama model name/);
    expect(() => assertLocalModelName('a'.repeat(101))).toThrow();
    expect(() => assertLocalModelName('hf.co/org/repo:Q4_K_M')).not.toThrow();
  });
});

describe('ollamaHasModel', () => {
  const tags = (names: string[]) =>
    (async () => new Response(JSON.stringify({ models: names.map((name) => ({ name, model: name })) }))) as unknown as typeof fetch;

  it('finds an exact tag, and a bare name as :latest', async () => {
    expect((await ollamaHasModel('qwen3:14b', 'http://o', tags(['qwen3:14b', 'nomic-embed-text:latest']))).ok).toBe(true);
    expect((await ollamaHasModel('nomic-embed-text', 'http://o', tags(['nomic-embed-text:latest']))).ok).toBe(true);
  });

  it('reports a model that is not pulled, with what is available', async () => {
    const r = await ollamaHasModel('qwen3:32b', 'http://o', tags(['qwen3:14b']));
    expect(r).toEqual({ ok: false, available: ['qwen3:14b'] });
    // A tagged ask never matches a different tag.
    expect((await ollamaHasModel('qwen3:14b', 'http://o', tags(['qwen3:latest']))).ok).toBe(false);
  });

  it('throws when Ollama answers with an error', async () => {
    const down = (async () => new Response('no', { status: 500 })) as unknown as typeof fetch;
    await expect(ollamaHasModel('qwen3:14b', 'http://o', down)).rejects.toThrow(/HTTP 500/);
  });
});
