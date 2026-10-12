/**
 * Which Ollama model answers when none is named.
 *
 * An app with no model configured used to fall through to a hosted one
 * (Anthropic, when a key was present): a missing setting quietly became an
 * outside AI. It asks Ollama instead: the chat model already loaded (asking it
 * costs no load, and pushes nothing else out of memory), else the first one
 * pulled, else DEFAULT_OLLAMA_MODEL. Never a model off this machine's Ollama.
 */

/** Used only when Ollama can't be asked or lists nothing usable: small enough for any recent Mac. */
export const DEFAULT_OLLAMA_MODEL = 'qwen2.5:7b';

/**
 * Is this one of Ollama's cloud models (`gpt-oss:120b-cloud`, `glm-4.6:cloud`)?
 * Those run on Ollama's servers: a pull is only a pointer to them.
 */
export function isOllamaCloudModel(name: string): boolean {
  const n = name.trim().toLowerCase();
  const colon = n.lastIndexOf(':');
  const base = colon === -1 ? n : n.slice(0, colon);
  const tag = colon === -1 ? '' : n.slice(colon + 1);
  return /(^|-)cloud$/.test(tag) || /-cloud$/.test(base);
}

/** One row of Ollama's /api/tags or /api/ps, as far as choosing goes. */
interface ListedModel {
  name?: unknown;
  remote_host?: unknown;
  details?: { family?: unknown } | null;
  /** /api/ps only: the context window the model is loaded with. */
  context_length?: unknown;
}

/**
 * Can this model hold a conversation on this machine? Not an embedder (their
 * names say `embed`, or their family is a BERT), and not a cloud pointer.
 */
function localChatModel(m: ListedModel): m is ListedModel & { name: string } {
  if (typeof m.name !== 'string' || !m.name.trim()) return false;
  if (isOllamaCloudModel(m.name) || (typeof m.remote_host === 'string' && m.remote_host.length > 0)) return false;
  const family = typeof m.details?.family === 'string' ? m.details.family : '';
  return !/embed|rerank/i.test(m.name) && !/bert/i.test(family);
}

export interface PickedOllamaModel {
  model: string;
  /** `loaded`: in Ollama's memory now; `pulled`: on disk; `default`: Ollama gave nothing to choose from. */
  from: 'loaded' | 'pulled' | 'default';
  /**
   * A loaded model's context window. Ollama reloads a model that is asked with
   * a different `num_ctx`, so a caller that sets none of its own sends this one
   * and whatever loaded the model (another app's chat) keeps it warm.
   */
  numCtx?: number;
  /**
   * Did Ollama answer either list call? False only with `default`, and then it
   * means Ollama could not be asked at all (down, or still starting), which is
   * worth asking again; true with `default` means it is up and has no chat model.
   */
  answered: boolean;
}

export interface PickOllamaModelOptions {
  /** Ollama's base URL. Defaults to http://127.0.0.1:11434. */
  baseURL?: string;
  /** Injectable fetch (tests). Defaults to global fetch. */
  fetch?: typeof fetch;
  /** How long each of the two list calls may take (default 2 s). */
  timeoutMs?: number;
}

/**
 * The model to use when none is configured: two free list calls to Ollama
 * (`/api/ps`, `/api/tags`), no generation. Never throws: an Ollama that is
 * down, slow or empty gives DEFAULT_OLLAMA_MODEL, and the caller says so
 * (`answered` tells down from empty, for a caller that would rather ask again).
 */
export async function pickOllamaModel(opts: PickOllamaModelOptions = {}): Promise<PickedOllamaModel> {
  const base = (opts.baseURL ?? 'http://127.0.0.1:11434').replace(/\/$/, '');
  const doFetch = opts.fetch ?? fetch;
  let answered = false;
  const list = async (path: string): Promise<ListedModel[]> => {
    try {
      const res = await doFetch(`${base}${path}`, { signal: AbortSignal.timeout(opts.timeoutMs ?? 2000) });
      if (!res.ok) return [];
      const models = ((await res.json()) as { models?: unknown } | null)?.models;
      answered = true;
      return Array.isArray(models) ? (models as ListedModel[]) : [];
    } catch {
      return [];
    }
  };
  const loaded = (await list('/api/ps')).find(localChatModel);
  if (loaded) {
    const n = loaded.context_length;
    return { model: loaded.name, from: 'loaded', answered: true, ...(typeof n === 'number' && Number.isInteger(n) && n > 0 ? { numCtx: n } : {}) };
  }
  const pulled = (await list('/api/tags')).find(localChatModel);
  if (pulled) return { model: pulled.name, from: 'pulled', answered: true };
  return { model: DEFAULT_OLLAMA_MODEL, from: 'default', answered };
}
