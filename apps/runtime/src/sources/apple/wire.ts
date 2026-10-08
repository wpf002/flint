/**
 * Flint Calendar's snapshot, wire v1 (Machine plan P2.6): what the helper on
 * the Mac (apps/desktop-calendar) pushes to POST
 * /v1/sources/apple_calendar/snapshot, checked, then turned into the calendar
 * core's item shape (Google's), so both calendars map the same way.
 *
 *  - The envelope is strict: an unknown key, or anything over a cap (1000
 *    events, 15 days), refuses the whole snapshot. Over a count cap (1000
 *    events, 100 attendees an event), the helper cuts the list itself, the
 *    same way every time, and says `complete: false`; this side then archives
 *    only what has ended.
 *  - Events are checked one at a time. One this side cannot read (an unknown
 *    key, an end before its start, too many attendees) is set aside, by its
 *    index and schema paths, and the rest are read: the source reports it as a
 *    warning, and a snapshot with anything set aside archives nothing missing.
 *  - What someone else wrote is clipped, never refused: a title to 300
 *    characters and an attendee's name to 100. An address over 254 characters
 *    is no address, and the mapper drops that attendee.
 *  - The body has a byte budget, MAX_BYTES (UTF-8, as sent; the route answers
 *    413 over it). A snapshot over it is cut by fitToBudget's rule (below,
 *    which the helper follows) and says `complete: false`.
 *  - Canonical form (the golden fixture, test/fixtures/apple-calendar-snapshot.json,
 *    which the helper's tests encode byte for byte): compact JSON, keys sorted,
 *    no trailing newline, and no escaped `/`. Swift's JSONEncoder needs
 *    `outputFormatting = [.sortedKeys, .withoutEscapingSlashes]` for that: by
 *    default it writes "America\/Chicago".
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
 *  - A refusal, and an event set aside, names schema paths, never a value
 *    (zod's messages can quote what they were given).
 */
import { z } from 'zod';
import { clip } from '../text.js';

const HEX64 = /^[0-9a-f]{64}$/;
/** Over 15 days is never a 14-day window. */
export const MAX_WINDOW_MS = 15 * 86_400_000;
export const MAX_EVENTS = 1000;
export const MAX_ATTENDEES = 100;
/**
 * The most a snapshot's body may be, in UTF-8 bytes as sent. The route reads
 * no more (413); the helper cuts a snapshot to fit (fitToBudget) and says
 * `complete: false`. The caps above allow far more than this (a thousand
 * events of a hundred attendees each is tens of megabytes), so the budget, not
 * the caps, is what bounds a body.
 */
export const MAX_BYTES = 2 * 1024 * 1024;
/** What someone else wrote is clipped to these (UTF-16 units, as the world kinds count). */
export const TITLE_MAX = 300;
export const NAME_MAX = 100;

const noNul = (s: string) => !s.includes('\u0000');
/** Text the helper writes: bounded, and never a NUL (Postgres refuses one). */
const text = (max: number, min = 0) => z.string().min(min).max(max).refine(noNul, 'no NUL');
/** Text someone else wrote (a title, a name): clipped to `max`, never refused for its length, and never a NUL. */
const outside = (max: number) => z.string().refine(noNul, 'no NUL').transform((s) => clip(s, max));
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
    name: outside(NAME_MAX).optional(),
    // Checked as an address when it is mapped (at most 254 characters, as an address is): one odd address is
    // dropped there, not its event. Its length is bounded by the body's budget.
    email: z.string().min(1).refine(noNul, 'no NUL'),
    kind: z.enum(['person', 'room', 'resource', 'group', 'unknown']),
  })
  .strict();

const MEETS = new Set(['organizer', 'accepted']);

const Event = z
  .object({
    id: z.string().regex(HEX64),
    recurring: z.boolean(),
    status: z.enum(['confirmed', 'tentative', 'cancelled']),
    title: outside(TITLE_MAX),
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

/** The envelope, strict; its events are checked one at a time (parseSnapshot). */
const Envelope = z
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
    events: z.array(z.unknown()).max(MAX_EVENTS),
  })
  .strict()
  .superRefine((s, ctx) => {
    const span = Date.parse(s.window.end) - Date.parse(s.window.start);
    if (!(span > 0 && span <= MAX_WINDOW_MS)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['window'], message: 'a window of up to 15 days' });
    if (s.events.length && (s.access !== 'full' || s.state !== 'live')) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['events'], message: 'no events unless access is full and the helper is live' });
  });

export type SnapshotEvent = z.infer<typeof Event>;
/** An event this side could not read: its index in the snapshot, and the schema paths it failed on (at most 5). */
export interface SetAside {
  index: number;
  paths: string[];
}
/** A snapshot as read: the events that could be read, and the ones set aside. */
export type Snapshot = Omit<z.infer<typeof Envelope>, 'events'> & { events: SnapshotEvent[]; setAside: SetAside[] };

/** At most 5 schema paths, never a value. */
const pathsOf = (e: z.ZodError, prefix = '') => [...new Set(e.issues.map((i) => [prefix, ...i.path].filter((x) => x !== '').join('.') || '(envelope)'))].slice(0, 5);

/** A snapshot (its unreadable events set aside), or the schema paths its envelope failed on (at most 5): never a value. */
export function parseSnapshot(raw: unknown): { ok: true; snapshot: Snapshot } | { ok: false; issues: string[] } {
  const r = Envelope.safeParse(raw);
  if (!r.success) return { ok: false, issues: pathsOf(r.error) };
  const events: SnapshotEvent[] = [];
  const setAside: SetAside[] = [];
  r.data.events.forEach((item, index) => {
    const e = Event.safeParse(item);
    if (e.success) events.push(e.data);
    else setAside.push({ index, paths: pathsOf(e.error, `events.${index}`) });
  });
  return { ok: true, snapshot: { ...r.data, events, setAside } };
}

// ---- the byte budget ------------------------------------------------------------------------

/** A snapshot as the helper builds it, before it is sent. */
export type WireSnapshot = Record<string, unknown> & { complete: boolean; events: Array<Record<string, unknown>> };

/** Its body's size: UTF-8 bytes of compact JSON (the same whatever the key order). */
export const bytesOf = (v: unknown): number => Buffer.byteLength(JSON.stringify(v), 'utf8');

/** An event's start as written: an instant, or a day (which sorts before the times on it). */
function startOf(e: Record<string, unknown>): string {
  const w = e.start as { at?: unknown; day?: unknown } | undefined;
  return typeof w?.at === 'string' ? w.at : typeof w?.day === 'string' ? w.day : '';
}
/** Plain character order (both are ASCII), so Swift's `<` on the same strings agrees. */
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** An event's place in the cut: by start, then id. */
const order = (a: Record<string, unknown>, b: Record<string, unknown>) => cmp(startOf(a), startOf(b)) || cmp(String(a.id ?? ''), String(b.id ?? ''));

/**
 * The helper's cut to the byte budget, written here so both sides test the
 * same rule. A snapshot that fits is sent as it is. One that does not says
 * `complete: false` and is cut the same way every time: the events are ranked
 * by start, then id, and from the last-ranked back, each event's attendees are
 * dropped (all of them, one event at a time) until it fits; if it still does
 * not, the last-ranked events themselves are dropped until it does. What is
 * left keeps its order. Pure.
 */
export function fitToBudget(s: WireSnapshot, budget = MAX_BYTES): WireSnapshot {
  if (bytesOf(s) <= budget) return s;
  const events = s.events.map((e) => ({ ...e }));
  // Last-ranked first.
  const cut = events.map((_, i) => i).sort((a, b) => order(events[b]!, events[a]!));
  const base = bytesOf({ ...s, complete: false, events: [] });
  const size = events.map(bytesOf);
  let kept = events.length;
  // The body is the envelope, each event, and a comma between two.
  let total = base + size.reduce((a, b) => a + b, 0) + Math.max(0, kept - 1);
  for (const i of cut) {
    if (total <= budget) break;
    if (!('attendees' in events[i]!)) continue;
    const { attendees: _dropped, ...rest } = events[i]!;
    events[i] = rest;
    const n = bytesOf(rest);
    total += n - size[i]!;
    size[i] = n;
  }
  const dropped = new Set<number>();
  for (const i of cut) {
    if (total <= budget) break;
    dropped.add(i);
    total -= size[i]! + (kept > 1 ? 1 : 0);
    kept -= 1;
  }
  return { ...s, complete: false, events: events.filter((_, i) => !dropped.has(i)) };
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
