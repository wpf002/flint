import { z } from 'zod';

/**
 * Normalized error taxonomy. Every provider maps its native errors onto one
 * of these kinds so app code can branch on `kind` without knowing the vendor.
 */
export const AiErrorKind = z.enum([
  'rate_limit',
  'timeout',
  'validation',
  'context_overflow',
  'provider_unavailable',
  'internal',
]);
export type AiErrorKind = z.infer<typeof AiErrorKind>;

export const AiErrorSchema = z.object({
  kind: AiErrorKind,
  message: z.string(),
  providerCode: z.string().optional(),
  retryable: z.boolean(),
  raw: z.unknown().optional(),
});

export type AiError = {
  kind: AiErrorKind;
  message: string;
  providerCode?: string;
  retryable: boolean;
  raw?: unknown;
};

/**
 * Throwable wrapper around the canonical AiError. Adapters and core throw this;
 * apps can `catch` it and inspect `.error.kind`. Carrying the structured error
 * on a real Error subclass keeps stack traces while preserving the taxonomy.
 */
export class FlintError extends Error {
  readonly error: AiError;

  constructor(error: AiError) {
    super(error.message);
    this.name = 'FlintError';
    this.error = error;
    // Preserve the original cause where available for debugging.
    if (error.raw instanceof Error) {
      this.cause = error.raw;
    }
  }

  get kind(): AiErrorKind {
    return this.error.kind;
  }

  get retryable(): boolean {
    return this.error.retryable;
  }
}

/** Build an AiError without throwing. */
export function makeAiError(
  kind: AiErrorKind,
  message: string,
  opts: { providerCode?: string; retryable?: boolean; raw?: unknown } = {},
): AiError {
  const err: AiError = {
    kind,
    message,
    retryable: opts.retryable ?? defaultRetryable(kind),
  };
  if (opts.providerCode !== undefined) err.providerCode = opts.providerCode;
  if (opts.raw !== undefined) err.raw = opts.raw;
  return err;
}

/** Sensible retryability default per kind; adapters may override explicitly. */
function defaultRetryable(kind: AiErrorKind): boolean {
  switch (kind) {
    case 'rate_limit':
    case 'timeout':
    case 'provider_unavailable':
      return true;
    case 'validation':
    case 'context_overflow':
    case 'internal':
      return false;
  }
}

/** Narrow an unknown thrown value to a FlintError if it is one. */
export function isFlintError(value: unknown): value is FlintError {
  return value instanceof FlintError;
}
