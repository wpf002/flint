/**
 * A task's forecast (P5): every task that goes out carries one prediction that
 * it meets its bar, written in the dispatch's own transaction (the database
 * refuses a dispatch without it), and scored once the task has ended.
 *
 * The probability is a base rate, not a model's: how often tasks of the same
 * template on the same kind of asset were accepted in the last 90 days, with
 * one imagined success and one imagined failure added, kept within 5% and 95%
 * (Flint never claims certainty). With no history it is 50%. Its claim names
 * the task only by ref (task#<last 6 of its id>); its evidence cites counts.
 * It is counted under its own counter and never claims the 50 a day chat's and
 * triage's predictions share.
 *
 * Scoring. tasks.tick scores a forecast 24 hours after its task ended (the
 * time Will has to overrule a check), as `auto_world`, and only once Will has
 * promoted ledger.resolve.auto for the assets domain: until then forecasts
 * wait. An accepted task is true; a rejected or failed one is false; a
 * cancelled one is left to expire. scoreTaskForecast is the only writer of a
 * task forecast's resolution: the ledger's own sweep leaves `assets` /
 * `task_meets_bar` predictions (TASK_FORECAST) to it.
 */
import { MEETS_BAR_COUNTER, TASKS_WRITER, entityRef, localDay, periodKey, resolveTier, type TaskTemplateId } from '@flint/policy';
import type { Db, Tx } from '../db.js';
import { activePolicies } from '../governance/proposals.js';
import { emitPrediction } from '../ledger/emit.js';

const DAY = 86_400_000;
/** What marks a prediction as a task's forecast: one owner scores these. */
export const TASK_FORECAST = { domain: 'assets', type: 'task_meets_bar', createdBy: TASKS_WRITER } as const;
/** The rule's name, as the forecast's evidence cites it. Change the rule, change the name. */
export const MEETS_BAR_RULE = 'tasks.meets_bar.base_rate.v1';
/** How far back the base rate looks. */
export const HISTORY_MS = 90 * DAY;
/** How long after a task ended its forecast is scored: the time Will has to overrule its check. */
export const OVERRIDE_WINDOW_MS = DAY;
/** A forecast outlives its task's time by this much: a week for Will's accept card, a day to overrule. */
const SETTLE_MS = 8 * DAY;

/** (accepted + 1) / (n + 2), within 5% and 95%, to two places. */
export function meetsBarProbability(accepted: number, n: number): number {
  const p = (Math.max(0, accepted) + 1) / (Math.max(0, n) + 2);
  return Math.round(Math.min(0.95, Math.max(0.05, p)) * 100) / 100;
}

/** When the forecast resolves: the task's due time (a day from now without one) and the time to settle after it. */
export function forecastResolveBy(dueAt: Date | null, now: Date): Date {
  return new Date(Math.max(dueAt?.getTime() ?? 0, now.getTime() + DAY) + SETTLE_MS);
}

/** Record a task's forecast inside its dispatch's transaction, and count it. Returns its id. */
export async function recordForecast(
  tx: Tx,
  task: { id: string; assetKind: string; template: TaskTemplateId; dueAt: Date | null },
  tz: string,
  now: Date,
): Promise<{ id: string; probability: number }> {
  // Like tasks that ended: a task whose words retention has cleared no longer says its template, and is not counted.
  const [history] = await tx.$queryRaw<Array<{ accepted: number; n: number }>>`
    SELECT count(*) FILTER (WHERE t.status = 'accepted')::int AS accepted, count(*)::int AS n
    FROM "Task" t JOIN "Asset" a ON a.id = t."assetId"
    WHERE a.kind = ${task.assetKind} AND t.spec->>'template' = ${task.template}
      AND t.status IN ('accepted', 'rejected', 'failed') AND t."completedAt" > ${new Date(now.getTime() - HISTORY_MS)}`;
  const accepted = history?.accepted ?? 0;
  const n = history?.n ?? 0;
  const probability = meetsBarProbability(accepted, n);
  const resolveBy = forecastResolveBy(task.dueAt, now);
  const ref = entityRef('task', task.id);
  const p = await emitPrediction(
    tx,
    {
      template: { id: 'task_meets_bar', params: { task: ref, by: localDay(tz, resolveBy) } },
      kind: 'binary', probability, method: 'base_rate', domain: TASK_FORECAST.domain, type: TASK_FORECAST.type,
      evidence: [{ kind: 'base_rate', ref: MEETS_BAR_RULE, note: `${accepted} of ${n} like it were accepted in the last 90 days` }],
      resolutionCriteria: `True if ${ref} is accepted at or before the resolve time. False if it is rejected or fails, or is not accepted by then.`,
      resolver: 'auto_world', resolverSpec: { taskId: task.id, rule: 'task_accepted_by' },
      resolveBy: resolveBy.toISOString(), tainted: false,
    },
    TASKS_WRITER,
    now,
  );
  await tx.$queryRaw`SELECT count_action(${MEETS_BAR_COUNTER}, ${periodKey({ period: 'day' }, tz, now)})`;
  return { id: p.id, probability };
}

/** May Flint score task forecasts on its own: only once Will promoted ledger.resolve.auto, for everything or for the assets domain. */
export async function mayScore(db: Db | Tx, now: Date): Promise<boolean> {
  const inAssets = (scope: unknown): boolean => scope !== null && typeof scope === 'object' && (scope as { domain?: unknown }).domain === TASK_FORECAST.domain;
  return resolveTier('ledger.resolve.auto', { context: 'autonomous', tainted: false, policies: await activePolicies(db, now), scopeAllows: inAssets, now }).tier === 'alone';
}

/**
 * Score one ended task's forecast, inside the caller's READ COMMITTED
 * transaction. The task's row is locked first and its status read after, so an
 * override and a score never cross (the database refuses an override once the
 * forecast is scored, and waits on a score in flight).
 */
export async function scoreTaskForecast(tx: Tx, taskId: string, now: Date): Promise<'scored' | 'not_yet' | 'left'> {
  const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "Task" WHERE id = ${taskId} FOR UPDATE`;
  if (!locked.length) return 'left';
  const t = await tx.task.findUniqueOrThrow({ where: { id: taskId }, select: { status: true, completedAt: true, predictionId: true } });
  if (!t.predictionId || t.status === 'cancelled') return 'left';
  if (!t.completedAt || !['accepted', 'rejected', 'failed'].includes(t.status) || t.completedAt.getTime() > now.getTime() - OVERRIDE_WINDOW_MS) return 'not_yet';
  const p = await tx.prediction.findUnique({ where: { id: t.predictionId }, select: { status: true, resolveBy: true, resolution: { select: { id: true } } } });
  // Already scored, or no longer open (it ran past its date and expired): there is nothing to record.
  if (!p || p.resolution || p.status !== 'open') return 'left';
  await tx.resolution.create({
    data: {
      id: `rs${now.getTime().toString(36)}${Math.random().toString(36).slice(2, 12)}`,
      predictionId: t.predictionId,
      outcome: t.status === 'accepted' && t.completedAt.getTime() <= p.resolveBy.getTime(),
      eventAt: t.completedAt,
      resolvedBy: 'auto_world',
      evidence: { taskId, status: t.status, via: 'tasks.tick' },
    },
  });
  return 'scored';
}

/**
 * Will's own signed act on a task (his accept card, his override) is his answer
 * to whether it met its bar. Whether that answer scores the forecast there and
 * then is the ledger's rule to make: the database takes a result recorded as
 * his only with his answer on record, and a task card is not yet one. So
 * nothing is recorded here, and the forecast is scored with the rest
 * (scoreTaskForecast). The executors of both cards call this, in the card's
 * transaction: it is the one place that changes if the rule does.
 */
export async function scoreOnWillsCard(_tx: Tx, _taskId: string, _outcome: boolean, _approvalId: string): Promise<boolean> {
  return false;
}
