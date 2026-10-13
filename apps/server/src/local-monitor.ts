/**
 * The local model server's health, as a turn needs to know it: for the main
 * local model and the standby, is each `loaded`, `cold`, `loading` or
 * `unavailable`.
 *
 * Why: a cold local model does not fail, it makes the turn wait while 18 GB of
 * weights load. A turn must never do that. So the monitor looks at the server
 * on a timer, off the turn's path; a turn only reads `snapshot()`, which never
 * waits and never throws, and is not sent to a model that is not ready.
 *
 * States, per model:
 *
 *   from              event                                         to
 *   any               probe: the server does not answer             unavailable (unreachable)
 *   any               probe: the model is not installed             unavailable (not_installed)
 *   any               the endpoint was refused by config            unavailable (config)
 *   unavailable       probe: installed, not in memory               cold
 *   cold              warm() (a turn needed it, or boot)            loading
 *   cold, loading     probe: in memory at the expected context      loaded
 *   loading           the warm-up failed or timed out               cold
 *   loaded            probe: not in memory, or another context      cold
 *   loaded            probe: left memory, after it answered a turn  cold, then loading: it is loaded again, once (`rewarm`)
 *   loaded            a turn timed out waiting for a first token    loading, and not ready for slowCooldownMs
 *   any               a turn could not connect                      unavailable (unreachable), every model on that server
 *   cold, loading     a turn on it got a first token                loaded
 *
 * Two rules that follow from how Ollama behaves:
 *  1. A turn is never the request that loads a cold model. Ollama drops a load
 *     whose client hangs up, so a turn that started one and then hit its
 *     deadline would throw the load away, every time. Loads are this monitor's
 *     own detached `warm()` calls.
 *  2. A warm-up asks for the same context chat will send; with another one
 *     Ollama would load the model twice. For the same reason a model that is in
 *     memory at a different context counts as `cold`, not `loaded`.
 *
 * Log lines carry the model, states and numbers. Never a server's own words.
 *
 * Kept free of index.ts so it is unit-testable (index.ts runs main() on import).
 */
import { LOCAL_MODEL_MAX_LEN, LOCAL_MODEL_RE } from './local-model';
import { WarmFailed, type LocalBackend, type ModelFacts, type ModelProbe, type ServerKind } from './local-backend';

export type LocalState = 'loaded' | 'cold' | 'loading' | 'unavailable';
/**
 * Why a model cannot be used. `unsettled`: nothing names the model and the
 * server has not said what it has, so the name held is a stand-in. A stand-in
 * is never probed for its state, warmed or asked: asking Ollama for one loads
 * it, and the next look would take it for the model Will runs.
 */
export type UnavailableWhy = 'unreachable' | 'not_installed' | 'config' | 'error' | 'unsettled';
export type Which = 'primary' | 'fallback';

export interface ModelHealth {
  model: string;
  state: LocalState;
  /** Only with `unavailable`. */
  why?: UnavailableWhy;
  /** When it entered this state. */
  since: number;
  /** When a probe last answered about it (0: never). */
  checkedAt: number;
  /** After a first-token timeout: not ready before this, even if the server says loaded. */
  slowUntil?: number;
  /** The context it is loaded with, when the server says. */
  contextLength?: number;
  /** In memory, but at a different context than Flint sends: the next turn would reload it. */
  contextMismatch?: boolean;
  /** Time to first token over the last turns it served (50 at most). */
  firstTokenMs?: { p50: number; p95: number; n: number };
  /** What the server says the model can do; undefined until it has been asked. */
  facts?: ModelFacts;
}

export interface LocalSnapshot {
  server: ServerKind | 'unknown';
  /** The server's version, when it says (Ollama). */
  version?: string;
  reachable: boolean;
  primary: ModelHealth;
  fallback?: ModelHealth;
}

/** What a turn saw of a model. Enums and numbers only. */
/** One model, however its tag is written: `Name:Latest` and `name` are the same (as ./memory-brain canonicalModel). */
const sameTag = (a: string, b: string): boolean => {
  // A tag is what follows the last ':' after the last '/', so a registry's port is not one.
  const canon = (m: string): string => {
    const t = m.trim().toLowerCase();
    return t.lastIndexOf(':') > t.lastIndexOf('/') ? t : `${t}:latest`;
  };
  return canon(a) === canon(b);
};

export interface TurnObservation {
  outcome: 'ok' | 'first_token_timeout' | 'unreachable' | 'error';
  firstTokenMs?: number;
  /**
   * The model the call was made to. A slot can be given another model while a
   * turn is still running (the tier's model lands behind the boot, the mode
   * changes): what that turn saw is about the model it asked, not the one the
   * slot holds now, so an observation that names another model is dropped.
   * Left out: about whatever the slot holds (tests).
   */
  model?: string;
}

export interface MonitorDeps {
  /** Undefined when config refused the endpoint: every model is `unavailable (config)`. */
  backend: LocalBackend | undefined;
  primary: string;
  /** False while the main model is a stand-in (see UnavailableWhy `unsettled`). Default true. */
  primarySettled?: boolean;
  fallback?: string;
  /** The context each model is asked for (the native wire's num_ctx). Undefined: any loaded context counts. */
  numCtx?: { primary?: number; fallback?: number };
  intervalMs: number;
  probeTimeoutMs?: number;
  warmTimeoutMs?: number;
  slowCooldownMs?: number;
  /**
   * May the main model be loaded again when a probe finds it has left memory?
   * Read each time (the local and hybrid modes say yes; the cloud mode loads
   * nothing ahead of a turn). Ollama unloads a model after its keep-alive (5
   * minutes unless OLLAMA_KEEP_ALIVE says otherwise), so without this the first
   * message after any break was answered by the standby. It is done ONCE per
   * departure, and only for a model that has answered a turn since it was last
   * loaded this way: a short break ends on the main model, and a long one does
   * not become a reload every five minutes for as long as nobody is there.
   */
  rewarm?: () => boolean;
  /**
   * May this model be loaded ahead of a turn at all? Asked at every warm-up.
   * No for a model the server says runs somewhere else (a cloud model under a
   * plain name): Flint never asks it for a turn that stays here, and a load
   * with no prompt would still be a request to wake it. Left out: yes.
   */
  mayWarm?: (model: string) => boolean;
  now?: () => number;
  log?: (msg: string) => void;
}

const PROBE_TIMEOUT_MS = 2_000;
const WARM_TIMEOUT_MS = 300_000;
const SLOW_COOLDOWN_MS = 30_000;
const SAMPLES = 50;

/** Is this model ready for a turn right now? Loaded, and not inside its slow cool-down. */
export function isReady(h: ModelHealth | undefined, now: number): boolean {
  return !!h && h.state === 'loaded' && !(h.slowUntil !== undefined && h.slowUntil > now);
}

/**
 * The command that downloads a model, for Will to run: Flint never runs it.
 * Only for a name made of the characters model tags use; anything else gets no
 * command at all rather than a line someone might paste.
 */
export function pullCommand(model: string): string | undefined {
  const m = model.trim();
  if (!m || m.length > LOCAL_MODEL_MAX_LEN || !LOCAL_MODEL_RE.test(m)) return undefined;
  return `ollama pull ${m}`;
}

/** What the monitor is pointed at: `retarget` moves it when the local brain is settled or swapped. */
export interface MonitorTarget {
  backend: LocalBackend | undefined;
  primary: { model: string; numCtx?: number | undefined; settled: boolean };
  fallback?: { model: string; numCtx?: number | undefined } | undefined;
}

interface Slot {
  which: Which;
  /** False for a stand-in: pinned to `unavailable (unsettled)`. */
  settled: boolean;
  health: ModelHealth;
  numCtx: number | undefined;
  /** A warm-up of this model is in flight. */
  warming: boolean;
  samples: number[];
  /** The pull command was logged for this spell of not_installed. */
  toldPull: boolean;
  describing: boolean;
  /** It has answered a turn since the monitor last loaded it again on its own (see MonitorDeps.rewarm). */
  servedSinceRewarm: boolean;
}

export class LocalMonitor {
  private backend: LocalBackend | undefined;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private slots: Slot[];
  private reachable = false;
  private version: string | undefined;
  private inFlight: Promise<LocalSnapshot> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastCheckAt = 0;
  /** Set by `close()`: nothing is asked of the server again. */
  private closed = false;

  constructor(private readonly deps: MonitorDeps) {
    this.backend = deps.backend;
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? (() => {});
    this.slots = [this.newSlot('primary', deps.primary, deps.numCtx?.primary, deps.primarySettled !== false)];
    if (deps.fallback) this.slots.push(this.newSlot('fallback', deps.fallback, deps.numCtx?.fallback, true));
  }

  /** A model nobody has looked at yet: unavailable until a probe says otherwise (`checkedAt` 0 means "not looked at"). */
  private newSlot(which: Which, model: string, numCtx: number | undefined, settled: boolean): Slot {
    return {
      which,
      settled,
      numCtx,
      warming: false,
      samples: [],
      toldPull: false,
      describing: false,
      servedSinceRewarm: false,
      health: { model, state: 'unavailable', why: !this.backend ? 'config' : !settled ? 'unsettled' : 'unreachable', since: this.now(), checkedAt: 0 },
    };
  }

  /**
   * Follow the local brain: another server, another model, another context.
   * A slot whose model, context and settledness are unchanged keeps everything
   * it knows; any other starts over, as a model nobody has looked at. The
   * caller looks again (`check`) when it wants the new state.
   */
  retarget(next: MonitorTarget): void {
    const backendChanged = next.backend !== this.backend;
    this.backend = next.backend;
    if (backendChanged) {
      this.reachable = false;
      this.version = undefined;
    }
    const keep = (which: Which, model: string, numCtx: number | undefined, settled: boolean): Slot => {
      const old = this.slot(which);
      if (old && !backendChanged && old.health.model === model && old.numCtx === numCtx && old.settled === settled) return old;
      return this.newSlot(which, model, numCtx, settled);
    };
    const slots = [keep('primary', next.primary.model, next.primary.numCtx, next.primary.settled)];
    if (next.fallback) slots.push(keep('fallback', next.fallback.model, next.fallback.numCtx, true));
    if (!backendChanged && slots.length === this.slots.length && slots.every((s, i) => s === this.slots[i])) return;
    this.slots = slots;
    // A probe in flight was asked about what the monitor held before: its answer is dropped (probeOnce), and the next look is a fresh one.
    this.inFlight = undefined;
    this.lastCheckAt = 0;
    if (!this.backend) this.stop();
  }

  /** What a turn reads. Never awaits, never throws. A copy: later changes do not reach it. */
  snapshot(): LocalSnapshot {
    const copy = (s: Slot): ModelHealth => ({ ...s.health, ...(s.health.facts ? { facts: { ...s.health.facts } } : {}), ...(s.health.firstTokenMs ? { firstTokenMs: { ...s.health.firstTokenMs } } : {}) });
    const fallback = this.slots[1];
    return {
      server: this.backend?.kind ?? 'unknown',
      ...(this.version ? { version: this.version } : {}),
      reachable: this.reachable,
      primary: copy(this.slots[0]!),
      ...(fallback ? { fallback: copy(fallback) } : {}),
    };
  }

  /** What the server said a model can do, or undefined when it has not been asked (or does not say). */
  facts(model: string): ModelFacts | undefined {
    return this.slots.find((s) => s.health.model === model)?.health.facts;
  }

  /** The context a model is in memory with, when the server says; undefined when it is not loaded or does not say. */
  contextLength(model: string): number | undefined {
    return this.slots.find((s) => s.health.model === model)?.health.contextLength;
  }

  /** One probe now (boot, status). Probes never overlap: a second caller gets the one in flight. */
  check(): Promise<LocalSnapshot> {
    if (!this.backend || this.closed) return Promise.resolve(this.snapshot());
    if (!this.inFlight) {
      const probe: Promise<LocalSnapshot> = this.probeOnce().finally(() => {
        if (this.inFlight === probe) this.inFlight = undefined;
      });
      this.inFlight = probe;
    }
    return this.inFlight;
  }

  /** A check nobody waits for, at most once per probe timeout: for a caller that found something missing. */
  checkSoon(): void {
    if (!this.backend || this.inFlight) return;
    if (this.now() - this.lastCheckAt < (this.deps.probeTimeoutMs ?? PROBE_TIMEOUT_MS)) return;
    void this.check().catch(() => {});
  }

  /** Probe on a timer. The timer never keeps the process alive, and a slow probe is not doubled up. */
  start(): void {
    if (this.timer || !this.backend || this.closed) return;
    this.timer = setInterval(() => void this.check().catch(() => {}), this.deps.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  get running(): boolean {
    return this.timer !== undefined;
  }

  /**
   * For good: the timer stops, and no probe or warm-up is started again, by a
   * timer, a turn or a callback that was already on its way. (A server being
   * shut down, a test: what was asked before this may still answer.)
   */
  close(): void {
    this.closed = true;
    this.stop();
  }

  /**
   * Ask the server to load a model, detached from any turn: nothing awaits it.
   * At most one per model at a time, and only for a model that is there to load.
   */
  warm(which: Which): void {
    const s = this.slot(which);
    const backend = this.backend;
    if (!s || !backend || s.warming || !s.settled || this.closed) return;
    if (s.health.state === 'unavailable') return;
    if (this.deps.mayWarm?.(s.health.model) === false) return;
    if (s.health.state === 'loaded' && !this.slow(s)) return;
    s.warming = true;
    if (s.health.state === 'cold') this.to(s, 'loading', undefined, 'warm-up started');
    const started = this.now();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.deps.warmTimeoutMs ?? WARM_TIMEOUT_MS);
    timer.unref?.();
    void backend
      .warm(s.health.model, { ...(s.numCtx !== undefined ? { numCtx: s.numCtx } : {}), signal: ac.signal })
      .then(
        () => {
          s.warming = false;
          if (!this.slots.includes(s)) return; // the monitor follows another model now
          // A server that cannot say what is in memory was just made to answer: that is loaded.
          if (backend.kind === 'openai' && s.health.state !== 'unavailable') this.to(s, 'loaded', undefined, `${this.now() - started} ms`);
          else void this.check().catch(() => {});
        },
        (err: unknown) => {
          s.warming = false;
          if (!this.slots.includes(s)) return;
          const why = ac.signal.aborted ? 'timed out' : err instanceof WarmFailed ? `status ${err.status}` : 'failed';
          if (s.health.state === 'loading') this.to(s, 'cold', undefined, `warm-up ${why}`);
        },
      )
      .finally(() => clearTimeout(timer));
  }

  /** What a turn saw: its first-token time, or how it failed. */
  observe(which: Which, e: TurnObservation): void {
    const s = this.slot(which);
    if (!s || !s.settled) return;
    // A turn that began on the model this slot held before: it says nothing about the one it holds now.
    if (e.model !== undefined && !sameTag(e.model, s.health.model)) return;
    if (e.outcome === 'ok') {
      s.servedSinceRewarm = true;
      if (e.firstTokenMs !== undefined && Number.isFinite(e.firstTokenMs) && e.firstTokenMs >= 0) {
        s.samples.push(Math.round(e.firstTokenMs));
        if (s.samples.length > SAMPLES) s.samples.shift();
        s.health.firstTokenMs = percentiles(s.samples);
      }
      if (s.health.state === 'cold' || s.health.state === 'loading') this.to(s, 'loaded', undefined, 'a turn got a first token');
      return;
    }
    if (e.outcome === 'first_token_timeout') {
      s.health.slowUntil = this.now() + (this.deps.slowCooldownMs ?? SLOW_COOLDOWN_MS);
      if (s.health.state !== 'unavailable') {
        if (s.health.state !== 'loading') this.to(s, 'loading', undefined, 'slow to first token');
        this.warm(which);
      }
      return;
    }
    if (e.outcome === 'unreachable') {
      // The connection was never made: that is the server, so every model on it is out of reach.
      this.reachable = false;
      for (const each of this.slots) if (each.settled) this.to(each, 'unavailable', 'unreachable');
    }
  }

  // --- internals ------------------------------------------------------------

  private slot(which: Which): Slot | undefined {
    return this.slots.find((s) => s.which === which);
  }

  private slow(s: Slot): boolean {
    return s.health.slowUntil !== undefined && s.health.slowUntil > this.now();
  }

  private async probeOnce(): Promise<LocalSnapshot> {
    const backend = this.backend!;
    const asked = this.slots;
    this.lastCheckAt = this.now();
    const signal = AbortSignal.timeout(this.deps.probeTimeoutMs ?? PROBE_TIMEOUT_MS);
    let result: Awaited<ReturnType<LocalBackend['probe']>>;
    try {
      result = await backend.probe(this.slots.filter((s) => s.settled).map((s) => s.health.model), signal);
    } catch {
      result = { reachable: false, models: {} };
    }
    // The monitor was pointed elsewhere while this was in flight: what came back is about something else.
    if (backend !== this.backend || asked !== this.slots) return this.snapshot();
    this.reachable = result.reachable;
    this.version = result.version ?? this.version;
    const t = this.now();
    for (const s of this.slots) {
      s.health.checkedAt = t;
      // A stand-in stays what it is, whatever the server has under that name.
      if (!s.settled) continue;
      if (!result.reachable) {
        this.to(s, 'unavailable', 'unreachable');
        continue;
      }
      this.apply(s, result.models[s.health.model] ?? {});
    }
    await this.describeMissing(backend);
    // What a model can hold may have just been learned (its own maximum context): a model that looked
    // loaded "at another context" is looked at again with it, before anyone reads the state.
    if (result.reachable && backend === this.backend && asked === this.slots) {
      for (const s of this.slots) if (s.settled && s.health.contextMismatch) this.apply(s, result.models[s.health.model] ?? {});
    }
    return this.snapshot();
  }

  /** One model's row of a probe, turned into a state. */
  private apply(s: Slot, p: ModelProbe): void {
    if (p.installed === false) {
      this.to(s, 'unavailable', 'not_installed');
      return;
    }
    s.toldPull = false;
    if (p.contextLength !== undefined) s.health.contextLength = p.contextLength;
    else if (p.loaded === false) delete s.health.contextLength;
    // The context Flint asks for, as the server will really give it: Ollama clamps num_ctx to the model's own
    // maximum (its /api/show `context_length`). Compared with the number asked, a model whose maximum is below
    // it was "in memory at another context" for good: cold, warmed, loaded at its maximum, cold again.
    const most = s.health.facts?.contextLength;
    const expected = s.numCtx === undefined ? undefined : most !== undefined ? Math.min(s.numCtx, most) : s.numCtx;
    const mismatch = p.loaded === true && expected !== undefined && p.contextLength !== undefined && p.contextLength !== expected;
    if (mismatch) s.health.contextMismatch = true;
    else delete s.health.contextMismatch;

    if (p.loaded === true && !mismatch) {
      this.to(s, 'loaded', undefined, p.contextLength !== undefined ? `context ${p.contextLength}` : undefined);
      return;
    }
    if (p.loading === true || s.warming) {
      this.to(s, 'loading');
      return;
    }
    if (p.loaded === undefined) {
      // The server cannot say what is in memory: what a turn (or a warm-up) last saw stands.
      if (s.health.state === 'unavailable') this.to(s, 'cold');
      return;
    }
    const wasLoaded = s.health.state === 'loaded';
    this.to(s, 'cold', undefined, mismatch ? `loaded at context ${p.contextLength}, not ${expected}` : undefined);
    // It was in memory and has left (Ollama's keep-alive ran out, or something pushed it out): the main model
    // is loaded again, once, when it has answered a turn since the last time this was done (MonitorDeps.rewarm).
    if (wasLoaded && !mismatch && s.which === 'primary' && s.servedSinceRewarm && this.deps.rewarm?.() === true) {
      s.servedSinceRewarm = false;
      this.warm('primary');
    }
  }

  /** Ask the server what a model can do, once it is there to ask about. */
  private async describeMissing(backend: LocalBackend): Promise<void> {
    await Promise.all(
      this.slots
        .filter((s) => s.health.facts === undefined && !s.describing && s.health.state !== 'unavailable')
        .map(async (s) => {
          s.describing = true;
          try {
            const facts = await backend.describe(s.health.model, AbortSignal.timeout(this.deps.probeTimeoutMs ?? PROBE_TIMEOUT_MS));
            if (facts) s.health.facts = facts;
          } catch {
            /* asked again on the next probe */
          } finally {
            s.describing = false;
          }
        }),
    );
  }

  /** Move a model to a state, with one log line per change (and the pull command once, when it is missing). */
  private to(s: Slot, state: LocalState, why?: UnavailableWhy, note?: string): void {
    const h = s.health;
    const said = this.logged.has(s);
    const same = h.state === state && h.why === why;
    if (same && said) return;
    const words = (st: LocalState, w: UnavailableWhy | undefined): string => (st === 'unavailable' ? `unavailable (${w ?? 'error'})` : st);
    const was = words(h.state, h.why);
    const extra = note ? [note] : [];
    // How long the load took, when this is the end of one.
    if (!same && h.state === 'loading' && state === 'loaded') extra.push(`${Math.max(0, this.now() - h.since)} ms`);
    if (!same) {
      h.state = state;
      h.since = this.now();
      if (why) h.why = why;
      else delete h.why;
    }
    this.logged.add(s);
    const name = s.which === 'primary' ? 'primary' : 'standby';
    let line = `[local] ${name} ${h.model}: ${said ? `${was} -> ${words(state, why)}` : words(state, why)}${extra.length ? ` (${extra.join(', ')})` : ''}`;
    if (state === 'unavailable' && why === 'not_installed' && !s.toldPull && this.backend?.kind === 'ollama') {
      const cmd = pullCommand(h.model);
      if (cmd) line += `. To download it, run: ${cmd}`;
      s.toldPull = true;
    }
    this.log(line);
  }

  /** Models whose state has been logged at least once (the first line has no arrow). */
  private readonly logged = new Set<Slot>();
}

function percentiles(samples: readonly number[]): { p50: number; p95: number; n: number } {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!;
  return { p50: at(0.5), p95: at(0.95), n: sorted.length };
}
