/**
 * @flint/core — one swappable, provider-agnostic AI layer.
 *
 * This barrel is the ENTIRE public API. Anything not exported here is internal
 * and may change without a breaking-version bump. App code imports only from
 * `@flint/core` and never from a vendor SDK (the prime directive).
 */

// --- the client -------------------------------------------------------------
export { Flint } from './core/client.js';
export type {
  Tool,
  GenerateInput,
  ChatInput,
  GenerateOutcome,
} from './core/client.js';

// --- canonical message types ------------------------------------------------
export { MessageSchema, parseMessage, Role } from './types/message.js';
export type { Message } from './types/message.js';

// --- streaming --------------------------------------------------------------
export {
  StreamEventSchema,
  StreamDoneReason,
  TokenUsageSchema,
} from './types/stream.js';
export type { StreamEvent, TokenUsage } from './types/stream.js';

// --- tools ------------------------------------------------------------------
export { ToolDefinitionSchema, ToolCallSchema } from './types/tool.js';
export type {
  ToolDefinition,
  ToolCall,
  ToolResult,
  ToolHandler,
} from './types/tool.js';

// --- errors -----------------------------------------------------------------
export {
  AiErrorKind,
  AiErrorSchema,
  FlintError,
  makeAiError,
  isFlintError,
} from './types/error.js';
export type { AiError } from './types/error.js';

// --- capabilities -----------------------------------------------------------
export { ModelCapabilitiesSchema } from './types/capabilities.js';
export type { ModelCapabilities } from './types/capabilities.js';

// --- config & per-call escape hatches ---------------------------------------
export { DEFAULT_RETRY_POLICY } from './types/config.js';
export type {
  FlintConfig,
  CallOptions,
  RetryPolicy,
  ContextStrategy,
} from './types/config.js';

// --- provider contract ------------------------------------------------------
export type {
  ProviderAdapter,
  GenerateArgs,
  GenerateResult,
} from './provider/adapter.js';

// --- observability ----------------------------------------------------------
export { noopObserver } from './observability/observer.js';
export type {
  AiObserver,
  ObserverEventBase,
  RequestEvent,
  ResponseEvent,
  ErrorEvent,
  ToolCallEvent,
  DebugEvent,
} from './observability/observer.js';

// --- memory -----------------------------------------------------------------
export { InMemoryStore } from './memory/in-memory.js';
export { SCHEMA_VERSION, TurnSchema, TurnStatus } from './memory/store.js';
export type {
  MemoryStore,
  Turn,
  BeginTurnInput,
  CommitTurnInput,
  FailTurnInput,
} from './memory/store.js';

// --- helpers for reading stored history -------------------------------------
export {
  decodeAssistantTurn,
  decodeToolCalls,
  decodeToolResult,
} from './core/encoding.js';
export type { AssistantTurn } from './core/encoding.js';

// --- providers --------------------------------------------------------------
export { AnthropicProvider } from './provider/anthropic/index.js';
export type { AnthropicProviderOptions } from './provider/anthropic/index.js';
