import { z } from 'zod';

/**
 * What a given model can actually do. Flint inspects these to pick an internal
 * STRATEGY (locked invariant #2) — e.g. native tool-calling vs. prompted-JSON.
 *
 * Apps should query these only for genuinely unbridgeable gaps (a model that
 * cannot do tools at all). If apps branch on `toolCalling === 'native'`
 * everywhere, the abstraction has failed.
 */
export const ModelCapabilitiesSchema = z.object({
  /** native = provider tool API; prompted = JSON-in-prompt + repair; unsupported = no tools. */
  toolCalling: z.enum(['native', 'prompted', 'unsupported']),
  /** native = guaranteed schema; prompted = best-effort + repair; unreliable = no guarantee. */
  structuredOutput: z.enum(['native', 'prompted', 'unreliable']),
  /** full = text + tool events; text-only = text deltas only; none = no streaming. */
  streaming: z.enum(['full', 'text-only', 'none']),
  maxContextTokens: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
});

export type ModelCapabilities = z.infer<typeof ModelCapabilitiesSchema>;
