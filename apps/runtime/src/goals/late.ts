/**
 * When is a goal's review late? (P3 part 3.) Not simply when its time is past:
 * a goal's next review time is set when it starts, so right after reviews are
 * turned on (FLINT_PLANNER), after a restart, or after the Mac slept, every
 * review that came due meanwhile is past its time without anything being
 * wrong. Flint runs those within minutes.
 *
 * So the goal tick notes each run here, in memory, and a review is late once
 * it has been due for over an hour WHILE the tick ran without a gap: a review
 * job that keeps dying, a queue that stopped. The panel ("Late"), Settings >
 * Health and the review's own audit entry (which the digest counts) all read
 * it this way.
 */
import { REVIEW_LATE_MS } from '@flint/policy';

/** Two ticks further apart than this were not one run: Flint was off, restarted or asleep in between. */
export const TICK_GAP_MS = 10 * 60_000;

let run: { since: Date; last: Date } | null = null;

/** A tick ran now. After a gap, the run of ticks starts over. */
export function noteTick(now: Date): void {
  const gap = run ? now.getTime() - run.last.getTime() : -1;
  run = run && gap >= 0 && gap <= TICK_GAP_MS ? { since: run.since, last: now } : { since: now, last: now };
}

/** Since when this process has ticked without a gap; null before its first tick. A restart starts over. */
export function tickingSince(): Date | null {
  return run?.since ?? null;
}

/** For the tests: as if no tick had run, or as if the tick had run without a gap since `since`. */
export function resetTicking(since?: Date): void {
  run = since ? { since, last: new Date() } : null;
}

/**
 * The time a review must have been due before to count as late (or, with `ms`
 * a day, as an outage); null when nothing can be yet. `since` null: no tick
 * has run. A run younger than `ms` has not had the time to be late. `since`
 * undefined: the caller does not track the tick, and it is taken as always
 * running.
 */
export function lateBefore(now: Date, since: Date | null | undefined, ms: number = REVIEW_LATE_MS): Date | null {
  if (since === null) return null;
  const cut = now.getTime() - ms;
  return since && since.getTime() > cut ? null : new Date(cut);
}
