/**
 * Triage's `act` (Machine plan P2, step 4): an act verdict files a template
 * proposal, never runs anything itself. Only actions with a template here
 * (templates/actions.ts) are filed, their params checked against its schema
 * and every id an entity Flint has.
 *
 * While triage.rule is not promoted to ALONE nothing is filed: the decision's
 * audit entry says what would have been (`wouldPropose`). Once it is, the
 * proposal is filed BEFORE the decision is recorded: filing is idempotent (the
 * same pending proposal comes back), so a crash between the two files nothing
 * twice.
 */
import type { Db } from '../db.js';
import { digestOf } from '@flint/policy';
import { createProposal, Refused } from '../governance/proposals.js';
import { claim } from '../governance/counters.js';
import { ACTION_TEMPLATES } from '../templates/actions.js';
import { actionFor } from '../templates/actions.js';
import type { EventFacts, Verdict } from '../triage/verdict.js';

export async function fileAction(db: Db, f: EventFacts, v: Verdict, o: { alone: boolean; now: Date; tz: string }): Promise<{ proposalId?: string; wouldPropose?: string; proposalRefused?: number }> {
  if (v.action !== 'act') return {};
  const a = actionFor(f);
  if (!a) return {};
  const ids = [a.params.fromId, a.params.toId].filter((x): x is string => typeof x === 'string');
  if ((await db.entity.count({ where: { id: { in: ids }, status: 'active' } })) !== ids.length) return {};
  // Linked already (by a source, or an earlier fact): nothing to ask Will.
  if (a.action === 'world.relation.write' && (await db.relation.findFirst({ where: { type: a.params.type as string, fromId: a.params.fromId as string, toId: a.params.toId as string, validTo: null }, select: { id: true } }))) return {};
  if (!o.alone) return { wouldPropose: a.templateId };
  // The same card waiting already (this event's job running again): that one, and no second slot of the day.
  const same = await db.proposal.findFirst({ where: { action: a.action, argsDigest: digestOf(a.params), status: 'pending', expiresAt: { gt: o.now } }, select: { id: true } });
  if (same) return { proposalId: same.id };
  // A day's worth of these, filed; past it, the decision is recorded and nothing more.
  if ((await claim(db, `propose.${a.templateId}`, { limit: ACTION_TEMPLATES[a.templateId].perDay, period: 'day' }, o.tz, o.now)) === null) return {};
  try {
    const p = await createProposal(db, {
      kind: 'tool_call', origin: 'runtime:triage', action: a.action, templateId: a.templateId, args: a.params,
      argsProvenance: Object.fromEntries(Object.keys(a.params).map((k) => [k, { source: 'event' as const, ref: f.eventId, tainted: f.tainted }])),
      tainted: f.tainted, sensitivity: f.sensitivity, destructive: false, consequential: false, ttlMinutes: 7 * 24 * 60,
    }, 'runtime:triage', o.now);
    return { proposalId: p.id };
  } catch (err) {
    // Forbidden by a signed policy: the refusal is audited by createProposal and noted on the decision; the job does not fail.
    if (err instanceof Refused) return { proposalRefused: err.status };
    throw err;
  }
}
