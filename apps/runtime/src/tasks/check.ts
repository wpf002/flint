/**
 * Checking a task's result against its bar (P5): the job a run sends once it
 * has handed a result in.
 *
 *  1. submitted -> checking.
 *  2. The rule checks, pure functions of the stored result (and of the items'
 *     clean state), then the bar, who checked it and its evidence, written
 *     once, with a decision on record that carries ids and counts only.
 *  3. A result that failed its bar is rejected: Flint's own record, which
 *     needs no signature.
 *  4. A result that passed is accepted only with its own successful check on
 *     record, and on Will's signed card (filed here, from runtime:tasks, with
 *     ids and counts only) until he promotes task.check_bar. Once he has, the
 *     proof and the acceptance are written here in one transaction.
 *
 * Checking runs in shadow at APPROVAL: it computes and files, and accepts
 * nothing on its own word. A rule that forbids task.check_bar stops it.
 */
import { Prisma } from '@prisma/client';
import { ACCEPT_TEMPLATE, Acceptance, TASKS_ORIGIN, TaskSpec, evaluateChecks, resolveTier, runsInShadow, specItems, type CheckFinding } from '@flint/policy';
import type { Db } from '../db.js';
import { appendAudit } from '../governance/audit.js';
import { activePolicies, createProposal } from '../governance/proposals.js';
import { sqlState } from '../dbcodes.js';
import { countsOf, endingCost, writeProof } from './card.js';
import { taskLog } from './errors.js';
import { failTask, itemFacts, type TaskJob } from './run.js';

/** How long an accept card waits for Will. */
const CARD_TTL_MINUTES = 7 * 24 * 60;
/** Who a rule check is by, as the task's row and its accept card say it. */
export const RULE_CHECKER = 'flint:rule';

export interface CheckDeps {
  db: Db;
  now?: () => Date;
  log?: (msg: string) => void;
}

const RC = { maxWait: 10_000, timeout: 20_000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted } as const;

/** Where checking stands: promoted (Flint accepts a passing result itself), in shadow (it files the accept card), or stopped by a rule. */
export async function checkStanding(db: Db, now: Date): Promise<'alone' | 'shadow' | 'stopped'> {
  const t = resolveTier('task.check_bar', { context: 'autonomous', tainted: false, policies: await activePolicies(db, now), now });
  return t.tier === 'alone' ? 'alone' : t.tier === 'approval' && runsInShadow('task.check_bar') ? 'shadow' : 'stopped';
}

/** The accept card of a task that is waiting, approved or running, if there is one. */
export async function liveAcceptCard(db: Db, taskId: string): Promise<string | undefined> {
  const p = await db.proposal.findFirst({
    where: { action: 'task.check_bar', status: { in: ['pending', 'approved', 'executing'] }, args: { path: ['taskId'], equals: taskId } },
    select: { id: true },
  });
  return p?.id;
}

export type CheckOutcome = 'skipped' | 'stopped' | 'rejected' | 'accepted' | 'filed' | 'waiting' | 'failed';

/** Check one task's result. Safe to run again: each step looks at where the task stands first. */
export async function checkTaskJob(d: CheckDeps, job: TaskJob): Promise<CheckOutcome> {
  const { db } = d;
  const now = d.now?.() ?? new Date();
  let task = await db.task.findUnique({ where: { id: job.taskId }, include: { asset: { select: { spends: true } }, output: true } });
  if (!task || (task.status !== 'submitted' && task.status !== 'checking')) return 'skipped';
  const standing = await checkStanding(db, now);
  if (standing === 'stopped') return 'stopped';
  if (task.status === 'submitted') {
    await db.$transaction((tx) => tx.task.updateMany({ where: { id: job.taskId, status: 'submitted' }, data: { status: 'checking' } }), RC);
  }

  if (task.metBar === null) {
    const spec = TaskSpec.safeParse(task.spec);
    const acceptance = Acceptance.safeParse(task.acceptance);
    // A task whose spec, bar or result cannot be read is not checked on a guess: it fails, as unusable.
    if (!spec.success || !acceptance.success || !task.output) return (await failTask(db, task.id, ['checking'], 'invalid', d.log)) ? 'failed' : 'skipped';
    const items = await itemFacts(db, [...new Set([...specItems(spec.data), ...acceptance.data.flatMap((a) => (a.check.type === 'deterministic' && a.check.op === 'item' ? [a.check.entityId] : []))])]);
    const given = new Set(specItems(spec.data));
    const { findings, metBar } = evaluateChecks(spec.data, acceptance.data, task.output.body, {
      refs: items.filter((i) => given.has(i.id)).map((i) => i.ref),
      items: Object.fromEntries(items.map((i) => [i.id, { kind: i.kind, state: i.state }])),
    });
    const met = findings.filter((f) => f.met === true).length;
    const wrote = await db.$transaction(async (tx) => {
      // The bar, who checked it and its evidence in one write, while it is being checked and has none yet.
      const r = await tx.task.updateMany({
        where: { id: job.taskId, status: 'checking', metBar: null },
        data: { metBar, barCheckedBy: RULE_CHECKER, barEvidence: findings as unknown as Prisma.InputJsonArray },
      });
      if (r.count === 0) return false;
      await appendAudit(tx, [{
        actor: TASKS_ORIGIN, context: 'autonomous', kind: 'decision', action: 'task.check_bar', tier: standing === 'alone' ? 'alone' : 'approval', decision: 'log', outcome: 'ok',
        inputs: { taskId: job.taskId, checks: findings.length, met, by: RULE_CHECKER }, correlationId: `task:${job.taskId}`, tainted: false,
      }], now);
      // Failed its bar: rejected, Flint's own record.
      if (!metBar) await tx.task.update({ where: { id: job.taskId }, data: { status: 'rejected', ...endingCost(task!, task!.asset.spends) } });
      return true;
    }, RC);
    if (wrote && !metBar) {
      d.log?.(taskLog(job.taskId, 'rejected', `${met} of ${findings.length}`));
      return 'rejected';
    }
    task = await db.task.findUnique({ where: { id: job.taskId }, include: { asset: { select: { spends: true } }, output: true } });
  }
  if (!task || task.status !== 'checking' || task.metBar !== true) return 'skipped';
  return settle(d, task, standing, now);
}

type Passed = NonNullable<Awaited<ReturnType<Db['task']['findUnique']>>> & { asset: { spends: boolean } };

/** A result that passed its bar: accepted here once Will has promoted that, otherwise offered to him on a card. */
async function settle(d: CheckDeps, task: Passed, standing: 'alone' | 'shadow', now: Date): Promise<CheckOutcome> {
  const { db } = d;
  const counts = countsOf(task.barEvidence as CheckFinding[] | null);
  if (standing === 'alone') {
    try {
      const accepted = await db.$transaction(async (tx) => {
        const [row] = await tx.$queryRaw<Array<{ status: string }>>`SELECT status FROM "Task" WHERE id = ${task.id} FOR UPDATE`;
        if (row?.status !== 'checking') return false;
        const proof = await writeProof(tx, { taskId: task.id, action: 'task.check_bar', actor: TASKS_ORIGIN, context: 'autonomous', tier: 'alone', inputs: { checks: counts.total, met: counts.met, by: task.barCheckedBy } }, now);
        await tx.task.update({ where: { id: task.id }, data: { status: 'accepted', acceptedAuditId: proof, ...endingCost(task, task.asset.spends) } });
        return true;
      }, RC);
      if (accepted) d.log?.(taskLog(task.id, 'accepted', 'alone'));
      return accepted ? 'accepted' : 'skipped';
    } catch (err) {
      // The database holds accepting alone to its own reading of Will's policy rows. Where it is stricter
      // than the tier engine (a row with a scope), the result still reaches him: on a card.
      if (sqlState(err) !== '42501') throw err;
    }
  }
  if (await liveAcceptCard(db, task.id)) return 'waiting';
  // One that Will turned down, or let expire, is his answer for now: it is not filed again (the tick ends the task).
  if (await db.proposal.findFirst({ where: { action: 'task.check_bar', status: { in: ['rejected', 'expired', 'failed'] }, args: { path: ['taskId'], equals: task.id } }, select: { id: true } })) return 'waiting';
  await createProposal(db, {
    kind: 'task', origin: TASKS_ORIGIN, action: 'task.check_bar', templateId: ACCEPT_TEMPLATE,
    args: { taskId: task.id, checks: counts.total, met: counts.met, by: task.barCheckedBy },
    // checkTaskCard sets where the args came from (the template), the fixed reason and the sensitivity (the task's).
    argsProvenance: {}, tainted: false, sensitivity: 'ops', destructive: false, consequential: false, ttlMinutes: CARD_TTL_MINUTES,
  }, TASKS_ORIGIN, now);
  d.log?.(taskLog(task.id, 'checking', 'accept card filed'));
  return 'filed';
}
