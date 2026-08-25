import { describe, it, expect } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { toAiError } from '../../src/provider/anthropic/errors.js';

const sdk = await import('@anthropic-ai/sdk');

/** Builds a real SDK error of the given class, as the client would throw it. */
function apiError(Klass: new (...a: never[]) => Error, status: number, message: string): Error {
  return Object.assign(Object.create(Klass.prototype) as Error, {
    status,
    message,
    name: Klass.name,
  });
}

describe('anthropic error mapping', () => {
  it('names a rejected key instead of reporting an internal fault', () => {
    const err = apiError(Anthropic.AuthenticationError, 401, 'invalid x-api-key');

    const mapped = toAiError(err, sdk);

    expect(mapped.kind).toBe('validation');
    expect(mapped.retryable).toBe(false);
    expect(mapped.message).toMatch(/check the API key/);
  });

  it('treats a denied permission the same way', () => {
    const mapped = toAiError(apiError(Anthropic.PermissionDeniedError, 403, 'forbidden'), sdk);

    expect(mapped.kind).toBe('validation');
    expect(mapped.retryable).toBe(false);
  });

  it('calls out an unknown model rather than blaming the provider', () => {
    const mapped = toAiError(apiError(Anthropic.NotFoundError, 404, 'model not found'), sdk);

    expect(mapped.kind).toBe('validation');
    expect(mapped.message).toMatch(/unknown model/);
  });

  it('still treats a 500 as a retryable provider failure', () => {
    const mapped = toAiError(apiError(Anthropic.InternalServerError, 500, 'oops'), sdk);

    expect(mapped.kind).toBe('provider_unavailable');
    expect(mapped.retryable).toBe(true);
  });
});
