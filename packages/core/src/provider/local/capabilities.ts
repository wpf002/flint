import type { ModelCapabilities } from '../../types/capabilities.js';

/**
 * What a caller knows about one model on a local server.
 *
 * There is no table here on purpose. A local server runs whatever model it was
 * given, at whatever context it was started with, so the facts come from the
 * caller: the server's own report (Ollama's /api/show), or the caller's own
 * choice of model. A model nobody has facts for must be given `tools: false`:
 * claiming tool calls it can't make is worse than not offering them.
 */
export interface LocalModelFacts {
  /** The context window the server runs the model with, in tokens. */
  contextTokens: number;
  /** The reply's share of that window. Default: a quarter of it, at most 4096. */
  maxOutputTokens?: number;
  /** Can the model call tools through the server's own function-calling API? */
  tools: boolean;
  /** Can it read images? Absent means no. */
  vision?: boolean;
  /** Does the server hold a reply to a JSON schema (`response_format`)? Default true. */
  structured?: boolean;
}

/** The share of the window set aside for the reply when the caller names none. */
const DEFAULT_MAX_OUTPUT = 4096;

/**
 * Honest capabilities for one local model. `tools: false` gives
 * `toolCalling: 'unsupported'`, which is the flag a router reads and what keeps
 * the adapter from offering the model any tools.
 */
export function localCapabilities(f: LocalModelFacts): ModelCapabilities {
  const context = Math.max(1, Math.floor(f.contextTokens));
  const output = f.maxOutputTokens ?? Math.min(DEFAULT_MAX_OUTPUT, Math.floor(context / 4));
  return {
    toolCalling: f.tools ? 'native' : 'unsupported',
    structuredOutput: f.structured === false ? 'unreliable' : 'native',
    streaming: 'full',
    maxContextTokens: context,
    maxOutputTokens: Math.max(1, Math.min(Math.floor(output), context)),
    ...(f.vision ? { vision: true } : {}),
  };
}
