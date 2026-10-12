/**
 * A review's plan stage, the runtime's part (P3 part 3; exit criterion 4):
 * what the local model suggested (planner.ts, steps.ts) becomes cards Will
 * signs, or, in the trial week, a record of what it would have suggested.
 * EVERY plan change is a Proposal(kind=plan): nothing here writes a plan.
 *
 * Minor and material, decided here by rule, never by the model:
 *  - minor: a status moved among todo, in progress and blocked; a due date
 *    moved by at most 7 days and not past the goal's finish date; a step
 *    reordered. All of a review's minor changes go on ONE card (it rides
 *    Approve All).
 *  - material: a step added; a step skipped; a due date set where there was
 *    none, moved by more than 7 days, or past the finish date; anything on a
 *    Flint action or a decision. Each goes on a card of its own, marked for a
 *    fresh touch, at most 2 a review; the rest wait for the next review.
 *  - at most 9 plan cards a day across every goal.
 *
 * A card's args are {goalId, goalTitle, ops}, each op with its precondition (the
 * step as it is now): no review, plan or version id, so the same suggestion
 * again is the same waiting card, and cards on different steps compose. They
 * are PERSONAL, kept 7 days, with a fixed reason; their parts are named by
 * where they came from (the model, a template, Will). When a review's answer is
 * in, the goal's older waiting runtime cards that it did not suggest again are
 * withdrawn unsigned ("A newer review replaced it."). A change Will rejected is
 * not suggested again while its rejected card still holds its args (7 days).
 *
 * Shadow (the trial week: goal.review.local not promoted): nothing is filed.
 * GoalReview.diff keeps the would-be changes, as ids and enums, and the panel
 * says them as sentences.
 *
 * Lock order: each of the stage's three short transactions takes the goal FOR
 * UPDATE first, at READ COMMITTED; none is open while the model runs or a card
 * is filed. It yields to chat as triage does: while a chat turn runs, the job
 * comes back in 15 s, at most 40 times; past that the review records
 * `none:deferred` and Settings > Health says so.
 */
import { Prisma } from '@prisma/client';
import {
  CHECK_PATHS,
  CODE_TABLE,
  GOAL_BUDGETS,
  PLAN_CARDS_COUNTER,
  PlanChangeArgs,
  entityRef,
  isPathTainted,
  localDay,
  type CheckState,
  type PlanOp,
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
import { labelOf } from './items.js';
import { GOALS_ACTOR } from './ontrack.js';
import { activePlan } from './ops.js';
import { planDiff, type PlanFacts } from './planner.js';
import { PLAN_QUEUE, REVIEW_ACTION, reviewStanding, type PlanJob } from './review.js';
import { STEP_TEMPLATES, STEP_TEMPLATES_REF, resolveReply, stepTitle, type DiffItem, type Held, type TemplateOp } from './steps.js';

const DAY = 86_400_000;
/** A due date moved by more than this is material. */
export const MINOR_DUE_SHIFT_MS = 7 * DAY;
/** How long a plan card waits for Will: a week, as long as the longest wait between two weekly reviews. */
const CARD_TTL_MINUTES = 7 * 24 * 60;
export const DEFER_SECONDS = 15;
export const MAX_DEFERRALS = 40;
/** Room between two steps' ordinals, as the panel's own Add Step leaves it. */
const ORDINAL_STEP = 100;
const MAX_ORDINAL = 1_000_000;

/** Minor or material, by rule. `step` is the step as it stands (undefined for a new one). */
export function classify(change: TemplateOp, step: Pick<PlanStepState, 'kind' | 'dueAt'> | undefined, horizonAt: string | null): 'minor' | 'material' {
  if (change.op === 'add' || change.op === 'skip') return 'material';
  if (step && (step.kind === 'flint_action' || step.kind === 'decision')) return 'material';
  if (change.op === 'due') {
    if (!step?.dueAt) return 'material';
    if (Math.abs(Date.parse(change.dueAt) - Date.parse(step.dueAt)) > MINOR_DUE_SHIFT_MS) return 'material';
    if (horizonAt && Date.parse(change.dueAt) > Date.parse(horizonAt)) return 'material';
  }
  return 'minor';
}

export interface ComposeContext {
  steps: readonly PlanStepState[];
  horizonAt: string | null;
  /** The goal's linked items' labels, by entity id (made from their keys, items.ts). */
  labels: ReadonlyMap<string, string>;
  /** The goal's checks' words, by id. */
  criteria: ReadonlyMap<string, string>;
}

export interface Suggestion {
  change: TemplateOp;
  class: 'minor' | 'material';
  /** The plan key its operation is under; null when it no longer fits the plan (stale). */
  key: string | null;
}

/**
 * The suggestions as signed operations on the plan as it stands NOW: an add gets
 * the next key and an ordinal between its neighbours; a change gets its
 * precondition (`from`: the step's title and each field it changes, as they
 * are). Changes to one step become one operation, material if any part is. A
 * suggestion that no longer fits (its step gone, done or skipped; nothing left
 * to change; no room) is stale and makes no operation.
 */
export function composeDiff(changes: readonly TemplateOp[], c: ComposeContext): { suggestions: Suggestion[]; ops: Map<string, { op: PlanOp; class: 'minor' | 'material' }> } {
  const byKey = new Map(c.steps.map((s) => [s.key, s]));
  /** Every step's place, the adds' included, to find a neighbour. */
  const ordinals = new Map(c.steps.map((s) => [s.key, s.ordinal]));
  let lastKey = c.steps.reduce((n, s) => Math.max(n, Number(s.key.slice(1)) || 0), 0);
  const ops = new Map<string, { op: PlanOp; class: 'minor' | 'material' }>();
  const sets = new Map<string, { from: Record<string, unknown>; to: Record<string, unknown>; class: 'minor' | 'material' }>();
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
  const suggestions = changes.map((change): Suggestion => {
    const stale: Suggestion = { change, class: classify(change, 'key' in change ? byKey.get(change.key) : undefined, c.horizonAt), key: null };
    if (change.op === 'add') {
      const title = stepTitle(change.template, { ...(change.entityId ? { label: c.labels.get(change.entityId) } : {}), ...(change.criterion ? { criterion: c.criteria.get(change.criterion) } : {}) });
      if (!title || lastKey >= 999 || ordinals.size >= 1000) return stale;
      const ordinal = placeAfter(change.after) ?? placeAfter(null);
      if (ordinal === undefined) return stale;
      const key = `s${++lastKey}`;
      ordinals.set(key, ordinal);
      ops.set(key, { op: { op: 'add', key, step: { ordinal, title, kind: STEP_TEMPLATES[change.template].kind, tier: 'approval', dueAt: change.dueAt, dependsOn: [] } }, class: 'material' });
      return { change, class: 'material', key };
    }
    const step = byKey.get(change.key);
    // A done step stays done, and a skipped one comes back only by Will's own card.
    if (!step || step.status === 'done' || step.status === 'skipped') return stale;
    const set = sets.get(step.key) ?? { from: { title: step.title }, to: {}, class: 'minor' as const };
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
      // Already right after it (or already first): nothing to move.
      const order = [...c.steps].sort((a, b) => a.ordinal - b.ordinal || (a.key < b.key ? -1 : 1)).map((s) => s.key);
      const before = order[order.indexOf(step.key) - 1] ?? null;
      const ordinal = change.after === null ? firstOrdinal(c.steps, step.key) : placeAfter(change.after, step.key);
      changed = before !== change.after && ordinal !== undefined && put('ordinal', step.ordinal, ordinal);
      if (changed) ordinals.set(step.key, ordinal!);
    }
    if (!changed) return stale;
    if (stale.class === 'material') set.class = 'material';
    sets.set(step.key, set);
    return { change, class: stale.class, key: step.key };
  });
  // The operations in the order they were suggested (a review files its first 2 material ones): a step's
  // suggestions share one operation, and so its class, material if any part of it is.
  const ordered = new Map<string, { op: PlanOp; class: 'minor' | 'material' }>();
  for (const s of suggestions) {
    if (!s.key) continue;
    const set = sets.get(s.key);
    const made = set ? { op: { op: 'set', key: s.key, from: set.from, to: set.to } as PlanOp, class: set.class } : ops.get(s.key)!;
    if (!ordered.has(s.key)) ordered.set(s.key, made);
    s.class = made.class;
  }
  return { suggestions, ops: ordered };
}

/** An ordinal before every other step, or undefined when there is no room before the first. */
function firstOrdinal(steps: readonly PlanStepState[], moving: string): number | undefined {
  const min = steps.filter((s) => s.key !== moving).reduce<number | undefined>((m, s) => (m === undefined || s.ordinal < m ? s.ordinal : m), undefined);
  if (min === undefined) return undefined;
  const at = Math.floor(min / 2);
  return at >= 1 && at < min ? at : undefined;
}

/**
 * What an operation is, for telling "the same suggestion again" from a new one:
 * an add by its kind and title, a change by its step and what it changes (a
 * status by its value; a date or a place by the field alone, since both move
 * every day). In memory only: it holds a step's words.
 */
export function opIdentity(op: PlanOp): string {
  if (op.op === 'add') return `add|${op.step.kind}|${op.step.title}`;
  return `set|${op.key}|${Object.keys(op.to).sort().map((k) => (k === 'status' ? `status=${String(op.to.status)}` : k)).join(',')}`;
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

/** The goal's linked items, one per ref. Forgotten items are left out. */
export async function linkedItems(db: Db | Tx, goalId: string, tz: string, now = new Date()): Promise<LinkedItem[]> {
  const links = await db.goalEntity.findMany({
    where: { goalId }, orderBy: { entityId: 'asc' },
    select: { entity: { select: { id: true, kind: true, key: true, name: true, status: true, state: true, taintedPaths: true, firstSeenAt: true } } },
  });
  const seen = new Set<string>();
  return links.flatMap(({ entity: e }) => {
    const item = itemOf(e, tz, now);
    if (e.status === 'forgotten' || seen.has(item.ref)) return [];
    seen.add(item.ref);
    return [item];
  });
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
}

export type PlanOutcome =
  /** The model answered: its suggestions are recorded (and filed, outside the trial week). */
  | { outcome: 'planned'; reviewId: string; suggested: number; filed: number }
  /** Chat is busy: the job comes back shortly. */
  | { outcome: 'deferred'; reviewId: string }
  /** No answer: the review says why (`none:<why>`). */
  | { outcome: 'none'; reviewId: string; why: 'off' | 'capped' | 'unavailable' | 'invalid' | 'deferred' | 'skipped' }
  /** Nothing waits for a plan stage (the goal is gone or not active, or its latest review has had one). */
  | { outcome: 'nothing' };

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
      today: localDay(tz, now), finishBy: g.horizonAt ? localDay(tz, g.horizonAt) : null, title: g.title, why: g.description,
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
    resolve: (ops) => resolveReply(ops, { steps: snap.steps, items: snap.items, criteria: snap.criteria }, tz, now),
    ...(d.fetch ? { fetch: d.fetch } : {}),
    ...(d.timeoutMs ? { timeoutMs: d.timeoutMs } : {}),
  });
  if (!planned.ok && planned.why === 'deferred') {
    const n = (job.deferrals ?? 0) + 1;
    if (n <= MAX_DEFERRALS) {
      // Stately on the goal: this job is running, so one more may wait.
      const again: PlanJob = { goalId: job.goalId, reviewId, deferrals: n, ...(planned.claimed ? { claimed: true as const } : {}) };
      await d.bus.boss.send(PLAN_QUEUE, again, { singletonKey: job.goalId, startAfter: DEFER_SECONDS });
      return { outcome: 'deferred', reviewId };
    }
    // Chat has been busy for ten minutes: the review stands without a plan stage, and health says so.
    await db.healthCheck.create({ data: { component: 'goals.deferral', status: 'degraded', detail: `Chat was busy for ${(MAX_DEFERRALS * DEFER_SECONDS) / 60} minutes, so a goal review suggested no plan changes.`, at: now } });
  }
  if (!planned.ok) return settleNone(d, job.goalId, reviewId, planned.why, standing.tier, now, { requests: planned.requests, modelMs: planned.modelMs });

  // 4. The suggestions against the plan as it stands now (it may have changed while the model ran).
  const composed = await db.$transaction(async (tx) => {
    const g = await lockGoal(tx, job.goalId);
    const review = await tx.goalReview.findUnique({ where: { id: reviewId }, select: { planner: true, shadow: true } });
    if (!g || !review || review.planner !== null) return undefined;
    // Finished or paused while the model ran: its suggestions are for a goal that no longer takes any.
    if (g.status !== 'active') {
      await tx.goalReview.update({ where: { id: reviewId }, data: { planner: 'none:skipped' } });
      return undefined;
    }
    const plan = await activePlan(tx, g.id);
    const items = await linkedItems(tx, g.id, tz, now);
    const c = composeDiff(planned.value, {
      steps: plan?.steps ?? [], horizonAt: g.horizonAt?.toISOString() ?? null,
      labels: new Map(items.map((i) => [i.entityId, i.label])), criteria: new Map(criteriaOf(g).map((x) => [x.id, x.text])),
    });
    return { ...c, goal: { id: g.id, title: g.title, tainted: g.tainted }, shadow: review.shadow };
  }, READ_COMMITTED);
  if (!composed) return { outcome: 'nothing' };

  // 5. Cards, outside the trial week and only while reviews are promoted now. No lock is held while a card is filed.
  const held = new Map<string, Held>();
  const cardOf = new Map<string, string>();
  const live = [...composed.ops.keys()];
  if (composed.shadow || standing.shadow) for (const k of live) held.set(k, 'shadow');
  else await fileCards(d, composed.goal, composed.ops, held, cardOf, now);

  // 6. The review's record: how its plan stage ended, what it suggested, and its card.
  const diff: DiffItem[] = composed.suggestions.map((s) => ({
    change: s.change, class: s.class,
    card: s.key ? (cardOf.get(s.key) ?? null) : null,
    held: s.key ? (cardOf.has(s.key) ? null : (held.get(s.key) ?? 'stale')) : 'stale',
  }));
  const cards = [...new Set(cardOf.values())];
  await db.$transaction(async (tx) => {
    await lockGoal(tx, job.goalId);
    const review = await tx.goalReview.findUnique({ where: { id: reviewId }, select: { planner: true } });
    if (!review || review.planner !== null) return;
    await tx.goalReview.update({ where: { id: reviewId }, data: { planner: `ollama:${ollama.model}`, diff: diff as unknown as Prisma.InputJsonArray, ...(cards[0] ? { proposalId: cards[0] } : {}) } });
    await appendAudit(tx, [{
      actor: GOALS_ACTOR, context: 'autonomous', kind: 'action', action: REVIEW_ACTION, tier: standing.tier, decision: composed.shadow || standing.shadow ? 'log' : 'act', outcome: 'ok', correlationId: reviewId,
      inputs: {
        goalId: job.goalId, reviewId, stage: 'plan', planner: 'ollama', reasonCode: planned.reasonCode, suggested: diff.length,
        minor: diff.filter((x) => x.class === 'minor').length, material: diff.filter((x) => x.class === 'material').length, cards: cards.length,
        stale: diff.filter((x) => x.held === 'stale').length, requests: planned.requests, modelMs: planned.modelMs,
        droppedSteps: planned.dropped.steps, droppedItems: planned.dropped.items, shadow: composed.shadow || standing.shadow,
      },
    }], now);
  }, READ_COMMITTED);
  return { outcome: 'planned', reviewId, suggested: diff.length, filed: cards.length };
}

/** The review's plan stage ended without an answer: it says why, and so does the audit trail. */
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
 * File the review's cards: one for every minor operation, one each for up to 2
 * material ones, within the day's 9. `held` says why an operation is on no
 * card; `cardOf` which card each filed operation is on. Then the goal's older
 * waiting runtime cards that this review did not suggest again are withdrawn.
 */
async function fileCards(
  d: PlanStageDeps, goal: { id: string; title: string; tainted: boolean }, ops: ReadonlyMap<string, { op: PlanOp; class: 'minor' | 'material' }>,
  held: Map<string, Held>, cardOf: Map<string, string>, now: Date,
): Promise<void> {
  const { db } = d;
  const tz = d.config.tz;
  // What Will rejected lately is not asked again while its card still says what it was.
  const rejected = new Set<string>();
  const turnedDown = await db.proposal.findMany({
    where: { status: 'rejected', action: 'plan.change', origin: GOALS_ORIGIN, args: { path: ['goalId'], equals: goal.id } },
    orderBy: { createdAt: 'desc' }, take: 50, select: { args: true, error: true },
  });
  for (const p of turnedDown) {
    // A card a newer review replaced was withdrawn by Flint, not turned down by Will.
    if (p.error === SAY.replacedReview) continue;
    const a = PlanChangeArgs.safeParse(p.args);
    if (a.success) for (const op of a.data.ops) rejected.add(opIdentity(op));
  }
  const fresh: Array<[string, { op: PlanOp; class: 'minor' | 'material' }]> = [];
  for (const [key, o] of ops) {
    if (rejected.has(opIdentity(o.op))) held.set(key, 'rejected');
    else fresh.push([key, o]);
  }
  const minor = fresh.filter(([, o]) => o.class === 'minor');
  const material = fresh.filter(([, o]) => o.class === 'material');
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
      const filed = await createProposal(db, {
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
      // The same suggestion again is the same waiting card: it is counted once, when it was first filed.
      if (!filed.deduped) await claim(db, PLAN_CARDS_COUNTER, cap, tz, now);
      b.entries.forEach(([key]) => cardOf.set(key, filed.id));
    } catch (err) {
      // The plan moved on under the suggestion, or the card could not be filed as it is: it waits for the next review.
      if (!(err instanceof Refused)) d.log?.(`filing a plan card failed: ${failureClass(err)}`);
      hold('stale');
    }
  }
  // Older waiting cards of this goal that this review did not suggest again: withdrawn, unsigned.
  const mine = new Set(cardOf.values());
  const older = await db.proposal.findMany({
    where: { status: 'pending', action: 'plan.change', origin: GOALS_ORIGIN, args: { path: ['goalId'], equals: goal.id }, id: { notIn: [...mine] } },
    select: { id: true },
  });
  for (const o of older) await rejectProposal(db, o.id, { error: SAY.replacedReview }, undefined, GOALS_ACTOR).catch(() => {});
}
