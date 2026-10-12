/**
 * The frontier circuit breaker: when an outside AI is going to keep failing,
 * stop asking it for a while and let the local model answer at once.
 *
 * Why: in October 2026 Will's Anthropic credit ran out. Every turn still asked
 * Opus, then Sonnet, each answered 400 "credit balance is too low", and only
 * then did the local model get the question. Nothing remembered that the turn
 * before had failed the same way, so every turn paid for the failure again.
 *
 * What opens it:
 *  - `credit`: a 400 that says the credit balance is too low, a 402, or
 *    OpenAI's insufficient_quota. At once, for the whole provider (one account).
 *  - `auth`: 401 or 403, the key was rejected. At once, for the whole provider;
 *    unless it is a 403 about one model (modelScoped), which pauses that model
 *    alone and leaves its siblings in use.
 *  - `transient`: 529 and any other 5xx, a timeout, a connection error. After
 *    BREAKER_THRESHOLD failed REQUESTS in a row on the provider with no success
 *    between them. One request's own retries count once (they share a request
 *    id), so one model having a bad minute cannot pause the provider by itself:
 *    the turn moves on to a sibling, and its answer starts the count over.
 * Nothing else is counted: a malformed request, an unknown model, a 429, a
 * refusal or a closed tab says nothing about the next call.
 *
 * While it is open, `paused(provider, model)` gives the reason code, and a turn
 * that the local model may answer leaves those brains out (gateTurn). The
 * cool-down is 5 minutes for `transient`, doubling up to 1 hour while checks
 * keep failing, and 15 minutes for `credit` and `auth` (a failed check costs
 * nothing, so there is no reason to wait longer).
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
 * it again. Time is the monotonic clock, so a clock change neither ends a
 * cool-down early nor stretches it. Log lines carry the provider and a reason
 * code, never a provider's message.
 *
 * Kept free of index.ts so it is unit-testable (index.ts runs main() on import).
 */
import { isFlintError, vendorOfProvider, type AiError, type AiObserver } from '@flint/core';
import type { BrainTier } from './brains';
import type { Brain } from './policy';

export type BreakerReason = 'credit' | 'auth' | 'transient';

/** Failed requests in a row on a provider (no success between) before `transient` opens it. */
export const BREAKER_THRESHOLD = 2;
/** The first `transient` cool-down; each failed check doubles it. */
export const TRANSIENT_COOLDOWN_MS = 5 * 60 * 1000;
/** Where the doubling stops. */
export const MAX_COOLDOWN_MS = 60 * 60 * 1000;
/** `credit` and `auth`: nothing changes until Will does something, and a failed check is free, so check every 15 minutes. */
export const HARD_COOLDOWN_MS = 15 * 60 * 1000;
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

/** The HTTP status an AiError carries as its providerCode, when it is one (OpenAI sends its own codes instead). */
function statusOf(err: Failure): number | undefined {
  const code = err.providerCode ?? '';
  return /^\d{3}$/.test(code) ? Number(code) : undefined;
}

/**
 * Which kind of "will keep failing" this error is, or undefined when it is not
 * one. Read from the canonical AiError the adapters produce: `providerCode` is
 * the HTTP status for Anthropic, and OpenAI's own error code when it sent one.
 */
export function breakerReason(err: Failure): BreakerReason | undefined {
  const status = statusOf(err);
  // 402 is Payment Required. OpenAI's spent quota is a 429 its adapter marks as not worth retrying.
  if (status === 402 || (status === 400 && creditExhausted(err.message)) || err.providerCode === 'insufficient_quota' || (status === 429 && err.kind === 'validation')) return 'credit';
  if (status === 401 || status === 403 || /\(check the API key\)$/.test(err.message)) return 'auth';
  if (err.kind === 'provider_unavailable') return 'transient'; // 5xx (529 included), or no connection at all
  if (err.kind === 'timeout' && err.retryable) return 'transient'; // a deadline; a caller's own cancellation is not retryable
  return undefined;
}

/**
 * Is this `auth` failure about ONE model, not the key? A permission error
 * (never a 401, which is the key itself) whose message names the model asked
 * for, or speaks of a model: "does not have access to model gpt-5". Its
 * siblings on the same key still answer, so only that model is paused.
 */
export function modelScoped(err: Failure, model: string | undefined): boolean {
  if (!model || statusOf(err) === 401) return false;
  return err.message.includes(model) || aboutAModel(err);
}

/** Does a permission error speak of a model (never a 401, which is the key itself)? */
function aboutAModel(err: Failure): boolean {
  return statusOf(err) !== 401 && /\bmodels?\b/i.test(err.message);
}

export interface BreakerEvent {
  provider: string;
  /** Set when one model is paused and the rest of the provider is not. */
  model?: string;
  reason: BreakerReason;
  cooldownMs: number;
}

export interface BreakerOptions {
  /**
   * One cheap call to `provider` (a one-token generation): resolves when it was
   * answered, rejects with what the call threw. `signal` ends it at the timeout.
   * `model` is set when it is that one model being checked.
   */
  probe: (provider: string, signal: AbortSignal, model?: string) => Promise<void>;
  /** Milliseconds on a clock that only goes forward (default performance.now). */
  now?: () => number;
  log?: (msg: string) => void;
  /** Told when a provider is newly paused, and when a check finds another reason than the one it was paused for. */
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

/** One breaker: a whole provider's, or one model's (a 403 about that model). */
interface State {
  provider: string;
  model?: string;
  /** `transient` failures in a row while closed, one per request. */
  failures: number;
  /** The request ids already counted, so a request's retries are one failure. */
  counted: Set<string>;
  open?: Open;
}

const minutes = (ms: number): number => Math.round(ms / 60_000);
const scopeOf = (provider: string, model?: string): string => (model === undefined ? provider : `${provider}:${model}`);

export class FrontierBreaker {
  private readonly states = new Map<string, State>();
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private readonly threshold: number;

  constructor(private readonly opts: BreakerOptions) {
    this.now = opts.now ?? (() => performance.now());
    this.log = opts.log ?? (() => {});
    this.threshold = opts.threshold ?? BREAKER_THRESHOLD;
  }

  /**
   * Why `model` on `provider` is not to be asked now (the reason code), or
   * undefined when it may be: the provider's own pause first, else that
   * model's. Past the cool-down this sets off the check, once, and the pause
   * holds until that check is answered.
   */
  paused(provider: string, model?: string): BreakerReason | undefined {
    return this.pausedAt(provider) ?? (model !== undefined ? this.pausedAt(scopeOf(provider, model)) : undefined);
  }

  private pausedAt(scope: string): BreakerReason | undefined {
    const s = this.states.get(scope);
    const open = s?.open;
    if (!s || !open) return undefined;
    if (!open.probing && this.now() >= open.until) this.check(s, open);
    return open.reason;
  }

  /**
   * A provider request failed. Opens the breaker when the failure is one that
   * will repeat. `at.requestId` is the request it belongs to (its retries share
   * it, and count once); `at.model` the model asked.
   */
  failed(provider: string, err: Failure, at: { requestId?: string; model?: string } = {}): void {
    if (vendorOfProvider(provider) === undefined) return; // the local model is never paused
    const reason = breakerReason(err);
    if (!reason) return;
    const model = reason === 'auth' && modelScoped(err, at.model) ? at.model : undefined;
    const scope = scopeOf(provider, model);
    let s = this.states.get(scope);
    if (!s) this.states.set(scope, (s = { provider, ...(model !== undefined ? { model } : {}), failures: 0, counted: new Set() }));
    if (s.open) return; // already paused: a call that was in flight, or the check's own failure
    if (reason === 'transient') {
      if (at.requestId !== undefined) {
        if (s.counted.has(at.requestId)) return; // this request's retry: already counted
        s.counted.add(at.requestId);
      }
      if (++s.failures < this.threshold) return;
    }
    this.pause(s, reason, reason === 'transient' ? TRANSIENT_COOLDOWN_MS : HARD_COOLDOWN_MS, true);
  }

  /** A provider request was answered: the count starts over, and an open breaker (the provider's, and that model's) closes. */
  succeeded(provider: string, model?: string): void {
    for (const scope of model === undefined ? [provider] : [provider, scopeOf(provider, model)]) {
      const s = this.states.get(scope);
      if (!s) continue;
      s.failures = 0;
      s.counted.clear();
      if (!s.open) continue;
      delete s.open;
      this.log(`[breaker] ${scope} answered: back in use`);
    }
  }

  /** What the breaker holds for a provider (or one model on it) right now. */
  state(provider: string, model?: string): { failures: number; open?: { reason: BreakerReason; until: number; cooldownMs: number; probing: boolean } } {
    const s = this.states.get(scopeOf(provider, model));
    return { failures: s?.failures ?? 0, ...(s?.open ? { open: { ...s.open } } : {}) };
  }

  /** Every pause in force, for /health: what is paused, why (a code), and how long until its next check. Reads only: it starts no check. */
  snapshot(): Array<{ scope: string; reason: BreakerReason; nextCheckInSec: number; checking: boolean }> {
    const t = this.now();
    return [...this.states.entries()]
      .filter(([, s]) => s.open)
      .map(([scope, s]) => ({ scope, reason: s.open!.reason, nextCheckInSec: Math.max(0, Math.ceil((s.open!.until - t) / 1000)), checking: s.open!.probing }));
  }

  /**
   * The observer that feeds the breaker from every request a Flint client
   * makes. Core emits `onError` once per failed provider request (each retry is
   * its own, under one request id) and `onResponse` once per answered pass; a
   * pass that ended `error` or `aborted` reports what it was billed, not an answer.
   */
  observer(): AiObserver {
    return {
      onError: (e) => this.failed(e.provider, e.error, { requestId: e.requestId, model: e.model }),
      onResponse: (e) => {
        if (e.reason !== 'error' && e.reason !== 'aborted') this.succeeded(e.provider, e.model);
      },
    };
  }

  /** Pause (or keep paused, for another reason or another cool-down). `tell`: this is news for Will. */
  private pause(s: State, reason: BreakerReason, cooldownMs: number, tell: boolean): void {
    const scope = scopeOf(s.provider, s.model);
    s.failures = 0;
    s.counted.clear();
    s.open = { reason, cooldownMs, until: this.now() + cooldownMs, probing: false };
    this.log(
      tell
        ? `[breaker] ${scope} paused (${reason}): ${s.model === undefined ? 'the local model answers' : 'its other models still answer'}; next check in ${minutes(cooldownMs)} min`
        : `[breaker] ${scope} still failing (${reason}): next check in ${minutes(cooldownMs)} min`,
    );
    if (!tell) return;
    try {
      this.opts.onOpen?.({ provider: s.provider, ...(s.model !== undefined ? { model: s.model } : {}), reason, cooldownMs });
    } catch {
      /* a listener's failure is not the breaker's */
    }
  }

  /**
   * The one check after a cool-down. Never throws, and nothing awaits it. It
   * races the call against its own deadline, so a check that never settles is a
   * timeout like any other and cannot leave the breaker checking forever.
   */
  private check(s: State, open: Open): void {
    open.probing = true;
    const ac = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => {
        ac.abort();
        resolve('timeout');
      }, this.opts.probeTimeoutMs ?? PROBE_TIMEOUT_MS);
      timer.unref?.();
    });
    const asked = Promise.resolve()
      .then(() => this.opts.probe(s.provider, ac.signal, s.model))
      .then(
        () => 'answered' as const,
        (err: unknown) => ({ err }),
      );
    void Promise.race([asked, deadline]).then((outcome) => {
      clearTimeout(timer);
      if (s.open !== open) return; // a real call closed it (or opened it afresh) while the check ran
      if (outcome === 'answered') return this.succeeded(s.provider, s.model);
      // What the check found. Its own deadline is a timeout however the adapter words the abort. An
      // error that is not the provider's (the check itself broke) is evidence of nothing: the pause
      // stays as it was. A provider answer that is no outage (a 429, a 4xx of the check's own) means
      // it is reachable and willing: real calls decide from here.
      let found: BreakerReason;
      if (outcome === 'timeout') found = 'transient';
      else if (!isFlintError(outcome.err)) found = open.reason;
      else {
        const reason = breakerReason(outcome.err.error);
        if (!reason) return this.succeeded(s.provider, s.model);
        // A provider-wide check that is told "not that model" was answered by a provider that is up,
        // with a key it accepts: the provider is back. The model's own pause is its own affair (the
        // observer has opened it), and must not be taken for the whole provider's.
        if (s.model === undefined && reason === 'auth' && aboutAModel(outcome.err.error)) return this.succeeded(s.provider);
        found = reason;
      }
      const cooldownMs = found !== 'transient' ? HARD_COOLDOWN_MS : open.reason === 'transient' ? Math.min(MAX_COOLDOWN_MS, open.cooldownMs * 2) : TRANSIENT_COOLDOWN_MS;
      // Another reason than it was paused for (an outage that turns out to be no credit) is news: Will is told.
      this.pause(s, found, cooldownMs, found !== open.reason);
    });
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

/** A turn's planned chain without the brains that are paused (their provider, or that one model), and which those were. */
export function gateChain<P>(chain: readonly BrainTier<P>[], breaker: Pick<FrontierBreaker, 'paused'>): { chain: BrainTier<P>[]; paused: PausedBrain[] } {
  const open: BrainTier<P>[] = [];
  const paused: PausedBrain[] = [];
  for (const b of chain) {
    const reason = breaker.paused(b.provider.name, b.model);
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
 * Thrown in place of asking a brain whose provider was paused, for `credit` or
 * `auth`, while its turn was already running (an earlier brain's failure opened
 * the breaker), so the chain moves on without paying for the same failure twice.
 */
export class FrontierPaused extends Error {
  constructor(
    readonly brain: PausedBrain,
  ) {
    super(`paused: ${brain.reason}`);
    this.name = 'FrontierPaused';
  }
}

/**
 * Wrap a chain's attempt (runWithFallback, answerWithFallback) so that a brain
 * paused while the turn runs is skipped, not asked, when the reason is the
 * account's (`credit`, `auth`): no sibling on that key will fare better. A
 * `transient` pause opened mid-turn skips nobody in that turn: one model's bad
 * minute says little about its siblings, and the turn is already under way.
 */
export function gated<P, T>(breaker: Pick<FrontierBreaker, 'paused'>, attempt: (brain: BrainTier<P>) => Promise<T>): (brain: BrainTier<P>) => Promise<T> {
  return async (brain) => {
    const reason = breaker.paused(brain.provider.name, brain.model);
    if (reason && reason !== 'transient') throw new FrontierPaused({ label: brain.label, provider: brain.provider.name, reason });
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
 *    paused for `credit` or `auth` is skipped as well (`attempt`, see gated);
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

/** What Will calls each outside provider. One this does not know is "an outside AI": a name from config is never shown as it is. */
const NAMES: Record<string, string> = { anthropic: 'Claude', openai: 'OpenAI', perplexity: 'Perplexity', ollama: 'Ollama' };

/**
 * The note for Will when a provider is paused for something only he can fix.
 * A `transient` pause clears itself in minutes and gets no note.
 *
 * Written to his rules for a note (2026-10-12): a short Title Case title, whole
 * sentences under it, and no internal name. A model's id is one, so the note
 * says "one of Claude's models" and the server log names it (`[breaker]
 * anthropic:<model> paused (auth)`), as GET /health does under frontierPaused.
 */
export function breakerNote(e: Pick<BreakerEvent, 'provider' | 'reason' | 'model'>): { title: string; body: string } | undefined {
  const name = NAMES[e.provider];
  const who = name ?? 'An Outside AI';
  const body = 'Flint is answering with the local model, and checks again every 15 minutes.';
  if (e.reason === 'credit') return { title: `${who} Has No Credit Left`, body };
  if (e.reason !== 'auth') return undefined;
  if (e.model === undefined) return { title: `${who} Rejected Flint’s Key`, body };
  return {
    title: `${who} Refused One Model`,
    body: `Flint’s key can’t use one of ${name ? `${name}’s` : 'its'} models, and the server log names it. The others still answer, and Flint checks again every 15 minutes.`,
  };
}
