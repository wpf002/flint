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
