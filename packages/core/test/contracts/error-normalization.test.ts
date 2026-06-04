import { describe, it, expect } from 'vitest';
import AnthropicSDK from '@anthropic-ai/sdk';
import { providerFromCassette, generatedMessage } from './harness.js';
import { isFlintError } from '../../src/index.js';
import type { AiErrorKind } from '../../src/index.js';

async function kindFromGenerate(makeError: () => Error): Promise<AiErrorKind> {
  const provider = providerFromCassette({ kind: 'error', on: 'create', makeError });
  try {
    await provider.generate({
      model: 'claude-sonnet-4-6',
      messages: [{ id: 'u1', role: 'user', content: 'hi', timestamp: 0 }],
    });
    throw new Error('expected generate to throw');
  } catch (err) {
    if (!isFlintError(err)) throw err;
    return err.error.kind;
  }
}

describe('contract: error-normalization', () => {
  it('maps rate limit → rate_limit (retryable)', async () => {
    const provider = providerFromCassette({
      kind: 'error',
      on: 'create',
      makeError: () =>
        new AnthropicSDK.RateLimitError(429, {}, 'slow down', new Headers(), 'rate_limit_error'),
    });
    try {
      await provider.generate({
        model: 'claude-sonnet-4-6',
        messages: [{ id: 'u1', role: 'user', content: 'hi', timestamp: 0 }],
      });
    } catch (err) {
      if (!isFlintError(err)) throw err;
      expect(err.error.kind).toBe('rate_limit');
      expect(err.error.retryable).toBe(true);
      return;
    }
    throw new Error('expected throw');
  });

  it('maps connection timeout → timeout', async () => {
    expect(
      await kindFromGenerate(
        () => new AnthropicSDK.APIConnectionTimeoutError({ message: 'timed out' }),
      ),
    ).toBe('timeout');
  });

  it('maps 5xx → provider_unavailable', async () => {
    expect(
      await kindFromGenerate(
        () => new AnthropicSDK.InternalServerError(503, {}, 'unavailable', new Headers(), null),
      ),
    ).toBe('provider_unavailable');
  });

  it('maps a context-length 400 → context_overflow', async () => {
    expect(
      await kindFromGenerate(
        () =>
          new AnthropicSDK.BadRequestError(
            400,
            {
              type: 'invalid_request_error',
              message: 'prompt is too long: 250000 tokens > 200000 maximum',
            },
            undefined,
            new Headers(),
            'invalid_request_error',
          ),
      ),
    ).toBe('context_overflow');
  });

  it('maps a non-context 400 → validation', async () => {
    expect(
      await kindFromGenerate(
        () =>
          new AnthropicSDK.BadRequestError(
            400,
            { type: 'invalid_request_error', message: 'unknown field: foo' },
            undefined,
            new Headers(),
            'invalid_request_error',
          ),
      ),
    ).toBe('validation');
  });

  it('maps an unknown error → internal', async () => {
    expect(await kindFromGenerate(() => new Error('boom'))).toBe('internal');
  });

  it('a successful generate does not throw (sanity)', async () => {
    const provider = providerFromCassette({
      kind: 'generate',
      response: generatedMessage({
        text: 'ok',
        stopReason: 'end_turn',
        inputTokens: 1,
        outputTokens: 1,
      }),
    });
    const r = await provider.generate({
      model: 'claude-sonnet-4-6',
      messages: [{ id: 'u1', role: 'user', content: 'hi', timestamp: 0 }],
    });
    expect(r.message.content).toBe('ok');
  });
});
