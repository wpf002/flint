/**
 * Retention (plan 3.0.5), nightly at 03:10: what is cleared, and when.
 *
 *  | Data | ops | personal, financial or tainted |
 *  |---|---|---|
 *  | SourceEvent.payload | NULL at 30 d | NULL at 7 d |
 *  | SourceEvent row (none decided on) | deleted at 13 months | same |
 *  | Proposal args and result | NULL 30 d after it ended | 7 d |
 *  | Escalation text, TriageDecision.reasoning, Recommendation text | 90 d | 7 d |
 *  | HealthCheck, MetricPoint (raw) | daily rollup, then deleted after 30 whole days | same |
 *
 *  - A proposal ages from when it ended (executed, or its expiry: the latest
 *    a rejected one can have ended), never from when it was made.
 *  - A purged escalation keeps its template's field-free title.
 *  - Before raw points go, each day is rolled up into a daily (`D`) series:
 *    latencies averaged, running totals taken at the day's last point, and a
 *    component's health as the share of its checks that were ok.
 *
 * It clears and deletes, so it runs at APPROVAL on a nightly card until Will
 * promotes it (backup/nightly.ts), and every run is audited with counts only.
 */
import { Prisma } from '@prisma/client';
import { localDay, localDayBounds } from '@flint/policy';
import type { Db } from './db.js';
import { appendAudit } from './governance/audit.js';
import { TEMPLATE_IDS, fieldFreeTitle } from './templates/escalations.js';

const DAY = 86_400_000;
const ago = (days: number, now: Date) => new Date(now.getTime() - days * DAY);
const TERMINAL = ['executed', 'failed', 'rejected', 'expired'];

export async function runRetention(db: Db, tz: string, now = new Date(), correlationId?: string): Promise<Record<string, number>> {
  const n: Record<string, number> = {};
  const exec = (q: Prisma.Sql) => db.$executeRaw(q);

  n.eventPayloads = await exec(Prisma.sql`
    UPDATE "SourceEvent" SET payload = NULL
    WHERE payload IS NOT NULL AND (
      "receivedAt" < ${ago(30, now)} OR ("receivedAt" < ${ago(7, now)} AND (tainted OR sensitivity IN ('personal', 'financial'))))`);
  n.eventsDeleted = await exec(Prisma.sql`
    DELETE FROM "SourceEvent" e WHERE e."receivedAt" < ${ago(396, now)}
      AND NOT EXISTS (SELECT 1 FROM "TriageDecision" d WHERE d."sourceEventId" = e.id)`);
  n.proposalArgs = await exec(Prisma.sql`
    UPDATE "Proposal" SET args = NULL, result = NULL, "argsPurgedAt" = ${now}
    WHERE "argsPurgedAt" IS NULL AND args IS NOT NULL AND status IN (${Prisma.join(TERMINAL)}) AND (
      coalesce("executedAt", "expiresAt") < ${ago(30, now)}
      OR (coalesce("executedAt", "expiresAt") < ${ago(7, now)} AND (tainted OR sensitivity IN ('personal', 'financial'))))`);
  n.decisionReasoning = await exec(Prisma.sql`
    UPDATE "TriageDecision" SET reasoning = NULL
    WHERE reasoning IS NOT NULL AND ("createdAt" < ${ago(90, now)} OR ("createdAt" < ${ago(7, now)} AND (tainted OR sensitivity IN ('personal', 'financial'))))`);
  n.escalationText = 0;
  for (const id of [...TEMPLATE_IDS, 'unknown']) {
    n.escalationText += await exec(Prisma.sql`
      UPDATE "Escalation" SET title = ${fieldFreeTitle(id)}, body = NULL, fields = '{}'::jsonb, "contentPurgedAt" = ${now}
      WHERE "contentPurgedAt" IS NULL AND "templateId" = ${id}
        AND ("createdAt" < ${ago(90, now)} OR ("createdAt" < ${ago(7, now)} AND (tainted OR sensitivity IN ('personal', 'financial'))))`);
  }
  n.recommendationText = await exec(Prisma.sql`
    UPDATE "Recommendation" SET text = NULL, rationale = NULL, "expectedEffect" = NULL
    WHERE (text IS NOT NULL OR rationale IS NOT NULL OR "expectedEffect" IS NOT NULL)
      AND ("createdAt" < ${ago(90, now)} OR ("createdAt" < ${ago(7, now)} AND tainted))`);

  // Whole local days only: a day is rolled up once, never in two halves on two nights.
  const cutoff = localDayBounds(tz, localDay(tz, ago(30, now))).start;
  n.healthRolledUp = await rollupHealth(db, tz, cutoff);
  n.healthChecks = await exec(Prisma.sql`DELETE FROM "HealthCheck" WHERE at < ${cutoff}`);
  n.metricsRolledUp = await rollupMetrics(db, tz, cutoff);
  n.metricPoints = await exec(Prisma.sql`
    DELETE FROM "MetricPoint" p USING "MetricSeries" s WHERE p."seriesKey" = s.key AND s.freq = 'raw' AND p.at < ${cutoff}`);

  await appendAudit(db, [{ actor: 'runtime:retention', context: 'autonomous', kind: 'action', action: 'maintenance.retention', decision: 'act', outcome: 'ok', inputs: n, ...(correlationId ? { correlationId } : {}) }], now);
  return n;
}

/** The series key a component's daily health share goes in. */
export const healthSeries = (component: string) => `health.${component.replace(/[^a-z0-9_-]/g, '_').slice(0, 60)}.ok_share`;

/** Each component's local days before `cutoff`: the share of its checks that were ok. */
async function rollupHealth(db: Db, tz: string, cutoff: Date): Promise<number> {
  const days = await db.$queryRaw<Array<{ component: string; day: Date; share: number }>>`
    SELECT component, (date_trunc('day', at AT TIME ZONE ${tz}) AT TIME ZONE ${tz}) AS day,
           avg(CASE WHEN status = 'ok' THEN 1.0 ELSE 0.0 END)::float8 AS share
    FROM "HealthCheck" WHERE at < ${cutoff} AND status <> 'disabled'
    GROUP BY 1, 2`;
  for (const d of days) {
    const key = healthSeries(d.component);
    await db.metricSeries.upsert({ where: { key }, create: { key, unit: 'share', freq: 'D', sensitivity: 'ops', description: `share of ${d.component}'s health checks that were ok, per day` }, update: {} });
  }
  if (!days.length) return 0;
  return (await db.metricPoint.createMany({ data: days.map((d) => ({ seriesKey: healthSeries(d.component), at: d.day, value: d.share })), skipDuplicates: true })).count;
}

/** Each raw series' local days before `cutoff`, into `<key>.daily`: an average for latencies, the day's last point otherwise. */
async function rollupMetrics(db: Db, tz: string, cutoff: Date): Promise<number> {
  const days = await db.$queryRaw<Array<{ key: string; unit: string; day: Date; value: number }>>`
    SELECT s.key, s.unit, (date_trunc('day', p.at AT TIME ZONE ${tz}) AT TIME ZONE ${tz}) AS day,
           CASE WHEN s.unit = 'ms' THEN avg(p.value) ELSE (array_agg(p.value ORDER BY p.at DESC))[1] END::float8 AS value
    FROM "MetricPoint" p JOIN "MetricSeries" s ON s.key = p."seriesKey"
    WHERE s.freq = 'raw' AND p.at < ${cutoff} AND s.description <> '[forgotten]'
    GROUP BY 1, 2, 3`;
  const series = await db.metricSeries.findMany({ where: { key: { in: [...new Set(days.map((d) => d.key))] } } });
  for (const s of series) {
    await db.metricSeries.upsert({
      where: { key: `${s.key}.daily` },
      create: { key: `${s.key}.daily`, entityId: s.entityId, unit: s.unit, freq: 'D', sensitivity: s.sensitivity, description: `${s.description} (daily)`.slice(0, 300) },
      update: {},
    });
  }
  if (!days.length) return 0;
  return (await db.metricPoint.createMany({ data: days.map((d) => ({ seriesKey: `${d.key}.daily`, at: d.day, value: d.value })), skipDuplicates: true })).count;
}
