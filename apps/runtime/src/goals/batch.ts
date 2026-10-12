/**
 * A review's plan stage, the runtime's part (P3 part 3; exit criterion 4):
 * what the local model suggested (planner.ts, steps.ts) becomes cards Will
 * signs, or, in the trial week, a record of what it would have suggested.
 * EVERY plan change is a Proposal(kind=plan): nothing here writes a plan.
 *
 * Small and bigger changes, decided by rule (classifyPlanOp, @flint/policy),
 * never by the model, and checked again by the card gate (apply.ts):
 *  - small: a status moved among todo, in progress and blocked; a due date
 *    moved by at most 7 days and not past the goal's finish date; a step
 *    reordered. All of a review's new small changes go on ONE card (it rides
 *    Approve All).
 *  - bigger: a step added; a step skipped; a due date set where there was
 *    none, moved by more than 7 days, or past the finish date; anything on a
 *    Flint action or a decision. Each goes on a card of its own, marked for a
 *    fresh touch, at most 2 new ones a review; the rest wait for the next
 *    review.
 *  - at most 9 new plan cards a day across every goal.
 *
 * A card's args are {goalId, goalTitle, ops}, each op with its precondition (the
 * step as it is now): no review, plan or version id, so cards on different
 * steps compose. They are PERSONAL, kept 7 days, with a fixed reason; their
 * parts are named by where they came from (the model, a template, Will).
 *
 * The goal's waiting cards belong to Will, not to the latest review:
 *  - A change a waiting card already asks for is that card: it is kept and not
 *    filed again, whatever would have held a new one back (the day's cap, the
 *    review's limit). A due date within a week of the card's is the same
 *    change, so a date counted in days from today does not make yesterday's
 *    card a different one; the review then records the card's date.
 *  - A waiting card is withdrawn unsigned ("A newer review replaced it.") only
 *    when it can no longer apply to the plan as it stands, or when this review
 *    changes the same thing differently (another status, a date over a week
 *    away, another place). A review that suggests nothing, or whose model gave
 *    no usable answer, withdraws nothing that still applies.
 *  - A change Will turned down is not suggested again while its rejected card
 *    still holds its args (7 days): each part of it, so turning down a date and
 *    a status together turns down either alone.
 *
 * Shadow (the trial week: goal.review.local not promoted): nothing is filed
 * and no card is touched. GoalReview.diff keeps the would-be changes, as ids
 * and enums, and the panel says them as sentences.
 *
 * Lock order: each of the stage's three short transactions takes the goal FOR
 * UPDATE first, at READ COMMITTED; none is open while the model runs or a card
 * is filed. It yields to chat as triage does: while a chat turn runs, the job
 * comes back in 15 s, at most 40 times; past that the review records
 * `none:deferred` and Settings > Health says so. When the model is not there
 * at all, the job comes back in 2 minutes, at most 3 times, before the review
 * records `none:unavailable`. A job that died after filing its cards files
 * none twice: its next run finds them waiting.
 */
import { Prisma } from '@prisma/client';
import {
  CHECK_PATHS,
  CODE_TABLE,
  GOAL_BUDGETS,
  MINOR_DUE_SHIFT_MS,
  PLAN_CARDS_COUNTER,
  PlanChangeArgs,
  classifyPlanOp,
  composePlan,
  entityRef,
  isPathTainted,
  localDay,
  type CheckState,
  type PlanOp,
  type PlanOpClass,
  type PlanStepState,
} from '@flint/policy';
import type { Config } from '../config.js';
import type { Db, Tx } from '../db.js';
import type { Bus } from '../bus.js';
import { appendAudit } from '../governance/audit.js';
import { claim, periodKey } from '../governance/counters.js';
import { Refused, createProposal, rejectProposal } from '../governance/proposals.js';
import { failureClass } from '../dbcodes.js';
import { chatLoad, type Load } from '../triage/load.js';
import { GOALS_ORIGIN } from './apply.js';
import { checkedItems, criteriaOf, evaluate, itemFacts, marksOf } from './criteria.js';
import { SAY } from './errors.js';
import { labelFor, labelOf } from './items.js';
import { GOALS_ACTOR } from './ontrack.js';
import { activePlan } from './ops.js';
import { planDiff, type PlanFacts } from './planner.js';
import { PLAN_QUEUE, REVIEW_ACTION, reviewStanding, type PlanJob } from './review.js';
import { STEP_TEMPLATES, STEP_TEMPLATES_REF, resolveReply, stepTitle, type DiffItem, type Held, type TemplateOp } from './steps.js';

/** How long a plan card waits for Will: a week, as long as the longest wait between two weekly reviews. */
const CARD_TTL_MINUTES = 7 * 24 * 60;
export const DEFER_SECONDS = 15;
export const MAX_DEFERRALS = 40;
/** The model was not there at all: the plan stage comes back this much later, at most this many times. */
export const RETRY_SECONDS = 120;
export const MAX_RETRIES = 3;
/** Room between two steps' ordinals, as the panel's own Add Step leaves it. */
const ORDINAL_STEP = 100;
const MAX_ORDINAL = 1_000_000;

/** A suggestion's class by the shared rule, as if it were filed alone. `step` is the step as it stands (undefined for a new one). */
export function classify(change: TemplateOp, step: Pick<PlanStepState, 'kind' | 'status' | 'dueAt'> | undefined, horizonAt: string | null): PlanOpClass {
  if (change.op === 'add') return 'material';
  const to = change.op === 'due' ? { dueAt: change.dueAt } : change.op === 'status' ? { status: change.status } : change.op === 'skip' ? { status: 'skipped' as const } : { ordinal: 1 };
  return classifyPlanOp({ op: 'set', key: change.key, from: { title: '' }, to }, step, horizonAt);
}

/** One thing an operation changes: a step added, or one field of a step. In memory only: a slot can hold a step's words. */
export interface OpPart {
  /** What it changes: a new step by its kind and title, or one field of a step. Two parts of one slot are the same change, or two different ones. */
  slot: string;
  field: 'add' | 'dueAt' | 'status' | 'ordinal' | 'other';
  /** A status; a time in ms (null: no date); the key of the step it would follow ('' for first); null for an add. */
  value: string | number | null;
}

const inOrder = (steps: readonly PlanStepState[]) => [...steps].sort((a, b) => a.ordinal - b.ordinal || (a.key < b.key ? -1 : 1));

/** The step a step at this ordinal would follow, among the plan's other steps ('' for none). */
function followed(steps: readonly PlanStepState[], key: string, ordinal: number): string {
  const before = inOrder(steps).filter((s) => s.key !== key && (s.ordinal < ordinal || (s.ordinal === ordinal && s.key < key)));
  return before[before.length - 1]?.key ?? '';
}

/** An operation's parts, against the plan as it stands (a new place is told by the step it would follow). */
export function partsOf(op: PlanOp, steps: readonly PlanStepState[] = []): OpPart[] {
  if (op.op === 'add') return [{ slot: `add|${op.step.kind}|${op.step.title}`, field: 'add', value: null }];
  return Object.entries(op.to).flatMap(([k, v]): OpPart[] => {
    if (v === undefined) return [];
    const slot = `set|${op.key}|${k}`;
    if (k === 'dueAt') return [{ slot, field: 'dueAt', value: v === null ? null : Date.parse(v as string) }];
    if (k === 'status') return [{ slot, field: 'status', value: v as string }];
    if (k === 'ordinal') return [{ slot, field: 'ordinal', value: followed(steps, op.key, v as number) }];
    return [{ slot, field: 'other', value: JSON.stringify(v) }];
  });
}

/**
 * The same change? An added step by its kind and title (whenever it is due);
 * a status by its value; a place by the step it follows; a due date when the
 * two are within a week, so a date counted in days from today is the same
 * change tomorrow.
 */
export function samePart(a: OpPart, b: OpPart): boolean {
  if (a.slot !== b.slot) return false;
  if (a.field === 'add') return true;
  if (a.field === 'dueAt' && typeof a.value === 'number' && typeof b.value === 'number') return Math.abs(a.value - b.value) <= MINOR_DUE_SHIFT_MS;
  return a.value === b.value;
}

/**
 * What Will's no to a part covers: an added step by its kind and title, a
 * status by its value, a date or a place by the field alone (he turned down
 * moving it, whatever day or place the next review would name).
 */
export const refusalOf = (p: OpPart): string => (p.field === 'status' ? `${p.slot}=${String(p.value)}` : p.slot);

/** One of the goal's review cards waiting for Will. */
export interface WaitingCard {
  id: string;
  ops: readonly PlanOp[];
}

export interface ComposeContext {
  steps: readonly PlanStepState[];
  horizonAt: string | null;
  /** The goal's linked items' labels, by entity id (made from their keys, items.ts). */
  labels: ReadonlyMap<string, string>;
  /** The goal's checks' words, by id. */
  criteria: ReadonlyMap<string, string>;
  /** The goal's review cards waiting for Will, oldest first. None in the trial week. */
  waiting?: readonly WaitingCard[];
  /** What Will turned down lately (refusalOf). */
  rejected?: ReadonlySet<string>;
}

export interface Suggestion {
  change: TemplateOp;
  class: PlanOpClass;
  /** The plan key its new operation is under; null when it makes none. */
  key: string | null;
  /** The waiting card that already asks for it, or null. */
  card: string | null;
  /** Why it makes no operation and is on no card: Will turned it down, or it no longer fits the plan. */
  held: 'rejected' | 'stale' | null;
}

export interface Composition {
  suggestions: Suggestion[];
  /** The NEW operations, by plan key, in the order they were suggested. */
  ops: Map<string, { op: PlanOp; class: PlanOpClass }>;
  /** Waiting cards to withdraw: they no longer apply, or this review changes the same thing differently. */
  withdraw: string[];
}

/**
 * The suggestions against the plan as it stands NOW and the cards already
 * waiting:
 *  1. each suggestion that still fits (its step there and open, something left
 *     to change) is one part;
 *  2. a part Will turned down is held (`rejected`);
 *  3. a waiting card that no longer applies, or that changes what a part
 *     changes but differently, is withdrawn;
 *  4. a part a remaining waiting card already asks for is that card's: nothing
 *     new is filed for it, and it takes the card's date;
 *  5. the rest become new operations: an add gets the next key no step or
 *     waiting card has and an ordinal between its neighbours; a change gets its
 *     precondition (`from`: the step's title and each field it changes, as they
 *     are). New changes to one step are one operation, bigger if any part is.
 */
export function composeDiff(changes: readonly TemplateOp[], c: ComposeContext): Composition {
  const byKey = new Map(c.steps.map((s) => [s.key, s]));
  const order = inOrder(c.steps).map((s) => s.key);
  const rejected = c.rejected ?? new Set<string>();

  // 1 and 2.
  interface Wanted { part: OpPart; title?: string; step?: PlanStepState }
  const suggestions: Suggestion[] = [];
  const wanted: Array<Wanted | null> = changes.map((change) => {
    const step = 'key' in change ? byKey.get(change.key) : undefined;
    const s: Suggestion = { change, class: classify(change, step, c.horizonAt), key: null, card: null, held: 'stale' };
    suggestions.push(s);
    let w: Wanted;
    if (change.op === 'add') {
      const title = stepTitle(change.template, { ...(change.entityId ? { label: c.labels.get(change.entityId) } : {}), ...(change.criterion ? { criterion: c.criteria.get(change.criterion) } : {}) });
      if (!title) return null;
      w = { part: { slot: `add|${STEP_TEMPLATES[change.template].kind}|${title}`, field: 'add', value: null }, title };
    } else {
      // A done step stays done, and a skipped one comes back only by Will's own card.
      if (!step || step.status === 'done' || step.status === 'skipped') return null;
      if (change.op === 'due') {
        if (step.dueAt === change.dueAt) return null;
        w = { part: { slot: `set|${step.key}|dueAt`, field: 'dueAt', value: Date.parse(change.dueAt) }, step };
      } else if (change.op === 'status' || change.op === 'skip') {
        const status = change.op === 'skip' ? 'skipped' : change.status;
        if (step.status === status) return null;
        w = { part: { slot: `set|${step.key}|status`, field: 'status', value: status }, step };
      } else {
        // Already right after it (or already first), or after a step the plan no longer has: nothing to move.
        const before = order[order.indexOf(step.key) - 1] ?? null;
        if (before === change.after || (change.after !== null && !byKey.has(change.after))) return null;
        w = { part: { slot: `set|${step.key}|ordinal`, field: 'ordinal', value: change.after ?? '' }, step };
      }
    }
    if (rejected.has(refusalOf(w.part))) {
      s.held = 'rejected';
      return null;
    }
    return w;
  });
  const live = wanted.filter((w): w is Wanted => w !== null);

  // 3. The waiting cards: which still apply, and which this review changes differently.
  const withdraw: string[] = [];
  const kept: Array<{ id: string; ops: readonly PlanOp[]; parts: OpPart[] }> = [];
  for (const card of c.waiting ?? []) {
    const parts = card.ops.flatMap((o) => partsOf(o, c.steps));
    const applies = composePlan(c.steps, card.ops).ok;
    const differs = parts.some((p) => live.some((w) => w.part.slot === p.slot && !samePart(w.part, p)));
    if (!applies || differs) withdraw.push(card.id);
    else kept.push({ id: card.id, ops: card.ops, parts });
  }

  // 4. What a kept card already asks for.
  wanted.forEach((w, i) => {
    if (!w) return;
    const s = suggestions[i]!;
    for (const card of kept) {
      const at = card.parts.findIndex((p) => samePart(p, w.part));
      if (at < 0) continue;
      s.card = card.id;
      s.held = null;
      // The card's own date is the one Will is asked to sign: the review records that one.
      const op = card.ops.find((o) => partsOf(o, c.steps).some((p) => samePart(p, w.part)))!;
      const date = op.op === 'add' ? op.step.dueAt : op.to.dueAt;
      if (s.change.op === 'add') s.change = { ...s.change, dueAt: date ?? null };
      else if (s.change.op === 'due' && typeof date === 'string') s.change = { ...s.change, dueAt: date };
      wanted[i] = null;
      return;
    }
  });

  // 5. New operations. Keys and places the kept cards' new steps would take are left to them.
  const reserved = kept.flatMap((k) => k.ops.flatMap((o) => (o.op === 'add' ? [o] : [])));
  /** Every step's place, the adds' included, to find a neighbour. */
  const ordinals = new Map<string, number>([...c.steps.map((s) => [s.key, s.ordinal] as const), ...reserved.map((o) => [o.key, o.step.ordinal] as const)]);
  let lastKey = [...ordinals.keys()].reduce((n, k) => Math.max(n, Number(k.slice(1)) || 0), 0);
  /** An ordinal right after `after` (null: after everything), or undefined when there is no room. */
  const placeAfter = (after: string | null, moving?: string): number | undefined => {
    const others = [...ordinals.entries()].filter(([k]) => k !== moving).map(([, o]) => o);
    if (after === null) {
      const max = others.reduce((m, o) => Math.max(m, o), 0);
      return max + ORDINAL_STEP <= MAX_ORDINAL ? max + ORDINAL_STEP : max + 1 <= MAX_ORDINAL ? max + 1 : undefined;
    }
    const at = ordinals.get(after);
    if (at === undefined) return undefined;
    const next = others.filter((o) => o > at).reduce<number | undefined>((m, o) => (m === undefined || o < m ? o : m), undefined);
    if (next === undefined) return at + ORDINAL_STEP <= MAX_ORDINAL ? at + ORDINAL_STEP : undefined;
    const mid = Math.floor((at + next) / 2);
    return mid > at ? mid : undefined;
  };
  const adds = new Map<string, PlanOp>();
  const sets = new Map<string, { from: Record<string, unknown>; to: Record<string, unknown> }>();
  wanted.forEach((w, i) => {
    if (!w) return;
    const s = suggestions[i]!;
    const change = s.change;
    if (change.op === 'add') {
      if (lastKey >= 999 || ordinals.size >= 1000) return;
      const ordinal = placeAfter(change.after) ?? placeAfter(null);
      if (ordinal === undefined) return;
      const key = `s${++lastKey}`;
      ordinals.set(key, ordinal);
      adds.set(key, { op: 'add', key, step: { ordinal, title: w.title!, kind: STEP_TEMPLATES[change.template].kind, tier: 'approval', dueAt: change.dueAt, dependsOn: [] } });
      s.key = key;
      s.held = null;
      return;
    }
    const step = w.step!;
    const set = sets.get(step.key) ?? { from: { title: step.title }, to: {} };
    const put = (field: 'dueAt' | 'status' | 'ordinal', now: unknown, next: unknown): boolean => {
      if (field in set.to || now === next) return false;
      set.from[field] = now;
      set.to[field] = next;
      return true;
    };
    let changed = false;
    if (change.op === 'due') changed = put('dueAt', step.dueAt, change.dueAt);
    else if (change.op === 'status') changed = put('status', step.status, change.status);
    else if (change.op === 'skip') changed = put('status', step.status, 'skipped');
    else {
      const ordinal = change.after === null ? firstOrdinal(c.steps, step.key) : placeAfter(change.after, step.key);
      changed = ordinal !== undefined && put('ordinal', step.ordinal, ordinal);
      if (changed) ordinals.set(step.key, ordinal!);
    }
    if (!changed) return;
    sets.set(step.key, set);
    s.key = step.key;
    s.held = null;
  });
  // The operations in the order they were suggested (a review files its first 2 bigger ones): a step's
  // suggestions share one operation, and so its class, bigger if any part of it is.
  const ops = new Map<string, { op: PlanOp; class: PlanOpClass }>();
  for (const s of suggestions) {
    if (!s.key) continue;
    const set = sets.get(s.key);
    const op = set ? ({ op: 'set', key: s.key, from: set.from, to: set.to } as PlanOp) : adds.get(s.key)!;
    const made = ops.get(s.key) ?? { op, class: classifyPlanOp(op, byKey.get(s.key), c.horizonAt) };
    ops.set(s.key, made);
    s.class = made.class;
  }
  return { suggestions, ops, withdraw };
}

/** An ordinal before every other step, or undefined when there is no room before the first. */
function firstOrdinal(steps: readonly PlanStepState[], moving: string): number | undefined {
  const min = steps.filter((s) => s.key !== moving).reduce<number | undefined>((m, s) => (m === undefined || s.ordinal < m ? s.ordinal : m), undefined);
  if (min === undefined) return undefined;
  const at = Math.floor(min / 2);
  return at >= 1 && at < min ? at : undefined;
}

/** What a review reads of a linked item. */
export interface LinkedEntity {
  id: string;
  kind: string;
  key: string;
  name: string;
  status: string;
  state: unknown;
  taintedPaths: readonly string[];
  firstSeenAt: Date;
}

/** A linked item as a review may name it: its ref, its kind, clean enums, and a label made from its key. Never its name or a title. */
export interface LinkedItem {
  entityId: string;
  ref: string;
  kind: string;
  status: 'active' | 'finished' | 'replaced';
  fields: Record<string, string>;
  label: string;
}

/**
 * One item for the prompt and the templates. Its fields are only the structural
 * ones a check may look at (CHECK_PATHS), and only a value that field is known to
 * take, from a path no outside text reached: so nothing a stranger wrote (a pull
 * request's title, an issue's labels) can ride into the model's prompt.
 */
export function itemOf(e: LinkedEntity, tz: string, now = new Date()): LinkedItem {
  const state = e.state && typeof e.state === 'object' && !Array.isArray(e.state) ? (e.state as Record<string, unknown>) : {};
  const fields = Object.fromEntries(
    Object.entries(CHECK_PATHS[e.kind] ?? {}).flatMap(([k, values]) => {
      const v = state[k];
      return typeof v === 'string' && values.includes(v) && !isPathTainted(`state.${k}`, e.taintedPaths) ? [[k, v] as const] : [];
    }),
  );
  // An item its source archived is finished (a merged pull request, an ended thread); one merged into another was replaced.
  return { entityId: e.id, ref: entityRef(e.kind, e.id), kind: e.kind, status: e.status === 'archived' ? 'finished' : e.status === 'merged' ? 'replaced' : 'active', fields, label: labelOf(e, tz, now) };
}

/** The goal's linked items, one per ref, each by the label the panel shows for it (labelFor). Forgotten items are left out. */
export async function linkedItems(db: Db | Tx, goalId: string, tz: string, now = new Date()): Promise<LinkedItem[]> {
  const links = await db.goalEntity.findMany({
    where: { goalId }, orderBy: { entityId: 'asc' },
    select: { entity: { select: { id: true, kind: true, key: true, name: true, status: true, state: true, taintedPaths: true, firstSeenAt: true } } },
  });
  const seen = new Set<string>();
  const out: LinkedItem[] = [];
  for (const { entity: e } of links) {
    const item = itemOf(e, tz, now);
    if (e.status === 'forgotten' || seen.has(item.ref)) continue;
    seen.add(item.ref);
    out.push({ ...item, label: await labelFor(db, e, tz, now) });
  }
  return out;
}

interface GoalFacts {
  id: string;
  status: string;
  title: string;
  description: string;
  successCriteria: unknown;
  criteriaMet: unknown;
  horizonAt: Date | null;
  tainted: boolean;
}

/** The goal row, locked for this transaction before anything else of it is read or written. */
async function lockGoal(tx: Tx, id: string): Promise<GoalFacts | undefined> {
  await tx.$queryRaw`SELECT set_config('flint.actor', ${GOALS_ACTOR}, true)`;
  const [g] = await tx.$queryRaw<GoalFacts[]>`
    SELECT id, status, title, description, "successCriteria", "criteriaMet", "horizonAt", tainted FROM "Goal" WHERE id = ${id} FOR UPDATE`;
  return g;
}

const READ_COMMITTED = { maxWait: 10_000, timeout: 20_000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted } as const;

export interface PlanStageDeps {
  db: Db;
  bus: Pick<Bus, 'boss'>;
  config: Pick<Config, 'tz' | 'server' | 'ollama'>;
  /** For the tests: the load check, the model's fetch and its timeout. */
  load?: () => Promise<Load>;
  fetch?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
  log?: (msg: string) => void;
  /** For the tests: how a card is filed, and a fault between filing the cards and writing the review. */
  file?: typeof createProposal;
  afterFiling?: () => Promise<void>;
}

export type PlanOutcome =
  /** The model answered: its suggestions are recorded. `filed`: new cards; `kept`: waiting cards that already asked for a suggestion. */
  | { outcome: 'planned'; reviewId: string; suggested: number; filed: number; kept: number }
  /** Chat is busy: the job comes back shortly. */
  | { outcome: 'deferred'; reviewId: string }
  /** The model was not there: the job comes back in a couple of minutes. */
  | { outcome: 'retrying'; reviewId: string }
  /** No answer: the review says why (`none:<why>`). */
  | { outcome: 'none'; reviewId: string; why: 'off' | 'capped' | 'unavailable' | 'invalid' | 'deferred' | 'skipped' }
  /** Nothing waits for a plan stage (the goal is gone or not active, or its latest review has had one). */
  | { outcome: 'nothing' };

/** The goal's review cards waiting for Will, oldest first, as the operations they hold. One whose args no longer read is left alone. */
async function waitingCards(db: Db | Tx, goalId: string, now: Date): Promise<WaitingCard[]> {
  const rows = await db.proposal.findMany({
    where: { status: 'pending', action: 'plan.change', origin: GOALS_ORIGIN, expiresAt: { gt: now }, args: { path: ['goalId'], equals: goalId } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 100, select: { id: true, args: true },
  });
  return rows.flatMap((r) => {
    const a = PlanChangeArgs.safeParse(r.args);
    return a.success ? [{ id: r.id, ops: a.data.ops }] : [];
  });
}

/**
 * What Will turned down lately, by part (refusalOf): the goal's last 50 review
 * cards HE rejected. A card Flint withdrew itself is not his no, and is left
 * out by the query, so withdrawals never crowd his rejections out of the 50.
 */
async function turnedDown(db: Db | Tx, goalId: string, steps: readonly PlanStepState[]): Promise<Set<string>> {
  const rows = await db.proposal.findMany({
    where: {
      status: 'rejected', action: 'plan.change', origin: GOALS_ORIGIN, args: { path: ['goalId'], equals: goalId },
      OR: [{ error: null }, { error: { not: SAY.replacedReview } }],
    },
    orderBy: { createdAt: 'desc' }, take: 50, select: { args: true },
  });
  const out = new Set<string>();
  for (const r of rows) {
    const a = PlanChangeArgs.safeParse(r.args);
    if (a.success) for (const op of a.data.ops) for (const part of partsOf(op, steps)) out.add(refusalOf(part));
  }
  return out;
}

/**
 * Run the plan stage for a goal's LATEST review. The job names a review, but a
 * goal has one plan job waiting at a time: a newer review's job is the same
 * job. So the latest review still waiting is the one planned, and any older one
 * still waiting is closed as skipped.
 */
export async function runPlan(d: PlanStageDeps, job: PlanJob): Promise<PlanOutcome> {
  const now = d.now?.() ?? new Date();
  const { db } = d;
  const tz = d.config.tz;

  // 1. The goal as it stands, under its lock; then the lock is let go before the model is asked.
  const snap = await db.$transaction(async (tx) => {
    const g = await lockGoal(tx, job.goalId);
    if (!g) return undefined;
    const waiting = await tx.goalReview.findMany({ where: { goalId: g.id, planner: null }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true, shadow: true } });
    const latest = await tx.goalReview.findFirst({ where: { goalId: g.id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true } });
    const target = g.status === 'active' ? waiting.find((r) => r.id === latest?.id) : undefined;
    for (const r of waiting) if (r.id !== target?.id) await tx.goalReview.update({ where: { id: r.id }, data: { planner: 'none:skipped' } });
    if (!target) return undefined;
    const criteria = criteriaOf(g);
    const plan = await activePlan(tx, g.id);
    const items = await linkedItems(tx, g.id, tz, now);
    const states = new Map<string, CheckState>(evaluate(criteria, marksOf(g), plan?.steps ?? null, await itemFacts(tx, checkedItems(criteria))).criteria.map((c) => [c.id, c.state]));
    const facts: PlanFacts = {
      today: localDay(tz, now), finishBy: g.horizonAt ? localDay(tz, g.horizonAt) : null, title: g.title, why: g.description, tainted: g.tainted,
      criteria: criteria.map((c) => ({ id: c.id, text: c.text, state: states.get(c.id) ?? 'unknown' })),
      steps: (plan?.steps ?? []).map((s) => ({ key: s.key, title: s.title, status: s.status, kind: s.kind, due: s.dueAt ? localDay(tz, new Date(s.dueAt)) : null })),
      items: items.map((i) => ({ ref: i.ref, kind: i.kind, status: i.status, fields: i.fields })),
    };
    return { review: target, facts, steps: plan?.steps ?? [], items: new Map(items.map((i) => [i.ref, i.entityId])), criteria: new Set(criteria.map((c) => c.id)) };
  }, READ_COMMITTED);
  if (!snap) return { outcome: 'nothing' };
  const reviewId = snap.review.id;

  // 2. May it run, and is there a model to ask?
  const standing = await reviewStanding(db, now);
  if (!standing.may) return settleNone(d, job.goalId, reviewId, 'skipped', standing.tier, now);
  const ollama = d.config.ollama;
  if (!ollama) return settleNone(d, job.goalId, reviewId, 'off', standing.tier, now);
  const cap = standing.cap ?? CODE_TABLE[REVIEW_ACTION]?.cap ?? { limit: 20, period: 'day' as const };

  // 3. The local model, one request at a time, yielding to chat.
  const planned = await planDiff(snap.facts, {
    ollama,
    load: d.load ?? chatLoad(d.config.server),
    claim: async () => (await claim(db, REVIEW_ACTION, cap, tz, now)) !== null,
    ...(job.claimed ? { claimed: true } : {}),
    // What a run that yielded to chat already asked: the 2 requests are the review's, not each run's.
    ...(job.requests ? { used: job.requests } : {}),
    resolve: (ops) => resolveReply(ops, { steps: snap.steps, items: snap.items, criteria: snap.criteria }, tz, now),
    ...(d.fetch ? { fetch: d.fetch } : {}),
    ...(d.timeoutMs ? { timeoutMs: d.timeoutMs } : {}),
  });
  // Stately on the goal: this job is running, so one more may wait.
  const again = (data: PlanJob, seconds: number) => d.bus.boss.send(PLAN_QUEUE, data, { singletonKey: job.goalId, startAfter: seconds });
  const carried = { goalId: job.goalId, reviewId, ...(planned.claimed ? { claimed: true as const } : {}) };
  if (!planned.ok && planned.why === 'deferred') {
    const n = (job.deferrals ?? 0) + 1;
    if (n <= MAX_DEFERRALS) {
      await again({ ...carried, deferrals: n, ...(planned.requests ? { requests: planned.requests } : {}), ...(job.retries ? { retries: job.retries } : {}) }, DEFER_SECONDS);
      return { outcome: 'deferred', reviewId };
    }
    // Chat has been busy for ten minutes: the review stands without a plan stage, and health says so.
    await db.healthCheck.create({ data: { component: 'goals.deferral', status: 'degraded', detail: `Chat was busy for ${(MAX_DEFERRALS * DEFER_SECONDS) / 60} minutes, so a goal review suggested no plan changes.`, at: now } });
  }
  if (!planned.ok && planned.why === 'unavailable') {
    // The model was not there (Ollama stopped, a model still loading): a new attempt later, with its own 2 requests.
    const n = (job.retries ?? 0) + 1;
    if (n <= MAX_RETRIES) {
      await again({ ...carried, retries: n, ...(job.deferrals ? { deferrals: job.deferrals } : {}) }, RETRY_SECONDS);
      return { outcome: 'retrying', reviewId };
    }
  }
  if (!planned.ok) return settleNone(d, job.goalId, reviewId, planned.why, standing.tier, now, { requests: planned.requests, modelMs: planned.modelMs });

  // 4. The suggestions against the plan as it stands now (it may have changed while the model ran), the
  //    cards already waiting and what Will turned down.
  const composed = await db.$transaction(async (tx) => {
    const g = await lockGoal(tx, job.goalId);
    const review = await tx.goalReview.findUnique({ where: { id: reviewId }, select: { planner: true, shadow: true } });
    if (!g || !review || review.planner !== null) return undefined;
    // Finished or paused while the model ran: its suggestions are for a goal that no longer takes any.
    if (g.status !== 'active') {
      await tx.goalReview.update({ where: { id: reviewId }, data: { planner: 'none:skipped' } });
      return undefined;
    }
    const shadow = review.shadow || standing.shadow;
    const plan = await activePlan(tx, g.id);
    const steps = plan?.steps ?? [];
    const items = await linkedItems(tx, g.id, tz, now);
    const c = composeDiff(planned.value, {
      steps, horizonAt: g.horizonAt?.toISOString() ?? null,
      labels: new Map(items.map((i) => [i.entityId, i.label])), criteria: new Map(criteriaOf(g).map((x) => [x.id, x.text])),
      // The trial week files nothing and touches no card.
      waiting: shadow ? [] : await waitingCards(tx, g.id, now),
      rejected: await turnedDown(tx, g.id, steps),
    });
    return { ...c, goal: { id: g.id, title: g.title, tainted: g.tainted }, shadow };
  }, READ_COMMITTED);
  if (!composed) return { outcome: 'nothing' };

  // 5. Cards, outside the trial week and only while reviews are promoted now. No lock is held while a card is filed.
  const held = new Map<string, Held>();
  const cardOf = new Map<string, string>();
  if (composed.shadow) for (const k of composed.ops.keys()) held.set(k, 'shadow');
  else await fileCards(d, composed.goal, composed.ops, composed.withdraw, held, cardOf, now);
  await d.afterFiling?.();

  // 6. The review's record: how its plan stage ended, what it suggested, and its card.
  const diff: DiffItem[] = composed.suggestions.map((s) => {
    const card = s.card ?? (s.key ? (cardOf.get(s.key) ?? null) : null);
    return { change: s.change, class: s.class, card, held: card ? null : (s.held ?? (s.key ? (held.get(s.key) ?? 'stale') : 'stale')) };
  });
  const filed = [...new Set(cardOf.values())];
  const kept = [...new Set(composed.suggestions.flatMap((s) => (s.card ? [s.card] : [])))];
  const first = filed[0] ?? kept[0];
  await db.$transaction(async (tx) => {
    await lockGoal(tx, job.goalId);
    const review = await tx.goalReview.findUnique({ where: { id: reviewId }, select: { planner: true } });
    if (!review || review.planner !== null) return;
    await tx.goalReview.update({ where: { id: reviewId }, data: { planner: `ollama:${ollama.model}`, diff: diff as unknown as Prisma.InputJsonArray, ...(first ? { proposalId: first } : {}) } });
    await appendAudit(tx, [{
      actor: GOALS_ACTOR, context: 'autonomous', kind: 'action', action: REVIEW_ACTION, tier: standing.tier, decision: composed.shadow ? 'log' : 'act', outcome: 'ok', correlationId: reviewId,
      inputs: {
        goalId: job.goalId, reviewId, stage: 'plan', planner: 'ollama', reasonCode: planned.reasonCode, suggested: diff.length,
        minor: diff.filter((x) => x.class === 'minor').length, material: diff.filter((x) => x.class === 'material').length,
        cards: filed.length, kept: kept.length, withdrawn: composed.shadow ? 0 : composed.withdraw.length,
        stale: diff.filter((x) => x.held === 'stale').length, requests: planned.requests, modelMs: planned.modelMs,
        droppedSteps: planned.dropped.steps, droppedItems: planned.dropped.items, shadow: composed.shadow,
      },
    }], now);
  }, READ_COMMITTED);
  return { outcome: 'planned', reviewId, suggested: diff.length, filed: filed.length, kept: kept.length };
}

/** The review's plan stage ended without an answer: it says why, and so does the audit trail. No card is touched. */
async function settleNone(
  d: PlanStageDeps, goalId: string, reviewId: string, why: 'off' | 'capped' | 'unavailable' | 'invalid' | 'deferred' | 'skipped', tier: 'alone' | 'approval' | 'forbidden', now: Date,
  model: { requests: number; modelMs: number } = { requests: 0, modelMs: 0 },
): Promise<PlanOutcome> {
  await d.db.$transaction(async (tx) => {
    await lockGoal(tx, goalId);
    const review = await tx.goalReview.findUnique({ where: { id: reviewId }, select: { planner: true } });
    if (!review || review.planner !== null) return;
    await tx.goalReview.update({ where: { id: reviewId }, data: { planner: `none:${why}` } });
    await appendAudit(tx, [{
      actor: GOALS_ACTOR, context: 'autonomous', kind: 'action', action: REVIEW_ACTION, tier, decision: 'log', outcome: why === 'invalid' || why === 'unavailable' ? 'failed' : 'skipped', correlationId: reviewId,
      inputs: { goalId, reviewId, stage: 'plan', planner: why, requests: model.requests, modelMs: model.modelMs },
    }], now);
  }, READ_COMMITTED);
  return { outcome: 'none', reviewId, why };
}

/**
 * File the review's NEW cards: one for every small operation, one each for up
 * to 2 bigger ones, within the day's 9. `held` says why an operation is on no
 * card; `cardOf` which card each filed operation is on. Then the waiting cards
 * the composition named are withdrawn: nothing else of the goal's queue is
 * touched, whatever was or was not filed here.
 */
async function fileCards(
  d: PlanStageDeps, goal: { id: string; title: string; tainted: boolean }, ops: ReadonlyMap<string, { op: PlanOp; class: PlanOpClass }>,
  withdraw: readonly string[], held: Map<string, Held>, cardOf: Map<string, string>, now: Date,
): Promise<void> {
  const { db } = d;
  const tz = d.config.tz;
  const file = d.file ?? createProposal;
  const all = [...ops];
  const minor = all.filter(([, o]) => o.class === 'minor');
  const material = all.filter(([, o]) => o.class === 'material');
  for (const [key] of material.slice(GOAL_BUDGETS.materialPerReview)) held.set(key, 'limit');
  const batches: Array<{ template: 'plan.diff.minor' | 'plan.diff.material'; entries: Array<[string, { op: PlanOp }]> }> = [
    ...(minor.length ? [{ template: 'plan.diff.minor' as const, entries: minor }] : []),
    ...material.slice(0, GOAL_BUDGETS.materialPerReview).map((m) => ({ template: 'plan.diff.material' as const, entries: [m] })),
  ];
  const cap = { limit: GOAL_BUDGETS.planCardsPerDay, period: 'day' as const };
  const used = async () => (await db.actionCounter.findUnique({ where: { action_day: { action: PLAN_CARDS_COUNTER, day: periodKey(cap, tz, now) } }, select: { count: true } }))?.count ?? 0;
  for (const b of batches) {
    const hold = (why: Held) => b.entries.forEach(([key]) => held.set(key, why));
    if ((await used()) >= cap.limit) {
      hold('cap');
      continue;
    }
    try {
      const filed = await file(db, {
        kind: 'plan', origin: GOALS_ORIGIN, action: 'plan.change', templateId: b.template,
        args: { goalId: goal.id, goalTitle: goal.title, ops: b.entries.map(([, o]) => o.op) },
        // Where each part came from, by id: the operations from the local model's choice among templates, a new step's title from a template, the goal's title from Will.
        argsProvenance: {
          goalTitle: { source: 'will', tainted: goal.tainted },
          ops: { source: 'model', ref: REVIEW_ACTION, tainted: false },
          'ops.title': { source: 'template', ref: STEP_TEMPLATES_REF, tainted: false },
        },
        tainted: goal.tainted, sensitivity: 'personal', destructive: false, consequential: b.template === 'plan.diff.material', ttlMinutes: CARD_TTL_MINUTES,
      }, GOALS_ACTOR, now);
      // The very same card again (a run that died after filing it) is the same waiting card: it is counted once.
      if (!filed.deduped) await claim(db, PLAN_CARDS_COUNTER, cap, tz, now);
      b.entries.forEach(([key]) => cardOf.set(key, filed.id));
    } catch (err) {
      // The plan moved on under the suggestion, or the card could not be filed as it is: it waits for the next review.
      if (!(err instanceof Refused)) d.log?.(`filing a plan card failed: ${failureClass(err)}`);
      hold('stale');
    }
  }
  for (const id of withdraw) await rejectProposal(db, id, { error: SAY.replacedReview }, undefined, GOALS_ACTOR).catch(() => {});
}
