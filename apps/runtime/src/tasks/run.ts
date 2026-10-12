/**
 * Running a task on its asset (P5): the job a dispatch sends, and the tick
 * sends again while a task is still out.
 *
 *  1. queued -> dispatched (the database stamps the time, and refuses when the
 *     asset has been turned off: the task then fails as `asset_off`).
 *  2. The adapter, a pure function: it gets the signed spec and the items it
 *     names (their refs, kinds and clean state fields only) and gives back a
 *     result, a wait, or a failure's class. Any call it makes sits outside
 *     every transaction.
 *  3. A result is checked against its template's shape and the database's
 *     size, stored once (always marked as outside text), and the task moves to
 *     submitted with its bar check sent, all in one transaction.
 *
 * A wait changes nothing: the tick sends the run again until the task's time
 * is up. Job data is a task's id; a log line is `task <id>: <status> (<class>)`.
 */
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { TASK_OUTPUTS, TaskId, TaskSpec, digestOf, entityRef, redact, specItems, type TaskFailure } from '@flint/policy';
import type { Db, Tx } from '../db.js';
import { inTx, type Bus } from '../bus.js';
import { jsonbBytes } from '../jsonsize.js';
import { failureClass, sqlState } from '../dbcodes.js';
import { ciWatch } from './adapters/ci-watch.js';
import type { AdapterSet, ItemFact } from './adapters/types.js';
import { endingCost } from './card.js';
import { taskLog } from './errors.js';

export const CHECK_QUEUE = 'tasks.check';
/** A task job's data: the task's id, and nothing of its words. */
export const TaskJob = z.object({ taskId: TaskId }).strict();
export type TaskJob = z.infer<typeof TaskJob>;

/** The adapters there are. A spending one is not among them: none is built. */
export const ADAPTERS: AdapterSet = { ci_runner: ciWatch };

export interface RunDeps {
  db: Db;
  bus?: Pick<Bus, 'boss'> | undefined;
  adapters?: AdapterSet;
  now?: () => Date;
  log?: (msg: string) => void;
}

const RC = { maxWait: 10_000, timeout: 20_000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted } as const;
const OUTPUT_MAX_BYTES = 32_768;

/**
 * The items a spec names, as an adapter may see them, in the spec's order:
 * each one's ref, kind and clean state fields. A field someone else's text
 * reached (the item's tainted paths) is left out, and so is any value that is
 * not a number, a flag or a short structural word. A forgotten item is gone.
 */
export async function itemFacts(db: Db | Tx, ids: readonly string[]): Promise<ItemFact[]> {
  const rows = ids.length ? await db.entity.findMany({ where: { id: { in: [...ids] }, status: { not: 'forgotten' } }, select: { id: true, kind: true, state: true, taintedPaths: true } }) : [];
  const facts = rows.map((e) => {
    const state: Record<string, string | number | boolean | null> = {};
    for (const [k, v] of Object.entries((e.state ?? {}) as Record<string, unknown>)) {
      if (e.taintedPaths.includes(`state.${k}`)) continue;
      if (v === null || typeof v === 'number' || typeof v === 'boolean' || (typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(v))) state[k] = v;
    }
    return { id: e.id, ref: entityRef(e.kind, e.id), kind: e.kind, state };
  });
  return ids.map((id) => facts.find((f) => f.id === id)).filter((f): f is ItemFact => f !== undefined);
}

/**
 * End a task that is still out as failed, with why as a class. Only from one
 * of `from` (someone else may have moved it on: then nothing is written).
 */
export async function failTask(db: Db, id: string, from: readonly string[], failure: TaskFailure, log?: (msg: string) => void): Promise<boolean> {
  const done = await db.$transaction(async (tx) => {
    const [row] = await tx.$queryRaw<Array<{ status: string }>>`SELECT status FROM "Task" WHERE id = ${id} FOR UPDATE`;
    if (!row || !from.includes(row.status)) return false;
    const t = await tx.task.findUniqueOrThrow({ where: { id }, select: { dispatchedAt: true, costUsd: true, estCostUsd: true, asset: { select: { spends: true } } } });
    await tx.task.update({ where: { id }, data: { status: 'failed', failure, ...endingCost(t, t.asset.spends) } });
    return true;
  }, RC);
  if (done) log?.(taskLog(id, 'failed', failure));
  return done;
}

export type RunOutcome = 'skipped' | 'waiting' | 'submitted' | 'failed';

/** Run one task's job. Safe to run again: each step looks at where the task stands first. */
export async function runTaskJob(d: RunDeps, job: TaskJob): Promise<RunOutcome> {
  const { db } = d;
  const now = d.now?.() ?? new Date();
  const out = ['queued', 'dispatched', 'running'];
  const fail = async (failure: TaskFailure): Promise<RunOutcome> => ((await failTask(db, job.taskId, out, failure, d.log)) ? 'failed' : 'skipped');
  const task = await db.task.findUnique({ where: { id: job.taskId }, include: { asset: true } });
  if (!task || !out.includes(task.status)) return 'skipped';
  if (!task.asset.enabled) return fail('asset_off');
  if (task.status === 'queued') {
    try {
      // The database stamps dispatchedAt, and refuses this move for an asset turned off since the read above.
      const moved = await db.$transaction((tx) => tx.task.updateMany({ where: { id: task.id, status: 'queued' }, data: { status: 'dispatched' } }), RC);
      if (moved.count === 0) return 'skipped';
    } catch (err) {
      if (sqlState(err) === '42501') return fail('asset_off');
      throw err;
    }
  }
  const spec = TaskSpec.safeParse(task.spec);
  const adapter = (d.adapters ?? ADAPTERS)[task.asset.kind as keyof AdapterSet];
  if (!spec.success) return fail('invalid');
  if (!adapter) return fail('error');
  const input = { taskId: task.id, spec: spec.data, items: await itemFacts(db, specItems(spec.data)), now };
  let result: Awaited<ReturnType<typeof adapter.run>>;
  try {
    result = await adapter.run(input);
  } catch (err) {
    // An adapter gives a failure's class; one that throws instead is a bug, told by its class only.
    d.log?.(taskLog(task.id, 'adapter threw', failureClass(err)));
    return fail('error');
  }
  if ('wait' in result) return 'waiting';
  if ('failure' in result) return fail(result.failure);
  const shaped = TASK_OUTPUTS[spec.data.template].safeParse(result.output);
  if (!shaped.success || jsonbBytes(shaped.data) > OUTPUT_MAX_BYTES) return fail('invalid');
  const body = shaped.data as Prisma.InputJsonObject;
  const sha256 = digestOf(body);
  // A spending asset says what the run cost, and whether that is an estimate, before the task can end.
  const cost = task.asset.spends ? await adapter.meter?.(input) : undefined;
  const submitted = await db.$transaction(async (tx) => {
    const [row] = await tx.$queryRaw<Array<{ status: string }>>`SELECT status FROM "Task" WHERE id = ${task.id} FOR UPDATE`;
    if (!row || (row.status !== 'dispatched' && row.status !== 'running')) return false;
    await tx.taskOutput.create({ data: { taskId: task.id, body, sha256, tainted: true } });
    await tx.task.update({
      where: { id: task.id },
      data: {
        status: 'submitted', outputRef: `out:${sha256.slice(0, 16)}`, outputSummary: redact(result.summary).slice(0, 1000), attempts: { increment: 1 },
        ...(cost ? { costUsd: new Prisma.Decimal(cost.micros).div(1_000_000), costIsEstimate: cost.estimate } : {}),
      },
    });
    // Its check, in this transaction: it is sent, or the result is not taken. (Without a bus, the tick sends it.)
    await d.bus?.boss.send(CHECK_QUEUE, { taskId: task.id }, { ...inTx(tx), singletonKey: task.id });
    return true;
  }, RC);
  if (!submitted) return 'skipped';
  d.log?.(taskLog(task.id, 'submitted'));
  return 'submitted';
}
