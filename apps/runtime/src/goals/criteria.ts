/**
 * What counts as done, as it stands now (P3): the deterministic evaluator the
 * goals panel uses (and part 3's reviews will). No model, no text: a check is
 *  - manual: Will's mark is on it;
 *  - steps: every step it names is done or skipped in the active plan;
 *  - item: the item's structural field (CHECK_PATHS) has the value.
 * An item is read as it stands, finished or not: GitHub archives a merged or
 * closed pull request and a closed issue, Nexus an ended thread, Railway a
 * removed deployment, and each is still exactly what its check looks at. Only a
 * forgotten item is unknown; one merged into another is read as the item it
 * became. A field whose text came from outside (tainted) is unknown too.
 * Unknown is never met. progress = met / total.
 */
import { checkFits, isPathTainted, type CheckState, type Criterion } from '@flint/policy';
import type { Db, Tx } from '../db.js';

/** What the evaluator reads of an item. */
export interface ItemFacts {
  id: string;
  kind: string;
  status: string;
  state: unknown;
  taintedPaths: readonly string[];
  mergedIntoId: string | null;
}

/** What it reads of a step. */
export interface StepFacts {
  key: string;
  status: string;
}

export interface Evaluated {
  criteria: Array<{ id: string; state: CheckState }>;
  met: number;
  unknown: number;
  total: number;
  progress: number;
}

/** How many merges are followed to the item an entity became. */
const MERGE_HOPS = 3;

/** The item as it stands: itself, or the one it was merged into. Undefined when it is gone or forgotten. */
export function resolveItem(id: string, items: ReadonlyMap<string, ItemFacts>): ItemFacts | undefined {
  let e = items.get(id);
  for (let hop = 0; e && e.status === 'merged'; hop++) {
    if (hop >= MERGE_HOPS || !e.mergedIntoId) return undefined;
    e = items.get(e.mergedIntoId);
  }
  return e && e.status !== 'forgotten' ? e : undefined;
}

/** One item check, as it stands. */
export function itemState(check: { entityId: string; key: string; value: string }, items: ReadonlyMap<string, ItemFacts>): CheckState {
  const e = resolveItem(check.entityId, items);
  if (!e || !checkFits(e.kind, check.key, check.value)) return 'unknown';
  if (isPathTainted(`state.${check.key}`, e.taintedPaths)) return 'unknown';
  const state = e.state && typeof e.state === 'object' && !Array.isArray(e.state) ? (e.state as Record<string, unknown>) : {};
  const v = state[check.key];
  if (v === undefined) return 'unknown';
  return v === check.value ? 'met' : 'unmet';
}

/** Every check of a goal, as it stands. `steps` is the active plan's (null: the goal has none). */
export function evaluate(
  criteria: readonly Criterion[],
  marks: Readonly<Record<string, unknown>>,
  steps: readonly StepFacts[] | null,
  items: ReadonlyMap<string, ItemFacts>,
): Evaluated {
  const byKey = new Map((steps ?? []).map((s) => [s.key, s.status]));
  const out = criteria.map((c): { id: string; state: CheckState } => {
    const check = c.check;
    if (check.kind === 'manual') return { id: c.id, state: typeof marks[c.id] === 'string' ? 'met' : 'unmet' };
    if (check.kind === 'steps') {
      if (!steps || check.keys.some((k) => !byKey.has(k))) return { id: c.id, state: 'unknown' };
      return { id: c.id, state: check.keys.every((k) => byKey.get(k) === 'done' || byKey.get(k) === 'skipped') ? 'met' : 'unmet' };
    }
    return { id: c.id, state: itemState(check, items) };
  });
  const met = out.filter((c) => c.state === 'met').length;
  const unknown = out.filter((c) => c.state === 'unknown').length;
  return { criteria: out, met, unknown, total: out.length, progress: out.length ? met / out.length : 0 };
}

/** The items these checks look at, with the items they were merged into. */
export async function itemFacts(db: Db | Tx, ids: Iterable<string>): Promise<Map<string, ItemFacts>> {
  const items = new Map<string, ItemFacts>();
  let want = [...new Set(ids)];
  for (let hop = 0; want.length && hop <= MERGE_HOPS; hop++) {
    const rows = await db.entity.findMany({
      where: { id: { in: want } },
      select: { id: true, kind: true, status: true, state: true, taintedPaths: true, mergedIntoId: true },
    });
    for (const r of rows) items.set(r.id, r);
    want = rows.filter((r) => r.status === 'merged' && r.mergedIntoId && !items.has(r.mergedIntoId)).map((r) => r.mergedIntoId!);
  }
  return items;
}

/** The item ids a goal's checks look at. */
export function checkedItems(criteria: readonly Criterion[]): string[] {
  return criteria.flatMap((c) => (c.check.kind === 'item' ? [c.check.entityId] : []));
}

/** A goal row's checks, as stored (an array, or none). */
export function criteriaOf(g: { successCriteria: unknown }): Criterion[] {
  return Array.isArray(g.successCriteria) ? (g.successCriteria as Criterion[]) : [];
}

/** A goal row's marks (Will's, by check id), as a copy that may be changed. */
export function marksOf(g: { criteriaMet: unknown }): Record<string, unknown> {
  return g.criteriaMet && typeof g.criteriaMet === 'object' && !Array.isArray(g.criteriaMet) ? { ...(g.criteriaMet as Record<string, unknown>) } : {};
}
