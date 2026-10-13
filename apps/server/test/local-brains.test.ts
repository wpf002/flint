import { describe, it, expect, afterEach } from 'vitest';
import { OllamaProvider, isFlintError, type Message, type StreamEvent, type ToolDefinition } from '@flint/core';
import { readInferenceConfig } from '../src/inference-config';
import { hardwareTier } from '@flint/core';
import { NO_LOCAL_MODEL, UNSETTLED, buildLocalBrains, disabledProvider, safeModelId, standbyContext, standbyModel, startLocalBrains, toolsAllowed, type LocalBrains, type LocalHandle } from '../src/local-brains';
import { liveOllamaOptions } from '../src/local-model';
import { startMockLocalServer, type MockLocalServer, type MockModel } from './mock-local-server';

/**
 * The local brain on either wire: with nothing new set it is today's Ollama
 * client, request for request; FLINT_LOCAL_PROVIDER=openai builds the
 * OpenAI-compatible adapter; a refused address builds a provider that is off;
 * and what the model can do comes from the server's own report.
 */

let server: MockLocalServer | undefined;
const handles: LocalHandle[] = [];
afterEach(async () => {
  for (const h of handles.splice(0)) h.stop();
  await server?.close();
  server = undefined;
});

const MAIN = 'main-model:30b';
const user: Message = { id: 'u1', role: 'user', content: 'hi', timestamp: 0 };
const tool: ToolDefinition = { name: 'get_weather', description: 'Weather', inputSchema: { type: 'object', properties: {} }, idempotent: true };

/** A network that is not there: for a test whose address is not this Mac, so nothing is ever sent to it. */
const offline = (async () => {
  throw new TypeError('fetch failed');
}) as unknown as typeof fetch;

async function build(env: Record<string, string | undefined>, opts: { on?: () => boolean; connects?: number[]; fetch?: typeof fetch; tier?: ReturnType<typeof hardwareTier> } = {}) {
  const lines: string[] = [];
  const cfg = readInferenceConfig(env, (m) => lines.push(m));
  const brains = await buildLocalBrains({
    cfg,
    env,
    deadlinesOn: opts.on ?? (() => false),
    connect: async (_h, _p, ms) => void opts.connects?.push(ms),
    log: (m) => lines.push(m),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.tier ? { tier: opts.tier } : {}),
    pick: { capMs: 500 },
  });
  return { brains, lines, cfg };
}

async function start(models: Record<string, MockModel>, kind: MockLocalServer['kind'] = 'ollama') {
  server = await startMockLocalServer({ kind, models });
  return server;
}

async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

describe('the native wire (nothing new set)', () => {
  it("is today's Ollama client: the same requests, to the same place, for the same model", async () => {
    const s = await start({ [MAIN]: { loaded: true, contextLength: 16384 } });
    const env = { OLLAMA_HOST: s.origin, OLLAMA_MODEL: MAIN, OLLAMA_NUM_CTX: '16384', OLLAMA_THINK: 'false' };
    const { brains } = await build(env);
    expect(brains.wire).toBe('ollama');
    expect(brains.server).toBe('ollama');
    expect(brains.primary).toMatchObject({ which: 'primary', model: MAIN, label: `ollama:${MAIN}`, from: 'env', numCtx: 16384 });
    expect(brains.primary.provider.name).toBe('ollama');

    // The same call through the plain client main() used to build, and through this one.
    const before = new OllamaProvider(liveOllamaOptions(env));
    s.requests.length = 0;
    await before.generate({ model: MAIN, messages: [user], tools: [tool] });
    await brains.primary.provider.generate({ model: MAIN, messages: [user], tools: [tool] });
    const [was, now] = s.chats();
    expect(now!.path).toBe('/api/chat');
    expect(now!.body).toEqual(was!.body);
    expect(now!.body).toMatchObject({ model: MAIN, stream: false, think: false, options: { num_ctx: 16384 } });
  });

  it('OLLAMA_MODEL unset: Ollama is asked which chat model it has, and a loaded one keeps the window it is loaded with', async () => {
    const s = await start({ [MAIN]: { loaded: true, contextLength: 16384 }, 'other-model:7b': {} });
    const { brains, lines } = await build({ OLLAMA_HOST: s.origin });
    expect(brains.primary).toMatchObject({ model: MAIN, from: 'loaded', numCtx: 16384 });
    // What memory extraction and background calls read, so they ask the same model at the same window.
    expect(brains.primary.env).toEqual({ OLLAMA_MODEL: MAIN, OLLAMA_NUM_CTX: '16384' });
    expect(lines.some((l) => l.includes(`OLLAMA_MODEL is unset: the local brain is ${MAIN}, which Ollama has loaded`))).toBe(true);
    // And the monitor expects that window, so the model reads as loaded, not as needing a reload.
    expect(brains.monitor.snapshot().primary.state).toBe('loaded');
  });

  it('a named model settles as itself', async () => {
    const s = await start({ [MAIN]: {} });
    const { brains } = await build({ OLLAMA_HOST: s.origin, OLLAMA_MODEL: MAIN });
    expect(brains.primary.env).toEqual({ OLLAMA_MODEL: MAIN });
  });

  it('an OLLAMA_NUM_CTX that is not a context size never reaches a request: the model keeps the window it is loaded with', async () => {
    const s = await start({ [MAIN]: { loaded: true, contextLength: 8192 } });
    const { brains, lines } = await build({ OLLAMA_HOST: s.origin, OLLAMA_NUM_CTX: 'lots' });
    expect(brains.primary).toMatchObject({ model: MAIN, from: 'loaded', numCtx: 8192 });
    await brains.primary.provider.generate({ model: MAIN, messages: [user] });
    expect((s.chats().at(-1)!.body!.options as { num_ctx: unknown }).num_ctx).toBe(8192);
    expect(lines.some((l) => l.startsWith('[inference] OLLAMA_NUM_CTX is '))).toBe(true);
    // With a named model and nothing loaded to copy, it is the client's own default, a number.
    const named = await build({ OLLAMA_HOST: s.origin, OLLAMA_MODEL: MAIN, OLLAMA_NUM_CTX: '-5' });
    expect(named.brains.primary.numCtx).toBe(4096);
  });

  it('an OLLAMA_MODEL that is not a model name names nothing: the server is asked what it has', async () => {
    const s = await start({ [MAIN]: { loaded: true, contextLength: 16384 } });
    const { brains, lines } = await build({ OLLAMA_HOST: s.origin, OLLAMA_MODEL: 'two words; rm -rf' });
    expect(brains.primary).toMatchObject({ model: MAIN, from: 'loaded' });
    expect(lines.join('\n')).not.toContain('rm -rf');
    expect(s.requests.some((r) => r.model === 'two words; rm -rf')).toBe(false);
  });

  it('FLINT_LOCAL_MODEL names the model ahead of OLLAMA_MODEL', async () => {
    const s = await start({ [MAIN]: {}, 'other-model:7b': {} });
    const { brains } = await build({ OLLAMA_HOST: s.origin, OLLAMA_MODEL: MAIN, FLINT_LOCAL_MODEL: 'other-model:7b' });
    expect(brains.primary).toMatchObject({ model: 'other-model:7b', from: 'env' });
  });

  it('takes one look at the server at boot and says what it found, with the host and nothing more of the address', async () => {
    const s = await start({ [MAIN]: { loaded: true, contextLength: 16384 } });
    const { brains, lines } = await build({ OLLAMA_HOST: s.origin, OLLAMA_MODEL: MAIN, OLLAMA_NUM_CTX: '16384' });
    const host = new URL(s.origin).host;
    expect(lines).toContain(`[local] primary ${MAIN}: loaded (context 16384)`);
    expect(lines).toContain(`[local] provider=ollama wire=native server=ollama 0.34.4 host=${host} loopback=yes`);
    expect(brains.monitor.snapshot().primary.state).toBe('loaded');
    expect(brains.confined).toEqual({ ok: true });
    // Boot never loads or downloads anything: probes only.
    expect(s.requests.map((r) => r.path).sort()).toEqual(['/api/ps', '/api/show', '/api/tags', '/api/version']);
  });

  it('with the server down at boot, the brain is still built and is unavailable (unreachable)', async () => {
    const s = await start({});
    const origin = s.origin;
    await s.close();
    server = undefined;
    const { brains, lines } = await build({ OLLAMA_HOST: origin, OLLAMA_MODEL: MAIN });
    expect(brains.primary.model).toBe(MAIN);
    expect(brains.monitor.snapshot().primary).toMatchObject({ state: 'unavailable', why: 'unreachable' });
    expect(lines).toContain(`[local] primary ${MAIN}: unavailable (unreachable)`);
  });

  it('a model that is not downloaded: unavailable (not_installed), and the log has the pull command (nothing is pulled)', async () => {
    const s = await start({});
    const { brains, lines } = await build({ OLLAMA_HOST: s.origin, OLLAMA_MODEL: MAIN });
    expect(brains.monitor.snapshot().primary).toMatchObject({ state: 'unavailable', why: 'not_installed' });
    expect(lines).toContain(`[local] primary ${MAIN}: unavailable (not_installed). To download it, run: ollama pull ${MAIN}`);
    expect(s.requests.some((r) => /pull/.test(r.path))).toBe(false);
  });
});

describe('what the local model may do comes from the server, not a guess', () => {
  it("auto: a model the server says can call tools is 'native' and is sent them", async () => {
    const s = await start({ [MAIN]: { loaded: true, capabilities: ['completion', 'tools'] } });
    const { brains } = await build({ OLLAMA_HOST: s.origin, OLLAMA_MODEL: MAIN });
    expect(brains.primary.provider.getCapabilities(MAIN).toolCalling).toBe('native');
    await brains.primary.provider.generate({ model: MAIN, messages: [user], tools: [tool] });
    expect((s.chats()[0]!.body!.tools as unknown[]).length).toBe(1);
  });

  it("auto: a model the server says cannot is 'unsupported' and is sent none (Ollama would answer 400 every turn)", async () => {
    const s = await start({ [MAIN]: { loaded: true, capabilities: ['completion'] } });
    const { brains } = await build({ OLLAMA_HOST: s.origin, OLLAMA_MODEL: MAIN });
    expect(brains.primary.provider.getCapabilities(MAIN).toolCalling).toBe('unsupported');
    await brains.primary.provider.generate({ model: MAIN, messages: [user], tools: [tool] });
    expect('tools' in s.chats()[0]!.body!).toBe(false);
  });

  it("auto, with the server down at boot: the flag is 'unsupported' until the server has been asked, and then it is right", async () => {
    const s = await start({ [MAIN]: { loaded: true, capabilities: ['completion', 'tools'] } });
    // Down at boot: every probe route is missing.
    s.kind = 'openai';
    const { brains } = await build({ OLLAMA_HOST: s.origin, OLLAMA_MODEL: MAIN });
    expect(brains.monitor.snapshot().reachable).toBe(false);
    expect(brains.primary.provider.getCapabilities(MAIN).toolCalling).toBe('unsupported');
    // Back up. Nobody restarts Flint: asking about the model set off a look, and the next look finds it.
    s.kind = 'ollama';
    await brains.monitor.check();
    expect(brains.primary.provider.getCapabilities(MAIN).toolCalling).toBe('native');
  });

  it('FLINT_LOCAL_TOOLS=off offers none whatever the server says; on offers them whatever it says', async () => {
    const s = await start({ [MAIN]: { loaded: true, capabilities: ['completion', 'tools'] } });
    const off = await build({ OLLAMA_HOST: s.origin, OLLAMA_MODEL: MAIN, FLINT_LOCAL_TOOLS: 'off' });
    expect(off.brains.primary.provider.getCapabilities(MAIN).toolCalling).toBe('unsupported');
    s.models.get(MAIN)!.capabilities = ['completion'];
    const on = await build({ OLLAMA_HOST: s.origin, OLLAMA_MODEL: MAIN, FLINT_LOCAL_TOOLS: 'on' });
    expect(on.brains.primary.provider.getCapabilities(MAIN).toolCalling).toBe('native');
  });

  it('toolsAllowed', () => {
    expect(toolsAllowed('on', undefined)).toBe(true);
    expect(toolsAllowed('off', { tools: true })).toBe(false);
    expect(toolsAllowed('auto', { tools: true })).toBe(true);
    expect(toolsAllowed('auto', { tools: false })).toBe(false);
    expect(toolsAllowed('auto', undefined)).toBeUndefined();
    expect(toolsAllowed('auto', {})).toBeUndefined();
  });

  it("the history budget follows OLLAMA_NUM_CTX: 16,384 is a 16,384-token window", async () => {
    const s = await start({ [MAIN]: { loaded: true, contextLength: 16384 } });
    const { brains } = await build({ OLLAMA_HOST: s.origin, OLLAMA_MODEL: MAIN, OLLAMA_NUM_CTX: '16384' });
    expect(brains.primary.provider.getCapabilities(MAIN).maxContextTokens).toBe(16384);
  });
});

describe('FLINT_LOCAL_PROVIDER=openai', () => {
  const openai = (s: MockLocalServer, more: Record<string, string> = {}) => ({ FLINT_LOCAL_PROVIDER: 'openai', FLINT_LOCAL_BASE_URL: s.baseURL, OLLAMA_MODEL: MAIN, ...more });

  it("builds the OpenAI-compatible adapter ('local'), which posts to /v1/chat/completions on that server only", async () => {
    const s = await start({ [MAIN]: { loaded: true, contextLength: 16384, capabilities: ['completion', 'tools'] } });
    const { brains, lines } = await build(openai(s));
    expect(brains.wire).toBe('openai');
    expect(brains.server).toBe('ollama');
    expect(brains.primary).toMatchObject({ model: MAIN, label: `local:${MAIN}`, numCtx: undefined });
    expect(brains.primary.provider.name).toBe('local');
    const events = await collect(brains.primary.provider.stream({ model: MAIN, messages: [user] }));
    expect(events.map((e) => e.type)).toContain('done');
    expect(s.chats()[0]).toMatchObject({ path: '/v1/chat/completions', model: MAIN });
    expect(lines.some((l) => l.startsWith('[local] provider=openai wire=openai-compatible server=ollama 0.34.4 host='))).toBe(true);
  });

  it('the window is what the server has the model loaded with, and tools only when the server says so', async () => {
    const s = await start({ [MAIN]: { loaded: true, contextLength: 32768, capabilities: ['completion', 'tools', 'vision'] } });
    const { brains } = await build(openai(s, { OLLAMA_NUM_CTX: '16384' }));
    expect(brains.primary.provider.getCapabilities(MAIN)).toMatchObject({ maxContextTokens: 32768, toolCalling: 'native', vision: true });
    s.models.get(MAIN)!.capabilities = ['completion'];
    const none = await build(openai(s));
    expect(none.brains.primary.provider.getCapabilities(MAIN).toolCalling).toBe('unsupported');
  });

  it('a model nothing is known about gets no tools and a small window', async () => {
    const s = await start({ [MAIN]: {} }, 'openai');
    const { brains } = await build(openai(s));
    expect(brains.server).toBe('openai');
    expect(brains.primary.provider.getCapabilities(MAIN)).toMatchObject({ toolCalling: 'unsupported', maxContextTokens: 4096 });
  });

  it('llama.cpp: detected by /health; with no model named, the one the server lists', async () => {
    const s = await start({ 'model.gguf': { loaded: true } }, 'llamacpp');
    const { brains } = await build({ FLINT_LOCAL_PROVIDER: 'openai', FLINT_LOCAL_BASE_URL: s.baseURL });
    expect(brains.server).toBe('llamacpp');
    expect(brains.primary).toMatchObject({ model: 'model.gguf', from: 'server' });
    expect(brains.monitor.snapshot().primary.state).toBe('loaded');
  });

  it('the connect check and the deadlines apply only while deadlinesOn says so (not in the cloud mode)', async () => {
    const s = await start({ [MAIN]: { loaded: true } });
    let on = false;
    const connects: number[] = [];
    const { brains } = await build(openai(s, { FLINT_LOCAL_CONNECT_TIMEOUT_MS: '700', FLINT_LOCAL_FIRST_OUTPUT_TIMEOUT_MS: '500' }), { on: () => on, connects });
    await collect(brains.primary.provider.stream({ model: MAIN, messages: [user] }));
    expect(connects).toEqual([]);
    on = true;
    await collect(brains.primary.provider.stream({ model: MAIN, messages: [user] }));
    expect(connects).toEqual([700]);
    // A model that never answers: off, only the caller ends it; on, the first-token deadline does.
    s.models.get(MAIN)!.stall = true;
    const events = await collect(brains.primary.provider.stream({ model: MAIN, messages: [user] }));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', error: { providerCode: 'first_token_timeout', retryable: false } });
  });

  it('a refused FLINT_LOCAL_BASE_URL builds a provider that is off: unavailable (config), and every call fails at once', async () => {
    const { brains, lines } = await build({ FLINT_LOCAL_PROVIDER: 'openai', FLINT_LOCAL_BASE_URL: 'http://192.168.1.20:8080/v1', OLLAMA_MODEL: MAIN });
    expect(brains.endpoint).toBeUndefined();
    expect(brains.backend).toBeUndefined();
    expect(brains.confined).toEqual({ ok: false, why: 'config' });
    expect(brains.monitor.snapshot().primary).toMatchObject({ state: 'unavailable', why: 'config' });
    const err = await brains.primary.provider.generate({ model: MAIN, messages: [user] }).catch((e: unknown) => e);
    expect(isFlintError(err) && err.error.kind).toBe('provider_unavailable');
    const events = await collect(brains.primary.provider.stream({ model: MAIN, messages: [user] }));
    expect(events).toEqual([expect.objectContaining({ type: 'error' })]);
    // The address is named by key, never repeated.
    expect(lines.join('\n')).not.toContain('192.168.1.20');
    expect(lines.some((l) => l.includes('FLINT_LOCAL_BASE_URL is not on this Mac'))).toBe(true);
    expect(lines).toContain('[local] provider=openai wire=openai-compatible server=unknown host=refused loopback=n/a');
  });

  it('with FLINT_LOCAL_ALLOW_REMOTE=1 a server elsewhere is used, and the log says it is not this Mac', async () => {
    const { brains, lines } = await build(
      { FLINT_LOCAL_PROVIDER: 'openai', FLINT_LOCAL_BASE_URL: 'http://192.168.1.20:8080/v1', FLINT_LOCAL_ALLOW_REMOTE: '1', FLINT_LOCAL_ALLOW_INSECURE_REMOTE: '1', FLINT_LOCAL_SERVER: 'openai', OLLAMA_MODEL: MAIN },
      { fetch: offline },
    );
    expect(brains.endpoint).toEqual({ host: '192.168.1.20:8080', loopback: false });
    expect(brains.confined).toEqual({ ok: true });
    expect(lines.some((l) => l.endsWith('host=192.168.1.20:8080 loopback=no'))).toBe(true);
  });
});

describe('"local" must mean this Mac in the local and hybrid modes', () => {
  it('a remote OLLAMA_HOST is not confined unless Will allows it; the cloud mode uses it as before', async () => {
    const remote = await build({ OLLAMA_HOST: 'http://gpu-box.invalid:11434', OLLAMA_MODEL: MAIN }, { fetch: offline });
    expect(remote.brains.confined).toEqual({ ok: false, why: 'remote_host' });
    expect(remote.brains.primary.provider.name).toBe('ollama');
    expect(remote.lines).toContain('[local] the local model server is not this Mac: the local and hybrid modes will not use it unless FLINT_LOCAL_ALLOW_REMOTE=1');
    // Will's say alone is not enough over plain http: every prompt would cross the network in the clear.
    const plain = await build({ OLLAMA_HOST: 'http://gpu-box.invalid:11434', OLLAMA_MODEL: MAIN, FLINT_LOCAL_ALLOW_REMOTE: '1' }, { fetch: offline });
    expect(plain.brains.confined).toEqual({ ok: false, why: 'remote_host' });
    const allowed = await build({ OLLAMA_HOST: 'https://gpu-box.invalid:11434', OLLAMA_MODEL: MAIN, FLINT_LOCAL_ALLOW_REMOTE: '1' }, { fetch: offline });
    expect(allowed.brains.confined).toEqual({ ok: true });
    const privateNet = await build({ OLLAMA_HOST: 'http://gpu-box.invalid:11434', OLLAMA_MODEL: MAIN, FLINT_LOCAL_ALLOW_REMOTE: '1', FLINT_LOCAL_ALLOW_INSECURE_REMOTE: '1' }, { fetch: offline });
    expect(privateNet.brains.confined).toEqual({ ok: true });
  });

  it('OLLAMA_HOST=http://localhost:11434: every request goes to 127.0.0.1, the address the guard holds it to', async () => {
    const s = await start({ [MAIN]: { loaded: true, contextLength: 16384 } });
    const port = new URL(s.origin).port;
    const { brains } = await build({ OLLAMA_HOST: `http://localhost:${port}`, OLLAMA_MODEL: MAIN, OLLAMA_NUM_CTX: '16384' });
    expect(brains.endpoint).toEqual({ host: `127.0.0.1:${port}`, loopback: true });
    expect((brains.primary.provider as { baseURL?: string }).baseURL).toBe(`http://127.0.0.1:${port}`);
    const out = await brains.primary.provider.generate({ model: MAIN, messages: [user] });
    expect(out.message.content).toContain('reply from');
    expect(brains.monitor.snapshot().primary.state).toBe('loaded');
  });

  it("an Ollama cloud model is never the local brain: on Ollama's own API it is refused and another is picked", async () => {
    const s = await start({ [MAIN]: { loaded: true, contextLength: 16384 } });
    const { brains, lines } = await build({ OLLAMA_HOST: s.origin, OLLAMA_MODEL: 'big-model:120b-cloud' });
    expect(brains.primary).toMatchObject({ model: MAIN, from: 'loaded' });
    expect(brains.confined).toEqual({ ok: true });
    expect(lines.some((l) => l.includes('OLLAMA_MODEL is an Ollama cloud model'))).toBe(true);
  });

  it('on the OpenAI-compatible wire too: a cloud model named by OLLAMA_MODEL is refused, and the server is asked what it has', async () => {
    const s = await start({ [MAIN]: { loaded: true, contextLength: 16384 } });
    const { brains, lines } = await build({ FLINT_LOCAL_PROVIDER: 'openai', FLINT_LOCAL_BASE_URL: s.baseURL, OLLAMA_MODEL: 'big-model:120b-cloud' });
    expect(brains.primary).toMatchObject({ model: MAIN, from: 'loaded', settled: true });
    expect(brains.confined).toEqual({ ok: true });
    expect(lines.some((l) => l.includes("runs on Ollama's servers"))).toBe(true);
    // Nothing was ever asked of the cloud model.
    expect(s.requests.some((r) => r.model === 'big-model:120b-cloud')).toBe(false);
  });

  it('on the OpenAI-compatible wire, with only a cloud model to offer, there is no local model at all', async () => {
    const s = await start({ 'big-model:120b-cloud': { loaded: true } }, 'openai');
    const { brains, lines } = await build({ FLINT_LOCAL_PROVIDER: 'openai', FLINT_LOCAL_BASE_URL: s.baseURL, FLINT_LOCAL_SERVER: 'openai', OLLAMA_MODEL: 'big-model:120b-cloud' });
    expect(brains.primary).toMatchObject({ model: 'big-model:120b-cloud', from: 'server' });
    // "No local model at all": the brain is held NOT confined, which is the only thing that keeps a turn that must
    // stay on this Mac off it. (The review's survivor 5: this test never looked, and the line could be deleted.)
    expect(brains.confined).toEqual({ ok: false, why: 'cloud_model' });
    expect(lines).toContain("[local] the local model is an Ollama cloud model, which runs on Ollama's servers: the local and hybrid modes will not use it");
  });

  // The review's survivor 8: nothing looked at the Authorization header a local brain really sends. The rule that a
  // key never travels in the clear was tested on the config object only, and the key could be dropped altogether.
  describe('the key a local brain sends (FLINT_LOCAL_API_KEY)', () => {
    const KEY = 'sk-local-do-not-leak-7781';
    /** A model server that is not there, standing in for one on another machine: every request it would have been sent is kept. */
    function capturing() {
      const seen: Array<{ url: string; authorization: string | undefined }> = [];
      const f = (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const headers = new Headers(init?.headers);
        seen.push({ url: String(url), authorization: headers.get('authorization') ?? undefined });
        const path = new URL(String(url)).pathname;
        if (path.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: MAIN }] }), { status: 200 });
        if (path.endsWith('/chat/completions')) return new Response(JSON.stringify({ id: 'x', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 });
        return new Response('{}', { status: 404 });
      }) as typeof fetch;
      return { f, seen };
    }
    const chats = (seen: Array<{ url: string; authorization: string | undefined }>) => seen.filter((r) => r.url.endsWith('/chat/completions'));

    it('on this Mac: the chat request carries it as a Bearer token, and so does the look at what the server has', async () => {
      const { f, seen } = capturing();
      const { brains } = await build({ FLINT_LOCAL_PROVIDER: 'openai', FLINT_LOCAL_BASE_URL: 'http://127.0.0.1:8080/v1', FLINT_LOCAL_SERVER: 'openai', FLINT_LOCAL_MODEL: MAIN, FLINT_LOCAL_API_KEY: KEY }, { fetch: f });
      await brains.primary.provider.generate({ model: MAIN, messages: [user] });
      expect(chats(seen).map((r) => r.authorization)).toEqual([`Bearer ${KEY}`]);
      expect(seen.filter((r) => r.url.endsWith('/v1/models')).every((r) => r.authorization === `Bearer ${KEY}`)).toBe(true);
      expect(seen.filter((r) => r.url.endsWith('/v1/models')).length).toBeGreaterThan(0);
      // Every request went to the one address, and the key is in nothing that was logged.
      for (const r of seen) expect(new URL(r.url).host).toBe('127.0.0.1:8080');
    });

    it('over plain http to another machine, even one Will allowed: the key is NOT sent, though it is in the environment', async () => {
      const { f, seen } = capturing();
      const env = { FLINT_LOCAL_PROVIDER: 'openai', FLINT_LOCAL_BASE_URL: 'http://10.0.0.9:8080/v1', FLINT_LOCAL_SERVER: 'openai', FLINT_LOCAL_MODEL: MAIN, FLINT_LOCAL_ALLOW_REMOTE: '1', FLINT_LOCAL_ALLOW_INSECURE_REMOTE: '1', FLINT_LOCAL_API_KEY: KEY };
      const { brains, lines, cfg } = await build(env, { fetch: f });
      expect(cfg.local.apiKey).toBeUndefined();
      await brains.primary.provider.generate({ model: MAIN, messages: [user] });
      expect(chats(seen)).toHaveLength(1);
      // The request was made, without Will's key: not in the header of the chat call, not in the look at the server.
      for (const r of seen) expect(r.authorization ?? '', r.url).not.toContain(KEY);
      expect(lines.join('\n')).not.toContain(KEY);
      expect(lines.some((l) => l.includes('FLINT_LOCAL_API_KEY is not sent over plain http to another machine'))).toBe(true);
    });

    it('over https to a machine Will allowed: it is sent', async () => {
      const { f, seen } = capturing();
      const { brains } = await build({ FLINT_LOCAL_PROVIDER: 'openai', FLINT_LOCAL_BASE_URL: 'https://gpu-box.lan:8443/v1', FLINT_LOCAL_SERVER: 'openai', FLINT_LOCAL_MODEL: MAIN, FLINT_LOCAL_ALLOW_REMOTE: '1', FLINT_LOCAL_API_KEY: KEY }, { fetch: f });
      await brains.primary.provider.generate({ model: MAIN, messages: [user] });
      expect(chats(seen).map((r) => r.authorization)).toEqual([`Bearer ${KEY}`]);
    });

    it('with no key set, no key of anyone\'s is sent: a placeholder the wire needs, and nothing from the environment', async () => {
      const { f, seen } = capturing();
      const { brains } = await build({ FLINT_LOCAL_PROVIDER: 'openai', FLINT_LOCAL_BASE_URL: 'http://127.0.0.1:8080/v1', FLINT_LOCAL_SERVER: 'openai', FLINT_LOCAL_MODEL: MAIN, OPENAI_API_KEY: 'sk-openai-REAL', ANTHROPIC_API_KEY: 'sk-ant-REAL' }, { fetch: f });
      await brains.primary.provider.generate({ model: MAIN, messages: [user] });
      for (const r of seen) expect(r.authorization ?? '', r.url).not.toMatch(/REAL|sk-openai|sk-ant/);
      expect(chats(seen)).toHaveLength(1);
    });
  });

  it('an OLLAMA_HOST that is not a URL turns the native wire off', async () => {
    const { brains } = await build({ OLLAMA_HOST: 'not a url', OLLAMA_MODEL: MAIN });
    expect(brains.confined).toEqual({ ok: false, why: 'config' });
    expect(brains.monitor.snapshot().primary).toMatchObject({ state: 'unavailable', why: 'config' });
  });
});

describe('disabledProvider', () => {
  it('fails at once with an error that names no address and is not retried', async () => {
    const p = disabledProvider();
    expect(p.name).toBe('local');
    const err = await p.generate({ model: 'm', messages: [user] }).catch((e: unknown) => e);
    expect(isFlintError(err)).toBe(true);
    if (isFlintError(err)) expect(err.error).toMatchObject({ kind: 'provider_unavailable', retryable: false, providerCode: 'config' });
    expect(p.getCapabilities('m').toolCalling).toBe('unsupported');
  });
});

describe('the standby model', () => {
  const SMALL = 'small-model:3b';
  const TIER = hardwareTier('48gb');

  it('FLINT_LOCAL_FALLBACK_MODEL names it: the same server and wire, thinking off, its own small window', async () => {
    const s = await start({ [MAIN]: { loaded: true, contextLength: 16384 }, [SMALL]: { loaded: false } });
    const { brains, lines } = await build({ OLLAMA_HOST: s.origin, OLLAMA_MODEL: MAIN, OLLAMA_NUM_CTX: '16384', OLLAMA_THINK: 'true', FLINT_LOCAL_FALLBACK_MODEL: SMALL });
    expect(brains.fallback).toMatchObject({ which: 'fallback', model: SMALL, label: `ollama:${SMALL}`, from: 'env', numCtx: 4096 });
    // The monitor watches it too.
    expect(brains.monitor.snapshot().fallback).toMatchObject({ model: SMALL, state: 'cold' });
    expect(lines).toContain(`[local] standby ${SMALL}: cold`);
    await brains.fallback!.provider.generate({ model: SMALL, messages: [user] });
    const sent = s.chats().at(-1)!;
    expect(sent.path).toBe('/api/chat');
    expect(sent.body).toMatchObject({ model: SMALL, think: false, options: { num_ctx: 4096 } });
    // It answered: the monitor heard, and it reads as loaded without waiting for the next probe.
    expect(brains.monitor.snapshot().fallback).toMatchObject({ state: 'loaded' });
  });

  it("unset, it is the hardware tier's standby (on an Ollama server), at the tier row's context", async () => {
    const s = await start({ [MAIN]: { loaded: true, contextLength: 16384 } });
    const { brains, lines } = await build({ OLLAMA_HOST: s.origin, OLLAMA_MODEL: MAIN, OLLAMA_NUM_CTX: '16384' }, { tier: TIER });
    expect(brains.fallback).toMatchObject({ model: TIER.fallbackModel, from: 'tier', numCtx: TIER.fallbackContextLength });
    // It is not downloaded: Flint says so and prints the command. It never pulls.
    expect(brains.monitor.snapshot().fallback).toMatchObject({ state: 'unavailable', why: 'not_installed' });
    expect(lines).toContain(`[local] standby ${TIER.fallbackModel}: unavailable (not_installed). To download it, run: ollama pull ${TIER.fallbackModel}`);
    expect(s.requests.some((r) => /pull/.test(r.path))).toBe(false);
  });

  it('off: no standby', async () => {
    const s = await start({ [MAIN]: { loaded: true } });
    const { brains } = await build({ OLLAMA_HOST: s.origin, OLLAMA_MODEL: MAIN, FLINT_LOCAL_FALLBACK_MODEL: 'off' }, { tier: TIER });
    expect(brains.fallback).toBeUndefined();
    expect(brains.monitor.snapshot().fallback).toBeUndefined();
  });

  it('a standby that is the main model is no standby, and the log says so', async () => {
    const s = await start({ [MAIN]: { loaded: true } });
    const { brains, lines } = await build({ OLLAMA_HOST: s.origin, OLLAMA_MODEL: MAIN, FLINT_LOCAL_FALLBACK_MODEL: MAIN.toUpperCase() });
    expect(brains.fallback).toBeUndefined();
    expect(lines.some((l) => l.includes('the standby model is the main model'))).toBe(true);
  });

  it('on the OpenAI-compatible wire it is the same adapter, asked for the other model', async () => {
    const s = await start({ [MAIN]: { loaded: true, contextLength: 16384 }, [SMALL]: { loaded: true, contextLength: 4096, replies: [{ text: 'from the standby' }] } });
    const { brains } = await build({ FLINT_LOCAL_PROVIDER: 'openai', FLINT_LOCAL_BASE_URL: s.baseURL, OLLAMA_MODEL: MAIN, FLINT_LOCAL_FALLBACK_MODEL: SMALL });
    expect(brains.fallback).toMatchObject({ model: SMALL, label: `local:${SMALL}`, numCtx: undefined });
    const out = await brains.fallback!.provider.generate({ model: SMALL, messages: [user] });
    expect(out.message.content).toBe('from the standby');
    expect(s.chats().at(-1)).toMatchObject({ path: '/v1/chat/completions', model: SMALL });
    expect(brains.fallback!.provider.getCapabilities(SMALL).maxContextTokens).toBe(4096);
  });

  it("a tier's tag means nothing to another server: llama.cpp gets a standby only when one is named", async () => {
    const s = await start({ 'model.gguf': { loaded: true } }, 'llamacpp');
    const { brains } = await build({ FLINT_LOCAL_PROVIDER: 'openai', FLINT_LOCAL_BASE_URL: s.baseURL }, { tier: TIER });
    expect(brains.fallback).toBeUndefined();
  });

  it('standbyModel / standbyContext', () => {
    const cfg = (env: Record<string, string>) => readInferenceConfig(env);
    expect(standbyModel(cfg({}), TIER, 'ollama', MAIN)).toEqual({ model: TIER.fallbackModel, from: 'tier' });
    expect(standbyModel(cfg({}), undefined, 'ollama', MAIN)).toBeUndefined();
    expect(standbyModel(cfg({ FLINT_LOCAL_FALLBACK_MODEL: 'off' }), TIER, 'ollama', MAIN)).toBeUndefined();
    expect(standbyModel(cfg({ FLINT_LOCAL_FALLBACK_MODEL: SMALL }), TIER, 'llamacpp', MAIN)).toEqual({ model: SMALL, from: 'env' });
    // Its context is what this MACHINE's tier gives a standby, whichever model it is: 8,192 where there is
    // memory for a second model at that size, 4,096 below, and 4,096 while the machine has not been looked at.
    expect(standbyContext(cfg({}), TIER)).toBe(TIER.fallbackContextLength);
    expect(standbyContext(cfg({}), TIER)).toBe(8192);
    expect(standbyContext(cfg({}), hardwareTier('16gb'))).toBe(8192);
    expect(standbyContext(cfg({}), hardwareTier('8gb'))).toBe(4096);
    expect(standbyContext(cfg({}), hardwareTier('cpu'))).toBe(4096);
    expect(standbyContext(cfg({}), undefined)).toBe(4096);
    // FLINT_LOCAL_FALLBACK_NUM_CTX overrides the tier's, up or down; a refused value is ignored.
    expect(standbyContext(cfg({ FLINT_LOCAL_FALLBACK_NUM_CTX: '16384' }), TIER)).toBe(16384);
    expect(standbyContext(cfg({ FLINT_LOCAL_FALLBACK_NUM_CTX: '2048' }), TIER)).toBe(2048);
    expect(standbyContext(cfg({ FLINT_LOCAL_FALLBACK_NUM_CTX: 'lots' }), TIER)).toBe(8192);
  });

  it('the window a local brain is budgeted at is never more than the model can hold: the server\'s own report bounds it', async () => {
    // Flint asks for 16,384, and this model's own maximum (its /api/show context_length) is 8,192.
    const s = await start({ [MAIN]: { loaded: true, contextLength: 8192, maxContext: 8192 } });
    const { brains } = await build({ OLLAMA_HOST: s.origin, OLLAMA_MODEL: MAIN, OLLAMA_NUM_CTX: '16384' });
    expect(brains.primary.numCtx).toBe(16384); // what is asked for
    expect(brains.primary.provider.getCapabilities(MAIN).maxContextTokens).toBe(8192); // what the prompt is sized to
    // ...and in memory at its maximum it is LOADED, not "at another context" for good.
    expect(brains.monitor.snapshot().primary).toMatchObject({ state: 'loaded', contextLength: 8192 });
  });
});

describe("the native wire's own deadlines, and what the monitor learns from a turn", () => {
  it('a model that never answers: off in the cloud mode (as before); in the other modes the turn ends at the deadline and the model is marked not ready', async () => {
    const s = await start({ [MAIN]: { loaded: true, contextLength: 16384, stall: true } });
    let on = false;
    const { brains } = await build({ OLLAMA_HOST: s.origin, OLLAMA_MODEL: MAIN, OLLAMA_NUM_CTX: '16384', FLINT_LOCAL_FIRST_OUTPUT_TIMEOUT_MS: '500', FLINT_LOCAL_REQUEST_TIMEOUT_MS: '1000' }, { on: () => on });
    // Off: only the caller ends it.
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 60);
    const off = await collect(brains.primary.provider.stream({ model: MAIN, messages: [user], signal: ac.signal }));
    expect(off[0]).toMatchObject({ type: 'error', error: { message: 'Request aborted' } });
    expect(brains.monitor.snapshot().primary.state).toBe('loaded');
    // On: the first-token deadline ends it, and the monitor hears.
    on = true;
    const events = await collect(brains.primary.provider.stream({ model: MAIN, messages: [user] }));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', error: { providerCode: 'first_token_timeout', retryable: false } });
    const p = brains.monitor.snapshot().primary;
    expect(p.slowUntil).toBeGreaterThan(Date.now());
    // The routing review's M5: the tool-decision pass (tools offered, which is nearly every chat turn) answered
    // whole, so it was under the whole-reply deadline: 1,000 ms here, 120 s by default. It is read as a
    // stream now, and ends at the FIRST-TOKEN deadline like any other call.
    const t0 = Date.now();
    const decision = await collect(brains.primary.provider.stream({ model: MAIN, messages: [user], tools: [tool] }));
    const took = Date.now() - t0;
    expect(decision[0]).toMatchObject({ type: 'error', error: { providerCode: 'first_token_timeout' } });
    expect(took).toBeGreaterThanOrEqual(450);
    expect(took).toBeLessThan(950);
    expect(s.chats().at(-1)!.body).toMatchObject({ stream: true });
    // In the cloud mode it is the non-streamed call it always was.
    on = false;
    const ac2 = new AbortController();
    setTimeout(() => ac2.abort(), 60);
    await collect(brains.primary.provider.stream({ model: MAIN, messages: [user], tools: [tool], signal: ac2.signal }));
    expect(s.chats().at(-1)!.body).toMatchObject({ stream: false });
  });

  it('an answer tells the monitor how long the first token took', async () => {
    const s = await start({ [MAIN]: { loaded: true, contextLength: 16384, firstTokenMs: 40 } });
    const { brains } = await build({ OLLAMA_HOST: s.origin, OLLAMA_MODEL: MAIN, OLLAMA_NUM_CTX: '16384' });
    await collect(brains.primary.provider.stream({ model: MAIN, messages: [user] }));
    const stats = brains.monitor.snapshot().primary.firstTokenMs;
    expect(stats?.n).toBe(1);
    expect(stats!.p50).toBeGreaterThanOrEqual(30);
  });

  it('a server that cannot be reached is marked unavailable by the turn that found out', async () => {
    const s = await start({ [MAIN]: { loaded: true, contextLength: 16384 } });
    const { brains } = await build({ OLLAMA_HOST: s.origin, OLLAMA_MODEL: MAIN, OLLAMA_NUM_CTX: '16384' });
    expect(brains.monitor.snapshot().primary.state).toBe('loaded');
    await s.close();
    server = undefined;
    const events = await collect(brains.primary.provider.stream({ model: MAIN, messages: [user] }));
    expect(events.at(-1)).toMatchObject({ type: 'error', error: { kind: 'provider_unavailable' } });
    expect(brains.monitor.snapshot().primary).toMatchObject({ state: 'unavailable', why: 'unreachable' });
  });
});

/**
 * Boot never waits on the model server, and a stand-in is never asked. What
 * lands behind the boot is a whole new brain, built the way the first was.
 */
describe('behind the boot', () => {
  const never = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
  const within = async <T>(p: Promise<T>, ms: number): Promise<T | 'late'> => Promise.race([p, new Promise<'late'>((r) => setTimeout(() => r('late'), ms))]);

  async function begin(env: Record<string, string | undefined>, more: Partial<Parameters<typeof startLocalBrains>[0]> = {}) {
    const lines: string[] = [];
    const cfg = readInferenceConfig(env, (m) => lines.push(m));
    const handle = await startLocalBrains({ cfg, env, deadlinesOn: () => true, connect: async () => {}, log: (m) => lines.push(m), pick: { capMs: 300 }, ...more });
    handles.push(handle);
    const changes: LocalBrains[] = [];
    handle.onChange((b) => changes.push(b));
    return { handle, lines, changes };
  }

  it('a named model: there is a brain to hold before the model server or the machine has said anything', async () => {
    let asked = 0;
    const silent = ((...a: Parameters<typeof fetch>) => {
      asked += 1;
      return never(...a);
    }) as typeof fetch;
    const started = Date.now();
    const got = await within(begin({ OLLAMA_HOST: 'http://127.0.0.1:11434', OLLAMA_MODEL: MAIN }, { fetch: silent, tier: new Promise(() => {}) }), 200);
    expect(got).not.toBe('late');
    expect(Date.now() - started).toBeLessThan(200);
    const { handle } = got as Awaited<ReturnType<typeof begin>>;
    expect(handle.current().primary).toMatchObject({ model: MAIN, from: 'env', settled: true });
    // Nothing was asked before the brain was handed over (the pick is skipped for a named model).
    expect(asked).toBe(0);
    // Until it is looked at, the model is not "ready": a turn planned now does not take it for loaded.
    expect(handle.current().monitor.snapshot().primary).toMatchObject({ model: MAIN, state: 'unavailable', checkedAt: 0 });
  });

  it('no model named and a server that never answers: the pick is cut off by the clock, and the brain is a stand-in that is never asked', async () => {
    const paths: string[] = [];
    const hung = ((url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      paths.push(new URL(String(url)).pathname);
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)));
    }) as typeof fetch;
    const started = Date.now();
    const { handle } = await begin({ OLLAMA_HOST: 'http://127.0.0.1:11434' }, { fetch: hung, pick: { capMs: 150, wait: () => new Promise(() => {}) } });
    expect(Date.now() - started).toBeLessThan(1500);
    const b = handle.current();
    expect(b.primary).toMatchObject({ from: 'default', settled: false });
    expect(b.primary.provider.name).toBe('ollama');
    expect(b.monitor.snapshot().primary).toMatchObject({ state: 'unavailable', why: 'unsettled' });
    // Asking the stand-in fails at once, with a code, and sends nothing: Ollama would load it otherwise.
    const before = paths.length;
    await expect(b.primary.provider.generate({ model: b.primary.model, messages: [user] })).rejects.toSatisfy((e) => isFlintError(e) && e.error.providerCode === UNSETTLED);
    const events = await collect(b.primary.provider.stream({ model: b.primary.model, messages: [user] }));
    expect(events).toEqual([{ type: 'error', error: expect.objectContaining({ kind: 'provider_unavailable', providerCode: UNSETTLED, retryable: false }) }]);
    expect(paths.slice(before).filter((p) => p === '/api/chat' || p === '/api/generate')).toEqual([]);
    // The monitor never warms a stand-in either.
    b.monitor.warm('primary');
    expect(paths.filter((p) => p === '/api/generate')).toEqual([]);
  });

  // The final review's L12: the boot line named one stand-in (the smallest GPU tier's model) and /health another
  // (this machine's tier's), with nothing in the log to say the name had changed.
  it('a stand-in that takes this machine\'s tier\'s name says so once, and is still never asked', async () => {
    const paths: string[] = [];
    const refused = ((url: Parameters<typeof fetch>[0]) => {
      paths.push(new URL(String(url)).pathname);
      return Promise.reject(new TypeError('fetch failed'));
    }) as typeof fetch;
    const TIER = hardwareTier('48gb');
    const { handle, lines } = await begin({ OLLAMA_HOST: 'http://127.0.0.1:11434' }, { fetch: refused, tier: new Promise((r) => setTimeout(() => r(TIER), 20)), once: true, pick: { capMs: 150 } });
    // Before the machine has been looked at, the stand-in is the smallest GPU tier's model.
    expect(handle.current().primary).toMatchObject({ model: hardwareTier('8gb').model, settled: false });
    await handle.ready;
    const b = handle.current();
    expect(b.primary).toMatchObject({ model: TIER.model, from: 'default', settled: false });
    const said = lines.filter((l) => l.includes('the stand-in is now'));
    expect(said).toEqual([`[brain] the stand-in is now ${TIER.model}, this machine's hardware tier's model: it is the name /health shows until the model server answers, and it is never asked`]);
    // The boot line named the first one; the two lines together account for both names.
    expect(lines.some((l) => l.includes('is held as a stand-in, and is never asked'))).toBe(true);
    expect(paths.filter((p) => p === '/api/chat' || p === '/api/generate')).toEqual([]);
  });

  it('the server is silent at boot and answers later: its model is adopted for the next turn, built like the first, and the monitor follows it', async () => {
    const s = await start({ [MAIN]: { loaded: true, contextLength: 8192, firstTokenMs: 5 } });
    s.kind = 'openai'; // the list routes are gone: Ollama reads as not answering
    let waits = 0;
    const { handle, lines, changes } = await begin(
      { OLLAMA_HOST: s.origin, FLINT_LOCAL_FIRST_OUTPUT_TIMEOUT_MS: '500' },
      {
        pick: {
          capMs: 300,
          wait: async () => {
            waits += 1;
            if (waits === 2) s.kind = 'ollama'; // it comes up while Flint keeps asking
            await new Promise((r) => setTimeout(r, 5));
          },
        },
      },
    );
    const first = handle.current();
    expect(first.primary.settled).toBe(false);
    for (let i = 0; i < 100 && changes.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(changes).toHaveLength(1);
    const adopted = handle.current();
    expect(adopted).toBe(changes[0]);
    expect(adopted.primary).toMatchObject({ model: MAIN, from: 'loaded', numCtx: 8192, settled: true });
    expect(adopted.primary.env).toEqual({ OLLAMA_MODEL: MAIN, OLLAMA_NUM_CTX: '8192' });
    expect(lines.some((l) => l.includes('the model server is answering now') && l.includes(MAIN))).toBe(true);
    // One monitor, and it follows the adopted model, never the stand-in.
    expect(adopted.monitor).toBe(first.monitor);
    const snap = await adopted.monitor.check();
    expect(snap.primary).toMatchObject({ model: MAIN, state: 'loaded', contextLength: 8192 });
    // Built like the first: the watcher tells the monitor what the turn saw...
    const events = await collect(adopted.primary.provider.stream({ model: MAIN, messages: [user] }));
    expect(events.some((e) => e.type === 'text')).toBe(true);
    expect(adopted.monitor.snapshot().primary.firstTokenMs?.n).toBe(1);
    // ...the deadlines hold (this model now stalls)...
    s.models.get(MAIN)!.stall = true;
    const stalled = await collect(adopted.primary.provider.stream({ model: MAIN, messages: [user] }));
    expect(stalled.at(-1)).toMatchObject({ type: 'error', error: { kind: 'timeout', providerCode: 'first_token_timeout' } });
    // ...and a redirect is refused, never followed.
    s.models.get(MAIN)!.stall = false;
    s.redirectTo = 'http://127.0.0.1:1/elsewhere';
    const redirected = await collect(adopted.primary.provider.stream({ model: MAIN, messages: [user] }));
    expect(redirected.at(-1)).toMatchObject({ type: 'error', error: { providerCode: 'redirect' } });
  });

  // The breaker's last review, F1, end to end on the mock server: Ollama is silent at boot, a local turn
  // arrives, and then Ollama comes up. The stand-in must never be asked for, so that what Ollama has when it
  // answers is what it had, not what Flint made it load.
  it('F1: while the server is silent the stand-in is never asked for, and the model adopted later is the server\'s own, not the stand-in', async () => {
    const STAND_IN = hardwareTier('8gb').model; // DEFAULT_OLLAMA_MODEL: installed here, and NOT loaded
    const s = await start({ [STAND_IN]: { loaded: false }, 'wills-model:30b': { loaded: false } });
    s.kind = 'openai'; // Ollama reads as not answering
    let up!: () => void;
    const comesUp = new Promise<void>((r) => (up = r));
    const { handle, changes } = await begin({ OLLAMA_HOST: s.origin }, { pick: { capMs: 300, wait: () => comesUp } });
    const b = handle.current();
    expect(b.primary).toMatchObject({ model: STAND_IN, from: 'default', settled: false });
    // A local turn in the gap: every way of asking the stand-in refuses, and none reaches Ollama.
    await expect(b.primary.provider.generate({ model: STAND_IN, messages: [user] })).rejects.toSatisfy((e) => isFlintError(e) && e.error.providerCode === UNSETTLED);
    await collect(b.primary.provider.stream({ model: STAND_IN, messages: [user], tools: [tool] }));
    b.monitor.warm('primary');
    await b.monitor.check();
    expect(s.chats()).toEqual([]);
    expect(s.warms()).toEqual([]);
    expect(s.models.get(STAND_IN)!.loaded).toBe(false);
    // Ollama comes up. It has two models on disk and none in memory: the pick takes the first pulled.
    s.kind = 'ollama';
    up();
    for (let i = 0; i < 100 && changes.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(handle.current().primary).toMatchObject({ settled: true, from: 'pulled' });
    // Had the stand-in been asked, Ollama would have loaded it and this would read `from: 'loaded'`, for good.
    expect(handle.current().primary.from).not.toBe('loaded');
    expect(s.models.get(STAND_IN)!.loaded).toBe(false);
  });

  it('a listener that throws does not stop the adoption, or the next listener', async () => {
    const s = await start({ [hardwareTier('48gb').model]: { loaded: false }, 'other-model:7b': { loaded: true, contextLength: 4096 } });
    let land!: (t: ReturnType<typeof hardwareTier>) => void;
    const { handle, changes } = await begin({ OLLAMA_HOST: s.origin }, { tier: new Promise((r) => (land = r)), once: true });
    const told: string[] = [];
    handle.onChange(() => {
      throw new Error('a listener of its own that fails');
    });
    handle.onChange((b) => told.push(b.primary.model));
    land(hardwareTier('48gb'));
    await handle.ready;
    expect(handle.current().primary.model).toBe(hardwareTier('48gb').model);
    expect(changes).toHaveLength(1);
    expect(told).toEqual([hardwareTier('48gb').model]);
  });

  it('the tier lands behind the boot: its model replaces what the pick took, once, and whoever holds the old brain is told', async () => {
    const TIER = hardwareTier('48gb');
    const s = await start({ [TIER.model]: { loaded: false }, 'other-model:7b': { loaded: true, contextLength: 4096 } });
    let land!: (t: ReturnType<typeof hardwareTier>) => void;
    const tier = new Promise<ReturnType<typeof hardwareTier>>((r) => (land = r));
    const { handle, changes, lines } = await begin({ OLLAMA_HOST: s.origin }, { tier, once: true });
    // Before the machine has been looked at: what Ollama had.
    expect(handle.current().primary).toMatchObject({ model: 'other-model:7b', from: 'loaded', settled: true });
    expect(handle.current().fallback).toBeUndefined();
    land(TIER);
    await handle.ready;
    expect(changes).toHaveLength(1);
    expect(handle.current().primary).toMatchObject({ model: TIER.model, from: 'tier', numCtx: TIER.contextLength, settled: true });
    // The standby is the tier's too, now that the tier is known.
    expect(handle.current().fallback).toMatchObject({ model: TIER.fallbackModel, from: 'tier' });
    expect(handle.current().monitor.snapshot()).toMatchObject({ primary: { model: TIER.model, state: 'cold' }, fallback: { model: TIER.fallbackModel } });
    expect(lines.some((l) => l.includes(`the local brain is ${TIER.model}, this machine's hardware tier's model`))).toBe(true);
  });

  it('a tier that changes nothing tells nobody: the first brain stays the one in use', async () => {
    const s = await start({ [MAIN]: { loaded: true, contextLength: 16384 } });
    const { handle, changes } = await begin({ OLLAMA_HOST: s.origin, OLLAMA_MODEL: MAIN, OLLAMA_NUM_CTX: '16384', FLINT_LOCAL_FALLBACK_MODEL: 'off' }, { tier: Promise.resolve(hardwareTier('48gb')), once: true });
    const first = handle.current();
    await handle.ready;
    expect(changes).toEqual([]);
    expect(handle.current()).toBe(first);
    expect(first.monitor.snapshot().primary.state).toBe('loaded');
  });

  it('the standby is never taken for the main model, though it is in memory too', async () => {
    const s = await start({ 'small-model:3b': { loaded: true, contextLength: 4096 }, 'other-model:7b': { loaded: false } });
    const { brains } = await build({ OLLAMA_HOST: s.origin, FLINT_LOCAL_FALLBACK_MODEL: 'small-model:3b' });
    expect(brains.primary).toMatchObject({ model: 'other-model:7b', from: 'pulled' });
    expect(brains.fallback).toMatchObject({ model: 'small-model:3b', from: 'env' });
  });

  it("the tier's standby, picked as the main model before the tier was known, is given up when the tier lands", async () => {
    const TIER = hardwareTier('48gb');
    const s = await start({ [TIER.fallbackModel]: { loaded: true, contextLength: 4096 }, 'other-model:7b': { loaded: false } });
    const { handle } = await begin({ OLLAMA_HOST: s.origin }, { tier: new Promise((r) => setTimeout(() => r(TIER), 20)), once: true });
    expect(handle.current().primary.model).toBe(TIER.fallbackModel);
    await handle.ready;
    expect(handle.current().primary).toMatchObject({ model: 'other-model:7b', from: 'pulled' });
    expect(handle.current().fallback?.model).toBe(TIER.fallbackModel);
  });

  it('a server that is not Ollama and lists nothing usable: no model is chosen, and nothing a server said reaches a log unchecked', async () => {
    const s = await start({ 'evil\nname [local] injected': { loaded: true } }, 'openai');
    const { brains, lines } = await build({ FLINT_LOCAL_PROVIDER: 'openai', FLINT_LOCAL_BASE_URL: s.baseURL, FLINT_LOCAL_SERVER: 'openai' });
    expect(brains.primary).toMatchObject({ model: NO_LOCAL_MODEL, from: 'none', settled: false });
    expect(lines.join('\n')).not.toContain('injected');
    expect(brains.monitor.snapshot().primary).toMatchObject({ state: 'unavailable', why: 'unsettled' });
  });

  it('safeModelId: a tag is a tag; anything else is not passed on', () => {
    expect(safeModelId('qwen2.5:7b')).toBe('qwen2.5:7b');
    expect(safeModelId('  hf.co/org/repo:Q4_K_M ')).toBe('hf.co/org/repo:Q4_K_M');
    for (const bad of ['', ' ', 'a b', 'x'.repeat(101), 'name\nline', '$(rm -rf)', 7, null, undefined, { id: 'x' }]) expect(safeModelId(bad)).toBeUndefined();
  });
});
