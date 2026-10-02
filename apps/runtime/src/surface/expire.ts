/**
 * expire.escalations (hourly): an escalation still open (or acknowledged and
 * left) a week later, or past its prediction's resolve time, expires. Each
 * expiry is audited, and a delivery that never went out is closed with it.
 */
import type { Db } from '../db.js';
import { appendAudit } from '../governance/audit.js';

export const ESCALATION_TTL_MS = 7 * 24 * 3_600_000;

export async function expireEscalations(db: Db, now = new Date()): Promise<number> {
  const due = await db.$queryRaw<Array<{ id: string; tainted: boolean; why: string }>>`
    SELECT e.id, e.tainted, CASE WHEN e."createdAt" < ${new Date(now.getTime() - ESCALATION_TTL_MS)} THEN 'week' ELSE 'resolveBy' END AS why
    FROM "Escalation" e LEFT JOIN "Prediction" p ON p.id = e."predictionId"
    WHERE e.status IN ('open', 'acked')
      AND (e."createdAt" < ${new Date(now.getTime() - ESCALATION_TTL_MS)} OR p."resolveBy" < ${now})
    ORDER BY e."createdAt"
    LIMIT 500`;
  for (const e of due) {
    await db.$transaction(async (tx) => {
      const n = await tx.escalation.updateMany({ where: { id: e.id, status: { in: ['open', 'acked'] } }, data: { status: 'expired' } });
      if (!n.count) return;
      const unsent = await tx.escalationDelivery.findMany({ where: { escalationId: e.id, status: 'pending' }, select: { channel: true } });
      await tx.escalationDelivery.updateMany({ where: { escalationId: e.id, status: 'pending' }, data: { status: 'failed', lastError: 'not sent: the escalation expired' } });
      await appendAudit(tx, [
        {
          actor: 'runtime:expire', context: 'autonomous', kind: 'escalation', action: 'escalation.expire', outcome: 'ok', correlationId: e.id, tainted: e.tainted,
          inputs: { escalationId: e.id, after: e.why },
        },
        // Each delivery's intent gets its outcome: it was never sent.
        ...unsent.map((d) => ({
          actor: 'runtime:expire', context: 'autonomous' as const, kind: 'escalation' as const, action: `notify.${d.channel}`, outcome: 'failed' as const,
          correlationId: `${e.id}.${d.channel}`, tainted: e.tainted, inputs: { escalationId: e.id, channel: d.channel, reason: 'expired before delivery' },
        })),
      ]);
    });
  }
  return due.length;
}
