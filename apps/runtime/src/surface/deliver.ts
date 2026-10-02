/**
 * The deliver job (Machine plan P2): one escalation's pending deliveries, in
 * one /internal/notify call with the channels and the escalation id as ref.
 *
 *  - The server has it (stored, or "duplicate": an earlier call landed): the
 *    deliveries are sent and each channel's outcome is audited
 *    (kind escalation, action notify.<channel>). If that write fails it is
 *    tried again; the note is never sent again for it (and the ref would make
 *    a second call a duplicate anyway).
 *  - The server refused it (4xx): failed, audited, not retried.
 *  - No answer to trust (5xx, timeout, no server): the job throws, and pg-boss
 *    retries it with backoff.
 *  - An escalation already dismissed, acted on or expired is not delivered.
 */
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { appendAudit } from '../governance/audit.js';
import { notifyServer, type NotifyOutcome } from '../notify.js';
import { fieldFreeTitle } from '../templates/escalations.js';

export type Delivered = 'sent' | 'refused' | 'nothing' | 'withdrawn';

export async function deliver(
  db: Db,
  config: Pick<Config, 'server'>,
  escalationId: string,
  now = () => new Date(),
  post: (req: Parameters<typeof notifyServer>[1]) => Promise<NotifyOutcome> = (req) => notifyServer(config, req),
): Promise<Delivered> {
  const e = await db.escalation.findUnique({ where: { id: escalationId }, include: { deliveries: { where: { status: 'pending' } } } });
  if (!e || e.deliveries.length === 0) return 'nothing';
  const channels = e.deliveries.map((d) => d.channel as 'inapp' | 'banner' | 'push');
  const audit = (outcome: 'ok' | 'failed', extra: Record<string, string | number | boolean>) =>
    channels.map((ch) => ({
      actor: 'runtime:deliver', context: 'autonomous' as const, kind: 'escalation' as const, action: `notify.${ch}`, tier: 'alone' as const, decision: 'act' as const, outcome,
      correlationId: `${e.id}.${ch}`, tainted: e.tainted, inputs: { escalationId: e.id, channel: ch, ...extra },
    }));
  if (e.status !== 'open' && e.status !== 'acked') {
    await db.$transaction(async (tx) => {
      await tx.escalationDelivery.updateMany({ where: { escalationId: e.id, status: 'pending' }, data: { status: 'failed', lastError: `not sent: the escalation is ${e.status}` } });
      await appendAudit(tx, audit('failed', { reason: `escalation ${e.status}` }), now());
    });
    return 'withdrawn';
  }
  const r = await post({ title: e.title ?? fieldFreeTitle(e.templateId), body: e.body ?? '', channels, ref: e.id });
  if (r.status === 'retry') {
    await db.escalationDelivery.updateMany({ where: { escalationId: e.id, status: 'pending' }, data: { attempts: { increment: 1 }, lastError: `not delivered yet: ${r.why}`.slice(0, 200) } });
    throw new Error(`the server did not take escalation ${e.id} (${r.why}); retrying`);
  }
  const done = async () =>
    db.$transaction(async (tx) => {
      if (r.status === 'refused') {
        await tx.escalationDelivery.updateMany({ where: { escalationId: e.id, status: 'pending' }, data: { status: 'failed', attempts: { increment: 1 }, lastError: `refused by the server (HTTP ${r.code})` } });
        await appendAudit(tx, audit('failed', { httpStatus: r.code }), now());
      } else {
        await tx.escalationDelivery.updateMany({ where: { escalationId: e.id, status: 'pending' }, data: { status: 'sent', attempts: { increment: 1 }, sentAt: now(), lastError: null } });
        await appendAudit(tx, audit('ok', { duplicate: r.status === 'duplicate', pinged: r.pinged }), now());
      }
    });
  // The note went out: recording that is retried, never the note.
  for (let attempt = 1; ; attempt++) {
    try {
      await done();
      break;
    } catch (err) {
      if (attempt >= 3) throw err;
      await new Promise((ok) => setTimeout(ok, 200 * attempt));
    }
  }
  return r.status === 'refused' ? 'refused' : 'sent';
}
