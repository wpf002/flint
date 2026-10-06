/**
 * `pnpm --filter @flint/runtime apple-calendar` (Machine plan P2.6): one line
 * on how Apple Calendar reading is going, for Will and for disconnect.sh, read
 * from the database as it stands, e.g. "Connected · Last Read 2 Min Ago · 23
 * Events". States and counts only: never a title, a name or an address. (The
 * snapshot itself lives in the runtime's memory, which this command cannot see,
 * and need not: a good run is a fresh snapshot with full access.)
 */
import type { Db } from '../db.js';
import { ACCESS_OFF } from './p25.js';

const SOURCE = 'apple_calendar';
/** A good read this recent is a connected helper (it pushes every 5 minutes). */
const FRESH_MS = 15 * 60_000;

/** "Just Now", "4 Min Ago", "3 H Ago", "2 D Ago". */
function ago(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'Just Now';
  if (min < 120) return `${min} Min Ago`;
  const h = Math.floor(min / 60);
  return h < 48 ? `${h} H Ago` : `${Math.floor(h / 24)} D Ago`;
}

export async function appleCalendarStatus(db: Db, now = new Date()): Promise<string> {
  const cursor = await db.sourceCursor.findUnique({ where: { source: SOURCE }, select: { enabled: true, lastOkAt: true, lastError: true, consecutiveFailures: true } });
  // The events Flint has from Apple Calendar now (commitments and deadlines that are not archived).
  const events = await db.entity.count({ where: { kind: { in: ['commitment', 'deadline'] }, status: 'active', sources: { some: { source: SOURCE } } } });
  const state = !cursor?.enabled
    ? 'Not Turned On'
    : cursor.consecutiveFailures > 0 && !!cursor.lastError && ACCESS_OFF.test(cursor.lastError)
      ? 'Calendar Access Is Off'
      : cursor.consecutiveFailures > 0
        ? 'Not Reporting'
        : !cursor.lastOkAt
          ? 'Waiting for Flint Calendar'
          : now.getTime() - cursor.lastOkAt.getTime() <= FRESH_MS ? 'Connected' : 'Not Reporting';
  const read = cursor?.lastOkAt ? `Last Read ${ago(now.getTime() - cursor.lastOkAt.getTime())}` : 'Never Read';
  return [state, read, `${events} ${events === 1 ? 'Event' : 'Events'}`].join(' · ');
}
