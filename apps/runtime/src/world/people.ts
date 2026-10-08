/**
 * PersonGuard (Machine plan P2.5, Decision 17): the only people Flint knows
 * are the ones on calendar events Will accepted (or organized), by the name
 * and address the invitation carried. Never a mail sender, never a lookup,
 * never anyone else.
 *
 *  - People are keyed by a hash of their address, so the key, the source
 *    reference and the event inbox never hold the address itself.
 *  - A candidate is allowed only when an active commitment from the same
 *    calendar source, one Will accepted or organized, lists that hash among
 *    its attendees; the executor checks this again when it runs, whatever the
 *    proposal says.
 *  - The database checks it a third time: a person entity must come from a
 *    calendar source (migrations p25_google, p26_apple_calendar).
 *  - P2.6: two calendar sources, google_calendar and apple_calendar. A person
 *    is keyed per source (someone in both is two entities), and forgetting
 *    one forgets them under both: the other entity is forgotten too, and
 *    neither comes back (person-create.ts, and the forget trigger).
 */
import { createHash } from 'node:crypto';

/** sha256 of an address, trimmed and lowercased. */
export function emailHash(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
}

/** The answers that make an event Will's commitment, and so its attendees people he meets. */
export const MEETS: ReadonlySet<string> = new Set(['accepted', 'organizer']);

/** The sources a person may come from: Will's calendars, and nothing else. */
export const CALENDAR_SOURCES = ['google_calendar', 'apple_calendar'] as const;
export type CalendarSource = (typeof CALENDAR_SOURCES)[number];
export const isCalendarSource = (s: unknown): s is CalendarSource => (CALENDAR_SOURCES as readonly unknown[]).includes(s);

/** person:<source>:<hash>; Google's keys are what they were in P2.5. */
export const personKey = (hash: string, source: CalendarSource = 'google_calendar') => `person:${source}:${hash}`;
export const personExternalId = (hash: string) => `person:${hash}`;
