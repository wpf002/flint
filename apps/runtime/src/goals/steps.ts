/**
 * What a goal review may suggest for a plan (P3 part 3): operations built only
 * from templates. The local model never writes a step's title, or any other
 * word that is stored or shown: it picks a template and names a step, an item
 * or a check by id, and this module turns that into
 *
 *  - a TemplateOp, the review's record of the suggestion (GoalReview.diff):
 *    ids, enums and times only; and
 *  - a step title, from STEP_TEMPLATES and nothing else: an item is named by
 *    its key-made label (`wpf002/flint #57`, items.ts), a check by Will's own
 *    words, clipped.
 *
 * resolveReply refuses anything that does not fit the plan as it stands: a step
 * the plan does not have, an item the goal is not linked to, a check it does
 * not have, a done or skipped step (a step is done by doing it, H7; skipping
 * one and bringing one back are Will's), two changes of the same thing.
 */
import { z } from 'zod';
import { CriterionId, IsoMs, StepKey, addLocalDays, localDay, localWallTime, type PlanStepState, type StepKind } from '@flint/policy';

/** A step Flint may add: its kind, what it is about, and its title. The only source of a step title Flint writes. */
export const STEP_TEMPLATES = {
  check_item: { kind: 'will_task', about: 'item', title: (x: string) => `Check on ${x}` },
  follow_up: { kind: 'will_task', about: 'item', title: (x: string) => `Follow up on ${x}` },
  wait_for_item: { kind: 'wait', about: 'item', title: (x: string) => `Wait for ${x} to change` },
  decide: { kind: 'decision', about: 'item', title: (x: string) => `Decide what to do about ${x}` },
  // No quotation marks of its own: the panel puts a title in quotes when it says a change, and quotes never nest.
  work_on: { kind: 'will_task', about: 'criterion', title: (x: string) => `Work on: ${x}` },
  review_progress: { kind: 'will_task', about: 'nothing', title: (_x: string) => 'Review your progress on this goal' },
} as const satisfies Readonly<Record<string, { kind: StepKind; about: 'item' | 'criterion' | 'nothing'; title: (x: string) => string }>>;
export type StepTemplateId = keyof typeof STEP_TEMPLATES;
export const STEP_TEMPLATE_IDS = Object.keys(STEP_TEMPLATES) as [StepTemplateId, ...StepTemplateId[]];
/** The version of the templates, as a plan card's provenance names it. */
export const STEP_TEMPLATES_REF = 'goals.steps.v1';

/** A check's words inside a step title: at most this many characters. */
export const CRITERION_CLIP = 80;
/** A step Flint adds is due at 17:00 local on its day (the panel's own Add Step does the same). */
export const STEP_DUE_HOUR = 17;

const clip = (s: string, n: number) => (Array.from(s).length > n ? `${Array.from(s).slice(0, n - 1).join('')}…` : s);

/** A template's title for an item's label or a check's words; undefined when what it is about is missing. */
export function stepTitle(template: StepTemplateId, about: { label?: string | undefined; criterion?: string | undefined }): string | undefined {
  const t = STEP_TEMPLATES[template];
  if (t.about === 'nothing') return t.title('');
  const x = t.about === 'item' ? about.label?.trim() : about.criterion?.replace(/\s+/g, ' ').trim();
  if (!x) return undefined;
  return t.title(t.about === 'criterion' ? clip(x, CRITERION_CLIP) : x).slice(0, 200);
}

const SHAPES = STEP_TEMPLATE_IDS.map((id) => {
  const t = STEP_TEMPLATES[id];
  const [before, after] = t.title('\u0000').split('\u0000');
  return { kind: t.kind as StepKind, before: before ?? '', after: after ?? '', fixed: t.about === 'nothing' };
});

/**
 * Could a step of this kind and title have come from a template? The card gate
 * (apply.ts) asks before it files or runs a review's added step, so the
 * templates hold whoever calls the proposals contract, not only this module.
 */
export function fromTemplate(title: string, kind: StepKind): boolean {
  return SHAPES.some((x) => x.kind === kind && (x.fixed ? title === x.before : title.length > x.before.length + x.after.length && title.startsWith(x.before) && title.endsWith(x.after)));
}

/** 17:00 local, `days` calendar days from now's local day: a calendar step, never a multiple of 24 hours. */
export function dueIn(tz: string, now: Date, days: number): string {
  return localWallTime(tz, addLocalDays(localDay(tz, now), days), STEP_DUE_HOUR, 0).toISOString();
}

const EntityId = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);
/** The statuses a review may suggest. Never done (H7), never skipped (that is its own operation, and material). */
export const SUGGESTED_STATUSES = ['todo', 'in_progress', 'blocked'] as const;

/**
 * One suggestion, as a review records it. `add.after`: the step it follows
 * (null: at the end). `move.after`: the step it would follow (null: first).
 */
export const TemplateOp = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add'), template: z.enum(STEP_TEMPLATE_IDS), entityId: EntityId.nullable(), criterion: CriterionId.nullable(), dueAt: IsoMs.nullable(), after: StepKey.nullable() }).strict(),
  z.object({ op: z.literal('due'), key: StepKey, dueAt: IsoMs }).strict(),
  z.object({ op: z.literal('status'), key: StepKey, status: z.enum(SUGGESTED_STATUSES) }).strict(),
  z.object({ op: z.literal('move'), key: StepKey, after: StepKey.nullable() }).strict(),
  z.object({ op: z.literal('skip'), key: StepKey }).strict(),
]);
export type TemplateOp = z.infer<typeof TemplateOp>;

/** Why a suggestion was not filed as a card. */
export const HELD = ['shadow', 'limit', 'cap', 'rejected', 'stale'] as const;
export type Held = (typeof HELD)[number];
/** A suggestion with what became of it: its class, the card it is on, or why it is on none. Ids only. */
export const DiffItem = z
  .object({ change: TemplateOp, class: z.enum(['minor', 'material']), card: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/).nullable(), held: z.enum(HELD).nullable() })
  .strict();
export type DiffItem = z.infer<typeof DiffItem>;
export const Diff = z.array(DiffItem).max(20);

/** The model's reply, one operation: every field present, a sentinel where it does not apply. No free text. */
export interface ReplyOp {
  op: 'add_step' | 'set_due' | 'set_status' | 'move' | 'skip' | 'none';
  step: string;
  template: StepTemplateId | 'none';
  ref: string;
  criterion: string;
  dueInDays: number;
  status: (typeof SUGGESTED_STATUSES)[number] | 'none';
  after: string;
}

/** The plan and the goal as the model was shown them: what its ids may name. */
export interface PlanState {
  steps: readonly Pick<PlanStepState, 'key' | 'status'>[];
  /** The goal's linked items, by the ref the prompt showed. */
  items: ReadonlyMap<string, string>;
  /** The goal's check ids. */
  criteria: ReadonlySet<string>;
}

/**
 * The reply's operations as TemplateOps, or null when any of them does not fit
 * (the whole reply is then refused: an attempt used up). `none` says nothing.
 */
export function resolveReply(ops: readonly ReplyOp[], s: PlanState, tz: string, now: Date): TemplateOp[] | null {
  const steps = new Map(s.steps.map((x) => [x.key, x]));
  /** A step a review may touch: in the plan, and neither done nor skipped. */
  const open = (key: string) => {
    const st = steps.get(key);
    return st && st.status !== 'done' && st.status !== 'skipped' ? st : undefined;
  };
  const touched = new Set<string>();
  const once = (what: string) => (touched.has(what) ? false : (touched.add(what), true));
  const out: TemplateOp[] = [];
  for (const o of ops) {
    if (o.op === 'none') continue;
    if (o.op === 'add_step') {
      if (o.template === 'none') return null;
      const about = STEP_TEMPLATES[o.template].about;
      const entityId = about === 'item' ? s.items.get(o.ref) : undefined;
      if (about === 'item' && !entityId) return null;
      if (about === 'criterion' && !s.criteria.has(o.criterion)) return null;
      if (o.after && !steps.has(o.after)) return null;
      // The same step twice is one suggestion.
      if (!once(`add:${o.template}:${entityId ?? ''}:${about === 'criterion' ? o.criterion : ''}`)) return null;
      out.push({
        op: 'add', template: o.template, entityId: entityId ?? null, criterion: about === 'criterion' ? o.criterion : null,
        dueAt: o.dueInDays < 0 ? null : dueIn(tz, now, o.dueInDays), after: o.after || null,
      });
      continue;
    }
    if (!open(o.step)) return null;
    if (o.op === 'set_due') {
      if (o.dueInDays < 0 || !once(`due:${o.step}`)) return null;
      out.push({ op: 'due', key: o.step, dueAt: dueIn(tz, now, o.dueInDays) });
    } else if (o.op === 'set_status') {
      if (o.status === 'none' || !once(`status:${o.step}`)) return null;
      out.push({ op: 'status', key: o.step, status: o.status });
    } else if (o.op === 'skip') {
      if (!once(`status:${o.step}`)) return null;
      out.push({ op: 'skip', key: o.step });
    } else {
      if (o.after === o.step || (o.after && !steps.has(o.after)) || !once(`move:${o.step}`)) return null;
      out.push({ op: 'move', key: o.step, after: o.after || null });
    }
  }
  return out;
}
