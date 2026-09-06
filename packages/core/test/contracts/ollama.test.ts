import { describe, it, expect } from 'vitest';
import {
  streamingProvider,
  jsonProvider,
  httpErrorProvider,
  unreachableProvider,
  textChunk,
  finalChunk,
} from './ollama-harness.js';
import { Flint, decodeToolCalls, isFlintError } from '../../src/index.js';
import type { StreamEvent, ToolDefinition, Tool } from '../../src/index.js';

const userMsg = { id: 'u1', role: 'user' as const, content: 'hi', timestamp: 0 };

const weatherTool: ToolDefinition = {
  name: 'get_weather',
  description: 'Weather for a city',
  inputSchema: { type: 'object', properties: { city: { type: 'string' } } },
  idempotent: true,
};

describe('contract (ollama): generate-basic', () => {
  it('returns a well-formed assistant Message with usage', async () => {
    const provider = jsonProvider({
      message: { role: 'assistant', content: 'Paris is the capital.' },
      done: true,
      done_reason: 'stop',
      prompt_eval_count: 11,
      eval_count: 6,
    });
    const r = await provider.generate({ model: 'llama3.1', messages: [userMsg] });
    expect(r.message.role).toBe('assistant');
    expect(r.message.content).toContain('Paris');
    expect(r.usage).toEqual({ input: 11, output: 6 });
    expect(r.reason).toBe('complete');
  });
});

describe('contract (ollama): stream-basic', () => {
  it('yields text deltas then exactly one done', async () => {
    const provider = streamingProvider([
      textChunk('Hello'),
      textChunk(', world'),
      finalChunk({ input: 8, output: 4 }),
    ]);
    const events: StreamEvent[] = [];
    for await (const ev of provider.stream({ model: 'llama3.1', messages: [userMsg] })) {
      events.push(ev);
    }
    const text = events
      .filter((e): e is Extract<StreamEvent, { type: 'text' }> => e.type === 'text')
      .map((e) => e.delta)
      .join('');
    expect(text).toBe('Hello, world');
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
    const terminal = events.at(-1);
    expect(terminal?.type).toBe('done');
    if (terminal?.type === 'done') expect(terminal.usage).toEqual({ input: 8, output: 4 });
  });
});

/*
 * CONTRACT NOTE. stream() splits by pass, and the fixture has to match the pass:
 *
 *  - The tool-DECISION pass (tools offered, no tool_result in history yet) is
 *    deliberately NON-streamed for reliability — see the comment at the top of
 *    OllamaProvider.stream. So it must be driven with jsonProvider.
 *  - The ANSWER pass (history ends in a tool_result) and pure chat ARE streamed,
 *    so those use streamingProvider.
 *
 * These tests used to drive the decision pass with streamingProvider, which
 * stopped matching the implementation at 09dac5a (native function-calling) and
 * b84b90e (stream the answer pass). They asserted a superseded design, not a bug.
 */
describe('contract (ollama): tool-call recovery on the DECISION pass (non-streamed)', () => {
  it('parses a tool-call JSON out of model text → tool_call then done.reason tool_call', async () => {
    // Model emits the prompted JSON, wrapped in a code fence (repair path).
    const provider = jsonProvider({
      message: {
        role: 'assistant',
        content: '```json\n{"tool_call": {"name": "get_weather", "arguments": {"city": "Paris"}}}\n```',
      },
      done: true,
      done_reason: 'stop',
      prompt_eval_count: 30,
      eval_count: 12,
    });
    const events: StreamEvent[] = [];
    for await (const ev of provider.stream({
      model: 'llama3.1',
      messages: [userMsg],
      tools: [weatherTool],
    })) {
      events.push(ev);
    }
    const calls = events.filter(
      (e): e is Extract<StreamEvent, { type: 'tool_call' }> => e.type === 'tool_call',
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.call.toolName).toBe('get_weather');
    expect(calls[0]?.call.args).toEqual({ city: 'Paris' });
    const terminal = events.at(-1);
    expect(terminal?.type === 'done' && terminal.reason).toBe('tool_call');
    // No raw JSON leaked as text in the tool-call path.
    expect(events.some((e) => e.type === 'text')).toBe(false);
  });

  it('treats plain text as a normal answer (no tool call)', async () => {
    const provider = jsonProvider({
      message: { role: 'assistant', content: 'It is sunny in Paris.' },
      done: true,
      done_reason: 'stop',
    });
    const events: StreamEvent[] = [];
    for await (const ev of provider.stream({
      model: 'llama3.1',
      messages: [userMsg],
      tools: [weatherTool],
    })) {
      events.push(ev);
    }
    expect(events.some((e) => e.type === 'tool_call')).toBe(false);
    expect(
      events
        .filter((e): e is Extract<StreamEvent, { type: 'text' }> => e.type === 'text')
        .map((e) => e.delta)
        .join(''),
    ).toBe('It is sunny in Paris.');
    const terminal = events.at(-1);
    expect(terminal?.type === 'done' && terminal.reason).toBe('complete');
  });
});

describe('contract (ollama): the ANSWER pass really streams', () => {
  // History ending in a tool_result puts stream() on the live-streamed path.
  const toolResultMsg = {
    id: 'tr1',
    role: 'tool_result' as const,
    content: JSON.stringify({ toolName: 'get_weather', result: 'sunny', isError: false }),
    toolCallId: 'toolu_1',
    timestamp: 0,
  };

  it('yields prose deltas live after a tool result', async () => {
    const provider = streamingProvider([
      textChunk('It is '),
      textChunk('sunny in Paris.'),
      finalChunk({ input: 40, output: 6 }),
    ]);
    const events: StreamEvent[] = [];
    for await (const ev of provider.stream({
      model: 'llama3.1',
      messages: [userMsg, toolResultMsg],
      tools: [weatherTool],
    })) {
      events.push(ev);
    }
    const deltas = events.filter(
      (e): e is Extract<StreamEvent, { type: 'text' }> => e.type === 'text',
    );
    // More than one delta proves it streamed rather than buffering the whole answer.
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.map((e) => e.delta).join('')).toBe('It is sunny in Paris.');
    const terminal = events.at(-1);
    expect(terminal?.type === 'done' && terminal.reason).toBe('complete');
  });
});

describe('contract (ollama): error-normalization', () => {
  it('maps 404 (model not pulled) → validation', async () => {
    const provider = httpErrorProvider(404, 'model "nope" not found');
    await expect(
      provider.generate({ model: 'nope', messages: [userMsg] }),
    ).rejects.toSatisfy((e: unknown) => isFlintError(e) && e.error.kind === 'validation');
  });

  it('maps 500 → provider_unavailable (retryable)', async () => {
    const provider = httpErrorProvider(500, 'internal');
    await expect(
      provider.generate({ model: 'llama3.1', messages: [userMsg] }),
    ).rejects.toSatisfy(
      (e: unknown) => isFlintError(e) && e.error.kind === 'provider_unavailable' && e.error.retryable,
    );
  });

  it('maps an unreachable server → provider_unavailable', async () => {
    const events: StreamEvent[] = [];
    for await (const ev of unreachableProvider().stream({ model: 'llama3.1', messages: [userMsg] })) {
      events.push(ev);
    }
    const err = events.at(-1);
    expect(err?.type).toBe('error');
    if (err?.type === 'error') expect(err.error.kind).toBe('provider_unavailable');
  });
});

describe('contract (ollama): idempotency via the Flint loop', () => {
  // generate() is non-streamed, so this must be a jsonProvider — a streaming
  // fixture here produced zero tool calls and the tool never ran, which made the
  // "did not retry" assertion pass for the wrong reason before it broke outright.
  function toolCallProvider() {
    return jsonProvider({
      message: {
        role: 'assistant',
        content: '{"tool_call": {"name": "do_thing", "arguments": {"x": 1}}}',
      },
      done: true,
      done_reason: 'stop',
      prompt_eval_count: 10,
      eval_count: 5,
    });
  }

  function failingTool(idempotent: boolean, counter: { n: number }): Tool {
    return {
      definition: {
        name: 'do_thing',
        description: 'does a thing',
        inputSchema: { type: 'object' },
        idempotent,
      },
      handler: () => {
        counter.n++;
        throw new Error('boom');
      },
    };
  }

  const fastRetry = { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 };

  it('does NOT auto-retry a non-idempotent tool through Ollama', async () => {
    const counter = { n: 0 };
    const flint = new Flint({ provider: toolCallProvider(), defaultModel: 'llama3.1' });
    await expect(
      flint.generate({ prompt: 'go', tools: [failingTool(false, counter)] }, { retryPolicy: fastRetry }),
    ).rejects.toSatisfy((e: unknown) => isFlintError(e));
    expect(counter.n).toBe(1);
  });
});

describe('contract (ollama): the parsed tool call round-trips through generate', () => {
  it('surfaces a tool call from the non-streaming path', async () => {
    const provider = jsonProvider({
      message: {
        role: 'assistant',
        content: '{"tool_call": {"name": "get_weather", "arguments": {"city": "NYC"}}}',
      },
      done: true,
      done_reason: 'stop',
      prompt_eval_count: 20,
      eval_count: 10,
    });
    const r = await provider.generate({
      model: 'llama3.1',
      messages: [userMsg],
      tools: [weatherTool],
    });
    expect(r.reason).toBe('tool_call');
    const calls = decodeToolCalls(r.message);
    expect(calls[0]?.toolName).toBe('get_weather');
    expect(calls[0]?.args).toEqual({ city: 'NYC' });
  });
});
