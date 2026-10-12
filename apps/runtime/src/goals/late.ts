/**
 * When is a goal's review late? (P3 part 3.) Not simply when its time is past:
 * a goal's next review time is set when it starts, so right after reviews are
 * turned on (FLINT_PLANNER), after a restart, or after the Mac slept, every
 * review that came due meanwhile is past its time without anything being
 * wrong. Flint runs those within minutes.
 *
 * So a review is late by the time it has waited WHILE Flint was reviewing, and
 * that time is counted from what the database already keeps, never from this
 * process's memory: the Goal Reviews rows the health job writes every 5
 * minutes. A row is there only while the runtime is up and its jobs run, and
 * it says reviews were on (not `disabled`, and not stopped by a rule). Two
 * rows at most 12 minutes apart are one stretch of reviewing; a longer gap (the
 * Mac asleep, the runtime down) counts for nothing. The stretches add up
 * across restarts and nights, so:
 *
 *  - a review due while reviews were off, or while the Mac slept, is not late
 *    when Flint comes back: it has waited no reviewing time yet;
 *  - a review that stays undone is late after an hour of reviewing time, and
 *    an outage after 24 hours of it, however that day is spread over deploys
 *    and nights. A review stuck for days shows as down.
 *
 * The panel ("Late"), Settings > Health and the review's own audit entry
 * (which the digest counts) all read it this way.
 */
import { REVIEW_LATE_MS } from '@flint/policy';
import type { Db, Tx } from '../db.js';

/** What Goal Reviews says in Settings > Health while a rule stops reviews. Such a row is not reviewing time. */
export const REVIEWS_STOPPED = 'A rule stops goal reviews, so none are running.';
/** Two Goal Reviews checks further apart than this were not one stretch (the health job runs every 5 minutes). */
export const EVIDENCE_GAP_MS = 12 * 60_000;

/** When Goal Reviews was checked and on, from just before `from` to `now`, oldest first. */
export async function reviewingLog(db: Db | Tx, from: Date, now: Date): Promise<Date[]> {
  const rows = await db.$queryRaw<Array<{ at: Date }>>`
    SELECT at FROM "HealthCheck"
    WHERE component = 'goals' AND status <> 'disabled' AND detail IS DISTINCT FROM ${REVIEWS_STOPPED}
      AND at > ${new Date(from.getTime() - EVIDENCE_GAP_MS)} AND at <= ${now}
    ORDER BY at ASC`;
  return rows.map((r) => r.at);
}

/**
 * How long a review due at `due` has waited while Flint was reviewing: the
 * stretches of the log after `due`, up to `now` when the last check is recent.
 */
export function reviewingMs(log: readonly Date[], due: Date, now: Date): number {
  const at = [...log.map((d) => d.getTime()), now.getTime()];
  const from = due.getTime();
  let ms = 0;
  for (let i = 1; i < at.length; i++) {
    const a = at[i - 1]!;
    const b = at[i]!;
    if (b - a > EVIDENCE_GAP_MS || b <= from) continue;
    ms += b - Math.max(a, from);
  }
  return ms;
}

/**
 * For each due time, how long it has waited while Flint was reviewing. One read
 * of the log for all of them, and none at all when nothing has been due for an
 * hour (the usual case).
 */
export async function waitedMs(db: Db | Tx, dues: ReadonlyArray<Date | null>, now: Date): Promise<number[]> {
  const cut = now.getTime() - REVIEW_LATE_MS;
  const old = dues.filter((d): d is Date => !!d && d.getTime() < cut);
  if (!old.length) return dues.map(() => 0);
  const log = await reviewingLog(db, new Date(Math.min(...old.map((d) => d.getTime()))), now);
  return dues.map((d) => (d && d.getTime() < cut ? reviewingMs(log, d, now) : 0));
}
