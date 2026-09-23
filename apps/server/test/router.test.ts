import { describe, expect, it } from 'vitest';
import type { Tool } from '@flint/core';
import { ToolRouter, type Embedder } from '../src/router';

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
});
