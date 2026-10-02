/**
 * What each kind of entity may hold as state: categorical facts only (plan
 * 3.0.5). Anything that changes on its own from minute to minute (latency, a
 * pid, a timestamp, a dollar figure) belongs in MetricPoint instead, so a quiet
 * day creates no versions. A field not listed here is refused, not ignored.
 */
import { z } from 'zod';

const sha = z.string().regex(/^[0-9a-f]{7,64}$/);
const short = z.string().max(120);

export const STATE: Record<string, z.ZodTypeAny> = {
  service: z
    .object({
      managedBy: z.enum(['launchd', 'railway', 'brew', 'docker', 'other']),
      health: z.enum(['ok', 'degraded', 'down', 'unknown']).optional(),
      loaded: z.boolean().optional(),
      running: z.boolean().optional(),
      lastExit: z.number().int().min(-255).max(255).nullable().optional(),
      disabled: z.boolean().optional(),
    })
    .strict(),
  repo: z
    .object({
      host: z.enum(['github', 'local']),
      defaultBranch: short.optional(),
      branch: short.optional(),
      headSha: sha.optional(),
      dirty: z.boolean().optional(),
    })
    .strict(),
  deployment: z
    .object({
      target: z.enum(['studio', 'railway']),
      status: z.enum(['building', 'deploying', 'success', 'failed', 'crashed', 'removed', 'unknown']),
      sha: sha.optional(),
    })
    .strict(),
  account: z
    .object({
      vendor: z.enum(['anthropic', 'openai', 'perplexity', 'gemini', 'tavily', 'railway', 'github', 'other']),
      level: z.enum(['normal', '50', '80', '100']),
    })
    .strict(),
  // byBot: a bot opened it (P2: never judged by the model); present only when true.
  pull_request: z.object({ number: z.number().int().positive(), state: z.enum(['open', 'closed', 'merged']), draft: z.boolean().optional(), title: short.optional(), byBot: z.literal(true).optional() }).strict(),
  issue: z.object({ number: z.number().int().positive(), state: z.enum(['open', 'closed']), labels: z.array(short).max(20).optional(), title: short.optional(), byBot: z.literal(true).optional() }).strict(),
  ci_run: z.object({ workflow: short, status: z.enum(['queued', 'in_progress', 'completed']), conclusion: z.enum(['success', 'failure', 'cancelled', 'skipped', 'timed_out', 'neutral', 'action_required']).nullable().optional(), sha: sha.optional() }).strict(),
  project: z.object({ status: z.enum(['active', 'archived']).optional() }).strict(),
  thread: z.object({ status: z.enum(['open', 'archived']).optional(), project: short.optional() }).strict(),
  deadline: z.object({ dueOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), source: short }).strict(),
};

/** People are FORBIDDEN in P1 (world.person.create). */
export const FORBIDDEN_KINDS = new Set(['person']);
