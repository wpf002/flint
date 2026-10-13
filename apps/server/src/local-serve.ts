/**
 * Warm-start fallback: which local model answers a turn, decided from the
 * models' state before the turn starts.
 *
 * A cold local model does not fail, it makes the turn wait while its weights
 * load. So a turn is planned from one snapshot of the monitor
 * (./local-monitor), and is only ever sent to a model that is ready:
 *
 *   main model     standby      local mode,          hybrid, any other turn
 *                               or a private turn
 *   ready          any          main, then standby   main, then standby, then cloud
 *   not ready      installed    standby              standby, then cloud
 *   not ready      none         a sentence           cloud
 *   unavailable    installed    standby              standby, then cloud
 *   unavailable    none         a sentence           cloud
 *
 * "Unavailable" includes a main model that is not settled: nothing names it and
 * the model server has not said what it has (./local-brains). The name held
 * meanwhile is a stand-in, and a stand-in is never asked, in any mode: asking
 * Ollama for it would load it, and the next pick would take it for the model
 * Will runs. A turn that must be local gets a sentence until the server answers.
 *
 * "Not ready" is cold, loading, or slow to first token a moment ago. In each
 * such row the main model is warmed, by the monitor, detached from the turn.
 * In the cloud mode none of this applies: a local turn goes to the main model
 * as it always has.
 *
 * Three rules hold the plan together:
 *  - NO MID-TURN SWAPS. The plan is made once and not recomputed. Every pass of
 *    a turn's tool loop uses the model the turn started on. When the main model
 *    becomes ready, the NEXT turn's plan picks it.
 *  - A step is abandoned only before any progress: nothing was shown and no
 *    tool was called (./brains mayAskAnother, the same rule the cloud tiers
 *    follow). After that a failure is an error, never a second model starting
 *    the turn over and calling the tool again.
 *  - A private turn, and every turn in Local mode, has no cloud step.
 *
 * In hybrid, with the main model not ready, the STANDBY answers first and the
 * cloud only if no local model can: `HYBRID_WHEN_COLD` is that one row, and the
 * place to flip it.
 *
 * Kept free of index.ts so it is unit-testable (index.ts runs main() on import).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { FIRST_TOKEN_TIMEOUT, IDLE_TIMEOUT, REQUEST_TIMEOUT, isFlintError, type AiError, type ProviderAdapter, type Tier } from '@flint/core';
import { mayAskAnother, type BrainTier } from './brains';
import { gateChain, type FrontierBreaker } from './frontier-breaker';
import { staysOn } from './inference-status';
import type { LocalBrains, NotConfined } from './local-brains';
import { isReady, type LocalMonitor, type LocalSnapshot, type LocalState, type ModelHealth, type TurnObservation, type Which } from './local-monitor';
import type { ModeRoute } from './mode-route';
import { planFrontier, type BrainChooser, type BudgetView } from './spend';
import { asLocalTurn } from './turn-taint';

/** In hybrid, what a turn that may use the cloud tries when the main local model is not ready, in order. One place to change it. */
export const HYBRID_WHEN_COLD: readonly ('fallback' | 'cloud')[] = ['fallback', 'cloud'];

/** One local model a turn may be answered by: the persona that speaks for it, and its name. */
export interface LocalChoice<P> {
  persona: P;
  model: string;
}

export type LocalStep<P> =
  | ({ kind: 'local'; which: Which; /** Its state when the plan was made. */ state: LocalState } & LocalChoice<P>)
  /** Hybrid only: the cloud tiers, when no local model could answer. */
  | { kind: 'cloud' };

export interface LocalPlan<P> {
  /** What to try, in order. Empty: nothing can answer (see `refusal`). */
  steps: LocalStep<P>[];
  /** The main model's state when the plan was made (the [route] line). */
  primaryState: LocalState;
  /** The main model is installed and not ready: the caller has the monitor warm it, detached from the turn. */
  warmPrimary: boolean;
  /** Why no local model can answer, as a sentence for Will. Set whenever no local step was planned. */
  refusal?: string;
}

export interface PlanInput<P> {
  route: Pick<ModeRoute, 'mode' | 'reason' | 'private' | 'cloudFallback'>;
  snapshot: LocalSnapshot;
  /** Is "local" really this Mac (./local-brains confined)? */
  confined: LocalBrains['confined'];
  primary: LocalChoice<P>;
  /** The standby model, when one is configured. */
  standby?: LocalChoice<P> | undefined;
  now: number;
  /** HYBRID_WHEN_COLD, or another order (tests, tuning). */
  whenCold?: readonly ('fallback' | 'cloud')[];
  /** An eval replay that named its own local model (`localModel`): `primary` is that model's persona, not the main brain's. */
  evalOwnModel?: boolean;
  /**
   * The local model is on another machine that Will said is his (FLINT_LOCAL_ALLOW_REMOTE=1): a sentence that
   * says where a private message stays then names that server too (./inference-status staysOn).
   */
  allowedRemote?: boolean;
}


/** How a refusal ends: why nothing else may answer this turn. */
function refusalTail(route: Pick<ModeRoute, 'mode' | 'private'>, allowedRemote?: boolean): string {
  return route.mode === 'local'
    ? 'and Local mode never uses the cloud.'
    : route.private
      ? `and a private message never leaves ${staysOn(allowedRemote)}.`
      : // Cloud or Hybrid, not private, and the turn was the local model's to answer: there is no cloud model to
        // send it to. (In Cloud mode this used to end "so only the cloud can answer right now", in the one state
        // where there is no cloud.)
        'and no cloud model is configured.';
}

/** The sentence for a turn that must stay here when "local" is not this Mac. */
function notHereSentence(why: NotConfined, tail: string): string {
  if (why === 'proxy') return `The local model server is reached through a proxy, ${tail}`;
  if (why === 'remote_host') return `The local model server is on another machine, ${tail}`;
  if (why === 'cloud_model') return `The local model is one that runs on Ollama's servers, ${tail}`;
  return `The local model server's address was refused, ${tail}`;
}

/** The sentence for a turn that must be local when no local model can answer it. */
function refusalFor(route: PlanInput<unknown>['route'], confined: LocalBrains['confined'], primary: ModelHealth, allowedRemote?: boolean): string {
  const tail = refusalTail(route, allowedRemote);
  if (!confined.ok) return notHereSentence(confined.why, tail);
  if (primary.state === 'unavailable' && primary.why === 'unsettled') return `Flint hasn't chosen its local model yet, because the local model server isn't answering, ${tail}`;
  if (primary.state === 'unavailable') return primary.why === 'not_installed' ? `The local model isn't downloaded yet, ${tail}` : `The local model isn't available, ${tail}`;
  return "Flint's local model is still loading. Try again in a moment.";
}

/**
 * Why a private message is not answered at all, before anything is made of it;
 * undefined when it may be. The local model server is not this Mac, and Will
 * has not said it is his: a private message is never sent there, in any mode.
 * Asked where the turn is first routed, so not a word of the message has been
 * embedded, recalled against or planned with by then.
 */
export function privateRefusal(route: { mode: 'local' | 'cloud' | 'hybrid'; private: boolean }, confined: LocalBrains['confined']): string | undefined {
  if (!route.private || confined.ok) return undefined;
  return notHereSentence(confined.why, refusalTail(route));
}

/**
 * A plan for a turn that stays here (Will kept it private, or Flint is in
 * Local mode), held to the models that are KNOWN to run here. `here` is
 * ./policy brainIsLocal for the step's model: for an Ollama that is the
 * server's own word, so a cloud model copied under a plain name is not asked
 * (`elsewhere`), and neither is a model the server has not been heard on yet.
 * A step that goes is not replaced: with no local step left, the turn gets a
 * sentence, never the cloud.
 */
export function heldToHere<P>(
  plan: LocalPlan<P>,
  o: {
    route: PlanInput<P>['route'];
    here: (step: Extract<LocalStep<P>, { kind: 'local' }>) => boolean;
    elsewhere: (step: Extract<LocalStep<P>, { kind: 'local' }>) => boolean;
    allowedRemote?: boolean;
    /** The main model's health, when the plan's main step is the main model: its own sentence is said when it is not there at all. */
    main?: ModelHealth | undefined;
  },
): LocalPlan<P> {
  const locals = plan.steps.filter((s): s is Extract<LocalStep<P>, { kind: 'local' }> => s.kind === 'local');
  const out = locals.filter((s) => !o.here(s));
  if (out.length === 0) return plan;
  const kept = locals.filter((s) => !out.includes(s));
  // (The main model is not loaded for a turn that may not use it.)
  const warmPrimary = plan.warmPrimary && !out.some((s) => s.which === 'primary');
  if (kept.length > 0) return { ...plan, steps: kept, warmPrimary };
  const tail = refusalTail(o.route, o.allowedRemote);
  const refusal = out.some((s) => o.elsewhere(s))
    ? notHereSentence('cloud_model', tail)
    : // A model that is not there at all (not downloaded, not chosen yet) is said so, as for any turn that must be local.
      o.main?.state === 'unavailable'
      ? refusalFor(o.route, { ok: true }, o.main, o.allowedRemote)
      : `Flint has not confirmed yet that its local model runs on ${staysOn(o.allowedRemote)}, ${tail}`;
  return { steps: [], primaryState: plan.primaryState, warmPrimary: false, refusal };
}

/**
 * The plan for one turn's local side, from one snapshot. Pure: the caller
 * fires the warm-up it asks for.
 *
 * The cloud mode and an eval replay get the main model alone, whatever its
 * state: the cloud mode behaves as it did, and a bake-off measures the model it
 * named.
 */
export function planLocal<P>(i: PlanInput<P>): LocalPlan<P> {
  const main = i.snapshot.primary;
  // A private message never leaves this Mac, in any mode, an eval replay included: with a local model server
  // that is not this Mac (and not one Will said is his) it is not answered. In Cloud mode it used to be sent there.
  if (i.route.private && !i.confined.ok) return { steps: [], primaryState: main.state, warmPrimary: false, refusal: refusalFor(i.route, i.confined, main, i.allowedRemote) };
  const mainStep: LocalStep<P> = { kind: 'local', which: 'primary', state: main.state, ...i.primary };
  // A stand-in is never asked, in any mode. (An eval replay that names its own model is not the stand-in: `evalOwnModel`.)
  const unsettled = main.state === 'unavailable' && main.why === 'unsettled';
  if (i.route.reason === 'eval' && (!unsettled || i.evalOwnModel)) return { steps: [mainStep], primaryState: main.state, warmPrimary: false };
  if (i.route.mode === 'cloud' || i.route.reason === 'eval') {
    return unsettled ? { steps: [], primaryState: main.state, warmPrimary: false, refusal: refusalFor(i.route, i.confined, main, i.allowedRemote) } : { steps: [mainStep], primaryState: main.state, warmPrimary: false };
  }

  const cloud: LocalStep<P>[] = i.route.cloudFallback && !i.route.private ? [{ kind: 'cloud' }] : [];
  if (!i.confined.ok) return { steps: cloud, primaryState: main.state, warmPrimary: false, refusal: refusalFor(i.route, i.confined, main, i.allowedRemote) };

  const spare = i.snapshot.fallback;
  // An installed standby is used even when it is not in memory: a small model loads inside the first-token deadline.
  const standby: LocalStep<P>[] = i.standby && spare && spare.state !== 'unavailable' ? [{ kind: 'local', which: 'fallback', state: spare.state, ...i.standby }] : [];
  // (A model that is loading already has its warm-up; asking again is harmless: one runs at a time.)
  const warmPrimary = main.state === 'cold' || main.state === 'loading';

  if (isReady(main, i.now)) return { steps: [mainStep, ...standby, ...cloud], primaryState: main.state, warmPrimary: false };

  const order = i.whenCold ?? HYBRID_WHEN_COLD;
  const steps = order.flatMap((o) => (o === 'fallback' ? standby : cloud));
  // An order that leaves one out (a tuned table) still uses what it listed, and nothing else.
  return {
    steps,
    primaryState: main.state,
    warmPrimary,
    ...(standby.length === 0 || !order.includes('fallback') ? { refusal: refusalFor(i.route, i.confined, main, i.allowedRemote) } : {}),
  };
}

// ---------------------------------------------------------------------------
// running a plan

/** What a local step's turn saw, for the [route] line. Numbers and enums only. */
export interface TurnMeter {
  which: Which;
  state: LocalState;
  /** ms from the start of the step to the model's first sign of output. */
  firstTokenMs?: number;
}

const meters = new AsyncLocalStorage<TurnMeter & { startedAt: number }>();

export interface RunOptions<P> {
  signal?: AbortSignal | undefined;
  /** Has the turn shown text or called a tool? Once it has, no other step is tried. */
  progressed: () => boolean;
  /** Will asked for THIS turn to stay on this Mac: nothing a local step sets off leaves this Mac (./turn-taint isPrivateTurn). */
  private?: boolean;
  /**
   * The turn was routed as one that stays on this Mac: private, or any turn of Local mode (./private-turns
   * turnStaysHere). Nothing a local step sets off reaches an outside AI or a paid service, even if the mode is
   * changed while the turn is still running (./turn-taint isStaysHereTurn).
   */
  staysHere?: boolean;
  /**
   * Awaited before each local step is asked: has the model server been heard from lately (./inference
   * heardLately)? What it says of where its models run decides, inside the ask, what that model is handed.
   */
  heard?: () => Promise<void>;
  onMove?: (from: LocalStep<P>, to: LocalStep<P>, err: unknown) => void;
  now?: () => number;
}

export interface RunResult<P, T> {
  result: T;
  /** The step that answered. */
  step: LocalStep<P>;
  /** For a local step: which model, its state when chosen, and its time to first token. */
  meter?: TurnMeter;
  /** Steps that were tried and abandoned before the one that answered. */
  moved: number;
}

/**
 * Run the plan's steps in order until one answers. A step that fails moves on
 * only while the turn has made no progress and the failure is the provider's
 * own (./brains mayAskAnother); otherwise its error is thrown as it is. A local
 * step runs as the local model's turn (./turn-taint asLocalTurn): nothing it
 * sets off sends the question to an outside AI. A cloud step does not.
 *
 * `attempt` is told whether its step is the last, so a stream can pass a final
 * failure on to the client instead of throwing it.
 */
export async function runLocalPlan<P, T>(plan: LocalPlan<P>, attempt: (step: LocalStep<P>, last: boolean) => Promise<T>, opts: RunOptions<P>): Promise<RunResult<P, T>> {
  if (plan.steps.length === 0) throw new Error(plan.refusal ?? 'no local model can answer');
  const now = opts.now ?? Date.now;
  let lastErr: unknown;
  for (let n = 0; n < plan.steps.length; n++) {
    const step = plan.steps[n]!;
    const last = n === plan.steps.length - 1;
    // (Before the meter starts: the look is not the model's time to first token. A look that fails holds nothing up.)
    if (step.kind === 'local') await opts.heard?.().catch(() => {});
    const meter = step.kind === 'local' ? { which: step.which, state: step.state, startedAt: now() } : undefined;
    try {
      const result = meter ? await asLocalTurn(() => meters.run(meter, () => attempt(step, last)), { private: opts.private === true, staysHere: opts.staysHere === true }) : await attempt(step, last);
      return { result, step, ...(meter ? { meter: publicMeter(meter) } : {}), moved: n };
    } catch (err) {
      lastErr = err;
      const next = plan.steps[n + 1];
      if (!next || !mayAskAnother(err, { acted: opts.progressed(), signal: opts.signal })) throw err;
      opts.onMove?.(step, next, err);
    }
  }
  throw lastErr;
}

function publicMeter(m: TurnMeter & { startedAt: number }): TurnMeter {
  return { which: m.which, state: m.state, ...(m.firstTokenMs !== undefined ? { firstTokenMs: m.firstTokenMs } : {}) };
}

/** A step, for a log line: which model, by role and name. */
export function stepName<P>(step: LocalStep<P>): string {
  return step.kind === 'cloud' ? 'the cloud' : `${step.which === 'primary' ? 'the main model' : 'the standby'} ${step.model}`;
}

/**
 * The line shown with a standby model's answer (never stored as the answer):
 * why it was not the main model. One complete sentence in plain words, by the
 * rules for a note (@flint/policy noteProblems; test/notes-inventory.test.ts):
 * no parentheses, no model's id.
 */
export function standbyNote(plan: Pick<LocalPlan<unknown>, 'primaryState'>): string {
  return plan.primaryState === 'unavailable' ? 'My standby model answered this because my main model isn’t available.' : 'My standby model answered this while my main model loads.';
}

/**
 * What the [route] line says about a turn's local side: which local model
 * answered, the MAIN model's state when the turn was planned (why the standby
 * was used, when it was), its time to first token, and what the turn fell to
 * when its first choice did not answer. `cloudFirst`: the turn started on the
 * cloud and came here as its fallback.
 */
export function routeLocal<P>(
  run: Pick<RunResult<P, unknown>, 'step' | 'meter'> | undefined,
  plan: Pick<LocalPlan<P>, 'primaryState'>,
  cloudFirst: boolean,
): { local?: { which: Which; state: LocalState; firstTokenMs?: number }; fellTo?: 'fallback' | 'cloud' | 'local' } {
  if (!run) return {};
  if (run.step.kind === 'cloud') return { fellTo: 'cloud' };
  const which = run.step.which;
  return {
    local: { which, state: plan.primaryState, ...(run.meter?.firstTokenMs !== undefined ? { firstTokenMs: run.meter.firstTokenMs } : {}) },
    ...(which === 'fallback' ? { fellTo: 'fallback' as const } : cloudFirst ? { fellTo: 'local' as const } : {}),
  };
}

// ---------------------------------------------------------------------------
// what the monitor learns from turns

/** What a failed call says about the model: slow to first token, not reachable at all, or nothing in particular. */
export function observationOf(err: Pick<AiError, 'kind' | 'providerCode'>): TurnObservation['outcome'] {
  // Slow to start, slow to finish, or gone quiet half way: the model is not keeping up, whichever clock said so.
  if (err.providerCode === FIRST_TOKEN_TIMEOUT || err.providerCode === REQUEST_TIMEOUT || err.providerCode === IDLE_TIMEOUT) return 'first_token_timeout';
  // A connection that was never made carries no status; a 5xx is a server that answered.
  if (err.kind === 'provider_unavailable' && err.providerCode === undefined) return 'unreachable';
  return 'error';
}

/** One call being watched: when it was sent, and whether its first sign of output has been counted. */
interface WatchedCall {
  t0: number;
  startsTurn: boolean;
  seen: boolean;
  /** The model this call asked: the monitor is told, so a slot that changed hands meanwhile is not credited with it. */
  model: string;
}

const watchedCalls = new AsyncLocalStorage<WatchedCall>();

export interface Watcher {
  /** The adapter, watched. */
  provider(inner: ProviderAdapter): ProviderAdapter;
  /**
   * For the adapter's own "first sign of output" hook (OllamaProvider's
   * `onFirstOutput`): it runs inside the call it is about, and marks that
   * call's first token at the moment it arrives.
   */
  onFirstOutput(): void;
}

/**
 * A local model's adapter, watched: every call tells the monitor what it saw
 * (a first token and how long it took, a deadline that fired, a server that
 * could not be reached), and tells the turn it is part of its time to first
 * token. It changes nothing about the calls themselves.
 *
 * TIME TO FIRST TOKEN IS ONLY EVER A REAL ONE. `timedBy` says where it comes
 * from:
 *  - `events` (the OpenAI-compatible wire, which streams every pass): the
 *    first text or tool call a streamed call yields;
 *  - `callback` (Ollama's own API): the adapter's own hook, at the first line
 *    of a reply it reads as a stream. Its first pass with tools answers whole,
 *    so its events only come out when the whole reply is in: timed by them, a
 *    "time to first token" was the time to the LAST token.
 * A call that was not read as a stream (generate() on the OpenAI wire, any
 * whole pass in the cloud mode, where there is no deadline and so no stream)
 * still says the model answered; it records no time.
 *
 * Only a call that starts a turn is timed (not the pass after a tool result),
 * and a caller's own cancellation says nothing about the model.
 */
export function watcher(which: Which, monitor: () => Pick<LocalMonitor, 'observe'> | undefined, now: () => number = Date.now, timedBy: 'events' | 'callback' = 'events'): Watcher {
  const tell = (o: TurnObservation): void => {
    try {
      monitor()?.observe(which, o);
    } catch {
      /* the monitor's trouble is not the turn's */
    }
  };
  /** The call's first sign of output, at the moment it arrived: the turn's meter and the monitor's sample. */
  const first = (call: WatchedCall): void => {
    if (call.seen) return;
    call.seen = true;
    const meter = meters.getStore();
    if (meter && meter.which === which && meter.firstTokenMs === undefined) meter.firstTokenMs = Math.max(0, now() - meter.startedAt);
    tell({ outcome: 'ok', model: call.model, ...(call.startsTurn ? { firstTokenMs: Math.max(0, now() - call.t0) } : {}) });
  };
  /** The call answered, and nothing timed its first token: the model is there, and that is all that is known. */
  const answered = (call: WatchedCall): void => {
    if (call.seen) return;
    call.seen = true;
    tell({ outcome: 'ok', model: call.model });
  };
  const failed = (err: Pick<AiError, 'kind' | 'providerCode'>, signal: AbortSignal | undefined, model: string): void => {
    if (signal?.aborted) return;
    const outcome = observationOf(err);
    // (A connection that was never made is about the SERVER, whichever model was asked: that one is not dropped.)
    if (outcome !== 'error') tell({ outcome, ...(outcome === 'unreachable' ? {} : { model }) });
  };
  const startsTurn = (args: { messages: ReadonlyArray<{ role: string }> }): boolean => args.messages[args.messages.length - 1]?.role !== 'tool_result';
  return {
    onFirstOutput: () => {
      const call = watchedCalls.getStore();
      if (call) first(call);
    },
    provider(inner) {
      // Where the adapter's server is, and the window it asks for, stay readable through the wrapper: ./policy
      // brainOf reads them to tell a model on this Mac from one elsewhere (brainIsLocal).
      const { baseURL, numCtx } = inner as { readonly baseURL?: unknown; readonly numCtx?: unknown };
      return {
        name: inner.name,
        ...(typeof baseURL === 'string' ? { baseURL } : {}),
        ...(typeof numCtx === 'number' ? { numCtx } : {}),
        getCapabilities: (model) => inner.getCapabilities(model),
        estimateTokens: (messages, model) => inner.estimateTokens(messages, model),
        async generate(args) {
          const call: WatchedCall = { t0: now(), startsTurn: startsTurn(args), seen: false, model: args.model };
          try {
            // The adapter's hook, when it has one, fires inside this scope, at the first line.
            const out = await watchedCalls.run(call, () => inner.generate(args));
            answered(call);
            return out;
          } catch (err) {
            if (isFlintError(err)) failed(err.error, args.signal, args.model);
            throw err;
          }
        },
        async *stream(args) {
          const call: WatchedCall = { t0: now(), startsTurn: startsTurn(args), seen: false, model: args.model };
          // Each step of the inner stream runs in the call's scope, so the adapter's hook finds the call it belongs to.
          const it = watchedCalls.run(call, () => inner.stream(args)[Symbol.asyncIterator]());
          try {
            for (;;) {
              const step = await watchedCalls.run(call, () => it.next());
              if (step.done) break;
              const ev = step.value;
              if (ev.type === 'text' || ev.type === 'tool_call' || ev.type === 'done') {
                if (timedBy === 'events' && ev.type !== 'done') first(call);
                else answered(call);
              }
              if (ev.type === 'error') failed(ev.error, args.signal, args.model);
              yield ev;
            }
          } finally {
            // The consumer stopped early (a tool loop that broke out): the inner stream is closed too.
            await it.return?.(undefined);
          }
        },
      };
    },
  };
}

/** `watcher(...).provider(inner)`: an adapter watched by its events alone (tests, and a wire with no hook of its own). */
export function observed(inner: ProviderAdapter, which: Which, monitor: () => Pick<LocalMonitor, 'observe'> | undefined, now: () => number = Date.now): ProviderAdapter {
  return watcher(which, monitor, now, 'events').provider(inner);
}

// ---------------------------------------------------------------------------
// the cloud step

/**
 * The cloud tiers a hybrid turn falls through to when no local model could
 * answer it: the spend plan for the tier (./spend planFrontier), minus the
 * brains whose provider the breaker has paused (./frontier-breaker). Worked out
 * only when the step is reached, so a turn the local model answers never sets
 * off a breaker check. Undefined: no cloud brain can answer either.
 */
export function cloudChainFor<P>(i: {
  brains: BrainChooser<P> | undefined;
  tier: Tier;
  guard: BudgetView;
  breaker: Pick<FrontierBreaker, 'paused'>;
  canRead?: ((brain: BrainTier<P>) => boolean) | undefined;
}): { chain: BrainTier<P>[]; tier: Tier } | undefined {
  if (!i.brains) return undefined;
  const plan = planFrontier(i.brains, i.tier, i.guard, { canRead: i.canRead });
  const { chain } = gateChain(plan.chain, i.breaker);
  return chain.length > 0 ? { chain, tier: plan.tier } : undefined;
}
