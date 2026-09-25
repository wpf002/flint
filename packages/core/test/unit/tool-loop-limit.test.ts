import { describe, it, expect } from 'vitest';
import { Flint, InMemoryStore, FlintError, makeAiError, type StreamEvent, type Tool } from '../../src/index.js';
import type { ToolResultEvent } from '../../src/observability/observer.js';
import { TOOL_LIMIT_NOTE } from '../../src/core/tool-loop.js';
import { OpenAiProvider } from '../../src/provider/openai/index.js';
import { OllamaProvider } from '../../src/provider/ollama/index.js';
import type { Message } from '../../src/types/message.js';
import {
  answer,
  callTool,
  eventsAnswer,
  eventsCallTool,
  scriptedAnthropic,
  scriptedEvents,
  searchTool,
} from './scripted.js';

const LIMIT = 6; // the loop's default maxIterations
const NO_RETRY = { retryPolicy: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 } };

async function drain(it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

describe('tool loop at its iteration limit', () => {
  it('makes one answer-only call instead of failing the turn (Anthropic wire)', async () => {
    const seen: string[] = [];
    const { provider, bodies } = scriptedAnthropic([
      ...Array.from({ length: LIMIT }, (_, i) => callTool('web__web_search', `toolu_${i}`)),
      answer('answered from what I found'),
    ]);
    const out = await new Flint({ provider, defaultModel: 'claude-sonnet-4-6' }).generate({
      prompt: 'q',
      tools: [searchTool(seen)],
    });

    expect(out.text).toBe('answered from what I found');
    expect(out.reason).toBe('complete');
    expect(seen).toHaveLength(LIMIT);
    expect(bodies).toHaveLength(LIMIT + 1);

    // The normal iterations are untouched: tools offered, no tool_choice sent.
    for (const b of bodies.slice(0, LIMIT)) expect(b.tool_choice).toBeUndefined();
    // The last call keeps the tools defined (the history holds tool_use blocks,
    // which Anthropic rejects without them) but forbids calling them...
    const last = bodies[LIMIT]!;
    expect(last.tool_choice).toEqual({ type: 'none' });
    expect(last.tools?.map((t) => t.name)).toEqual(['web__web_search']);
    // ...and ends with the note, alongside the last tool result in the user turn.
    const fed = JSON.stringify(last.messages.at(-1));
    expect(last.messages.at(-1)!.role).toBe('user');
    expect(fed).toContain('tool_result');
    expect(fed).toContain('tool-call limit for this turn has been reached');
  });

  it('never stores the note: chat history holds the tool turns and the answer only', async () => {
    const memory = new InMemoryStore();
    const { provider } = scriptedEvents([...Array.from({ length: LIMIT }, (_, i) => eventsCallTool(`c${i}`)), eventsAnswer('done')]);
    const flint = new Flint({ provider, defaultModel: 'm', memory });
    const events = await drain(flint.chat({ conversationId: 'c', message: 'q', tools: [searchTool([])] }));

    expect(events.at(-1)).toMatchObject({ type: 'done', reason: 'complete' });
    const history = await memory.getMessages('c');
    expect(history.some((m) => m.content.includes(TOOL_LIMIT_NOTE))).toBe(false);
    expect(history.at(-1)).toMatchObject({ role: 'assistant', content: 'done' });
    expect(history.filter((m) => m.role === 'tool_result')).toHaveLength(LIMIT);
  });

  it('drops a tool call on the answer-only call and keeps its text', async () => {
    const seen: string[] = [];
    const { provider, calls } = scriptedEvents([
      ...Array.from({ length: LIMIT }, (_, i) => eventsCallTool(`c${i}`)),
      [{ type: 'text', delta: 'best I can say' }, ...eventsCallTool('late')],
    ]);
    const events = await drain(
      new Flint({ provider, defaultModel: 'm' }).stream({ prompt: 'q', tools: [searchTool(seen)] }),
    );

    expect(calls.at(-1)!.toolChoice).toBe('none');
    expect(seen).toHaveLength(LIMIT); // the late call never ran
    expect(events.filter((e) => e.type === 'tool_call')).toHaveLength(LIMIT); // and was never shown
    expect(events.at(-1)).toMatchObject({ type: 'done', reason: 'complete' });
  });

  it('fails the turn, as before, when the answer-only call is empty', async () => {
    const { provider } = scriptedEvents([...Array.from({ length: LIMIT }, () => eventsCallTool()), eventsAnswer('')]);
    const err = await new Flint({ provider, defaultModel: 'm' })
      .generate({ prompt: 'q', tools: [searchTool([])] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FlintError);
    expect((err as FlintError).message).toMatch(/exceeded 6 iterations/);
    expect((err as FlintError).message).toMatch(/came back empty/);
  });

  it('fails the turn when the answer-only call errors, keeping that error kind', async () => {
    const { provider } = scriptedEvents([
      ...Array.from({ length: LIMIT }, () => eventsCallTool()),
      [{ type: 'error', error: makeAiError('rate_limit', '429 slow down', { retryable: false }) }],
    ]);
    const err = (await new Flint({ provider, defaultModel: 'm', ...NO_RETRY })
      .generate({ prompt: 'q', tools: [searchTool([])] })
      .catch((e: unknown) => e)) as FlintError;
    expect(err).toBeInstanceOf(FlintError);
    expect(err.kind).toBe('rate_limit');
    expect(err.message).toMatch(/exceeded 6 iterations.*also failed: 429 slow down/);
  });

  it('a refusal on the answer-only call is reported as a refusal, not an error', async () => {
    const { provider } = scriptedEvents([...Array.from({ length: LIMIT }, () => eventsCallTool()), eventsAnswer('', 'refusal')]);
    const out = await new Flint({ provider, defaultModel: 'm' }).generate({ prompt: 'q', tools: [searchTool([])] });
    expect(out.reason).toBe('refusal');
  });

  it('a turn that finishes inside the limit makes no extra call', async () => {
    const { provider, calls } = scriptedEvents([eventsCallTool(), eventsAnswer('quick')]);
    const out = await new Flint({ provider, defaultModel: 'm' }).generate({ prompt: 'q', tools: [searchTool([])] });
    expect(out.text).toBe('quick');
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.toolChoice === undefined)).toBe(true);
  });
});

describe('a tool result that reports an error', () => {
  /** The shape @flint/mcp returns for a CallToolResult with isError: true. */
  const mcpError = { isError: true, content: 'invalid_grant: token expired' };

  it('is marked isError for the model and the observer (it used to read as ok)', async () => {
    const results: ToolResultEvent[] = [];
    const { provider, bodies } = scriptedAnthropic([callTool('trident__gmail_search'), answer('mail is down')]);
    const gmail: Tool = {
      definition: { name: 'trident.gmail_search', description: 'mail', inputSchema: { type: 'object' }, idempotent: true },
      handler: () => mcpError,
    };
    const out = await new Flint({
      provider,
      defaultModel: 'claude-sonnet-4-6',
      observer: { onToolResult: (e) => results.push(e) },
    }).generate({ prompt: 'q', tools: [gmail] });

    expect(out.text).toBe('mail is down');
    expect(results.map((r) => r.isError)).toEqual([true]);
    const block = (bodies[1]!.messages.at(-1)!.content as Array<Record<string, unknown>>)[0]!;
    expect(block).toMatchObject({ type: 'tool_result', is_error: true });
    expect(String(block.content)).toContain('invalid_grant');
  });

  it('a normal result is still ok, including one with a falsy or non-boolean isError', async () => {
    for (const result of ['plain text', { isError: false, content: 'fine' }, { isError: 'yes' }, null]) {
      const results: ToolResultEvent[] = [];
      const { provider, bodies } = scriptedAnthropic([callTool('web__web_search'), answer('ok')]);
      await new Flint({
        provider,
        defaultModel: 'claude-sonnet-4-6',
        observer: { onToolResult: (e) => results.push(e) },
      }).generate({ prompt: 'q', tools: [searchTool([], result)] });
      expect(results.map((r) => r.isError), JSON.stringify(result)).toEqual([false]);
      const block = (bodies[1]!.messages.at(-1)!.content as Array<Record<string, unknown>>)[0]!;
      expect(block.is_error).toBeUndefined();
    }
  });
});

describe('toolChoice none on the other adapters', () => {
  const user: Message = { id: 'm1', role: 'user', content: 'q', timestamp: 0 };
  const tools = [{ name: 'web.web_search', description: 's', inputSchema: { type: 'object' }, idempotent: true }];

  it('OpenAI keeps the tools and sends tool_choice none; other requests are unchanged', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetch = (async (_u: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body) as Record<string, unknown>);
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const p = new OpenAiProvider({ apiKey: 'k', fetch });
    await p.generate({ model: 'gpt-5', messages: [user], tools, toolChoice: 'none' });
    await p.generate({ model: 'gpt-5', messages: [user], tools });
    await p.generate({ model: 'gpt-5', messages: [user], toolChoice: 'none' });
    expect(bodies[0]!.tool_choice).toBe('none');
    expect(bodies[0]!.tools).toHaveLength(1);
    expect('tool_choice' in bodies[1]!).toBe(false);
    expect('tool_choice' in bodies[2]!).toBe(false); // no tools, nothing to forbid
  });

  it('Ollama (no tool_choice knob) simply does not offer the tools', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetch = (async (_u: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      bodies.push(body);
      const final = { message: { role: 'assistant', content: 'ok' }, done: true, done_reason: 'stop' };
      return new Response(body.stream ? JSON.stringify(final) + '\n' : JSON.stringify(final), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const p = new OllamaProvider({ fetch });
    await p.generate({ model: 'm', messages: [user], tools, toolChoice: 'none' });
    await drain(p.stream({ model: 'm', messages: [user], tools, toolChoice: 'none' }));
    await p.generate({ model: 'm', messages: [user], tools });
    expect('tools' in bodies[0]!).toBe(false);
    expect('tools' in bodies[1]!).toBe(false);
    expect(bodies[2]!.tools).toHaveLength(1);
  });
});
