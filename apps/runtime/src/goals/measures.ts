/**
 * What P3 measured (part 4): the numbers behind the P3 report (report/p3.ts)
 * and the promotion cards (governance/promotion.ts), read from the database as
 * it stands. One set of counts for both, so a card never says a number the
 * report would not.
 *
 * Numbers only. Nothing here reads a goal's title, a check's text or a step's
 * title, and nothing returns an id: counts, days and durations.
 */
import { GOAL_SIGNED_ACTIONS, REVIEW_DOWN_MS, localDay, localDayBounds, previousDay } from '@flint/policy';
import type { Db } from '../db.js';

export const DAY = 86_400_000;
/** The chat suggestions (part 5 files them): a goal, or a commitment, from Will's quoted words. */
export const CHAT_SUGGESTION_ACTIONS = ['goal.propose', 'world.commitment.from_chat'] as const;

/** When Flint first reviewed a goal: the trial week, and every lateness window, starts here. */
export async function firstReviewAt(db: Db): Promise<Date | undefined> {
  return (await db.goalReview.findFirst({ orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { createdAt: true } }))?.createdAt;
}

export interface ReviewCounts {
  /** Reviews of every kind. */
  reviews: number;
  scheduled: number;
  /** Scheduled reviews that ran more than 24 hours after they were due. */
  late: number;
  /** Reviews the local model answered. */
  answered: number;
  /** Changes those answers suggested and that still fit the plan. */
  suggested: number;
  /** Reviews made in the trial week (they file no card). */
  shadow: number;
}

/**
 * The reviews made after `since` and up to `until`. A scheduled review is late
 * when it ran more than 24 hours after its due time, and only a due time from
 * `first` on counts: a goal that was due before Flint ever reviewed (reviews
 * turned on days after the goal started) was not late, it was waiting.
 */
export async function reviewCounts(db: Db, since: Date, until: Date, first: Date): Promise<ReviewCounts> {
  const [r] = await db.$queryRaw<Array<ReviewCounts>>`
    SELECT count(*)::int AS reviews,
           count(*) FILTER (WHERE r.kind = 'scheduled')::int AS scheduled,
           count(*) FILTER (WHERE r.kind = 'scheduled' AND r."dueAt" >= ${first}
                              AND r."createdAt" > r."dueAt" + ${REVIEW_DOWN_MS / 1000}::float8 * interval '1 second')::int AS late,
           count(*) FILTER (WHERE r.planner LIKE 'ollama:%')::int AS answered,
           coalesce(sum((SELECT count(*) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.diff) = 'array' THEN r.diff ELSE '[]'::jsonb END) d
                         WHERE coalesce(d->>'held', '') NOT IN ('stale', 'rejected'))), 0)::int AS suggested,
           count(*) FILTER (WHERE r.shadow)::int AS shadow
    FROM "GoalReview" r WHERE r."createdAt" > ${since} AND r."createdAt" <= ${until}`;
  return r ?? { reviews: 0, scheduled: 0, late: 0, answered: 0, suggested: 0, shadow: 0 };
}

/** Active goals whose review is more than 24 hours past due right now. */
export async function overdueNow(db: Db, now: Date): Promise<number> {
  return db.goal.count({ where: { status: 'active', nextReviewAt: { lt: new Date(now.getTime() - REVIEW_DOWN_MS) } } });
}

/**
 * Of the `days` whole local days before today, the ones goal reviews were not
 * on for: a health check that day found them off (Settings > Health's Goal
 * Reviews is `disabled` while FLINT_PLANNER is off), or none found them on and
 * no review ran (the runtime was down). The health job looks every 5 minutes,
 * so a day counts only if reviews were on every time it looked.
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
           count(*) FILTER (WHERE status IN ('ok', 'degraded', 'down'))::int AS "on",
           count(*) FILTER (WHERE status = 'disabled')::int AS "off"
    FROM "HealthCheck" WHERE component = 'goals' AND at >= ${since} GROUP BY 1`;
  const health = new Map(checked.map((c) => [c.day, c]));
  const reviewed = new Set<string>();
  for (const r of await db.goalReview.findMany({ where: { createdAt: { gte: since } }, select: { createdAt: true } })) reviewed.add(localDay(tz, r.createdAt));
  const ran = (d: string) => !health.get(d)?.off && ((health.get(d)?.on ?? 0) > 0 || reviewed.has(d));
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
 * goal's own card, or a plan change), and a review's minor changes went on one
 * card. `versions` counts plans that are or were active; `splitMinor` reviews
 * whose minor changes are on more than one card.
 */
export async function planChanges(db: Db): Promise<{ versions: number; withoutCard: number; reviewsWithCards: number; splitMinor: number }> {
  const [p] = await db.$queryRaw<Array<{ versions: number; withoutCard: number }>>`
    SELECT count(*)::int AS versions,
           count(*) FILTER (WHERE NOT EXISTS (
             SELECT 1 FROM "Proposal" c WHERE c."approvalId" = pl."approvalId" AND c.action IN ('goal.activate', 'plan.change') AND c.status IN ('executing', 'executed')
           ))::int AS "withoutCard"
    FROM "Plan" pl WHERE pl.status IN ('active', 'superseded')`;
  const [r] = await db.$queryRaw<Array<{ reviewsWithCards: number; splitMinor: number }>>`
    SELECT count(*) FILTER (WHERE cards > 0)::int AS "reviewsWithCards", count(*) FILTER (WHERE minor > 1)::int AS "splitMinor"
    FROM (
      SELECT count(DISTINCT d->>'card') FILTER (WHERE d->>'card' IS NOT NULL) AS cards,
             count(DISTINCT d->>'card') FILTER (WHERE d->>'card' IS NOT NULL AND d->>'class' = 'minor') AS minor
      FROM "GoalReview" r, jsonb_array_elements(CASE WHEN jsonb_typeof(r.diff) = 'array' THEN r.diff ELSE '[]'::jsonb END) d
      GROUP BY r.id
    ) per`;
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
 */
export async function chatSuggestions(
  db: Db, o: { since?: Date; actions?: readonly string[] } = {},
): Promise<{ filed: number; withoutQuote: number; cleared: number; executed: number; rejected: number; expired: number }> {
  const since = o.since ?? null;
  const [r] = await db.$queryRaw<Array<{ filed: number; withoutQuote: number; cleared: number; executed: number; rejected: number; expired: number }>>`
    SELECT count(*)::int AS filed,
           count(*) FILTER (WHERE c.args IS NOT NULL AND NOT coalesce(
             jsonb_typeof(c.args->'quote') = 'string' AND char_length(c.args->>'quote') BETWEEN 12 AND 300
             AND c."argsProvenance"->'quote'->>'source' = 'will' AND c."argsProvenance"->'quote'->'tainted' = 'false'::jsonb, false))::int AS "withoutQuote",
           count(*) FILTER (WHERE c.args IS NULL)::int AS cleared,
           count(*) FILTER (WHERE c.status = 'executed')::int AS executed,
           count(*) FILTER (WHERE c.status = 'rejected')::int AS rejected,
           count(*) FILTER (WHERE c.status = 'expired')::int AS expired
    FROM "Proposal" c WHERE c.action = ANY (${[...(o.actions ?? CHAT_SUGGESTION_ACTIONS)]}::text[]) AND (${since}::timestamptz IS NULL OR c."createdAt" > ${since}::timestamptz)`;
  return r ?? { filed: 0, withoutQuote: 0, cleared: 0, executed: 0, rejected: 0, expired: 0 };
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
