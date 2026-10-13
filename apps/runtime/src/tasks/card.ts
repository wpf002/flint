/**
 * Asset and task cards, carried out (P5): turning an asset on, requiring
 * reviews, sending a task out, accepting a result that passed its checks,
 * cancelling a task, and overruling a check. A card is:
 *  - checked when it is filed (checkTaskCard): never from chat; its args
 *    against the shared contract, normalized so what Will signs is what the
 *    database compares; the asset and the task as they stand. Its reason is a
 *    fixed sentence. One that could not apply, or would change nothing, is
 *    never filed.
 *  - carried out in ONE transaction at READ COMMITTED (runTask): the claim
 *    (signature checked again, tier, cap, intent), the guarded writes, and the
 *    card's completion. A crash anywhere leaves nothing changed and the card
 *    approved.
 * The database checks every write against the executing card it names
 * (migration p5_assets): an asset turns on only as the card signed what it is,
 * a task goes out only as the task the card signed, with its forecast on
 * record, and is accepted only with its result and its own successful check on
 * record, on a card that names that result. Of two cards Will signed about the
 * same asset, task or gate, only the later one acts. The checks here come
 * first so that Will reads a sentence, not a refusal.
 *
 * A card whose subject he had Flint forget (its args are gone) does not run:
 * it fails with a sentence and no result.
 *
 * Results, audit entries, log lines and errors carry ids, classes and counts,
 * never a task's title, spec or result.
 */
import { Prisma } from '@prisma/client';
import {
  ACCEPT_TEMPLATE,
  AUTONOMOUS_ACTIONS,
  AssetEnableArgs,
  PAID_DISPATCH,
  ReviewEnforceArgs,
  TASKS_ORIGIN,
  TASK_CARD_KIND,
  TASK_REASONS,
  TASK_WILL_ONLY,
  TaskAcceptArgs,
  TaskCancelArgs,
  TaskDispatchArgs,
  TaskOverrideArgs,
  digestOf,
  isTaskCard,
  isTaskDispatch,
  isTaskSignedAction,
  type WebAuthnRelyingParty,
} from '@flint/policy';
import type { z } from 'zod';
import type { Db, Tx } from '../db.js';
import { inTx, type Bus } from '../bus.js';
import { appendAudit } from '../governance/audit.js';
import { Refused, claimIn, completeIn, contextOf, type CreateProposal } from '../governance/proposals.js';
import { dbRefused, failureOf, failureReport, schemaSkew, sqlState } from '../dbcodes.js';
import { GoalFailure, sanitize } from '../goals/errors.js';
import { failApproved } from '../goals/apply.js';
import { ASSETS, assetDef, sameAsset, type AssetDef } from '../assets/registry.js';
import { enableProblem } from '../assets/service.js';
import { SAY, taskStatusWords } from './errors.js';
import { recordForecast } from './forecast.js';

/** The queue a dispatched task's run is sent to. */
export const RUN_QUEUE = 'tasks.run';

export interface TaskCardDeps {
  /** True only while tasks and assets are switched on (FLINT_ASSETS=on); otherwise no card runs. */
  assets?: boolean;
  /** The assets there are (the code registry). */
  registry?: readonly AssetDef[];
  /** The bus, to send a dispatched task's run in the card's own transaction; without it the tick sends it. */
  bus?: Pick<Bus, 'boss'> | undefined;
  /**
   * A spending asset's dispatch asks for its money first (millionths of a
   * dollar). No paid path is built, so there is nothing to ask: absent, the
   * answer is no, and the card fails saying paid tasks are off.
   */
  reserve?: (micros: number) => Promise<boolean>;
}

/** A provenance ref on a card is an id: a proposal's provenance is kept for good. */
const PROVENANCE_REF = /^[A-Za-z0-9_.:@-]{1,120}$/;
const STILL_OUT = ['queued', 'dispatched', 'running', 'submitted', 'checking'];

/** A zod error as paths and codes (a message of ours, never a value): it is logged under a ref, not shown. */
function issuesOf(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join('.') || '<args>'}: ${i.code === 'custom' ? i.message : i.code}`).join('; ').slice(0, 500);
}

type TaskRow = NonNullable<Awaited<ReturnType<Tx['task']['findUnique']>>>;
/** A task's estimate in millionths of a dollar (it is kept to four decimal places of a dollar). */
export const microsOf = (usd: Prisma.Decimal | number | null): number => Math.round(Number(usd ?? 0) * 1_000_000);

/** Is the task's row exactly what a dispatch card's args say (what the database compares, said first as a sentence)? */
function sameTask(t: TaskRow, a: TaskDispatchArgs): boolean {
  return t.id === a.taskId && t.assetId === a.assetId && t.title === a.title && t.goalId === a.goalId && t.stepKey === a.stepKey
    && (t.dueAt?.toISOString() ?? null) === a.dueAt && t.sensitivity === a.sensitivity && t.tainted === a.tainted && microsOf(t.estCostUsd) === a.estCostMicros
    && t.spec !== null && t.acceptance !== null && digestOf(t.spec) === digestOf(a.spec) && digestOf(t.acceptance) === digestOf(a.acceptance);
}

/** How many checks a bar's evidence holds, and how many were met. */
export function countsOf(evidence: unknown): { total: number; met: number } {
  const rows = Array.isArray(evidence) ? (evidence as Array<{ met?: unknown }>) : [];
  return { total: rows.length, met: rows.filter((r) => r?.met === true).length };
}

/**
 * Why Will cannot end a task against its check this way, or undefined. His
 * override corrects what Flint accepted or rejected by its checks; a result he
 * already decided himself (his accept card, an earlier override) is final, and
 * so is one whose forecast is scored.
 */
export async function overrideProblem(db: Db | Tx, t: TaskRow, to: 'accepted' | 'rejected'): Promise<{ status: 400 | 409; say: string } | undefined> {
  if (!['checking', 'accepted', 'rejected'].includes(t.status)) return { status: 409, say: taskStatusWords(t.status) };
  if (t.metBar === null) return { status: 409, say: SAY.notChecked };
  if (t.status === to || (t.status === 'checking' && (to === 'accepted') === t.metBar)) return { status: 400, say: SAY.notOverride };
  if (t.barCheckedBy === 'will') return { status: 409, say: SAY.decided };
  if (await db.proposal.findFirst({ where: { action: 'task.check_bar', status: 'executed', args: { path: ['taskId'], equals: t.id } }, select: { id: true } })) return { status: 409, say: SAY.decided };
  if (t.predictionId && (await db.resolution.findUnique({ where: { predictionId: t.predictionId }, select: { id: true } }))) return { status: 409, say: SAY.scored };
  return undefined;
}

/**
 * A task or asset card as it may be filed, or a refusal (400 for what it says,
 * 409 for where things stand). A job's card for anything off the tier
 * engine's closed list is returned as it is: the engine refuses it (FORBIDDEN,
 * autonomous) and audits that.
 */
export async function checkTaskCard(db: Db, input: CreateProposal, registry: readonly AssetDef[] = ASSETS): Promise<CreateProposal> {
  const { action } = input;
  if (!isTaskCard(action)) return input;
  const context = contextOf(input.origin);
  if (context === 'chat') throw new Refused(409, SAY.fromConsole);
  const accept = action === 'task.check_bar';
  if (context === 'autonomous') {
    if (!AUTONOMOUS_ACTIONS.has(action)) return input;
    // Of the cards a job may file, only the accept card is filed yet: by the check itself, under its template.
    if (!accept || input.origin !== TASKS_ORIGIN || input.templateId !== ACCEPT_TEMPLATE) throw new Refused(409, SAY.fromConsole);
  } else {
    if (accept) throw new Refused(409, SAY.flintFiles);
    if (input.templateId !== undefined) throw new Refused(400, SAY.template);
  }
  if (Object.values(input.argsProvenance).some((p) => p.ref !== undefined && !PROVENANCE_REF.test(p.ref))) throw new Refused(400, SAY.provenance);
  const parse = <T extends z.ZodTypeAny>(schema: T): z.output<T> => {
    const r = schema.safeParse(input.args);
    if (!r.success) throw new Refused(400, SAY.invalid, issuesOf(r.error));
    return r.data;
  };
  const kind = (want: CreateProposal['kind']) => {
    if (input.kind !== want) throw new Refused(400, SAY.kind);
  };
  const clean = () => {
    if (input.tainted) throw new Refused(400, SAY.invalid, 'this card is never tainted');
  };
  const task = async (id: string): Promise<TaskRow> => {
    const t = await db.task.findUnique({ where: { id } });
    if (!t) throw new Refused(404, SAY.noTask);
    return t;
  };
  const fixed = { destructive: false } as const;

  if (action === 'asset.enable') {
    kind('policy');
    clean();
    const args = parse(AssetEnableArgs);
    const def = assetDef(args.assetId, registry);
    const row = await db.asset.findUnique({ where: { id: args.assetId } });
    if (!def || !row || !sameAsset(def, row) || !sameAsset(def, args)) throw new Refused(400, SAY.noAsset);
    if (row.enabled) throw new Refused(400, SAY.nothing);
    const why = await enableProblem(db, def);
    if (why) throw new Refused(409, why);
    // What the asset is comes from the code registry, by its id: Will signs it, he does not type it.
    return { ...input, ...fixed, args, argsProvenance: { args: { source: 'template', ref: def.id, tainted: false } }, reason: TASK_REASONS.enable, sensitivity: 'ops', consequential: true };
  }

  if (action === 'review.enforce') {
    kind('policy');
    clean();
    const args = parse(ReviewEnforceArgs);
    const gate = await db.reviewGate.findUnique({ where: { id: args.gate } });
    if (!gate || gate.enforced === args.enforced) throw new Refused(400, SAY.nothing);
    if (args.enforced && !(await db.asset.findFirst({ where: { kind: 'local_reviewer', enabled: true }, select: { id: true } }))) throw new Refused(409, SAY.reviewerFirst);
    return {
      ...input, ...fixed, args, argsProvenance: { enforced: { source: 'will', tainted: false } },
      reason: args.enforced ? TASK_REASONS.require : TASK_REASONS.stopRequiring, sensitivity: 'ops', consequential: true,
    };
  }

  if (isTaskDispatch(action)) {
    const args = parse(TaskDispatchArgs);
    const t = await task(args.taskId);
    if (t.status !== 'proposed') throw new Refused(409, taskStatusWords(t.status));
    const asset = await db.asset.findUnique({ where: { id: args.assetId } });
    if (!asset || asset.kind !== args.assetKind || asset.dispatchAction !== action) throw new Refused(400, SAY.invalid, 'the card is not for its asset');
    if (!sameTask(t, args)) throw new Refused(409, SAY.changed);
    if (!asset.enabled) throw new Refused(409, SAY.assetOff);
    // A spending asset's dispatch is a spend card carrying its estimate; any other is a task card at no cost.
    kind(asset.spends ? 'spend' : 'task');
    if (!asset.spends && args.estCostMicros !== 0) throw new Refused(400, SAY.invalid, 'an asset on this Mac costs nothing');
    if (input.tainted !== t.tainted) throw new Refused(400, SAY.invalid, 'the card is as tainted as its task');
    const { estCostUsd: _none, ...rest } = input;
    return {
      ...rest, ...fixed, args, argsProvenance: { args: { source: 'will', tainted: t.tainted } },
      reason: asset.spends ? TASK_REASONS.paid : TASK_REASONS.dispatch, sensitivity: t.sensitivity as CreateProposal['sensitivity'], consequential: asset.spends,
      ...(asset.spends ? { estCostUsd: args.estCostMicros / 1_000_000 } : {}),
    };
  }

  kind('task');
  clean();
  if (accept) {
    const args = parse(TaskAcceptArgs);
    const t = await task(args.taskId);
    if (t.status !== 'checking') throw new Refused(409, taskStatusWords(t.status));
    const counts = countsOf(t.barEvidence);
    // It names the result it accepts: the one the task was handed in under, having met its bar.
    if (t.metBar !== true || t.outputRef !== args.outputRef || t.barCheckedBy !== args.by || counts.total !== args.checks || counts.met !== args.met) throw new Refused(409, SAY.changed);
    return {
      ...input, ...fixed, args, argsProvenance: { args: { source: 'template', ref: ACCEPT_TEMPLATE, tainted: false } },
      reason: TASK_REASONS.accept, sensitivity: t.sensitivity as CreateProposal['sensitivity'], consequential: false,
    };
  }
  if (action === 'task.cancel') {
    const args = parse(TaskCancelArgs);
    const t = await task(args.taskId);
    if (!STILL_OUT.includes(t.status)) throw new Refused(409, taskStatusWords(t.status));
    return { ...input, ...fixed, args, argsProvenance: { taskId: { source: 'will', tainted: false } }, reason: TASK_REASONS.cancel, sensitivity: t.sensitivity as CreateProposal['sensitivity'], consequential: false };
  }
  // task.bar_override
  const args = parse(TaskOverrideArgs);
  const t = await task(args.taskId);
  const why = await overrideProblem(db, t, args.to);
  if (why) throw new Refused(why.status, why.say);
  return {
    ...input, ...fixed, args, argsProvenance: { taskId: { source: 'will', tainted: false }, to: { source: 'will', tainted: false } },
    reason: args.to === 'accepted' ? TASK_REASONS.overrideAccept : TASK_REASONS.overrideReject, sensitivity: t.sensitivity as CreateProposal['sensitivity'],
    // Marked for Will's own fresh touch, never Approve All.
    consequential: true,
  };
}

interface ApplyContext {
  proposalId: string;
  approvalId: string;
  /** What Will signed: the stored args' digest. */
  argsDigest: string;
  actor: string;
  now: Date;
  tz: string;
  deps: TaskCardDeps;
}
type Result = Record<string, string | number | boolean>;
type Applied = { result: Result } | { refusal: string };

/** The args as signed, read again with the shared contract: normalizing them again must change nothing. */
function signed<T extends z.ZodTypeAny>(schema: T, raw: unknown, ctx: ApplyContext): z.output<T> | undefined {
  const r = schema.safeParse(raw);
  return r.success && digestOf(r.data) === ctx.argsDigest ? r.data : undefined;
}

/**
 * Has Will signed for or against another card about the same asset, task or
 * gate since he signed this one? The database lets only his latest signature
 * act (it records what each one was for as it is recorded); said here first, as
 * a sentence.
 */
async function superseded(tx: Tx, approvalId: string, subject: string): Promise<boolean> {
  const [row] = await tx.$queryRaw<Array<{ later: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM "Approval" mine JOIN "Approval" other ON other."signedFor" = ${subject} AND (other."createdAt", other.id) > (mine."createdAt", mine.id)
      WHERE mine.id = ${approvalId}) AS later`;
  return row?.later === true;
}

/** The task, locked for this transaction before anything of it is read or written. */
async function lockTask(tx: Tx, id: string): Promise<TaskRow | null> {
  await tx.$queryRaw`SELECT id FROM "Task" WHERE id = ${id} FOR UPDATE`;
  return tx.task.findUnique({ where: { id } });
}

/** The proof a task is accepted with: its own successful check (or Will's override) on record, by id. Ids and counts only. */
export async function writeProof(
  tx: Tx,
  o: { taskId: string; action: 'task.check_bar' | 'task.bar_override'; actor: string; context: 'console' | 'autonomous'; tier: 'approval' | 'alone'; inputs: Record<string, string | number | boolean | null> },
  now: Date,
): Promise<string> {
  const id = `au${now.getTime().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
  await appendAudit(tx, [{
    id, actor: o.actor, context: o.context, kind: 'action', action: o.action, tier: o.tier, decision: 'act', outcome: 'ok',
    inputs: { taskId: o.taskId, ...o.inputs }, correlationId: `task:${o.taskId}`, tainted: false,
  }], now);
  return id;
}

/** A spending asset's task that went out ends with a cost: without a metered one, its estimate, marked as an estimate. */
export function endingCost(t: { dispatchedAt: Date | null; costUsd: Prisma.Decimal | null; estCostUsd: Prisma.Decimal | null }, spends: boolean): { costUsd?: Prisma.Decimal; costIsEstimate?: boolean } {
  return spends && t.dispatchedAt && t.costUsd === null ? { costUsd: t.estCostUsd ?? new Prisma.Decimal(0), costIsEstimate: true } : {};
}

/**
 * The signed card's change, inside the caller's transaction. A refusal is
 * returned before anything is written.
 */
async function applyTask(tx: Tx, action: string, raw: unknown, ctx: ApplyContext): Promise<Applied> {
  const { approvalId, now } = ctx;

  if (action === 'asset.enable') {
    const args = signed(AssetEnableArgs, raw, ctx);
    if (!args) return { refusal: SAY.reshaped };
    await tx.$queryRaw`SELECT id FROM "Asset" WHERE id = ${args.assetId} FOR UPDATE`;
    const row = await tx.asset.findUnique({ where: { id: args.assetId } });
    const def = assetDef(args.assetId, ctx.deps.registry ?? ASSETS);
    if (!def || !row || !sameAsset(def, row) || !sameAsset(def, args)) return { refusal: SAY.noAsset };
    if (row.enabled) return { refusal: SAY.nothing };
    const why = await enableProblem(tx, def);
    if (why) return { refusal: why };
    if (await superseded(tx, approvalId, `assetId:${row.id}`)) return { refusal: SAY.superseded };
    await tx.asset.update({ where: { id: row.id }, data: { enabled: true, approvalId } });
    return { result: { assetId: row.id, enabled: true } };
  }

  if (action === 'review.enforce') {
    const args = signed(ReviewEnforceArgs, raw, ctx);
    if (!args) return { refusal: SAY.reshaped };
    const [gate] = await tx.$queryRaw<Array<{ enforced: boolean }>>`SELECT enforced FROM "ReviewGate" WHERE id = ${args.gate} FOR UPDATE`;
    if (!gate || gate.enforced === args.enforced) return { refusal: SAY.nothing };
    if (args.enforced && !(await tx.asset.findFirst({ where: { kind: 'local_reviewer', enabled: true }, select: { id: true } }))) return { refusal: SAY.reviewerFirst };
    if (await superseded(tx, approvalId, `gate:${args.gate}`)) return { refusal: SAY.superseded };
    await tx.reviewGate.update({ where: { id: args.gate }, data: { enforced: args.enforced, approvalId } });
    return { result: { gate: args.gate, enforced: args.enforced } };
  }

  if (isTaskDispatch(action)) {
    const args = signed(TaskDispatchArgs, raw, ctx);
    if (!args) return { refusal: SAY.reshaped };
    const t = await lockTask(tx, args.taskId);
    if (!t) return { refusal: SAY.noTask };
    if (t.status !== 'proposed') return { refusal: taskStatusWords(t.status) };
    const asset = await tx.asset.findUnique({ where: { id: t.assetId } });
    if (!asset || asset.kind !== args.assetKind || asset.dispatchAction !== action || !sameTask(t, args)) return { refusal: SAY.changed };
    if (!asset.enabled) return { refusal: SAY.assetOff };
    if (await superseded(tx, approvalId, `taskId:${t.id}`)) return { refusal: SAY.superseded };
    // Money first: a spending asset's task goes out only once its amount is set aside.
    if (asset.spends && !(await ctx.deps.reserve?.(args.estCostMicros))) return { refusal: SAY.paidOff };
    const forecast = await recordForecast(tx, { id: t.id, assetKind: asset.kind, template: args.spec.template, dueAt: t.dueAt }, ctx.tz, now);
    await tx.task.update({ where: { id: t.id }, data: { status: 'queued', dispatchApprovalId: approvalId, predictionId: forecast.id } });
    // Its run, in this transaction: it is sent, or the dispatch is not made. (Without a bus, the tick sends it.)
    await ctx.deps.bus?.boss.send(RUN_QUEUE, { taskId: t.id }, { ...inTx(tx), singletonKey: t.id });
    return { result: { taskId: t.id, predictionId: forecast.id } };
  }

  if (action === 'task.check_bar') {
    const args = signed(TaskAcceptArgs, raw, ctx);
    if (!args) return { refusal: SAY.reshaped };
    const t = await lockTask(tx, args.taskId);
    if (!t) return { refusal: SAY.noTask };
    if (t.status !== 'checking') return { refusal: taskStatusWords(t.status) };
    const counts = countsOf(t.barEvidence);
    if (t.metBar !== true || t.outputRef !== args.outputRef || t.barCheckedBy !== args.by || counts.total !== args.checks || counts.met !== args.met) return { refusal: SAY.changed };
    if (await superseded(tx, approvalId, `taskId:${t.id}`)) return { refusal: SAY.superseded };
    const asset = await tx.asset.findUniqueOrThrow({ where: { id: t.assetId }, select: { spends: true } });
    const proof = await writeProof(tx, { taskId: t.id, action: 'task.check_bar', actor: ctx.actor, context: 'console', tier: 'approval', inputs: { proposalId: ctx.proposalId, approvalId, checks: counts.total, met: counts.met, by: args.by } }, now);
    await tx.task.update({ where: { id: t.id }, data: { status: 'accepted', acceptedAuditId: proof, ...endingCost(t, asset.spends) } });
    // (Its forecast is scored by the task tick, a day after it ended: Will can still overrule the check until then.)
    return { result: { taskId: t.id, accepted: true } };
  }

  if (action === 'task.cancel') {
    const args = signed(TaskCancelArgs, raw, ctx);
    if (!args) return { refusal: SAY.reshaped };
    const t = await lockTask(tx, args.taskId);
    if (!t) return { refusal: SAY.noTask };
    if (!STILL_OUT.includes(t.status)) return { refusal: taskStatusWords(t.status) };
    if (await superseded(tx, approvalId, `taskId:${t.id}`)) return { refusal: SAY.superseded };
    const asset = await tx.asset.findUniqueOrThrow({ where: { id: t.assetId }, select: { spends: true } });
    await tx.task.update({ where: { id: t.id }, data: { status: 'cancelled', ...endingCost(t, asset.spends) } });
    return { result: { taskId: t.id, cancelled: true } };
  }

  // task.bar_override
  const args = signed(TaskOverrideArgs, raw, ctx);
  if (!args) return { refusal: SAY.reshaped };
  const t = await lockTask(tx, args.taskId);
  if (!t) return { refusal: SAY.noTask };
  const why = await overrideProblem(tx, t, args.to);
  if (why) return { refusal: why.say };
  if (await superseded(tx, approvalId, `taskId:${t.id}`)) return { refusal: SAY.superseded };
  const asset = await tx.asset.findUniqueOrThrow({ where: { id: t.assetId }, select: { spends: true } });
  // Accepted by his word: the proof is his override, on record. (A proof a task already has is kept: it is set once.)
  const proof = args.to === 'accepted' && t.acceptedAuditId === null
    ? await writeProof(tx, { taskId: t.id, action: 'task.bar_override', actor: ctx.actor, context: 'console', tier: 'approval', inputs: { proposalId: ctx.proposalId, approvalId, to: args.to } }, now)
    : undefined;
  await tx.task.update({ where: { id: t.id }, data: { status: args.to, barCheckedBy: 'will', ...(proof ? { acceptedAuditId: proof } : {}), ...endingCost(t, asset.spends) } });
  return { result: { taskId: t.id, to: args.to } };
}

/** Why a card is not one this executor runs as it stands, or undefined: who filed it, as what kind, under which template. */
function cardProblem(action: string, p: { origin: string; templateId: string | null; kind: string; tainted: boolean }): string | undefined {
  const context = contextOf(p.origin);
  if (context === 'chat') return SAY.fromConsole;
  if (action === 'task.check_bar') return p.origin === TASKS_ORIGIN && p.templateId === ACCEPT_TEMPLATE && p.kind === 'task' && !p.tainted ? undefined : SAY.flintFiles;
  if (context !== 'console') return SAY.fromConsole;
  if (p.templateId !== null) return SAY.template;
  if (isTaskDispatch(action)) return p.kind === (action === PAID_DISPATCH ? 'spend' : 'task') ? undefined : SAY.kind;
  if (!isTaskSignedAction(action)) return SAY.invalid;
  if (p.kind !== TASK_CARD_KIND[action]) return SAY.kind;
  return TASK_WILL_ONLY.has(action) && p.tainted ? SAY.invalid : undefined;
}

/** End an approved card whose args a forget cleared: failed, with a sentence, no result, and its denial on record by ids only. */
async function completeForgotten(tx: Tx, id: string, actor: string, now: Date): Promise<void> {
  const p = await tx.proposal.findUniqueOrThrow({ where: { id }, select: { action: true, origin: true, argsDigest: true, tainted: true } });
  await tx.proposal.update({ where: { id }, data: { status: 'failed', error: SAY.forgotten, executedAt: now } });
  await appendAudit(tx, [{
    actor, context: contextOf(p.origin), kind: 'action', action: p.action, decision: 'deny', outcome: 'denied',
    inputs: { proposalId: id, argsDigest: p.argsDigest, why: 'forgotten' }, correlationId: id, tainted: p.tainted,
  }], now);
}

/** Test seams: a fault injected after the writes, before the card completes. */
export interface TaskHooks {
  afterWrites?: (tx: Tx) => Promise<void>;
}

/**
 * Claim, apply and complete one approved task or asset card, in one
 * transaction. A refusal fails the card with a sentence; any other error rolls
 * everything back, leaving the card approved, and is rethrown as its class and
 * SQLSTATE. While tasks are switched off no card runs, and it stays approved.
 */
export async function runTask(db: Db, id: string, rp: WebAuthnRelyingParty | undefined, tz: string, actor: string, deps: TaskCardDeps = {}, hooks: TaskHooks = {}): Promise<Result> {
  if (deps.assets !== true) throw new Refused(409, SAY.off);
  const now = new Date();
  let out: { refused: Refused } | { done: Result };
  try {
    out = await db.$transaction(
      async (tx) => {
        // A card whose subject Will had Flint forget since he approved it: its args are gone (only a forget clears
        // them before a card has ended). It does not run, and ends with a sentence and no result.
        const [gone] = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "Proposal" WHERE id = ${id} AND status = 'approved' AND "argsPurgedAt" IS NOT NULL FOR UPDATE`;
        if (gone) {
          await completeForgotten(tx, id, actor, now);
          return { refused: new Refused(409, SAY.forgotten) };
        }
        const c = await claimIn(tx, id, rp, tz, actor, now);
        if ('refused' in c) return c;
        const p = await tx.proposal.findUniqueOrThrow({ where: { id }, select: { approvalId: true, origin: true, templateId: true, kind: true, tainted: true } });
        const r: Applied = !isTaskCard(c.claimed.action)
          ? { refusal: SAY.invalid }
          : await (async () => {
              const why = cardProblem(c.claimed.action, p);
              if (why) return { refusal: why };
              await tx.$queryRaw`SELECT set_config('flint.actor', ${`will:approval:${p.approvalId}`}, true)`;
              return applyTask(tx, c.claimed.action, c.claimed.args, { proposalId: id, approvalId: p.approvalId!, argsDigest: c.claimed.argsDigest, actor, now, tz, deps });
            })();
        if ('refusal' in r) {
          await completeIn(tx, id, { ok: false, error: r.refusal }, actor, now);
          return { refused: new Refused(409, r.refusal) };
        }
        await hooks.afterWrites?.(tx);
        await completeIn(tx, id, { ok: true, result: r.result }, actor, now);
        return { done: r.result };
      },
      // READ COMMITTED, said out loud: the database refuses these changes above it (its guards read what is committed now).
      { maxWait: 10_000, timeout: 30_000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
  } catch (err) {
    throw sanitize(err);
  }
  if ('refused' in out) throw out.refused;
  return out.done;
}

/**
 * runInternal's task branch: runTask and, when it fails other than by a
 * refusal, a log line with a reference, the failure's class, SQLSTATE and
 * constraint, and its top frames (never its message). Nothing was changed.
 * When the database refused the change itself, the card fails, saying so with
 * the reference only; after anything else (a lost connection, a crash, a
 * schema the code does not expect yet) it stays approved, to run again.
 */
export async function runTaskCard(db: Db, id: string, rp: WebAuthnRelyingParty | undefined, tz: string, actor: string, deps: TaskCardDeps = {}, hooks: TaskHooks = {}): Promise<Result> {
  try {
    return await runTask(db, id, rp, tz, actor, deps, hooks);
  } catch (err) {
    if (err instanceof Refused) throw err;
    const ref = `err${Date.now().toString(36)}`;
    const failure = failureOf(err);
    console.error(`[runtime] ${ref} running proposal ${id} failed: ${failureReport(err)}`);
    const state = err instanceof GoalFailure ? err.code : sqlState(err);
    if (state && /^(22|23|42|P0)/.test(state) && !schemaSkew(state)) await failApproved(db, id, `could not carry it out (${ref})`, failure, actor).catch(() => {});
    if (dbRefused(err)) throw new Refused(400, 'The database refused this change.');
    throw new Refused(409, 'Flint couldn’t carry it out.');
  }
}
