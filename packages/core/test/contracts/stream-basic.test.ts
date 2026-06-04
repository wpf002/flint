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
import type { StreamEvent } from '../../src/index.js';

describe('contract: stream-basic', () => {
  it('yields text deltas then exactly one done event', async () => {
    const provider = providerFromCassette({
      kind: 'stream',
      events: [
        messageStart(10),
        textBlockStart(0),
        textDelta(0, 'Hello'),
        textDelta(0, ', world'),
        blockStop(0),
        messageDelta('end_turn', 4),
        messageStop(),
      ],
    });

    const events: StreamEvent[] = [];
    for await (const ev of provider.stream({
      model: 'claude-sonnet-4-6',
      messages: [{ id: 'u1', role: 'user', content: 'hi', timestamp: 0 }],
    })) {
      events.push(ev);
    }

    const text = events
      .filter((e): e is Extract<StreamEvent, { type: 'text' }> => e.type === 'text')
      .map((e) => e.delta)
      .join('');
    expect(text).toBe('Hello, world');

    const done = events.filter((e) => e.type === 'done');
    expect(done).toHaveLength(1);
    expect(events.filter((e) => e.type === 'error')).toHaveLength(0);

    const terminal = events[events.length - 1];
    expect(terminal?.type).toBe('done');
    if (terminal?.type === 'done') {
      expect(terminal.reason).toBe('complete');
      expect(terminal.usage).toEqual({ input: 10, output: 4 });
    }
  });
});
