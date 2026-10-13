/**
 * What "a model on this Mac" means, the pure part: a cloud model's name, one
 * model written two ways, an address that is this machine, and Ollama's own
 * listing read so that anything it says of a remote host or model means the
 * model runs elsewhere. The server and the runtime both build on these.
 */
import { describe, it, expect } from 'vitest';
import { ModelPlaces, PLACE_MAX_AGE_MS, canonicalModel, isCloudModel, listedHere, listedModels, onThisMachine, placeSaid, readEnvProxy, sameModel, serverOf, viaProxy } from '../src/models';

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
  it('a name under localhost is not taken for this machine, though it resolves here', () => {
    // Node on this Mac does resolve `ollama.localhost` to loopback (measured). Where a name resolves is the
    // resolver's to say, and a hosts file or a DNS answer can say otherwise: the rule takes the three exact
    // spellings and no other name on trust. (The runtime's own setting allows only those three, and pins
    // `localhost` to 127.0.0.1.)
    for (const url of ['http://ollama.localhost:11434', 'http://a.b.localhost:11434', 'http://xlocalhost:11434', 'http://localhost.:11434', 'http://localhost.localdomain:11434', 'http://127.1:11435', 'http://[::ffff:10.0.0.5]:11434']) {
      expect(onThisMachine(url), url).toBe(url === 'http://127.1:11435');
    }
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
    // A blank name is no model, even where a row would read as the same name once a tag is added.
    const odd = listedModels([{ name: ':latest' }, { name: 'latest' }]);
    for (const blank of ['', ' ', '\t']) expect(listedHere(odd, blank), JSON.stringify(blank)).toBe(false);
    expect(new ModelPlaces().runsHere('http://127.0.0.1:11434', '')).toBe(false);
  });

  it('a row with no name falls back to its model field, and a row that is no row is dropped', () => {
    expect(listedModels([{ model: 'a:1' }, { name: '  ', model: 'b:1' }, { name: 7 }, null, 'x', 3, [], { name: '' }])).toEqual([{ name: 'a:1', here: true }, { name: 'b:1', here: true }]);
  });
});

describe('what a server said when asked for its listing', () => {
  const never = async () => { throw new Error('the body is read only for a 2xx'); };
  it('a 2xx with a models array is an Ollama; null is an Ollama with none', async () => {
    expect(await placeSaid(200, async () => ({ models: [{ name: 'a' }] }))).toEqual({ ollama: [{ name: 'a' }] });
    expect(await placeSaid(200, async () => ({ models: [] }))).toEqual({ ollama: [] });
    expect(await placeSaid(200, async () => ({ models: null }))).toEqual({ ollama: [] });
  });
  it('an answer that is no listing is some other server', async () => {
    expect(await placeSaid(200, async () => ({ data: [] }))).toBe('other');
    expect(await placeSaid(200, async () => 'a string')).toBe('other');
    expect(await placeSaid(200, async () => null)).toBe('other');
    expect(await placeSaid(200, async () => { throw new SyntaxError('not json'); })).toBe('other');
    for (const status of [404, 405, 501]) expect(await placeSaid(status, never), String(status)).toBe('other');
  });
  it('anything else says nothing either way', async () => {
    for (const status of [301, 302, 400, 401, 403, 408, 429, 500, 502, 503, 599]) expect(await placeSaid(status, never), String(status)).toBeUndefined();
  });
});

describe('the record of what model servers have said', () => {
  const HERE = 'http://127.0.0.1:11434';
  it('nothing is known until a server has been heard from', () => {
    const p = new ModelPlaces();
    expect(p.runsHere(HERE, 'm:1')).toBe(false);
    expect(p.runsElsewhere(HERE, 'm:1')).toBe(false);
    expect(p.said(HERE)).toBeUndefined();
    expect(p.heardAt(HERE)).toBeUndefined();
    expect(p.runsHere(undefined, 'm:1')).toBe(false);
    expect(p.runsHere(HERE, '')).toBe(false);
  });

  it('a listing says which models run there and which run elsewhere; a model it does not hold is neither', () => {
    const p = new ModelPlaces();
    p.learn(HERE, [{ name: 'm:1' }, { name: 'mine:latest', remote_host: 'https://ollama.com:443' }]);
    expect(p.said(HERE)).toBe('ollama');
    expect(p.runsHere(HERE, 'm:1')).toBe(true);
    expect(p.runsElsewhere(HERE, 'm:1')).toBe(false);
    expect(p.runsHere(HERE, 'mine')).toBe(false);
    expect(p.runsElsewhere(HERE, 'mine')).toBe(true);
    expect(p.runsHere(HERE, 'other:1')).toBe(false);
    expect(p.runsElsewhere(HERE, 'other:1')).toBe(false);
  });

  it('a server is known by its origin: a path or a trailing slash is the same server, another port or name is not', () => {
    const p = new ModelPlaces();
    p.learn(`${HERE}/`, [{ name: 'm:1' }]);
    for (const url of [HERE, `${HERE}/`, `${HERE}/v1`, 'HTTP://127.0.0.1:11434']) expect(p.runsHere(url, 'm:1'), url).toBe(true);
    for (const url of ['http://localhost:11434', 'http://127.0.0.1:11435', 'https://127.0.0.1:11434', 'http://[::1]:11434']) expect(p.runsHere(url, 'm:1'), url).toBe(false);
    expect(serverOf(`${HERE}/v1/`)).toBe(HERE);
    expect(serverOf('not a url//')).toBe('not a url');
  });

  it('what was said is believed for five minutes, and then not at all', () => {
    let now = 1_000;
    const p = new ModelPlaces({ now: () => now });
    p.learn(HERE, [{ name: 'm:1' }, { name: 'r:1', remote_host: 'x' }]);
    now += PLACE_MAX_AGE_MS;
    expect(p.runsHere(HERE, 'm:1')).toBe(true);
    expect(p.runsElsewhere(HERE, 'r:1')).toBe(true);
    now += 1;
    expect(p.runsHere(HERE, 'm:1')).toBe(false);
    expect(p.runsElsewhere(HERE, 'r:1')).toBe(false);
    expect(p.said(HERE)).toBeUndefined();
    // It was heard, once: when is still known, so whoever asks knows to ask again.
    expect(p.heardAt(HERE)).toBe(1_000);
    expect(new ModelPlaces({ maxAgeMs: 10, now: () => now }).runsHere(HERE, 'm:1')).toBe(false);
  });

  it('a server that says it is no Ollama runs nothing known here on Ollama’s wire, and does not unsay a listing still believed', () => {
    let now = 0;
    const p = new ModelPlaces({ now: () => now });
    p.notOllama(HERE);
    expect(p.said(HERE)).toBe('other');
    expect(p.runsHere(HERE, 'm:1')).toBe(false);
    p.learn(HERE, [{ name: 'm:1' }]);
    p.notOllama(`${HERE}/v1`);
    expect(p.said(HERE)).toBe('ollama');
    expect(p.runsHere(HERE, 'm:1')).toBe(true);
    // Once the listing is too old to believe, the no is taken.
    now += PLACE_MAX_AGE_MS + 1;
    p.notOllama(HERE);
    expect(p.said(HERE)).toBe('other');
  });

  it('take: a listing is learned, a no is noted, and nothing said is nothing learned', () => {
    const p = new ModelPlaces();
    p.take(HERE, undefined);
    expect(p.heardAt(HERE)).toBeUndefined();
    p.take(HERE, { ollama: [{ name: 'm:1' }] });
    expect(p.runsHere(HERE, 'm:1')).toBe(true);
    p.take(HERE, undefined);
    expect(p.runsHere(HERE, 'm:1')).toBe(true);
    p.clear();
    p.take(HERE, 'other');
    expect(p.said(HERE)).toBe('other');
  });
});

describe('Node’s env proxy: an address that goes through it is not this Mac', () => {
  const PROXY = { NODE_USE_ENV_PROXY: '1', HTTP_PROXY: 'http://proxy.example:3128' };
  it('on only when Node is told to use it and a proxy is named', () => {
    expect(readEnvProxy({}, [])).toEqual({ on: false, direct: [] });
    expect(readEnvProxy({ HTTP_PROXY: PROXY.HTTP_PROXY }, []).on).toBe(false);
    expect(readEnvProxy({ NODE_USE_ENV_PROXY: '1' }, []).on).toBe(false);
    expect(readEnvProxy(PROXY, []).on).toBe(true);
    for (const key of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy']) expect(readEnvProxy({ NODE_USE_ENV_PROXY: '1', [key]: 'http://p:1' }, []).on, key).toBe(true);
    expect(readEnvProxy({ HTTP_PROXY: 'http://p:1' }, ['--use-env-proxy']).on).toBe(true);
    expect(readEnvProxy({ HTTP_PROXY: 'http://p:1', NODE_OPTIONS: '--max-old-space-size=4096 --use-env-proxy' }, []).on).toBe(true);
    expect(readEnvProxy({ HTTP_PROXY: 'http://p:1', NODE_OPTIONS: '--use-env-proxy-not' }, []).on).toBe(false);
    for (const v of ['0', 'true', 'yes', '']) expect(readEnvProxy({ NODE_USE_ENV_PROXY: v, HTTP_PROXY: 'http://p:1' }, []).on, v).toBe(false);
  });
  it('loopback goes through it too, unless the no-proxy list names the host exactly', () => {
    const on = readEnvProxy(PROXY, []);
    for (const host of ['127.0.0.1:11434', '[::1]:8080', 'localhost:11434', '127.0.0.1', undefined]) expect(viaProxy(host, on), String(host)).toBe(true);
    const listed = readEnvProxy({ ...PROXY, NO_PROXY: 'localhost,127.0.0.1,[::1]' }, []);
    expect(listed.direct).toEqual(['localhost', '127.0.0.1', '[::1]']);
    for (const host of ['127.0.0.1:11434', '127.0.0.1', '[::1]:8080', '[::1]', 'localhost:1', 'LOCALHOST:1']) expect(viaProxy(host, listed), host).toBe(false);
    expect(viaProxy('gpu-box.lan:11434', listed)).toBe(true);
    expect(viaProxy('anything.example:1', readEnvProxy({ ...PROXY, NO_PROXY: '*' }, []))).toBe(false);
    // An entry Node would have to interpret is not taken as naming the host.
    for (const entry of ['.0.0.1', '0.0.1', '*.0.0.1', '127.*', '127.0.0.0/8', '127.0.0.1:11434', '127.0.0.1.', '127.0.0.1;foo']) expect(viaProxy('127.0.0.1:11434', readEnvProxy({ ...PROXY, NO_PROXY: entry }, [])), entry).toBe(true);
    const off = readEnvProxy({ HTTP_PROXY: PROXY.HTTP_PROXY }, []);
    for (const host of ['127.0.0.1:11434', 'gpu-box.lan:11434', undefined]) expect(viaProxy(host, off)).toBe(false);
  });

  // Each row is what Node v24.15 really did with that environment, measured against a proxy and two targets on
  // loopback (an IPv4 one and an IPv6 one): `true` is "Node sent it through the proxy".
  const NODE_V24: Array<[string, Record<string, string>, { v4: boolean; v6: boolean }]> = [
    ['NO_PROXY=127.0.0.1', { NO_PROXY: '127.0.0.1' }, { v4: false, v6: true }],
    ['NO_PROXY=[::1]', { NO_PROXY: '[::1]' }, { v4: true, v6: false }],
    ['NO_PROXY=[::1],127.0.0.1', { NO_PROXY: '[::1],127.0.0.1' }, { v4: false, v6: false }],
    ['NO_PROXY=127.0.0.1 with spaces around it', { NO_PROXY: ' 127.0.0.1 ' }, { v4: false, v6: true }],
    ['NO_PROXY=foo<tab>127.0.0.1', { NO_PROXY: 'foo\t127.0.0.1' }, { v4: false, v6: true }],
    ['NO_PROXY=*', { NO_PROXY: '*' }, { v4: false, v6: false }],
    ['no_proxy=*', { no_proxy: '*' }, { v4: false, v6: false }],
    ['no_proxy=127.0.0.1', { no_proxy: '127.0.0.1' }, { v4: false, v6: true }],
    // The three forms that used to read as "this Mac" while Node proxied them.
    // 1. An IPv6 address without its brackets names nothing: Node needs `[::1]`.
    ['NO_PROXY=::1', { NO_PROXY: '::1' }, { v4: true, v6: true }],
    ['no_proxy=::1', { no_proxy: '::1' }, { v4: true, v6: true }],
    ['NO_PROXY=::1,127.0.0.1', { NO_PROXY: '::1,127.0.0.1' }, { v4: false, v6: true }],
    ['NO_PROXY=0:0:0:0:0:0:0:1', { NO_PROXY: '0:0:0:0:0:0:0:1' }, { v4: true, v6: true }],
    // 2. `*` is every host only as the whole value: beside another entry Node does not honour it.
    ['NO_PROXY=*,foo', { NO_PROXY: '*,foo' }, { v4: true, v6: true }],
    ['NO_PROXY=foo,*', { NO_PROXY: 'foo,*' }, { v4: true, v6: true }],
    ['NO_PROXY=" * " (a star with spaces around it)', { NO_PROXY: ' * ' }, { v4: true, v6: true }],
    ['NO_PROXY=*,127.0.0.1', { NO_PROXY: '*,127.0.0.1' }, { v4: false, v6: true }],
    // 3. With both spellings set Node reads the lower-case one, and only it: even when it is empty.
    ['NO_PROXY=127.0.0.1 and no_proxy=x', { NO_PROXY: '127.0.0.1', no_proxy: 'x' }, { v4: true, v6: true }],
    ['NO_PROXY=x and no_proxy=127.0.0.1', { NO_PROXY: 'x', no_proxy: '127.0.0.1' }, { v4: false, v6: true }],
    ['NO_PROXY=127.0.0.1 and no_proxy empty', { NO_PROXY: '127.0.0.1', no_proxy: '' }, { v4: true, v6: true }],
  ];
  it.each(NODE_V24)('says what Node does: %s', (_label, noProxy, node) => {
    const proxy = readEnvProxy({ ...PROXY, ...noProxy }, []);
    expect({ v4: viaProxy('127.0.0.1:11434', proxy), v6: viaProxy('[::1]:11434', proxy) }).toEqual(node);
  });

  it('where it is not sure it says proxied, never direct: every form Node keeps direct that the rule does not is the safe way round', () => {
    // Node keeps these direct (a matching port, a suffix): the rule does not try to follow it, and refuses the address.
    for (const entry of ['127.0.0.1:11434', '.0.0.1', '0.0.1', '*.0.0.1']) expect(viaProxy('127.0.0.1:11434', readEnvProxy({ ...PROXY, NO_PROXY: entry }, [])), entry).toBe(true);
    expect(viaProxy('[::1]:11434', readEnvProxy({ ...PROXY, NO_PROXY: '[::1]:11434' }, []))).toBe(true);
    // A star inside a list is no entry at all, and the entries beside it still count.
    expect(readEnvProxy({ ...PROXY, NO_PROXY: '*,127.0.0.1' }, []).direct).toEqual(['127.0.0.1']);
    expect(viaProxy('gpu-box.lan:1', readEnvProxy({ ...PROXY, NO_PROXY: '*,127.0.0.1' }, []))).toBe(true);
    // A name under localhost is kept direct by Node when `localhost` is listed (a suffix): the rule does not follow it.
    expect(viaProxy('ollama.localhost:11434', readEnvProxy({ ...PROXY, NO_PROXY: 'localhost' }, []))).toBe(true);
  });
});
