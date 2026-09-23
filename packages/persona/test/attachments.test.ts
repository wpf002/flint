import { describe, it, expect } from 'vitest';
import { Flint } from '@flint/core';
import type { ProviderAdapter, GenerateArgs, StreamEvent, Message, Attachment } from '@flint/core';
import { Persona } from '../src/index.js';

/** Records the messages each call received. */
class CapturingProvider implements ProviderAdapter {
  readonly name = 'capture';
  calls: Message[][] = [];
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
    this.calls.push(args.messages);
    return {
      message: { id: 'm', role: 'assistant' as const, content: 'ok', timestamp: 0 },
      usage: { input: 1, output: 1 },
      reason: 'complete' as const,
    };
  }
  async *stream(args: GenerateArgs): AsyncIterable<StreamEvent> {
    this.calls.push(args.messages);
    yield { type: 'text', delta: 'ok' };
    yield { type: 'done', reason: 'complete', usage: { input: 1, output: 1 } };
  }
}

const PNG: Attachment = { kind: 'image', mediaType: 'image/png', name: 'a.png', data: 'iVBORw0KGgo=' };

function setup() {
  const provider = new CapturingProvider();
  const persona = new Persona(new Flint({ provider, defaultModel: 'm' }), { name: 'T', styleGuide: 'S' });
  return { provider, persona };
}

describe('Persona attachments', () => {
  it('carries attachments on the user message in chat', async () => {
    const { provider, persona } = setup();
    for await (const _ of persona.chat({ conversationId: 'c', message: 'what is this', attachments: [PNG] })) {
      /* drain */
    }
    const last = provider.calls[0]!.at(-1)!;
    expect(last.role).toBe('user');
    expect(last.content).toBe('what is this');
    expect(last.attachments).toEqual([PNG]);
  });

  it('carries attachments on the prompt in generate', async () => {
    const { provider, persona } = setup();
    await persona.generate({ prompt: 'describe', attachments: [PNG] });
    const msgs = provider.calls[0]!;
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.attachments).toEqual([PNG]);
  });

  it('leaves a plain turn without an attachments field', async () => {
    const { provider, persona } = setup();
    for await (const _ of persona.chat({ conversationId: 'c', message: 'hi', attachments: [] })) {
      /* drain */
    }
    expect(provider.calls[0]!.at(-1)).not.toHaveProperty('attachments');
  });
});
