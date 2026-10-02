/**
 * reconcile (every 5 minutes, while triage is on): the safety net under the
 * transactional sends, and the backfill after triage was off.
 *
 *  - An applied, triage-eligible event from the last 14 days with no decision
 *    and no job waiting, running or dead-lettered, seen more than 2 minutes
 *    ago, has its job sent again. At most 200 a run, oldest first. Anything
 *    triaged a day after it arrived is old news: logged, never escalated.
 *  - An escalation with a delivery still pending 5 minutes on and no deliver
 *    job waiting or running (the server was down past the job's retries) has
 *    its job sent again. The note's ref makes a resend a duplicate on the
 *    server; a dismissed or expired one is withdrawn by the job itself.
 *
 * sweepEvents (hourly, whatever triage's state): an event whose application
 * failed 5 times, or that a later event of the same thing has superseded, is
 * dead: no sync takes it back again, and the source's own error says it is
 * failing.
 */
import { appendAudit } from '../governance/audit.js';
import type { Db } from '../db.js';
import { QUEUES, type Bus } from '../bus.js';
import { MEASUREMENTS } from './facts.js';

export const RECONCILE_LIMIT = 200;
export const RECONCILE_WINDOW_MS = 14 * 24 * 3_600_000;
export const RECONCILE_GRACE_MS = 2 * 60_000;
export const DELIVERY_GRACE_MS = 5 * 60_000;
export const DEAD_AFTER_ATTEMPTS = 5;

export async function reconcile(db: Db, bus: Pick<Bus, 'boss'>, now = new Date()): Promise<{ resent: number; redelivered: number }> {
  const missing = await db.$queryRaw<Array<{ id: string }>>`
    SELECT ev.id FROM "SourceEvent" ev
    WHERE ev.status = 'applied'
      AND ev."receivedAt" > ${new Date(now.getTime() - RECONCILE_WINDOW_MS)}
      AND ev."receivedAt" < ${new Date(now.getTime() - RECONCILE_GRACE_MS)}
      AND NOT (ev.source || ':' || ev.type = ANY (${MEASUREMENTS as string[]}::text[]))
      AND NOT EXISTS (SELECT 1 FROM "TriageDecision" td WHERE td."sourceEventId" = ev.id)
      -- Waiting or running already, or dead-lettered (one that failed every
      -- retry is looked at, not re-sent every 5 minutes for ever).
      AND NOT EXISTS (SELECT 1 FROM pgboss.job j WHERE j.name = 'triage' AND j.singleton_key = ev.id AND j.state IN ('created', 'retry', 'active', 'failed'))
    ORDER BY ev."receivedAt", ev.id
    LIMIT ${RECONCILE_LIMIT}`;
  let resent = 0;
  for (const { id } of missing) {
    if (await bus.boss.send(QUEUES.triage, { eventId: id }, { singletonKey: id })) resent += 1;
  }
  // Notes the server never took: unlike triage, a dead-lettered deliver job is sent again.
  const undelivered = await db.$queryRaw<Array<{ id: string }>>`
    SELECT DISTINCT d."escalationId" AS id FROM "EscalationDelivery" d
    WHERE d.status = 'pending' AND d."createdAt" < ${new Date(now.getTime() - DELIVERY_GRACE_MS)}
      AND NOT EXISTS (SELECT 1 FROM pgboss.job j WHERE j.name = 'deliver' AND j.singleton_key = d."escalationId" AND j.state IN ('created', 'retry', 'active'))
    LIMIT ${RECONCILE_LIMIT}`;
  let redelivered = 0;
  for (const { id } of undelivered) {
    if (await bus.boss.send(QUEUES.deliver, { escalationId: id }, { singletonKey: id })) redelivered += 1;
  }
  return { resent, redelivered };
}

export async function sweepEvents(db: Db, now = new Date()): Promise<{ dead: number }> {
  const dead = await db.$queryRaw<Array<{ source: string }>>`
    UPDATE "SourceEvent" f SET status = 'dead'
    WHERE f.status = 'failed' AND (
      f.attempts >= ${DEAD_AFTER_ATTEMPTS}
      -- The same thing was observed again in another state, and that applied: this one never will.
      OR EXISTS (SELECT 1 FROM "SourceEvent" later
                 WHERE later.source = f.source AND later.status IN ('applied', 'ignored') AND later."receivedAt" > f."receivedAt"
                   AND split_part(later."sourceRef", '@', 1) = split_part(f."sourceRef", '@', 1)))
    RETURNING source`;
  if (dead.length) {
    const sources = [...new Set(dead.map((d) => d.source))].sort().slice(0, 20);
    await appendAudit(db, [{
      actor: 'runtime:sweep', context: 'autonomous', kind: 'error', action: 'events.dead', outcome: 'ok',
      inputs: { count: dead.length, sources, attempts: DEAD_AFTER_ATTEMPTS },
    }], now);
  }
  return { dead: dead.length };
}
