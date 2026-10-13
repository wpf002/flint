import { describe, it, expect } from 'vitest';
import { OllamaProvider, type OllamaProviderOptions } from '../../src/provider/ollama/index.js';
import { isFlintError } from '../../src/types/error.js';
import type { Message } from '../../src/types/message.js';
import type { StreamEvent } from '../../src/types/stream.js';
import type { ToolDefinition } from '../../src/types/tool.js';

/**
 * Optional deadlines on the native Ollama adapter. A cold or slow model does
 * not fail, it stalls; with a deadline set a stalled call ends, once, with an
 * error the caller can act on. With none set, the adapter makes exactly the
 * calls it did.
 */

const user = (content: string): Message => ({ id: 'u1', role: 'user', content, timestamp: 0 });
const toolResult: Message = { id: 't1', role: 'tool_result', toolCallId: 'c1', content: '{"toolName":"get_weather","result":"sunny","isError":false}', timestamp: 0 };
const weather: ToolDefinition = { name: 'get_weather', description: 'Weather', inputSchema: { type: 'object', properties: {} }, idempotent: true };

type Init = RequestInit & { body?: string };
const line = (o: unknown): Uint8Array => new TextEncoder().encode(`${JSON.stringify(o)}\n`);
const chunk = (message: Record<string, unknown>, done = false) => ({ model: 'm', message: { role: 'assistant', content: '', ...message }, done, ...(done ? { done_reason: 'stop', prompt_eval_count: 5, eval_count: 2 } : {}) });

/** A streamed /api/chat whose lines arrive after the given waits; `Infinity` never arrives. It ignores its signal on purpose. */
function streamed(steps: Array<{ after: number; chunk?: unknown }>): { fetch: typeof fetch; inits: Init[] } {
  const inits: Init[] = [];
  const fn = (async (_url: string, init?: Init) => {
    inits.push(init ?? {});
    let i = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const step = steps[i++];
        if (!step) return controller.close();
        if (step.after === Infinity) return new Promise<void>(() => {});
        if (step.after > 0) await new Promise((r) => setTimeout(r, step.after));
        controller.enqueue(line(step.chunk));
      },
    });
    return new Response(body, { status: 200 });
  }) as unknown as typeof fetch;
  return { fetch: fn, inits };
}

const never = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
const whole = (content: string, after = 0, inits: Init[] = []) =>
  (async (_url: string, init?: Init) => {
    inits.push(init ?? {});
    if (after > 0) await new Promise((r) => setTimeout(r, after));
    return new Response(JSON.stringify(chunk({ content }, true)), { status: 200 });
  }) as unknown as typeof fetch;

async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}
const provider = (opts: OllamaProviderOptions) => new OllamaProvider(opts);

describe('with no deadline set, the calls are what they were', () => {
  it('a streamed call: the same init, and the caller\'s own signal', async () => {
    const s = streamed([{ after: 0, chunk: chunk({ content: 'hi' }) }, { after: 0, chunk: chunk({}, true) }]);
    const ac = new AbortController();
    const events = await collect(provider({ fetch: s.fetch }).stream({ model: 'm', messages: [user('hello')], signal: ac.signal }));
    expect(events.map((e) => e.type)).toEqual(['text', 'done']);
    expect(Object.keys(s.inits[0]!).sort()).toEqual(['body', 'headers', 'method', 'redirect', 'signal']);
    expect(s.inits[0]!.signal).toBe(ac.signal);
    expect(JSON.parse(s.inits[0]!.body!)).toEqual({ model: 'm', messages: [{ role: 'user', content: 'hello' }], stream: true });
  });

  it('a call that is not streamed: the same init, no signal when the caller gave none', async () => {
    const inits: Init[] = [];
    const r = await provider({ fetch: whole('ok', 0, inits) }).generate({ model: 'm', messages: [user('hello')] });
    expect(r.message.content).toBe('ok');
    expect(Object.keys(inits[0]!).sort()).toEqual(['body', 'headers', 'method', 'redirect']);
  });
});

describe('firstTokenTimeoutMs (streamed calls)', () => {
  it('a model that never sends a line: one first_token_timeout error, not retryable', async () => {
    const s = streamed([{ after: Infinity }]);
    const events = await collect(provider({ fetch: s.fetch, firstTokenTimeoutMs: 30 }).stream({ model: 'm', messages: [user('hello')] }));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', error: { kind: 'timeout', providerCode: 'first_token_timeout', retryable: false, message: 'Ollama sent no first token in 30 ms' } });
  });

  it('a server that never answers the request at all ends the same way', async () => {
    const events = await collect(provider({ fetch: never, firstTokenTimeoutMs: 30 }).stream({ model: 'm', messages: [user('hello')] }));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', error: { providerCode: 'first_token_timeout' } });
  });

  it("a thinking model's reasoning counts as a first token, and is never shown", async () => {
    const s = streamed([
      { after: 0, chunk: chunk({ thinking: 'Let me think about this.' }) },
      { after: 80, chunk: chunk({ content: 'Answer.' }) },
      { after: 0, chunk: chunk({}, true) },
    ]);
    const events = await collect(provider({ fetch: s.fetch, firstTokenTimeoutMs: 40 }).stream({ model: 'm', messages: [user('hello')] }));
    expect(events.map((e) => (e.type === 'text' ? e.delta : e.type))).toEqual(['Answer.', 'done']);
  });

  it('text in time is delivered, and a slow rest of the answer is not cut off', async () => {
    const s = streamed([
      { after: 0, chunk: chunk({ content: 'Hello' }) },
      { after: 80, chunk: chunk({ content: ' there.' }) },
      { after: 0, chunk: chunk({}, true) },
    ]);
    const events = await collect(provider({ fetch: s.fetch, firstTokenTimeoutMs: 40 }).stream({ model: 'm', messages: [user('hello')] }));
    expect(events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta).join('')).toBe('Hello there.');
    expect(events.at(-1)?.type).toBe('done');
  });

  it("the caller's own cancellation still reads as a cancellation", async () => {
    const s = streamed([{ after: Infinity }]);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 20);
    const events = await collect(provider({ fetch: s.fetch, firstTokenTimeoutMs: 5000 }).stream({ model: 'm', messages: [user('hello')], signal: ac.signal }));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', error: { kind: 'timeout', message: 'Request aborted', retryable: false } });
  });

  it('toolPassTimeoutMs is the deadline for the answer after a tool result', async () => {
    const slow = streamed([{ after: 80, chunk: chunk({ content: 'It is sunny.' }) }, { after: 0, chunk: chunk({}, true) }]);
    const after = await collect(provider({ fetch: slow.fetch, firstTokenTimeoutMs: 30, toolPassTimeoutMs: 300 }).stream({ model: 'm', messages: [user('weather?'), toolResult], tools: [weather] }));
    expect(after.map((e) => e.type)).toEqual(['text', 'done']);
  });

  it('a function is read on every call, so a server can turn the deadline on and off', async () => {
    let ms: number | undefined;
    const p = provider({ fetch: streamed([{ after: Infinity }]).fetch, firstTokenTimeoutMs: () => ms });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);
    // Off: only the caller ends a stalled call. (This transport ignores its signal, so the adapter is given one that does not.)
    const honest = ((_u: string, init?: Init) => new Promise<Response>((_r, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)))) as unknown as typeof fetch;
    const off = await collect(provider({ fetch: honest, firstTokenTimeoutMs: () => ms }).stream({ model: 'm', messages: [user('hello')], signal: ac.signal }));
    expect(off[0]).toMatchObject({ type: 'error', error: { message: 'Request aborted' } });
    ms = 30;
    const on = await collect(p.stream({ model: 'm', messages: [user('hello')] }));
    expect(on[0]).toMatchObject({ type: 'error', error: { providerCode: 'first_token_timeout' } });
  });
});

// The routing review's M5. The tool-decision pass (tools offered, no tool result yet) answers whole, and
// tools are offered on nearly every chat turn. So the first-token deadline covered almost nothing on this
// wire: a main model that stalled held the turn for the whole-reply deadline (120 s by default).
describe('firstTokenTimeoutMs covers the calls that answer whole: they are streamed, timed and folded', () => {
  const tools = [weather];

  it('the tool-decision pass of a stalled model ends at the FIRST-TOKEN deadline, not the whole-reply one', async () => {
    const started = Date.now();
    const events = await collect(provider({ fetch: never, firstTokenTimeoutMs: 30, requestTimeoutMs: 5000 }).stream({ model: 'm', messages: [user('weather?')], tools }));
    expect(Date.now() - started).toBeLessThan(1000);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', error: { kind: 'timeout', providerCode: 'first_token_timeout', retryable: false, message: 'Ollama sent no first token in 30 ms' } });
    // Headers at once and then nothing (a loaded model that hangs): the same.
    const hung = streamed([{ after: Infinity }]);
    const again = await collect(provider({ fetch: hung.fetch, firstTokenTimeoutMs: 30, requestTimeoutMs: 5000 }).stream({ model: 'm', messages: [user('weather?')], tools }));
    expect(again[0]).toMatchObject({ type: 'error', error: { providerCode: 'first_token_timeout' } });
  });

  it('it is sent stream: true, and what comes back is the one reply a non-streamed call gives: the text joined, the counts the last line\'s', async () => {
    const s = streamed([
      { after: 0, chunk: chunk({ content: 'It is ' }) },
      { after: 0, chunk: chunk({ content: 'sunny' }) },
      { after: 0, chunk: chunk({ content: '.' }) },
      { after: 0, chunk: chunk({}, true) },
    ]);
    const events = await collect(provider({ fetch: s.fetch, firstTokenTimeoutMs: 200 }).stream({ model: 'm', messages: [user('weather?')], tools }));
    expect(events).toEqual([
      { type: 'text', delta: 'It is sunny.' },
      { type: 'done', reason: 'complete', usage: { input: 5, output: 2 } },
    ]);
    expect(s.inits).toHaveLength(1);
    expect(JSON.parse(s.inits[0]!.body!).stream).toBe(true);
    expect(JSON.parse(s.inits[0]!.body!).tools).toHaveLength(1);
  });

  it('a tool call that arrives in a line is the turn\'s tool call', async () => {
    const s = streamed([
      { after: 0, chunk: chunk({ tool_calls: [{ function: { name: 'get_weather', arguments: { city: 'Austin' } } }] }) },
      { after: 0, chunk: chunk({}, true) },
    ]);
    const events = await collect(provider({ fetch: s.fetch, firstTokenTimeoutMs: 200 }).stream({ model: 'm', messages: [user('weather?')], tools }));
    expect(events.map((e) => e.type)).toEqual(['tool_call', 'done']);
    expect(events[0]).toMatchObject({ type: 'tool_call', call: { toolName: 'get_weather', args: { city: 'Austin' } } });
    expect(events[1]).toMatchObject({ reason: 'tool_call' });
  });

  it('a tool call the model wrote as TEXT, split over lines, is still recovered: the fold is what the recovery reads', async () => {
    const s = streamed([
      { after: 0, chunk: chunk({ content: '{"name": "get_wea' }) },
      { after: 0, chunk: chunk({ content: 'ther", "parameters": {"city": "Austin"}}' }) },
      { after: 0, chunk: chunk({}, true) },
    ]);
    const events = await collect(provider({ fetch: s.fetch, firstTokenTimeoutMs: 200 }).stream({ model: 'm', messages: [user('weather?')], tools }));
    expect(events.map((e) => e.type)).toEqual(['tool_call', 'done']);
    expect(events[0]).toMatchObject({ call: { toolName: 'get_weather', args: { city: 'Austin' } } });
  });

  it('an empty turn is still asked again, as before; a stalled one is asked once', async () => {
    let n = 0;
    const emptyThenText = (async (_u: string, init?: Init) => {
      n += 1;
      const text = n < 3 ? '' : 'Third time.';
      void init;
      return new Response(`${JSON.stringify(chunk({ content: text }))}\n${JSON.stringify(chunk({}, true))}\n`, { status: 200 });
    }) as unknown as typeof fetch;
    const events = await collect(provider({ fetch: emptyThenText, firstTokenTimeoutMs: 200 }).stream({ model: 'm', messages: [user('weather?')], tools }));
    expect(n).toBe(3);
    expect(events[0]).toEqual({ type: 'text', delta: 'Third time.' });
    let calls = 0;
    const counting = (() => {
      calls += 1;
      return new Promise<Response>(() => {});
    }) as unknown as typeof fetch;
    await collect(provider({ fetch: counting, firstTokenTimeoutMs: 30 }).stream({ model: 'm', messages: [user('weather?')], tools }));
    expect(calls).toBe(1);
  });

  it("a thinking model's reasoning is a first token there too, and never part of the answer", async () => {
    const s = streamed([
      { after: 0, chunk: chunk({ thinking: 'Let me think.' }) },
      { after: 80, chunk: chunk({ content: 'Sunny.' }) },
      { after: 0, chunk: chunk({}, true) },
    ]);
    const events = await collect(provider({ fetch: s.fetch, firstTokenTimeoutMs: 40 }).stream({ model: 'm', messages: [user('weather?')], tools }));
    expect(events.map((e) => (e.type === 'text' ? e.delta : e.type))).toEqual(['Sunny.', 'done']);
  });

  it('generate() and a constrained reply are streamed and folded the same way, and time out on their first token', async () => {
    const s = streamed([{ after: 0, chunk: chunk({ content: '{"action":' }) }, { after: 0, chunk: chunk({ content: '"log"}' }) }, { after: 0, chunk: chunk({}, true) }]);
    const r = await provider({ fetch: s.fetch, firstTokenTimeoutMs: 200 }).generate({ model: 'm', messages: [user('hello')], responseFormat: { type: 'json_schema', name: 'x', schema: { type: 'object' } } });
    expect(JSON.parse(r.message.content)).toEqual({ action: 'log' });
    expect(JSON.parse(s.inits[0]!.body!)).toMatchObject({ stream: true, format: { type: 'object' } });
    const plain = streamed([{ after: 0, chunk: chunk({ content: 'fine' }) }, { after: 0, chunk: chunk({}, true) }]);
    expect((await provider({ fetch: plain.fetch, firstTokenTimeoutMs: 200 }).generate({ model: 'm', messages: [user('hello')] })).message.content).toBe('fine');
    const err = await provider({ fetch: never, firstTokenTimeoutMs: 30, requestTimeoutMs: 5000 }).generate({ model: 'm', messages: [user('hello')] }).catch((e: unknown) => e);
    expect(isFlintError(err) && err.error.providerCode).toBe('first_token_timeout');
  });

  it('the whole reply is still bounded: a model that keeps sending past the request deadline is cut off there', async () => {
    const drip = streamed([...Array.from({ length: 20 }, () => ({ after: 15, chunk: chunk({ content: 'x' }) })), { after: 0, chunk: chunk({}, true) }]);
    const events = await collect(provider({ fetch: drip.fetch, firstTokenTimeoutMs: 200, requestTimeoutMs: 60 }).stream({ model: 'm', messages: [user('weather?')], tools }));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', error: { providerCode: 'request_timeout', message: 'Ollama did not answer in 60 ms' } });
  });

  it('an error object inside the stream is the failure it would have been; a stream that ends before it is done is one too', async () => {
    const failing = streamed([{ after: 0, chunk: chunk({ content: 'par' }) }, { after: 0, chunk: { error: 'llama runner process has terminated' } }]);
    const a = await collect(provider({ fetch: failing.fetch, firstTokenTimeoutMs: 200 }).stream({ model: 'm', messages: [user('weather?')], tools }));
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ type: 'error', error: { kind: 'provider_unavailable', providerCode: '500' } });
    const cut = streamed([{ after: 0, chunk: chunk({ content: 'cut off mid' }) }]);
    const b = await collect(provider({ fetch: cut.fetch, firstTokenTimeoutMs: 200 }).stream({ model: 'm', messages: [user('weather?')], tools }));
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({ type: 'error', error: { providerCode: '502' } });
    // An HTTP error keeps its status, as on a non-streamed call.
    const notFound = (async () => new Response('{"error":"model \\"x\\" not found"}', { status: 404 })) as unknown as typeof fetch;
    const c = await collect(provider({ fetch: notFound, firstTokenTimeoutMs: 200 }).stream({ model: 'x', messages: [user('weather?')], tools }));
    expect(c[0]).toMatchObject({ type: 'error', error: { kind: 'validation', providerCode: '404' } });
  });

  it('with no first-token deadline the call is the non-streamed one it always was', async () => {
    const inits: Init[] = [];
    await collect(provider({ fetch: whole('ok', 0, inits), requestTimeoutMs: 500 }).stream({ model: 'm', messages: [user('weather?')], tools }));
    expect(JSON.parse(inits[0]!.body!).stream).toBe(false);
    const off: Init[] = [];
    await collect(provider({ fetch: whole('ok', 0, off), firstTokenTimeoutMs: () => undefined }).stream({ model: 'm', messages: [user('weather?')], tools }));
    expect(JSON.parse(off[0]!.body!).stream).toBe(false);
  });
});

describe('idleTimeoutMs (a reply that begins and then goes quiet)', () => {
  it('a streamed answer: text, then nothing, ends with idle_timeout after what was shown', async () => {
    const s = streamed([{ after: 0, chunk: chunk({ content: 'Hello there, ' }) }, { after: Infinity }]);
    const events = await collect(provider({ fetch: s.fetch, firstTokenTimeoutMs: 500, idleTimeoutMs: 40 }).stream({ model: 'm', messages: [user('hello')] }));
    expect(events.map((e) => e.type)).toEqual(['text', 'error']);
    expect(events[1]).toMatchObject({ type: 'error', error: { kind: 'timeout', providerCode: 'idle_timeout', retryable: false, message: 'Ollama went quiet for 40 ms in the middle of a reply' } });
  });

  it('reasoning, then nothing: the first token came, so it is the idle deadline that ends it (it used to hang until the caller gave up)', async () => {
    const s = streamed([{ after: 0, chunk: chunk({ thinking: 'Hmm.' }) }, { after: Infinity }]);
    const events = await collect(provider({ fetch: s.fetch, firstTokenTimeoutMs: 30, idleTimeoutMs: 40 }).stream({ model: 'm', messages: [user('hello')] }));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', error: { providerCode: 'idle_timeout' } });
  });

  it('each line restarts it: a slow, steady answer is never cut off', async () => {
    const s = streamed([...Array.from({ length: 6 }, () => ({ after: 25, chunk: chunk({ content: 'x' }) })), { after: 25, chunk: chunk({}, true) }]);
    const events = await collect(provider({ fetch: s.fetch, firstTokenTimeoutMs: 100, idleTimeoutMs: 60 }).stream({ model: 'm', messages: [user('hello')] }));
    expect(events.at(-1)?.type).toBe('done');
    expect(events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta).join('')).toBe('xxxxxx');
  });

  it('the folded pass has it too, and it works with no first-token deadline on the streamed path', async () => {
    const folded = streamed([{ after: 0, chunk: chunk({ content: 'It is' }) }, { after: Infinity }]);
    const a = await collect(provider({ fetch: folded.fetch, firstTokenTimeoutMs: 500, idleTimeoutMs: 40, requestTimeoutMs: 5000 }).stream({ model: 'm', messages: [user('weather?')], tools: [weather] }));
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ type: 'error', error: { providerCode: 'idle_timeout' } });
    const only = streamed([{ after: 0, chunk: chunk({ content: 'Hello there, ' }) }, { after: Infinity }]);
    const b = await collect(provider({ fetch: only.fetch, idleTimeoutMs: 40 }).stream({ model: 'm', messages: [user('hello')] }));
    expect(b.map((e) => e.type)).toEqual(['text', 'error']);
  });
});

describe('onFirstOutput (for a caller that measures time to first token)', () => {
  it('is called once per request, when the first sign of output arrives: on the streamed path and on the folded one', async () => {
    for (const withTools of [false, true]) {
      const marks: number[] = [];
      const t0 = Date.now();
      const s = streamed([
        { after: 40, chunk: chunk({ content: 'It is ' }) },
        { after: 60, chunk: chunk({ content: 'sunny.' }) },
        { after: 0, chunk: chunk({}, true) },
      ]);
      const p = provider({ fetch: s.fetch, firstTokenTimeoutMs: 500, onFirstOutput: () => marks.push(Date.now() - t0) });
      const events = await collect(p.stream({ model: 'm', messages: [user('weather?')], ...(withTools ? { tools: [weather] } : {}) }));
      const total = Date.now() - t0;
      expect(events.at(-1)?.type, String(withTools)).toBe('done');
      expect(marks, String(withTools)).toHaveLength(1);
      // At the first line (about 40 ms in), well before the whole reply was in (about 100 ms).
      expect(marks[0]!).toBeGreaterThanOrEqual(30);
      expect(marks[0]!).toBeLessThan(total - 30);
    }
  });

  it('a callback that throws is its own trouble, never the request\'s', async () => {
    const s = streamed([{ after: 0, chunk: chunk({ content: 'ok' }) }, { after: 0, chunk: chunk({}, true) }]);
    const events = await collect(
      provider({
        fetch: s.fetch,
        firstTokenTimeoutMs: 200,
        onFirstOutput: () => {
          throw new Error('boom');
        },
      }).stream({ model: 'm', messages: [user('weather?')], tools: [weather] }),
    );
    expect(events.map((e) => e.type)).toEqual(['text', 'done']);
  });
});

describe('requestTimeoutMs (calls that answer whole, when no first-token deadline is set)', () => {
  it('the tool-decision pass: the whole reply is under the request deadline', async () => {
    const events = await collect(provider({ fetch: never, requestTimeoutMs: 40 }).stream({ model: 'm', messages: [user('weather?')], tools: [weather] }));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', error: { kind: 'timeout', providerCode: 'request_timeout', retryable: false, message: 'Ollama did not answer in 40 ms' } });
  });

  it('a stalled decision pass is asked once, not three times (the empty-turn retry is for empty turns)', async () => {
    let calls = 0;
    const counting = (() => {
      calls += 1;
      return new Promise<Response>(() => {});
    }) as unknown as typeof fetch;
    await collect(provider({ fetch: counting, requestTimeoutMs: 30 }).stream({ model: 'm', messages: [user('weather?')], tools: [weather] }));
    expect(calls).toBe(1);
  });

  it('generate() and a constrained reply are under it too', async () => {
    const err = await provider({ fetch: never, requestTimeoutMs: 30 }).generate({ model: 'm', messages: [user('hello')] }).catch((e: unknown) => e);
    expect(isFlintError(err) && err.error.providerCode).toBe('request_timeout');
    const err2 = await provider({ fetch: never, requestTimeoutMs: 30 })
      .generate({ model: 'm', messages: [user('hello')], responseFormat: { type: 'json_schema', name: 'x', schema: { type: 'object' } } })
      .catch((e: unknown) => e);
    expect(isFlintError(err2) && err2.error.providerCode).toBe('request_timeout');
  });

  it('a reply whose headers come at once but whose body never does is still cut off', async () => {
    const headersOnly = (async () => new Response(new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => {}) }), { status: 200 })) as unknown as typeof fetch;
    const err = await provider({ fetch: headersOnly, requestTimeoutMs: 30 }).generate({ model: 'm', messages: [user('hello')] }).catch((e: unknown) => e);
    expect(isFlintError(err) && err.error.providerCode).toBe('request_timeout');
  });

  it('an answer in time is returned as usual, and an HTTP error keeps its status', async () => {
    const r = await provider({ fetch: whole('fine', 10), requestTimeoutMs: 500 }).generate({ model: 'm', messages: [user('hello')] });
    expect(r.message.content).toBe('fine');
    const notFound = (async () => new Response('model "x" not found', { status: 404 })) as unknown as typeof fetch;
    const err = await provider({ fetch: notFound, requestTimeoutMs: 500 }).generate({ model: 'x', messages: [user('hello')] }).catch((e: unknown) => e);
    expect(isFlintError(err) && err.error).toMatchObject({ kind: 'validation', providerCode: '404' });
  });
});
