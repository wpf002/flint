/**
 * Recording and surfacing what triage decided (Machine plan P2, steps 4-5).
 * The words are rendered first; then ONE transaction writes everything, so a
 * crash leaves all of it or none (the job runs again, and a second worker
 * finds the decision and stops):
 *
 *  - the TriageDecision and its audit entry (correlationId = the decision);
 *  - for an escalation: the "how this goes" Prediction where the template has
 *    a base rate and a claim template (service_down -> service_healthy), and a
 *    Recommendation with its conditional Prediction, each under the ledger's
 *    tier and daily cap, each inheriting the event's taint;
 *  - the Escalation, one EscalationDelivery per channel decided, an intent
 *    audit entry per channel that will be delivered, and the deliver job.
 *
 * Channels: a critical escalation goes to the console note, the banner and
 * the phone (its ping passes the 3-a-day cap and is still counted); any other
 * to the note and the banner, and the phone while under the cap. A channel is
 * delivered only once its notify.<channel> is promoted to ALONE and triage is
 * out of shadow; otherwise its delivery is `held`: recorded, never sent.
 */
import { randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { CODE_TABLE, entityRef, periodKey, resolveTier, runsInShadow, type Cap, type NotifyChannel, type PolicyRow, type Tier } from '@flint/policy';
import type { Db, Tx } from '../db.js';
import { inTx, QUEUES, type Bus } from '../bus.js';
import { appendAudit } from '../governance/audit.js';
import { claim } from '../governance/counters.js';
import { emitPrediction } from '../ledger/emit.js';
import { displayName, fieldFreeTitle, isTemplateId, phrase, render, type Rendered } from '../templates/escalations.js';
import type { EventFacts, Verdict } from '../triage/verdict.js';

export interface SurfaceContext {
  /** Recorded only: triage is not promoted. */
  shadow: boolean;
  /** The tier of the action that decided (triage.rule, or triage.local_model). */
  tier: Tier;
  tz: string;
  now: Date;
  policies: readonly PolicyRow[];
  /** Sends the deliver job inside the transaction. */
  bus?: Pick<Bus, 'boss'>;
  /** An `act` verdict: the proposal filed for it, or the template it would have filed in shadow. */
  proposalId?: string;
  wouldPropose?: string;
}

export const newDecisionId = (now: Date) => `td${now.getTime().toString(36)}${randomBytes(5).toString('hex')}`;
const newId = (prefix: string, now: Date) => `${prefix}${now.getTime().toString(36)}${randomBytes(5).toString('hex')}`;

/** The audit's decision word for a triage action. */
const DECISION = { ignore: 'log', log: 'log', act: 'act', escalate: 'escalate' } as const;

/** service_down's base rates (P(healthy within 2 h)), until the ledger has its own. */
export const SERVICE_DOWN = { horizonMs: 2 * 3_600_000, healthyAnyway: 0.4, healthyIfLooked: 0.8, version: 'triage.service_down.v1' } as const;

interface Standing {
  alone: boolean;
  may: boolean;
  tier: Tier;
  cap?: Cap;
}
function standing(action: string, c: SurfaceContext): Standing {
  // A ping is content-free, so no data's sensitivity rides on it.
  const t = resolveTier(action, { context: 'autonomous', tainted: false, sensitivity: 'ops', policies: c.policies, now: c.now });
  const cap = t.cap ?? CODE_TABLE[action]?.cap;
  return { alone: t.tier === 'alone', may: t.tier === 'alone' || (t.tier === 'approval' && runsInShadow(action)), tier: t.tier, ...(cap ? { cap } : {}) };
}

/** The words, rendered before anything is written: with the ledger's phrase, and without it. */
function words(f: EventFacts, v: Verdict, c: SurfaceContext): { plain: Rendered; withLedger?: Rendered; prediction?: { by: Date } } {
  const t = v.template!;
  const names: Record<string, string> = f.entity ? { [entityRef(f.entity.kind, f.entity.id)]: displayName(f.entity) } : {};
  if (!isTemplateId(t.id)) return { plain: { fields: {}, title: 'Something needs a look', body: 'The console has the details.', linted: true } };
  try {
    const plain = render(t.id, t.fields, names);
    if (t.id !== 'service_down' || !f.entity) return { plain };
    const by = new Date(c.now.getTime() + SERVICE_DOWN.horizonMs);
    return { plain, withLedger: render(t.id, t.fields, names, phrase(SERVICE_DOWN.healthyAnyway, by, c.tz)), prediction: { by } };
  } catch {
    // Fields that are not the template's: the note says only what is safe to say.
    return { plain: { fields: {}, title: fieldFreeTitle(t.id), body: 'The console has the details.', linted: true } };
  }
}

/** Claim one slot of an action's cap; true when there was one (or there is no cap). */
async function take(tx: Tx, action: string, s: Standing, c: SurfaceContext): Promise<boolean> {
  return !s.cap || (await claim(tx, action, s.cap, c.tz, c.now)) !== null;
}

async function predictions(tx: Tx, f: EventFacts, by: Date, c: SurfaceContext): Promise<{ predictionId?: string; recommendationId?: string; skipped?: string }> {
  const s = standing('ledger.prediction.record', c);
  if (!s.may) return { skipped: `ledger.prediction.record is ${s.tier}` };
  if (!(await take(tx, 'ledger.prediction.record', s, c))) return { skipped: 'the daily prediction cap is reached' };
  const e = f.entity!;
  const ref = entityRef(e.kind, e.id);
  const common = {
    template: { id: 'service_healthy' as const, params: { entity: ref } },
    kind: 'binary' as const, method: 'base_rate' as const, evidence: [{ kind: 'base_rate', ref: SERVICE_DOWN.version }],
    resolutionCriteria: 'The service reports healthy (running, or its health check ok) when it is next observed after the resolve time.',
    resolveBy: by.toISOString(), subjectEntityId: e.id, tainted: f.tainted,
  };
  const p = await emitPrediction(tx, {
    ...common, probability: SERVICE_DOWN.healthyAnyway, domain: 'services', type: 'event_occurs', resolver: 'auto_world',
    resolverSpec: { entityId: e.id, check: 'healthy', at: 'resolveBy' },
  }, 'runtime:triage', c.now);
  // What Flint recommends, with what it expects if Will does it.
  if (!(await take(tx, 'ledger.prediction.record', s, c))) return { predictionId: p.id, skipped: 'the daily prediction cap is reached (recommendation)' };
  const recommendationId = newId('rc', c.now);
  const conditional = await emitPrediction(tx, {
    ...common, probability: SERVICE_DOWN.healthyIfLooked, domain: 'recommendation', type: 'effect_given_accept', resolver: 'conditional', conditionRecommendationId: recommendationId,
  }, 'runtime:triage', c.now);
  await tx.recommendation.create({
    data: {
      id: recommendationId, templateId: 'look_at_service', params: { entity: ref } as Prisma.InputJsonObject, domain: 'services', type: 'escalation_action',
      text: `Look at ${displayName(e)} in the console: its status, its last exit and its health checks.`,
      expectedEffect: 'it reports healthy within 2 hours', predictionId: conditional.id, tainted: f.tainted, createdBy: 'runtime:triage',
    },
  });
  return { predictionId: p.id, recommendationId };
}

/** Which channels an escalation goes to, and which of them are delivered now. */
async function channels(tx: Tx, v: Verdict, c: SurfaceContext): Promise<Array<{ channel: NotifyChannel; deliver: boolean; counted?: number; overCap?: boolean }>> {
  const out: Array<{ channel: NotifyChannel; deliver: boolean; counted?: number; overCap?: boolean }> = [];
  for (const ch of ['inapp', 'banner'] as const) out.push({ channel: ch, deliver: !c.shadow && standing(`notify.${ch}`, c).alone });
  const push = standing('notify.push', c);
  const cap = push.cap ?? { limit: 3, period: 'day' as const };
  if (!c.shadow && push.alone) {
    const n = await claim(tx, 'notify.push', cap, c.tz, c.now);
    if (n !== null) out.push({ channel: 'push', deliver: true, counted: n });
    else if (v.critical) {
      // Past the cap, a critical ping still goes, and is counted.
      const counted = (await tx.$queryRaw<Array<{ n: number }>>`SELECT count_action('notify.push', ${periodKey(cap, c.tz, c.now)}) AS n`)[0]?.n ?? 0;
      out.push({ channel: 'push', deliver: true, counted, overCap: true });
    }
  } else {
    // Held: recorded as it would have gone, with nothing claimed.
    const used = (await tx.actionCounter.findUnique({ where: { action_day: { action: 'notify.push', day: periodKey(cap, c.tz, c.now) } } }))?.count ?? 0;
    if (v.critical || used < cap.limit) out.push({ channel: 'push', deliver: false });
  }
  return out;
}

export async function recordDecision(db: Db, f: EventFacts, v: Verdict, c: SurfaceContext): Promise<{ id: string; verdict: Verdict; escalationId?: string } | undefined> {
  const escalating = v.action === 'escalate' && !!v.template;
  const rendered = escalating ? words(f, v, c) : undefined;
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

      let surfaced: Record<string, string | number | boolean | string[]> = {};
      let escalationId: string | undefined;
      if (verdict.action === 'escalate' && verdict.template && rendered) {
        const esc = newId('es', c.now);
        escalationId = esc;
        const ledger = rendered.prediction && f.entity ? await predictions(tx, f, rendered.prediction.by, c) : {};
        const text = ledger.predictionId && rendered.withLedger ? rendered.withLedger : rendered.plain;
        const chans = await channels(tx, verdict, c);
        await tx.escalation.create({
          data: {
            id: escalationId, triageDecisionId: id, templateId: isTemplateId(verdict.template.id) ? verdict.template.id : 'unknown',
            fields: text.fields as Prisma.InputJsonObject, title: text.title, body: text.body,
            ...(ledger.predictionId ? { predictionId: ledger.predictionId } : {}),
            ...(ledger.recommendationId ? { recommendationId: ledger.recommendationId } : {}),
            channels: chans.map((x) => x.channel), tainted: f.tainted, sensitivity: f.sensitivity, createdAt: c.now,
          },
        });
        for (const x of chans) {
          await tx.escalationDelivery.create({ data: { id: newId('ed', c.now), escalationId, channel: x.channel, status: x.deliver ? 'pending' : 'held', createdAt: c.now } });
        }
        const pending = chans.filter((x) => x.deliver);
        if (pending.length) {
          await appendAudit(tx, pending.map((x) => ({
            actor: 'runtime:surface', context: 'autonomous' as const, kind: 'intent' as const, action: `notify.${x.channel}`, tier: 'alone' as const, decision: 'act' as const, outcome: 'pending' as const,
            correlationId: `${esc}.${x.channel}`, tainted: f.tainted,
            inputs: { escalationId: esc, channel: x.channel, critical: verdict.critical, ...(x.counted !== undefined ? { count: x.counted } : {}), ...(x.overCap ? { overCap: true } : {}) },
          })), c.now);
          // The job carries the escalation's id only; stately on it, so a resend is a no-op.
          await c.bus?.boss.send(QUEUES.deliver, { escalationId }, { ...inTx(tx), singletonKey: escalationId });
        }
        surfaced = {
          escalationId, templateId: verdict.template.id, linted: text.linted, channels: chans.map((x) => x.channel), delivered: pending.map((x) => x.channel),
          ...(ledger.predictionId ? { predictionId: ledger.predictionId } : {}),
          ...(ledger.recommendationId ? { recommendationId: ledger.recommendationId } : {}),
          ...(ledger.skipped ? { predictionSkipped: ledger.skipped.slice(0, 120) } : {}),
        };
      }

      const byModel = verdict.decidedBy.startsWith('model:') || /^fallback:(invalid|unavailable|capped|deferred)$/.test(verdict.decidedBy);
      await appendAudit(tx, [{
        actor: 'runtime:triage', context: 'autonomous', kind: 'decision', action: byModel ? 'triage.local_model' : 'triage.rule', tier: c.tier,
        decision: DECISION[verdict.action], outcome: verdict.decidedBy === 'fallback:skipped' ? 'skipped' : 'ok', correlationId: id, tainted: f.tainted,
        // Ids, enums and numbers: never the event's text or the model's words.
        inputs: {
          eventId: f.eventId, source: f.source, type: f.type, triageAction: verdict.action, lane: verdict.lane, decidedBy: verdict.decidedBy,
          critical: verdict.critical, shadow: c.shadow, backfill: f.backfill,
          ...(verdict.ruleName ? { ruleName: verdict.ruleName } : {}),
          ...(verdict.relevance !== undefined ? { relevance: verdict.relevance } : {}),
          ...(verdict.reasonCode ? { reasonCode: verdict.reasonCode } : {}),
          ...(verdict.modelMs !== undefined ? { modelMs: Math.round(verdict.modelMs) } : {}),
          ...(verdict !== v ? { capped: v.perDay?.key ?? true } : {}),
          ...(c.proposalId ? { proposalId: c.proposalId } : {}),
          ...(c.wouldPropose ? { wouldPropose: c.wouldPropose } : {}),
          ...surfaced,
        },
      }], c.now);
      return { id, verdict, ...(escalationId ? { escalationId } : {}) };
    });
  } catch (err) {
    // Decided already (a retried or duplicate job): the first decision stands.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002' && String(err.meta?.target ?? '').includes('sourceEventId')) return undefined;
    throw err;
  }
}
