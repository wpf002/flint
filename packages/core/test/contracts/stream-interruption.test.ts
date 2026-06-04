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
import { Flint } from '../../src/index.js';
import type { StreamEvent } from '../../src/index.js';

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
});
