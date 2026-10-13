import { describe, it, expect } from 'vitest';
import { Flint, HARDWARE_TIERS, InMemoryStore, OllamaProvider, hardwareTier, type ContextEvent, type StreamEvent, type Tool } from '@flint/core';
import { InMemoryLessonStore, Persona } from '@flint/persona';
import { WINDOW_FULL_AT, fitFields, fitObserver, type PromptFit } from '../src/route-log';
import { STANDBY_STYLE, engineLineFor, localStyleFor, readStyleDefaults, styleGuideFor, type StyleVariant } from '../src/style-variant';
import { noteFit, noteFitInput, turnFit, withTurnTaint } from '../src/turn-taint';
import { LOCAL_WIRES } from '../src/policy';

/**
 * The routing review's M6, as its own script found it (e5-standby): the standby
 * model was handed the default local guide (about 3,980 tokens), a dozen tool
 * schemas and half its window of history, in a 4,096-token window. That is
 * about twice what the window holds, and Ollama cuts the START of a prompt that
 * does not fit: the persona and the tools.
 *
 * The real Persona, Flint client and Ollama adapter, as main() builds them for
 * a local brain, over a fetch that records what would have been sent.
 */

const tok = (chars: number): number => Math.ceil(chars / 4);
const REPLY = 'Synthetic reply text for a review. '.repeat(20); // about 700 characters a turn
const USER = 'Synthetic user message for a review, about nothing in particular. '.repeat(6); // about 400
const CONTEXT = '[Context: synthetic per-turn context block, about 200 characters long, standing in for the time, the location and a recalled fact or two from memory.]';

const tools = (n: number): Tool[] =>
  Array.from({ length: n }, (_, i) => ({
    definition: {
      name: `server${i}.tool_${i}`,
      description: `Synthetic tool number ${i} that looks something up for a query and returns a short text result.`,
      inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'what to look up' }, max_results: { type: 'number' } }, required: ['query'] },
      idempotent: true,
    },
    handler: async () => 'ok',
  }));

interface Sent {
  system: number;
  tools: number;
  toolNames: string[];
  messages: number;
  messageCount: number;
  first: string;
  last: string;
}

/** Twelve turns on one brain; what its last request carried, in tokens, and how the client says it sized it. */
async function twelveTurns(o: { numCtx: number; modelMax?: number; guide: StyleVariant; toolCount: number; fit: boolean }) {
  const bodies: Array<Record<string, unknown>> = [];
  const f = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    bodies.push(body);
    const line = `${JSON.stringify({ message: { role: 'assistant', content: REPLY }, done: true, done_reason: 'stop', prompt_eval_count: 1, eval_count: 1 })}\n`;
    return new Response(line, { status: 200 });
  }) as unknown as typeof fetch;
  const model = hardwareTier('8gb').model;
  const provider = new OllamaProvider({
    baseURL: 'http://127.0.0.1:1',
    defaultOptions: { num_ctx: o.numCtx },
    think: false,
    fetch: f,
    capabilities: () => ({ toolCalling: 'native', ...(o.modelMax ? { maxContextTokens: o.modelMax } : {}) }),
  });
  const events: ContextEvent[] = [];
  const flint = new Flint({ provider, defaultModel: model, memory: new InMemoryStore(), observer: { onContext: (e) => events.push(e) }, ...(o.fit ? { fitToWindow: true } : {}) });
  const persona = new Persona(flint, { name: 'Flint', styleGuide: styleGuideFor(o.guide), engine: engineLineFor(provider, model), lessonStore: new InMemoryLessonStore() });
  const offered = tools(o.toolCount);
  let lastEvents: StreamEvent[] = [];
  for (let i = 0; i < 12; i++) {
    lastEvents = [];
    for await (const ev of persona.chat({ conversationId: 'c', message: `turn ${i}: ${USER}`, context: CONTEXT, tools: offered })) lastEvents.push(ev);
  }
  const caps = provider.getCapabilities(model);
  const body = bodies.at(-1) as { messages: Array<{ role: string; content: string }>; tools?: Array<{ function: { name: string } }> } | undefined;
  const sys = body ? body.messages.filter((m) => m.role === 'system') : [];
  const rest = body ? body.messages.filter((m) => m.role !== 'system') : [];
  const sent: Sent | undefined = body
    ? {
        system: tok(sys.reduce((n, m) => n + m.content.length, 0)),
        tools: tok(JSON.stringify(body.tools ?? []).length),
        toolNames: (body.tools ?? []).map((t) => t.function.name),
        messages: tok(rest.reduce((n, m) => n + m.content.length, 0)),
        messageCount: rest.length,
        first: rest[0]?.content ?? '',
        last: rest.at(-1)?.content ?? '',
      }
    : undefined;
  return { sent, caps, lastEvents, fit: events.at(-1), requests: bodies.length };
}

describe('the standby model is sent a prompt that fits its window', () => {
  it('the compact guide is the standby\'s, whatever the main model\'s, and it is about a third of the default one', () => {
    expect(STANDBY_STYLE).toBe('local-v1');
    expect(readStyleDefaults({}, () => {}).local).toBe('v1');
    const compact = tok(styleGuideFor(STANDBY_STYLE).length);
    const dflt = tok(styleGuideFor('v1').length);
    expect(dflt).toBeGreaterThan(3500); // "about 3,980 tokens": on its own, nearly a whole 4,096 window
    expect(compact).toBeLessThan(1500);
  });

  // What the reviewer measured, kept as the "before": about 8,000 tokens into a 4,096-token window.
  it('BEFORE (the default guide, no fitting): about twice what a 4,096 window holds was sent, for Ollama to cut', async () => {
    const r = await twelveTurns({ numCtx: 4096, guide: 'v1', toolCount: 12, fit: false });
    const total = r.sent!.system + r.sent!.tools + r.sent!.messages;
    expect(r.sent!.system).toBeGreaterThan(3500);
    expect(total + r.caps.maxOutputTokens).toBeGreaterThan(4096 * 1.5);
  });

  for (const [numCtx, toolCount] of [
    [8192, 12],
    [8192, 16],
    [4096, 12],
    [4096, 16],
  ] as const) {
    it(`AFTER, a ${numCtx}-token window and ${toolCount} tools offered: what is sent fits, the newest turns are the ones kept, and the first tools listed are the ones offered`, async () => {
      const r = await twelveTurns({ numCtx, guide: STANDBY_STYLE, toolCount, fit: true });
      expect(r.sent).toBeDefined();
      const total = r.sent!.system + r.sent!.tools + r.sent!.messages;
      // The whole prompt and the reply's reserve are inside the window. (4 characters a token, as the client counts.)
      expect(total + r.caps.maxOutputTokens).toBeLessThanOrEqual(numCtx);
      // The question that was asked is there, and what was left out is the OLDEST history.
      expect(r.sent!.last.startsWith('turn 11: ')).toBe(true);
      expect(r.sent!.first.startsWith('turn 0: ')).toBe(false);
      expect(r.fit!.messages.dropped + r.fit!.messages.kept).toBe(23); // eleven stored turns and the new question
      // Tools give way, the last listed first: the ones kept are the first ones (the core tools are listed first).
      expect(r.sent!.toolNames).toEqual(tools(toolCount).slice(0, r.sent!.toolNames.length).map((t) => t.definition.name));
      expect(r.fit).toMatchObject({ windowTokens: numCtx, fitted: true, tools: { offered: r.sent!.toolNames.length } });
      expect(r.fit!.messages.dropped).toBeGreaterThan(0);
      expect(r.fit!.messages.kept).toBe(r.sent!.messageCount);
      expect(r.lastEvents.at(-1)).toMatchObject({ type: 'done' });
    });
  }

  it('at 8,192 the standby keeps all twelve core tools; at 4,096 it keeps the first few that fit', async () => {
    const big = await twelveTurns({ numCtx: 8192, guide: STANDBY_STYLE, toolCount: 12, fit: true });
    const small = await twelveTurns({ numCtx: 4096, guide: STANDBY_STYLE, toolCount: 12, fit: true });
    expect(big.sent!.toolNames).toHaveLength(12);
    expect(big.fit!.tools.shed).toEqual([]);
    expect(small.sent!.toolNames.length).toBeGreaterThanOrEqual(3);
    expect(small.sent!.toolNames.length).toBeLessThan(12);
    expect(small.fit!.tools.shed.length).toBe(12 - small.sent!.toolNames.length);
    // The history it has room for is short, and it is the newest.
    expect(small.fit!.messages.kept).toBeGreaterThanOrEqual(1);
    expect(small.sent!.last.startsWith('turn 11: ')).toBe(true);
  });

  it('the main model at 16,384 with the default guide: nothing is left out, as before', async () => {
    const r = await twelveTurns({ numCtx: 16384, guide: 'v1', toolCount: 16, fit: true });
    const total = r.sent!.system + r.sent!.tools + r.sent!.messages;
    expect(total + r.caps.maxOutputTokens).toBeLessThanOrEqual(16384);
    expect(r.sent!.toolNames).toHaveLength(16);
    expect(r.sent!.first.startsWith('turn 0: ')).toBe(true);
    expect(r.fit).toMatchObject({ messages: { dropped: 0 }, tools: { shed: [] } });
  });

  it('the default guide in a 4,096 window is refused with a clear error before anything is sent, never cut by the server', async () => {
    const r = await twelveTurns({ numCtx: 4096, guide: 'v1', toolCount: 12, fit: true });
    expect(r.requests).toBe(0);
    expect(r.lastEvents).toHaveLength(1);
    expect(r.lastEvents[0]).toMatchObject({ type: 'error', error: { kind: 'context_overflow', retryable: false } });
  });

  it('so the MAIN model on a small tier is given the guide that fits: every tier\'s model, at its context, gets its question through', async () => {
    for (const tier of HARDWARE_TIERS) {
      // What main() builds the main local persona with (./style-variant localStyleFor).
      const guide = localStyleFor(readStyleDefaults({}, () => {}).local, tier.contextLength);
      const r = await twelveTurns({ numCtx: tier.contextLength, guide, toolCount: 12, fit: true });
      expect(r.requests, tier.id).toBeGreaterThan(0);
      expect(r.lastEvents.at(-1), tier.id).toMatchObject({ type: 'done' });
      expect(r.sent!.system + r.sent!.tools + r.sent!.messages + r.caps.maxOutputTokens, tier.id).toBeLessThanOrEqual(tier.contextLength);
      expect(r.sent!.last.startsWith('turn 11: '), tier.id).toBe(true);
    }
  });

  it('the window is what the model can really hold: asked for 8,192, a model whose maximum is 4,096 is sized to 4,096', async () => {
    const r = await twelveTurns({ numCtx: 8192, modelMax: 4096, guide: STANDBY_STYLE, toolCount: 12, fit: true });
    expect(r.caps.maxContextTokens).toBe(4096);
    expect(r.sent!.system + r.sent!.tools + r.sent!.messages + r.caps.maxOutputTokens).toBeLessThanOrEqual(4096);
    expect(r.fit!.windowTokens).toBe(4096);
  });
});

describe('what a local prompt left out is on the [route] line, with counts', () => {
  it('fitFields: a line only when something was left out', () => {
    expect(fitFields(undefined)).toEqual({});
    expect(fitFields({ window: 16384, dropped: 0, kept: 13, toolsShed: 0 })).toEqual({});
    expect(fitFields({ window: 8192, dropped: 6, kept: 7, toolsShed: 0 })).toEqual({ fit: { window: 8192, dropped: 6, kept: 7, toolsShed: 0 } });
    expect(fitFields({ window: 4096, dropped: 0, kept: 3, toolsShed: 5 })).toEqual({ fit: { window: 4096, dropped: 0, kept: 3, toolsShed: 5 } });
  });

  it('fitObserver: a local wire\'s prompt is noted on the turn that is running; a cloud brain\'s is not; numbers only', async () => {
    const event = (provider: string, dropped: number, shed: string[]): ContextEvent => ({ requestId: 'r', provider, model: 'm', timestamp: 0, windowTokens: 8192, reserveTokens: 2048, fixedTokens: 2000, budgetTokens: 4144, messages: { kept: 5, dropped }, tools: { offered: 3, shed }, fitted: true });
    const obs = fitObserver((p) => LOCAL_WIRES.has(p), noteFit);
    const seen = await withTurnTaint(async () => {
      expect(turnFit()).toBeUndefined();
      obs.onContext(event('anthropic', 9, ['x']));
      expect(turnFit()).toBeUndefined();
      obs.onContext(event('ollama', 4, ['web.fetch_url', 'trident.gmail_search']));
      await Promise.resolve();
      return turnFit();
    });
    const expected: PromptFit = { window: 8192, dropped: 4, kept: 5, toolsShed: 2 };
    expect(seen).toEqual(expected);
    // The OpenAI-compatible local adapter is a local wire too; the last local model asked is the one on the line.
    expect(await withTurnTaint(async () => (obs.onContext(event('ollama', 4, [])), obs.onContext(event('local', 1, [])), turnFit()))).toMatchObject({ dropped: 1 });
    // Outside a turn, nothing is noted and nothing breaks.
    obs.onContext(event('ollama', 4, []));
    expect(turnFit()).toBeUndefined();
    // A tool's name never reaches the line: only how many were left out.
    expect(JSON.stringify(seen)).not.toContain('gmail');
  });

  it('when the model\'s own count says the window was full after all, the line says so: a cut is never silent', async () => {
    const event = (dropped: number): ContextEvent => ({ requestId: 'r', provider: 'ollama', model: 'm', timestamp: 0, windowTokens: 4096, reserveTokens: 1024, fixedTokens: 1500, budgetTokens: 1300, messages: { kept: 3, dropped }, tools: { offered: 2, shed: [] }, fitted: true });
    const obs = fitObserver((p) => LOCAL_WIRES.has(p), noteFit, noteFitInput);
    const answered = (provider: string, usage: { input: number; output: number; lastInput?: number }) => obs.onResponse({ provider, usage });
    // Nothing was left out, and the model counted 2,900 tokens in a 4,096 window: nothing to say.
    expect(fitFields(await withTurnTaint(async () => (obs.onContext(event(0)), answered('ollama', { input: 2900, output: 40 }), turnFit())))).toEqual({});
    // Nothing was left out by the estimate, and the model counted 4,090: the estimate was wrong, and the server may have cut.
    const full = await withTurnTaint(async () => (obs.onContext(event(0)), answered('ollama', { input: 4090, output: 40 }), turnFit()));
    expect(fitFields(full)).toEqual({ fit: { window: 4096, dropped: 0, kept: 3, toolsShed: 0, full: true } });
    expect(WINDOW_FULL_AT).toBe(0.97);
    // A cloud brain's answer says nothing about a local window; a retried reply is judged by its last try.
    expect((await withTurnTaint(async () => (obs.onContext(event(0)), answered('anthropic', { input: 99999, output: 1 }), turnFit())))?.full).toBeUndefined();
    expect((await withTurnTaint(async () => (obs.onContext(event(0)), answered('ollama', { input: 9000, output: 1, lastInput: 3000 }), turnFit())))?.full).toBeUndefined();
  });
});
