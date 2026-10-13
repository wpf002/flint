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
 * It fails closed, and it asks every time. Before each local request Ollama is
 * asked for its listing again, unless its last word is from an ask that began
 * within the last two seconds (requests that come together share one answer).
 * The rule is the shared one (@flint/policy `ModelPlaces.fresh`), the same the
 * server asks with before a private turn:
 *  - a word is as old as when its ask BEGAN, never as young as when it landed;
 *  - an ask that yields no word (Ollama down, slow, an error, a redirect)
 *    drops what was believed to run here: a silent listing is not a yes,
 *    whatever it said a moment ago. What it said runs elsewhere is kept;
 *  - a listing that fails at once is asked once more inside the same ask (one
 *    bad answer does not cost the work its model); one that hangs is not;
 *  - a silent Ollama is not asked again for two seconds.
 * A model repointed at Ollama's servers stops being asked at the next request.
 * The word's age is counted on a clock that never goes backwards, so setting
 * the Mac's clock back cannot make an old word young. The server keeps a watch
 * and believes a listing for minutes, because it reads it on every chat turn;
 * the runtime's requests are few, carry Will's own words (a goal's title and
 * why it matters), and can afford the question each time.
 *
 * This is also the runtime's ONE reader of Ollama's lists (`list`): Settings >
 * Health reads what is installed and what is loaded through it
 * (health/machine.ts), and what a health run hears of the listing is what a
 * local request that comes with it goes by.
 *
 * A request can reach only `/api/tags` or `/api/ps` on that loopback address
 * (scopedFetch, no redirect followed), has two seconds, and is given up after
 * them even when the transport would wait longer. A listing longer than 4 MB
 * is not read. Listing models loads nothing and costs nothing, so it needs no
 * slot and no cap.
 */
import { ModelPlaces, PLACE_FRESH_MS, PLACE_TIMEOUT_MS, isCloudModel, onThisMachine, placeSaid, type AskPlace, type PlaceSaid } from '@flint/policy';
import { scopedFetch } from '../policy/egress.js';

/** How old Ollama's word may be when a local request goes: counted from when its ask began. */
export const LISTING_WORD_MS = PLACE_FRESH_MS;
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
  /** How old Ollama's word may be when a request goes (default: two seconds, from when its ask began). */
  wordMs?: number;
  /** How long Ollama has to list its models (default: two seconds). */
  timeoutMs?: number;
  /** The clock a word's age is counted on (default: one that never goes backwards). */
  now?: () => number;
}

export class LocalModels {
  readonly #places: ModelPlaces;

  constructor(private readonly opts: LocalModelsOptions = {}) {
    // The shared record. A word is believed here only as long as a request may go on it: two seconds.
    this.#places = new ModelPlaces({ maxAgeMs: this.#word(), timeoutMs: this.#timeout(), now: () => this.#now() });
  }

  /** Monotonic: the Mac's clock being set back does not make an old word young. */
  #now(): number {
    return this.opts.now?.() ?? performance.now();
  }

  #word(): number {
    return this.opts.wordMs ?? LISTING_WORD_MS;
  }

  #timeout(): number {
    return this.opts.timeoutMs ?? PLACE_TIMEOUT_MS;
  }

  /**
   * True only when the name, the address and that Ollama's own word, from an
   * ask begun within the last two seconds, all say the model runs on this Mac.
   * Asked before every request to the model. Never throws.
   */
  async runsHere(ollama: AskedOllama, base: typeof fetch = fetch): Promise<boolean> {
    if (!ollama.model.trim() || isCloudModel(ollama.model)) return false;
    if (ollama.proxied === true || !onThisMachine(ollama.url)) return false;
    const origin = new URL(ollama.url).origin;
    // Asked again unless its word is young enough. An ask that yields no word leaves nothing believed to run here.
    await this.#places.fresh(origin, this.#word(), this.#asker(base));
    return this.#places.runsHere(origin, ollama.model);
  }

  /**
   * One of Ollama's two lists, as it gave it: the rows of `models` from `/api/tags` (what is installed) or
   * `/api/ps` (what is loaded now). Undefined when the address is not this machine (nothing is asked), or it
   * did not answer with a list. Asked now, whatever was heard before; what the listing says (or its silence) is
   * taken into the record as `runsHere` takes it. Never throws.
   */
  async list(ollama: Pick<AskedOllama, 'url' | 'proxied'>, path: ListPath, base: typeof fetch = fetch): Promise<readonly unknown[] | undefined> {
    if (ollama.proxied === true || !onThisMachine(ollama.url)) return undefined;
    const origin = new URL(ollama.url).origin;
    const from = this.#now();
    const said = await this.#get(origin, path, base, AbortSignal.timeout(this.#timeout()));
    if (path === '/api/tags') {
      // The look began at `from`: its word is that old, and its silence drops what was believed before it.
      if (said === 'other') this.#places.notOllama(origin, from);
      else if (said) this.#places.learn(origin, said.ollama, from);
      else this.#places.silent(origin, from);
    }
    return said && said !== 'other' ? said.ollama : undefined;
  }

  /** How the shared record asks this Ollama for its listing: through `base`, scoped to that one path. */
  #asker(base: typeof fetch): AskPlace {
    return (at, signal) => this.#get(at, '/api/tags', base, signal);
  }

  /**
   * One request for one of Ollama's lists, read as the shared rule reads it (`placeSaid`). Never throws: no answer,
   * an answer too long to be a list, or one that comes after it was given up is no word.
   */
  async #get(origin: string, path: ListPath, base: typeof fetch, signal: AbortSignal): Promise<PlaceSaid | undefined> {
    const timeoutMs = this.#timeout();
    const get = scopedFetch([{ origin, pathPrefix: path, methods: ['GET'] }], base, timeoutMs);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let gaveUp = false;
    // The transport is told to stop when the ask's time is up; this stops waiting for it even if it does not.
    const deadline = new Promise<undefined>((resolve) => {
      const end = (): void => {
        gaveUp = true;
        resolve(undefined);
      };
      timer = setTimeout(end, timeoutMs + 250);
      timer.unref?.();
      if (signal.aborted) end();
      else signal.addEventListener('abort', () => setTimeout(end, 250).unref?.(), { once: true });
    });
    const answer = (async (): Promise<PlaceSaid | undefined> => {
      try {
        const r = await get(`${origin}${path}`, { method: 'GET', signal });
        let text = '';
        if (r.ok) text = await r.text();
        else await r.body?.cancel().catch(() => {});
        // Too late, or too long to be a list: no word.
        if (gaveUp || text.length > LISTING_MAX_CHARS) return undefined;
        return await placeSaid(r.status, async () => JSON.parse(text) as unknown);
      } catch {
        // Down, slow or refused: no word.
        return undefined;
      }
    })();
    const said = await Promise.race([answer, deadline]);
    if (timer) clearTimeout(timer);
    return said;
  }

  /** Take a listing as Ollama gave it (`/api/tags`'s `models`), as of `at`: what `runsHere` then goes by for the word's two seconds (tests). */
  learn(url: string, rows: readonly unknown[], at: number = this.#now()): void {
    this.#places.learn(url, rows, at);
  }

  /** Forget everything heard (tests). */
  forget(): void {
    this.#places.clear();
  }
}

/** The runtime's one record of what its Ollama says runs on it. */
export const LOCAL_MODELS = new LocalModels();
