/**
 * "A model on this Mac" is one meaning in three places: @flint/core names a
 * cloud model for the apps that pick a default; @flint/policy holds the rules
 * the runtime uses for every local call it makes; the server decides what may
 * be shown to a brain. They cannot import each other every way round, so this
 * holds them together: the same names, the same addresses and the same
 * listings must get the same answer from each.
 */
import { describe, it, expect } from 'vitest';
import { isOllamaCloudModel } from '@flint/core';
import { canonicalModel as policyCanonical, isCloudModel as policyCloud, listedHere, listedModels, onThisMachine as policyHere, sameModel as policySame } from '@flint/policy';
import { canonicalModel, isCloudModel, sameModel } from '../src/memory-brain';
import { OllamaLocality } from '../src/ollama-locality';
import { onThisMachine } from '../src/policy';

const NAMES = [
  'gpt-oss:120b-cloud', 'glm-4.6:cloud', 'deepseek-v3.1:671b-cloud', 'qwen3-coder-cloud', 'Kimi-K2:1T-Cloud', ' glm-4.6:CLOUD ',
  'muse-glimmer:30b', 'qwen3.6:35b', 'mycloud:7b', 'cloudy:7b', 'cloud', 'cloud:7b', 'x:cloud', 'x:my-cloud', 'x:mycloud', 'x:cloud-7b',
  'hf.co/org/cloudy-repo:Q4_K_M', 'hf.co/org/cloud-model:Q4_K_M', 'hf.co/org/model-cloud', 'hf.co/org/model-cloud:Q4', 'registry.local:5000/org/model',
  'registry.local:5000/org/model-cloud', 'registry.local:5000/org/cloud', 'my-cloud:5000/org/model', 'nomic-embed-text', 'llama3.1', 'llama3.1:latest', '', ':', 'a:', ':cloud', '-cloud',
];

describe('one rule for a cloud model’s name', () => {
  it('the server’s is the policy package’s', () => {
    expect(isCloudModel).toBe(policyCloud);
    expect(canonicalModel).toBe(policyCanonical);
    expect(sameModel).toBe(policySame);
  });

  it('and the policy package’s agrees with @flint/core’s on every name', () => {
    for (const name of NAMES) expect(policyCloud(name), JSON.stringify(name)).toBe(isOllamaCloudModel(name));
    // Names put together from the pieces a rule could trip on, every way round.
    const parts = ['cloud', '-cloud', 'x', ':', '/', '-', '7b', 'Cloud', ' '];
    let n = 0;
    for (const a of parts) for (const b of parts) for (const c of parts) for (const d of parts) {
      const name = a + b + c + d;
      n += 1;
      if (policyCloud(name) !== isOllamaCloudModel(name)) throw new Error(`the two rules differ on ${JSON.stringify(name)}`);
    }
    expect(n).toBe(parts.length ** 4);
  });
});

describe('one rule for an address on this machine', () => {
  it('the server’s agrees with the policy package’s', () => {
    for (const url of [
      'http://127.0.0.1:11434', 'http://localhost:11434', 'http://[::1]:11434', 'http://LOCALHOST:11434/', 'https://127.0.0.1:8443/v1', 'http://127.0.0.1',
      'http://127.0.0.1.example.com:11434', 'http://localhost.example.com', 'http://192.168.1.20:11434', 'http://0.0.0.0:11434', 'https://ollama.com',
      'http://studio.local:11434', 'ftp://127.0.0.1', 'file:///tmp/x', '127.0.0.1:11434', 'not a url', '', undefined,
    ]) expect(policyHere(url), String(url)).toBe(onThisMachine(url));
  });
});

describe('one reading of Ollama’s listing', () => {
  const URL_ = 'http://127.0.0.1:11434';
  const LISTINGS: unknown[][] = [
    [{ name: 'muse-glimmer:30b' }, { name: 'llama3.1:latest' }],
    [{ name: 'mine:latest', remote_host: 'https://ollama.com:443', remote_model: 'gpt-oss:120b' }, { name: 'muse-glimmer:30b' }],
    [{ name: 'm:1', remote_host: 1 }], [{ name: 'm:1', remote_host: true }], [{ name: 'm:1', remote_host: false }], [{ name: 'm:1', remote_host: {} }], [{ name: 'm:1', remote_model: 0 }],
    [{ name: 'm:1', remote_host: '' }], [{ name: 'm:1', remote_host: null }], [{ name: 'm:1' }, { name: 'M:1', remote_host: 'x' }], [{ name: 'm:1', remote_model: 'y' }, { name: 'm:1' }],
    [{ model: 'm:1' }], [{ name: '  ', model: 'm:1' }], [{ name: 7 }, { name: '' }], [],
  ];
  it('the server’s record and the policy package’s reader say the same of every model', () => {
    for (const rows of LISTINGS) {
      const server = new OllamaLocality();
      server.learn(URL_, rows as never[]);
      const models = listedModels(rows);
      for (const model of ['muse-glimmer:30b', 'llama3.1', 'Llama3.1:latest', 'mine', 'm:1', 'M:1', 'other:7b', '']) {
        expect(listedHere(models, model), `${JSON.stringify(rows)} ${model}`).toBe(server.runsHere(URL_, model));
      }
      server.clear();
    }
  });
});
