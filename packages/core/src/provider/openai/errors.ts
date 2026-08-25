import { makeAiError, type AiError } from '../../types/error.js';

/** A non-2xx response from an OpenAI-compatible endpoint. */
export class OpenAiHttpError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'OpenAiHttpError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Map failures from an OpenAI-compatible endpoint onto the canonical taxonomy.
 * Classification is by status code plus the error `code` the API returns, which is
 * the only part of the body that is stable across OpenAI and its compatibles.
 */
export function toAiError(err: unknown, providerLabel: string): AiError {
  if (err instanceof DOMException && err.name === 'AbortError') {
    return makeAiError('timeout', 'Request aborted', { retryable: false, raw: err });
  }

  if (err instanceof OpenAiHttpError) {
    return fromStatus(err, providerLabel);
  }

  // fetch() connection failures (DNS, refused, offline) surface as TypeError.
  if (err instanceof TypeError) {
    return makeAiError('provider_unavailable', `Cannot reach ${providerLabel}: ${err.message}`, {
      retryable: true,
      raw: err,
    });
  }

  const message = err instanceof Error ? err.message : String(err);
  return makeAiError('internal', message, { retryable: false, raw: err });
}

function fromStatus(err: OpenAiHttpError, providerLabel: string): AiError {
  const { status, message, code } = err;
  const providerCode = code ?? String(status);
  const detail = `${providerLabel}: ${message}`;

  if (status === 429) {
    /*
     * 429 covers both "slow down" and "you are out of credit". Only the first is
     * worth retrying; retrying a spent quota just burns the backoff budget and
     * reports a timeout instead of the real problem.
     */
    const quota = code === 'insufficient_quota' || /quota|billing|credit/i.test(message);
    return makeAiError(quota ? 'validation' : 'rate_limit', detail, {
      retryable: !quota,
      providerCode,
      raw: err,
    });
  }

  if (status === 401 || status === 403) {
    return makeAiError('validation', `${detail} (check the API key)`, {
      retryable: false,
      providerCode,
      raw: err,
    });
  }

  if (status === 404) {
    return makeAiError('validation', `${detail} (unknown model or endpoint)`, {
      retryable: false,
      providerCode,
      raw: err,
    });
  }

  if (status === 408 || status === 504) {
    return makeAiError('timeout', detail, { retryable: true, providerCode, raw: err });
  }

  if (status >= 500) {
    return makeAiError('provider_unavailable', detail, { retryable: true, providerCode, raw: err });
  }

  if (code === 'context_length_exceeded' || /context length|maximum context|too many tokens/i.test(message)) {
    return makeAiError('context_overflow', detail, { retryable: false, providerCode, raw: err });
  }

  return makeAiError('validation', detail, { retryable: false, providerCode, raw: err });
}
