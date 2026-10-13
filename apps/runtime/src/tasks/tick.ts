/**
 * The task tick (P5), every 2 minutes: it keeps tasks moving and ends the ones
 * whose time is up. Indexed reads; it never runs an adapter itself, and its
 * jobs carry a task's id only.
 *
 *  1. A proposed task whose dispatch card is gone (rejected, expired or
 *     failed) is cancelled: nothing went out, so that needs no signature. It
 *     is on record under its own name (task.withdraw), never the signed
 *     cancellation's.
 *  2. A task that is out (queued, dispatched, running): failed as `asset_off`
 *     when its asset was turned off; as `expired` once its due time has
 *     passed; with no due time, as `timeout` after 24 hours without moving.
 *     Otherwise its run is sent again (a watcher has nothing else to wake it,
 *     and a job that died heals the same way). A task with a due time is
 *     watched until then, however far off.
 *  3. A task handed in and not yet checked (submitted, checking): its check
 *     is sent again, until it has a result; failed as `timeout` after 24
 *     hours without one.
 *  4. A result that passed waits for Will's accept card as long as the card
 *     does. One whose card is no longer waiting fails as `expired` when he
 *     turned a card down or let one lapse (his answer: check.ts's
 *     acceptDeclined says the same), and is otherwise sent to its check,
 *     which files a card (again, when the last one did not run).
 *
 * Each of these is read on its own, by what needs doing: tasks waiting on a
 * card of Will's are not in any answer, so however many wait they never hide
 * a task that is out or overdue. Tasks that are out are walked a page at a
 * time, all of them, every tick.
 *
 *  5. Scoring: an ended task's forecast, 24 hours after it ended, as the
 *     ledger's own checks run (in shadow; a rule that forbids
 *     ledger.resolve.auto stops it). This is the only place a task's forecast
 *     is scored (forecast.ts): the ledger's own sweep leaves these predictions
 *     alone, because they carry a rule it does not know.
 *  6. Running out: a cancelled task's forecast is never scored, so it is
 *     marked as run out once its date has passed (ledger.expire, the same
 *     way). The sweep would never do it.
 */
import { Prisma } from '@prisma/client';
import type { Db } from '../db.js';
import type { Bus } from '../bus.js';
import { appendAudit } from '../governance/audit.js';
import { TASKS_ORIGIN } from '@flint/policy';
import { ACCEPT_CARD, RUN_QUEUE, WILL_ORIGINS, WITHDRAW_ACTION, releaseTaskKeys, type Reserve } from './card.js';
import { OVERRIDE_WINDOW_MS, TASK_FORECAST, expireCancelledForecast, mayExpire, mayScore, scoreTaskForecast } from './forecast.js';
import { CHECK_QUEUE, failTask } from './run.js';
import { taskLog } from './errors.js';
import { failureClass } from '../dbcodes.js';

/** The tick's cron: every 2 minutes. */
export const TASK_TICK_CRON = '*/2 * * * *';
/** A task with no due time that has not moved for this long is given up on; so is a result no check has read for this long. */
export const STALE_MS = 24 * 3_600_000;
/** A proposed task is left alone this long before its card is looked for (the request that made it files the card next). */
export const FILING_GRACE_MS = 10 * 60_000;
/** How many tasks one read answers. */
export const TASKS_PER_PAGE = 200;
/** How many pages of tasks that are out one tick walks: more than can be out at once (70 may go out a day, none for longer than 90 days). */
const MAX_PAGES = 40;
const SCORES_PER_TICK = 50;

export interface TaskTickDeps {
  db: Db;
  bus: Pick<Bus, 'boss'>;
  now?: () => Date;
  log?: (msg: string) => void;
  /** How many tasks one read answers (TASKS_PER_PAGE; a test's seam, to walk pages without hundreds of tasks). */
  pageSize?: number;
  /** What sets a paid task's money aside, when there is one: a task withdrawn before it went out gives back what its cards hold. */
  reserve?: Reserve;
}

export interface TaskTickCounts {
  /** Runs and checks sent (again). */
  sent: number;
  /** Tasks ended as failed: their asset was turned off, their time was up, or Will did not accept their result. */
  failed: number;
  /** Proposed tasks cancelled: their card was gone. */
  cancelled: number;
  /** Forecasts scored. */
  scored: number;
  /** Forecasts of cancelled tasks marked as run out. */
  ranOut: number;
}

const RC = { maxWait: 10_000, timeout: 20_000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted } as const;

export async function taskTick(d: TaskTickDeps): Promise<TaskTickCounts> {
  const { db } = d;
  const now = d.now?.() ?? new Date();
  const counts: TaskTickCounts = { sent: 0, failed: 0, cancelled: 0, scored: 0, ranOut: 0 };
  const stale = new Date(now.getTime() - STALE_MS);
  const pageSize = Math.max(1, Math.trunc(d.pageSize ?? TASKS_PER_PAGE));
  const send = async (queue: string, taskId: string) => {
    if (await d.bus.boss.send(queue, { taskId }, { singletonKey: taskId })) counts.sent += 1;
  };

  const fail = async (t: { id: string; status: string }, failure: 'asset_off' | 'expired' | 'timeout') => {
    if (await failTask(db, t.id, [t.status], failure, d.log)) counts.failed += 1;
  };

  // 1. Proposed, with no card left that could send it out. Read by what it lacks: a task whose card still waits
  // for Will is not in the answer, so cards that wait never crowd out one whose card is gone. Only a card filed
  // for him counts: one written under another origin could never be approved, and would keep the task for good.
  const proposed = await db.$queryRaw<Array<{ id: string }>>`
    SELECT t.id FROM "Task" t
    WHERE t.status = 'proposed' AND t."createdAt" < ${new Date(now.getTime() - FILING_GRACE_MS)}
      AND NOT EXISTS (
        SELECT 1 FROM "Proposal" p
        WHERE p.action LIKE 'task.dispatch.%' AND p.origin IN (${Prisma.join([...WILL_ORIGINS])})
          AND p.status IN ('pending', 'approved', 'executing') AND p.args->>'taskId' = t.id)
    ORDER BY t."createdAt" ASC, t.id ASC LIMIT ${pageSize}`;
  for (const t of proposed) {
    // What its cards set aside is given back first: none of them can send it out any more. A release that does not
    // go through leaves the task as it is, for the next tick.
    if (!(await releaseTaskKeys(db, d.reserve, t.id).catch(() => false))) continue;
    const done = await db.$transaction(async (tx) => {
      const r = await tx.task.updateMany({ where: { id: t.id, status: 'proposed' }, data: { status: 'cancelled' } });
      // `now` decides what is overdue; what is written carries the time it is written.
      if (r.count) await appendAudit(tx, [{ actor: TASKS_ORIGIN, context: 'autonomous', kind: 'decision', action: WITHDRAW_ACTION, decision: 'log', outcome: 'ok', inputs: { taskId: t.id, why: 'card_gone' }, correlationId: `task:${t.id}`, tainted: false }]);
      return r.count > 0;
    }, RC);
    if (done) counts.cancelled += 1;
  }

  // 2. Everything that is out, a page at a time by id: each one is ended or woken, and none is left unseen
  // behind the first page.
  let after: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const out = await db.task.findMany({
      where: { status: { in: ['queued', 'dispatched', 'running'] }, ...(after ? { id: { gt: after } } : {}) },
      orderBy: { id: 'asc' }, take: pageSize,
      select: { id: true, status: true, dueAt: true, updatedAt: true, asset: { select: { enabled: true } } },
    });
    for (const t of out) {
      if (!t.asset.enabled) await fail(t, 'asset_off');
      // Its due time, when it has one, is its time: a run that takes days is watched for days. Without one, a day.
      else if (t.dueAt ? t.dueAt <= now : t.updatedAt <= stale) await fail(t, t.dueAt ? 'expired' : 'timeout');
      else await send(RUN_QUEUE, t.id);
    }
    if (out.length < pageSize) break;
    after = out[out.length - 1]!.id;
    if (page === MAX_PAGES - 1) d.log?.(`tasks.tick: more than ${MAX_PAGES * pageSize} tasks are out; the rest wait for the next tick`);
  }

  // 3. Handed in, and not yet checked: Flint's own step, so a day without a result means it is not coming.
  const unchecked = await db.task.findMany({
    where: { OR: [{ status: 'submitted' }, { status: 'checking', metBar: null }, { status: 'checking', metBar: false }] },
    orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }], take: pageSize,
    select: { id: true, status: true, updatedAt: true },
  });
  for (const t of unchecked) {
    if (t.updatedAt <= stale) await fail(t, 'timeout');
    else await send(CHECK_QUEUE, t.id);
  }

  // 4. Passed, with no accept card waiting, approved or running. (One whose card waits is left to Will, and is not
  // read here at all.) Two reads, each of what needs one thing done, so neither kind waits behind the other:
  // a card he turned down, or let lapse, is his answer, and the wait ends; one with no such card is sent to its
  // check, which files one (again, when the last one failed).
  // (An accept card is the check's own, as check.ts reads it: one written under another origin is neither
  // waiting for him nor his answer when it lapses.)
  const theCheckFiled = Prisma.sql`p.action = ${ACCEPT_CARD.action} AND p.origin = ${ACCEPT_CARD.origin} AND p."templateId" = ${ACCEPT_CARD.templateId}`;
  const passedWithout = (declined: boolean) => db.$queryRaw<Array<{ id: string }>>`
    SELECT t.id FROM "Task" t
    WHERE t.status = 'checking' AND t."metBar" = true
      AND NOT EXISTS (
        SELECT 1 FROM "Proposal" p
        WHERE ${theCheckFiled} AND p.status IN ('pending', 'approved', 'executing') AND p.args->>'taskId' = t.id)
      AND ${declined} = EXISTS (
        SELECT 1 FROM "Proposal" p
        WHERE ${theCheckFiled} AND p.status IN ('rejected', 'expired') AND p.args->>'taskId' = t.id)
    ORDER BY t."updatedAt" ASC, t.id ASC LIMIT ${pageSize}`;
  for (const t of await passedWithout(true)) await fail({ id: t.id, status: 'checking' }, 'expired');
  for (const t of await passedWithout(false)) await send(CHECK_QUEUE, t.id);

  // 5. Forecasts of tasks that ended a day ago or more.
  if (await mayScore(db, now)) {
    const due = await db.$queryRaw<Array<{ id: string }>>`
      SELECT t.id FROM "Task" t JOIN "Prediction" p ON p.id = t."predictionId"
      WHERE t.status IN ('accepted', 'rejected', 'failed') AND t."completedAt" <= ${new Date(now.getTime() - OVERRIDE_WINDOW_MS)}
        AND p.status = 'open' AND p.domain = ${TASK_FORECAST.domain} AND p.type = ${TASK_FORECAST.type}
        AND NOT EXISTS (SELECT 1 FROM "Resolution" r WHERE r."predictionId" = p.id)
      ORDER BY t."completedAt" ASC LIMIT ${SCORES_PER_TICK}`;
    for (const t of due) {
      // One forecast the database will not take (its day is not up by the database's own clock, an override
      // landed first) is left for the next tick, said by its class: the others are still scored.
      try {
        if ((await db.$transaction((tx) => scoreTaskForecast(tx, t.id, now), RC)) === 'scored') {
          counts.scored += 1;
          d.log?.(taskLog(t.id, 'scored'));
        }
      } catch (err) {
        d.log?.(taskLog(t.id, 'not scored', failureClass(err)));
      }
    }
  }

  // 6. Forecasts of cancelled tasks, past their date: nothing will ever settle them.
  if (await mayExpire(db, now)) {
    const lapsed = await db.$queryRaw<Array<{ id: string }>>`
      SELECT t.id FROM "Task" t JOIN "Prediction" p ON p.id = t."predictionId"
      WHERE t.status = 'cancelled' AND p.status = 'open' AND p."resolveBy" < ${now}
        AND p.domain = ${TASK_FORECAST.domain} AND p.type = ${TASK_FORECAST.type} AND p."createdBy" = ${TASK_FORECAST.createdBy}
        AND NOT EXISTS (SELECT 1 FROM "Resolution" r WHERE r."predictionId" = p.id)
      ORDER BY p."resolveBy" ASC LIMIT ${SCORES_PER_TICK}`;
    for (const t of lapsed) {
      try {
        if (await db.$transaction((tx) => expireCancelledForecast(tx, t.id, now), RC)) {
          counts.ranOut += 1;
          d.log?.(taskLog(t.id, 'forecast ran out'));
        }
      } catch (err) {
        d.log?.(taskLog(t.id, 'forecast not run out', failureClass(err)));
      }
    }
  }
  return counts;
}
