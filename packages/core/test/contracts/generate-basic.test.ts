import { describe, it, expect } from 'vitest';
import { providerFromCassette, generatedMessage } from './harness.js';

describe('contract: generate-basic', () => {
  it('returns a well-formed assistant Message with usage and a complete reason', async () => {
    const provider = providerFromCassette({
      kind: 'generate',
      response: generatedMessage({
        text: 'The capital of France is Paris.',
        stopReason: 'end_turn',
        inputTokens: 12,
        outputTokens: 8,
      }),
    });

    const result = await provider.generate({
      model: 'claude-sonnet-4-6',
      messages: [
        { id: 'u1', role: 'user', content: 'Capital of France?', timestamp: 0 },
      ],
    });

    expect(result.message.role).toBe('assistant');
    expect(result.message.content).toContain('Paris');
    expect(result.message.id).toBeTruthy();
    expect(result.usage).toEqual({ input: 12, output: 8 });
    expect(result.reason).toBe('complete');
  });
});
