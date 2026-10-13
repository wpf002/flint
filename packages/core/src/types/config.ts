import type { ProviderAdapter } from '../provider/adapter.js';
import type { AiObserver } from '../observability/observer.js';
import type { MemoryStore } from '../memory/store.js';
import type { ToolCall } from './tool.js';

/**
 * Context-assembly strategy (context.ts). The default is ALWAYS explicit —
 * Flint never silently "stuffs everything" into the window.
 *
 * - `full`           — send everything; throw `context_overflow` if it won't fit.
 * - `truncate_oldest` — drop oldest non-system messages until it fits.
 * - `summarize`      — summarize dropped history into a synthetic system note.
 */
export type ContextStrategy = 'full' | 'truncate_oldest' | 'summarize';

/**
 * Retry policy for transient, RETRYABLE provider failures. Never overrides the
 * idempotency rule (invariant #5): a non-idempotent tool that already executed
 * is not auto-retried regardless of this policy.
 */
export interface RetryPolicy {
  /** Max attempts for a single provider call (1 = no retry). */
  maxAttempts: number;
  /** Base backoff in ms; actual delay is exponential w/ jitter. */
  baseDelayMs: number;
  /** Ceiling for a single backoff delay. */
  maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 250,
  maxDelayMs: 4000,
};

/**
 * Per-call escape hatches (spec §7.9). Every public Flint method accepts this.
 * These let an app override Flint's decisions for one call and see why Flint
 * did what it did (invariant #6, the corollary to the prime directive).
 */
export interface CallOptions {
  /** Override the configured default model for this call. */
  model?: string;
  retryPolicy?: RetryPolicy;
  contextStrategy?: ContextStrategy;
  maxTokens?: number;
  /**
   * When true, capture and surface the raw provider request/response through
   * the observer (`onDebug`) without filtering. Off by default.
   */
  debug?: boolean;
  /** Cancellation. */
  signal?: AbortSignal;
  /**
   * Opaque, app-owned context object. Flint never interprets it — it is passed
   * verbatim to the observer and memory store (spec §12).
   */
  context?: unknown;
}

/**
 * Configuration handed to `new Flint(...)` by the consuming app. `@flint/core`
 * reads no env directly — everything it needs arrives here (spec §3.7).
 */
export interface FlintConfig {
  provider: ProviderAdapter;
  defaultModel: string;
  /** Defaults to a no-op observer. */
  observer?: AiObserver;
  /** Defaults to an InMemoryStore. */
  memory?: MemoryStore;
  /** Per-provider concurrency limit. Defaults to a conservative value. */
  maxConcurrent?: number;
  /** Default retry policy for the client; overridable per call. */
  retryPolicy?: RetryPolicy;
  /** Default context strategy for the client; overridable per call. */
  contextStrategy?: ContextStrategy;
  /**
   * Size the WHOLE prompt to the model's window, for a model whose window is
   * small enough to matter (a local one). Off by default: the client then
   * behaves as it always has, and gives the messages at least half the input
   * window whatever the system prompt and tools take, which on a small window
   * can add up to more than the model holds (the server then cuts the START of
   * the prompt: the persona and the tools).
   *
   * On, nothing is sent that does not fit:
   *  - tools are left out, last first, until the system prompt and the tools
   *    that remain leave the messages a quarter of the input window (or the
   *    newest message, when that is more). List the tools that matter first,
   *    and mark a tool chosen for the message being asked `keep` (Tool.keep):
   *    it is left out only after every tool that is not;
   *  - the messages get exactly what is left, oldest dropped first as the
   *    context strategy says;
   *  - when the system prompt alone leaves no room for the newest message, the
   *    call fails with `context_overflow` before anything is sent.
   * What was left out is reported through the observer (`onContext`).
   */
  fitToWindow?: boolean;
  /**
   * What to tell the model when it calls a tool this call did not offer, in
   * place of the default ("Unknown tool 'x'. Available tools: ..."). An app
   * that holds a tool back on purpose (a turn that must not reach outside
   * services) can say why, so the model tells the user instead of guessing.
   * Return undefined for the default. Whatever it returns is the call's
   * result, marked as an error; Flint runs nothing for such a call, and a
   * function that throws gets the default.
   */
  unknownTool?: (call: ToolCall, offered: readonly string[]) => unknown;
}
