/**
 * Flint's time zone and its calendar (Machine plan P2, TIME rules): one place
 * that says what "today", "yesterday", "this hour" and "this week" mean, for
 * the runtime's counters, the digest, retention and the probability phrase,
 * so none of them computes a day with toISOString() (a UTC day) by mistake.
 */

/** The zone: FLINT_TZ, else the server's FLINT_USER_TZ, else America/Chicago; blank means unset, and an unknown zone is refused. */
export function zoneFrom(flintTz?: string, userTz?: string): string {
  const z = flintTz?.trim() || userTz?.trim() || 'America/Chicago';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: z }).format(0);
  } catch {
    throw new Error(`not a time zone: ${z.slice(0, 60)}`);
  }
  return z;
}

const partsIn = (tz: string, at: Date): Record<string, string> =>
  Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );

/** The local calendar day of `at` in `tz`, as YYYY-MM-DD. */
export function localDay(tz: string, at: Date = new Date()): string {
  const p = partsIn(tz, at);
  return `${p.year}-${p.month}-${p.day}`;
}

/** The offset of `tz` from UTC at `at`, in ms (local wall time minus UTC). */
function offsetMs(tz: string, at: Date): number {
  const p = partsIn(tz, at);
  const wall = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return wall - Math.floor(at.getTime() / 1000) * 1000;
}

/** The instant a local wall-clock time (YYYY-MM-DD hh:mm in tz) falls on. DST-safe: two passes settle the offset around a change. */
export function localWallTime(tz: string, day: string, hh = 0, mm = 0): Date {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let t = guess - offsetMs(tz, new Date(guess));
  t = guess - offsetMs(tz, new Date(t));
  return new Date(t);
}

/** The instant a local wall-clock midnight (YYYY-MM-DD 00:00 in tz) falls on. DST-safe: a 23- or 25-hour day is exactly its length. */
function localMidnight(tz: string, day: string): Date {
  return localWallTime(tz, day, 0, 0);
}

/** [start, end) of a local calendar day in tz. */
export function localDayBounds(tz: string, day: string): { start: Date; end: Date } {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const next = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  return { start: localMidnight(tz, day), end: localMidnight(tz, next) };
}

/** The day before a YYYY-MM-DD day. */
export function previousDay(day: string): string {
  return addLocalDays(day, -1);
}

/** A YYYY-MM-DD day n calendar days later (or earlier). */
export function addLocalDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** A YYYY-MM-DD day n calendar months later, on anchorDay clamped to that month's length: Jan 31 gives Feb 28 (or 29), then Mar 31. */
export function addLocalMonths(day: string, n: number, anchorDay: number): string {
  const [y, m] = day.split('-').map(Number) as [number, number];
  const first = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return `${first.toISOString().slice(0, 8)}${String(Math.min(anchorDay, last)).padStart(2, '0')}`;
}

/** The local hour a goal's review lands on: clear of the 02:00-02:59 a DST change skips or repeats. */
export const REVIEW_HOUR = 9;
const CADENCE_DAYS: Readonly<Record<string, number>> = { P1D: 1, P3D: 3, P1W: 7, P2W: 14 };

/**
 * When a goal is next reviewed (P3): the local date of `due` stepped by the
 * cadence (P1D, P3D, P1W and P2W in days, P1M in months on due's day of the
 * month), at 09:00 local, stepped again until it is after `now`. It steps
 * calendar dates, never multiples of 24 hours, so the weekday stays put across a
 * DST change, and a late run does not pile up reviews.
 */
export function nextReviewAt(cadence: 'P1D' | 'P3D' | 'P1W' | 'P2W' | 'P1M', tz: string, due: Date, now: Date): Date {
  const base = localDay(tz, due);
  const today = localDay(tz, now);
  const days = CADENCE_DAYS[cadence];
  const [by, bm, bd] = base.split('-').map(Number) as [number, number, number];
  const [ty, tm, td] = today.split('-').map(Number) as [number, number, number];
  // Skip the whole steps that are surely past: every step before this one falls before today.
  let i = days
    ? Math.max(1, Math.floor((Date.UTC(ty, tm - 1, td) - Date.UTC(by, bm - 1, bd)) / 86_400_000 / days))
    : Math.max(1, ty * 12 + tm - (by * 12 + bm));
  for (;; i++) {
    const at = localWallTime(tz, days ? addLocalDays(base, i * days) : addLocalMonths(base, i, bd), REVIEW_HOUR, 0);
    if (at.getTime() > now.getTime()) return at;
  }
}

/**
 * The counter period a cap is claimed in: YYYY-MM-DD for a day and YYYY-Www
 * (ISO week) for a week, both of the local calendar in tz; YYYY-MM-DDTHH for an
 * hour, of UTC, so the hour a DST fall-back repeats is not counted twice.
 */
export function periodKey(cap: { period: 'hour' | 'day' | 'week' }, tz: string, now: Date = new Date()): string {
  if (cap.period === 'hour') return now.toISOString().slice(0, 13);
  const day = localDay(tz, now);
  if (cap.period === 'day') return day;
  const d = new Date(`${day}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d.getTime() - firstThursday.getTime()) / 86400_000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
