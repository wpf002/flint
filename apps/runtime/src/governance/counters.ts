/**
 * Caps, claimed atomically at decision time (plan 3.0.3) through the database's
 * claim_action(): two concurrent claims can never both take the last slot, and
 * nothing is counted after the fact.
 */
import { periodKey, type Cap } from '@flint/policy';
import type { Db, Tx } from '../db.js';

/** The counter period a cap is claimed in (YYYY-MM-DD, YYYY-Www, or the UTC hour YYYY-MM-DDTHH): shared with the policy package. */
export { periodKey };

/** Take one slot under the cap; returns the new count, or null when the cap is reached. */
export async function claim(db: Db | Tx, action: string, cap: Cap, tz: string, now?: Date): Promise<number | null> {
  const key = periodKey(cap, tz, now);
  const rows = await db.$queryRaw<Array<{ n: number | null }>>`SELECT claim_action(${action}, ${key}, ${cap.limit}::int) AS n`;
  return rows[0]?.n ?? null;
}
