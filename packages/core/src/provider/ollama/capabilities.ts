import type { ModelCapabilities } from '../../types/capabilities.js';

/**
 * Honest capability tiers for local Ollama models (spec §10). We deliberately
 * do NOT claim parity with Anthropic:
 *  - tool calling is `prompted` (the adapter owns the prompt protocol + repair),
 *  - structured output is `prompted` at best,
 *  - context windows are much smaller.
 *
 * Numbers are conservative defaults per model family; unknown models fall back
 * to a small, safe profile. A model's real context can be larger (Ollama lets
 * you raise `num_ctx`), but Flint budgets against the safe default unless the
 * app overrides it.
 */
function caps(
  maxContextTokens: number,
  maxOutputTokens: number,
  structuredOutput: ModelCapabilities['structuredOutput'] = 'prompted',
): ModelCapabilities {
  return {
    toolCalling: 'prompted',
    structuredOutput,
    streaming: 'full',
    maxContextTokens,
    maxOutputTokens,
  };
}

const KNOWN: Array<{ match: RegExp; caps: ModelCapabilities }> = [
  { match: /^llama3\.[12]/i, caps: caps(8_192, 4_096) },
  { match: /^llama3/i, caps: caps(8_192, 4_096) },
  { match: /^qwen2\.5/i, caps: caps(32_768, 8_192) },
  { match: /^mistral|^mixtral/i, caps: caps(8_192, 4_096) },
  { match: /^phi3/i, caps: caps(4_096, 4_096, 'unreliable') },
  { match: /^gemma2?/i, caps: caps(8_192, 4_096) },
];

export function ollamaCapabilities(model: string): ModelCapabilities {
  for (const entry of KNOWN) {
    if (entry.match.test(model)) return entry.caps;
  }
  // Unknown local model: assume a small window and unreliable structure.
  return caps(4_096, 2_048, 'unreliable');
}
