/**
 * Does a brain's prompt stay on this Mac? (./policy brainIsLocal, the one place
 * that is decided.) Local is a local wire, a model that is not named as a
 * cloud model, a server at a loopback address, and that server's own word that
 * the model runs on it: all four. Anything unknown is not local.
 */
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { AnthropicProvider, OllamaProvider, OpenAiProvider, PerplexityProvider } from '@flint/core';
import { LOCAL_WIRES, brainIsLocal, brainOf, isLocalWire, listedAt, onThisMachine, placeUnknown, placedHere, setPlaceRules } from '../src/policy';
import { liveOllamaOptions } from '../src/local-model';
import { buildTiers, envProviderFactory } from '../src/brains';
import { LOCALITY } from '../src/ollama-locality';
import { listed } from './goals-mini';

const here = 'http://127.0.0.1:11434';
const LOOPBACKS = [here, 'http://localhost:11434', 'http://[::1]:11434', 'http://LOCALHOST:11434', 'https://127.0.0.1:8443', 'http://127.0.0.1:11434/'];
const PULLED = ['qwen2.5:14b', 'qwen2.5:72b', 'cloudy-7b:latest'];

// The Ollama at each of this Mac's addresses lists these models as its own (./ollama-locality).
beforeEach(() => {
  for (const url of LOOPBACKS) listed(url, PULLED);
});
afterEach(() => {
  LOCALITY.clear();
  setPlaceRules({});
});

describe('brainIsLocal', () => {
  it('an Ollama model on this Mac is local, at any loopback address', () => {
    for (const baseURL of LOOPBACKS) {
      expect(brainIsLocal({ provider: 'ollama', model: 'qwen2.5:14b', baseURL }), baseURL).toBe(true);
    }
  });

  it('a name is not trusted: a cloud model copied under a plain name is not local, because its Ollama says where it runs', () => {
    // `ollama cp gpt-oss:120b-cloud mine`: the listing still gives it a remote host.
    listed(here, ['qwen2.5:14b', { name: 'mine:latest', remote_host: 'https://ollama.com:443', remote_model: 'gpt-oss:120b' }, { name: 'other', remote_model: 'glm-4.6' }]);
    expect(brainIsLocal({ provider: 'ollama', model: 'mine', baseURL: here })).toBe(false);
    expect(brainIsLocal({ provider: 'ollama', model: 'mine:latest', baseURL: here })).toBe(false);
    expect(brainIsLocal({ provider: 'ollama', model: 'other', baseURL: here })).toBe(false);
    expect(brainIsLocal({ provider: 'ollama', model: 'qwen2.5:14b', baseURL: here })).toBe(true);
    // The same name listed twice, once as remote: not local.
    listed(here, [{ name: 'twice:7b' }, { name: 'twice:7b', remote_host: 'https://ollama.com' }]);
    expect(brainIsLocal({ provider: 'ollama', model: 'twice:7b', baseURL: here })).toBe(false);
  });

  it('it fails closed: a model its Ollama does not list, and an Ollama nobody has heard from, are not local', () => {
    expect(brainIsLocal({ provider: 'ollama', model: 'never-pulled:7b', baseURL: here })).toBe(false);
    LOCALITY.clear();
    expect(brainIsLocal({ provider: 'ollama', model: 'qwen2.5:14b', baseURL: here })).toBe(false);
    // What one address lists says nothing of another.
    listed('http://localhost:11434', ['qwen2.5:14b']);
    expect(brainIsLocal({ provider: 'ollama', model: 'qwen2.5:14b', baseURL: here })).toBe(false);
    expect(brainIsLocal({ provider: 'ollama', model: 'qwen2.5:14b', baseURL: 'http://localhost:11434' })).toBe(true);
    // A caller's own listing is asked instead of the server's, and is asked for this brain.
    const asked: Array<[string | undefined, string]> = [];
    expect(brainIsLocal({ provider: 'ollama', model: 'qwen2.5:14b', baseURL: here }, { listed: (url, model) => (asked.push([url, model]), true) })).toBe(true);
    expect(asked).toEqual([[here, 'qwen2.5:14b']]);
    // ...and it is not asked at all about a brain the other rules already ruled out.
    expect(brainIsLocal({ provider: 'anthropic', model: 'claude-opus-5-5', baseURL: here }, { listed: () => true })).toBe(false);
    expect(brainIsLocal({ provider: 'ollama', model: 'gpt-oss:120b-cloud', baseURL: here }, { listed: () => true })).toBe(false);
    expect(brainIsLocal({ provider: 'ollama', model: 'qwen2.5:14b', baseURL: 'http://studio:11434' }, { listed: () => true })).toBe(false);
  });

  it('the address whose listing decides is the brain’s own, and only when it is an Ollama on this Mac', () => {
    expect(listedAt({ provider: 'ollama', model: 'qwen2.5:14b', baseURL: here })).toBe(here);
    expect(listedAt({ provider: 'ollama', model: 'qwen2.5:14b', baseURL: 'http://studio:11434' })).toBeUndefined();
    expect(listedAt({ provider: 'anthropic', model: 'claude-opus-5-5', baseURL: here })).toBeUndefined();
    expect(listedAt({ provider: 'ollama', model: 'qwen2.5:14b' })).toBeUndefined();
    expect(listedAt(undefined)).toBeUndefined();
  });

  it('no outside provider is local, whatever its model or address says', () => {
    for (const provider of ['anthropic', 'openai', 'perplexity', 'tavily', 'Ollama', 'ollama ', 'Local', 'openai-compatible', '']) {
      expect(brainIsLocal({ provider, model: 'qwen2.5:14b', baseURL: here }), provider).toBe(false);
    }
    // Two wires reach a model on this Mac: Ollama's own API, and the OpenAI-compatible local adapter (`local`).
    expect([...LOCAL_WIRES]).toEqual(['ollama', 'local']);
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
    // Not yet: that server has not said the model runs on it.
    expect(brainIsLocal({ provider: 'ollama', model: 'qwen2.5:72b', baseURL: 'http://studio:11434' }, { allowRemote: true })).toBe(false);
    listed('http://studio:11434', ['qwen2.5:72b']);
    expect(brainIsLocal({ provider: 'ollama', model: 'qwen2.5:72b', baseURL: 'http://studio:11434' }, { allowRemote: true })).toBe(true);
    expect(brainIsLocal({ provider: 'ollama', model: 'qwen2.5:72b', baseURL: 'http://studio:11434' })).toBe(false);
    expect(brainIsLocal({ provider: 'ollama', model: 'gpt-oss:120b-cloud', baseURL: 'http://studio:11434' }, { allowRemote: true })).toBe(false);
    expect(brainIsLocal({ provider: 'anthropic', model: 'claude-opus-5-5', baseURL: here }, { allowRemote: true })).toBe(false);
  });
});

describe('what the server’s own settings say about an address (setPlaceRules, told by ./inference at boot)', () => {
  const studio = 'https://studio.tailnet.ts.net:11434';

  it('with none set, here is this Mac and nowhere else', () => {
    expect(placedHere(here)).toBe(true);
    expect(placedHere(studio)).toBe(false);
    expect(placedHere(undefined)).toBe(false);
    expect(placedHere('not a url')).toBe(false);
  });

  it('the model server Will said is his own is held as this Mac is, on its Ollama’s word, and no other server is', () => {
    setPlaceRules({ own: (url) => new URL(url).origin === new URL(studio).origin });
    expect(placedHere(studio)).toBe(true);
    expect(placedHere('https://other.example.com:11434')).toBe(false);
    // The address is his, and the model is still local only once that Ollama has said it runs there.
    expect(brainIsLocal({ provider: 'ollama', model: 'qwen2.5:72b', baseURL: studio })).toBe(false);
    listed(studio, ['qwen2.5:72b', { name: 'mine', remote_host: 'https://ollama.com:443' }]);
    expect(brainIsLocal({ provider: 'ollama', model: 'qwen2.5:72b', baseURL: studio })).toBe(true);
    expect(brainIsLocal({ provider: 'ollama', model: 'mine', baseURL: studio })).toBe(false);
    expect(brainIsLocal({ provider: 'ollama', model: 'gpt-oss:120b-cloud', baseURL: studio })).toBe(false);
    expect(brainIsLocal({ provider: 'anthropic', model: 'claude-opus-5-5', baseURL: studio })).toBe(false);
    listed('https://other.example.com:11434', ['qwen2.5:72b']);
    expect(brainIsLocal({ provider: 'ollama', model: 'qwen2.5:72b', baseURL: 'https://other.example.com:11434' })).toBe(false);
    // It is asked like this Mac's own, so what is known of it stays current; no other server ever is.
    expect(listedAt({ provider: 'ollama', model: 'qwen2.5:72b', baseURL: studio })).toBe(studio);
    expect(listedAt({ provider: 'ollama', model: 'qwen2.5:72b', baseURL: 'https://other.example.com:11434' })).toBeUndefined();
  });

  it('an address reached through a proxy is not here, loopback included, whoever vouches for it', () => {
    setPlaceRules({ proxied: () => true, own: () => true });
    expect(placedHere(here)).toBe(false);
    expect(placedHere(studio)).toBe(false);
    expect(brainIsLocal({ provider: 'ollama', model: 'qwen2.5:14b', baseURL: here })).toBe(false);
    expect(brainIsLocal({ provider: 'ollama', model: 'qwen2.5:14b', baseURL: here }, { allowRemote: true })).toBe(false);
    expect(brainIsLocal({ provider: 'local', model: 'any', baseURL: 'http://127.0.0.1:8080/v1' })).toBe(false);
    setPlaceRules({ proxied: (url) => new URL(url).port === '8080' });
    expect(brainIsLocal({ provider: 'ollama', model: 'qwen2.5:14b', baseURL: here })).toBe(true);
    expect(brainIsLocal({ provider: 'local', model: 'any', baseURL: 'http://127.0.0.1:8080/v1' })).toBe(false);
  });
});

describe('not local, or not known yet? (placeUnknown: whoever can wait for the answer should)', () => {
  const ollama = (model: string, baseURL: string = here) => ({ provider: 'ollama', model, baseURL });

  it('a model its Ollama has not been heard on is not known yet; one it lists is settled either way', () => {
    listed(here, ['qwen2.5:14b', { name: 'mine', remote_host: 'https://ollama.com:443' }]);
    expect(placeUnknown(ollama('qwen2.5:14b'))).toBe(false); // here
    expect(placeUnknown(ollama('mine'))).toBe(false); // elsewhere, for good
    expect(placeUnknown(ollama('not-pulled:7b'))).toBe(true); // the listing does not hold it: it may be pulled yet
    LOCALITY.clear();
    expect(brainIsLocal(ollama('qwen2.5:14b'))).toBe(false);
    expect(placeUnknown(ollama('qwen2.5:14b'))).toBe(true); // nothing heard: not a no for good
  });

  it('a brain that can never be local is not "unknown": another provider, a cloud name, a server elsewhere, no address', () => {
    LOCALITY.clear();
    expect(placeUnknown({ provider: 'anthropic', model: 'claude-opus-5-5' })).toBe(false);
    expect(placeUnknown(ollama('gpt-oss:120b-cloud'))).toBe(false);
    expect(placeUnknown(ollama('qwen2.5:14b', 'http://gpu-box.lan:11434'))).toBe(false);
    expect(placeUnknown({ provider: 'ollama', model: 'qwen2.5:14b' })).toBe(false);
    expect(placeUnknown(undefined)).toBe(false);
    // The model server Will allowed is here, so its answer is worth waiting for too.
    setPlaceRules({ own: (url) => url.startsWith('https://studio.example') });
    expect(placeUnknown(ollama('qwen2.5:14b', 'https://studio.example:11434'))).toBe(true);
  });
});

describe('the OpenAI-compatible local wire', () => {
  const lm = 'http://127.0.0.1:1234/v1';

  it('is a local wire: a model on a server at this Mac’s address is local, and one elsewhere is not', () => {
    expect(isLocalWire('local')).toBe(true);
    expect(isLocalWire('ollama')).toBe(true);
    expect(isLocalWire('openai')).toBe(false);
    // llama.cpp, LM Studio: a server that runs only its own models has no listing to ask.
    expect(brainIsLocal({ provider: 'local', model: 'qwen2.5-coder-14b', baseURL: lm })).toBe(true);
    expect(brainIsLocal({ provider: 'local', model: 'qwen2.5-coder-14b', baseURL: 'http://gpu.example.com:1234/v1' })).toBe(false);
    expect(brainIsLocal({ provider: 'local', model: 'qwen2.5-coder-14b' })).toBe(false);
    expect(brainIsLocal({ provider: 'local', model: 'gpt-oss:120b-cloud', baseURL: lm })).toBe(false);
  });

  it('pointed at an Ollama, it is held to that Ollama’s listing like the other wire: an alias of a cloud model is not local', () => {
    const viaOllama = 'http://127.0.0.1:11434/v1';
    expect(brainIsLocal({ provider: 'local', model: 'mine', baseURL: viaOllama })).toBe(true); // not known to be an Ollama yet
    // The monitor's look at the server found an Ollama, and handed over what it lists (./local-backend onListing).
    listed(viaOllama, ['qwen2.5:14b', { name: 'mine:latest', remote_host: 'https://ollama.com:443', remote_model: 'gpt-oss:120b' }]);
    expect(LOCALITY.isOllama(viaOllama)).toBe(true);
    expect(brainIsLocal({ provider: 'local', model: 'mine', baseURL: viaOllama })).toBe(false);
    expect(brainIsLocal({ provider: 'local', model: 'qwen2.5:14b', baseURL: viaOllama })).toBe(true);
    // A model that Ollama does not list is not known to run on it.
    expect(brainIsLocal({ provider: 'local', model: 'never-pulled', baseURL: viaOllama })).toBe(false);
    // Another server on the same wire is none of that Ollama's business.
    expect(brainIsLocal({ provider: 'local', model: 'mine', baseURL: lm })).toBe(true);
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
