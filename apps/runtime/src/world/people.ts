/**
 * PersonGuard (Machine plan P2.5, Decision 17): the only people Flint knows
 * are the ones on calendar events Will accepted (or organized), by the name
 * and address the invitation carried. Never a mail sender, never a lookup,
 * never anyone else.
 *
 *  - People are keyed by a hash of their address, so the key, the source
 *    reference and the event inbox never hold the address itself.
 *  - A candidate is allowed only when an active google_calendar commitment
 *    Will accepted or organized lists that hash among its attendees; the
 *    executor checks this again when it runs, whatever the proposal says.
 *  - The database checks it a third time: a person entity must come from
 *    google_calendar (migration p25_google).
 */
import { createHash } from 'node:crypto';

/** sha256 of an address, trimmed and lowercased. */
export function emailHash(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
}

/** The answers that make an event Will's commitment, and so its attendees people he meets. */
export const MEETS: ReadonlySet<string> = new Set(['accepted', 'organizer']);

export const personKey = (hash: string) => `person:google_calendar:${hash}`;
export const personExternalId = (hash: string) => `person:${hash}`;
