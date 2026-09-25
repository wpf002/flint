import { describe, it, expect } from 'vitest';
import {
  providerFromCassette,
  messageStart,
  textBlockStart,
  textDelta,
  blockStop,
  messageDelta,
  messageStop,
} from './harness.js';
import AnthropicSDK from '@anthropic-ai/sdk';
import { Flint } from '../../src/index.js';
import type { ResponseEvent, StreamEvent } from '../../src/index.js';

describe('contract: stream-interruption', () => {
  it('aborting mid-stream yields an error and does NOT commit memory', async () => {
    const provider = providerFromCassette({
      kind: 'stream',
      events: [
        messageStart(10),
        textBlockStart(0),
        textDelta(0, 'Once upon'),
        textDelta(0, ' a time'),
        textDelta(0, ' there was'),
        blockStop(0),
        messageDelta('end_turn', 12),
        messageStop(),
      ],
    });

    const flint = new Flint({ provider, defaultModel: 'claude-sonnet-4-6' });
    const controller = new AbortController();

    const seen: StreamEvent[] = [];
    for await (const ev of flint.chat(
      { conversationId: 'c1', message: 'tell me a story' },
      { signal: controller.signal },
    )) {
      seen.push(ev);
      if (ev.type === 'text') controller.abort(); // abort after the first token
    }

    const terminal = seen[seen.length - 1];
    expect(terminal?.type).toBe('error');

    // Transactional guarantee: nothing committed to history.
    const history = await flint.store.getMessages('c1');
    expect(history).toHaveLength(0);

    const turns = await flint.store.getTurns('c1');
    expect(turns).toHaveLength(1);
    expect(turns[0]?.status).toBe('failed');
  });

  it('a stream cut off after it reached the model reports what was billed (input + output so far)', async () => {
    const provider = providerFromCassette({
      kind: 'stream',
      events: [
        messageStart(1_234),
        textBlockStart(0),
        textDelta(0, 'Once upon'), // 9 chars streamed before the abort
        textDelta(0, ' a time'),
        blockStop(0),
        messageDelta('end_turn', 12),
        messageStop(),
      ],
    });
    const responses: ResponseEvent[] = [];
    const flint = new Flint({ provider, defaultModel: 'claude-sonnet-4-6', observer: { onResponse: (e) => responses.push(e) } });
    const controller = new AbortController();
    const seen: StreamEvent[] = [];
    for await (const ev of flint.stream({ prompt: 'tell me a story' }, { signal: controller.signal })) {
      seen.push(ev);
      if (ev.type === 'text') controller.abort();
    }
    const terminal = seen[seen.length - 1];
    expect(terminal?.type).toBe('error');
    // The full input was billed; output is estimated from what streamed (no final count arrived).
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({ reason: 'aborted', model: 'claude-sonnet-4-6', usage: { input: 1_234, output: 3 } });
  });

  it('uses the final output count when it arrived before the stream failed', async () => {
    const provider = providerFromCassette({
      kind: 'stream',
      events: [messageStart(500), textBlockStart(0), textDelta(0, 'Hello'), blockStop(0), messageDelta('end_turn', 42), messageStop()],
      throwAfter: 5, // after message_delta, before message_stop
      makeError: () => new AnthropicSDK.APIConnectionError({ message: 'socket hang up' }),
    });
    const responses: ResponseEvent[] = [];
    const flint = new Flint({
      provider,
      defaultModel: 'claude-sonnet-4-6',
      observer: { onResponse: (e) => responses.push(e) },
      retryPolicy: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
    });
    await expect(flint.generate({ prompt: 'hi' })).rejects.toThrow();
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({ reason: 'error', usage: { input: 500, output: 42 } });
  });

  it('reports nothing for a request that failed before reaching the model (nothing was billed)', async () => {
    const provider = providerFromCassette({
      kind: 'error',
      on: 'stream',
      makeError: () => new AnthropicSDK.APIConnectionError({ message: 'connect ECONNREFUSED' }),
    });
    const responses: ResponseEvent[] = [];
    const flint = new Flint({
      provider,
      defaultModel: 'claude-sonnet-4-6',
      observer: { onResponse: (e) => responses.push(e) },
      retryPolicy: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
    });
    await expect(flint.generate({ prompt: 'hi' })).rejects.toThrow();
    expect(responses).toHaveLength(0);
  });
});
