import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HISTORY_HEADER, appendHistory, migrateHistory } from '../src/report.js';
import { FatalError, fetchWhileRestarting, flintContestant } from '../src/contestants.js';

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
