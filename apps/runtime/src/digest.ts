/**
 * The 07:30 digest (Machine plan P2): the previous local day, from counts
 * only (no model writes any of it), in the console's note and nowhere else.
 *
 *  - Did / queued, as ask's morning brief split them: what was done (actions
 *    with an ok outcome, not Will's own clicks) and what waits on Will
 *    (pending proposals, open escalations); the lanes; what is not healthy;
 *    the predictions that resolve today.
 *  - Once a local day: the day's claim and the delivery intent are written
 *    together; a retried job finds them and finishes the delivery (the server
 *    dedupes on the digest's ref), never a second digest.
 *  - Recorded in shadow; delivered only once digest.daily and notify.inapp are
 *    promoted. A delivery that fails is audited as failed.
 */
import { localDay, localDayBounds, previousDay, resolveTier, runsInShadow, type PolicyRow } from '@flint/policy';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { appendAudit } from './governance/audit.js';
import { activePolicies } from './governance/proposals.js';
import { claim } from './governance/counters.js';
import { notifyServer, type NotifyOutcome } from './notify.js';

export interface Digest {
  day: string;
  title: string;
  body: string;
  counts: Record<string, number>;
  degraded: string[];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export async function buildDigest(db: Db, tz: string, now = new Date()): Promise<Digest> {
  const day = previousDay(localDay(tz, now));
  const { start, end } = localDayBounds(tz, day);
  const today = localDayBounds(tz, localDay(tz, now));
  const window = { gte: start, lt: end };
  const [relevant, quiet, escalated, did, queued, open, due, latest] = await Promise.all([
    db.triageDecision.count({ where: { lane: 'relevant', createdAt: window } }),
    db.triageDecision.count({ where: { lane: 'quiet', createdAt: window } }),
    db.escalation.count({ where: { createdAt: window } }),
    db.auditEntry.count({ where: { kind: 'action', outcome: 'ok', context: { not: 'console' }, at: window } }),
    db.proposal.count({ where: { status: 'pending', expiresAt: { gt: now } } }),
    db.escalation.count({ where: { status: 'open' } }),
    db.prediction.count({ where: { status: 'open', resolveBy: { gte: today.start, lt: today.end } } }),
    db.$queryRaw<Array<{ component: string; status: string }>>`SELECT DISTINCT ON (component) component, status FROM "HealthCheck" ORDER BY component, at DESC`,
  ]);
  const degraded = latest.filter((c) => c.status !== 'ok' && c.status !== 'disabled' && !c.component.includes('.')).map((c) => c.component).sort();
  const body = [
    `${day}: ${plural(relevant, 'item')} for you (${plural(escalated, 'escalation')}), ${quiet} in the quiet lane.`,
    `Done on its own: ${plural(did, 'action')}. Waiting on you: ${plural(queued, 'proposal')} and ${plural(open, 'open escalation')}.`,
    degraded.length ? `Not healthy: ${degraded.slice(0, 6).join(', ')}${degraded.length > 6 ? ` and ${degraded.length - 6} more` : ''}.` : 'Everything checked is healthy.',
    `Predictions that resolve today: ${due}.`,
  ].join('\n');
  return { day, title: `Flint for ${day}`, body: body.slice(0, 500), counts: { relevant, quiet, escalated, did, queued, open, due, degraded: degraded.length }, degraded };
}

export type DigestOutcome = 'delivered' | 'recorded' | 'already' | 'failed' | 'skipped';

export async function runDigest(
  db: Db,
  config: Pick<Config, 'tz' | 'server'>,
  now = new Date(),
  post: (req: Parameters<typeof notifyServer>[1]) => Promise<NotifyOutcome> = (req) => notifyServer(config, req),
): Promise<DigestOutcome> {
  const policies: PolicyRow[] = await activePolicies(db, now);
  const tier = (a: string) => resolveTier(a, { context: 'autonomous', tainted: false, policies, now }).tier;
  const digestTier = tier('digest.daily');
  if (digestTier === 'forbidden' || (digestTier === 'approval' && !runsInShadow('digest.daily'))) return 'skipped';
  const deliver = digestTier === 'alone' && tier('notify.inapp') === 'alone';
  const d = await buildDigest(db, config.tz, now);
  const ref = `digest:${d.day}`;
  // The day's claim and the intent, together: a second run that day finds the claim taken.
  const first = await db.$transaction(async (tx) => {
    if ((await claim(tx, 'digest.daily', { limit: 1, period: 'day' }, config.tz, now)) === null) return false;
    await appendAudit(tx, [{
      actor: 'runtime:digest', context: 'autonomous', kind: deliver ? 'intent' : 'action', action: 'digest.daily', tier: digestTier, decision: deliver ? 'act' : 'log',
      outcome: deliver ? 'pending' : 'ok', correlationId: ref, inputs: { day: d.day, ...d.counts, delivered: false, shadow: !deliver },
    }], now);
    return true;
  });
  if (!first) {
    // A retry: finish a delivery that began and did not end; otherwise it is done.
    const done = await db.auditEntry.count({ where: { correlationId: ref, kind: 'action', action: 'digest.daily' } });
    const began = await db.auditEntry.count({ where: { correlationId: ref, kind: 'intent', action: 'digest.daily' } });
    if (done || !began) return 'already';
  } else if (!deliver) {
    return 'recorded';
  }
  const r = await post({ title: d.title, body: d.body, channels: ['inapp'], ref });
  if (r.status === 'retry') throw new Error(`the digest for ${d.day} was not delivered (${r.why}); retrying`);
  const ok = r.status === 'stored' || r.status === 'duplicate';
  await appendAudit(db, [{
    actor: 'runtime:digest', context: 'autonomous', kind: 'action', action: 'digest.daily', tier: digestTier, decision: 'act', outcome: ok ? 'ok' : 'failed', correlationId: ref,
    inputs: { day: d.day, ...d.counts, delivered: ok, ...(r.status === 'refused' ? { httpStatus: r.code } : {}) },
  }], now);
  return ok ? 'delivered' : 'failed';
}
