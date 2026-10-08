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
 *  - A record Will asked Flint to forget is skipped before anything is
 *    written: no event, no text, so its id and state never come back.
 *  - P2.5: an observation's untrusted text (a calendar title) goes to
 *    EntityText, never into the world model or the event; a person is never
 *    applied here but offered to world.person.create (PersonGuard); a raised
 *    event may name its entity by kind and key, and is dropped when that
 *    entity is not active (a forgotten event raises nothing).
 *  - P2.6: a source with nothing to read yet says it is idle, and the run is
 *    not counted at all: no audit, no rollup, the cursor left as it was.
 */
import { createHash } from 'node:crypto';
import { redact, resolveTier } from '@flint/policy';
import type { Db } from '../db.js';
import { appendAudit } from '../governance/audit.js';
import { activePolicies } from '../governance/proposals.js';
import { applyObservation, stateHash, type Applied } from '../world/mapper.js';
import { markProcessed, recordEvent, recordFailure, refreshUndecided, type Enqueue, type EventIn } from '../events/record.js';
import { sourceTime, triageEligible } from '../triage/facts.js';
import { wellFormedDeep } from './text.js';
import { faultAt } from '../config.js';
import { offerPeople } from '../world/person-create.js';
import { clip } from './text.js';
import type { Known, RaisedEvent, Source, SourceObservation, SourceRun } from './types.js';
import type { Tx } from '../db.js';

/** Sources whose every observation is PERSONAL, whatever the adapter says (Will's calendars). */
const PERSONAL_SOURCES: ReadonlySet<string> = new Set(['google_calendar', 'apple_calendar']);

/** An idle run's reason (jobs.ts does not log it: nothing went wrong). */
export const IDLE = 'idle: nothing to read yet';

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
  // Nothing to read yet (P2.6): not a run at all. The cursor, lastOkAt and the circuit stay as they were.
  if (result.idle) return { ...summary, reason: IDLE };
  summary.ran = true;

  // The world as it already was: everything a source's first good run reports.
  const backfill = !cursor.lastOkAt;
  const people: SourceObservation[] = [];
  // What Will asked Flint to forget, from this source: skipped before an event is recorded (the mapper refuses it too).
  const forgotten = new Set((await db.suppressedKey.findMany({ where: { source: source.name }, select: { externalIdHash: true } })).map((k) => k.externalIdHash));
  for (const raw of result.observations) {
    // A person is never applied by a sync: it is offered to world.person.create below.
    if (raw.kind === 'person') {
      people.push(raw);
      continue;
    }
    // A NUL or half an emoji from outside would make the item unwritable on every run.
    // (The time is taken out first: a Date is not plain data; the text too: it never enters the world model.)
    const { changedAt, texts: rawTexts, ...rest } = raw;
    const o = wellFormedDeep({ ...rest, ...(PERSONAL_SOURCES.has(source.name) ? { sensitivity: 'personal' as const } : {}) });
    if (forgotten.has(createHash('sha256').update(o.externalId).digest('hex'))) {
      summary.skipped += 1;
      continue;
    }
    const texts = rawTexts ? wellFormedDeep(rawTexts) : undefined;
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
        if (!changes) {
          const applied = await applyObservation(tx, { ...o, source: source.name, actor: `sync:${source.name}`, observedAt: run.now });
          if (texts && applied !== 'skipped') await writeTexts(tx, o.kind, o.key, source.name, texts, run.now);
          return applied;
        }
        const id = await recordEvent(tx, event, run.now);
        const applied = await applyObservation(tx, { ...o, source: source.name, actor: `sync:${source.name}`, observedAt: run.now, ...(id ? { sourceEventId: id } : {}) });
        if (texts && applied !== 'skipped') await writeTexts(tx, o.kind, o.key, source.name, texts, run.now);
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

  // People, offered to world.person.create: never applied by the sync itself.
  if (people.length) {
    try {
      const offered = await offerPeople(db, people, run.now, tz, source.name);
      summary.updated += offered.updated;
      summary.unchanged += offered.unchanged;
      summary.created += offered.created;
      summary.skipped += offered.refused + offered.proposed;
    } catch (err) {
      summary.failed += 1;
      console.error(`[sync] ${source.name}: offering people failed: ${redact(err instanceof Error ? err.message : String(err)).slice(0, 300)}`);
    }
  }

  // Event-only sources: each event applied with its triage job; nothing enters the world model.
  for (const { current, ...raised } of result.events ?? []) {
    const e = await occurrence(db, source.name, await withEntity(db, raised));
    if (!e) {
      summary.skipped += 1;
      continue;
    }
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

  // Parts of the run that failed, and observations that did not apply, are this run's error. Items the
  // source set aside are said too (Will should see them) but are not a failure.
  const partErrors = (result.errors ?? []).map((e) => redact(e).slice(0, 300));
  const problems = [...partErrors, ...(summary.failed ? [`${summary.failed} observation(s) failed to apply`] : [])];
  const warnings = (result.warnings ?? []).map((e) => redact(e).slice(0, 300));
  summary.failed += partErrors.length;
  const said = [...problems, ...warnings];
  const lastError = said.length ? said.join('; ').slice(0, 500) : null;
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
  // A change in what the source says went wrong (items set aside, or that ending) is audited once, not every run.
  const changed = summary.created + summary.updated > 0 || summary.failed > 0 || (lastError ?? null) !== (cursor.lastError ?? null);
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

/**
 * A raised event that names its entity by kind and key (the calendar does not
 * know ids) carries its id instead. Undefined when that entity is not active:
 * a forgotten or vanished event raises nothing.
 */
async function withEntity(db: Db, e: Omit<RaisedEvent, 'current'>): Promise<Omit<RaisedEvent, 'current'> | undefined> {
  const { entityKind, entityKey, ...payload } = e.payload;
  if (entityKind === undefined && entityKey === undefined) return e;
  if (typeof entityKind !== 'string' || typeof entityKey !== 'string') return undefined;
  const found = await db.entity.findUnique({ where: { kind_key: { kind: entityKind, key: entityKey } }, select: { id: true, status: true } });
  if (found?.status !== 'active') return undefined;
  return { ...e, payload: { ...payload, entityId: found.id } };
}

/** Heads-ups (the calendar): one per occurrence of an event at a time. */
const UPCOMING: ReadonlySet<string> = new Set(['commitment.upcoming', 'deadline.upcoming']);
const AGAIN = /:r\d+$/;
/** How often one time is raised again after triage passed over it: a bound, never a loop. */
const MAX_AGAIN = 5;

/**
 * A heads-up's source names the event and its time (`upcoming:<id>:<when>`),
 * so the same time read again is the same event. An event moved away and back
 * again is a new occurrence of that old time (`...:r1`): Will hears the time
 * that holds now, not silence after the one before.
 */
async function occurrence(db: Db, source: string, e: Omit<RaisedEvent, 'current'> | undefined): Promise<Omit<RaisedEvent, 'current'> | undefined> {
  if (!e || !UPCOMING.has(e.type)) return e;
  const parts = e.sourceRef.split(':');
  if (parts.length < 3) return e;
  const event = `${parts[0]}:${parts[1]}:`;
  const last = await db.sourceEvent.findFirst({ where: { source, type: e.type, sourceRef: { startsWith: event } }, orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }], select: { sourceRef: true } });
  if (!last) return e;
  // The time last raised still holds: the same occurrence (a duplicate, or a refresh while undecided), unless
  // triage passed over it without telling Will (it had moved, or was decided late), when it is raised again.
  if (last.sourceRef.replace(AGAIN, '') === e.sourceRef) {
    const told = await db.triageDecision.findFirst({ where: { sourceEvent: { source, sourceRef: last.sourceRef } }, select: { action: true, ruleName: true } });
    const again = await db.sourceEvent.count({ where: { source, sourceRef: { startsWith: `${e.sourceRef}:r` } } });
    // Told (this time, or this very time before): the same occurrence; nothing to raise again.
    if (!told || told.action === 'escalate' || told.ruleName === 'calendar.upcoming.told' || again >= MAX_AGAIN) return { ...e, sourceRef: last.sourceRef };
    return { ...e, sourceRef: `${e.sourceRef}:r${again + 1}`.slice(0, 500) };
  }
  // It moved: a time not raised before is simply new; one raised before is raised again.
  if (!(await db.sourceEvent.count({ where: { source, sourceRef: e.sourceRef } }))) return e;
  const n = await db.sourceEvent.count({ where: { source, sourceRef: { startsWith: `${e.sourceRef}:r` } } });
  return { ...e, sourceRef: `${e.sourceRef}:r${n + 1}`.slice(0, 500) };
}

/** The entity's untrusted text, refreshed (or removed, when the source no longer has it). */
async function writeTexts(tx: Tx, kind: string, key: string, source: string, texts: { title?: string }, now: Date): Promise<void> {
  const e = await tx.entity.findUnique({ where: { kind_key: { kind, key } }, select: { id: true } });
  if (!e) return;
  const title = texts.title?.trim() ? clip(texts.title.trim(), 300) : undefined;
  if (!title) {
    await tx.entityText.deleteMany({ where: { entityId: e.id, field: 'title' } });
    return;
  }
  await tx.entityText.upsert({
    where: { entityId_field: { entityId: e.id, field: 'title' } },
    create: { entityId: e.id, field: 'title', text: title, source, tainted: true, observedAt: now },
    update: { text: title, source, observedAt: now },
  });
}
