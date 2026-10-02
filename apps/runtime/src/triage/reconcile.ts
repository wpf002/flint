/**
 * reconcile (every 5 minutes, while triage is on): the safety net under the
 * transactional enqueue, and the backfill after triage was off.
 *
 *  - An applied, triage-eligible event from the last 14 days with no decision
 *    and no job waiting, running or dead-lettered, seen more than 2 minutes
 *    ago, has its job sent again. At most 200 a run, oldest first; anything
 *    that happened more than a day before it was seen is backfill and costs
 *    no model.
 *  - An event whose application failed 5 times is dead: no sync takes it back
 *    again, and the source's own error says it is failing.
 */
import { appendAudit } from '../governance/audit.js';
import type { Db } from '../db.js';
import { QUEUES, type Bus } from '../bus.js';
import { MEASUREMENTS } from './facts.js';

export const RECONCILE_LIMIT = 200;
export const RECONCILE_WINDOW_MS = 14 * 24 * 3_600_000;
export const RECONCILE_GRACE_MS = 2 * 60_000;
export const DEAD_AFTER_ATTEMPTS = 5;

export async function reconcile(db: Db, bus: Bus, now = new Date()): Promise<{ resent: number; dead: number }> {
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
  const dead = await db.$queryRaw<Array<{ source: string }>>`
    UPDATE "SourceEvent" SET status = 'dead'
    WHERE status = 'failed' AND attempts >= ${DEAD_AFTER_ATTEMPTS}
    RETURNING source`;
  if (dead.length) {
    const sources = [...new Set(dead.map((d) => d.source))].sort().slice(0, 20);
    await appendAudit(db, [{
      actor: 'runtime:reconcile', context: 'autonomous', kind: 'error', action: 'events.dead', outcome: 'ok',
      inputs: { count: dead.length, sources, attempts: DEAD_AFTER_ATTEMPTS },
    }], now);
  }
  return { resent, dead: dead.length };
}
