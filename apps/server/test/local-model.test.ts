import { describe, expect, it } from 'vitest';
import { LOCAL_MODEL_MAX_LEN, LocalPersonaCache, parseLocalModelRequest, resolveLocalPersona } from '../src/local-model';

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
    expect(resolveLocalPersona(undefined, base, new LocalPersonaCache((m) => m))).toEqual({ ok: true, persona: 'main', model: 'qwen2.5:14b' });
  });

  it('uses the cached override persona and echoes the override model', () => {
    const cache = new LocalPersonaCache((m) => `persona:${m}`);
    expect(resolveLocalPersona('qwen3:14b', base, cache)).toEqual({ ok: true, persona: 'persona:qwen3:14b', model: 'qwen3:14b' });
  });

  it('refuses an override when the local brain is not Ollama', () => {
    expect(resolveLocalPersona('qwen3:14b', base, undefined)).toMatchObject({ ok: false, status: 422 });
  });
});
