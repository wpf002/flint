import { describe, it, expect } from 'vitest';
import { OpenAiProvider } from '../../src/provider/openai/index.js';
import { PerplexityProvider } from '../../src/provider/perplexity/index.js';
import { isFlintError } from '../../src/types/error.js';
import { decodeAssistantTurn } from '../../src/core/encoding.js';
import type { Message } from '../../src/types/message.js';

/** A fetch stub that records the request and replays a canned response. */
function stubFetch(response: unknown, status = 200) {
  const calls: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
  const fn = (async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String(init?.body ?? '{}')),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return new Response(typeof response === 'string' ? response : JSON.stringify(response), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

/** A fetch stub that replays an SSE body. */
function stubStream(lines: string[]) {
  const body = lines.map((l) => `data: ${l}\n`).join('') + 'data: [DONE]\n';
  return (async () =>
    new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })) as unknown as typeof fetch;
}

function user(content: string): Message {
  return { id: 'm1', role: 'user', content, timestamp: 0 };
}

const completion = {
  id: 'chatcmpl-1',
  choices: [{ message: { content: 'hello there' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 11, completion_tokens: 3 },
};

describe('OpenAiProvider.generate', () => {
  it('returns text, usage and reason from a completion', async () => {
    const { fn, calls } = stubFetch(completion);
    const provider = new OpenAiProvider({ apiKey: 'k', fetch: fn });

    const result = await provider.generate({ model: 'gpt-5', messages: [user('hi')] });

    expect(result.message.content).toBe('hello there');
    expect(result.usage).toEqual({ input: 11, output: 3 });
    expect(result.reason).toBe('complete');
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(calls[0]!.headers.authorization).toBe('Bearer k');
  });

  it('sends max_completion_tokens, which the reasoning models require', async () => {
    const { fn, calls } = stubFetch(completion);
    const provider = new OpenAiProvider({ apiKey: 'k', fetch: fn });

    await provider.generate({ model: 'o4-mini', messages: [user('hi')], maxTokens: 900 });

    expect(calls[0]!.body.max_completion_tokens).toBe(900);
    expect(calls[0]!.body.max_tokens).toBeUndefined();
  });

  it('round-trips a namespaced tool name through the dot-free wire format', async () => {
    const { fn, calls } = stubFetch({
      id: 'c2',
      choices: [
        {
          message: {
            content: '',
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'nexus__thread_append', arguments: '{"seq":2}' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 7 },
    });
    const provider = new OpenAiProvider({ apiKey: 'k', fetch: fn });

    const result = await provider.generate({
      model: 'gpt-5',
      messages: [user('go')],
      tools: [{ name: 'nexus.thread_append', description: 'append', inputSchema: {}, idempotent: false }],
    });

    const sentTools = calls[0]!.body.tools as Array<{ function: { name: string } }>;
    expect(sentTools[0]!.function.name).toBe('nexus__thread_append');

    expect(result.reason).toBe('tool_call');
    const turn = decodeAssistantTurn(result.message);
    expect(turn.toolCalls[0]!.toolName).toBe('nexus.thread_append');
    expect(turn.toolCalls[0]!.args).toEqual({ seq: 2 });
  });
});

describe('OpenAiProvider error mapping', () => {
  it('treats a spent quota as non-retryable rather than a rate limit', async () => {
    const { fn } = stubFetch({ error: { message: 'You exceeded your quota', code: 'insufficient_quota' } }, 429);
    const provider = new OpenAiProvider({ apiKey: 'k', fetch: fn });

    await expect(provider.generate({ model: 'gpt-5', messages: [user('hi')] })).rejects.toSatisfy(
      (err: unknown) => isFlintError(err) && err.error.kind === 'validation' && err.retryable === false,
    );
  });

  it('treats an ordinary 429 as a retryable rate limit', async () => {
    const { fn } = stubFetch({ error: { message: 'Rate limit reached', code: 'rate_limit_exceeded' } }, 429);
    const provider = new OpenAiProvider({ apiKey: 'k', fetch: fn });

    await expect(provider.generate({ model: 'gpt-5', messages: [user('hi')] })).rejects.toSatisfy(
      (err: unknown) => isFlintError(err) && err.error.kind === 'rate_limit' && err.retryable === true,
    );
  });

  it('maps a 500 to a retryable provider_unavailable', async () => {
    const { fn } = stubFetch({ error: { message: 'server error' } }, 500);
    const provider = new OpenAiProvider({ apiKey: 'k', fetch: fn });

    await expect(provider.generate({ model: 'gpt-5', messages: [user('hi')] })).rejects.toSatisfy(
      (err: unknown) => isFlintError(err) && err.error.kind === 'provider_unavailable' && err.retryable === true,
    );
  });

  it('refuses to construct without a key rather than reading the environment', () => {
    expect(() => new OpenAiProvider({ apiKey: '' })).toThrow(/apiKey/);
  });
});

describe('OpenAiProvider.stream', () => {
  it('reassembles text and tool-call fragments and ends with exactly one done', async () => {
    const provider = new OpenAiProvider({
      apiKey: 'k',
      fetch: stubStream([
        JSON.stringify({ choices: [{ delta: { content: 'Hel' } }] }),
        JSON.stringify({ choices: [{ delta: { content: 'lo' } }] }),
        JSON.stringify({
          choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'nexus__recall', arguments: '{"q":' } }] } }],
        }),
        JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] } }] }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 4, completion_tokens: 9 } }),
      ]),
    });

    const events = [];
    for await (const ev of provider.stream({ model: 'gpt-5', messages: [user('hi')] })) events.push(ev);

    const text = events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta).join('');
    expect(text).toBe('Hello');

    const call = events.find((e) => e.type === 'tool_call') as { call: { toolName: string; args: unknown } };
    expect(call.call.toolName).toBe('nexus.recall');
    expect(call.call.args).toEqual({ q: 'x' });

    const terminals = events.filter((e) => e.type === 'done' || e.type === 'error');
    expect(terminals).toHaveLength(1);
    expect(events.at(-1)).toEqual({ type: 'done', reason: 'tool_call', usage: { input: 4, output: 9 } });
  });

  it('ends with an error event rather than just stopping when the request fails', async () => {
    const { fn } = stubFetch({ error: { message: 'nope' } }, 401);
    const provider = new OpenAiProvider({ apiKey: 'k', fetch: fn });

    const events = [];
    for await (const ev of provider.stream({ model: 'gpt-5', messages: [user('hi')] })) events.push(ev);

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('error');
  });
});

describe('PerplexityProvider', () => {
  const sonar = {
    id: 'p1',
    choices: [{ message: { content: 'Rain is likely.' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 20, completion_tokens: 4 },
    search_results: [{ title: 'Met Office', url: 'https://example.test/a' }],
  };

  it('uses max_tokens, because the newer field is rejected', async () => {
    const { fn, calls } = stubFetch(sonar);
    const provider = new PerplexityProvider({ apiKey: 'k', fetch: fn });

    await provider.generate({ model: 'sonar-pro', messages: [user('hi')], maxTokens: 512 });

    expect(calls[0]!.url).toBe('https://api.perplexity.ai/chat/completions');
    expect(calls[0]!.body.max_tokens).toBe(512);
    expect(calls[0]!.body.max_completion_tokens).toBeUndefined();
  });

  it('never sends tools, because the endpoint has no function calling', async () => {
    const { fn, calls } = stubFetch(sonar);
    const provider = new PerplexityProvider({ apiKey: 'k', fetch: fn });

    await provider.generate({
      model: 'sonar',
      messages: [user('hi')],
      tools: [{ name: 'nexus.recall', description: 'recall', inputSchema: {}, idempotent: true }],
    });

    expect(calls[0]!.body.tools).toBeUndefined();
    expect(provider.getCapabilities('sonar').toolCalling).toBe('unsupported');
  });

  it('folds the search results into the reply so the sources travel with the claim', async () => {
    const { fn } = stubFetch(sonar);
    const provider = new PerplexityProvider({ apiKey: 'k', fetch: fn });

    const result = await provider.generate({ model: 'sonar-pro', messages: [user('hi')] });

    expect(result.message.content).toContain('Rain is likely.');
    expect(result.message.content).toContain('Sources:');
    expect(result.message.content).toContain('https://example.test/a');
  });

  it('leaves the reply alone when citations are turned off', async () => {
    const { fn } = stubFetch(sonar);
    const provider = new PerplexityProvider({ apiKey: 'k', fetch: fn, citations: false });

    const result = await provider.generate({ model: 'sonar-pro', messages: [user('hi')] });

    expect(result.message.content).toBe('Rain is likely.');
  });

  it('adds nothing when the answer came back without sources', async () => {
    const { fn } = stubFetch({ ...sonar, search_results: undefined });
    const provider = new PerplexityProvider({ apiKey: 'k', fetch: fn });

    const result = await provider.generate({ model: 'sonar', messages: [user('hi')] });

    expect(result.message.content).toBe('Rain is likely.');
  });
});
