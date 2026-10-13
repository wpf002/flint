/**
 * What P3 measured (part 4): the numbers behind the P3 report (report/p3.ts)
 * and the promotion cards (governance/promotion.ts), read from the database as
 * it stands. One set of counts for both, so a card never says a number the
 * report would not.
 *
 * Numbers only. Nothing here reads a goal's title, a check's text or a step's
 * title, and nothing returns an id: counts, days and durations.
 */
import { CHAT_SUGGESTION_ACTIONS, GOAL_SAYS, GOAL_SIGNED_ACTIONS, REVIEW_DOWN_MS, localDay, localDayBounds, previousDay } from '@flint/policy';
import { Prisma } from '@prisma/client';
import type { Db } from '../db.js';
import { REVIEWS_STOPPED, waitedMs } from './late.js';

export const DAY = 86_400_000;
/** The chat suggestions (part 5 files them): a goal, or a commitment, from Will's quoted words (@flint/policy's list). */
export { CHAT_SUGGESTION_ACTIONS };

/** When Flint first reviewed a goal: the trial week starts here. */
export async function firstReviewAt(db: Db): Promise<Date | undefined> {
  return (await db.goalReview.findFirst({ orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { createdAt: true } }))?.createdAt;
}

export interface ReviewCounts {
  /** Reviews of every kind. */
  reviews: number;
  scheduled: number;
  /** Scheduled reviews that ran late: over an hour of waiting while Flint was reviewing, as each review's own audit entry recorded (what the digest counts). */
  lateHour: number;
  /** Of those, the ones that had waited more than 24 hours: the review's audit entry marks that too. */
  late: number;
  /** Reviews the local model answered. */
  answered: number;
  /** Changes those answers suggested and that still fit the plan. A change a waiting card already asks for is one change, however many reviews found the card still waiting. */
  suggested: number;
  /** Reviews made in the trial week (they file no card). */
  shadow: number;
}

/**
 * The reviews made from `since` up to `until`. Late is counted on the clock
 * the panel, Settings > Health and the digest read (late.ts): the time a
 * review waited WHILE FLINT WAS REVIEWING, so a goal that was due while reviews
 * were off, the runtime was down or the Mac slept was waiting, not late. Both
 * marks are read from the review's own audit entry, written when it ran:
 * `late` (over an hour, what the digest counts) and `lateOverDay` (over 24
 * hours, the outage mark). An audit entry is kept, so neither changes when
 * retention deletes the health rows the wait was counted from.
 */
export async function reviewCounts(db: Db, since: Date, until: Date): Promise<ReviewCounts> {
  const marked = (mark: string) => Prisma.sql`EXISTS (SELECT 1 FROM "AuditEntry" a WHERE a."correlationId" = r.id AND a.action = 'goal.review.local' AND a.inputs->>${mark} = 'true')`;
  const [r] = await db.$queryRaw<Array<Omit<ReviewCounts, 'suggested'>>>`
    SELECT count(*)::int AS reviews,
           count(*) FILTER (WHERE r.kind = 'scheduled')::int AS scheduled,
           count(*) FILTER (WHERE r.kind = 'scheduled' AND ${marked('late')})::int AS "lateHour",
           count(*) FILTER (WHERE r.kind = 'scheduled' AND ${marked('lateOverDay')})::int AS late,
           count(*) FILTER (WHERE r.planner LIKE 'ollama:%')::int AS answered,
           count(*) FILTER (WHERE r.shadow)::int AS shadow
    FROM "GoalReview" r WHERE r."createdAt" >= ${since} AND r."createdAt" <= ${until}`;
  // A suggestion on no card (the trial week's, or one held back) is one each time it is made. One on a card is
  // that card's change: a review that found the card still waiting did not suggest it again.
  const [s] = await db.$queryRaw<Array<{ suggested: number }>>`
    SELECT (count(*) FILTER (WHERE d->>'card' IS NULL) + count(DISTINCT (d->>'card') || ' ' || (d->'change')::text) FILTER (WHERE d->>'card' IS NOT NULL))::int AS suggested
    FROM "GoalReview" r, jsonb_array_elements(CASE WHEN jsonb_typeof(r.diff) = 'array' THEN r.diff ELSE '[]'::jsonb END) d
    WHERE r."createdAt" >= ${since} AND r."createdAt" <= ${until} AND coalesce(d->>'held', '') NOT IN ('stale', 'rejected')`;
  return { ...(r ?? { reviews: 0, scheduled: 0, lateHour: 0, late: 0, answered: 0, shadow: 0 }), suggested: s?.suggested ?? 0 };
}

/** Active goals whose review has now waited more than 24 hours while Flint was reviewing: what Settings > Health shows as down. */
export async function overdueNow(db: Db, now: Date): Promise<number> {
  const due = await db.goal.findMany({ where: { status: 'active', nextReviewAt: { lt: new Date(now.getTime() - REVIEW_DOWN_MS) } }, select: { nextReviewAt: true } });
  if (!due.length) return 0;
  return (await waitedMs(db, due.map((g) => g.nextReviewAt), now)).filter((ms) => ms > REVIEW_DOWN_MS).length;
}

/**
 * Where a count of "the last `days` days" starts: the start of the local day
 * that many days before today. The promotion table's gate and the sentence on
 * its card both count from here, so the card never says a number the gate did
 * not see.
 */
export function windowStart(tz: string, now: Date, days: number): Date {
  let d = localDay(tz, now);
  for (let i = 0; i < days; i++) d = previousDay(d);
  return localDayBounds(tz, d).start;
}

/** A Goal Reviews check older than this says nothing about now (the health job looks every 5 minutes). */
export const HEALTH_FRESH_MS = 15 * 60_000;

/**
 * What the latest health check found for goal reviews: `on`; `off`
 * (FLINT_PLANNER is off); `stopped` (a rule forbids them); or `unknown` when
 * the health check has not looked in the last 15 minutes.
 */
export async function reviewsNow(db: Db, now: Date): Promise<'on' | 'off' | 'stopped' | 'unknown'> {
  const row = await db.healthCheck.findFirst({ where: { component: 'goals', at: { lte: now } }, orderBy: [{ at: 'desc' }, { id: 'desc' }], select: { status: true, detail: true, at: true } });
  if (!row || now.getTime() - row.at.getTime() > HEALTH_FRESH_MS) return 'unknown';
  return row.status === 'disabled' ? 'off' : row.detail === REVIEWS_STOPPED ? 'stopped' : 'on';
}

/**
 * Of the `days` whole local days before today, the ones goal reviews were not
 * on for, by the health check's own Goal Reviews rows (the rows late.ts counts
 * reviewing time from, read the same way): a day counts when a check that day
 * found reviews on, and none found them off (`disabled` while FLINT_PLANNER is
 * off) or stopped by a rule. The health job looks every 5 minutes, so a day
 * counts only if reviews were on every time it looked. A day it never looked
 * (the runtime down, or the Mac asleep, from midnight to midnight) is not a
 * day they were on.
 *
 * A day with nothing due is still a day they were on: reviews follow each
 * goal's own cadence, so most days of a weekly goal have none.
 */
export async function daysNotRunning(db: Db, tz: string, now: Date, days: number): Promise<{ since: Date; missing: string[] }> {
  const want: string[] = [];
  // Calendar dates, stepped back one at a time: a 23- or 25-hour day is still one day.
  for (let d = previousDay(localDay(tz, now)); want.length < days; d = previousDay(d)) want.push(d);
  const since = localDayBounds(tz, want[want.length - 1]!).start;
  const checked = await db.$queryRaw<Array<{ day: string; on: number; off: number }>>`
    SELECT to_char(at AT TIME ZONE ${tz}, 'YYYY-MM-DD') AS day,
           count(*) FILTER (WHERE status <> 'disabled' AND detail IS DISTINCT FROM ${REVIEWS_STOPPED})::int AS "on",
           count(*) FILTER (WHERE status = 'disabled' OR detail IS NOT DISTINCT FROM ${REVIEWS_STOPPED})::int AS "off"
    FROM "HealthCheck" WHERE component = 'goals' AND at >= ${since} GROUP BY 1`;
  const health = new Map(checked.map((c) => [c.day, c]));
  const ran = (d: string) => (health.get(d)?.on ?? 0) > 0 && !health.get(d)?.off;
  return { since, missing: want.filter((d) => !ran(d)).sort() };
}

/** Exit 1: the active goals, their checks, and how many of those Flint reads itself (a step or an item, not Will's own mark). */
export async function activeGoals(db: Db): Promise<{ active: number; checks: number; machine: number }> {
  const [r] = await db.$queryRaw<Array<{ active: number; checks: number; machine: number }>>`
    SELECT count(DISTINCT g.id)::int AS active,
           count(c.value)::int AS checks,
           count(c.value) FILTER (WHERE c.value->'check'->>'kind' IN ('steps', 'item'))::int AS machine
    FROM "Goal" g LEFT JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(g."successCriteria") = 'array' THEN g."successCriteria" ELSE '[]'::jsonb END) c ON true
    WHERE g.status = 'active'`;
  return r ?? { active: 0, checks: 0, machine: 0 };
}

/**
 * Exit 3: from a watched item's change being recorded to the review it set off.
 * Each such review names the item's version that set it off (`version:<id>`).
 */
export async function watchedLatency(db: Db, since: Date): Promise<{ n: number; maxS: number | null; over10Min: number }> {
  const [r] = await db.$queryRaw<Array<{ n: number; maxS: number | null; over10Min: number }>>`
    SELECT count(*)::int AS n,
           max(EXTRACT(EPOCH FROM (r."createdAt" - v."recordedAt")))::float8 AS "maxS",
           count(*) FILTER (WHERE r."createdAt" > v."recordedAt" + interval '10 minutes')::int AS "over10Min"
    FROM "GoalReview" r JOIN "EntityVersion" v ON v.id = substr(r."triggerEventId", 9)
    WHERE r.kind = 'triggered' AND r."triggerEventId" LIKE 'version:%' AND r."createdAt" > ${since}`;
  return r ?? { n: 0, maxS: null, over10Min: 0 };
}

/**
 * Exit 4: every plan version that took effect came from a card Will signed (the
 * goal's own card, or a plan change), and the small changes a review FILED went
 * on one card. `versions` counts plans that are or were active.
 *
 * A review's record names the card each suggestion is on, and that can be a
 * card an earlier review filed and Will has not answered yet (a waiting card is
 * kept, not filed again). So a card counts for the review that named it first:
 * `reviewsWithCards` reviews filed one, and `splitMinor` of them put their
 * small changes on more than one.
 */
export async function planChanges(db: Db): Promise<{ versions: number; withoutCard: number; reviewsWithCards: number; splitMinor: number }> {
  const [p] = await db.$queryRaw<Array<{ versions: number; withoutCard: number }>>`
    SELECT count(*)::int AS versions,
           count(*) FILTER (WHERE NOT EXISTS (
             SELECT 1 FROM "Proposal" c WHERE c."approvalId" = pl."approvalId" AND c.action IN ('goal.activate', 'plan.change') AND c.status IN ('executing', 'executed')
           ))::int AS "withoutCard"
    FROM "Plan" pl WHERE pl.status IN ('active', 'superseded')`;
  const [r] = await db.$queryRaw<Array<{ reviewsWithCards: number; splitMinor: number }>>`
    WITH named AS (
      SELECT r.id AS review, r."createdAt" AS at, d->>'card' AS card, d->>'class' AS class
      FROM "GoalReview" r, jsonb_array_elements(CASE WHEN jsonb_typeof(r.diff) = 'array' THEN r.diff ELSE '[]'::jsonb END) d
      WHERE d->>'card' IS NOT NULL
    ), filed AS (
      SELECT DISTINCT ON (card) card, review, class FROM named ORDER BY card, at ASC, review ASC
    )
    SELECT count(*)::int AS "reviewsWithCards", count(*) FILTER (WHERE minor > 1)::int AS "splitMinor"
    FROM (SELECT review, count(*) FILTER (WHERE class = 'minor') AS minor FROM filed GROUP BY review) per`;
  return { versions: p?.versions ?? 0, withoutCard: p?.withoutCard ?? 0, reviewsWithCards: r?.reviewsWithCards ?? 0, splitMinor: r?.splitMinor ?? 0 };
}

/**
 * Exit 5: goals that have started (active, paused, done or abandoned) without
 * Will's signed and used approval behind their latest change. The database
 * refuses such a row; this counts any that exist anyway.
 */
export async function signedGoals(db: Db): Promise<{ started: number; unsigned: number }> {
  const [r] = await db.$queryRaw<Array<{ started: number; unsigned: number }>>`
    SELECT count(*)::int AS started,
           count(*) FILTER (WHERE NOT EXISTS (
             SELECT 1 FROM "Approval" a JOIN "Proposal" c ON c."approvalId" = a.id
             WHERE a.id = g."approvalId" AND a.decision = 'approve' AND a."consumedAt" IS NOT NULL AND c.action = ANY (${[...GOAL_SIGNED_ACTIONS]}::text[])
           ))::int AS unsigned
    FROM "Goal" g WHERE g.status IN ('active', 'paused', 'done', 'abandoned')`;
  return r ?? { started: 0, unsigned: 0 };
}

/** Exit 6: reviews, and those without their goal's own onTrack forecast in the ledger. */
export async function reviewForecasts(db: Db): Promise<{ reviews: number; without: number }> {
  const [r] = await db.$queryRaw<Array<{ reviews: number; without: number }>>`
    SELECT count(*)::int AS reviews,
           count(*) FILTER (WHERE p.id IS NULL OR p."goalId" IS DISTINCT FROM r."goalId" OR p.domain <> 'goals')::int AS without
    FROM "GoalReview" r LEFT JOIN "Prediction" p ON p.id = r."predictionId"`;
  return r ?? { reviews: 0, without: 0 };
}

/**
 * Exit 7: suggestions from chat, and those not resting on Will's own quoted
 * words (12 to 300 characters, his, from a turn that read nothing untrusted).
 * A card whose args retention has cleared can no longer be read: it is counted
 * as `cleared`, not as a miss.
 *
 * What Will did with them, each counted once: `executed` (he approved the
 * card), `made` (he made the suggestion a goal himself before approving its
 * card: Make It a Goal set the card aside, which is a yes, not a no),
 * `rejected` (he turned it down: rejected the card, or dismissed it) and
 * `expired`.
 */
export interface ChatSuggestionCounts {
  filed: number;
  withoutQuote: number;
  cleared: number;
  executed: number;
  made: number;
  rejected: number;
  expired: number;
}
export async function chatSuggestions(db: Db, o: { since?: Date; actions?: readonly string[] } = {}): Promise<ChatSuggestionCounts> {
  const since = o.since ?? null;
  // A card set aside by Make It a Goal carries this fixed sentence as its error, and a card's error is kept for good.
  const replaced = GOAL_SAYS.replaced;
  const [r] = await db.$queryRaw<ChatSuggestionCounts[]>`
    SELECT count(*)::int AS filed,
           count(*) FILTER (WHERE c.args IS NOT NULL AND NOT coalesce(
             jsonb_typeof(c.args->'quote') = 'string' AND char_length(c.args->>'quote') BETWEEN 12 AND 300
             AND c."argsProvenance"->'quote'->>'source' = 'will' AND c."argsProvenance"->'quote'->'tainted' = 'false'::jsonb, false))::int AS "withoutQuote",
           count(*) FILTER (WHERE c.args IS NULL)::int AS cleared,
           count(*) FILTER (WHERE c.status = 'executed')::int AS executed,
           count(*) FILTER (WHERE c.status = 'rejected' AND c.action = 'goal.propose' AND c.error IS NOT DISTINCT FROM ${replaced})::int AS made,
           count(*) FILTER (WHERE c.status = 'rejected' AND NOT (c.action = 'goal.propose' AND c.error IS NOT DISTINCT FROM ${replaced}))::int AS rejected,
           count(*) FILTER (WHERE c.status = 'expired')::int AS expired
    FROM "Proposal" c WHERE c.action = ANY (${[...(o.actions ?? CHAT_SUGGESTION_ACTIONS)]}::text[]) AND (${since}::timestamptz IS NULL OR c."createdAt" >= ${since}::timestamptz)`;
  return r ?? { filed: 0, withoutQuote: 0, cleared: 0, executed: 0, made: 0, rejected: 0, expired: 0 };
}

/** Exit 7, beside the cards: what the candidates intake added with no card, under a rule Will signed (its own audit entries). */
export async function addedAlone(db: Db, since?: Date): Promise<number> {
  return db.auditEntry.count({
    where: { actor: 'runtime:goals.candidates', kind: 'action', outcome: 'ok', action: { in: [...CHAT_SUGGESTION_ACTIONS] }, ...(since ? { at: { gte: since } } : {}) },
  });
}

/**
 * Exit 8: the goals block's size on the chat turns that carried it, from the
 * daily rollup's series over the last 30 days and from today's turns (which
 * the rollup has not reached yet).
 */
export async function goalsBlockSize(db: Db, tz: string, now: Date): Promise<{ days: number; mean: number | null; max: number | null }> {
  const since = new Date(now.getTime() - 30 * DAY);
  const points = async (key: string) => (await db.metricPoint.findMany({ where: { seriesKey: key, at: { gt: since } }, select: { value: true } })).map((p) => p.value);
  const means = await points('p3.ctx_tokens.goals');
  const maxes = await points('p3.ctx_tokens.goals_max');
  const [today] = await db.$queryRaw<Array<{ mean: number | null; max: number | null }>>`
    SELECT avg((e.payload->'ctxTokens'->>'goals')::float8)::float8 AS mean, max((e.payload->'ctxTokens'->>'goals')::float8)::float8 AS max
    FROM "SourceEvent" e
    WHERE e.source = 'server' AND e.type = 'chat.turn' AND e."occurredAt" >= ${localDayBounds(tz, localDay(tz, now)).start} AND e."occurredAt" <= ${now}
      AND jsonb_typeof(e.payload->'ctxTokens'->'goals') = 'number'`;
  if (typeof today?.mean === 'number') means.push(today.mean);
  if (typeof today?.max === 'number') maxes.push(today.max);
  return { days: means.length, mean: means.length ? means.reduce((a, b) => a + b, 0) / means.length : null, max: maxes.length ? Math.max(...maxes) : null };
}
