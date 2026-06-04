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
import { Flint, isFlintError } from '../../src/index.js';
import type { Tool } from '../../src/index.js';

function toolCallProvider() {
  return providerFromCassette({
    kind: 'stream',
    events: [
      messageStart(20),
      toolUseBlockStart(0, 'toolu_1', 'do_thing'),
      inputJsonDelta(0, '{"x":1}'),
      blockStop(0),
      messageDelta('tool_use', 5),
      messageStop(),
    ],
  });
}

function failingTool(idempotent: boolean, counter: { n: number }): Tool {
  return {
    definition: {
      name: 'do_thing',
      description: 'does a thing',
      inputSchema: { type: 'object', properties: { x: { type: 'number' } } },
      idempotent,
    },
    handler: () => {
      counter.n++;
      throw new Error('tool blew up');
    },
  };
}

const fastRetry = { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 };

describe('contract: idempotency', () => {
  it('does NOT auto-retry a non-idempotent tool failure', async () => {
    const counter = { n: 0 };
    const flint = new Flint({
      provider: toolCallProvider(),
      defaultModel: 'claude-sonnet-4-6',
    });

    await expect(
      flint.generate(
        { prompt: 'do the thing', tools: [failingTool(false, counter)] },
        { retryPolicy: fastRetry },
      ),
    ).rejects.toSatisfy((e: unknown) => isFlintError(e));

    expect(counter.n).toBe(1); // executed exactly once, never retried
  });

  it('DOES retry an idempotent tool failure up to the policy', async () => {
    const counter = { n: 0 };
    const flint = new Flint({
      provider: toolCallProvider(),
      defaultModel: 'claude-sonnet-4-6',
    });

    await expect(
      flint.generate(
        { prompt: 'do the thing', tools: [failingTool(true, counter)] },
        { retryPolicy: fastRetry },
      ),
    ).rejects.toSatisfy((e: unknown) => isFlintError(e));

    expect(counter.n).toBe(3); // retried up to maxAttempts
  });
});
