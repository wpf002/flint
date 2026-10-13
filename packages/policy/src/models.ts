/**
 * What "a model on this Mac" means, for the server and the runtime alike. Both
 * ask a local Ollama for work that may only be done locally (Will's goals, his
 * numbers, the events he is sent), and both must mean the same thing by local.
 * Three things, all of them:
 *
 *  - the model is not named as one of Ollama's cloud models (`isCloudModel`);
 *  - its Ollama is this machine (`onThisMachine`: a loopback address);
 *  - that Ollama itself lists the model with no remote host and no remote
 *    model (`listedModels`, `listedHere`). A name proves nothing: `ollama cp
 *    gpt-oss:120b-cloud mine` gives a cloud model a plain name, and what tells
 *    them apart is the listing (`/api/tags`), where a model that runs on
 *    Ollama's servers says where.
 *
 * Everything here is pure: who asks Ollama, how often, and for how long an
 * answer is believed is each process's own (the server's ollama-locality, the
 * runtime's model/here). Each fails closed: no listing, or a listing without
 * the model, is not local.
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
