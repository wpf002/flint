import { describe, expect, it } from 'vitest';
import type { Tool } from '@flint/core';
import { classifyMessage } from '@flint/core';
import { BOOT_EMBED_WAIT_MS, DEFAULT_TIER_TOOL_SCORE, EMBED_DEADLINE_MS, ToolRouter, parseTierToolScore, type Embedder } from '../src/router';

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

  // The final review's M3d: a small window sheds tools last listed first, and the matched ones are listed last.
  it('a tool matched to the message is marked to be kept: on a small window the core gives way before it', async () => {
    const { state, embedder } = fakeEmbedder();
    state.up = true;
    const router = await ToolRouter.build(tools, embedder, ['remember'], { maxAppend: 4, floor: 0.5 });
    const picked = await router.select('forecast please');
    expect(picked.map((t) => [t.definition.name, t.keep === true])).toEqual([['remember', false], ['prophet.forecast', true]]);
    // The core tool is the server's own object, untouched; the matched one is a copy with the same handler and definition.
    expect(picked[0]).toBe(tools[0]);
    const original = tools.find((t) => t.definition.name === 'prophet.forecast')!;
    expect(picked[1]!.definition).toBe(original.definition);
    expect(picked[1]!.handler).toBe(original.handler);
    expect(original.keep).toBeUndefined();
  });
});

// The server builds its router before it listens. An Ollama that took the embedding request and
// said nothing held the boot there for good: /health never answered, and the installer, which
// polls it, put the previous bundle back. The deploy must never fail because Ollama is slow.
describe('ToolRouter never holds the boot, or a turn, on a slow Ollama', () => {
  const tools = [tool('remember'), tool('prophet.forecast')];
  const vectors = (texts: string[]) => texts.map((t) => [t.includes('forecast') ? 1 : 0, t.includes('forecast') ? 0 : 1]);
  const names = (ts: Tool[]) => ts.map((t) => t.definition.name);
  /** Resolves to 'late' if `p` has not settled within `ms`. */
  const orLate = <T,>(p: Promise<T>, ms = 500) => Promise.race([p, new Promise<'late'>((r) => setTimeout(() => r('late'), ms))]);

  /** An Ollama whose first embedding request hangs until `answer()` (or for good); later ones answer at once. */
  function slowEmbedder() {
    const state = { calls: 0, answer: () => {} };
    const embedder: Embedder = {
      embed(texts) {
        if (++state.calls > 1) return Promise.resolve(vectors(texts));
        return new Promise((resolve) => {
          state.answer = () => resolve(vectors(texts));
        });
      },
    };
    return { state, embedder };
  }

  it('build() returns after its wait with the core, though Ollama has not answered', async () => {
    const { embedder } = slowEmbedder();
    const started = Date.now();
    const router = await orLate(ToolRouter.build(tools, embedder, ['remember'], { bootWaitMs: 30 }));
    if (router === 'late') throw new Error('build() waited for Ollama');
    expect(Date.now() - started).toBeLessThan(500);
    expect(router.appendsReady).toBe(false);
    expect(router.coreLength).toBe(1);
  });

  it('a message that arrives while the vectors are still being built gets the core at once', async () => {
    const { state, embedder } = slowEmbedder();
    const router = await ToolRouter.build(tools, embedder, ['remember'], { bootWaitMs: 20, floor: 0.5 });
    const picked = await orLate(router.select('forecast please'));
    if (picked === 'late') throw new Error('the turn waited for Ollama');
    expect(names(picked)).toEqual(['remember']);
    expect(state.calls).toBe(1); // it did not start a second pass beside the one in flight
  });

  it('appends go live when the slow answer lands, with no restart', async () => {
    const { state, embedder } = slowEmbedder();
    const router = await ToolRouter.build(tools, embedder, ['remember'], { bootWaitMs: 20, floor: 0.5 });
    expect(router.appendsReady).toBe(false);
    state.answer();
    await new Promise((r) => setTimeout(r, 0));
    expect(router.appendsReady).toBe(true);
    expect(names(await router.select('forecast please'))).toEqual(['remember', 'prophet.forecast']);
  });

  it('a pass that is never answered is given up by the clock, and the next one due is made', async () => {
    const { state, embedder } = slowEmbedder(); // the first request hangs for good
    let clock = 0;
    const router = await ToolRouter.build(tools, embedder, ['remember'], { bootWaitMs: 10, embedDeadlineMs: 40, retryMs: 60_000, floor: 0.5, now: () => clock });
    await new Promise((r) => setTimeout(r, 80)); // past the deadline: the hung pass is no longer in flight
    expect(router.appendsReady).toBe(false);
    expect(names(await router.select('forecast please'))).toEqual(['remember']); // not due yet
    expect(state.calls).toBe(1);
    clock += 60_000;
    expect(names(await router.select('forecast please'))).toEqual(['remember', 'prophet.forecast']);
    expect(router.appendsReady).toBe(true);
  });

  it('the real waits are short: a few seconds at boot, a minute for a pass', () => {
    expect(BOOT_EMBED_WAIT_MS).toBeLessThanOrEqual(5_000);
    expect(EMBED_DEADLINE_MS).toBeLessThanOrEqual(60_000);
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

