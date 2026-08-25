import { z } from 'zod';

/**
 * Responder configuration.
 *
 * Every participant is one Nexus namespace plus one model. The namespace token is
 * what gives the turn its authorship — Nexus derives the author from the token and
 * never from anything the model writes — so a participant can only ever speak as
 * itself, no matter what the model puts in its reply.
 */

/** Secrets live in the environment; the config file holds a reference, not a value. */
const Secret = z
  .string()
  .min(1)
  .describe("A literal value, or 'env:NAME' to read it from the environment.");

export const ParticipantConfigSchema = z
  .object({
    slug: z.string().min(1).describe('Nexus namespace slug this participant speaks as.'),
    token: Secret.describe('Nexus token for that namespace.'),
    provider: z.enum(['anthropic', 'openai', 'perplexity', 'ollama']),
    model: z.string().min(1),
    apiKey: Secret.optional().describe('Provider API key. Not needed for ollama.'),
    baseURL: z.string().url().optional(),
    role: z
      .string()
      .max(400)
      .optional()
      .describe('What this participant is good at. Published to Nexus so routing and nominations have something to match on.'),
    /*
     * Room for the contribution plus the JSON wrapper around it. 1500 was too tight:
     * turns hit the cap mid-object, which arrived as unparseable JSON rather than as
     * "ran out of room", and the thread stalled without saying why.
     */
    maxOutputTokens: z.number().int().min(256).max(32_000).default(4_000),
    /*
     * Provider-specific request fields, merged verbatim. Exists because a reasoning
     * model spends its output budget on reasoning before it writes anything visible,
     * so `reasoning_effort` is the difference between a turn that fits and one that is
     * cut off — and that knob has no equivalent on the other providers.
     */
    options: z.record(z.unknown()).optional(),
  })
  .strict();

export type ParticipantConfig = z.infer<typeof ParticipantConfigSchema>;

export const ResponderConfigSchema = z
  .object({
    nexusUrl: z.string().url().describe('Nexus MCP endpoint, e.g. https://nexus-mcp.up.railway.app/mcp'),
    pollMs: z.number().int().min(2_000).default(15_000),

    /*
     * Two independent brakes, because an autonomous loop that bills per turn needs
     * both. The per-tick cap bounds spend over time; the per-thread cap bounds a
     * single conversation that has stopped converging.
     */
    maxTurnsPerTick: z.number().int().min(1).max(50).default(4),
    maxTurnsPerThread: z.number().int().min(2).max(200).default(20),

    /** Stop taking turns entirely after this many model calls. 0 disables the loop's own limit. */
    maxTurnsPerRun: z.number().int().min(0).default(0),
    /*
     * The cap that survives a restart. A supervised process that crashes comes back
     * with a fresh run budget, so the run cap alone bounds nothing once the loop is
     * left running. 0 disables it.
     */
    maxTurnsPerDay: z.number().int().min(0).default(60),
    participants: z.array(ParticipantConfigSchema).min(1),
  })
  .strict();

export type ResponderConfig = z.infer<typeof ResponderConfigSchema>;

/** Resolves an `env:NAME` reference, or passes a literal through unchanged. */
export function resolveSecret(value: string, label: string): string {
  if (!value.startsWith('env:')) return value;
  const name = value.slice(4);
  const found = process.env[name]?.trim();
  if (!found) throw new Error(`${label} points at $${name}, which is unset or empty.`);
  return found;
}

export function parseConfig(raw: unknown): ResponderConfig {
  const cfg = ResponderConfigSchema.parse(raw);

  const seen = new Set<string>();
  for (const p of cfg.participants) {
    if (seen.has(p.slug)) {
      throw new Error(`Two participants both claim the namespace '${p.slug}'. Each namespace speaks once.`);
    }
    seen.add(p.slug);
    if (p.provider !== 'ollama' && !p.apiKey) {
      throw new Error(`Participant '${p.slug}' uses ${p.provider} and needs an apiKey.`);
    }
  }
  return cfg;
}
