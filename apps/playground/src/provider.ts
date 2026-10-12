import { AnthropicProvider, OllamaProvider, isOllamaCloudModel, pickOllamaModel, type ProviderAdapter } from '@flint/core';

/**
 * Which model a playground demo talks to.
 *
 * A demo used to land on Anthropic (claude-sonnet-4-6) whenever OLLAMA_MODEL was
 * unset and ANTHROPIC_API_KEY was in the environment, and `dotenv` puts it there
 * from any .env: a key that happened to be present chose an outside AI. A key is
 * not a request. Now:
 *
 *   OLLAMA_MODEL=llama3.1           that local model (an Ollama cloud model is refused)
 *   (nothing set)                   the chat model Ollama has loaded, else the first one
 *                                   pulled, when Ollama answers and has one
 *   PLAYGROUND_PROVIDER=anthropic   Anthropic, asked for by name, with ANTHROPIC_API_KEY:
 *                                   the run to compare a local model against
 *
 * Undefined when there is no live model: no Ollama model, and Anthropic not
 * asked for. The caller says so (or, for `start`, uses the offline mock).
 */
export interface Picked {
  provider: ProviderAdapter;
  model: string;
}

export async function pickProvider(
  env: Record<string, string | undefined> = process.env,
  deps: { fetch?: typeof fetch; log?: (msg: string) => void } = {},
): Promise<Picked | undefined> {
  const log = deps.log ?? ((m: string) => console.error(m));
  if (env.PLAYGROUND_PROVIDER?.trim().toLowerCase() === 'anthropic') {
    const key = env.ANTHROPIC_API_KEY?.trim();
    if (!key) {
      log('PLAYGROUND_PROVIDER=anthropic needs ANTHROPIC_API_KEY.');
      return undefined;
    }
    return { provider: new AnthropicProvider({ apiKey: key }), model: env.PLAYGROUND_MODEL?.trim() || 'claude-sonnet-4-6' };
  }
  const baseURL = env.OLLAMA_HOST?.trim() || 'http://127.0.0.1:11434';
  let named = env.OLLAMA_MODEL?.trim();
  if (named && isOllamaCloudModel(named)) {
    log(`OLLAMA_MODEL=${named} is an Ollama cloud model, which does not run on this machine; using a local one.`);
    named = undefined;
  }
  if (named) return { provider: new OllamaProvider({ baseURL }), model: named };
  const picked = await pickOllamaModel({ baseURL, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
  if (picked.from === 'default') return undefined; // Ollama is not running, or has no chat model
  // A model that is already loaded is asked with the window it is loaded with, so Ollama does not reload it.
  return { provider: new OllamaProvider({ baseURL, ...(picked.numCtx !== undefined ? { defaultOptions: { num_ctx: picked.numCtx } } : {}) }), model: picked.model };
}

/** What a demo that needs a live model prints when there is none. */
export const NO_LIVE_MODEL =
  'No live model. Start Ollama with a model pulled (or set OLLAMA_MODEL=<model>), or ask for Anthropic by name with PLAYGROUND_PROVIDER=anthropic and ANTHROPIC_API_KEY.';
