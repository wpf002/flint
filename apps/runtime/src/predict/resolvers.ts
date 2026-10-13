/**
 * How a prediction is settled without Will (P4 part 2): one resolver per kind
 * of claim, each a rule over rows Flint already holds. No model, no network,
 * no guess: a spec no resolver knows is counted and left alone, and facts that
 * cannot be told (an item that was forgotten, a number that never arrived) give
 * no resolution at all.
 *
 *   spec (Prediction.resolverSpec)                      settled as
 *   {seriesKey, at, end, op: 'range'}                   the series' value for the step that starts at `at` (auto_metric)
 *   {seriesKey, at, end, op: 'above' | 'below', value}  whether that value is above or below (auto_metric)
 *   {entityId, check: 'healthy', at: 'resolveBy'}       triage's: the item's state at the resolve time (auto_world)
 *   {goalId, rule: 'goal_done_by'}                      a goal review's forecast, at its date (auto_world)
 *   resolver `conditional` (no spec)                    by its recommendation, then as its own claim (auto_world)
 *
 * Three rules hold for every one of them:
 *  - The time on a resolution (`eventAt`) is the time the claim is about: the
 *    end of the series' step, or the prediction's resolve time. Never the time
 *    the sweep ran, so a late sweep reads nothing the claim was not about, and
 *    the database's leak guard stays the last word.
 *  - The world is read as it stood THEN: an item's state comes from the version
 *    that was valid at the resolve time (EntityVersion.validFrom), never from
 *    when a version was recorded or from the row as it is now; and only once
 *    the item has been seen again after that time, so a source that stopped
 *    watching does not settle anything with stale news.
 *  - A resolver never resolves as Will. It writes `auto_metric` or
 *    `auto_world`, and the database refuses either on a prediction only Will
 *    resolves.
 *
 * Whose a prediction is (ruleOwner): the sweep's when its rule is one of the
 * shapes above, or it hangs on a piece of triage's advice; nobody's when it has
 * no rule at all (it can only run out); and another module's when it carries a
 * rule this file does not know. Another module's prediction is left alone: not
 * settled, not counted, never run out from here, so a later owner that settles
 * late finds its row as it left it.
 *
 * Triage's first rows say "healthy when it is next observed after the resolve
 * time", and are settled by that sentence, not by the one triage writes now
 * (healthy()).
 *
 * A goal's forecast has two owners, one for each way it ends. When Will marks
 * the goal done or abandons it, the goal's own card settles every forecast of
 * it, as Will, in that transaction (goals/apply.ts). When a forecast's date
 * comes and the goal is still not finished, this file settles that forecast:
 * false, as its own words say ("not done by then"). A goal that is finished is
 * never settled here.
 */
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { SeriesKey, addLocalDays, localDay, localDayBounds } from '@flint/policy';
import type { Tx } from '../db.js';

const Id = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);
const Instant = z.string().datetime({ offset: true });

/**
 * A forecast's rule carries its step's own end (`end`), written when the forecast was made: the forecaster always
 * writes it (predict/run.ts). The step is then the one the forecast was about whatever Flint's zone is when it is
 * settled; without it the end is worked out in the zone of the day, and a zone changed in between would move it.
 */
export const MetricRangeSpec = z.object({ seriesKey: SeriesKey, at: Instant, end: Instant.optional(), op: z.literal('range') }).strict();
export const MetricThresholdSpec = z.object({ seriesKey: SeriesKey, at: Instant, end: Instant.optional(), op: z.enum(['above', 'below']), value: z.number().finite() }).strict();
export const HealthySpec = z.object({ entityId: Id, check: z.literal('healthy'), at: z.literal('resolveBy') }).strict();
export const GoalDoneBySpec = z.object({ goalId: Id, rule: z.literal('goal_done_by') }).strict();
/** Every shape a resolver knows. Anything else is left alone and counted, never guessed at. */
export const ResolverSpec = z.union([MetricRangeSpec, MetricThresholdSpec, HealthySpec, GoalDoneBySpec]);
export type ResolverSpec = z.infer<typeof ResolverSpec>;

/** The recommendation whose accepted prediction is settled as "the service is healthy at the resolve time" (triage's). */
export const LOOK_AT_SERVICE = 'look_at_service';
/** The type of the advice the sweep decides and lapses (triage's). Advice of any other type is its own module's. */
export const ESCALATION_ACTION = 'escalation_action';
/**
 * What triage's rows said of themselves before this part settled any: the state "when it is next observed after the
 * resolve time". A row that states it is settled by it. Triage now writes the sentence in surface/record.ts.
 */
export const NEXT_OBSERVED_CRITERIA = 'The service reports healthy (running, or its health check ok) when it is next observed after the resolve time.';

/** What the sweep reads of a prediction. */
export interface DuePrediction {
  id: string;
  kind: string;
  status: string;
  resolver: string;
  resolverSpec: unknown;
  resolveBy: Date;
  createdAt: Date;
  seriesKey: string | null;
  goalId: string | null;
  subjectEntityId: string | null;
  conditionRecommendationId: string | null;
  /** The type of the advice a conditional prediction hangs on. Null: it hangs on none. */
  recType: string | null;
  /** Its words were forgotten (a forget blanks the claim and takes the rule away): nothing can be told of it any more. */
  forgotten: boolean;
  /** It states triage's first rule (NEXT_OBSERVED_CRITERIA). */
  nextObserved: boolean;
}

/** The columns of a DuePrediction, read from "Prediction" p: the sweep's two reads and the tests share them. Never the claim's words. */
export const DUE_COLUMNS = Prisma.sql`p.id, p.kind, p.status, p.resolver, p."resolverSpec", p."resolveBy", p."createdAt", p."seriesKey", p."goalId", p."subjectEntityId", p."conditionRecommendationId",
  (SELECT rc.type FROM "Recommendation" rc WHERE rc.id = p."conditionRecommendationId") AS "recType",
  (p.claim = '[forgotten]') AS forgotten, (p."resolutionCriteria" = ${NEXT_OBSERVED_CRITERIA}) AS "nextObserved"`;

/**
 * Whose a prediction that resolves by itself is.
 *  - `sweep`: its rule is one this file knows, or it hangs on triage's advice. Settled here, and run out here.
 *  - `nobody`: it has no rule at all, so nothing can ever settle it. It runs out here, and is counted.
 *  - `other`: it carries a rule this file does not know, or hangs on another module's advice. Left alone.
 */
export type RuleOwner = 'sweep' | 'nobody' | 'other';
export function ruleOwner(p: Pick<DuePrediction, 'resolver' | 'resolverSpec' | 'recType'>): RuleOwner {
  if (p.resolver === 'conditional') return p.recType === null || p.recType === undefined ? 'nobody' : p.recType === ESCALATION_ACTION ? 'sweep' : 'other';
  if (p.resolver !== 'auto_metric' && p.resolver !== 'auto_world') return 'other';
  if (p.resolverSpec === null || p.resolverSpec === undefined) return 'nobody';
  return ResolverSpec.safeParse(p.resolverSpec).success ? 'sweep' : 'other';
}

/** Why nothing was written this time. Each is a reason to look again later, or to let the prediction run out. */
export type WaitReason =
  | 'step_not_over' // the series' step has not ended
  | 'no_point' // the number for that step is not there (yet)
  | 'not_seen_since' // the item has not been observed after the resolve time
  | 'unknowable' // the item or series was forgotten, or its state says neither way
  | 'busy' // the goal is being changed right now
  | 'finished' // the goal is done or abandoned: its own card settles its forecasts
  | 'undecided' // the recommendation is not decided yet
  | 'superseded'; // its condition was never met, and it was revised first: it stays superseded

export type Verdict =
  | { verdict: 'resolve'; resolvedBy: 'auto_metric' | 'auto_world'; outcome: boolean | null; outcomeValue: number | null; eventAt: Date; evidence: Record<string, string> }
  | { verdict: 'condition_unmet' }
  | { verdict: 'wait'; why: WaitReason }
  /** The sweep's, and it cannot be checked: no rule, or a rule that does not fit its own row. It runs out. */
  | { verdict: 'unknown' }
  /** Another module's: left alone. */
  | { verdict: 'other' };

const wait = (why: WaitReason): Verdict => ({ verdict: 'wait', why });
const UNKNOWN: Verdict = { verdict: 'unknown' };
const OTHER: Verdict = { verdict: 'other' };

/** When a series' step that starts at `at` ends: the next local midnight for a daily series, seven local days on for a weekly one. */
export function stepEnd(tz: string, at: Date, freq: string): Date | undefined {
  if (freq !== 'D' && freq !== 'W') return undefined;
  const day = localDay(tz, at);
  return localDayBounds(tz, freq === 'D' ? day : addLocalDays(day, 6)).end;
}

const HOUR_MS = 3_600_000;
/** Is `end` the end of a step of this length that starts at `at`? A day or a week, give or take the hour a clock change moves a local midnight. */
export function fitsStep(at: Date, end: Date, freq: string): boolean {
  const span = end.getTime() - at.getTime();
  const whole = freq === 'D' ? 24 * HOUR_MS : freq === 'W' ? 7 * 24 * HOUR_MS : NaN;
  return Math.abs(span - whole) <= HOUR_MS;
}

/** A forecast's range or question: the series' own number for that step, once the step is over and the number is there. */
async function metric(tx: Tx, p: DuePrediction, spec: z.infer<typeof MetricRangeSpec> | z.infer<typeof MetricThresholdSpec>, tz: string, now: Date): Promise<Verdict> {
  if (p.resolver !== 'auto_metric') return UNKNOWN;
  // A range is an interval prediction's; a threshold a yes/no one's. A forecast's row names its series: the spec must name the same one.
  if ((spec.op === 'range') !== (p.kind === 'interval')) return UNKNOWN;
  if (p.seriesKey !== null && p.seriesKey !== spec.seriesKey) return UNKNOWN;
  const series = await tx.metricSeries.findUnique({ where: { key: spec.seriesKey }, select: { freq: true, description: true } });
  if (!series) return UNKNOWN;
  const at = new Date(spec.at);
  // The step's end is the rule's own when it carries one, and this zone's otherwise. One that is not a day or a week
  // after its start (as the series' step is) is no end of that step: the rule does not fit its row.
  const end = spec.end ? new Date(spec.end) : stepEnd(tz, at, series.freq);
  if (spec.end && !fitsStep(at, end!, series.freq)) return UNKNOWN;
  // A claim about a step that ended before the claim was made is no forecast (the database would refuse it as a leak).
  if (!end || end.getTime() < p.createdAt.getTime()) return UNKNOWN;
  if (series.description === '[forgotten]') return wait('unknowable');
  if (end.getTime() > now.getTime()) return wait('step_not_over');
  const point = await tx.metricPoint.findUnique({ where: { seriesKey_at: { seriesKey: spec.seriesKey, at } }, select: { value: true } });
  if (!point) return wait('no_point');
  if (!Number.isFinite(point.value)) return wait('unknowable');
  const evidence = { rule: spec.op === 'range' ? 'metric_range' : 'metric_threshold', seriesKey: spec.seriesKey, at: at.toISOString() };
  if (spec.op === 'range') return { verdict: 'resolve', resolvedBy: 'auto_metric', outcome: null, outcomeValue: point.value, eventAt: end, evidence };
  return { verdict: 'resolve', resolvedBy: 'auto_metric', outcome: spec.op === 'above' ? point.value > spec.value : point.value < spec.value, outcomeValue: null, eventAt: end, evidence };
}

/** Healthy, as an item's state says it: its health check ok, or running where it has no health check. Undefined: the state says neither way. */
export function healthyState(state: unknown): boolean | undefined {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return undefined;
  const s = state as Record<string, unknown>;
  if (typeof s.health === 'string') return s.health === 'ok';
  if (typeof s.running === 'boolean') return s.running;
  return undefined;
}

/**
 * "The item is healthy at the resolve time": its state in the version that was
 * valid then (the latest whose validFrom is at or before it), once the item has
 * been observed after that time. A forgotten item, or a version whose content
 * was blanked, is unknowable.
 *
 * A row that states triage's first rule (p.nextObserved) is about the state
 * "when it is next observed after the resolve time" instead. Flint keeps no
 * list of its looks at an item, only a version each time the state changed, so
 * that state is either the one valid at the resolve time or the next version's:
 * whichever the first look after the resolve time saw. Where the two say the
 * same, the row's own rule is certain and it is settled by it. Where they
 * differ, the rows cannot tell which it was, and the prediction is left to run
 * out: it is never settled by a rule its row does not state.
 */
async function healthy(tx: Tx, p: DuePrediction, entityId: string): Promise<Verdict> {
  const e = await tx.entity.findUnique({ where: { id: entityId }, select: { status: true, lastObservedAt: true } });
  if (!e) return UNKNOWN;
  if (e.status === 'forgotten') return wait('unknowable');
  if (e.lastObservedAt.getTime() <= p.resolveBy.getTime()) return wait('not_seen_since');
  const then = await tx.entityVersion.findFirst({
    where: { entityId, validFrom: { lte: p.resolveBy } },
    orderBy: [{ validFrom: 'desc' }, { version: 'desc' }],
    select: { id: true, changeKind: true, state: true },
  });
  if (!then || then.changeKind === 'forgotten') return wait('unknowable');
  const outcome = healthyState(then.state);
  if (outcome === undefined) return wait('unknowable');
  if (p.nextObserved) {
    const next = await tx.entityVersion.findFirst({
      where: { entityId, validFrom: { gt: p.resolveBy } },
      orderBy: [{ validFrom: 'asc' }, { version: 'asc' }],
      select: { changeKind: true, state: true },
    });
    if (next && (next.changeKind === 'forgotten' || healthyState(next.state) !== outcome)) return wait('unknowable');
  }
  return {
    verdict: 'resolve', resolvedBy: 'auto_world', outcome, outcomeValue: null, eventAt: p.resolveBy,
    evidence: { rule: p.nextObserved ? 'healthy_next_observed' : 'healthy_at', entityId, versionId: then.id },
  };
}

/**
 * A goal review's forecast, at its date: the goal was not finished by then, so
 * it did not come true. The goal is taken FOR UPDATE first (as its cards and
 * reviews take it), so this never crosses the card that finishes it; a goal
 * that is busy waits for the next sweep, and a finished one is its card's.
 */
async function goalDoneBy(tx: Tx, p: DuePrediction, spec: z.infer<typeof GoalDoneBySpec>): Promise<Verdict> {
  if (p.resolver !== 'auto_world' || p.kind !== 'binary' || p.goalId !== spec.goalId) return UNKNOWN;
  if (!(await tx.goal.findUnique({ where: { id: spec.goalId }, select: { id: true } }))) return UNKNOWN;
  const locked = await tx.$queryRaw<Array<{ status: string }>>`SELECT status FROM "Goal" WHERE id = ${spec.goalId} FOR UPDATE SKIP LOCKED`;
  if (!locked[0]) return wait('busy');
  if (locked[0].status === 'done' || locked[0].status === 'abandoned') return wait('finished');
  return { verdict: 'resolve', resolvedBy: 'auto_world', outcome: false, outcomeValue: null, eventAt: p.resolveBy, evidence: { rule: 'goal_done_by', goalId: spec.goalId, goalStatus: locked[0].status } };
}

/**
 * A prediction about what happens if Will takes a recommendation. Declined or
 * lapsed, its condition was never met (the sweep marks it so). Taken, it is
 * settled as its own claim: for triage's "look at the service", whether that
 * service is healthy at the resolve time.
 */
async function conditional(tx: Tx, p: DuePrediction): Promise<Verdict> {
  if (!p.conditionRecommendationId) return UNKNOWN;
  const rec = await tx.recommendation.findUnique({ where: { id: p.conditionRecommendationId }, select: { status: true, templateId: true, predictionId: true } });
  if (!rec || rec.predictionId !== p.id) return UNKNOWN;
  if (rec.status === 'proposed') return wait('undecided');
  if (rec.status === 'rejected' || rec.status === 'expired') return { verdict: 'condition_unmet' };
  if (rec.status !== 'accepted') return UNKNOWN;
  if (rec.templateId !== LOOK_AT_SERVICE || !p.subjectEntityId || p.kind !== 'binary') return UNKNOWN;
  return healthy(tx, p, p.subjectEntityId);
}

async function ownVerdict(tx: Tx, p: DuePrediction, o: { tz: string; now: Date }): Promise<Verdict> {
  if (p.resolver === 'conditional') return conditional(tx, p);
  const parsed = ResolverSpec.safeParse(p.resolverSpec);
  if (!parsed.success) return UNKNOWN;
  const spec = parsed.data;
  if ('seriesKey' in spec) return metric(tx, p, spec, o.tz, o.now);
  if ('entityId' in spec) return p.resolver === 'auto_world' && p.kind === 'binary' ? healthy(tx, p, spec.entityId) : UNKNOWN;
  return goalDoneBy(tx, p, spec);
}

/**
 * What to do with one prediction that is due, read inside the transaction that
 * will write it. Only a prediction with resolver auto_metric, auto_world or
 * conditional is ever given one: Will's own are his to answer. Another
 * module's is `other`. One with nothing left to check it by is `unknown`,
 * unless its words were forgotten: a forget is Will's doing, not a fault, so
 * that one waits as unknowable and runs out quietly.
 */
export async function verdictFor(tx: Tx, p: DuePrediction, o: { tz: string; now: Date }): Promise<Verdict> {
  const owner = ruleOwner(p);
  if (owner === 'other') return OTHER;
  const v = owner === 'nobody' ? UNKNOWN : await ownVerdict(tx, p, o);
  return v.verdict === 'unknown' && p.forgotten ? wait('unknowable') : v;
}

/** How a recommendation was decided, from the escalation that showed it to Will. Undefined: not yet. */
export function decisionOf(
  e: { status: string; ackedAt: Date | null } | null,
  resolveBy: Date,
  now: Date,
): { status: 'accepted' | 'rejected' | 'expired'; decidedAt: Date } | undefined {
  // Dismissed: Will said no to it, whenever he did.
  if (e?.status === 'dismissed') return { status: 'rejected', decidedAt: now };
  // Acknowledged before the resolve time (the escalation itself may have lapsed since), or acted on: he took it up.
  if (e?.ackedAt && e.ackedAt.getTime() <= resolveBy.getTime()) return { status: 'accepted', decidedAt: e.ackedAt };
  if (e?.status === 'acted') return { status: 'accepted', decidedAt: e.ackedAt ?? now };
  // Never shown, never answered, or answered too late: once the resolve time is past, it lapsed.
  if (now.getTime() > resolveBy.getTime()) return { status: 'expired', decidedAt: now };
  return undefined;
}
