/**
 * The task tick (P5), every 2 minutes: it keeps tasks moving and ends the ones
 * whose time is up. Indexed reads; it never runs an adapter itself, and its
 * jobs carry a task's id only.
 *
 *  1. A proposed task whose dispatch card is gone (rejected, expired or
 *     failed) is cancelled: nothing went out, so that needs no signature.
 *  2. A task that is out (queued, dispatched, running): failed as `asset_off`
 *     when its asset was turned off, as `expired` past its due time or after
 *     24 hours without moving; otherwise its run is sent again (a watcher has
 *     nothing else to wake it, and a job that died heals the same way).
 *  3. A task handed in (submitted, checking): its check is sent again, until
 *     it has a result. One that passed waits for Will's accept card as long as
 *     the card does, and fails as `expired` once he turned it down or let it
 *     lapse; one without a card is sent to its check, which files it.
 *  4. Scoring: an ended task's forecast, 24 hours after it ended, once Will
 *     has promoted ledger.resolve.auto for the assets domain. This is the only
 *     place a task's forecast is scored (forecast.ts): the ledger's own sweep
 *     leaves these predictions alone.
 */
import { Prisma } from '@prisma/client';
import type { Db } from '../db.js';
import type { Bus } from '../bus.js';
import { appendAudit } from '../governance/audit.js';
import { TASKS_ORIGIN } from '@flint/policy';
import { RUN_QUEUE } from './card.js';
import { liveAcceptCard } from './check.js';
import { OVERRIDE_WINDOW_MS, TASK_FORECAST, mayScore, scoreTaskForecast } from './forecast.js';
import { CHECK_QUEUE, failTask } from './run.js';
import { taskLog } from './errors.js';

/** The tick's cron: every 2 minutes. */
export const TASK_TICK_CRON = '*/2 * * * *';
/** A task that has not moved for this long is given up on. */
export const STALE_MS = 24 * 3_600_000;
/** A proposed task is left alone this long before its card is looked for (the request that made it files the card next). */
export const FILING_GRACE_MS = 10 * 60_000;
const TASKS_PER_TICK = 200;
const SCORES_PER_TICK = 50;

export interface TaskTickDeps {
  db: Db;
  bus: Pick<Bus, 'boss'>;
  now?: () => Date;
  log?: (msg: string) => void;
}

export interface TaskTickCounts {
  /** Runs and checks sent (again). */
  sent: number;
  /** Tasks ended as failed: their asset was turned off, or their time was up. */
  failed: number;
  /** Proposed tasks cancelled: their card was gone. */
  cancelled: number;
  /** Forecasts scored. */
  scored: number;
}

const RC = { maxWait: 10_000, timeout: 20_000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted } as const;

export async function taskTick(d: TaskTickDeps): Promise<TaskTickCounts> {
  const { db } = d;
  const now = d.now?.() ?? new Date();
  const counts: TaskTickCounts = { sent: 0, failed: 0, cancelled: 0, scored: 0 };
  const stale = new Date(now.getTime() - STALE_MS);
  const send = async (queue: string, taskId: string) => {
    if (await d.bus.boss.send(queue, { taskId }, { singletonKey: taskId })) counts.sent += 1;
  };

  // 1. Proposed, with no card left that could send it out.
  const proposed = await db.task.findMany({ where: { status: 'proposed', createdAt: { lt: new Date(now.getTime() - FILING_GRACE_MS) } }, orderBy: { createdAt: 'asc' }, take: TASKS_PER_TICK, select: { id: true } });
  for (const t of proposed) {
    const live = await db.proposal.findFirst({ where: { action: { startsWith: 'task.dispatch.' }, status: { in: ['pending', 'approved', 'executing'] }, args: { path: ['taskId'], equals: t.id } }, select: { id: true } });
    if (live) continue;
    const done = await db.$transaction(async (tx) => {
      const r = await tx.task.updateMany({ where: { id: t.id, status: 'proposed' }, data: { status: 'cancelled' } });
      if (r.count) await appendAudit(tx, [{ actor: TASKS_ORIGIN, context: 'autonomous', kind: 'decision', action: 'task.cancel', decision: 'log', outcome: 'ok', inputs: { taskId: t.id, why: 'card_gone' }, correlationId: `task:${t.id}`, tainted: false }], now);
      return r.count > 0;
    }, RC);
    if (done) counts.cancelled += 1;
  }

  // 2 and 3. Everything that went out and has not ended.
  const open = await db.task.findMany({
    where: { status: { in: ['queued', 'dispatched', 'running', 'submitted', 'checking'] } },
    orderBy: { updatedAt: 'asc' }, take: TASKS_PER_TICK,
    select: { id: true, status: true, dueAt: true, updatedAt: true, metBar: true, asset: { select: { enabled: true } } },
  });
  for (const t of open) {
    const out = t.status === 'queued' || t.status === 'dispatched' || t.status === 'running';
    const fail = async (failure: 'asset_off' | 'expired') => {
      if (await failTask(db, t.id, [t.status], failure, d.log)) counts.failed += 1;
    };
    if (out) {
      if (!t.asset.enabled) await fail('asset_off');
      else if ((t.dueAt && t.dueAt <= now) || t.updatedAt <= stale) await fail('expired');
      else await send(RUN_QUEUE, t.id);
    } else if (t.status === 'checking' && t.metBar === true) {
      // Passed: it waits for Will as long as his card does. A card he turned down, or let lapse, ends the wait.
      if (await liveAcceptCard(db, t.id)) continue;
      const dead = await db.proposal.findFirst({ where: { action: 'task.check_bar', status: { in: ['rejected', 'expired', 'failed'] }, args: { path: ['taskId'], equals: t.id } }, select: { id: true } });
      if (dead) await fail('expired');
      else await send(CHECK_QUEUE, t.id);
    } else if (t.updatedAt <= stale) await fail('expired');
    else await send(CHECK_QUEUE, t.id);
  }

  // 4. Forecasts of tasks that ended a day ago or more.
  if (await mayScore(db, now)) {
    const due = await db.$queryRaw<Array<{ id: string }>>`
      SELECT t.id FROM "Task" t JOIN "Prediction" p ON p.id = t."predictionId"
      WHERE t.status IN ('accepted', 'rejected', 'failed') AND t."completedAt" <= ${new Date(now.getTime() - OVERRIDE_WINDOW_MS)}
        AND p.status = 'open' AND p.domain = ${TASK_FORECAST.domain} AND p.type = ${TASK_FORECAST.type}
        AND NOT EXISTS (SELECT 1 FROM "Resolution" r WHERE r."predictionId" = p.id)
      ORDER BY t."completedAt" ASC LIMIT ${SCORES_PER_TICK}`;
    for (const t of due) {
      if ((await db.$transaction((tx) => scoreTaskForecast(tx, t.id, now), RC)) === 'scored') {
        counts.scored += 1;
        d.log?.(taskLog(t.id, 'scored'));
      }
    }
  }
  return counts;
}
