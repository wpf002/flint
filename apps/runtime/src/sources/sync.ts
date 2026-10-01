/**
 * Running one source once (plan P1): the tier engine first, then the source,
 * then each observation into the world model through the SourceEvent inbox.
 *
 *  - A source runs only while its cursor is enabled, and turning it on needs an
 *    approved world.source.enable proposal (the database enforces that). That
 *    is the standing approval world.sync.<source> runs under at APPROVAL tier.
 *  - Each observation is a SourceEvent keyed by `<externalId>@<state hash>`, so
 *    a restart or a repeat never duplicates an event (exit criterion 4).
 *  - Metrics are written only when the value changed since the last point.
 *  - Runs that changed something, and failures, are audit entries; runs that
 *    changed nothing are counted in AuditRollup, so the audit trail stays
 *    readable (plan 3.0.7).
 */
import { Prisma } from '@prisma/client';
import { digestOf, redact, resolveTier } from '@flint/policy';
import type { Db } from '../db.js';
import { appendAudit } from '../governance/audit.js';
import { activePolicies } from '../governance/proposals.js';
import { applyObservation, stateHash, type Applied } from '../world/mapper.js';
import type { Source, SourceRun } from './types.js';

export interface SyncSummary {
  source: string;
  ran: boolean;
  reason?: string;
  created: number;
  updated: number;
  unchanged: number;
  skipped: number;
  failed: number;
  metrics: number;
}

const localDay = (tz: string, at: Date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);

export async function syncOnce(db: Db, source: Source, run: Omit<SourceRun, 'cursor'>, tz: string): Promise<SyncSummary> {
  const action = `world.sync.${source.name}`;
  const summary: SyncSummary = { source: source.name, ran: false, created: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0, metrics: 0 };
  const tier = resolveTier(action, { context: 'autonomous', tainted: false, policies: await activePolicies(db, run.now), now: run.now });
  if (tier.tier === 'forbidden') return { ...summary, reason: `forbidden: ${tier.reason}` };
  const cursor = await db.sourceCursor.findUnique({ where: { source: source.name } });
  if (!cursor?.enabled) return { ...summary, reason: 'not enabled (needs an approved world.source.enable)' };

  let result;
  try {
    result = await source.run({ ...run, cursor: { cursor: cursor.cursor, etag: cursor.etag } });
  } catch (err) {
    const message = redact(err instanceof Error ? err.message : String(err)).slice(0, 500);
    await db.sourceCursor.update({ where: { source: source.name }, data: { lastError: message, consecutiveFailures: { increment: 1 } } });
    await appendAudit(db, [{ actor: `sync:${source.name}`, context: 'autonomous', kind: 'sync', action, tier: tier.tier, decision: 'act', outcome: 'failed', inputs: { source: source.name }, reasoning: message }], run.now);
    return { ...summary, ran: true, reason: message, failed: 1 };
  }
  summary.ran = true;

  for (const o of result.observations) {
    const hash = stateHash({ name: o.name, state: o.state, ...(o.status ? { status: o.status } : {}), taintedPaths: o.taintedPaths ?? [] });
    const sourceRef = `${o.externalId}@${hash}`.slice(0, 500);
    const tainted = (o.taintedPaths ?? []).length > 0;
    const payload = { kind: o.kind, key: o.key, name: o.name, state: o.state, status: o.status ?? 'active' };
    let outcome: Applied;
    try {
      outcome = await db.$transaction(async (tx) => {
        const inserted = await tx.sourceEvent.createMany({
          data: [{
            id: `se${run.now.getTime().toString(36)}${Math.random().toString(36).slice(2, 10)}`,
            source: source.name, sourceRef, type: o.type, occurredAt: run.now, sensitivity: o.sensitivity, tainted,
            payload: payload as Prisma.InputJsonObject, payloadHash: digestOf(payload),
          }],
          skipDuplicates: true,
        });
        const event = await tx.sourceEvent.findUniqueOrThrow({ where: { source_sourceRef: { source: source.name, sourceRef } } });
        const applied = await applyObservation(tx, {
          ...o, source: source.name, actor: `sync:${source.name}`, observedAt: run.now,
          ...(inserted.count ? { sourceEventId: event.id } : {}),
        });
        if (inserted.count) {
          await tx.sourceEvent.update({ where: { id: event.id }, data: { status: applied === 'skipped' ? 'ignored' : 'applied', processedAt: run.now, attempts: 1 } });
        }
        return applied;
      });
    } catch (err) {
      summary.failed += 1;
      await db.sourceEvent.updateMany({
        where: { source: source.name, sourceRef, status: 'received' },
        data: { status: 'failed', attempts: { increment: 1 }, lastError: redact(err instanceof Error ? err.message : String(err)).slice(0, 500) },
      });
      continue;
    }
    summary[outcome] += 1;
  }

  for (const m of result.metrics) {
    let entityId: string | null = null;
    if (m.series.entityKey) {
      entityId = (await db.entity.findUnique({ where: { kind_key: m.series.entityKey }, select: { id: true } }))?.id ?? null;
    }
    await db.metricSeries.upsert({
      where: { key: m.series.key },
      create: { key: m.series.key, entityId, unit: m.series.unit, freq: m.series.freq, sensitivity: m.series.sensitivity, description: m.series.description },
      update: {},
    });
    const last = await db.metricPoint.findFirst({ where: { seriesKey: m.series.key }, orderBy: { at: 'desc' } });
    // Latency is always recorded; a running total only when it moved.
    if (m.series.unit !== 'ms' && last && last.value === m.value) continue;
    await db.metricPoint.createMany({ data: [{ seriesKey: m.series.key, at: m.at, value: m.value }], skipDuplicates: true });
    summary.metrics += 1;
  }

  await db.sourceCursor.update({
    where: { source: source.name },
    data: {
      lastOkAt: run.now, lastError: null, consecutiveFailures: 0,
      ...(result.cursor !== undefined ? { cursor: result.cursor } : {}), ...(result.etag !== undefined ? { etag: result.etag } : {}),
    },
  });
  const changed = summary.created + summary.updated > 0 || summary.failed > 0;
  if (changed) {
    await appendAudit(db, [{
      actor: `sync:${source.name}`, context: 'autonomous', kind: 'sync', action, tier: tier.tier, decision: 'act', outcome: summary.failed ? 'failed' : 'ok',
      inputs: { created: summary.created, updated: summary.updated, unchanged: summary.unchanged, skipped: summary.skipped, failed: summary.failed, metrics: summary.metrics },
    }], run.now);
  } else {
    const day = localDay(tz, run.now);
    await db.auditRollup.upsert({
      where: { day_action_context: { day, action, context: 'autonomous' } },
      create: { day, action, context: 'autonomous', count: 1 },
      update: { count: { increment: 1 } },
    });
  }
  return summary;
}
