/**
 * Recording a prediction (plan P1 ledger; exit criterion 5). A prediction must
 * say how it will be resolved and by when, within 180 days, and Flint never
 * claims certainty: only Will's own (method `human`) may go below 5% or above
 * 95%. The database enforces the same rules; this rejects early, with reasons.
 *
 * Honesty (plan 3.0.9): when any input is tainted, the claim is rendered from a
 * fixed template instead of free text, so a stranger's words never become a
 * statement Flint makes.
 */
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import type { Db, Tx } from '../db.js';

export const DOMAINS = ['services', 'deploys', 'spend', 'repos', 'projects', 'calendar', 'goals', 'assets', 'selfmod', 'triage', 'recommendation'] as const;
export const TYPES = ['event_occurs', 'deadline_met', 'threshold_cross', 'trend', 'relevance', 'task_meets_bar', 'effect_given_accept'] as const;
const HORIZON_MS = 180 * 86400_000;

/** An entity reference a template may name: kind#shortId, never a title. */
const Ref = z.string().regex(/^[a-z_]{2,20}#[A-Za-z0-9]{1,12}$/);
/**
 * Fixed claim templates for predictions made from tainted inputs. Each has its
 * own schema: only entity refs, series keys, an operator and numbers fill them,
 * so a stranger's words can never become a claim Flint makes.
 */
export const CLAIM_TEMPLATES = {
  service_healthy: { params: z.object({ entity: Ref }).strict(), render: (p: { entity: string }) => `${p.entity} reports healthy at the resolve time` },
  deploy_succeeds: { params: z.object({ entity: Ref }).strict(), render: (p: { entity: string }) => `the next deployment of ${p.entity} succeeds` },
  threshold: {
    params: z.object({ series: z.string().regex(/^[a-z0-9_]+(\.[a-z0-9_-]+)+$/).max(80), op: z.enum(['above', 'below']), value: z.number().finite() }).strict(),
    render: (p: { series: string; op: string; value: number }) => `${p.series} is ${p.op} ${p.value} at the resolve time`,
  },
  closed_by: { params: z.object({ entity: Ref }).strict(), render: (p: { entity: string }) => `${p.entity} is closed by the resolve time` },
} as const;
export type ClaimTemplate = keyof typeof CLAIM_TEMPLATES;

const Evidence = z.array(z.object({ kind: z.string().min(1).max(40), ref: z.string().min(1).max(200), note: z.string().max(200).optional() }).strict()).max(20);

export const EmitPrediction = z
  .object({
    claim: z.string().min(1).max(300).optional(),
    template: z
      .object({ id: z.enum(Object.keys(CLAIM_TEMPLATES) as [ClaimTemplate, ...ClaimTemplate[]]), params: z.record(z.string(), z.union([z.string().max(120), z.number().finite()])) })
      .strict()
      .optional(),
    kind: z.enum(['binary', 'interval']).default('binary'),
    probability: z.number().min(0).max(1).optional(),
    method: z.enum(['model_reasoning', 'prophet', 'rule', 'base_rate', 'human']),
    model: z.string().max(100).optional(),
    modelConfig: z.record(z.string(), z.unknown()).optional(),
    domain: z.enum(DOMAINS),
    type: z.enum(TYPES),
    evidence: Evidence,
    resolutionCriteria: z.string().max(1000),
    resolver: z.enum(['auto_world', 'auto_metric', 'will', 'conditional']),
    resolverSpec: z.record(z.string(), z.unknown()).optional(),
    conditionRecommendationId: z.string().max(40).optional(),
    resolveBy: z.string().datetime({ offset: true }),
    subjectEntityId: z.string().max(40).optional(),
    supersedesId: z.string().max(40).optional(),
    tainted: z.boolean().default(false),
  })
  .strict();
export type EmitPrediction = z.infer<typeof EmitPrediction>;

export class Invalid extends Error {}

/** The reasons a prediction is refused, or [] when it may be recorded. */
export function validatePrediction(p: EmitPrediction, now = new Date()): string[] {
  const why: string[] = [];
  if (!p.resolutionCriteria.trim()) why.push('missing resolution criteria');
  const by = Date.parse(p.resolveBy);
  if (!(by > now.getTime())) why.push('resolveBy must be in the future');
  if (by - now.getTime() > HORIZON_MS) why.push('the horizon is over 180 days');
  if (p.kind === 'binary' && p.probability === undefined) why.push('a binary prediction needs a probability');
  if (p.probability !== undefined && p.method !== 'human' && (p.probability < 0.05 || p.probability > 0.95)) {
    why.push('only Will may predict below 5% or above 95%');
  }
  if ((p.resolver === 'conditional') !== (p.conditionRecommendationId !== undefined)) {
    why.push('a conditional prediction names its recommendation, and only it does');
  }
  if (p.tainted && !p.template) why.push('a prediction from tainted inputs uses a claim template');
  if (p.template) {
    const ok = CLAIM_TEMPLATES[p.template.id].params.safeParse(p.template.params);
    if (!ok.success) why.push(`template ${p.template.id}: ${ok.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')}`);
  }
  if (!p.claim && !p.template) why.push('missing claim');
  return why;
}

/** The claim as it will be stored: the template's rendering when there is one. */
export function renderClaim(p: EmitPrediction): string {
  if (p.template) {
    const t = CLAIM_TEMPLATES[p.template.id];
    return (t.render as (x: unknown) => string)(t.params.parse(p.template.params)).slice(0, 300);
  }
  return p.claim!;
}

export async function emitPrediction(db: Db | Tx, p: EmitPrediction, createdBy: string, now = new Date()) {
  const why = validatePrediction(p, now);
  if (why.length) throw new Invalid(why.join('; '));
  return db.prediction.create({
    data: {
      id: `pd${now.getTime().toString(36)}${Math.random().toString(36).slice(2, 12)}`,
      claim: renderClaim(p),
      kind: p.kind,
      probability: p.probability ?? null,
      method: p.method,
      model: p.model ?? null,
      ...(p.modelConfig ? { modelConfig: p.modelConfig as Prisma.InputJsonObject } : {}),
      domain: p.domain,
      type: p.type,
      evidence: p.evidence as Prisma.InputJsonArray,
      resolutionCriteria: p.resolutionCriteria,
      resolver: p.resolver,
      ...(p.resolverSpec ? { resolverSpec: p.resolverSpec as Prisma.InputJsonObject } : {}),
      conditionRecommendationId: p.conditionRecommendationId ?? null,
      resolveBy: new Date(p.resolveBy),
      subjectEntityId: p.subjectEntityId ?? null,
      supersedesId: p.supersedesId ?? null,
      tainted: p.tainted,
      createdBy,
    },
  });
}
