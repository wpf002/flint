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
  /**
   * It has since been asked and gave no word (`silent`): all that is left of
   * what it said is which models run ELSEWHERE. It is no longer taken as
   * having said what it is.
   */
  quiet?: true;
}

/** One ask of one address, once it is over: when it began, when it ended, and whether the server gave its word. */
interface Asked {
  from: number;
  at: number;
  word: boolean;
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
  readonly #asking = new Map<string, Promise<Asked>>();
  /** The addresses asked every minute: where each server's listing is. */
  readonly #watched = new Set<string>();
  /** The last ask of each address that is over, answered or not: `fresh` does not ask a silent server at every call. */
  readonly #asked = new Map<string, Asked>();
  /**
   * When each server was last found silent by someone who waited (`silent`), until it speaks again: by one of the
   * asks made here, or by a look the health monitor took. `fresh` does not ask such a server again at once, so a
   * turn that has just waited one look for it does not wait a second time for the same silence.
   */
  readonly #silentAt = new Map<string, number>();
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
    return heard === undefined || heard.quiet ? undefined : heard.models ? 'ollama' : 'other';
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
   * Fresh enough already: nothing is asked. When this returns, either the
   * server's word is from an ask that BEGAN within `maxAgeMs` of this call
   * (or since), or nothing it said before is believed to run here (`silent`):
   * an ask that this caller waited for and that yielded no word does not
   * leave the old listing standing.
   *
   * A word is as old as when its ask began, never as young as when its
   * answer landed: a listing that took most of two seconds to arrive is not
   * handed to the next caller for two more. Only SILENCE is left alone: a
   * server that was asked within `maxAgeMs` and gave no word is not asked
   * again yet (one that is down, or hangs, is not asked at every call), and
   * it is as silent for this caller as it was for that ask. Never rejects; it
   * waits as long as one ask may take (two, for a caller that found an ask
   * under way that began before its own window).
   */
  fresh(baseURL: string, maxAgeMs: number = FRESH_MS): Promise<void> {
    const at = trimmed(baseURL);
    const now = this.#now();
    const since = now - maxAgeMs;
    const heard = this.#heard.get(serverOf(at));
    // (What is left of a server found silent is no older than the silence, so it is covered by the line after this one.)
    if (heard && heard.at >= since) return Promise.resolve();
    // Found silent a moment ago by someone who waited for it, and not a word since: it is already not believed, and
    // it is not asked again yet.
    const hushed = this.#silentAt.get(serverOf(at));
    if (hushed !== undefined && hushed >= since) return Promise.resolve();
    // No word: what was said before that ask began is dropped, and so is anything too old for this caller
    // (an ask that hung can have begun before a word that is itself too old by now).
    const settle = (a: Asked): void => {
      if (!a.word) this.silent(at, Math.max(a.from, since), a.at);
    };
    const last = this.#asked.get(at);
    if (last !== undefined && !last.word && last.at >= since) return Promise.resolve(settle(last));
    const running = this.#asking.get(at);
    if (!running) return this.#begin(at).then(settle);
    // An ask already under way: its word is as old as its start. Begun before this caller's window, it is too old
    // for this caller, who then asks once more.
    return running.then((a) => (a.word && a.from < since ? this.#begin(at).then(settle) : settle(a)));
  }

  /**
   * Ask that server for its models. Never throws. An ask nobody waits for
   * that says nothing either way leaves what is known to age out; whoever
   * must know asks with `fresh`.
   */
  refresh(baseURL: string): Promise<void> {
    return this.#begin(trimmed(baseURL)).then(() => undefined);
  }

  /** The ask of this address that is under way, or a new one. */
  #begin(at: string): Promise<Asked> {
    const running = this.#asking.get(at);
    if (running) return running;
    const asked = this.#ask(at).finally(() => this.#asking.delete(at));
    this.#asking.set(at, asked);
    return asked;
  }

  async #ask(at: string): Promise<Asked> {
    const from = this.#now();
    // One clock for the whole ask, however many times the server is tried inside it.
    const signal = AbortSignal.timeout(this.opts.timeoutMs ?? 2_000);
    let word = await this.#try(at, from, signal);
    // One failed listing is not yet silence. A server that answered AT ONCE with something that is no word (an
    // error, a dropped connection: it is restarting, or it was busy for a moment) is tried once more, so one bad
    // answer does not cost a turn. A server that did not answer in time is not: whoever waits has waited as long
    // as an ask may take.
    if (!word && !signal.aborted) word = await this.#try(at, this.#now(), signal);
    // (When the ask ENDED: a server that hangs is left alone for a moment after each ask, not asked again at once.)
    const asked: Asked = { from, at: this.#now(), word };
    this.#asked.set(at, asked);
    return asked;
  }

  /** One request for the listing, begun at `from`: did the server give its word? Never throws. */
  async #try(at: string, from: number, signal: AbortSignal): Promise<boolean> {
    try {
      // (A redirect is an error: a listing that came from another address is not this one's word.)
      const r = await (this.opts.fetchImpl ?? fetch)(`${at}/api/tags`, { signal, redirect: 'error' });
      const said = await placeSaid(r.status, () => r.json());
      if (!r.ok) await r.body?.cancel().catch(() => {});
      if (said === 'other') this.notOllama(at, from);
      else if (said) this.learn(at, said.ollama, from);
      // Its word is an answer that is now what is known of this server. A "no" that did not replace a listing still
      // believed (two addresses on one origin) left that listing as old as it was: no word about it.
      const heard = this.#heard.get(serverOf(at));
      return said !== undefined && heard !== undefined && !heard.quiet && heard.at >= from;
    } catch {
      // Down or slow: nothing is learned.
      return false;
    }
  }

  /**
   * The server at this address was asked, by someone who waited for its
   * answer, and gave no word (it is down, it hangs, its listing failed, the
   * question was not let through). What it said BEFORE that ask began
   * (`asOf`) is no longer believed as far as "runs here" goes: every model it
   * listed as its own is forgotten, and so is "it is not an Ollama". The
   * models it said run elsewhere are kept, for as long as they would have
   * been: silence never turns that into a yes, and a turn refused for a cloud
   * model goes on being told so. Anything it has said since `asOf` stands.
   * And until it speaks again, or two seconds pass since the silence was
   * found (`foundAt`: when the ask that met it ended), `fresh` does not ask
   * it once more: whoever waited for this silence has waited for all of them.
   */
  silent(baseURL: string, asOf: number = this.#now(), foundAt: number = this.#now()): void {
    const key = serverOf(baseURL);
    const heard = this.#heard.get(key);
    if (heard && heard.at > asOf) return;
    this.#silentAt.set(key, foundAt);
    if (!heard) return;
    const elsewhere = heard.models?.filter((m) => !m.here) ?? [];
    if (elsewhere.length === 0) this.#heard.delete(key);
    else this.#heard.set(key, { at: heard.at, models: elsewhere, quiet: true });
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
    this.#silentAt.delete(serverOf(baseURL));
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
    this.#silentAt.delete(key);
  }

  /** Stop asking, and forget everything (tests, and a server shutting down). */
  clear(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#watched.clear();
    this.#heard.clear();
    this.#asked.clear();
    this.#silentAt.clear();
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
