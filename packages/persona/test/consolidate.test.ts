import { describe, it, expect } from 'vitest';
import { Flint } from '@flint/core';
import type { ProviderAdapter, GenerateArgs, StreamEvent } from '@flint/core';
import { InMemoryLessonStore, consolidate } from '../src/index.js';

function fixedProvider(output: string): ProviderAdapter {
  return {
    name: 'fixed',
    getCapabilities: () => ({
      toolCalling: 'native',
      structuredOutput: 'native',
      streaming: 'full',
      maxContextTokens: 100_000,
      maxOutputTokens: 4096,
    }),
    estimateTokens: (m) => m.reduce((n, x) => n + x.content.length, 0),
    async generate() {
      return {
        message: { id: 'm', role: 'assistant' as const, content: output, timestamp: 0 },
        usage: { input: 1, output: 1 },
        reason: 'complete' as const,
      };
    },
    async *stream(_args: GenerateArgs): AsyncIterable<StreamEvent> {
      yield { type: 'text', delta: output };
      yield { type: 'done', reason: 'complete', usage: { input: 1, output: 1 } };
    },
  };
}

describe('InMemoryLessonStore.replace', () => {
  it('replaces the entire set', async () => {
    const store = new InMemoryLessonStore();
    await store.add([{ category: 'fact', text: 'a' }, { category: 'fact', text: 'b' }], 1);
    await store.replace([{ id: 'x', category: 'preference', text: 'only', createdAt: 5 }]);
    const all = await store.all();
    expect(all).toHaveLength(1);
    expect(all[0]?.text).toBe('only');
  });
});

describe('consolidate', () => {
  it('merges near-duplicate lessons into a canonical set', async () => {
    const store = new InMemoryLessonStore();
    await store.add(
      [
        { category: 'preference', text: 'Always use TypeScript strict mode.' },
        { category: 'preference', text: 'Enable TS strict mode globally.' },
        { category: 'fact', text: 'User reviews PRs in the morning.' },
      ],
      1,
    );

    // Model collapses the two strict-mode lessons into one.
    const flint = new Flint({
      provider: fixedProvider(
        '[{"category":"preference","text":"Always use TypeScript strict mode."},' +
          '{"category":"fact","text":"User reviews PRs in the morning."}]',
      ),
      defaultModel: 'm',
    });

    const res = await consolidate({ flint, lessonStore: store, now: 2 });
    expect(res.before).toBe(3);
    expect(res.after).toBe(2);
    expect(res.changed).toBe(true);
    const texts = (await store.all()).map((l) => l.text);
    expect(texts).toContain('Always use TypeScript strict mode.');
    expect(texts).not.toContain('Enable TS strict mode globally.');
  });

  it('preserves id/createdAt for unchanged lessons', async () => {
    const store = new InMemoryLessonStore();
    const [a] = await store.add([{ category: 'fact', text: 'keep me' }], 1);
    await store.add([{ category: 'fact', text: 'dup one' }, { category: 'fact', text: 'dup two' }], 1);

    const flint = new Flint({
      provider: fixedProvider('[{"category":"fact","text":"keep me"},{"category":"fact","text":"merged dup"}]'),
      defaultModel: 'm',
    });
    await consolidate({ flint, lessonStore: store, now: 99 });

    const all = await store.all();
    const kept = all.find((l) => l.text === 'keep me');
    expect(kept?.id).toBe(a!.id); // same identity, not re-minted
    expect(kept?.createdAt).toBe(1);
  });

  it('is a no-op below the threshold', async () => {
    const store = new InMemoryLessonStore();
    await store.add([{ category: 'fact', text: 'only one' }], 1);
    const flint = new Flint({ provider: fixedProvider('SHOULD NOT BE CALLED'), defaultModel: 'm' });
    const res = await consolidate({ flint, lessonStore: store, now: 2 });
    expect(res.changed).toBe(false);
    expect(res.after).toBe(1);
  });

  it('never wipes the store on an unparseable response', async () => {
    const store = new InMemoryLessonStore();
    await store.add(
      [
        { category: 'fact', text: 'a' },
        { category: 'fact', text: 'b' },
        { category: 'fact', text: 'c' },
      ],
      1,
    );
    const flint = new Flint({ provider: fixedProvider('sorry, no JSON here'), defaultModel: 'm' });
    const res = await consolidate({ flint, lessonStore: store, now: 2 });
    expect(res.changed).toBe(false);
    expect((await store.all()).length).toBe(3);
  });
});
