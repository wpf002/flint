/**
 * Which model is answering, as one paragraph of the system prompt.
 *
 * The frontier guides (v1, v2) describe Flint's engines in general: "Claude's
 * model for most questions, a local open model for private ones and outages".
 * That sentence is part of a pinned text, and one guide speaks for every brain,
 * so a local model asked what it runs on read "Claude's model" and could say
 * so. The guides stay byte-identical (a variant name means one text, see
 * test/flint-variants.test.ts). The fact for the model that is actually
 * answering is added per brain instead, after the guide (PersonaConfig.engine),
 * and is told to win where the two differ.
 */

export interface FlintEngine {
  /** The provider adapter's name: `ollama`, `local` (an OpenAI-compatible local server), `anthropic`, `openai`, `perplexity`. */
  provider: string;
  /** The model as the provider is asked for it (`muse-glimmer:30b`, `claude-opus-5-5`). */
  model: string;
  /** An Ollama cloud model (`...-cloud`): open weights, but run on Ollama's servers. */
  ollamaCloud?: boolean;
}

const HEAD = 'WHAT IS ANSWERING THIS MESSAGE.';
// Short on purpose: it rides on every call, and a local model's window is small.
const TAIL =
  'If Will asks what you run on or whether you are Claude, tell him exactly that, plainly. ' +
  'Where anything above describes your engines differently, this is the fact for this reply. ' +
  'You are still Flint.';

/** A model name as it may appear in a prompt: the characters model ids use, nothing else. */
function shown(model: string): string {
  return model.replace(/[^A-Za-z0-9._:/-]/g, '').slice(0, 100) || 'unnamed';
}

/** Where this reply comes from, in one sentence or two. */
function source(e: FlintEngine): string {
  const model = shown(e.model);
  switch (e.provider) {
    case 'ollama':
      return e.ollamaCloud
        ? `This reply comes from an open model (${model}) that Ollama runs on its own servers, not on Will's hardware. It is not Claude.`
        : `This reply comes from an open model (${model}) that Will runs himself with Ollama. It is not Claude, and no AI company's service is answering.`;
    case 'local':
      // LocalOpenAiProvider: Ollama's /v1, llama.cpp or another server Will runs. The server is not named: Flint may not know which it is.
      return `This reply comes from an open model (${model}) that Will runs himself, on his own model server. It is not Claude, and no AI company's service is answering.`;
    case 'anthropic':
      return `This reply comes from Claude (${model}), Anthropic's model: a borrowed engine, reached over the network.`;
    case 'openai':
      return `This reply comes from ${model}, OpenAI's model: a borrowed engine, reached over the network. It is not Claude.`;
    case 'perplexity':
      return `This reply comes from ${model}, Perplexity's model: a borrowed engine, reached over the network. It is not Claude.`;
    default:
      return `This reply comes from the model ${model}.`;
  }
}

/**
 * The engine paragraph for one brain: what answers, that Will is told so when
 * he asks, and that Flint is still Flint. Pass it as PersonaConfig.engine.
 */
export function flintEngineLine(e: FlintEngine): string {
  return `${HEAD} ${source(e)} ${TAIL}`;
}
