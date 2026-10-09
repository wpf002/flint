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
  GoalActivateArgs,
  type Criterion,
  type GoalRow,
  type GoalSignedAction,
  type GoalTab,
  type GoalView,
  type GoalsPage,
  type Link,
} from '@flint/policy';
import type { Db, Tx } from '../db.js';
import { checkedItems, evaluate, itemFacts, type ItemFacts, type StepFacts } from './criteria.js';
import { labelOf } from './items.js';
import { stepState } from './ops.js';

/** Reviews are part 3's: until then they are off, and so is lateness. */
const REVIEWS = 'off' as const;
/** The finished tab's length. */
const FINISHED = 50;

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

/** Cards waiting for Will, by the goal they are for (its id is in their args). */
async function waitingCards(db: Db | Tx, now: Date): Promise<Map<string, Array<{ id: string; action: GoalSignedAction; args: unknown }>>> {
  const rows = await db.proposal.findMany({
    where: { status: 'pending', action: { in: [...GOAL_SIGNED_ACTIONS] }, expiresAt: { gt: now } },
    orderBy: { createdAt: 'asc' },
    take: 500,
    select: { id: true, action: true, args: true },
  });
  const by = new Map<string, Array<{ id: string; action: GoalSignedAction; args: unknown }>>();
  for (const r of rows) {
    const goalId = (r.args as { goalId?: unknown } | null)?.goalId;
    if (typeof goalId !== 'string') continue;
    by.set(goalId, [...(by.get(goalId) ?? []), { id: r.id, action: r.action as GoalSignedAction, args: r.args }]);
  }
  return by;
}

/** The active plans' steps, by goal. */
async function activeSteps(db: Db | Tx, goalIds: readonly string[]): Promise<Map<string, { version: number; steps: StepFacts[] }>> {
  if (!goalIds.length) return new Map();
  const plans = await db.plan.findMany({ where: { goalId: { in: [...goalIds] }, status: 'active' }, select: { goalId: true, version: true, steps: { select: { key: true, status: true } } } });
  return new Map(plans.map((p) => [p.goalId, { version: p.version, steps: p.steps }]));
}

const criteriaOf = (g: GoalRecord) => (Array.isArray(g.successCriteria) ? (g.successCriteria as Criterion[]) : []);
const marksOf = (g: GoalRecord) => (g.criteriaMet && typeof g.criteriaMet === 'object' && !Array.isArray(g.criteriaMet) ? (g.criteriaMet as Record<string, unknown>) : {});
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
  // A new goal Will filed and has not signed yet: its card's own words, as it will start.
  const known = new Set((await db.goal.findMany({ where: { id: { in: [...cards.keys()] } }, select: { id: true } })).map((g) => g.id));
  const waiting = tab !== 'active' ? [] : [...cards.entries()].flatMap(([goalId, list]) => {
    if (known.has(goalId)) return [];
    return list.flatMap((c) => {
      if (c.action !== 'goal.activate') return [];
      const a = GoalActivateArgs.safeParse(c.args);
      return a.success ? [{ proposalId: c.id, goalId, title: a.data.title, checks: a.data.successCriteria.length }] : [];
    });
  }).slice(0, 50);
  return { tab, goals: rows, waiting, reviews: REVIEWS };
}

/** One goal, open; null when there is none. */
export async function goalView(db: Db | Tx, id: string, now = new Date()): Promise<GoalView | null> {
  const g = await db.goal.findUnique({ where: { id } });
  if (!g) return null;
  const [linkRows, planRow, cards] = await Promise.all([
    db.goalEntity.findMany({ where: { goalId: id }, orderBy: { entityId: 'asc' }, include: { entity: { select: { id: true, kind: true, key: true, name: true, status: true, taintedPaths: true } } } }),
    db.plan.findFirst({ where: { goalId: id, status: 'active' }, select: { version: true, steps: { orderBy: [{ ordinal: 'asc' }, { key: 'asc' }] } } }),
    waitingCards(db, now),
  ]);
  const criteria = criteriaOf(g);
  const items = await itemFacts(db, checkedItems(criteria));
  const steps = planRow ? planRow.steps.map(stepState) : null;
  const e = evaluate(criteria, marksOf(g), steps, items);
  const links = linkRows.map((l) => ({
    entityId: l.entityId, role: l.role as Link['role'], watchPaths: [...l.watchPaths].sort(),
    label: labelOf(l.entity), kind: l.entity.kind, status: l.entity.status as GoalView['links'][number]['status'],
  }));
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
    waiting: (cards.get(id) ?? []).map((c) => ({ id: c.id, action: c.action })),
    reviews: REVIEWS,
    late: false,
  };
}
