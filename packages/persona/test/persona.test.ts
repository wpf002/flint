import { describe, it, expect } from 'vitest';
import { Flint } from '@flint/core';
import type { ProviderAdapter, GenerateArgs, StreamEvent } from '@flint/core';
import { Persona, InMemoryRetriever } from '../src/index.js';

/** A provider that records the system prompt it received and echoes it back. */
class CapturingProvider implements ProviderAdapter {
  readonly name = 'capture';
  lastSystem: string | undefined;
  getCapabilities() {
    return {
      toolCalling: 'native',
      structuredOutput: 'native',
      streaming: 'full',
      maxContextTokens: 100_000,
      maxOutputTokens: 4096,
    } as const;
  }
  estimateTokens(messages: { content: string }[]) {
    return messages.reduce((n, m) => n + m.content.length, 0);
  }
  async generate(args: GenerateArgs) {
    this.lastSystem = args.system;
    return {
      message: { id: 'm', role: 'assistant' as const, content: 'ok', timestamp: 0 },
      usage: { input: 1, output: 1 },
      reason: 'complete' as const,
    };
  }
  async *stream(args: GenerateArgs): AsyncIterable<StreamEvent> {
    this.lastSystem = args.system;
    yield { type: 'text', delta: 'ok' };
    yield { type: 'done', reason: 'complete', usage: { input: 1, output: 1 } };
  }
}

function setup(retriever?: InMemoryRetriever) {
  const provider = new CapturingProvider();
  const flint = new Flint({ provider, defaultModel: 'm' });
  const persona = new Persona(flint, {
    name: 'Test',
    styleGuide: 'STYLE_GUIDE_MARKER: write tersely.',
    ...(retriever ? { retriever, retrieveK: 2 } : {}),
  });
  return { provider, persona };
}

describe('Persona', () => {
  it('injects the style guide as the system prompt (generate)', async () => {
    const { provider, persona } = setup();
    await persona.generate({ prompt: 'hello' });
    expect(provider.lastSystem).toContain('STYLE_GUIDE_MARKER');
  });

  it('retrieves the user\'s relevant writing into the system prompt', async () => {
    const retriever = new InMemoryRetriever([
      { id: '1', text: 'I always sign off my emails with "cheers, Will".' },
      { id: '2', text: 'A note about gardening tomatoes in spring.' },
    ]);
    const { provider, persona } = setup(retriever);

    await persona.generate({ prompt: 'help me write an email sign off' });

    expect(provider.lastSystem).toContain('STYLE_GUIDE_MARKER');
    // The email sample is relevant; the gardening one is not.
    expect(provider.lastSystem).toContain('cheers, Will');
    expect(provider.lastSystem).not.toContain('gardening');
  });

  it('streams through chat with the persona system prompt applied', async () => {
    const { provider, persona } = setup();
    let out = '';
    for await (const ev of persona.chat({ conversationId: 'c', message: 'hi' })) {
      if (ev.type === 'text') out += ev.delta;
    }
    expect(out).toBe('ok');
    expect(provider.lastSystem).toContain('STYLE_GUIDE_MARKER');
  });

  it('learn() adds samples the retriever can later surface', async () => {
    const retriever = new InMemoryRetriever();
    const { provider, persona } = setup(retriever);
    await persona.learn([{ id: '1', text: 'Signature phrase: onward and upward.' }]);
    await persona.generate({ prompt: 'what is my signature phrase' });
    expect(provider.lastSystem).toContain('onward and upward');
  });
});

describe('InMemoryRetriever', () => {
  it('ranks by keyword overlap', () => {
    const r = new InMemoryRetriever([
      { id: '1', text: 'tomatoes and basil in the garden' },
      { id: '2', text: 'quarterly revenue and finance report' },
    ]);
    const hits = r.retrieve('garden tomatoes', 1);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.id).toBe('1');
  });

  it('falls back to most-recent when the query has no signal', () => {
    const r = new InMemoryRetriever([
      { id: 'old', text: 'aaa', createdAt: 1 },
      { id: 'new', text: 'bbb', createdAt: 2 },
    ]);
    expect(r.retrieve('', 1)[0]?.id).toBe('new');
  });
});
