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
 *     record, and on Will's signed card (filed here, from runtime:tasks, once
 *     the result is handed in: it names that result, and carries ids and
 *     counts only) until he promotes task.check_bar. Once he has, the proof
 *     and the acceptance are written here in one transaction.
 *  5. An accept card that did not run (he signed something newer about the
 *     task, a rule stopped it, the database refused it) is asked for again,
 *     unless he has turned one down or let one lapse: of his cards about one
 *     task, only the latest acts, and only his own answer ends the wait.
 *  6. Accepting alone has a daily cap the code holds (the tier engine's
 *     ALONE_CAPS). Past it, a passing result goes to him on a card like any
 *     other.
 *
 * Checking runs in shadow at APPROVAL: it computes and files, and accepts
 * nothing on its own word. A rule that forbids task.check_bar stops it.
 */
import { Prisma } from '@prisma/client';
import { ACCEPT_TEMPLATE, Acceptance, TASKS_ORIGIN, TaskSpec, evaluateChecks, resolveTier, runsInShadow, specItems, type Cap, type CheckFinding } from '@flint/policy';
import type { Db } from '../db.js';
import { appendAudit } from '../governance/audit.js';
import { activePolicies, createProposal } from '../governance/proposals.js';
import { claim } from '../governance/counters.js';
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
  /** Will's time zone: the day the cap on accepting alone is counted in. */
  tz?: string;
  now?: () => Date;
  log?: (msg: string) => void;
}

const RC = { maxWait: 10_000, timeout: 20_000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted } as const;

export type Standing = 'alone' | 'shadow' | 'stopped';

/**
 * Where checking stands: promoted (Flint accepts a passing result itself, up
 * to the day's cap), in shadow (it files the accept card), or stopped by a
 * rule. Promoted always comes with a cap (the tier engine's own, which a rule
 * of Will's can only lower); a reading without one is taken as shadow.
 */
export async function checkTier(db: Db, now: Date): Promise<{ standing: Standing; alone?: { key: string; cap: Cap } }> {
  const t = resolveTier('task.check_bar', { context: 'autonomous', tainted: false, policies: await activePolicies(db, now), now });
  if (t.tier === 'alone' && t.cap) return { standing: 'alone', alone: { key: t.key, cap: t.cap } };
  return { standing: t.tier === 'forbidden' || !runsInShadow('task.check_bar') ? 'stopped' : 'shadow' };
}
export const checkStanding = async (db: Db, now: Date): Promise<Standing> => (await checkTier(db, now)).standing;

/** The accept card of a task that is waiting, approved or running, if there is one. */
export async function liveAcceptCard(db: Db, taskId: string): Promise<string | undefined> {
  const p = await db.proposal.findFirst({
    where: { action: 'task.check_bar', status: { in: ['pending', 'approved', 'executing'] }, args: { path: ['taskId'], equals: taskId } },
    select: { id: true },
  });
  return p?.id;
}

/**
 * Has Will turned this task's accept card down, or let one lapse? That is his
 * answer for now: none is filed again. Only those two count. A card that
 * failed, for whatever reason (he signed something newer about the task, a
 * rule of his stopped it after he approved it, the database refused it), is
 * not an answer about the result: the task keeps waiting, and is offered to
 * him again.
 */
export async function acceptDeclined(db: Db, taskId: string): Promise<boolean> {
  const dead = await db.proposal.findFirst({
    where: { action: 'task.check_bar', args: { path: ['taskId'], equals: taskId }, status: { in: ['rejected', 'expired'] } },
    select: { id: true },
  });
  return dead !== null;
}

export type CheckOutcome = 'skipped' | 'stopped' | 'rejected' | 'accepted' | 'filed' | 'waiting' | 'failed';

/** Check one task's result. Safe to run again: each step looks at where the task stands first. */
export async function checkTaskJob(d: CheckDeps, job: TaskJob): Promise<CheckOutcome> {
  const { db } = d;
  const now = d.now?.() ?? new Date();
  let task = await db.task.findUnique({ where: { id: job.taskId }, include: { asset: { select: { spends: true } }, output: true } });
  if (!task || (task.status !== 'submitted' && task.status !== 'checking')) return 'skipped';
  const { standing, alone } = await checkTier(db, now);
  if (standing === 'stopped') return 'stopped';
  // A task whose result is not on record under the reference it was handed in with is not checked on a guess: it
  // fails, as unusable. (The database refuses to check one, too.)
  const unusable = async (): Promise<CheckOutcome> => ((await failTask(db, job.taskId, ['submitted', 'checking'], 'invalid', d.log)) ? 'failed' : 'skipped');
  if (!task.output || !task.outputRef?.startsWith('out:') || !task.output.sha256.startsWith(task.outputRef.slice(4))) return unusable();
  if (task.status === 'submitted') {
    try {
      await db.$transaction((tx) => tx.task.updateMany({ where: { id: job.taskId, status: 'submitted' }, data: { status: 'checking' } }), RC);
    } catch (err) {
      if (sqlState(err) === '42501') return unusable();
      throw err;
    }
  }

  if (task.metBar === null) {
    const spec = TaskSpec.safeParse(task.spec);
    const acceptance = Acceptance.safeParse(task.acceptance);
    // A task whose spec or bar cannot be read is not checked on a guess either.
    if (!spec.success || !acceptance.success) return unusable();
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
  return settle(d, task, alone, now);
}

type Passed = NonNullable<Awaited<ReturnType<Db['task']['findUnique']>>> & { asset: { spends: boolean } };

/**
 * A result that passed its bar: accepted here once Will has promoted that (and
 * while the day's cap on accepting alone has room), otherwise offered to him
 * on a card.
 */
async function settle(d: CheckDeps, task: Passed, alone: { key: string; cap: Cap } | undefined, now: Date): Promise<CheckOutcome> {
  const { db } = d;
  const counts = countsOf(task.barEvidence as CheckFinding[] | null);
  if (alone) {
    try {
      const accepted = await db.$transaction(async (tx) => {
        const [row] = await tx.$queryRaw<Array<{ status: string }>>`SELECT status FROM "Task" WHERE id = ${task.id} FOR UPDATE`;
        if (row?.status !== 'checking') return 'moved' as const;
        // One of the day's places for accepting alone, taken with the acceptance or not at all.
        if ((await claim(tx, alone.key, alone.cap, d.tz ?? 'UTC', now)) === null) return 'capped' as const;
        const proof = await writeProof(tx, { taskId: task.id, action: 'task.check_bar', actor: TASKS_ORIGIN, context: 'autonomous', tier: 'alone', inputs: { checks: counts.total, met: counts.met, by: task.barCheckedBy } }, now);
        await tx.task.update({ where: { id: task.id }, data: { status: 'accepted', acceptedAuditId: proof, ...endingCost(task, task.asset.spends) } });
        return 'accepted' as const;
      }, RC);
      if (accepted === 'accepted') d.log?.(taskLog(task.id, 'accepted', 'alone'));
      if (accepted !== 'capped') return accepted === 'accepted' ? 'accepted' : 'skipped';
      // Past the cap, the result still reaches Will: on a card, like any other.
    } catch (err) {
      // The database holds accepting alone to its own reading of Will's policy rows. Where it is stricter
      // than the tier engine (a row with a scope), the result still reaches him: on a card.
      if (sqlState(err) !== '42501') throw err;
    }
  }
  if (await liveAcceptCard(db, task.id)) return 'waiting';
  // One that Will turned down, or let expire, is his answer for now: none is filed again (the tick ends the task).
  // One that failed is no answer: a new one is filed.
  if (await acceptDeclined(db, task.id)) return 'waiting';
  // Filed now that the result is handed in (the database takes an accept card only if he signed it after that),
  // naming the result it accepts and that it met its bar.
  await createProposal(db, {
    kind: 'task', origin: TASKS_ORIGIN, action: 'task.check_bar', templateId: ACCEPT_TEMPLATE,
    args: { taskId: task.id, outputRef: task.outputRef, metBar: true, checks: counts.total, met: counts.met, by: task.barCheckedBy },
    // checkTaskCard sets where the args came from (the template), the fixed reason and the sensitivity (the task's).
    argsProvenance: {}, tainted: false, sensitivity: 'ops', destructive: false, consequential: false, ttlMinutes: CARD_TTL_MINUTES,
  }, TASKS_ORIGIN, now);
  d.log?.(taskLog(task.id, 'checking', 'accept card filed'));
  return 'filed';
}
