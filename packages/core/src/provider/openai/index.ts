import { OpenAiCompatibleProvider } from './chat.js';
import { openAiCapabilities } from './capabilities.js';

export interface OpenAiProviderOptions {
  /** API key. Passed explicitly — Flint never reads process.env. */
  apiKey: string;
  baseURL?: string;
  /** Fallback output cap when a call doesn't specify one. */
  defaultMaxTokens?: number;
  /** Injectable fetch (tests, proxies, custom transports). */
  fetch?: typeof fetch;
  /** Extra fields merged into every request body. */
  extraBody?: Record<string, unknown>;
  headers?: Record<string, string>;
}

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MAX_TOKENS = 4096;

/**
 * OpenAI, over the chat-completions API.
 *
 * `max_completion_tokens` rather than `max_tokens`: the older field is rejected
 * outright by the reasoning models, and accepted as an alias by the rest, so the
 * newer name is the one that works everywhere OpenAI still serves.
 */
export class OpenAiProvider extends OpenAiCompatibleProvider {
  constructor(opts: OpenAiProviderOptions) {
    super({
      name: 'openai',
      apiKey: opts.apiKey,
      baseURL: opts.baseURL ?? DEFAULT_BASE_URL,
      maxTokensField: 'max_completion_tokens',
      supportsTools: true,
      capabilities: openAiCapabilities,
      defaultMaxTokens: opts.defaultMaxTokens ?? DEFAULT_MAX_TOKENS,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      ...(opts.extraBody ? { extraBody: opts.extraBody } : {}),
      ...(opts.headers ? { headers: opts.headers } : {}),
    });
  }
}

export { OpenAiCompatibleProvider } from './chat.js';
export type { ChatWire } from './chat.js';
export { openAiCapabilities } from './capabilities.js';
export { OpenAiHttpError, toAiError } from './errors.js';
