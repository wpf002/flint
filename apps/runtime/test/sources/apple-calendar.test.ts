/**
 * The apple_calendar source (P2.6), pure: Flint Calendar's wire v1 checked
 * strictly (the golden fixture the Swift helper's tests encode byte for
 * byte), the snapshot turned into the calendar core's item shape, the same
 * mapping as google_calendar's under its own name, and the source's run: idle
 * while the helper has not pushed since a restart, a failure (never "gone")
 * when it stops or calendar access is off, the mass-archive guards, a
 * disconnect, and no title or address anywhere but EntityText and a person's
 * own row. No network, no database, no EventKit.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_ATTENDEES, MAX_EVENTS, parseSnapshot, toItems, type Snapshot } from '../../src/sources/apple/wire';
import { ACCEPT_EVERY_MS, CalendarInbox, HOLD_MS } from '../../src/sources/apple/inbox';
import { CONFIRM_MS, CONFIRM_RUNS, GRACE_MS, STALE_MS, appleCalendarSource } from '../../src/sources/apple/calendar';
import { mapEvents } from '../../src/sources/calendar/core';
import { mapEvents as mapGoogle } from '../../src/sources/google/calendar';
import { STATE } from '../../src/world/kinds';
import { emailHash, personExternalId, personKey } from '../../src/world/people';
import type { Known, SourceObservation, SourceRun, SyncResult } from '../../src/sources/types';

const TZ = 'America/Chicago';
/** 10:00 CDT on a Monday. */
const NOW = new Date('2026-10-05T15:00:00Z');
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const at = (ms: number, from = NOW) => new Date(from.getTime() + ms).toISOString();
const H = (s: string) => createHash('sha256').update(s).digest('hex');
const FIXTURE = join(__dirname, '..', 'fixtures', 'apple-calendar-snapshot.json');
const CALS = H('calendar-a\ncalendar-b');

type Ev = Record<string, unknown>;
/** One event as Flint Calendar sends it. */
const ev = (name: string, o: Ev = {}): Ev => ({
  id: H(name), recurring: false, status: 'confirmed', title: `Private title ${name}`,
  start: { at: '2026-10-07T19:00:00Z' }, end: { at: '2026-10-07T20:00:00Z' }, self: 'accepted', ...o,
});
/** A whole snapshot, read now. */
const snap = (events: Ev[], o: Ev = {}): Record<string, unknown> => ({
  v: 1, generatedAt: at(0), access: 'full', state: 'live', window: { start: at(0), end: at(14 * DAY) }, tz: TZ, complete: true,
  calendars: { count: 2, hash: CALS }, events, ...o,
});
const parsed = (raw: unknown): Snapshot => {
  const p = parseSnapshot(raw);
  if (!p.ok) throw new Error(`refused: ${p.issues.join(', ')}`);
  return p.snapshot;
};
const refused = (raw: unknown): string[] => {
  const p = parseSnapshot(raw);
  if (p.ok) throw new Error('accepted');
  return p.issues;
};

/** Every observation's state is one its kind accepts (the mapper would refuse anything else). */
function expectValid(obs: SourceObservation[]) {
  for (const o of obs) expect(STATE[o.kind]!.safeParse(o.state).success, `${o.key}: ${JSON.stringify(o.state)}`).toBe(true);
}
const apple = (items: unknown[], now = NOW) => {
  const r = mapEvents(items, { tz: TZ, now, source: 'apple_calendar', label: 'apple calendar' });
  expectValid(r.observations);
  return r;
};
const fromSnapshot = (raw: unknown, now = NOW) => apple(toItems(parsed(raw)), now);
const byKey = (obs: SourceObservation[], key: string) => obs.find((o) => o.key === key);
const commitment = (obs: SourceObservation[], name: string) => byKey(obs, `commitment:apple_calendar:${H(name)}`);
const persons = (obs: SourceObservation[]) => obs.filter((o) => o.kind === 'person');

describe('apple_calendar: the wire (v1)', () => {
  it('accepts the golden fixture, which is canonical: keys sorted, compact, as the helper encodes it', () => {
    const text = readFileSync(FIXTURE, 'utf8');
    const raw = JSON.parse(text) as unknown;
    const sortDeep = (v: unknown): unknown => (Array.isArray(v) ? v.map(sortDeep) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortDeep((v as Record<string, unknown>)[k])])) : v);
    expect(JSON.stringify(sortDeep(raw))).toBe(text);
    const s = parsed(raw);
    expect(s.events).toHaveLength(9);
    expect(s.calendars).toEqual({ count: 2, hash: CALS });
  });

  it('refuses unknown keys anywhere, and anything over a cap', () => {
    expect(refused(snap([], { extra: 1 }))).toEqual(['(envelope)']);
    expect(refused(snap([ev('a', { location: 'Room 4' })]))).toEqual(['events.0']);
    expect(refused(snap([ev('a', { attendees: [{ email: 'a@x.org', kind: 'person', status: 'accepted' }] })]))).toEqual(['events.0.attendees.0']);
    expect(refused(snap([], { window: { start: at(0), end: at(DAY), calendars: 1 } }))).toEqual(['window']);
    expect(refused(snap(Array.from({ length: MAX_EVENTS + 1 }, (_, i) => ev(`e${i}`))))).toEqual(['events']);
    expect(parseSnapshot(snap(Array.from({ length: MAX_EVENTS }, (_, i) => ev(`e${i}`)))).ok).toBe(true);
    const many = Array.from({ length: MAX_ATTENDEES + 1 }, (_, i) => ({ email: `p${i}@x.org`, kind: 'person' }));
    expect(refused(snap([ev('a', { attendees: many })]))).toEqual(['events.0.attendees']);
    expect(refused(snap([ev('a', { title: 'x'.repeat(301) })]))).toEqual(['events.0.title']);
    expect(refused(snap([ev('a', { attendees: [{ name: 'n'.repeat(101), email: 'a@x.org', kind: 'person' }] })]))).toEqual(['events.0.attendees.0.name']);
    expect(refused(snap([ev('a', { attendees: [{ email: `${'a'.repeat(250)}@x.org`, kind: 'person' }] })]))).toEqual(['events.0.attendees.0.email']);
  });

  it('refuses ids that are not sha256 hex, instants without Z, days that are not days, an end before its start', () => {
    /** A time is one of two shapes: the path names the field, or the shape it came closest to. */
    const atStart = (raw: unknown) => expect(refused(raw)[0]).toMatch(/^events\.0\.start(\.at|\.day)?$/);
    expect(refused(snap([ev('a', { id: 'ABC' })]))).toEqual(['events.0.id']);
    expect(refused(snap([ev('a', { id: H('x').toUpperCase() })]))).toEqual(['events.0.id']);
    atStart(snap([ev('a', { start: { at: '2026-10-07T14:00:00-05:00' } })]));
    atStart(snap([ev('a', { start: { at: '2026-10-07T14:00:00' } })]));
    expect(refused(snap([], { generatedAt: '2026-10-05T15:00:00+00:00' }))).toEqual(['generatedAt']);
    atStart(snap([ev('a', { start: { day: '2026-02-30' }, end: { day: '2026-03-01' } })]));
    atStart(snap([ev('a', { start: { at: '2026-02-30T10:00:00Z' }, end: { at: '2026-03-01T10:00:00Z' } })]));
    expect(refused(snap([ev('a', { start: { at: '2026-10-07T15:00:00Z' }, end: { at: '2026-10-07T14:00:00Z' } })]))).toEqual(['events.0.end']);
    // An all-day end is the day after the last: the same day is no span.
    expect(refused(snap([ev('a', { start: { day: '2026-10-07' }, end: { day: '2026-10-07' } })]))).toEqual(['events.0.end']);
    expect(refused(snap([ev('a', { start: { day: '2026-10-07' }, end: { at: '2026-10-08T05:00:00Z' } })]))).toEqual(['events.0.end']);
    atStart(snap([ev('a', { start: { day: '2026-10-07', at: '2026-10-07T05:00:00Z' } })]));
    // A zero-length timed event is a deadline-like one, not an error.
    expect(parseSnapshot(snap([ev('a', { start: { at: '2026-10-07T15:00:00Z' }, end: { at: '2026-10-07T15:00:00Z' } })])).ok).toBe(true);
  });

  it('refuses a window over 15 days, a zone that is not one, a NUL, and an envelope that is not v1', () => {
    expect(refused(snap([], { window: { start: at(0), end: at(15 * DAY + MIN) } }))).toEqual(['window']);
    expect(refused(snap([], { window: { start: at(0), end: at(0) } }))).toEqual(['window']);
    expect(parseSnapshot(snap([], { window: { start: at(0), end: at(15 * DAY) } })).ok).toBe(true);
    expect(refused(snap([], { tz: 'Mars/Olympus_Mons' }))).toEqual(['tz']);
    expect(refused(snap([], { tz: 'America/Chicago; rm' }))).toEqual(['tz']);
    expect(refused(snap([ev('a', { title: 'Lunch\u0000' })]))).toEqual(['events.0.title']);
    expect(refused(snap([], { v: 2 }))).toEqual(['v']);
    expect(refused('not a snapshot')).toEqual(['(envelope)']);
  });

  it("attendees only with an event Will organized or accepted; no events unless access is full and the helper is live", () => {
    const others = [{ email: 'ada@example.com', kind: 'person' }];
    for (const self of ['tentative', 'declined', 'needs_action']) expect(refused(snap([ev('a', { self, attendees: others })])), self).toEqual(['events.0.attendees']);
    for (const self of ['organizer', 'accepted']) expect(parseSnapshot(snap([ev('a', { self, attendees: others })])).ok, self).toBe(true);
    for (const access of ['denied', 'restricted', 'not_determined', 'write_only']) {
      expect(refused(snap([ev('a')], { access })), access).toEqual(['events']);
      expect(parseSnapshot(snap([], { access })).ok, access).toBe(true);
    }
    expect(refused(snap([ev('a')], { state: 'revoked' }))).toEqual(['events']);
    expect(parseSnapshot(snap([], { state: 'revoked' })).ok).toBe(true);
  });

  it('a refusal names schema paths, never what it was given', () => {
    const issues = refused(snap([ev('a', { self: 'CANARY-self', attendees: [{ email: 'canary@example.com', kind: 'CANARY-kind' }] })], { access: 'CANARY-access', extra: 'CANARY' }));
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.length).toBeLessThanOrEqual(5);
    expect(JSON.stringify(issues)).not.toMatch(/canary/i);
  });
});

describe('apple_calendar: into the calendar core', () => {
  it('Will organized it: a commitment, with the people on it and never a room, a resource or a group', () => {
    const r = fromSnapshot(snap([ev('o1', {
      self: 'organizer', modifiedAt: '2026-10-05T14:56:00Z',
      attendees: [
        { name: 'Ada Lovelace', email: ' Ada@Example.com ', kind: 'person' }, { name: 'Room 4', email: 'room-4@example.com', kind: 'room' },
        { email: 'proj@example.com', kind: 'resource' }, { name: 'Team', email: 'team@example.com', kind: 'group' }, { email: 'who@example.com', kind: 'unknown' },
        { email: 'not an address', kind: 'person' },
      ],
    })]));
    expect(r.errors).toEqual([]);
    expect(commitment(r.observations, 'o1')).toEqual({
      type: 'commitment.state', kind: 'commitment', key: `commitment:apple_calendar:${H('o1')}`, externalId: `event:${H('o1')}`, name: 'event 2026-10-07 14:00',
      state: {
        source: 'apple_calendar', startsAt: '2026-10-07T19:00:00.000Z', endsAt: '2026-10-07T20:00:00.000Z', allDay: false, response: 'organizer',
        eventStatus: 'confirmed', confirmation: 'confirmed', attendeeHashes: [emailHash('ada@example.com')],
      },
      sensitivity: 'personal', taintedPaths: [], changedAt: '2026-10-05T14:56:00Z', texts: { title: 'Private title o1' },
    });
    const h = emailHash('ada@example.com');
    expect(persons(r.observations)).toEqual([{
      type: 'person.seen', kind: 'person', key: personKey(h, 'apple_calendar'), externalId: personExternalId(h), name: 'Ada Lovelace',
      state: { source: 'apple_calendar', email: 'ada@example.com', emailHash: h }, sensitivity: 'personal', taintedPaths: ['name', 'state.email'],
    }]);
    expect(personKey(h, 'apple_calendar')).toBe(`person:apple_calendar:${h}`);
  });

  it("Will's answer: accepted keeps the others; tentative and not answered keep nobody; declined and cancelled are gone", () => {
    const r = fromSnapshot(snap([
      ev('a1', { self: 'accepted', recurring: true, attendees: [{ email: 'bo@example.com', kind: 'person' }] }),
      ev('t1', { self: 'tentative' }),
      ev('n1', { self: 'needs_action' }),
      ev('d1', { self: 'declined' }),
      ev('c1', { status: 'cancelled', self: 'accepted' }),
      ev('tt', { status: 'tentative', self: 'accepted' }),
    ]));
    expect(r.errors).toEqual([]);
    const answer = (n: string) => commitment(r.observations, n)?.state.response;
    expect(['a1', 't1', 'n1', 'tt'].map(answer)).toEqual(['accepted', 'tentative', 'needs_action', 'accepted']);
    expect(commitment(r.observations, 'a1')!.state).toMatchObject({ recurring: true, attendeeHashes: [emailHash('bo@example.com')] });
    expect(commitment(r.observations, 'tt')!.state.eventStatus).toBe('tentative');
    expect(commitment(r.observations, 't1')!.state).not.toHaveProperty('attendeeHashes');
    expect(commitment(r.observations, 'd1')).toBeUndefined();
    expect(commitment(r.observations, 'c1')).toBeUndefined();
    expect(r.gone.sort()).toEqual([H('d1'), H('c1')].sort());
    expect(persons(r.observations).map((p) => (p.state as { email: string }).email)).toEqual(['bo@example.com']);
  });

  it('all-day: local days with an exclusive end, a 25-hour day exactly its length; a due-date word is a deadline', () => {
    const r = fromSnapshot(snap([
      ev('ad', { title: 'Team offsite', self: 'organizer', start: { day: '2026-10-12' }, end: { day: '2026-10-14' } }),
      ev('fb', { title: 'Fall back', self: 'organizer', start: { day: '2026-11-01' }, end: { day: '2026-11-02' } }),
      ev('dl', { title: 'Passport renewal', self: 'organizer', start: { day: '2026-10-20' }, end: { day: '2026-10-21' } }),
      ev('z0', { title: 'Check in', self: 'organizer', start: { at: '2026-10-09T20:00:00Z' }, end: { at: '2026-10-09T20:00:00Z' } }),
    ], { window: { start: at(0), end: at(14 * DAY) } }), new Date('2026-10-05T15:00:00Z'));
    expect(r.errors).toEqual([]);
    expect(commitment(r.observations, 'ad')).toMatchObject({ name: 'event 2026-10-12 (all day)', state: { startsAt: '2026-10-12T05:00:00.000Z', endsAt: '2026-10-14T05:00:00.000Z', allDay: true } });
    const fb = commitment(r.observations, 'fb')!;
    expect(Date.parse(fb.state.endsAt as string) - Date.parse(fb.state.startsAt as string)).toBe(25 * HOUR);
    expect(byKey(r.observations, `deadline:apple_calendar:${H('dl')}`)).toMatchObject({ name: 'deadline 2026-10-20', state: { dueOn: '2026-10-20', source: 'apple_calendar' }, texts: { title: 'Passport renewal' } });
    expect(byKey(r.observations, `deadline:apple_calendar:${H('z0')}`)!.state).toEqual({ dueOn: '2026-10-09', source: 'apple_calendar' });
  });

  it('the golden fixture maps to what the same events from Google would, under its own name', () => {
    const raw = JSON.parse(readFileSync(FIXTURE, 'utf8')) as unknown;
    const r = fromSnapshot(raw);
    expect(r.errors).toEqual([]);
    expect(r.observations.filter((o) => o.kind === 'commitment').map((o) => o.state.response).sort()).toEqual(['accepted', 'needs_action', 'organizer', 'organizer', 'tentative']);
    expect(r.observations.filter((o) => o.kind === 'deadline')).toHaveLength(2);
    expect(persons(r.observations).map((p) => (p.state as { email: string }).email).sort()).toEqual(['ada@example.com', 'grace@example.com']);
    expect(r.gone).toHaveLength(2);
    // The same events, as Google's listing would send them.
    const s = parsed(raw);
    const google = s.events.map((e) => {
      if (e.status === 'cancelled') return { id: e.id, status: 'cancelled', ...(e.modifiedAt ? { updated: e.modifiedAt } : {}) };
      const w = (x: { at?: string; day?: string }) => (x.at ? { dateTime: x.at } : { date: x.day });
      const meets = e.self === 'organizer' || e.self === 'accepted';
      return {
        id: e.id, status: e.status, summary: e.title, eventType: 'default', start: w(e.start as never), end: w(e.end as never),
        organizer: { self: e.self === 'organizer' },
        attendees: [
          ...(e.self === 'organizer' ? [] : [{ email: 'will@example.com', self: true, responseStatus: { accepted: 'accepted', tentative: 'tentative', declined: 'declined', needs_action: 'needsAction' }[e.self] }]),
          ...(meets ? (e.attendees ?? []).map((a) => ({ email: a.email, ...(a.name ? { displayName: a.name } : {}), ...(a.kind === 'person' ? {} : { resource: true }) })) : []),
        ],
        ...(e.modifiedAt ? { updated: e.modifiedAt } : {}), ...(e.recurring ? { recurringEventId: 'base' } : {}),
      };
    });
    const g = mapGoogle(google, { tz: TZ, now: NOW });
    expect(JSON.stringify(r)).toBe(JSON.stringify(g).replaceAll('google_calendar', 'apple_calendar').replaceAll('google calendar', 'apple calendar'));
  });
});

describe('the calendar core: Google and Apple map the same items the same way, apart from their names', () => {
  const me = { email: 'will@example.com', self: true, responseStatus: 'accepted' };
  const timed = (start: string, end: string) => ({ start: { dateTime: start }, end: { dateTime: end } });
  const allDay = (start: string, end: string) => ({ start: { date: start }, end: { date: end } });
  const g = (id: string, o: Record<string, unknown> = {}) => ({ id, status: 'confirmed', summary: `Private title ${id}`, eventType: 'default', ...timed('2026-10-07T14:00:00-05:00', '2026-10-07T15:00:00-05:00'), updated: '2026-10-01T12:00:00.000Z', ...o });
  // The cases google-calendar.test.ts maps one by one, here in one listing each.
  const cases: Array<[string, unknown[], Date]> = [
    ['instants, names, titles', [g('a1', { attendees: [me, { email: ' Alice@Example.com ', displayName: 'Alice' }], recurringEventId: 'b' }), g('a2', { summary: undefined })], NOW],
    ['the fall-back hour', [g('fb1', timed('2026-11-01T01:30:00-05:00', '2026-11-01T01:00:00-06:00')), g('fb2', timed('2026-11-01T01:30:00-06:00', '2026-11-01T02:00:00-06:00')), g('fb5', allDay('2026-11-01', '2026-11-02'))], new Date('2026-10-31T12:00:00Z')],
    ['the spring-forward day', [g('sf1', timed('2027-03-14T01:30:00-06:00', '2027-03-14T03:30:00-05:00')), g('sf3', allDay('2027-03-14', '2027-03-15')), g('sf4', allDay('2027-03-13', '2027-03-16'))], new Date('2027-03-12T12:00:00Z')],
    ["Will's answers", [
      g('r1', { attendees: [{ ...me, responseStatus: 'declined' }, { email: 'a@x.org' }] }), g('r2', { attendees: [{ ...me, responseStatus: 'tentative' }, { email: 'a@x.org' }] }),
      g('r3', { attendees: [{ ...me, responseStatus: 'needsAction' }] }), g('r4', { attendees: undefined }), g('r5', { attendees: [{ email: 'a@x.org' }], organizer: { self: true } }),
      g('r7', { status: 'tentative', attendees: [me, { email: 'a@x.org' }] }),
    ], NOW],
    ['attendee hashes', [g('h1', { attendees: [me, { email: 'room@x.org', resource: true }, { email: 'Zoe@X.org' }, { email: 'zoe@x.org ' }, { email: 'nope' }] }), g('h2', { attendees: [me, ...Array.from({ length: 250 }, (_, i) => ({ email: `p${i}@x.org` }))] })], NOW],
    ['deadlines', [g('dl1', { summary: 'Passport renewal', ...allDay('2026-10-20', '2026-10-21') }), g('dl2', { summary: 'Grant submission', ...timed('2026-10-08T03:00:00Z', '2026-10-08T04:00:00Z') }), g('dl3', { summary: 'Check in', ...timed('2026-10-09T15:00:00-05:00', '2026-10-09T15:00:00-05:00') }), g('dl8', { summary: 'Submission window', ...timed('2026-10-12T09:00:00-05:00', '2026-10-16T17:00:00-05:00') })], NOW],
    ['cancelled and skipped', [g('x1', { status: 'cancelled' }), { id: 'rec1_20261010T150000Z', status: 'cancelled' }, g('x2', { eventType: 'workingLocation' }), g('x4', { eventType: 'focusTime' })], NOW],
    ['long ids', [g(`_${'a'.repeat(299)}`), g('c'.repeat(1025))], NOW],
    ['set aside', [g('has space'), g('m2', timed('2026-10-07T14:00:00', '2026-10-07T15:00:00')), 'Private plan B', g('m4', timed('2026-10-07T15:00:00-05:00', '2026-10-07T14:00:00-05:00')), ...Array.from({ length: 12 }, (_, i) => ({ id: `bad ${i}` }))], NOW],
    ['upcoming', [g('u2', timed(at(-14 * MIN), at(46 * MIN))), g('u3', timed(at(24 * HOUR), at(25 * HOUR))), g('u5', allDay('2026-10-06', '2026-10-07')), g('u7', { attendees: [{ ...me, responseStatus: 'needsAction' }], ...timed(at(HOUR), at(2 * HOUR)) }), g('d1', { summary: 'Rent due', ...allDay('2026-10-05', '2026-10-06') })], NOW],
    ['people', [g('p1', { attendees: [me, { email: 'Alice@Example.com', displayName: 'Alice A' }, { email: 'bob@example.com' }, { email: 'cy@x.org', displayName: '‍‏' }, { email: 'long@example.com', displayName: `L${'o'.repeat(150)}ng` }] }), g('p3', { attendees: [{ ...me, responseStatus: 'tentative' }, { email: 'dave@example.com' }] })], NOW],
    ['texts', [g('t1', { summary: `\u0000${'x'.repeat(299)}😀tail` }), g('t2', { summary: '   ' }), g('t3', { summary: 'half \uD800 pair' })], NOW],
  ];
  for (const [name, items, now] of cases) {
    it(name, () => {
      const google = mapGoogle(items, { tz: TZ, now });
      const ours = apple(items, now);
      expect(JSON.stringify(ours)).toBe(JSON.stringify(google).replaceAll('google_calendar', 'apple_calendar').replaceAll('google calendar', 'apple calendar'));
      expect(JSON.stringify(ours)).not.toContain('google');
    });
  }
});

// ---- the source --------------------------------------------------------------------------

const noFetch: SourceRun['fetch'] = async () => {
  throw new Error('apple_calendar reaches nothing');
};
function runOf(o: { now?: Date; cursor?: string; known?: Known[] } = {}): SourceRun {
  return {
    now: o.now ?? NOW, signal: new AbortController().signal, fetch: noFetch,
    ...(o.cursor !== undefined ? { cursor: { cursor: o.cursor, etag: null } } : {}),
    known: async (kind) => (o.known ?? []).filter((k) => k.key.startsWith(`${kind}:`)),
  };
}
/** An inbox started an hour before NOW, holding this snapshot (pushed when it was read). */
function inboxWith(raw?: Record<string, unknown>, startedAt = NOW.getTime() - HOUR): CalendarInbox {
  const inbox = new CalendarInbox(startedAt);
  if (raw) expect(inbox.offer(parsed(raw), Date.parse(raw.generatedAt as string))).toBe('accepted');
  return inbox;
}
const source = (inbox: CalendarInbox) => appleCalendarSource({ tz: TZ, inbox });
const cursorAt = (o: Record<string, unknown> = {}) => JSON.stringify({ lastRunAt: at(-10 * MIN), calendars: CALS, ...o });

const knownAhead = (name: string, startsIn = 2 * DAY): Known => ({
  key: `commitment:apple_calendar:${H(name)}`, name: 'event 2026-10-07 14:00', taintedPaths: [],
  state: { source: 'apple_calendar', startsAt: at(startsIn), endsAt: at(startsIn + HOUR), allDay: false, response: 'accepted', eventStatus: 'confirmed', confirmation: 'confirmed' },
});
const knownEnded = (name: string) => knownAhead(name, -2 * HOUR);
const knownDeadline = (name: string, dueOn = '2026-10-09'): Known => ({ key: `deadline:apple_calendar:${H(name)}`, name: `deadline ${dueOn}`, taintedPaths: [], state: { dueOn, source: 'apple_calendar' } });
const archived = (r: SyncResult) => r.observations.filter((o) => o.status === 'archived').map((o) => o.key).sort();
const keyOf = (name: string) => `commitment:apple_calendar:${H(name)}`;

describe('apple_calendar: the inbox', () => {
  it('holds a fresh snapshot newer than every one before it, at most one every 5 seconds, for an hour', () => {
    const inbox = new CalendarInbox(NOW.getTime());
    const now = NOW.getTime();
    const s = (generatedAt: string) => parsed(snap([], { generatedAt }));
    expect(inbox.latest(now)).toBeUndefined();
    expect(inbox.offer(s(at(-11 * MIN)), now)).toBe('stale');
    expect(inbox.offer(s(at(3 * MIN)), now)).toBe('stale');
    expect(inbox.offer(s(at(-MIN)), now)).toBe('accepted');
    expect(inbox.latest(now)!.generatedAt).toBe(now - MIN);
    // Too soon, however new; then a replay or an older one is stale, whatever the time.
    expect(inbox.offer(s(at(0)), now + ACCEPT_EVERY_MS - 1)).toBe('too_soon');
    expect(inbox.offer(s(at(-MIN)), now + ACCEPT_EVERY_MS)).toBe('stale');
    expect(inbox.offer(s(at(-2 * MIN)), now + ACCEPT_EVERY_MS)).toBe('stale');
    expect(inbox.offer(s(at(0)), now + ACCEPT_EVERY_MS)).toBe('accepted');
    expect(inbox.lastAcceptedAt()).toBe(now + ACCEPT_EVERY_MS);
    // Dropped an hour after it arrived; still no replay after that.
    expect(inbox.latest(now + ACCEPT_EVERY_MS + HOLD_MS)).toBeDefined();
    expect(inbox.latest(now + ACCEPT_EVERY_MS + HOLD_MS + 1)).toBeUndefined();
    expect(inbox.offer(s(at(0)), now + 2 * MIN)).toBe('stale');
    // Cleared at once (the source is off).
    expect(inbox.offer(s(at(MIN)), now + 2 * MIN)).toBe('accepted');
    inbox.clear();
    expect(inbox.latest(now + 2 * MIN)).toBeUndefined();
  });
});

describe('apple_calendar: the source', () => {
  it('reaches nothing, every 5 minutes; refuses a zone it cannot use', () => {
    const src = source(inboxWith());
    expect([src.name, src.cadenceMs]).toEqual(['apple_calendar', 5 * MIN]);
    expect(() => appleCalendarSource({ tz: 'Mars/Olympus_Mons', inbox: new CalendarInbox() })).toThrow();
  });

  it('no snapshot in the first 10 minutes after a restart is idle; after that, or one over 15 minutes old, it fails and archives nothing', async () => {
    const started = NOW.getTime() - GRACE_MS + MIN;
    expect(await source(new CalendarInbox(started)).run(runOf({ known: [knownAhead('k1')] }))).toEqual({ observations: [], metrics: [], idle: true });
    const late = new CalendarInbox(NOW.getTime() - GRACE_MS - MIN);
    await expect(source(late).run(runOf())).rejects.toThrow("apple calendar: Flint Calendar hasn't reported since the runtime started at 09:49");
    // Pushed, then quiet: 16 minutes on, the snapshot is no reading of the calendar now.
    const old = inboxWith(snap([ev('a')], { generatedAt: at(-16 * MIN) }));
    await expect(source(old).run(runOf({ known: [knownAhead('k1')] }))).rejects.toThrow("apple calendar: Flint Calendar hasn't reported since 09:44");
    expect(STALE_MS).toBe(15 * MIN);
    // Fresh: read.
    const fresh = inboxWith(snap([ev('a')], { generatedAt: at(-14 * MIN) }));
    expect((await source(fresh).run(runOf())).observations.map((o) => o.key)).toEqual([keyOf('a')]);
  });

  it('calendar access off on the Mac fails with where to turn it on, and archives nothing', async () => {
    for (const access of ['denied', 'restricted', 'not_determined', 'write_only']) {
      await expect(source(inboxWith(snap([], { access }))).run(runOf({ known: [knownAhead('k1')] })), access)
        .rejects.toThrow('apple calendar: Calendar access is off: System Settings > Privacy & Security > Calendars > Flint Calendar');
    }
  });

  it('disconnected (revoked): every event it has from Apple Calendar is archived, and nothing of another source', async () => {
    const known = [knownAhead('k1'), knownEnded('k2'), knownDeadline('k3'), { ...knownAhead('g1'), key: 'commitment:google_calendar:g1' }];
    const r = await source(inboxWith(snap([], { state: 'revoked', access: 'denied' }))).run(runOf({ known, cursor: cursorAt() }));
    expect(archived(r)).toEqual([keyOf('k1'), keyOf('k2'), `deadline:apple_calendar:${H('k3')}`].sort());
    expect(r.observations.every((o) => o.status === 'archived' && o.sensitivity === 'personal')).toBe(true);
    expect(JSON.parse(r.cursor!)).toEqual({ lastRunAt: NOW.toISOString() });
  });

  it('a whole snapshot archives what it no longer holds, as it was last known; keys are commitment:apple_calendar:<id>', async () => {
    const known = [knownAhead('keep'), knownAhead('gone1'), knownDeadline('gone2'), knownAhead('dec')];
    const r = await source(inboxWith(snap([ev('keep'), ev('dec', { self: 'declined' })]))).run(runOf({ known, cursor: cursorAt() }));
    expectValid(r.observations);
    expect(r.observations.filter((o) => o.status !== 'archived').map((o) => o.key)).toEqual([keyOf('keep')]);
    expect(archived(r)).toEqual([keyOf('gone1'), keyOf('dec'), `deadline:apple_calendar:${H('gone2')}`].sort());
    expect(r.observations.find((o) => o.key === keyOf('gone1'))).toEqual({
      type: 'commitment.state', kind: 'commitment', key: keyOf('gone1'), name: knownAhead('gone1').name, state: knownAhead('gone1').state, status: 'archived',
      externalId: `event:${H('gone1')}`, sensitivity: 'personal', taintedPaths: [],
    });
    expect(r.warnings).toBeUndefined();
    expect(JSON.parse(r.cursor!)).toEqual({ lastRunAt: NOW.toISOString(), calendars: CALS });
  });

  it('a different choice of calendars archives nothing missing this run, says so, and is the choice next time', async () => {
    const known = [knownAhead('gone1'), knownEnded('ended'), knownAhead('dec')];
    const r = await source(inboxWith(snap([ev('dec', { self: 'declined' })], { calendars: { count: 1, hash: H('calendar-a') } }))).run(runOf({ known, cursor: cursorAt() }));
    expect(archived(r)).toEqual([keyOf('ended'), keyOf('dec')].sort());
    expect(r.warnings).toEqual(['apple calendar: the calendars Flint Calendar reads have changed; nothing missing is archived this run']);
    expect(JSON.parse(r.cursor!).calendars).toBe(H('calendar-a'));
    // No calendars at all (iCloud Calendar off on the Mac): nothing missing is archived either.
    const none = await source(inboxWith(snap([], { calendars: { count: 0, hash: H('') } }))).run(runOf({ known, cursor: cursorAt({ calendars: H('') }) }));
    expect(archived(none)).toEqual([keyOf('ended')]);
    expect(none.warnings).toEqual(['apple calendar: no calendars are chosen in Flint Calendar, or iCloud Calendar is off on this Mac; nothing missing is archived']);
    // No cursor yet (a first run): nothing missing is archived, quietly.
    const first = await source(inboxWith(snap([]))).run(runOf({ known }));
    expect(archived(first)).toEqual([keyOf('ended')]);
    expect(first.warnings).toBeUndefined();
  });

  it('6 of 10 events ahead missing trips the guard; 5, or half, does not', async () => {
    const names = Array.from({ length: 10 }, (_, i) => `f${i}`);
    const known = [...names.map((n) => knownAhead(n)), knownEnded('ended')];
    const run = (listed: string[]) => source(inboxWith(snap(listed.map((n) => ev(n))))).run(runOf({ known, cursor: cursorAt() }));
    const six = await run(names.slice(6));
    expect(archived(six)).toEqual([keyOf('ended')]);
    expect(six.warnings).toEqual(["apple calendar: 6 of 10 events ahead are missing from Flint Calendar's snapshot; they are archived only if they are still missing an hour after they went"]);
    expect(JSON.parse(six.cursor!).missing).toMatchObject({ runs: 1, since: NOW.toISOString() });
    expect(archived(await run(names.slice(5)))).toHaveLength(6);
    // Of 20 ahead, 8 missing is under half.
    const twenty = Array.from({ length: 20 }, (_, i) => `t${i}`);
    const many = await source(inboxWith(snap(twenty.slice(8).map((n) => ev(n))))).run(runOf({ known: twenty.map((n) => knownAhead(n)), cursor: cursorAt() }));
    expect(archived(many)).toHaveLength(8);
  });

  it('the same ones missing for 12 runs, over most of an hour, are archived; a different set starts again', async () => {
    const names = Array.from({ length: 10 }, (_, i) => `m${i}`);
    const known = names.map((n) => knownAhead(n, 3 * DAY));
    let cursor = cursorAt();
    let r: SyncResult | undefined;
    for (let i = 0; i < CONFIRM_RUNS; i++) {
      const now = new Date(NOW.getTime() + i * 5 * MIN);
      const inbox = inboxWith(snap(names.slice(8).map((n) => ev(n)), { generatedAt: now.toISOString(), window: { start: now.toISOString(), end: at(14 * DAY, now) } }));
      r = await source(inbox).run(runOf({ now, known, cursor }));
      if (i < CONFIRM_RUNS - 1) {
        expect(archived(r), `run ${i + 1}`).toEqual([]);
        expect(JSON.parse(r.cursor!).missing.runs).toBe(i + 1);
      }
      cursor = r.cursor!;
    }
    expect(CONFIRM_MS).toBeLessThanOrEqual((CONFIRM_RUNS - 1) * 5 * MIN);
    expect(archived(r!)).toHaveLength(8);
    expect(JSON.parse(r!.cursor!)).not.toHaveProperty('missing');
    // Twelve runs in a burst (pushes, minutes apart) are not an hour: still held back.
    let burst = cursorAt();
    for (let i = 0; i < CONFIRM_RUNS + 2; i++) {
      const now = new Date(NOW.getTime() + i * 10_000);
      const b = await source(inboxWith(snap(names.slice(8).map((n) => ev(n)), { generatedAt: now.toISOString() }))).run(runOf({ now, known, cursor: burst }));
      expect(archived(b)).toEqual([]);
      burst = b.cursor!;
    }
    // A different set missing: counted from one again.
    const other = await source(inboxWith(snap(names.slice(7).map((n) => ev(n))))).run(runOf({ known, cursor: burst }));
    expect(JSON.parse(other.cursor!).missing.runs).toBe(1);
  });

  it('a snapshot that is not complete archives only what ended, was declined, cancelled or renamed', async () => {
    const known = [knownAhead('ahead'), knownEnded('ended'), knownAhead('can'), knownAhead('ren'), knownDeadline('pastdue', '2026-10-04')];
    const listed = [ev('can', { status: 'cancelled' }), ev('ren', { title: 'Report due' })];
    const part = await source(inboxWith(snap(listed, { complete: false }))).run(runOf({ known, cursor: cursorAt() }));
    expect(archived(part)).toEqual([keyOf('ended'), keyOf('can'), keyOf('ren'), `deadline:apple_calendar:${H('pastdue')}`].sort());
    expect(part.warnings).toEqual(['apple calendar: Flint Calendar sent only part of the next 14 days (over its limits); only what has ended is archived']);
    // The same snapshot, whole: the one missing is archived too.
    expect(archived(await source(inboxWith(snap(listed))).run(runOf({ known, cursor: cursorAt() })))).toContain(keyOf('ahead'));
  });

  it('nothing Will did not write reaches a key, a name, an id, a state or an event; the title is in texts, a person only in their own row', async () => {
    const r = await source(inboxWith(snap([
      ev('s1', { title: 'TOPSECRET merger talk', self: 'organizer', start: { at: at(HOUR) }, end: { at: at(2 * HOUR) }, attendees: [{ name: 'Zed Quux', email: 'zed@corp.example', kind: 'person' }] }),
      ev('s2', { title: 'TOPSECRET filing due', start: { day: '2026-10-05' }, end: { day: '2026-10-06' } }),
      ev('s3', { title: 'TOPSECRET', self: 'accepted', attendees: [{ name: 'Yan TOPSECRET', email: 'yan@corp.example', kind: 'room' }] }),
    ]))).run(runOf({ cursor: cursorAt() }));
    expect(r.events!.length).toBeGreaterThan(0);
    const outside = r.observations.map((o) => {
      const { texts: _texts, ...rest } = o;
      return o.kind === 'person' ? { key: o.key, externalId: o.externalId, state: { ...o.state, email: undefined } } : rest;
    });
    expect(JSON.stringify([outside, r.events, r.metrics, r.warnings ?? [], r.cursor])).not.toMatch(/TOPSECRET|@|Zed|Yan|corp/);
    expect(commitment(r.observations, 's1')!.texts).toEqual({ title: 'TOPSECRET merger talk' });
    // People: only from an event Will organized or accepted, never a room, and with this calendar's name.
    expect(persons(r.observations)).toEqual([expect.objectContaining({ key: personKey(emailHash('zed@corp.example'), 'apple_calendar'), name: 'Zed Quux', state: { source: 'apple_calendar', email: 'zed@corp.example', emailHash: emailHash('zed@corp.example') } })]);
    expect(r.events!.map((e) => [e.type, e.payload.entityKey])).toEqual([
      ['commitment.upcoming', keyOf('s1')],
      ['deadline.upcoming', `deadline:apple_calendar:${H('s2')}`],
    ]);
  });

  it('the lag metric is apple_calendar.lag_ms, from when the event last changed', async () => {
    const r = await source(inboxWith(snap([ev('l1', { modifiedAt: '2026-10-05T14:56:00Z' }), ev('l2', { modifiedAt: '2026-10-05T14:40:00Z' })]))).run(runOf({ cursor: cursorAt() }));
    expect(r.metrics).toEqual([{
      series: { key: 'apple_calendar.lag_ms', unit: 'ms', freq: 'raw', sensitivity: 'ops', description: 'how long a calendar change took to reach Flint (the longest this run)' },
      at: NOW, value: 4 * MIN,
    }]);
    // No cursor: no lag (a first run is not one).
    expect((await source(inboxWith(snap([ev('l1', { modifiedAt: '2026-10-05T14:56:00Z' })]))).run(runOf())).metrics).toEqual([]);
  });
});
