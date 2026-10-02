/**
 * Recording what triage decided (Machine plan P2): one transaction for the
 * decision, its audit entry and any per-day claim, so a decision never exists
 * without its audit, and a crash leaves either all of it or none (the job
 * runs again). A second worker on the same event finds the decision there
 * (sourceEventId is unique) and stops.
 *
 * In shadow (triage at APPROVAL, before Will promotes it) the decision is
 * recorded the same way and marked `shadow`: nothing is delivered.
 */
import { randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { Tier } from '@flint/policy';
import type { Db } from '../db.js';
import { appendAudit } from '../governance/audit.js';
import { claim } from '../governance/counters.js';
import type { EventFacts, Verdict } from '../triage/verdict.js';

export interface DecisionContext {
  /** Recorded only: triage is not promoted. */
  shadow: boolean;
  /** The tier of the action that decided (triage.rule, or triage.local_model for the model). */
  tier: Tier;
  tz: string;
  now: Date;
}

export const newDecisionId = (now: Date) => `td${now.getTime().toString(36)}${randomBytes(5).toString('hex')}`;

/** The audit's decision word for a triage action. */
const DECISION = { ignore: 'log', log: 'log', act: 'act', escalate: 'escalate' } as const;

export async function recordDecision(db: Db, f: EventFacts, v: Verdict, c: DecisionContext): Promise<{ id: string; verdict: Verdict } | undefined> {
  try {
    return await db.$transaction(async (tx) => {
      let verdict = v;
      if (v.perDay) {
        // Past the day's limit for this sender (or this handoff), the match is logged quietly.
        const n = await claim(tx, v.perDay.key, { limit: v.perDay.limit, period: 'day' }, c.tz, c.now);
        if (n === null) {
          const { template: _t, perDay: _p, ...rest } = v;
          verdict = { ...rest, action: 'log', lane: 'quiet' };
        }
      }
      const id = newDecisionId(c.now);
      await tx.triageDecision.create({
        data: {
          id, sourceEventId: f.eventId, action: verdict.action, lane: verdict.lane, decidedBy: verdict.decidedBy, critical: verdict.critical, shadow: c.shadow,
          tainted: f.tainted, sensitivity: f.sensitivity, createdAt: c.now,
          ...(verdict.ruleName ? { ruleName: verdict.ruleName } : {}),
          ...(verdict.relevance !== undefined ? { relevance: verdict.relevance } : {}),
          ...(verdict.reasonCode ? { reasonCode: verdict.reasonCode } : {}),
          ...(verdict.reasoning ? { reasoning: verdict.reasoning.slice(0, 500) } : {}),
          ...(verdict.modelMs !== undefined ? { modelMs: Math.max(0, Math.round(verdict.modelMs)) } : {}),
        },
      });
      const byModel = verdict.decidedBy.startsWith('model:') || /^fallback:(invalid|unavailable|capped|deferred)$/.test(verdict.decidedBy);
      await appendAudit(tx, [{
        actor: 'runtime:triage', context: 'autonomous', kind: 'decision', action: byModel ? 'triage.local_model' : 'triage.rule', tier: c.tier,
        decision: DECISION[verdict.action], outcome: verdict.decidedBy === 'fallback:skipped' ? 'skipped' : 'ok', correlationId: id, tainted: f.tainted,
        // Ids, enums and numbers: never the event's text or the model's words.
        inputs: {
          eventId: f.eventId, source: f.source, type: f.type, action: verdict.action, lane: verdict.lane, decidedBy: verdict.decidedBy,
          critical: verdict.critical, shadow: c.shadow, backfill: f.backfill,
          ...(verdict.ruleName ? { ruleName: verdict.ruleName } : {}),
          ...(verdict.relevance !== undefined ? { relevance: verdict.relevance } : {}),
          ...(verdict.reasonCode ? { reasonCode: verdict.reasonCode } : {}),
          ...(verdict.modelMs !== undefined ? { modelMs: Math.round(verdict.modelMs) } : {}),
          ...(verdict !== v ? { capped: v.perDay?.key ?? true } : {}),
        },
      }], c.now);
      return { id, verdict };
    });
  } catch (err) {
    // Decided already (a retried or duplicate job): the first decision stands.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return undefined;
    throw err;
  }
}
