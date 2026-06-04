import Anthropic from '@anthropic-ai/sdk';
import { makeAiError, type AiError } from '../../types/error.js';

/**
 * Map an Anthropic SDK error (or any thrown value) onto the canonical AiError
 * taxonomy. This is the ONLY place vendor error shapes are interpreted.
 */
export function toAiError(err: unknown): AiError {
  // User-initiated abort surfaces as a timeout-class, non-retryable signal.
  if (err instanceof Anthropic.APIUserAbortError) {
    return makeAiError('timeout', 'Request aborted', {
      retryable: false,
      raw: err,
    });
  }

  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return makeAiError('timeout', err.message, { retryable: true, raw: err });
  }

  if (err instanceof Anthropic.RateLimitError) {
    return makeAiError('rate_limit', err.message, {
      retryable: true,
      providerCode: String(err.status),
      raw: err,
    });
  }

  if (err instanceof Anthropic.InternalServerError) {
    return makeAiError('provider_unavailable', err.message, {
      retryable: true,
      providerCode: String(err.status),
      raw: err,
    });
  }

  if (err instanceof Anthropic.APIConnectionError) {
    return makeAiError('provider_unavailable', err.message, {
      retryable: true,
      raw: err,
    });
  }

  if (
    err instanceof Anthropic.BadRequestError ||
    err instanceof Anthropic.UnprocessableEntityError
  ) {
    // 400/422 — often a context-window or schema problem. Distinguish overflow.
    const kind = /context|token|too long|too large/i.test(err.message)
      ? 'context_overflow'
      : 'validation';
    return makeAiError(kind, err.message, {
      retryable: false,
      providerCode: String(err.status),
      raw: err,
    });
  }

  if (err instanceof Anthropic.APIError) {
    const status = typeof err.status === 'number' ? err.status : undefined;
    const retryable = status !== undefined && status >= 500;
    return makeAiError(retryable ? 'provider_unavailable' : 'internal', err.message, {
      retryable,
      ...(status !== undefined ? { providerCode: String(status) } : {}),
      raw: err,
    });
  }

  const message = err instanceof Error ? err.message : String(err);
  return makeAiError('internal', message, { retryable: false, raw: err });
}
