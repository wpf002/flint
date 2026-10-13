import { describe, it, expect } from 'vitest';
import { COMPLETION, NOT_FOUND, TEXT_STREAM, TOOL_STREAM, jsonProvider, streamingProvider, unreachableProvider } from './local-harness.js';
import { Flint, InMemoryStore, isFlintError } from '../../src/index.js';
import type { StreamEvent, ToolDefinition } from '../../src/index.js';

/**
 * The provider contract, for LocalOpenAiProvider (any OpenAI-compatible local
 * server): the same guarantees the Anthropic and Ollama adapters are held to.
 */

const userMsg = { id: 'u1', role: 'user' as const, content: 'hi', timestamp: 0 };

const weatherTool: ToolDefinition = {
  name: 'get_weather',
  description: 'Weather for a city',
  inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  idempotent: true,
};

async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

describe('contract (local): generate-basic', () => {
  it('returns a well-formed assistant Message with usage', async () => {
    const r = await jsonProvider(COMPLETION).generate({ model: 'test-model', messages: [userMsg] });
    expect(r.message.role).toBe('assistant');
    expect(r.message.content).toBe('ok');
    expect(r.usage).toEqual({ input: 33, output: 2, cacheRead: 27 });
    expect(r.reason).toBe('complete');
  });
});

describe('contract (local): stream-basic', () => {
  it('yields text deltas then exactly one done, with usage from the final chunk', async () => {
    const { provider, requests } = streamingProvider(TEXT_STREAM);
    const events = await collect(provider.stream({ model: 'test-model', messages: [userMsg] }));
    const text = events
      .filter((e): e is Extract<StreamEvent, { type: 'text' }> => e.type === 'text')
      .map((e) => e.delta);
    expect(text).toEqual(['Hello', ',', ' world']);
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
    const terminal = events.at(-1);
    expect(terminal?.type).toBe('done');
    if (terminal?.type === 'done') {
      expect(terminal.reason).toBe('complete');
      expect(terminal.usage).toEqual({ input: 35, output: 4 });
    }
    expect(requests[0]).toMatchObject({ model: 'test-model', stream: true, stream_options: { include_usage: true } });
  });
});

describe('contract (local): stream-tool-call', () => {
  it('yields a tool_call with parsed args, then done.reason tool_call, and no text', async () => {
    const { provider, requests } = streamingProvider(TOOL_STREAM);
    const events = await collect(provider.stream({ model: 'test-model', messages: [userMsg], tools: [weatherTool] }));
    const calls = events.filter((e): e is Extract<StreamEvent, { type: 'tool_call' }> => e.type === 'tool_call');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.call).toMatchObject({ id: 'call_668wpbkr', toolName: 'get_weather', args: { city: 'Paris' } });
    expect(events.some((e) => e.type === 'text')).toBe(false);
    const terminal = events.at(-1);
    expect(terminal?.type === 'done' && terminal.reason).toBe('tool_call');
    expect((requests[0]!.tools as unknown[]).length).toBe(1);
  });
});

describe('contract (local): stream-interruption', () => {
  it('an abort mid-stream ends in an error event, and the chat turn is not committed', async () => {
    const { provider } = streamingProvider(TEXT_STREAM);
    const memory = new InMemoryStore();
    const flint = new Flint({ provider, defaultModel: 'test-model', memory });
    const ac = new AbortController();
    const events: StreamEvent[] = [];
    for await (const ev of flint.chat({ conversationId: 'c1', message: 'hi' }, { signal: ac.signal })) {
      events.push(ev);
      if (ev.type === 'text') ac.abort();
    }
    expect(events.at(-1)?.type).toBe('error');
    expect(await memory.getMessages('c1')).toEqual([]);
  });
});

describe('contract (local): error-normalization', () => {
  it('maps 404 (a model the server does not have) to validation, not retryable', async () => {
    await expect(jsonProvider(NOT_FOUND, 404).generate({ model: 'no-such-model', messages: [userMsg] })).rejects.toSatisfy(
      (e: unknown) => isFlintError(e) && e.error.kind === 'validation' && !e.error.retryable && e.error.providerCode === 'not_found_error',
    );
  });

  it('maps 503 (the server is loading its model) to provider_unavailable', async () => {
    await expect(
      jsonProvider({ error: { message: 'Loading model', type: 'unavailable_error', code: 503 } }, 503).generate({ model: 'test-model', messages: [userMsg] }),
    ).rejects.toSatisfy((e: unknown) => isFlintError(e) && e.error.kind === 'provider_unavailable' && e.error.retryable);
  });

  it('maps an unreachable server to provider_unavailable', async () => {
    const events = await collect(unreachableProvider().stream({ model: 'test-model', messages: [userMsg] }));
    const err = events.at(-1);
    expect(err?.type).toBe('error');
    if (err?.type === 'error') expect(err.error.kind).toBe('provider_unavailable');
  });
});
