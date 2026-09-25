import { describe, it, expect } from 'vitest';
import { OllamaProvider } from '../../src/provider/ollama/index.js';
import type { StreamEvent, ToolDefinition } from '../../src/index.js';

/**
 * The `think` option: sent as Ollama's top-level `think` field on every
 * /api/chat body when set, and absent (bodies byte-identical to before) when not.
 * A stub fetch records the raw bodies; nothing touches a real Ollama.
 */

const userMsg = { id: 'u1', role: 'user' as const, content: 'hi', timestamp: 0 };
const toolResultMsg = {
  id: 'tr1',
  role: 'tool_result' as const,
  content: JSON.stringify({ toolName: 'get_weather', result: 'sunny', isError: false }),
  toolCallId: 'toolu_1',
  timestamp: 0,
};
const weatherTool: ToolDefinition = {
  name: 'get_weather',
  description: 'Weather for a city',
  inputSchema: { type: 'object', properties: { city: { type: 'string' } } },
  idempotent: true,
};

interface Reply {
  content: string;
  thinking?: string;
}

/** A fetch that records each raw request body and answers JSON or NDJSON to match `stream`. */
function recordingFetch(replies: Reply[] = [{ content: 'ok' }]) {
  const bodies: string[] = [];
  let i = 0;
  const impl = (async (_url: string, init: { body: string }) => {
    bodies.push(init.body);
    const reply = replies[Math.min(i++, replies.length - 1)]!;
    const message = { role: 'assistant', content: reply.content, ...(reply.thinking ? { thinking: reply.thinking } : {}) };
    const final = { done: true, done_reason: 'stop', prompt_eval_count: 5, eval_count: 3 };
    if ((JSON.parse(init.body) as { stream: boolean }).stream) {
      const lines = [
        ...(reply.thinking ? [{ message: { role: 'assistant', content: '', thinking: reply.thinking } }] : []),
        { message: { role: 'assistant', content: reply.content } },
        { message: { role: 'assistant', content: '' }, ...final },
      ];
      return new Response(lines.map((l) => JSON.stringify(l)).join('\n') + '\n', { status: 200 });
    }
    return new Response(JSON.stringify({ message, ...final }), { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, bodies, parsed: () => bodies.map((b) => JSON.parse(b) as Record<string, unknown>) };
}

async function drain(it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

const textOf = (events: StreamEvent[]): string =>
  events
    .filter((e): e is Extract<StreamEvent, { type: 'text' }> => e.type === 'text')
    .map((e) => e.delta)
    .join('');

describe('OllamaProvider think option', () => {
  for (const think of [false, true]) {
    it(`generate sends top-level think: ${think}`, async () => {
      const f = recordingFetch();
      await new OllamaProvider({ fetch: f.impl, think, defaultOptions: { num_ctx: 16384 } }).generate({ model: 'm', messages: [userMsg] });
      const [body] = f.parsed();
      expect(body!.think).toBe(think);
      // A top-level field, not one of Ollama's model `options`.
      expect(body!.options).toEqual({ num_ctx: 16384 });
    });

    it(`the streamed path (pure chat) sends think: ${think}`, async () => {
      const f = recordingFetch();
      await drain(new OllamaProvider({ fetch: f.impl, think }).stream({ model: 'm', messages: [userMsg] }));
      const [body] = f.parsed();
      expect(body!.stream).toBe(true);
      expect(body!.think).toBe(think);
    });
  }

  it('the non-streamed tool-decision pass and the streamed answer pass both carry it', async () => {
    const f = recordingFetch();
    const p = new OllamaProvider({ fetch: f.impl, think: false });
    await drain(p.stream({ model: 'm', messages: [userMsg], tools: [weatherTool] }));
    await drain(p.stream({ model: 'm', messages: [userMsg, toolResultMsg], tools: [weatherTool] }));
    const [decision, answer] = f.parsed();
    expect(decision).toMatchObject({ stream: false, think: false });
    expect(answer).toMatchObject({ stream: true, think: false });
  });

  it('keeps think on the retry after an empty reply', async () => {
    const f = recordingFetch([{ content: '' }, { content: 'second try' }]);
    const r = await new OllamaProvider({ fetch: f.impl, think: false }).generate({ model: 'm', messages: [userMsg] });
    expect(r.message.content).toContain('second try');
    expect(f.parsed().map((b) => b.think)).toEqual([false, false]);
  });

  it('sends no think field when unset, so bodies are byte-identical to before the option existed', async () => {
    const f = recordingFetch();
    const p = new OllamaProvider({ fetch: f.impl, defaultOptions: { num_ctx: 4096 } });
    await p.generate({ model: 'qwen2.5:7b', messages: [userMsg], system: 'sys' });
    await drain(p.stream({ model: 'qwen2.5:7b', messages: [userMsg], system: 'sys' }));
    await drain(p.stream({ model: 'qwen2.5:7b', messages: [userMsg], tools: [weatherTool] }));
    const messages = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ];
    expect(f.bodies[0]).toBe(JSON.stringify({ model: 'qwen2.5:7b', messages, stream: false, options: { num_ctx: 4096 } }));
    expect(f.bodies[1]).toBe(JSON.stringify({ model: 'qwen2.5:7b', messages, stream: true, options: { num_ctx: 4096 } }));
    for (const body of f.parsed()) expect(body).not.toHaveProperty('think');
  });

  it('adds only the think key: everything else in the body is unchanged', async () => {
    const without = recordingFetch();
    const withThink = recordingFetch();
    const args = { model: 'm', messages: [userMsg], tools: [weatherTool], maxTokens: 64 };
    await new OllamaProvider({ fetch: without.impl, defaultOptions: { num_ctx: 8 } }).generate(args);
    await new OllamaProvider({ fetch: withThink.impl, defaultOptions: { num_ctx: 8 }, think: false }).generate(args);
    const { think, ...rest } = withThink.parsed()[0]!;
    expect(think).toBe(false);
    expect(JSON.stringify(rest)).toBe(without.bodies[0]);
  });

  it("never surfaces a thinking model's reasoning as answer text", async () => {
    const f = recordingFetch([{ content: '391', thinking: '17*23: 17*20=340, 17*3=51, so 391' }]);
    const p = new OllamaProvider({ fetch: f.impl, think: true });
    const r = await p.generate({ model: 'm', messages: [userMsg] });
    expect(r.message.content).toBe('391');
    expect(textOf(await drain(p.stream({ model: 'm', messages: [userMsg] })))).toBe('391');
  });
});
