/**
 * What the tests of Flint checking its own predictions share (P4 part 2):
 * predictions made "in the past", the world as it stood then, and the rows a
 * resolver reads. Synthetic only; every number a test checks for carries CANARY.
 *
 * The database stamps a prediction's time itself (a prediction cannot be
 * backdated), and it refuses a resolution whose event is before the prediction
 * or after now. A resolver test needs a prediction that is already due, so
 * `madeAgo` turns that one stamp off, as the owner, for the one insert: every
 * rule about resolutions stays on. Test files run one at a time on this
 * database, and each starts from a fresh one.
 */
import { applyObservation } from '../../src/world/mapper';
import { createDb, type Db } from '../../src/db';
import { HEX, id, type TestUrls } from '../db';
import { CANARY, p4Kit } from '../p4';

export { CANARY };
export const MIN = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;
/** Every test here keeps Flint's zone at UTC: a local day is a UTC day. */
export const TZ = 'UTC';

/** The start of the UTC day `daysAgo` days back (0: today). */
export function dayStart(daysAgo: number, now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysAgo));
}

export async function ledgerKit(urls: TestUrls) {
  const db: Db = createDb(urls.app);
  const k = await p4Kit(urls);
  const { app, owner } = k;

  /**
   * A prediction as if it was made `madeAgo` ms ago, due `dueAgo` ms ago (negative: still ahead). Defaults: a rule's
   * yes/no prediction that resolves from the world. Returns its id.
   */
  async function prediction(over: Record<string, unknown> = {}, t: { madeAgo?: number; dueAgo?: number } = {}): Promise<string> {
    const now = Date.now();
    const v: Record<string, unknown> = {
      id: id('pd'), claim: 'a synthetic claim', kind: 'binary', probability: 0.6, method: 'rule', domain: 'services', type: 'event_occurs', evidence: '[]',
      resolutionCriteria: 'synthetic criteria', resolver: 'auto_world', resolverSpec: null, createdBy: 'test', tainted: false,
      pointEstimate: null, lower: null, upper: null, level: null, unit: null, seriesKey: null, forecastRunId: null, goalId: null, subjectEntityId: null,
      conditionRecommendationId: null, supersedesId: null, ...over,
    };
    const createdAt = new Date(now - (t.madeAgo ?? 2 * DAY));
    const resolveBy = new Date(now - (t.dueAgo ?? HOUR));
    await owner(`ALTER TABLE "Prediction" DISABLE TRIGGER "Prediction_insert_check"`);
    try {
      await app(
        `INSERT INTO "Prediction" (id, claim, kind, probability, method, domain, type, evidence, "resolutionCriteria", resolver, "resolverSpec", "resolveBy", "createdAt", "createdBy", tainted,
                                   "pointEstimate", lower, upper, level, unit, "seriesKey", "forecastRunId", "goalId", "subjectEntityId", "conditionRecommendationId", "supersedesId")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11::jsonb, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26)`,
        [v.id, v.claim, v.kind, v.probability, v.method, v.domain, v.type, v.evidence, v.resolutionCriteria, v.resolver, v.resolverSpec === null ? null : JSON.stringify(v.resolverSpec),
          resolveBy, createdAt, v.createdBy, v.tainted, v.pointEstimate, v.lower, v.upper, v.level, v.unit, v.seriesKey, v.forecastRunId, v.goalId, v.subjectEntityId,
          v.conditionRecommendationId, v.supersedesId],
      );
    } finally {
      await owner(`ALTER TABLE "Prediction" ENABLE TRIGGER "Prediction_insert_check"`);
    }
    return v.id as string;
  }

  /** One number of a series: the value for the step that starts at `at`. */
  const point = (seriesKey: string, at: Date, value: number) => app(`INSERT INTO "MetricPoint" ("seriesKey", at, value) VALUES ($1, $2, $3)`, [seriesKey, at, value]);

  /** What a forecast's row says of its series (its unit, and the domain the database can tell from it). */
  async function seriesSays(seriesKey: string): Promise<{ unit: string; domain: string }> {
    const s = (await owner(`SELECT unit, sensitivity, key ~ '(^|[.])calendar([.]|$)' AS calendar FROM "MetricSeries" WHERE key = $1`, [seriesKey])).rows[0] as { unit: string; sensitivity: string; calendar: boolean };
    return { unit: s.unit, domain: s.sensitivity === 'financial' ? 'spend' : s.calendar ? 'calendar' : 'deploys' };
  }
  /**
   * The forecaster's range for the step that starts at `at`, on a run of its own (made now: a run's time is the
   * database's too). 2 to 6 around 4 at 80% unless said otherwise.
   */
  async function range(seriesKey: string, at: Date, over: Record<string, unknown> = {}, t: { madeAgo?: number; dueAgo?: number } = {}, run: Record<string, unknown> = {}): Promise<string> {
    const forecastRunId = await k.run(seriesKey, run);
    return prediction({
      kind: 'interval', probability: null, method: 'statistical', type: 'trend', resolver: 'auto_metric', createdBy: 'runtime:forecast', seriesKey, forecastRunId,
      ...(await seriesSays(seriesKey)), pointEstimate: 4, lower: 2, upper: 6, level: 0.8, resolverSpec: { seriesKey, at: at.toISOString(), op: 'range' }, ...over,
    }, t);
  }
  /** The forecaster's yes/no question about the same step: is the value above (or below) a threshold? */
  async function question(seriesKey: string, at: Date, op: 'above' | 'below', value: number, over: Record<string, unknown> = {}, t: { madeAgo?: number; dueAgo?: number } = {}): Promise<string> {
    const forecastRunId = await k.run(seriesKey);
    return prediction({
      method: 'statistical', type: 'threshold_cross', resolver: 'auto_metric', createdBy: 'runtime:forecast', seriesKey, forecastRunId, ...(await seriesSays(seriesKey)),
      resolverSpec: { seriesKey, at: at.toISOString(), op, value }, ...over,
    }, t);
  }

  /** A service as a source saw it at `at`: one observation through the real mapper (a change makes a version valid from `at`). Returns its entity id. */
  async function service(key: string, state: Record<string, unknown>, at: Date): Promise<string> {
    await db.$transaction((tx) => applyObservation(tx, { kind: 'service', key, name: key, state: { managedBy: 'launchd', ...state }, source: 'launchd', externalId: key, observedAt: at, actor: 'source:launchd' }));
    return (await db.entity.findFirstOrThrow({ where: { kind: 'service', key }, select: { id: true } })).id;
  }
  const serviceKey = () => `service:launchd:com.flint.test-${id('s').slice(-8)}`;

  /**
   * Triage's two predictions about a service that is down, as surface/record.ts writes them, made in the past: the
   * plain one ("healthy at the resolve time"), and the one that holds if Will takes the recommendation; with the
   * recommendation and the escalation that showed it to him.
   */
  async function escalated(entityId: string, o: { madeAgo?: number; dueAgo?: number; status?: string; ackedAgo?: number | null; escalation?: boolean; templateId?: string } = {}) {
    const t = { madeAgo: o.madeAgo ?? 3 * HOUR, dueAgo: o.dueAgo ?? HOUR };
    const recommendationId = id('rc');
    const common = { method: 'base_rate', subjectEntityId: entityId, createdBy: 'runtime:triage' };
    const plain = await prediction({ ...common, probability: 0.4, domain: 'services', type: 'event_occurs', resolver: 'auto_world', resolverSpec: { entityId, check: 'healthy', at: 'resolveBy' } }, t);
    const conditional = await prediction({ ...common, probability: 0.8, domain: 'recommendation', type: 'effect_given_accept', resolver: 'conditional', conditionRecommendationId: recommendationId }, t);
    await app(
      `INSERT INTO "Recommendation" (id, "templateId", params, domain, type, text, "expectedEffect", "predictionId", "createdBy")
       VALUES ($1, $2, '{}', 'services', 'escalation_action', 'Look at the synthetic service.', 'it reports healthy within 2 hours', $3, 'runtime:triage')`,
      [recommendationId, o.templateId ?? 'look_at_service', conditional],
    );
    let escalationId: string | undefined;
    if (o.escalation !== false) {
      const eventId = id('ev');
      await app(
        `INSERT INTO "SourceEvent" (id, source, "sourceRef", type, "occurredAt", sensitivity, payload, "payloadHash", status)
         VALUES ($1, 'runtime', $2, 'service.down_30m', now(), 'ops', '{}', $3, 'applied')`, [eventId, id('ref'), HEX('e')]);
      const decisionId = id('td');
      await app(`INSERT INTO "TriageDecision" (id, "sourceEventId", action, lane, "decidedBy", sensitivity) VALUES ($1, $2, 'escalate', 'relevant', 'code:service.down_30m', 'ops')`, [decisionId, eventId]);
      escalationId = id('es');
      await app(
        `INSERT INTO "Escalation" (id, "triageDecisionId", "templateId", fields, title, body, channels, sensitivity, "predictionId", "recommendationId", status, "ackedAt")
         VALUES ($1, $2, 'service_down', '{"minutes": 31}', 'A Service Is Down', 'It has been down for 31 minutes.', ARRAY['inapp'], 'ops', $3, $4, $5, $6)`,
        [escalationId, decisionId, plain, recommendationId, o.status ?? 'open', o.ackedAgo == null ? null : new Date(Date.now() - o.ackedAgo)],
      );
    }
    return { plain, conditional, recommendationId, escalationId };
  }

  const status = async (pid: string) => (await owner(`SELECT status FROM "Prediction" WHERE id = $1`, [pid])).rows[0]?.status as string | undefined;
  const resolution = async (pid: string) =>
    (await owner(`SELECT outcome, "outcomeValue", "eventAt", "resolvedAt", "resolvedBy", evidence, brier FROM "Resolution" WHERE "predictionId" = $1`, [pid])).rows[0] as
      | { outcome: boolean | null; outcomeValue: number | null; eventAt: Date; resolvedAt: Date; resolvedBy: string; evidence: Record<string, unknown>; brier: number | null }
      | undefined;
  /** The sweep's audit entries, newest first: what each one says, whole. */
  const sweepAudits = async () => (await owner(`SELECT actor, context, kind, action, outcome, inputs, reasoning, "outcomeDetail", "correlationId" FROM "AuditEntry" WHERE action = 'ledger.sweep' ORDER BY seq DESC`)).rows;

  return { ...k, db, prediction, point, range, question, service, serviceKey, escalated, status, resolution, sweepAudits };
}
export type LedgerKit = Awaited<ReturnType<typeof ledgerKit>>;
