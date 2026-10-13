import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DETECT_PATHS,
  GuardRefusal,
  OLLAMA_PATHS,
  PLACE_PATH,
  WarmFailed,
  askPlace,
  detectServer,
  guardedFetch,
  llamaCppBackend,
  llamaCppPaths,
  ollamaBackend,
  openAiBackend,
  openAiPaths,
  withPlace,
} from '../src/local-backend';
import type { PlaceSaid } from '../src/ollama-locality';
import { startMockLocalServer, type MockLocalServer } from './mock-local-server';

/**
 * What Flint asks a local model server besides "answer this", and the fetch
 * that holds every such call to one server.
 */

let server: MockLocalServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});
const signal = () => AbortSignal.timeout(2000);

describe('guardedFetch', () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const base = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init: init ?? {} });
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  const guard = (over: Partial<Parameters<typeof guardedFetch>[0]> = {}) =>
    guardedFetch({ origin: 'http://127.0.0.1:11434', paths: ['/v1/chat/completions', '/api/version'], fetch: base, connect: async () => {}, ...over });

  it('reaches only its origin: another host, port or scheme is refused before anything is sent', async () => {
    calls.length = 0;
    const f = guard();
    for (const url of ['http://127.0.0.1:9999/api/version', 'http://evil.example/api/version', 'https://127.0.0.1:11434/api/version', 'http://127.0.0.1.evil.example:11434/api/version']) {
      await expect(f(url), url).rejects.toBeInstanceOf(GuardRefusal);
    }
    expect(calls).toEqual([]);
  });

  it('reaches only the listed paths, exactly, with no query: there is no way to ask for a download', async () => {
    calls.length = 0;
    const f = guard();
    for (const url of ['http://127.0.0.1:11434/api/pull', 'http://127.0.0.1:11434/api/version/x', 'http://127.0.0.1:11434/api/delete', 'http://127.0.0.1:11434/']) {
      await expect(f(url, { method: 'POST' }), url).rejects.toThrow(/path not allowed/);
    }
    await expect(f('http://127.0.0.1:11434/api/version?x=1')).rejects.toThrow(/query not allowed/);
    await expect(f('http://127.0.0.1:11434/api/version', { method: 'DELETE' })).rejects.toThrow(/method not allowed/);
    expect(calls).toEqual([]);
  });

  it("a refusal's message names the rule, never the URL", async () => {
    const err = await guard()('http://user:secret@evil.example/api/version').catch((e: unknown) => e);
    expect((err as Error).message).toBe('local fetch refused: origin not allowed');
  });

  it('never follows a redirect, whatever the caller asked for', async () => {
    calls.length = 0;
    await guard()('http://127.0.0.1:11434/api/version', { redirect: 'follow' });
    expect(calls[0]!.init.redirect).toBe('error');
  });

  it('checks the server accepts a connection before a POST, within the connect deadline', async () => {
    calls.length = 0;
    const connects: Array<[string, number, number]> = [];
    const f = guard({ connectTimeoutMs: 1500, connect: async (h, p, ms) => void connects.push([h, p, ms]) });
    await f('http://127.0.0.1:11434/v1/chat/completions', { method: 'POST', body: '{}' });
    expect(connects).toEqual([['127.0.0.1', 11434, 1500]]);
    expect(calls).toHaveLength(1);
    // A GET (a probe) has its own timeout and is not checked first.
    await f('http://127.0.0.1:11434/api/version');
    expect(connects).toHaveLength(1);
  });

  it('a server that does not accept the connection fails the POST the way a refused connection does, and nothing is sent', async () => {
    calls.length = 0;
    const f = guard({ connectTimeoutMs: 1500, connect: async () => Promise.reject(new Error('connect timed out')) });
    const err = await f('http://127.0.0.1:11434/v1/chat/completions', { method: 'POST', body: '{}' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TypeError);
    expect((err as Error).message).toBe('fetch failed');
    expect(calls).toEqual([]);
  });

  it('the connect deadline can be a function, read on every call (it follows the routing mode)', async () => {
    let ms: number | undefined;
    const connects: number[] = [];
    const f = guard({ connectTimeoutMs: () => ms, connect: async (_h, _p, t) => void connects.push(t) });
    await f('http://127.0.0.1:11434/v1/chat/completions', { method: 'POST', body: '{}' });
    expect(connects).toEqual([]);
    ms = 800;
    await f('http://127.0.0.1:11434/v1/chat/completions', { method: 'POST', body: '{}' });
    expect(connects).toEqual([800]);
  });

  it('strips the brackets from an IPv6 origin for the connect, and uses the scheme\'s port when none is written', async () => {
    const connects: Array<[string, number]> = [];
    const f = guardedFetch({ origin: 'http://[::1]', paths: ['/x'], fetch: base, connectTimeoutMs: 100, connect: async (h, p) => void connects.push([h, p]) });
    await f('http://[::1]/x', { method: 'POST' });
    expect(connects).toEqual([['::1', 80]]);
  });

  it('a real redirect from the server is an error, not followed', async () => {
    server = await startMockLocalServer();
    server.redirectTo = 'http://evil.example/steal';
    const f = guardedFetch({ origin: server.origin, paths: ['/api/version'] });
    await expect(f(`${server.origin}/api/version`)).rejects.toBeInstanceOf(TypeError);
  });
});

describe('the allowlists', () => {
  it('no backend lists a path that downloads or deletes a model', () => {
    const all = [...OLLAMA_PATHS, ...llamaCppPaths('/v1'), ...openAiPaths('/v1'), ...DETECT_PATHS];
    for (const p of all) expect(p).not.toMatch(/pull|push|delete|create|copy|blobs/);
    // And the module never names one.
    const src = readFileSync(join(__dirname, '..', 'src', 'local-backend.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    expect(src).not.toMatch(/\/api\/(pull|push|delete|create|copy)/);
  });
});

describe('ollamaBackend', () => {
  const backend = (s: MockLocalServer) => ollamaBackend(s.origin, guardedFetch({ origin: s.origin, paths: OLLAMA_PATHS }));

  it('probe: reachable, with what is installed and what is in memory at which context', async () => {
    server = await startMockLocalServer({
      models: { 'big:30b': { loaded: true, contextLength: 16384 }, 'small:3b': { loaded: false }, 'missing:1b': { installed: false } },
    });
    const r = await backend(server).probe(['big:30b', 'small:3b', 'missing:1b', 'never-heard-of:1b'], signal());
    expect(r).toEqual({
      reachable: true,
      version: '0.34.4',
      models: {
        'big:30b': { installed: true, loaded: true, contextLength: 16384 },
        'small:3b': { installed: true, loaded: false },
        'missing:1b': { installed: false, loaded: false },
        'never-heard-of:1b': { installed: false, loaded: false },
      },
    });
    // Three GETs, nothing else.
    expect(server.requests.map((q) => `${q.method} ${q.path}`).sort()).toEqual(['GET /api/ps', 'GET /api/tags', 'GET /api/version']);
  });

  it('probe: a model is the same model however it is written (case, :latest)', async () => {
    server = await startMockLocalServer({ models: { 'Thing:latest': { loaded: true, contextLength: 4096 } } });
    const r = await backend(server).probe(['thing'], signal());
    expect(r.models.thing).toEqual({ installed: true, loaded: true, contextLength: 4096 });
  });

  // The listing is where an Ollama says whether a model really runs on it (../src/ollama-locality keeps it for ./policy).
  it('probe: whoever keeps the listing is handed its rows as they came, each time; its own trouble never fails a look', async () => {
    server = await startMockLocalServer({ models: { 'main-model:30b': { loaded: true }, 'mine:latest': { remoteHost: 'https://ollama.com:443' } } });
    const heard: Array<ReadonlyArray<Record<string, unknown>>> = [];
    const b = ollamaBackend(server.origin, guardedFetch({ origin: server.origin, paths: OLLAMA_PATHS }), (rows) => heard.push(rows));
    await b.probe(['main-model:30b'], signal());
    await b.probe(['main-model:30b'], signal());
    expect(heard).toHaveLength(2);
    // Every model it lists, asked about or not, with what the row says of a remote host.
    expect(heard[0]!.map((r) => [r.name, r.remote_host])).toEqual([['main-model:30b', undefined], ['mine:latest', 'https://ollama.com:443']]);
    const throwing = ollamaBackend(server.origin, guardedFetch({ origin: server.origin, paths: OLLAMA_PATHS }), () => {
      throw new Error('the keeper is broken');
    });
    expect((await throwing.probe(['main-model:30b'], signal())).models['main-model:30b']).toMatchObject({ installed: true, loaded: true });
  });

  it('probe: a server that does not answer hands over no listing, and says so', async () => {
    const heard: unknown[] = [];
    let silent = 0;
    const f = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    expect(await ollamaBackend('http://127.0.0.1:9', f, (rows) => heard.push(rows), () => void silent++).probe(['m'], signal())).toEqual({ reachable: false, models: {} });
    expect(heard).toEqual([]);
    expect(silent).toBe(1);
  });

  // The follow-up review's F2: the listing can fail while the rest of the server answers, and a name can be pointed
  // at a cloud model behind that. A look that came back without a listing is told to whoever keeps the last one.
  it('probe: a look whose listing failed while the rest answered says so, each time, however it failed; a look with a listing never does', async () => {
    server = await startMockLocalServer({ models: { 'main-model:30b': { loaded: true, contextLength: 16384 } } });
    const real = guardedFetch({ origin: server.origin, paths: OLLAMA_PATHS });
    for (const how of ['500', '401', 'not json', 'throws', 'hangs'] as const) {
      let broken = true;
      const f = ((url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        if (!broken || !String(url).endsWith('/api/tags')) return real(url, init);
        if (how === 'throws') return Promise.reject(new TypeError('fetch failed'));
        if (how === 'hangs') return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
        return Promise.resolve(how === 'not json' ? new Response('<html>', { status: 502 }) : new Response('{"error":"x"}', { status: Number(how) }));
      }) as typeof fetch;
      const heard: unknown[] = [];
      let silent = 0;
      const b = ollamaBackend(server.origin, f, (rows) => heard.push(rows), () => void silent++);
      const r = await b.probe(['main-model:30b'], how === 'hangs' ? AbortSignal.timeout(60) : signal());
      // The server is there, and what it has in memory is known; what is installed is not.
      expect(r.reachable, how).toBe(true);
      expect(r.models['main-model:30b'], how).toEqual({ loaded: true, contextLength: 16384 });
      expect(heard, how).toEqual([]);
      expect(silent, how).toBe(1);
      await b.probe(['main-model:30b'], how === 'hangs' ? AbortSignal.timeout(60) : signal());
      expect(silent, how).toBe(2);
      broken = false;
      await b.probe(['main-model:30b'], signal());
      expect(heard, how).toHaveLength(1);
      expect(silent, how).toBe(2);
    }
    // Whoever is told has its own trouble: the look is the look all the same. And nobody need be told.
    const fails = ((url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => (String(url).endsWith('/api/tags') ? Promise.resolve(new Response('{}', { status: 500 })) : real(url, init))) as typeof fetch;
    const throwing = ollamaBackend(server.origin, fails, undefined, () => {
      throw new Error('the keeper is broken');
    });
    expect((await throwing.probe(['main-model:30b'], signal())).reachable).toBe(true);
    expect((await ollamaBackend(server.origin, fails).probe(['main-model:30b'], signal())).reachable).toBe(true);
  });

  // The re-review's N4. One failed listing cost one refused turn: the turn that waited for that look got a sentence,
  // and the next one was answered. A question that fails AT ONCE is asked once more inside the same look; one that
  // was not answered in time is not, so a turn never waits for two deadlines.
  it('probe: one bad answer is asked once more, and a good second answer is the look; two bad answers are silence; a hang is asked once', async () => {
    server = await startMockLocalServer({ models: { 'main-model:30b': { loaded: true, contextLength: 16384 } } });
    const real = guardedFetch({ origin: server.origin, paths: OLLAMA_PATHS });
    for (const path of ['/api/tags', '/api/version'] as const) {
      for (const how of ['500', 'throws', 'not json'] as const) {
        let bad = 0;
        let asked = 0;
        const f = ((url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
          if (!String(url).endsWith(path)) return real(url, init);
          asked++;
          if (bad <= 0) return real(url, init);
          bad--;
          if (how === 'throws') return Promise.reject(new TypeError('fetch failed'));
          return Promise.resolve(how === 'not json' ? new Response('<html>busy</html>', { status: 503 }) : new Response('{"error":"x"}', { status: 500 }));
        }) as typeof fetch;
        const heard: unknown[] = [];
        const silent: number[] = [];
        const b = ollamaBackend(server.origin, f, (rows) => heard.push(rows), (since) => void silent.push(since));
        const label = `${path} ${how}`;
        // Healthy: one request, as ever.
        expect((await b.probe(['main-model:30b'], signal())).reachable, label).toBe(true);
        expect([asked, heard.length, silent.length], label).toEqual([1, 1, 0]);
        // One bad answer, then a good one: the look is a look, with its listing, and nobody is told of a silence.
        bad = 1;
        const once = await b.probe(['main-model:30b'], signal());
        expect(once, label).toMatchObject({ reachable: true, models: { 'main-model:30b': { installed: true, loaded: true } } });
        expect([asked, heard.length, silent.length], label).toEqual([3, 2, 0]);
        // Two bad answers: silence, told with when the look began. Never a third request.
        bad = 2;
        const before = Date.now();
        const twice = await b.probe(['main-model:30b'], signal());
        expect(twice.reachable, label).toBe(path === '/api/tags');
        expect([asked, heard.length, silent.length], label).toEqual([5, 2, 1]);
        expect(silent[0], label).toBeGreaterThanOrEqual(before);
        expect(silent[0], label).toBeLessThanOrEqual(Date.now());
      }
      // Not answered in time: asked once. The look has one deadline, and it has passed.
      let asked = 0;
      const hangs = ((url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        if (!String(url).endsWith(path)) return real(url, init);
        asked++;
        return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
      }) as typeof fetch;
      let silent = 0;
      const began = Date.now();
      await ollamaBackend(server.origin, hangs, undefined, () => void silent++).probe(['main-model:30b'], AbortSignal.timeout(80));
      expect([asked, silent], path).toEqual([1, 1]);
      expect(Date.now() - began, path).toBeLessThan(1_000);
    }
  });

  it('probe: a server that is not there is unreachable, and nothing throws', async () => {
    server = await startMockLocalServer();
    const dead = backend(server);
    await server.close();
    server = undefined;
    await expect(dead.probe(['big:30b'], signal())).resolves.toEqual({ reachable: false, models: {} });
  });

  it('warm: one /api/generate with no prompt and the context chat will send; it resolves once the model is in memory', async () => {
    server = await startMockLocalServer({ models: { 'big:30b': { loaded: false, loadMs: 20 } } });
    await backend(server).warm('big:30b', { numCtx: 16384, signal: signal() });
    const load = server.requests.find((q) => q.path === '/api/generate')!;
    expect(load.body).toEqual({ model: 'big:30b', stream: false, options: { num_ctx: 16384 } });
    expect(server.models.get('big:30b')).toMatchObject({ loaded: true, contextLength: 16384 });
  });

  it('warm: a model the server does not have is a failure that carries only the status', async () => {
    server = await startMockLocalServer();
    const err = await backend(server).warm('missing:1b', { signal: signal() }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WarmFailed);
    expect((err as WarmFailed).status).toBe(404);
    expect((err as Error).message).toBe('warm-up answered 404');
  });

  it("describe: the server's own report of what the model can do", async () => {
    server = await startMockLocalServer({ models: { 'big:30b': { capabilities: ['completion', 'vision', 'tools', 'thinking'] }, 'plain:1b': { capabilities: ['completion'] } } });
    expect(await backend(server).describe('big:30b', signal())).toEqual({ tools: true, vision: true, thinking: true, contextLength: 32768 });
    expect(await backend(server).describe('plain:1b', signal())).toEqual({ tools: false, vision: false, thinking: false, contextLength: 32768 });
    expect(await backend(server).describe('missing:1b', signal())).toBeUndefined();
  });
});

describe('llamaCppBackend', () => {
  const backend = (s: MockLocalServer) => llamaCppBackend(s.origin, '/v1', guardedFetch({ origin: s.origin, paths: llamaCppPaths('/v1') }));

  it('probe: /health 200 is loaded; its one model answers whatever name is asked', async () => {
    server = await startMockLocalServer({ kind: 'llamacpp', models: { 'model.gguf': { loaded: true } } });
    const r = await backend(server).probe(['whatever-name'], signal());
    expect(r).toEqual({ reachable: true, models: { 'whatever-name': { installed: true, loaded: true, loading: false } } });
  });

  it('probe: /health 503 is loading', async () => {
    server = await startMockLocalServer({ kind: 'llamacpp', models: { 'model.gguf': {} } });
    server.loading = true;
    const r = await backend(server).probe(['model.gguf'], signal());
    expect(r).toEqual({ reachable: true, models: { 'model.gguf': { installed: true, loaded: false, loading: true } } });
  });

  it('warm asks for nothing: llama-server loads its model when it starts', async () => {
    server = await startMockLocalServer({ kind: 'llamacpp', models: { 'model.gguf': {} } });
    await backend(server).warm('model.gguf', { signal: signal() });
    expect(server.requests).toEqual([]);
  });
});

describe('openAiBackend', () => {
  const backend = (s: MockLocalServer) => openAiBackend(s.origin, '/v1', guardedFetch({ origin: s.origin, paths: openAiPaths('/v1') }));

  it('probe: reachable and installed from /v1/models; whether it is in memory, the API does not say', async () => {
    server = await startMockLocalServer({ kind: 'openai', models: { a: {}, b: { installed: false } } });
    const r = await backend(server).probe(['a', 'b'], signal());
    expect(r).toEqual({ reachable: true, models: { a: { installed: true }, b: { installed: false } } });
  });

  it('warm: one token from the model, so the server loads it', async () => {
    server = await startMockLocalServer({ kind: 'openai', models: { a: { loaded: false } } });
    await backend(server).warm('a', { signal: signal() });
    expect(server.chats()[0]!.body).toMatchObject({ model: 'a', max_tokens: 1 });
    expect(server.models.get('a')!.loaded).toBe(true);
  });
});

// The privacy review's N1. What KIND of server sits behind the OpenAI-compatible wire is read off what answered at
// boot, or off FLINT_LOCAL_SERVER, and either can be wrong: an Ollama taken for a plain OpenAI-compatible server
// serves cloud models under plain names all the same. So every look asks the one question only an Ollama answers
// with a listing, whatever the kind, and ../src/policy takes nothing on that wire for local until it is answered.
describe('askPlace / withPlace: every look asks the server what it is', () => {
  const open = (s: MockLocalServer) => guardedFetch({ origin: s.origin, paths: [...openAiPaths('/v1'), PLACE_PATH] });

  it('the question is the listing an Ollama gives, at the server’s origin', () => {
    expect(PLACE_PATH).toBe('/api/tags');
  });

  it('an Ollama answers with its listing, as it came: every model, with what its row says of a remote host', async () => {
    server = await startMockLocalServer({ kind: 'ollama', models: { 'main-model:30b': { loaded: true }, 'mine:latest': { remoteHost: 'https://ollama.com:443' } } });
    const said = await askPlace(open(server), server.origin, signal());
    expect(said).not.toBe('other');
    expect((said as { ollama: Array<Record<string, unknown>> }).ollama.map((r) => [r.name, r.remote_host])).toEqual([['main-model:30b', undefined], ['mine:latest', 'https://ollama.com:443']]);
    expect(server.requests.map((q) => `${q.method} ${q.path}`)).toEqual(['GET /api/tags']);
  });

  it('llama.cpp and a plain OpenAI-compatible server answer that there is no such thing: some other server', async () => {
    for (const kind of ['llamacpp', 'openai'] as const) {
      server = await startMockLocalServer({ kind, models: { 'only-model': { loaded: true } } });
      expect(await askPlace(open(server), server.origin, signal()), kind).toBe('other');
      await server.close();
      server = undefined;
    }
  });

  it('a server that says nothing either way teaches nothing: down, an error, not let through, an answer too long to read', async () => {
    const answering = (status: number, body = '{}') => (async () => new Response(body, { status })) as unknown as typeof fetch;
    for (const status of [401, 403, 429, 500, 503]) expect(await askPlace(answering(status), 'http://127.0.0.1:9', signal()), String(status)).toBeUndefined();
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    expect(await askPlace(down, 'http://127.0.0.1:9', signal())).toBeUndefined();
    // Too long to be read is not "no Ollama here": that would make every model on it local by its address.
    const huge = (async () => ({ status: 200, text: async () => ({ length: 9 * 1024 * 1024 }) as unknown as string, body: null })) as unknown as typeof fetch;
    expect(await askPlace(huge, 'http://127.0.0.1:9', signal())).toBeUndefined();
    // A 200 that is no listing is another server (LM Studio answers 200 to a path it does not know).
    expect(await askPlace(answering(200, '{"error":"Unexpected endpoint"}'), 'http://127.0.0.1:9', signal())).toBe('other');
    expect(await askPlace(answering(200, 'not json'), 'http://127.0.0.1:9', signal())).toBe('other');
  });

  it('it carries the key the server’s other requests carry, and the look’s own deadline', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const f = (async (url: string, init?: RequestInit) => {
      seen.push({ url, init: init ?? {} });
      return new Response('{"models":[]}');
    }) as unknown as typeof fetch;
    const s = signal();
    expect(await askPlace(f, 'http://127.0.0.1:1234', s, { authorization: 'Bearer test-key-not-real' })).toEqual({ ollama: [] });
    expect(seen).toEqual([{ url: 'http://127.0.0.1:1234/api/tags', init: { headers: { authorization: 'Bearer test-key-not-real' }, signal: s } }]);
  });

  it('withPlace: every probe also asks, and whoever keeps the answer is told each time; the backend is otherwise itself', async () => {
    server = await startMockLocalServer({ kind: 'ollama', models: { 'mine:latest': { loaded: true, remoteHost: 'https://ollama.com:443' } } });
    const f = open(server);
    const told: PlaceSaid[] = [];
    // An Ollama that Will's settings called a plain OpenAI-compatible server.
    const inner = openAiBackend(server.origin, '/v1', f);
    const b = withPlace(inner, (sig) => askPlace(f, server!.origin, sig), (said) => told.push(said));
    expect(b.kind).toBe('openai');
    const r = await b.probe(['mine:latest'], signal());
    expect(r).toEqual(await inner.probe(['mine:latest'], signal()));
    await b.probe(['mine:latest'], signal());
    expect(told).toHaveLength(2);
    expect((told[0] as { ollama: Array<Record<string, unknown>> }).ollama.map((row) => [row.name, row.remote_host])).toEqual([['mine:latest', 'https://ollama.com:443']]);
    expect(server.requests.filter((q) => q.path === '/api/tags')).toHaveLength(2);
  });

  it('withPlace: a server that did not say is reported as silent, not as an answer, and trouble keeping the answer never fails a look', async () => {
    server = await startMockLocalServer({ kind: 'llamacpp', models: { 'only-model': { loaded: true } } });
    const f = guardedFetch({ origin: server.origin, paths: [...llamaCppPaths('/v1'), PLACE_PATH] });
    const inner = llamaCppBackend(server.origin, '/v1', f);
    const told: PlaceSaid[] = [];
    let quiet = 0;
    const silent = withPlace(inner, async () => undefined, (said) => told.push(said), () => void quiet++);
    expect((await silent.probe(['only-model'], signal())).reachable).toBe(true);
    expect(told).toEqual([]);
    expect(quiet).toBe(1);
    await silent.probe(['only-model'], signal());
    expect(quiet).toBe(2); // every look that came back without it
    // Nobody to tell, and a keeper with trouble of its own: the look is the look all the same.
    expect((await withPlace(inner, async () => undefined, (said) => told.push(said)).probe(['only-model'], signal())).reachable).toBe(true);
    const brokenSilent = withPlace(inner, async () => undefined, (said) => told.push(said), () => {
      throw new Error('the keeper is broken');
    });
    expect((await brokenSilent.probe(['only-model'], signal())).reachable).toBe(true);
    // A look that was answered is never "silent".
    const answered = withPlace(inner, (sig) => askPlace(f, server!.origin, sig), () => {}, () => void quiet++);
    await answered.probe(['only-model'], signal());
    expect(quiet).toBe(2);
    // The re-review's N4: asked once more when the first try came back at once with nothing, and the second answer is
    // the look's; told as silence (with when the look began) only when both said nothing; a hang is asked once.
    let looks = 0;
    const since: number[] = [];
    const flaky = withPlace(inner, async () => (++looks === 1 ? undefined : 'other'), (said) => told.push(said), (at) => void since.push(at));
    told.length = 0;
    await flaky.probe(['only-model'], signal());
    expect([looks, told, since]).toEqual([2, ['other'], []]);
    looks = 0;
    const began = Date.now();
    await withPlace(inner, async () => (looks++, undefined), () => {}, (at) => void since.push(at)).probe(['only-model'], signal());
    expect(looks).toBe(2);
    expect(since).toHaveLength(1);
    expect(since[0]).toBeGreaterThanOrEqual(began);
    looks = 0;
    const hung = withPlace(inner, (sig) => (looks++, new Promise<undefined>((resolve) => sig.addEventListener('abort', () => resolve(undefined)))), () => {}, (at) => void since.push(at));
    await hung.probe(['only-model'], AbortSignal.timeout(60));
    expect([looks, since.length]).toEqual([1, 2]);
    told.length = 0;
    const broken = withPlace(inner, (sig) => askPlace(f, server!.origin, sig), () => {
      throw new Error('the keeper is broken');
    });
    expect((await broken.probe(['only-model'], signal())).reachable).toBe(true);
    const heard = withPlace(inner, (sig) => askPlace(f, server!.origin, sig), (said) => told.push(said));
    await heard.probe(['only-model'], signal());
    expect(told).toEqual(['other']);
  });
});

describe('detectServer', () => {
  const detect = (s: MockLocalServer) => detectServer(s.origin, guardedFetch({ origin: s.origin, paths: DETECT_PATHS }), signal(), 'openai');

  it('tells Ollama, llama.cpp and a plain OpenAI-compatible server apart', async () => {
    for (const kind of ['ollama', 'llamacpp', 'openai'] as const) {
      server = await startMockLocalServer({ kind });
      expect(await detect(server), kind).toBe(kind);
      await server.close();
    }
    server = undefined;
  });

  it('a server that is down is taken for what the wire implies', async () => {
    server = await startMockLocalServer();
    const origin = server.origin;
    await server.close();
    server = undefined;
    expect(await detectServer(origin, guardedFetch({ origin, paths: DETECT_PATHS }), signal(), 'ollama')).toBe('ollama');
  });
});
