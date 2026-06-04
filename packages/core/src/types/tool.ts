import { z } from 'zod';

/**
 * A tool the model may call. Provider-independent.
 *
 * `idempotent` is REQUIRED and gates auto-retry (locked invariant #5):
 * a non-idempotent (side-effecting) tool that already executed is NEVER
 * auto-retried by Flint — the failure surfaces to the app instead.
 */
export const ToolDefinitionSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  /** JSON Schema describing the tool's input. Opaque to Flint; passed to the provider. */
  inputSchema: z.record(z.string(), z.unknown()),
  idempotent: z.boolean(),
});

export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: object;
  idempotent: boolean;
};

/**
 * A normalized request from the model to invoke a tool. Providers map their
 * native tool-use payloads onto this. `rawProviderPayload` is retained for
 * debugging / escape-hatch capture but is never interpreted by core.
 */
export const ToolCallSchema = z.object({
  id: z.string().min(1),
  toolName: z.string().min(1),
  args: z.unknown(),
  rawProviderPayload: z.unknown().optional(),
});

export type ToolCall = {
  id: string;
  toolName: string;
  args: unknown;
  rawProviderPayload?: unknown;
};

/**
 * The result of executing a tool, produced by an app-supplied handler and fed
 * back into the loop. `isError` lets a handler signal a soft failure that the
 * model should see (vs. throwing, which aborts the turn).
 */
export interface ToolResult {
  toolCallId: string;
  toolName: string;
  /** JSON-serializable result payload. */
  result: unknown;
  isError?: boolean;
}

/** A handler the app registers per tool. May be async; receives parsed args. */
export type ToolHandler = (
  call: ToolCall,
) => Promise<unknown> | unknown;
