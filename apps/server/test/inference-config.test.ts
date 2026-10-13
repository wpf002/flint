import { describe, it, expect } from 'vitest';
import { DEFAULTS, PDF_READERS, PDF_READER_PROGRAMS, readContextSize, addressIsLocal, endpointIsLocal, localEndpoint, parseLocalUrl, readEnvProxy, readInferenceConfig, SCHEMAS, ollamaIsLocal, viaProxy, type FileCheck } from '../src/inference-config';

/**
 * Local-inference config: every key has a schema, a refused value never stops
 * Flint and is named without being repeated, and a local endpoint is this Mac
 * unless Will says a server elsewhere is meant.
 */

const read = (env: Record<string, string | undefined>) => {
  const warned: string[] = [];
  const cfg = readInferenceConfig(env, (m) => warned.push(m));
  return { cfg, warned };
};

describe('readInferenceConfig: with nothing set', () => {
  const { cfg, warned } = read({});

  it('is the cloud mode on the native Ollama wire: today, unchanged', () => {
    expect(cfg.mode).toBe('cloud');
    expect(cfg.modeSource).toBe('default');
    expect(cfg.local.provider).toBe('ollama');
    expect(cfg.local.server).toBe('auto');
    expect(cfg.local.tools).toBe('auto');
    expect(cfg.local.allowRemote).toBe(false);
    expect(cfg.local.model).toBeUndefined();
    expect(cfg.local.fallbackModel).toBeUndefined();
    expect(cfg.local.apiKey).toBeUndefined();
  });

  it('points both wires at this Mac', () => {
    expect(cfg.local.ollama).toEqual({ origin: 'http://127.0.0.1:11434', path: '', host: '127.0.0.1:11434', loopback: true, secure: true });
    expect(cfg.local.allowInsecureRemote).toBe(false);
    expect(cfg.local.openai).toMatchObject({ baseURL: 'http://127.0.0.1:11434/v1', origin: 'http://127.0.0.1:11434', path: '/v1', loopback: true });
  });

  it('uses the documented deadlines', () => {
    expect(cfg.local.connectTimeoutMs).toBe(1500);
    expect(cfg.local.firstTokenTimeoutMs).toBe(20000);
    expect(cfg.local.toolPassTimeoutMs).toBe(60000);
    expect(cfg.local.requestTimeoutMs).toBe(120000);
    expect(cfg.local.idleTimeoutMs).toBe(30000);
    expect(cfg.local.healthIntervalMs).toBe(15000);
    expect(DEFAULTS.firstTokenTimeoutMs).toBe(20000);
  });

  it('detects the hardware tier rather than assuming one', () => {
    expect(cfg.hardwareTier).toBe('auto');
  });

  it('reports no problem and warns about nothing', () => {
    expect(cfg.problems).toEqual([]);
    expect(warned).toEqual([]);
  });

  it('a blank value is the same as an unset one', () => {
    const blank = read({ FLINT_INFERENCE_MODE: '  ', FLINT_LOCAL_PROVIDER: '', FLINT_LOCAL_BASE_URL: ' ', OLLAMA_HOST: '' });
    expect(blank.cfg).toEqual(cfg);
    expect(blank.warned).toEqual([]);
  });
});

describe('readInferenceConfig: valid values', () => {
  it('reads each key', () => {
    const { cfg, warned } = read({
      FLINT_INFERENCE_MODE: ' Hybrid ',
      FLINT_LOCAL_PROVIDER: 'openai',
      FLINT_LOCAL_BASE_URL: 'http://localhost:8080/v1/',
      FLINT_LOCAL_SERVER: 'llamacpp',
      FLINT_LOCAL_MODEL: 'my-model:q4',
      FLINT_LOCAL_FALLBACK_MODEL: 'tiny-model:1b',
      FLINT_LOCAL_TOOLS: 'on',
      FLINT_LOCAL_API_KEY: 'sk-local-123',
      FLINT_LOCAL_CONNECT_TIMEOUT_MS: '500',
      FLINT_LOCAL_FIRST_OUTPUT_TIMEOUT_MS: '8000',
      FLINT_LOCAL_TOOL_PASS_TIMEOUT_MS: '30000',
      FLINT_LOCAL_REQUEST_TIMEOUT_MS: '90000',
      FLINT_LOCAL_HEALTH_INTERVAL_MS: '5000',
    });
    expect(warned).toEqual([]);
    expect(cfg.mode).toBe('hybrid');
    expect(cfg.modeSource).toBe('env');
    expect(cfg.local).toMatchObject({
      provider: 'openai',
      server: 'llamacpp',
      model: 'my-model:q4',
      fallbackModel: 'tiny-model:1b',
      tools: 'on',
      apiKey: 'sk-local-123',
      connectTimeoutMs: 500,
      firstTokenTimeoutMs: 8000,
      toolPassTimeoutMs: 30000,
      requestTimeoutMs: 90000,
      healthIntervalMs: 5000,
    });
    // `localhost` is pinned to 127.0.0.1: the address requests go to is this machine's loopback, whatever the name resolves to.
    expect(cfg.local.openai).toMatchObject({ baseURL: 'http://127.0.0.1:8080/v1', host: '127.0.0.1:8080', loopback: true });
  });

  it('FLINT_HARDWARE_TIER names a tier, and anything else goes back to detecting', () => {
    expect(read({ FLINT_HARDWARE_TIER: '16GB' }).cfg.hardwareTier).toBe('16gb');
    expect(read({ FLINT_HARDWARE_TIER: 'cpu' }).cfg.hardwareTier).toBe('cpu');
    const bad = read({ FLINT_HARDWARE_TIER: '32gb' });
    expect(bad.cfg.hardwareTier).toBe('auto');
    expect(bad.cfg.problems).toEqual([{ key: 'FLINT_HARDWARE_TIER', reason: 'not one of auto, cpu-small, cpu, 8gb, 16gb, 24gb, 48gb', kind: 'invalid' }]);
    expect(bad.warned).toEqual(['[inference] FLINT_HARDWARE_TIER is not one of auto, cpu-small, cpu, 8gb, 16gb, 24gb, 48gb; detecting the hardware instead']);
    expect(read({ FLINT_HARDWARE_TIER: 'cpu-small' }).cfg.hardwareTier).toBe('cpu-small');
  });

  it('FLINT_LOCAL_FALLBACK_MODEL=off turns the standby off', () => {
    expect(read({ FLINT_LOCAL_FALLBACK_MODEL: 'OFF' }).cfg.local.fallbackModel).toBe('off');
  });

  it('a base URL with no path gets /v1', () => {
    expect(read({ FLINT_LOCAL_BASE_URL: 'http://127.0.0.1:8080' }).cfg.local.openai?.baseURL).toBe('http://127.0.0.1:8080/v1');
  });
});

describe('readInferenceConfig: a refused value never stops Flint, and lands on the safe side', () => {
  it('an invalid FLINT_INFERENCE_MODE runs as local, never cloud', () => {
    const { cfg, warned } = read({ FLINT_INFERENCE_MODE: 'cloudd' });
    expect(cfg.mode).toBe('local');
    expect(cfg.modeSource).toBe('invalid_env');
    expect(cfg.problems).toEqual([{ key: 'FLINT_INFERENCE_MODE', reason: 'not one of local, cloud, hybrid', kind: 'invalid' }]);
    expect(warned).toEqual(['[inference] FLINT_INFERENCE_MODE is not one of local, cloud, hybrid; running as local, which never uses the cloud']);
  });

  it('an invalid FLINT_LOCAL_BASE_URL turns the OpenAI-compatible provider off, with no substitute', () => {
    for (const [url, reason] of [
      ['http://192.168.1.20:11434/v1', 'not on this Mac'],
      ['http://127.0.0.1.evil.example/v1', 'not on this Mac'],
      ['http://will:hunter2@127.0.0.1:11434/v1', 'a URL that carries credentials'],
      ['http://127.0.0.1:11434/v1?key=abc', 'a URL with a query or fragment'],
      ['http://127.0.0.1:11434/v1#frag', 'a URL with a query or fragment'],
      ['http://127.0.0.1:11434/a/b/c/d', 'a URL whose path is not a plain one'],
      ['http://127.0.0.1:11434/v1/%2e%2e/admin', 'a URL whose path is not a plain one'],
      ['file:///etc/passwd', 'not http or https'],
      ['nonsense', 'not a URL'],
    ] as const) {
      const { cfg, warned } = read({ FLINT_LOCAL_PROVIDER: 'openai', FLINT_LOCAL_BASE_URL: url });
      expect(cfg.local.openai, url).toBeUndefined();
      expect(cfg.problems[0]!.key, url).toBe('FLINT_LOCAL_BASE_URL');
      expect(cfg.problems[0]!.reason, url).toContain(reason);
      // The class of the refusal travels with it: a face that never shows a key says it in its own words.
      expect(parseLocalUrl(url, false, { defaultPath: '/v1' }), url).toEqual({ ok: false, reason: cfg.problems[0]!.kind });
      expect(warned[0], url).toContain('the OpenAI-compatible provider is off');
      expect(localEndpoint(cfg), url).toBeUndefined();
      expect(endpointIsLocal(cfg), url).toBe(false);
    }
  });

  it('FLINT_LOCAL_ALLOW_REMOTE=1 accepts a server on another machine over https, and says it is not this Mac', () => {
    const { cfg, warned } = read({ FLINT_LOCAL_PROVIDER: 'openai', FLINT_LOCAL_BASE_URL: 'https://gpu-box.example:8443/v1', FLINT_LOCAL_ALLOW_REMOTE: '1' });
    expect(warned).toEqual([]);
    expect(cfg.local.openai).toMatchObject({ baseURL: 'https://gpu-box.example:8443/v1', loopback: false, secure: true });
    expect(endpointIsLocal(cfg)).toBe(true);
  });

  // The routing review: with FLINT_LOCAL_ALLOW_REMOTE=1 every prompt, and the API key, went to another machine in the clear.
  it('plain http to another machine is refused even with FLINT_LOCAL_ALLOW_REMOTE=1, unless Will also says the network is private', () => {
    const plain = read({ FLINT_LOCAL_PROVIDER: 'openai', FLINT_LOCAL_BASE_URL: 'http://192.168.1.20:8080/v1', FLINT_LOCAL_ALLOW_REMOTE: '1' });
    expect(plain.cfg.local.openai).toBeUndefined();
    expect(plain.cfg.problems).toEqual([
      { key: 'FLINT_LOCAL_BASE_URL', reason: 'plain http to another machine (use https, or set FLINT_LOCAL_ALLOW_INSECURE_REMOTE=1 for a private network)', kind: 'insecure_remote' },
    ]);
    expect(plain.warned).toEqual(['[inference] FLINT_LOCAL_BASE_URL is plain http to another machine (use https, or set FLINT_LOCAL_ALLOW_INSECURE_REMOTE=1 for a private network); the OpenAI-compatible provider is off']);
    expect(endpointIsLocal(plain.cfg)).toBe(false);
    const said = read({ FLINT_LOCAL_PROVIDER: 'openai', FLINT_LOCAL_BASE_URL: 'http://192.168.1.20:8080/v1', FLINT_LOCAL_ALLOW_REMOTE: '1', FLINT_LOCAL_ALLOW_INSECURE_REMOTE: '1' });
    expect(said.warned).toEqual([]);
    expect(said.cfg.local.openai).toMatchObject({ baseURL: 'http://192.168.1.20:8080/v1', loopback: false, secure: false });
    expect(endpointIsLocal(said.cfg)).toBe(true);
    // The second setting alone allows nothing: a server elsewhere still needs the first.
    expect(read({ FLINT_LOCAL_PROVIDER: 'openai', FLINT_LOCAL_BASE_URL: 'http://192.168.1.20:8080/v1', FLINT_LOCAL_ALLOW_INSECURE_REMOTE: '1' }).cfg.local.openai).toBeUndefined();
    // This Mac over plain http is this Mac: nothing crosses a network.
    expect(read({ FLINT_LOCAL_PROVIDER: 'openai', FLINT_LOCAL_BASE_URL: 'http://127.0.0.1:8080/v1' }).cfg.local.openai).toMatchObject({ secure: true });
  });

  it('a key is never sent in the clear: over plain http to another machine it is left out, whatever else is allowed', () => {
    const env = { FLINT_LOCAL_PROVIDER: 'openai', FLINT_LOCAL_ALLOW_REMOTE: '1', FLINT_LOCAL_ALLOW_INSECURE_REMOTE: '1', FLINT_LOCAL_API_KEY: 'sk-local-SECRETKEY' };
    const clear = read({ ...env, FLINT_LOCAL_BASE_URL: 'http://192.168.1.20:8080/v1' });
    expect(clear.cfg.local.openai).toBeDefined();
    expect(clear.cfg.local.apiKey).toBeUndefined();
    expect(clear.warned).toEqual(['[inference] FLINT_LOCAL_API_KEY is not sent over plain http to another machine; no key is sent (use https)']);
    expect(clear.cfg.problems).toEqual([{ key: 'FLINT_LOCAL_API_KEY', reason: 'not sent over plain http to another machine', kind: 'in_the_clear' }]);
    expect(clear.warned.join('')).not.toContain('SECRETKEY');
    // Over https, and to this Mac, it is sent as before.
    expect(read({ ...env, FLINT_LOCAL_BASE_URL: 'https://gpu-box.example/v1' }).cfg.local.apiKey).toBe('sk-local-SECRETKEY');
    expect(read({ ...env, FLINT_LOCAL_BASE_URL: 'http://127.0.0.1:8080/v1' }).cfg.local.apiKey).toBe('sk-local-SECRETKEY');
  });

  it('OLLAMA_HOST on another machine over plain http is kept for the cloud mode, and is not "local" unless both settings say so', () => {
    const host = { OLLAMA_HOST: 'http://gpu-box.example:11434' };
    expect(read(host).cfg.local.ollama).toMatchObject({ loopback: false, secure: false });
    expect(endpointIsLocal(read(host).cfg)).toBe(false);
    expect(ollamaIsLocal(read(host).cfg)).toBe(false);
    expect(ollamaIsLocal(read({ ...host, FLINT_LOCAL_ALLOW_REMOTE: '1' }).cfg)).toBe(false);
    expect(ollamaIsLocal(read({ ...host, FLINT_LOCAL_ALLOW_REMOTE: '1', FLINT_LOCAL_ALLOW_INSECURE_REMOTE: '1' }).cfg)).toBe(true);
    expect(ollamaIsLocal(read({ OLLAMA_HOST: 'https://gpu-box.example:11434', FLINT_LOCAL_ALLOW_REMOTE: '1' }).cfg)).toBe(true);
    expect(ollamaIsLocal(read({}).cfg)).toBe(true);
    // The rule is about Ollama's own address, whichever wire the local brain is on.
    expect(ollamaIsLocal(read({ ...host, FLINT_LOCAL_PROVIDER: 'openai' }).cfg)).toBe(false);
  });

  // The privacy review's N2. FLINT_LOCAL_ALLOW_REMOTE says ONE server on another machine is Will's own: the local
  // model server. It used to make OLLAMA_HOST "here" as well, even with the model server somewhere else.
  it('FLINT_LOCAL_ALLOW_REMOTE vouches for the model server only: OLLAMA_HOST on another machine is "local" only when it IS that server', () => {
    const allow = { FLINT_LOCAL_ALLOW_REMOTE: '1', FLINT_LOCAL_ALLOW_INSECURE_REMOTE: '1' };
    const ollamaAway = { OLLAMA_HOST: 'https://ollama-box.example:11434' };
    // The local model on this Mac over the OpenAI-compatible wire, Ollama elsewhere: that Ollama is not here.
    const lmHere = read({ ...ollamaAway, ...allow, FLINT_LOCAL_PROVIDER: 'openai', FLINT_LOCAL_BASE_URL: 'http://127.0.0.1:8080/v1' }).cfg;
    expect(endpointIsLocal(lmHere)).toBe(true);
    expect(ollamaIsLocal(lmHere)).toBe(false);
    // The model server on a third machine he allowed: it is his, and Ollama's is still not.
    const third = read({ ...ollamaAway, ...allow, FLINT_LOCAL_PROVIDER: 'openai', FLINT_LOCAL_BASE_URL: 'https://gpu-box.example/v1' }).cfg;
    expect(endpointIsLocal(third)).toBe(true);
    expect(ollamaIsLocal(third)).toBe(false);
    // One server for both, on either wire: vouched for, as before.
    expect(ollamaIsLocal(read({ ...ollamaAway, ...allow }).cfg)).toBe(true);
    expect(ollamaIsLocal(read({ ...ollamaAway, ...allow, FLINT_LOCAL_PROVIDER: 'openai', FLINT_LOCAL_BASE_URL: 'https://ollama-box.example:11434/v1' }).cfg)).toBe(true);
    // The same host on another port is another server.
    expect(ollamaIsLocal(read({ ...ollamaAway, ...allow, FLINT_LOCAL_PROVIDER: 'openai', FLINT_LOCAL_BASE_URL: 'https://ollama-box.example:8443/v1' }).cfg)).toBe(false);
    // Ollama on this Mac is here whatever the model server is.
    expect(ollamaIsLocal(read({ ...allow, FLINT_LOCAL_PROVIDER: 'openai', FLINT_LOCAL_BASE_URL: 'https://gpu-box.example/v1' }).cfg)).toBe(true);
    // Without the switch nothing on another machine is.
    expect(ollamaIsLocal(read({ ...ollamaAway }).cfg)).toBe(false);
  });

  it('the other keys fall back as documented', () => {
    const { cfg } = read({
      FLINT_LOCAL_PROVIDER: 'vllm',
      FLINT_LOCAL_ALLOW_REMOTE: 'yes',
      FLINT_LOCAL_SERVER: 'lmstudio',
      FLINT_LOCAL_MODEL: 'bad model name!',
      FLINT_LOCAL_FALLBACK_MODEL: 'also bad!',
      FLINT_LOCAL_TOOLS: 'maybe',
      FLINT_LOCAL_API_KEY: 'has space',
      FLINT_LOCAL_CONNECT_TIMEOUT_MS: '5',
      FLINT_LOCAL_FIRST_OUTPUT_TIMEOUT_MS: '1e4',
      FLINT_LOCAL_TOOL_PASS_TIMEOUT_MS: '-1',
      FLINT_LOCAL_REQUEST_TIMEOUT_MS: '99999999',
      FLINT_LOCAL_HEALTH_INTERVAL_MS: 'soon',
    });
    expect(cfg.local.provider).toBe('ollama');
    expect(cfg.local.allowRemote).toBe(false);
    expect(cfg.local.server).toBe('auto');
    expect(cfg.local.model).toBeUndefined();
    expect(cfg.local.fallbackModel).toBeUndefined();
    // A bad FLINT_LOCAL_TOOLS offers no tools: the side that cannot misfire.
    expect(cfg.local.tools).toBe('off');
    expect(cfg.local.apiKey).toBeUndefined();
    expect(cfg.local.connectTimeoutMs).toBe(1500);
    expect(cfg.local.firstTokenTimeoutMs).toBe(20000);
    expect(cfg.local.toolPassTimeoutMs).toBe(60000);
    expect(cfg.local.requestTimeoutMs).toBe(120000);
    expect(cfg.local.healthIntervalMs).toBe(15000);
    expect(cfg.problems.map((p) => p.key).sort()).toEqual(
      [
        'FLINT_LOCAL_ALLOW_REMOTE',
        'FLINT_LOCAL_API_KEY',
        'FLINT_LOCAL_CONNECT_TIMEOUT_MS',
        'FLINT_LOCAL_FALLBACK_MODEL',
        'FLINT_LOCAL_FIRST_OUTPUT_TIMEOUT_MS',
        'FLINT_LOCAL_HEALTH_INTERVAL_MS',
        'FLINT_LOCAL_MODEL',
        'FLINT_LOCAL_PROVIDER',
        'FLINT_LOCAL_REQUEST_TIMEOUT_MS',
        'FLINT_LOCAL_SERVER',
        'FLINT_LOCAL_TOOLS',
        'FLINT_LOCAL_TOOL_PASS_TIMEOUT_MS',
      ].sort(),
    );
  });

  it("an Ollama cloud model is refused as a local model: it runs on Ollama's servers", () => {
    for (const key of ['FLINT_LOCAL_MODEL', 'FLINT_LOCAL_FALLBACK_MODEL'] as const) {
      const { cfg } = read({ [key]: 'big-model:120b-cloud' });
      expect(key === 'FLINT_LOCAL_MODEL' ? cfg.local.model : cfg.local.fallbackModel).toBeUndefined();
      expect(cfg.problems).toEqual([{ key, reason: 'an Ollama cloud model does not run on this Mac', kind: 'cloud_model' }]);
    }
  });

  it('an OLLAMA_HOST that is not a URL turns the native wire off; a remote one is kept and marked', () => {
    const bad = read({ OLLAMA_HOST: 'not a url' });
    expect(bad.cfg.local.ollama).toBeUndefined();
    expect(bad.cfg.problems).toEqual([{ key: 'OLLAMA_HOST', reason: 'not a URL', kind: 'not_a_url' }]);
    const remote = read({ OLLAMA_HOST: 'http://gpu-box.example:11434' });
    expect(remote.cfg.local.ollama).toEqual({ origin: 'http://gpu-box.example:11434', path: '', host: 'gpu-box.example:11434', loopback: false, secure: false });
    // Served under a prefix (a reverse proxy): the prefix is kept.
    expect(read({ OLLAMA_HOST: 'http://127.0.0.1:8443/ollama/' }).cfg.local.ollama).toMatchObject({ origin: 'http://127.0.0.1:8443', path: '/ollama' });
    expect(remote.warned).toEqual([]);
    // Not this Mac: a turn that must stay local may not use it unless Will says so.
    expect(endpointIsLocal(remote.cfg)).toBe(false);
    // (Over https: plain http to another machine also needs his word that the network is private.)
    expect(endpointIsLocal(read({ OLLAMA_HOST: 'https://gpu-box.example:11434', FLINT_LOCAL_ALLOW_REMOTE: '1' }).cfg)).toBe(true);
    expect(endpointIsLocal(read({ OLLAMA_HOST: 'http://gpu-box.example:11434', FLINT_LOCAL_ALLOW_REMOTE: '1' }).cfg)).toBe(false);
  });

  it('no refused value is ever repeated, in a problem or in a log line', () => {
    const secrets = {
      FLINT_INFERENCE_MODE: 'SECRETMODE',
      FLINT_LOCAL_PROVIDER: 'SECRETPROVIDER',
      FLINT_LOCAL_BASE_URL: 'http://user:SECRETPASS@127.0.0.1:11434/v1?token=SECRETTOKEN',
      FLINT_LOCAL_ALLOW_REMOTE: 'SECRETFLAG',
      FLINT_LOCAL_API_KEY: 'SECRET KEY WITH SPACES',
      FLINT_LOCAL_SERVER: 'SECRETSERVER',
      FLINT_LOCAL_MODEL: 'SECRET MODEL',
      FLINT_LOCAL_FALLBACK_MODEL: 'SECRET FALLBACK',
      FLINT_LOCAL_TOOLS: 'SECRETTOOLS',
      FLINT_LOCAL_CONNECT_TIMEOUT_MS: 'SECRET1',
      FLINT_LOCAL_FIRST_OUTPUT_TIMEOUT_MS: 'SECRET2',
      FLINT_LOCAL_TOOL_PASS_TIMEOUT_MS: 'SECRET3',
      FLINT_LOCAL_REQUEST_TIMEOUT_MS: 'SECRET4',
      FLINT_LOCAL_HEALTH_INTERVAL_MS: 'SECRET5',
      FLINT_HARDWARE_TIER: 'SECRETTIER',
      OLLAMA_HOST: 'SECRETHOST ::',
    };
    const { cfg, warned } = read(secrets);
    expect(cfg.problems).toHaveLength(Object.keys(secrets).length);
    const said = JSON.stringify(cfg.problems) + warned.join('\n');
    expect(said).not.toMatch(/SECRET/i);
  });

  it('a valid API key is kept for the adapter and appears in no problem or log line', () => {
    const { cfg, warned } = read({ FLINT_LOCAL_API_KEY: 'sk-live-do-not-log', FLINT_LOCAL_TOOLS: 'nope' });
    expect(cfg.local.apiKey).toBe('sk-live-do-not-log');
    expect(JSON.stringify(cfg.problems) + warned.join('\n')).not.toContain('sk-live-do-not-log');
  });
});

// The final review's L1, as it ran it: with NODE_USE_ENV_PROXY=1 and HTTP_PROXY, Node sends every fetch through
// the proxy, loopback included. The model's prompt and the status command's bearer token went to the proxy first.
describe("Node's env proxy: an address that goes through it is not this Mac", () => {
  const PROXY = { NODE_USE_ENV_PROXY: '1', HTTP_PROXY: 'http://proxy.corp.example:3128' };

  it('is on only when Node is told to use it AND a proxy is named', () => {
    expect(readEnvProxy({}, [])).toEqual({ on: false, direct: [] });
    // The proxy variables alone change nothing: Node ignores them without the switch (the reviewer's second row).
    expect(readEnvProxy({ HTTP_PROXY: PROXY.HTTP_PROXY }, []).on).toBe(false);
    expect(readEnvProxy({ NODE_USE_ENV_PROXY: '1' }, []).on).toBe(false);
    expect(readEnvProxy(PROXY, []).on).toBe(true);
    for (const key of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy']) expect(readEnvProxy({ NODE_USE_ENV_PROXY: '1', [key]: 'http://p:1' }, []).on, key).toBe(true);
    // ALL_PROXY is not one Node reads (the reviewer's fifth row).
    expect(readEnvProxy({ NODE_USE_ENV_PROXY: '1', ALL_PROXY: 'http://p:1' }, []).on).toBe(false);
    // The switch as a flag: on the command line, or in NODE_OPTIONS.
    expect(readEnvProxy({ HTTP_PROXY: 'http://p:1' }, ['--use-env-proxy']).on).toBe(true);
    expect(readEnvProxy({ HTTP_PROXY: 'http://p:1', NODE_OPTIONS: '--max-old-space-size=4096 --use-env-proxy' }, []).on).toBe(true);
    expect(readEnvProxy({ HTTP_PROXY: 'http://p:1', NODE_OPTIONS: '--use-env-proxy-not' }, []).on).toBe(false);
    for (const v of ['0', 'true', 'yes', '']) expect(readEnvProxy({ NODE_USE_ENV_PROXY: v, HTTP_PROXY: 'http://p:1' }, []).on, v).toBe(false);
  });

  it('with it on, every host goes through it, loopback included, unless NO_PROXY names that host exactly', () => {
    const on = readEnvProxy(PROXY, []);
    for (const host of ['127.0.0.1:11434', '[::1]:8080', 'localhost:11434', 'gpu-box.lan:11434', '127.0.0.1']) expect(viaProxy(host, on), host).toBe(true);
    // A host nobody can name is proxied too.
    expect(viaProxy(undefined, on)).toBe(true);
    // An IPv6 address is named with its brackets, as Node needs it: `::1` alone names nothing (Node proxies it).
    const listed = readEnvProxy({ ...PROXY, NO_PROXY: 'localhost,127.0.0.1,[::1]' }, []);
    expect(listed.direct).toEqual(['localhost', '127.0.0.1', '[::1]']);
    for (const host of ['127.0.0.1:11434', '127.0.0.1', '[::1]:8080', '[::1]', 'localhost:1', 'LOCALHOST:1']) expect(viaProxy(host, listed), host).toBe(false);
    expect(viaProxy('gpu-box.lan:11434', listed)).toBe(true);
    const bare = readEnvProxy({ ...PROXY, NO_PROXY: 'localhost,127.0.0.1,::1' }, []);
    for (const host of ['[::1]:8080', '[::1]']) expect(viaProxy(host, bare), host).toBe(true);
    expect(viaProxy('127.0.0.1:11434', bare)).toBe(false);
    // Either spelling of the variable (the lower-case one alone when both are set, as Node reads them), either
    // separator; `*` is every host only as the whole value.
    expect(readEnvProxy({ ...PROXY, no_proxy: '[::1] 127.0.0.1' }, []).direct).toEqual(['[::1]', '127.0.0.1']);
    expect(viaProxy('127.0.0.1:11434', readEnvProxy({ ...PROXY, NO_PROXY: '127.0.0.1', no_proxy: 'x' }, []))).toBe(true);
    expect(viaProxy('127.0.0.1:11434', readEnvProxy({ ...PROXY, NO_PROXY: 'x', no_proxy: '127.0.0.1' }, []))).toBe(false);
    expect(viaProxy('anything.example:1', readEnvProxy({ ...PROXY, NO_PROXY: '*' }, []))).toBe(false);
    for (const star of ['*,foo', 'foo,*', ' * ']) expect(viaProxy('127.0.0.1:11434', readEnvProxy({ ...PROXY, NO_PROXY: star }, [])), star).toBe(true);
    // Naming `localhost` does not cover the address Flint really asks, which is 127.0.0.1.
    expect(viaProxy('127.0.0.1:11434', readEnvProxy({ ...PROXY, NO_PROXY: 'localhost' }, []))).toBe(true);
  });

  it('an entry that is a suffix, a wildcard or carries a port is not taken as keeping a host direct', () => {
    for (const entry of ['.0.0.1', '*.0.0.1', '127.0.0.1:11434', '0.0.1', '127.0.0', '127.0.0.1.example.com']) {
      expect(viaProxy('127.0.0.1:11434', readEnvProxy({ ...PROXY, NO_PROXY: entry }, [])), entry).toBe(true);
    }
  });

  it('off, nothing is proxied', () => {
    const off = readEnvProxy({ HTTP_PROXY: PROXY.HTTP_PROXY }, []);
    for (const host of ['127.0.0.1:11434', 'gpu-box.lan:11434', undefined]) expect(viaProxy(host, off)).toBe(false);
  });

  it('the config carries it, and no address is local through it: the brain\'s server, and Ollama\'s for the helpers', () => {
    const plain = readInferenceConfig({}, () => {}, { execArgv: [] });
    expect(plain.local.proxy).toEqual({ on: false, direct: [] });
    expect([endpointIsLocal(plain), ollamaIsLocal(plain)]).toEqual([true, true]);
    const proxied = readInferenceConfig(PROXY, () => {}, { execArgv: [] });
    expect(proxied.local.proxy.on).toBe(true);
    expect([endpointIsLocal(proxied), ollamaIsLocal(proxied)]).toEqual([false, false]);
    expect(proxied.problems).toEqual([]); // it is not one of Flint's settings: nothing is "refused"
    // The other wire, and a server Will allowed elsewhere, alike.
    const openai = readInferenceConfig({ ...PROXY, FLINT_LOCAL_PROVIDER: 'openai', FLINT_LOCAL_BASE_URL: 'http://127.0.0.1:8080/v1' }, () => {}, { execArgv: [] });
    expect(endpointIsLocal(openai)).toBe(false);
    const allowed = readInferenceConfig({ ...PROXY, OLLAMA_HOST: 'https://gpu-box.lan:11434', FLINT_LOCAL_ALLOW_REMOTE: '1' }, () => {}, { execArgv: [] });
    expect(endpointIsLocal(allowed)).toBe(false);
    // With the host named in NO_PROXY it is local again.
    const direct = readInferenceConfig({ ...PROXY, NO_PROXY: '127.0.0.1' }, () => {}, { execArgv: [] });
    expect([endpointIsLocal(direct), ollamaIsLocal(direct)]).toEqual([true, true]);
    // An address with no host to check is not local while the proxy is on.
    expect(addressIsLocal({ loopback: true, secure: true }, proxied)).toBe(false);
    expect(addressIsLocal({ loopback: true, secure: true }, plain)).toBe(true);
  });
});

// The final review's L7: `none` was read as a model called "none".
describe('FLINT_LOCAL_FALLBACK_MODEL', () => {
  it('off, or none, in any case: no standby', () => {
    for (const v of ['off', 'OFF', ' Off ', 'none', 'NONE', ' None ']) expect(readInferenceConfig({ FLINT_LOCAL_FALLBACK_MODEL: v }).local.fallbackModel, v).toBe('off');
  });
  it('anything else is a model name, or refused', () => {
    expect(readInferenceConfig({ FLINT_LOCAL_FALLBACK_MODEL: 'small-model:3b' }).local.fallbackModel).toBe('small-model:3b');
    expect(readInferenceConfig({ FLINT_LOCAL_FALLBACK_MODEL: 'nonesuch:1b' }).local.fallbackModel).toBe('nonesuch:1b');
    const bad = readInferenceConfig({ FLINT_LOCAL_FALLBACK_MODEL: 'no model; rm' });
    expect(bad.local.fallbackModel).toBeUndefined();
    expect(bad.problems.map((p) => p.key)).toEqual(['FLINT_LOCAL_FALLBACK_MODEL']);
  });
});

describe('parseLocalUrl', () => {
  it('accepts this Mac by its three names', () => {
    for (const u of ['http://127.0.0.1:11434/v1', 'http://localhost:8080/v1', 'http://[::1]:8080/v1', 'https://127.0.0.1/v1']) {
      expect(parseLocalUrl(u, false), u).toMatchObject({ ok: true, loopback: true });
    }
  });

  it('refuses a host that only looks like this Mac', () => {
    for (const u of ['http://127.0.0.1.evil.example/v1', 'http://localhost.evil.example/v1', 'http://0.0.0.0:11434/v1', 'http://127.0.0.2/v1', 'http://2130706433/v1']) {
      const r = parseLocalUrl(u, false);
      // (2130706433 is 127.0.0.1 as one number: the URL parser turns it into the dotted form, which is this Mac.)
      if (u.includes('2130706433')) expect(r).toMatchObject({ ok: true, loopback: true, host: '127.0.0.1' });
      else expect(r, u).toEqual({ ok: false, reason: 'not_loopback' });
    }
  });

  it('never accepts credentials, a query or a fragment, even from a server elsewhere that is allowed', () => {
    expect(parseLocalUrl('http://a:b@10.0.0.5:8080/v1', true)).toEqual({ ok: false, reason: 'has_credentials' });
    expect(parseLocalUrl('http://10.0.0.5:8080/v1?x=1', true)).toEqual({ ok: false, reason: 'has_query' });
    expect(parseLocalUrl('http://10.0.0.5:8080/v1?', true)).toEqual({ ok: false, reason: 'has_query' });
    expect(parseLocalUrl('http://10.0.0.5:8080/v1#x', true)).toEqual({ ok: false, reason: 'has_query' });
  });

  it('normalises the address it accepts', () => {
    // `localhost`, in any case, is pinned to 127.0.0.1.
    expect(parseLocalUrl('http://LOCALHOST:8080/v1///', false)).toEqual({
      ok: true,
      baseURL: 'http://127.0.0.1:8080/v1',
      origin: 'http://127.0.0.1:8080',
      path: '/v1',
      loopback: true,
      host: '127.0.0.1:8080',
      secure: true,
    });
    expect(parseLocalUrl('http://[::1]:8080/v1', false)).toMatchObject({ origin: 'http://[::1]:8080', loopback: true });
    // A name that only starts with it is somebody else's, and is not rewritten.
    expect(parseLocalUrl('http://localhost.example.com/v1', true)).toMatchObject({ origin: 'http://localhost.example.com', loopback: false });
    expect(parseLocalUrl('http://10.0.0.5:8080/v1', true, { refuseInsecureRemote: true })).toEqual({ ok: false, reason: 'insecure_remote' });
    expect(parseLocalUrl('https://10.0.0.5:8080/v1', true, { refuseInsecureRemote: true })).toMatchObject({ ok: true, secure: true });
    expect(parseLocalUrl('http://127.0.0.1:11434', false, { defaultPath: '/v1' })).toMatchObject({ baseURL: 'http://127.0.0.1:11434/v1', path: '/v1' });
    expect(parseLocalUrl('http://127.0.0.1:11434/', false)).toMatchObject({ baseURL: 'http://127.0.0.1:11434', path: '' });
  });
});

describe('FLINT_EMBED_MODEL: the embedding model, in place of the tier table\'s', () => {
  it('a model name is read; unset is the table\'s; a value that is not a model name is refused and ignored', () => {
    expect(readInferenceConfig({}).local.embedModel).toBeUndefined();
    expect(readInferenceConfig({ FLINT_EMBED_MODEL: ' mxbai-embed-large ' }).local.embedModel).toBe('mxbai-embed-large');
    const bad = read({ FLINT_EMBED_MODEL: 'nomic; rm -rf ~' });
    expect(bad.cfg.local.embedModel).toBeUndefined();
    expect(bad.cfg.problems).toEqual([{ key: 'FLINT_EMBED_MODEL', reason: 'written with characters that are not allowed', kind: 'invalid' }]);
    expect(bad.warned.join('\n')).not.toContain('rm -rf');
  });

  // The final review's L6: the one model tag here that had no cloud check. A cloud embedding model would send
  // every fact Flint stores and every question it recalls with to Ollama's servers.
  it("one of Ollama's cloud models is refused, like every other model tag here", () => {
    for (const cloud of ['embed-big:cloud', 'embed-big-cloud', 'some-embed:120b-cloud']) {
      const r = read({ FLINT_EMBED_MODEL: cloud });
      expect(r.cfg.local.embedModel, cloud).toBeUndefined();
      expect(r.cfg.problems, cloud).toEqual([{ key: 'FLINT_EMBED_MODEL', reason: 'an Ollama cloud model does not run on this Mac', kind: 'cloud_model' }]);
    }
  });
});

describe('a context size is one rule, wherever it is read', () => {
  it('plain digits from 256 to 1,048,576; anything else is no size', () => {
    expect(readContextSize('8192')).toBe(8192);
    expect(readContextSize(' 32768 ')).toBe(32768);
    expect(readContextSize('256')).toBe(256);
    expect(readContextSize('1048576')).toBe(1048576);
    for (const bad of [undefined, '', '  ', '255', '1048577', '8192.5', '1e9', '-8192', '0x2000', 'Infinity', 'NaN', '8192 tokens', '99999999999']) expect(readContextSize(bad), String(bad)).toBeUndefined();
  });
});

describe('every key has a schema', () => {
  it('lists the keys this module reads', () => {
    expect(Object.keys(SCHEMAS).sort()).toEqual(
      [
        'FLINT_EMBED_MODEL',
        'FLINT_INFERENCE_MODE',
        'FLINT_LOCAL_ALLOW_INSECURE_REMOTE',
        'FLINT_LOCAL_ALLOW_REMOTE',
        'FLINT_LOCAL_API_KEY',
        'FLINT_LOCAL_CONNECT_TIMEOUT_MS',
        // Voice (./voice; its own tests are in voice.test.ts).
        'FLINT_STT_PROVIDER',
        'FLINT_TTS_PROVIDER',
        'FLINT_LOCAL_STT_MODEL',
        'FLINT_LOCAL_TTS_MODEL',
        'FLINT_LOCAL_TTS_VOICE',
        'FLINT_LOCAL_VOICE_API_KEY',
        'FLINT_SAY_VOICE',
        // Older than this module, and read here now: OpenAI's speech model and voice, whisper.cpp and its model.
        'FLINT_TTS_MODEL',
        'FLINT_TTS_VOICE',
        'WHISPER_BIN',
        'WHISPER_MODEL',
        'FLINT_LOCAL_FALLBACK_MODEL',
        'FLINT_LOCAL_FALLBACK_NUM_CTX',
        'FLINT_LOCAL_FIRST_OUTPUT_TIMEOUT_MS',
        'FLINT_LOCAL_HEALTH_INTERVAL_MS',
        'FLINT_LOCAL_IDLE_TIMEOUT_MS',
        'FLINT_LOCAL_MODEL',
        'FLINT_LOCAL_PROVIDER',
        'FLINT_LOCAL_REQUEST_TIMEOUT_MS',
        'FLINT_LOCAL_SERVER',
        'FLINT_LOCAL_TOOLS',
        'FLINT_LOCAL_TOOL_PASS_TIMEOUT_MS',
        // Pictures and PDFs for the local model (./local-media): both ship off.
        'FLINT_LOCAL_VISION',
        'FLINT_LOCAL_PDF',
        'FLINT_HARDWARE_TIER',
        'OLLAMA_MODEL',
        'OLLAMA_NUM_CTX',
      ].sort(),
    );
  });
});

// Pictures and PDFs for the local model. Both settings ship off, and off is exactly what Flint did before them.
describe('FLINT_LOCAL_VISION and FLINT_LOCAL_PDF', () => {
  const have = (...paths: string[]): FileCheck => (path, kind) => kind === 'program' && paths.includes(path);
  const readWith = (env: Record<string, string | undefined>, fileExists?: FileCheck) => {
    const warned: string[] = [];
    const cfg = readInferenceConfig(env, (m) => warned.push(m), fileExists ? { fileExists } : {});
    return { cfg, warned };
  };

  it('with nothing set both are off, and nothing is said', () => {
    const { cfg, warned } = readWith({}, have('/usr/bin/mdimport'));
    expect(cfg.local.vision).toBe(false);
    expect(cfg.local.pdf).toBeUndefined();
    expect(cfg.problems).toEqual([]);
    expect(warned).toEqual([]);
  });

  it('pictures: on or off, in any case, and nothing else', () => {
    expect(readWith({ FLINT_LOCAL_VISION: 'on' }).cfg.local.vision).toBe(true);
    expect(readWith({ FLINT_LOCAL_VISION: ' ON ' }).cfg.local.vision).toBe(true);
    expect(readWith({ FLINT_LOCAL_VISION: 'off' }).cfg.local.vision).toBe(false);
    expect(readWith({ FLINT_LOCAL_VISION: 'off' }).cfg.problems).toEqual([]);
    for (const bad of ['1', 'true', 'yes', 'auto', 'on; rm -rf /']) {
      const { cfg, warned } = readWith({ FLINT_LOCAL_VISION: bad });
      expect(cfg.local.vision, bad).toBe(false);
      expect(cfg.problems.map((p) => p.key)).toEqual(['FLINT_LOCAL_VISION']);
      expect(warned.join('\n')).toContain('no picture is sent to the local model');
      expect(JSON.stringify(cfg.problems) + warned.join('\n')).not.toContain(bad);
    }
  });

  it('PDFs: the reader it names, with its program as a full path that is on this Mac', () => {
    expect(PDF_READERS).toEqual(['off', 'spotlight', 'pdftotext']);
    expect(readWith({ FLINT_LOCAL_PDF: 'spotlight' }, have('/usr/bin/mdimport')).cfg.local.pdf).toEqual({ reader: 'spotlight', program: '/usr/bin/mdimport' });
    expect(readWith({ FLINT_LOCAL_PDF: ' Spotlight ' }, have('/usr/bin/mdimport')).cfg.local.pdf).toEqual({ reader: 'spotlight', program: '/usr/bin/mdimport' });
    expect(readWith({ FLINT_LOCAL_PDF: 'off' }, have('/usr/bin/mdimport')).cfg.local.pdf).toBeUndefined();
    expect(readWith({ FLINT_LOCAL_PDF: 'off' }, have()).cfg.problems).toEqual([]);
    // Homebrew's folder on Apple silicon first, then on Intel: whichever has it.
    expect(readWith({ FLINT_LOCAL_PDF: 'pdftotext' }, have('/opt/homebrew/bin/pdftotext', '/usr/local/bin/pdftotext')).cfg.local.pdf).toEqual({ reader: 'pdftotext', program: '/opt/homebrew/bin/pdftotext' });
    expect(readWith({ FLINT_LOCAL_PDF: 'pdftotext' }, have('/usr/local/bin/pdftotext')).cfg.local.pdf).toEqual({ reader: 'pdftotext', program: '/usr/local/bin/pdftotext' });
    for (const list of Object.values(PDF_READER_PROGRAMS)) for (const p of list) expect(p).toMatch(/^\/[A-Za-z0-9/_.-]+$/);
  });

  it('a reader whose program is not on this Mac is refused by name, and no PDF is read: nothing is installed for it', () => {
    const { cfg, warned } = readWith({ FLINT_LOCAL_PDF: 'pdftotext' }, have('/usr/bin/mdimport'));
    expect(cfg.local.pdf).toBeUndefined();
    expect(cfg.problems).toEqual([{ key: 'FLINT_LOCAL_PDF', reason: 'set to pdftotext, which is not installed on this Mac', kind: 'missing' }]);
    expect(warned.join('\n')).toContain('no PDF is read on this Mac');
    const none = readWith({ FLINT_LOCAL_PDF: 'spotlight' }, have());
    expect(none.cfg.local.pdf).toBeUndefined();
    expect(none.cfg.problems).toEqual([{ key: 'FLINT_LOCAL_PDF', reason: "set to spotlight, and this machine does not have the Mac's own PDF importer", kind: 'missing' }]);
  });

  it('the program has to be one that can be run: the check is asked for a program, not for a file', () => {
    const asked: Array<[string, string]> = [];
    readWith({ FLINT_LOCAL_PDF: 'spotlight' }, (path, kind) => (asked.push([path, kind]), true));
    expect(asked).toEqual([['/usr/bin/mdimport', 'program']]);
  });

  it('a value that is not a reader is refused, never repeated, and never becomes a program or a path', () => {
    for (const bad of ['/usr/bin/mdimport', 'mdimport', 'poppler', 'yes', '/tmp/evil.sh', 'spotlight; rm -rf /']) {
      const { cfg, warned } = readWith({ FLINT_LOCAL_PDF: bad }, () => true);
      expect(cfg.local.pdf, bad).toBeUndefined();
      expect(cfg.problems.map((p) => [p.key, p.kind])).toEqual([['FLINT_LOCAL_PDF', 'invalid']]);
      expect(JSON.stringify(cfg.problems) + warned.join('\n')).not.toContain(bad);
    }
  });

  it('with no file check handed in (a caller that only reads the settings), the reader is taken at its first path', () => {
    expect(readInferenceConfig({ FLINT_LOCAL_PDF: 'pdftotext' }).local.pdf).toEqual({ reader: 'pdftotext', program: '/opt/homebrew/bin/pdftotext' });
  });

  it('neither setting changes any other: the config is the same with both on, but for the two fields', () => {
    const off = readWith({}, have('/usr/bin/mdimport')).cfg;
    const on = readWith({ FLINT_LOCAL_VISION: 'on', FLINT_LOCAL_PDF: 'spotlight' }, have('/usr/bin/mdimport')).cfg;
    expect({ ...on, local: { ...on.local, vision: false, pdf: undefined } }).toEqual(off);
  });
});

// OLLAMA_MODEL and OLLAMA_NUM_CTX are older than this module, and other parts of the server read
// them as they are. Here they are checked before a value reaches a request, a log or a status.
describe('OLLAMA_MODEL and OLLAMA_NUM_CTX, where they feed local inference', () => {
  it('valid values are read', () => {
    const cfg = readInferenceConfig({ OLLAMA_MODEL: ' muse-glimmer:30b ', OLLAMA_NUM_CTX: '16384' });
    expect(cfg.local.ollamaModel).toBe('muse-glimmer:30b');
    expect(cfg.local.numCtx).toBe(16384);
    expect(cfg.problems).toEqual([]);
  });

  it('unset or blank: undefined, and no problem', () => {
    for (const env of [{}, { OLLAMA_MODEL: '', OLLAMA_NUM_CTX: '  ' }]) {
      const cfg = readInferenceConfig(env);
      expect(cfg.local.ollamaModel).toBeUndefined();
      expect(cfg.local.numCtx).toBeUndefined();
      expect(cfg.problems).toEqual([]);
    }
  });

  it('a model name that is not one is ignored and reported by key, never by value', () => {
    for (const bad of ['two words', 'x'.repeat(101), 'name\n[local] injected', '$(touch /tmp/x)', 'a;b']) {
      const lines: string[] = [];
      const cfg = readInferenceConfig({ OLLAMA_MODEL: bad }, (m) => lines.push(m));
      expect(cfg.local.ollamaModel, bad).toBeUndefined();
      expect(cfg.problems.map((p) => p.key)).toEqual(['OLLAMA_MODEL']);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/^\[inference\] OLLAMA_MODEL is .*; ignored, so the model server is asked what it has$/);
      expect(lines[0]).not.toContain('injected');
      expect(lines[0]).not.toContain('touch');
    }
  });

  it('a context size that is not a whole number in range is ignored and reported', () => {
    for (const bad of ['abc', '16k', '-1', '0', '255', '1048577', '1e4', '4096.5', '99999999']) {
      const lines: string[] = [];
      const cfg = readInferenceConfig({ OLLAMA_NUM_CTX: bad }, (m) => lines.push(m));
      expect(cfg.local.numCtx, bad).toBeUndefined();
      expect(cfg.problems.map((p) => p.key), bad).toEqual(['OLLAMA_NUM_CTX']);
      expect(lines[0]).toContain("ignored, so the model's own context is used");
    }
    expect(readInferenceConfig({ OLLAMA_NUM_CTX: '256' }).local.numCtx).toBe(256);
    expect(readInferenceConfig({ OLLAMA_NUM_CTX: '1048576' }).local.numCtx).toBe(1048576);
  });

  it('FLINT_LOCAL_FALLBACK_NUM_CTX: the standby\'s context, checked the same way', () => {
    expect(readInferenceConfig({}).local.fallbackNumCtx).toBeUndefined();
    expect(readInferenceConfig({ FLINT_LOCAL_FALLBACK_NUM_CTX: '8192' }).local.fallbackNumCtx).toBe(8192);
    const lines: string[] = [];
    const bad = readInferenceConfig({ FLINT_LOCAL_FALLBACK_NUM_CTX: 'big' }, (m) => lines.push(m));
    expect(bad.local.fallbackNumCtx).toBeUndefined();
    expect(bad.problems.map((p) => p.key)).toEqual(['FLINT_LOCAL_FALLBACK_NUM_CTX']);
    expect(lines[0]).toContain("ignored, so the hardware tier's standby context is used");
  });

  it("a cloud tag in OLLAMA_MODEL is a model's name here: ./local-brains refuses it as the local brain, and says so", () => {
    const cfg = readInferenceConfig({ OLLAMA_MODEL: 'big-model:120b-cloud' });
    expect(cfg.local.ollamaModel).toBe('big-model:120b-cloud');
    expect(cfg.problems).toEqual([]);
  });
});
