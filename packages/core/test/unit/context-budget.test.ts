import { describe, it, expect } from 'vitest';
import { FIT_MARGIN, fittedPromptTokens, fixedPromptTokens, messageBudget } from '../../src/core/context.js';
import { Flint, InMemoryStore, OllamaProvider } from '../../src/index.js';
import { ollamaCapabilities } from '../../src/provider/ollama/capabilities.js';
import type { ContextEvent, GenerateArgs, ProviderAdapter, StreamEvent, Tool } from '../../src/index.js';

/**
 * How much history a turn carries. The budget follows the window the model
 * really runs with, and counts what else is in it: the system prompt and the
 * tool schemas, which ride on every pass.
 *
 * Why: the native Ollama table gave an unknown model a 4,096-token window, so
 * a model Ollama ran at 16,384 was sent about 2,000 tokens of history; and a
 * model the table knew (32,768) was sent far more than a 4,096 window holds.
 */

describe('OllamaProvider.getCapabilities follows the context it asks Ollama for', () => {
  const unknown = 'some-new-model';

  it('with no num_ctx configured, the table answers, as before', () => {
    const p = new OllamaProvider();
    expect(p.getCapabilities(unknown)).toEqual(ollamaCapabilities(unknown));
    expect(p.getCapabilities(unknown).maxContextTokens).toBe(4096);
  });

  it('num_ctx 16384 is a 16,384-token window, whatever the table says about the model', () => {
    const p = new OllamaProvider({ defaultOptions: { num_ctx: 16384 } });
    const caps = p.getCapabilities(unknown);
    expect(caps.maxContextTokens).toBe(16384);
    // The unknown model's 2,048 reply reserve fits a quarter of the window, so it stays.
    expect(caps.maxOutputTokens).toBe(2048);
  });

  it('num_ctx 4096 is a 4,096-token window even for a family the table lists at 32,768', () => {
    const family = ollamaCapabilities('qwen2.5');
    expect(family.maxContextTokens).toBe(32768);
    const p = new OllamaProvider({ defaultOptions: { num_ctx: 4096 } });
    const caps = p.getCapabilities('qwen2.5');
    expect(caps.maxContextTokens).toBe(4096);
    // The table's 8,192 reply reserve would be the whole window: it is held to a quarter.
    expect(caps.maxOutputTokens).toBe(1024);
  });

  it('a num_ctx that is not a positive whole number is ignored', () => {
    for (const bad of [0, -1, 4096.5, NaN, '16384', null]) {
      const p = new OllamaProvider({ defaultOptions: { num_ctx: bad } });
      expect(p.getCapabilities(unknown).maxContextTokens, String(bad)).toBe(4096);
    }
  });
});

describe('an unknown Ollama model is not claimed to call tools', () => {
  it("the table says 'unsupported' for a model it has never heard of, 'native' for the families it lists", () => {
    expect(ollamaCapabilities('some-new-model').toolCalling).toBe('unsupported');
    expect(ollamaCapabilities('qwen2.5').toolCalling).toBe('native');
    expect(ollamaCapabilities('llama3.1').toolCalling).toBe('native');
  });

  it("what the caller knows (the server's own report) wins over the table, field by field", () => {
    const p = new OllamaProvider({
      defaultOptions: { num_ctx: 16384 },
      capabilities: (m) => (m === 'probed' ? { toolCalling: 'native', vision: true } : undefined),
    });
    expect(p.getCapabilities('probed')).toMatchObject({ toolCalling: 'native', vision: true, maxContextTokens: 16384 });
    expect(p.getCapabilities('not-probed').toolCalling).toBe('unsupported');
  });

  it('an undefined field in what the caller knows never erases the table', () => {
    const p = new OllamaProvider({ capabilities: () => ({ toolCalling: undefined, vision: true }) as never });
    expect(p.getCapabilities('qwen2.5').toolCalling).toBe('native');
  });
});

describe('the native adapter and a model that cannot call tools', () => {
  const tool = { name: 'get_weather', description: 'Weather', inputSchema: { type: 'object', properties: {} }, idempotent: true };
  const user = { id: 'u', role: 'user' as const, content: 'hi', timestamp: 0 };

  function recording(over: ConstructorParameters<typeof OllamaProvider>[0] = {}) {
    const bodies: Array<Record<string, unknown>> = [];
    const inits: RequestInit[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit & { body?: string }) => {
      inits.push(init ?? {});
      bodies.push(JSON.parse(init?.body ?? '{}') as Record<string, unknown>);
      return new Response(JSON.stringify({ message: { role: 'assistant', content: 'ok' }, done: true, done_reason: 'stop' }), { status: 200 });
    }) as unknown as typeof fetch;
    return { provider: new OllamaProvider({ fetch: fetchImpl, ...over }), bodies, inits };
  }

  it('with nothing known about the model, tools are sent exactly as before (only the reported flag changed)', async () => {
    const { provider, bodies } = recording();
    await provider.generate({ model: 'some-new-model', messages: [user], tools: [tool] });
    expect((bodies[0]!.tools as unknown[]).length).toBe(1);
  });

  it("a model the caller knows cannot call tools is not offered any (Ollama would answer 400 every time)", async () => {
    const { provider, bodies } = recording({ capabilities: () => ({ toolCalling: 'unsupported' }) });
    await provider.generate({ model: 'm', messages: [user], tools: [tool] });
    expect('tools' in bodies[0]!).toBe(false);
    const events: StreamEvent[] = [];
    for await (const e of provider.stream({ model: 'm', messages: [user], tools: [tool] })) events.push(e);
    expect('tools' in bodies[1]!).toBe(false);
    // With no tools it is plain chat, which streams.
    expect(bodies[1]!.stream).toBe(true);
  });

  it('never follows a redirect, on any of its calls', async () => {
    const { provider, inits } = recording();
    await provider.generate({ model: 'm', messages: [user] });
    await provider.generate({ model: 'm', messages: [user], responseFormat: { type: 'json_schema', name: 'x', schema: { type: 'object' } } }).catch(() => {});
    for await (const _ of provider.stream({ model: 'm', messages: [user] })) void _;
    expect(inits.length).toBeGreaterThanOrEqual(3);
    for (const init of inits) expect(init.redirect).toBe('error');
  });

  it('a redirect is reported as a wrong address, not retried as an outage', async () => {
    const redirected = (async () => {
      throw new TypeError('fetch failed', { cause: new Error('unexpected redirect') });
    }) as unknown as typeof fetch;
    const provider = new OllamaProvider({ fetch: redirected });
    await expect(provider.generate({ model: 'm', messages: [user] })).rejects.toMatchObject({ error: { kind: 'validation', providerCode: 'redirect', retryable: false } });
  });
});

describe('messageBudget', () => {
  it('is the input window minus the fixed prompt', () => {
    expect(messageBudget(14336, 3500)).toBe(10836);
    expect(messageBudget(192_000, 5_000)).toBe(187_000);
  });

  it('never lets the fixed prompt take more than half the input window', () => {
    expect(messageBudget(3072, 3000)).toBe(1536);
    expect(messageBudget(3072, 9000)).toBe(1536);
  });

  it('is never negative', () => {
    expect(messageBudget(-5, 100)).toBe(0);
    expect(messageBudget(0, 0)).toBe(0);
  });
});

describe('fixedPromptTokens', () => {
  it('counts the system prompt and each tool schema at about four characters a token', () => {
    expect(fixedPromptTokens(undefined, [])).toBe(0);
    expect(fixedPromptTokens('x'.repeat(400), [])).toBe(100);
    const tool = { name: 'abcd', description: 'd'.repeat(36), inputSchema: { type: 'object' }, idempotent: true };
    expect(fixedPromptTokens('', [tool])).toBe(Math.ceil((4 + 36 + JSON.stringify(tool.inputSchema).length) / 4));
  });
});

describe('a chat turn carries the history its real window has room for', () => {
  /** A provider with a given window that records what each call was sent. Tokens are characters / 4. */
  function windowed(maxContextTokens: number, maxOutputTokens: number) {
    const calls: GenerateArgs[] = [];
    const provider: ProviderAdapter = {
      name: 'stub',
      getCapabilities: () => ({ toolCalling: 'native', structuredOutput: 'native', streaming: 'full', maxContextTokens, maxOutputTokens }),
      estimateTokens: (ms) => Math.ceil(ms.reduce((n, m) => n + m.content.length, 0) / 4),
      generate: () => Promise.reject(new Error('stream only')),
      async *stream(args) {
        calls.push(args);
        yield { type: 'text', delta: 'ok' };
        yield { type: 'done', reason: 'complete', usage: { input: 1, output: 1 } };
      },
    };
    return { provider, calls };
  }

  /** Six past turns of 1,000 tokens each (a 3,998-character question and a 2-character answer), then one short question. */
  async function sentWith(provider: ProviderAdapter, calls: GenerateArgs[], system: string, tools: Tool[] = []): Promise<number> {
    const memory = new InMemoryStore();
    const flint = new Flint({ provider, defaultModel: 'm', memory });
    for (let i = 0; i < 6; i++) {
      for await (const _ of flint.chat({ conversationId: 'c', message: 'q'.repeat(3998) })) void _;
    }
    calls.length = 0;
    for await (const _ of flint.chat({ conversationId: 'c', message: 'and now?', system, tools })) void _;
    return calls[0]!.messages.length;
  }

  it('a 16,384-token window carries all six turns; a 4,096-token one carries only the newest that fit', async () => {
    const big = windowed(16384, 2048);
    // 6 turns x 1,000 tokens = 6,000: well inside 16,384 - 2,048. Twelve stored messages and the new question.
    expect(await sentWith(big.provider, big.calls, '')).toBe(13);
    const small = windowed(4096, 1024);
    // Input window 3,072 tokens: the new question, the three newest turns, and the two-character
    // answer before them (messages are dropped oldest first, one at a time).
    expect(await sentWith(small.provider, small.calls, '')).toBe(8);
    expect(small.calls[0]!.messages.at(-1)!.content).toBe('and now?');
  });

  it('a large system prompt and tool list leave less room for history, but the newest message always goes', async () => {
    const bare = windowed(8192, 1024);
    const withNothing = await sentWith(bare.provider, bare.calls, '');
    const loaded = windowed(8192, 1024);
    const tools: Tool[] = Array.from({ length: 10 }, (_, i) => ({
      definition: { name: `tool_${i}`, description: 'd'.repeat(800), inputSchema: { type: 'object', properties: {} }, idempotent: true },
      handler: () => 'x',
    }));
    const withPrompt = await sentWith(loaded.provider, loaded.calls, 's'.repeat(8000), tools);
    // Input window 7,168. Alone, the 6,000 tokens of history fit. The prompt and tools are about
    // 4,000 more, which would leave 3,100: the half-window floor (3,584) keeps three turns.
    expect(withNothing).toBe(13);
    expect(withPrompt).toBe(8);
    expect(loaded.calls[0]!.messages.at(-1)!.content).toBe('and now?');
  });
});

// The routing review's M6: a small local model was handed a system prompt of about 3,980 tokens, tool schemas
// and half its window of history, in a 4,096-token window. Ollama then cuts the START of the prompt, which is
// the persona and the tools. With fitToWindow the client sends nothing that does not fit, and says what it left out.
describe('fitToWindow: the whole prompt is sized to the window', () => {
  const tokens = (n: number): string => 'x'.repeat(n * 4);
  const tool = (name: string, schemaTokens: number): Tool => ({
    // Its schema is `schemaTokens` tokens, near enough: the name and the JSON shell are a few characters more.
    definition: { name, description: tokens(schemaTokens), inputSchema: {}, idempotent: true },
    handler: () => 'x',
  });

  function windowed(maxContextTokens: number, maxOutputTokens: number) {
    const calls: GenerateArgs[] = [];
    const provider: ProviderAdapter = {
      name: 'stub',
      getCapabilities: () => ({ toolCalling: 'native', structuredOutput: 'native', streaming: 'full', maxContextTokens, maxOutputTokens }),
      estimateTokens: (ms) => Math.ceil(ms.reduce((n, m) => n + m.content.length, 0) / 4),
      generate: () => Promise.reject(new Error('stream only')),
      async *stream(args) {
        calls.push(args);
        yield { type: 'text', delta: 'ok' };
        yield { type: 'done', reason: 'complete', usage: { input: 1, output: 1 } };
      },
    };
    return { provider, calls };
  }

  async function ask(opts: { window: number; reserve: number; system: string; tools?: Tool[]; history?: number; message?: string; fit?: boolean }) {
    const w = windowed(opts.window, opts.reserve);
    const seen: ContextEvent[] = [];
    const flint = new Flint({ provider: w.provider, defaultModel: 'm', memory: new InMemoryStore(), observer: { onContext: (e) => seen.push(e) }, ...(opts.fit === false ? {} : { fitToWindow: true }) });
    // History: turns of about 500 tokens each (a 499-token question and a short answer).
    for (let i = 0; i < (opts.history ?? 0); i++) for await (const _ of flint.chat({ conversationId: 'c', message: `turn ${i} ${tokens(497)}` })) void _;
    w.calls.length = 0;
    seen.length = 0;
    const events: StreamEvent[] = [];
    for await (const e of flint.chat({ conversationId: 'c', message: opts.message ?? 'and now?', system: opts.system, tools: opts.tools ?? [] })) events.push(e);
    return { sent: w.calls[0], events, fit: seen[0] };
  }
  const total = (sent: GenerateArgs): number => fixedPromptTokens(sent.system, sent.tools ?? []) + Math.ceil(sent.messages.reduce((n, m) => n + m.content.length, 0) / 4);

  it('a prompt that fits is sent whole, and the event says nothing was left out', async () => {
    const { sent, fit } = await ask({ window: 16384, reserve: 2048, system: tokens(4000), tools: [tool('a', 300), tool('b', 300)], history: 6 });
    expect(sent!.tools!.map((t) => t.name)).toEqual(['a', 'b']);
    expect(sent!.messages).toHaveLength(13);
    expect(fit).toMatchObject({ windowTokens: 16384, reserveTokens: 2048, messages: { kept: 13, dropped: 0 }, tools: { offered: 2, shed: [] }, fitted: true });
  });

  it('what is sent never adds up to more than the window, whatever the system prompt, the tools and the history', async () => {
    for (const window of [4096, 8192, 16384]) {
      for (const system of [0, 1300, 2000, 4000]) {
        for (const tools of [0, 5, 15]) {
          const reserve = Math.floor(window / 4);
          const r = await ask({ window, reserve, system: tokens(system), tools: Array.from({ length: tools }, (_, i) => tool(`t${i}`, 250)), history: 12 });
          if (!r.sent) continue; // refused before it was sent: the next test
          expect(total(r.sent) + reserve, `window ${window}, system ${system}, ${tools} tools`).toBeLessThanOrEqual(window);
          // The newest message always goes.
          expect(r.sent.messages.at(-1)!.content).toBe('and now?');
        }
      }
    }
  });

  it('tools give way, the last listed first, so the messages keep a quarter of the input window', async () => {
    // Window 8,192, reply 2,048, and 5% of the window left free: 5,734 for the prompt, of which the messages
    // are owed a quarter (1,433). System 2,000. Each tool counts for about 355 (as it goes on the wire, at 3
    // characters a token): four of them fit easily.
    const system = tokens(2000);
    const four = Array.from({ length: 4 }, (_, i) => tool(`t${i}`, 250));
    const fits = await ask({ window: 8192, reserve: 2048, system, tools: four, history: 8 });
    expect(fits.sent!.tools).toHaveLength(4);
    expect(fits.fit!.tools).toEqual({ offered: 4, shed: [] });
    // Fourteen do not. The last listed go until what is left fits: the first six stay.
    const fourteen = Array.from({ length: 14 }, (_, i) => tool(`t${i}`, 250));
    const input = 8192 - 2048 - Math.ceil(8192 * FIT_MARGIN);
    let room = 0;
    while (room < 14 && fittedPromptTokens(system, fourteen.slice(0, room + 1).map((t) => t.definition)) <= input - Math.floor(input / 4)) room++;
    expect(room).toBe(6);
    const shed = await ask({ window: 8192, reserve: 2048, system, tools: fourteen, history: 8 });
    const names = shed.sent!.tools!.map((t) => t.name);
    expect(names).toEqual(['t0', 't1', 't2', 't3', 't4', 't5']); // the first listed are the ones kept
    expect(shed.fit!.tools).toEqual({ offered: 6, shed: ['t6', 't7', 't8', 't9', 't10', 't11', 't12', 't13'] });
    // And the history that is left out is counted: the newest turns are the ones kept.
    expect(shed.fit!.messages.dropped).toBeGreaterThan(0);
    expect(shed.fit!.messages.kept + shed.fit!.messages.dropped).toBe(17);
    expect(shed.sent!.messages.at(-1)!.content).toBe('and now?');
    expect(shed.sent!.messages.at(-3)!.content.startsWith('turn 7 ')).toBe(true);
  });

  // The final review's M3d: a router lists the tools it matched to the message LAST, after the ones every turn
  // gets, so on a small window the matched tools were the first to go and the turn lost exactly what it needed.
  it('a tool chosen for this message (keep) is left out only after every other: the core gives way from its tail first', async () => {
    const system = tokens(2000);
    const core = Array.from({ length: 10 }, (_, i) => tool(`core${i}`, 250));
    const matched = [{ ...tool('matched_a', 250), keep: true }, { ...tool('matched_b', 250), keep: true }];
    // The same window as above: six tools fit. Without the mark the two matched ones, listed last, would go first.
    const plain = await ask({ window: 8192, reserve: 2048, system, tools: [...core, ...matched.map((t) => ({ definition: t.definition, handler: t.handler }))], history: 8 });
    expect(plain.sent!.tools!.map((t) => t.name)).toEqual(['core0', 'core1', 'core2', 'core3', 'core4', 'core5']);
    const fit = await ask({ window: 8192, reserve: 2048, system, tools: [...core, ...matched], history: 8 });
    // Four of the core, from its head, and both matched tools: still six, in the order they were listed.
    expect(fit.sent!.tools!.map((t) => t.name)).toEqual(['core0', 'core1', 'core2', 'core3', 'matched_a', 'matched_b']);
    expect(fit.fit!.tools).toEqual({ offered: 6, shed: ['core4', 'core5', 'core6', 'core7', 'core8', 'core9'] });
    // The mark is the client's own: it never reaches the wire.
    expect(JSON.stringify(fit.sent!.tools)).not.toContain('keep');
  });

  it('when even the tools chosen for the message do not all fit, they go last first too, and the prompt still fits', async () => {
    const system = tokens(2000);
    const many = Array.from({ length: 9 }, (_, i) => ({ ...tool(`m${i}`, 250), keep: true }));
    const r = await ask({ window: 8192, reserve: 2048, system, tools: [tool('core0', 250), tool('core1', 250), ...many], history: 8 });
    // Every unmarked tool went first; then the marked ones from the end.
    expect(r.sent!.tools!.map((t) => t.name)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4', 'm5']);
    expect(r.fit!.tools).toEqual({ offered: 6, shed: ['core0', 'core1', 'm6', 'm7', 'm8'] });
    expect(total(r.sent!) + 2048).toBeLessThanOrEqual(8192);
  });

  it('with room for everything, the mark changes nothing: same tools, same order', async () => {
    const tools = [tool('a', 300), { ...tool('b', 300), keep: true }, tool('c', 300)];
    const { sent, fit } = await ask({ window: 16384, reserve: 2048, system: tokens(4000), tools, history: 2 });
    expect(sent!.tools!.map((t) => t.name)).toEqual(['a', 'b', 'c']);
    expect(fit!.tools).toEqual({ offered: 3, shed: [] });
    // ...and a client that is not fitted ignores it.
    const off = await ask({ window: 8192, reserve: 2048, system: tokens(2000), tools: Array.from({ length: 14 }, (_, i) => ({ ...tool(`t${i}`, 250), keep: i > 11 })), history: 8, fit: false });
    expect(off.sent!.tools).toHaveLength(14);
  });

  it('a fitted prompt is counted on the safe side: each tool as it goes on the wire and at 3 characters a token, and 5% of the window is left free', () => {
    const t = { name: 'abcd', description: 'd'.repeat(236), inputSchema: {}, idempotent: true };
    // 4 + 236 + 2 ("{}") + 60 of wire wrapper = 302 characters: 101 tokens at 3, where the plain count says 61.
    expect(fittedPromptTokens('', [t])).toBe(101);
    expect(fixedPromptTokens('', [t])).toBe(61);
    expect(fittedPromptTokens('x'.repeat(400), [])).toBe(100); // prose is still 4 characters a token
    expect(fittedPromptTokens(undefined, [])).toBe(0);
    expect(FIT_MARGIN).toBe(0.05);
  });

  it('a tool that was left out can still be run if the model names it: only its schema was not sent', async () => {
    const calls: GenerateArgs[] = [];
    let ran = 0;
    const provider: ProviderAdapter = {
      name: 'stub',
      getCapabilities: () => ({ toolCalling: 'native', structuredOutput: 'native', streaming: 'full', maxContextTokens: 4096, maxOutputTokens: 1024 }),
      estimateTokens: (ms) => Math.ceil(ms.reduce((n, m) => n + m.content.length, 0) / 4),
      generate: () => Promise.reject(new Error('stream only')),
      async *stream(args) {
        calls.push(args);
        yield { type: 'text', delta: 'ok' };
        yield { type: 'done', reason: 'complete', usage: { input: 1, output: 1 } };
      },
    };
    const big: Tool = { definition: { name: 'big', description: tokens(3000), inputSchema: {}, idempotent: true }, handler: () => (ran++, 'x') };
    const flint = new Flint({ provider, defaultModel: 'm', fitToWindow: true });
    for await (const _ of flint.stream({ prompt: 'hi', system: tokens(500), tools: [big] })) void _;
    expect(calls[0]!.tools ?? []).toEqual([]);
    expect(ran).toBe(0);
  });

  it('a system prompt that leaves no room for the question is refused before anything is sent: context_overflow, with the numbers', async () => {
    // Window 4,096, reply 1,024: input 3,072. The system prompt is 3,980 tokens (the default local guide's size).
    const r = await ask({ window: 4096, reserve: 1024, system: tokens(3980), tools: [tool('a', 200)], history: 2 });
    expect(r.sent).toBeUndefined();
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({ type: 'error', error: { kind: 'context_overflow', retryable: false } });
    expect((r.events[0] as { error: { message: string } }).error.message).toBe("The prompt does not fit this model's window: 4096 tokens, 1024 of them kept for the reply, and the system prompt takes about 3980.");
    // The compact guide (about 1,300 tokens) fits the same window, with what history there is room for.
    const compact = await ask({ window: 4096, reserve: 1024, system: tokens(1300), tools: [tool('a', 200)], history: 6 });
    expect(compact.sent).toBeDefined();
    expect(total(compact.sent!) + 1024).toBeLessThanOrEqual(4096);
    expect(compact.fit!.messages.dropped).toBeGreaterThan(0);
  });

  it('a question that is itself too long for the window is refused the same way, never cut', async () => {
    const r = await ask({ window: 4096, reserve: 1024, system: tokens(500), message: tokens(3000) });
    expect(r.sent).toBeUndefined();
    expect(r.events[0]).toMatchObject({ type: 'error', error: { kind: 'context_overflow' } });
  });

  it('off (the default), the client is what it was: the half-window floor, and the same event with fitted false', async () => {
    const r = await ask({ window: 4096, reserve: 1024, system: tokens(3980), tools: [tool('a', 200)], history: 2, fit: false });
    expect(r.sent).toBeDefined();
    expect(r.sent!.tools).toHaveLength(1);
    // More than the window holds: this is what the server used to be sent, and cut.
    expect(total(r.sent!) + 1024).toBeGreaterThan(4096);
    expect(r.fit).toMatchObject({ fitted: false, tools: { offered: 1, shed: [] }, budgetTokens: 1536 });
  });
});

describe("OllamaProvider's window is never more than the model's own maximum", () => {
  it('num_ctx above what the model can hold: the window is the maximum the caller knows, and the reply reserve follows it', () => {
    const p = new OllamaProvider({ defaultOptions: { num_ctx: 16384 }, capabilities: () => ({ maxContextTokens: 8192 }) });
    const caps = p.getCapabilities('small-max-model');
    expect(caps.maxContextTokens).toBe(8192);
    expect(caps.maxOutputTokens).toBeLessThanOrEqual(2048);
  });

  it('num_ctx below the maximum is the window, as before; so is num_ctx with no maximum known', () => {
    expect(new OllamaProvider({ defaultOptions: { num_ctx: 4096 }, capabilities: () => ({ maxContextTokens: 131072 }) }).getCapabilities('m').maxContextTokens).toBe(4096);
    expect(new OllamaProvider({ defaultOptions: { num_ctx: 16384 }, capabilities: () => ({ toolCalling: 'native' }) }).getCapabilities('m').maxContextTokens).toBe(16384);
    expect(new OllamaProvider({ defaultOptions: { num_ctx: 16384 }, capabilities: () => undefined }).getCapabilities('m').maxContextTokens).toBe(16384);
  });
});
