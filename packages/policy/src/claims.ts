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

export const CLAIM_TEMPLATE_PARAMS = {
  service_healthy: z.object({ entity: ClaimRef }).strict(),
  deploy_succeeds: z.object({ entity: ClaimRef }).strict(),
  threshold: z.object({ series: z.string().regex(/^[a-z0-9_]+(\.[a-z0-9_-]+)+$/).max(80), op: z.enum(['above', 'below']), value: z.number().finite() }).strict(),
  closed_by: z.object({ entity: ClaimRef }).strict(),
} as const;

export type ClaimTemplateId = keyof typeof CLAIM_TEMPLATE_PARAMS;
export const CLAIM_TEMPLATE_IDS = Object.keys(CLAIM_TEMPLATE_PARAMS) as ClaimTemplateId[];

/** A template with its params, as a tool takes it. */
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
