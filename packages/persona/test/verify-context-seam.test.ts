import { describe, it, expect } from 'vitest';
import { Flint } from '@flint/core';
import type { ProviderAdapter, GenerateArgs, StreamEvent, Message } from '@flint/core';
import { Persona } from '../src/index.js';

class Capturing implements ProviderAdapter {
  readonly name = 'capture';
  lastSystem: string | undefined;
  lastMessages: Message[] = [];
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
    this.lastMessages = args.messages as Message[];
    return {
      message: { id: 'm', role: 'assistant' as const, content: 'ok', timestamp: 0 },
      usage: { input: 1, output: 1 },
      reason: 'complete' as const,
    };
  }
  async *stream(args: GenerateArgs): AsyncIterable<StreamEvent> {
    this.lastSystem = args.system;
    this.lastMessages = args.messages as Message[];
    yield { type: 'text', delta: 'ok' };
    yield { type: 'done', reason: 'complete', usage: { input: 1, output: 1 } };
  }
}

function setup() {
  const provider = new Capturing();
  const flint = new Flint({ provider, defaultModel: 'm' });
  const persona = new Persona(flint, { name: 'T', styleGuide: 'STYLE' });
  return { provider, persona, flint };
}

const CTX = '[Context — not a user message: Right now it is Wednesday, September 2, 2026.]';

describe('per-turn context seam', () => {
  it('chat: context reaches the system prompt and NOT the user message', async () => {
    const { provider, persona } = setup();
    for await (const _ of persona.chat({ conversationId: 'c', message: 'hi there', context: CTX })) {
      /* drain */
    }
    expect(provider.lastSystem).toContain(CTX);
    expect(provider.lastSystem).toContain('STYLE');
    const user = provider.lastMessages.filter((m) => m.role === 'user');
    expect(user).toHaveLength(1);
    expect(user[0]!.content).toBe('hi there');
    expect(user[0]!.content).not.toContain('Context');
  });

  it('generate: context reaches the system prompt and NOT the prompt', async () => {
    const { provider, persona } = setup();
    await persona.generate({ prompt: 'hi there', context: CTX });
    expect(provider.lastSystem).toContain(CTX);
    const user = provider.lastMessages.filter((m) => m.role === 'user');
    expect(user[0]!.content).toBe('hi there');
  });

  it('turn 2 does NOT replay turn 1 context — fresh context only', async () => {
    const { provider, persona } = setup();
    const day1 = '[Context: Right now it is Tuesday, September 1, 2026.]';
    const day2 = '[Context: Right now it is Wednesday, September 2, 2026.]';
    for await (const _ of persona.chat({ conversationId: 'c', message: 'first', context: day1 })) {
      /* drain */
    }
    for await (const _ of persona.chat({ conversationId: 'c', message: 'second', context: day2 })) {
      /* drain */
    }
    // The stale day-1 context must appear NOWHERE in turn 2's replayed history.
    const replayed = provider.lastMessages.map((m) => m.content).join('\n');
    expect(replayed).not.toContain('September 1');
    expect(replayed).toContain('first'); // history itself is preserved
    expect(provider.lastSystem).toContain('September 2');
    expect(provider.lastSystem).not.toContain('September 1');
  });

  it('omitting context leaves the system prompt untouched (no stray blank block)', async () => {
    const { provider, persona } = setup();
    await persona.generate({ prompt: 'hi' });
    expect(provider.lastSystem).toBe('STYLE');
    const { provider: p2, persona: pe2 } = setup();
    await pe2.generate({ prompt: 'hi', context: '   ' });
    expect(p2.lastSystem).toBe('STYLE');
  });
});
