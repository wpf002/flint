import { describe, it, expect } from 'vitest';
import { OllamaProvider } from '../../src/provider/ollama/index.js';
import { pickOllamaModel } from '../../src/provider/ollama/default-model.js';
import type { Message } from '../../src/types/message.js';
import type { StreamEvent } from '../../src/types/stream.js';
import type { ToolDefinition } from '../../src/types/tool.js';

/**
 * Three guards on the native Ollama adapter that a review found no test would
 * miss (its survivors 9 and 10): each was deleted, and every test still passed.
 *
 *  - a whole reply read as a stream (what every whole pass is once a deadline
 *    is set, which is always in the local and hybrid modes) never follows a
 *    redirect. The existing redirect test builds a provider with no deadline,
 *    so that request was never looked at;
 *  - neither do the two list calls that choose a model when none is named;
 *  - an error object sent INSIDE a live stream, after the 200, ends the call
 *    as an error. It used to be read as an empty line, and the reply ended
 *    `complete` with whatever had arrived.
 */

type Init = RequestInit & { body?: string };
const user = (content: string): Message => ({ id: 'u1', role: 'user', content, timestamp: 0 });
const weather: ToolDefinition = { name: 'get_weather', description: 'Weather', inputSchema: { type: 'object', properties: {} }, idempotent: true };
const ndjson = (lines: unknown[]): Response =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const l of lines) controller.enqueue(new TextEncoder().encode(`${JSON.stringify(l)}\n`));
        controller.close();
      },
    }),
    { status: 200 },
  );
const said = (content: string, done = false) => ({ model: 'm', message: { role: 'assistant', content }, done, ...(done ? { done_reason: 'stop', prompt_eval_count: 5, eval_count: 2 } : {}) });
async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

describe('a whole reply read as a stream never follows a redirect', () => {
  function recording(lines: unknown[]) {
    const seen: Array<{ url: string; init: Init; body: Record<string, unknown> }> = [];
    const fetchImpl = (async (url: string, init?: Init) => {
      seen.push({ url, init: init ?? {}, body: JSON.parse(init?.body ?? '{}') as Record<string, unknown> });
      return ndjson(lines);
    }) as unknown as typeof fetch;
    return { fetchImpl, seen };
  }

  it('generate() under a deadline: the request is the streamed one, and it carries redirect: error', async () => {
    const { fetchImpl, seen } = recording([said('The answer '), said('is 4.'), said('', true)]);
    const p = new OllamaProvider({ fetch: fetchImpl, firstTokenTimeoutMs: 5_000, requestTimeoutMs: 10_000 });
    const out = await p.generate({ model: 'm', messages: [user('2+2?')] });
    expect(out.message.content).toBe('The answer is 4.');
    expect(seen).toHaveLength(1);
    // This is the folded pass: asked as a stream, answered whole.
    expect(seen[0]!.body.stream).toBe(true);
    expect(seen[0]!.init.redirect).toBe('error');
  });

  it('the first pass of a turn with tools, and a pass held to a schema, under a deadline: the same', async () => {
    const tools = recording([said('It is sunny.'), said('', true)]);
    const p = new OllamaProvider({ fetch: tools.fetchImpl, firstTokenTimeoutMs: 5_000, capabilities: () => ({ toolCalling: 'native' }) });
    await collect(p.stream({ model: 'm', messages: [user('weather?')], tools: [weather] }));
    const schema = recording([said('{"a":1}'), said('', true)]);
    const q = new OllamaProvider({ fetch: schema.fetchImpl, firstTokenTimeoutMs: 5_000 });
    await q.generate({ model: 'm', messages: [user('json')], responseFormat: { type: 'json_schema', name: 'x', schema: { type: 'object' } } }).catch(() => {});
    for (const r of [...tools.seen, ...schema.seen]) expect(r.init.redirect, JSON.stringify(r.body).slice(0, 60)).toBe('error');
    expect(tools.seen.length + schema.seen.length).toBeGreaterThanOrEqual(2);
  });

  it('the deadline as a function read on every call (how the server sets it) changes nothing about that', async () => {
    const { fetchImpl, seen } = recording([said('ok'), said('', true)]);
    let on = true;
    const p = new OllamaProvider({ fetch: fetchImpl, firstTokenTimeoutMs: () => (on ? 5_000 : undefined) });
    await p.generate({ model: 'm', messages: [user('hi')] });
    on = false;
    await p.generate({ model: 'm', messages: [user('hi')] }).catch(() => {});
    expect(seen.length).toBe(2);
    for (const r of seen) expect(r.init.redirect).toBe('error');
  });
});

describe('choosing a model when none is named never follows a redirect', () => {
  it('both list calls carry redirect: error, whichever of them answers', async () => {
    const seen: Array<{ url: string; init: Init }> = [];
    const fetchImpl = (async (url: string, init?: Init) => {
      seen.push({ url, init: init ?? {} });
      return new Response(JSON.stringify({ models: url.endsWith('/api/tags') ? [{ name: 'some-model:7b', details: { family: 'qwen' } }] : [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const picked = await pickOllamaModel({ baseURL: 'http://127.0.0.1:11434', fetch: fetchImpl });
    expect(picked).toMatchObject({ model: 'some-model:7b', answered: true });
    expect(seen.map((s) => new URL(s.url).pathname).sort()).toEqual(['/api/ps', '/api/tags']);
    for (const s of seen) expect(s.init.redirect, s.url).toBe('error');
  });

  it('a server that answers with a redirect is one that did not answer: the default, and nothing is followed', async () => {
    const asked: string[] = [];
    const redirecting = (async (url: string, init?: Init) => {
      asked.push(url);
      // What fetch does with redirect: 'error' when the server says 307.
      if (init?.redirect === 'error') throw new TypeError('fetch failed', { cause: new Error('unexpected redirect') });
      return new Response(JSON.stringify({ models: [{ name: 'someone-elses-model:1b' }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const picked = await pickOllamaModel({ baseURL: 'http://127.0.0.1:11434', fetch: redirecting });
    expect(picked.answered).toBe(false);
    expect(picked.from).toBe('default');
    expect(picked.model).not.toBe('someone-elses-model:1b');
    for (const url of asked) expect(new URL(url).host).toBe('127.0.0.1:11434');
  });
});

describe('an error sent inside a live stream ends the call as an error', () => {
  const failing = (lines: unknown[]) => new OllamaProvider({ fetch: (async () => ndjson(lines)) as unknown as typeof fetch });

  it('after some text: the text that arrived, then an error, and never a reply that ends complete', async () => {
    const events = await collect(failing([said('The first half '), { error: 'model runner has unexpectedly stopped' }]).stream({ model: 'm', messages: [user('hi')] }));
    expect(events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta).join('')).toBe('The first half ');
    const last = events.at(-1)!;
    expect(last.type).toBe('error');
    expect(events.some((e) => e.type === 'done')).toBe(false);
  });

  it('as the very first line, and as an object rather than a string: an error both times', async () => {
    for (const error of ['out of memory', { message: 'out of memory', code: 500 }]) {
      const events = await collect(failing([{ error }]).stream({ model: 'm', messages: [user('hi')] }));
      expect(events.map((e) => e.type), JSON.stringify(error)).toEqual(['error']);
    }
  });

  it('a line with a null error, or none, is an ordinary line: the reply completes', async () => {
    const events = await collect(failing([{ ...said('fine'), error: null }, said('', true)]).stream({ model: 'm', messages: [user('hi')] }));
    expect(events.at(-1)).toMatchObject({ type: 'done', reason: 'complete' });
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });
});
