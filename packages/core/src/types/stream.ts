import { z } from 'zod';
import { ToolCallSchema, type ToolCall } from './tool.js';
import { AiErrorSchema, type AiError } from './error.js';

/** Token accounting for a single generation. */
export const TokenUsageSchema = z.object({
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
});
export type TokenUsage = z.infer<typeof TokenUsageSchema>;

/**
 * Why a generation terminated. Normalized across providers; the tool-call loop
 * is driven entirely by this (`tool_call` → run tools and continue).
 */
export const StreamDoneReason = z.enum([
  'complete',
  'tool_call',
  'max_tokens',
  'error',
]);
export type StreamDoneReason = z.infer<typeof StreamDoneReason>;

/**
 * The canonical streaming event. Every provider maps its native event stream
 * onto this discriminated union. A stream ALWAYS terminates with exactly one
 * `done` or one `error` event (contract-tested, Section 8).
 */
export const StreamEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), delta: z.string() }),
  z.object({ type: z.literal('tool_call'), call: ToolCallSchema }),
  z.object({
    type: z.literal('done'),
    reason: StreamDoneReason,
    usage: TokenUsageSchema,
  }),
  z.object({ type: z.literal('error'), error: AiErrorSchema }),
]);

export type StreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'done'; reason: StreamDoneReason; usage: TokenUsage }
  | { type: 'error'; error: AiError };
