/**
 * Laying out weeks of goal reviews for the P3 report's and promotion table's
 * tests. A review's time is the database's own clock, set on insert and never
 * changed after (goal_review_insert_check, GoalReview_guard), so a test cannot
 * make one "eight days ago" the way the runtime could not either. The fixture's
 * owner (the role that owns the tables; no runtime role can) switches that one
 * guard off for a single statement to move a review in time, then on again.
 */
import { localDay, previousDay } from '@flint/policy';
import { withClient, type TestUrls } from '../db';
import type { Db } from '../../src/db';

export const HOUR = 3_600_000;

/** Move a review to `createdAt` (and, for a scheduled one, its due time to `dueAt`). */
export async function moveReview(urls: TestUrls, reviewId: string, createdAt: Date, dueAt?: Date): Promise<void> {
  await withClient(urls.owner, async (c) => {
    await c.query('BEGIN');
    try {
      await c.query('ALTER TABLE "GoalReview" DISABLE TRIGGER "GoalReview_guard"');
      const r = await c.query('UPDATE "GoalReview" SET "createdAt" = $2, "dueAt" = coalesce($3, "dueAt") WHERE id = $1', [reviewId, createdAt, dueAt ?? null]);
      if (r.rowCount !== 1) throw new Error(`no review ${reviewId}`);
      await c.query('ALTER TABLE "GoalReview" ENABLE TRIGGER "GoalReview_guard"');
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK');
      throw err;
    }
  });
}

/** The `n` whole local days before `now`'s day, newest first, as YYYY-MM-DD. */
export function daysBefore(tz: string, now: Date, n: number): string[] {
  const out: string[] = [];
  for (let d = previousDay(localDay(tz, now)); out.length < n; d = previousDay(d)) out.push(d);
  return out;
}

/** Noon UTC of a YYYY-MM-DD day: inside that day in UTC, the tests' time zone. */
export const noon = (day: string): Date => new Date(`${day}T12:00:00.000Z`);

/** Settings > Health's Goal Reviews row, as the health job writes it every few minutes: here, one a day. */
export async function goalReviewsRan(db: Db, days: readonly string[], status: 'ok' | 'degraded' | 'down' | 'disabled' = 'ok'): Promise<void> {
  await db.healthCheck.createMany({ data: days.map((d) => ({ component: 'goals', status, at: noon(d) })) });
}
