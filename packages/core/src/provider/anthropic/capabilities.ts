import type { ModelCapabilities } from '../../types/capabilities.js';

/**
 * Per-model capability table for Anthropic models. Honest, real limits — the
 * adapter never claims a capability the model can't deliver. Unknown models
 * fall back to a conservative Sonnet-class profile.
 */
const KNOWN: Record<string, ModelCapabilities> = {
  'claude-opus-4-8': caps(200_000, 32_000),
  'claude-sonnet-4-6': caps(200_000, 64_000),
  'claude-haiku-4-5-20251001': caps(200_000, 32_000),
};

function caps(maxContextTokens: number, maxOutputTokens: number): ModelCapabilities {
  return {
    toolCalling: 'native',
    structuredOutput: 'native',
    streaming: 'full',
    maxContextTokens,
    maxOutputTokens,
  };
}

export function anthropicCapabilities(model: string): ModelCapabilities {
  return KNOWN[model] ?? caps(200_000, 32_000);
}
