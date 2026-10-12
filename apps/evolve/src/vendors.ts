import type { ModelInfo, VendorCatalog } from './discover.js';

/**
 * "What do you serve": the local Ollama's own list by default, and each
 * vendor's only when asked for.
 *
 * All of these are free; none of them generate a token. But the vendor lists
 * are still calls to outside AI companies, made with Will's keys, so they are
 * off unless a run asks (`evolve discover --vendors`): by default Flint looks
 * only at the models on its own machine.
 */

const TIMEOUT_MS = 20_000;

async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: ac.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 120)}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

function fail(vendor: string, err: unknown): VendorCatalog {
  return { vendor, models: [], error: err instanceof Error ? err.message : String(err) };
}

export async function openaiCatalog(key: string | undefined): Promise<VendorCatalog> {
  if (!key) return { vendor: 'openai', models: [], error: 'no OPENAI_API_KEY' };
  try {
    const d = (await getJson('https://api.openai.com/v1/models', { authorization: `Bearer ${key}` })) as {
      data?: Array<{ id: string; created?: number }>;
    };
    const models: ModelInfo[] = (d.data ?? []).map((m) => ({
      id: m.id,
      ...(m.created !== undefined ? { created: m.created } : {}),
    }));
    return { vendor: 'openai', models };
  } catch (e) {
    return fail('openai', e);
  }
}

export async function anthropicCatalog(key: string | undefined): Promise<VendorCatalog> {
  if (!key) return { vendor: 'anthropic', models: [], error: 'no ANTHROPIC_API_KEY' };
  try {
    const d = (await getJson('https://api.anthropic.com/v1/models?limit=100', {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    })) as { data?: Array<{ id: string; created_at?: string }> };
    const models: ModelInfo[] = (d.data ?? []).map((m) => {
      const ms = m.created_at ? Date.parse(m.created_at) : NaN;
      return { id: m.id, ...(Number.isFinite(ms) ? { created: Math.floor(ms / 1000) } : {}) };
    });
    return { vendor: 'anthropic', models };
  } catch (e) {
    return fail('anthropic', e);
  }
}

export async function googleCatalog(key: string | undefined): Promise<VendorCatalog> {
  if (!key) return { vendor: 'google', models: [], error: 'no GEMINI_API_KEY' };
  try {
    // The key goes in the query string here, as this endpoint expects; it is
    // never logged, and the caller only ever prints ids.
    const d = (await getJson(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`, {})) as {
      models?: Array<{ name: string }>;
    };
    const models: ModelInfo[] = (d.models ?? []).map((m) => ({ id: m.name.replace(/^models\//, '') }));
    return { vendor: 'google', models };
  } catch (e) {
    return fail('google', e);
  }
}

/** The local brain's own registry: which open weights are pulled on this box. */
export async function ollamaCatalog(host: string): Promise<VendorCatalog> {
  try {
    const d = (await getJson(`${host.replace(/\/$/, '')}/api/tags`, {})) as {
      models?: Array<{ name: string; modified_at?: string }>;
    };
    const models: ModelInfo[] = (d.models ?? []).map((m) => {
      const ms = m.modified_at ? Date.parse(m.modified_at) : NaN;
      return { id: m.name, ...(Number.isFinite(ms) ? { created: Math.floor(ms / 1000) } : {}) };
    });
    return { vendor: 'ollama', models };
  } catch (e) {
    return fail('ollama', e);
  }
}

/**
 * The catalogs a run looks at: Ollama's alone, unless `vendors` asks for the
 * outside vendors' model lists as well (off by default; no vendor is contacted
 * and no key is read without it).
 */
export async function allCatalogs(env: NodeJS.ProcessEnv, opts: { vendors?: boolean } = {}): Promise<VendorCatalog[]> {
  const host = env.OLLAMA_HOST?.trim() || 'http://127.0.0.1:11434';
  if (!opts.vendors) return [await ollamaCatalog(host)];
  return Promise.all([
    openaiCatalog(env.OPENAI_API_KEY?.trim()),
    anthropicCatalog(env.ANTHROPIC_API_KEY?.trim()),
    googleCatalog(env.GEMINI_API_KEY?.trim()),
    ollamaCatalog(host),
  ]);
}

/** `evolve discover --vendors`: also list what the outside vendors serve. Anything else on the line is not it. */
export function wantsVendors(args: readonly string[]): boolean {
  return args.includes('--vendors');
}
