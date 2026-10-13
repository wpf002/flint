/**
 * What "a model on this Mac" means, for the server and the runtime alike. Both
 * ask a local Ollama for work that may only be done locally (Will's goals, his
 * numbers, the events he is sent), and both must mean the same thing by local.
 * All of these:
 *
 *  - the model is not named as one of Ollama's cloud models (`isCloudModel`);
 *  - its server is this machine (`onThisMachine`: a loopback address), and the
 *    request is not carried there by a proxy (`viaProxy`: with Node's env
 *    proxy on, a request to 127.0.0.1 leaves the process for the proxy first);
 *  - the server itself has said so, recently enough to believe (`ModelPlaces`).
 *    A name proves nothing: `ollama cp gpt-oss:120b-cloud mine` gives a cloud
 *    model a plain name, and what tells them apart is the listing
 *    (`/api/tags`), where a model that runs on Ollama's servers says where
 *    (`listedModels`). A server is known by its origin, and nothing on it is
 *    local until it has said what it is (`placeSaid`).
 *
 * Nothing here reads the environment or makes a request of its own: the one
 * request (a server's listing) is handed to `ModelPlaces` by whoever keeps it.
 * What an answer means, what SILENCE means, and how old a word may be when a
 * caller asks first (two seconds, from when its ask began) are all here, so
 * the server and the runtime cannot read one listing, or one silence, two
 * ways. How often a server is asked in the background is each process's own
 * (the server keeps a watch; the runtime asks before each local request).
 * Each fails closed: no word, an old one, a silence, or a listing without the
 * model is not local.
 */

/**
 * Is this one of Ollama's cloud models (`gpt-oss:120b-cloud`, `glm-4.6:cloud`)?
 * Those run on Ollama's servers: a pull is only a pointer to them. The same
 * rule as @flint/core's isOllamaCloudModel, which the apps without this
 * package use; a server test holds the two together.
 */
export function isCloudModel(name: string): boolean {
  const n = name.trim().toLowerCase();
  const colon = n.lastIndexOf(':');
  const base = colon === -1 ? n : n.slice(0, colon);
  const tag = colon === -1 ? '' : n.slice(colon + 1);
  return /(^|-)cloud$/.test(tag) || /-cloud$/.test(base);
}

/**
 * Ollama's name for a model: lower case, and `:latest` when no tag is given
 * ("Llama3.1" and "llama3.1:latest" are the same model). A tag is what follows
 * the last ':' after the last '/', so a registry port isn't one.
 */
export function canonicalModel(name: string): string {
  const n = name.trim().toLowerCase();
  return n.lastIndexOf(':') > n.lastIndexOf('/') ? n : `${n}:latest`;
}

/** Are these the same Ollama model, however each is written? */
export function sameModel(a: string, b: string): boolean {
  return canonicalModel(a) === canonicalModel(b);
}

/** Is this URL's host the machine itself? Exactly 127.0.0.1, localhost or ::1: `127.0.0.1.example.com` is someone else's. */
export function onThisMachine(baseURL: string | undefined): boolean {
  if (!baseURL) return false;
  let host: string;
  try {
    const u = new URL(baseURL);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    host = u.hostname.toLowerCase();
  } catch {
    return false;
  }
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

/** One row of Ollama's /api/tags, as far as this goes. */
export interface ListedModel {
  name?: unknown;
  model?: unknown;
  remote_host?: unknown;
  remote_model?: unknown;
}

/** A model an Ollama listed, and whether it runs on that Ollama. */
export interface ModelHere {
  name: string;
  here: boolean;
}

/**
 * Read a listing as Ollama gave it (`/api/tags`'s `models`). A row that says
 * anything of a remote host or a remote model (a string, a number, `true`, an
 * object) runs elsewhere: only a row that says nothing is here. A model listed
 * twice is here only if every row says so. A row without a name is dropped.
 */
export function listedModels(rows: readonly unknown[]): ModelHere[] {
  const said = (v: unknown): boolean => v !== undefined && v !== null && v !== '';
  const models: ModelHere[] = [];
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const m = row as ListedModel;
    const name = typeof m.name === 'string' && m.name.trim() ? m.name : typeof m.model === 'string' ? m.model : '';
    if (!name.trim()) continue;
    const remote = said(m.remote_host) || said(m.remote_model);
    const seen = models.find((x) => sameModel(x.name, name));
    if (seen) seen.here = seen.here && !remote;
    else models.push({ name, here: !remote });
  }
  return models;
}

/** Does this listing say the model runs on that Ollama? A model it does not hold is not here. */
export function listedHere(models: readonly ModelHere[], model: string): boolean {
  if (!model.trim()) return false;
  return models.find((m) => sameModel(m.name, model))?.here === true;
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
 *    failed is still an Ollama), a redirect, and no answer at all.
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

/** What a server last said is believed for this long, and then not at all. */
export const PLACE_MAX_AGE_MS = 5 * 60_000;
/** A watched server is asked again this often. */
export const PLACE_ASK_EVERY_MS = 60_000;
/** How long one ask of a server may take, however many times it is tried inside it. */
export const PLACE_TIMEOUT_MS = 2_000;
/** How old a server's word may be before a caller that asks with `fresh` has it asked again. */
export const PLACE_FRESH_MS = 2_000;

/** A base URL without its trailing slashes: the address one listing is asked at. */
export const trimmedAddress = (baseURL: string): string => baseURL.replace(/\/+$/, '');

/** The server an address is at: its origin. An address that is no URL is its own key, and matches nothing else. */
export function serverOf(baseURL: string): string {
  try {
    return new URL(baseURL).origin.toLowerCase();
  } catch {
    return trimmedAddress(baseURL);
  }
}

/** What one server last said, and when. */
interface Heard {
  at: number;
  /** Every model it listed, with whether it runs on that server. Absent: it answered, and it is not an Ollama. */
  models?: ModelHere[];
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

/**
 * One request for a server's listing (`GET <at>/api/tags`), read with
 * `placeSaid`: what it said, or undefined (or a throw) for no word. It is
 * handed the ask's own signal, which ends it when the ask's time is up.
 */
export type AskPlace = (at: string, signal: AbortSignal) => Promise<PlaceSaid | undefined>;

export interface ModelPlacesOptions {
  /** What a server said is believed for this long (default PLACE_MAX_AGE_MS). */
  maxAgeMs?: number;
  /** How long one ask may take (default PLACE_TIMEOUT_MS). */
  timeoutMs?: number;
  now?: () => number;
  /** How a server is asked, when a call does not say. The record makes no request of its own. */
  ask?: AskPlace;
}

/**
 * The record of what model servers have said runs on them, and the one way a
 * server's silence is read. The server (apps/server ollama-locality) and the
 * runtime (apps/runtime model/here) both keep one, so neither can take a word,
 * or a silence, differently from the other. It makes no request of its own:
 * whoever keeps it hands it the request (`AskPlace`).
 *
 * A SERVER is known by its origin, not by the address a wire happens to use:
 * `http://127.0.0.1:11434` (Ollama's own API) and `http://127.0.0.1:11434/v1`
 * (the same Ollama, asked the OpenAI-compatible way) are one server, and what
 * it says of a model holds on both.
 *
 * `runsHere` only reads what is known: it never waits, and it never asks.
 * Whoever is about to hand a model something that stays here asks first with
 * `fresh`: the server is asked again when its last word is more than two
 * seconds old.
 *
 *  - A word is as old as when its ask BEGAN, never as young as when its answer
 *    landed.
 *  - A server asked by someone who WAITS for the answer, and gives none, is
 *    not believed on what it said before (`silent`): every model it listed as
 *    its own is forgotten, and so is "it is not an Ollama". What it said runs
 *    ELSEWHERE is kept: silence never turns that into a yes.
 *  - A server found silent is not asked again for two seconds: whoever waited
 *    for that silence has waited for all of them.
 *  - One failed listing is not yet silence: a server that answered AT ONCE
 *    with no word is tried once more inside the same ask. One that did not
 *    answer in time is not.
 *  - An ask nobody waited for (`refresh`) that fails changes nothing by itself:
 *    what was last heard stands until it is too old, or until the next caller
 *    that asks first finds the silence.
 */
export class ModelPlaces {
  readonly #heard = new Map<string, Heard>();
  readonly #asking = new Map<string, Promise<Asked>>();
  /** The last ask of each address that is over, answered or not: `fresh` does not ask a silent server at every call. */
  readonly #asked = new Map<string, Asked>();
  /**
   * When each server was last found silent by someone who waited (`silent`), until it speaks again. `fresh` does
   * not ask such a server again at once, so a caller that has just waited one ask for it does not wait a second time.
   */
  readonly #silentAt = new Map<string, number>();

  constructor(private readonly opts: ModelPlacesOptions = {}) {}

  #now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  #maxAge(): number {
    return this.opts.maxAgeMs ?? PLACE_MAX_AGE_MS;
  }

  /** What the server at this address last said, when that is recent enough to believe. */
  #fresh(baseURL: string | undefined): Heard | undefined {
    if (!baseURL) return undefined;
    const heard = this.#heard.get(serverOf(baseURL));
    return heard && this.#now() - heard.at <= this.#maxAge() ? heard : undefined;
  }

  /**
   * Is this model known, now, to run on the Ollama at this address? True only
   * on that Ollama's own word, recent enough to believe. It reads what is
   * known and asks nothing.
   */
  runsHere(baseURL: string | undefined, model: string): boolean {
    if (!model) return false;
    const models = this.#fresh(baseURL)?.models;
    return models !== undefined && listedHere(models, model);
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
   * answered, and not with one). Undefined: it has not said, not for a few
   * minutes, or it has been found silent since.
   */
  said(baseURL: string | undefined): 'ollama' | 'other' | undefined {
    const heard = this.#fresh(baseURL);
    return heard === undefined || heard.quiet ? undefined : heard.models ? 'ollama' : 'other';
  }

  /** Has the server at this address ever been heard from (however long ago)? */
  heard(baseURL: string): boolean {
    return this.#heard.has(serverOf(baseURL));
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
   * Only SILENCE is left alone: a server that was asked within `maxAgeMs` and
   * gave no word is not asked again yet (one that is down, or hangs, is not
   * asked at every call), and it is as silent for this caller as it was for
   * that ask. Never rejects; it waits as long as one ask may take (two, for a
   * caller that found an ask under way that began before its own window).
   */
  fresh(baseURL: string, maxAgeMs: number = PLACE_FRESH_MS, ask: AskPlace | undefined = this.opts.ask): Promise<void> {
    const at = trimmedAddress(baseURL);
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
    if (!running) return this.#begin(at, ask).then(settle);
    // An ask already under way: its word is as old as its start. Begun before this caller's window, it is too old
    // for this caller, who then asks once more.
    return running.then((a) => (a.word && a.from < since ? this.#begin(at, ask).then(settle) : settle(a)));
  }

  /**
   * Ask that server for its models. Never throws. An ask nobody waits for
   * that says nothing either way leaves what is known to age out; whoever
   * must know asks with `fresh`.
   */
  refresh(baseURL: string, ask: AskPlace | undefined = this.opts.ask): Promise<void> {
    return this.#begin(trimmedAddress(baseURL), ask).then(() => undefined);
  }

  /** The ask of this address that is under way, or a new one. */
  #begin(at: string, ask: AskPlace | undefined): Promise<Asked> {
    const running = this.#asking.get(at);
    if (running) return running;
    const asked = this.#ask(at, ask).finally(() => this.#asking.delete(at));
    this.#asking.set(at, asked);
    return asked;
  }

  async #ask(at: string, ask: AskPlace | undefined): Promise<Asked> {
    const from = this.#now();
    // One clock for the whole ask, however many times the server is tried inside it.
    const signal = AbortSignal.timeout(this.opts.timeoutMs ?? PLACE_TIMEOUT_MS);
    let word = await this.#try(at, from, signal, ask);
    // One failed listing is not yet silence. A server that answered AT ONCE with something that is no word (an
    // error, a dropped connection: it is restarting, or it was busy for a moment) is tried once more, so one bad
    // answer does not cost a turn. A server that did not answer in time is not: whoever waits has waited as long
    // as an ask may take.
    if (!word && !signal.aborted) word = await this.#try(at, this.#now(), signal, ask);
    // (When the ask ENDED: a server that hangs is left alone for a moment after each ask, not asked again at once.)
    const asked: Asked = { from, at: this.#now(), word };
    this.#asked.set(at, asked);
    return asked;
  }

  /** One request for the listing, begun at `from`: did the server give its word? Never throws. */
  async #try(at: string, from: number, signal: AbortSignal, ask: AskPlace | undefined): Promise<boolean> {
    try {
      const said = ask ? await ask(at, signal) : undefined;
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
   * been: silence never turns that into a yes. Anything it has said since
   * `asOf` stands. And until it speaks again, or two seconds pass since the
   * silence was found (`foundAt`: when the ask that met it ended), `fresh`
   * does not ask it once more.
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

  /** Take a listing as Ollama gave it (`/api/tags`'s `models`), as of `at` (`listedModels` reads the rows). */
  learn(baseURL: string, rows: readonly unknown[], at: number = this.#now()): void {
    this.#heard.set(serverOf(baseURL), { at, models: listedModels(rows) });
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
    if (heard?.models && at - heard.at <= this.#maxAge()) return;
    this.#heard.set(key, { at });
    this.#silentAt.delete(key);
  }

  /** Forget everything. */
  clear(): void {
    this.#heard.clear();
    this.#asked.clear();
    this.#silentAt.clear();
  }
}

/**
 * Node's own proxy switch. With NODE_USE_ENV_PROXY=1 (or `--use-env-proxy`)
 * Node sends every `fetch` through the proxy HTTP_PROXY / HTTPS_PROXY name,
 * LOOPBACK INCLUDED, unless NO_PROXY lists the host. A request to 127.0.0.1
 * then leaves the process for the proxy first: the model's prompt with it. So
 * an address that goes through the proxy is not "this Mac", whatever its host
 * is (`viaProxy`).
 *
 * The rule is held to what Node really does (v24, measured), and where the two
 * could differ it errs toward "proxied": calling a direct address proxied
 * costs a local model its turn; calling a proxied one direct would send Will's
 * words to the proxy.
 */
export interface EnvProxy {
  /** Node is sending `fetch` through a proxy the environment names. */
  on: boolean;
  /**
   * The hosts the no-proxy list names exactly, in lower case and as written: an IPv6 address keeps its brackets,
   * because Node matches `[::1]` and not `::1`. `['*']` alone: the list is `*` and nothing else, so every host is direct.
   */
  direct: readonly string[];
}

/** Read the switch as Node reads it at startup. `execArgv`: the process's own flags. */
export function readEnvProxy(env: Readonly<Record<string, string | undefined>>, execArgv: readonly string[]): EnvProxy {
  const flagged = (s: string | undefined): boolean => !!s && s.split(/\s+/).includes('--use-env-proxy');
  const asked = env.NODE_USE_ENV_PROXY?.trim() === '1' || execArgv.includes('--use-env-proxy') || flagged(env.NODE_OPTIONS);
  // Whichever proxy is named: which scheme it would carry is Node's to decide, so any one counts.
  const named = [env.HTTP_PROXY, env.http_proxy, env.HTTPS_PROXY, env.https_proxy].some((v) => !!v && v.trim() !== '');
  // Node reads the lower-case name when it is set at all (even to nothing), and the upper-case one only otherwise: never both.
  const list = env.no_proxy ?? env.NO_PROXY ?? '';
  // `*` keeps every host direct only when it is the whole value, to the character. Beside another entry, or with a
  // space around it, Node does not honour it, so here it names nothing.
  const direct = list === '*' ? ['*'] : list.split(/[,\s]+/).map((e) => e.trim().toLowerCase()).filter((e) => e !== '' && e !== '*');
  return { on: asked && named, direct };
}

/**
 * Would a request to this host go through the proxy? Only an entry that names
 * the host exactly is taken as keeping it direct (or a list that is `*` alone):
 * a suffix, a wildcard or a port on the entry is Node's to interpret, and a
 * wrong guess here would call a proxied address "this Mac". An IPv6 host is
 * named with its brackets (`[::1]`), as Node needs it. A host that is not
 * known is proxied.
 */
export function viaProxy(host: string | undefined, proxy: EnvProxy): boolean {
  if (!proxy.on) return false;
  if (proxy.direct.length === 1 && proxy.direct[0] === '*') return false;
  if (!host) return true;
  let name = host.trim().toLowerCase();
  // `host` may carry a port (`127.0.0.1:11434`, `[::1]:8080`): the name alone is what the list names, brackets and all.
  const v6 = /^(\[[^\]]+\])(?::\d+)?$/.exec(name);
  if (v6) name = v6[1]!;
  else if (/^[^:]+:\d+$/.test(name)) name = name.slice(0, name.lastIndexOf(':'));
  return !proxy.direct.includes(name);
}
