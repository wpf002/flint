import { describe, it, expect } from 'vitest';
import { Flint, InMemoryStore, type StreamEvent, type ToolDefinition } from '../../src/index.js';
import { OllamaProvider } from '../../src/provider/ollama/index.js';
import { decodeAssistantTurn } from '../../src/core/encoding.js';
import { searchTool } from './scripted.js';

/**
 * The tool loop's answer-only call on the local brain. Ollama has no
 * tool_choice, so `none` is honoured by not offering the tools; with no tools,
 * Ollama does not parse the model's tool-call output either, so a model that
 * keeps calling tools writes the call as TEXT. That text is not an answer: it
 * must never be shown, committed to memory, or reach the server's training log.
 *
 * A stub fetch plays Ollama; nothing touches a real Ollama.
 */

const LIMIT = 6; // the loop's default maxIterations

/**
 * Every request that offers tools gets a native tool call back (JSON or NDJSON
 * to match `stream`); the tool-less request (the answer-only call) streams
 * `answerChunks` as the content, one NDJSON line each.
 */
function loopingOllama(answerChunks: string[]) {
  const bodies: Array<Record<string, unknown>> = [];
  const impl = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    bodies.push(body);
    const final = { done: true, done_reason: 'stop', prompt_eval_count: 5, eval_count: 3 };
    if (body.tools) {
      const message = {
        role: 'assistant',
        content: '',
        tool_calls: [{ function: { name: 'web_search', arguments: { query: 'again' } } }],
      };
      return new Response(JSON.stringify({ message, ...final }) + (body.stream ? '\n' : ''), { status: 200 });
    }
    const lines = [
      ...answerChunks.map((content) => ({ message: { role: 'assistant', content } })),
      { message: { role: 'assistant', content: '' }, ...final },
    ];
    return new Response(lines.map((l) => JSON.stringify(l)).join('\n') + '\n', { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, bodies };
}

async function drain(it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

const textOf = (events: StreamEvent[]): string =>
  events.map((e) => (e.type === 'text' ? e.delta : '')).join('');

const CALL_JSON = '{"name": "web_search", "arguments": {"query": "still looking"}}';

describe('Ollama answer-only call: a tool call written as text is not an answer', () => {
  it.each([
    ['bare JSON', [CALL_JSON]],
    ['<tool_call> markup in one chunk', [`<tool_call>\n${CALL_JSON}\n</tool_call>`]],
    ['<tool_call> markup split across chunks', ['<', 'tool', '_call', '>\n', CALL_JSON, '\n</tool_call>']],
    ['<tool_call> markup after leading whitespace', ['\n', '<tool_call>', CALL_JSON, '</tool_call>']],
    ['function-call syntax', ['web_search("still looking")']],
  ])('%s: the turn fails as before, nothing is shown or stored', async (_label, chunks) => {
    const seen: string[] = [];
    const memory = new InMemoryStore();
    const { impl, bodies } = loopingOllama(chunks);
    const flint = new Flint({ provider: new OllamaProvider({ fetch: impl }), defaultModel: 'qwen', memory });

    const events = await drain(flint.chat({ conversationId: 'c', message: 'q', tools: [searchTool(seen)] }));

    expect(seen).toHaveLength(LIMIT);
    expect(bodies).toHaveLength(LIMIT + 1);
    expect('tools' in bodies[LIMIT]!).toBe(false); // the answer-only call offers no tools
    expect(textOf(events)).toBe(''); // no tool syntax reached the caller
    const last = events.at(-1);
    expect(last?.type).toBe('error');
    expect(last?.type === 'error' && last.error.message).toMatch(/exceeded 6 iterations.*came back empty/);
    // The failed turn committed nothing an answer could be read from.
    const history = await memory.getMessages('c');
    expect(history.filter((m) => m.role === 'assistant' && m.content.includes('still looking'))).toEqual([]);
    expect((await memory.getTurns('c')).map((t) => t.status)).toEqual(['failed']);
  });

  it('a real answer on the answer-only call still streams and completes', async () => {
    const memory = new InMemoryStore();
    const { impl } = loopingOllama(['From what I found, ', 'it is 42.']);
    const flint = new Flint({ provider: new OllamaProvider({ fetch: impl }), defaultModel: 'qwen', memory });

    const events = await drain(flint.chat({ conversationId: 'c', message: 'q', tools: [searchTool([])] }));

    expect(textOf(events)).toBe('From what I found, it is 42.');
    expect(events.filter((e) => e.type === 'text').length).toBeGreaterThan(1); // streamed, not held back
    expect(events.at(-1)).toMatchObject({ type: 'done', reason: 'complete' });
    expect((await memory.getMessages('c')).at(-1)).toMatchObject({ role: 'assistant', content: 'From what I found, it is 42.' });
  });
});

describe('OllamaProvider with toolChoice none', () => {
  const user = { id: 'u1', role: 'user' as const, content: 'q', timestamp: 0 };
  const tools: ToolDefinition[] = [
    { name: 'web.web_search', description: 's', inputSchema: { type: 'object', properties: { query: { type: 'string' } } }, idempotent: true },
  ];

  it('stream: recovers a text-form call against the tools it did not offer', async () => {
    const { impl, bodies } = loopingOllama(['<tool_call>', CALL_JSON, '</tool_call>']);
    const events = await drain(new OllamaProvider({ fetch: impl }).stream({ model: 'm', messages: [user], tools, toolChoice: 'none' }));
    expect('tools' in bodies[0]!).toBe(false);
    expect(textOf(events)).toBe('');
    expect(events).toMatchObject([
      { type: 'tool_call', call: { toolName: 'web.web_search', args: { query: 'still looking' } } },
      { type: 'done', reason: 'tool_call' },
    ]);
  });

  it('generate: the same recovery, so the call never comes back as the text', async () => {
    const impl = (async () =>
      new Response(JSON.stringify({ message: { role: 'assistant', content: CALL_JSON }, done: true, done_reason: 'stop' }), {
        status: 200,
      })) as unknown as typeof fetch;
    const out = await new OllamaProvider({ fetch: impl }).generate({ model: 'm', messages: [user], tools, toolChoice: 'none' });
    expect(out.reason).toBe('tool_call');
    expect(decodeAssistantTurn(out.message)).toMatchObject({
      text: '', // not left as text
      toolCalls: [{ toolName: 'web.web_search', args: { query: 'still looking' } }],
    });
  });

  it('text that merely starts with "<" still streams as text', async () => {
    const { impl } = loopingOllama(['<', 'b>bold</b> and <tool', 's> are tags']);
    const events = await drain(new OllamaProvider({ fetch: impl }).stream({ model: 'm', messages: [user], tools, toolChoice: 'none' }));
    expect(textOf(events)).toBe('<b>bold</b> and <tools> are tags');
    expect(events.at(-1)).toMatchObject({ type: 'done', reason: 'complete' });
  });
});
