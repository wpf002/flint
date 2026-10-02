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

/** The instant a local wall-clock midnight (YYYY-MM-DD 00:00 in tz) falls on. DST-safe: a 23- or 25-hour day is exactly its length. */
function localMidnight(tz: string, day: string): Date {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d);
  // Two passes settle the offset around a DST change.
  let t = guess - offsetMs(tz, new Date(guess));
  t = guess - offsetMs(tz, new Date(t));
  return new Date(t);
}

/** [start, end) of a local calendar day in tz. */
export function localDayBounds(tz: string, day: string): { start: Date; end: Date } {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const next = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  return { start: localMidnight(tz, day), end: localMidnight(tz, next) };
}

/** The day before a YYYY-MM-DD day. */
export function previousDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
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
