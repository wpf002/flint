import { describe, it, expect } from 'vitest';
import { OpenAiCompatibleProvider, type ChatWire } from '../../src/provider/openai/chat.js';
import { isFlintError } from '../../src/types/error.js';
import type { ModelCapabilities } from '../../src/types/capabilities.js';
import type { Message } from '../../src/types/message.js';
import type { StreamEvent } from '../../src/types/stream.js';
import type { ToolDefinition } from '../../src/types/tool.js';

/**
 * The deadlines and the tool gate on the OpenAI-compatible wire (ChatWire's
 * optional fields). They exist for a local model server, which stalls instead
 * of failing; a wire that sets none of them must send exactly what it did.
 */

const caps = (toolCalling: ModelCapabilities['toolCalling'] = 'native'): ModelCapabilities => ({
  toolCalling,
  structuredOutput: 'native',
  streaming: 'full',
  maxContextTokens: 8192,
  maxOutputTokens: 1024,
});

const user = (content: string): Message => ({ id: 'u1', role: 'user', content, timestamp: 0 });
const toolResult: Message = { id: 't1', role: 'tool_result', toolCallId: 'c1', content: '{"toolName":"get_weather","result":"sunny","isError":false}', timestamp: 0 };

const weather: ToolDefinition = {
  name: 'get_weather',
  description: 'Weather for a city',
  inputSchema: { type: 'object', properties: { city: { type: 'string' } } },
  idempotent: true,
};

type Init = RequestInit & { body?: string };

function wire(over: Partial<ChatWire> & { fetch: typeof fetch }): ChatWire {
  return {
    name: 'local',
    baseURL: 'http://127.0.0.1:11434/v1',
    apiKey: 'local',
    maxTokensField: 'max_tokens',
    supportsTools: true,
    capabilities: () => caps(),
    defaultMaxTokens: 512,
    ...over,
  };
}

const sse = (chunk: unknown): Uint8Array => new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`);
const delta = (d: Record<string, unknown>, finish: string | null = null) => ({ choices: [{ delta: d, finish_reason: finish }] });

/** A streamed response whose chunks arrive after the given waits; `Infinity` never arrives. It ignores the signal on purpose. */
function scripted(steps: Array<{ after: number; chunk?: unknown }>): { fetch: typeof fetch; inits: Init[]; cancelled: () => boolean } {
  const inits: Init[] = [];
  let cancelled = false;
  const fn = (async (_url: string | URL, init?: Init) => {
    inits.push(init ?? {});
    let i = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const step = steps[i++];
        if (!step) {
          controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          controller.close();
          return;
        }
        if (step.after === Infinity) return new Promise<void>(() => {});
        if (step.after > 0) await new Promise((r) => setTimeout(r, step.after));
        controller.enqueue(sse(step.chunk));
      },
      cancel() {
        cancelled = true;
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as unknown as typeof fetch;
  return { fetch: fn, inits, cancelled: () => cancelled };
}

async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

describe('ChatWire deadlines: a wire that sets none of them', () => {
  it('sends the same body and the same fetch init as before the fields existed', async () => {
    const s = scripted([{ after: 0, chunk: delta({ content: 'hi' }, 'stop') }]);
    const provider = new OpenAiCompatibleProvider(wire({ fetch: s.fetch }));
    const events = await collect(provider.stream({ model: 'm', messages: [user('hello')], tools: [weather], toolChoice: 'none' }));
    expect(events.map((e) => e.type)).toEqual(['text', 'done']);
    expect(Object.keys(s.inits[0]!).sort()).toEqual(['body', 'headers', 'method']);
    expect(JSON.parse(s.inits[0]!.body!)).toEqual({
      model: 'm',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 512,
      tools: [{ type: 'function', function: { name: 'get_weather', description: 'Weather for a city', parameters: weather.inputSchema } }],
      tool_choice: 'none',
      stream: true,
      stream_options: { include_usage: true },
    });
  });

  it("hands fetch the caller's own signal, untouched", async () => {
    const s = scripted([{ after: 0, chunk: delta({ content: 'hi' }, 'stop') }]);
    const provider = new OpenAiCompatibleProvider(wire({ fetch: s.fetch }));
    const ac = new AbortController();
    await collect(provider.stream({ model: 'm', messages: [user('hello')], signal: ac.signal }));
    expect(s.inits[0]!.signal).toBe(ac.signal);
    expect('redirect' in s.inits[0]!).toBe(false);
  });
});

describe('ChatWire.firstTokenTimeoutMs', () => {
  it('a body that never sends a token ends in exactly one first_token_timeout error, not retryable', async () => {
    const s = scripted([{ after: Infinity }]);
    const provider = new OpenAiCompatibleProvider(wire({ fetch: s.fetch, firstTokenTimeoutMs: 30 }));
    const started = Date.now();
    const events = await collect(provider.stream({ model: 'm', messages: [user('hello')] }));
    expect(Date.now() - started).toBeLessThan(2000);
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.type).toBe('error');
    if (e.type !== 'error') return;
    expect(e.error.kind).toBe('timeout');
    expect(e.error.providerCode).toBe('first_token_timeout');
    // Not retryable: the tool loop would otherwise wait three deadlines on the same stalled model.
    expect(e.error.retryable).toBe(false);
    expect(e.error.message).toBe('local sent no first token in 30 ms');
    // "abort" in a non-retryable timeout reads as the user hanging up, and nothing falls back from that.
    expect(e.error.message).not.toMatch(/abort/i);
    expect(s.cancelled()).toBe(true);
  });

  it('a server that never even answers the request ends the same way (the transport may ignore its signal)', async () => {
    const never = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    const provider = new OpenAiCompatibleProvider(wire({ fetch: never, firstTokenTimeoutMs: 30 }));
    const events = await collect(provider.stream({ model: 'm', messages: [user('hello')] }));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', error: { kind: 'timeout', providerCode: 'first_token_timeout', retryable: false } });
  });

  it('text that arrives in time is delivered, and a slow rest of the answer is not cut off', async () => {
    const s = scripted([
      { after: 0, chunk: delta({ content: 'Hel' }) },
      { after: 80, chunk: delta({ content: 'lo' }, 'stop') },
    ]);
    const provider = new OpenAiCompatibleProvider(wire({ fetch: s.fetch, firstTokenTimeoutMs: 40 }));
    const events = await collect(provider.stream({ model: 'm', messages: [user('hello')] }));
    expect(events.map((e) => (e.type === 'text' ? e.delta : e.type))).toEqual(['Hel', 'lo', 'done']);
  });

  it('a reasoning-only delta counts as a first token (the model is working) and is never shown', async () => {
    for (const field of ['reasoning', 'reasoning_content']) {
      const s = scripted([
        { after: 0, chunk: delta({ [field]: 'Let me think.' }) },
        { after: 80, chunk: delta({ content: 'Answer.' }, 'stop') },
      ]);
      const provider = new OpenAiCompatibleProvider(wire({ fetch: s.fetch, firstTokenTimeoutMs: 40 }));
      const events = await collect(provider.stream({ model: 'm', messages: [user('hello')] }));
      expect(events.map((e) => (e.type === 'text' ? e.delta : e.type)), field).toEqual(['Answer.', 'done']);
    }
  });

  it('a tool-call delta counts as a first token', async () => {
    const s = scripted([
      { after: 0, chunk: delta({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'get_weather', arguments: '' } }] }) },
      { after: 80, chunk: delta({ tool_calls: [{ index: 0, function: { arguments: '{"city":"Paris"}' } }] }, 'tool_calls') },
    ]);
    const provider = new OpenAiCompatibleProvider(wire({ fetch: s.fetch, firstTokenTimeoutMs: 40 }));
    const events = await collect(provider.stream({ model: 'm', messages: [user('weather?')], tools: [weather] }));
    expect(events.map((e) => e.type)).toEqual(['tool_call', 'done']);
    expect(events[0]).toMatchObject({ call: { toolName: 'get_weather', args: { city: 'Paris' } } });
  });

  it('a role-only first chunk is not a token: the deadline still runs', async () => {
    const s = scripted([{ after: 0, chunk: delta({ role: 'assistant', content: '' }) }, { after: Infinity }]);
    const provider = new OpenAiCompatibleProvider(wire({ fetch: s.fetch, firstTokenTimeoutMs: 30 }));
    const events = await collect(provider.stream({ model: 'm', messages: [user('hello')] }));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', error: { providerCode: 'first_token_timeout' } });
  });

  it("the caller's own cancellation still reads as a cancellation, not as the deadline", async () => {
    const s = scripted([{ after: Infinity }]);
    const provider = new OpenAiCompatibleProvider(wire({ fetch: s.fetch, firstTokenTimeoutMs: 5000 }));
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 20);
    const events = await collect(provider.stream({ model: 'm', messages: [user('hello')], signal: ac.signal }));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', error: { kind: 'timeout', retryable: false, message: 'Request aborted' } });
    expect((events[0] as { error: { providerCode?: string } }).error.providerCode).toBeUndefined();
  });

  it('a signal already aborted never sends a request worth waiting on', async () => {
    const s = scripted([{ after: Infinity }]);
    const provider = new OpenAiCompatibleProvider(wire({ fetch: s.fetch, firstTokenTimeoutMs: 5000 }));
    const events = await collect(provider.stream({ model: 'm', messages: [user('hello')], signal: AbortSignal.abort() }));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', error: { message: 'Request aborted' } });
  });

  it('toolPassTimeoutMs is the deadline for a call that follows a tool result; other calls keep the first-token one', async () => {
    // After a tool result: 30 ms would be too short, the tool-pass deadline (200 ms) applies.
    const slow = scripted([{ after: 80, chunk: delta({ content: 'It is sunny.' }, 'stop') }]);
    const provider = new OpenAiCompatibleProvider(wire({ fetch: slow.fetch, firstTokenTimeoutMs: 30, toolPassTimeoutMs: 200 }));
    const after = await collect(provider.stream({ model: 'm', messages: [user('weather?'), toolResult] }));
    expect(after.map((e) => e.type)).toEqual(['text', 'done']);
    // A call that starts a turn: the first-token deadline.
    const slow2 = scripted([{ after: 80, chunk: delta({ content: 'late' }, 'stop') }]);
    const provider2 = new OpenAiCompatibleProvider(wire({ fetch: slow2.fetch, firstTokenTimeoutMs: 30, toolPassTimeoutMs: 200 }));
    const first = await collect(provider2.stream({ model: 'm', messages: [user('weather?')] }));
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ type: 'error', error: { providerCode: 'first_token_timeout' } });
  });
});

describe('a deadline given as a function', () => {
  it('is read on every call: the same client can run with it and without it', async () => {
    let ms: number | undefined;
    // A server that never answers; like real fetch, it gives up when its signal aborts.
    const signals: Array<AbortSignal | null | undefined> = [];
    const stalled = ((_url: string, init?: RequestInit) => {
      signals.push(init?.signal);
      return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)));
    }) as unknown as typeof fetch;
    const provider = new OpenAiCompatibleProvider(wire({ fetch: stalled, firstTokenTimeoutMs: () => ms }));
    // Off: the caller's own signal is the only thing that ends a stalled call, and it is handed over untouched.
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);
    const off = await collect(provider.stream({ model: 'm', messages: [user('hello')], signal: ac.signal }));
    expect(off[0]).toMatchObject({ type: 'error', error: { message: 'Request aborted' } });
    expect(signals[0]).toBe(ac.signal);
    // On: the deadline ends it.
    ms = 30;
    const on = await collect(provider.stream({ model: 'm', messages: [user('hello')] }));
    expect(on[0]).toMatchObject({ type: 'error', error: { providerCode: 'first_token_timeout', message: 'local sent no first token in 30 ms' } });
  });

  it('zero, a negative number or NaN is no deadline', async () => {
    for (const bad of [0, -5, NaN]) {
      const s = scripted([{ after: 20, chunk: delta({ content: 'hi' }, 'stop') }]);
      const provider = new OpenAiCompatibleProvider(wire({ fetch: s.fetch, firstTokenTimeoutMs: bad }));
      const events = await collect(provider.stream({ model: 'm', messages: [user('hello')] }));
      expect(events.map((e) => e.type), String(bad)).toEqual(['text', 'done']);
    }
  });
});

describe('ChatWire.requestTimeoutMs', () => {
  it('a non-streamed call that never answers throws a request_timeout, not retryable', async () => {
    const never = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    const provider = new OpenAiCompatibleProvider(wire({ fetch: never, requestTimeoutMs: 30 }));
    const err = await provider.generate({ model: 'm', messages: [user('hello')] }).catch((e: unknown) => e);
    expect(isFlintError(err)).toBe(true);
    if (!isFlintError(err)) return;
    expect(err.error).toMatchObject({ kind: 'timeout', providerCode: 'request_timeout', retryable: false, message: 'local did not answer in 30 ms' });
  });

  it('an answer in time is returned as usual', async () => {
    const ok = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }] }), { status: 200 })) as unknown as typeof fetch;
    const provider = new OpenAiCompatibleProvider(wire({ fetch: ok, requestTimeoutMs: 1000 }));
    const r = await provider.generate({ model: 'm', messages: [user('hello')] });
    expect(r.message.content).toBe('hi');
  });
});

describe('the tool gate', () => {
  const bodyOf = async (over: Partial<ChatWire>, args: { toolChoice?: 'none' | 'auto' } = {}): Promise<Record<string, unknown>> => {
    const s = scripted([{ after: 0, chunk: delta({ content: 'ok' }, 'stop') }]);
    const provider = new OpenAiCompatibleProvider(wire({ fetch: s.fetch, ...over }));
    await collect(provider.stream({ model: 'm', messages: [user('hello')], tools: [weather], ...args }));
    return JSON.parse(s.inits[0]!.body!) as Record<string, unknown>;
  };

  it("a model whose toolCalling is 'unsupported' is never offered tools", async () => {
    const body = await bodyOf({ capabilities: () => caps('unsupported') });
    expect('tools' in body).toBe(false);
    expect('tool_choice' in body).toBe(false);
  });

  it('the gate is per model: one model on the wire gets the tools, another does not', async () => {
    const s = scripted([{ after: 0, chunk: delta({ content: 'ok' }, 'stop') }]);
    const provider = new OpenAiCompatibleProvider(
      wire({ fetch: s.fetch, capabilities: (m) => caps(m === 'can' ? 'native' : 'unsupported') }),
    );
    await collect(provider.stream({ model: 'can', messages: [user('hello')], tools: [weather] }));
    const s2 = scripted([{ after: 0, chunk: delta({ content: 'ok' }, 'stop') }]);
    const provider2 = new OpenAiCompatibleProvider(
      wire({ fetch: s2.fetch, capabilities: (m) => caps(m === 'can' ? 'native' : 'unsupported') }),
    );
    await collect(provider2.stream({ model: 'cannot', messages: [user('hello')], tools: [weather] }));
    expect('tools' in JSON.parse(s.inits[0]!.body!)).toBe(true);
    expect('tools' in JSON.parse(s2.inits[0]!.body!)).toBe(false);
  });

  it("toolChoiceNone 'drop_tools' honours toolChoice none by not offering the tools (a server with no tool_choice)", async () => {
    const body = await bodyOf({ toolChoiceNone: 'drop_tools' }, { toolChoice: 'none' });
    expect('tools' in body).toBe(false);
    expect('tool_choice' in body).toBe(false);
    // Any other choice still offers them.
    const auto = await bodyOf({ toolChoiceNone: 'drop_tools' }, { toolChoice: 'auto' });
    expect('tools' in auto).toBe(true);
  });

  it("the default ('send') keeps the tools defined and sends the API's own none", async () => {
    const body = await bodyOf({}, { toolChoice: 'none' });
    expect('tools' in body).toBe(true);
    expect(body.tool_choice).toBe('none');
  });
});

describe('ChatWire.refuseRedirects', () => {
  it("asks fetch to fail on a redirect, and reports one as a wrong address (not an outage to retry)", async () => {
    const inits: Init[] = [];
    const redirected = (async (_url: string | URL, init?: Init) => {
      inits.push(init ?? {});
      throw new TypeError('fetch failed', { cause: new Error('unexpected redirect') });
    }) as unknown as typeof fetch;
    const provider = new OpenAiCompatibleProvider(wire({ fetch: redirected, refuseRedirects: true }));
    const events = await collect(provider.stream({ model: 'm', messages: [user('hello')] }));
    expect(inits[0]!.redirect).toBe('error');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', error: { kind: 'validation', providerCode: 'redirect', retryable: false } });
  });

  it('a refused connection is still an outage', async () => {
    const refused = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const provider = new OpenAiCompatibleProvider(wire({ fetch: refused, refuseRedirects: true }));
    const events = await collect(provider.stream({ model: 'm', messages: [user('hello')] }));
    expect(events[0]).toMatchObject({ type: 'error', error: { kind: 'provider_unavailable', retryable: true } });
  });
});
