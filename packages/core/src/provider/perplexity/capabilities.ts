import type { ModelCapabilities } from '../../types/capabilities.js';

/**
 * Perplexity's Sonar models. Reported honestly, which here means admitting a real
 * gap: these are search-grounded completion models with no function-calling API, so
 * `toolCalling` is 'unsupported' rather than a hopeful 'prompted'. Anything that
 * needs tools should route elsewhere; what these are for is an answer with sources.
 */
function caps(maxContextTokens: number, maxOutputTokens: number): ModelCapabilities {
  return {
    toolCalling: 'unsupported',
    structuredOutput: 'prompted',
    streaming: 'text-only',
    maxContextTokens,
    maxOutputTokens,
  };
}

const KNOWN: Array<{ match: RegExp; caps: ModelCapabilities }> = [
  { match: /^sonar-deep-research/i, caps: caps(128_000, 8_192) },
  { match: /^sonar-reasoning-pro/i, caps: caps(128_000, 8_192) },
  { match: /^sonar-reasoning/i, caps: caps(128_000, 8_192) },
  { match: /^sonar-pro/i, caps: caps(200_000, 8_192) },
  { match: /^sonar/i, caps: caps(128_000, 8_192) },
];

export function perplexityCapabilities(model: string): ModelCapabilities {
  for (const entry of KNOWN) {
    if (entry.match.test(model)) return entry.caps;
  }
  return caps(128_000, 4_096);
}
