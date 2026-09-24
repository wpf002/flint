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
 */

/** Ollama model names: `name`, `name:tag`, `namespace/name:tag`, `hf.co/org/repo:Q4_K_M`. */
export const LOCAL_MODEL_RE = /^[a-z0-9._:\-/]+$/i;
export const LOCAL_MODEL_MAX_LEN = 100;

export type LocalModelRequest =
  | { ok: true; model: string | undefined }
  | { ok: false; status: 400; error: string };

/** Validate the override fields of a /generate body. `model` is undefined when no override was asked for. */
export function parseLocalModelRequest(body: Record<string, unknown>): LocalModelRequest {
  const raw = body.localModel;
  if (raw === undefined || raw === null) return { ok: true, model: undefined };
  if (typeof raw !== 'string') return { ok: false, status: 400, error: 'localModel must be a string' };
  const model = raw.trim();
  if (!model || model.length > LOCAL_MODEL_MAX_LEN || !LOCAL_MODEL_RE.test(model)) {
    return { ok: false, status: 400, error: `localModel must match ${String(LOCAL_MODEL_RE)} and be at most ${LOCAL_MODEL_MAX_LEN} chars` };
  }
  if (body.eval !== true) return { ok: false, status: 400, error: 'localModel is only accepted with eval: true' };
  if (body.localOnly !== true) return { ok: false, status: 400, error: 'localModel requires localOnly: true' };
  return { ok: true, model };
}

/**
 * One persona per override model, built on first use and reused after that.
 * Bounded (least-recently-used out) so a long bake-off across many candidates
 * can't grow it without limit; a persona is cheap to rebuild.
 */
export class LocalPersonaCache<P> {
  private readonly byModel = new Map<string, P>();

  constructor(
    private readonly make: (model: string) => P,
    private readonly max = 8,
  ) {}

  get(model: string): P {
    const hit = this.byModel.get(model);
    if (hit !== undefined) {
      this.byModel.delete(model); // refresh recency
      this.byModel.set(model, hit);
      return hit;
    }
    const p = this.make(model);
    this.byModel.set(model, p);
    while (this.byModel.size > this.max) {
      const oldest = this.byModel.keys().next().value as string;
      this.byModel.delete(oldest);
    }
    return p;
  }

  get size(): number {
    return this.byModel.size;
  }
}

/**
 * Which persona and model label answer a /generate turn. Without an override
 * it's the server's own local persona, exactly as before. With one, the cached
 * override persona, or an error if this server's local brain isn't Ollama (no
 * cache was built).
 */
export function resolveLocalPersona<P>(
  override: string | undefined,
  base: { persona: P; model: string },
  cache: LocalPersonaCache<P> | undefined,
): { ok: true; persona: P; model: string } | { ok: false; status: 422; error: string } {
  if (override === undefined) return { ok: true, persona: base.persona, model: base.model };
  if (!cache) return { ok: false, status: 422, error: "localModel needs an Ollama local brain, and this server's isn't one" };
  return { ok: true, persona: cache.get(override), model: override };
}
