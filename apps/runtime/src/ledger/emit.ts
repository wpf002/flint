/**
 * Recording a prediction (plan P1 ledger; exit criterion 5). A prediction must
 * say how it will be resolved and by when, within 180 days, and Flint never
 * claims certainty: only Will's own (method `human`) may go below 5% or above
 * 95%. The database enforces the same rules; this rejects early, with reasons.
 *
 * Honesty (plan 3.0.9): when any input is tainted, the claim is rendered from a
 * fixed template instead of free text, so a stranger's words never become a
 * statement Flint makes.
 *
 * P4: a forecast's prediction also carries its range (a range's middle, ends and
 * level), its unit, and the series and run it came from. `statistical` is a
 * forecast computed on this Mac that beat a naive guess; the database holds the
 * method to what the run earned (prediction_forecast_check). Nothing is recorded
 * as `prophet`: Flint calls no outside forecaster (the name stays in P1's list).
 * A reason given here never carries a number from a series.
 *
 * Over HTTP only chat's own shape is taken (ChatPrediction): every other
 * prediction is written by runtime code.
 */
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { CHAT_CLAIM_TEMPLATE_IDS, CLAIM_TEMPLATE_PARAMS, RUNTIME_CLAIM_TEMPLATE_IDS, SeriesKey, TASKS_WRITER, TaskForecastSpec } from '@flint/policy';
import type { Db, Tx } from '../db.js';
import { forecastSeries } from '../predict/series.js';

export const DOMAINS = ['services', 'deploys', 'spend', 'repos', 'projects', 'calendar', 'goals', 'assets', 'selfmod', 'triage', 'recommendation'] as const;
export const TYPES = ['event_occurs', 'deadline_met', 'threshold_cross', 'trend', 'relevance', 'task_meets_bar', 'effect_given_accept'] as const;
/**
 * The types chat may file under: every one but a task's own (P5), which only
 * the tasks writer records. The connector's tool offers the same list
 * (packages/mcp/connectors/runtime-server.ts; a test keeps the two in step).
 */
export const CHAT_TYPES = ['event_occurs', 'deadline_met', 'threshold_cross', 'trend', 'relevance', 'effect_given_accept'] as const satisfies ReadonlyArray<(typeof TYPES)[number]>;
const HORIZON_MS = 180 * 86400_000;

/**
 * Fixed claim templates for predictions made from tainted inputs: their params'
 * schemas are shared (@flint/policy claims.ts), so the chat gate and the
 * runtime connector check the same rules this does.
 */
export const CLAIM_TEMPLATES = {
  service_healthy: { params: CLAIM_TEMPLATE_PARAMS.service_healthy, render: (p: { entity: string }) => `${p.entity} reports healthy at the resolve time` },
  deploy_succeeds: { params: CLAIM_TEMPLATE_PARAMS.deploy_succeeds, render: (p: { entity: string }) => `the next deployment of ${p.entity} succeeds` },
  threshold: { params: CLAIM_TEMPLATE_PARAMS.threshold, render: (p: { series: string; op: string; value: number }) => `${p.series} is ${p.op} ${p.value} at the resolve time` },
  closed_by: { params: CLAIM_TEMPLATE_PARAMS.closed_by, render: (p: { entity: string }) => `${p.entity} is closed by the resolve time` },
  // A goal review's forecast (P3): the goal by its ref, never its title.
  goal_on_track: { params: CLAIM_TEMPLATE_PARAMS.goal_on_track, render: (p: { goal: string; by: string }) => `${p.goal} meets its success criteria by ${p.by}` },
  // P4, the forecaster's own (never offered to chat): a registry key, two numbers and a local date.
  series_range: { params: CLAIM_TEMPLATE_PARAMS.series_range, render: (p: { series: string; lo: number; hi: number; on: string }) => `${p.series} is between ${p.lo} and ${p.hi} on ${p.on}` },
  // ...and its yes/no question about the same step (a whole day or week, so never "at the resolve time").
  series_above: { params: CLAIM_TEMPLATE_PARAMS.series_above, render: (p: { series: string; value: number; on: string }) => `${p.series} is above ${p.value} on ${p.on}` },
  // A task's forecast (P5): the task by its ref, never its title.
  task_meets_bar: { params: CLAIM_TEMPLATE_PARAMS.task_meets_bar, render: (p: { task: string; by: string }) => `${p.task} meets its bar by ${p.by}` },
} as const;
export type ClaimTemplate = keyof typeof CLAIM_TEMPLATES;
/** Templates only the runtime's own writers fill (a goal review's, the forecaster's, a task's): never one a caller of the ledger's route may send. */
export const INTERNAL_TEMPLATES: ReadonlySet<string> = new Set<ClaimTemplate>(RUNTIME_CLAIM_TEMPLATE_IDS);

export const METHODS = ['model_reasoning', 'prophet', 'statistical', 'rule', 'base_rate', 'human'] as const;
/** The methods a prediction made from a forecast run may claim. */
const RUN_METHODS: ReadonlySet<string> = new Set(['statistical', 'base_rate', 'model_reasoning']);
/** Who writes a run's predictions: the forecaster, and the local model's estimate. */
export const FORECAST_WRITER = 'runtime:forecast';
export const REASON_WRITER = 'runtime:reason';

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
    method: z.enum(METHODS),
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
    // P4: a range's numbers (kind interval), and where a forecast's prediction came from.
    pointEstimate: z.number().finite().optional(),
    lower: z.number().finite().optional(),
    upper: z.number().finite().optional(),
    level: z.number().gt(0).lt(1).optional(),
    unit: z.string().regex(/^[a-z_]{1,20}$/).optional(),
    seriesKey: SeriesKey.optional(),
    forecastRunId: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/).optional(),
  })
  .strict();
export type EmitPrediction = z.infer<typeof EmitPrediction>;

/**
 * What POST /v1/ledger/predictions takes: exactly what chat's
 * ledger_record_prediction sends (packages/mcp/connectors/runtime-server.ts), and
 * no more. A yes/no estimate the model made, which only Will resolves, in the
 * model's words or one of chat's four templates. Not another method (`human`
 * would lift the 5% to 95% band; `statistical` would claim a forecast), not
 * another resolver, not a range, a series, a run, a subject or a supersession.
 * The chat connector's token holds this route's scope, so the route is held to
 * what that connector sends.
 */
export const ChatPrediction = z
  .object({
    claim: z.string().min(1).max(300).optional(),
    template: z
      .object({ id: z.enum(CHAT_CLAIM_TEMPLATE_IDS as [(typeof CHAT_CLAIM_TEMPLATE_IDS)[number], ...Array<(typeof CHAT_CLAIM_TEMPLATE_IDS)[number]>]), params: z.record(z.string(), z.union([z.string().max(120), z.number().finite()])) })
      .strict()
      .optional(),
    kind: z.literal('binary').default('binary'),
    probability: z.number().min(0).max(1),
    method: z.literal('model_reasoning'),
    domain: z.enum(DOMAINS),
    type: z.enum(CHAT_TYPES),
    evidence: Evidence,
    resolutionCriteria: z.string().max(1000),
    resolver: z.literal('will'),
    resolveBy: z.string().datetime({ offset: true }),
    /** Whether the turn read text from outside: the server says, and the connector always sends it. */
    tainted: z.boolean(),
  })
  .strict();
export type ChatPrediction = z.infer<typeof ChatPrediction>;

/**
 * The wider shape with the runtime's own templates taken out. The route itself
 * takes ChatPrediction, which is narrower still; this is what part of P3's
 * tests hold the wider shape to: no goal's id (the object is strict, and the
 * goal a forecast is about is an argument only the goals writer passes), and
 * none of the templates only the runtime fills.
 */
export const EmitPredictionIn = EmitPrediction.refine((p) => !p.template || !INTERNAL_TEMPLATES.has(p.template.id), { message: 'this template is the runtime’s own', path: ['template', 'id'] });

export class Invalid extends Error {}

/**
 * The reasons a prediction is refused, or [] when it may be recorded. `createdBy`,
 * when given, is held to the forecast writers' rule too (emitPrediction gives it).
 */
export function validatePrediction(p: EmitPrediction, now = new Date(), createdBy?: string): string[] {
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
  // P4 (the database's prediction_valid says the same, by id).
  const range = [p.pointEstimate, p.lower, p.upper, p.level];
  if (p.kind === 'interval') {
    if (range.some((x) => x === undefined)) why.push('a range needs its middle, both ends and a level');
    else if (!(p.lower! <= p.pointEstimate! && p.pointEstimate! <= p.upper!)) why.push('a range runs from its lower end, through its middle, to its upper end');
  } else if (range.some((x) => x !== undefined)) {
    why.push('a yes/no prediction carries no range');
  }
  if ((p.forecastRunId === undefined) !== (p.seriesKey === undefined)) why.push('a forecast names its run and its series together');
  // P5: a task's forecast is the tasks writer's, under its own template, domain and type, by base rate, settled
  // from the world under the rule that names its task. That writer records nothing else, and no other writer
  // (a caller that names none among them) uses the template, or the domain and type together: the database
  // knows a task's forecast by that pair, and scores one only for its task, so another writer's would never be.
  const taskPair = p.domain === 'assets' && p.type === 'task_meets_bar';
  const taskShaped = p.template?.id === 'task_meets_bar' && taskPair && p.kind === 'binary' && p.method === 'base_rate'
    && p.resolver === 'auto_world' && !p.tainted && TaskForecastSpec.safeParse(p.resolverSpec).success;
  if (createdBy === TASKS_WRITER ? !taskShaped : p.template?.id === 'task_meets_bar' || taskPair) why.push('a task’s forecast is the tasks writer’s, under the task template with its task’s rule, and only it is');
  // A forecast writer's row always names its run and series: neither has a way to record a series' numbers loose.
  if ((createdBy === FORECAST_WRITER || createdBy === REASON_WRITER) && p.forecastRunId === undefined) why.push(`${createdBy} records only a forecast's predictions, each with its run and series`);
  if (p.method === 'prophet') why.push('no prediction is recorded as prophet: Flint forecasts on this Mac');
  if (p.method === 'statistical' && p.forecastRunId === undefined) why.push('a statistical prediction names its forecast run');
  if (p.forecastRunId !== undefined) {
    if (!RUN_METHODS.has(p.method) && p.method !== 'prophet') why.push(`a forecast's prediction is not made by ${p.method}`);
    if (p.resolver !== 'auto_metric') why.push("a forecast's prediction resolves by itself, from its series");
    if (p.tainted) why.push("a forecast's prediction is never tainted");
    if (p.subjectEntityId !== undefined) why.push("a forecast's prediction is about a series, not an entity");
    const writer = p.method === 'model_reasoning' ? REASON_WRITER : FORECAST_WRITER;
    if (createdBy !== undefined && createdBy !== writer) why.push(`a forecast's ${p.method} prediction is written by ${writer}`);
    // It says what its series is (the registry is the authority; the database holds the unit, and the two
    // domains it can tell from a series, to the same): a forecast of dollars is never on record as a count.
    const def = p.seriesKey === undefined ? undefined : forecastSeries(p.seriesKey);
    if (!def) why.push('a forecast is of a registered series');
    else {
      if (p.unit !== def.unit) why.push("a forecast carries its series' unit");
      if (p.domain !== def.domain) why.push("a forecast is filed under its series' domain");
    }
  }
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

/**
 * Record a prediction. `own` is the runtime's alone, never read from a request:
 * the goal a review's onTrack forecast is about (P3). A goal's forecast is the
 * goals writer's (the database checks createdBy too) and uses its own template;
 * a task's (P5) is the tasks writer's, under the task template (validatePrediction).
 */
export async function emitPrediction(db: Db | Tx, p: EmitPrediction, createdBy: string, now = new Date(), own: { goalId?: string } = {}) {
  const why = validatePrediction(p, now, createdBy);
  if ((p.template?.id === 'goal_on_track') !== (own.goalId !== undefined)) why.push('a goal’s forecast uses the goal template, and only it does');
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
      pointEstimate: p.pointEstimate ?? null,
      lower: p.lower ?? null,
      upper: p.upper ?? null,
      level: p.level ?? null,
      unit: p.unit ?? null,
      seriesKey: p.seriesKey ?? null,
      forecastRunId: p.forecastRunId ?? null,
      createdBy,
      ...(own.goalId ? { goalId: own.goalId } : {}),
    },
  });
}
