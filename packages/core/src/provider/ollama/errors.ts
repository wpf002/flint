import { makeAiError, type AiError } from '../../types/error.js';

/**
 * Map Ollama HTTP/transport failures onto the canonical AiError taxonomy.
 * Ollama has no rich error classes (it's a plain HTTP API), so we classify by
 * status code and the shape of the thrown value.
 */
export function toAiError(err: unknown): AiError {
  // Abort surfaces as a non-retryable timeout-class signal.
  if (err instanceof DOMException && err.name === 'AbortError') {
    return makeAiError('timeout', 'Request aborted', { retryable: false, raw: err });
  }

  // Our own HTTP wrapper (below) carries a status code.
  if (err instanceof OllamaHttpError) {
    return fromStatus(err.status, err.message, err);
  }

  // fetch() connection failures (server down, refused, DNS) are TypeErrors.
  if (err instanceof TypeError) {
    return makeAiError('provider_unavailable', `Cannot reach Ollama: ${err.message}`, {
      retryable: true,
      raw: err,
    });
  }

  const message = err instanceof Error ? err.message : String(err);
  return makeAiError('internal', message, { retryable: false, raw: err });
}

function fromStatus(status: number, message: string, raw: unknown): AiError {
  if (status === 429) {
    return makeAiError('rate_limit', message, {
      retryable: true,
      providerCode: '429',
      raw,
    });
  }
  if (status === 404) {
    // Model not pulled / unknown endpoint — a configuration error, not transient.
    return makeAiError('validation', `Ollama: ${message}`, {
      retryable: false,
      providerCode: '404',
      raw,
    });
  }
  if (status >= 500) {
    return makeAiError('provider_unavailable', message, {
      retryable: true,
      providerCode: String(status),
      raw,
    });
  }
  if (status === 400 && /context|too (long|large)|num_ctx|exceed/i.test(message)) {
    return makeAiError('context_overflow', message, {
      retryable: false,
      providerCode: '400',
      raw,
    });
  }
  return makeAiError('validation', message, {
    retryable: false,
    providerCode: String(status),
    raw,
  });
}

/** A non-2xx HTTP response from the Ollama server. */
export class OllamaHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'OllamaHttpError';
    this.status = status;
  }
}
