import { describe, it, expect } from 'vitest';
import { DEFAULT_OLLAMA_MODEL, isOllamaCloudModel, pickOllamaModel } from '../../src/provider/ollama/default-model.js';

/**
 * The model an app uses when none is named: one Ollama already has, never a
 * hosted one. A stub fetch plays Ollama's two list endpoints; nothing touches a
 * real Ollama and nothing is generated.
 */

const model = (name: string, family?: string, extra: Record<string, unknown> = {}) => ({ name, model: name, details: { family }, ...extra });

/** Ollama's list endpoints, each answering `{ models }`, a status, or failing outright. */
function ollama(lists: { ps?: unknown[] | number | 'down'; tags?: unknown[] | number | 'down' }) {
  const asked: string[] = [];
  const impl = (async (url: string) => {
    asked.push(url);
    const list = url.endsWith('/api/ps') ? lists.ps : lists.tags;
    if (list === 'down' || list === undefined) throw new TypeError('fetch failed');
    if (typeof list === 'number') return new Response('no', { status: list });
    return new Response(JSON.stringify({ models: list }), { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, asked };
}

describe('pickOllamaModel', () => {
  it('prefers the chat model Ollama already has loaded, past a loaded embedder', async () => {
    const o = ollama({
      ps: [model('nomic-embed-text:latest', 'nomic-bert'), model('muse-glimmer:30b', 'muse-glimmer')],
      tags: [model('gemma4:26b', 'gemma4'), model('muse-glimmer:30b', 'muse-glimmer')],
    });
    expect(await pickOllamaModel({ fetch: o.impl })).toEqual({ model: 'muse-glimmer:30b', from: 'loaded', answered: true });
    expect(o.asked).toEqual(['http://127.0.0.1:11434/api/ps']); // the pulled list is not needed
  });

  it('says what context window a loaded model has, so asking it does not make Ollama reload it', async () => {
    const o = ollama({ ps: [model('muse-glimmer:30b', 'muse-glimmer', { context_length: 16384 })] });
    expect(await pickOllamaModel({ fetch: o.impl })).toEqual({ model: 'muse-glimmer:30b', from: 'loaded', numCtx: 16384, answered: true });
    for (const bad of [0, -1, 4096.5, '16384', null]) {
      const junk = ollama({ ps: [model('muse-glimmer:30b', 'muse-glimmer', { context_length: bad })] });
      expect(await pickOllamaModel({ fetch: junk.impl })).toEqual({ model: 'muse-glimmer:30b', from: 'loaded', answered: true });
    }
  });

  it('with nothing loaded, takes the first pulled model that can chat on this machine', async () => {
    const o = ollama({
      ps: [],
      tags: [
        model('nomic-embed-text:latest', 'nomic-bert'),
        model('bge-reranker:latest', 'bert'),
        model('gpt-oss:120b-cloud', 'gptoss'),
        model('some-pointer:latest', 'llama', { remote_host: 'https://ollama.com' }),
        model('qwen3.8:27b', 'qwen35'),
        model('qwen2.5:7b', 'qwen2'),
      ],
    });
    expect(await pickOllamaModel({ baseURL: 'http://box:11434/', fetch: o.impl })).toEqual({ model: 'qwen3.8:27b', from: 'pulled', answered: true });
    expect(o.asked).toEqual(['http://box:11434/api/ps', 'http://box:11434/api/tags']);
  });

  it('a model listed without details still counts (an MLX build has no family)', async () => {
    const o = ollama({ ps: [], tags: [{ name: 'muse-glimmer:30b-mlx', details: null }] });
    expect(await pickOllamaModel({ fetch: o.impl })).toEqual({ model: 'muse-glimmer:30b-mlx', from: 'pulled', answered: true });
  });

  it('falls back to the default, and never throws, when Ollama is down, errors, or has only embedders', async () => {
    for (const [lists, answered] of [
      [{ ps: 'down', tags: 'down' }, false],
      [{ ps: 500, tags: 404 }, false],
      [{ ps: [], tags: [] }, true],
      [{ ps: [model('nomic-embed-text:latest', 'nomic-bert')], tags: [model('nomic-embed-text:latest', 'nomic-bert'), { name: 7 }, {}] }, true],
    ] as const) {
      // `answered` tells an Ollama that could not be asked (worth asking again) from one that is up and empty.
      expect(await pickOllamaModel({ fetch: ollama(lists as Parameters<typeof ollama>[0]).impl })).toEqual({ model: DEFAULT_OLLAMA_MODEL, from: 'default', answered });
    }
  });

  it('skip: a model the caller names is never picked, loaded or pulled', async () => {
    const skip = (name: string) => name === 'small-model:3b';
    const both = ollama({ ps: [model('small-model:3b', 'llama'), model('muse-glimmer:30b', 'muse-glimmer')], tags: [] });
    expect(await pickOllamaModel({ fetch: both.impl, skip })).toMatchObject({ model: 'muse-glimmer:30b', from: 'loaded' });
    const onlyIt = ollama({ ps: [model('small-model:3b', 'llama')], tags: [model('small-model:3b', 'llama'), model('gemma4:26b', 'gemma4')] });
    expect(await pickOllamaModel({ fetch: onlyIt.impl, skip })).toMatchObject({ model: 'gemma4:26b', from: 'pulled' });
    const nothingElse = ollama({ ps: [model('small-model:3b', 'llama')], tags: [model('small-model:3b', 'llama')] });
    expect(await pickOllamaModel({ fetch: nothingElse.impl, skip })).toEqual({ model: DEFAULT_OLLAMA_MODEL, from: 'default', answered: true });
  });

  it('a reply that is not the expected shape is treated as an empty list', async () => {
    const impl = (async () => new Response('"nope"', { status: 200 })) as unknown as typeof fetch;
    expect(await pickOllamaModel({ fetch: impl })).toEqual({ model: DEFAULT_OLLAMA_MODEL, from: 'default', answered: true });
  });
});

describe('isOllamaCloudModel', () => {
  it('knows a cloud tag and a cloud suffix, and nothing else', () => {
    for (const m of ['gpt-oss:120b-cloud', 'glm-4.6:cloud', 'qwen3-coder-cloud', 'Kimi-K2:1T-Cloud']) expect(isOllamaCloudModel(m), m).toBe(true);
    for (const m of ['qwen2.5:7b', 'muse-glimmer:30b', 'cloudy:7b', 'llama3.1', 'hf.co/org/cloud-model:Q4_K_M']) expect(isOllamaCloudModel(m), m).toBe(false);
  });
});
