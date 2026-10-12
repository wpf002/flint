/**
 * One goal's review, stage 1 (P3 part 3): deterministic, a few seconds of
 * database work, and never the model. In ONE transaction at READ COMMITTED,
 * under flint.actor `runtime:goals`:
 *
 *  1. the goal, locked FOR UPDATE before any plan, step or review is read or
 *     written (the README's lock order, as the card executor and the panel's
 *     own writes take it); it must still be active;
 *  2. its checks, as they stand (criteria.ts: a finished item is read as it
 *     stands; only a forgotten one, or a tainted field, is unknown);
 *  3. its onTrack forecast (ontrack.ts), superseding the open one;
 *  4. the GoalReview row (the database requires the forecast), its summary made
 *     from counts;
 *  5. the goal's progress and, for a scheduled review, its next review time
 *     (the cadence's next 09:00 local, zone.ts);
 *  6. its audit entry, and the plan stage's job (ids only), sent in the same
 *     transaction.
 *
 * A scheduled review answers one due time: under the lock it checks that the
 * goal's next review is still the one the job was sent for, so a second job for
 * the same time does nothing (the database's index would refuse it too). A
 * triggered review runs once per trigger. Triggered and requested reviews claim
 * 12 a day per goal; scheduled ones are never capped. While goal.review.local
 * is not promoted the review is marked `shadow` (the trial week): it records
 * what it found, and its plan stage files nothing.
 *
 * Nothing here logs, audits or returns a goal's words: ids, counts and enums.
 */
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import {
  GOAL_BUDGETS,
  GoalId,
  IsoMs,
  REVIEW_CADENCES,
  REVIEW_KINDS,
  localDay,
  nextReviewAt,
  resolveTier,
  reviewCounter,
  runsInShadow,
  type ReviewCadence,
  type Tier,
} from '@flint/policy';
import type { Db, Tx } from '../db.js';
import { QUEUES, inTx, type Bus } from '../bus.js';
import { appendAudit } from '../governance/audit.js';
import { claim, periodKey } from '../governance/counters.js';
import { activePolicies } from '../governance/proposals.js';
import { checkedItems, criteriaOf, evaluate, itemFacts, marksOf } from './criteria.js';
import { REVIEW_LATE_MS } from '@flint/policy';
import { reviewingLog, reviewingMs } from './late.js';
import { GOALS_ACTOR, recordOnTrack } from './ontrack.js';
import { activePlan } from './ops.js';

export const REVIEW_QUEUE = QUEUES.goals[0];
export const PLAN_QUEUE = QUEUES.goals[1];
/** The action a review runs under: APPROVAL with shadow until Will promotes it; a FORBIDDEN row stops reviews. */
export const REVIEW_ACTION = 'goal.review.local';
const DAY = 86_400_000;

/** What sets a review off, by id: version:<id>, step:<key>@<ms>.v<plan version>, resolution:<id>, chat:<ref>. Never words. */
export const TriggerId = z.string().regex(/^[a-z]{1,20}:[A-Za-z0-9_:@.-]{1,99}$/);

/** goals.review's data: ids and times only (pg-boss's tables sit outside retention and forget). */
export const ReviewJob = z
  .object({ goalId: GoalId, kind: z.enum(REVIEW_KINDS), triggerEventId: TriggerId.optional(), dueAt: IsoMs.optional() })
  .strict()
  .superRefine((j, ctx) => {
    if ((j.kind === 'scheduled') !== (j.dueAt !== undefined)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['dueAt'], message: 'a scheduled review names its due time, and only it does' });
    if (j.kind === 'triggered' && !j.triggerEventId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['triggerEventId'], message: 'a triggered review names what set it off' });
  });
export type ReviewJob = z.infer<typeof ReviewJob>;

/**
 * goals.plan's data: the goal and the review whose plan stage it is; how often
 * it yielded to chat (`deferrals`) and how many model requests it had made by
 * then (`requests`: the review's 2 are not given again to a run that comes
 * back); how often it came back because the model was not there (`retries`);
 * and whether it already holds its slot of the day's cap (`claimed`).
 */
export const PlanJob = z
  .object({
    goalId: GoalId, reviewId: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
    deferrals: z.number().int().min(1).max(1000).optional(), requests: z.number().int().min(1).max(10).optional(),
    retries: z.number().int().min(1).max(10).optional(), claimed: z.literal(true).optional(),
  })
  .strict();
export type PlanJob = z.infer<typeof PlanJob>;

/** May reviews run, and in shadow? Promoted (ALONE): for real. APPROVAL: in shadow. FORBIDDEN: not at all. */
export async function reviewStanding(db: Db | Tx, now: Date): Promise<{ may: boolean; shadow: boolean; tier: Tier; cap: { limit: number; period: 'hour' | 'day' | 'week' } | undefined }> {
  const t = resolveTier(REVIEW_ACTION, { context: 'autonomous', tainted: false, policies: await activePolicies(db, now), now });
  return { may: t.tier === 'alone' || (t.tier === 'approval' && runsInShadow(REVIEW_ACTION)), shadow: t.tier !== 'alone', tier: t.tier, cap: t.cap };
}

/** Has this goal a triggered or requested review left today? Read only: the review itself claims the slot. */
export async function reviewsLeft(db: Db | Tx, goalId: string, tz: string, now: Date): Promise<boolean> {
  const row = await db.actionCounter.findUnique({ where: { action_day: { action: reviewCounter(goalId), day: periodKey({ period: 'day' }, tz, now) } }, select: { count: true } });
  return (row?.count ?? 0) < GOAL_BUDGETS.reviewsPerGoalPerDay;
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * A review's summary: sentences made from counts, never a goal's words. The
 * checks are said as the panel says them (the verb follows the count: "1 of 3
 * checks is met", "2 of 3 checks are met").
 */
export function reviewSummary(c: { met: number; total: number; unknown: number; overdue: number; dueSoon: number }): string {
  const one = c.total === 1;
  const checks =
    c.total > 0 && c.met === c.total ? (one ? 'Its check is met.' : 'All of its checks are met.')
    : one ? (c.unknown ? 'Flint can’t tell whether its check is met right now.' : 'Its check isn’t met yet.')
    : `${c.met} of ${c.total} checks ${c.met === 1 ? 'is' : 'are'} met.`;
  const out = [checks];
  if (c.unknown && !one) out.push(`Flint can’t tell about ${c.unknown} of them right now.`);
  if (c.overdue) out.push(`${count(c.overdue, 'step is', 'steps are')} overdue.`);
  if (c.dueSoon) out.push(`${count(c.dueSoon, 'step is', 'steps are')} due this week.`);
  return out.join(' ');
}

export interface ReviewDeps {
  db: Db;
  bus: Pick<Bus, 'boss'>;
  tz: string;
  now?: () => Date;
  /** Test seam: runs inside the transaction once the goal is locked, before anything else of it is read. */
  afterLock?: (tx: Tx) => Promise<void>;
}

export type ReviewOutcome =
  | { outcome: 'reviewed'; reviewId: string; predictionId: string; shadow: boolean }
  | { outcome: 'gone' | 'stale' | 'duplicate' | 'capped' | 'forbidden' };

interface LockedGoal {
  id: string;
  status: string;
  successCriteria: unknown;
  criteriaMet: unknown;
  horizonAt: Date | null;
  reviewCadence: string;
  nextReviewAt: Date | null;
  activatedAt: Date | null;
  createdAt: Date;
  progress: number;
}

const newReviewId = (now: Date) => `gr${now.getTime().toString(36)}${Math.random().toString(36).slice(2, 12)}`;

/** Review one goal. Nothing is written unless the review is: every refusal leaves the goal as it was. */
export async function runReview(d: ReviewDeps, job: ReviewJob): Promise<ReviewOutcome> {
  const now = d.now?.() ?? new Date();
  const standing = await reviewStanding(d.db, now);
  if (!standing.may) return { outcome: 'forbidden' };
  try {
    return await d.db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT set_config('flint.actor', ${GOALS_ACTOR}, true)`;
        // The goal first, FOR UPDATE: a card being carried out, a step tick and another review wait their turn.
        const [g] = await tx.$queryRaw<LockedGoal[]>`
          SELECT id, status, "successCriteria", "criteriaMet", "horizonAt", "reviewCadence", "nextReviewAt", "activatedAt", "createdAt", progress
          FROM "Goal" WHERE id = ${job.goalId} FOR UPDATE`;
        if (!g || g.status !== 'active') return { outcome: 'gone' as const };
        await d.afterLock?.(tx);
        const due = job.dueAt ? new Date(job.dueAt) : null;
        // A scheduled review answers the due time it was sent for: if the goal's next review moved on, it is done.
        if (job.kind === 'scheduled' && (!g.nextReviewAt || !due || g.nextReviewAt.getTime() !== due.getTime())) return { outcome: 'stale' as const };
        if (job.triggerEventId && (await tx.goalReview.count({ where: { goalId: g.id, triggerEventId: job.triggerEventId } })) > 0) return { outcome: 'duplicate' as const };
        if (job.kind !== 'scheduled' && (await claim(tx, reviewCounter(g.id), { limit: GOAL_BUDGETS.reviewsPerGoalPerDay, period: 'day' }, d.tz, now)) === null) {
          return { outcome: 'capped' as const };
        }

        const criteria = criteriaOf(g);
        const plan = await activePlan(tx, g.id);
        const e = evaluate(criteria, marksOf(g), plan?.steps ?? null, await itemFacts(tx, checkedItems(criteria)));
        const open = (plan?.steps ?? []).filter((s) => s.dueAt && (s.status === 'todo' || s.status === 'in_progress' || s.status === 'blocked'));
        const overdue = open.filter((s) => Date.parse(s.dueAt!) <= now.getTime()).length;
        const dueSoon = open.filter((s) => Date.parse(s.dueAt!) > now.getTime() && Date.parse(s.dueAt!) <= now.getTime() + 7 * DAY).length;

        // A scheduled review moves the goal to its cadence's next slot (monthly reviews keep the day the goal started on).
        const cadence = (REVIEW_CADENCES as readonly string[]).includes(g.reviewCadence) ? (g.reviewCadence as ReviewCadence) : 'P1W';
        const anchor = Number(localDay(d.tz, g.activatedAt ?? g.createdAt).slice(8, 10));
        const next = job.kind === 'scheduled' && due ? nextReviewAt(cadence, d.tz, due, now, anchor) : g.nextReviewAt;

        // Late: it waited over an hour while Flint was reviewing (late.ts). The digest counts these, from the audit entry.
        const late = job.kind === 'scheduled' && !!due && now.getTime() - due.getTime() > REVIEW_LATE_MS && reviewingMs(await reviewingLog(tx, due, now), due, now) > REVIEW_LATE_MS;

        const forecast = await recordOnTrack(tx, g, { progress: e.progress, overdueSteps: overdue, nextReviewAt: next }, d.tz, now);
        const reviewId = newReviewId(now);
        await tx.goalReview.create({
          data: {
            id: reviewId, goalId: g.id, kind: job.kind, triggerEventId: job.triggerEventId ?? null, dueAt: job.kind === 'scheduled' ? due : null,
            summary: reviewSummary({ met: e.met, total: e.total, unknown: e.unknown, overdue, dueSoon }),
            criteria: e.criteria as unknown as Prisma.InputJsonArray, progressBefore: g.progress, progressAfter: e.progress,
            predictionId: forecast.id, shadow: standing.shadow,
          },
        });
        await tx.goal.update({ where: { id: g.id }, data: { progress: e.progress, ...(job.kind === 'scheduled' ? { nextReviewAt: next } : {}) } });
        await appendAudit(tx, [{
          actor: GOALS_ACTOR, context: 'autonomous', kind: 'action', action: REVIEW_ACTION, tier: standing.tier, decision: standing.shadow ? 'log' : 'act', outcome: 'ok', correlationId: reviewId,
          inputs: {
            goalId: g.id, reviewId, kind: job.kind, ...(job.triggerEventId ? { trigger: job.triggerEventId } : {}), met: e.met, total: e.total, unknown: e.unknown,
            overdue, predictionId: forecast.id, superseded: forecast.superseded, shadow: standing.shadow, ...(late ? { late: true } : {}),
          },
        }], now);
        // The plan stage's job, with the review it is for: both commit, or neither does.
        await d.bus.boss.send(PLAN_QUEUE, { goalId: g.id, reviewId }, { ...inTx(tx), singletonKey: g.id });
        return { outcome: 'reviewed' as const, reviewId, predictionId: forecast.id, shadow: standing.shadow };
      },
      // READ COMMITTED, said out loud: the database refuses plan and step writes above it, and each check reads what is committed now.
      { maxWait: 10_000, timeout: 30_000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
  } catch (err) {
    // The same trigger, or the same due time, reviewed by a job that ran beside this one: the index refused the second.
    const e = err as { code?: unknown; meta?: { target?: unknown } };
    if (e.code === 'P2002' && JSON.stringify(e.meta?.target ?? '').includes('GoalReview')) return { outcome: 'duplicate' };
    throw err;
  }
}
