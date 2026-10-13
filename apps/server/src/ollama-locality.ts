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
 *    is there and has no remote host;
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
 * until the next `watch`. The asking in the background is `watch`: the server names the addresses its local
 * brains use (./goals-chat), each is asked at once and then once a minute, and
 * a server that stops answering is believed for five more minutes and then
 * not at all. Only an address ./policy already took as here is watched (this
 * Mac, or the model server Will said is his).
 *
 * The local model's own server is also heard from another way: every look the
 * health monitor takes at it asks the same question (./local-backend), with
 * the key and the guard its other requests have, and hands the answer here
 * (`learn`, `notOllama`). That keeps what is known of it fresher than a
 * minute, and is how a server that wants a key on every request is known at
 * all.
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

/** How old a server's word may be before a caller that asks with `fresh` has it asked again. */
export const FRESH_MS = 2_000;

/** What one server last said, and when. */
interface Heard {
  at: number;
  /** Every model it listed, with whether it runs on that server. Absent: it answered, and it is not an Ollama. */
  models?: Array<{ name: string; here: boolean }>;
}

const trimmed = (baseURL: string): string => baseURL.replace(/\/+$/, '');

/** The server an address is at: its origin. An address that is no URL is its own key, and matches nothing else. */
const serverOf = (baseURL: string): string => {
  try {
    return new URL(baseURL).origin.toLowerCase();
  } catch {
    return trimmed(baseURL);
  }
};

export class OllamaLocality {
  readonly #heard = new Map<string, Heard>();
  readonly #asking = new Map<string, Promise<void>>();
  /** The addresses asked every minute: where each server's listing is. */
  readonly #watched = new Set<string>();
  /** When each address was last asked, answered or not: `fresh` does not ask a silent server at every call. */
  readonly #askedAt = new Map<string, number>();
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly opts: OllamaLocalityOptions = {}) {}

  #now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /** What the server at this address last said, when that is recent enough to believe. */
  #fresh(baseURL: string | undefined): Heard | undefined {
    if (!baseURL) return undefined;
    const heard = this.#heard.get(serverOf(baseURL));
    return heard && this.#now() - heard.at <= (this.opts.maxAgeMs ?? 5 * 60_000) ? heard : undefined;
  }

  /**
   * Is this model known, now, to run on the Ollama at this address? True only
   * on that Ollama's own word, recent enough to believe. It reads what is
   * known and asks nothing.
   */
  runsHere(baseURL: string | undefined, model: string): boolean {
    if (!model) return false;
    return this.#fresh(baseURL)?.models?.find((m) => sameModel(m.name, model))?.here === true;
  }

  /**
   * Is this model known, now, to run somewhere ELSE than the Ollama at this
   * address: its listing, recent enough to believe, gives it a remote host?
   * This is the other definite answer. Everything in between (no listing, an
   * old one, a model it does not hold) is neither: `runsHere` and this are
   * then both false, and whoever asks decides what not knowing means.
   */
  runsElsewhere(baseURL: string | undefined, model: string): boolean {
    if (!model) return false;
    return this.#fresh(baseURL)?.models?.find((m) => sameModel(m.name, model))?.here === false;
  }

  /**
   * What the server at this address has said it is, recently enough to
   * believe: an Ollama (it gave a model listing), or some other server (it
   * answered, and not with one). Undefined: it has not said, or not for a few
   * minutes. An OpenAI-compatible address can be either, and only the server
   * knows (./policy brainIsLocal).
   */
  said(baseURL: string | undefined): 'ollama' | 'other' | undefined {
    const heard = this.#fresh(baseURL);
    return heard === undefined ? undefined : heard.models ? 'ollama' : 'other';
  }

  /**
   * Keep what is known of the server at this address current: ask it now, and
   * again every minute for as long as the server runs. `baseURL` is where its
   * listing is asked (`<baseURL>/api/tags`). The promise is the first answer
   * (or the first failure); it never rejects.
   */
  watch(baseURL: string): Promise<void> {
    const at = trimmed(baseURL);
    const first = !this.#watched.has(at);
    this.#watched.add(at);
    if (!this.#timer) {
      this.#timer = setInterval(() => {
        for (const url of this.#watched) void this.refresh(url);
      }, this.opts.everyMs ?? 60_000);
      this.#timer.unref?.();
    }
    return first || !this.#heard.has(serverOf(at)) ? this.refresh(at) : Promise.resolve();
  }

  /**
   * Have the server at this address asked again NOW when what it last said is
   * older than `maxAgeMs` (or it has said nothing), and wait for its answer:
   * for a caller about to hand one of its models something that stays here.
   * Fresh enough already: nothing is asked. Asked within `maxAgeMs` and
   * silent: not asked again (a server that is down is not asked at every
   * call), and what was known stands until it is too old to believe. Never
   * rejects; it waits as long as one ask may take.
   */
  fresh(baseURL: string, maxAgeMs: number = FRESH_MS): Promise<void> {
    const at = trimmed(baseURL);
    const now = this.#now();
    const heard = this.#heard.get(serverOf(at));
    if (heard && now - heard.at <= maxAgeMs) return Promise.resolve();
    const running = this.#asking.get(at);
    if (running) return running;
    const asked = this.#askedAt.get(at);
    if (asked !== undefined && now - asked <= maxAgeMs) return Promise.resolve();
    return this.refresh(at);
  }

  /** Ask that server for its models. Never throws; an answer that says nothing either way leaves what is known to age out. */
  refresh(baseURL: string): Promise<void> {
    const at = trimmed(baseURL);
    const running = this.#asking.get(at);
    if (running) return running;
    const asked = this.#ask(at).finally(() => this.#asking.delete(at));
    this.#asking.set(at, asked);
    return asked;
  }

  async #ask(at: string): Promise<void> {
    const when = this.#now();
    this.#askedAt.set(at, when);
    try {
      // (A redirect is an error: a listing that came from another address is not this one's word.)
      const r = await (this.opts.fetchImpl ?? fetch)(`${at}/api/tags`, { signal: AbortSignal.timeout(this.opts.timeoutMs ?? 2_000), redirect: 'error' });
      const said = await placeSaid(r.status, () => r.json());
      if (!r.ok) await r.body?.cancel().catch(() => {});
      if (said === 'other') this.notOllama(at, when);
      else if (said) this.learn(at, said.ollama, when);
    } catch {
      // Down or slow: nothing is learned, and what was known ages out.
    }
  }

  /**
   * Take a listing as Ollama gave it (`/api/tags`'s `models`), as of `at`. A
   * row that says anything of a remote host or a remote model (a string, a
   * number, `true`, an object) runs elsewhere. A model listed twice is local
   * only if every row says so.
   */
  learn(baseURL: string, rows: readonly ListedModel[], at: number = this.#now()): void {
    const models: NonNullable<Heard['models']> = [];
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
    this.#heard.set(serverOf(baseURL), { at, models });
  }

  /**
   * The server at this address answered the question an Ollama answers with a
   * listing, and its answer was none: it is some other server (llama.cpp, LM
   * Studio), as of `at`. One thing is not taken from it: while a listing from
   * that very server is still believed, a "no" does not replace it. Two
   * addresses on one origin can be asked (Ollama behind a path, and the origin
   * itself), and the one that is not the Ollama's must not unsay the other.
   */
  notOllama(baseURL: string, at: number = this.#now()): void {
    const key = serverOf(baseURL);
    const heard = this.#heard.get(key);
    if (heard?.models && at - heard.at <= (this.opts.maxAgeMs ?? 5 * 60_000)) return;
    this.#heard.set(key, { at });
  }

  /** Stop asking, and forget everything (tests, and a server shutting down). */
  clear(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#watched.clear();
    this.#heard.clear();
    this.#askedAt.clear();
  }
}

/** What a server said when it was asked for the listing an Ollama gives (`GET /api/tags`). */
export type PlaceSaid = { ollama: ListedModel[] } | 'other';

/**
 * Read a server's answer to `GET /api/tags`:
 *  - 2xx with a `models` array: it is an Ollama, and the rows say where each
 *    model runs (`"models": null` is an Ollama with none: nothing on it is
 *    known to run there);
 *  - an answer that is no such listing: it is some other server. A 404 (or
 *    405, 501: llama.cpp, vLLM), and a 2xx with anything else in it (LM Studio
 *    answers 200 to a path it does not know);
 *  - anything that says nothing either way: undefined. A 401 or 403 (the
 *    question was not let through), a 429, a 5xx (an Ollama whose listing
 *    failed is still an Ollama), and no answer at all.
 * `body` is read only for a 2xx; a body that is not JSON is "no listing".
 */
export async function placeSaid(status: number, body: () => Promise<unknown>): Promise<PlaceSaid | undefined> {
  if (status >= 200 && status < 300) {
    let json: unknown;
    try {
      json = await body();
    } catch {
      json = undefined;
    }
    const models = (json as { models?: unknown } | null | undefined)?.models;
    if (models === null) return { ollama: [] };
    return Array.isArray(models) ? { ollama: models as ListedModel[] } : 'other';
  }
  return status === 404 || status === 405 || status === 501 ? 'other' : undefined;
}

/** The server's one record of what its model servers say runs on them. */
export const LOCALITY = new OllamaLocality();
