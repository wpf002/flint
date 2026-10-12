/**
 * Errors, as the server log may carry them.
 *
 * A provider's error message is the provider's words, and its `raw` is the
 * whole response. An Ollama error body echoes model output; an
 * OpenAI-compatible message can quote values from the request. The server log
 * is no place for either. So what is logged of an error is its class: the
 * AiError kind, the provider's code when it is a status or a short identifier,
 * and the breaker's reason code (errorSummary). Never the message, never `raw`.
 * An error that is not a provider's is its name and where it was thrown. A
 * string the caller wrote itself is logged as written.
 *
 * FLINT_DEBUG_ERRORS=1 puts the whole error back (message, stack, raw), for as
 * long as it takes to see what a provider is really saying. Off by default.
 */
import { isFlintError } from '@flint/core';
import { breakerReason } from './frontier-breaker';

/** An error's class, never its words: the AiError kind, `timeout`, or the error's name. */
export function errorClass(err: unknown): string {
  const kind = (err as { error?: { kind?: unknown } } | null)?.error?.kind;
  if (typeof kind === 'string' && /^[a-z_]{1,40}$/.test(kind)) return kind;
  if (err instanceof Error && err.name === 'TimeoutError') return 'timeout';
  return err instanceof Error && /^[A-Za-z]{1,40}$/.test(err.name) ? err.name : 'error';
}

/**
 * One error in a few code words: `validation 400 credit`, `provider_unavailable
 * 529 transient`, `timeout`, `NoAnswer refusal`, `TypeError`, `Error ENOENT`,
 * `SyntaxError`. The provider's code is kept only when it looks like one (a
 * status, `insufficient_quota`). A SyntaxError from JSON.parse quotes what it
 * was parsing, a file error names a path, a database error can quote a row:
 * none of that is in here.
 */
export function errorSummary(err: unknown): string {
  const parts = [errorClass(err)];
  if (isFlintError(err)) {
    const code = err.error.providerCode;
    if (code !== undefined && /^[A-Za-z0-9_]{1,40}$/.test(code)) parts.push(code);
    const reason = breakerReason(err.error);
    if (reason) parts.push(reason);
  } else {
    const e = (typeof err === 'object' && err !== null ? err : {}) as { why?: unknown; code?: unknown; status?: unknown };
    // What Node says went wrong with a file or a socket (ENOENT, EACCES, ECONNREFUSED): a code, never a path.
    if (typeof e.code === 'string' && /^[A-Z][A-Z0-9_]{1,30}$/.test(e.code)) parts.push(e.code);
    // The HTTP status another service answered with (the runtime's RuntimeError).
    if (typeof e.status === 'number' && Number.isInteger(e.status) && e.status >= 100 && e.status <= 599) parts.push(String(e.status));
    // A reason code some of the server's own errors carry (NoAnswer.why): an enum, never text.
    if (typeof e.why === 'string' && /^[a-z_]{1,20}$/.test(e.why)) parts.push(e.why);
  }
  return parts.join(' ');
}

/** Is the whole error to be logged (FLINT_DEBUG_ERRORS=1)? */
export function debugErrors(env: Record<string, string | undefined> = process.env): boolean {
  return env.FLINT_DEBUG_ERRORS?.trim() === '1';
}

/** A stack frame as V8 writes one: `at fn (file:line:col)` or `at file:line:col`. */
const FRAME = /^\s+at (?:.* \()?[^()\s]+:\d+:\d+\)?$/;

/**
 * Where a non-provider error was thrown: its first stack frame, which holds a
 * function and a file, never the message. A stack is the error's name and
 * message, then the frames, and a message can run over several lines, one of
 * which may itself begin "    at ...". So frames are looked for only AFTER the
 * message. When the message cannot be found in the stack (it was changed after
 * the stack was written), there is no telling where the old one ends, and no
 * frame is logged at all.
 */
function thrownAt(err: unknown): string {
  if (!(err instanceof Error) || isFlintError(err) || typeof err.stack !== 'string') return '';
  const at = err.stack.indexOf(err.message);
  if (at < 0) return '';
  const frame = err.stack.slice(at + err.message.length).split('\n').find((l) => FRAME.test(l));
  return frame ? ` ${frame.trim().slice(0, 200)}` : '';
}

/**
 * Log one error after `prefix`: its summary (and, for an error of the server's
 * own, where it was thrown); a string as it is; the whole error only when
 * FLINT_DEBUG_ERRORS=1.
 */
export function logError(
  prefix: string,
  err: unknown,
  opts: { log?: (...args: unknown[]) => void; env?: Record<string, string | undefined> } = {},
): void {
  const log = opts.log ?? console.error;
  if (debugErrors(opts.env)) log(prefix, err);
  else if (typeof err === 'string') log(`${prefix} ${err}`);
  else log(`${prefix} ${errorSummary(err)}${thrownAt(err)}`);
}
