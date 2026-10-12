/**
 * Goals as the console's panel shows them (P3 parts 2 and 3): each goal's
 * definition, its checks evaluated now (criteria.ts), its links by label
 * (items.ts), its active plan, the ids of its cards waiting for Will and, once
 * Flint reviews goals, when it is next reviewed, its open onTrack forecast and
 * its latest review.
 *
 * Reviews run only while FLINT_PLANNER is on. Off, a view says so and nothing
 * is ever late: a goal's next review time is set when it starts, and showing
 * it as overdue while nothing reviews goals would be wrong. On, an active
 * goal is late once its review is over an hour past due.
 *
 * A review's suggestions are kept as ids and enums (GoalReview.diff). Here they
 * get their words back for the panel: a step's own title, or a template's for a
 * step Flint would add. Never a model's words: it wrote none.
 *
 * Goal text is PERSONAL: these answers go only to the console (the `proposals`
 * scope), never to a log or an outside service.
 */
import {
  GOAL_SIGNED_ACTIONS,
  GoalTitle,
  PLAN_STAGES,
  REVIEW_LATE_MS,
  likelihoodOf,
  type Criterion,
  type GoalRow,
  type GoalSignedAction,
  type GoalTab,
  type GoalView,
  type GoalsPage,
  type Link,
  type PlanStage,
  type PlanStepState,
  type ReviewChange,
  type ReviewView,
} from '@flint/policy';
import type { Db, Tx } from '../db.js';
import { checkedItems, criteriaOf, evaluate, itemFacts, marksOf, type ItemFacts, type StepFacts } from './criteria.js';
import { conditionsOf, labelFor } from './items.js';
import { stepState } from './ops.js';
import { Diff, stepTitle, type DiffItem } from './steps.js';

/** What a view needs to know about the runtime: whether Flint reviews goals (FLINT_PLANNER). */
export interface ViewOptions {
  reviews: boolean;
}
const NO_REVIEWS: ViewOptions = { reviews: false };
/** A review whose plan stage has not reported for this long never will (its job is gone): it is shown as skipped, not as still running. */
const PLAN_STAGE_GIVEN_UP_MS = 30 * 60_000;
/** The finished tab's length. */
const FINISHED = 50;
/** How many waiting cards a view names (GoalView.waiting and GoalsPage.waiting, @flint/policy). */
const WAITING = 50;

const iso = (d: Date | null) => d?.toISOString() ?? null;

interface GoalRecord {
  id: string;
  title: string;
  description: string;
  status: string;
  owner: string;
  origin: string;
  sensitivity: string;
  tainted: boolean;
  nexusProjectId: string | null;
  successCriteria: unknown;
  criteriaMet: unknown;
  horizonAt: Date | null;
  reviewCadence: string;
  nextReviewAt: Date | null;
  activatedAt: Date | null;
  updatedAt: Date;
}

/** Over an hour past its review time, while Flint reviews goals. Never a paused or finished goal. */
const isLate = (g: GoalRecord, now: Date, o: ViewOptions): boolean =>
  o.reviews && g.status === 'active' && !!g.nextReviewAt && g.nextReviewAt.getTime() < now.getTime() - REVIEW_LATE_MS;

interface WaitingCard {
  id: string;
  action: GoalSignedAction;
}

/**
 * Cards waiting for Will, by the goal they are for (its id is in their args), oldest
 * first. Only each card's id, action and goal id are read: never its whole args.
 */
async function waitingCards(db: Db | Tx, now: Date, goalId?: string): Promise<Map<string, WaitingCard[]>> {
  const rows = await db.$queryRaw<Array<{ id: string; action: string; goalId: string | null }>>`
    SELECT id, action, args->>'goalId' AS "goalId" FROM "Proposal"
    WHERE status = 'pending' AND action = ANY (${[...GOAL_SIGNED_ACTIONS]}::text[]) AND "expiresAt" > ${now}
      AND (${goalId ?? null}::text IS NULL OR args->>'goalId' = ${goalId ?? null}::text)
    ORDER BY "createdAt" ASC, id ASC LIMIT 500`;
  const by = new Map<string, WaitingCard[]>();
  for (const r of rows) {
    if (typeof r.goalId !== 'string') continue;
    by.set(r.goalId, [...(by.get(r.goalId) ?? []), { id: r.id, action: r.action as GoalSignedAction }]);
  }
  return by;
}

/** New goals whose card waits: each card's title and how many checks it has, and nothing else of its args. */
async function waitingGoals(db: Db | Tx, cardIds: readonly string[]): Promise<Array<{ proposalId: string; goalId: string; title: string; checks: number }>> {
  if (!cardIds.length) return [];
  const rows = await db.$queryRaw<Array<{ id: string; goalId: string; title: string | null; checks: number | null }>>`
    SELECT id, args->>'goalId' AS "goalId", args->>'title' AS title,
           CASE WHEN jsonb_typeof(args->'successCriteria') = 'array' THEN jsonb_array_length(args->'successCriteria') END AS checks
    FROM "Proposal" WHERE id = ANY (${[...cardIds]}::text[]) ORDER BY "createdAt" ASC, id ASC`;
  return rows.flatMap((r) => (GoalTitle.safeParse(r.title).success && typeof r.checks === 'number' ? [{ proposalId: r.id, goalId: r.goalId, title: r.title!, checks: r.checks }] : []));
}

/** The active plans' steps, by goal. */
async function activeSteps(db: Db | Tx, goalIds: readonly string[]): Promise<Map<string, { version: number; steps: StepFacts[] }>> {
  if (!goalIds.length) return new Map();
  const plans = await db.plan.findMany({ where: { goalId: { in: [...goalIds] }, status: 'active' }, select: { goalId: true, version: true, steps: { select: { key: true, status: true } } } });
  return new Map(plans.map((p) => [p.goalId, { version: p.version, steps: p.steps }]));
}

const FINAL = new Set(['done', 'abandoned', 'rejected']);

function row(g: GoalRecord, steps: StepFacts[] | null, items: ReadonlyMap<string, ItemFacts>, waiting: number, late: boolean): GoalRow {
  const e = evaluate(criteriaOf(g), marksOf(g), steps, items);
  return {
    id: g.id, title: g.title, status: g.status as GoalRow['status'], origin: g.origin as GoalRow['origin'],
    checks: { met: e.met, total: e.total, unknown: e.unknown },
    horizonAt: iso(g.horizonAt), reviewCadence: g.reviewCadence as GoalRow['reviewCadence'],
    endedAt: FINAL.has(g.status) ? g.updatedAt.toISOString() : null,
    waiting, late, tainted: g.tainted,
  };
}

/** How a review's plan stage ended, from what the review row says. */
function stageOf(planner: string | null, createdAt: Date, now: Date): PlanStage {
  if (planner === null) return now.getTime() - createdAt.getTime() < PLAN_STAGE_GIVEN_UP_MS ? 'pending' : 'skipped';
  if (planner.startsWith('ollama:')) return 'ok';
  const why = planner.slice('none:'.length);
  return (PLAN_STAGES as readonly string[]).includes(why) && why !== 'pending' && why !== 'ok' ? (why as PlanStage) : 'skipped';
}

/**
 * A review's suggestions in the panel's terms: each with the step's title. One
 * that no longer fits the plan, or that Will already turned down, is left out.
 */
async function changesOf(db: Db | Tx, diff: readonly DiffItem[], steps: readonly PlanStepState[] | null, criteria: readonly Criterion[], tz: string, now: Date): Promise<ReviewChange[]> {
  const shown = diff.filter((d) => d.held !== 'stale' && d.held !== 'rejected');
  const ids = shown.flatMap((d) => (d.change.op === 'add' && d.change.entityId ? [d.change.entityId] : []));
  const entities = ids.length
    ? await db.entity.findMany({ where: { id: { in: ids }, status: { not: 'forgotten' } }, select: { id: true, kind: true, key: true, name: true, taintedPaths: true, firstSeenAt: true } })
    : [];
  const labels = new Map(entities.map((e) => [e.id, labelOf(e, tz, now)]));
  const words = new Map(criteria.map((c) => [c.id, c.text]));
  const titles = new Map((steps ?? []).map((s) => [s.key, s.title]));
  return shown.flatMap((d): ReviewChange[] => {
    const c = d.change;
    const material = d.class === 'material';
    if (c.op === 'add') {
      const title = stepTitle(c.template, { label: c.entityId ? labels.get(c.entityId) : undefined, criterion: c.criterion ? words.get(c.criterion) : undefined });
      return title ? [{ kind: 'add', title, dueAt: c.dueAt, status: null, after: null, material }] : [];
    }
    const title = titles.get(c.key);
    if (!title) return [];
    if (c.op === 'due') return [{ kind: 'due', title, dueAt: c.dueAt, status: null, after: null, material }];
    if (c.op === 'status') return [{ kind: 'status', title, dueAt: null, status: c.status, after: null, material }];
    if (c.op === 'skip') return [{ kind: 'skip', title, dueAt: null, status: null, after: null, material }];
    return [{ kind: 'move', title, dueAt: null, status: null, after: c.after ? (titles.get(c.after) ?? null) : null, material }];
  });
}

/** The goal's latest review, or null. */
async function latestReview(db: Db | Tx, goalId: string, steps: readonly PlanStepState[] | null, criteria: readonly Criterion[], tz: string, now: Date): Promise<ReviewView | null> {
  const r = await db.goalReview.findFirst({ where: { goalId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
  if (!r) return null;
  const diff = Diff.safeParse(r.diff ?? []);
  const items = diff.success ? diff.data : [];
  return {
    at: r.createdAt.toISOString(), kind: r.kind as ReviewView['kind'], summary: r.summary, shadow: r.shadow,
    planner: stageOf(r.planner, r.createdAt, now),
    changes: await changesOf(db, items, steps, criteria, tz, now),
  };
}

/** One tab of the panel: active (with paused goals, and new goals whose card waits), suggested, or finished. */
export async function goalsPage(db: Db | Tx, tab: GoalTab, now = new Date(), o: ViewOptions = NO_REVIEWS): Promise<GoalsPage> {
  const statuses = tab === 'active' ? ['active', 'paused'] : tab === 'suggested' ? ['proposed'] : ['done', 'abandoned', 'rejected'];
  const goals = await db.goal.findMany({
    where: { status: { in: statuses } },
    orderBy: tab === 'finished' ? [{ updatedAt: 'desc' }, { id: 'asc' }] : [{ createdAt: 'asc' }, { id: 'asc' }],
    take: tab === 'finished' ? FINISHED : 200,
  });
  const [plans, cards, items] = await Promise.all([
    activeSteps(db, goals.map((g) => g.id)),
    waitingCards(db, now),
    itemFacts(db, goals.flatMap((g) => checkedItems(criteriaOf(g)))),
  ]);
  const rows = goals.map((g) => row(g, plans.get(g.id)?.steps ?? null, items, cards.get(g.id)?.length ?? 0, isLate(g, now, o)));
  // A new goal Will filed and has not signed yet: its card's own title, as it will start.
  let waiting: GoalsPage['waiting'] = [];
  if (tab === 'active') {
    const known = new Set((await db.goal.findMany({ where: { id: { in: [...cards.keys()] } }, select: { id: true } })).map((g) => g.id));
    const fresh = [...cards.entries()].flatMap(([goalId, list]) => (known.has(goalId) ? [] : list.filter((c) => c.action === 'goal.activate').map((c) => c.id)));
    waiting = await waitingGoals(db, fresh.slice(0, WAITING));
  }
  return { tab, goals: rows, waiting, reviews: o.reviews ? 'on' : 'off' };
}

/** One goal, open; null when there is none. */
export async function goalView(db: Db | Tx, id: string, tz: string, now = new Date(), o: ViewOptions = NO_REVIEWS): Promise<GoalView | null> {
  const g = await db.goal.findUnique({ where: { id } });
  if (!g) return null;
  const [linkRows, planRow, cards] = await Promise.all([
    db.goalEntity.findMany({ where: { goalId: id }, orderBy: { entityId: 'asc' }, include: { entity: { select: { id: true, kind: true, key: true, name: true, status: true, taintedPaths: true, firstSeenAt: true } } } }),
    db.plan.findFirst({ where: { goalId: id, status: 'active' }, select: { version: true, steps: { orderBy: [{ ordinal: 'asc' }, { key: 'asc' }] } } }),
    waitingCards(db, now, id),
  ]);
  const criteria = criteriaOf(g);
  const items = await itemFacts(db, checkedItems(criteria));
  const steps = planRow ? planRow.steps.map(stepState) : null;
  const e = evaluate(criteria, marksOf(g), steps, items);
  const waiting = cards.get(id) ?? [];
  const live = g.status === 'active' || g.status === 'paused';
  // Its open forecast, from the ledger's own row: the number a review recorded, never a model's words.
  const forecast = live ? await db.prediction.findFirst({ where: { goalId: id, domain: 'goals', status: 'open' }, orderBy: { createdAt: 'desc' }, select: { probability: true, resolveBy: true } }) : null;
  const review = await latestReview(db, id, steps, criteria, tz, now);
  const links = await Promise.all(linkRows.map(async (l) => ({
    entityId: l.entityId, role: l.role as Link['role'], watchPaths: [...l.watchPaths].sort(),
    label: await labelFor(db, l.entity, tz, now), kind: l.entity.kind, status: l.entity.status as GoalView['links'][number]['status'],
    conditions: conditionsOf(l.entity.kind),
  })));
  return {
    id: g.id, title: g.title, description: g.description, status: g.status as GoalView['status'],
    owner: g.owner as GoalView['owner'], origin: g.origin as GoalView['origin'], sensitivity: g.sensitivity as GoalView['sensitivity'],
    tainted: g.tainted, nexusProjectId: g.nexusProjectId,
    successCriteria: criteria, criteria: e.criteria, checks: { met: e.met, total: e.total, unknown: e.unknown },
    horizonAt: iso(g.horizonAt), reviewCadence: g.reviewCadence as GoalView['reviewCadence'],
    activatedAt: iso(g.activatedAt), endedAt: FINAL.has(g.status) ? g.updatedAt.toISOString() : null,
    links,
    plan: planRow && steps
      ? { version: planRow.version, steps: steps.map((s) => ({ key: s.key, ordinal: s.ordinal, title: s.title, kind: s.kind, tier: s.tier, status: s.status, dueAt: s.dueAt, dependsOn: s.dependsOn })) }
      : null,
    // The oldest of its waiting cards: a goal with more still opens.
    waiting: waiting.slice(0, WAITING),
    reviews: o.reviews ? 'on' : 'off',
    late: isLate(g, now, o),
    nextReviewAt: g.status === 'active' ? iso(g.nextReviewAt) : null,
    onTrack: forecast && forecast.probability !== null ? { likelihood: likelihoodOf(forecast.probability), percent: Math.round(forecast.probability * 100), by: forecast.resolveBy.toISOString() } : null,
    review,
  };
}
