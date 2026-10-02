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
 *  - P2: an event happened when the source says it changed (else now); the
 *    events of a source's first successful run are marked backfill; and with
 *    triage on, each applied event's triage job is sent in the transaction
 *    that applied it.
 */
import { redact, resolveTier } from '@flint/policy';
import type { Db } from '../db.js';
import { appendAudit } from '../governance/audit.js';
import { activePolicies } from '../governance/proposals.js';
import { applyObservation, stateHash, type Applied } from '../world/mapper.js';
import { markProcessed, recordEvent, recordFailure, refreshUndecided, type Enqueue, type EventIn } from '../events/record.js';
import { sourceTime, triageEligible } from '../triage/facts.js';
import { wellFormedDeep } from './text.js';
import { faultAt } from '../config.js';
import type { Known, Source, SourceRun } from './types.js';

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

export async function syncOnce(db: Db, source: Source, run: Omit<SourceRun, 'cursor'>, tz: string, enqueue?: Enqueue): Promise<SyncSummary> {
  const action = `world.sync.${source.name}`;
  const summary: SyncSummary = { source: source.name, ran: false, created: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0, metrics: 0 };
  const tier = resolveTier(action, { context: 'autonomous', tainted: false, policies: await activePolicies(db, run.now), now: run.now });
  if (tier.tier === 'forbidden') return { ...summary, reason: `forbidden: ${tier.reason}` };
  const cursor = await db.sourceCursor.findUnique({ where: { source: source.name } });
  if (!cursor?.enabled) return { ...summary, reason: 'not enabled (needs an approved world.source.enable)' };

  let result;
  try {
    const known = async (kind: string): Promise<Known[]> =>
      (await db.entity.findMany({ where: { kind, status: 'active', sources: { some: { source: source.name } } }, select: { key: true, name: true, state: true, taintedPaths: true }, take: 5000 }))
        .map((e) => ({ key: e.key, name: e.name, state: (e.state ?? {}) as Record<string, unknown>, taintedPaths: e.taintedPaths }));
    result = await source.run({ ...run, cursor: { cursor: cursor.cursor, etag: cursor.etag }, known });
  } catch (err) {
    const message = redact(err instanceof Error ? err.message : String(err)).slice(0, 500);
    await db.sourceCursor.update({ where: { source: source.name }, data: { lastError: message, consecutiveFailures: { increment: 1 } } });
    await appendAudit(db, [{ actor: `sync:${source.name}`, context: 'autonomous', kind: 'sync', action, tier: tier.tier, decision: 'act', outcome: 'failed', inputs: { source: source.name }, reasoning: message }], run.now);
    return { ...summary, ran: true, reason: message, failed: 1 };
  }
  summary.ran = true;

  // The world as it already was: everything a source's first good run reports.
  const backfill = !cursor.lastOkAt;
  for (const raw of result.observations) {
    // A NUL or half an emoji from outside would make the item unwritable on every run.
    // (The time is taken out first: a Date is not plain data.)
    const { changedAt, ...rest } = raw;
    const o = wellFormedDeep(rest);
    const hash = stateHash({ name: o.name, state: o.state, ...(o.status ? { status: o.status } : {}), taintedPaths: o.taintedPaths ?? [] });
    // The event names the change: the state, and the version it would replace.
    // The same observation again (a restart) is the same event; the same state
    // coming back later (down, ok, down) is a new one.
    const current = await db.entity.findUnique({ where: { kind_key: { kind: o.kind, key: o.key } }, select: { version: true, stateHash: true } });
    const changes = !current || current.stateHash !== hash;
    const event: EventIn = {
      source: source.name,
      sourceRef: `${o.externalId}@${hash}#${current?.version ?? 0}`.slice(0, 500),
      type: o.type,
      occurredAt: sourceTime(changedAt, run.now),
      sensitivity: o.sensitivity,
      tainted: (o.taintedPaths ?? []).length > 0,
      payload: { kind: o.kind, key: o.key, name: o.name, state: o.state, status: o.status ?? 'active', ...(backfill ? { backfill: true } : {}) },
    };
    let outcome: Applied;
    try {
      outcome = await db.$transaction(async (tx) => {
        // Nothing changed: no event, just "seen again".
        if (!changes) return applyObservation(tx, { ...o, source: source.name, actor: `sync:${source.name}`, observedAt: run.now });
        const id = await recordEvent(tx, event, run.now);
        const applied = await applyObservation(tx, { ...o, source: source.name, actor: `sync:${source.name}`, observedAt: run.now, ...(id ? { sourceEventId: id } : {}) });
        if (id) {
          const status = applied === 'skipped' ? 'ignored' : 'applied';
          await markProcessed(tx, id, status, run.now);
          if (enqueue && triageEligible(source.name, o.type, status)) await enqueue(tx, id);
        }
        return applied;
      });
    } catch (err) {
      summary.failed += 1;
      await recordFailure(db, event, err, run.now).catch(() => {});
      continue;
    }
    summary[outcome] += 1;
  }

  // Event-only sources: each event applied with its triage job; nothing enters the world model.
  for (const { current, ...e } of result.events ?? []) {
    const event: EventIn = { source: source.name, ...e, occurredAt: sourceTime(e.occurredAt, run.now) };
    try {
      const id = await db.$transaction(async (tx) => {
        const id = await recordEvent(tx, event, run.now);
        if (!id) {
          if (current) {
            const again = await refreshUndecided(tx, source.name, e.sourceRef, run.now, e.payload);
            if (again && enqueue && triageEligible(source.name, e.type, 'applied')) await enqueue(tx, again);
          }
          return null;
        }
        await markProcessed(tx, id, 'applied', run.now);
        if (enqueue && triageEligible(source.name, e.type, 'applied')) await enqueue(tx, id);
        return id;
      });
      if (id) {
        summary.created += 1;
        faultAt('after_event');
      } else summary.unchanged += 1;
    } catch (err) {
      summary.failed += 1;
      await recordFailure(db, event, err, run.now).catch(() => {});
    }
  }

  for (const m of result.metrics) {
    let entityId: string | null = null;
    if (m.series.entityKey) {
      const e = await db.entity.findUnique({ where: { kind_key: m.series.entityKey }, select: { id: true, status: true } });
      entityId = e?.id ?? null;
    }
    const existingSeries = await db.metricSeries.findUnique({ where: { key: m.series.key }, select: { description: true } });
    // A series whose entity was forgotten takes no more points.
    if (existingSeries?.description === '[forgotten]') continue;
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

  // Parts of the run that failed, and observations that did not apply, are this run's error.
  const partErrors = (result.errors ?? []).map((e) => redact(e).slice(0, 300));
  const problems = [...partErrors, ...(summary.failed ? [`${summary.failed} observation(s) failed to apply`] : [])];
  summary.failed += partErrors.length;
  const lastError = problems.length ? problems.join('; ').slice(0, 500) : null;
  if (lastError) summary.reason = lastError;
  await db.sourceCursor.update({
    where: { source: source.name },
    data: {
      lastOkAt: run.now, lastError, ...(problems.length ? { consecutiveFailures: { increment: 1 } } : { consecutiveFailures: 0 }),
      // The cursor moves only when every observation applied: otherwise a 304
      // next time would hide the change that failed, until something else changed.
      ...(summary.failed === partErrors.length
        ? { ...(result.cursor !== undefined ? { cursor: result.cursor } : {}), ...(result.etag !== undefined ? { etag: result.etag } : {}) }
        : {}),
    },
  });
  const changed = summary.created + summary.updated > 0 || summary.failed > 0;
  if (changed) {
    await appendAudit(db, [{
      actor: `sync:${source.name}`, context: 'autonomous', kind: 'sync', action, tier: tier.tier, decision: 'act', outcome: summary.failed ? 'failed' : 'ok',
      inputs: { created: summary.created, updated: summary.updated, unchanged: summary.unchanged, skipped: summary.skipped, failed: summary.failed, metrics: summary.metrics },
      ...(lastError ? { reasoning: lastError } : {}),
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
