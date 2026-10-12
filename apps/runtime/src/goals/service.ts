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
 *
 * Review Now (part 3) is unsigned too: it only asks for a review, which writes
 * what every review writes. It sends the goal's review job (ids only) and its
 * audit entry; the review itself claims one of the goal's 12 a day.
 */
import { Prisma } from '@prisma/client';
import { GOAL_CARD_VERBS, GOAL_KIND, localDay, type Criterion, type GoalCardVerb, type GoalSignedAction } from '@flint/policy';
import type { Db, Tx } from '../db.js';
import type { Bus } from '../bus.js';
import { appendAudit } from '../governance/audit.js';
import { Refused, createProposal, rejectProposal } from '../governance/proposals.js';
import { sqlState } from '../dbcodes.js';
import { checkedItems, criteriaOf, evaluate, itemFacts, marksOf } from './criteria.js';
import { SAY, goalStatusWords } from './errors.js';
import { REVIEW_QUEUE, reviewStanding, reviewsLeft, type ReviewJob } from './review.js';

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
 * The newer card wins: Will's other cards of this action still waiting for this
 * goal, from the console or the CLI, are rejected (unsigned, with a fixed
 * sentence) once a new one is filed. A card left waiting after a cancelled prompt
 * can then never be approved later over the change that replaced it.
 */
async function supersede(db: Db, action: GoalSignedAction, goalId: string, keep: string): Promise<void> {
  const older = await db.proposal.findMany({
    where: { status: 'pending', action, origin: { in: ['console', 'cli'] }, id: { not: keep }, args: { path: ['goalId'], equals: goalId } },
    select: { id: true },
  });
  for (const o of older) await rejectProposal(db, o.id, { error: SAY.replaced }, undefined, CONSOLE_ACTOR).catch(() => {});
}

/**
 * A new goal's card. Another card still waiting for the same new goal (the form
 * filed, then changed) is rejected once this one is filed: the newer form wins.
 */
export async function fileNewGoal(db: Db, args: Record<string, unknown> & { goalId: string }, now = new Date()) {
  const filed = await file(db, 'goal.activate', args, now);
  if (!filed.deduped && !(await db.goal.findUnique({ where: { id: args.goalId }, select: { id: true } }))) await supersede(db, 'goal.activate', args.goalId, filed.id);
  return { id: filed.id, deduped: filed.deduped };
}

/** The cards that say a goal's new values and nothing of the old ones' order: a newer one replaces an older one still waiting. */
const SUPERSEDING: ReadonlySet<GoalCardVerb> = new Set<GoalCardVerb>(['edit', 'timing']);

/**
 * A card for an existing goal, from its route: its args name that goal. A change
 * to what counts as done, or to the timing, replaces an older one still waiting
 * (and each says what it changes from, so one filed before a later change does
 * not apply: apply.ts).
 */
export async function fileGoalCard(db: Db, verb: GoalCardVerb, goalId: string, args: Record<string, unknown> & { goalId: string }, now = new Date()) {
  if (args.goalId !== goalId) throw new Refused(400, SAY.invalid, 'the args name another goal');
  if (!(await db.goal.findUnique({ where: { id: goalId }, select: { id: true } }))) throw new Refused(404, SAY.noGoal);
  const filed = await file(db, GOAL_CARD_VERBS[verb], args, now);
  if (!filed.deduped && SUPERSEDING.has(verb)) await supersede(db, GOAL_CARD_VERBS[verb], goalId, filed.id);
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

/**
 * Review Now: ask for this goal's review. It says yes only when a review will
 * run: refused, in a sentence, while reviews are off, for a goal that is not
 * active, while a rule stops reviews (the job would do nothing), past the
 * day's 12, or before the job queue is up. A review already waiting for the
 * goal is the same review.
 */
export async function requestReview(db: Db, bus: Pick<Bus, 'boss'> | undefined, id: string, o: { reviews: boolean; tz: string }, now = new Date()): Promise<void> {
  if (!o.reviews) throw new Refused(409, SAY.reviewsOff);
  const g = await db.goal.findUnique({ where: { id }, select: { status: true } });
  if (!g) throw new Refused(404, SAY.noGoal);
  if (g.status !== 'active') throw new Refused(409, goalStatusWords(g.status));
  if (!(await reviewStanding(db, now)).may) throw new Refused(409, SAY.reviewsStopped);
  if (!(await reviewsLeft(db, id, o.tz, now))) throw new Refused(429, SAY.reviewCap);
  if (!bus) throw new Refused(409, SAY.notReady);
  const job: ReviewJob = { goalId: id, kind: 'requested' };
  await bus.boss.send(REVIEW_QUEUE, job, { singletonKey: id });
  await appendAudit(db, [{ actor: CONSOLE_ACTOR, context: 'console', kind: 'action', action: 'goal.review.request', outcome: 'ok', correlationId: `${id}.review`, tainted: false, inputs: { goalId: id } }], now);
}
