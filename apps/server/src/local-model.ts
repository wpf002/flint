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
import { OllamaProvider, type OllamaProviderOptions } from '@flint/core';

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
 * Cache key for one override. Model names can't contain `~` (LOCAL_MODEL_RE), so
 * the suffix is unambiguous; no `think` keeps the bare model name.
 */
export function overrideKey(model: string, think: boolean | undefined): string {
  return think === undefined ? model : `${model}~${think ? 'think' : 'nothink'}`;
}

/**
 * One persona per override (model, think), built on first use and reused after
 * that. Bounded (least-recently-used out) so a long bake-off across many
 * candidates can't grow it without limit; a persona is cheap to rebuild.
 */
export class LocalPersonaCache<P> {
  private readonly byKey = new Map<string, P>();

  constructor(
    private readonly make: (model: string, think: boolean | undefined) => P,
    private readonly max = 8,
  ) {}

  get(model: string, think?: boolean): P {
    const key = overrideKey(model, think);
    const hit = this.byKey.get(key);
    if (hit !== undefined) {
      this.byKey.delete(key); // refresh recency
      this.byKey.set(key, hit);
      return hit;
    }
    const p = this.make(model, think);
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
 * The override cache main() builds: for each (model, think), `build` wraps a new
 * OllamaProvider made from evalOllamaOptions(env, think) in a persona. Each entry
 * records the `think` that provider was actually given, and /generate echoes that
 * (not the request), so apps/parity's echo check fails if the flag is lost on the
 * way to Ollama.
 */
export function overridePersonaCache<P>(
  env: Record<string, string | undefined>,
  build: (provider: OllamaProvider, model: string) => P,
  opts: { fetch?: typeof fetch; max?: number } = {},
): LocalPersonaCache<OverridePersona<P>> {
  return new LocalPersonaCache((model, think) => {
    const options: OllamaProviderOptions = { ...evalOllamaOptions(env, think), ...(opts.fetch ? { fetch: opts.fetch } : {}) };
    return { persona: build(new OllamaProvider(options), model), think: options.think };
  }, opts.max);
}

/**
 * Which persona and model label answer a /generate turn. Without an override
 * it's the server's own local persona, exactly as before. With one, the cached
 * override persona for (model, think), or an error if this server's local brain
 * isn't Ollama (no cache was built). `think` in the result is what that persona's
 * Ollama client sends, present only when it sends one: the eval answer's
 * `localThink` echo.
 */
export function resolveLocalPersona<P>(
  override: string | undefined,
  base: { persona: P; model: string },
  cache: LocalPersonaCache<OverridePersona<P>> | undefined,
  think?: boolean,
): { ok: true; persona: P; model: string; think?: boolean } | { ok: false; status: 422; error: string } {
  if (override === undefined) return { ok: true, persona: base.persona, model: base.model };
  if (!cache) return { ok: false, status: 422, error: "localModel needs an Ollama local brain, and this server's isn't one" };
  const hit = cache.get(override, think);
  return { ok: true, persona: hit.persona, model: override, ...(hit.think !== undefined ? { think: hit.think } : {}) };
}
