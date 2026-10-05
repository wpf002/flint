/**
 * The google_calendar source against fixtures shaped like Google's events
 * listing (P2.5): instants across both DST changes in America/Chicago,
 * all-day spans, Will's answer, deadlines, people only from what he accepted,
 * no title or address anywhere but EntityText and a person's own row, paging,
 * archiving only after a whole readable listing, HTTP failures that never
 * quote the token, and the lag metric. No network: fetch is a stub.
 */
import { describe, it, expect } from 'vitest';
import { CALENDAR_ENDPOINTS, CALENDAR_EVENTS_PATH, GOOGLE_API, googleCalendarSource, mapEvents, type CalendarOpts } from '../../src/sources/google/calendar';
import { allowed, scopedFetch } from '../../src/policy/egress';
import { STATE } from '../../src/world/kinds';
import { emailHash, personExternalId, personKey } from '../../src/world/people';
import type { Known, RaisedEvent, SourceObservation, SourceRun } from '../../src/sources/types';

const TZ = 'America/Chicago';
/** 10:00 CDT on a Monday. */
const NOW = new Date('2026-10-05T15:00:00Z');
const MIN = 60_000;
const HOUR = 3_600_000;
const TOKEN = 'ya29.a0-test-access-token';
const at = (ms: number, from = NOW) => new Date(from.getTime() + ms).toISOString();

const me = { email: 'will@example.com', self: true, responseStatus: 'accepted' };
const timed = (start: string, end: string) => ({ start: { dateTime: start }, end: { dateTime: end } });
const allDay = (start: string, end: string) => ({ start: { date: start }, end: { date: end } });
/** One item as the listing sends it (the requested fields only). */
const ev = (id: string, o: Record<string, unknown> = {}) => ({
  id, status: 'confirmed', summary: `Private title ${id}`, eventType: 'default',
  ...timed('2026-10-07T14:00:00-05:00', '2026-10-07T15:00:00-05:00'),
  updated: '2026-10-01T12:00:00.000Z',
  ...o,
});

/** Every observation's state is one its kind accepts (the mapper would refuse anything else). */
function expectValid(obs: SourceObservation[]) {
  for (const o of obs) expect(STATE[o.kind]!.safeParse(o.state).success, `${o.key}: ${JSON.stringify(o.state)}`).toBe(true);
}
const map = (items: unknown[], now = NOW) => {
  const r = mapEvents(items, { tz: TZ, now });
  expectValid(r.observations);
  return r;
};
const byKey = (obs: SourceObservation[], key: string) => obs.find((o) => o.key === key);
const commitment = (obs: SourceObservation[], id: string) => byKey(obs, `commitment:google_calendar:${id}`);
const persons = (obs: SourceObservation[]) => obs.filter((o) => o.kind === 'person');

/** Google's events listing: a body (or an HTTP status) per pageToken, '' being the first page; every request recorded. */
function fakeGoogle(pages: Record<string, unknown>) {
  const seen: Array<{ url: URL; method: string; headers: Headers; signal: AbortSignal | null | undefined }> = [];
  const fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const u = new URL(url);
    seen.push({ url: u, method: init.method ?? 'GET', headers: new Headers(init.headers), signal: init.signal });
    const page = pages[u.searchParams.get('pageToken') ?? ''];
    if (typeof page === 'number') return new Response(JSON.stringify({ error: { code: page, message: 'Request had invalid authentication credentials.' } }), { status: page });
    if (typeof page === 'string') return new Response(page, { status: 200 });
    return new Response(JSON.stringify(page ?? { items: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, seen };
}

function runOf(fetch: SourceRun['fetch'], o: { now?: Date; cursor?: string; known?: Known[]; asked?: string[] } = {}): SourceRun {
  return {
    now: o.now ?? NOW,
    signal: new AbortController().signal,
    fetch,
    ...(o.cursor !== undefined ? { cursor: { cursor: o.cursor, etag: null } } : {}),
    known: async (kind) => {
      o.asked?.push(kind);
      return (o.known ?? []).filter((k) => k.key.startsWith(`${kind}:`));
    },
  };
}
const source = (o: Partial<CalendarOpts> = {}) => googleCalendarSource({ tz: TZ, accessToken: async () => TOKEN, ...o });

const knownCommitment = (id: string): Known => ({
  key: `commitment:google_calendar:${id}`, name: 'event 2026-10-04 09:00', taintedPaths: [],
  state: { source: 'google_calendar', startsAt: '2026-10-04T14:00:00.000Z', endsAt: '2026-10-04T15:00:00.000Z', allDay: false, response: 'accepted', eventStatus: 'confirmed', confirmation: 'confirmed' },
});
const knownDeadline = (id: string): Known => ({ key: `deadline:google_calendar:${id}`, name: 'deadline 2026-10-04', taintedPaths: [], state: { dueOn: '2026-10-04', source: 'google_calendar' } });

describe('google_calendar: mapping events', () => {
  it('a timed event is a commitment: instants, a name from the time alone, the title only in texts', () => {
    const r = map([
      ev('a1', { attendees: [me, { email: ' Alice@Example.com ', displayName: 'Alice' }], recurringEventId: 'base1' }),
      ev('a2', { summary: undefined }),
    ]);
    expect(r.errors).toEqual([]);
    expect(commitment(r.observations, 'a1')).toEqual({
      type: 'commitment.state', kind: 'commitment', key: 'commitment:google_calendar:a1', externalId: 'event:a1', name: 'event 2026-10-07 14:00',
      state: {
        source: 'google_calendar', startsAt: '2026-10-07T19:00:00.000Z', endsAt: '2026-10-07T20:00:00.000Z', allDay: false, response: 'accepted',
        eventStatus: 'confirmed', confirmation: 'confirmed', recurring: true, attendeeHashes: [emailHash('alice@example.com')],
      },
      sensitivity: 'personal', taintedPaths: [], changedAt: '2026-10-01T12:00:00.000Z', texts: { title: 'Private title a1' },
    });
    // Not recurring and nobody else on it: neither field is there at all; no title, no texts.
    const a2 = commitment(r.observations, 'a2')!;
    expect(a2.state).toEqual({ source: 'google_calendar', startsAt: '2026-10-07T19:00:00.000Z', endsAt: '2026-10-07T20:00:00.000Z', allDay: false, response: 'organizer', eventStatus: 'confirmed', confirmation: 'confirmed' });
    expect(a2).not.toHaveProperty('texts');
  });

  it('DST fall-back (2026-11-01): 01:30 CDT and 01:30 CST are different instants and names; the all-day day is 25 hours', () => {
    const r = map([
      ev('fb1', timed('2026-11-01T01:30:00-05:00', '2026-11-01T01:00:00-06:00')),
      ev('fb2', timed('2026-11-01T01:30:00-06:00', '2026-11-01T02:00:00-06:00')),
      ev('fb3', timed('2026-11-01T00:30:00-05:00', '2026-11-01T01:00:00-05:00')),
      ev('fb4', timed('2026-11-01T03:00:00-06:00', '2026-11-01T04:00:00-06:00')),
      ev('fb5', allDay('2026-11-01', '2026-11-02')),
    ], new Date('2026-10-31T12:00:00Z'));
    expect(r.errors).toEqual([]);
    const fb1 = commitment(r.observations, 'fb1')!;
    const fb2 = commitment(r.observations, 'fb2')!;
    expect([fb1.state.startsAt, fb1.state.endsAt]).toEqual(['2026-11-01T06:30:00.000Z', '2026-11-01T07:00:00.000Z']);
    expect([fb2.state.startsAt, fb2.state.endsAt]).toEqual(['2026-11-01T07:30:00.000Z', '2026-11-01T08:00:00.000Z']);
    expect(fb1.name).toBe('event 2026-11-01 01:30 CDT');
    expect(fb2.name).toBe('event 2026-11-01 01:30 CST');
    // Outside the repeated hour the zone is not named.
    expect(commitment(r.observations, 'fb3')!.name).toBe('event 2026-11-01 00:30');
    expect(commitment(r.observations, 'fb4')!.name).toBe('event 2026-11-01 03:00');
    const fb5 = commitment(r.observations, 'fb5')!;
    expect(fb5.name).toBe('event 2026-11-01 (all day)');
    expect(fb5.state).toMatchObject({ startsAt: '2026-11-01T05:00:00.000Z', endsAt: '2026-11-02T06:00:00.000Z', allDay: true });
    expect(Date.parse(fb5.state.endsAt as string) - Date.parse(fb5.state.startsAt as string)).toBe(25 * HOUR);
  });

  it('DST spring-forward (2027-03-14): the wall clock jumps 01:59 to 03:00; the all-day day is 23 hours', () => {
    const r = map([
      ev('sf1', timed('2027-03-14T01:30:00-06:00', '2027-03-14T03:30:00-05:00')),
      ev('sf2', timed('2027-03-14T08:00:00Z', '2027-03-14T09:00:00Z')),
      ev('sf3', allDay('2027-03-14', '2027-03-15')),
      ev('sf4', allDay('2027-03-13', '2027-03-16')),
    ], new Date('2027-03-12T12:00:00Z'));
    expect(r.errors).toEqual([]);
    const sf1 = commitment(r.observations, 'sf1')!;
    expect([sf1.name, sf1.state.startsAt, sf1.state.endsAt]).toEqual(['event 2027-03-14 01:30', '2027-03-14T07:30:00.000Z', '2027-03-14T08:30:00.000Z']);
    // Given in UTC, named on Chicago's clock.
    expect(commitment(r.observations, 'sf2')!.name).toBe('event 2027-03-14 03:00');
    const sf3 = commitment(r.observations, 'sf3')!;
    expect(sf3.state).toMatchObject({ startsAt: '2027-03-14T06:00:00.000Z', endsAt: '2027-03-15T05:00:00.000Z', allDay: true });
    expect(Date.parse(sf3.state.endsAt as string) - Date.parse(sf3.state.startsAt as string)).toBe(23 * HOUR);
    // Several days: from the first local midnight to the one after the last day (Google's end date is exclusive).
    expect(commitment(r.observations, 'sf4')!.state).toMatchObject({ startsAt: '2027-03-13T06:00:00.000Z', endsAt: '2027-03-16T05:00:00.000Z' });
  });

  it('an ordinary all-day event spans its local day', () => {
    const r = map([ev('ad1', allDay('2026-10-09', '2026-10-10'))]);
    expect(commitment(r.observations, 'ad1')).toMatchObject({
      name: 'event 2026-10-09 (all day)',
      state: { startsAt: '2026-10-09T05:00:00.000Z', endsAt: '2026-10-10T05:00:00.000Z', allDay: true },
    });
  });

  it("Will's answer: declined is not kept; tentative, needs action and organizer are kept as such", () => {
    const alice = { email: 'alice@example.com' };
    const r = map([
      ev('r1', { attendees: [{ ...me, responseStatus: 'declined' }, alice] }),
      ev('r2', { attendees: [{ ...me, responseStatus: 'tentative' }, alice] }),
      ev('r3', { attendees: [{ ...me, responseStatus: 'needsAction' }, alice] }),
      ev('r4', { attendees: undefined }),
      ev('r5', { attendees: [alice], organizer: { self: true } }),
      ev('r6', { attendees: [alice], organizer: { self: false } }),
      ev('r7', { status: 'tentative', attendees: [me, alice] }),
      ev('r8', { attendees: [{ ...me, responseStatus: 'maybe' }] }),
      ev('r9', { attendees: [] }),
    ]);
    expect(r.errors).toEqual([]);
    expect(commitment(r.observations, 'r1')).toBeUndefined();
    const answer = (id: string) => commitment(r.observations, id)?.state.response;
    expect(['r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9'].map(answer)).toEqual(['tentative', 'needs_action', 'organizer', 'organizer', 'needs_action', 'accepted', 'needs_action', 'organizer']);
    expect(commitment(r.observations, 'r7')!.state.eventStatus).toBe('tentative');
    expect(commitment(r.observations, 'r2')!.state.eventStatus).toBe('confirmed');
    expect(r.events.some((e) => e.sourceRef.startsWith('upcoming:r1:'))).toBe(false);
  });

  it('attendee hashes: not Will, not a room, not a bad address; sorted, unique, at most 200', () => {
    const r = map([
      ev('h1', {
        attendees: [
          me,
          { email: 'room-1@resource.calendar.google.com', resource: true, displayName: 'Room 1' },
          { email: 'Zoe@X.org' }, { email: 'zoe@x.org ' }, { email: 'adam@x.org', responseStatus: 'declined' },
          { displayName: 'No address' }, { email: 'not an address' },
        ],
      }),
      ev('h2', { attendees: [me, ...Array.from({ length: 250 }, (_, i) => ({ email: `p${i}@x.org` }))] }),
    ]);
    expect(commitment(r.observations, 'h1')!.state.attendeeHashes).toEqual([emailHash('zoe@x.org'), emailHash('adam@x.org')].sort());
    const many = commitment(r.observations, 'h2')!.state.attendeeHashes as string[];
    expect(many).toHaveLength(200);
    expect([...many].sort()).toEqual(many);
  });

  it('deadlines: a due-date word in the title, or a zero-length timed event; dueOn is the local day of the start', () => {
    const r = map([
      ev('dl1', { summary: 'Passport renewal', ...allDay('2026-10-20', '2026-10-21') }),
      // 22:00 CDT on the 7th is the 8th in UTC: the local day is the due date.
      ev('dl2', { summary: 'Grant submission', ...timed('2026-10-08T03:00:00Z', '2026-10-08T04:00:00Z') }),
      ev('dl3', { summary: 'Check in', ...timed('2026-10-09T15:00:00-05:00', '2026-10-09T15:00:00-05:00') }),
      ev('dl4', { summary: 'LAST DAY to return the bike' }),
      ev('dl5', { summary: 'Lease expires', attendees: [me, { email: 'landlord@example.com', displayName: 'Landlord' }] }),
      ev('dl6', { summary: 'Report submitted?' }),
      ev('c1', { summary: 'Lunch with Sam' }),
      ev('c2', { summary: 'Overdue library books chat' }),
    ]);
    expect(r.errors).toEqual([]);
    expect(byKey(r.observations, 'deadline:google_calendar:dl1')).toEqual({
      type: 'deadline.state', kind: 'deadline', key: 'deadline:google_calendar:dl1', externalId: 'deadline:dl1', name: 'deadline 2026-10-20',
      state: { dueOn: '2026-10-20', source: 'google_calendar' }, sensitivity: 'personal', taintedPaths: [],
      changedAt: '2026-10-01T12:00:00.000Z', texts: { title: 'Passport renewal' },
    });
    expect(byKey(r.observations, 'deadline:google_calendar:dl2')!.state).toEqual({ dueOn: '2026-10-07', source: 'google_calendar' });
    expect(byKey(r.observations, 'deadline:google_calendar:dl3')!.state.dueOn).toBe('2026-10-09');
    for (const id of ['dl4', 'dl5', 'dl6']) expect(byKey(r.observations, `deadline:google_calendar:${id}`), id).toBeDefined();
    for (const id of ['c1', 'c2']) expect(commitment(r.observations, id), id).toBeDefined();
    // A deadline is never also a commitment, and names nobody.
    expect(r.observations.filter((o) => o.key.endsWith(':dl5')).map((o) => o.kind)).toEqual(['deadline']);
    expect(persons(r.observations)).toEqual([]);
  });

  it('skips cancelled events, working locations and birthdays; a bare cancelled instance is no error', () => {
    const r = map([
      ev('x1', { status: 'cancelled' }),
      { id: 'rec1_20261010T150000Z', status: 'cancelled', recurringEventId: 'rec1' },
      ev('x2', { eventType: 'workingLocation', ...allDay('2026-10-06', '2026-10-07') }),
      ev('x3', { eventType: 'birthday', ...allDay('2026-10-08', '2026-10-09') }),
      ev('x4', { eventType: 'focusTime' }),
    ]);
    expect(r.errors).toEqual([]);
    expect(r.observations.map((o) => o.key)).toEqual(['commitment:google_calendar:x4']);
  });

  it('sets aside a malformed item with an error that names fields, never its text', () => {
    const r = map([
      ev('has space', { summary: 'Private plan A' }),
      ev('m2', timed('2026-10-07T14:00:00', '2026-10-07T15:00:00')),
      ev('m3', allDay('2026-02-30', '2026-03-01')),
      ev('m4', timed('2026-10-07T15:00:00-05:00', '2026-10-07T14:00:00-05:00')),
      ev('m5', { start: { date: '2026-10-07' }, end: { dateTime: '2026-10-07T15:00:00-05:00' } }),
      'Private plan B',
      ev('m6', { attendees: [{ email: 42 }] }),
      ev('ok1'),
    ]);
    expect(r.observations.map((o) => o.key)).toEqual(['commitment:google_calendar:ok1']);
    expect(r.errors).toHaveLength(7);
    expect(r.errors[0]).toMatch(/item 0 .*\(id\)/);
    expect(r.errors[1]).toMatch(/item 1 .*start\.dateTime/);
    expect(r.errors[2]).toMatch(/item 2 .*start\.date/);
    expect(r.errors[3]).toBe('google calendar: event m4: ends before it starts; set aside');
    expect(r.errors[4]).toMatch(/event m5: an all-day start without an all-day end/);
    expect(r.errors[5]).toMatch(/item 5 is not an event/);
    expect(r.errors[6]).toMatch(/attendees\.0\.email/);
    expect(r.errors.join(' ')).not.toMatch(/Private|has space/);
    // Many bad items are summed up, not listed.
    const lots = map(Array.from({ length: 15 }, (_, i) => ({ id: `bad ${i}` })));
    expect(lots.errors).toHaveLength(11);
    expect(lots.errors[10]).toBe('google calendar: 5 more item(s) set aside');
  });

  it('upcoming: accepted, organized or tentative commitments starting in (now - 15 min, now + 24 h]; deadlines due today or tomorrow', () => {
    const r = map([
      ev('u1', timed(at(-15 * MIN), at(45 * MIN))),
      ev('u2', timed(at(-14 * MIN), at(46 * MIN))),
      ev('u3', timed(at(24 * HOUR), at(25 * HOUR))),
      ev('u4', timed(at(24 * HOUR + MIN), at(25 * HOUR))),
      ev('u5', allDay('2026-10-06', '2026-10-07')),
      ev('u6', allDay('2026-10-05', '2026-10-06')),
      ev('u7', { attendees: [{ ...me, responseStatus: 'needsAction' }], ...timed(at(HOUR), at(2 * HOUR)) }),
      ev('u8', { attendees: [{ ...me, responseStatus: 'tentative' }], ...timed(at(2 * HOUR), at(3 * HOUR)) }),
      ev('u9', { attendees: [me], ...timed(at(3 * HOUR), at(4 * HOUR)) }),
      ev('d1', { summary: 'Rent due', ...allDay('2026-10-05', '2026-10-06') }),
      ev('d2', { summary: 'Submit report', ...timed('2026-10-06T22:00:00Z', '2026-10-06T22:30:00Z') }),
      ev('d3', { summary: 'Visa expires', ...allDay('2026-10-08', '2026-10-09') }),
    ]);
    expect(r.errors).toEqual([]);
    const c = (id: string, startsAt: string, day: string, time: string, allDayEv = false): RaisedEvent => ({
      sourceRef: `upcoming:${id}:${startsAt}`, type: 'commitment.upcoming', occurredAt: NOW, sensitivity: 'personal', tainted: false, current: true,
      payload: { entityKind: 'commitment', entityKey: `commitment:google_calendar:${id}`, day, time, allDay: allDayEv },
    });
    const d = (id: string, dueOn: string, day: string, allDayEv: boolean): RaisedEvent => ({
      sourceRef: `upcoming:${id}:${dueOn}`, type: 'deadline.upcoming', occurredAt: NOW, sensitivity: 'personal', tainted: false, current: true,
      payload: { entityKind: 'deadline', entityKey: `deadline:google_calendar:${id}`, day, time: '', allDay: allDayEv },
    });
    expect(r.events).toEqual([
      c('u2', '2026-10-05T14:46:00.000Z', 'today', '09:46'),
      c('u3', '2026-10-06T15:00:00.000Z', 'tomorrow', '10:00'),
      c('u5', '2026-10-06T05:00:00.000Z', 'tomorrow', '', true),
      c('u8', '2026-10-05T17:00:00.000Z', 'today', '12:00'),
      c('u9', '2026-10-05T18:00:00.000Z', 'today', '13:00'),
      d('d1', '2026-10-05', 'today', true),
      d('d2', '2026-10-06', 'tomorrow', false),
    ]);
  });

  it('upcoming days are local: just before midnight, and across a 23-hour spring-forward day', () => {
    // 23:50 CDT on the 4th (already the 5th in UTC).
    const late = new Date('2026-10-05T04:50:00Z');
    const r = map([
      ev('le1', timed('2026-10-05T04:40:00Z', '2026-10-05T05:40:00Z')),
      ev('le2', timed('2026-10-05T05:10:00Z', '2026-10-05T06:10:00Z')),
      ev('le3', { summary: 'Form due', ...allDay('2026-10-05', '2026-10-06') }),
    ], late);
    expect(r.events.map((e) => [e.sourceRef, e.payload.day, e.payload.time])).toEqual([
      ['upcoming:le1:2026-10-05T04:40:00.000Z', 'today', '23:40'],
      ['upcoming:le2:2026-10-05T05:10:00.000Z', 'tomorrow', '00:10'],
      ['upcoming:le3:2026-10-05', 'tomorrow', ''],
    ]);
    // 23:30 CST on 2027-03-13: 00:15 on the 15th is 23 h 45 min away but two local days off, so it waits.
    const dst = new Date('2027-03-14T05:30:00Z');
    const s = map([ev('dst1', timed('2027-03-15T05:15:00Z', '2027-03-15T06:00:00Z')), ev('dst2', timed('2027-03-15T04:30:00Z', '2027-03-15T05:00:00Z'))], dst);
    expect(s.events.map((e) => [e.sourceRef, e.payload.day, e.payload.time])).toEqual([['upcoming:dst2:2027-03-15T04:30:00.000Z', 'tomorrow', '23:30']]);
  });

  it('people come only from commitments Will accepted or organized, once per address, never Will or a room', () => {
    const r = map([
      ev('p1', {
        attendees: [
          me, { email: 'Alice@Example.com', displayName: 'Alice A' }, { email: 'room-1@resource.calendar.google.com', resource: true, displayName: 'Room 1' },
          { email: 'bob@example.com' }, { email: 'nope', displayName: 'Not An Address' }, { email: 'long@example.com', displayName: `L${'o'.repeat(150)}ng` },
        ],
      }),
      ev('p2', { organizer: { self: true }, attendees: [{ email: 'alice@example.com', displayName: 'Alice Again' }, { email: 'carol@example.com', displayName: '  ' }] }),
      ev('p3', { attendees: [{ ...me, responseStatus: 'tentative' }, { email: 'dave@example.com' }] }),
      ev('p4', { attendees: [{ ...me, responseStatus: 'needsAction' }, { email: 'erin@example.com' }] }),
      ev('p5', { summary: 'Visa expires', attendees: [me, { email: 'frank@example.com' }] }),
      ev('p6', { attendees: [{ ...me, responseStatus: 'declined' }, { email: 'gina@example.com' }] }),
    ]);
    const people = persons(r.observations);
    const h = (e: string) => emailHash(e);
    expect(people.map((p) => p.key)).toEqual([personKey(h('alice@example.com')), personKey(h('bob@example.com')), personKey(h('long@example.com')), personKey(h('carol@example.com'))]);
    expect(people[0]).toEqual({
      type: 'person.seen', kind: 'person', key: personKey(h('alice@example.com')), externalId: personExternalId(h('alice@example.com')), name: 'Alice A',
      state: { source: 'google_calendar', email: 'alice@example.com', emailHash: h('alice@example.com') }, sensitivity: 'personal', taintedPaths: ['name', 'state.email'],
    });
    // No display name (or a blank one): the address is the name, tainted like any name.
    expect(people[1]!.name).toBe('bob@example.com');
    expect(people[3]!.name).toBe('carol@example.com');
    expect(people[2]!.name).toHaveLength(100);
    // Commitments first, so PersonGuard finds the commitment that names each person.
    const firstPerson = r.observations.findIndex((o) => o.kind === 'person');
    expect(r.observations.slice(firstPerson).every((o) => o.kind === 'person')).toBe(true);
  });

  it("nothing Will did not write reaches a key, a name, an externalId, a state or an event payload", () => {
    const r = map([
      ev('s1', { summary: 'TOPSECRET merger talk', attendees: [me, { email: 'zed@corp.example', displayName: 'Zed Quux' }], ...timed(at(HOUR), at(2 * HOUR)) }),
      ev('s2', { summary: 'TOPSECRET filing due', ...allDay('2026-10-05', '2026-10-06') }),
      ev('s3', { summary: 'TOPSECRET', organizer: { self: true }, attendees: [{ email: 'yan@corp.example', displayName: 'Yan TOPSECRET' }], ...allDay('2026-10-06', '2026-10-07') }),
      ev('bad id!', { summary: 'TOPSECRET' }),
    ]);
    expect(r.events.length).toBeGreaterThan(0);
    const outside = r.observations.map((o) => {
      const { texts: _texts, ...rest } = o;
      // A person's own row holds their name and address, tainted; only its key and id are checked here.
      return o.kind === 'person' ? { key: o.key, externalId: o.externalId, state: { ...o.state, email: undefined } } : rest;
    });
    expect(JSON.stringify([outside, r.events, r.errors])).not.toMatch(/TOPSECRET|@|Zed|Yan|corp/);
    // The title is in texts, which goes to EntityText.
    expect(commitment(r.observations, 's1')!.texts).toEqual({ title: 'TOPSECRET merger talk' });
    expect(byKey(r.observations, 'deadline:google_calendar:s2')!.texts).toEqual({ title: 'TOPSECRET filing due' });
  });

  it('texts: the title clipped to 300 and made storable; none when it is blank', () => {
    // The NUL goes first; the cut at 300 then falls inside the emoji, and never keeps half of it.
    const long = `\u0000${'x'.repeat(299)}😀tail`;
    const r = map([ev('t1', { summary: long }), ev('t2', { summary: '   ' }), ev('t3', { summary: 'half \uD800 pair' })]);
    expect(commitment(r.observations, 't1')!.texts).toEqual({ title: 'x'.repeat(299) });
    expect(commitment(r.observations, 't2')).not.toHaveProperty('texts');
    expect(commitment(r.observations, 't3')!.texts).toEqual({ title: 'half � pair' });
  });
});

describe('google_calendar: the source', () => {
  it('asks for the next 14 days of the primary calendar, GET only, with the token from accessToken', async () => {
    const g = fakeGoogle({ '': { items: [ev('a1')] } });
    const calls: Array<[SourceRun['fetch'], Date]> = [];
    const src = googleCalendarSource({ tz: TZ, accessToken: async (f, now) => (calls.push([f, now]), TOKEN) });
    expect([src.name, src.cadenceMs]).toEqual(['google_calendar', 5 * 60_000]);
    const run = runOf(g.fetch);
    const res = await src.run(run);
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe(run.fetch);
    expect(calls[0]![1]).toBe(NOW);
    expect(g.seen).toHaveLength(1);
    const { url, method, headers, signal } = g.seen[0]!;
    expect(`${url.origin}${url.pathname}`).toBe(`${GOOGLE_API}${CALENDAR_EVENTS_PATH}`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      timeMin: '2026-10-05T15:00:00.000Z', timeMax: '2026-10-19T15:00:00.000Z', singleEvents: 'true', orderBy: 'startTime', showDeleted: 'false', maxResults: '250',
      fields: 'items(id,status,summary,start,end,attendees(email,displayName,self,responseStatus,resource,organizer),organizer(self),eventType,updated,recurringEventId),nextPageToken',
    });
    expect(method).toBe('GET');
    expect(headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(signal).toBe(run.signal);
    expect(res.observations.map((o) => o.key)).toEqual(['commitment:google_calendar:a1']);
    expect(res.errors).toBeUndefined();

    // The endpoint list admits exactly that request.
    expect(allowed(CALENDAR_ENDPOINTS, url.toString(), 'GET')).toBe(true);
    expect(allowed(CALENDAR_ENDPOINTS, url.toString(), 'POST')).toBe(false);
    expect(allowed(CALENDAR_ENDPOINTS, `${GOOGLE_API}/calendar/v3/users/me/calendarList`, 'GET')).toBe(false);
    expect(allowed(CALENDAR_ENDPOINTS, `${GOOGLE_API}/gmail/v1/users/me/messages`, 'GET')).toBe(false);
    const scoped = scopedFetch(CALENDAR_ENDPOINTS, g.fetch as unknown as typeof fetch);
    await expect(source().run(runOf(scoped))).resolves.toMatchObject({ observations: [{ key: 'commitment:google_calendar:a1' }] });

    // A shorter window reaches less far.
    const g3 = fakeGoogle({ '': { items: [] } });
    await source({ windowDays: 3 }).run(runOf(g3.fetch));
    expect(g3.seen[0]!.url.searchParams.get('timeMax')).toBe('2026-10-08T15:00:00.000Z');
  });

  it('refuses options it cannot use', () => {
    expect(() => source({ tz: 'Mars/Olympus_Mons' })).toThrow();
    expect(() => source({ windowDays: 0 })).toThrow();
    expect(() => source({ maxPages: 1.5 })).toThrow();
  });

  it('follows nextPageToken, then archives what left the listing (declined included) as it was last known', async () => {
    const g = fakeGoogle({
      '': { items: [ev('pg1', { attendees: [me] })], nextPageToken: 'tok-2' },
      'tok-2': { items: [ev('pg2', { summary: 'Taxes due' }), ev('dec', { attendees: [{ ...me, responseStatus: 'declined' }] })] },
    });
    const asked: string[] = [];
    const known = [
      knownCommitment('pg1'), knownCommitment('dec'), knownCommitment('gone1'), knownDeadline('old'),
      // Another source's deadline is not this source's to close.
      { key: 'deadline:github:wpf002/flint:milestone:3', name: 'v1', taintedPaths: ['name'], state: { dueOn: '2026-10-01', source: 'github' } },
    ];
    const res = await source().run(runOf(g.fetch, { known, asked }));
    expect(g.seen.map((s) => s.url.searchParams.get('pageToken'))).toEqual([null, 'tok-2']);
    const { pageToken: _p, ...second } = Object.fromEntries(g.seen[1]!.url.searchParams);
    expect(second).toEqual(Object.fromEntries(g.seen[0]!.url.searchParams));
    expect(res.errors).toBeUndefined();
    expectValid(res.observations);
    expect(res.observations.filter((o) => o.status !== 'archived').map((o) => o.key)).toEqual(['commitment:google_calendar:pg1', 'deadline:google_calendar:pg2']);
    expect(res.observations.filter((o) => o.status === 'archived')).toEqual([
      { type: 'commitment.state', kind: 'commitment', key: 'commitment:google_calendar:dec', name: knownCommitment('dec').name, state: knownCommitment('dec').state, status: 'archived', externalId: 'event:dec', sensitivity: 'personal', taintedPaths: [] },
      { type: 'commitment.state', kind: 'commitment', key: 'commitment:google_calendar:gone1', name: knownCommitment('gone1').name, state: knownCommitment('gone1').state, status: 'archived', externalId: 'event:gone1', sensitivity: 'personal', taintedPaths: [] },
      { type: 'deadline.state', kind: 'deadline', key: 'deadline:google_calendar:old', name: 'deadline 2026-10-04', state: { dueOn: '2026-10-04', source: 'google_calendar' }, status: 'archived', externalId: 'deadline:old', sensitivity: 'personal', taintedPaths: [] },
    ]);
    // People are never archived here (not even asked about).
    expect(asked).toEqual(['commitment', 'deadline']);
  });

  it('an incomplete listing (maxPages reached) archives nothing, and says so', async () => {
    const g = fakeGoogle({ '': { items: [ev('pg1')], nextPageToken: 'tok-2' }, 'tok-2': { items: [ev('pg2')] } });
    const asked: string[] = [];
    const res = await source({ maxPages: 1 }).run(runOf(g.fetch, { known: [knownCommitment('gone1')], asked }));
    expect(g.seen).toHaveLength(1);
    expect(res.observations.map((o) => [o.key, o.status])).toEqual([['commitment:google_calendar:pg1', undefined]]);
    expect(asked).toEqual([]);
    expect(res.errors).toEqual(['google calendar: more than 250 events in the next 14 days; the rest are not read and nothing is archived']);
  });

  it('a malformed item is set aside, reported, and blocks archiving', async () => {
    const g = fakeGoogle({ '': { items: [ev('ok1'), ev('bad', { start: { dateTime: 'soon' } })] } });
    const asked: string[] = [];
    const res = await source().run(runOf(g.fetch, { known: [knownCommitment('gone1')], asked }));
    expect(res.observations.map((o) => o.key)).toEqual(['commitment:google_calendar:ok1']);
    expect(res.errors).toHaveLength(1);
    expect(res.errors![0]).toMatch(/item 1 .*start\.dateTime/);
    expect(asked).toEqual([]);
  });

  it('a failed page fails the whole run, never quoting the token', async () => {
    for (const [pages, message] of [
      [{ '': 401 }, 'google calendar answered 401'],
      [{ '': { items: [ev('pg1')], nextPageToken: 'tok-2' }, 'tok-2': 500 }, 'google calendar answered 500'],
      [{ '': '<html>not json</html>' }, 'google calendar: not an events page'],
      [{ '': { items: 'nope' } }, 'google calendar: not an events page'],
    ] as Array<[Record<string, unknown>, string]>) {
      const g = fakeGoogle(pages);
      const err = await source().run(runOf(g.fetch)).catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe(message);
      expect((err as Error).message).not.toContain(TOKEN);
    }
    // A token Headers would refuse (and quote) never reaches it.
    const g = fakeGoogle({});
    const err = await source({ accessToken: async () => 'ya29.secret\r\nX-Injected: 1' }).run(runOf(g.fetch)).catch((e: Error) => e);
    expect((err as Error).message).toBe('google calendar: the access token is not usable');
    expect(g.seen).toHaveLength(0);
  });

  it('the lag metric: the longest a change made since the last run took to arrive; the cursor is this run', async () => {
    const lastRunAt = at(-10 * MIN);
    const items = [
      ev('l1', { updated: at(-4 * MIN) }), ev('l2', { updated: at(-2 * MIN) }),
      ev('l3', { updated: at(-20 * MIN) }), ev('l4', { updated: at(MIN) }), ev('l5', { updated: 'yesterday' }),
      // A cancellation is a change that reached Flint too.
      { id: 'l6', status: 'cancelled', updated: at(-6 * MIN) },
    ];
    const g = fakeGoogle({ '': { items } });
    const res = await source().run(runOf(g.fetch, { cursor: JSON.stringify({ lastRunAt }) }));
    expect(res.metrics).toEqual([{
      series: { key: 'google_calendar.lag_ms', unit: 'ms', freq: 'raw', sensitivity: 'ops', description: 'how long a calendar change took to reach Flint (the longest this run)' },
      at: NOW, value: 6 * MIN,
    }]);
    expect(JSON.parse(res.cursor!)).toEqual({ lastRunAt: NOW.toISOString() });
    // An unparseable "updated" is no change time, and never a changedAt.
    expect(commitment(res.observations, 'l5')).not.toHaveProperty('changedAt');

    // Nothing changed since: no point. No cursor, or a malformed one: no point either (a first run is not lag).
    const quiet = fakeGoogle({ '': { items: [ev('q1', { updated: at(-20 * MIN) })] } });
    expect((await source().run(runOf(quiet.fetch, { cursor: JSON.stringify({ lastRunAt }) }))).metrics).toEqual([]);
    for (const cursor of [undefined, 'garbage', '{"lastRunAt":"not a time"}', 'null', '[]']) {
      const r = await source().run(runOf(fakeGoogle({ '': { items } }).fetch, cursor === undefined ? {} : { cursor }));
      expect(r.metrics, String(cursor)).toEqual([]);
      expect(JSON.parse(r.cursor!)).toEqual({ lastRunAt: NOW.toISOString() });
    }
    // A change stamped after now (clock skew) is a lag of 0, not a negative one.
    const skew = fakeGoogle({ '': { items: [ev('k1', { updated: at(MIN) })] } });
    expect((await source().run(runOf(skew.fetch, { cursor: JSON.stringify({ lastRunAt }) }))).metrics[0]!.value).toBe(0);
  });

  it('raises the upcoming events with the observations', async () => {
    const g = fakeGoogle({ '': { items: [ev('soon', { attendees: [me], ...timed(at(30 * MIN), at(90 * MIN)) })] } });
    const res = await source().run(runOf(g.fetch));
    expect(res.events!.map((e) => [e.type, e.sourceRef, e.payload.day, e.payload.time])).toEqual([['commitment.upcoming', 'upcoming:soon:2026-10-05T15:30:00.000Z', 'today', '10:30']]);
  });
});
