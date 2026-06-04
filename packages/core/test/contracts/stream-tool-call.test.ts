import { describe, it, expect } from 'vitest';
import {
  providerFromCassette,
  messageStart,
  toolUseBlockStart,
  inputJsonDelta,
  blockStop,
  messageDelta,
  messageStop,
} from './harness.js';
import type { StreamEvent } from '../../src/index.js';

describe('contract: stream-tool-call', () => {
  it('yields a tool_call event then done.reason === "tool_call"', async () => {
    const provider = providerFromCassette({
      kind: 'stream',
      events: [
        messageStart(20),
        toolUseBlockStart(0, 'toolu_1', 'get_weather'),
        inputJsonDelta(0, '{"city":'),
        inputJsonDelta(0, '"NYC"}'),
        blockStop(0),
        messageDelta('tool_use', 9),
        messageStop(),
      ],
    });

    const events: StreamEvent[] = [];
    for await (const ev of provider.stream({
      model: 'claude-sonnet-4-6',
      messages: [{ id: 'u1', role: 'user', content: 'weather in NYC?', timestamp: 0 }],
    })) {
      events.push(ev);
    }

    const toolCalls = events.filter(
      (e): e is Extract<StreamEvent, { type: 'tool_call' }> => e.type === 'tool_call',
    );
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]?.call.toolName).toBe('get_weather');
    expect(toolCalls[0]?.call.args).toEqual({ city: 'NYC' });

    const done = events.filter((e) => e.type === 'done');
    expect(done).toHaveLength(1);
    const terminal = events[events.length - 1];
    expect(terminal?.type).toBe('done');
    if (terminal?.type === 'done') {
      expect(terminal.reason).toBe('tool_call');
    }
  });
});
