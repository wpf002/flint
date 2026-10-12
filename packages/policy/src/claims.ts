/**
 * The ledger's claim templates (Machine plan 3.0.9): when any input to a
 * prediction is tainted, its claim is one of these, filled only with entity
 * references, series keys, an operator and numbers, so a stranger's words can
 * never become a statement Flint makes. Shared by the runtime (which renders
 * and enforces them), the runtime MCP connector (which shows them to the model)
 * and the chat gate (which refuses a bad one before Will is asked to approve it).
 */
import { z } from 'zod';

/** An entity reference: kind#shortId, never a title. */
export const ClaimRef = z.string().regex(/^[a-z_]{2,20}#[A-Za-z0-9]{1,12}$/);

/** A series key: lowercase segments, never words. */
const SeriesRef = z.string().regex(/^[a-z0-9_]+(\.[a-z0-9_-]+)+$/).max(80);

export const CLAIM_TEMPLATE_PARAMS = {
  service_healthy: z.object({ entity: ClaimRef }).strict(),
  deploy_succeeds: z.object({ entity: ClaimRef }).strict(),
  threshold: z.object({ series: SeriesRef, op: z.enum(['above', 'below']), value: z.number().finite() }).strict(),
  closed_by: z.object({ entity: ClaimRef }).strict(),
  /**
   * A goal review's forecast (P3): the goal by its ref (goal#<last 6 of its id>, never its title) and a local
   * day. The runtime's own: it is not in ClaimTemplate below, so no tool and no caller of the ledger's route
   * can fill it (the runtime refuses it there, and the database ties a goal's forecast to the goals writer).
   */
  goal_on_track: z.object({ goal: ClaimRef, by: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict(),
  // P4, the runtime's own: a forecast's range for one step of a series. A registry key, two numbers and a local date.
  series_range: z
    .object({ series: SeriesRef, lo: z.number().finite(), hi: z.number().finite(), on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })
    .strict()
    .refine((p) => p.lo <= p.hi, 'the range is upside down'),
  // The forecaster's yes/no question about the same step: is the series' number for that day (or the week starting
  // then) above a value? Its own template because chat's `threshold` says "at the resolve time", and this is about
  // a whole step.
  series_above: z.object({ series: SeriesRef, value: z.number().finite(), on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict(),
  /**
   * P5, the runtime's own: a task's forecast that it meets its bar. The task by its ref (task#<last 6 of its
   * id>, never its title) and a local day.
   */
  task_meets_bar: z.object({ task: ClaimRef, by: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict(),
} as const;

export type ClaimTemplateId = keyof typeof CLAIM_TEMPLATE_PARAMS;
export const CLAIM_TEMPLATE_IDS = Object.keys(CLAIM_TEMPLATE_PARAMS) as ClaimTemplateId[];
/**
 * Templates only the runtime's own writers fill (a goal review's forecast, the
 * forecaster's range and its question, a task's forecast). Chat is never offered them: they are not in ClaimTemplate
 * below, which is what the connector shows the model and the chat gate checks,
 * and the ledger's route takes chat's templates only.
 */
export const RUNTIME_CLAIM_TEMPLATE_IDS = ['goal_on_track', 'series_range', 'series_above', 'task_meets_bar'] as const satisfies readonly ClaimTemplateId[];
/** The templates chat may fill. */
export const CHAT_CLAIM_TEMPLATE_IDS = CLAIM_TEMPLATE_IDS.filter((id) => !(RUNTIME_CLAIM_TEMPLATE_IDS as readonly string[]).includes(id)) as Array<
  Exclude<ClaimTemplateId, (typeof RUNTIME_CLAIM_TEMPLATE_IDS)[number]>
>;

/** A template with its params, as a tool takes it (chat's four; never the runtime's own: only a goal's review fills goal_on_track, only the forecaster series_range). */
export const ClaimTemplate = z.discriminatedUnion('id', [
  z.object({ id: z.literal('service_healthy'), params: CLAIM_TEMPLATE_PARAMS.service_healthy }).strict(),
  z.object({ id: z.literal('deploy_succeeds'), params: CLAIM_TEMPLATE_PARAMS.deploy_succeeds }).strict(),
  z.object({ id: z.literal('threshold'), params: CLAIM_TEMPLATE_PARAMS.threshold }).strict(),
  z.object({ id: z.literal('closed_by'), params: CLAIM_TEMPLATE_PARAMS.closed_by }).strict(),
]);
export type ClaimTemplate = z.infer<typeof ClaimTemplate>;

/**
 * How a template names an entity: its kind and the last 6 characters of its id
 * (the same short form safeName uses), never its title. The world tools give it
 * as `ref`.
 */
export const entityRef = (kind: string, id: string): string => `${kind}#${id.slice(-6)}`;

/** The templates in words, for a model choosing one. */
export const CLAIM_TEMPLATE_HELP =
  'service_healthy {entity} (it reports healthy at the resolve time); deploy_succeeds {entity} (its next deployment succeeds); ' +
  'threshold {series: "a.b", op: "above"|"below", value: number} (the series is above/below the value at the resolve time); closed_by {entity} (it is closed by the resolve time). ' +
  'entity is the `ref` world_now or world_entity gives for it (kind#<last 6 characters of its id>, e.g. service#24ehza), never its title.';
