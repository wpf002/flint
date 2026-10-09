/**
 * Goals (Machine plan P3): the shapes every goal card carries, shared by the
 * runtime, which checks a card when it is filed and again when it runs, and
 * later by the server and the console. Strict throughout: a field not named
 * here is refused, not ignored.
 *
 * The database proves the same things (migration p3_goals): a goal becomes
 * active, done or abandoned, or changes what counts as done or its timing,
 * only as the exact args of a card Will signed that is executing now; and a
 * plan version becomes active only as the previous version plus exactly the
 * signed operations. These contracts keep a card that could not apply from
 * ever being filed, and normalize what is signed (defaults filled in, lists
 * sorted, times to the millisecond) so the database's equality checks hold.
 *
 * Goal text is PERSONAL. Nothing here puts it in a reason, an error or a log:
 * the fixed sentences below are what a card's reason says, for good.
 */
import { z } from 'zod';

export const GOAL_STATUSES = ['proposed', 'active', 'paused', 'done', 'abandoned', 'rejected'] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];
/** A closed set: it keeps the review calendar's arithmetic finite and the console to one select. */
export const REVIEW_CADENCES = ['P1D', 'P3D', 'P1W', 'P2W', 'P1M'] as const;
export type ReviewCadence = (typeof REVIEW_CADENCES)[number];
export const LINK_ROLES = ['target', 'depends_on', 'watch'] as const;
export const STEP_KINDS = ['will_task', 'flint_action', 'asset_task', 'wait', 'decision'] as const;
export type StepKind = (typeof STEP_KINDS)[number];
export const STEP_STATUSES = ['todo', 'in_progress', 'blocked', 'done', 'skipped'] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];
export const STEP_TIERS = ['alone', 'approval', 'forbidden'] as const;
export type StepTier = (typeof STEP_TIERS)[number];

/** The six actions only Will's passkey takes. Never promoted (fixed in the code table, and NEVER_PROMOTED). */
export const GOAL_SIGNED_ACTIONS = ['goal.activate', 'goal.criteria_change', 'goal.horizon_change', 'goal.done', 'goal.abandon', 'plan.change'] as const;
export type GoalSignedAction = (typeof GOAL_SIGNED_ACTIONS)[number];
export function isGoalSignedAction(action: string): action is GoalSignedAction {
  return (GOAL_SIGNED_ACTIONS as readonly string[]).includes(action);
}
/** Every action P3 adds to the code table. */
export const P3_ACTIONS = [...GOAL_SIGNED_ACTIONS, 'goal.propose', 'goal.review.local', 'world.commitment.from_chat', 'nexus.remember_goal_decision'] as const;

/**
 * What an item check may look at: one structural field of an item's state, and
 * one of the values that field takes (apps/runtime/src/world/kinds.ts; a runtime
 * test keeps the two in step). Never a name, a title or any free text.
 */
export const CHECK_PATHS: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  pull_request: { state: ['open', 'closed', 'merged'] },
  issue: { state: ['open', 'closed'] },
  ci_run: { conclusion: ['success', 'failure', 'cancelled', 'skipped', 'timed_out', 'neutral', 'action_required'] },
  service: { health: ['ok', 'degraded', 'down', 'unknown'] },
  deployment: { status: ['building', 'deploying', 'success', 'failed', 'crashed', 'removed', 'unknown'] },
  thread: { status: ['open', 'archived'] },
  project: { status: ['active', 'archived'] },
};
/** Can an item of this kind be checked for key = value? */
export function checkFits(kind: string, key: string, value: string): boolean {
  return Object.prototype.hasOwnProperty.call(CHECK_PATHS, kind) && (CHECK_PATHS[kind]![key]?.includes(value) ?? false);
}

/**
 * A value's size as Postgres's CHECKs measure it, octet_length(jsonb::text): jsonb's
 * text form puts a space after every ':' and ','. (The runtime's jsonbBytes, without Buffer.)
 */
export function jsonbSize(v: unknown): number {
  const bytes = (s: string) => new TextEncoder().encode(s).length;
  if (v === null || v === undefined) return 4;
  if (typeof v !== 'object') return bytes(JSON.stringify(v));
  if (Array.isArray(v)) return 2 + v.reduce<number>((n, x, i) => n + jsonbSize(x) + (i ? 2 : 0), 0);
  const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined);
  return 2 + entries.reduce((n, [k, x], i) => n + bytes(JSON.stringify(k)) + 2 + jsonbSize(x) + (i ? 2 : 0), 0);
}

// ---- Pieces ---------------------------------------------------------------------------

/** Goal ids are made by the runtime (or derived from a console draft): `go` and letters or digits. */
export const GoalId = z.string().regex(/^go[A-Za-z0-9]{6,38}$/);
const EntityId = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);
/** An instant as a UTC ISO string to the millisecond, as Date#toISOString writes it: stored and signed times then compare exactly. */
export const IsoMs = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine((t) => !Number.isNaN(Date.parse(t)) && new Date(t).toISOString() === t, 'not a real time');
const words = (max: number) => z.string().min(1).max(max).refine((s) => /\S/.test(s), 'blank');
export const GoalTitle = words(120);
const Description = z.string().max(1000);
export const CriterionId = z.string().regex(/^c([1-9]|10)$/);
export const StepKey = z.string().regex(/^s[0-9]{1,3}$/);
/** Sorted and without repeats: a list's order means nothing here, and its digest must not depend on it. */
const sorted = (xs: readonly string[]): string[] => [...new Set(xs)].sort();
const KeyList = (max: number) => z.array(StepKey).max(max).transform(sorted);

export const Check = z.union([
  z.object({ kind: z.literal('manual') }).strict(),
  z.object({ kind: z.literal('steps'), keys: z.array(StepKey).min(1).max(20).transform(sorted) }).strict(),
  z
    .object({ kind: z.literal('item'), entityId: EntityId, key: z.string().max(40), value: z.string().max(40) })
    .strict()
    .refine((c) => Object.keys(CHECK_PATHS).some((kind) => checkFits(kind, c.key, c.value)), 'not a check Flint can make'),
]);
export type Check = z.infer<typeof Check>;

export const Criterion = z.object({ id: CriterionId, text: words(200), check: Check }).strict();
export type Criterion = z.infer<typeof Criterion>;
export const SuccessCriteria = z
  .array(Criterion)
  .min(1)
  .max(10)
  .superRefine((cs, ctx) => {
    const ids = new Set<string>();
    cs.forEach((c, i) => {
      if (ids.has(c.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i, 'id'], message: 'each check has its own id' });
      ids.add(c.id);
    });
    if (jsonbSize(cs) > 8192) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'the checks are over 8 KB' });
  });

/** A top-level field of an item's state that a change to wakes the goal's review. Never its name or a title. */
const WatchPath = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/)
  .refine((p) => p !== 'name' && p !== 'title', 'a name or title is never watched');
export const Link = z.object({ entityId: EntityId, role: z.enum(LINK_ROLES), watchPaths: z.array(WatchPath).max(10).transform(sorted) }).strict();
export type Link = z.infer<typeof Link>;
/** The whole set of a goal's links after the card runs, one per item, in item order. */
export const Links = z
  .array(Link)
  .max(20)
  .superRefine((ls, ctx) => {
    const seen = new Set<string>();
    ls.forEach((l, i) => {
      if (seen.has(l.entityId)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i, 'entityId'], message: 'an item is linked once' });
      seen.add(l.entityId);
    });
  })
  .transform((ls) => [...ls].sort((a, b) => (a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0)));

// ---- Plans --------------------------------------------------------------------------------

const Ordinal = z.number().int().min(1).max(1_000_000);
const StepTitle = words(200);
const DueAt = IsoMs.nullable();
/** A new step, as an add operation signs it. It starts todo. */
export const NewStep = z
  .object({
    ordinal: Ordinal,
    title: StepTitle,
    kind: z.enum(STEP_KINDS),
    tier: z.enum(STEP_TIERS).default('approval'),
    dueAt: DueAt.default(null),
    dependsOn: KeyList(10).default([]),
  })
  .strict();
/** A step's fields as they are now: a set operation's precondition. */
const StepNow = z.object({ ordinal: Ordinal, title: StepTitle, dueAt: DueAt, status: z.enum(STEP_STATUSES), dependsOn: KeyList(10) }).partial().strict();
/** What a set operation may change. Never a step's key, kind or tier, and never into done (H7: a step is done by doing it). */
const StepTo = z
  .object({ ordinal: Ordinal, title: StepTitle, dueAt: DueAt, status: z.enum(['todo', 'in_progress', 'blocked', 'skipped']), dependsOn: KeyList(10) })
  .partial()
  .strict();
export const AddOp = z.object({ op: z.literal('add'), key: StepKey, step: NewStep }).strict();
/** `from` names the step's title and every field `to` changes, as they are now: a card whose step changed since then does not apply. */
export const SetOp = z.object({ op: z.literal('set'), key: StepKey, from: StepNow, to: StepTo }).strict();
export const PlanOp = z.discriminatedUnion('op', [AddOp, SetOp]);
export type PlanOp = z.infer<typeof PlanOp>;

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export const PlanOps = z
  .array(PlanOp)
  .min(1)
  .max(20)
  .superRefine((ops, ctx) => {
    const keys = new Set<string>();
    ops.forEach((o, i) => {
      const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i, ...path], message });
      if (keys.has(o.key)) issue(['key'], 'one operation per step');
      keys.add(o.key);
      if (o.op === 'add') {
        if (o.step.dependsOn.includes(o.key)) issue(['step', 'dependsOn'], 'a step cannot depend on itself');
        return;
      }
      if (o.from.title === undefined) issue(['from', 'title'], 'names the step as it is');
      const changed = Object.keys(o.to) as Array<keyof typeof o.to>;
      if (!changed.length) issue(['to'], 'changes nothing');
      for (const k of changed) {
        if (!(k in o.from)) issue(['from', k], 'says what it changes from');
        else if (same(o.from[k], o.to[k])) issue(['to', k], 'changes nothing');
      }
      if (o.to.dependsOn?.includes(o.key)) issue(['to', 'dependsOn'], 'a step cannot depend on itself');
    });
  });

/** One step as the plan holds it (times as ISO strings to the millisecond). */
export interface PlanStepState {
  key: string;
  ordinal: number;
  title: string;
  kind: StepKind;
  tier: StepTier;
  status: StepStatus;
  dueAt: string | null;
  dependsOn: string[];
  doneAt: string | null;
  doneAuditId: string | null;
  proposalId: string | null;
  taskId: string | null;
}

/**
 * Why operations do not apply: `stale`, a step is no longer as its `from` says;
 * `exists`, an add's key is taken; `missing`, a set's key is not in the plan;
 * `depends`, a step depends on one the plan does not have; `circle`, the
 * dependencies go round.
 */
export type ComposeRefusal = 'stale' | 'exists' | 'missing' | 'depends' | 'circle';
export type Composed = { ok: true; steps: PlanStepState[] } | { ok: false; why: ComposeRefusal; key?: string };

/**
 * The next version of a plan: the previous steps with the operations applied,
 * exactly as the database's composition check (plan_guard) will require it.
 * Every previous step survives; an add starts todo; a set applies only to a step
 * that still matches its `from`.
 */
export function composePlan(prev: readonly PlanStepState[], ops: readonly PlanOp[]): Composed {
  const steps = new Map<string, PlanStepState>(prev.map((s) => [s.key, { ...s, dependsOn: sorted(s.dependsOn) }]));
  for (const op of ops) {
    if (op.op === 'add') {
      if (steps.has(op.key)) return { ok: false, why: 'exists', key: op.key };
      const s = op.step;
      steps.set(op.key, {
        key: op.key, ordinal: s.ordinal, title: s.title, kind: s.kind, tier: s.tier, status: 'todo', dueAt: s.dueAt, dependsOn: sorted(s.dependsOn),
        doneAt: null, doneAuditId: null, proposalId: null, taskId: null,
      });
      continue;
    }
    const cur = steps.get(op.key);
    if (!cur) return { ok: false, why: 'missing', key: op.key };
    for (const [k, v] of Object.entries(op.from)) {
      const now = cur[k as keyof PlanStepState];
      if (!same(Array.isArray(now) ? sorted(now) : now, v)) return { ok: false, why: 'stale', key: op.key };
    }
    const next: PlanStepState = { ...cur };
    for (const [k, v] of Object.entries(op.to)) {
      if (v !== undefined) (next as unknown as Record<string, unknown>)[k] = k === 'dependsOn' ? sorted(v as string[]) : v;
    }
    steps.set(op.key, next);
  }
  for (const s of steps.values()) {
    if (s.dependsOn.some((d) => d === s.key || !steps.has(d))) return { ok: false, why: 'depends', key: s.key };
  }
  // Take away the steps whose dependencies are all gone, until none is left (or some depend on each other).
  const remaining = new Set(steps.keys());
  for (;;) {
    const free = [...remaining].filter((k) => !steps.get(k)!.dependsOn.some((d) => remaining.has(d)));
    if (!free.length) break;
    for (const k of free) remaining.delete(k);
  }
  if (remaining.size) return { ok: false, why: 'circle' };
  return { ok: true, steps: [...steps.values()].sort((a, b) => a.ordinal - b.ordinal || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)) };
}

// ---- The cards' args ---------------------------------------------------------------------------

const fits = (a: unknown) => jsonbSize(a) <= 65536;
const OVER = 'args are over 64 KB';

/** Every item check's item is one of the goal's links, so a change to it wakes the review. */
function itemsLinked(a: { successCriteria: Criterion[]; links: Link[] }, ctx: z.RefinementCtx): void {
  const linked = new Set(a.links.map((l) => l.entityId));
  a.successCriteria.forEach((c, i) => {
    if (c.check.kind === 'item' && !linked.has(c.check.entityId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['successCriteria', i, 'check', 'entityId'], message: 'an item check needs its item linked' });
    }
  });
}

/**
 * goal.activate: a new goal (or one Flint suggested) with what counts as done,
 * its timing, its links and, optionally, its first plan (adds only); or a paused
 * goal resumed, with exactly what it already has and no plan.
 */
export const GoalActivateArgs = z
  .object({
    goalId: GoalId,
    title: GoalTitle,
    description: Description.default(''),
    successCriteria: SuccessCriteria,
    horizonAt: IsoMs.nullable().default(null),
    reviewCadence: z.enum(REVIEW_CADENCES).default('P1W'),
    links: Links.default([]),
    plan: z.object({ ops: PlanOps }).strict().nullable().default(null),
  })
  .strict()
  .superRefine((a, ctx) => {
    itemsLinked(a, ctx);
    if (!a.plan) return;
    a.plan.ops.forEach((o, i) => {
      if (o.op !== 'add') ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['plan', 'ops', i, 'op'], message: 'a first plan only adds steps' });
    });
    const first = composePlan([], a.plan.ops);
    if (!first.ok && (first.why === 'depends' || first.why === 'circle')) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['plan', 'ops'], message: first.why === 'circle' ? 'steps depend on each other in a circle' : 'a step depends on a step the plan does not have' });
    }
    const keys = new Set(a.plan.ops.map((o) => o.key));
    a.successCriteria.forEach((c, i) => {
      if (c.check.kind === 'steps' && c.check.keys.some((k) => !keys.has(k))) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['successCriteria', i, 'check', 'keys'], message: 'names a step the plan does not have' });
      }
    });
  })
  .refine(fits, OVER);

/** goal.criteria_change: what counts as done (title, description, checks) and the whole new set of links. */
export const GoalCriteriaChangeArgs = z
  .object({ goalId: GoalId, title: GoalTitle, description: Description.default(''), successCriteria: SuccessCriteria, links: Links })
  .strict()
  .superRefine(itemsLinked)
  .refine(fits, OVER);

/** goal.horizon_change: when it should be done by, and how often it is reviewed. The title is for the card only. */
export const GoalHorizonChangeArgs = z
  .object({ goalId: GoalId, goalTitle: GoalTitle, horizonAt: IsoMs.nullable(), reviewCadence: z.enum(REVIEW_CADENCES) })
  .strict();

/** goal.done and goal.abandon: the goal, and its title for the card. */
export const GoalDoneArgs = z.object({ goalId: GoalId, goalTitle: GoalTitle }).strict();
export const GoalAbandonArgs = GoalDoneArgs;

/** plan.change: operations on the active plan, each with its precondition. No plan id or version: cards on different steps compose. */
export const PlanChangeArgs = z.object({ goalId: GoalId, goalTitle: GoalTitle, ops: PlanOps }).strict().refine(fits, OVER);

/** Each signed action's args. */
export const GOAL_ARGS: Readonly<Record<GoalSignedAction, z.ZodTypeAny>> = {
  'goal.activate': GoalActivateArgs,
  'goal.criteria_change': GoalCriteriaChangeArgs,
  'goal.horizon_change': GoalHorizonChangeArgs,
  'goal.done': GoalDoneArgs,
  'goal.abandon': GoalAbandonArgs,
  'plan.change': PlanChangeArgs,
};
/** The kind of proposal each is filed as (Proposal_kind_check; the database's p3_signed_proposal requires it). */
export const GOAL_KIND: Readonly<Record<GoalSignedAction, 'goal' | 'plan'>> = {
  'goal.activate': 'goal',
  'goal.criteria_change': 'goal',
  'goal.horizon_change': 'goal',
  'goal.done': 'goal',
  'goal.abandon': 'goal',
  'plan.change': 'plan',
};

/**
 * What a goal card's reason says: a fixed sentence, never the goal's words. A
 * proposal's reason is kept for good (retention clears only args and result,
 * and the database refuses any change to it).
 */
export const GOAL_REASONS = {
  start: 'Approving starts this goal.',
  resume: 'Approving resumes this goal.',
  criteria: 'Approving changes what counts as done.',
  timing: 'Approving changes its timing.',
  done: 'Approving marks it done.',
  abandon: 'Approving abandons it for good.',
  planFlint: 'Flint suggests this after its review.',
  planWill: 'You asked for this change.',
  propose: 'Approving adds it to your suggested goals.',
  commitment: 'Approving adds it to the things Flint knows you said you’d do.',
} as const;
