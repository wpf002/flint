/**
 * Is the model the runtime is about to ask on this Mac? The one place that is
 * decided, for EVERY local call the runtime makes: triage's judge, a goal
 * review's plan stage and a prediction's second opinion all ask here before
 * they ask the model, and a model not known to be here is "unavailable": no
 * request is sent, no cap is claimed, nothing waits for chat.
 *
 * It means what the server means by it (apps/server/src/policy.ts
 * brainIsLocal), and the two cannot drift: what a name, an address and a
 * server's answer mean, and for how long an answer is believed, is one piece
 * of code both read (@flint/policy models.ts). All of these:
 *  - the model's name is not one of Ollama's cloud models (`-cloud`, `:cloud`);
 *  - Ollama's address is this machine (loopback), and Node is not carrying
 *    requests to it through a proxy (config.ts reads Node's own switch);
 *  - Ollama itself has said so. A server is known by its origin, and nothing
 *    on it is local until it has said what it is: its own listing
 *    (`GET /api/tags`) holds the model and says nothing of a remote host or a
 *    remote model. A name proves nothing: `ollama cp` gives a cloud model a
 *    plain one, and only the listing tells them apart.
 *
 * It fails closed. The server keeps its record current by asking every
 * minute; the runtime asks before a call instead, whenever what it last heard
 * is more than a minute old. What was heard is believed for five minutes and
 * then not at all, so an Ollama that is slow to answer once does not stop the
 * work, and one that has stopped answering is soon not asked anything. Never
 * heard, not listed, listed with a remote host, or an answer that is no
 * listing: not here.
 *
 * The request can reach only `/api/tags` on that loopback address
 * (scopedFetch, no redirect followed), has two seconds, and is given up after
 * them even when the transport would wait longer. Listing models loads nothing
 * and costs nothing, so it needs no slot and no cap.
 */
import { ModelPlaces, PLACE_ASK_EVERY_MS, PLACE_TIMEOUT_MS, isCloudModel, onThisMachine, placeSaid } from '@flint/policy';
import { scopedFetch } from '../policy/egress.js';

/** A listing longer than this is not read. */
export const LISTING_MAX_CHARS = 4_000_000;

/** The Ollama a local call is about to ask, as config.ts read it. */
export interface AskedOllama {
  url: string;
  model: string;
  /** Node's env proxy would carry requests to this address: it is not this Mac, whatever its host says. */
  proxied?: boolean;
}

export interface LocalModelsOptions {
  /** What was heard is asked for again once it is this old (default: a minute). */
  askEveryMs?: number;
  /** What was heard is believed for this long (default: five minutes). */
  maxAgeMs?: number;
  /** How long Ollama has to list its models (default: two seconds). */
  timeoutMs?: number;
  now?: () => number;
}

export class LocalModels {
  readonly #places: ModelPlaces;
  readonly #asking = new Map<string, Promise<void>>();

  constructor(private readonly opts: LocalModelsOptions = {}) {
    this.#places = new ModelPlaces({ ...(opts.maxAgeMs !== undefined ? { maxAgeMs: opts.maxAgeMs } : {}), ...(opts.now ? { now: opts.now } : {}) });
  }

  #now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /**
   * True only when the name, the address and that Ollama's own word, recent
   * enough to believe, all say the model runs on this Mac. Never throws.
   */
  async runsHere(ollama: AskedOllama, base: typeof fetch = fetch): Promise<boolean> {
    if (!ollama.model.trim() || isCloudModel(ollama.model)) return false;
    if (ollama.proxied === true || !onThisMachine(ollama.url)) return false;
    const origin = new URL(ollama.url).origin;
    const at = this.#places.heardAt(origin);
    if (at === undefined || this.#now() - at > (this.opts.askEveryMs ?? PLACE_ASK_EVERY_MS)) await this.#listen(origin, base);
    return this.#places.runsHere(origin, ollama.model);
  }

  /** One request at a time per Ollama: callers that ask together share the answer. */
  #listen(origin: string, base: typeof fetch): Promise<void> {
    const running = this.#asking.get(origin);
    if (running) return running;
    const asked = this.#ask(origin, base).finally(() => this.#asking.delete(origin));
    this.#asking.set(origin, asked);
    return asked;
  }

  /** Ask that Ollama for its models. Never throws; an answer that says nothing either way leaves what is known to age out. */
  async #ask(origin: string, base: typeof fetch): Promise<void> {
    const at = this.#now();
    const timeoutMs = this.opts.timeoutMs ?? PLACE_TIMEOUT_MS;
    const get = scopedFetch([{ origin, pathPrefix: '/api/tags', methods: ['GET'] }], base, timeoutMs);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let gaveUp = false;
    // The transport is told to stop after the timeout; this stops waiting for it even if it does not.
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        gaveUp = true;
        resolve();
      }, timeoutMs + 250);
      timer.unref?.();
    });
    const answer = (async (): Promise<void> => {
      try {
        const r = await get(`${origin}/api/tags`, { method: 'GET' });
        let text = '';
        if (r.ok) text = await r.text();
        else await r.body?.cancel().catch(() => {});
        // Too late, or too long to be a listing: nothing is learned.
        if (gaveUp || text.length > LISTING_MAX_CHARS) return;
        this.#places.take(origin, await placeSaid(r.status, async () => JSON.parse(text) as unknown), at);
      } catch {
        // Down, slow or refused: nothing is learned, and what was known ages out.
      }
    })();
    await Promise.race([answer, deadline]);
    if (timer) clearTimeout(timer);
  }

  /** Take a listing as Ollama gave it (`/api/tags`'s `models`), as of `at`: what `runsHere` then believes (tests). */
  learn(url: string, rows: readonly unknown[], at: number = this.#now()): void {
    this.#places.learn(url, rows, at);
  }

  /** Forget everything heard (tests). */
  forget(): void {
    this.#places.clear();
    this.#asking.clear();
  }
}

/** The runtime's one record of what its Ollama says runs on it. */
export const LOCAL_MODELS = new LocalModels();
