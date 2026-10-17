/**
 * What P5's exit report and its promotion table count (report/p5.ts,
 * governance/promotion.ts). Counts only: never a task's title, its words, its
 * result or an id.
 */
import { ALONE_CAPS, CODE_TABLE, ACCEPT_TEMPLATE, PAID_DISPATCH, TASKS_ORIGIN, type Cap } from '@flint/policy';
import type { Db } from '../db.js';

const n = (rows: Array<{ n: bigint | number | null }>) => Number(rows[0]?.n ?? 0);

/** Tasks that went out, and how many of those went out with no signed card behind them. */
export async function dispatchedTasks(db: Db): Promise<{ went: number; unsigned: number }> {
  const went = await db.task.count({ where: { dispatchedAt: { not: null } } });
  const unsigned = await db.task.count({ where: { dispatchedAt: { not: null }, dispatchApprovalId: null } });
  return { went, unsigned };
}

/**
 * Accepted tasks, and how many were accepted with neither a passing check nor
 * Will's signed Accept Anyway (a task.bar_override to accepted that ran).
 */
export async function acceptedTasks(db: Db): Promise<{ accepted: number; unearned: number }> {
  const accepted = await db.task.count({ where: { status: 'accepted' } });
  const unearned = n(await db.$queryRaw<Array<{ n: bigint }>>`
    SELECT count(*) AS n FROM "Task" t
    WHERE t.status = 'accepted' AND t."metBar" IS DISTINCT FROM true
      AND NOT EXISTS (SELECT 1 FROM "Proposal" p WHERE p.action = 'task.bar_override' AND p.status = 'executed'
                      AND p.args->>'taskId' = t.id AND p.args->>'to' = 'accepted')`);
  return { accepted, unearned };
}

/** The P5 actions with a daily limit, and the limit: the code table's, and accepting alone's (ALONE_CAPS). */
export function p5Caps(): Array<{ action: string; cap: Cap }> {
  const out: Array<{ action: string; cap: Cap }> = [];
  for (const action of ['task.dispatch.local_worker', 'task.dispatch.ci_runner', 'review.local']) {
    const cap = CODE_TABLE[action]?.cap;
    if (cap) out.push({ action, cap });
  }
  for (const [action, cap] of Object.entries(ALONE_CAPS)) out.push({ action, cap });
  return out;
}

/** Days counted under each P5 limit, and the days any went past it (the database's claim_action never lets one). */
export async function capsKept(db: Db): Promise<{ days: number; over: number; busiest: number }> {
  const caps = p5Caps();
  const rows = await db.actionCounter.findMany({ where: { action: { in: caps.map((c) => c.action) } } });
  let over = 0;
  let busiest = 0;
  for (const r of rows) {
    const cap = caps.find((c) => c.action === r.action)!.cap;
    if (r.count > cap.limit) over += 1;
    busiest = Math.max(busiest, r.count / cap.limit);
  }
  return { days: rows.length, over, busiest };
}

/** What tasks cost: the dollars recorded on them, and paid dispatches that ran. */
export async function taskSpend(db: Db): Promise<{ tasks: number; costUsd: number; paidRan: number }> {
  const tasks = await db.task.count();
  const sum = await db.task.aggregate({ _sum: { costUsd: true } });
  const paidRan = await db.proposal.count({ where: { action: PAID_DISPATCH, status: { in: ['executing', 'executed'] } } });
  return { tasks, costUsd: Number(sum._sum.costUsd ?? 0), paidRan };
}

/**
 * Cards approved that needed a review, since `since`, and how many had their
 * review first (review_coverage); and the cards approved without one since
 * reviews were last required (review_gate_violations, which must stay empty).
 * `required` is whether reviews have ever been required (the gate has an approval behind it).
 */
export async function reviewCoverage(db: Db, since: Date): Promise<{ approved: number; reviewedFirst: number; violations: number; required: boolean; requiredNow: boolean }> {
  const [c] = await db.$queryRaw<Array<{ approved: bigint; first: bigint }>>`
    SELECT count(*) AS approved, count(*) FILTER (WHERE "reviewedFirst") AS first FROM review_coverage WHERE "approvedAt" >= ${since}`;
  const violations = n(await db.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM review_gate_violations`);
  const gate = await db.reviewGate.findUnique({ where: { id: 'proposal' }, select: { enforced: true, approvalId: true } });
  return { approved: Number(c?.approved ?? 0), reviewedFirst: Number(c?.first ?? 0), violations, required: !!gate?.approvalId, requiredNow: gate?.enforced === true };
}

/** Cards filed since `since` that needed a review, how many have one, and how the reviews came out. */
export async function reviewsWritten(db: Db, since: Date): Promise<{ needed: number; reviewed: number; agreed: number; verdicts: Record<string, number> }> {
  const needed = await db.proposal.count({ where: { reviewRequired: true, createdAt: { gte: since } } });
  const reviewed = await db.proposal.count({ where: { reviewRequired: true, createdAt: { gte: since }, reviewId: { not: null } } });
  const reviews = await db.review.findMany({ where: { subjectType: 'proposal', createdAt: { gte: since } }, select: { verdict: true, agreed: true } });
  const verdicts: Record<string, number> = { proceed: 0, proceed_with_changes: 0, block: 0 };
  for (const r of reviews) verdicts[r.verdict] = (verdicts[r.verdict] ?? 0) + 1;
  return { needed, reviewed, agreed: reviews.filter((r) => r.agreed).length, verdicts };
}

/** Whether Local Reviews has ever been turned on (its turn-on card ran). */
export async function reviewerEverOn(db: Db): Promise<boolean> {
  const on = await db.asset.findFirst({ where: { kind: 'local_reviewer', approvalId: { not: null } }, select: { id: true } });
  return !!on;
}

/**
 * The accept cards Flint's checks filed since `since` (a result that passed its checks, waiting for Will) and what
 * he did with them; and his Accept Anyway and Reject Anyway since then, each a call against the check.
 */
export async function acceptCards(db: Db, since: Date): Promise<{ filed: number; accepted: number; rejected: number; expired: number; acceptedAnyway: number; rejectedAnyway: number }> {
  const cards = await db.proposal.groupBy({ by: ['status'], where: { action: 'task.check_bar', origin: TASKS_ORIGIN, templateId: ACCEPT_TEMPLATE, createdAt: { gte: since } }, _count: { _all: true } });
  const of = (st: string) => cards.find((c) => c.status === st)?._count._all ?? 0;
  const overrides = await db.proposal.findMany({ where: { action: 'task.bar_override', status: 'executed', createdAt: { gte: since } }, select: { args: true } });
  const to = (w: string) => overrides.filter((o) => (o.args as { to?: unknown } | null)?.to === w).length;
  return {
    filed: cards.reduce((s, c) => s + c._count._all, 0), accepted: of('executed'), rejected: of('rejected'), expired: of('expired'),
    acceptedAnyway: to('accepted'), rejectedAnyway: to('rejected'),
  };
}

/** When Flint's checks first filed an accept card: P5's promotion week runs from there. */
export async function firstAcceptCard(db: Db): Promise<Date | undefined> {
  return (await db.proposal.findFirst({ where: { action: 'task.check_bar', origin: TASKS_ORIGIN, templateId: ACCEPT_TEMPLATE }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }))?.createdAt;
}
