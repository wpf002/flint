import { describe, it, expect } from 'vitest';
import AnthropicSDK from '@anthropic-ai/sdk';
import {
  providerFromCassette,
  messageStart,
  textBlockStart,
  textDelta,
  blockStop,
  messageDelta,
  messageStop,
} from './harness.js';
import { Flint } from '../../src/index.js';

function completingProvider() {
  return providerFromCassette({
    kind: 'stream',
    events: [
      messageStart(10),
      textBlockStart(0),
      textDelta(0, 'Hi there!'),
      blockStop(0),
      messageDelta('end_turn', 3),
      messageStop(),
    ],
  });
}

describe('contract: memory-transaction', () => {
  it('commits user + assistant together on a successful turn', async () => {
    const flint = new Flint({
      provider: completingProvider(),
      defaultModel: 'claude-sonnet-4-6',
    });

    for await (const _ of flint.chat({ conversationId: 'c1', message: 'hello' })) {
      // drain
    }

    const history = await flint.store.getMessages('c1');
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(history[0]?.content).toBe('hello');

    const turns = await flint.store.getTurns('c1');
    expect(turns).toHaveLength(1);
    expect(turns[0]?.status).toBe('complete');
  });

  it('a failed turn leaves no orphaned user message', async () => {
    const flint = new Flint({
      provider: providerFromCassette({
        kind: 'error',
        on: 'stream',
        // Non-retryable so the turn fails immediately.
        makeError: () =>
          new AnthropicSDK.BadRequestError(400, {}, 'invalid request', new Headers(), null),
      }),
      defaultModel: 'claude-sonnet-4-6',
    });

    let sawError = false;
    for await (const ev of flint.chat({ conversationId: 'c1', message: 'hello' })) {
      if (ev.type === 'error') sawError = true;
    }
    expect(sawError).toBe(true);

    // No orphaned user message in history.
    const history = await flint.store.getMessages('c1');
    expect(history).toHaveLength(0);

    const turns = await flint.store.getTurns('c1');
    expect(turns[0]?.status).toBe('failed');
  });
});
