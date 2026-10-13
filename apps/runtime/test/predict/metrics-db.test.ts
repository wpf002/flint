/**
 * The daily and weekly numbers Flint forecasts, on flint_test (P4 part 3): each
 * series built from world rows as a source writes them, in Flint's zone.
 *
 *  - Each series from fixture rows: spend, deploys, service downtime, open
 *    threads, calendar hours, weekly commits.
 *  - A 23-hour and a 25-hour day are each one day, stamped at its own midnight.
 *  - Idempotent: a second run writes nothing, and a number once written does
 *    not move.
 *  - It backfills on the first run, and then reads only what is new: each
 *    number remembers where it was read to, so a blank day is read once and
 *    the night's read does not grow with the history.
 *  - A day the runtime was down is missing, never zero.
 *  - A forgotten series takes no points; today's number is never written.
 * Synthetic rows only. America/Chicago, with "now" fixed in March 2026.
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NO_DB, freshDb, id, type TestUrls } from '../db';
import { ledgerKit, type LedgerKit } from '../ledger/kit';
import { applyObservation } from '../../src/world/mapper';
import { FORECAST_SERIES, forecastSeries, freqOf } from '../../src/predict/series';
import { BACKFILL_DAYS, BACKFILL_WEEKS, MIN_UP_MS, dayIndex, materialise, stepDay, stepIndex, weekIndex, weekOf } from '../../src/predict/metrics';

const TZ = 'America/Chicago';
/** Thursday 2026-03-12, 10:00 in Chicago (CDT). */
const NOW = new Date('2026-03-12T15:00:00.000Z');
/** A Chicago wall time as an instant: CST (UTC-6) until 2026-03-08 02:00, CDT (UTC-5) after; and CDT before 2025-11-02 02:00. */
const chi = (day: string, hhmm = '00:00'): Date => {
  const cdt = day >= '2026-03-09' || day < '2025-11-02' || (day === '2026-03-08' && hhmm >= '03:00') || (day === '2025-11-02' && hhmm < '01:00');
  return new Date(`${day}T${hhmm}:00.000${cdt ? '-05:00' : '-06:00'}`);
};

describe('step arithmetic', () => {
  it('days and weeks are whole numbers in step; a week starts on its Monday', () => {
    expect(dayIndex('2026-03-12') - dayIndex('2026-03-11')).toBe(1);
    expect(dayIndex('2026-03-01') - dayIndex('2026-02-28')).toBe(1);
    expect(dayIndex('2028-03-01') - dayIndex('2028-02-28')).toBe(2);
    // 2026-03-12 is a Thursday: its week began Monday the 9th.
    expect([weekOf('2026-03-12'), weekOf('2026-03-09'), weekOf('2026-03-15'), weekOf('2026-03-16')]).toEqual(['2026-03-09', '2026-03-09', '2026-03-09', '2026-03-16']);
    expect(weekIndex('2026-03-16') - weekIndex('2026-03-15')).toBe(1);
    expect(weekIndex('2026-03-15')).toBe(weekIndex('2026-03-09'));
    const daily = { step: 'day' as const };
    const weekly = { step: 'week' as const };
    expect(stepDay(daily, stepIndex(daily, '2026-03-12'))).toBe('2026-03-12');
    expect(stepDay(weekly, stepIndex(weekly, '2026-03-12'))).toBe('2026-03-09');
    expect([BACKFILL_DAYS, BACKFILL_WEEKS, MIN_UP_MS / 3_600_000]).toEqual([400, 60, 4]);
  });
});

describe.skipIf(NO_DB)('the materialiser on flint_test', () => {
  let urls: TestUrls;
  let k: LedgerKit;
  const points = async (key: string) =>
    Object.fromEntries((await k.owner(`SELECT at, value FROM "MetricPoint" WHERE "seriesKey" = $1 ORDER BY at`, [key])).rows.map((r) => [(r.at as Date).toISOString(), r.value as number]));
  /** The series row for a registered number, as the Turn On card makes it. */
  async function registered(key: string) {
    const d = forecastSeries(key)!;
    await k.app(`INSERT INTO "MetricSeries" (key, unit, freq, sensitivity, description) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (key) DO NOTHING`, [d.key, d.unit, freqOf(d), d.sensitivity, d.description]);
    return key;
  }
  const observe = (kind: string, key: string, state: Record<string, unknown>, at: Date, o: { status?: 'active' | 'archived'; source?: string; sensitivity?: 'ops' | 'personal' } = {}) =>
    k.db.$transaction((tx) => applyObservation(tx, { kind, key, name: key, state, source: o.source ?? 'launchd', externalId: key, observedAt: at, actor: 'source:test', ...(o.status ? { status: o.status } : {}), ...(o.sensitivity ? { sensitivity: o.sensitivity } : {}) }));
  /** The runtime was up from `from` to `to`. */
  const up = (from: Date, to: Date) => k.db.runtimeInstance.create({ data: { id: id('ri'), gitSha: 'dev', startedAt: from, lastBeatAt: to, stoppedAt: to } });
  const run = (keys: string[], over: Partial<Parameters<typeof materialise>[0]> = {}) => materialise({ db: k.db, tz: TZ, now: NOW, ...over }, keys);
  /** Where a number has been read to (the first instant not read yet), and a way to make it forget, so a test can read the past again. */
  const readTo = async (key: string) => (await k.db.metricSeries.findUniqueOrThrow({ where: { key }, select: { readTo: true } })).readTo;
  const unread = (key: string) => k.app(`UPDATE "MetricSeries" SET "readTo" = NULL WHERE key = $1`, [key]);

  beforeAll(async () => {
    urls = await freshDb();
    k = await ledgerKit(urls);
    // Up the whole time, but for one day: Wednesday 2026-03-04 (down from Tuesday 23:00 to Thursday 01:00).
    await up(chi('2025-10-01'), chi('2026-03-03', '23:00'));
    await up(chi('2026-03-05', '01:00'), NOW);
  });
  afterAll(async () => k?.db.$disconnect());

  it('spend: the day\'s last reading of the running total; a day with no reading is 0 only after a 0; older days come from the daily roll-up', async () => {
    const key = await registered('daily.spend.anthropic.usd');
    const raw = 'spend.anthropic.day.usd';
    await k.app(`INSERT INTO "MetricSeries" (key, unit, freq, sensitivity, description) VALUES ($1, 'usd', 'raw', 'financial', 'synthetic'), ($2, 'usd', 'D', 'financial', 'synthetic (daily)')`, [raw, `${raw}.daily`]);
    const reading = (day: string, hhmm: string, value: number, series = raw) => k.app(`INSERT INTO "MetricPoint" ("seriesKey", at, value) VALUES ($1, $2, $3)`, [series, chi(day, hhmm), value]);
    // Retention's roll-up for a day long ago (stamped at that day's midnight).
    await reading('2026-01-20', '00:00', 2.5, `${raw}.daily`);
    // Friday the 6th: three readings, the last one counts. Saturday: back to 0 just after midnight, then one purchase.
    await reading('2026-03-06', '09:15', 0.4);
    await reading('2026-03-06', '13:00', 1.1);
    await reading('2026-03-06', '23:58', 1.37);
    await reading('2026-03-07', '00:01', 0);
    await reading('2026-03-07', '16:20', 0.25);
    // Sunday the 8th (the 23-hour day): reset to 0 at 00:01, nothing bought. Monday the 9th: no reading at all (still 0).
    await reading('2026-03-08', '00:01', 0);
    // Tuesday the 10th: a purchase late in the evening. Wednesday the 11th: no reading at all, after a day that ended above 0.
    await reading('2026-03-10', '21:30', 3.2);
    const r = await run([key]);
    expect(r.failed).toEqual([]);
    const p = await points(key);
    expect(p[chi('2026-01-20').toISOString()]).toBe(2.5);
    expect(p[chi('2026-03-06').toISOString()]).toBe(1.37);
    expect(p[chi('2026-03-07').toISOString()]).toBe(0.25);
    // Each day is stamped at its own local midnight: 06:00Z in winter, 05:00Z once the clocks have moved.
    expect(chi('2026-03-08').toISOString()).toBe('2026-03-08T06:00:00.000Z');
    expect(chi('2026-03-09').toISOString()).toBe('2026-03-09T05:00:00.000Z');
    expect(p['2026-03-08T06:00:00.000Z']).toBe(0);
    expect(p['2026-03-09T05:00:00.000Z']).toBe(0);
    expect(p[chi('2026-03-10').toISOString()]).toBe(3.2);
    // After a day that ended at $3.20, a day with no reading is a day nothing was reading: missing, never 0.
    expect(p[chi('2026-03-11').toISOString()]).toBeUndefined();
    // After the roll-up day ($2.50) and before the 6th there were no readings: missing too.
    expect(p[chi('2026-02-10').toISOString()]).toBeUndefined();
    // Today's number is never written.
    expect(p[chi('2026-03-12').toISOString()]).toBeUndefined();
    expect(Object.keys(p)).toHaveLength(6);
    expect(r.written[key]).toBe(6);
    // A vendor nothing was ever read for has no numbers at all.
    const other = await registered('daily.spend.tavily.usd');
    expect((await run([other])).written[other]).toBe(0);
    expect(await points(other)).toEqual({});
  });

  it('deploys: a new sha counts on the local day it was seen, and so does a deployment first seen, but not on the first day its place was read; a change of status alone does not', async () => {
    const key = await registered('daily.deploys.count');
    const dep = (sha: string, status: string, at: Date) => observe('deployment', 'deployment:studio:flint', { target: 'studio', status, sha }, at, { source: 'git' });
    await dep('a'.repeat(40), 'success', chi('2026-03-02', '10:00'));
    await dep('b'.repeat(40), 'deploying', chi('2026-03-02', '15:00'));
    await dep('b'.repeat(40), 'success', chi('2026-03-02', '15:04'));
    // 23:30 on Saturday the 7th and 00:30 on Sunday the 8th are two days.
    await dep('c'.repeat(40), 'success', chi('2026-03-07', '23:30'));
    await dep('d'.repeat(40), 'success', chi('2026-03-08', '00:30'));
    // 01:30 and 03:30 on the 23-hour day are the same day (02:00 to 03:00 does not exist).
    await dep('e'.repeat(40), 'success', chi('2026-03-08', '03:30'));
    await dep('f'.repeat(40), 'failed', chi('2026-03-10', '09:00'));
    // Railway is turned on on Tuesday the 10th: its two services are seen for the first time at once. They were already
    // deployed: neither is a deploy (review finding 15). The next day one of them gets a new sha, and a third service
    // is seen for the first time: on a later day than the place's first, that is one.
    const rail = (name: string, sha: string, at: Date) => observe('deployment', `deployment:railway:${name}`, { target: 'railway', status: 'success', sha }, at, { source: 'railway' });
    await rail('web', '1'.repeat(40), chi('2026-03-10', '14:00'));
    await rail('api', '2'.repeat(40), chi('2026-03-10', '14:00'));
    await rail('web', '3'.repeat(40), chi('2026-03-11', '09:00'));
    await rail('jobs', '4'.repeat(40), chi('2026-03-11', '16:00'));
    const r = await run([key]);
    const p = await points(key);
    // Monday the 2nd: the Studio's deployment is first seen (it was already there: not a deploy), then one new sha
    // (the status change is not a deploy either).
    expect(p[chi('2026-03-02').toISOString()]).toBe(1);
    expect(p[chi('2026-03-03').toISOString()]).toBe(0);
    expect(p[chi('2026-03-07').toISOString()]).toBe(1);
    expect(p[chi('2026-03-08').toISOString()]).toBe(2);
    expect(p[chi('2026-03-09').toISOString()]).toBe(0);
    // Tuesday the 10th: the Studio's new sha, and not Railway's two first sightings.
    expect(p[chi('2026-03-10').toISOString()]).toBe(1);
    // Wednesday the 11th: Railway's new sha, and its new service.
    expect(p[chi('2026-03-11').toISOString()]).toBe(2);
    // Before Flint ever saw a deployment there is nothing to count, and no zero is written.
    expect(p[chi('2026-03-01').toISOString()]).toBeUndefined();
    // Wednesday the 4th: the runtime was down all day. Nothing was watching: missing, never 0.
    expect(p[chi('2026-03-04').toISOString()]).toBeUndefined();
    expect(r.down).toBe(1);
    expect(Object.keys(p)).toHaveLength(9);
    for (const v of Object.values(p)) expect(Number.isInteger(v)).toBe(true);
  });

  it('service downtime: minutes any of Flint\'s or Nexus\'s services was down, across midnight, counted once when two are down together', async () => {
    const key = await registered('daily.services.incident_minutes');
    const svc = (name: string, running: boolean, at: Date, disabled = false) => observe('service', `service:launchd:${name}`, { managedBy: 'launchd', running, disabled }, at);
    await svc('com.flint.server', true, chi('2026-03-01', '08:00'));
    await svc('com.nexus.worker', true, chi('2026-03-01', '08:00'));
    // The server: down from 23:40 on Thursday the 5th to 00:25 on Friday the 6th (20 minutes, then 25).
    await svc('com.flint.server', false, chi('2026-03-05', '23:40'));
    await svc('com.flint.server', true, chi('2026-03-06', '00:25'));
    // Tuesday the 10th: the server down 10:00 to 10:30, the worker 10:20 to 11:00. Together: 10:00 to 11:00, one hour.
    await svc('com.flint.server', false, chi('2026-03-10', '10:00'));
    await svc('com.nexus.worker', false, chi('2026-03-10', '10:20'));
    await svc('com.flint.server', true, chi('2026-03-10', '10:30'));
    await svc('com.nexus.worker', true, chi('2026-03-10', '11:00'));
    // A service put away on purpose is not down, and neither is one of somebody else's: each is seen "down" for two
    // hours of Monday the 9th (seen then, and seen again two hours on), and neither adds a minute to it.
    await svc('com.flint.voice', false, chi('2026-03-09', '09:00'), true);
    await svc('com.flint.voice', true, chi('2026-03-09', '11:00'), true);
    await observe('service', 'service:launchd:homebrew.mxcl.postgresql', { managedBy: 'brew', running: false, disabled: false }, chi('2026-03-09', '09:00'));
    await observe('service', 'service:launchd:homebrew.mxcl.postgresql', { managedBy: 'brew', running: true, disabled: false }, chi('2026-03-09', '11:00'));
    // An endpoint: down by its health check for a quarter of an hour on the 11th.
    await observe('service', 'service:endpoint:flint-server', { managedBy: 'other', health: 'ok' }, chi('2026-03-01', '08:00'), { source: 'health' });
    await observe('service', 'service:endpoint:flint-server', { managedBy: 'other', health: 'down' }, chi('2026-03-11', '14:00'), { source: 'health' });
    await observe('service', 'service:endpoint:flint-server', { managedBy: 'other', health: 'ok' }, chi('2026-03-11', '14:15'), { source: 'health' });
    // Everything was seen again this morning.
    for (const n of ['com.flint.server', 'com.nexus.worker']) await svc(n, true, chi('2026-03-12', '09:00'));
    await run([key]);
    const p = await points(key);
    expect(p[chi('2026-03-05').toISOString()]).toBe(20);
    expect(p[chi('2026-03-06').toISOString()]).toBe(25);
    expect(p[chi('2026-03-09').toISOString()]).toBe(0);
    expect(p[chi('2026-03-10').toISOString()]).toBe(60);
    expect(p[chi('2026-03-11').toISOString()]).toBe(15);
    expect(p[chi('2026-03-02').toISOString()]).toBe(0);
    expect(p[chi('2026-03-04').toISOString()]).toBeUndefined();
    expect(p[chi('2026-02-28').toISOString()]).toBeUndefined();
  });

  it('open threads: how many were open at the day\'s end; nothing at all until Flint has seen a thread', async () => {
    const key = await registered('daily.threads.open');
    // Before Flint has seen a thread (here: on the 1st) there is nothing to write.
    expect((await run([key], { now: chi('2026-03-01', '10:00') })).written[key]).toBe(0);
    const thread = (n: number, status: 'open' | 'archived', at: Date) => observe('thread', `thread:nexus:t${n}`, { status }, at, { source: 'nexus', ...(status === 'archived' ? { status: 'archived' as const } : {}) });
    await thread(1, 'open', chi('2026-03-06', '09:00'));
    await thread(2, 'open', chi('2026-03-06', '23:59'));
    await thread(3, 'open', chi('2026-03-07', '00:01'));
    await thread(1, 'archived', chi('2026-03-09', '17:00'));
    await thread(2, 'archived', chi('2026-03-11', '08:00'));
    await run([key]);
    const p = await points(key);
    expect([p[chi('2026-03-06').toISOString()], p[chi('2026-03-07').toISOString()], p[chi('2026-03-08').toISOString()], p[chi('2026-03-09').toISOString()], p[chi('2026-03-10').toISOString()], p[chi('2026-03-11').toISOString()]])
      .toEqual([2, 3, 3, 2, 2, 1]);
    expect(p[chi('2026-03-05').toISOString()]).toBeUndefined();
  });

  it('calendar hours: the distinct hours of accepted or organized, confirmed, timed events, as each stood when it ended; one cancelled first is not counted', async () => {
    const key = await registered('daily.calendar.hours');
    const base = { source: 'apple_calendar', allDay: false, response: 'accepted', eventStatus: 'confirmed', confirmation: 'confirmed' };
    const event = (n: number, state: Record<string, unknown>, at: Date, status?: 'archived') =>
      observe('commitment', `commitment:apple_calendar:e${n}`, { ...base, ...state }, at, { source: 'apple_calendar', sensitivity: 'personal', ...(status ? { status } : {}) });
    const times = (day: string, from: string, to: string, endDay = day) => ({ startsAt: chi(day, from).toISOString(), endsAt: chi(endDay, to).toISOString() });
    // Monday the 9th: 9:00 to 10:30 (accepted) and 13:00 to 14:00 (Will's own). Put away after they ended.
    await event(1, times('2026-03-09', '09:00', '10:30'), chi('2026-03-05', '12:00'));
    await event(1, times('2026-03-09', '09:00', '10:30'), chi('2026-03-09', '10:35'), 'archived');
    await event(2, { ...times('2026-03-09', '13:00', '14:00'), response: 'organizer' }, chi('2026-03-05', '12:00'));
    // Not counted: an all-day event, one he has not answered, a tentative one, and one cancelled an hour before it began.
    await event(3, { ...times('2026-03-09', '00:00', '00:00', '2026-03-10'), allDay: true }, chi('2026-03-05', '12:00'));
    await event(4, { ...times('2026-03-09', '15:00', '16:00'), response: 'needs_action' }, chi('2026-03-05', '12:00'));
    await event(5, { ...times('2026-03-09', '16:00', '17:00'), eventStatus: 'tentative' }, chi('2026-03-05', '12:00'));
    await event(6, times('2026-03-09', '18:00', '19:00'), chi('2026-03-05', '12:00'));
    await event(6, times('2026-03-09', '18:00', '19:00'), chi('2026-03-09', '17:00'), 'archived');
    // Moved before it began: from Tuesday 10:00 to Wednesday 10:00, and half an hour longer. It counts where it ended up.
    await event(7, times('2026-03-10', '10:00', '11:00'), chi('2026-03-05', '12:00'));
    await event(7, times('2026-03-11', '10:00', '11:30'), chi('2026-03-09', '20:00'));
    // Across midnight: Tuesday 22:00 to Wednesday 01:30 is two hours on Tuesday and one and a half on Wednesday.
    await event(8, times('2026-03-10', '22:00', '01:30', '2026-03-11'), chi('2026-03-05', '12:00'));
    // Thursday the 5th (review finding 8): two that overlap, 14:00 to 15:00 and 14:30 to 15:30, are an hour and a half of
    // the day, not two hours; one inside another (16:00 to 18:00 and 16:30 to 17:00) is two hours; and two that only
    // touch (19:00 to 19:30, 19:30 to 20:00) are one.
    await event(9, times('2026-03-05', '14:00', '15:00'), chi('2026-03-05', '12:00'));
    await event(10, times('2026-03-05', '14:30', '15:30'), chi('2026-03-05', '12:00'));
    await event(11, times('2026-03-05', '16:00', '18:00'), chi('2026-03-05', '12:00'));
    await event(12, times('2026-03-05', '16:30', '17:00'), chi('2026-03-05', '12:00'));
    await event(13, times('2026-03-05', '19:00', '19:30'), chi('2026-03-05', '12:00'));
    await event(14, times('2026-03-05', '19:30', '20:00'), chi('2026-03-05', '12:00'));
    // A timed block of 36 hours, Friday the 6th 08:00 to Saturday the 7th 20:00, with a meeting inside it on each day:
    // Friday has the 16 hours from 08:00, Saturday its first 20, and neither counts the meeting twice.
    await event(15, times('2026-03-06', '08:00', '20:00', '2026-03-07'), chi('2026-03-05', '12:00'));
    await event(16, times('2026-03-06', '10:00', '11:00'), chi('2026-03-05', '12:00'));
    await event(17, times('2026-03-07', '09:00', '12:00'), chi('2026-03-05', '12:00'));
    // A block that covers the whole of the 23-hour Sunday the 8th and more, beside another that does too: 23 hours, never more.
    await event(18, times('2026-03-07', '22:00', '06:00', '2026-03-09'), chi('2026-03-05', '12:00'));
    await event(19, times('2026-03-07', '23:00', '05:00', '2026-03-09'), chi('2026-03-05', '12:00'));
    // Moved after it began, before it ended: Wednesday the 11th, 14:00 to 15:00, moved at 14:20 to 16:00 to 17:00. It
    // counts at its new time (an hour, once). Moved after it ended: 18:00 to 18:30 on the 11th, moved the next morning
    // to the 12th. What is done is done: it counts on the 11th, as it stood when it ended.
    await event(20, times('2026-03-11', '14:00', '15:00'), chi('2026-03-05', '12:00'));
    await event(20, times('2026-03-11', '16:00', '17:00'), chi('2026-03-11', '14:20'));
    await event(21, times('2026-03-11', '18:00', '18:30'), chi('2026-03-05', '12:00'));
    await event(21, times('2026-03-12', '18:00', '18:30'), chi('2026-03-12', '08:00'));
    await run([key]);
    const p = await points(key);
    // Monday the 9th: its own 2.5 hours, and the 6 hours before 06:00 that the long block still covers.
    expect(p[chi('2026-03-09').toISOString()]).toBe(8.5);
    expect(p[chi('2026-03-10').toISOString()]).toBe(2);
    // Wednesday the 11th: 00:00 to 01:30, 10:00 to 11:30, the moved hour at 16:00, and the half hour at 18:00.
    expect(p[chi('2026-03-11').toISOString()]).toBe(4.5);
    expect(p[chi('2026-03-05').toISOString()]).toBe(4.5);
    expect(p[chi('2026-03-06').toISOString()]).toBe(16);
    // Saturday the 7th: 00:00 to 20:00 of the block, and 22:00 to midnight of the next one.
    expect(p[chi('2026-03-07').toISOString()]).toBe(22);
    expect(p[chi('2026-03-08').toISOString()]).toBe(23);
    for (const v of Object.values(p)) expect(v).toBeLessThanOrEqual(24);
    // (A day with nothing on it is 0, once the calendar has been read at all: from the 5th. Here every day had something.)
    expect(p[chi('2026-03-03').toISOString()]).toBeUndefined();
    // No title, no attendee and no event id is anywhere in what was written: a point is a time and a number.
    expect(JSON.stringify(p)).not.toMatch(/commitment|apple|e\d/);
  });

  it('weekly commits: the main branch\'s own, one fixed git command per missing week, Monday to Monday; quiet weeks before the first commit are left out, later ones are 0', async () => {
    const key = await registered('weekly.commits.flint.count');
    const calls: string[][] = [];
    // A clone of its own (it has a .git), whose main branch is origin's.
    const dir = mkdtempSync(join(tmpdir(), 'commits-'));
    mkdirSync(join(dir, 'flint', '.git'), { recursive: true });
    mkdirSync(join(dir, 'plain'));
    const path = join(dir, 'flint');
    // The clone had its first commit in the week of 2026-02-09; then 12, 0, 7, 3 a week.
    const byWeek: Record<string, number> = { '2026-02-09': 4, '2026-02-16': 12, '2026-02-23': 0, '2026-03-02': 7 };
    const git = async (_cmd: string, args: readonly string[]) => {
      calls.push([...args]);
      if (args.includes('for-each-ref')) return 'refs/remotes/origin/main\nrefs/heads/main\n';
      const since = args.find((a) => a.startsWith('--since='))!.slice('--since='.length);
      const monday = Object.keys(byWeek).find((d) => chi(d).toISOString() === since);
      return `${monday ? byWeek[monday] : 0}\n`;
    };
    const repos = [{ name: 'flint', path }];
    const r = await run([key], { run: git, repos });
    expect(r.failed).toEqual([]);
    const p = await points(key);
    expect(p).toEqual({
      [chi('2026-02-09').toISOString()]: 4, [chi('2026-02-16').toISOString()]: 12, [chi('2026-02-23').toISOString()]: 0, [chi('2026-03-02').toISOString()]: 7,
    });
    // One question about which branch is main, then one count a week. This week (it began Monday the 9th) is not over:
    // never asked for, never written.
    expect(calls[0]!.slice(0, 3)).toEqual(['-C', path, 'for-each-ref']);
    const counts = calls.slice(1);
    expect(counts).toHaveLength(60);
    expect(counts.every((a) => a.slice(0, 5).join(' ') === `-C ${path} rev-list --count --first-parent`)).toBe(true);
    // Main only (review finding 9): never every ref the clone happens to hold. A week ends a second before the next begins.
    expect(calls.flat()).not.toContain('--all');
    const last = counts[counts.length - 1]!;
    expect(last.slice(5)).toEqual([`--since=${chi('2026-03-02').toISOString()}`, `--before=${new Date(chi('2026-03-09').getTime() - 1000).toISOString()}`, 'refs/remotes/origin/main']);
    // The week the clocks moved is still Monday to Monday: 167 hours.
    expect((chi('2026-03-09').getTime() - chi('2026-03-02').getTime()) / 3_600_000).toBe(167);
    // A backfill and the night itself ask the same question of the same branch, so the series does not break at turn-on:
    // a week later one more week is over, and only it is asked for, in the same words. A quiet week is now a 0.
    calls.length = 0;
    const next = await run([key], { run: git, repos, now: new Date('2026-03-17T15:00:00.000Z') });
    expect(calls.filter((a) => a.includes('rev-list'))).toHaveLength(1);
    expect(calls.find((a) => a.includes('rev-list'))!.slice(0, 5)).toEqual(counts[0]!.slice(0, 5));
    expect(calls.find((a) => a.includes('rev-list'))!.at(-1)).toBe('refs/remotes/origin/main');
    expect(next.written[key]).toBe(1);
    expect((await points(key))[chi('2026-03-09').toISOString()]).toBe(0);
    // With no clone, no way to run git, a folder that is no clone of its own, or a clone with no main branch, nothing
    // is written and nothing fails; and the weeks are asked for again another night (nothing was read).
    const nexus = await registered('weekly.commits.nexus.count');
    expect(await run([nexus], { run: git, repos })).toMatchObject({ written: { [nexus]: 0 }, failed: [] });
    expect(await run([nexus])).toMatchObject({ written: { [nexus]: 0 }, failed: [] });
    expect(await run([nexus], { run: git, repos: [{ name: 'nexus', path: join(dir, 'plain') }] })).toMatchObject({ written: { [nexus]: 0 }, failed: [] });
    expect(await run([nexus], { run: async () => 'refs/heads/feature\n', repos: [{ name: 'nexus', path }] })).toMatchObject({ written: { [nexus]: 0 }, failed: [] });
    expect(await readTo(nexus)).toBeNull();
    // What git prints for a count that is not a number is refused, and the series is counted as failed, not written.
    const broken = async (_cmd: string, args: readonly string[]) => (args.includes('for-each-ref') ? 'refs/heads/main\n' : 'fatal: bad revision');
    expect(await run([nexus], { run: broken, repos: [{ name: 'nexus', path }] })).toMatchObject({ failed: [nexus] });
    expect(await points(nexus)).toEqual({});
    expect(await readTo(nexus)).toBeNull();
  });

  it('a 25-hour day is one day too, stamped at its own midnight', async () => {
    // Sunday 2025-11-02 in Chicago: clocks go back at 02:00. Its midnight is 05:00Z; the next day's is 06:00Z.
    expect(chi('2025-11-02').toISOString()).toBe('2025-11-02T05:00:00.000Z');
    expect(chi('2025-11-03').toISOString()).toBe('2025-11-03T06:00:00.000Z');
    const key = 'daily.deploys.count';
    // A deployment that was there the day before, deployed again at 23:30 that day, 24.5 hours after its midnight, and
    // once more 30 minutes into the next day.
    const dep = (sha: string, at: Date) => observe('deployment', 'deployment:railway:fall', { target: 'railway', status: 'success', sha }, at, { source: 'railway' });
    await dep('0'.repeat(40), new Date('2025-11-01T15:00:00.000Z'));
    await dep('1'.repeat(40), new Date('2025-11-03T05:30:00.000Z'));
    await dep('2'.repeat(40), new Date('2025-11-03T06:30:00.000Z'));
    // The points written so far begin in March: what came before the series' first number is not filled in afterwards,
    // and what was read is not read again. So the number forgets both, and is read from the start.
    await k.past('MetricPoint', 'USER', (q) => q(`DELETE FROM "MetricPoint" WHERE "seriesKey" = $1`, [key]));
    await unread(key);
    await run([key]);
    const p = await points(key);
    // Saturday the 1st: first seen, on what is now Railway's first day. Not a deploy.
    expect(p['2025-11-01T05:00:00.000Z']).toBe(0);
    expect(p['2025-11-02T05:00:00.000Z']).toBe(1);
    expect(p['2025-11-03T06:00:00.000Z']).toBe(1);
    expect(p['2025-11-04T06:00:00.000Z']).toBe(0);
    // And March is as it was, but for the 10th: read again with Railway known since November, its two services first
    // seen that day are no longer the place's first day, so they count beside the Studio's.
    expect(p[chi('2026-03-08').toISOString()]).toBe(2);
    expect(p[chi('2026-03-10').toISOString()]).toBe(3);
    expect(p[chi('2026-03-11').toISOString()]).toBe(2);
    expect(p[chi('2026-03-04').toISOString()]).toBeUndefined();
  });

  it('a second run writes nothing, and a number once written does not move when the world is read differently later', async () => {
    const keys = ['daily.deploys.count', 'daily.services.incident_minutes', 'daily.threads.open', 'daily.calendar.hours', 'daily.spend.anthropic.usd'];
    const before = Object.fromEntries(await Promise.all(keys.map(async (key) => [key, await points(key)] as const)));
    const again = await run(keys);
    expect(Object.values(again.written)).toEqual([0, 0, 0, 0, 0]);
    expect(again.failed).toEqual([]);
    // A deployment turns out to have happened on the 9th (seen late). The 9th was written as 0 and stays 0.
    await observe('deployment', 'deployment:railway:late', { target: 'railway', status: 'success', sha: '9'.repeat(40) }, chi('2026-03-09', '12:00'), { source: 'railway' });
    await run(keys);
    for (const key of keys) expect(await points(key), key).toEqual(before[key]);
  });

  it('the next night reads only what is new; a day the runtime was down stays missing, is read once and counted once, and the day after it is still written', async () => {
    const key = 'daily.deploys.count';
    // Read to the start of today (Thursday the 12th): everything before it has been read.
    expect((await readTo(key))!.toISOString()).toBe(chi('2026-03-12').toISOString());
    await up(NOW, new Date('2026-03-13T15:00:00.000Z'));
    await observe('deployment', 'deployment:studio:flint', { target: 'studio', status: 'success', sha: '7'.repeat(40) }, chi('2026-03-12', '11:00'), { source: 'git' });
    const tomorrow = await run([key], { now: new Date('2026-03-13T15:00:00.000Z') });
    expect(tomorrow).toMatchObject({ written: { [key]: 1 }, down: 0 });
    expect((await points(key))[chi('2026-03-12').toISOString()]).toBe(1);
    expect((await readTo(key))!.toISOString()).toBe(chi('2026-03-13').toISOString());
    // The runtime stops at 10:00 on Friday the 13th and stays off over the weekend. Friday had ten hours of it: written (0).
    // Saturday and Sunday had none: neither is written, by this run or any later one. Nor is the 4th, ever.
    const later = await run([key], { now: new Date('2026-03-16T15:00:00.000Z') });
    // Two days left missing: the weekend. The 4th was read and counted the night it was found blank, and is not read
    // or counted again (review finding 16: it was, every night, with everything after it).
    expect(later).toMatchObject({ written: { [key]: 1 }, down: 2 });
    const p = await points(key);
    expect(p[chi('2026-03-13').toISOString()]).toBe(0);
    for (const day of ['2026-03-04', '2026-03-14', '2026-03-15']) expect(p[chi(day).toISOString()], day).toBeUndefined();
    expect((await readTo(key))!.toISOString()).toBe(chi('2026-03-16').toISOString());
    // A second pass the same day reads nothing at all: no blank day is read or counted twice.
    expect(await run([key], { now: new Date('2026-03-16T16:00:00.000Z') })).toMatchObject({ written: { [key]: 0 }, down: 0 });
    // Up for under four hours of a day is still a day nothing was watching: the one new day, counted once.
    await up(chi('2026-03-16', '20:30'), chi('2026-03-16', '23:59'));
    expect(await run([key], { now: new Date('2026-03-17T15:00:00.000Z') })).toMatchObject({ written: { [key]: 0 }, down: 1 });
    expect(await run([key], { now: new Date('2026-03-17T18:00:00.000Z') })).toMatchObject({ written: { [key]: 0 }, down: 0 });
    // A reading that turns up later for a day already read does not move it: the day stays as it was left.
    await observe('deployment', 'deployment:studio:flint', { target: 'studio', status: 'success', sha: '8'.repeat(40) }, chi('2026-03-14', '12:00'), { source: 'git' });
    expect(await run([key], { now: new Date('2026-03-17T19:00:00.000Z') })).toMatchObject({ written: { [key]: 0 }, down: 0 });
    expect((await points(key))[chi('2026-03-14').toISOString()]).toBeUndefined();
  });

  it('the night\'s read does not grow: a service\'s or a thread\'s whole history is never loaded, only the day\'s changes and where each stood', async () => {
    // Service downtime and open threads used to load every version ever recorded, every night (review finding 16).
    const read: Array<{ model: string; where: Record<string, unknown> }> = [];
    const raw: string[] = [];
    const watching = new Proxy(k.db, {
      get(target, prop, receiver) {
        if (prop === 'entityVersion') {
          return new Proxy(target.entityVersion, {
            get: (model, fn) => (fn === 'findMany' || fn === 'findFirst'
              ? (args: { where: Record<string, unknown> }) => (read.push({ model: `entityVersion.${String(fn)}`, where: args.where }), (model[fn as 'findMany'] as (a: unknown) => unknown)(args))
              : Reflect.get(model, fn)),
          });
        }
        if (prop === '$queryRaw') return (strings: TemplateStringsArray, ...values: unknown[]) => (raw.push(strings.join('?')), target.$queryRaw(strings, ...values));
        return Reflect.get(target, prop, receiver);
      },
    });
    const keys = ['daily.services.incident_minutes', 'daily.threads.open'];
    const before = Object.fromEntries(await Promise.all(keys.map(async (key) => [key, await points(key)] as const)));
    // The next night: one day is new.
    await up(new Date('2026-03-17T15:00:00.000Z'), new Date('2026-03-18T15:00:00.000Z'));
    const r = await materialise({ db: watching, tz: TZ, now: new Date('2026-03-18T15:00:00.000Z') }, keys);
    expect(r.failed).toEqual([]);
    // Every read of versions through the client is bounded: the first version of each item (when it was first seen),
    // or the versions that began inside the days being read. None asks for all of them.
    const from = chi('2026-03-12').getTime();
    expect(read.length).toBeGreaterThanOrEqual(4);
    for (const q of read) {
      const w = q.where as { version?: number; validFrom?: { gte?: Date; lt?: Date } };
      const bounded = w.version === 1 || (w.validFrom?.gte instanceof Date && w.validFrom.gte.getTime() >= from && w.validFrom.lt instanceof Date);
      expect(bounded, JSON.stringify(q)).toBe(true);
    }
    // And where each item stood when those days began is one row an item, read backwards from its latest.
    const standing = raw.filter((q) => q.includes('"EntityVersion"'));
    expect(standing.length).toBeGreaterThanOrEqual(2);
    for (const q of standing) expect(q).toMatch(/ORDER BY v\.version DESC LIMIT 1/);
    // What it wrote is right: the days since the last read, and nothing before them moved.
    const after = Object.fromEntries(await Promise.all(keys.map(async (key) => [key, await points(key)] as const)));
    for (const key of keys) for (const [at, v] of Object.entries(before[key]!)) expect(after[key]![at], `${key} ${at}`).toBe(v);
    // Threads 1 and 2 were archived before the 12th, thread 3 is still open: one open, by the version that stood then.
    expect(after['daily.threads.open']![chi('2026-03-17').toISOString()]).toBe(1);
    expect(after['daily.services.incident_minutes']![chi('2026-03-17').toISOString()]).toBe(0);
  });

  it('a forgotten series takes no more points; a key that is not registered, or whose row is not the registry\'s, is left alone', async () => {
    const eid = await k.entity();
    // A registered number whose row was made tied to an item, which Will then forgot.
    const key = 'daily.spend.openai.usd';
    await k.app(`INSERT INTO "MetricSeries" (key, "entityId", unit, freq, sensitivity, description) VALUES ($1, $2, 'usd', 'D', 'financial', 'synthetic')`, [key, eid]);
    await k.app(`INSERT INTO "MetricSeries" (key, unit, freq, sensitivity, description) VALUES ('spend.openai.day.usd', 'usd', 'raw', 'financial', 'synthetic')`);
    await k.app(`INSERT INTO "MetricPoint" ("seriesKey", at, value) VALUES ('spend.openai.day.usd', $1, 0.75)`, [chi('2026-03-10', '12:00')]);
    await k.forget(eid);
    expect(await run([key])).toMatchObject({ skipped: 1, written: {} });
    expect(await points(key)).toEqual({});
    // Not in the registry; registered but with no row; and a row under a registered key with another step.
    const odd = await k.series({ key: `test.${id('k')}.count` });
    await k.app(`INSERT INTO "MetricSeries" (key, unit, freq, sensitivity, description) VALUES ('weekly.commits.helm.count', 'count', 'D', 'ops', 'not the registry''s')`);
    expect(await run([odd, 'daily.spend.perplexity.usd', 'weekly.commits.helm.count'])).toMatchObject({ skipped: 3, written: {}, failed: [] });
    // Every registered number has something it is built from.
    expect(FORECAST_SERIES.map((s) => s.from.kind).sort()).toEqual(['calendar', 'commits', 'commits', 'commits', 'commits', 'deploys', 'incidents', 'spend', 'spend', 'spend', 'spend', 'threads']);
  });
});
