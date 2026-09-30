import { describe, expect, it } from 'vitest';
import type { Tool } from '@flint/core';
import { classifyMessage } from '@flint/core';
import { DEFAULT_TIER_TOOL_SCORE, ToolRouter, parseTierToolScore, type Embedder } from '../src/router';

const tool = (name: string): Tool => ({
  definition: { name, description: name, inputSchema: { type: 'object', properties: {} } },
  handler: () => 'ok',
});

/** Embeds each text to a one-hot vector by keyword; can be switched off like ollama during a train. */
function fakeEmbedder() {
  const state = { up: false, calls: 0 };
  const embedder: Embedder = {
    async embed(texts) {
      state.calls++;
      if (!state.up) throw new TypeError('fetch failed');
      return texts.map((t) => [t.includes('forecast') ? 1 : 0, t.includes('forecast') ? 0 : 1]);
    },
  };
  return { state, embedder };
}

describe('ToolRouter', () => {
  const tools = [tool('remember'), tool('prophet.forecast')];

  it('recovers appends once the embedder comes back, without a restart', async () => {
    const { state, embedder } = fakeEmbedder();
    let clock = 0;
    const router = await ToolRouter.build(tools, embedder, ['remember'], { maxAppend: 4, floor: 0.5, retryMs: 60_000, now: () => clock });
    expect(router.appendsReady).toBe(false);
    expect((await router.select('forecast please')).map((t) => t.definition.name)).toEqual(['remember']);

    state.up = true;
    clock += 60_000;
    const picked = (await router.select('forecast please')).map((t) => t.definition.name);
    expect(router.appendsReady).toBe(true);
    expect(picked).toEqual(['remember', 'prophet.forecast']);
  });

  it('does not re-embed the tool list on every message while the embedder is down', async () => {
    const { state, embedder } = fakeEmbedder();
    let clock = 0;
    const router = await ToolRouter.build(tools, embedder, ['remember'], { retryMs: 60_000, now: () => clock });
    const afterBuild = state.calls;
    for (let i = 0; i < 5; i++) {
      clock += 1_000;
      await router.select('forecast');
    }
    expect(state.calls).toBe(afterBuild);
    clock += 60_000;
    await router.select('forecast');
    expect(state.calls).toBe(afterBuild + 1);
  });

  it('builds appends at startup when the embedder is up', async () => {
    const { state, embedder } = fakeEmbedder();
    state.up = true;
    const router = await ToolRouter.build(tools, embedder, ['remember']);
    expect(router.appendsReady).toBe(true);
    expect(router.coreLength).toBe(1);
  });

  // The route log records what was appended and how close it came to the floor.
  it('selectScored returns what select does, plus each append\'s score', async () => {
    const { state, embedder } = fakeEmbedder();
    state.up = true;
    const router = await ToolRouter.build(tools, embedder, ['remember'], { maxAppend: 4, floor: 0.5 });
    const scored = await router.selectScored('forecast please');
    expect(scored.tools.map((t) => t.definition.name)).toEqual((await router.select('forecast please')).map((t) => t.definition.name));
    expect(scored.appended).toEqual([{ name: 'prophet.forecast', score: 1 }]);
    expect(await router.selectScored('hello there')).toEqual({ tools: [tools[0]], appended: [] });
  });
});

// 2026-09-30, 504 real messages: tools just over the 0.55 append floor reached
// greetings and sent 5 of 12 routine one-liners to Opus; none used the tool.
describe('a tier move needs a confident tool match', () => {
  async function router(tierScore?: number) {
    const { state, embedder } = fakeEmbedder();
    state.up = true;
    return ToolRouter.build([tool('remember'), tool('prophet.forecast')], embedder, ['remember'], {
      maxAppend: 4,
      floor: 0.55,
      ...(tierScore !== undefined ? { tierScore } : {}),
    });
  }

  it('keeps a greeting routine when its only append is a near miss', async () => {
    const r = await router();
    const greeting = [{ name: 'spend_status', score: 0.602 }]; // measured: "How are you doing today Flint?"
    expect(r.toolsLikely(greeting)).toBe(false);
    expect(classifyMessage('How are you doing today Flint?', { toolsLikely: r.toolsLikely(greeting) })).toBe('routine');
  });

  it('moves a routine-shaped ask to standard on a clear match', async () => {
    const r = await router();
    const ask = [{ name: 'nexus.thread_list', score: 0.843 }]; // measured: a real Nexus ask
    expect(r.toolsLikely(ask)).toBe(true);
    expect(classifyMessage('ok, check nexus', { toolsLikely: r.toolsLikely(ask) })).toBe('standard');
  });

  it('counts a score exactly at the threshold, and nothing with no appends', async () => {
    const r = await router();
    expect(r.toolsLikely([{ score: DEFAULT_TIER_TOOL_SCORE }])).toBe(true);
    expect(r.toolsLikely([])).toBe(false);
  });

  it('takes the threshold from its option', async () => {
    const r = await router(0.6);
    expect(r.toolsLikely([{ score: 0.602 }])).toBe(true);
  });
});

describe('parseTierToolScore (FLINT_TIER_TOOL_SCORE)', () => {
  it('reads a score from 0 to 1', () => {
    expect(parseTierToolScore('0.7')).toBe(0.7);
    expect(parseTierToolScore(' 0 ')).toBe(0);
  });

  it('falls back to the default, and says so, on anything else', () => {
    const said: string[] = [];
    for (const bad of ['high', '1.5', '-0.1', 'NaN']) expect(parseTierToolScore(bad, (m) => said.push(m))).toBe(DEFAULT_TIER_TOOL_SCORE);
    expect(said).toHaveLength(4);
    expect(parseTierToolScore(undefined)).toBe(DEFAULT_TIER_TOOL_SCORE);
    expect(parseTierToolScore('')).toBe(DEFAULT_TIER_TOOL_SCORE);
  });
});

