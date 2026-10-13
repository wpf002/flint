/**
 * What the Tasks panel does (P5), behind the runtime's task routes.
 *
 * A new task: the form names a template and its parameters. The runtime
 * validates them against the shared contract, resolves every item to one Flint
 * tracks (never a person), makes the task's id from the form's draft key (so a
 * form sent twice is one task), its title from the template (fixed words: a
 * title is kept for good) and its bar from the template's rule checks, writes
 * the task as proposed and files its dispatch card. The card's args are the
 * whole task: what Will signs is what the database compares.
 *
 * Cancelling a task that has not gone out needs no signature (nothing went
 * out); one that has is a card he signs. Ending a task against its check
 * (Accept Anyway, Reject Anyway) is a card he signs with a fresh touch.
 *
 * Audit entries carry ids and a template's name, never a task's words.
 */
import { Prisma } from '@prisma/client';
import {
  TASK_ITEMS_MAX,
  TaskDispatchArgs,
  TaskSpec,
  mostSensitive,
  ruleChecks,
  specItems,
  specTainted,
  taskIdOf,
  type NewTaskBody,
  type TaskTemplateId,
} from '@flint/policy';
import type { Db } from '../db.js';
import { appendAudit } from '../governance/audit.js';
import { Refused, createProposal, rejectProposal } from '../governance/proposals.js';
import { ASSETS, assetFor, sameAsset, type AssetDef } from '../assets/registry.js';
import { CONSOLE_ACTOR } from '../assets/service.js';
import type { AdapterSet } from './adapters/types.js';
import { WITHDRAW_ACTION, releaseTaskKeys, type Reserve } from './card.js';
import { SAY, taskStatusWords } from './errors.js';
import { ADAPTERS } from './run.js';

/** How long a task card waits for Will. */
const CARD_TTL_MINUTES = 7 * 24 * 60;
const DAY = 86_400_000;
/** A task is due within this long (its forecast's date has to fit the ledger's horizon). */
export const DUE_MAX_MS = 90 * DAY;

/** A task's title, by its template: fixed words, with nothing of Will's or an item's in them. */
export const TASK_TITLES: Readonly<Record<TaskTemplateId, string>> = {
  summarize_items: 'Summarize Items',
  sort_items: 'Sort Items',
  draft_note: 'Draft a Note',
  watch_ci: 'Watch a CI Run',
};

export interface TaskServiceDeps {
  registry?: readonly AssetDef[];
  adapters?: AdapterSet;
  /** What sets a paid task's money aside, when there is one. */
  reserve?: Reserve;
}

const RC = { maxWait: 10_000, timeout: 20_000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted } as const;

const audit = (db: Parameters<typeof appendAudit>[0], action: string, taskId: string, inputs: Record<string, string | boolean | number | null>, now: Date) =>
  appendAudit(db, [{ actor: CONSOLE_ACTOR, context: 'console', kind: 'action', action, outcome: 'ok', correlationId: `task:${taskId}`, tainted: false, inputs: { taskId, ...inputs } }], now);

/** Cancel a task that has not gone out, with its audit entry. False when it has moved on. */
async function cancelProposed(db: Db, id: string, why: string, now: Date): Promise<boolean> {
  return db.$transaction(async (tx) => {
    const r = await tx.task.updateMany({ where: { id, status: 'proposed' }, data: { status: 'cancelled' } });
    if (r.count) await audit(tx, WITHDRAW_ACTION, id, { why }, now);
    return r.count > 0;
  }, RC);
}

/**
 * A new task and its dispatch card. The same form sent again is the same task
 * and, while its card waits, the same card.
 */
export async function createTask(db: Db, body: NewTaskBody, deps: TaskServiceDeps = {}, now = new Date()): Promise<{ id: string; proposalId: string; deduped: boolean }> {
  // Will's own check is judged by a local review, which does not exist yet: said, not dropped.
  if (body.ownCheck !== null) throw new Refused(400, SAY.ownCheck);
  const parsed = TaskSpec.safeParse({ template: body.template, params: body.params });
  if (!parsed.success) {
    const items = (body.params as { items?: unknown }).items;
    if (Array.isArray(items) && items.length > TASK_ITEMS_MAX) throw new Refused(400, SAY.tooMany);
    throw new Refused(400, SAY.invalid, parsed.error.issues.map((i) => `${i.path.join('.') || '<body>'}: ${i.code}`).join('; ').slice(0, 300));
  }
  const spec = parsed.data;
  const registry = deps.registry ?? ASSETS;
  const def = assetFor(spec.template, registry);
  if (!def) throw new Refused(409, SAY.cantRun);
  const asset = await db.asset.findUnique({ where: { id: def.id } });
  if (!asset || !sameAsset(def, asset) || !asset.enabled) throw new Refused(409, SAY.assetOff);
  const adapter = (deps.adapters ?? ADAPTERS)[def.kind];
  if (!adapter) throw new Refused(409, SAY.cantRun);

  const ids = specItems(spec);
  const items = ids.length ? await db.entity.findMany({ where: { id: { in: ids } }, select: { id: true, kind: true, status: true, sensitivity: true } }) : [];
  if (items.length !== ids.length || items.some((e) => e.status === 'forgotten')) throw new Refused(409, SAY.itemGone);
  if (items.some((e) => e.kind === 'person')) throw new Refused(400, SAY.person);
  if (spec.template === 'watch_ci' && items[0]!.kind !== 'ci_run') throw new Refused(400, SAY.wrongItem);
  const dueAt = body.dueAt === null ? null : new Date(body.dueAt);
  if (dueAt && !(dueAt.getTime() > now.getTime() && dueAt.getTime() <= now.getTime() + DUE_MAX_MS)) throw new Refused(400, SAY.due);
  if (body.goalId !== null && !(await db.goal.findUnique({ where: { id: body.goalId }, select: { id: true } }))) throw new Refused(404, SAY.noGoal);

  const id = taskIdOf(body.draftKey);
  const estCostMicros = adapter.estimate(spec);
  const args = TaskDispatchArgs.parse({
    taskId: id, assetId: asset.id, assetKind: asset.kind, title: TASK_TITLES[spec.template], spec, acceptance: ruleChecks(spec),
    goalId: body.goalId, stepKey: null, dueAt: body.dueAt,
    // As sensitive as the most sensitive item it reads; a note Will describes in his own words is personal.
    sensitivity: mostSensitive([...items.map((e) => e.sensitivity as 'ops' | 'personal' | 'financial'), ...(spec.template === 'draft_note' ? (['personal'] as const) : [])]),
    tainted: specTainted(spec), estCostMicros,
  });
  const existing = await db.task.findUnique({ where: { id }, select: { status: true } });
  if (existing && existing.status !== 'proposed') throw new Refused(409, taskStatusWords(existing.status));
  if (!existing) {
    await db.$transaction(async (tx) => {
      await tx.task.create({
        data: {
          id, assetId: asset.id, goalId: args.goalId, stepKey: null, title: args.title, spec: args.spec as Prisma.InputJsonObject, acceptance: args.acceptance as unknown as Prisma.InputJsonArray,
          entityIds: ids, origin: 'will', sensitivity: args.sensitivity, tainted: args.tainted, dueAt, estCostUsd: new Prisma.Decimal(estCostMicros).div(1_000_000),
        },
      });
      await audit(tx, 'task.create', id, { assetId: asset.id, template: spec.template }, now);
    }, RC);
  }
  try {
    const filed = await createProposal(db, {
      kind: asset.spends ? 'spend' : 'task', origin: 'console', action: asset.dispatchAction, args,
      // checkTaskCard sets where the args came from, the fixed reason, the sensitivity and (for a paid task) its estimate.
      argsProvenance: {}, tainted: args.tainted, sensitivity: args.sensitivity, destructive: false, consequential: asset.spends, ttlMinutes: CARD_TTL_MINUTES,
    }, CONSOLE_ACTOR, now);
    return { id, proposalId: filed.id, deduped: filed.deduped };
  } catch (err) {
    // No card, so no way out for it: the task made a moment ago is cancelled (nothing went out).
    if (!existing) await cancelProposed(db, id, 'card_refused', now).catch(() => {});
    throw err;
  }
}

/**
 * Cancel a task. One that has not gone out is cancelled here, and its card
 * that is still waiting is turned away; one that has gone out gets a card for
 * Will to sign.
 */
export async function cancelTask(db: Db, id: string, now = new Date(), deps: Pick<TaskServiceDeps, 'reserve'> = {}): Promise<{ ok: true } | { proposalId: string; deduped: boolean }> {
  const t = await db.task.findUnique({ where: { id }, select: { status: true, sensitivity: true } });
  if (!t) throw new Refused(404, SAY.noTask);
  if (t.status === 'proposed' && (await cancelProposed(db, id, 'will', now))) {
    const waiting = await db.proposal.findMany({ where: { action: { startsWith: 'task.dispatch.' }, status: 'pending', args: { path: ['taskId'], equals: id } }, select: { id: true } });
    for (const p of waiting) await rejectProposal(db, p.id, { error: taskStatusWords('cancelled') }, undefined, CONSOLE_ACTOR).catch(() => {});
    // It will never go out: what any of its cards set aside is given back.
    await releaseTaskKeys(db, deps.reserve, id).catch(() => false);
    return { ok: true };
  }
  const filed = await createProposal(db, {
    kind: 'task', origin: 'console', action: 'task.cancel', args: { taskId: id },
    argsProvenance: {}, tainted: false, sensitivity: 'ops', destructive: false, consequential: false, ttlMinutes: CARD_TTL_MINUTES,
  }, CONSOLE_ACTOR, now);
  return { proposalId: filed.id, deduped: filed.deduped };
}

/** Accept Anyway, Reject Anyway: the card that ends a task against its check. */
export async function overrideTask(db: Db, id: string, to: 'accepted' | 'rejected', now = new Date()): Promise<{ proposalId: string; deduped: boolean }> {
  const filed = await createProposal(db, {
    kind: 'task', origin: 'console', action: 'task.bar_override', args: { taskId: id, to },
    argsProvenance: {}, tainted: false, sensitivity: 'ops', destructive: false, consequential: true, ttlMinutes: CARD_TTL_MINUTES,
  }, CONSOLE_ACTOR, now);
  return { proposalId: filed.id, deduped: filed.deduped };
}
