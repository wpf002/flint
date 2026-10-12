/**
 * The goal tick (P3 part 3), every 2 minutes: it finds the reviews that are
 * due and sends each goal's review job. Indexed reads only; it never asks the
 * model, and its jobs carry ids and times only.
 *
 *  1. Scheduled: an active goal whose next review time has come. Never capped.
 *     A job that died heals itself: the next tick finds the goal still due.
 *  2. A watched item changed: for each link of an active goal, the item's
 *     versions past the link's cursor (seenVersion). One is a hit when its
 *     patch touches a watched field, or the item was archived, restored,
 *     merged or forgotten (a merged pull request is archived by its sync, and
 *     that is exactly the change a goal waits for). The cursor moves past
 *     every version read, in the same transaction as the send. A version
 *     number cannot be missed the way a timestamp can: a sync that commits
 *     late still writes the next number.
 *  3. A forecast about a linked item came false, since the link was made. Never
 *     the goal's own onTrack forecast: a goal past its finish date gets a new
 *     one at every review, each a day ahead, and each would come false and set
 *     off the next.
 *  4. A step is due within 48 hours.
 *
 * One review answers every trigger that was there when it ran: a step's
 * trigger is seen once any review of the goal was made since the step came
 * within 48 hours and since its plan version went active; a false forecast's,
 * once any review was made since it resolved. So three steps due the same day,
 * or a change, a false forecast and a due step together, are one review.
 *
 * Triggered sends wait 60 seconds and share the goal's singleton key, so a
 * burst of changes is one review. Worst case from a change to its review: 2
 * minutes to the tick, 60 seconds of waiting, then seconds of stage 1 (exit
 * criterion 3 allows 10 minutes).
 *
 * Lock order: for anything beyond the scheduled read, the tick takes the goal
 * FOR UPDATE first (SKIP LOCKED: a goal busy with a card or a review is left for
 * the next tick), at READ COMMITTED, before it reads a link, a plan, a step or a
 * review of it or moves a cursor.
 */
import { Prisma } from '@prisma/client';
import type { Db, Tx } from '../db.js';
import { inTx, type Bus } from '../bus.js';
import { REVIEW_QUEUE, reviewStanding, reviewsLeft, type ReviewJob } from './review.js';

/** A triggered review waits this long, so a burst of changes becomes one review. */
export const COALESCE_SECONDS = 60;
/** How far ahead a step's due time sets off a review. */
export const STEP_DUE_MS = 48 * 3_600_000;
/** A false forecast older than this no longer sets off a review. */
export const RESOLUTION_WINDOW_MS = 7 * 86_400_000;
/** An item's change kinds that always wake its goals, whatever fields they watch. */
export const WAKING_KINDS = ['archived', 'restored', 'merged', 'forgotten'] as const;
/** The tick's cron: every 2 minutes. */
export const TICK_CRON = '*/2 * * * *';
export const TICK_SECONDS = 120;
/** At most this many of a link's versions are read in one tick (the next tick reads on). */
const VERSIONS_PER_TICK = 500;
const GOALS_PER_TICK = 200;

export interface TickDeps {
  db: Db;
  bus: Pick<Bus, 'boss'>;
  tz: string;
  now?: () => Date;
  coalesceSeconds?: number;
}

export interface TickCounts {
  /** Scheduled reviews sent. */
  due: number;
  /** Triggered reviews sent. */
  triggered: number;
  /** Goals whose trigger was left to the next scheduled review: the day's 12 are used. */
  capped: number;
  /** Goals left for the next tick: something else held their lock. */
  busy: number;
  /** Reviews may not run (a FORBIDDEN rule): nothing was sent. */
  forbidden?: true;
}

/** The goals that may have a trigger waiting: three indexed reads, ids only. */
async function candidates(db: Db, now: Date): Promise<string[]> {
  const rows = await db.$queryRaw<Array<{ id: string }>>`
    SELECT g.id FROM "Goal" g WHERE g.status = 'active' AND (
      EXISTS (SELECT 1 FROM "GoalEntity" ge JOIN "Entity" e ON e.id = ge."entityId" WHERE ge."goalId" = g.id AND e.version > ge."seenVersion")
      OR EXISTS (SELECT 1 FROM "Plan" p JOIN "PlanStep" s ON s."planId" = p.id
                 WHERE p."goalId" = g.id AND p.status = 'active' AND s.status IN ('todo', 'in_progress', 'blocked')
                   AND s."dueAt" > ${now} AND s."dueAt" <= ${new Date(now.getTime() + STEP_DUE_MS)})
      OR EXISTS (SELECT 1 FROM "Resolution" r JOIN "Prediction" pr ON pr.id = r."predictionId"
                 WHERE r.outcome = false AND r."resolvedAt" > ${new Date(now.getTime() - RESOLUTION_WINDOW_MS)}
                   AND r."eventAt" > ${new Date(now.getTime() - RESOLUTION_WINDOW_MS)}
                   AND pr."goalId" IS NULL AND EXISTS (SELECT 1 FROM "GoalEntity" ge WHERE ge."goalId" = g.id AND ge."entityId" = pr."subjectEntityId")))
    ORDER BY g.id LIMIT ${GOALS_PER_TICK}`;
  return rows.map((r) => r.id);
}

/** A watched item's change, if any: the cursors move past every version read. Returns the first hit's version id. */
async function watched(tx: Tx, goalId: string): Promise<string | undefined> {
  const links = await tx.goalEntity.findMany({ where: { goalId }, orderBy: { entityId: 'asc' }, select: { entityId: true, watchPaths: true, seenVersion: true } });
  let first: string | undefined;
  for (const l of links) {
    const versions = await tx.$queryRaw<Array<{ id: string; version: number; hit: boolean }>>`
      SELECT v.id, v.version,
             (v."changeKind" IN (${Prisma.join([...WAKING_KINDS])})
              OR (v.patch IS NOT NULL AND jsonb_typeof(v.patch) = 'object' AND jsonb_exists_any(v.patch, ${l.watchPaths}::text[]))) AS hit
      FROM "EntityVersion" v WHERE v."entityId" = ${l.entityId} AND v.version > ${l.seenVersion}
      ORDER BY v.version ASC LIMIT ${VERSIONS_PER_TICK}`;
    if (!versions.length) continue;
    first ??= versions.find((v) => v.hit)?.id;
    await tx.goalEntity.update({ where: { goalId_entityId: { goalId, entityId: l.entityId } }, data: { seenVersion: versions[versions.length - 1]!.version } });
  }
  return first;
}

/**
 * A forecast about one of the goal's items that came false since the link was
 * made, with no review of the goal since. Never a goal's own onTrack forecast
 * (Prediction.goalId is set on those alone). Recent means both recorded in the
 * last week and about the last week: a result written late about something
 * long past (the first check of old predictions) is news to nobody, and wakes
 * no review.
 */
async function falseForecast(tx: Tx, goalId: string, now: Date): Promise<string | undefined> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT r.id FROM "Resolution" r JOIN "Prediction" pr ON pr.id = r."predictionId"
    WHERE r.outcome = false AND r."resolvedAt" > ${new Date(now.getTime() - RESOLUTION_WINDOW_MS)}
      AND r."eventAt" > ${new Date(now.getTime() - RESOLUTION_WINDOW_MS)}
      AND pr."goalId" IS NULL
      AND EXISTS (SELECT 1 FROM "GoalEntity" ge WHERE ge."goalId" = ${goalId} AND ge."entityId" = pr."subjectEntityId" AND r."resolvedAt" >= ge."createdAt")
      AND NOT EXISTS (SELECT 1 FROM "GoalReview" gr WHERE gr."goalId" = ${goalId} AND gr."createdAt" >= r."resolvedAt")
    ORDER BY r."resolvedAt" ASC, r.id ASC LIMIT 1`;
  return rows[0]?.id;
}

/**
 * An open step of the active plan due within 48 hours, with no review of the
 * goal since it came within 48 hours and since this plan version went active.
 * Its trigger names the step, its due time and the plan version, so a plan
 * changed under the same step and time is a new trigger, never a duplicate.
 */
async function stepDue(tx: Tx, goalId: string, now: Date): Promise<string | undefined> {
  const plan = await tx.plan.findFirst({ where: { goalId, status: 'active' }, select: { id: true, version: true, createdAt: true } });
  if (!plan) return undefined;
  const steps = await tx.planStep.findMany({
    where: { planId: plan.id, status: { in: ['todo', 'in_progress', 'blocked'] }, dueAt: { gt: now, lte: new Date(now.getTime() + STEP_DUE_MS) } },
    orderBy: [{ dueAt: 'asc' }, { key: 'asc' }],
    take: 50,
    select: { key: true, dueAt: true },
  });
  if (!steps.length) return undefined;
  const last = await tx.goalReview.findFirst({ where: { goalId }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
  const fresh = steps.find((s) => !last || last.createdAt.getTime() < Math.max(s.dueAt!.getTime() - STEP_DUE_MS, plan.createdAt.getTime()));
  return fresh && `step:${fresh.key}@${fresh.dueAt!.getTime()}.v${plan.version}`;
}

export async function tick(d: TickDeps): Promise<TickCounts> {
  const now = d.now?.() ?? new Date();
  const counts: TickCounts = { due: 0, triggered: 0, capped: 0, busy: 0 };
  if (!(await reviewStanding(d.db, now)).may) return { ...counts, forbidden: true };

  // 1. Scheduled: the goal's own row says when (Goal_status_nextReviewAt_idx). A job already waiting for the goal is the same job.
  const due = await d.db.goal.findMany({ where: { status: 'active', nextReviewAt: { lte: now } }, orderBy: [{ nextReviewAt: 'asc' }, { id: 'asc' }], take: GOALS_PER_TICK, select: { id: true, nextReviewAt: true } });
  for (const g of due) {
    const job: ReviewJob = { goalId: g.id, kind: 'scheduled', dueAt: g.nextReviewAt!.toISOString() };
    if (await d.bus.boss.send(REVIEW_QUEUE, job, { singletonKey: g.id })) counts.due += 1;
  }

  // 2 to 4. Triggers, one goal at a time, each under its goal's lock.
  for (const goalId of await candidates(d.db, now)) {
    const r = await d.db.$transaction(
      async (tx) => {
        const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "Goal" WHERE id = ${goalId} AND status = 'active' FOR UPDATE SKIP LOCKED`;
        if (!locked.length) return 'busy' as const;
        // The cursors move whatever comes next: a change past the day's 12 is covered by the next scheduled review.
        const version = await watched(tx, goalId);
        const trigger = version ? `version:${version}` : (await falseForecast(tx, goalId, now).then((id) => id && `resolution:${id}`)) || (await stepDue(tx, goalId, now));
        if (!trigger) return 'nothing' as const;
        if (!(await reviewsLeft(tx, goalId, d.tz, now))) return 'capped' as const;
        const job: ReviewJob = { goalId, kind: 'triggered', triggerEventId: trigger };
        const sent = await d.bus.boss.send(REVIEW_QUEUE, job, { ...inTx(tx), singletonKey: goalId, startAfter: d.coalesceSeconds ?? COALESCE_SECONDS });
        return sent ? ('sent' as const) : ('nothing' as const);
      },
      { maxWait: 10_000, timeout: 20_000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
    if (r === 'sent') counts.triggered += 1;
    else if (r === 'capped') counts.capped += 1;
    else if (r === 'busy') counts.busy += 1;
  }
  return counts;
}
