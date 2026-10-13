/**
 * Is the model the runtime is about to ask on this Mac? The one place that is
 * decided, for EVERY local call the runtime makes: triage's judge, a goal
 * review's plan stage and a prediction's second opinion all ask here before
 * they ask the model, and a model not known to be here is "unavailable": no
 * request is sent, no cap is claimed, nothing waits for chat.
 *
 * It means what the server means (@flint/policy's models.ts holds the rules
 * both use). All three:
 *  - the model's name is not one of Ollama's cloud models (`-cloud`, `:cloud`);
 *  - Ollama's address is this machine (loopback);
 *  - Ollama's own listing (`GET /api/tags`) holds the model and says nothing of
 *    a remote host or a remote model. A name proves nothing: `ollama cp` gives
 *    a cloud model a plain one, and only the listing tells them apart.
 *
 * It fails closed. A listing is believed for a minute, then asked for again; a
 * listing that does not come (Ollama down, slow, not an Ollama, an answer that
 * is no listing) leaves nothing to believe, so the model is not here. The
 * request can reach only `/api/tags` on that loopback address (scopedFetch),
 * has two seconds, and is given up after them even when the transport would
 * wait longer. Listing models loads nothing and costs nothing, so it needs no
 * slot and no cap.
 */
import { isCloudModel, listedHere, listedModels, onThisMachine, type ModelHere } from '@flint/policy';
import { scopedFetch } from '../policy/egress.js';

/** A listing older than this is asked for again. */
export const LISTING_MAX_AGE_MS = 60_000;
/** How long Ollama has to list its models. */
export const LISTING_TIMEOUT_MS = 2_000;
/** A listing longer than this is not read. */
export const LISTING_MAX_BYTES = 4_000_000;

export interface LocalModelsOptions {
  maxAgeMs?: number;
  timeoutMs?: number;
  now?: () => number;
}

interface Heard {
  at: number;
  models: ModelHere[];
}

export class LocalModels {
  readonly #heard = new Map<string, Heard>();
  readonly #asking = new Map<string, Promise<Heard | null>>();

  constructor(private readonly opts: LocalModelsOptions = {}) {}

  #now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /**
   * True only when the name, the address and that Ollama's own word, recent
   * enough to believe, all say the model runs on this Mac. Never throws.
   */
  async runsHere(ollama: { url: string; model: string }, base: typeof fetch = fetch): Promise<boolean> {
    if (!ollama.model.trim() || isCloudModel(ollama.model)) return false;
    if (!onThisMachine(ollama.url)) return false;
    const origin = new URL(ollama.url).origin;
    const known = this.#heard.get(origin);
    const heard = known && this.#now() - known.at <= (this.opts.maxAgeMs ?? LISTING_MAX_AGE_MS) ? known : await this.#listen(origin, base);
    return heard !== null && listedHere(heard.models, ollama.model);
  }

  /** One request at a time per Ollama: callers that ask together share the answer. */
  #listen(origin: string, base: typeof fetch): Promise<Heard | null> {
    const running = this.#asking.get(origin);
    if (running) return running;
    const asked = this.#ask(origin, base).finally(() => this.#asking.delete(origin));
    this.#asking.set(origin, asked);
    return asked;
  }

  async #ask(origin: string, base: typeof fetch): Promise<Heard | null> {
    const at = this.#now();
    const timeoutMs = this.opts.timeoutMs ?? LISTING_TIMEOUT_MS;
    const get = scopedFetch([{ origin, pathPrefix: '/api/tags', methods: ['GET'] }], base, timeoutMs);
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The transport is told to stop after the timeout; this stops waiting for it even if it does not.
    const gaveUp = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs + 250);
      timer.unref?.();
    });
    const answer = (async (): Promise<Heard | null> => {
      try {
        const r = await get(`${origin}/api/tags`, { method: 'GET' });
        if (!r.ok) {
          await r.body?.cancel().catch(() => {});
          return null;
        }
        const text = await r.text();
        if (text.length > LISTING_MAX_BYTES) return null;
        const body = JSON.parse(text) as { models?: unknown } | null;
        if (typeof body !== 'object' || body === null || !Array.isArray(body.models)) return null;
        return { at, models: listedModels(body.models) };
      } catch {
        // Down, slow, refused, or not a listing: nothing is learned.
        return null;
      }
    })();
    const heard = await Promise.race([answer, gaveUp]);
    if (timer) clearTimeout(timer);
    if (heard) this.#heard.set(origin, heard);
    else this.#heard.delete(origin);
    return heard;
  }

  /** Take a listing as Ollama gave it (`/api/tags`'s `models`), as of `at`: what `runsHere` then believes for a minute. */
  learn(url: string, rows: readonly unknown[], at: number = this.#now()): void {
    if (!onThisMachine(url)) return;
    this.#heard.set(new URL(url).origin, { at, models: listedModels(rows) });
  }

  /** Forget everything heard (tests). */
  forget(): void {
    this.#heard.clear();
    this.#asking.clear();
  }
}

/** The runtime's one record of what its Ollama says runs on it. */
export const LOCAL_MODELS = new LocalModels();
