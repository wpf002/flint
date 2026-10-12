/**
 * The frontier circuit breaker: when an outside AI is going to keep failing,
 * stop asking it for a while and let the local model answer at once.
 *
 * Why: in October 2026 Will's Anthropic credit ran out. Every turn still asked
 * Opus, then Sonnet, each answered 400 "credit balance is too low", and only
 * then did the local model get the question. Nothing remembered that the turn
 * before had failed the same way, so every turn paid for the failure again.
 *
 * What opens it, per provider (one key, one account, one endpoint: a failure of
 * these kinds is every model's on it):
 *  - `credit`: a 400 that says the credit balance is too low (or OpenAI's
 *    insufficient_quota). At once.
 *  - `auth`: 401 or 403, the key was rejected. At once.
 *  - `transient`: 529 and any other 5xx, a timeout, a connection error. After
 *    BREAKER_THRESHOLD failed requests in a row with no success between them
 *    (Flint's own retries count: each is a request that failed).
 * Nothing else is counted: a malformed request, an unknown model, a 429, a
 * refusal or a closed tab says nothing about the next call.
 *
 * While it is open, `paused(provider)` gives the reason code, and a turn that
 * the local model may answer leaves that provider's brains out (gateTurn). The
 * cool-down is 5 minutes for `transient`, doubling up to 1 hour while checks
 * keep failing, and 1 hour for `credit` and `auth`.
 *
 * After the cool-down, the next turn that comes along sets off ONE cheap check
 * (`probe`: a one-token call) and is itself still answered locally at once: no
 * turn waits on the check. If the check is answered the breaker closes; if it
 * fails, the cool-down starts again. Any real call that succeeds closes it too.
 * Nothing runs on a schedule: with nobody chatting, nothing is asked.
 *
 * It is fed by an AiObserver (`observer()`), so it sees every provider request
 * the server's Flint clients make: /chat and /generate, every tier, each retry,
 * the research planner. Only outside providers are tracked (vendorOfProvider):
 * the local Ollama model is the last resort and is never skipped.
 *
 * State is in memory only: a restart starts closed, and one failing call opens
 * it again. Log lines carry the provider and a reason code, never a provider's
 * message.
 *
 * Kept free of index.ts so it is unit-testable (index.ts runs main() on import).
 */
import { isFlintError, vendorOfProvider, type AiError, type AiObserver } from '@flint/core';
import type { BrainTier } from './brains';
import type { Brain } from './policy';

export type BreakerReason = 'credit' | 'auth' | 'transient';

/** Failed requests in a row (no success between) before `transient` opens it. */
export const BREAKER_THRESHOLD = 3;
/** The first `transient` cool-down; each failed check doubles it. */
export const TRANSIENT_COOLDOWN_MS = 5 * 60 * 1000;
/** Where the doubling stops. */
export const MAX_COOLDOWN_MS = 60 * 60 * 1000;
/** `credit` and `auth`: nothing changes until Will does something, so check hourly. */
export const HARD_COOLDOWN_MS = 60 * 60 * 1000;
/** How long the one-token check may take before it counts as a `transient` failure. */
export const PROBE_TIMEOUT_MS = 30 * 1000;

/**
 * Does this error message say the account's credit has run out? Anthropic
 * answers that with a plain 400 whose error type (invalid_request_error) is a
 * malformed request's too, so only the words tell them apart. Shared with
 * memory extraction's frontierOutage (./memory-brain).
 */
export function creditExhausted(message: string): boolean {
  return /credit balance is too low/i.test(message);
}

/** The parts of an AiError the breaker reads. */
export type Failure = Pick<AiError, 'kind' | 'message' | 'retryable'> & { providerCode?: string | undefined };

/**
 * Which kind of "will keep failing" this error is, or undefined when it is not
 * one. Read from the canonical AiError the adapters produce: `providerCode` is
 * the HTTP status for Anthropic, and OpenAI's own error code when it sent one.
 */
export function breakerReason(err: Failure): BreakerReason | undefined {
  const code = err.providerCode ?? '';
  const status = /^\d{3}$/.test(code) ? Number(code) : undefined;
  // OpenAI's spent quota is a 429 its adapter marks as not worth retrying.
  if ((status === 400 && creditExhausted(err.message)) || code === 'insufficient_quota' || (status === 429 && err.kind === 'validation')) return 'credit';
  if (status === 401 || status === 403 || /\(check the API key\)$/.test(err.message)) return 'auth';
  if (err.kind === 'provider_unavailable') return 'transient'; // 5xx (529 included), or no connection at all
  if (err.kind === 'timeout' && err.retryable) return 'transient'; // a deadline; a caller's own cancellation is not retryable
  return undefined;
}

export interface BreakerEvent {
  provider: string;
  reason: BreakerReason;
  cooldownMs: number;
}

export interface BreakerOptions {
  /**
   * One cheap call to `provider` (a one-token generation): resolves when it was
   * answered, rejects with what the call threw. `signal` ends it at the timeout.
   */
  probe: (provider: string, signal: AbortSignal) => Promise<void>;
  now?: () => number;
  log?: (msg: string) => void;
  /** Told when a provider is newly paused (not when a check fails on one already paused). */
  onOpen?: (e: BreakerEvent) => void;
  threshold?: number;
  probeTimeoutMs?: number;
}

interface Open {
  reason: BreakerReason;
  /** When the cool-down ends: from then, the next ask sets off the check. */
  until: number;
  cooldownMs: number;
  /** The check is running; no second one starts. */
  probing: boolean;
}

interface State {
  /** `transient` failures in a row while closed. */
  failures: number;
  open?: Open;
}

const minutes = (ms: number): number => Math.round(ms / 60_000);

export class FrontierBreaker {
  private readonly states = new Map<string, State>();
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private readonly threshold: number;

  constructor(private readonly opts: BreakerOptions) {
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
    this.threshold = opts.threshold ?? BREAKER_THRESHOLD;
  }

  /**
   * Why `provider` is not to be asked now (its reason code), or undefined when
   * it may be. Past the cool-down this sets off the check, once, and the
   * provider stays paused until that check is answered.
   */
  paused(provider: string): BreakerReason | undefined {
    const open = this.states.get(provider)?.open;
    if (!open) return undefined;
    if (!open.probing && this.now() >= open.until) this.check(provider, open);
    return open.reason;
  }

  /** A provider request failed. Opens the breaker when the failure is one that will repeat. */
  failed(provider: string, err: Failure): void {
    if (vendorOfProvider(provider) === undefined) return; // the local model is never paused
    const reason = breakerReason(err);
    if (!reason) return;
    let s = this.states.get(provider);
    if (!s) this.states.set(provider, (s = { failures: 0 }));
    if (s.open) return; // already paused: a call that was in flight, or the check's own failure
    if (reason === 'transient' && ++s.failures < this.threshold) return;
    const cooldownMs = reason === 'transient' ? TRANSIENT_COOLDOWN_MS : HARD_COOLDOWN_MS;
    s.failures = 0;
    s.open = { reason, cooldownMs, until: this.now() + cooldownMs, probing: false };
    this.log(`[breaker] ${provider} paused (${reason}): the local model answers; next check in ${minutes(cooldownMs)} min`);
    try {
      this.opts.onOpen?.({ provider, reason, cooldownMs });
    } catch {
      /* a listener's failure is not the breaker's */
    }
  }

  /** A provider request was answered: the count starts over, and an open breaker closes. */
  succeeded(provider: string): void {
    const s = this.states.get(provider);
    if (!s) return;
    s.failures = 0;
    if (!s.open) return;
    delete s.open;
    this.log(`[breaker] ${provider} answered: back in use`);
  }

  /** What the breaker holds for a provider right now (tests, the boot log). */
  state(provider: string): { failures: number; open?: { reason: BreakerReason; until: number; cooldownMs: number; probing: boolean } } {
    const s = this.states.get(provider);
    return { failures: s?.failures ?? 0, ...(s?.open ? { open: { ...s.open } } : {}) };
  }

  /**
   * The observer that feeds the breaker from every request a Flint client
   * makes. Core emits `onError` once per failed provider request (each retry is
   * its own) and `onResponse` once per answered pass; a pass that ended `error`
   * or `aborted` reports what it was billed, not an answer.
   */
  observer(): AiObserver {
    return {
      onError: (e) => this.failed(e.provider, e.error),
      onResponse: (e) => {
        if (e.reason !== 'error' && e.reason !== 'aborted') this.succeeded(e.provider);
      },
    };
  }

  /** The one check after a cool-down. Never throws, and nothing awaits it. */
  private check(provider: string, open: Open): void {
    open.probing = true;
    const ac = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, this.opts.probeTimeoutMs ?? PROBE_TIMEOUT_MS);
    timer.unref?.();
    void Promise.resolve()
      .then(() => this.opts.probe(provider, ac.signal))
      .then(
        () => this.succeeded(provider),
        (err: unknown) => {
          const s = this.states.get(provider);
          if (!s?.open || s.open !== open) return; // a real call closed it while the check ran
          // Our own deadline is a timeout however the adapter words the abort.
          const reason = timedOut ? 'transient' : isFlintError(err) ? breakerReason(err.error) : undefined;
          if (!reason) {
            // It answered, with something that is no outage (a 429, a 4xx of the check's own): real calls decide.
            this.succeeded(provider);
            return;
          }
          const cooldownMs = reason !== 'transient' ? HARD_COOLDOWN_MS : open.reason === 'transient' ? Math.min(MAX_COOLDOWN_MS, open.cooldownMs * 2) : TRANSIENT_COOLDOWN_MS;
          s.open = { reason, cooldownMs, until: this.now() + cooldownMs, probing: false };
          this.log(`[breaker] ${provider} still failing (${reason}): next check in ${minutes(cooldownMs)} min`);
        },
      )
      .finally(() => clearTimeout(timer));
  }
}

// ---------------------------------------------------------------------------
// applying it to a turn

/** A brain left out of a turn because its provider is paused. */
export interface PausedBrain {
  label: string;
  provider: string;
  reason: BreakerReason;
}

/** A turn's planned chain without the brains whose provider is paused, and which those were. */
export function gateChain<P>(chain: readonly BrainTier<P>[], breaker: Pick<FrontierBreaker, 'paused'>): { chain: BrainTier<P>[]; paused: PausedBrain[] } {
  const open: BrainTier<P>[] = [];
  const paused: PausedBrain[] = [];
  for (const b of chain) {
    const reason = breaker.paused(b.provider.name);
    if (reason) paused.push({ label: b.label, provider: b.provider.name, reason });
    else open.push(b);
  }
  return { chain: open, paused };
}

/** For the [route] line and a response's `frontierPaused`: `anthropic:credit`, one per provider. */
export function pausedCode(paused: readonly PausedBrain[]): string | undefined {
  const codes = [...new Set(paused.map((p) => `${p.provider}:${p.reason}`))];
  return codes.length > 0 ? codes.join(',') : undefined;
}

/**
 * Thrown in place of asking a brain whose provider was paused while its turn
 * was already running (an earlier brain's failure opened the breaker), so the
 * chain moves on without paying for the same failure twice.
 */
export class FrontierPaused extends Error {
  constructor(
    readonly brain: PausedBrain,
  ) {
    super(`paused: ${brain.reason}`);
    this.name = 'FrontierPaused';
  }
}

/** Wrap a chain's attempt (runWithFallback, answerWithFallback) so a paused provider's brain is skipped, not asked. */
export function gated<P, T>(breaker: Pick<FrontierBreaker, 'paused'>, attempt: (brain: BrainTier<P>) => Promise<T>): (brain: BrainTier<P>) => Promise<T> {
  return async (brain) => {
    const reason = breaker.paused(brain.provider.name);
    if (reason) throw new FrontierPaused({ label: brain.label, provider: brain.provider.name, reason });
    return attempt(brain);
  };
}

export interface TurnGate<P> {
  /** The brain that answers: the plan's, or `local` when every planned brain is paused. */
  brain: Brain;
  /** The frontier brains to try, in order. */
  chain: BrainTier<P>[];
  /** `provider:reason` codes for the brains left out (pausedCode); undefined when none was. */
  paused?: string;
  /** Wraps the chain's attempt: `gated` for a turn the local model may answer, the attempt itself otherwise. */
  attempt: <T>(ask: (brain: BrainTier<P>) => Promise<T>) => (brain: BrainTier<P>) => Promise<T>;
}

/**
 * What the breaker decides about one turn, BEFORE any call (what /generate and
 * /chat apply, after the spend plan):
 *  - a turn the local model may answer (`canLocal`: no image or PDF on it, and
 *    the local brain not refused) leaves out the brains whose provider is
 *    paused; with none left it is a local turn from the start, answered at once;
 *  - while it runs, a brain whose provider an earlier brain's failure has just
 *    paused is skipped as well (`attempt`);
 *  - a turn only the frontier can answer is left exactly as planned: there is
 *    no local answer to hurry to, and its call may be the one that works.
 */
export function gateTurn<P>(input: {
  brain: Brain;
  /** The spend plan's chain; undefined for a turn that was local already. */
  chain: readonly BrainTier<P>[] | undefined;
  canLocal: boolean;
  breaker: Pick<FrontierBreaker, 'paused'>;
}): TurnGate<P> {
  const planned = [...(input.chain ?? [])];
  if (input.brain !== 'frontier' || !input.canLocal || planned.length === 0) {
    return { brain: input.brain, chain: planned, attempt: (ask) => ask };
  }
  const { chain, paused } = gateChain(planned, input.breaker);
  const code = pausedCode(paused);
  return {
    brain: chain.length === 0 ? 'local' : 'frontier',
    chain,
    ...(code ? { paused: code } : {}),
    attempt: (ask) => gated(input.breaker, ask),
  };
}

/** What Will calls each outside provider. */
const NAMES: Record<string, string> = { anthropic: 'Claude', openai: 'OpenAI', perplexity: 'Perplexity' };

/**
 * The note for Will when a provider is paused for something only he can fix.
 * A `transient` pause clears itself in minutes and gets no note.
 */
export function breakerNote(e: Pick<BreakerEvent, 'provider' | 'reason'>): { title: string; body: string } | undefined {
  const name = NAMES[e.provider] ?? e.provider;
  const body = 'Flint is answering with the local model, and checks again every hour.';
  if (e.reason === 'credit') return { title: `${name} Is Out of Credit`, body };
  if (e.reason === 'auth') return { title: `${name} Rejected Flint's Key`, body };
  return undefined;
}
