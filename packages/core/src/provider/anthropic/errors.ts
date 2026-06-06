import { makeAiError, type AiError } from '../../types/error.js';

/** The Anthropic SDK module namespace (passed in, never imported at load). */
type AnthropicModule = typeof import('@anthropic-ai/sdk');

/**
 * Map an Anthropic SDK error (or any thrown value) onto the canonical AiError
 * taxonomy. This is the ONLY place vendor error shapes are interpreted.
 *
 * The SDK namespace is passed in rather than imported at module load, so the
 * Anthropic SDK is only ever resolved when an app actually uses the Anthropic
 * provider (it is an OPTIONAL peer dependency). `sdk` is undefined only if the
 * SDK failed to load at all — in which case we fall back to generic mapping.
 */
export function toAiError(err: unknown, sdk?: AnthropicModule): AiError {
  if (sdk) {
    if (err instanceof sdk.APIUserAbortError) {
      return makeAiError('timeout', 'Request aborted', { retryable: false, raw: err });
    }
    if (err instanceof sdk.APIConnectionTimeoutError) {
      return makeAiError('timeout', err.message, { retryable: true, raw: err });
    }
    if (err instanceof sdk.RateLimitError) {
      return makeAiError('rate_limit', err.message, {
        retryable: true,
        providerCode: String(err.status),
        raw: err,
      });
    }
    if (err instanceof sdk.InternalServerError) {
      return makeAiError('provider_unavailable', err.message, {
        retryable: true,
        providerCode: String(err.status),
        raw: err,
      });
    }
    if (err instanceof sdk.APIConnectionError) {
      return makeAiError('provider_unavailable', err.message, {
        retryable: true,
        raw: err,
      });
    }
    if (err instanceof sdk.BadRequestError || err instanceof sdk.UnprocessableEntityError) {
      const kind = /context|token|too long|too large/i.test(err.message)
        ? 'context_overflow'
        : 'validation';
      return makeAiError(kind, err.message, {
        retryable: false,
        providerCode: String(err.status),
        raw: err,
      });
    }
    if (err instanceof sdk.APIError) {
      const status = typeof err.status === 'number' ? err.status : undefined;
      const retryable = status !== undefined && status >= 500;
      return makeAiError(retryable ? 'provider_unavailable' : 'internal', err.message, {
        retryable,
        ...(status !== undefined ? { providerCode: String(status) } : {}),
        raw: err,
      });
    }
  }

  const message = err instanceof Error ? err.message : String(err);
  return makeAiError('internal', message, { retryable: false, raw: err });
}
