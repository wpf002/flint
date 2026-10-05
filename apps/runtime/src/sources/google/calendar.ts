/**
 * google_calendar: Will's primary Google Calendar, read-only, every 5 minutes
 * (Machine plan P2.5): the next 14 days of events as commitments and
 * deadlines, the people on the ones he accepted, and an event for what is
 * about to start.
 *
 *  - Auth: an OAuth access token from the injected accessToken (./oauth.ts
 *    holds the refresh token; this file never sees it). One endpoint, GET
 *    only, and only the fields read below are asked for.
 *  - All-or-nothing: any page that fails fails the run, so a half-read
 *    calendar is never applied and the source's lastOkAt never looks fresh.
 *  - No outside text in the world model: an event's title goes to EntityText
 *    (`texts.title`), never into a name, a key, the state or an event payload,
 *    which outlive it. Names are made from the time alone.
 *  - Will's answer decides: a declined event is not kept, and only the
 *    attendees of one he accepted or organized are reported as people (the
 *    sync engine hands those to PersonGuard, which decides).
 *  - Times are instants (UTC ISO). An all-day event spans its local days in
 *    tz, so a 23- or 25-hour day is exactly its length.
 *  - What leaves the listing (it ended, was declined, cancelled or deleted) is
 *    archived as it was last known, but only after a complete listing in which
 *    every item could be read: a gap must never read as "gone". What the
 *    listing itself shows declined or cancelled, and what has ended, is archived
 *    whatever else the listing held.
 *  - An item this source cannot read is set aside as a warning: it is reported
 *    (the source's last error) without counting as a failed run, so one odd
 *    invitation from outside can neither open the circuit nor stop the rest.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { localDayBounds } from '@flint/policy';
import type { Endpoint } from '../../policy/egress.js';
import { MEETS, emailHash, personExternalId, personKey } from '../../world/people.js';
import { clip, wellFormed } from '../text.js';
import type { MetricObservation, RaisedEvent, SeriesDef, Source, SourceObservation, SourceRun, SyncResult } from '../types.js';

export const GOOGLE_API = 'https://www.googleapis.com';
export const CALENDAR_EVENTS_PATH = '/calendar/v3/calendars/primary/events';
/** All this source may reach: the primary calendar's events, read. */
export const CALENDAR_ENDPOINTS: Endpoint[] = [{ origin: GOOGLE_API, pathPrefix: CALENDAR_EVENTS_PATH, methods: ['GET'] }];

export interface CalendarOpts {
  /** Flint's zone: what "today" and an all-day event's day mean. */
  tz: string;
  /** A current access token (./oauth.ts), fetched with this run's scoped fetch. */
  accessToken: (fetch: SourceRun['fetch'], now: Date) => Promise<string>;
  /** How far ahead to read; 14. */
  windowDays?: number;
  /** Pages of 250 to follow; 8. Past that the listing is incomplete and nothing is archived. */
  maxPages?: number;
}

const SOURCE = 'google_calendar';
const PAGE_SIZE = 250;
/** Only what is read below: descriptions, locations and links never leave Google. */
const FIELDS = 'items(id,status,summary,start,end,attendees(email,displayName,self,responseStatus,resource,organizer),organizer(self),eventType,updated,recurringEventId),nextPageToken';
/** Not commitments: where Will works from that day, and a contact's birthday. */
const SKIPPED_TYPES: ReadonlySet<unknown> = new Set(['workingLocation', 'birthday']);
/** A title that names a due date. ("submission" is its own word: `submit(?:ssion)` could never match it.) */
const DEADLINE_WORDS = /\b(deadline|due|submit(?:ted)?|submission|expires?|expiry|renew(?:al)?|last day)\b/i;
/** Started this recently, still upcoming: Will may be on his way. */
const UPCOMING_SINCE_MS = 15 * 60_000;
const UPCOMING_WITHIN_MS = 24 * 3_600_000;
/** Google's own event ids run to 1024 characters (an organizer may choose one; Exchange invitations and recurring instances are long). */
const EVENT_ID = /^[A-Za-z0-9_-]{1,1024}$/;
/** Ids longer than this are keyed by a digest, so keys and source refs stay short. */
const LOCAL_ID_MAX = 200;
/** Visible ASCII: anything else would make Headers throw an error that quotes the token. */
const TOKEN = /^[\x21-\x7E]{1,4096}$/;
const MAX_ERRORS = 10;

const LAG_SERIES: SeriesDef = {
  key: 'google_calendar.lag_ms', unit: 'ms', freq: 'raw', sensitivity: 'ops',
  description: 'how long a calendar change took to reach Flint (the longest this run)',
};

const isZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

const Opts = z.object({
  tz: z.string().min(1).refine(isZone, 'not a time zone'),
  windowDays: z.number().int().min(1).max(90).default(14),
  maxPages: z.number().int().min(1).max(40).default(8),
});

// ---- what Google sends (types checked on the fields read; anything else passes through unread) ----

/** RFC 3339 with an offset (Google always sends one): without it, Date would read the Mac's own zone. */
const instant = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i).refine((s) => Number.isFinite(Date.parse(s)));
/** A real calendar day: 2026-02-30 is not one. */
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => {
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
});
const When = z.object({ dateTime: instant.optional(), date: day.optional() }).passthrough();
const Attendee = z.object({
  email: z.string().optional(),
  displayName: z.string().optional(),
  self: z.boolean().optional(),
  responseStatus: z.string().optional(),
  resource: z.boolean().optional(),
}).passthrough();
const Item = z.object({
  id: z.string().regex(EVENT_ID),
  status: z.string().optional(),
  summary: z.string().optional(),
  start: When,
  end: When,
  attendees: z.array(Attendee).optional(),
  organizer: z.object({ self: z.boolean().optional() }).passthrough().optional(),
  eventType: z.string().optional(),
  updated: z.string().optional(),
  recurringEventId: z.string().optional(),
}).passthrough();
type Item = z.infer<typeof Item>;
const Page = z.object({ items: z.array(z.unknown()).optional(), nextPageToken: z.string().max(4096).optional() }).passthrough();
const Email = z.string().email().max(254);

type Answer = 'accepted' | 'tentative' | 'needs_action' | 'organizer';

// ---- small pure helpers ------------------------------------------------------------------

/** The wall clock in tz: an instant's local day (YYYY-MM-DD) and time (HH:mm, 24 h). */
function wallClock(tz: string): (at: Date) => { day: string; time: string } {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return (at) => {
    const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, x.value]));
    return { day: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
  };
}

/** The day after (or before) a YYYY-MM-DD day. */
const shiftDay = (d: string, by: number) => {
  const [y, m, n] = d.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, n + by)).toISOString().slice(0, 10);
};
const nextDay = (d: string) => shiftDay(d, 1);
const previousDay = (d: string) => shiftDay(d, -1);

/** An event's span as instants, or why it has none. Google's all-day end date is the day after the last. */
function spanOf(it: Item, tz: string): { startsAt: string; endsAt: string; allDay: boolean } | string {
  if (it.start.date) {
    if (!it.end.date) return 'an all-day start without an all-day end';
    if (it.end.date <= it.start.date) return 'ends before it starts';
    return { startsAt: localDayBounds(tz, it.start.date).start.toISOString(), endsAt: localDayBounds(tz, it.end.date).start.toISOString(), allDay: true };
  }
  if (!it.start.dateTime || !it.end.dateTime) return 'no start or end time';
  const s = new Date(it.start.dateTime);
  const e = new Date(it.end.dateTime);
  if (e < s) return 'ends before it starts';
  return { startsAt: s.toISOString(), endsAt: e.toISOString(), allDay: false };
}

/** Will's answer: his own attendee entry; without one, an event he made (or one nobody else is on) is his. */
function responseOf(it: Item): Answer | 'declined' {
  const attendees = it.attendees ?? [];
  const self = attendees.find((a) => a.self === true);
  if (self) {
    const s = self.responseStatus;
    return s === 'declined' ? 'declined' : s === 'accepted' ? 'accepted' : s === 'tentative' ? 'tentative' : 'needs_action';
  }
  return it.organizer?.self === true || attendees.length === 0 ? 'organizer' : 'needs_action';
}

/** Everyone else on the event with a usable address (trimmed, lowercased): never Will, never a room. */
function othersOf(it: Item): Array<{ email: string; hash: string; displayName: string | undefined }> {
  return (it.attendees ?? []).flatMap((a) => {
    if (a.self === true || a.resource === true || a.email === undefined) return [];
    const email = a.email.trim().toLowerCase();
    return Email.safeParse(email).success ? [{ email, hash: emailHash(email), displayName: a.displayName }] : [];
  });
}

/** The id Flint keys an event by: Google's own, or for a very long one a stable digest of it. */
export const localIdOf = (id: string) => (id.length <= LOCAL_ID_MAX ? id : `h-${createHash('sha256').update(id).digest('hex')}`);

/** A display name fit to be a person's name: no control or format characters (a ZWJ, a bidi mark, a newline). */
const cleanName = (s: string) => wellFormed(s).replace(/\p{Cc}+/gu, ' ').replace(/\p{Cf}/gu, '').replace(/\s+/g, ' ').trim();

/** Which checked fields an item failed on: our schema's names only, never its values. */
const fieldsOf = (e: z.ZodError) => [...new Set(e.issues.map((i) => i.path.join('.') || 'item'))].slice(0, 5).join(', ');

// ---- mapping -----------------------------------------------------------------------------

/**
 * One listing's items as observations (commitments and deadlines, then the
 * people on Will's commitments, so a person's commitment is applied before
 * PersonGuard looks for it), the upcoming events, and the items set aside.
 * Pure: the same items, zone and time give the same result.
 */
export function mapEvents(items: unknown[], ctx: { tz: string; now: Date }): { observations: SourceObservation[]; events: RaisedEvent[]; errors: string[]; gone: string[] } {
  const wall = wallClock(ctx.tz);
  const zoneName = new Intl.DateTimeFormat('en-US', { timeZone: ctx.tz, timeZoneName: 'short' });
  const now = ctx.now.getTime();
  const today = wall(ctx.now).day;
  const tomorrow = nextDay(today);
  const dayOf = (d: string): 'today' | 'tomorrow' | undefined => (d === today ? 'today' : d === tomorrow ? 'tomorrow' : undefined);
  /** "event 2026-10-05 14:00"; in the hour a fall-back repeats, with the zone (01:30 CDT, 01:30 CST) so the two differ. */
  const nameAt = (at: Date) => {
    const w = wall(at);
    const label = `${w.day} ${w.time}`;
    // Every zone Flint runs in moves its clocks by an hour.
    const repeated = [-3_600_000, 3_600_000].some((d) => {
      const o = wall(new Date(at.getTime() + d));
      return `${o.day} ${o.time}` === label;
    });
    const zone = repeated ? zoneName.formatToParts(at).find((p) => p.type === 'timeZoneName')?.value : undefined;
    return `event ${label}${zone ? ` ${zone}` : ''}`;
  };
  const upcoming = (sourceRef: string, type: string, payload: RaisedEvent['payload']): RaisedEvent => ({
    // Seen soon now: a condition that holds while the event is near, so it is current (refreshed each run until decided).
    sourceRef, type, occurredAt: ctx.now, sensitivity: 'personal', tainted: false, current: true, payload,
  });

  const entities: SourceObservation[] = [];
  const people = new Map<string, SourceObservation>();
  const events: RaisedEvent[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  /** Events the listing itself shows as no longer Will's (declined, cancelled), by local id. */
  const gone = new Set<string>();

  items.forEach((raw, i) => {
    if (!raw || typeof raw !== 'object') {
      errors.push(`google calendar: item ${i} is not an event; set aside`);
      return;
    }
    // Checked before the shape: a cancelled instance of a recurring event comes without a start or end.
    const head = raw as { id?: unknown; status?: unknown; eventType?: unknown };
    if (head.status === 'cancelled') {
      if (typeof head.id === 'string' && EVENT_ID.test(head.id)) gone.add(localIdOf(head.id));
      return;
    }
    if (SKIPPED_TYPES.has(head.eventType)) return;
    const parsed = Item.safeParse(raw);
    if (!parsed.success) {
      errors.push(`google calendar: item ${i} is not an event this source can read (${fieldsOf(parsed.error)}); set aside`);
      return;
    }
    const it = parsed.data;
    const id = localIdOf(it.id);
    if (seen.has(id)) return;
    seen.add(id);
    const response = responseOf(it);
    if (response === 'declined') {
      gone.add(id);
      return;
    }
    const span = spanOf(it, ctx.tz);
    if (typeof span === 'string') {
      errors.push(`google calendar: event ${id}: ${span}; set aside`);
      return;
    }

    const title = it.summary ?? '';
    // Always sent for a listed event: a title removed at Google is removed here too (an empty one deletes it).
    const texts = { texts: { title: title.trim() ? clip(wellFormed(title), 300) : '' } };
    const changedAt = it.updated && Number.isFinite(Date.parse(it.updated)) ? { changedAt: it.updated } : {};
    const start = new Date(span.startsAt);

    if (DEADLINE_WORDS.test(title) || (!span.allDay && span.startsAt === span.endsAt)) {
      // Due on the span's last day (an all-day end is the day after it; a timed one ends just before its end instant).
      const dueOn = span.allDay ? previousDay(it.end.date!) : span.startsAt === span.endsAt ? wall(start).day : wall(new Date(Date.parse(span.endsAt) - 1)).day;
      const key = `deadline:${SOURCE}:${id}`;
      entities.push({
        type: 'deadline.state', kind: 'deadline', key, externalId: `deadline:${id}`, name: `deadline ${dueOn}`,
        state: { dueOn, source: SOURCE }, sensitivity: 'personal', taintedPaths: [], ...changedAt, ...texts,
      });
      // The day and time are worked out again when triage decides (the note says them then, from the entity).
      if (dayOf(dueOn)) events.push(upcoming(`upcoming:${id}:${dueOn}`, 'deadline.upcoming', { entityKind: 'deadline', entityKey: key }));
      return;
    }

    const others = othersOf(it);
    // Attendees are kept (as hashes) only on events Will accepted or organized: PersonGuard reads no others.
    const hashes = MEETS.has(response) ? [...new Set(others.map((o) => o.hash))].sort().slice(0, 200) : [];
    const key = `commitment:${SOURCE}:${id}`;
    entities.push({
      type: 'commitment.state', kind: 'commitment', key, externalId: `event:${id}`,
      name: span.allDay ? `event ${it.start.date} (all day)` : nameAt(start),
      state: {
        source: SOURCE, startsAt: span.startsAt, endsAt: span.endsAt, allDay: span.allDay, response,
        eventStatus: it.status === 'tentative' ? 'tentative' : 'confirmed',
        confirmation: 'confirmed',
        ...(it.recurringEventId ? { recurring: true } : {}),
        ...(hashes.length ? { attendeeHashes: hashes } : {}),
      },
      sensitivity: 'personal', taintedPaths: [], ...changedAt, ...texts,
    });

    if (MEETS.has(response)) {
      for (const o of others) {
        if (people.has(o.hash)) continue;
        people.set(o.hash, {
          type: 'person.seen', kind: 'person', key: personKey(o.hash), externalId: personExternalId(o.hash),
          // The name the invitation carried (without control or format characters), else the address: tainted either way.
          name: clip(cleanName(o.displayName ?? ''), 100).trim() || o.email,
          state: { source: SOURCE, email: o.email, emailHash: o.hash }, sensitivity: 'personal', taintedPaths: ['name', 'state.email'],
        });
      }
    }

    const t = start.getTime();
    if (response !== 'needs_action' && t > now - UPCOMING_SINCE_MS && t <= now + UPCOMING_WITHIN_MS) {
      events.push(upcoming(`upcoming:${id}:${span.startsAt}`, 'commitment.upcoming', { entityKind: 'commitment', entityKey: key }));
    }
  });

  if (errors.length > MAX_ERRORS) errors.splice(MAX_ERRORS, errors.length - MAX_ERRORS, `google calendar: ${errors.length - MAX_ERRORS} more item(s) set aside`);
  return { observations: [...entities, ...people.values()], events, errors, gone: [...gone] };
}

// ---- the cursor --------------------------------------------------------------------------

/** When the last good run read the calendar (ms), from {"lastRunAt": ISO}; anything else is no cursor. */
function lastRunOf(raw: string | undefined): number | undefined {
  try {
    const c = JSON.parse(raw ?? '') as { lastRunAt?: unknown } | null;
    const t = typeof c?.lastRunAt === 'string' ? Date.parse(c.lastRunAt) : NaN;
    return Number.isFinite(t) ? t : undefined;
  } catch {
    return undefined;
  }
}

/** The longest a change made since the last run took to arrive (ms, floored at 0), or undefined when none was. */
function lagOf(items: unknown[], since: number | undefined, now: number): number | undefined {
  if (since === undefined) return undefined;
  let lag: number | undefined;
  for (const raw of items) {
    const u = (raw as { updated?: unknown } | null)?.updated;
    const t = typeof u === 'string' ? Date.parse(u) : NaN;
    if (Number.isFinite(t) && t > since) lag = Math.max(lag ?? 0, now - t, 0);
  }
  return lag;
}

// ---- the source --------------------------------------------------------------------------

export function googleCalendarSource(opts: CalendarOpts): Source {
  const o = Opts.parse({ tz: opts.tz, windowDays: opts.windowDays, maxPages: opts.maxPages });
  return {
    name: 'google_calendar',
    cadenceMs: 5 * 60_000,
    async run(r: SourceRun): Promise<SyncResult> {
      const token = await opts.accessToken(r.fetch, r.now);
      if (typeof token !== 'string' || !TOKEN.test(token)) throw new Error('google calendar: the access token is not usable');

      const query = {
        timeMin: r.now.toISOString(),
        timeMax: new Date(r.now.getTime() + o.windowDays * 86_400_000).toISOString(),
        singleEvents: 'true', orderBy: 'startTime', showDeleted: 'false', maxResults: String(PAGE_SIZE), fields: FIELDS,
      };
      const items: unknown[] = [];
      let pageToken: string | undefined;
      let pages = 0;
      do {
        const q = new URLSearchParams(pageToken ? { ...query, pageToken } : query);
        const res = await r.fetch(`${GOOGLE_API}${CALENDAR_EVENTS_PATH}?${q}`, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
          signal: r.signal,
        });
        if (!res.ok) throw new Error(`google calendar answered ${res.status}`);
        const page = Page.safeParse(await res.json().catch(() => undefined));
        if (!page.success) throw new Error('google calendar: not an events page');
        items.push(...(page.data.items ?? []));
        pageToken = page.data.nextPageToken || undefined;
        pages += 1;
      } while (pageToken && pages < o.maxPages);
      const complete = !pageToken;

      const mapped = mapEvents(items, { tz: o.tz, now: r.now });
      const observations = [...mapped.observations];
      // Set aside, not failed: reported as the source's last error, never counted toward its circuit.
      const warnings = [...mapped.errors];
      if (!complete) warnings.push(`google calendar: more than ${o.maxPages * PAGE_SIZE} events in the next ${o.windowDays} days; the rest are not read and only what has ended is archived`);

      // What is gone. A whole, readable listing says it of anything not in it; any listing says it of what it
      // shows declined or cancelled, and the clock says it of what has ended. People are never archived here.
      if (r.known) {
        const whole = complete && mapped.errors.length === 0;
        const listed = new Set(observations.map((x) => x.key));
        const gone = new Set(mapped.gone);
        const today = wallClock(o.tz)(r.now).day;
        for (const kind of ['commitment', 'deadline'] as const) {
          const prefix = `${kind}:${SOURCE}:`;
          for (const k of await r.known(kind)) {
            if (!k.key.startsWith(prefix) || listed.has(k.key)) continue;
            const id = k.key.slice(prefix.length);
            if (!EVENT_ID.test(id)) continue;
            const ended = kind === 'commitment' ? typeof k.state.endsAt === 'string' && Date.parse(k.state.endsAt) <= r.now.getTime() : typeof k.state.dueOn === 'string' && k.state.dueOn < today;
            if (!whole && !gone.has(id) && !ended) continue;
            observations.push({
              type: `${kind}.state`, kind, key: k.key, name: k.name, state: k.state, status: 'archived',
              externalId: `${kind === 'commitment' ? 'event' : 'deadline'}:${id}`, sensitivity: 'personal', taintedPaths: [],
            });
          }
        }
      }

      const lag = lagOf(items, lastRunOf(r.cursor?.cursor), r.now.getTime());
      const metrics: MetricObservation[] = lag === undefined ? [] : [{ series: LAG_SERIES, at: r.now, value: lag }];
      return {
        observations, metrics, events: mapped.events, cursor: JSON.stringify({ lastRunAt: r.now.toISOString() }),
        ...(warnings.length ? { warnings } : {}),
      };
    },
  };
}
