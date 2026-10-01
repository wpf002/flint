/**
 * Caps, claimed atomically at decision time (plan 3.0.3) through the database's
 * claim_action(): two concurrent claims can never both take the last slot, and
 * nothing is counted after the fact.
 */
import type { Cap } from '@flint/policy';
import type { Db, Tx } from '../db.js';

/** The counter period a cap is claimed in: YYYY-MM-DD, or YYYY-Www for weekly caps, in Flint's time zone. */
export function periodKey(cap: Pick<Cap, 'period'>, tz: string, now: Date = new Date()): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  const day = `${parts.year}-${parts.month}-${parts.day}`;
  if (cap.period === 'day') return day;
  // ISO week of the local calendar date.
  const d = new Date(`${day}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d.getTime() - firstThursday.getTime()) / 86400_000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** Take one slot under the cap; returns the new count, or null when the cap is reached. */
export async function claim(db: Db | Tx, action: string, cap: Cap, tz: string, now?: Date): Promise<number | null> {
  const key = periodKey(cap, tz, now);
  const rows = await db.$queryRaw<Array<{ n: number | null }>>`SELECT claim_action(${action}, ${key}, ${cap.limit}::int) AS n`;
  return rows[0]?.n ?? null;
}
