import { describe, it, expect } from 'vitest';
import { Flint } from '@flint/core';
import type { ProviderAdapter, GenerateArgs, StreamEvent } from '@flint/core';
import { Persona, InMemoryRetriever, FLINT_STYLE_GUIDE, FLINT_VOICE_EXEMPLARS } from '../src/index.js';

describe('FLINT_STYLE_GUIDE', () => {
  it('encodes the load-bearing rules', () => {
    expect(FLINT_STYLE_GUIDE).toMatch(/Answer first/i);
    expect(FLINT_STYLE_GUIDE).toMatch(/Disagree hard/i);
    expect(FLINT_STYLE_GUIDE).toMatch(/never bluff|fabricate/i);
  });

  it('lists the hard bans', () => {
    for (const banned of ['Great question', "It's important to note", 'In conclusion', 'game-changing']) {
      expect(FLINT_STYLE_GUIDE).toContain(banned);
    }
  });

  it('ships voice exemplars in the answer-first register', () => {
    expect(FLINT_VOICE_EXEMPLARS.length).toBeGreaterThanOrEqual(3);
    expect(FLINT_VOICE_EXEMPLARS[0]?.text).toMatch(/^Use SQS/);
  });
});

describe('Flint persona end to end', () => {
  it('injects the Flint identity + a relevant exemplar into the system prompt', async () => {
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

    const flint = new Flint({ provider, defaultModel: 'm' });
    const me = new Persona(flint, {
      name: 'Flint',
      styleGuide: FLINT_STYLE_GUIDE,
      retriever: new InMemoryRetriever(FLINT_VOICE_EXEMPLARS),
      retrieveK: 2,
    });

    await me.generate({ prompt: 'Kafka or SQS for a small app?' });

    expect(captured).toContain('You are Flint');
    expect(captured).toContain('Answer first');
    // The architecture exemplar is the relevant one for a Kafka/SQS query.
    expect(captured).toContain('Use SQS unless you have a reason not to');
  });
});
