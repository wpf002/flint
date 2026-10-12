/**
 * The daily and weekly numbers Flint forecasts (P4 part 3; queue
 * forecast.series): each registered series' value for every whole local day
 * (or week) that is over, built from rows Flint already holds. No text is
 * read, nothing leaves this Mac, and a log line or an audit entry carries keys
 * and counts, never a value.
 *
 *   series                           one step's value
 *   daily.spend.<vendor>.usd         the day's last reading of that vendor's running total
 *   daily.deploys.count              deployments first seen, or seen with a new sha, that day
 *   weekly.commits.<repo>.count      commits in Will's clone that week (git rev-list --count; never a fetch)
 *   daily.services.incident_minutes  minutes any of Flint's or Nexus's services was down that day
 *   daily.threads.open               threads open at the day's end
 *   daily.calendar.hours             hours of accepted, confirmed events that day (never an all-day one)
 *
 * Rules that hold for all of them:
 *  - A day is the local day in Flint's zone, and its point is stamped with the
 *    day's first instant (a week: its Monday's). A 23- or 25-hour day is one day.
 *  - Only steps that are over. Today's number is never written.
 *  - A number is written once and never rewritten (createMany, skipDuplicates),
 *    so a second run changes nothing and history does not move under a forecast.
 *  - It backfills: every past step its sources still cover, up to 400 days (60
 *    weeks), on the first run and after any gap.
 *  - A day the runtime was down for more than 20 hours is left MISSING, never
 *    written as zero: nothing was watching, so "no deploys" would be a guess.
 *    (A week of commits is read from the clone itself, so it needs no watcher.)
 *  - A forgotten series takes no more points.
 *
 * The world is read as it stood: a service's minutes from the versions valid
 * that day, a thread from the version valid at the day's end, an event from
 * how it stood when it ended (one cancelled before it ended is not counted).
 */
import { addLocalDays, localDay, localDayBounds } from '@flint/policy';
import type { Db } from '../db.js';
import { uptime } from '../health/instance.js';
import { isDown } from '../health/watchdog.js';
import type { Run } from '../sources/exec.js';
import { commitsBetween } from '../sources/git.js';
import { FORECAST_SERIES, freqOf, type ForecastSeriesDef } from './series.js';

const DAY_MS = 86_400_000;
/** How far back a first run (or a run after a gap) fills in. */
export const BACKFILL_DAYS = 400;
export const BACKFILL_WEEKS = 60;
/** A day with less than this much of the runtime up is left missing (down for more than 20 hours of a 24-hour day). */
export const MIN_UP_MS = 4 * 3_600_000;
/** Whose services count: Flint's own and Nexus's agents, and the health endpoints (as the watchdog reads them). */
const WATCHED = /^service:(launchd:com\.(flint|nexus)\.[A-Za-z0-9._-]+|endpoint:[A-Za-z0-9._-]+)$/;

const utcDay = (day: string): number => {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d) / DAY_MS;
};
/** A local day as a whole number of days (for the forecaster's step index): consecutive days are consecutive numbers. */
export const dayIndex = (day: string): number => utcDay(day) - utcDay('2001-01-01');
/** The Monday of the week a local day is in (2001-01-01 was a Monday). */
export const weekOf = (day: string): string => addLocalDays(day, -(((dayIndex(day) % 7) + 7) % 7));
/** A week as a whole number of weeks. */
export const weekIndex = (day: string): number => Math.floor(dayIndex(day) / 7);
/** A series' step index for the step that starts on a local day. */
export const stepIndex = (def: Pick<ForecastSeriesDef, 'step'>, day: string): number => (def.step === 'day' ? dayIndex(day) : weekIndex(day));
/** The local day a step starts on, from its index. */
export const stepDay = (def: Pick<ForecastSeriesDef, 'step'>, index: number): string => addLocalDays('2001-01-01', def.step === 'day' ? index : index * 7);

/** The local days from `from` up to (not including) `to`. */
function days(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d < to; d = addLocalDays(d, 1)) out.push(d);
  return out;
}

export interface MetricsDeps {
  db: Db;
  tz: string;
  now?: Date;
  /** Runs git (a fixed command, no shell). Absent: the commit series are skipped. */
  run?: Run;
  /** Will's clones, by the registry's repo name. */
  repos?: ReadonlyArray<{ name: string; path: string }>;
}

type Values = Map<string, number>;

/** Which of `want` days the runtime was up for at least 4 hours of. */
async function upDays(db: Db, tz: string, want: readonly string[]): Promise<Set<string>> {
  if (!want.length) return new Set();
  const from = localDayBounds(tz, want[0]!).start;
  const beats = await db.runtimeInstance.findMany({ where: { lastBeatAt: { gt: new Date(from.getTime() - 120_000) } }, select: { startedAt: true, lastBeatAt: true } });
  const up = new Set<string>();
  for (const day of want) {
    const { start, end } = localDayBounds(tz, day);
    if (uptime(beats, start, end) * (end.getTime() - start.getTime()) >= MIN_UP_MS) up.add(day);
  }
  return up;
}

/**
 * A vendor's spend per day: the last reading of its running total that day.
 * The spend source records the total only when it moves, so a day with no
 * reading at all is a day it stayed where it began, at 0, and that is only
 * known when the reading before it was 0 too (a total that ended a day above 0
 * is always followed by the next day's 0). Older days come from retention's
 * daily roll-up of the same readings.
 */
async function spend(db: Db, tz: string, vendor: string, want: readonly string[]): Promise<Values> {
  const raw = `spend.${vendor}.day.usd`;
  const from = localDayBounds(tz, want[0]!).start;
  const to = localDayBounds(tz, want[want.length - 1]!).end;
  const points = await db.metricPoint.findMany({ where: { seriesKey: { in: [raw, `${raw}.daily`] }, at: { gte: from, lt: to } }, orderBy: { at: 'asc' }, select: { at: true, value: true } });
  const before = await db.metricPoint.findFirst({ where: { seriesKey: { in: [raw, `${raw}.daily`] }, at: { lt: from } }, orderBy: { at: 'desc' }, select: { value: true } });
  const last = new Map<string, number>();
  for (const p of points) last.set(localDay(tz, p.at), p.value);
  const out: Values = new Map();
  // Nothing was ever read for this vendor: there is no number to keep.
  if (!points.length && !before) return out;
  let prev = before?.value;
  for (const day of want) {
    const v = last.get(day);
    if (v !== undefined) {
      out.set(day, v);
      prev = v;
    } else if (prev === 0) out.set(day, 0);
  }
  return out;
}

/** Deployments first seen, or seen with a new sha, per day. */
async function deploys(db: Db, tz: string, want: readonly string[]): Promise<Values> {
  const from = localDayBounds(tz, want[0]!).start;
  const to = localDayBounds(tz, want[want.length - 1]!).end;
  const first = await db.entityVersion.findFirst({ where: { entity: { kind: 'deployment' } }, orderBy: { validFrom: 'asc' }, select: { validFrom: true } });
  const out: Values = new Map();
  if (!first) return out;
  const rows = await db.$queryRaw<Array<{ validFrom: Date }>>`
    SELECT v."validFrom" FROM "EntityVersion" v JOIN "Entity" e ON e.id = v."entityId"
    WHERE e.kind = 'deployment' AND v."validFrom" >= ${from} AND v."validFrom" < ${to}
      AND (v."changeKind" = 'created' OR (v.patch IS NOT NULL AND jsonb_typeof(v.patch) = 'object' AND v.patch ? 'sha'))`;
  const since = localDay(tz, first.validFrom);
  for (const day of want) if (day >= since) out.set(day, 0);
  for (const r of rows) {
    const day = localDay(tz, r.validFrom);
    if (out.has(day)) out.set(day, out.get(day)! + 1);
  }
  return out;
}

/** The union of [start, end) spans, as sorted spans that do not touch. */
function merged(spans: Array<[number, number]>): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const [a, b] of spans.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0])) {
    const tail = out[out.length - 1];
    if (tail && a <= tail[1]) tail[1] = Math.max(tail[1], b);
    else out.push([a, b]);
  }
  return out;
}

/**
 * Minutes any watched service was down, per day: each service's versions, each
 * holding from when it became valid until the next one (the latest, until the
 * service was last seen), and down as the watchdog reads a state.
 */
async function incidents(db: Db, tz: string, want: readonly string[]): Promise<Values> {
  const services = (await db.entity.findMany({ where: { kind: 'service' }, select: { id: true, key: true, lastObservedAt: true, firstSeenAt: true } })).filter((e) => WATCHED.test(e.key));
  const out: Values = new Map();
  if (!services.length) return out;
  const versions = await db.entityVersion.findMany({
    where: { entityId: { in: services.map((e) => e.id) } }, orderBy: [{ entityId: 'asc' }, { version: 'asc' }],
    select: { entityId: true, changeKind: true, state: true, validFrom: true },
  });
  const down: Array<[number, number]> = [];
  let since = Infinity;
  for (const e of services) {
    const own = versions.filter((v) => v.entityId === e.id);
    own.forEach((v, i) => {
      since = Math.min(since, v.validFrom.getTime());
      const until = own[i + 1]?.validFrom.getTime() ?? e.lastObservedAt.getTime();
      // An archived or forgotten version says nothing; a state says down or not as the watchdog reads it.
      if (v.changeKind !== 'archived' && v.changeKind !== 'forgotten' && v.state !== null && isDown(e.key, v.state) === true) down.push([v.validFrom.getTime(), until]);
    });
  }
  const spans = merged(down);
  const first = Number.isFinite(since) ? localDay(tz, new Date(since)) : undefined;
  for (const day of want) {
    if (!first || day < first) continue;
    const { start, end } = localDayBounds(tz, day);
    const ms = spans.reduce((t, [a, b]) => t + Math.max(0, Math.min(b, end.getTime()) - Math.max(a, start.getTime())), 0);
    out.set(day, Math.round(ms / 60_000));
  }
  return out;
}

/** Threads open at each day's end: by the version valid then. */
async function threads(db: Db, tz: string, want: readonly string[]): Promise<Values> {
  const versions = await db.$queryRaw<Array<{ entityId: string; changeKind: string; state: unknown; validFrom: Date }>>`
    SELECT v."entityId", v."changeKind", v.state, v."validFrom" FROM "EntityVersion" v JOIN "Entity" e ON e.id = v."entityId"
    WHERE e.kind = 'thread' ORDER BY v."entityId", v.version`;
  const out: Values = new Map();
  if (!versions.length) return out;
  const first = localDay(tz, new Date(Math.min(...versions.map((v) => v.validFrom.getTime()))));
  const by = new Map<string, typeof versions>();
  for (const v of versions) by.set(v.entityId, [...(by.get(v.entityId) ?? []), v]);
  for (const day of want) {
    if (day < first) continue;
    const end = localDayBounds(tz, day).end.getTime();
    let open = 0;
    for (const own of by.values()) {
      const then = [...own].reverse().find((v) => v.validFrom.getTime() < end);
      if (!then || then.changeKind === 'archived' || then.changeKind === 'forgotten' || then.state === null) continue;
      if ((then.state as { status?: unknown }).status !== 'archived') open += 1;
    }
    out.set(day, open);
  }
  return out;
}

interface Stood {
  start: number;
  end: number;
  counts: boolean;
}
/** How an event stood when it ended: its last word before its own end. Undefined when it was taken off the calendar first. */
function stoodAtEnd(versions: ReadonlyArray<{ changeKind: string; state: unknown; validFrom: Date }>): Stood | undefined {
  let cur: Stood | undefined;
  for (const v of versions) {
    const s = v.state as { startsAt?: unknown; endsAt?: unknown; allDay?: unknown; response?: unknown; eventStatus?: unknown } | null;
    const gone = v.changeKind === 'archived' || v.changeKind === 'forgotten' || s === null;
    if (gone) {
      // Taken off before it ended: cancelled, declined or deleted. After it ended: only put away.
      if (cur && v.validFrom.getTime() < cur.end) cur = undefined;
      continue;
    }
    const start = typeof s.startsAt === 'string' ? Date.parse(s.startsAt) : NaN;
    const end = typeof s.endsAt === 'string' ? Date.parse(s.endsAt) : NaN;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    // A change after its own end is not about how it happened.
    if (cur && v.validFrom.getTime() >= cur.end) continue;
    cur = { start, end, counts: s.allDay === false && s.eventStatus === 'confirmed' && (s.response === 'accepted' || s.response === 'organizer') };
  }
  return cur;
}

/** Hours of accepted (or organized), confirmed, timed events per day. A day with none is 0 once the calendar has ever been read. */
async function calendar(db: Db, tz: string, want: readonly string[]): Promise<Values> {
  const out: Values = new Map();
  const first = await db.entityVersion.findFirst({ where: { entity: { kind: 'commitment' } }, orderBy: { validFrom: 'asc' }, select: { validFrom: true } });
  if (!first) return out;
  const from = localDayBounds(tz, want[0]!).start;
  const to = localDayBounds(tz, want[want.length - 1]!).end;
  // The events whose time (in any version) touches the days asked for; then every version of each.
  const ids = await db.$queryRaw<Array<{ id: string }>>`
    SELECT DISTINCT v."entityId" AS id FROM "EntityVersion" v JOIN "Entity" e ON e.id = v."entityId"
    WHERE e.kind = 'commitment' AND v.state IS NOT NULL AND v.state->>'endsAt' > ${from.toISOString()} AND v.state->>'startsAt' < ${to.toISOString()}`;
  const versions = ids.length
    ? await db.entityVersion.findMany({ where: { entityId: { in: ids.map((r) => r.id) } }, orderBy: [{ entityId: 'asc' }, { version: 'asc' }], select: { entityId: true, changeKind: true, state: true, validFrom: true } })
    : [];
  const by = new Map<string, typeof versions>();
  for (const v of versions) by.set(v.entityId, [...(by.get(v.entityId) ?? []), v]);
  const events = [...by.values()].map(stoodAtEnd).filter((e): e is Stood => !!e && e.counts);
  const since = localDay(tz, first.validFrom);
  for (const day of want) {
    if (day < since) continue;
    const { start, end } = localDayBounds(tz, day);
    const ms = events.reduce((t, e) => t + Math.max(0, Math.min(e.end, end.getTime()) - Math.max(e.start, start.getTime())), 0);
    out.set(day, Math.round((ms / 3_600_000) * 100) / 100);
  }
  return out;
}

/**
 * Commits in a clone per week (keyed by the week's Monday). Until the series has its first number, weeks with no
 * commits are left out: the clone may not have existed yet. Once it has one, a quiet week is a 0.
 */
async function commits(d: MetricsDeps, repo: string, want: readonly string[], started: boolean): Promise<Values> {
  const out: Values = new Map();
  const path = d.repos?.find((r) => r.name === repo)?.path;
  if (!d.run || !path) return out;
  let seen = started;
  for (const monday of want) {
    const n = await commitsBetween(d.run, path, localDayBounds(d.tz, monday).start, localDayBounds(d.tz, addLocalDays(monday, 6)).end);
    if (n === undefined) return out;
    if (n > 0) seen = true;
    if (seen) out.set(monday, n);
  }
  return out;
}

export interface Materialised {
  /** Points written, by series key. */
  written: Record<string, number>;
  /** Series left alone: not registered, not there, or forgotten. */
  skipped: number;
  /** Days left missing because the runtime was down. */
  down: number;
  /** Series whose builder failed (the others are still written). */
  failed: string[];
}

/**
 * Write every missing step of each of `keys` that is over. A key that is not
 * registered, has no series row, or was forgotten is left alone.
 */
export async function materialise(d: MetricsDeps, keys: readonly string[]): Promise<Materialised> {
  const now = d.now ?? new Date();
  const today = localDay(d.tz, now);
  const out: Materialised = { written: {}, skipped: 0, down: 0, failed: [] };
  const rows = await d.db.metricSeries.findMany({ where: { key: { in: [...keys] } }, select: { key: true, description: true, freq: true } });
  const live = new Map(rows.filter((r) => r.description !== '[forgotten]').map((r) => [r.key, r]));
  for (const key of keys) {
    const def = FORECAST_SERIES.find((s) => s.key === key);
    if (!def || live.get(key)?.freq !== freqOf(def)) {
      out.skipped += 1;
      continue;
    }
    try {
      // The steps that are over, as far back as a backfill goes, less the ones already written.
      const weekly = def.step === 'week';
      const end = weekly ? weekOf(today) : today;
      const start = weekly ? addLocalDays(end, -7 * BACKFILL_WEEKS) : addLocalDays(end, -BACKFILL_DAYS);
      const steps = weekly ? days(start, end).filter((day) => weekOf(day) === day) : days(start, end);
      const have = new Set((await d.db.metricPoint.findMany({ where: { seriesKey: key, at: { gte: localDayBounds(d.tz, start).start } }, select: { at: true } })).map((p) => localDay(d.tz, p.at)));
      // Once a series has its first number, only what came after it is filled in: before it, its sources had nothing
      // (a first run already wrote everything they covered), so the nightly run reads yesterday, not 400 days.
      const began = [...have].sort()[0];
      const want = steps.filter((day) => !have.has(day) && (!began || day > began));
      if (!want.length) {
        out.written[key] = 0;
        continue;
      }
      // Every step from the first missing one on, so a carried value (a vendor's running total) has its history.
      const span = steps.slice(steps.indexOf(want[0]!));
      const from = def.from;
      const values =
        from.kind === 'spend' ? await spend(d.db, d.tz, from.vendor, span)
          : from.kind === 'deploys' ? await deploys(d.db, d.tz, span)
            : from.kind === 'incidents' ? await incidents(d.db, d.tz, span)
              : from.kind === 'threads' ? await threads(d.db, d.tz, span)
                : from.kind === 'calendar' ? await calendar(d.db, d.tz, span)
                  : await commits(d, from.repo, want, have.size > 0);
      // A day nothing was watching is left missing (a week of commits is read from the clone itself).
      const up = weekly ? undefined : await upDays(d.db, d.tz, want.filter((day) => values.has(day)));
      const data = want.flatMap((day) => {
        const value = values.get(day);
        if (value === undefined || !Number.isFinite(value)) return [];
        if (up && !up.has(day)) {
          out.down += 1;
          return [];
        }
        return [{ seriesKey: key, at: localDayBounds(d.tz, day).start, value }];
      });
      out.written[key] = data.length ? (await d.db.metricPoint.createMany({ data, skipDuplicates: true })).count : 0;
    } catch {
      out.failed.push(key);
    }
  }
  return out;
}
