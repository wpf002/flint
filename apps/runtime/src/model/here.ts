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
 * It fails closed, and it asks every time. Before each local call Ollama is
 * asked for its listing again, unless it answered within the last two
 * seconds (calls that come together share one answer). What it said is
 * believed for those two seconds and no longer: a model repointed at Ollama's
 * servers stops being asked at the next call, and a listing that does not
 * come (Ollama down, slow, not an Ollama, an answer that is no listing) is not
 * a yes, whatever it said a moment ago. Never heard, not listed, listed with a
 * remote host: not here. The server keeps a watch and believes a listing for
 * minutes, because it reads it on every chat turn; the runtime's calls are
 * few, carry Will's own words (a goal's title and why it matters), and can
 * afford the question each time.
 *
 * This is also the runtime's ONE reader of Ollama's lists (`list`): Settings >
 * Health reads what is installed and what is loaded through it
 * (health/machine.ts), and what a health run hears of the listing is what the
 * next local call believes.
 *
 * A request can reach only `/api/tags` or `/api/ps` on that loopback address
 * (scopedFetch, no redirect followed), has two seconds, and is given up after
 * them even when the transport would wait longer. Listing models loads nothing
 * and costs nothing, so it needs no slot and no cap.
 */
import { ModelPlaces, PLACE_TIMEOUT_MS, isCloudModel, onThisMachine, placeSaid, type PlaceSaid } from '@flint/policy';
import { scopedFetch } from '../policy/egress.js';

/** What Ollama said of its models is believed for this long, then asked for again: long enough for calls that come together to share one answer. */
export const LISTING_WORD_MS = 2_000;
/** A list longer than this is not read. */
export const LISTING_MAX_CHARS = 4_000_000;

/** Ollama's two lists: what is installed, and what is loaded now. */
export type ListPath = '/api/tags' | '/api/ps';

/** The Ollama a local call is about to ask, as config.ts read it. */
export interface AskedOllama {
  url: string;
  model: string;
  /** Node's env proxy would carry requests to this address: it is not this Mac, whatever its host says. */
  proxied?: boolean;
}

export interface LocalModelsOptions {
  /** What Ollama said is believed for this long, and then asked for again (default: two seconds). */
  wordMs?: number;
  /** How long Ollama has to list its models (default: two seconds). */
  timeoutMs?: number;
  now?: () => number;
}

export class LocalModels {
  readonly #places: ModelPlaces;
  readonly #asking = new Map<string, Promise<PlaceSaid | undefined>>();

  constructor(private readonly opts: LocalModelsOptions = {}) {
    // The shared record reads the answer; here it is believed only for the word's two seconds.
    this.#places = new ModelPlaces({ maxAgeMs: opts.wordMs ?? LISTING_WORD_MS, ...(opts.now ? { now: opts.now } : {}) });
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
    // Asked again unless it answered within the word's two seconds. An answer that does not come leaves nothing
    // to believe: what was heard before is too old by then, so the model is not here.
    const at = this.#places.heardAt(origin);
    if (at === undefined || this.#now() - at > (this.opts.wordMs ?? LISTING_WORD_MS)) await this.#listen(origin, base);
    return this.#places.runsHere(origin, ollama.model);
  }

  /**
   * One of Ollama's two lists, as it gave it: the rows of `models` from `/api/tags` (what is installed) or
   * `/api/ps` (what is loaded now). Undefined when the address is not this machine (nothing is asked), or it
   * did not answer with a list. Asked now, whatever was heard before; the listing is remembered as `runsHere`
   * remembers it. Never throws.
   */
  async list(ollama: Pick<AskedOllama, 'url' | 'proxied'>, path: ListPath, base: typeof fetch = fetch): Promise<readonly unknown[] | undefined> {
    if (ollama.proxied === true || !onThisMachine(ollama.url)) return undefined;
    const origin = new URL(ollama.url).origin;
    const said = path === '/api/tags' ? await this.#listen(origin, base) : await this.#ask(origin, path, base);
    return said && said !== 'other' ? said.ollama : undefined;
  }

  /** One request for the listing at a time per Ollama: callers that ask together share the answer. */
  #listen(origin: string, base: typeof fetch): Promise<PlaceSaid | undefined> {
    const running = this.#asking.get(origin);
    if (running) return running;
    const asked = this.#ask(origin, '/api/tags', base).finally(() => this.#asking.delete(origin));
    this.#asking.set(origin, asked);
    return asked;
  }

  /**
   * Ask that Ollama for one of its lists. Never throws. What the listing (`/api/tags`) says is taken into the
   * record; an answer that says nothing either way leaves nothing new to believe.
   */
  async #ask(origin: string, path: ListPath, base: typeof fetch): Promise<PlaceSaid | undefined> {
    const timeoutMs = this.opts.timeoutMs ?? PLACE_TIMEOUT_MS;
    const get = scopedFetch([{ origin, pathPrefix: path, methods: ['GET'] }], base, timeoutMs);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let gaveUp = false;
    // The transport is told to stop after the timeout; this stops waiting for it even if it does not.
    const deadline = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => {
        gaveUp = true;
        resolve(undefined);
      }, timeoutMs + 250);
      timer.unref?.();
    });
    const answer = (async (): Promise<PlaceSaid | undefined> => {
      try {
        const r = await get(`${origin}${path}`, { method: 'GET' });
        let text = '';
        if (r.ok) text = await r.text();
        else await r.body?.cancel().catch(() => {});
        // Too late, or too long to be a list: nothing is learned.
        if (gaveUp || text.length > LISTING_MAX_CHARS) return undefined;
        const said = await placeSaid(r.status, async () => JSON.parse(text) as unknown);
        // Its word is as old as its arrival: believed from now, for the word's two seconds.
        if (path === '/api/tags') this.#places.take(origin, said, this.#now());
        return said;
      } catch {
        // Down, slow or refused: nothing is learned.
        return undefined;
      }
    })();
    const said = await Promise.race([answer, deadline]);
    if (timer) clearTimeout(timer);
    return said;
  }

  /** Take a listing as Ollama gave it (`/api/tags`'s `models`), as of `at`: what `runsHere` then believes for the word's two seconds (tests). */
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
