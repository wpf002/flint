/**
 * The playground demos' provider choice (apps/playground/src/provider.ts; the
 * playground has no test runner of its own, so it is run from here). The same
 * rule as the server and `ask`: a local Ollama model, and never Anthropic
 * because a key happens to be in the environment. Anthropic is still there for
 * the comparison run, asked for by name. A stub fetch plays Ollama's list
 * endpoints; nothing is generated.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { NO_LIVE_MODEL, pickProvider } from '../../playground/src/provider';

const SRC = join(__dirname, '..', '..', 'playground', 'src');

function ollama(lists: { ps?: Array<{ name: string; context_length?: number }>; tags?: string[] } | 'down') {
  const asked: string[] = [];
  const impl = (async (url: string) => {
    asked.push(url);
    if (lists === 'down') throw new TypeError('fetch failed');
    const rows = url.endsWith('/api/ps') ? (lists.ps ?? []) : (lists.tags ?? []).map((name) => ({ name }));
    return new Response(JSON.stringify({ models: rows }), { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, asked };
}
const quiet = { log: () => {} };

describe('playground pickProvider', () => {
  // The old rule: OLLAMA_MODEL unset + ANTHROPIC_API_KEY set = claude-sonnet-4-6.
  it('a key in the environment is not a request: with Ollama running, the local model answers', async () => {
    const o = ollama({ ps: [{ name: 'muse-glimmer:30b', context_length: 16384 }] });
    const p = await pickProvider({ ANTHROPIC_API_KEY: 'sk-ant-test', OPENAI_API_KEY: 'sk-test' }, { fetch: o.impl, ...quiet });
    expect(p?.provider.name).toBe('ollama');
    expect(p?.model).toBe('muse-glimmer:30b');
    expect(o.asked).toEqual(['http://127.0.0.1:11434/api/ps']);
  });

  it('a key in the environment and no Ollama: no live model, not Anthropic', async () => {
    for (const lists of ['down', { ps: [], tags: ['nomic-embed-text:latest'] }] as const) {
      expect(await pickProvider({ ANTHROPIC_API_KEY: 'sk-ant-test' }, { fetch: ollama(lists).impl, ...quiet })).toBeUndefined();
    }
    expect(NO_LIVE_MODEL).toContain('PLAYGROUND_PROVIDER=anthropic');
  });

  it('OLLAMA_MODEL names the local model; Ollama is not asked', async () => {
    const o = ollama('down');
    const p = await pickProvider({ OLLAMA_MODEL: 'qwen2.5:7b', ANTHROPIC_API_KEY: 'sk-ant-test' }, { fetch: o.impl, ...quiet });
    expect(p).toMatchObject({ model: 'qwen2.5:7b', provider: { name: 'ollama' } });
    expect(o.asked).toEqual([]);
  });

  it('an Ollama cloud model is not a local one: refused, and what Ollama has here is used', async () => {
    const logs: string[] = [];
    const p = await pickProvider({ OLLAMA_MODEL: 'gpt-oss:120b-cloud' }, { fetch: ollama({ ps: [], tags: ['qwen3.8:27b'] }).impl, log: (m) => logs.push(m) });
    expect(p).toMatchObject({ model: 'qwen3.8:27b', provider: { name: 'ollama' } });
    expect(logs[0]).toMatch(/Ollama cloud model/);
  });

  it('Anthropic only when asked for by name, and only with a key', async () => {
    const o = ollama({ ps: [{ name: 'muse-glimmer:30b' }] });
    const p = await pickProvider({ PLAYGROUND_PROVIDER: ' Anthropic ', ANTHROPIC_API_KEY: 'sk-ant-test', OLLAMA_MODEL: 'qwen2.5:7b' }, { fetch: o.impl, ...quiet });
    expect(p).toMatchObject({ model: 'claude-sonnet-4-6', provider: { name: 'anthropic' } });
    expect(o.asked).toEqual([]);
    const logs: string[] = [];
    expect(await pickProvider({ PLAYGROUND_PROVIDER: 'anthropic' }, { fetch: o.impl, log: (m) => logs.push(m) })).toBeUndefined();
    expect(logs).toEqual(['PLAYGROUND_PROVIDER=anthropic needs ANTHROPIC_API_KEY.']);
    // Any other value of the switch asks for nothing.
    expect((await pickProvider({ PLAYGROUND_PROVIDER: 'yes', ANTHROPIC_API_KEY: 'sk-ant-test' }, { fetch: o.impl, ...quiet }))?.provider.name).toBe('ollama');
  });
});

describe('the playground demos', () => {
  const demos = readdirSync(SRC).filter((f) => f.endsWith('.ts') && f !== 'provider.ts' && f !== 'mock-provider.ts');

  it('all choose their model through pickProvider, and none builds an Anthropic client itself', () => {
    expect(demos.sort()).toEqual(['eval.ts', 'index.ts', 'reflect-demo.ts', 'tool-check.ts', 'voice-check.ts']);
    for (const f of demos) {
      const src = readFileSync(join(SRC, f), 'utf8');
      expect(src, f).toContain("from './provider.js'");
      expect(src, f).toMatch(/await pickProvider\(\)/);
      expect(src, f).not.toMatch(/AnthropicProvider|ANTHROPIC_API_KEY\?\.|claude-sonnet/);
    }
  });
});
