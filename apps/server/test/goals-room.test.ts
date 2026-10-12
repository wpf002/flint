/**
 * The room the goals block has (P3 part 4). The block is never more than the
 * brain's REAL context has room for: the window the model will really have
 * (an Ollama client's own `num_ctx`, not a hard-coded 4,096 and not a table's
 * guess), less its reply's share, less the rest of the ask's prompt, less a
 * margin. With too little room it is shorter; with none it is left out, and
 * then the ask is an ordinary one: every tool, and no mark on its turn. A
 * prompt Ollama has to cut loses its start, the persona and the tools.
 * Synthetic text only. No network.
 */
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { AnthropicProvider, OllamaProvider, type Tool } from '@flint/core';
import { envProviderFactory } from '../src/brains';
import { GOALS_NOW_MAX_TOKENS, GOALS_PROMPT_MARGIN, GOALS_TURN, GoalsNow, chatBrain, promptRoom, renderGoals, type ChatBrain } from '../src/goals-now';
import { withoutOutsideAi } from '../src/goals-tools';
import { liveOllamaOptions } from '../src/local-model';
import { paidToolSpecs } from '../src/spend';
import { estimateTokens } from '../src/world-now';
import { CANARY, GUIDE, HERE, RT, answer, cleanup, goal, listed, miniServer as server, type Step } from './goals-mini';

// What this Mac's Ollama lists as running on it (../src/ollama-locality): the gate takes its word, not a name's.
beforeEach(() => listed(HERE, ['qwen2.5:14b', 'qwen2.5:72b', 'm', 'x']));
afterEach(cleanup);

describe('chatBrain: the context a brain really has', () => {
  it('an Ollama client’s own num_ctx is its window: 4,096 by default, and whatever OLLAMA_NUM_CTX says when it is set', () => {
    expect(chatBrain(new OllamaProvider(liveOllamaOptions({})), 'qwen2.5:14b')).toMatchObject({ numCtx: 4096, window: 4096, reserve: 1024 });
    expect(chatBrain(new OllamaProvider(liveOllamaOptions({ OLLAMA_NUM_CTX: '16384' })), 'qwen2.5:14b')).toMatchObject({ numCtx: 16384, window: 16384, reserve: 4096 });
    expect(chatBrain(new OllamaProvider(liveOllamaOptions({ OLLAMA_NUM_CTX: '32768' })), 'muse-glimmer:30b')).toMatchObject({ window: 32768 });
    // A table says qwen2.5 holds 32,768. The client asked Ollama for 4,096, so that is what it has.
    expect(new OllamaProvider(liveOllamaOptions({})).getCapabilities('qwen2.5:14b').maxContextTokens).toBe(32_768);
  });

  it('an `ollama:` tier’s window is the num_ctx its own client sends', () => {
    expect(chatBrain(envProviderFactory({})('ollama')!, 'qwen2.5:72b')).toMatchObject({ window: 8192, reserve: 2048 });
    expect(chatBrain(envProviderFactory({ FLINT_FRONTIER_NUM_CTX: '65536' })('ollama')!, 'qwen2.5:72b')).toMatchObject({ window: 65536, reserve: 8192 });
  });

  it('a client that sets no num_ctx falls back to its capability table; a value that is not a whole number of tokens is no num_ctx', () => {
    expect(new OllamaProvider().numCtx).toBeUndefined();
    expect(chatBrain(new OllamaProvider(), 'qwen2.5:14b')).toMatchObject({ window: 32_768, reserve: 8192 });
    expect(chatBrain(new OllamaProvider(), 'a-model-no-table-knows')).toMatchObject({ window: 4096, reserve: 1024 });
    for (const bad of [0, -4096, 4096.5, Number.NaN, '4096', null]) expect(new OllamaProvider({ defaultOptions: { num_ctx: bad } }).numCtx, String(bad)).toBeUndefined();
  });

  it('the reply’s share is what the model may write, and never more than a quarter of the window', () => {
    expect(chatBrain({ name: 'ollama', getCapabilities: () => ({ maxContextTokens: 8000, maxOutputTokens: 500 }) }, 'm')).toMatchObject({ window: 8000, reserve: 500 });
    expect(chatBrain({ name: 'ollama', getCapabilities: () => ({ maxContextTokens: 8000, maxOutputTokens: 6000 }) }, 'm')).toMatchObject({ window: 8000, reserve: 2000 });
  });

  it('an outside model’s window is its table’s (it only matters once Will sends goals out); a provider that says nothing has no known window', () => {
    const claude = chatBrain(new AnthropicProvider({ apiKey: 'test-key-not-real' }), 'claude-sonnet-4-6');
    expect(claude.window).toBeGreaterThan(100_000);
    expect(chatBrain({ name: 'ollama' }, 'm')).toEqual({ provider: 'ollama', model: 'm' });
  });
});

describe('promptRoom', () => {
  it('is the window, less the reply’s share, less the prompt at four characters a token, less the margin', () => {
    expect(GOALS_PROMPT_MARGIN).toBe(256);
    expect(promptRoom({ provider: 'ollama', model: 'm', window: 4096, reserve: 1024 }, 4000)).toBe(4096 - 1024 - 1000 - 256);
    expect(promptRoom({ provider: 'ollama', model: 'm', window: 4096, reserve: 1024 }, 4001)).toBe(4096 - 1024 - 1001 - 256);
    expect(promptRoom({ provider: 'ollama', model: 'm', window: 4096, reserve: 1024 }, 40_000)).toBeLessThan(0);
    expect(promptRoom({ provider: 'ollama', model: 'm', window: 16384, reserve: 4096 }, 40_000)).toBe(16384 - 4096 - 10_000 - 256);
  });

  it('is unbounded for a brain whose window is not known: only the 300-token limit holds it then', () => {
    expect(promptRoom({ provider: 'ollama', model: 'm' }, 1_000_000)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('the block fits the room it has', () => {
  type P = { name: string };
  const local: P = { name: 'local' };
  const three = answer([goal(1), goal(2), goal(3)]);
  const full = renderGoals(three);
  const fullTokens = estimateTokens(full);
  const make = (brain: ChatBrain, over: Record<string, unknown> = {}) =>
    new GoalsNow<P>({ runtime: () => RT, brainOf: () => brain, fetchImpl: (async () => new Response(JSON.stringify(three))) as unknown as typeof fetch, ...over });
  const small: ChatBrain = { provider: 'ollama', model: 'qwen2.5:14b', baseURL: HERE, numCtx: 4096, window: 4096, reserve: 1024 };
  const large: ChatBrain = { provider: 'ollama', model: 'qwen2.5:14b', baseURL: HERE, numCtx: 16384, window: 16384, reserve: 4096 };
  /** The characters of prompt that leave exactly `room` tokens in the small brain's context. */
  const charsFor = (room: number, brain: ChatBrain = small) => (brain.window! - brain.reserve! - GOALS_PROMPT_MARGIN - room) * 4;

  it('with room to spare, the whole block', async () => {
    const asked = (await make(small).forTurn()).ask(local, { context: 'ctx', promptChars: charsFor(fullTokens + 4) });
    expect(asked.context).toBe(`ctx\n\n${full}`);
    expect(asked.tokens).toBe(fullTokens);
    expect(asked.mark).toEqual({ context: GOALS_TURN });
  });

  it('with less room than the block, a shorter block: whole lines, the goals left out counted, never more than the room', async () => {
    const one = renderGoals(three, estimateTokens(renderGoals(answer([goal(1)], 2))));
    expect(one.split('\n')).toHaveLength(3);
    expect(one).toContain('- (2 more not shown)');
    const room = estimateTokens(one) + 3; // room for one goal and the count, not for two goals
    const asked = (await make(small).forTurn()).ask(local, { context: '', promptChars: charsFor(room) });
    expect(asked.context).toBe(one);
    expect(asked.tokens).toBe(estimateTokens(one));
    expect(asked.tokens).toBeLessThanOrEqual(room);
    expect(asked.tokens).toBeLessThan(fullTokens);
    expect(asked.context).toContain(`“${CANARY} goal 1”`);
    expect(asked.context).not.toContain(`“${CANARY} goal 2”`);
    expect(asked.mark).toEqual({ context: GOALS_TURN });
  });

  it('with no room for even one goal, no block: the ask is an ordinary one, with every tool and no mark', async () => {
    const tool = (name: string): Tool => ({ definition: { name, description: '', inputSchema: { type: 'object' }, idempotent: true }, handler: async () => '' });
    const offered = [tool('web.web_search'), tool('trident.perplexity_search')];
    const g = make(small, { tools: withoutOutsideAi({ specs: paidToolSpecs({}) }) });
    const turn = await g.forTurn();
    for (const room of [20, 0, -500]) {
      const asked = turn.ask(local, { context: 'ctx', tools: offered, promptChars: charsFor(room) });
      expect(asked, String(room)).toEqual({ context: 'ctx', tools: offered, tokens: 0, mark: {} });
    }
    // With room, the same ask carries the goals, and so only the tools that keep them here.
    const fits = turn.ask(local, { context: 'ctx', tools: offered, promptChars: 0 });
    expect(fits.tokens).toBe(fullTokens);
    expect(fits.tools.map((t) => t.definition.name)).toEqual(['web.web_search']);
  });

  it('whatever the prompt’s size, the block is never larger than the room, and never over 300 tokens', async () => {
    const turn = await make(small).forTurn();
    const sizes = new Set<number>();
    for (let chars = 0; chars <= 14_000; chars += 250) {
      const asked = turn.ask(local, { context: '', promptChars: chars });
      const room = promptRoom(small, chars);
      expect(asked.tokens, String(chars)).toBeLessThanOrEqual(Math.max(0, Math.min(GOALS_NOW_MAX_TOKENS, room)));
      expect(asked.tokens, String(chars)).toBe(asked.context ? estimateTokens(asked.context) : 0);
      sizes.add(asked.tokens);
    }
    // It went from whole, through shorter, to none.
    expect(sizes.has(fullTokens)).toBe(true);
    expect(sizes.has(0)).toBe(true);
    expect(sizes.size).toBeGreaterThan(2);
  });

  it('the real num_ctx decides: the prompt that leaves no room in 4,096 tokens leaves plenty in 16,384', async () => {
    const promptChars = 12_000; // about 3,000 tokens of persona, tools, history and message
    expect((await make(small).forTurn()).ask(local, { context: '', promptChars }).tokens).toBe(0);
    expect((await make(large).forTurn()).ask(local, { context: '', promptChars }).tokens).toBe(fullTokens);
  });

  it('the context and the tools’ schemas are part of the prompt it is fitted to', async () => {
    const turn = await make(small).forTurn();
    const base = charsFor(fullTokens + 4);
    expect(turn.ask(local, { context: '', promptChars: base }).tokens).toBe(fullTokens);
    // The same prompt with a long context, or with a large tool schema, no longer has room for all of it.
    expect(turn.ask(local, { context: 'x'.repeat(800), promptChars: base }).tokens).toBeLessThan(fullTokens);
    const big: Tool = { definition: { name: 'big.tool', description: 'd'.repeat(800), inputSchema: { type: 'object' }, idempotent: true }, handler: async () => '' };
    expect(turn.ask(local, { context: '', tools: [big], promptChars: base }).tokens).toBeLessThan(fullTokens);
  });

  it('a brain whose window is not known gets the whole block, held only to 300 tokens', async () => {
    const asked = (await make({ provider: 'ollama', model: 'm', baseURL: HERE }).forTurn()).ask(local, { context: '', promptChars: 5_000_000 });
    expect(asked.tokens).toBe(fullTokens);
  });
});

describe('on the server in miniature: a local model with a 4,096-token context', () => {
  const claude = [{ name: 'anthropic', model: 'claude-opus-5-5', script: ['answer'] as Step[] }];
  /** A local model whose answers are long: each turn adds about 1,000 tokens of history. */
  const wordy = (numCtx: number) => ({ name: 'ollama', model: 'qwen2.5:14b', baseURL: HERE, numCtx, maxOutput: 8192, script: [{ say: 'A long answer. '.repeat(270) }] as Step[] });

  it('the block is there while the prompt has room, shorter as the conversation grows, and gone before the prompt would overflow', async () => {
    const s = server({ frontier: claude, local: wordy(4096), goals: answer([goal(1), goal(2), goal(3)]) });
    const sizes: number[] = [];
    for (let i = 0; i < 4; i++) sizes.push((await s.chat('local', `question ${i}`)).goalsTokens);
    // 4,096 less a 1,024-token reply less the margin is 2,816 tokens of prompt: two long turns fit beside the block, three do not.
    expect(sizes[0]).toBe(estimateTokens(renderGoals(answer([goal(1), goal(2), goal(3)]))));
    expect(sizes.at(-1)).toBe(0);
    expect([...sizes].sort((a, b) => b - a)).toEqual(sizes);
    for (const [i, req] of s.local.requests.entries()) {
      // What the model was really sent never exceeds its window: the system prompt, the history, the message and the reply's share.
      const sent = (req.system ?? '').length + req.messages.reduce((n, m) => n + m.content.length, 0);
      if (sizes[i]! > 0) expect(Math.ceil(sent / 4) + 1024, `turn ${i}`).toBeLessThanOrEqual(4096);
      expect((req.system ?? '').includes('Will’s goals'), `turn ${i}`).toBe(sizes[i]! > 0);
      expect(req.system, `turn ${i}`).toContain(GUIDE);
    }
    // The turn that went without the block is marked all the same: the local model read the marked turns before
    // it as history, so what it said may repeat them (the mark follows history).
    const marks = (await s.store.getTurns('c1')).map((t) => (t.context as { goals?: boolean } | undefined)?.goals === true);
    expect(marks).toEqual([true, true, true, true]);
  });

  it('the same conversation on a model with a 32,768-token context keeps the whole block on every turn', async () => {
    const s = server({ frontier: claude, local: wordy(32_768), goals: answer([goal(1), goal(2), goal(3)]) });
    const whole = estimateTokens(renderGoals(answer([goal(1), goal(2), goal(3)])));
    for (let i = 0; i < 4; i++) expect((await s.chat('local', `question ${i}`)).goalsTokens, `turn ${i}`).toBe(whole);
  });

  it('the boot log says the context each local brain really has', async () => {
    const s = server({ frontier: claude, local: wordy(4096) });
    await s.goalsChat.settled;
    expect(s.logs).toEqual(['[goals-now] on: Will\'s goals go into chat turns answered on this Mac (ollama:qwen2.5:14b, 4096-token context), never to anthropic:claude-opus-5-5']);
  });
});
