/**
 * A review's onTrack forecast (P3 part 3; exit criterion 6): every review
 * records one prediction that the goal meets its success criteria by a date,
 * and the database refuses a review without it.
 *
 * The probability is a RULE, not a model's: how far the checks are met against
 * how much of the time is gone, less a little for each overdue step. So a
 * review never waits on the local model, and two reviews of the same facts say
 * the same number. Its claim names the goal only by ref (goal#<last 6 of its
 * id>), from the goal_on_track template; its criteria are fixed text. It
 * supersedes the goal's open forecast (the ledger flags a revision made close
 * to the date as late, which is honest). goal.done and goal.abandon resolve it
 * as Will; P4's resolver will, at its date. Its resolver is `auto_world` and
 * must stay so: P4's resolver, and its guard on who may resolve what, are built
 * on that, and another value would block the goal-done path.
 *
 * Its own budget: it is counted under ON_TRACK_COUNTER and never claims
 * ledger.prediction.record's daily cap (@flint/policy tiers.ts says why).
 */
import { ON_TRACK_COUNTER, entityRef, localDay, periodKey } from '@flint/policy';
import type { Tx } from '../db.js';
import { emitPrediction } from '../ledger/emit.js';

const DAY = 86_400_000;
/** The rule's name, as the forecast's evidence cites it. Change the rule, change the name. */
export const ON_TRACK_RULE = 'goals.on_track.rule.v1';
/** Who writes a goal's forecast (the database lets no one else attach one to a goal). */
export const GOALS_ACTOR = 'runtime:goals';

export interface OnTrackFacts {
  /** met / total, 0 to 1. */
  progress: number;
  activatedAt: Date | null;
  horizonAt: Date | null;
  /** Steps still open past their due time. */
  overdueSteps: number;
  now: Date;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/**
 * p = 0.5 + 0.8 × (progress − elapsed) − 0.05 × min(3, overdue steps), kept
 * within 5% and 95% (Flint never claims certainty), to two places. `elapsed` is
 * the share of the time from activation to the finish date that is gone; 0
 * without a finish date.
 */
export function onTrackProbability(f: OnTrackFacts): number {
  let elapsed = 0;
  if (f.horizonAt && f.activatedAt) {
    const span = f.horizonAt.getTime() - f.activatedAt.getTime();
    elapsed = span > 0 ? clamp((f.now.getTime() - f.activatedAt.getTime()) / span, 0, 1) : 1;
  }
  const p = 0.5 + 0.8 * (clamp(f.progress, 0, 1) - elapsed) - 0.05 * Math.min(3, Math.max(0, f.overdueSteps));
  return Math.round(clamp(p, 0.05, 0.95) * 100) / 100;
}

/**
 * When the forecast resolves: the finish date, at most 179 days out (the
 * ledger's horizon is 180); with the finish date past or within the hour, a day
 * from now or the next review, whichever is later, so it is always ahead;
 * without a finish date, 90 days from now.
 */
export function onTrackResolveBy(horizonAt: Date | null, nextReviewAt: Date | null, now: Date): Date {
  const cap = now.getTime() + 179 * DAY;
  if (!horizonAt) return new Date(now.getTime() + 90 * DAY);
  if (horizonAt.getTime() <= now.getTime() + 3_600_000) return new Date(Math.min(cap, Math.max(now.getTime() + DAY, nextReviewAt?.getTime() ?? 0)));
  return new Date(Math.min(horizonAt.getTime(), cap));
}

/** Record the goal's forecast inside the review's transaction, superseding its open one, and count it. Returns its id. */
export async function recordOnTrack(
  tx: Tx,
  goal: { id: string; activatedAt: Date | null; horizonAt: Date | null },
  f: { progress: number; overdueSteps: number; nextReviewAt: Date | null },
  tz: string,
  now: Date,
): Promise<{ id: string; probability: number; resolveBy: Date; superseded: boolean }> {
  const probability = onTrackProbability({ progress: f.progress, activatedAt: goal.activatedAt, horizonAt: goal.horizonAt, overdueSteps: f.overdueSteps, now });
  const resolveBy = onTrackResolveBy(goal.horizonAt, f.nextReviewAt, now);
  const ref = entityRef('goal', goal.id);
  const open = await tx.prediction.findFirst({ where: { goalId: goal.id, domain: 'goals', status: 'open' }, orderBy: { createdAt: 'desc' }, select: { id: true } });
  const p = await emitPrediction(
    tx,
    {
      template: { id: 'goal_on_track', params: { goal: ref, by: localDay(tz, resolveBy) } },
      kind: 'binary', probability, method: 'rule', domain: 'goals', type: 'deadline_met',
      evidence: [{ kind: 'rule', ref: ON_TRACK_RULE }],
      resolutionCriteria: `True if Will marks ${ref} done at or before the resolve time. False if he abandons it, or it is not done by then.`,
      resolver: 'auto_world', resolverSpec: { goalId: goal.id, rule: 'goal_done_by' },
      resolveBy: resolveBy.toISOString(), tainted: false,
      ...(open ? { supersedesId: open.id } : {}),
    },
    GOALS_ACTOR,
    now,
    { goalId: goal.id },
  );
  await tx.$queryRaw`SELECT count_action(${ON_TRACK_COUNTER}, ${periodKey({ period: 'day' }, tz, now)})`;
  return { id: p.id, probability, resolveBy, superseded: !!open };
}
