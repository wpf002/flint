/**
 * Goals as the console's panel shows them (P3 part 2): each goal's definition,
 * its checks evaluated now (criteria.ts), its links by label (items.ts), its
 * active plan, and the ids of its cards waiting for Will. Reviews don't exist
 * until part 3, so a view says they are off and nothing is ever late: a goal's
 * next review time is set when it starts, and showing it as overdue would be
 * wrong. Goal text is PERSONAL: these answers go only to the console (the
 * `proposals` scope), never to a model or a log.
 */
import {
  GOAL_SIGNED_ACTIONS,
  GoalTitle,
  type GoalRow,
  type GoalSignedAction,
  type GoalTab,
  type GoalView,
  type GoalsPage,
  type Link,
} from '@flint/policy';
import type { Db, Tx } from '../db.js';
import { checkedItems, criteriaOf, evaluate, itemFacts, marksOf, type ItemFacts, type StepFacts } from './criteria.js';
import { conditionsOf, labelFor } from './items.js';
import { stepState } from './ops.js';

/** Reviews are part 3's: until then they are off, and so is lateness. */
const REVIEWS = 'off' as const;
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
  activatedAt: Date | null;
  updatedAt: Date;
}

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

function row(g: GoalRecord, steps: StepFacts[] | null, items: ReadonlyMap<string, ItemFacts>, waiting: number): GoalRow {
  const e = evaluate(criteriaOf(g), marksOf(g), steps, items);
  return {
    id: g.id, title: g.title, status: g.status as GoalRow['status'], origin: g.origin as GoalRow['origin'],
    checks: { met: e.met, total: e.total, unknown: e.unknown },
    horizonAt: iso(g.horizonAt), reviewCadence: g.reviewCadence as GoalRow['reviewCadence'],
    endedAt: FINAL.has(g.status) ? g.updatedAt.toISOString() : null,
    waiting, late: false, tainted: g.tainted,
  };
}

/** One tab of the panel: active (with paused goals, and new goals whose card waits), suggested, or finished. */
export async function goalsPage(db: Db | Tx, tab: GoalTab, now = new Date()): Promise<GoalsPage> {
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
  const rows = goals.map((g) => row(g, plans.get(g.id)?.steps ?? null, items, cards.get(g.id)?.length ?? 0));
  // A new goal Will filed and has not signed yet: its card's own title, as it will start.
  let waiting: GoalsPage['waiting'] = [];
  if (tab === 'active') {
    const known = new Set((await db.goal.findMany({ where: { id: { in: [...cards.keys()] } }, select: { id: true } })).map((g) => g.id));
    const fresh = [...cards.entries()].flatMap(([goalId, list]) => (known.has(goalId) ? [] : list.filter((c) => c.action === 'goal.activate').map((c) => c.id)));
    waiting = await waitingGoals(db, fresh.slice(0, WAITING));
  }
  return { tab, goals: rows, waiting, reviews: REVIEWS };
}

/** One goal, open; null when there is none. */
export async function goalView(db: Db | Tx, id: string, tz: string, now = new Date()): Promise<GoalView | null> {
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
    waiting: (cards.get(id) ?? []).slice(0, WAITING),
    reviews: REVIEWS,
    late: false,
  };
}
