/**
 * A task's forecast (P5): every task that goes out carries one prediction that
 * it meets its bar, written in the dispatch's own transaction (the database
 * refuses a dispatch without it), and scored once the task has ended.
 *
 * The probability is a base rate, not a model's: how often tasks of the same
 * template on the same kind of asset were accepted, among those that ended in
 * the last 90 days and still say their template (retention clears a task's
 * details 30 days after it ended, 7 for a personal, financial or tainted one,
 * and a cleared task is not counted), with one imagined success and one
 * imagined failure added, kept within 5% and 95% (Flint never claims
 * certainty). With no history it is 50%. Its claim names the task only by ref
 * (task#<last 6 of its id>); its evidence cites the counts and says which
 * tasks they are of.
 * It is counted under its own counter and never claims the 50 a day chat's and
 * triage's predictions share.
 *
 * Whose it is. The forecast carries the rule that names its task
 * (TaskForecastSpec): the database takes a dispatch only with it, and the
 * ledger's own sweep leaves a prediction alone when it carries a rule it does
 * not know. So tasks.tick is the only thing that settles one or lets it run
 * out, and this file is the only writer of a task forecast's resolution.
 *
 * Scoring. tasks.tick scores a forecast 24 hours after its task ended (the
 * time Will has to overrule a check; the database refuses a score before
 * then), as `auto_world`: true when the task ended accepted, false when it
 * ended rejected or failed. It runs as the ledger's own checks do, in shadow
 * at APPROVAL, and a rule that forbids ledger.resolve.auto stops it. A
 * cancelled task's forecast is never scored: it runs out once its date has
 * passed (ledger.expire, the same way).
 */
import { MEETS_BAR_COUNTER, TASKS_WRITER, TASK_FORECAST_RULE, entityRef, localDay, periodKey, resolveTier, runsInShadow, type TaskTemplateId } from '@flint/policy';
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

/** What the evidence says the counts are of: the tasks the base rate really read, not the whole 90 days. */
export const baseRateNote = (accepted: number, n: number): string =>
  `${accepted} of ${n} like it were accepted, among those that ended in the last 90 days and whose details are still kept`;

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
      evidence: [{ kind: 'base_rate', ref: MEETS_BAR_RULE, note: baseRateNote(accepted, n) }],
      resolutionCriteria: `True if ${ref} ends accepted. False if it ends rejected or failed.`,
      resolver: 'auto_world', resolverSpec: { taskId: task.id, rule: TASK_FORECAST_RULE },
      resolveBy: resolveBy.toISOString(), tainted: false,
    },
    TASKS_WRITER,
    now,
  );
  await tx.$queryRaw`SELECT count_action(${MEETS_BAR_COUNTER}, ${periodKey({ period: 'day' }, tz, now)})`;
  return { id: p.id, probability };
}

/**
 * May a ledger action run for task forecasts now: promoted, or in shadow at
 * APPROVAL, as the ledger's own sweep reads it. A rule of Will's scoped to the
 * assets domain counts here; one that forbids the action stops it.
 */
async function ledgerMay(db: Db | Tx, action: 'ledger.resolve.auto' | 'ledger.expire', now: Date): Promise<boolean> {
  const inAssets = (scope: unknown): boolean => scope !== null && typeof scope === 'object' && (scope as { domain?: unknown }).domain === TASK_FORECAST.domain;
  const t = resolveTier(action, { context: 'autonomous', tainted: false, policies: await activePolicies(db, now), scopeAllows: inAssets, now });
  return t.tier === 'alone' || (t.tier === 'approval' && runsInShadow(action));
}
/** May Flint score task forecasts now? */
export const mayScore = (db: Db | Tx, now: Date): Promise<boolean> => ledgerMay(db, 'ledger.resolve.auto', now);
/** May Flint let a task forecast that can never be scored run out now? */
export const mayExpire = (db: Db | Tx, now: Date): Promise<boolean> => ledgerMay(db, 'ledger.expire', now);

/**
 * Score one ended task's forecast, inside the caller's READ COMMITTED
 * transaction (the database refuses a score above it). The task's row is
 * locked first and its status read after, in the order an override takes them
 * (the task, then its forecast), so the two never cross: the database refuses
 * an override once the forecast is scored, and a score whose outcome is not
 * how the task ended.
 */
export async function scoreTaskForecast(tx: Tx, taskId: string, now: Date): Promise<'scored' | 'not_yet' | 'left'> {
  const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "Task" WHERE id = ${taskId} FOR UPDATE`;
  if (!locked.length) return 'left';
  const t = await tx.task.findUniqueOrThrow({ where: { id: taskId }, select: { status: true, completedAt: true, predictionId: true } });
  if (!t.predictionId || t.status === 'cancelled') return 'left';
  if (!t.completedAt || !['accepted', 'rejected', 'failed'].includes(t.status) || t.completedAt.getTime() > now.getTime() - OVERRIDE_WINDOW_MS) return 'not_yet';
  const p = await tx.prediction.findUnique({ where: { id: t.predictionId }, select: { status: true, resolution: { select: { id: true } } } });
  // Already scored, or no longer open (it ran past its date and expired): there is nothing to record.
  if (!p || p.resolution || p.status !== 'open') return 'left';
  await tx.resolution.create({
    data: {
      id: `rs${now.getTime().toString(36)}${Math.random().toString(36).slice(2, 12)}`,
      predictionId: t.predictionId,
      outcome: t.status === 'accepted',
      eventAt: t.completedAt,
      resolvedBy: 'auto_world',
      evidence: { taskId, status: t.status, via: 'tasks.tick' },
    },
  });
  return 'scored';
}

/**
 * Let a cancelled task's forecast run out, inside the caller's transaction:
 * nothing will ever settle it. Only once its date has passed (the database
 * holds every expiry to that), and only while it is still open and unscored.
 */
export async function expireCancelledForecast(tx: Tx, taskId: string, now: Date): Promise<boolean> {
  const t = await tx.task.findUnique({ where: { id: taskId }, select: { status: true, predictionId: true } });
  if (!t?.predictionId || t.status !== 'cancelled') return false;
  const r = await tx.prediction.updateMany({ where: { id: t.predictionId, status: 'open', resolveBy: { lt: now }, resolution: null }, data: { status: 'expired' } });
  return r.count > 0;
}
