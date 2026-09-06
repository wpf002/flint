import type { Message } from '../types/message.js';
import type { StreamEvent, TokenUsage, StreamDoneReason } from '../types/stream.js';
import type { ToolDefinition } from '../types/tool.js';
import type { ModelCapabilities } from '../types/capabilities.js';

/**
 * Where a provider may put a prompt-cache breakpoint for this call.
 *
 * This is a pure COST hint and never a behavioural one: a provider that ignores
 * it sends exactly the same prompt, and a provider that honours it gets the same
 * answer back — the marked prefix is simply billed at the cache-read rate instead
 * of being re-charged at full input price on every repeat call. It lives in the
 * contract rather than in one adapter's escape hatch because the caller is the
 * only party that knows which half of its prompt is actually stable.
 */
export interface CacheHints {
  /** Put a breakpoint at the end of the system prompt (after `systemSuffix`, if any, is split off). */
  system?: boolean;
  /** Put a breakpoint on the LAST tool. */
  tools?: boolean;
  /**
   * Put the tool breakpoint on the tool at this index instead of the last one.
   * That matters when a router appends variable tools after a fixed core: the
   * breakpoint belongs on the last FIXED tool, so an append-triggering request
   * still reads the core schemas from cache rather than paying full price for
   * everything. Out-of-range values are ignored.
   */
  toolsThrough?: number;
  /**
   * The volatile tail of `system` — a literal SUFFIX of that same string, not a
   * replacement for or an addition to it. Everything before it is the stable,
   * cacheable half. A provider that ignores this still sends an identical
   * `system`, which is why splitting here can never change the answer.
   */
  systemSuffix?: string;
}

/** Shared shape for the two generation entry points. */
export interface GenerateArgs {
  model: string;
  system?: string;
  messages: Message[];
  tools?: ToolDefinition[];
  /**
   * How the model may use the supplied tools.
   *
   * `{ name }` forces exactly that tool, which is how a provider guarantees a reply's
   * shape rather than being asked for it in the prompt. Every provider here expresses
   * the same three states, so it belongs in the contract rather than in each adapter's
   * escape hatch.
   */
  toolChoice?: 'auto' | 'required' | { name: string };
  maxTokens?: number;
  /**
   * Optional prompt-cache breakpoints. Providers that don't cache (Ollama,
   * OpenAI, Perplexity) ignore it; omit it and the request is byte-identical to
   * one made before this field existed.
   */
  cache?: CacheHints;
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
