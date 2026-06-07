import { describe, it, expect } from 'vitest';
import { Flint } from '@flint/core';
import type { ProviderAdapter, GenerateArgs, StreamEvent } from '@flint/core';
import { InMemoryLessonStore, reflect, Persona } from '../src/index.js';

/** A provider that always returns the same text (the model's reflection output). */
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

const convo = [
  { role: 'user', content: 'For small apps just use SQS, not Kafka.' },
  { role: 'assistant', content: 'Noted.' },
];

describe('InMemoryLessonStore', () => {
  it('dedupes by text', async () => {
    const store = new InMemoryLessonStore();
    await store.add([{ category: 'preference', text: 'Use SQS for small apps.' }], 1);
    await store.add([{ category: 'preference', text: 'use sqs for small apps.' }], 2);
    expect((await store.all()).length).toBe(1);
  });

  it('returns recent newest-first', async () => {
    const store = new InMemoryLessonStore();
    await store.add([{ category: 'fact', text: 'old' }], 1);
    await store.add([{ category: 'fact', text: 'new' }], 2);
    const recent = await store.recent(1);
    expect(recent[0]?.text).toBe('new');
  });
});

describe('reflect', () => {
  it('distills lessons from a transcript and persists them', async () => {
    const flint = new Flint({
      provider: fixedProvider(
        '[{"category":"preference","text":"Use SQS over Kafka for small apps."},' +
          '{"category":"fact","text":"User ships a provider-agnostic AI layer called Flint."}]',
      ),
      defaultModel: 'm',
    });
    const store = new InMemoryLessonStore();

    const res = await reflect({ flint, messages: convo, lessonStore: store, now: 1000 });

    expect(res.learned).toHaveLength(2);
    expect((await store.all()).map((l) => l.category)).toEqual(['preference', 'fact']);
  });

  it('is idempotent across nights (dedupe)', async () => {
    const output = '[{"category":"preference","text":"Lead with the answer."}]';
    const flint = new Flint({ provider: fixedProvider(output), defaultModel: 'm' });
    const store = new InMemoryLessonStore();

    const first = await reflect({ flint, messages: convo, lessonStore: store, now: 1 });
    const second = await reflect({ flint, messages: convo, lessonStore: store, now: 2 });

    expect(first.learned).toHaveLength(1);
    expect(second.learned).toHaveLength(0); // already learned
    expect((await store.all()).length).toBe(1);
  });

  it('handles fenced / messy JSON and empty results', async () => {
    const flint = new Flint({
      provider: fixedProvider('```json\n[]\n```'),
      defaultModel: 'm',
    });
    const store = new InMemoryLessonStore();
    const res = await reflect({ flint, messages: convo, lessonStore: store, now: 1 });
    expect(res.learned).toHaveLength(0);
  });

  it('does nothing on an empty transcript (no model call needed)', async () => {
    const flint = new Flint({ provider: fixedProvider('should not be used'), defaultModel: 'm' });
    const store = new InMemoryLessonStore();
    const res = await reflect({ flint, messages: [], lessonStore: store, now: 1 });
    expect(res.learned).toHaveLength(0);
  });
});

describe('Persona evolves from lessons', () => {
  it('injects recent lessons into the system prompt', async () => {
    let captured: string | undefined;
    const provider: ProviderAdapter = {
      name: 'capture',
      getCapabilities: () => ({
        toolCalling: 'native',
        structuredOutput: 'native',
        streaming: 'full',
        maxContextTokens: 100_000,
        maxOutputTokens: 4096,
      }),
      estimateTokens: (m) => m.reduce((n, x) => n + x.content.length, 0),
      async generate(args: GenerateArgs) {
        captured = args.system;
        return {
          message: { id: 'm', role: 'assistant' as const, content: 'ok', timestamp: 0 },
          usage: { input: 1, output: 1 },
          reason: 'complete' as const,
        };
      },
      async *stream(args: GenerateArgs): AsyncIterable<StreamEvent> {
        captured = args.system;
        yield { type: 'done', reason: 'complete', usage: { input: 0, output: 0 } };
      },
    };

    const store = new InMemoryLessonStore();
    await store.add([{ category: 'preference', text: 'Never use the word "robust".' }], 1);

    const flint = new Flint({ provider, defaultModel: 'm' });
    const me = new Persona(flint, { name: 'Flint', styleGuide: 'BASE', lessonStore: store });

    await me.generate({ prompt: 'hello' });

    expect(captured).toContain("What you've learned");
    expect(captured).toContain('Never use the word "robust"');
  });
});
