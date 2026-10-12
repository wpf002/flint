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
import { OllamaProvider, isOllamaCloudModel, pickOllamaModel, type OllamaProviderOptions, type PickedOllamaModel } from '@flint/core';
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
}

/** How many more times an Ollama that did not answer is asked at boot, and how far apart: about a minute in all. */
export const LOCAL_PICK_RETRIES = 12;
export const LOCAL_PICK_RETRY_MS = 5_000;

/**
 * The local brain. It is always Ollama, and always a model on this Ollama:
 *  - OLLAMA_MODEL names it. An Ollama cloud model (`...-cloud`, `:cloud`) is
 *    refused: it runs on Ollama's servers, which is an outside AI by another
 *    door. The pick below is used in its place, and the log says so.
 *  - Unset, Ollama is asked which it has (@flint/core pickOllamaModel: the chat
 *    model already loaded, else the first one pulled, else DEFAULT_OLLAMA_MODEL).
 *    A loaded model keeps the context size it is loaded with, unless
 *    OLLAMA_NUM_CTX says otherwise, so the pick does not make Ollama reload it.
 *  - An Ollama that does not answer may simply not be up yet (both start at
 *    login), so it is asked again for about a minute before the default is
 *    settled for. The default is a guess that lasts until the next restart:
 *    /health says where the model came from, and the console gets one note.
 *
 * It used to become Anthropic's claude-sonnet-4-6 whenever OLLAMA_MODEL was
 * unset and a key was present: a missing setting quietly sent every "local"
 * answer, the private ones included, to an outside AI. No key changes it now,
 * and FLINT_MODEL, which named that model, is no longer read (said once at boot).
 */
export async function chooseLocalBrain(
  env: Record<string, string | undefined>,
  deps: { fetch?: typeof fetch; log?: (msg: string) => void; wait?: (ms: number) => Promise<void>; retries?: number } = {},
): Promise<LocalBrain> {
  const log = deps.log ?? (() => {});
  const options = liveOllamaOptions(env);
  if (env.FLINT_MODEL?.trim()) log('[brain] FLINT_MODEL is no longer read: the local brain is always an Ollama model (OLLAMA_MODEL)');
  let named = env.OLLAMA_MODEL?.trim();
  if (named && isOllamaCloudModel(named)) {
    log('[brain] OLLAMA_MODEL is an Ollama cloud model, which runs on Ollama\'s servers: it is not used as the local brain');
    named = undefined;
  }
  if (named) return { options, model: named, from: 'env', env: { OLLAMA_MODEL: named } };

  const pick = () => pickOllamaModel({ ...(options.baseURL ? { baseURL: options.baseURL } : {}), ...(deps.fetch ? { fetch: deps.fetch } : {}) });
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let picked = await pick();
  if (!picked.answered) log('[brain] OLLAMA_MODEL is unset and Ollama is not answering yet: asking again for up to a minute');
  for (let i = 0; !picked.answered && i < (deps.retries ?? LOCAL_PICK_RETRIES); i++) {
    await wait(LOCAL_PICK_RETRY_MS);
    picked = await pick();
  }
  log(
    picked.from === 'default'
      ? `[brain] OLLAMA_MODEL is unset and Ollama ${picked.answered ? 'listed no chat model' : 'did not answer'}: the local brain is ${picked.model} until the next restart (run "ollama pull ${picked.model}", or set OLLAMA_MODEL)`
      : `[brain] OLLAMA_MODEL is unset: the local brain is ${picked.model}, which Ollama has ${picked.from} (set OLLAMA_MODEL to choose another)`,
  );
  // A loaded model is asked with the window it is loaded with, unless Will set one.
  const numCtx = env.OLLAMA_NUM_CTX?.trim() ? undefined : picked.numCtx;
  return {
    options: numCtx === undefined ? options : { ...options, defaultOptions: { ...options.defaultOptions, num_ctx: numCtx } },
    model: picked.model,
    from: picked.from,
    env: { OLLAMA_MODEL: picked.model, ...(numCtx !== undefined ? { OLLAMA_NUM_CTX: String(numCtx) } : {}) },
  };
}

/** The console note when the local brain is the fallback default: nothing was set and Ollama had nothing to offer. */
export function localDefaultNote(model: string): { title: string; body: string } {
  return {
    title: 'Flint Is Guessing Its Local Model',
    body: `No local model is set, and Ollama listed none, so Flint is trying ${model}. Set OLLAMA_MODEL to choose one, then restart Flint.`,
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
