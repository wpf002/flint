/**
 * Strip credentials out of anything headed for a log, the audit trail or the
 * spool. The rule is "no secrets in logs": an audit entry is reviewable by
 * design, so it must never be the place a token leaks.
 *
 * Two layers. Keys that name a credential (`token`, `apiKey`, `authorization`,
 * `password`, ...) have their value replaced whatever it looks like. Values that
 * LOOK like a credential (vendor key prefixes, `Bearer ...`, a password inside a
 * connection URL) are replaced wherever they sit, so a key pasted into free text
 * is caught too. Callers can also pass the exact secrets they hold (FLINT_TOKEN,
 * the scoped tokens) to be replaced verbatim.
 *
 * Hex digests are NOT treated as secrets: audit inputs carry sha256 hashes on
 * purpose, and Flint's tokens are matched by value instead.
 */

export const REDACTED = '[redacted]';

/** Words that make a key name a credential: `token`, `accessToken`, `api_key`, `X-Api-Key`, `clientSecret`. */
const SECRET_WORDS = new Set([
  'token', 'tokens', 'secret', 'secrets', 'password', 'passwords', 'passwd', 'pwd', 'passphrase',
  'apikey', 'auth', 'authorization', 'cookie', 'cookies', 'credential', 'credentials', 'signature', 'privatekey',
]);
/** Two-word credentials: `api_key`, `privateKey`, `accessKey`, `session_id`. */
const SECRET_PAIRS = new Set(['api key', 'private key', 'access key', 'secret key', 'session id', 'client secret']);

/**
 * Whether a key names a credential. Its STRING value is replaced whatever it
 * looks like; a number under the same key (`inputTokens: 1200`) is a count, not
 * a credential, and is kept.
 */
export function isSecretKey(key: string): boolean {
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (words.some((w) => SECRET_WORDS.has(w))) return true;
  return words.some((w, i) => i > 0 && SECRET_PAIRS.has(`${words[i - 1]} ${w}`));
}

/** Credential shapes, replaced inside any string. */
const SECRET_VALUE: ReadonlyArray<[RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, `Bearer ${REDACTED}`],
  [/\b(?:sk|pk|rk)-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, REDACTED],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, REDACTED],
  [/\btvly-[A-Za-z0-9_-]{10,}/g, REDACTED],
  [/\bpplx-[A-Za-z0-9]{16,}/g, REDACTED],
  // user:password@ in a connection URL keeps the user and drops the password.
  [/\b([a-z][a-z0-9+.-]*:\/\/[^:/?#\s@]+):[^@/?#\s]+@/gi, `$1:${REDACTED}@`],
];

export interface RedactOptions {
  /** Exact secret strings this process holds; each is replaced wherever it appears. Short ones (< 8 chars) are ignored. */
  secrets?: readonly string[];
  /** Deeper than this is replaced by a marker. Default 12. */
  maxDepth?: number;
}

/** A string with every credential shape (and every listed secret) replaced. */
export function redactString(s: string, secrets: readonly string[] = []): string {
  let out = s;
  for (const secret of secrets) {
    if (secret && secret.length >= 8) out = out.split(secret).join(REDACTED);
  }
  for (const [re, rep] of SECRET_VALUE) out = out.replace(re, rep);
  return out;
}

/**
 * A redacted deep copy of `value`. Never mutates its input. Cycles and over-deep
 * nesting become markers instead of throwing: a redactor that throws would take
 * the log line, and whatever it was recording, down with it.
 */
export function redact<T>(value: T, opts: RedactOptions = {}): T {
  const secrets = opts.secrets ?? [];
  const maxDepth = opts.maxDepth ?? 12;
  const seen = new WeakSet<object>();
  const go = (v: unknown, depth: number): unknown => {
    if (typeof v === 'string') return redactString(v, secrets);
    if (v === null || typeof v !== 'object') return v;
    if (depth >= maxDepth) return '[too deep]';
    if (seen.has(v)) return '[circular]';
    seen.add(v);
    try {
      if (Array.isArray(v)) return v.map((x) => go(x, depth + 1));
      if (v instanceof Date) return v.toISOString();
      if (v instanceof Uint8Array) return `[${v.byteLength} bytes]`;
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        const credential = isSecretKey(k) && ((typeof x === 'string' && x !== '') || x instanceof Uint8Array);
        out[k] = credential ? REDACTED : go(x, depth + 1);
      }
      return out;
    } finally {
      seen.delete(v);
    }
  };
  return go(value, 0) as T;
}
