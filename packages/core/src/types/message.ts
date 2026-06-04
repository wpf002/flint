import { z } from 'zod';

/**
 * Canonical message roles. Provider-independent.
 *
 * - `system`      — system prompt / instructions
 * - `user`        — end-user input
 * - `assistant`   — model output
 * - `tool`        — a request to invoke a tool (assistant-initiated, normalized)
 * - `tool_result` — the result of a tool invocation, fed back to the model
 */
export const Role = z.enum(['system', 'user', 'assistant', 'tool', 'tool_result']);
export type Role = z.infer<typeof Role>;

/**
 * The canonical Message. This is Flint's own shape — never a provider's.
 *
 * `content` is always a string. For `tool` / `tool_result` messages the
 * structured payload is JSON-encoded into `content`; the structured form is
 * reconstructed from `toolCallId` + the parsed JSON at the loop boundary.
 * Keeping `content` a string keeps the persisted shape stable across
 * provider and package versions (locked invariant #1, #7).
 */
export const MessageSchema = z.object({
  id: z.string().min(1),
  role: Role,
  content: z.string(),
  toolCallId: z.string().min(1).optional(),
  timestamp: z.number().int().nonnegative(),
});

export type Message = z.infer<typeof MessageSchema>;

/** Parse + validate an unknown value as a Message (boundary guard, invariant #7). */
export function parseMessage(value: unknown): Message {
  return MessageSchema.parse(value);
}
