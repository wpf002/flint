import type { Message } from '../types/message.js';
import type { StreamEvent, TokenUsage, StreamDoneReason } from '../types/stream.js';
import type { ToolDefinition } from '../types/tool.js';
import type { ModelCapabilities } from '../types/capabilities.js';

/** Shared shape for the two generation entry points. */
export interface GenerateArgs {
  model: string;
  system?: string;
  messages: Message[];
  tools?: ToolDefinition[];
  maxTokens?: number;
  signal?: AbortSignal;
}

/** Result of a single-shot generation. */
export interface GenerateResult {
  message: Message;
  usage: TokenUsage;
  reason: StreamDoneReason;
}

/**
 * The ONLY surface `core/` knows about a provider. Anthropic, Ollama, etc.
 * each implement this; nothing in `core/` imports a vendor SDK (invariant #1).
 *
 * A provider is responsible for:
 *  - mapping its native event stream onto canonical `StreamEvent`s,
 *  - guaranteeing a stream ALWAYS ends with exactly one `done` or `error`,
 *  - mapping native errors onto `AiError` with correct `kind` / `retryable`,
 *  - reporting honest `getCapabilities` (no claiming parity it can't deliver).
 */
export interface ProviderAdapter {
  readonly name: string;

  /** Capabilities for a specific model string. Drives internal strategy. */
  getCapabilities(model: string): ModelCapabilities;

  /** Best-effort token estimate for budgeting (context assembly). */
  estimateTokens(messages: Message[], model: string): number;

  /** Single-shot, non-streaming generation. */
  generate(args: GenerateArgs): Promise<GenerateResult>;

  /**
   * Streaming generation. Yields normalized `StreamEvent`s and ALWAYS ends
   * with a `done` or `error` event (never just stops).
   */
  stream(args: GenerateArgs): AsyncIterable<StreamEvent>;
}
