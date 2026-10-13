import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { OllamaEmbedder } from '../src/embedder.js';

/**
 * The embedder is sent every fact Flint stores and every question it recalls
 * with. It talks to Ollama at one fixed address, and a redirect from that
 * address is never followed: a 307 would carry the text, body and all, to
 * wherever it pointed. A review found that deleting the one line that says so
 * failed no test (its survivor 7). These run real requests between two
 * loopback servers, so what is checked is what leaves, not an option's name.
 */

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

/** A loopback server; `handle` answers each request, and every body it was sent is kept. */
async function listen(handle: (path: string) => { status: number; headers?: Record<string, string>; body?: string }): Promise<{ origin: string; bodies: string[] }> {
  const bodies: string[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += String(c)));
    req.on('end', () => {
      bodies.push(body);
      const a = handle(req.url ?? '/');
      res.writeHead(a.status, { 'content-type': 'application/json', ...(a.headers ?? {}) });
      res.end(a.body ?? '');
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, bodies };
}

const SECRET = 'ZEBRA-7781: what Will told Flint in confidence';

describe('OllamaEmbedder never follows a redirect', () => {
  it('a 307 from Ollama\'s address: the call fails, and the text is not sent on to where it pointed', async () => {
    const elsewhere = await listen(() => ({ status: 200, body: JSON.stringify({ embedding: [1, 2, 3] }) }));
    for (const status of [301, 302, 307, 308]) {
      const ollama = await listen(() => ({ status, headers: { location: `${elsewhere.origin}/api/embeddings` } }));
      const embedder = new OllamaEmbedder({ baseURL: ollama.origin });
      await expect(embedder.embed([SECRET]), String(status)).rejects.toBeDefined();
      // The address it was configured with did get the request...
      expect(ollama.bodies.join('')).toContain('ZEBRA-7781');
    }
    // ...and nothing went anywhere else, for any kind of redirect.
    expect(elsewhere.bodies).toEqual([]);
  });

  it('a redirect to another path on the same server is not followed either', async () => {
    let hits = 0;
    const ollama = await listen((path) => (path === '/api/embeddings' ? { status: 307, headers: { location: '/elsewhere' } } : (hits++, { status: 200, body: JSON.stringify({ embedding: [9] }) })));
    await expect(new OllamaEmbedder({ baseURL: ollama.origin }).embed([SECRET])).rejects.toBeDefined();
    expect(hits).toBe(0);
  });

  it('with no redirect it embeds as before, one request a text, in order', async () => {
    const ollama = await listen(() => ({ status: 200, body: JSON.stringify({ embedding: [0.5, 0.25] }) }));
    const out = await new OllamaEmbedder({ baseURL: ollama.origin, model: 'embed-model' }).embed(['one', 'two']);
    expect(out).toEqual([[0.5, 0.25], [0.5, 0.25]]);
    expect(ollama.bodies.map((b) => JSON.parse(b) as { model: string; prompt: string })).toEqual([{ model: 'embed-model', prompt: 'one' }, { model: 'embed-model', prompt: 'two' }]);
  });

  it('the request an injected fetch is handed says so too (the server wraps the embedder\'s fetch with its own)', async () => {
    const inits: RequestInit[] = [];
    const f = (async (_url: string, init?: RequestInit) => {
      inits.push(init ?? {});
      return new Response(JSON.stringify({ embedding: [1] }), { status: 200 });
    }) as unknown as typeof fetch;
    await new OllamaEmbedder({ fetch: f }).embed(['a', 'b']);
    expect(inits.map((i) => i.redirect)).toEqual(['error', 'error']);
  });
});
