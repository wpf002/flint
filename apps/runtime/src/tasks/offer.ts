/**
 * What may be offered as a task to make (P5): the rules the New Task form
 * lists by, and the same rules Run Again is held to, so a task cannot be made
 * again from something the form would no longer offer.
 *
 * A kind of task is offered only while the asset that runs it is on, is what
 * the registry says it is, and has something behind it to run it; an item only
 * while it is active and of the kind that task is about; a goal only while it
 * is active. Each reason is one of the fixed sentences.
 */
import { specItems, type TaskSpec, type TaskTemplateId } from '@flint/policy';
import type { Db, Tx } from '../db.js';
import { ASSETS, assetFor, sameAsset, type AssetDef } from '../assets/registry.js';
import type { AdapterSet } from './adapters/types.js';
import { SAY } from './errors.js';
import { ADAPTERS } from './run.js';

/** The kind of item each kind of task in the New Task form is about. One not named here is not offered there yet. */
export const FORM_ITEM_KIND: Readonly<Partial<Record<TaskTemplateId, string>>> = { watch_ci: 'ci_run' };
/** The status an item or a goal has while it can be offered. */
export const OFFERED_STATUS = 'active';

export interface OfferDeps {
  registry?: readonly AssetDef[];
  adapters?: AdapterSet;
}

/** The asset that would run this kind of task now, or why none would. */
export async function runnerOf(db: Db | Tx, template: TaskTemplateId, deps: OfferDeps = {}): Promise<{ def: AssetDef } | { why: string }> {
  const def = assetFor(template, deps.registry ?? ASSETS);
  if (!def || !(deps.adapters ?? ADAPTERS)[def.kind]) return { why: SAY.cantRun };
  const row = await db.asset.findUnique({ where: { id: def.id } });
  return row && sameAsset(def, row) && row.enabled ? { def } : { why: SAY.assetOff };
}

/**
 * Why the form would not offer this task now, as a sentence, or undefined when
 * it would: its kind, its items and its goal, each as it stands.
 */
export async function offerProblem(db: Db | Tx, spec: TaskSpec, goalId: string | null, deps: OfferDeps = {}): Promise<string | undefined> {
  const kind = FORM_ITEM_KIND[spec.template];
  if (!kind) return SAY.cantRun;
  const runner = await runnerOf(db, spec.template, deps);
  if ('why' in runner) return runner.why;
  const ids = specItems(spec);
  const items = ids.length ? await db.entity.findMany({ where: { id: { in: ids } }, select: { kind: true, status: true } }) : [];
  if (items.length !== ids.length) return SAY.itemGone;
  if (items.some((e) => e.kind !== kind || e.status !== OFFERED_STATUS)) return SAY.itemEnded;
  if (goalId !== null && (await db.goal.findUnique({ where: { id: goalId }, select: { status: true } }))?.status !== OFFERED_STATUS) return SAY.goalEnded;
  return undefined;
}
