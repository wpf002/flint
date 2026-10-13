import { makeAiError, type AiError } from '../types/error.js';

/**
 * Hard deadlines for a local model server, shared by the adapters that talk to
 * one (the OpenAI-compatible wire, native Ollama).
 *
 * A cold or overloaded local model does not fail: it sits there. A turn must
 * never wait on it, so an adapter may be given deadlines of its own:
 *  - first token: from sending a call to the first sign of output;
 *  - idle: between one piece of a streamed reply and the next, once it has
 *    begun (a model that starts and then goes quiet);
 *  - request: for a whole reply.
 * All are off unless the caller sets them, and a call made without them is
 * exactly the call it was before they existed.
 */

/**
 * A deadline in ms. A function is read on every call, so a server can turn a
 * deadline on and off (by its routing mode, say) without rebuilding its client;
 * it returns undefined for "no deadline on this call".
 */
export type DeadlineMs = number | (() => number | undefined);

/** The deadline for one call: a positive whole number of ms, or undefined for none. */
export function readDeadline(ms: DeadlineMs | undefined): number | undefined {
  const v = typeof ms === 'function' ? ms() : ms;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined;
}

/** Our own deadline fired; never a caller's cancellation. */
export class DeadlineError extends Error {
  constructor(
    readonly deadline: DeadlineKind,
    readonly ms: number,
  ) {
    super(deadline === 'first_token' ? `no first token in ${ms} ms` : deadline === 'idle' ? `nothing more in ${ms} ms` : `no reply in ${ms} ms`);
    this.name = 'DeadlineError';
  }
}

export type DeadlineKind = 'first_token' | 'idle' | 'request';

/** `providerCode` of a first-token deadline: what a caller matches on to try another model. */
export const FIRST_TOKEN_TIMEOUT = 'first_token_timeout';
/** `providerCode` of a whole-reply deadline. */
export const REQUEST_TIMEOUT = 'request_timeout';
/** `providerCode` of a reply that began and then went quiet. */
export const IDLE_TIMEOUT = 'idle_timeout';

/**
 * A fired deadline as a canonical error.
 *
 * Not retryable, on purpose: the tool loop retries a retryable failure three
 * times, which would turn a 20 second deadline into a minute of waiting. The
 * caller's next step is another model, not the same one again.
 *
 * The message never says "abort": a non-retryable timeout whose message does is
 * read as the user hanging up, and nothing falls back from that.
 */
export function deadlineAiError(err: DeadlineError, providerLabel: string): AiError {
  const message =
    err.deadline === 'first_token'
      ? `${providerLabel} sent no first token in ${err.ms} ms`
      : err.deadline === 'idle'
        ? `${providerLabel} went quiet for ${err.ms} ms in the middle of a reply`
        : `${providerLabel} did not answer in ${err.ms} ms`;
  return makeAiError('timeout', message, {
    retryable: false,
    providerCode: err.deadline === 'first_token' ? FIRST_TOKEN_TIMEOUT : err.deadline === 'idle' ? IDLE_TIMEOUT : REQUEST_TIMEOUT,
    raw: err,
  });
}

/** A `redirect: 'error'` fetch that was answered with a redirect (undici: TypeError, cause "unexpected redirect"). */
export function isRedirectRefusal(err: unknown): boolean {
  if (!(err instanceof TypeError)) return false;
  const cause = (err as { cause?: unknown }).cause;
  return /redirect/i.test(err.message) || (cause instanceof Error && /redirect/i.test(cause.message));
}

/** A refused redirect as a canonical error: a misconfigured address, not an outage, so it is not retried. */
export function redirectAiError(providerLabel: string, raw: unknown): AiError {
  return makeAiError('validation', `${providerLabel} answered with a redirect, which is never followed (check its address)`, {
    retryable: false,
    providerCode: 'redirect',
    raw,
  });
}

export interface Deadline {
  /** The signal to hand to fetch: the caller's own when there is no deadline. */
  readonly signal: AbortSignal | undefined;
  /** True when a deadline is set: the caller then races its reads against `signal`. */
  readonly active: boolean;
  /** The first sign of output arrived: the deadline is over, the caller's own signal still counts. */
  disarm(): void;
  /**
   * Start the clock again, as another kind of deadline (`idle`, on each piece
   * of a streamed reply). With `ms` undefined the clock just stops. A guard
   * that was started with no deadline at all does nothing here either.
   */
  rearm(kind: DeadlineKind, ms: number | undefined): void;
  /** The error to report, when it was the deadline that ended the call. */
  fired(): DeadlineError | undefined;
  /** Always call when the request is over. */
  dispose(): void;
}

/**
 * One deadline on one request. With `ms` undefined it does nothing at all and
 * hands back the caller's own signal. Otherwise the returned signal aborts when
 * the caller's does (same reason) or when `ms` passes before `disarm()`.
 *
 * Linked by listener rather than AbortSignal.any, which Node 20.0 to 20.2 lack.
 */
export function startDeadline(kind: DeadlineKind, ms: number | undefined, outer: AbortSignal | undefined, opts: { always?: boolean } = {}): Deadline {
  // `always`: a guard with its own signal even with no first deadline, for a call that may still be given one later (`rearm`).
  if (ms === undefined && !opts.always) {
    return { signal: outer, active: false, disarm: () => {}, rearm: () => {}, fired: () => undefined, dispose: () => {} };
  }
  const ac = new AbortController();
  let fired: DeadlineError | undefined;
  const onOuter = (): void => ac.abort(outer?.reason);
  if (outer?.aborted) ac.abort(outer.reason);
  else outer?.addEventListener('abort', onOuter, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const disarm = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const arm = (k: DeadlineKind, wait: number | undefined): void => {
    disarm();
    if (wait === undefined || ac.signal.aborted) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (ac.signal.aborted) return;
      fired = new DeadlineError(k, wait);
      ac.abort(fired);
    }, wait);
  };
  arm(kind, ms);
  return {
    signal: ac.signal,
    active: true,
    disarm,
    rearm: arm,
    fired: () => fired,
    dispose: () => {
      disarm();
      outer?.removeEventListener('abort', onOuter);
    },
  };
}

/**
 * `p`, unless `signal` aborts first: then it rejects with the signal's reason.
 * A transport that ignores its signal (a custom fetch, a stalled body) cannot
 * hold a turn past its deadline this way.
 */
export function raceAbort<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return p;
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    if (signal.aborted) {
      p.catch(() => {}); // its own failure is no longer anyone's
      reject(signal.reason);
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}
