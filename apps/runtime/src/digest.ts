/**
 * The 07:30 digest (Machine plan P2): the previous local day, from counts
 * only (no model writes any of it), in the console's note and nowhere else.
 *
 *  - Did / queued, as ask's morning brief split them: what Flint did on its own
 *    (each action that ended ok, counted once however many rows it wrote, and
 *    never one Will approved or clicked) and what waits on Will
 *    (pending proposals, open escalations); the lanes; what is not healthy,
 *    by the names Settings > Health uses; the predictions that resolve today.
 *    Each line is a sentence in the console's words (Important, Other, approvals).
 *  - Once a local day: the day's claim and the delivery intent are written
 *    together; a retried job finds them and finishes the delivery (the server
 *    dedupes on the digest's ref), never a second digest.
 *  - Recorded in shadow; delivered only once digest.daily and notify.inapp are
 *    promoted. A delivery that fails is audited as failed.
 */
import { healthName, localDay, localDayBounds, previousDay, resolveTier, runsInShadow, type PolicyRow } from '@flint/policy';
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
/** "A", "A and B", "A, B and C". */
const listOf = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : (xs[0] ?? ''));

/**
 * What Flint did on its own in [start, end): actions that ended ok, each counted
 * once by its correlation id (a nightly job and its proposal both write a row
 * for one run), never one Will approved (its correlation id is the proposal's)
 * or did himself (the console), nor a row that only logged.
 */
async function didOnItsOwn(db: Db, start: Date, end: Date): Promise<number> {
  const [row] = await db.$queryRaw<Array<{ n: number }>>`
    SELECT count(DISTINCT COALESCE(a."correlationId", a.id))::int AS n FROM "AuditEntry" a
    WHERE a.kind = 'action' AND a.outcome = 'ok' AND a.context <> 'console' AND a.decision IS DISTINCT FROM 'log'
      AND a.at >= ${start} AND a.at < ${end}
      AND NOT EXISTS (SELECT 1 FROM "Proposal" p WHERE p.id = a."correlationId")`;
  return row?.n ?? 0;
}

export async function buildDigest(db: Db, tz: string, now = new Date()): Promise<Digest> {
  const day = previousDay(localDay(tz, now));
  const { start, end } = localDayBounds(tz, day);
  const today = localDayBounds(tz, localDay(tz, now));
  const window = { gte: start, lt: end };
  const [relevant, quiet, escalated, did, queued, open, due, latest] = await Promise.all([
    db.triageDecision.count({ where: { lane: 'relevant', createdAt: window } }),
    db.triageDecision.count({ where: { lane: 'quiet', createdAt: window } }),
    db.escalation.count({ where: { createdAt: window } }),
    didOnItsOwn(db, start, end),
    db.proposal.count({ where: { status: 'pending', expiresAt: { gt: now } } }),
    db.escalation.count({ where: { status: 'open' } }),
    db.prediction.count({ where: { status: 'open', resolveBy: { gte: today.start, lt: today.end } } }),
    db.$queryRaw<Array<{ component: string; status: string }>>`SELECT DISTINCT ON (component) component, status FROM "HealthCheck" ORDER BY component, at DESC`,
  ]);
  const degraded = latest.filter((c) => c.status !== 'ok' && c.status !== 'disabled' && !c.component.includes('.')).map((c) => c.component).sort();
  const counts = { relevant, quiet, escalated, did, queued, open, due };
  return { day, title: `Flint for ${day}`, body: digestBody(counts, degraded).slice(0, 500), counts: { ...counts, degraded: degraded.length }, degraded };
}

/**
 * The digest's four lines, each a sentence. The title carries the date; the console's
 * tabs are Important and Other, it calls a proposal an approval, and Health's names
 * stand for the components.
 */
export function digestBody(c: { relevant: number; quiet: number; escalated: number; did: number; queued: number; open: number; due: number }, degraded: string[]): string {
  const waiting = [c.queued ? plural(c.queued, 'approval') : '', c.open ? plural(c.open, 'open escalation') : ''].filter(Boolean);
  const names = degraded.slice(0, 6).map(healthName).concat(degraded.length > 6 ? [`${degraded.length - 6} more`] : []);
  return [
    `Yesterday, ${c.relevant ? plural(c.relevant, 'item') : 'no items'} ${c.relevant === 1 ? 'was' : 'were'} important and ${c.quiet || 'none'} went to Other.${c.escalated ? ` Flint escalated ${c.escalated}.` : ''}`,
    `${c.did ? `Flint did ${plural(c.did, 'thing')} on its own.` : 'Flint did nothing on its own.'} ${waiting.length ? `You have ${waiting.join(' and ')} waiting.` : 'Nothing is waiting on you.'}`,
    degraded.length ? `${degraded.length === 1 ? 'This needs' : 'These need'} a look: ${listOf(names)}.` : 'Everything checked is healthy.',
    c.due ? `Today, ${plural(c.due, 'prediction')} ${c.due === 1 ? 'resolves' : 'resolve'}.` : 'No predictions resolve today.',
  ].join('\n');
}

export type DigestOutcome = 'delivered' | 'recorded' | 'already' | 'failed' | 'skipped';

/**
 * An earlier day's digest whose delivery began and never ended (the server
 * was down past the job's retries): it is not sent a day late. Its intent
 * gets its outcome, failed, so no intent is left open.
 */
async function closeStaleDigests(db: Db, today: string, now: Date): Promise<void> {
  const open = await db.$queryRaw<Array<{ ref: string }>>`
    SELECT i."correlationId" AS ref FROM "AuditEntry" i
    WHERE i.kind = 'intent' AND i.action = 'digest.daily' AND i."correlationId" <> ${today} AND i.at > ${new Date(now.getTime() - 31 * 86_400_000)}
      AND NOT EXISTS (SELECT 1 FROM "AuditEntry" o WHERE o."correlationId" = i."correlationId" AND o.kind <> 'intent' AND o.outcome <> 'pending')`;
  if (!open.length) return;
  await appendAudit(db, open.map((o) => ({
    actor: 'runtime:digest', context: 'autonomous' as const, kind: 'action' as const, action: 'digest.daily', decision: 'act' as const, outcome: 'failed' as const,
    correlationId: o.ref, inputs: { day: o.ref.slice('digest:'.length, 'digest:'.length + 10), delivered: false, reason: 'not delivered that day' },
  })), now);
}

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
  await closeStaleDigests(db, ref, now);
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
