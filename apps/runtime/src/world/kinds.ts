/**
 * What each kind of entity may hold as state: categorical facts only (plan
 * 3.0.5). Anything that changes on its own from minute to minute (latency, a
 * pid, a timestamp, a dollar figure) belongs in MetricPoint instead, so a quiet
 * day creates no versions. A field not listed here is refused, not ignored.
 */
import { z } from 'zod';

const sha = z.string().regex(/^[0-9a-f]{7,64}$/);
const short = z.string().max(120);
/** An instant, as a UTC ISO string to the millisecond (what Date#toISOString gives). */
const isoTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
/** sha256 of an address, lowercased and trimmed (people are keyed by it, never by the address). */
const emailHash = z.string().regex(/^[0-9a-f]{64}$/);

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
  // P2.5: an event on Will's calendar (a time he has given away). Times are the
  // event's own, not volatile; the title is never here (EntityText). Attendees
  // are counted, and named only as hashes of their addresses: the people Will
  // may meet are created from them (PersonGuard), and nobody else.
  commitment: z
    .object({
      source: z.enum(['google_calendar']),
      startsAt: isoTime,
      endsAt: isoTime,
      allDay: z.boolean(),
      // Will's answer. A declined event is not a commitment and is never kept.
      response: z.enum(['accepted', 'tentative', 'needs_action', 'organizer']),
      eventStatus: z.enum(['confirmed', 'tentative']),
      // Calendar commitments are Will's own; later sources (mail, chat) propose unconfirmed ones.
      confirmation: z.enum(['confirmed', 'unconfirmed']),
      recurring: z.boolean().optional(),
      attendeeHashes: z.array(emailHash).max(200).optional(),
    })
    .strict(),
  // P2.5 (Decision 17): someone on an event Will accepted, and only that: their
  // name (tainted) and address. Created only through world.person.create.
  person: z.object({ source: z.enum(['google_calendar']), email: z.string().email().max(254), emailHash }).strict(),
};

/** Kinds an ordinary sync may never write: a person exists only through world.person.create (PersonGuard). */
export const GUARDED_KINDS = new Set(['person']);
