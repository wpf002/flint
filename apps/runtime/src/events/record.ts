/**
 * Writing a SourceEvent (Machine plan P2, pipeline step 1). Every source and
 * every pushed server event goes through here, so the rules hold in one place:
 *
 *  - The payload is written as exact JSON text (a float read back from
 *    Prisma's JSON is not always the one hashed) and hashed as written.
 *  - (source, sourceRef) is the event's identity: the same event again is a
 *    duplicate, never a second row; a FAILED one is taken back and tried again,
 *    its attempts counted (reconcile makes it dead at 5).
 *  - The triage job is sent in the same transaction as the event it is for:
 *    they commit, or roll back, together. Its data is the event id and nothing
 *    else (pg-boss's tables sit outside retention and forget).
 */
import { randomBytes } from 'node:crypto';
import { digestOf, redact } from '@flint/policy';
import type { Db, Tx } from '../db.js';
import { inTx, QUEUES, type Bus } from '../bus.js';

export type Sensitivity = 'ops' | 'personal' | 'financial';

export interface EventIn {
  source: string;
  sourceRef: string;
  type: string;
  /** When it happened at the source (not when Flint saw it). */
  occurredAt: Date;
  sensitivity: Sensitivity;
  tainted: boolean;
  payload: Record<string, unknown> | null;
}

export const newEventId = (now: Date) => `se${now.getTime().toString(36)}${randomBytes(5).toString('hex')}`;

/**
 * Insert the event as `received`, or take back a failed one; null when it is
 * already there (applied, ignored, dead, or in flight).
 */
export async function recordEvent(tx: Tx, e: EventIn, now: Date): Promise<string | null> {
  const payload = e.payload === null ? null : JSON.stringify(e.payload);
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    INSERT INTO "SourceEvent" (id, source, "sourceRef", type, "occurredAt", "receivedAt", sensitivity, tainted, payload, "payloadHash", status, attempts)
    VALUES (${newEventId(now)}, ${e.source}, ${e.sourceRef.slice(0, 500)}, ${e.type}, ${e.occurredAt}, ${now}, ${e.sensitivity}, ${e.tainted},
            ${payload}::jsonb, ${digestOf(e.payload)}, 'received', 0)
    ON CONFLICT (source, "sourceRef") DO UPDATE SET status = 'received', "lastError" = NULL
      WHERE "SourceEvent".status = 'failed'
    RETURNING id`;
  return rows[0]?.id ?? null;
}

/**
 * The same condition seen again while it still holds (a watchdog condition, a
 * handoff still pending): its event, if not yet decided, is as fresh as this
 * sighting, so triage never takes a condition that holds now for old news.
 * Returns the id when it was refreshed (its triage job may then be sent).
 */
export async function refreshUndecided(tx: Tx, source: string, sourceRef: string, now: Date): Promise<string | null> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    UPDATE "SourceEvent" e SET "receivedAt" = ${now}, "occurredAt" = ${now}
    WHERE e.source = ${source} AND e."sourceRef" = ${sourceRef.slice(0, 500)} AND e.status = 'applied'
      AND NOT EXISTS (SELECT 1 FROM "TriageDecision" d WHERE d."sourceEventId" = e.id)
    RETURNING e.id`;
  return rows[0]?.id ?? null;
}

/** The event was applied (or the world model skipped it): it is done, one attempt more. */
export async function markProcessed(tx: Tx, id: string, status: 'applied' | 'ignored', now: Date): Promise<void> {
  await tx.$executeRaw`UPDATE "SourceEvent" SET status = ${status}, "processedAt" = ${now}, attempts = attempts + 1 WHERE id = ${id}`;
}

/**
 * The transaction that would have applied it rolled back: record the event as
 * failed (or count one more attempt on the failed row), outside it. The error
 * is redacted and clipped; reconcile turns a fifth failure into `dead`.
 */
export async function recordFailure(db: Db, e: EventIn, err: unknown, now: Date): Promise<void> {
  const message = redact(err instanceof Error ? err.message : String(err)).slice(0, 500);
  const payload = e.payload === null ? null : JSON.stringify(e.payload);
  await db.$executeRaw`
    INSERT INTO "SourceEvent" (id, source, "sourceRef", type, "occurredAt", "receivedAt", sensitivity, tainted, payload, "payloadHash", status, attempts, "lastError")
    VALUES (${newEventId(now)}, ${e.source}, ${e.sourceRef.slice(0, 500)}, ${e.type}, ${e.occurredAt}, ${now}, ${e.sensitivity}, ${e.tainted},
            ${payload}::jsonb, ${digestOf(e.payload)}, 'failed', 1, ${message})
    ON CONFLICT (source, "sourceRef") DO UPDATE SET attempts = "SourceEvent".attempts + 1, "lastError" = EXCLUDED."lastError"
      WHERE "SourceEvent".status = 'failed'`;
}

/** Sends an event's triage job inside the transaction that wrote the event. */
export type Enqueue = (tx: Tx, eventId: string) => Promise<void>;

export function triageEnqueue(bus: Bus): Enqueue {
  return async (tx, eventId) => {
    // Stately on the event id: a second send while one waits is a no-op.
    await bus.boss.send(QUEUES.triage, { eventId }, { ...inTx(tx), singletonKey: eventId });
  };
}
