/**
 * Does a brain's prompt stay on this Mac? (./policy brainIsLocal, the one place
 * that is decided.) Local is a local wire, a model that runs here, and a server
 * at a loopback address: all three. Anything unknown is not local.
 */
import { describe, it, expect } from 'vitest';
import { AnthropicProvider, OllamaProvider, OpenAiProvider, PerplexityProvider } from '@flint/core';
import { LOCAL_WIRES, brainIsLocal, brainOf, onThisMachine } from '../src/policy';
import { liveOllamaOptions } from '../src/local-model';
import { buildTiers, envProviderFactory } from '../src/brains';

const here = 'http://127.0.0.1:11434';

describe('brainIsLocal', () => {
  it('an Ollama model on this Mac is local, at any loopback address', () => {
    for (const baseURL of [here, 'http://localhost:11434', 'http://[::1]:11434', 'http://LOCALHOST:11434', 'https://127.0.0.1:8443', 'http://127.0.0.1:11434/']) {
      expect(brainIsLocal({ provider: 'ollama', model: 'qwen2.5:14b', baseURL }), baseURL).toBe(true);
    }
  });

  it('no outside provider is local, whatever its model or address says', () => {
    for (const provider of ['anthropic', 'openai', 'perplexity', 'tavily', 'Ollama', 'ollama ', 'local', '']) {
      expect(brainIsLocal({ provider, model: 'qwen2.5:14b', baseURL: here }), provider).toBe(false);
    }
    expect([...LOCAL_WIRES]).toEqual(['ollama']);
  });

  it('an Ollama cloud model is not local: Ollama serves it from its own machines', () => {
    for (const model of ['gpt-oss:120b-cloud', 'glm-4.6:cloud', 'qwen3-coder:480b-cloud', 'deepseek-v3.1-cloud', 'GPT-OSS:120B-CLOUD']) {
      expect(brainIsLocal({ provider: 'ollama', model, baseURL: here }), model).toBe(false);
    }
    // A model whose name only contains the word is a local model.
    expect(brainIsLocal({ provider: 'ollama', model: 'cloudy-7b:latest', baseURL: here })).toBe(true);
    expect(brainIsLocal({ provider: 'ollama', model: '', baseURL: here })).toBe(false);
  });

  it('an Ollama server on another machine is not local, and neither is an address it cannot read', () => {
    for (const baseURL of [
      'http://10.0.0.12:11434', 'http://studio:11434', 'http://studio.tailnet.ts.net:11434', 'https://gpu.example.com', 'http://100.101.102.103:11434',
      'http://127.0.0.1.example.com:11434', 'http://localhost.example.com:11434', 'http://0.0.0.0:11434', 'http://127.0.0.2:11434',
      'http://user@127.0.0.1.evil.example:11434', 'ftp://127.0.0.1/', 'not a url', '127.0.0.1:11434', '',
    ]) {
      expect(brainIsLocal({ provider: 'ollama', model: 'qwen2.5:14b', baseURL }), baseURL).toBe(false);
      expect(onThisMachine(baseURL), baseURL).toBe(false);
    }
    // No address at all (a provider that does not say where it sends): not local.
    expect(brainIsLocal({ provider: 'ollama', model: 'qwen2.5:14b' })).toBe(false);
    expect(brainIsLocal(undefined)).toBe(false);
  });

  it('a remote Ollama server counts only when the caller says it is Will’s own, and never a cloud model or another provider', () => {
    expect(brainIsLocal({ provider: 'ollama', model: 'qwen2.5:72b', baseURL: 'http://studio:11434' }, { allowRemote: true })).toBe(true);
    expect(brainIsLocal({ provider: 'ollama', model: 'gpt-oss:120b-cloud', baseURL: 'http://studio:11434' }, { allowRemote: true })).toBe(false);
    expect(brainIsLocal({ provider: 'anthropic', model: 'claude-opus-5-5', baseURL: here }, { allowRemote: true })).toBe(false);
  });
});

describe('brainOf: a provider adapter as the rule sees it', () => {
  it('reads an Ollama client’s own name and address', () => {
    expect(brainOf(new OllamaProvider({ baseURL: 'http://127.0.0.1:11434/' }), 'qwen2.5:14b')).toEqual({ provider: 'ollama', model: 'qwen2.5:14b', baseURL: 'http://127.0.0.1:11434' });
    expect(brainIsLocal(brainOf(new OllamaProvider({ baseURL: 'http://gpu.example.com:11434' }), 'qwen2.5:14b'))).toBe(false);
    // Ollama's own default is this machine.
    expect(brainIsLocal(brainOf(new OllamaProvider(), 'qwen2.5:14b'))).toBe(true);
  });

  it('the local brain as main() builds it is local at the default address, and not when OLLAMA_HOST points elsewhere', () => {
    expect(brainIsLocal(brainOf(new OllamaProvider(liveOllamaOptions({})), 'qwen2.5:14b'))).toBe(true);
    expect(brainIsLocal(brainOf(new OllamaProvider(liveOllamaOptions({ OLLAMA_HOST: 'http://rented-gpu.example.com:11434' })), 'qwen2.5:14b'))).toBe(false);
  });

  it('no outside provider’s client is local, key or no key', () => {
    for (const p of [new AnthropicProvider({ apiKey: 'test-key-not-real' }), new OpenAiProvider({ apiKey: 'test-key-not-real' }), new PerplexityProvider({ apiKey: 'test-key-not-real' })]) {
      expect(brainIsLocal(brainOf(p, 'any-model')), p.name).toBe(false);
    }
  });

  it('an `ollama:` tier is local at this Mac’s address, and not when the tier host is another machine', () => {
    const tiers = (env: Record<string, string>) => buildTiers({ env, factory: envProviderFactory(env), legacy: undefined, makePersona: (p, m) => `${p.name}:${m}` })!;
    const local = tiers({ FLINT_TIER_STANDARD: 'ollama:qwen2.5:72b' }).primary;
    expect(brainIsLocal(brainOf(local.provider, local.model))).toBe(true);
    const remote = tiers({ FLINT_TIER_STANDARD: 'ollama:qwen2.5:72b', FLINT_TIER_OLLAMA_HOST: 'http://homebox:11434' }).primary;
    expect(brainIsLocal(brainOf(remote.provider, remote.model))).toBe(false);
    const cloud = tiers({ FLINT_TIER_STANDARD: 'ollama:gpt-oss:120b-cloud' }).primary;
    expect(brainIsLocal(brainOf(cloud.provider, cloud.model))).toBe(false);
  });
});
