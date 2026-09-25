import { describe, expect, it } from 'vitest';
import { OllamaProvider } from '@flint/core';
import {
  LOCAL_MODEL_MAX_LEN,
  LocalPersonaCache,
  evalOllamaOptions,
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
