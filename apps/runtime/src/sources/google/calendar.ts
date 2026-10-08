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
 *  - The listing is mapped by the calendar core (../calendar/core.ts), which
 *    holds the rules both calendars keep: no outside text in the world model,
 *    Will's answer decides, times are instants, a gap never reads as "gone",
 *    and an item this source cannot read is set aside as a warning.
 *  - What leaves the listing is archived as it was last known, but only after
 *    a complete listing in which every item could be read. What the listing
 *    itself shows declined or cancelled, and what has ended, is archived
 *    whatever else the listing held.
 */
import { z } from 'zod';
import type { Endpoint } from '../../policy/egress.js';
import { lagOf, lagSeries, lastRunOf, mapEvents as mapCalendar, unlisted } from '../calendar/core.js';
import type { MetricObservation, RaisedEvent, Source, SourceObservation, SourceRun, SyncResult } from '../types.js';

export { localIdOf } from '../calendar/core.js';

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
const LABEL = 'google calendar';
const PAGE_SIZE = 250;
/** Only what is read below: descriptions, locations and links never leave Google. */
const FIELDS = 'items(id,status,summary,start,end,attendees(email,displayName,self,responseStatus,resource,organizer),organizer(self),eventType,updated,recurringEventId),nextPageToken';
/** Visible ASCII: anything else would make Headers throw an error that quotes the token. */
const TOKEN = /^[\x21-\x7E]{1,4096}$/;

const LAG_SERIES = lagSeries(SOURCE);

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

const Page = z.object({ items: z.array(z.unknown()).optional(), nextPageToken: z.string().max(4096).optional() }).passthrough();

/**
 * One listing's items as observations (commitments and deadlines, then the
 * people on Will's commitments), the upcoming events, and the items set aside:
 * the calendar core, as google_calendar. Pure.
 */
export function mapEvents(items: unknown[], ctx: { tz: string; now: Date }): { observations: SourceObservation[]; events: RaisedEvent[]; errors: string[]; gone: string[] } {
  return mapCalendar(items, { ...ctx, source: SOURCE, label: LABEL });
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
        // showDeleted: a cancelled event comes back as `cancelled` (known gone) instead of silently missing.
        singleEvents: 'true', orderBy: 'startTime', showDeleted: 'true', maxResults: String(PAGE_SIZE), fields: FIELDS,
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
        const left = await unlisted(r.known, new Set(observations.map((x) => x.key)), new Set(mapped.gone), { source: SOURCE, tz: o.tz, now: r.now });
        for (const u of left.unlisted) if (whole || !u.missing) observations.push(u.observation);
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
