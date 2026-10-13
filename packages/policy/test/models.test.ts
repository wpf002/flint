/**
 * What "a model on this Mac" means, the pure part: a cloud model's name, one
 * model written two ways, an address that is this machine, and Ollama's own
 * listing read so that anything it says of a remote host or model means the
 * model runs elsewhere. The server and the runtime both build on these.
 */
import { describe, it, expect } from 'vitest';
import { canonicalModel, isCloudModel, listedHere, listedModels, onThisMachine, sameModel } from '../src/models';

describe('a cloud model by its name', () => {
  it('a -cloud or :cloud name runs on Ollama’s servers, in any case', () => {
    for (const name of ['gpt-oss:120b-cloud', 'glm-4.6:cloud', 'deepseek-v3.1:671b-cloud', 'qwen3-coder-cloud', 'Kimi-K2:1T-Cloud', ' glm-4.6:CLOUD ']) expect(isCloudModel(name), name).toBe(true);
  });
  it('a name that only holds the word is not one', () => {
    for (const name of ['muse-glimmer:30b', 'qwen3.6:35b', 'mycloud:7b', 'cloudy:7b', 'hf.co/org/cloudy-repo:Q4_K_M', 'hf.co/org/cloud-model:Q4_K_M', 'nomic-embed-text', 'llama3.1', '']) expect(isCloudModel(name), name).toBe(false);
  });
});

describe('one model, however it is written', () => {
  it('lower case, and :latest when no tag is given; a registry port is not a tag', () => {
    expect(canonicalModel(' Llama3.1 ')).toBe('llama3.1:latest');
    expect(canonicalModel('llama3.1:8b')).toBe('llama3.1:8b');
    expect(canonicalModel('registry.local:5000/org/model')).toBe('registry.local:5000/org/model:latest');
    expect(sameModel('hf.co/Org/Repo:Q4_K_M', 'hf.co/org/repo:q4_k_m')).toBe(true);
    expect(sameModel('llama3.1', 'llama3.1:latest')).toBe(true);
    expect(sameModel('llama3.1', 'llama3.1:8b')).toBe(false);
  });
});

describe('an address that is this machine', () => {
  it('exactly 127.0.0.1, localhost or ::1', () => {
    for (const url of ['http://127.0.0.1:11434', 'http://localhost:11434', 'http://[::1]:11434', 'http://LOCALHOST:11434/', 'https://127.0.0.1:8443/v1']) expect(onThisMachine(url), url).toBe(true);
  });
  it('anything else is someone else’s, and so is anything that is no address', () => {
    for (const url of ['http://127.0.0.1.example.com:11434', 'http://localhost.example.com', 'http://192.168.1.20:11434', 'http://10.0.0.5:11434', 'http://0.0.0.0:11434', 'https://ollama.com', 'http://studio.local:11434', 'ftp://127.0.0.1', 'file:///tmp/x', '127.0.0.1:11434', 'not a url', '', undefined]) {
      expect(onThisMachine(url), String(url)).toBe(false);
    }
  });
});

describe('Ollama’s own listing', () => {
  it('a row that says nothing of a remote host or model is here', () => {
    const models = listedModels([{ name: 'muse-glimmer:30b', model: 'muse-glimmer:30b', size: 1 }, { name: 'llama3.1:latest' }]);
    expect(models).toEqual([{ name: 'muse-glimmer:30b', here: true }, { name: 'llama3.1:latest', here: true }]);
    expect(listedHere(models, 'muse-glimmer:30b')).toBe(true);
    expect(listedHere(models, 'Llama3.1')).toBe(true);
  });

  it('a plain name with a remote host is a cloud model, whatever it is called', () => {
    const models = listedModels([{ name: 'mine:latest', remote_host: 'https://ollama.com:443', remote_model: 'gpt-oss:120b' }, { name: 'muse-glimmer:30b' }]);
    expect(listedHere(models, 'mine')).toBe(false);
    expect(isCloudModel('mine')).toBe(false); // the name alone would have let it through
    expect(listedHere(models, 'muse-glimmer:30b')).toBe(true);
  });

  it('anything at all said of a remote host or a remote model means elsewhere', () => {
    for (const extra of [{ remote_host: 'x' }, { remote_model: 'y' }, { remote_host: 1 }, { remote_host: true }, { remote_host: {} }, { remote_model: 0 }, { remote_host: false }]) {
      expect(listedHere(listedModels([{ name: 'm:1', ...extra }]), 'm:1'), JSON.stringify(extra)).toBe(false);
    }
    for (const extra of [{ remote_host: '' }, { remote_host: null }, { remote_model: undefined }, {}]) {
      expect(listedHere(listedModels([{ name: 'm:1', ...extra }]), 'm:1'), JSON.stringify(extra)).toBe(true);
    }
  });

  it('a model listed twice is here only if every row says so', () => {
    expect(listedHere(listedModels([{ name: 'm:1' }, { name: 'M:1', remote_host: 'x' }]), 'm:1')).toBe(false);
    expect(listedHere(listedModels([{ name: 'm:1', remote_host: 'x' }, { name: 'm:1' }]), 'm:1')).toBe(false);
  });

  it('a model the listing does not hold is not here, nor is an empty name', () => {
    const models = listedModels([{ name: 'muse-glimmer:30b' }]);
    expect(listedHere(models, 'qwen3.6:35b')).toBe(false);
    expect(listedHere(models, '')).toBe(false);
    expect(listedHere([], 'muse-glimmer:30b')).toBe(false);
  });

  it('a row with no name falls back to its model field, and a row that is no row is dropped', () => {
    expect(listedModels([{ model: 'a:1' }, { name: '  ', model: 'b:1' }, { name: 7 }, null, 'x', 3, [], { name: '' }])).toEqual([{ name: 'a:1', here: true }, { name: 'b:1', here: true }]);
  });
});
