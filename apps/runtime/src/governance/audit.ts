/**
 * The audit trail (plan 3.0.7): one writer (this runtime), append-only in the
 * database, and never a place for PERSONAL free text. `inputs` holds ids,
 * hashes, enums and numbers only: every string in it is at most 200 characters
 * and the whole object at most 16 KB, enforced here and by a CHECK.
 */
import { z } from 'zod';
import { redact } from '@flint/policy';
import { jsonbBytes } from '../jsonsize.js';
import { Prisma } from '@prisma/client';
import type { Db, Tx } from '../db.js';

const Scalar = z.union([z.string().max(200), z.number().finite(), z.boolean(), z.null()]);
const Inputs = z
  .record(z.string().max(64), z.union([Scalar, z.array(Scalar).max(50)]))
  .refine((o) => Object.keys(o).length <= 40, 'too many inputs')
  .refine((o) => jsonbBytes(o) <= 16384, 'inputs are over 16 KB');

export const AuditIn = z
  .object({
    /** Supplied by the server's spool so a replay is idempotent. */
    id: z.string().regex(/^[a-z0-9]{8,40}$/).optional(),
    at: z.string().datetime({ offset: true }).optional(),
    actor: z.string().min(1).max(100),
    context: z.enum(['chat', 'autonomous', 'console', 'deploy']),
    kind: z.enum(['intent', 'decision', 'action', 'approval', 'rejection', 'spend', 'policy', 'sync', 'escalation', 'health', 'forget', 'error']),
    action: z.string().min(1).max(200),
    tier: z.enum(['alone', 'approval', 'forbidden']).optional(),
    inputs: Inputs,
    reasoning: z.string().max(1000).optional(),
    decision: z.enum(['act', 'log', 'escalate', 'queue', 'deny']).optional(),
    outcome: z.enum(['pending', 'ok', 'denied', 'failed', 'skipped']),
    outcomeDetail: z.record(z.string().max(64), z.unknown()).refine((o) => jsonbBytes(o) <= 16384, 'outcomeDetail is over 16 KB').optional(),
    correlationId: z.string().max(100).optional(),
    costUsd: z.number().nonnegative().max(1000).optional(),
    tainted: z.boolean().optional(),
  })
  .strict();
export type AuditIn = z.infer<typeof AuditIn>;

const newId = (): string => `au${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;

/**
 * Append entries. Text fields are redacted again here (the server redacts too:
 * belt and braces for a table nobody can edit afterwards). Replays of an entry
 * with the same id and time are ignored. An `at` more than 30 days old or 5
 * minutes ahead is refused, so no one can write history into the past.
 */
export async function appendAudit(db: Db | Tx, entries: AuditIn[], now = new Date()): Promise<number> {
  const rows = entries.map((e) => {
    const at = e.at ? new Date(e.at) : now;
    if (at.getTime() < now.getTime() - 30 * 86400_000 || at.getTime() > now.getTime() + 300_000) {
      throw new AuditRefused('an audit entry must be from the last 30 days');
    }
    return {
      id: e.id ?? newId(),
      at,
      actor: e.actor,
      context: e.context,
      kind: e.kind,
      action: e.action,
      tier: e.tier ?? null,
      inputs: redact(e.inputs) as Prisma.InputJsonObject,
      reasoning: e.reasoning ? redact(e.reasoning) : null,
      decision: e.decision ?? null,
      outcome: e.outcome,
      outcomeDetail: e.outcomeDetail ? (redact(e.outcomeDetail) as Prisma.InputJsonObject) : Prisma.DbNull,
      correlationId: e.correlationId ?? null,
      costUsd: e.costUsd ?? null,
      tainted: e.tainted ?? false,
    };
  });
  const r = await db.auditEntry.createMany({ data: rows, skipDuplicates: true });
  return r.count;
}

export class AuditRefused extends Error {}

export const AuditQuery = z
  .object({
    kind: AuditIn.shape.kind.optional(),
    action: z.string().max(200).optional(),
    correlationId: z.string().max(100).optional(),
    since: z.string().datetime({ offset: true }).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  })
  .strict();

/** Newest first, for the console's Audit tab and GET /v1/audit. */
export async function listAudit(db: Db, q: z.infer<typeof AuditQuery>) {
  return db.auditEntry.findMany({
    where: {
      ...(q.kind ? { kind: q.kind } : {}),
      ...(q.action ? { action: q.action } : {}),
      ...(q.correlationId ? { correlationId: q.correlationId } : {}),
      ...(q.since ? { at: { gte: new Date(q.since) } } : {}),
    },
    orderBy: [{ at: 'desc' }, { seq: 'desc' }],
    take: q.limit,
  });
}
