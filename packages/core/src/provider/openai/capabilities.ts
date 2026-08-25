import type { ModelCapabilities } from '../../types/capabilities.js';

/**
 * Capability tiers for OpenAI models. Conservative on purpose: an unknown model gets
 * a small-but-real profile rather than an optimistic one, because over-claiming a
 * context window produces a request the API rejects, while under-claiming only costs
 * some trimming.
 */
function caps(maxContextTokens: number, maxOutputTokens: number): ModelCapabilities {
  return {
    toolCalling: 'native',
    structuredOutput: 'native',
    streaming: 'full',
    maxContextTokens,
    maxOutputTokens,
  };
}

const KNOWN: Array<{ match: RegExp; caps: ModelCapabilities }> = [
  { match: /^gpt-5/i, caps: caps(400_000, 128_000) },
  { match: /^gpt-4\.1/i, caps: caps(1_047_576, 32_768) },
  { match: /^gpt-4o-mini/i, caps: caps(128_000, 16_384) },
  { match: /^gpt-4o/i, caps: caps(128_000, 16_384) },
  { match: /^o[34]/i, caps: caps(200_000, 100_000) },
];

export function openAiCapabilities(model: string): ModelCapabilities {
  for (const entry of KNOWN) {
    if (entry.match.test(model)) return entry.caps;
  }
  return caps(128_000, 16_384);
}
