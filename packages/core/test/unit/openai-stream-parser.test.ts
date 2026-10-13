import { describe, it, expect } from 'vitest';
import { LocalOpenAiProvider, localCapabilities } from '../../src/index.js';
import type { Message } from '../../src/types/message.js';
import type { StreamEvent } from '../../src/types/stream.js';
import type { ToolDefinition } from '../../src/types/tool.js';

/**
 * The OpenAI-compatible stream parser against what local servers really send.
 * The routing review's adapter cases (e8), each as it was found: an error sent
 * inside a 200 stream ended the turn `complete`, two tool calls that shared an
 * index (or had none) became one, and a reply that began and then went quiet
 * was bounded by nothing.
 */

const enc = new TextEncoder();
const user: Message[] = [{ id: 'u', role: 'user', content: 'synthetic', timestamp: 0 }];
const tools: ToolDefinition[] = [{ name: 'web.search', description: 'd', inputSchema: { type: 'object', properties: { q: { type: 'string' } } }, idempotent: true }];
const d = (o: unknown): string => `data: ${JSON.stringify(o)}\n\n`;
const c = (delta: Record<string, unknown>, fin?: string) => ({ id: 'x', choices: [{ index: 0, delta, ...(fin ? { finish_reason: fin } : {}) }] });
const DONE = 'data: [DONE]\n\n';

async function run(parts: string[], opts: { hang?: boolean; provider?: Record<string, unknown>; signal?: AbortSignal } = {}): Promise<StreamEvent[]> {
  const f = (async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(ctl) {
          for (const p of parts) ctl.enqueue(enc.encode(p));
          if (!opts.hang) ctl.close();
        },
      }),
      { status: 200 },
    )) as unknown as typeof fetch;
  const p = new LocalOpenAiProvider({ baseURL: 'http://127.0.0.1:9/v1', capabilities: () => localCapabilities({ contextTokens: 8192, tools: true }), fetch: f, ...opts.provider });
  const out: StreamEvent[] = [];
  for await (const ev of p.stream({ model: 'm', messages: user, tools, ...(opts.signal ? { signal: opts.signal } : {}) })) out.push(ev);
  return out;
}
const brief = (events: StreamEvent[]): string[] =>
  events.map((e) => (e.type === 'text' ? `text:${e.delta}` : e.type === 'tool_call' ? `tool:${e.call.toolName}:${JSON.stringify(e.call.args)}:${e.call.id}` : e.type === 'done' ? `done:${e.reason}` : `error:${e.error.kind}/${e.error.providerCode ?? '-'}`));

describe('what still parses as it did', () => {
  it('a clean stream, whole or split at every byte', async () => {
    const whole = d(c({ content: 'Hello ' })) + d(c({ content: 'world' })) + d(c({}, 'stop')) + DONE;
    expect(brief(await run([whole]))).toEqual(['text:Hello ', 'text:world', 'done:complete']);
    expect(brief(await run(whole.split('')))).toEqual(['text:Hello ', 'text:world', 'done:complete']);
  });

  it('a tool call whose arguments are split over chunks; two calls at index 0 and 1', async () => {
    const split = [d(c({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'web__search', arguments: '{"q":' } }] })), d(c({ tool_calls: [{ index: 0, function: { arguments: '"cats"}' } }] })), d(c({}, 'tool_calls')), DONE];
    expect(brief(await run(split))).toEqual(['tool:web.search:{"q":"cats"}:call_1', 'done:tool_call']);
    const two = [d(c({ tool_calls: [{ index: 0, id: 'a', function: { name: 'web__search', arguments: '{"q":"a"}' } }, { index: 1, id: 'b', function: { name: 'web__search', arguments: '{"q":"b"}' } }] })), d(c({}, 'tool_calls')), DONE];
    expect(brief(await run(two))).toEqual(['tool:web.search:{"q":"a"}:a', 'tool:web.search:{"q":"b"}:b', 'done:tool_call']);
  });

  it('fragments of two calls interleaved by index are still each their own call, in index order', async () => {
    const parts = [
      d(c({ tool_calls: [{ index: 1, id: 'b', function: { name: 'web__search', arguments: '{"q":' } }] })),
      d(c({ tool_calls: [{ index: 0, id: 'a', function: { name: 'web__search', arguments: '{"q":' } }] })),
      d(c({ tool_calls: [{ index: 1, function: { arguments: '"b"}' } }] })),
      d(c({ tool_calls: [{ index: 0, function: { arguments: '"a"}' } }] })),
      d(c({}, 'tool_calls')),
      DONE,
    ];
    expect(brief(await run(parts))).toEqual(['tool:web.search:{"q":"a"}:a', 'tool:web.search:{"q":"b"}:b', 'done:tool_call']);
  });
});

describe('an error sent inside the stream is a failure, never a finished reply', () => {
  // e8 case 5: it ended `done:complete` with no text at all.
  it('an error object and nothing else (llama.cpp sends this once the 200 is out)', async () => {
    const events = await run(['data: {"error":{"code":500,"message":"context size exceeded","type":"exceed_context_size_error"}}\n\n']);
    expect(brief(events)).toEqual(['error:provider_unavailable/exceed_context_size_error']);
  });

  // e8 case 6: it ended `done:complete` after half an answer.
  it('text, then an error object: what was shown stays shown, and the turn ends in the error', async () => {
    const events = await run([d(c({ content: 'partial ' })), 'data: {"error":{"message":"model runner crashed"}}\n\n']);
    expect(brief(events)).toEqual(['text:partial ', 'error:provider_unavailable/502']);
  });

  it('an error that is a plain string, and one that carries a status the taxonomy knows', async () => {
    expect(brief(await run(['data: {"error":"out of memory"}\n\n']))).toEqual(['error:provider_unavailable/502']);
    expect(brief(await run(['data: {"error":{"code":503,"message":"Loading model"}}\n\n']))).toEqual(['error:provider_unavailable/503']);
    expect(brief(await run(['data: {"error":{"code":"429","message":"slow down"}}\n\n']))).toEqual(['error:rate_limit/429']);
  });

  it('a chunk that has choices is a chunk, whatever else it carries', async () => {
    const withBoth = { ...c({ content: 'fine' }), error: null };
    expect(brief(await run([d(withBoth), d(c({}, 'stop')), DONE]))).toEqual(['text:fine', 'done:complete']);
  });
});

describe('two tool calls are two tool calls', () => {
  // e8 case 12: only the second survived, with no arguments.
  it('both at index 0, in their own chunks, each with its own id', async () => {
    const parts = [d(c({ tool_calls: [{ index: 0, id: 'a', function: { name: 'web__search', arguments: '{"q":"a"}' } }] })), d(c({ tool_calls: [{ index: 0, id: 'b', function: { name: 'web__search', arguments: '{"q":"b"}' } }] })), d(c({}, 'tool_calls')), DONE];
    expect(brief(await run(parts))).toEqual(['tool:web.search:{"q":"a"}:a', 'tool:web.search:{"q":"b"}:b', 'done:tool_call']);
  });

  // e8 case 13.
  it('with no index field at all', async () => {
    const parts = [d(c({ tool_calls: [{ id: 'a', function: { name: 'web__search', arguments: '{"q":"a"}' } }] })), d(c({ tool_calls: [{ id: 'b', function: { name: 'web__search', arguments: '{"q":"b"}' } }] })), d(c({}, 'tool_calls')), DONE];
    expect(brief(await run(parts))).toEqual(['tool:web.search:{"q":"a"}:a', 'tool:web.search:{"q":"b"}:b', 'done:tool_call']);
  });

  it('a fragment with no index and no id continues the call before it', async () => {
    const parts = [d(c({ tool_calls: [{ id: 'a', function: { name: 'web__search', arguments: '{"q":' } }] })), d(c({ tool_calls: [{ function: { arguments: '"cats"}' } }] })), d(c({}, 'tool_calls')), DONE];
    expect(brief(await run(parts))).toEqual(['tool:web.search:{"q":"cats"}:a', 'done:tool_call']);
  });

  it('the same id repeated at an index is the same call (a server that sends the id on every fragment)', async () => {
    const parts = [d(c({ tool_calls: [{ index: 0, id: 'a', function: { name: 'web__search', arguments: '{"q":' } }] })), d(c({ tool_calls: [{ index: 0, id: 'a', function: { arguments: '"cats"}' } }] })), d(c({}, 'tool_calls')), DONE];
    expect(brief(await run(parts))).toEqual(['tool:web.search:{"q":"cats"}:a', 'done:tool_call']);
  });
});

describe('a reply that begins and then goes quiet (idleTimeoutMs)', () => {
  // e8 case 17: one reasoning delta disarmed the first-token deadline, and then nothing bounded the stream.
  it('one reasoning delta, then silence: the idle deadline ends it, long before the caller would', async () => {
    const started = Date.now();
    const events = await run([d(c({ reasoning: 'hmm' }))], { hang: true, provider: { firstTokenTimeoutMs: 300, idleTimeoutMs: 60 } });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', error: { kind: 'timeout', providerCode: 'idle_timeout', retryable: false, message: 'local went quiet for 60 ms in the middle of a reply' } });
  });

  it('text, then silence: what was shown stays shown', async () => {
    const events = await run([d(c({ content: 'Hello ' }))], { hang: true, provider: { firstTokenTimeoutMs: 300, idleTimeoutMs: 60 } });
    expect(brief(events)).toEqual(['text:Hello ', 'error:timeout/idle_timeout']);
  });

  it('a role-only first chunk is still not a first token: that is the first-token deadline\'s', async () => {
    const events = await run([d(c({ role: 'assistant', content: '' }))], { hang: true, provider: { firstTokenTimeoutMs: 60, idleTimeoutMs: 5000 } });
    expect(brief(events)).toEqual(['error:timeout/first_token_timeout']);
  });

  it('with no idle deadline set, nothing changes: only the caller ends a reply that went quiet', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 120);
    const events = await run([d(c({ reasoning: 'hmm' }))], { hang: true, provider: { firstTokenTimeoutMs: 60 }, signal: ac.signal });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', error: { message: 'Request aborted' } });
  });

  it('it works on its own, with no first-token deadline', async () => {
    const events = await run([d(c({ content: 'Hello ' }))], { hang: true, provider: { idleTimeoutMs: 60 } });
    expect(brief(events)).toEqual(['text:Hello ', 'error:timeout/idle_timeout']);
  });
});
