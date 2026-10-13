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
 * Everything here is pure: it reads no environment, makes no request and keeps
 * no clock of its own. Who asks a server, and when, is each process's own (the
 * server's ollama-locality watches; the runtime's model/here asks before a
 * call). What an answer means, and for how long it is believed, is here, so
 * the two cannot disagree. Each fails closed: no word, an old one, or a
 * listing without the model is not local.
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
/** A server is asked again once what it said is this old. */
export const PLACE_ASK_EVERY_MS = 60_000;
/** How long a server has to list its models. */
export const PLACE_TIMEOUT_MS = 2_000;

/** The server an address is at: its origin. An address that is no URL is its own key, and matches nothing else. */
export function serverOf(baseURL: string): string {
  try {
    return new URL(baseURL).origin.toLowerCase();
  } catch {
    return baseURL.replace(/\/+$/, '');
  }
}

/** What one server last said, and when. */
interface Heard {
  at: number;
  /** Every model it listed, with whether it runs on that server. Absent: it answered, and it is not an Ollama. */
  models?: ModelHere[];
}

export interface ModelPlacesOptions {
  /** What a server said is believed for this long (default PLACE_MAX_AGE_MS). */
  maxAgeMs?: number;
  now?: () => number;
}

/**
 * The record of what model servers have said runs on them. It only reads what
 * it was told (`learn`, `notOllama`, `take`): it asks nothing and waits for
 * nothing. A SERVER is known by its origin, not by the address a wire happens
 * to use: `http://127.0.0.1:11434` (Ollama's own API) and
 * `http://127.0.0.1:11434/v1` (the same Ollama, asked the OpenAI-compatible
 * way) are one server, and what it says of a model holds on both.
 */
export class ModelPlaces {
  readonly #heard = new Map<string, Heard>();

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
   * on that Ollama's own word, recent enough to believe.
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
   * answered, and not with one). Undefined: it has not said, or not for a few
   * minutes.
   */
  said(baseURL: string | undefined): 'ollama' | 'other' | undefined {
    const heard = this.#fresh(baseURL);
    return heard === undefined ? undefined : heard.models ? 'ollama' : 'other';
  }

  /** When the server at this address last said anything, however long ago; undefined when it never has. */
  heardAt(baseURL: string): number | undefined {
    return this.#heard.get(serverOf(baseURL))?.at;
  }

  /** Take a listing as Ollama gave it (`/api/tags`'s `models`), as of `at` (`listedModels` reads the rows). */
  learn(baseURL: string, rows: readonly unknown[], at: number = this.#now()): void {
    this.#heard.set(serverOf(baseURL), { at, models: listedModels(rows) });
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
  }

  /** Take whatever `placeSaid` read. Nothing said either way (undefined) is nothing learned: what was known ages out. */
  take(baseURL: string, said: PlaceSaid | undefined, at: number = this.#now()): void {
    if (said === 'other') this.notOllama(baseURL, at);
    else if (said) this.learn(baseURL, said.ollama, at);
  }

  /** Forget everything. */
  clear(): void {
    this.#heard.clear();
  }
}

/**
 * Node's own proxy switch. With NODE_USE_ENV_PROXY=1 (or `--use-env-proxy`)
 * Node sends every `fetch` through the proxy HTTP_PROXY / HTTPS_PROXY name,
 * LOOPBACK INCLUDED, unless NO_PROXY lists the host. A request to 127.0.0.1
 * then leaves the process for the proxy first: the model's prompt with it. So
 * an address that goes through the proxy is not "this Mac", whatever its host
 * is (`viaProxy`).
 */
export interface EnvProxy {
  /** Node is sending `fetch` through a proxy the environment names. */
  on: boolean;
  /** The hosts NO_PROXY names exactly, in lower case and without brackets; `*` is every host. */
  direct: readonly string[];
}

/** Read the switch as Node reads it at startup. `execArgv`: the process's own flags. */
export function readEnvProxy(env: Readonly<Record<string, string | undefined>>, execArgv: readonly string[]): EnvProxy {
  const flagged = (s: string | undefined): boolean => !!s && s.split(/\s+/).includes('--use-env-proxy');
  const asked = env.NODE_USE_ENV_PROXY?.trim() === '1' || execArgv.includes('--use-env-proxy') || flagged(env.NODE_OPTIONS);
  // Whichever proxy is named: which scheme it would carry is Node's to decide, so any one counts.
  const named = [env.HTTP_PROXY, env.http_proxy, env.HTTPS_PROXY, env.https_proxy].some((v) => !!v && v.trim() !== '');
  const direct = `${env.NO_PROXY ?? ''},${env.no_proxy ?? ''}`
    .split(/[,\s]+/)
    .map((e) => e.trim().toLowerCase().replace(/^\[|\]$/g, ''))
    .filter((e) => e !== '');
  return { on: asked && named, direct };
}

/**
 * Would a request to this host go through the proxy? Only an entry that names
 * the host exactly (or `*`) is taken as keeping it direct: a suffix, a
 * wildcard or a port on the entry is Node's to interpret, and a wrong guess
 * here would call a proxied address "this Mac". A host that is not known is
 * proxied.
 */
export function viaProxy(host: string | undefined, proxy: EnvProxy): boolean {
  if (!proxy.on) return false;
  if (proxy.direct.includes('*')) return false;
  if (!host) return true;
  let name = host.trim().toLowerCase();
  // `host` may carry a port (`127.0.0.1:11434`, `[::1]:8080`): the name alone is what NO_PROXY lists.
  const v6 = /^\[([^\]]+)\](?::\d+)?$/.exec(name);
  if (v6) name = v6[1]!;
  else if (/^[^:]+:\d+$/.test(name)) name = name.slice(0, name.lastIndexOf(':'));
  return !proxy.direct.includes(name);
}
