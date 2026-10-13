/**
 * Tasks as the panel shows them (P5): a tab of rows, and one task open. A row
 * is the task's title (a template's fixed words), what it is about (an item's
 * label made from its key, or a count), and one sentence for where it stands,
 * built from its status, a class and counts. The result shown is the summary
 * the template's own code made, always marked as outside text.
 *
 * Nothing here reaches a model: the routes need the `proposals` scope.
 */
import type { z } from 'zod';
import { Acceptance, CHECK_NAMES, TASK_ENDED, TaskSpec, likelihoodOf, specItems, taskLine, type AssetKind, type TaskFailure, type TaskRow, type TaskStatus, type TaskTab, type TaskView, type TasksPage } from '@flint/policy';
import type { Db } from '../db.js';
import { labelFor } from '../goals/items.js';
import { ACCEPT_CARD, WILL_ORIGINS, countsOf, microsOf, overrideProblem } from './card.js';

const PAGE = 100;
type Row = z.infer<typeof TaskRow>;

type Loaded = NonNullable<Awaited<ReturnType<typeof load>>>;
const load = (db: Db, id: string) => db.task.findUnique({ where: { id }, include: { asset: true } });

/** The ids of the tasks, among these, whose accept card is waiting for Will. */
async function waitingOn(db: Db, ids: readonly string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  // Only a card he can approve is waiting for him: the check's own (not one written under another origin).
  const cards = await db.proposal.findMany({ where: { ...ACCEPT_CARD, status: 'pending', expiresAt: { gt: new Date() } }, select: { id: true, args: true } });
  const out = new Map<string, string>();
  for (const c of cards) {
    const taskId = (c.args as { taskId?: unknown } | null)?.taskId;
    if (typeof taskId === 'string' && ids.includes(taskId)) out.set(taskId, c.id);
  }
  return out;
}

/** What a task is about, for its row: one item by its label, or how many items. Never a title. */
async function aboutOf(db: Db, t: Loaded, tz: string, now: Date): Promise<string | null> {
  const spec = TaskSpec.safeParse(t.spec);
  if (!spec.success) return null;
  const ids = specItems(spec.data);
  if (ids.length === 0) return null;
  if (ids.length > 1) return `${ids.length} Items`;
  const e = await db.entity.findUnique({ where: { id: ids[0]! }, select: { id: true, kind: true, key: true, name: true, status: true, taintedPaths: true, firstSeenAt: true } });
  return e && e.status !== 'forgotten' ? labelFor(db, e, tz, now) : null;
}

async function rowOf(db: Db, t: Loaded, waiting: Map<string, string>, tz: string, now: Date): Promise<Row> {
  // Once a task's details are cleared, what its checks found is gone with them: said, never counted as none.
  const checksCleared = t.metBar !== null && t.barEvidence === null;
  const checks = t.metBar === null || checksCleared ? null : countsOf(t.barEvidence);
  return {
    id: t.id, title: t.title, about: await aboutOf(db, t, tz, now), status: t.status as TaskStatus,
    line: taskLine({
      status: t.status as TaskStatus, assetKind: t.asset.kind as AssetKind, failure: t.failure as TaskFailure | null, checks, checksCleared,
      overridden: t.barCheckedBy === 'will', waitingForWill: waiting.has(t.id),
      // It passed its checks and still ended: only its accept card, turned down or left to lapse, ends a task that way.
      declined: t.status === 'failed' && t.failure === 'expired' && t.metBar === true,
    }),
    runsOn: t.asset.name,
    // Its spec showed the model outside text, or it has a result (a result is always outside text).
    outside: t.tainted || t.outputRef !== null,
    costs: t.asset.spends,
    createdAt: t.createdAt.toISOString(),
  };
}

/** A tab of the panel, newest first. */
export async function tasksPage(db: Db, tab: TaskTab, tz: string, now = new Date()): Promise<z.infer<typeof TasksPage>> {
  const ended = [...TASK_ENDED];
  const tasks = await db.task.findMany({
    where: { status: tab === 'finished' ? { in: ended } : { notIn: ended } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: PAGE + 1, include: { asset: true },
  });
  const shown = tasks.slice(0, PAGE);
  const waiting = await waitingOn(db, shown.map((t) => t.id));
  return { tasks: await Promise.all(shown.map((t) => rowOf(db, t, waiting, tz, now))), more: tasks.length > PAGE };
}

/** One task, open; undefined when there is none. */
export async function taskView(db: Db, id: string, tz: string, now = new Date()): Promise<z.infer<typeof TaskView> | undefined> {
  const t = await load(db, id);
  if (!t) return undefined;
  const waiting = await waitingOn(db, [id]);
  const acceptance = Acceptance.safeParse(t.acceptance);
  const found = new Map((Array.isArray(t.barEvidence) ? (t.barEvidence as Array<{ id?: unknown; met?: unknown }>) : []).map((f) => [f.id, f.met === true]));
  const forecast = t.predictionId ? await db.prediction.findUnique({ where: { id: t.predictionId }, select: { probability: true } }) : null;
  // His card for this task that is waiting: the newest of any kind (to run it, to accept it, to stop it, to overrule
  // its check), among the cards he can approve: the check's accept card, and any other filed for him.
  const card = await db.proposal.findFirst({
    where: {
      status: 'pending', expiresAt: { gt: now }, args: { path: ['taskId'], equals: id },
      OR: [ACCEPT_CARD, { action: { startsWith: 'task.' }, NOT: { action: ACCEPT_CARD.action }, origin: { in: [...WILL_ORIGINS] } }],
    },
    orderBy: { createdAt: 'desc' }, select: { id: true },
  });
  const can = async (to: 'accepted' | 'rejected') => !(await overrideProblem(db, t, to));
  return {
    ...(await rowOf(db, t, waiting, tz, now)),
    result: t.outputSummary,
    checks: acceptance.success
      ? acceptance.data.map((a) => ({ id: a.id, name: CHECK_NAMES[a.check.type === 'judge' ? 'judge' : a.check.op], state: !found.has(a.id) ? ('waiting' as const) : found.get(a.id) ? ('passed' as const) : ('failed' as const) }))
      : [],
    checkedBy: t.barCheckedBy === null ? null : t.barCheckedBy === 'will' ? 'you' : t.barCheckedBy === 'flint:rule' ? 'rules' : 'model',
    askedBy: t.origin === 'flint' ? 'flint' : 'you',
    goalId: t.goalId,
    dueAt: t.dueAt?.toISOString() ?? null,
    chance: forecast?.probability != null ? { likelihood: likelihoodOf(forecast.probability), percent: Math.round(forecast.probability * 100) } : null,
    cost: t.costUsd === null ? null : { micros: microsOf(t.costUsd), estimate: t.costIsEstimate },
    card: card?.id ?? null,
    can: { cancel: !(TASK_ENDED as readonly string[]).includes(t.status), accept: await can('accepted'), reject: await can('rejected') },
  };
}
