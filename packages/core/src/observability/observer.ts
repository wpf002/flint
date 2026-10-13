import type { Message } from '../types/message.js';
import type { ToolCall } from '../types/tool.js';
import type { TokenUsage } from '../types/stream.js';
import type { AiError } from '../types/error.js';

/** Context shared by every observer event so logs can be correlated. */
export interface ObserverEventBase {
  /** Correlates all events for one logical operation. */
  requestId: string;
  /** Provider name (e.g. 'anthropic'). */
  provider: string;
  model: string;
  /** Wall-clock ms (injected by core; core itself never reads the clock for logs). */
  timestamp: number;
  /** Opaque, app-supplied context passed through from CallOptions. */
  context?: unknown;
}

export interface RequestEvent extends ObserverEventBase {
  messages: Message[];
  system?: string;
  toolNames: string[];
  /** 'generate' | 'stream' | a tool-loop continuation. */
  kind: string;
}

export interface ResponseEvent extends ObserverEventBase {
  usage: TokenUsage;
  reason: string;
  /** ms from request to completion. */
  durationMs: number;
}

export interface ErrorEvent extends ObserverEventBase {
  error: AiError;
}

export interface ToolCallEvent extends ObserverEventBase {
  call: ToolCall;
  idempotent: boolean;
}

/**
 * The OUTCOME of a tool call — emitted after the handler runs (success or
 * failure). Together with `onToolCall` this gives the full call→result lineage
 * an audit log needs (auditability rail).
 */
export interface ToolResultEvent extends ObserverEventBase {
  toolCallId: string;
  toolName: string;
  /** The handler's return value (or an error payload on failure). */
  result: unknown;
  isError: boolean;
  durationMs: number;
}

/**
 * Raw, UNFILTERED provider payloads — only emitted when a call sets
 * `debug: true`. This is the escape hatch that lets an app developer see
 * exactly what Flint sent to and got from the provider.
 */
export interface DebugEvent extends ObserverEventBase {
  phase: 'request' | 'response';
  /** The raw provider-shaped payload. Intentionally untyped and unfiltered. */
  raw: unknown;
}

/**
 * How a call's prompt was sized to the model's window, once per call, before
 * anything is sent. Numbers and tool names only: nothing of the prompt itself.
 * An app that wants to know when history was left out to make a prompt fit (a
 * small local window) reads `messages.dropped`.
 */
export interface ContextEvent extends ObserverEventBase {
  /** The model's context window, as its adapter reports it. */
  windowTokens: number;
  /** Tokens kept for the reply. */
  reserveTokens: number;
  /** The system prompt and the tool schemas that are sent. */
  fixedTokens: number;
  /** What was left for the messages. */
  budgetTokens: number;
  /** The conversation as it is sent: how many messages, and how many of the oldest were left out to fit. */
  messages: { kept: number; dropped: number };
  /** The tools as they are sent: how many, and the names left out so the prompt fits (`fitToWindow`). */
  tools: { offered: number; shed: string[] };
  /** True when the client was asked to fit the whole prompt to the window (FlintConfig.fitToWindow). */
  fitted: boolean;
}

/**
 * All observability flows through this injected interface (locked invariant #6).
 * Core NEVER calls `console.*`. Every method is optional so implementers wire
 * up only what they need; the default implementation is a no-op.
 */
export interface AiObserver {
  /** Once per call, after the prompt was sized and before it is sent. */
  onContext?(event: ContextEvent): void;
  onRequest?(event: RequestEvent): void;
  onResponse?(event: ResponseEvent): void;
  onError?(event: ErrorEvent): void;
  onToolCall?(event: ToolCallEvent): void;
  onToolResult?(event: ToolResultEvent): void;
  onDebug?(event: DebugEvent): void;
}

/** The default observer: does nothing. Used whenever the app supplies none. */
export const noopObserver: AiObserver = {};
