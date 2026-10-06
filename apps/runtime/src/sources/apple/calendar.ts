/**
 * apple_calendar: Will's Apple Calendar, read-only (Machine plan P2.6): the
 * next 14 days of the calendars he chose, as commitments and deadlines, the
 * people on the ones he accepted, and an event for what is about to start.
 *
 *  - It reaches nothing (no endpoints). Flint Calendar, a helper on the Mac
 *    (apps/desktop-calendar), reads Apple Calendar through EventKit and pushes
 *    a snapshot to the runtime's own route; this source reads the one held in
 *    memory (./inbox.ts), every 5 minutes and as soon as a push arrives.
 *  - The snapshot goes through the calendar core (../calendar/core.ts) in
 *    Google's item shape (./wire.ts), so its rules are google_calendar's: no
 *    outside text in the world model, Will's answer decides, times are
 *    instants, items it cannot read are set aside as warnings.
 *  - A gap never reads as "gone". With no snapshot in the first 10 minutes after
 *    a restart, or after a push turned away because the source was not yet on
 *    (Will has just turned it on), the source is idle (not a failure, nothing
 *    touched). With none after that, or one over 15 minutes old, or calendar
 *    access off on the Mac, the run fails and says why, and nothing is archived.
 *  - A snapshot older than the one last applied is never applied (idle): the
 *    cursor keeps when that one was read, so a replay is refused after a
 *    restart too (and the route turns one away: restoreInbox).
 *  - An event the snapshot holds but this side cannot read is set aside as a
 *    warning, as an item Google lists that it cannot read is.
 *  - What left the snapshot is archived as it was last known only when the
 *    snapshot is complete, every item was read, Will's choice of calendars is
 *    the one the last good run saw, and either at most 5 (or at most half) of
 *    the events ahead would go, or the same ones have stayed missing for 12 runs
 *    and most of an hour (a local store being re-synced can be empty for a
 *    while). What the snapshot shows declined or cancelled, what has ended and
 *    what was renamed are archived whatever else held. A wrong archive is
 *    restored the next time the event is read.
 *  - Disconnected (state `revoked`, sent once by disconnect.sh): every event it
 *    has from this calendar is archived, and the cursor says so: until a live
 *    snapshot comes again, a run with none is idle, not a failure.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { lagOf, lagSeries, lastRunOf, mapEvents, unlisted, wallClock } from '../calendar/core.js';
import type { Db } from '../../db.js';
import type { MetricObservation, Source, SourceRun, SyncResult } from '../types.js';
import type { CalendarInbox } from './inbox.js';
import { toItems, type SetAside } from './wire.js';

const SOURCE = 'apple_calendar';
const LABEL = 'apple calendar';
/** No snapshot this long after the runtime started is idle, not a failure: the helper's next push is on its way. */
export const GRACE_MS = 10 * 60_000;
/** A snapshot older than this is no reading of the calendar now. */
export const STALE_MS = 15 * 60_000;
/** Archiving events missing from a snapshot: at most this many, or at most this share of those ahead... */
const MISSING_MAX = 5;
const MISSING_SHARE = 0.5;
/** ...or the same ones missing for this many runs, over at least this long. */
export const CONFIRM_RUNS = 12;
export const CONFIRM_MS = 55 * 60_000;

const LAG_SERIES = lagSeries(SOURCE);

const isZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};
const Opts = z.object({ tz: z.string().min(1).refine(isZone, 'not a time zone') });

/**
 * What the source keeps between runs: when it last read, the calendars it saw,
 * an unconfirmed mass absence, when the snapshot it last applied was read, and
 * whether that one said Flint Calendar was disconnected. States, digests and
 * times only.
 */
const Cursor = z.object({
  calendars: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  missing: z.object({ hash: z.string().regex(/^[0-9a-f]{64}$/), runs: z.number().int().min(1), since: z.string() }).optional(),
  generatedAt: z.string().optional(),
  revoked: z.literal(true).optional(),
}).passthrough();
function cursorOf(raw: string | null | undefined): z.infer<typeof Cursor> {
  try {
    const c = Cursor.safeParse(JSON.parse(raw ?? ''));
    return c.success ? c.data : {};
  } catch {
    return {};
  }
}

/** When the snapshot the source last applied was read (ms), from its cursor; undefined when none was. */
export function appliedAtOf(raw: string | null | undefined): number | undefined {
  const t = Date.parse(cursorOf(raw).generatedAt ?? '');
  return Number.isFinite(t) ? t : undefined;
}

/** Whether the snapshot the source last applied said Flint Calendar was disconnected (the cursor says so). */
export const revokedIn = (raw: string | null | undefined): boolean => cursorOf(raw).revoked === true;

/**
 * At startup (index.ts): the inbox turns away any snapshot as old as the one
 * the source last applied, as it would have before the restart.
 */
export async function restoreInbox(db: Pick<Db, 'sourceCursor'>, inbox: CalendarInbox): Promise<void> {
  const c = await db.sourceCursor.findUnique({ where: { source: 'apple_calendar' }, select: { cursor: true } });
  const at = appliedAtOf(c?.cursor);
  if (at !== undefined) inbox.restore(at);
}

/** The events set aside, said by index and schema path (never a value): at most 5, then how many more. */
function setAsideOf(list: SetAside[]): string[] {
  const out = list.slice(0, 5).map((x) => `${LABEL}: event ${x.index} of Flint Calendar's snapshot could not be read (${x.paths.join(', ')}); set aside`);
  if (list.length > 5) out.push(`${LABEL}: ${list.length - 5} more event(s) set aside`);
  return out;
}

export interface AppleCalendarOpts {
  /** Flint's zone: what "today" and an all-day event's day mean. */
  tz: string;
  /** Where the route holds what Flint Calendar pushed. */
  inbox: CalendarInbox;
}

export function appleCalendarSource(opts: AppleCalendarOpts): Source {
  const o = Opts.parse({ tz: opts.tz });
  const wall = wallClock(o.tz);
  /** "14:05" today, "2026-10-05 14:05" on another day: the time alone, in Flint's zone. */
  const since = (at: number, now: Date) => {
    const w = wall(new Date(at));
    return w.day === wall(now).day ? w.time : `${w.day} ${w.time}`;
  };
  return {
    name: 'apple_calendar',
    cadenceMs: 5 * 60_000,
    async run(r: SourceRun): Promise<SyncResult> {
      const now = r.now.getTime();
      const idle: SyncResult = { observations: [], metrics: [], idle: true };
      const prev = cursorOf(r.cursor?.cursor);
      const held = opts.inbox.latest(now);
      if (!held || now - held.generatedAt > STALE_MS) {
        // Disconnected in Flint Calendar (the last snapshot applied said so): nothing more comes until Will connects again.
        if (prev.revoked) return idle;
        const last = opts.inbox.lastAcceptedAt();
        if (last === undefined) {
          // Nothing since the runtime started. Idle for 10 minutes from then, or from a push turned away while the
          // source was not yet on (Will has just turned it on, and the helper's next push is on its way).
          const away = opts.inbox.lastTurnedAwayAt();
          const heard = Math.max(opts.inbox.startedAt, away ?? Number.NEGATIVE_INFINITY);
          if (now - heard < GRACE_MS) return idle;
          // A failure (counted toward the circuit), and nothing archived: a quiet helper is not an empty calendar.
          throw new Error(away !== undefined && away > opts.inbox.startedAt
            ? `apple calendar: Flint Calendar hasn't reported since ${since(away, r.now)}`
            : `apple calendar: Flint Calendar hasn't reported since the runtime started at ${since(opts.inbox.startedAt, r.now)}`);
        }
        throw new Error(`apple calendar: Flint Calendar hasn't reported since ${since(held?.generatedAt ?? last, r.now)}`);
      }
      // Older than the snapshot last applied (a replay; after a restart the inbox may not know): nothing applied.
      const applied = appliedAtOf(r.cursor?.cursor);
      if (applied !== undefined && held.generatedAt < applied) return idle;
      const s = held.snapshot;

      // Disconnected: every event Flint has from this calendar is archived, as it was last known.
      if (s.state === 'revoked') {
        const left = r.known ? await unlisted(r.known, new Set(), new Set(), { source: SOURCE, tz: o.tz, now: r.now }) : undefined;
        return {
          observations: (left?.unlisted ?? []).map((u) => u.observation), metrics: [],
          cursor: JSON.stringify({ lastRunAt: r.now.toISOString(), generatedAt: s.generatedAt, revoked: true }),
        };
      }
      if (s.access !== 'full') throw new Error('apple calendar: Calendar access is off: System Settings > Privacy & Security > Calendars > Flint Calendar');

      const items = toItems(s);
      const mapped = mapEvents(items, { tz: o.tz, now: r.now, source: SOURCE, label: LABEL });
      const observations = [...mapped.observations];
      // Set aside, not failed: reported as the source's last error, never counted toward its circuit.
      const warnings = [...setAsideOf(s.setAside), ...mapped.errors];
      if (!s.complete) warnings.push('apple calendar: Flint Calendar sent only part of the next 14 days (over its limits); only what has ended is archived');
      if (s.calendars.count === 0) warnings.push('apple calendar: no calendars are chosen in Flint Calendar, or iCloud Calendar is off on this Mac; nothing missing is archived');
      const sameCalendars = prev.calendars === s.calendars.hash;
      if (prev.calendars !== undefined && !sameCalendars) warnings.push('apple calendar: the calendars Flint Calendar reads have changed; nothing missing is archived this run');

      // What is gone. A whole snapshot says it of what it no longer holds, within the guards above; any snapshot
      // says it of what it shows declined or cancelled, and the clock of what has ended. People are never archived here.
      let unconfirmed: { hash: string; runs: number; since: string } | undefined;
      if (r.known) {
        // Every event read: none set aside here, and none by the mapper.
        const whole = s.complete && s.setAside.length === 0 && mapped.errors.length === 0 && s.calendars.count > 0 && sameCalendars;
        const left = await unlisted(r.known, new Set(observations.map((x) => x.key)), new Set(mapped.gone), { source: SOURCE, tz: o.tz, now: r.now });
        const missing = left.unlisted.filter((u) => u.missing).map((u) => u.observation.key).sort();
        let archiveMissing = false;
        if (whole && missing.length) {
          const hash = createHash('sha256').update(missing.join('\n')).digest('hex');
          const again = prev.missing?.hash === hash ? prev.missing : undefined;
          const runs = (again?.runs ?? 0) + 1;
          const first = again && Number.isFinite(Date.parse(again.since)) ? Date.parse(again.since) : now;
          archiveMissing = missing.length <= MISSING_MAX || missing.length <= left.ahead * MISSING_SHARE || (runs >= CONFIRM_RUNS && now - first >= CONFIRM_MS);
          if (!archiveMissing) {
            unconfirmed = { hash, runs, since: new Date(first).toISOString() };
            warnings.push(`apple calendar: ${missing.length} of ${left.ahead} events ahead are missing from Flint Calendar's snapshot; they are archived only if they are still missing an hour after they went`);
          }
        }
        for (const u of left.unlisted) if (archiveMissing || !u.missing) observations.push(u.observation);
      }

      const lag = lagOf(items, lastRunOf(r.cursor?.cursor), now);
      const metrics: MetricObservation[] = lag === undefined ? [] : [{ series: LAG_SERIES, at: r.now, value: lag }];
      return {
        observations, metrics, events: mapped.events,
        cursor: JSON.stringify({ lastRunAt: r.now.toISOString(), generatedAt: s.generatedAt, calendars: s.calendars.hash, ...(unconfirmed ? { missing: unconfirmed } : {}) }),
        ...(warnings.length ? { warnings } : {}),
      };
    },
  };
}
