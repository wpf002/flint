import type {
  AiObserver,
  RequestEvent,
  ResponseEvent,
  ToolCallEvent,
  ToolResultEvent,
  ErrorEvent,
} from './observer.js';
import type { AiError } from '../types/error.js';

/**
 * A structured, append-only audit entry. The auditability rail: every model
 * request, tool call, tool result, and error is recorded with lineage
 * (requestId ties a turn together), so a consequential action is never a black
 * box. Plain data — safe to persist as JSONL.
 */
export type ActionEntry =
  | { type: 'request'; requestId: string; timestamp: number; model: string; kind: string; toolNames: string[] }
  | { type: 'response'; requestId: string; timestamp: number; model: string; reason: string; durationMs: number; usage: { input: number; output: number } }
  | { type: 'tool_call'; requestId: string; timestamp: number; tool: string; args: unknown; idempotent: boolean }
  | { type: 'tool_result'; requestId: string; timestamp: number; tool: string; result: unknown; isError: boolean; durationMs: number }
  | { type: 'error'; requestId: string; timestamp: number; error: AiError };

/**
 * An observer that records the audit trail. Pass an `onEntry` callback to also
 * stream entries somewhere durable (e.g. append to a JSONL file). Read the
 * accumulated trace with `actions()`.
 */
export class ActionLogObserver implements AiObserver {
  private readonly entries: ActionEntry[] = [];

  /**
   * @param onEntry    called as each entry is recorded (e.g. append to JSONL).
   * @param maxEntries cap the in-memory buffer (oldest dropped) so a
   *                   long-running server doesn't grow unbounded. 0 = unbounded.
   */
  constructor(
    private readonly onEntry?: (entry: ActionEntry) => void,
    private readonly maxEntries = 0,
  ) {}

  onRequest(e: RequestEvent): void {
    this.push({ type: 'request', requestId: e.requestId, timestamp: e.timestamp, model: e.model, kind: e.kind, toolNames: e.toolNames });
  }

  onResponse(e: ResponseEvent): void {
    this.push({ type: 'response', requestId: e.requestId, timestamp: e.timestamp, model: e.model, reason: e.reason, durationMs: e.durationMs, usage: e.usage });
  }

  onToolCall(e: ToolCallEvent): void {
    this.push({ type: 'tool_call', requestId: e.requestId, timestamp: e.timestamp, tool: e.call.toolName, args: e.call.args, idempotent: e.idempotent });
  }

  onToolResult(e: ToolResultEvent): void {
    this.push({ type: 'tool_result', requestId: e.requestId, timestamp: e.timestamp, tool: e.toolName, result: e.result, isError: e.isError, durationMs: e.durationMs });
  }

  onError(e: ErrorEvent): void {
    this.push({ type: 'error', requestId: e.requestId, timestamp: e.timestamp, error: e.error });
  }

  /** The full trace, in order. */
  actions(): ActionEntry[] {
    return [...this.entries];
  }

  /** Just the tool calls + results — the "what did Flint actually do" view. */
  toolTrace(): ActionEntry[] {
    return this.entries.filter((e) => e.type === 'tool_call' || e.type === 'tool_result');
  }

  clear(): void {
    this.entries.length = 0;
  }

  private push(entry: ActionEntry): void {
    this.entries.push(entry);
    if (this.maxEntries > 0 && this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries);
    }
    this.onEntry?.(entry);
  }
}

/** Fan one observer interface out to several (e.g. metrics + audit log). */
export function combineObservers(...observers: AiObserver[]): AiObserver {
  return {
    onRequest: (e) => observers.forEach((o) => o.onRequest?.(e)),
    onResponse: (e) => observers.forEach((o) => o.onResponse?.(e)),
    onError: (e) => observers.forEach((o) => o.onError?.(e)),
    onToolCall: (e) => observers.forEach((o) => o.onToolCall?.(e)),
    onToolResult: (e) => observers.forEach((o) => o.onToolResult?.(e)),
    onDebug: (e) => observers.forEach((o) => o.onDebug?.(e)),
  };
}
