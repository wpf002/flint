import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AnthropicProvider } from '../../src/provider/anthropic/index.js';
import { isFlintError } from '../../src/types/error.js';

/**
 * `maxRetries` and `timeoutMs` reach the real SDK client. Checked against a
 * loopback HTTP server standing in for the API (nothing leaves this machine):
 * how many requests one failing call makes, and how long a silent server is
 * waited for. The server's chat brains set both low, so one failing try is quick.
 */

let server: Server | undefined;
afterEach(async () => {
  server?.closeAllConnections();
  await new Promise((r) => (server ? server.close(() => r(undefined)) : r(undefined)));
  server = undefined;
});

/** A stand-in API: `answer` gets each request's number (from 1) and replies, or never does. */
async function fakeApi(answer: (n: number) => { status: number; body: unknown } | 'silent'): Promise<{ baseURL: string; requests: () => number }> {
  let n = 0;
  server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const a = answer(++n);
      if (a === 'silent') return; // never answers: the client's timeout has to end it
      // retry-after-ms: the SDK's own backoff between retries, kept at 1 ms here.
      res.writeHead(a.status, { 'content-type': 'application/json', 'retry-after-ms': '1' });
      res.end(JSON.stringify(a.body));
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return { baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests: () => n };
}

const overloaded = { status: 529, body: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } };
const ask = { model: 'claude-test', messages: [{ id: 'm1', role: 'user' as const, content: 'hi', timestamp: 0 }] };

async function failure(p: AnthropicProvider) {
  try {
    await p.generate(ask);
  } catch (err) {
    if (isFlintError(err)) return err.error;
    throw err;
  }
  throw new Error('the call did not fail');
}

describe('AnthropicProvider client options', () => {
  it('maxRetries: 0 makes one request for one failing call', async () => {
    const api = await fakeApi(() => overloaded);
    const err = await failure(new AnthropicProvider({ apiKey: 'k', baseURL: api.baseURL, maxRetries: 0 }));
    expect(api.requests()).toBe(1);
    expect(err).toMatchObject({ kind: 'provider_unavailable', providerCode: '529', retryable: true });
  });

  it('unset, the SDK retries twice on its own: three requests', async () => {
    const api = await fakeApi(() => overloaded);
    await failure(new AnthropicProvider({ apiKey: 'k', baseURL: api.baseURL }));
    expect(api.requests()).toBe(3);
  });

  it('timeoutMs ends a call the server never answers, as a retryable timeout', async () => {
    const api = await fakeApi(() => 'silent');
    const started = Date.now();
    const err = await failure(new AnthropicProvider({ apiKey: 'k', baseURL: api.baseURL, maxRetries: 0, timeoutMs: 150 }));
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(api.requests()).toBe(1);
    expect(err).toMatchObject({ kind: 'timeout', retryable: true });
  });

  it('a spent credit balance is a 400 that is never retried, with its status and the vendor\'s words', async () => {
    const api = await fakeApi(() => ({
      status: 400,
      body: { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } },
    }));
    const err = await failure(new AnthropicProvider({ apiKey: 'k', baseURL: api.baseURL }));
    expect(api.requests()).toBe(1);
    expect(err).toMatchObject({ kind: 'validation', providerCode: '400', retryable: false });
    expect(err.message).toMatch(/credit balance is too low/i);
  });
});
