/**
 * What the goals panel does (P3 part 2), behind the runtime's goal routes.
 *
 * Signed: a new goal, and each change to one (what counts as done, its timing,
 * done, abandoned, resumed, a step added), is a card filed here and signed by
 * Will in the console. The card's args are exactly what the panel showed him
 * (the console signs only their digest), checked against the shared contract
 * and the goal as it stands by createProposal (checkGoalCard), with a fixed
 * reason, kept 7 days. A new goal's id comes from its form's draft key, so the
 * same form filed twice is the same card; a changed form's card replaces the
 * one it changed.
 *
 * Unsigned: pausing, dismissing a suggestion, Will's mark on a manual check and
 * a step's progress. These move progress only, never what a goal is, and each
 * is written with its audit entry (actor will:console, ids only) in one
 * transaction that takes the goal FOR UPDATE before it touches any plan or step
 * (the lock order the README sets), at READ COMMITTED (the database refuses
 * step writes above it).
 */
import { Prisma } from '@prisma/client';
import { GOAL_CARD_VERBS, GOAL_KIND, localDay, type Criterion, type GoalCardVerb, type GoalSignedAction } from '@flint/policy';
import type { Db, Tx } from '../db.js';
import { appendAudit } from '../governance/audit.js';
import { Refused, createProposal, rejectProposal } from '../governance/proposals.js';
import { sqlState } from '../dbcodes.js';
import { checkedItems, evaluate, itemFacts } from './criteria.js';
import { SAY, goalStatusWords } from './errors.js';

/** Who the panel's writes are by. */
export const CONSOLE_ACTOR = 'will:console';
/** How long a goal card waits for Will. */
const CARD_TTL_MINUTES = 7 * 24 * 60;

/** File one goal card from the console. Its reason, sensitivity and fresh-touch mark are set by checkGoalCard. */
async function file(db: Db, action: GoalSignedAction, args: Record<string, unknown>, now: Date) {
  return createProposal(db, {
    kind: GOAL_KIND[action], origin: 'console', action, args,
    // Every part is Will's own, typed or picked in the panel; items are named by id.
    argsProvenance: { args: { source: 'will', tainted: false } },
    tainted: false, sensitivity: 'personal', destructive: false, consequential: true, ttlMinutes: CARD_TTL_MINUTES,
  }, CONSOLE_ACTOR, now);
}

/**
 * A new goal's card. Another card still waiting for the same new goal (the form
 * filed, then changed) is rejected once this one is filed: the newer form wins.
 */
export async function fileNewGoal(db: Db, args: Record<string, unknown> & { goalId: string }, now = new Date()) {
  const filed = await file(db, 'goal.activate', args, now);
  if (!filed.deduped) {
    const older = await db.proposal.findMany({
      where: { status: 'pending', action: 'goal.activate', origin: 'console', id: { not: filed.id }, args: { path: ['goalId'], equals: args.goalId } },
      select: { id: true },
    });
    const goal = await db.goal.findUnique({ where: { id: args.goalId }, select: { id: true } });
    if (!goal) {
      for (const o of older) await rejectProposal(db, o.id, { error: SAY.replaced }, undefined, CONSOLE_ACTOR).catch(() => {});
    }
  }
  return { id: filed.id, deduped: filed.deduped };
}

/** A card for an existing goal, from its route: its args name that goal. */
export async function fileGoalCard(db: Db, verb: GoalCardVerb, goalId: string, args: Record<string, unknown> & { goalId: string }, now = new Date()) {
  if (args.goalId !== goalId) throw new Refused(400, SAY.invalid, 'the args name another goal');
  if (!(await db.goal.findUnique({ where: { id: goalId }, select: { id: true } }))) throw new Refused(404, SAY.noGoal);
  const filed = await file(db, GOAL_CARD_VERBS[verb], args, now);
  return { id: filed.id, deduped: filed.deduped };
}

interface LockedGoal {
  id: string;
  status: string;
  successCriteria: unknown;
  criteriaMet: unknown;
}

/** The goal, locked for this transaction before anything else of it is read or written. */
async function lockGoal(tx: Tx, id: string): Promise<LockedGoal> {
  const [g] = await tx.$queryRaw<LockedGoal[]>`SELECT id, status, "successCriteria", "criteriaMet" FROM "Goal" WHERE id = ${id} FOR UPDATE`;
  if (!g) throw new Refused(404, SAY.noGoal);
  return g;
}

/** Progress as the checks stand now, inside the transaction that changed them. */
async function progressOf(tx: Tx, goalId: string, criteria: readonly Criterion[], marks: Record<string, unknown>): Promise<number> {
  const plan = await tx.plan.findFirst({ where: { goalId, status: 'active' }, select: { steps: { select: { key: true, status: true } } } });
  const items = await itemFacts(tx, checkedItems(criteria));
  return evaluate(criteria, marks, plan?.steps ?? null, items).progress;
}

/** One unsigned write and its audit entry, at READ COMMITTED; a plan replaced under it is a sentence, not a 500. */
async function plain<T>(db: Db, work: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    return await db.$transaction(work, { maxWait: 10_000, timeout: 20_000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  } catch (err) {
    if (err instanceof Refused) throw err;
    const state = sqlState(err);
    if (state === '40001') throw new Refused(409, SAY.planLooked);
    if (state === '40P01' || state === '55P03') throw new Refused(409, SAY.busy);
    throw err;
  }
}

const audit = (tx: Tx, action: string, correlationId: string, inputs: Record<string, string | boolean | number | null>, now: Date) =>
  appendAudit(tx, [{ actor: CONSOLE_ACTOR, context: 'console', kind: 'action', action, outcome: 'ok', correlationId, tainted: false, inputs }], now);

/** Pause an active goal: Flint stops reviewing it until Will resumes it (a signed goal.activate). */
export async function pauseGoal(db: Db, id: string, now = new Date()): Promise<void> {
  await plain(db, async (tx) => {
    const g = await lockGoal(tx, id);
    if (g.status !== 'active') throw new Refused(409, goalStatusWords(g.status));
    await tx.goal.update({ where: { id }, data: { status: 'paused' } });
    await audit(tx, 'goal.pause', `${id}.pause`, { goalId: id, from: g.status }, now);
  });
}

/** Dismiss a goal Flint suggested: it is never started. */
export async function dismissGoal(db: Db, id: string, now = new Date()): Promise<void> {
  await plain(db, async (tx) => {
    const g = await lockGoal(tx, id);
    if (g.status !== 'proposed') throw new Refused(409, goalStatusWords(g.status));
    await tx.goal.update({ where: { id }, data: { status: 'rejected' } });
    await audit(tx, 'goal.dismiss', `${id}.dismiss`, { goalId: id }, now);
  });
}

const criteriaOf = (g: LockedGoal) => (Array.isArray(g.successCriteria) ? (g.successCriteria as Criterion[]) : []);
const marksOf = (g: LockedGoal): Record<string, unknown> => (g.criteriaMet && typeof g.criteriaMet === 'object' && !Array.isArray(g.criteriaMet) ? { ...(g.criteriaMet as Record<string, unknown>) } : {});
const live = (g: LockedGoal) => {
  if (g.status !== 'active' && g.status !== 'paused') throw new Refused(409, goalStatusWords(g.status));
};

/** Will's mark on one of his own (manual) checks: met today, or not met. Progress follows. */
export async function markCriterion(db: Db, id: string, cid: string, met: boolean, tz: string, now = new Date()): Promise<void> {
  await plain(db, async (tx) => {
    const g = await lockGoal(tx, id);
    live(g);
    const criteria = criteriaOf(g);
    const c = criteria.find((x) => x.id === cid);
    if (!c) throw new Refused(404, SAY.noCheck);
    if (c.check.kind !== 'manual') throw new Refused(400, SAY.notManual);
    const marks = marksOf(g);
    if (met) marks[cid] = typeof marks[cid] === 'string' ? marks[cid] : localDay(tz, now);
    else delete marks[cid];
    const progress = await progressOf(tx, id, criteria, marks);
    await tx.goal.update({ where: { id }, data: { criteriaMet: marks as Prisma.InputJsonObject, progress } });
    await audit(tx, 'goal.criterion.mark', `${id}.mark.${cid}`, { goalId: id, criterionId: cid, met }, now);
  });
}

/** Steps Will moves himself: his own tasks, waits and decisions. A Flint action is done only by doing it. */
const TICKABLE = new Set(['will_task', 'wait', 'decision']);

/** A step's progress on the active plan. Never into or out of skipped (that is a signed plan change). Progress follows. */
export async function setStep(db: Db, id: string, key: string, status: 'todo' | 'in_progress' | 'blocked' | 'done', now = new Date()): Promise<void> {
  await plain(db, async (tx) => {
    const g = await lockGoal(tx, id);
    live(g);
    // Then the plan (FOR SHARE, as the step guard reads it): a plan change waiting on the goal sees this one first.
    const [plan] = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "Plan" WHERE "goalId" = ${id} AND status = 'active' FOR SHARE`;
    if (!plan) throw new Refused(404, SAY.noPlan);
    const step = await tx.planStep.findUnique({ where: { planId_key: { planId: plan.id, key } } });
    if (!step) throw new Refused(404, SAY.noStep);
    if (!TICKABLE.has(step.kind)) throw new Refused(400, SAY.notTickable);
    if (step.status === 'skipped') throw new Refused(409, SAY.skipped);
    if (step.status !== status) {
      await tx.planStep.update({ where: { id: step.id }, data: { status, doneAt: status === 'done' ? now : null } });
    }
    const progress = await progressOf(tx, id, criteriaOf(g), marksOf(g));
    await tx.goal.update({ where: { id }, data: { progress } });
    await audit(tx, 'goal.step.status', `${id}.step.${key}`, { goalId: id, stepKey: key, status, from: step.status }, now);
  });
}
