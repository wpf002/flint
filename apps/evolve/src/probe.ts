/**
 * Can this model actually answer? A model list is not the answer.
 *
 * OpenAI still listed `gpt-5.2-codex` in /v1/models long after deprecating it;
 * the refusal only appeared when it was called. So the "is it served" screen let
 * a dead model through, Flint was reconfigured onto it, and a full measurement
 * was paid for before the fallback made the result meaningless.
 *
 * This asks for one token instead, which is the only check that reflects what
 * happens at call time: for a local model, that it loads and generates.
 *
 * It asks the local Ollama and nothing else. `try` only takes local candidates
 * (promote.ts localOnly), so the OpenAI, Anthropic and Google probes that used
 * to live here are gone: there is no code path from evolve's probe to a vendor.
 */
import { localOnly } from './promote.js';
import { tierOllamaHost } from './vendors.js';

export interface ProbeResult {
  ok: boolean;
  detail: string;
}

/** A cold 30B model can take most of a minute to load before its first token. */
const TIMEOUT_MS = 120_000;

/**
 * A one-token generation against the Ollama the server's `ollama:` tier is
 * served from (vendors.ts tierOllamaHost: FLINT_TIER_OLLAMA_HOST, else
 * FLINT_FRONTIER_BASE_URL, else OLLAMA_HOST), the same one the screen listed.
 *
 * An empty completion still counts as alive: the call was accepted and the
 * model ran, which is what is being tested.
 */
export async function probe(opts: {
  provider: string;
  model: string;
  env: NodeJS.ProcessEnv;
  /** Injectable fetch (tests). Defaults to global fetch. */
  fetch?: typeof fetch;
}): Promise<ProbeResult> {
  const { provider, model, env } = opts;
  const local = localOnly({ provider, model });
  // Not a local model: refused here too, whoever called, before any request is made.
  if (!local.ok) return { ok: false, detail: local.reason };
  try {
    const res = await (opts.fetch ?? fetch)(`${tierOllamaHost(env)}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], stream: false, options: { num_predict: 1 } }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 200) return { ok: true, detail: 'answered' };
    return { ok: false, detail: `HTTP ${res.status}: ${(await res.text()).slice(0, 300)}` };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}
