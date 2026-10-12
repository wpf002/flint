import { describe, expect, it } from 'vitest';
import { DEFAULT_OLLAMA_MODEL, OllamaProvider } from '@flint/core';
import {
  LOCAL_MODEL_MAX_LEN,
  LOCAL_PICK_RETRIES,
  LOCAL_PICK_RETRY_MS,
  LocalPersonaCache,
  chooseLocalBrain,
  evalOllamaOptions,
  localDefaultNote,
  liveOllamaOptions,
  overrideKey,
  overridePersonaCache,
  parseLocalModelRequest,
  parseOllamaThink,
  resolveLocalPersona,
  thinkOption,
} from '../src/local-model';

describe('parseLocalModelRequest', () => {
  const evalLocal = { eval: true, localOnly: true };

  it('is a no-op when no override is asked for (normal traffic)', () => {
    expect(parseLocalModelRequest({ prompt: 'hi' })).toEqual({ ok: true, model: undefined });
    expect(parseLocalModelRequest({ prompt: 'hi', eval: true })).toEqual({ ok: true, model: undefined });
    expect(parseLocalModelRequest({ prompt: 'hi', localModel: null })).toEqual({ ok: true, model: undefined });
  });

  it('accepts real Ollama model names with eval + localOnly', () => {
    for (const m of ['qwen2.5:14b', 'llama3.1', 'hf.co/bartowski/Qwen3-14B-GGUF:Q4_K_M', 'library/gemma3:12b-it-qat', 'mistral-small3.2:24b']) {
      expect(parseLocalModelRequest({ ...evalLocal, localModel: m }), m).toEqual({ ok: true, model: m });
    }
  });

  it('rejects the override without eval: true', () => {
    expect(parseLocalModelRequest({ localOnly: true, localModel: 'qwen3:14b' })).toMatchObject({ ok: false, status: 400 });
    expect(parseLocalModelRequest({ eval: 'true', localOnly: true, localModel: 'qwen3:14b' })).toMatchObject({ ok: false, status: 400 });
  });

  it('rejects the override without localOnly: true', () => {
    expect(parseLocalModelRequest({ eval: true, localModel: 'qwen3:14b' })).toMatchObject({ ok: false, status: 400 });
    expect(parseLocalModelRequest({ eval: true, localOnly: false, localModel: 'qwen3:14b' })).toMatchObject({ ok: false, status: 400 });
  });

  it('rejects names that are not plain model names', () => {
    for (const bad of ['', '   ', 'qwen 14b', 'qwen;rm -rf', 'a'.repeat(LOCAL_MODEL_MAX_LEN + 1), 'q$wen', 'qwen\nx', 'ünï']) {
      expect(parseLocalModelRequest({ ...evalLocal, localModel: bad }), JSON.stringify(bad)).toMatchObject({ ok: false, status: 400 });
    }
    expect(parseLocalModelRequest({ ...evalLocal, localModel: 42 })).toMatchObject({ ok: false, status: 400 });
    expect(parseLocalModelRequest({ ...evalLocal, localModel: 'a'.repeat(LOCAL_MODEL_MAX_LEN) })).toMatchObject({ ok: true });
  });

  it('checks the name before the eval/localOnly rules', () => {
    const r = parseLocalModelRequest({ localModel: 'bad name' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/must match/);
  });
});

describe('LocalPersonaCache', () => {
  it('builds one persona per model and reuses it', () => {
    const made: string[] = [];
    const cache = new LocalPersonaCache((m) => {
      made.push(m);
      return { model: m };
    });
    const a = cache.get('qwen3:14b');
    expect(cache.get('qwen3:14b')).toBe(a);
    cache.get('gemma3:12b');
    expect(made).toEqual(['qwen3:14b', 'gemma3:12b']);
  });

  it('evicts the least recently used past its bound', () => {
    const made: string[] = [];
    const cache = new LocalPersonaCache((m) => {
      made.push(m);
      return m;
    }, 2);
    cache.get('a');
    cache.get('b');
    cache.get('a'); // a is now the most recent
    cache.get('c'); // evicts b
    expect(cache.size).toBe(2);
    cache.get('a');
    cache.get('b'); // rebuilt
    expect(made).toEqual(['a', 'b', 'c', 'b']);
  });
});

describe('resolveLocalPersona', () => {
  const base = { persona: 'main', model: 'qwen2.5:14b' };

  it('uses the server persona when there is no override', () => {
    expect(resolveLocalPersona(undefined, base, undefined)).toEqual({ ok: true, persona: 'main', model: 'qwen2.5:14b' });
    expect(resolveLocalPersona(undefined, base, new LocalPersonaCache((m, think) => ({ persona: m, think })))).toEqual({
      ok: true,
      persona: 'main',
      model: 'qwen2.5:14b',
    });
  });

  it('uses the cached override persona and echoes the override model', () => {
    const cache = new LocalPersonaCache((m, think) => ({ persona: `persona:${m}`, think }));
    expect(resolveLocalPersona('qwen3:14b', base, cache)).toEqual({ ok: true, persona: 'persona:qwen3:14b', model: 'qwen3:14b' });
  });

  it('refuses an override when the local brain is not Ollama', () => {
    expect(resolveLocalPersona('qwen3:14b', base, undefined)).toMatchObject({ ok: false, status: 422 });
  });
});

describe('localThink (the think override)', () => {
  const evalLocal = { eval: true, localOnly: true, localModel: 'qwen3.8:27b' };

  it('is accepted with a valid localModel and echoed back', () => {
    expect(parseLocalModelRequest({ ...evalLocal, localThink: false })).toEqual({ ok: true, model: 'qwen3.8:27b', think: false });
    expect(parseLocalModelRequest({ ...evalLocal, localThink: true })).toEqual({ ok: true, model: 'qwen3.8:27b', think: true });
  });

  it('is undefined when not sent (or null), so no think field reaches Ollama', () => {
    const r = parseLocalModelRequest(evalLocal);
    expect(r).toMatchObject({ ok: true, model: 'qwen3.8:27b' });
    expect(r.ok && r.think).toBeUndefined();
    const n = parseLocalModelRequest({ ...evalLocal, localThink: null });
    expect(n).toMatchObject({ ok: true, model: 'qwen3.8:27b' });
    expect(n.ok && n.think).toBeUndefined();
    expect(parseLocalModelRequest({ prompt: 'hi' })).toMatchObject({ ok: true, model: undefined, think: undefined });
  });

  it('is refused without a localModel, even on an eval + localOnly request', () => {
    for (const body of [
      { localThink: false },
      { eval: true, localOnly: true, localThink: true },
      { eval: true, localOnly: true, localModel: null, localThink: false },
    ]) {
      const r = parseLocalModelRequest(body);
      expect(r, JSON.stringify(body)).toMatchObject({ ok: false, status: 400 });
      if (!r.ok) expect(r.error).toMatch(/only accepted with localModel/);
    }
  });

  it('is refused with an invalid localModel', () => {
    expect(parseLocalModelRequest({ ...evalLocal, localModel: 'bad name', localThink: false })).toMatchObject({ ok: false, status: 400 });
  });

  it('must be a real boolean', () => {
    for (const bad of ['false', 'true', 0, 1, 'off', {}]) {
      const r = parseLocalModelRequest({ ...evalLocal, localThink: bad });
      expect(r, JSON.stringify(bad)).toMatchObject({ ok: false, status: 400 });
      if (!r.ok) expect(r.error).toMatch(/must be a boolean/);
    }
  });

  it('still needs eval + localOnly, like localModel', () => {
    expect(parseLocalModelRequest({ localOnly: true, localModel: 'qwen3.8:27b', localThink: false })).toMatchObject({ ok: false, status: 400 });
    expect(parseLocalModelRequest({ eval: true, localModel: 'qwen3.8:27b', localThink: false })).toMatchObject({ ok: false, status: 400 });
  });
});

describe('OLLAMA_THINK (the live local brain)', () => {
  it('reads "true" and "false", ignoring case and surrounding space', () => {
    expect(parseOllamaThink('true')).toBe(true);
    expect(parseOllamaThink('false')).toBe(false);
    expect(parseOllamaThink(' FALSE ')).toBe(false);
    expect(parseOllamaThink('True')).toBe(true);
  });

  it('treats unset or anything else as unset: no think field, unchanged behaviour', () => {
    for (const v of [undefined, '', '  ', '1', '0', 'yes', 'no', 'on', 'off', 'truthy']) {
      expect(parseOllamaThink(v), JSON.stringify(v)).toBeUndefined();
      expect(thinkOption(parseOllamaThink(v))).not.toHaveProperty('think');
    }
    expect(thinkOption(false)).toEqual({ think: false });
    expect(thinkOption(true)).toEqual({ think: true });
  });
});

describe('evalOllamaOptions (the override personas’ provider)', () => {
  it('keeps the 16K eval context and the Ollama host', () => {
    expect(evalOllamaOptions({}, undefined)).toEqual({ baseURL: 'http://127.0.0.1:11434', defaultOptions: { num_ctx: 16384 } });
    expect(evalOllamaOptions({ OLLAMA_HOST: 'http://studio:11434', FLINT_EVAL_NUM_CTX: '32768' }, false)).toEqual({
      baseURL: 'http://studio:11434',
      defaultOptions: { num_ctx: 32768 },
      think: false,
    });
  });

  it('carries think only when the request set it', () => {
    expect(evalOllamaOptions({}, undefined)).not.toHaveProperty('think');
    expect(evalOllamaOptions({}, true).think).toBe(true);
  });

  it('builds a provider whose /api/chat bodies carry that think and the eval context', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetch = (async (_u: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body) as Record<string, unknown>);
      return new Response(JSON.stringify({ message: { role: 'assistant', content: 'ok' }, done: true, done_reason: 'stop' }));
    }) as unknown as typeof globalThis.fetch;
    const msg = { id: 'u', role: 'user' as const, content: 'hi', timestamp: 0 };
    for (const think of [false, true, undefined]) {
      await new OllamaProvider({ ...evalOllamaOptions({}, think), fetch }).generate({ model: 'qwen3.8:27b', messages: [msg] });
    }
    expect(bodies.map((b) => b.think)).toEqual([false, true, undefined]);
    expect(bodies[2]).not.toHaveProperty('think');
    for (const b of bodies) expect(b.options).toEqual({ num_ctx: 16384 });
  });
});

describe('override personas per (model, think)', () => {
  it('keys a bare model by its name and the think variants apart', () => {
    expect(overrideKey('qwen3.8:27b', undefined)).toBe('qwen3.8:27b');
    expect(overrideKey('qwen3.8:27b', true)).toBe('qwen3.8:27b~think');
    expect(overrideKey('qwen3.8:27b', false)).toBe('qwen3.8:27b~nothink');
  });

  it('keys the style variant apart too, and leaves the key alone without one', () => {
    expect(overrideKey('qwen3.8:27b', undefined, 'v1')).toBe('qwen3.8:27b#v1');
    expect(overrideKey('qwen3.8:27b', false, 'local-v1')).toBe('qwen3.8:27b~nothink#local-v1');
    expect(overrideKey('qwen3.8:27b', true, undefined)).toBe('qwen3.8:27b~think');
  });

  it('builds one persona per (model, think) and reuses it', () => {
    const made: Array<[string, boolean | undefined]> = [];
    const cache = new LocalPersonaCache((m, think) => {
      made.push([m, think]);
      return { m, think };
    });
    const plain = cache.get('qwen3.8:27b');
    const off = cache.get('qwen3.8:27b', false);
    const on = cache.get('qwen3.8:27b', true);
    expect(new Set([plain, off, on]).size).toBe(3);
    expect(cache.get('qwen3.8:27b', false)).toBe(off);
    expect(cache.get('qwen3.8:27b', undefined)).toBe(plain);
    expect(off).toEqual({ m: 'qwen3.8:27b', think: false });
    expect(made).toEqual([
      ['qwen3.8:27b', undefined],
      ['qwen3.8:27b', false],
      ['qwen3.8:27b', true],
    ]);
    expect(cache.size).toBe(3);
  });

  it('resolveLocalPersona hands think to the cache and still echoes the plain model', () => {
    const base = { persona: 'main', model: 'qwen2.5:7b' };
    const cache = new LocalPersonaCache((m, think) => ({ persona: `persona:${m}:${String(think)}`, think }));
    expect(resolveLocalPersona('muse-glimmer:30b', base, cache, false)).toEqual({
      ok: true,
      persona: 'persona:muse-glimmer:30b:false',
      model: 'muse-glimmer:30b',
      think: false,
    });
    const plain = resolveLocalPersona('muse-glimmer:30b', base, cache);
    expect(plain).toEqual({ ok: true, persona: 'persona:muse-glimmer:30b:undefined', model: 'muse-glimmer:30b' });
    expect(plain).not.toHaveProperty('think');
    // No override: the server's own persona, whatever think says, and no think echo.
    const own = resolveLocalPersona(undefined, base, cache, false);
    expect(own).toEqual({ ok: true, persona: 'main', model: 'qwen2.5:7b' });
    expect(own).not.toHaveProperty('think');
  });

  it("echoes the think the persona was built with, not the request's", () => {
    // A persona whose client dropped the flag must not be reported as honouring it:
    // no echo, so apps/parity's localThink check stops the run.
    const base = { persona: 'main', model: 'qwen2.5:7b' };
    const dropsIt = new LocalPersonaCache((m) => ({ persona: `persona:${m}`, think: undefined }));
    const r = resolveLocalPersona('qwen3.8:27b', base, dropsIt, false);
    expect(r).toMatchObject({ ok: true, persona: 'persona:qwen3.8:27b' });
    expect(r).not.toHaveProperty('think');
  });
});

/** An Ollama that records every /api/chat body and answers "ok". */
function captureOllama(): { fetch: typeof globalThis.fetch; bodies: Array<Record<string, unknown>> } {
  const bodies: Array<Record<string, unknown>> = [];
  const fetch = (async (_u: string, init: { body: string }) => {
    bodies.push(JSON.parse(init.body) as Record<string, unknown>);
    return new Response(JSON.stringify({ message: { role: 'assistant', content: 'ok' }, done: true, done_reason: 'stop' }));
  }) as unknown as typeof globalThis.fetch;
  return { fetch, bodies };
}
const hi = { id: 'u', role: 'user' as const, content: 'hi', timestamp: 0 };

describe('overridePersonaCache (what main() builds for bake-offs)', () => {
  it("sends the request's think to Ollama, with the eval context, and echoes it", async () => {
    const { fetch, bodies } = captureOllama();
    // main() wraps the provider in a Persona; the provider is all that matters here.
    const cache = overridePersonaCache({}, (provider, model) => ({ provider, model }), { fetch });
    const base = { persona: undefined as never, model: 'qwen2.5:7b' };
    const echoes: Array<boolean | undefined> = [];
    for (const think of [false, true, undefined]) {
      const local = resolveLocalPersona('qwen3.8:27b', base, cache, think);
      if (!local.ok) throw new Error(local.error);
      echoes.push(local.think);
      expect(local.persona.model).toBe('qwen3.8:27b');
      await local.persona.provider.generate({ model: local.persona.model, messages: [hi] });
    }
    expect(bodies.map((b) => b.think)).toEqual([false, true, undefined]);
    expect(bodies[2]).not.toHaveProperty('think');
    for (const b of bodies) expect(b.options).toEqual({ num_ctx: 16384 });
    expect(echoes).toEqual([false, true, undefined]);
  });

  it('builds one client per (model, think), reused, and honours OLLAMA_HOST', async () => {
    const urls: string[] = [];
    const fetch = (async (u: string) => {
      urls.push(u);
      return new Response(JSON.stringify({ message: { role: 'assistant', content: 'ok' }, done: true }));
    }) as unknown as typeof globalThis.fetch;
    let built = 0;
    const cache = overridePersonaCache({ OLLAMA_HOST: 'http://studio:11434' }, (provider) => (built++, provider), { fetch });
    expect(cache.get('qwen3.8:27b', false)).toBe(cache.get('qwen3.8:27b', false));
    expect(cache.get('qwen3.8:27b', false)).not.toBe(cache.get('qwen3.8:27b'));
    expect(built).toBe(2);
    await cache.get('qwen3.8:27b', false).persona.generate({ model: 'qwen3.8:27b', messages: [hi] });
    expect(urls).toEqual(['http://studio:11434/api/chat']);
  });

  it('builds the persona with the style variant the turn resolved, one per variant', () => {
    const variants: Array<string | undefined> = [];
    const cache = overridePersonaCache({}, (_provider, model, variant) => (variants.push(variant), `${model}:${String(variant)}`));
    const base = { persona: 'main', model: 'qwen2.5:7b' };
    const v1 = resolveLocalPersona('muse-glimmer:30b', base, cache, false, 'v1');
    const lv1 = resolveLocalPersona('muse-glimmer:30b', base, cache, false, 'local-v1');
    expect(v1).toEqual({ ok: true, persona: 'muse-glimmer:30b:v1', model: 'muse-glimmer:30b', think: false });
    expect(lv1).toEqual({ ok: true, persona: 'muse-glimmer:30b:local-v1', model: 'muse-glimmer:30b', think: false });
    expect(resolveLocalPersona('muse-glimmer:30b', base, cache, false, 'local-v1')).toEqual(lv1);
    expect(variants).toEqual(['v1', 'local-v1']);
    // No override: the base persona (already in the turn's variant), untouched.
    expect(resolveLocalPersona(undefined, base, cache, false, 'local-v1')).toEqual({ ok: true, persona: 'main', model: 'qwen2.5:7b' });
  });
});

describe('liveOllamaOptions (the live local brain)', () => {
  it('sends OLLAMA_THINK to Ollama, keeps num_ctx 4096 by default, and sends no think when unset', async () => {
    const { fetch, bodies } = captureOllama();
    for (const env of [{ OLLAMA_THINK: 'false' }, { OLLAMA_THINK: ' TRUE ' }, {}, { OLLAMA_THINK: 'off' }]) {
      await new OllamaProvider({ ...liveOllamaOptions(env), fetch }).generate({ model: 'qwen3.8:27b', messages: [hi] });
    }
    expect(bodies.map((b) => b.think)).toEqual([false, true, undefined, undefined]);
    expect(bodies[2]).not.toHaveProperty('think');
    expect(bodies[3]).not.toHaveProperty('think');
    for (const b of bodies) expect(b.options).toEqual({ num_ctx: 4096 });
  });

  it('takes OLLAMA_HOST and OLLAMA_NUM_CTX', () => {
    expect(liveOllamaOptions({})).toEqual({ baseURL: 'http://127.0.0.1:11434', defaultOptions: { num_ctx: 4096 } });
    expect(liveOllamaOptions({ OLLAMA_HOST: 'http://gpu:11434', OLLAMA_NUM_CTX: '8192', OLLAMA_THINK: 'false' })).toEqual({
      baseURL: 'http://gpu:11434',
      defaultOptions: { num_ctx: 8192 },
      think: false,
    });
  });
});

describe('chooseLocalBrain (the local brain is always an Ollama model)', () => {
  type Lists = { ps?: Array<string | { name: string; context_length: number }>; tags?: string[] } | 'down';
  /** Ollama's two list endpoints; `script` gives each round of asking its answer (the last one repeats). Records what was asked. */
  function ollama(...script: Lists[]) {
    const asked: string[] = [];
    let round = 0;
    const impl = (async (url: string) => {
      asked.push(url);
      const ps = url.endsWith('/api/ps');
      if (ps) round++;
      const lists = script[Math.min(round, script.length) - 1]!;
      if (lists === 'down') throw new TypeError('fetch failed');
      const rows = ((ps ? lists.ps : lists.tags) ?? []).map((m) => (typeof m === 'string' ? { name: m } : m));
      return new Response(JSON.stringify({ models: rows.map((m) => ({ ...m, details: { family: m.name.includes('embed') ? 'nomic-bert' : 'qwen' } })) }), { status: 200 });
    }) as unknown as typeof fetch;
    return { impl, asked };
  }
  const noWait = { wait: async () => {} };

  it('OLLAMA_MODEL names it: Ollama is not even asked', async () => {
    const o = ollama({ tags: ['gemma4:26b'] });
    const logs: string[] = [];
    const b = await chooseLocalBrain({ OLLAMA_MODEL: ' muse-glimmer:30b ', OLLAMA_HOST: 'http://gpu:11434', OLLAMA_THINK: 'false' }, { fetch: o.impl, log: (m) => logs.push(m) });
    expect(b).toEqual({
      model: 'muse-glimmer:30b',
      from: 'env',
      options: { baseURL: 'http://gpu:11434', defaultOptions: { num_ctx: 4096 }, think: false },
      env: { OLLAMA_MODEL: 'muse-glimmer:30b' },
    });
    expect(o.asked).toEqual([]);
    expect(logs).toEqual([]);
  });

  // The old default: OLLAMA_MODEL unset + ANTHROPIC_API_KEY set made the "local" brain claude-sonnet-4-6.
  it('unset, with an Anthropic key present: still Ollama, the chat model it has loaded', async () => {
    const o = ollama({ ps: ['nomic-embed-text:latest', 'muse-glimmer:30b'], tags: ['gemma4:26b', 'muse-glimmer:30b'] });
    const logs: string[] = [];
    const b = await chooseLocalBrain({ ANTHROPIC_API_KEY: 'sk-ant-test', OPENAI_API_KEY: 'sk-test' }, { fetch: o.impl, log: (m) => logs.push(m) });
    expect(b).toMatchObject({ model: 'muse-glimmer:30b', from: 'loaded', options: { baseURL: 'http://127.0.0.1:11434' } });
    expect(logs).toEqual(['[brain] OLLAMA_MODEL is unset: the local brain is muse-glimmer:30b, which Ollama has loaded (set OLLAMA_MODEL to choose another)']);
    // Only Ollama's own list endpoint was asked: no vendor, no generation.
    expect(o.asked).toEqual(['http://127.0.0.1:11434/api/ps']);
  });

  it('a loaded model keeps the context size it is loaded with, and the rest of the server is told', async () => {
    const o = ollama({ ps: [{ name: 'muse-glimmer:30b', context_length: 16384 }] });
    const b = await chooseLocalBrain({}, { fetch: o.impl });
    // The chat brain's own client...
    expect(b.options.defaultOptions).toEqual({ num_ctx: 16384 });
    // ...and what memory extraction and background calls read, so Ollama never reloads the model between them.
    expect(b.env).toEqual({ OLLAMA_MODEL: 'muse-glimmer:30b', OLLAMA_NUM_CTX: '16384' });
    expect(liveOllamaOptions({ ...b.env }).defaultOptions).toEqual({ num_ctx: 16384 });
  });

  it('OLLAMA_NUM_CTX, when Will set it, wins over the loaded size', async () => {
    const o = ollama({ ps: [{ name: 'muse-glimmer:30b', context_length: 16384 }] });
    const b = await chooseLocalBrain({ OLLAMA_NUM_CTX: '8192' }, { fetch: o.impl });
    expect(b.options.defaultOptions).toEqual({ num_ctx: 8192 });
    expect(b.env).toEqual({ OLLAMA_MODEL: 'muse-glimmer:30b' });
  });

  it('unset, nothing loaded: the first chat model pulled, asked of OLLAMA_HOST', async () => {
    const o = ollama({ ps: [], tags: ['nomic-embed-text:latest', 'qwen3.8:27b', 'qwen2.5:7b'] });
    const logs: string[] = [];
    const b = await chooseLocalBrain({ OLLAMA_HOST: 'http://gpu:11434' }, { fetch: o.impl, log: (m) => logs.push(m) });
    expect(b).toMatchObject({ model: 'qwen3.8:27b', from: 'pulled', env: { OLLAMA_MODEL: 'qwen3.8:27b' } });
    expect(b.options.defaultOptions).toEqual({ num_ctx: 4096 });
    expect(o.asked).toEqual(['http://gpu:11434/api/ps', 'http://gpu:11434/api/tags']);
    expect(logs[0]).toMatch(/the local brain is qwen3\.8:27b, which Ollama has pulled/);
  });

  // Both start at login: Ollama may be a few seconds behind the server.
  it('an Ollama that is not up yet is asked again, and its answer is used', async () => {
    const o = ollama('down', 'down', { ps: [{ name: 'muse-glimmer:30b', context_length: 16384 }] });
    const logs: string[] = [];
    const waits: number[] = [];
    const b = await chooseLocalBrain({}, { fetch: o.impl, log: (m) => logs.push(m), wait: async (ms) => void waits.push(ms) });
    expect(b).toMatchObject({ model: 'muse-glimmer:30b', from: 'loaded' });
    expect(waits).toEqual([LOCAL_PICK_RETRY_MS, LOCAL_PICK_RETRY_MS]);
    expect(logs).toEqual([
      '[brain] OLLAMA_MODEL is unset and Ollama is not answering yet: asking again for up to a minute',
      '[brain] OLLAMA_MODEL is unset: the local brain is muse-glimmer:30b, which Ollama has loaded (set OLLAMA_MODEL to choose another)',
    ]);
  });

  it('it gives up after about a minute, and settles for the default until the next restart', async () => {
    const o = ollama('down');
    const logs: string[] = [];
    const waits: number[] = [];
    const b = await chooseLocalBrain({ ANTHROPIC_API_KEY: 'sk-ant-test' }, { fetch: o.impl, log: (m) => logs.push(m), wait: async (ms) => void waits.push(ms) });
    expect(b).toMatchObject({ model: DEFAULT_OLLAMA_MODEL, from: 'default', env: { OLLAMA_MODEL: DEFAULT_OLLAMA_MODEL } });
    expect(b.model).not.toMatch(/claude|gpt|sonar/);
    expect(waits).toHaveLength(LOCAL_PICK_RETRIES);
    expect(waits.reduce((a, n) => a + n, 0)).toBe(60_000);
    expect(logs.at(-1)).toBe(
      `[brain] OLLAMA_MODEL is unset and Ollama did not answer: the local brain is ${DEFAULT_OLLAMA_MODEL} until the next restart (run "ollama pull ${DEFAULT_OLLAMA_MODEL}", or set OLLAMA_MODEL)`,
    );
  });

  it('an Ollama that answers with no chat model is not asked again: the default, at once', async () => {
    const o = ollama({ ps: [], tags: ['nomic-embed-text:latest'] });
    const logs: string[] = [];
    const waits: number[] = [];
    const b = await chooseLocalBrain({}, { fetch: o.impl, log: (m) => logs.push(m), wait: async (ms) => void waits.push(ms) });
    expect(b).toMatchObject({ model: DEFAULT_OLLAMA_MODEL, from: 'default' });
    expect(waits).toEqual([]);
    expect(logs).toEqual([
      `[brain] OLLAMA_MODEL is unset and Ollama listed no chat model: the local brain is ${DEFAULT_OLLAMA_MODEL} until the next restart (run "ollama pull ${DEFAULT_OLLAMA_MODEL}", or set OLLAMA_MODEL)`,
    ]);
  });

  // An Ollama cloud model runs on Ollama's servers: naming one would make the "local" brain an outside AI again.
  it('refuses an Ollama cloud model named in OLLAMA_MODEL, and uses what Ollama has on this machine', async () => {
    for (const named of ['gpt-oss:120b-cloud', 'glm-4.6:cloud', 'qwen3-coder-cloud']) {
      const o = ollama({ ps: ['muse-glimmer:30b'] });
      const logs: string[] = [];
      const b = await chooseLocalBrain({ OLLAMA_MODEL: named }, { fetch: o.impl, log: (m) => logs.push(m), ...noWait });
      expect(b, named).toMatchObject({ model: 'muse-glimmer:30b', from: 'loaded' });
      expect(logs[0]).toBe("[brain] OLLAMA_MODEL is an Ollama cloud model, which runs on Ollama's servers: it is not used as the local brain");
    }
  });

  it('FLINT_MODEL, which used to name the Anthropic "local" model, is no longer read, and says so', async () => {
    const logs: string[] = [];
    const b = await chooseLocalBrain({ FLINT_MODEL: 'claude-opus-5-5', ANTHROPIC_API_KEY: 'sk-ant-test', OLLAMA_MODEL: 'qwen2.5:7b' }, { log: (m) => logs.push(m) });
    expect(b.model).toBe('qwen2.5:7b');
    expect(logs).toEqual(['[brain] FLINT_MODEL is no longer read: the local brain is always an Ollama model (OLLAMA_MODEL)']);
  });

  it('what it returns builds an OllamaProvider, whatever the environment holds', async () => {
    const b = await chooseLocalBrain({ ANTHROPIC_API_KEY: 'sk-ant-test' }, { fetch: ollama('down').impl, ...noWait });
    expect(new OllamaProvider(b.options).name).toBe('ollama');
  });

  it('localDefaultNote: one plain sentence for the console when the model is a guess', () => {
    expect(localDefaultNote('qwen2.5:7b')).toEqual({
      title: 'Flint Is Guessing Its Local Model',
      body: 'No local model is set, and Ollama listed none, so Flint is trying qwen2.5:7b. Set OLLAMA_MODEL to choose one, then restart Flint.',
    });
  });
});
