import { describe, it, expect } from 'vitest';
import { Flint, ActionLogObserver, combineObservers } from '../../src/index.js';
import type { ProviderAdapter, GenerateArgs, StreamEvent, Tool } from '../../src/index.js';

/** Provider that calls a tool once, then answers from the result. */
function toolProvider(): ProviderAdapter {
  return {
    name: 'mock',
    getCapabilities: () => ({
      toolCalling: 'native',
      structuredOutput: 'native',
      streaming: 'full',
      maxContextTokens: 100_000,
      maxOutputTokens: 4096,
    }),
    estimateTokens: (m) => m.reduce((n, x) => n + x.content.length, 0),
    async generate() {
      throw new Error('unused');
    },
    async *stream(args: GenerateArgs): AsyncIterable<StreamEvent> {
      const ran = args.messages.some((m) => m.role === 'tool_result');
      if (!ran) {
        yield { type: 'tool_call', call: { id: 'c1', toolName: 'add', args: { a: 2, b: 3 } } };
        yield { type: 'done', reason: 'tool_call', usage: { input: 1, output: 1 } };
      } else {
        yield { type: 'text', delta: 'The sum is 5.' };
        yield { type: 'done', reason: 'complete', usage: { input: 1, output: 1 } };
      }
    },
  };
}

const addTool: Tool = {
  definition: {
    name: 'add',
    description: 'add',
    inputSchema: { type: 'object' },
    idempotent: true,
  },
  handler: (call) => {
    const { a, b } = call.args as { a: number; b: number };
    return { sum: a + b };
  },
};

describe('ActionLogObserver', () => {
  it('records the full call→result lineage of a tool-using turn', async () => {
    const log = new ActionLogObserver();
    const flint = new Flint({ provider: toolProvider(), defaultModel: 'm', observer: log });

    await flint.generate({ prompt: 'add 2 and 3', tools: [addTool] });

    const types = log.actions().map((e) => e.type);
    expect(types).toContain('request');
    expect(types).toContain('tool_call');
    expect(types).toContain('tool_result');
    expect(types).toContain('response');

    const toolCall = log.actions().find((e) => e.type === 'tool_call');
    const toolResult = log.actions().find((e) => e.type === 'tool_result');
    expect(toolCall).toMatchObject({ tool: 'add', idempotent: true });
    expect(toolResult).toMatchObject({ tool: 'add', isError: false, result: { sum: 5 } });

    // toolTrace() is the "what did it actually do" view.
    expect(log.toolTrace().map((e) => e.type)).toEqual(['tool_call', 'tool_result']);
  });

  it('streams entries to onEntry as they happen', async () => {
    const streamed: string[] = [];
    const log = new ActionLogObserver((e) => streamed.push(e.type));
    const flint = new Flint({ provider: toolProvider(), defaultModel: 'm', observer: log });
    await flint.generate({ prompt: 'add', tools: [addTool] });
    expect(streamed).toContain('tool_result');
  });

  it('combineObservers fans events out to several observers', async () => {
    const a = new ActionLogObserver();
    const b = new ActionLogObserver();
    const flint = new Flint({
      provider: toolProvider(),
      defaultModel: 'm',
      observer: combineObservers(a, b),
    });
    await flint.generate({ prompt: 'add', tools: [addTool] });
    expect(a.actions().length).toBeGreaterThan(0);
    expect(b.actions().length).toBe(a.actions().length);
  });
});
