/**
 * Does a model really run on the server it is asked through? Asked of the
 * server itself, never read off the model's name (Machine plan P3 part 4).
 *
 * A name proves nothing. Ollama's cloud models are named for it
 * (`gpt-oss:120b-cloud`), but `ollama cp gpt-oss:120b-cloud mine` gives the
 * same cloud model a plain local-looking name. What tells them apart is what
 * the auto-picker already reads (@flint/core pickOllamaModel): in `/api/tags`,
 * a model that runs on Ollama's servers carries a `remote_host`, and one that
 * runs here does not.
 *
 * So ./policy brainIsLocal asks here as well as looking at the name and the
 * address, and this fails closed:
 *  - a model is local only while a listing no older than a few minutes says it
 *    is there and has no remote host, and only until its server is asked by
 *    someone who waits for the answer and gives none;
 *  - a model the listing does not hold, a listing that could not be read, and
 *    an address nobody has asked are all "not known to be local", which is not
 *    local.
 *
 * A SERVER is known by its origin, not by the address a wire happens to use:
 * `http://127.0.0.1:11434` (Ollama's own API) and `http://127.0.0.1:11434/v1`
 * (the same Ollama, asked the OpenAI-compatible way) are one server, and what
 * it says of a model holds on both wires.
 *
 * And a server can say one more thing: that it is NOT an Ollama at all
 * (`said` is then `other`). llama.cpp and LM Studio answer the listing an
 * Ollama gives with a 404, or with something that is no listing. Such a server
 * runs only its own models, so there is nothing more to ask it. That too is
 * its own word, recent enough to believe: until a server has said which it
 * is, nothing on it is known to be local.
 *
 * `runsHere` only reads what is known: it never waits, and it never makes a
 * request. Whoever is about to hand a model something that stays here, and
 * has not just asked, asks first with `fresh`: the server is asked again when
 * its last word is more than two seconds old, so a name pointed at a cloud
 * model while Flint runs (`ollama cp`) is not read as local for the minute
 * until the next `watch`.
 *
 * A server that is asked by someone who WAITS for the answer, and gives none,
 * is not believed on what it said before (`silent`): its listing could have
 * changed behind the silence (a name pointed at a cloud model while
 * `/api/tags` answers 500, or hangs), so nothing on it is known to run here
 * until it answers again. What it said runs ELSEWHERE is kept: that is never
 * a yes. The wait is one ask, two seconds at most, and a server that was
 * asked a moment ago and gave no word is not asked again at every call.
 *
 * The asking in the background is `watch`: the server names the addresses its
 * local brains use (./goals-chat), each is asked at once and then once a
 * minute. An ask nobody waited for that fails changes nothing by itself (what
 * was last heard stands, for five minutes at most); the next caller that asks
 * first finds the silence and drops it. Only an
 * address ./policy already took as here is watched (this Mac, or the model
 * server Will said is his).
 *
 * The local model's own server is also heard from another way: every look the
 * health monitor takes at it asks the same question (./local-backend), with
 * the key and the guard its other requests have, and hands the answer here
 * (`learn`, `notOllama`). That keeps what is known of it fresher than a
 * minute, and is how a server that wants a key on every request is known at
 * all.
 *
 * What a word means, what silence means and how old a word may be are
 * @flint/policy's (models.ts `ModelPlaces`), which the runtime keeps one of too
 * (apps/runtime/src/model/here.ts), so the two cannot read a listing or a
 * silence differently. This file is the asking: which addresses are watched,
 * how often, and the request itself.
 */
import { ModelPlaces, PLACE_ASK_EVERY_MS, PLACE_FRESH_MS, placeSaid, trimmedAddress, type ListedModel, type PlaceSaid } from '@flint/policy';

// Re-exported so imports here hold.
export { placeSaid, type ListedModel, type PlaceSaid };

export interface OllamaLocalityOptions {
  fetchImpl?: typeof fetch;
  /** How often a watched address is asked again (default 60 s). */
  everyMs?: number;
  /** A listing older than this is no longer believed (default 5 min). */
  maxAgeMs?: number;
  /** How long Ollama has to list its models (default 2 s). */
  timeoutMs?: number;
  now?: () => number;
}

/** How old a server's word may be before a caller that asks with `fresh` has it asked again. */
export const FRESH_MS = PLACE_FRESH_MS;

export class OllamaLocality {
  readonly #places: ModelPlaces;
  /** The addresses asked every minute: where each server's listing is. */
  readonly #watched = new Set<string>();
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly opts: OllamaLocalityOptions = {}) {
    this.#places = new ModelPlaces({
      ...(opts.maxAgeMs !== undefined ? { maxAgeMs: opts.maxAgeMs } : {}),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.now ? { now: opts.now } : {}),
      // One request for the listing. (A redirect is an error: a listing that came from another address is not this one's word.)
      ask: async (at, signal) => {
        const r = await (this.opts.fetchImpl ?? fetch)(`${at}/api/tags`, { signal, redirect: 'error' });
        const said = await placeSaid(r.status, () => r.json());
        if (!r.ok) await r.body?.cancel().catch(() => {});
        return said;
      },
    });
  }

  /**
   * Is this model known, now, to run on the Ollama at this address? True only
   * on that Ollama's own word, recent enough to believe. It reads what is
   * known and asks nothing.
   */
  runsHere(baseURL: string | undefined, model: string): boolean {
    return this.#places.runsHere(baseURL, model);
  }

  /**
   * Is this model known, now, to run somewhere ELSE than the Ollama at this
   * address: its listing, recent enough to believe, gives it a remote host?
   * This is the other definite answer. Everything in between (no listing, an
   * old one, a model it does not hold) is neither: `runsHere` and this are
   * then both false, and whoever asks decides what not knowing means.
   */
  runsElsewhere(baseURL: string | undefined, model: string): boolean {
    return this.#places.runsElsewhere(baseURL, model);
  }

  /**
   * What the server at this address has said it is, recently enough to
   * believe: an Ollama (it gave a model listing), or some other server (it
   * answered, and not with one). Undefined: it has not said, or not for a few
   * minutes. An OpenAI-compatible address can be either, and only the server
   * knows (./policy brainIsLocal).
   */
  said(baseURL: string | undefined): 'ollama' | 'other' | undefined {
    return this.#places.said(baseURL);
  }

  /**
   * Keep what is known of the server at this address current: ask it now, and
   * again every minute for as long as the server runs. `baseURL` is where its
   * listing is asked (`<baseURL>/api/tags`). The promise is the first answer
   * (or the first failure); it never rejects.
   */
  watch(baseURL: string): Promise<void> {
    const at = trimmedAddress(baseURL);
    const first = !this.#watched.has(at);
    this.#watched.add(at);
    if (!this.#timer) {
      this.#timer = setInterval(() => {
        for (const url of this.#watched) void this.refresh(url);
      }, this.opts.everyMs ?? PLACE_ASK_EVERY_MS);
      this.#timer.unref?.();
    }
    return first || !this.#places.heard(at) ? this.refresh(at) : Promise.resolve();
  }

  /**
   * Have the server at this address asked again NOW when what it last said is
   * older than `maxAgeMs` (or it has said nothing), and wait for its answer:
   * for a caller about to hand one of its models something that stays here.
   * Fresh enough already: nothing is asked. When this returns, either the
   * server's word is from an ask that BEGAN within `maxAgeMs` of this call
   * (or since), or nothing it said before is believed to run here (`silent`).
   * Never rejects. (The rule itself: @flint/policy ModelPlaces.fresh.)
   */
  fresh(baseURL: string, maxAgeMs: number = FRESH_MS): Promise<void> {
    return this.#places.fresh(baseURL, maxAgeMs);
  }

  /**
   * Ask that server for its models. Never throws. An ask nobody waits for
   * that says nothing either way leaves what is known to age out; whoever
   * must know asks with `fresh`.
   */
  refresh(baseURL: string): Promise<void> {
    return this.#places.refresh(baseURL);
  }

  /**
   * The server at this address was asked, by someone who waited for its
   * answer, and gave no word. What it said BEFORE that ask began (`asOf`) is
   * no longer believed as far as "runs here" goes; what it said runs
   * elsewhere is kept; and `fresh` does not ask it again for two seconds
   * after the silence was found (`foundAt`). (@flint/policy ModelPlaces.silent.)
   */
  silent(baseURL: string, asOf?: number, foundAt?: number): void {
    this.#places.silent(baseURL, asOf, foundAt);
  }

  /**
   * Take a listing as Ollama gave it (`/api/tags`'s `models`), as of `at`. A
   * row that says anything of a remote host or a remote model (a string, a
   * number, `true`, an object) runs elsewhere. A model listed twice is local
   * only if every row says so.
   */
  learn(baseURL: string, rows: readonly ListedModel[], at?: number): void {
    this.#places.learn(baseURL, rows, at);
  }

  /**
   * The server at this address answered the question an Ollama answers with a
   * listing, and its answer was none: it is some other server (llama.cpp, LM
   * Studio), as of `at`. One thing is not taken from it: while a listing from
   * that very server is still believed, a "no" does not replace it.
   */
  notOllama(baseURL: string, at?: number): void {
    this.#places.notOllama(baseURL, at);
  }

  /** Stop asking, and forget everything (tests, and a server shutting down). */
  clear(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#watched.clear();
    this.#places.clear();
  }
}

/** The server's one record of what its model servers say runs on them. */
export const LOCALITY = new OllamaLocality();
