/**
 * Assets and tasks (P5): the shapes a task, its checks and its cards carry,
 * shared by the runtime, which checks a card when it is filed and again when it
 * runs, and later by the server and the console. Strict throughout: a field not
 * named here is refused, not ignored.
 *
 * A task is a template with parameters, never free instructions: its spec names
 * one of TASK_TEMPLATE_IDS and the items it is about, by id. Its bar is a list
 * of checks, each a pure function of the result (evaluateChecks): there is no
 * free regular expression and no command.
 *
 * The database proves the same things (migration p5_assets): a task goes out
 * only as the exact args of a card Will signed that is executing now, to an
 * asset he turned on with a card that signed what the asset is; it is accepted
 * only with its result on record, its own successful check, and his card for
 * that result. These contracts keep a card that could not apply from being
 * filed, and normalize what is signed (lists sorted, defaults filled in, times
 * to the millisecond, money as a whole number) so the database's equality
 * checks hold.
 *
 * A task's title, spec and result are Will's words, or a model's. Nothing here
 * puts them in a reason, an error or a log: the fixed sentences below are what a
 * card's reason and a refusal say.
 */
import { z } from 'zod';
import { ClaimRef } from './claims.js';
import { DraftKey, GoalId, IsoMs, LIKELIHOODS, StepKey, checkFits, jsonbSize } from './goals.js';

export const ASSET_KINDS = ['local_worker', 'local_reviewer', 'ci_runner', 'nexus_participant', 'trident_panel', 'hive_bot'] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];
/** The kinds a task runs on (a reviewer reviews cards; nothing dispatches to the Hive). */
export const TASK_ASSET_KINDS = ['local_worker', 'ci_runner', 'nexus_participant'] as const;
export type TaskAssetKind = (typeof TASK_ASSET_KINDS)[number];

export const TASK_STATUSES = ['proposed', 'queued', 'dispatched', 'running', 'submitted', 'checking', 'accepted', 'rejected', 'failed', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
/** A task that has ended: nothing more runs. */
export const TASK_ENDED: readonly TaskStatus[] = ['accepted', 'rejected', 'failed', 'cancelled'];
/** Why a task failed, as a class (the database's list): never words. */
export const TASK_FAILURES = ['unavailable', 'invalid', 'capped', 'timeout', 'asset_off', 'budget', 'expired', 'error'] as const;
export type TaskFailure = (typeof TASK_FAILURES)[number];

/**
 * The seven cards the runtime carries out itself, each on Will's signature:
 * turning an asset on, requiring reviews (or not), sending a task to the local
 * model or the CI watcher, accepting a result that passed its checks,
 * cancelling a task, and overruling a check.
 */
export const TASK_SIGNED_ACTIONS = ['asset.enable', 'review.enforce', 'task.dispatch.local_worker', 'task.dispatch.ci_runner', 'task.check_bar', 'task.cancel', 'task.bar_override'] as const;
export type TaskSignedAction = (typeof TASK_SIGNED_ACTIONS)[number];
export function isTaskSignedAction(action: string): action is TaskSignedAction {
  return (TASK_SIGNED_ACTIONS as readonly string[]).includes(action);
}
/** A dispatch that spends: filed only by Will, as a spend card. No asset of its kind is built, and nothing carries it out. */
export const PAID_DISPATCH = 'task.dispatch.nexus_participant';
/** Every action P5 adds to the code table. */
export const P5_ACTIONS = [...TASK_SIGNED_ACTIONS, PAID_DISPATCH, 'review.local', 'review.trident_panel'] as const;
/** The Hive's dispatch: not in the code table (so APPROVAL, and never autonomous), and never promoted. */
export const HIVE_DISPATCH = 'hive.dispatch_job';

/** The action a card that hands an asset work is filed under (the database's Asset_dispatchAction_check says the same). */
export function dispatchActionOf(kind: AssetKind): string {
  return kind === 'local_reviewer' ? 'review.local' : kind === 'trident_panel' ? 'review.trident_panel' : kind === 'hive_bot' ? HIVE_DISPATCH : `task.dispatch.${kind}`;
}
/** Is this a card that sends a task out? */
export const isTaskDispatch = (action: string): boolean => action.startsWith('task.dispatch.');
/** A task card: one of the seven, or a dispatch that spends. Each is checked when it is filed. */
export const isTaskCard = (action: string): boolean => isTaskSignedAction(action) || isTaskDispatch(action);
/** The cards only Will files, from the console or the CLI. */
export const TASK_WILL_ONLY: ReadonlySet<string> = new Set(['asset.enable', 'review.enforce', 'task.cancel', 'task.bar_override', PAID_DISPATCH]);

/** Where the runtime's own task cards come from, and the template its accept card rides on. */
export const TASKS_ORIGIN = 'runtime:tasks';
export const ACCEPT_TEMPLATE = 'task.accept.v1';
/** Who writes a task's forecast, and the counter it is counted under (counted, never capped). */
export const TASKS_WRITER = 'runtime:tasks';
export const MEETS_BAR_COUNTER = 'task.meets_bar';
/**
 * The rule a task's forecast carries (Prediction.resolverSpec): whose it is to
 * settle. The database takes a dispatch only with a forecast that names its
 * task under this rule, and the ledger's own sweep leaves a prediction alone
 * when it carries a rule it does not know, so only the task tick settles one.
 */
export const TASK_FORECAST_RULE = 'task_meets_bar';

// ---- Pieces ---------------------------------------------------------------------------

const EntityId = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);
export const AssetId = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);
/** Task ids are made from a New Task form's draft key: `tk` and letters or digits. */
export const TaskId = z.string().regex(/^tk[A-Za-z0-9]{16,32}$/);
/** The id of the task a draft adds: sending the same form twice makes the same task. */
export const taskIdOf = (draftKey: string): string => `tk${draftKey}`;
/** A NUL, or half of a surrogate pair: Postgres stores neither, in text or in jsonb. */
const UNSTORABLE = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
/** Can the database store this text as it is? A writer cleans a model's words first; Will's own are refused, never changed under his signature. */
export const isStorable = (s: string): boolean => !UNSTORABLE.test(s);
const words = (max: number) => z.string().min(1).max(max).refine((s) => /\S/.test(s), 'blank').refine(isStorable, 'holds a character that cannot be stored');
export const TaskTitle = words(200);
/** Sorted and without repeats: a list's order means nothing here, and its digest must not depend on it. */
const sorted = (xs: readonly string[]): string[] => [...new Set(xs)].sort();
export const TaskForecastSpec = z.object({ taskId: TaskId, rule: z.literal(TASK_FORECAST_RULE) }).strict();
export type TaskForecastSpec = z.infer<typeof TaskForecastSpec>;
/** The items a task is about, by id: at most 12. */
export const TASK_ITEMS_MAX = 12;
const Items = (min: number) => z.array(EntityId).min(min).max(TASK_ITEMS_MAX).transform(sorted);

// ---- Templates --------------------------------------------------------------------------

export const TASK_TEMPLATE_IDS = ['summarize_items', 'sort_items', 'draft_note', 'watch_ci'] as const;
export type TaskTemplateId = (typeof TASK_TEMPLATE_IDS)[number];

/**
 * What each template is asked: the items by id, and Will's own few words where
 * a template takes them. `titles` (off unless Will asks) shows the model the
 * items' titles, which are outside text: the task is then tainted.
 */
export const TASK_PARAMS = {
  summarize_items: z.object({ items: Items(1), titles: z.boolean().default(false) }).strict(),
  sort_items: z
    .object({ items: Items(1), labels: z.array(words(40)).min(2).max(6).refine((ls) => new Set(ls).size === ls.length, 'a label is given once'), titles: z.boolean().default(false) })
    .strict(),
  draft_note: z.object({ about: words(300), items: Items(0).default([]), titles: z.boolean().default(false) }).strict(),
  /** One CI run, and optionally the start of the commit it must be for. */
  watch_ci: z.object({ item: EntityId, sha: z.string().regex(/^[0-9a-f]{7,40}$/).nullable().default(null) }).strict(),
} as const satisfies Readonly<Record<TaskTemplateId, z.ZodTypeAny>>;

export const TaskSpec = z.discriminatedUnion('template', [
  z.object({ template: z.literal('summarize_items'), params: TASK_PARAMS.summarize_items }).strict(),
  z.object({ template: z.literal('sort_items'), params: TASK_PARAMS.sort_items }).strict(),
  z.object({ template: z.literal('draft_note'), params: TASK_PARAMS.draft_note }).strict(),
  z.object({ template: z.literal('watch_ci'), params: TASK_PARAMS.watch_ci }).strict(),
]);
export type TaskSpec = z.infer<typeof TaskSpec>;

/** The items a spec names, by id. */
export function specItems(spec: TaskSpec): string[] {
  return spec.template === 'watch_ci' ? [spec.params.item] : spec.params.items;
}
/** Does the spec show the model outside text (the items' titles)? */
export const specTainted = (spec: TaskSpec): boolean => spec.template !== 'watch_ci' && spec.params.titles;

/**
 * What each template gives back. A result is data: parsed by these, never
 * executed, never used as an instruction. A ref is an item's kind and the last
 * of its id (ClaimRef), never a title.
 */
export const TASK_OUTPUTS = {
  summarize_items: z
    .object({
      headline: words(120),
      points: z.array(z.object({ text: words(200), refs: z.array(ClaimRef).max(TASK_ITEMS_MAX) }).strict()).min(1).max(6),
      attention: z.array(ClaimRef).max(5),
    })
    .strict(),
  sort_items: z.object({ labels: z.array(z.object({ ref: ClaimRef, label: words(40) }).strict()).max(TASK_ITEMS_MAX) }).strict(),
  draft_note: z.object({ title: words(80), body: words(1200) }).strict(),
  /** What the watcher saw of the run when it ended: structural fields only. */
  watch_ci: z
    .object({
      ref: ClaimRef,
      status: z.enum(['queued', 'in_progress', 'completed']),
      conclusion: z.enum(['success', 'failure', 'cancelled', 'skipped', 'timed_out', 'neutral', 'action_required']).nullable(),
      sha: z.string().regex(/^[0-9a-f]{7,40}$/).nullable(),
    })
    .strict(),
} as const satisfies Readonly<Record<TaskTemplateId, z.ZodTypeAny>>;

// ---- The bar ------------------------------------------------------------------------------

/**
 * Probability words a result may not carry: a task never states odds the
 * ledger did not produce. The runtime's notes are held to the same pattern.
 */
export const LOOSE_ODDS = /\b(likely|unlikely|probabl[ey]|almost certain|certain(ly)?|chances?|odds|confident|even)\b|\d+ ?%/i;

export const CHECK_OPS = ['shape', 'refs_known', 'covers', 'count', 'max_chars', 'all_labelled', 'no_loose_odds', 'item', 'ci'] as const;
export type CheckOp = (typeof CHECK_OPS)[number];
/** The lists a count check may count. */
const COUNTED = ['points', 'attention', 'labels'] as const;

/**
 * One check of a result. A rule is a pure function of the result (and, for
 * `item`, of one tracked item's state, by the same field and value list a goal's
 * item check uses); `judge` is Will's own words, judged by a local review.
 */
export const TaskCheck = z.union([
  z.object({ type: z.literal('deterministic'), op: z.enum(['shape', 'refs_known', 'covers', 'all_labelled', 'no_loose_odds']) }).strict(),
  z
    .object({ type: z.literal('deterministic'), op: z.literal('count'), of: z.enum(COUNTED), min: z.number().int().min(0).max(100), max: z.number().int().min(0).max(100) })
    .strict()
    .refine((c) => c.min <= c.max, 'the range is upside down'),
  z.object({ type: z.literal('deterministic'), op: z.literal('max_chars'), max: z.number().int().min(1).max(32_000) }).strict(),
  z
    .object({ type: z.literal('deterministic'), op: z.literal('item'), entityId: EntityId, key: z.string().max(40), value: z.string().max(40) })
    .strict()
    .refine((c) => ['pull_request', 'issue', 'ci_run', 'service', 'deployment', 'thread', 'project'].some((kind) => checkFits(kind, c.key, c.value)), 'not a check Flint can make'),
  z.object({ type: z.literal('deterministic'), op: z.literal('ci'), sha: z.string().regex(/^[0-9a-f]{7,40}$/).nullable() }).strict(),
  z.object({ type: z.literal('judge'), rubric: words(300) }).strict(),
]);
export type TaskCheck = z.infer<typeof TaskCheck>;

/** A check's name, as the Tasks panel shows it. A rule's name is fixed here: an acceptance item never holds a model's words. */
export const CHECK_NAMES: Readonly<Record<CheckOp | 'judge', string>> = {
  shape: 'Has Every Part',
  refs_known: 'Names Only Your Items',
  covers: 'Covers Enough Items',
  count: 'Has the Right Number',
  max_chars: 'Stays Within Length',
  all_labelled: 'Labels Every Item',
  no_loose_odds: 'Makes No Loose Predictions',
  item: 'Item Is as Expected',
  ci: 'CI Run Passed',
  judge: 'Your Own Check',
};
const nameOf = (c: TaskCheck): string => CHECK_NAMES[c.type === 'judge' ? 'judge' : c.op];

export const CheckId = z.string().regex(/^a([1-9]|10)$/);
export const AcceptanceItem = z
  .object({ id: CheckId, text: words(200), check: TaskCheck })
  .strict()
  .refine((a) => a.text === nameOf(a.check), { message: 'a check is named by what it checks', path: ['text'] });
export type AcceptanceItem = z.infer<typeof AcceptanceItem>;
/** A task's bar: 1 to 10 checks, each with its own id, within the database's 8 KB. */
export const Acceptance = z
  .array(AcceptanceItem)
  .min(1)
  .max(10)
  .superRefine((as, ctx) => {
    const ids = new Set<string>();
    as.forEach((a, i) => {
      if (ids.has(a.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i, 'id'], message: 'each check has its own id' });
      ids.add(a.id);
    });
    if (jsonbSize(as) > 8192) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'the checks are over 8 KB' });
  });
export type Acceptance = z.infer<typeof Acceptance>;

/** The rule checks a template ships with, in order. Will's own check, when he adds one, comes after them. */
export function ruleChecks(spec: TaskSpec): Acceptance {
  const rule = (op: 'shape' | 'refs_known' | 'covers' | 'all_labelled' | 'no_loose_odds'): TaskCheck => ({ type: 'deterministic', op });
  const length = (max: number): TaskCheck => ({ type: 'deterministic', op: 'max_chars', max });
  const checks: TaskCheck[] =
    spec.template === 'summarize_items' ? [rule('shape'), rule('refs_known'), rule('covers'), length(1600), rule('no_loose_odds')]
    : spec.template === 'sort_items' ? [rule('shape'), rule('all_labelled'), rule('refs_known')]
    : spec.template === 'draft_note' ? [rule('shape'), length(1280), rule('no_loose_odds')]
    : [{ type: 'deterministic', op: 'ci', sha: spec.params.sha }];
  return checks.map((check, i) => ({ id: `a${i + 1}`, text: nameOf(check), check }));
}

/** What the checks are run against, besides the result: the refs of the items the task was given, and (for `item`) those items' clean state. */
export interface CheckContext {
  refs: readonly string[];
  items?: Readonly<Record<string, { kind: string; state: Readonly<Record<string, unknown>> }>>;
}
/** One check's finding: met, not met, or (a judge's) not a rule to run here. */
export interface CheckFinding {
  id: string;
  op: CheckOp | 'judge';
  met: boolean | null;
}

/** Every string a result holds, to any depth (a result is at most 32 KB). */
function textsOf(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) textsOf(x, out);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) textsOf(x, out);
  return out;
}

/**
 * Run a task's rule checks over its result. Pure: the same result and context
 * give the same findings. A result that is not its template's shape meets no
 * check that reads it. A judge's item is left null (a review answers it), and
 * the bar is met only when every item is met.
 */
export function evaluateChecks(spec: TaskSpec, acceptance: Acceptance, output: unknown, ctx: CheckContext): { findings: CheckFinding[]; metBar: boolean } {
  const shaped = TASK_OUTPUTS[spec.template].safeParse(output);
  const o = shaped.success ? (shaped.data as Record<string, unknown>) : undefined;
  const given = new Set(ctx.refs);
  // The refs a result names, by its template (undefined: it is not shaped, so it names nothing that can be trusted).
  const named: string[] | undefined = !o ? undefined
    : spec.template === 'summarize_items' ? [...(o.points as Array<{ refs: string[] }>).flatMap((p) => p.refs), ...(o.attention as string[])]
    : spec.template === 'sort_items' ? (o.labels as Array<{ ref: string }>).map((l) => l.ref)
    : spec.template === 'watch_ci' ? [o.ref as string]
    : [];
  const one = (c: TaskCheck): boolean | null => {
    if (c.type === 'judge') return null;
    if (c.op === 'item') {
      const item = ctx.items?.[c.entityId];
      return !!item && checkFits(item.kind, c.key, c.value) && item.state[c.key] === c.value;
    }
    if (!o || !named) return false;
    switch (c.op) {
      case 'shape':
        return true;
      case 'refs_known':
        return named.every((r) => given.has(r));
      case 'covers': {
        const covered = new Set(named.filter((r) => given.has(r))).size;
        return covered >= (given.size <= 4 ? given.size : Math.ceil(given.size / 2));
      }
      case 'count': {
        const list = o[c.of];
        return Array.isArray(list) && list.length >= c.min && list.length <= c.max;
      }
      case 'max_chars':
        return textsOf(o).reduce((n, s) => n + s.length, 0) <= c.max;
      case 'all_labelled': {
        if (spec.template !== 'sort_items') return false;
        const labels = o.labels as Array<{ ref: string; label: string }>;
        return labels.length === given.size && new Set(labels.map((l) => l.ref)).size === given.size && labels.every((l) => given.has(l.ref) && spec.params.labels.includes(l.label));
      }
      case 'no_loose_odds':
        return !textsOf(o).some((s) => LOOSE_ODDS.test(s));
      case 'ci':
        return o.status === 'completed' && o.conclusion === 'success' && (c.sha === null || (typeof o.sha === 'string' && o.sha.startsWith(c.sha)));
    }
  };
  const findings = acceptance.map((a) => ({ id: a.id, op: a.check.type === 'judge' ? ('judge' as const) : a.check.op, met: one(a.check) }));
  return { findings, metBar: findings.every((f) => f.met === true) };
}

// ---- Cards ----------------------------------------------------------------------------------

const Sensitivity = z.enum(['ops', 'personal', 'financial']);

/**
 * asset.enable: what the asset is, signed (the database compares each field
 * with the asset's row, and the list of what it can do in order). `entityId`
 * is the tracked item it stands for, or null: always said, never left out.
 */
export const AssetEnableArgs = z
  .object({
    assetId: AssetId,
    kind: z.enum(ASSET_KINDS),
    externalRef: z.string().regex(/^[a-z0-9][a-z0-9_.:/-]{0,119}$/),
    name: words(80),
    capabilities: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,39}$/)).max(20),
    dispatchAction: z.string().regex(/^[a-z][a-z0-9_.]{0,79}$/),
    spends: z.boolean(),
    entityId: EntityId.nullable(),
  })
  .strict()
  .refine((a) => a.dispatchAction === dispatchActionOf(a.kind), { message: 'an asset of this kind is handed work under its own action', path: ['dispatchAction'] });
export type AssetEnableArgs = z.infer<typeof AssetEnableArgs>;

/** review.enforce: whether cards that matter wait for a review before Will can approve them. */
export const ReviewEnforceArgs = z.object({ gate: z.literal('proposal'), enforced: z.boolean() }).strict();
export type ReviewEnforceArgs = z.infer<typeof ReviewEnforceArgs>;

/**
 * A dispatch card's args are the whole task: what Will signs is what the
 * database compares with the task's row. Money is a whole number of millionths
 * of a dollar, in hundreds (the task keeps four decimal places of a dollar).
 */
export const TaskDispatchArgs = z
  .object({
    taskId: TaskId,
    assetId: AssetId,
    assetKind: z.enum(TASK_ASSET_KINDS),
    title: TaskTitle,
    spec: TaskSpec,
    acceptance: Acceptance,
    goalId: GoalId.nullable(),
    stepKey: StepKey.nullable(),
    dueAt: IsoMs.nullable(),
    sensitivity: Sensitivity,
    tainted: z.boolean(),
    estCostMicros: z.number().int().min(0).max(1_000_000_000).multipleOf(100),
  })
  .strict()
  .superRefine((a, ctx) => {
    if (a.stepKey !== null && a.goalId === null) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['stepKey'], message: 'a step belongs to a goal' });
    if (jsonbSize(a.spec) > 16384) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['spec'], message: 'the spec is over 16 KB' });
  });
export type TaskDispatchArgs = z.infer<typeof TaskDispatchArgs>;

/**
 * How a task names its result: `out:` and the start of its output's digest. The
 * digest is the database's own, computed as the output is written and read
 * back; the database checks a task only with that output on record.
 */
export const OutputRef = z.string().regex(/^out:[0-9a-f]{12,64}$/);
export const outputRefOf = (sha256: string): string => `out:${sha256.slice(0, 16)}`;

/** Who checked a bar: Flint's rules, or the local model that judged Will's own check. */
const CheckedBy = z.string().regex(/^(flint:rule|ollama:[A-Za-z0-9._:/-]{1,80})$/);
/**
 * task.check_bar (the accept card): the task, the result it accepts and that it
 * met its bar (the database compares both with the task's row, and takes the
 * card only if Will signed it after the result was handed in), then what the
 * check found, as counts only.
 */
export const TaskAcceptArgs = z
  .object({ taskId: TaskId, outputRef: OutputRef, metBar: z.literal(true), checks: z.number().int().min(1).max(10), met: z.number().int().min(0).max(10), by: CheckedBy })
  .strict()
  .refine((a) => a.met === a.checks, { message: 'only a result that passed every check is offered', path: ['met'] });
export type TaskAcceptArgs = z.infer<typeof TaskAcceptArgs>;
export const TaskCancelArgs = z.object({ taskId: TaskId }).strict();
/** task.bar_override: the task, and how Will ends it against its check. */
export const TaskOverrideArgs = z.object({ taskId: TaskId, to: z.enum(['accepted', 'rejected']) }).strict();
export type TaskOverrideArgs = z.infer<typeof TaskOverrideArgs>;

/** The kind of proposal each of the seven is filed as (the database's p5_signed_proposal requires it). */
export const TASK_CARD_KIND: Readonly<Record<TaskSignedAction, 'task' | 'policy'>> = {
  'asset.enable': 'policy',
  'review.enforce': 'policy',
  'task.dispatch.local_worker': 'task',
  'task.dispatch.ci_runner': 'task',
  'task.check_bar': 'task',
  'task.cancel': 'task',
  'task.bar_override': 'task',
};

/** What a task card's reason says, for good: a fixed sentence, never a task's words. */
export const TASK_REASONS = {
  enable: 'Approving turns this asset on.',
  require: 'Approving makes cards that matter wait for a review.',
  stopRequiring: 'Approving lets you approve cards before Flint reviews them.',
  dispatch: 'Approving runs this task.',
  paid: 'Approving runs this task, which costs money.',
  accept: 'Approving accepts this result.',
  cancel: 'Approving stops this task.',
  overrideAccept: 'Approving accepts this result against its checks.',
  overrideReject: 'Approving rejects this result against its checks.',
} as const;

/**
 * What Will reads when a task card or a task route is refused: fixed sentences,
 * never a task's words, never a database's. The runtime refuses with one of
 * these and names it by its key (`code`).
 */
export const TASK_SAYS = {
  off: 'Tasks are turned off on this Mac.',
  invalid: 'This task card isn’t valid.',
  kind: 'This card is filed as the wrong kind.',
  fromConsole: 'Tasks and assets are changed from the console.',
  flintFiles: 'Flint files this card itself, once a task passes its checks.',
  template: 'A card you file carries no template.',
  provenance: 'A task card names where its parts came from by id only.',
  reshaped: 'Flint reads this card differently since you approved it. File it again.',
  nothing: 'It changes nothing.',
  noAsset: 'Flint doesn’t know this asset.',
  assetOff: 'Its asset is off. Turn it on in Settings.',
  needsGithub: 'It needs the GitHub source first.',
  paidOff: 'Paid tasks are off.',
  noTask: 'This task no longer exists.',
  changed: 'The task changed since you looked. Reload it and try again.',
  tooMany: 'A task takes up to 12 items.',
  itemGone: 'One of its items is no longer there.',
  person: 'A person can’t be part of a task.',
  wrongItem: 'That item isn’t a CI run.',
  cantRun: 'No asset that is on can run this kind of task.',
  ownCheck: 'Flint can’t judge your own check yet.',
  due: 'The due time has to be in the future, within 90 days.',
  noGoal: 'This goal no longer exists.',
  scored: 'Its result is already scored.',
  notChecked: 'Flint hasn’t checked its result yet.',
  notOverride: 'That is already how it ended.',
  decided: 'You already decided this result.',
  superseded: 'You signed something newer about this, so this card didn’t run. Ask for it again if you still want it.',
  forgotten: 'You had Flint forget what this was about, so it didn’t run.',
  reviewerFirst: 'Turn on Local Reviews first.',
  reviewerStays: 'Reviews are required, so this stays on.',
} as const;
export type TaskSay = keyof typeof TASK_SAYS;

/** Where a task stands, in a sentence: also why it cannot take a step from there. */
export const TASK_STATUS_SAYS: Readonly<Record<TaskStatus, string>> = {
  proposed: 'It’s waiting for your approval.',
  queued: 'It’s next in line.',
  dispatched: 'It’s running.',
  running: 'It’s running.',
  submitted: 'Flint is checking the result.',
  checking: 'Flint is checking the result.',
  accepted: 'It was accepted.',
  rejected: 'It was rejected.',
  failed: 'It failed.',
  cancelled: 'It was cancelled.',
};

/** Why a task failed, in a sentence, by its class. */
export const TASK_FAILURE_SAYS: Readonly<Record<TaskFailure, string>> = {
  unavailable: 'The local model didn’t answer.',
  invalid: 'Its result wasn’t usable.',
  capped: 'Today’s task limit was reached.',
  timeout: 'It ran out of time.',
  asset_off: 'Its asset was turned off.',
  budget: 'Paid tasks are off.',
  expired: 'It wasn’t finished by its due date.',
  error: 'Something went wrong.',
};

/** The sentence a code stands for (a TASK_SAYS key, or `status.<status>`), or undefined for a code outside the closed set. */
export function taskSayOf(code: unknown): string | undefined {
  if (typeof code !== 'string') return undefined;
  if (Object.prototype.hasOwnProperty.call(TASK_SAYS, code)) return TASK_SAYS[code as TaskSay];
  const m = /^status\.([a-z]+)$/.exec(code);
  return m && Object.prototype.hasOwnProperty.call(TASK_STATUS_SAYS, m[1]!) ? TASK_STATUS_SAYS[m[1] as TaskStatus] : undefined;
}
/** The code of one of these sentences, or undefined. A sentence two statuses share takes the first. */
export function taskCodeOf(sentence: string): string | undefined {
  for (const [k, v] of Object.entries(TASK_SAYS)) if (v === sentence) return k;
  for (const [k, v] of Object.entries(TASK_STATUS_SAYS)) if (v === sentence) return `status.${k}`;
  return undefined;
}

/** What the line under a task's title is made from: where it stands and counts, never its words. */
export interface TaskStanding {
  status: TaskStatus;
  assetKind: AssetKind;
  failure: TaskFailure | null;
  /** Its checks, once they ran: how many there are and how many it met. */
  checks: { total: number; met: number } | null;
  /** Will ended it himself, against its check. */
  overridden: boolean;
  /** Its accept card is waiting for him. */
  waitingForWill: boolean;
}
/** The one sentence under a task's title in the Tasks panel. */
export function taskLine(t: TaskStanding): string {
  const n = (count: number) => `${count} of ${t.checks?.total ?? 0} ${t.checks?.total === 1 ? 'check' : 'checks'}`;
  switch (t.status) {
    case 'dispatched':
    case 'running':
      return t.assetKind === 'ci_runner' ? 'Flint is watching for the run.' : t.assetKind === 'local_worker' ? 'The local model is working on it.' : TASK_STATUS_SAYS[t.status];
    case 'checking':
      return t.waitingForWill ? 'It passed its checks and is waiting for you.' : TASK_STATUS_SAYS.checking;
    case 'accepted':
      return t.overridden ? 'You accepted it.' : t.checks ? `It passed ${n(t.checks.met)}.` : TASK_STATUS_SAYS.accepted;
    case 'rejected':
      return t.overridden ? 'You rejected it.' : t.checks ? `It failed ${n(t.checks.total - t.checks.met)}.` : TASK_STATUS_SAYS.rejected;
    case 'failed':
      return t.failure ? TASK_FAILURE_SAYS[t.failure] : TASK_STATUS_SAYS.failed;
    default:
      return TASK_STATUS_SAYS[t.status];
  }
}

// ---- The Tasks panel's wire -----------------------------------------------------------------------
// The console reaches the runtime's task routes through the server. A task's
// title and result travel only between the runtime and Will's console (the
// runtime's `proposals` scope), never to a model, a log or an audit entry.

export const TASK_TABS = ['active', 'finished'] as const;
export type TaskTab = (typeof TASK_TABS)[number];

/**
 * POST /tasks: a new task, as the New Task form sends it. The runtime makes its
 * id from the draft key, its title and its rule checks from the template, and
 * files its dispatch card in the same request.
 */
export const NewTaskBody = z
  .object({
    draftKey: DraftKey,
    template: z.enum(TASK_TEMPLATE_IDS),
    params: z.record(z.string().max(40), z.unknown()),
    goalId: GoalId.nullable().default(null),
    dueAt: IsoMs.nullable().default(null),
    /** Will's own check, in his words: judged by a local review. */
    ownCheck: z.string().max(300).nullable().default(null),
  })
  .strict();
export type NewTaskBody = z.infer<typeof NewTaskBody>;

const ProposalRef = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);
const Sentence = z.string().min(1).max(200);
/** A task's row in a tab: its title (its template's fixed words), what it is about, and where it stands. */
export const TaskRow = z
  .object({
    id: TaskId,
    title: TaskTitle,
    /** What it is about: one item by its label (made from its key), or how many items. Never a title. */
    about: z.string().min(1).max(120).nullable(),
    status: z.enum(TASK_STATUSES),
    line: Sentence,
    /** The asset it runs on, by the registry's name. */
    runsOn: z.string().min(1).max(80),
    /** It read outside text, or its result is a model's: shown marked. */
    outside: z.boolean(),
    costs: z.boolean(),
    createdAt: IsoMs,
  })
  .strict();
export type TaskRow = z.infer<typeof TaskRow>;
export const TasksPage = z.object({ tasks: z.array(TaskRow).max(200), more: z.boolean() }).strict();

/** One task, open. `result` is built by template code from its output, never by a second model call. */
export const TaskView = TaskRow.extend({
  /** Its result in a sentence or two, always shown as outside text; null until there is one, and once it is cleared. */
  result: z.string().max(1000).nullable(),
  checks: z.array(z.object({ id: CheckId, name: z.string().min(1).max(200), state: z.enum(['passed', 'failed', 'waiting']) }).strict()).max(10),
  checkedBy: z.enum(['rules', 'model', 'you']).nullable(),
  askedBy: z.enum(['you', 'flint']),
  goalId: GoalId.nullable(),
  dueAt: IsoMs.nullable(),
  /** Its forecast, from its Prediction row: never a model's words. */
  chance: z.object({ likelihood: z.enum(LIKELIHOODS), percent: z.number().int().min(0).max(100) }).strict().nullable(),
  /** What it cost, in millionths of a dollar; null until it ends, and for a task that costs nothing. */
  cost: z.object({ micros: z.number().int().min(0), estimate: z.boolean() }).strict().nullable(),
  /** Its card that is waiting for Will, if one is. */
  card: ProposalRef.nullable(),
  /** What Will can do with it now. */
  can: z.object({ cancel: z.boolean(), accept: z.boolean(), reject: z.boolean() }).strict(),
}).strict();
export type TaskView = z.infer<typeof TaskView>;
export const TaskAnswer = z.object({ task: TaskView }).strict();

/** An asset's row in Settings: the registry's name, whether it is on, and the sentence under it. */
export const AssetRow = z
  .object({
    id: AssetId,
    name: z.string().min(1).max(80),
    kind: z.enum(ASSET_KINDS),
    on: z.boolean(),
    /** Its turn-on card is waiting for Will. */
    waiting: z.boolean(),
    line: Sentence,
    /** Turning it on can be asked for now. */
    canTurnOn: z.boolean(),
    costs: z.boolean(),
  })
  .strict();
export type AssetRow = z.infer<typeof AssetRow>;
export const AssetsPage = z.object({ assets: z.array(AssetRow).max(50), reviewsRequired: z.boolean() }).strict();

/** A task made and its dispatch card filed; a card filed for an existing task or asset; an unsigned write done. */
export const TaskFiled = z.object({ id: TaskId, proposalId: ProposalRef, deduped: z.boolean() }).strict();
export const TaskCardFiled = z.object({ proposalId: ProposalRef, deduped: z.boolean() }).strict();
export const TaskDone = z.object({ ok: z.literal(true) }).strict();
