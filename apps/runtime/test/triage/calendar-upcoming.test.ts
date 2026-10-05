/**
 * The calendar's heads-up rule (P2.5), decided when triage runs, from the
 * event as it stands: an absolute date and time in Flint's zone; a deadline
 * due today or tomorrow by local day (a 25-hour fall-back day included); an
 * event within a day, or started under a quarter of an hour ago; logged when
 * it has passed, left the calendar, moved since it was raised, or a newer
 * heads-up for it exists.
 */
import { describe, it, expect } from 'vitest';
import { codeVerdict, type CodeRuleContext } from '../../src/triage/critical';
import { facts, noCode } from './helpers';

const TZ = 'America/Chicago';
const ctx = (now: string, later = false): CodeRuleContext => ({ ...noCode, now: new Date(now), tz: TZ, laterHeadsUp: async () => later });
const deadline = (dueOn: string, at = dueOn) =>
  facts({ source: 'google_calendar', type: 'deadline.upcoming', payload: { entityId: 'cent0000abc123', at } }, { kind: 'deadline', key: 'deadline:google_calendar:d1', state: { dueOn, source: 'google_calendar' } });
const event = (startsAt: string, o: { at?: string; allDay?: boolean; status?: string } = {}) =>
  facts(
    { source: 'google_calendar', type: 'commitment.upcoming', payload: { entityId: 'cent0000abc123', at: o.at ?? startsAt } },
    { kind: 'commitment', key: 'commitment:google_calendar:e1', status: o.status ?? 'active', state: { source: 'google_calendar', startsAt, endsAt: startsAt, allDay: o.allDay ?? false, response: 'accepted', eventStatus: 'confirmed', confirmation: 'confirmed' } },
  );

describe('the calendar heads-up', () => {
  it('a deadline due tomorrow is told in the first hour of a 25-hour fall-back day; one past due is logged', async () => {
    // 00:02 CDT on Sun 2026-11-01: tomorrow (Nov 2) starts 24 h 58 min from now, and is still tomorrow.
    expect(await codeVerdict(deadline('2026-11-02'), ctx('2026-11-01T05:02:00Z'))).toMatchObject({
      action: 'escalate', template: { id: 'calendar_upcoming', fields: { kind: 'deadline', date: '2026-11-02', time: null, until: '2026-11-03T06:00:00.000Z' } },
    });
    expect(await codeVerdict(deadline('2026-11-02'), ctx('2026-11-03T06:01:00Z'))).toMatchObject({ action: 'log', ruleName: 'calendar.upcoming.stale' });
    expect(await codeVerdict(deadline('2026-11-05'), ctx('2026-11-01T05:02:00Z'))).toMatchObject({ action: 'log', ruleName: 'calendar.upcoming.stale' });
  });

  it('an event: its local date and time, decided now; passed, gone, moved or overtaken, it is logged', async () => {
    // 10:00 CDT on Mon Oct 5; the event at 14:30 CDT.
    const now = '2026-10-05T15:00:00Z';
    expect(await codeVerdict(event('2026-10-05T19:30:00.000Z'), ctx(now))).toMatchObject({
      action: 'escalate', template: { fields: { kind: 'commitment', date: '2026-10-05', time: '14:30', until: '2026-10-05T19:30:00.000Z' } },
    });
    // All day: no time.
    expect(await codeVerdict(event('2026-10-06T05:00:00.000Z', { allDay: true }), ctx(now))).toMatchObject({ template: { fields: { date: '2026-10-06', time: null } } });
    // Started 20 minutes ago, or more than a day away: not news.
    expect(await codeVerdict(event('2026-10-05T14:40:00.000Z'), ctx(now))).toMatchObject({ action: 'log', ruleName: 'calendar.upcoming.stale' });
    expect(await codeVerdict(event('2026-10-06T15:01:00.000Z'), ctx(now))).toMatchObject({ action: 'log', ruleName: 'calendar.upcoming.stale' });
    // Off the calendar since it was raised.
    expect(await codeVerdict(event('2026-10-05T19:30:00.000Z', { status: 'archived' }), ctx(now))).toMatchObject({ action: 'log', ruleName: 'calendar.upcoming.stale' });
    // Raised for 14:30, the event is at 15:30 now: the heads-up raised for 15:30 tells it.
    expect(await codeVerdict(event('2026-10-05T20:30:00.000Z', { at: '2026-10-05T19:30:00.000Z' }), ctx(now))).toMatchObject({ action: 'log', ruleName: 'calendar.upcoming.moved' });
    // A newer heads-up for it exists (moved away and back): that one tells it.
    expect(await codeVerdict(event('2026-10-05T19:30:00.000Z'), ctx(now, true))).toMatchObject({ action: 'log', ruleName: 'calendar.upcoming.moved' });
    // Without a clock and a zone (an older caller), nothing is told.
    expect(await codeVerdict(event('2026-10-05T19:30:00.000Z'), noCode)).toMatchObject({ action: 'log' });
  });
});
