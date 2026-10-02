/**
 * What triage knows about an event before it decides anything (Machine plan
 * P2): whether it is triaged at all, and whether it is backfill.
 *
 *  - Every applied event is triaged, except measurements (a chat turn is
 *    counted, never decided on).
 *  - Backfill is an event from a source's first successful run (the world as
 *    it already was), or one that happened more than 24 h before Flint saw it
 *    (a source catching up, triage switched back on). It is logged to the
 *    quiet lane without judgement: old news is never news, and a first sync
 *    of a hundred open issues is not a hundred model calls.
 */
import type { Db } from '../db.js';
import type { EventFacts, FactsEntity } from './verdict.js';

export const BACKFILL_AGE_MS = 24 * 3_600_000;

/** Counted, never triaged (`source:type`). */
export const MEASUREMENTS: readonly string[] = ['server:chat.turn'];
const MEASURED: ReadonlySet<string> = new Set(MEASUREMENTS);

export function triageEligible(source: string, type: string, status: string): boolean {
  return status === 'applied' && !MEASURED.has(`${source}:${type}`);
}

export function isBackfill(e: { occurredAt: Date; receivedAt: Date; payload: unknown }): boolean {
  if (e.payload && typeof e.payload === 'object' && (e.payload as { backfill?: unknown }).backfill === true) return true;
  return e.receivedAt.getTime() - e.occurredAt.getTime() > BACKFILL_AGE_MS;
}

/**
 * A source's own time for a change, when it is believable: in the past (a
 * little clock skew allowed) and this century. Anything else is "now".
 */
export function sourceTime(at: string | Date | null | undefined, now: Date): Date {
  const t = at instanceof Date ? at.getTime() : typeof at === 'string' ? Date.parse(at) : NaN;
  if (!Number.isFinite(t) || t < Date.UTC(2000, 0, 1) || t > now.getTime() + 5 * 60_000) return now;
  return new Date(Math.min(t, now.getTime()));
}

/**
 * The facts of one applied event: the entity a sync's EntityVersion names, or
 * (for an event the runtime or server raised) the one in payload.entityId. A
 * forgotten entity is no entity. Undefined when the event is gone or was not
 * applied.
 */
export async function loadFacts(db: Db, eventId: string): Promise<EventFacts | undefined> {
  const ev = await db.sourceEvent.findUnique({ where: { id: eventId } });
  if (!ev || ev.status !== 'applied') return undefined;
  const payload = ev.payload && typeof ev.payload === 'object' && !Array.isArray(ev.payload) ? (ev.payload as Record<string, unknown>) : {};
  const version = await db.entityVersion.findFirst({ where: { sourceEventId: eventId }, orderBy: { version: 'desc' }, include: { entity: true } });
  const raisedFor = typeof payload.entityId === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(payload.entityId) ? payload.entityId : undefined;
  const e = version?.entity ?? (raisedFor ? await db.entity.findUnique({ where: { id: raisedFor } }) : null);
  const entity: FactsEntity | undefined =
    e && e.status !== 'forgotten'
      ? { id: e.id, kind: e.kind, key: e.key, name: e.name, state: (e.state ?? {}) as Record<string, unknown>, taintedPaths: e.taintedPaths, status: e.status }
      : undefined;
  return {
    eventId: ev.id,
    source: ev.source,
    type: ev.type,
    sensitivity: ev.sensitivity as EventFacts['sensitivity'],
    tainted: ev.tainted,
    occurredAt: ev.occurredAt,
    receivedAt: ev.receivedAt,
    payload,
    ...(entity ? { entity } : {}),
    created: version?.changeKind === 'created',
    backfill: isBackfill(ev),
  };
}
