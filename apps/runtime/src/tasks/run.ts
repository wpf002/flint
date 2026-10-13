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
 *  3. What the adapter gives back is read strictly before anything of it is
 *     used: exactly a result with its summary, a wait, or one of the failure
 *     classes there are, and a result that is plain data within a depth and a
 *     size. Anything else (nothing at all, bare words, a missing summary, a
 *     made-up class, a value that loops back on itself or throws when read)
 *     ends the task as `invalid`, told by a class and never by its text.
 *  4. A result is cleaned of what the database cannot store (a NUL, half a
 *     surrogate pair), checked against its template's shape and the database's
 *     size, stored once (always marked as outside text) under the digest the
 *     database computes for it, and the task moves to submitted under the
 *     reference that digest gives, with its bar check sent: one transaction.
 *     A result the database will not take ends the task the same way.
 *
 * A wait changes nothing: the tick sends the run again until the task's time
 * is up. Whatever an adapter does, this job ends the task or leaves it to wait:
 * it throws only for what another try can fix (a lost connection). Job data is
 * a task's id; a log line is `task <id>: <status> (<class>)`.
 */
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { TASK_FAILURES, TASK_OUTPUTS, TaskId, TaskSpec, entityRef, outputRefOf, redact, specItems, type TaskFailure } from '@flint/policy';
import type { Db, Tx } from '../db.js';
import { inTx, type Bus } from '../bus.js';
import { jsonbBytes } from '../jsonsize.js';
import { clip, wellFormedDeep } from '../sources/text.js';
import { failureClass, schemaSkew, sqlState } from '../dbcodes.js';
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
/** No template's result nests deeper than a list of parts with a list of refs each; this leaves room and stops well short of the stack. */
const OUTPUT_MAX_DEPTH = 12;
const OUTPUT_MAX_VALUES = 20_000;
/** A summary is cut to this before anything reads it, and to what is kept after. */
const SUMMARY_READ_CHARS = 4000;
const SUMMARY_KEPT_CHARS = 1000;

/**
 * What an adapter may give back, read strictly: exactly one of a result with
 * its summary, a wait, or a failure's class from the closed list. An adapter is
 * typed to return this; a local model's will sit behind one, so the type is
 * not taken on trust.
 */
const AdapterReturn = z.union([
  z.object({ output: z.record(z.string(), z.unknown()), summary: z.string() }).strict(),
  z.object({ wait: z.literal(true) }).strict(),
  z.object({ failure: z.enum(TASK_FAILURES) }).strict(),
]);
const Metered = z.object({ micros: z.number().int().min(0).max(1_000_000_000_000), estimate: z.boolean() }).strict();

/**
 * Is a value plain JSON data, no deeper than `OUTPUT_MAX_DEPTH` and no larger
 * than `OUTPUT_MAX_VALUES` values? A value that holds itself is deeper than any
 * depth, so it is refused too, and nothing here goes past the limit to find out.
 */
export function plainData(v: unknown, depth = 0, left = { values: OUTPUT_MAX_VALUES }): boolean {
  if (--left.values < 0 || depth > OUTPUT_MAX_DEPTH) return false;
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v !== 'object') return false;
  if (Array.isArray(v)) return v.every((x) => plainData(x, depth + 1, left));
  const proto = Object.getPrototypeOf(v) as unknown;
  if (proto !== Object.prototype && proto !== null) return false;
  return Object.values(v).every((x) => plainData(x, depth + 1, left));
}

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
  /** What the adapter gave is not a result: the task ends, told by a class of ours or an error's, never by any of its text. */
  const unusable = async (what: string): Promise<RunOutcome> => {
    d.log?.(taskLog(task.id, 'result unusable', what));
    return fail('invalid');
  };
  let given: unknown;
  try {
    given = await adapter.run(input);
  } catch (err) {
    // An adapter gives a failure's class; one that throws instead is a bug, told by its class only.
    d.log?.(taskLog(task.id, 'adapter threw', failureClass(err)));
    return fail('error');
  }
  // Read first, with nothing written while reading: whatever it is, the outcome is one of these four.
  type Read = { wait: true } | { failure: TaskFailure } | { unusable: string } | { body: string; summary: string; cost?: z.infer<typeof Metered> };
  let read: Read;
  try {
    read = await (async (): Promise<Read> => {
      const result = AdapterReturn.safeParse(given);
      if (!result.success) return { unusable: 'shape' };
      if ('wait' in result.data || 'failure' in result.data) return result.data;
      if (!plainData(result.data.output)) return { unusable: 'not plain data' };
      // An asset's words are outside text: what the database cannot store is taken out before anything reads them.
      const shaped = TASK_OUTPUTS[spec.data.template].safeParse(wellFormedDeep(result.data.output));
      if (!shaped.success) return { unusable: 'shape' };
      if (jsonbBytes(shaped.data) > OUTPUT_MAX_BYTES) return { unusable: 'size' };
      const summary = clip(redact(clip(result.data.summary, SUMMARY_READ_CHARS)), SUMMARY_KEPT_CHARS);
      // A spending asset says what the run cost, and whether that is an estimate, before the task can end.
      if (!task.asset.spends || !adapter.meter) return { body: JSON.stringify(shaped.data), summary };
      const metered = Metered.safeParse(await adapter.meter(input));
      return metered.success ? { body: JSON.stringify(shaped.data), summary, cost: metered.data } : { unusable: 'cost' };
    })();
  } catch (err) {
    // Reading it threw (a value that throws when read, an adapter's meter): the same end, by the error's class.
    read = { unusable: failureClass(err) };
  }
  if ('wait' in read) return 'waiting';
  if ('failure' in read) return fail(read.failure);
  if ('unusable' in read) return unusable(read.unusable);
  const { body, summary, cost } = read;
  let submitted: boolean;
  try {
    submitted = await db.$transaction(async (tx) => {
      const [row] = await tx.$queryRaw<Array<{ status: string }>>`SELECT status FROM "Task" WHERE id = ${task.id} FOR UPDATE`;
      if (!row || (row.status !== 'dispatched' && row.status !== 'running')) return false;
      // Its digest is the database's own, over the body as it stores it: computed in the write and read back. (The
      // database refuses any other, so a task's reference names what was really written.)
      const [stored] = await tx.$queryRaw<Array<{ sha256: string }>>`
        WITH o AS (SELECT ${body}::jsonb AS body)
        INSERT INTO "TaskOutput" ("taskId", body, sha256, tainted)
        SELECT ${task.id}, o.body, encode(sha256(convert_to(o.body::text, 'UTF8')), 'hex'), true FROM o
        RETURNING sha256`;
      await tx.task.update({
        where: { id: task.id },
        data: {
          status: 'submitted', outputRef: outputRefOf(stored!.sha256), outputSummary: summary, attempts: { increment: 1 },
          ...(cost ? { costUsd: new Prisma.Decimal(cost.micros).div(1_000_000), costIsEstimate: cost.estimate } : {}),
        },
      });
      // Its check, in this transaction: it is sent, or the result is not taken. (Without a bus, the tick sends it.)
      await d.bus?.boss.send(CHECK_QUEUE, { taskId: task.id }, { ...inTx(tx), singletonKey: task.id });
      return true;
    }, RC);
  } catch (err) {
    // The database would not take the result (a data, integrity, privilege or rule error): another try would only
    // be refused again, so the task ends here. Anything else (a lost connection, a conflict) is left to run again.
    const state = sqlState(err);
    if (!state || !/^(22|23|42|P0)/.test(state) || schemaSkew(state)) throw err;
    return unusable(failureClass(err));
  }
  if (!submitted) return 'skipped';
  d.log?.(taskLog(task.id, 'submitted'));
  return 'submitted';
}
