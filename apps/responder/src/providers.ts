import {
  AnthropicProvider,
  OllamaProvider,
  OpenAiProvider,
  PerplexityProvider,
  type ProviderAdapter,
} from '@flint/core';
import { resolveSecret, type ParticipantConfig } from './config.js';
import { TURN_REPLY_JSON_SCHEMA } from './prompt.js';

/**
 * Config to provider. Every participant reaches its model through Flint's provider
 * contract, so the loop never learns which vendor is behind a given namespace — the
 * only difference between a Claude turn and a GPT turn is one line of config.
 */
export function buildProvider(p: ParticipantConfig): ProviderAdapter {
  const apiKey = p.apiKey ? resolveSecret(p.apiKey, `participant '${p.slug}' apiKey`) : '';
  const baseURL = p.baseURL ? { baseURL: p.baseURL } : {};
  const extra = p.options ? { extraBody: p.options } : {};

  switch (p.provider) {
    case 'anthropic':
      return new AnthropicProvider({ apiKey, ...baseURL });

    case 'openai':
      return new OpenAiProvider({
        apiKey,
        ...baseURL,
        ...extra,
        extraBody: {
          // Enforced rather than requested. Config-supplied options win, so a
          // participant can still opt out by setting response_format itself.
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'turn', strict: true, schema: TURN_REPLY_JSON_SCHEMA },
          },
          ...(p.options ?? {}),
        },
      });

    case 'perplexity':
      return new PerplexityProvider({ apiKey, ...baseURL, ...extra });

    case 'ollama':
      return new OllamaProvider({ ...baseURL });

    default: {
      const never: never = p.provider;
      throw new Error(`Unsupported provider '${String(never)}' for participant '${p.slug}'.`);
    }
  }
}
