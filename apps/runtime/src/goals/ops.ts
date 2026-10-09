/**
 * Plans as the executors read and write them (P3): a version's steps in the
 * shape composePlan (@flint/policy) works on, and a next version written as a
 * draft, which becomes active only through the database's composition check
 * (plan_guard). Also the goal's links, set to exactly what a signed card lists.
 */
import { Prisma } from '@prisma/client';
import { digestOf, type Link, type PlanStepState, type StepKind, type StepStatus, type StepTier } from '@flint/policy';
import type { Db, Tx } from '../db.js';

/** Code-side ids: `go` goals, `pl` plans, `ps` steps. */
export const newId = (prefix: 'go' | 'pl' | 'ps'): string => `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;

/** A plan's own words, a template: never the goal's or the model's. */
export const RATIONALE = {
  first: 'The first plan, from the goal card.',
  flint: 'Flint suggested this after its review.',
  will: 'Will asked for this change.',
} as const;

interface StepRow {
  key: string;
  ordinal: number;
  title: string;
  kind: string;
  tier: string;
  status: string;
  dueAt: Date | null;
  dependsOn: string[];
  doneAt: Date | null;
  doneAuditId: string | null;
  proposalId: string | null;
  taskId: string | null;
}

export function stepState(r: StepRow): PlanStepState {
  return {
    key: r.key, ordinal: r.ordinal, title: r.title, kind: r.kind as StepKind, tier: r.tier as StepTier, status: r.status as StepStatus,
    dueAt: r.dueAt?.toISOString() ?? null, dependsOn: [...r.dependsOn].sort(), doneAt: r.doneAt?.toISOString() ?? null,
    doneAuditId: r.doneAuditId, proposalId: r.proposalId, taskId: r.taskId,
  };
}

/**
 * The goal's active plan and its steps, or null. With `lock`, the plan row is
 * taken FOR UPDATE first: a step tick waiting on it (plan_step_guard reads the
 * plan FOR SHARE) then finds it superseded and is refused, instead of being
 * written to a version the new one did not copy.
 */
export async function activePlan(db: Db | Tx, goalId: string, lock = false): Promise<{ id: string; version: number; steps: PlanStepState[] } | null> {
  const [plan] = lock
    ? await db.$queryRaw<Array<{ id: string; version: number }>>`SELECT id, version FROM "Plan" WHERE "goalId" = ${goalId} AND status = 'active' FOR UPDATE`
    : await db.plan.findMany({ where: { goalId, status: 'active' }, select: { id: true, version: true } });
  if (!plan) return null;
  const steps = await db.planStep.findMany({ where: { planId: plan.id }, orderBy: [{ ordinal: 'asc' }, { key: 'asc' }] });
  return { id: plan.id, version: plan.version, steps: steps.map(stepState) };
}

/** The goal's latest version that was ever active (it holds an approval; a dropped draft does not): the next is this plus one, or 1. */
export async function lastVersion(tx: Tx, goalId: string): Promise<number> {
  const last = await tx.plan.findFirst({ where: { goalId, approvalId: { not: null } }, orderBy: { version: 'desc' }, select: { version: true } });
  return last?.version ?? 0;
}

/**
 * A plan version, written as an unsigned draft with exactly these steps. Returns
 * its id. Writing a draft and activating it must stay in one transaction: a draft
 * left behind would hold the next version number, and the goal's plan could then
 * never change again.
 */
export async function writeDraft(tx: Tx, goalId: string, version: number, steps: readonly PlanStepState[], createdBy: 'will' | 'flint', rationale: string): Promise<string> {
  const id = newId('pl');
  await tx.plan.create({ data: { id, goalId, version, createdBy, rationale } });
  if (steps.length) {
    await tx.planStep.createMany({
      data: steps.map((s) => ({
        id: newId('ps'), planId: id, key: s.key, ordinal: s.ordinal, title: s.title, kind: s.kind, status: s.status, tier: s.tier,
        dueAt: s.dueAt ? new Date(s.dueAt) : null, dependsOn: s.dependsOn, proposalId: s.proposalId, taskId: s.taskId,
        doneAuditId: s.doneAuditId, doneAt: s.doneAt ? new Date(s.doneAt) : null,
      })),
    });
  }
  return id;
}

const linkKey = (l: { role: string; watchPaths: readonly string[] }) => digestOf({ role: l.role, watchPaths: [...l.watchPaths].sort() });

/** A goal's links as a card states them: one per item, in item order. */
export async function currentLinks(db: Db | Tx, goalId: string): Promise<Link[]> {
  const rows = await db.goalEntity.findMany({ where: { goalId }, orderBy: { entityId: 'asc' } });
  return rows.map((r) => ({ entityId: r.entityId, role: r.role as Link['role'], watchPaths: [...r.watchPaths].sort() }));
}

/** Make the goal's links exactly `links` (the database lets only the executing card's links in, and only the ones it leaves out go). */
export async function syncLinks(tx: Tx, goalId: string, links: readonly Link[]): Promise<{ added: number; removed: number }> {
  const current = await tx.goalEntity.findMany({ where: { goalId } });
  const want = new Map(links.map((l) => [l.entityId, l]));
  let removed = 0;
  for (const c of current) {
    const w = want.get(c.entityId);
    if (w && linkKey(w) === linkKey(c)) continue;
    await tx.goalEntity.delete({ where: { goalId_entityId: { goalId, entityId: c.entityId } } });
    removed += 1;
  }
  let added = 0;
  for (const l of links) {
    const c = current.find((x) => x.entityId === l.entityId);
    if (c && linkKey(c) === linkKey(l)) continue;
    await tx.goalEntity.create({ data: { goalId, entityId: l.entityId, role: l.role, watchPaths: l.watchPaths } });
    added += 1;
  }
  return { added, removed };
}

/** Two goal definitions are the same: title, description and checks, compared as signed. */
export function sameDefinition(g: { title: string; description: string; successCriteria: Prisma.JsonValue }, a: { title: string; description: string; successCriteria: unknown }): boolean {
  return g.title === a.title && g.description === a.description && digestOf(g.successCriteria) === digestOf(a.successCriteria);
}

/** Two goal timings are the same: horizon and cadence. */
export function sameTiming(g: { horizonAt: Date | null; reviewCadence: string }, a: { horizonAt: string | null; reviewCadence: string }): boolean {
  return (g.horizonAt?.toISOString() ?? null) === a.horizonAt && g.reviewCadence === a.reviewCadence;
}

/** Two link sets are the same: the same items, each in the same role, watching the same fields. */
export function sameLinks(a: readonly Link[], b: readonly Link[]): boolean {
  const key = (ls: readonly Link[]) => digestOf([...ls].map((l) => ({ entityId: l.entityId, role: l.role, watchPaths: [...l.watchPaths].sort() })).sort((x, y) => (x.entityId < y.entityId ? -1 : 1)));
  return key(a) === key(b);
}
