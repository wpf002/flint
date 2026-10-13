/**
 * Does a model really run on the Ollama it is asked through? Asked of Ollama
 * itself, never read off the model's name (Machine plan P3 part 4).
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
 *    is there and has no remote host;
 *  - a model the listing does not hold, a listing that could not be read, and
 *    an address nobody has asked are all "not known to be local", which is not
 *    local.
 *
 * `runsHere` only reads what is known: it never waits, and it never makes a
 * request. The asking is `watch`: the server names the addresses its local
 * brains use (./goals-chat), each is asked at once and then once a minute, and
 * an Ollama that stops answering is believed for five more minutes and then
 * not at all. Only an address ./policy already took as here is watched (this
 * Mac, or the model server Will said is his).
 *
 * The local model's own server is also heard from another way: every look the
 * health monitor takes at it reads the same listing (./local-backend), and
 * hands it here (`learn`). That is the only way an Ollama asked over the
 * OpenAI-compatible wire is known (its address there is not one this can ask),
 * and it keeps what is known of the main server fresher than a minute.
 */
import { sameModel } from './memory-brain';

/** One row of Ollama's /api/tags, as far as this goes. */
export interface ListedModel {
  name?: unknown;
  model?: unknown;
  remote_host?: unknown;
  remote_model?: unknown;
}

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

interface Listing {
  at: number;
  /** Every model it listed, with whether it runs on that Ollama. */
  models: Array<{ name: string; here: boolean }>;
}

const base = (baseURL: string): string => baseURL.replace(/\/+$/, '');

export class OllamaLocality {
  readonly #listings = new Map<string, Listing>();
  readonly #asking = new Map<string, Promise<void>>();
  readonly #watched = new Set<string>();
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly opts: OllamaLocalityOptions = {}) {}

  #now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /**
   * Is this model known, now, to run on the Ollama at this address? True only
   * on that Ollama's own word, recent enough to believe. It reads what is
   * known and asks nothing.
   */
  runsHere(baseURL: string | undefined, model: string): boolean {
    if (!baseURL || !model) return false;
    const listing = this.#listings.get(base(baseURL));
    if (!listing || this.#now() - listing.at > (this.opts.maxAgeMs ?? 5 * 60_000)) return false;
    const row = listing.models.find((m) => sameModel(m.name, model));
    return row?.here === true;
  }

  /**
   * Is this model known, now, to run somewhere ELSE than the Ollama at this
   * address: its listing, recent enough to believe, gives it a remote host?
   * This is the other definite answer. Everything in between (no listing, an
   * old one, a model it does not hold) is neither: `runsHere` and this are
   * then both false, and whoever asks decides what not knowing means.
   */
  runsElsewhere(baseURL: string | undefined, model: string): boolean {
    if (!baseURL || !model) return false;
    const listing = this.#listings.get(base(baseURL));
    if (!listing || this.#now() - listing.at > (this.opts.maxAgeMs ?? 5 * 60_000)) return false;
    const row = listing.models.find((m) => sameModel(m.name, model));
    return row?.here === false;
  }

  /**
   * Has the server at this address ever listed its models as an Ollama does?
   * Then it is an Ollama, whatever wire it is asked through, and a model on it
   * is local only on its word (./policy brainIsLocal). It stays one once it
   * was: an old listing is not believed, but it is not forgotten either.
   */
  isOllama(baseURL: string | undefined): boolean {
    return !!baseURL && this.#listings.has(base(baseURL));
  }

  /**
   * Keep what is known of this Ollama current: ask it now, and again every
   * minute for as long as the server runs. The promise is the first answer
   * (or the first failure); it never rejects.
   */
  watch(baseURL: string): Promise<void> {
    const key = base(baseURL);
    const first = !this.#watched.has(key);
    this.#watched.add(key);
    if (!this.#timer) {
      this.#timer = setInterval(() => {
        for (const url of this.#watched) void this.refresh(url);
      }, this.opts.everyMs ?? 60_000);
      this.#timer.unref?.();
    }
    return first || !this.#listings.has(key) ? this.refresh(key) : Promise.resolve();
  }

  /** Ask that Ollama for its models. Never throws; an answer that cannot be read leaves what is known to age out. */
  refresh(baseURL: string): Promise<void> {
    const key = base(baseURL);
    const running = this.#asking.get(key);
    if (running) return running;
    const asked = this.#ask(key).finally(() => this.#asking.delete(key));
    this.#asking.set(key, asked);
    return asked;
  }

  async #ask(key: string): Promise<void> {
    const at = this.#now();
    try {
      const r = await (this.opts.fetchImpl ?? fetch)(`${key}/api/tags`, { signal: AbortSignal.timeout(this.opts.timeoutMs ?? 2_000) });
      if (!r.ok) {
        await r.body?.cancel().catch(() => {});
        return;
      }
      const body = (await r.json()) as { models?: unknown };
      if (!Array.isArray(body.models)) return;
      this.learn(key, body.models as ListedModel[], at);
    } catch {
      // Down, slow, or not Ollama: nothing is learned, and what was known ages out.
    }
  }

  /**
   * Take a listing as Ollama gave it (`/api/tags`'s `models`), as of `at`. A
   * row that says anything of a remote host or a remote model (a string, a
   * number, `true`, an object) runs elsewhere. A model listed twice is local
   * only if every row says so.
   */
  learn(baseURL: string, rows: readonly ListedModel[], at: number = this.#now()): void {
    const models: Listing['models'] = [];
    for (const m of rows) {
      const name = typeof m?.name === 'string' && m.name.trim() ? m.name : typeof m?.model === 'string' ? m.model : '';
      if (!name.trim()) continue;
      // Anything at all said of a remote host or model, of any type, means it runs elsewhere: only a row that says nothing is local.
      const said = (v: unknown): boolean => v !== undefined && v !== null && v !== '';
      const remote = said(m.remote_host) || said(m.remote_model);
      const seen = models.find((x) => sameModel(x.name, name));
      if (seen) seen.here = seen.here && !remote;
      else models.push({ name, here: !remote });
    }
    this.#listings.set(base(baseURL), { at, models });
  }

  /** Stop asking, and forget everything (tests, and a server shutting down). */
  clear(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#watched.clear();
    this.#listings.clear();
  }
}

/** The server's one record of what its Ollama says runs on it. */
export const LOCALITY = new OllamaLocality();
