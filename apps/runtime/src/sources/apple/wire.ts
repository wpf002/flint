/**
 * Flint Calendar's snapshot, wire v1 (Machine plan P2.6): what the helper on
 * the Mac (apps/desktop-calendar) pushes to POST
 * /v1/sources/apple_calendar/snapshot, checked strictly, then turned into the
 * calendar core's item shape (Google's), so both calendars map the same way.
 *
 *  - Strict: an unknown key anywhere is refused, and so is anything over a cap
 *    (1000 events, 100 attendees an event, a 300-character title). Over a cap,
 *    the helper cuts the list itself, the same way every time, and says
 *    `complete: false`; this side then archives only what has ended.
 *  - Ids are sha256 hex (the helper hashes Apple's own, so no Apple id or UID
 *    reaches Flint). Instants are UTC (Z). An all-day event is local days with
 *    an exclusive end, as Google's are.
 *  - Will's answer (`self`) is worked out on the Mac, where EventKit knows which
 *    attendee is him. Attendees come only with an event he organized or
 *    accepted; other people's answers never come at all; and there are no
 *    events unless access is full and the helper is live (`revoked`: sent once,
 *    when Will disconnects).
 *  - The calendars Will chose are a count and a digest of their ids: a change of
 *    choice is seen, and no calendar's name ever leaves the Mac.
 *  - A refusal names schema paths, never a value (zod's messages can quote
 *    what they were given).
 */
import { z } from 'zod';

const HEX64 = /^[0-9a-f]{64}$/;
/** Over 15 days is never a 14-day window. */
export const MAX_WINDOW_MS = 15 * 86_400_000;
export const MAX_EVENTS = 1000;
export const MAX_ATTENDEES = 100;

/** Text from the calendar: bounded, and never a NUL (Postgres refuses one). */
const text = (max: number, min = 0) => z.string().min(min).max(max).refine((s) => !s.includes('\u0000'), 'no NUL');
/** An instant in UTC, as the helper writes it: to the second or the millisecond, with Z. */
const At = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/)
  .refine((s) => {
    const t = Date.parse(s);
    return Number.isFinite(t) && new Date(t).toISOString().slice(0, 19) === s.slice(0, 19);
  }, 'a real instant');
/** A real calendar day: 2026-02-30 is not one. */
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => {
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
}, 'a real day');
const When = z.union([z.object({ at: At }).strict(), z.object({ day: Day }).strict()]);
type When = z.infer<typeof When>;

const isZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

/** Everyone else on an event Will organized or accepted: never Will himself, never their answer. */
const Attendee = z
  .object({
    name: text(100).optional(),
    // Checked as an address when it is mapped: one odd address is dropped there, not the whole snapshot.
    email: text(254, 1),
    kind: z.enum(['person', 'room', 'resource', 'group', 'unknown']),
  })
  .strict();

const MEETS = new Set(['organizer', 'accepted']);

const Event = z
  .object({
    id: z.string().regex(HEX64),
    recurring: z.boolean(),
    status: z.enum(['confirmed', 'tentative', 'cancelled']),
    title: text(300),
    start: When,
    end: When,
    modifiedAt: At.optional(),
    self: z.enum(['organizer', 'accepted', 'tentative', 'declined', 'needs_action']),
    attendees: z.array(Attendee).max(MAX_ATTENDEES).optional(),
  })
  .strict()
  .superRefine((e, ctx) => {
    if (e.attendees && !MEETS.has(e.self)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['attendees'], message: 'attendees come only with an event Will organized or accepted' });
    if (('at' in e.start) !== ('at' in e.end)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['end'], message: 'a start and an end of the same kind' });
    // A timed event may end as it starts (a deadline-like zero-length one); an all-day end is the day after the last.
    else if ('at' in e.start && 'at' in e.end ? Date.parse(e.end.at) < Date.parse(e.start.at) : 'day' in e.start && 'day' in e.end && e.end.day <= e.start.day) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['end'], message: 'ends before it starts' });
    }
  });

export const Snapshot = z
  .object({
    v: z.literal(1),
    generatedAt: At,
    access: z.enum(['full', 'denied', 'restricted', 'not_determined', 'write_only']),
    state: z.enum(['live', 'revoked']),
    window: z.object({ start: At, end: At }).strict(),
    /** The Mac's zone, as the helper read it (a zone name, nothing more). */
    tz: z.string().min(1).max(64).regex(/^[A-Za-z0-9_+/-]+$/).refine(isZone, 'a time zone'),
    complete: z.boolean(),
    calendars: z.object({ count: z.number().int().min(0).max(1000), hash: z.string().regex(HEX64) }).strict(),
    events: z.array(Event).max(MAX_EVENTS),
  })
  .strict()
  .superRefine((s, ctx) => {
    const span = Date.parse(s.window.end) - Date.parse(s.window.start);
    if (!(span > 0 && span <= MAX_WINDOW_MS)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['window'], message: 'a window of up to 15 days' });
    if (s.events.length && (s.access !== 'full' || s.state !== 'live')) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['events'], message: 'no events unless access is full and the helper is live' });
  });
export type Snapshot = z.infer<typeof Snapshot>;

/** A snapshot, or the schema paths it failed on (at most 5): never a value. */
export function parseSnapshot(raw: unknown): { ok: true; snapshot: Snapshot } | { ok: false; issues: string[] } {
  const r = Snapshot.safeParse(raw);
  if (r.success) return { ok: true, snapshot: r.data };
  return { ok: false, issues: [...new Set(r.error.issues.map((i) => i.path.join('.') || '(envelope)'))].slice(0, 5) };
}

// ---- into the calendar core's item shape --------------------------------------------------

/** Will's answer as Google words it on his own attendee entry. */
const RESPONSE = { accepted: 'accepted', tentative: 'tentative', declined: 'declined', needs_action: 'needsAction' } as const;
const when = (w: When) => ('at' in w ? { dateTime: w.at } : { date: w.day });

/**
 * The snapshot's events as the items the calendar core reads (Google's shape):
 * the title as `summary`; Will's answer as his own attendee entry, or, for an
 * event he organized, `organizer.self`; the others (only on one he organized
 * or accepted) with `resource` set for anything that is not a person, so a
 * room, a resource or a group is never one; `updated` from modifiedAt; and a
 * cancelled event as Google lists one, gone. Pure.
 */
export function toItems(s: Snapshot): Array<Record<string, unknown>> {
  return s.events.map((e) => {
    const updated = e.modifiedAt ? { updated: e.modifiedAt } : {};
    if (e.status === 'cancelled') return { id: e.id, status: 'cancelled', ...updated };
    const others = MEETS.has(e.self)
      ? (e.attendees ?? []).map((a) => ({ email: a.email, ...(a.name !== undefined ? { displayName: a.name } : {}), resource: a.kind !== 'person' }))
      : [];
    const me = e.self === 'organizer' ? [] : [{ self: true, responseStatus: RESPONSE[e.self] }];
    return {
      id: e.id, status: e.status, summary: e.title, start: when(e.start), end: when(e.end),
      organizer: { self: e.self === 'organizer' }, attendees: [...me, ...others],
      ...updated, ...(e.recurring ? { recurringEventId: e.id } : {}),
    };
  });
}
