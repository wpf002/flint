import { z } from 'zod';
import { ToolCallSchema, type ToolCall } from './tool.js';
import { AiErrorSchema, type AiError } from './error.js';

/** Token accounting for a single generation. */
export const TokenUsageSchema = z.object({
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  /**
   * Input tokens WRITTEN to the provider's prompt cache (a one-off premium).
   * Optional: only providers that cache report it.
   */
  cacheWrite: z.number().int().nonnegative().optional(),
  /**
   * Input tokens READ back from that cache — the cheap ones, and therefore the
   * only visible proof a breakpoint is paying for itself. Without this a cache
   * hit is indistinguishable from a miss in the logs.
   */
  cacheRead: z.number().int().nonnegative().optional(),
});
export type TokenUsage = z.infer<typeof TokenUsageSchema>;

/**
 * Why a generation terminated. Normalized across providers; the tool-call loop
 * is driven entirely by this (`tool_call` → run tools and continue).
 *
 * `refusal`: the provider stopped the turn on a policy decision (Anthropic's
 * `stop_reason: "refusal"`, OpenAI's `refusal` field or `content_filter`). The
 * text is usually empty or cut short, so it is not a completed answer: a chat
 * turn that ends this way is not committed to memory, and a caller can try
 * another model instead of showing the user nothing.
 */
export const StreamDoneReason = z.enum([
  'complete',
  'tool_call',
  'max_tokens',
  'refusal',
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
  z.object({ type: z.literal('error'), error: AiErrorSchema, usage: TokenUsageSchema.optional() }),
]);

export type StreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'done'; reason: StreamDoneReason; usage: TokenUsage }
  /**
   * `usage`: what the provider had already billed when the stream failed or was
   * cancelled (a closed tab, a timeout). A request that got as far as the model
   * is billed its full input and whatever output was generated, so an adapter
   * that knows it reports it here; absent when nothing was billed or it can't tell.
   */
  | { type: 'error'; error: AiError; usage?: TokenUsage };
