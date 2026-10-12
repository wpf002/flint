/**
 * Will's active goals for chat (P3 part 4): what GET /v1/goals/now answers,
 * for the server's goals block. One row a goal, of closed values only: its ref,
 * its checks as they stand (criteria.ts), its open onTrack forecast from the
 * ledger's own row, the day it is to be finished by, and how many of its steps
 * are still to do and how many of those are overdue.
 *
 * A row's title is Will's own, and it is sent only for a goal he signed that
 * carries no outside text; any other goal goes by its ref alone. Nothing else
 * of a goal's words is here: no description, no check's text, no step's title.
 *
 * Goal text is PERSONAL: this answer goes only to the server (the `proposals`
 * scope), which hands it only to a model on this Mac. Nothing here logs.
 */
import { GOALS_NOW_ROWS, GoalTitle, entityRef, likelihoodOf, localDay, type GoalNow, type GoalsNowAnswer } from '@flint/policy';
import type { Db, Tx } from '../db.js';
import { checkedItems, criteriaOf, evaluate, itemFacts, marksOf } from './criteria.js';

const OPEN = new Set(['todo', 'in_progress', 'blocked']);

export async function goalsNow(db: Db | Tx, tz: string, now = new Date()): Promise<GoalsNowAnswer> {
  const where = { status: 'active' };
  const [total, goals] = await Promise.all([
    db.goal.count({ where }),
    // The panel's order, so the block reads the same from one turn to the next.
    db.goal.findMany({ where, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: GOALS_NOW_ROWS }),
  ]);
  const ids = goals.map((g) => g.id);
  const [plans, items, forecasts] = await Promise.all([
    ids.length ? db.plan.findMany({ where: { goalId: { in: ids }, status: 'active' }, select: { goalId: true, steps: { select: { key: true, status: true, dueAt: true } } } }) : [],
    itemFacts(db, goals.flatMap((g) => checkedItems(criteriaOf(g)))),
    // Each goal's open forecast, newest first: the number a review recorded.
    ids.length
      ? db.prediction.findMany({ where: { goalId: { in: ids }, domain: 'goals', status: 'open', probability: { not: null } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { goalId: true, probability: true, resolveBy: true } })
      : [],
  ]);
  const stepsOf = new Map(plans.map((p) => [p.goalId, p.steps]));
  const forecastOf = new Map<string, { probability: number; resolveBy: Date }>();
  for (const f of forecasts) if (f.goalId && f.probability !== null && !forecastOf.has(f.goalId)) forecastOf.set(f.goalId, { probability: f.probability, resolveBy: f.resolveBy });

  const rows = goals.map((g): GoalNow => {
    const steps = stepsOf.get(g.id) ?? null;
    const e = evaluate(criteriaOf(g), marksOf(g), steps, items);
    const open = (steps ?? []).filter((s) => OPEN.has(s.status));
    const f = forecastOf.get(g.id);
    return {
      ref: entityRef('goal', g.id),
      // His own words, signed, with no outside text in them; otherwise the goal goes by its ref.
      title: !g.tainted && g.approvalId && GoalTitle.safeParse(g.title).success ? g.title : null,
      checks: { met: e.met, total: e.total, unknown: e.unknown },
      onTrack: f ? { likelihood: likelihoodOf(f.probability), percent: Math.round(f.probability * 100), by: localDay(tz, f.resolveBy) } : null,
      finishBy: g.horizonAt ? localDay(tz, g.horizonAt) : null,
      steps: { open: open.length, overdue: open.filter((s) => s.dueAt && s.dueAt.getTime() <= now.getTime()).length },
    };
  });
  return { goals: rows, more: Math.max(0, total - rows.length) };
}
