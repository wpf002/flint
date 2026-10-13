/**
 * Local-model override for eval bake-offs (apps/parity `--local-model`).
 *
 * To compare candidate local models through Flint's real pipeline (persona,
 * tools, memory context) without touching the live server's OLLAMA_MODEL or
 * restarting it, an eval request may name the Ollama model to answer with:
 *
 *   POST /generate { prompt, eval: true, localOnly: true, localModel: "qwen3:14b" }
 *
 * The override is accepted ONLY together with `eval: true` (so the answer never
 * reaches the training corpus or long-term memory) and `localOnly: true` (so it
 * never silently turns into a frontier answer). Anything else is a 400. Normal
 * traffic never carries the field, and a request without it is untouched.
 *
 * It may also carry `localThink: boolean` (apps/parity `--local-think on|off`),
 * Ollama's `think` flag for that candidate. Thinking models (qwen3.8,
 * muse-glimmer) reason by default, which is most of their answer time; this is
 * how a bake-off measures them with it off. Accepted only with a valid
 * `localModel`. Leaving it out sends no `think` field, the model's own default.
 */
import { DEFAULT_OLLAMA_MODEL, OllamaProvider, isOllamaCloudModel, pickOllamaModel, type OllamaProviderOptions, type PickedOllamaModel } from '@flint/core';
import { errorSummary } from './error-log';
import type { StyleVariant } from './style-variant';

/** Ollama model names: `name`, `name:tag`, `namespace/name:tag`, `hf.co/org/repo:Q4_K_M`. */
export const LOCAL_MODEL_RE = /^[a-z0-9._:\-/]+$/i;
export const LOCAL_MODEL_MAX_LEN = 100;

export type LocalModelRequest =
  | { ok: true; model: string | undefined; think: boolean | undefined }
  | { ok: false; status: 400; error: string };

/**
 * Validate the override fields of a /generate body. `model` is undefined when no
 * override was asked for; `think` is undefined unless `localThink` was sent.
 */
export function parseLocalModelRequest(body: Record<string, unknown>): LocalModelRequest {
  const raw = body.localModel;
  const rawThink = body.localThink;
  const hasThink = rawThink !== undefined && rawThink !== null;
  if (raw === undefined || raw === null) {
    if (hasThink) return { ok: false, status: 400, error: 'localThink is only accepted with localModel' };
    return { ok: true, model: undefined, think: undefined };
  }
  if (typeof raw !== 'string') return { ok: false, status: 400, error: 'localModel must be a string' };
  const model = raw.trim();
  if (!model || model.length > LOCAL_MODEL_MAX_LEN || !LOCAL_MODEL_RE.test(model)) {
    return { ok: false, status: 400, error: `localModel must match ${String(LOCAL_MODEL_RE)} and be at most ${LOCAL_MODEL_MAX_LEN} chars` };
  }
  // A bake-off candidate is a model on this Mac. An Ollama cloud tag is a pointer to Ollama's servers: asked
  // through "localModel" it would be an outside AI answering as the local brain, under localOnly.
  if (isOllamaCloudModel(model)) return { ok: false, status: 400, error: "localModel must be a model on this Mac: an Ollama cloud model runs on Ollama's servers" };
  if (hasThink && typeof rawThink !== 'boolean') return { ok: false, status: 400, error: 'localThink must be a boolean' };
  if (body.eval !== true) return { ok: false, status: 400, error: 'localModel is only accepted with eval: true' };
  if (body.localOnly !== true) return { ok: false, status: 400, error: 'localModel requires localOnly: true' };
  return { ok: true, model, think: hasThink ? (rawThink as boolean) : undefined };
}

/**
 * The live local brain's `think` flag, from OLLAMA_THINK: "true" or "false"
 * (case and surrounding space ignored). Unset or anything else is undefined, so
 * the provider sends no `think` field and behaves exactly as before.
 *
 * Don't set "true" for a model that can't think: Ollama answers `think: true`
 * on qwen2.5 with HTTP 400 "does not support thinking", on every turn. "false"
 * is a harmless no-op there.
 */
export function parseOllamaThink(raw: string | undefined): boolean | undefined {
  const v = raw?.trim().toLowerCase();
  if (v === 'true') return true;
  if (v === 'false') return false;
  return undefined;
}

/** `{ think }` for OllamaProviderOptions, or nothing at all when it's unset. */
export function thinkOption(think: boolean | undefined): Pick<OllamaProviderOptions, 'think'> {
  return think === undefined ? {} : { think };
}

/**
 * The live local brain's Ollama client (buildProvider in index.ts): OLLAMA_HOST,
 * OLLAMA_NUM_CTX and OLLAMA_THINK.
 */
export function liveOllamaOptions(env: Record<string, string | undefined>): OllamaProviderOptions {
  return {
    baseURL: env.OLLAMA_HOST ?? 'http://127.0.0.1:11434',
    // IMPORTANT: keep num_ctx at 4096. Above ~6k, qwen2.5:14b's native
    // tool-calling silently breaks — the model returns an EMPTY turn instead
    // of emitting tool_calls (verified by bisection). 4096 keeps tool-calling
    // reliable; the trade-off is a tighter window (curate the tool set so the
    // prompt + tool results fit).
    defaultOptions: { num_ctx: Number(env.OLLAMA_NUM_CTX ?? 4096) },
    // OLLAMA_THINK=true|false sets Ollama's `think`; unset sends nothing (as before).
    ...thinkOption(parseOllamaThink(env.OLLAMA_THINK)),
  };
}

/** The local brain main() builds: its Ollama client's options, its model, and where the model's name came from. */
export interface LocalBrain {
  options: OllamaProviderOptions;
  model: string;
  /** `env`: OLLAMA_MODEL. Otherwise Ollama was asked: the chat model it had loaded, the first it had pulled, or the default. */
  from: 'env' | PickedOllamaModel['from'];
  /**
   * What was settled here, as the env the rest of the server reads: the model,
   * and the context size when it was taken from a loaded model. Memory
   * extraction and background calls read these, so they ask the same model
   * with the same window and Ollama never reloads it between them and chat.
   */
  env: { OLLAMA_MODEL: string; OLLAMA_NUM_CTX?: string };
  /**
   * False only when the model is the default BECAUSE Ollama did not answer: a
   * stand-in until it does (keepPickingLocal), not a choice. True for a named
   * model, a picked one, and the default when Ollama answered with none to offer.
   */
  settled: boolean;
}

/**
 * The longest the pick may take, by the clock. Its two list calls are cut off at 2 s each, so
 * this is never reached by an Ollama that is merely down or slow; it is there so that nothing
 * Ollama does (a reply that trickles in, a socket that never closes) can hold the server's boot.
 */
export const LOCAL_PICK_CAP_MS = 5_000;

/** How often an Ollama that did not answer at boot is asked again, in the background: every 5 s for the first minute, then every 30 s. */
export const LOCAL_REPICK_FAST_MS = 5_000;
export const LOCAL_REPICK_SLOW_MS = 30_000;
export const LOCAL_REPICK_FAST_TRIES = 12;

/**
 * The local brain. It is always Ollama, and always a model on this Ollama:
 *  - OLLAMA_MODEL names it. An Ollama cloud model (`...-cloud`, `:cloud`) is
 *    refused: it runs on Ollama's servers, which is an outside AI by another
 *    door. The pick below is used in its place, and the log says so.
 *  - Unset, Ollama is asked which it has (@flint/core pickOllamaModel: the chat
 *    model already loaded, else the first one pulled, else DEFAULT_OLLAMA_MODEL).
 *    A loaded model keeps the context size it is loaded with, unless
 *    OLLAMA_NUM_CTX says otherwise, so the pick does not make Ollama reload it.
 *
 * It asks ONCE and never waits: two list calls, each cut off at 2 s, and the
 * whole pick at LOCAL_PICK_CAP_MS by the clock, so the server is listening
 * within seconds whatever Ollama is doing (the installer polls /health, and a
 * boot that waited for Ollama failed the deploy). When Ollama does not answer
 * (both start at login, and it may be a few seconds behind), the result is the
 * default model with `settled: false`: a stand-in. main() holds its name and
 * never asks for it (asking would make Ollama load it, and the next pick would
 * then take it for the model Will runs: local turns get a sentence instead, and
 * the background gate has no local model); keepPickingLocal swaps in Ollama's
 * own answer for the next turn.
 *
 * It used to become Anthropic's claude-sonnet-4-6 whenever OLLAMA_MODEL was
 * unset and a key was present: a missing setting quietly sent every "local"
 * answer, the private ones included, to an outside AI. No key changes it now,
 * and FLINT_MODEL, which named that model, is no longer read (said once at boot).
 */
export async function chooseLocalBrain(
  env: Record<string, string | undefined>,
  deps: {
    fetch?: typeof fetch;
    log?: (msg: string) => void;
    capMs?: number;
    /** What to settle for when Ollama offers nothing, in place of DEFAULT_OLLAMA_MODEL: this machine's hardware tier's model (./local-brains). */
    defaultModel?: string;
    /** Models never to pick (./local-brains: the standby is in Ollama's memory too, and is not the model Will runs). */
    skip?: (name: string) => boolean;
  } = {},
): Promise<LocalBrain> {
  const log = deps.log ?? (() => {});
  const options = liveOllamaOptions(env);
  if (env.FLINT_MODEL?.trim()) log('[brain] FLINT_MODEL is no longer read: the local brain is always an Ollama model (OLLAMA_MODEL)');
  let named = env.OLLAMA_MODEL?.trim();
  if (named && isOllamaCloudModel(named)) {
    log('[brain] OLLAMA_MODEL is an Ollama cloud model, which runs on Ollama\'s servers: it is not used as the local brain');
    named = undefined;
  }
  if (named) return { options, model: named, from: 'env', env: { OLLAMA_MODEL: named }, settled: true };

  let cap: ReturnType<typeof setTimeout> | undefined;
  let picked = await Promise.race([
    pickOllamaModel({ ...(options.baseURL ? { baseURL: options.baseURL } : {}), ...(deps.fetch ? { fetch: deps.fetch } : {}), ...(deps.skip ? { skip: deps.skip } : {}) }),
    // Out of time is the same answer as no answer: the stand-in default, asked again in the background.
    new Promise<PickedOllamaModel>((resolve) => {
      cap = setTimeout(() => resolve({ model: DEFAULT_OLLAMA_MODEL, from: 'default', answered: false }), deps.capMs ?? LOCAL_PICK_CAP_MS);
    }),
  ]).finally(() => clearTimeout(cap));
  if (picked.from === 'default' && deps.defaultModel) picked = { ...picked, model: deps.defaultModel };
  // A name the SERVER supplied is printed only when it is a model's name. Anything else (a line break, colour
  // codes, a forged log line) is described, never repeated: the caller refuses such a name next (./local-brains).
  const plain = picked.model.length <= LOCAL_MODEL_MAX_LEN && LOCAL_MODEL_RE.test(picked.model);
  log(
    picked.from !== 'default'
      ? plain
        ? `[brain] OLLAMA_MODEL is unset: the local brain is ${picked.model}, which Ollama has ${picked.from} (set OLLAMA_MODEL to choose another)`
        : `[brain] OLLAMA_MODEL is unset: Ollama has a model ${picked.from} whose name is not a model name, so it is not printed (set OLLAMA_MODEL to choose one)`
      : picked.answered
        ? `[brain] OLLAMA_MODEL is unset and Ollama listed no chat model: the local brain is ${picked.model} until the next restart (run "ollama pull ${picked.model}", or set OLLAMA_MODEL)`
        : `[brain] OLLAMA_MODEL is unset and Ollama is not answering: no local model is chosen yet, so local turns wait, and Ollama is asked again in the background (${picked.model} is held as a stand-in, and is never asked)`,
  );
  // A loaded model is asked with the window it is loaded with, unless Will set one.
  const numCtx = env.OLLAMA_NUM_CTX?.trim() ? undefined : picked.numCtx;
  return {
    options: numCtx === undefined ? options : { ...options, defaultOptions: { ...options.defaultOptions, num_ctx: numCtx } },
    model: picked.model,
    from: picked.from,
    env: { OLLAMA_MODEL: picked.model, ...(numCtx !== undefined ? { OLLAMA_NUM_CTX: String(numCtx) } : {}) },
    settled: picked.from !== 'default' || picked.answered,
  };
}

/**
 * Keep asking an Ollama that did not answer at boot, in the background, and
 * hand its answer to `adopt` once: the local brain for the NEXT turn (a turn
 * already running finishes on the one it started with). Nothing waits on this:
 * the server is up and answering on the stand-in default meanwhile. The timer
 * does not keep the process alive, and `stop()` ends it.
 */
export function keepPickingLocal<B extends { settled: boolean; from: string; model: string } = LocalBrain>(
  env: Record<string, string | undefined>,
  adopt: (brain: B) => void,
  deps: {
    fetch?: typeof fetch;
    log?: (msg: string) => void;
    wait?: (ms: number) => Promise<void>;
    /** How the model is chosen, in place of chooseLocalBrain: ./local-brains asks with its own guarded fetch and the tier's model first. */
    choose?: () => Promise<B>;
  } = {},
): { stop: () => void; done: Promise<void> } {
  let stopped = false;
  const wait =
    deps.wait ??
    ((ms: number) =>
      new Promise<void>((r) => {
        setTimeout(r, ms).unref?.();
      }));
  const done = (async () => {
    for (let tries = 0; !stopped; tries++) {
      await wait(tries < LOCAL_REPICK_FAST_TRIES ? LOCAL_REPICK_FAST_MS : LOCAL_REPICK_SLOW_MS);
      if (stopped) return;
      // Quiet: one line when it settles, not one for every time Ollama still is not there.
      const next = deps.choose ? await deps.choose() : ((await chooseLocalBrain(env, deps.fetch ? { fetch: deps.fetch } : {})) as unknown as B);
      if (!next.settled) continue;
      (deps.log ?? (() => {}))(
        next.from === 'default'
          ? `[brain] Ollama is answering now and lists no chat model: the local brain stays ${next.model} (run "ollama pull ${next.model}", or set OLLAMA_MODEL)`
          : `[brain] Ollama is answering now: the local brain is ${next.model}, which it has ${next.from}; the next turn uses it`,
      );
      // An adopt that throws must not become an unhandled rejection, which ends the process: the brain
      // Flint had stays, and the log says so by the error's class only.
      try {
        adopt(next);
      } catch (err) {
        (deps.log ?? (() => {}))(`[brain] the model that was settled could not be adopted, so the one in use stays (${errorSummary(err)})`);
      }
      return;
    }
  })().catch((err: unknown) => {
    // Nothing in the loop is meant to throw (the pick never does); if something does, it ends here, not in the process.
    (deps.log ?? (() => {}))(`[brain] asking the model server again stopped (${errorSummary(err)})`);
  });
  return { stop: () => void (stopped = true), done };
}

/**
 * The console note when the local brain is the fallback default: nothing was
 * set and Ollama had nothing to offer. Written to Will's rules for a note
 * (2026-10-12): no internal name, so neither the model's id nor the setting's.
 * The boot log has both, and says what to run (`[brain] OLLAMA_MODEL is unset
 * and Ollama listed no chat model: ...`).
 */
export function localDefaultNote(): { title: string; body: string } {
  return {
    title: 'Flint Is Guessing Its Local Model',
    body: 'No local model is set, and Ollama has none to offer, so Flint is trying a small default. The server log says how to choose one.',
  };
}

/**
 * The OllamaProvider for override personas. Candidates get a larger context
 * window than the live 4096 (FLINT_EVAL_NUM_CTX, default 16384): Flint's prompt
 * is ~2k tokens, and thinking models (qwen3.8, muse-glimmer) spend more on
 * reasoning. At 4096 Ollama silently drops the oldest tokens (the persona and
 * tool schemas), so the bake-off would measure truncation, not the model.
 */
export function evalOllamaOptions(env: Record<string, string | undefined>, think: boolean | undefined): OllamaProviderOptions {
  return {
    baseURL: env.OLLAMA_HOST ?? 'http://127.0.0.1:11434',
    defaultOptions: { num_ctx: Number(env.FLINT_EVAL_NUM_CTX ?? 16384) },
    ...thinkOption(think),
  };
}

/**
 * Cache key for one override. Model names can't contain `~` or `#`
 * (LOCAL_MODEL_RE), so the suffixes are unambiguous; no `think` and no style
 * variant keeps the bare model name.
 */
export function overrideKey(model: string, think: boolean | undefined, variant?: StyleVariant): string {
  const base = think === undefined ? model : `${model}~${think ? 'think' : 'nothink'}`;
  return variant === undefined ? base : `${base}#${variant}`;
}

/**
 * One persona per override (model, think, style variant), built on first use and
 * reused after that. Bounded (least-recently-used out) so a long bake-off across
 * many candidates can't grow it without limit; a persona is cheap to rebuild.
 * The variant (./style-variant) is the style guide the persona is built with;
 * main() always passes one.
 */
export class LocalPersonaCache<P> {
  private readonly byKey = new Map<string, P>();

  constructor(
    private readonly make: (model: string, think: boolean | undefined, variant: StyleVariant | undefined) => P,
    private readonly max = 8,
  ) {}

  get(model: string, think?: boolean, variant?: StyleVariant): P {
    const key = overrideKey(model, think, variant);
    const hit = this.byKey.get(key);
    if (hit !== undefined) {
      this.byKey.delete(key); // refresh recency
      this.byKey.set(key, hit);
      return hit;
    }
    const p = this.make(model, think, variant);
    this.byKey.set(key, p);
    while (this.byKey.size > this.max) {
      const oldest = this.byKey.keys().next().value as string;
      this.byKey.delete(oldest);
    }
    return p;
  }

  get size(): number {
    return this.byKey.size;
  }
}

/** One cached override: the persona, and the `think` its Ollama client was built with. */
export interface OverridePersona<P> {
  persona: P;
  /** What the persona's OllamaProvider sends as `think`; undefined means it sends none. */
  think: boolean | undefined;
}

/**
 * The override cache main() builds: for each (model, think, variant), `build`
 * wraps a new OllamaProvider made from evalOllamaOptions(env, think) in a persona
 * with that variant's style guide. Each entry records the `think` that provider
 * was actually given, and /generate echoes that (not the request), so
 * apps/parity's echo check fails if the flag is lost on the way to Ollama.
 */
export function overridePersonaCache<P>(
  env: Record<string, string | undefined>,
  build: (provider: OllamaProvider, model: string, variant: StyleVariant | undefined) => P,
  opts: { fetch?: typeof fetch; max?: number } = {},
): LocalPersonaCache<OverridePersona<P>> {
  return new LocalPersonaCache((model, think, variant) => {
    const options: OllamaProviderOptions = { ...evalOllamaOptions(env, think), ...(opts.fetch ? { fetch: opts.fetch } : {}) };
    return { persona: build(new OllamaProvider(options), model, variant), think: options.think };
  }, opts.max);
}

/**
 * Which persona and model label answer a /generate turn. Without an override
 * it's `base`: the server's own local persona (in the turn's style variant; the
 * live one by default), exactly as before. With one, the cached override persona
 * for (model, think, variant), or an error if this server's local brain isn't
 * Ollama (no cache was built). `think` in the result is what that persona's
 * Ollama client sends, present only when it sends one: the eval answer's
 * `localThink` echo.
 */
export function resolveLocalPersona<P>(
  override: string | undefined,
  base: { persona: P; model: string },
  cache: LocalPersonaCache<OverridePersona<P>> | undefined,
  think?: boolean,
  variant?: StyleVariant,
): { ok: true; persona: P; model: string; think?: boolean } | { ok: false; status: 422; error: string } {
  if (override === undefined) return { ok: true, persona: base.persona, model: base.model };
  if (!cache) return { ok: false, status: 422, error: "localModel needs an Ollama local brain, and this server's isn't one" };
  const hit = cache.get(override, think, variant);
  return { ok: true, persona: hit.persona, model: override, ...(hit.think !== undefined ? { think: hit.think } : {}) };
}
