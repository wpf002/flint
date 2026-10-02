/**
 * One run of a source (the bus's sync.<source> job calls it on the source's
 * cadence; jobs.ts). One at a time: the queue's singleton policy, and a
 * Postgres advisory lock so a second runtime (a deploy overlap) cannot run it
 * at the same moment.
 */
import type { Db } from './db.js';
import { scopedFetch } from './policy/egress.js';
import type { Registered } from './sources/registry.js';
import { syncOnce, type SyncSummary } from './sources/sync.js';
import type { Enqueue } from './events/record.js';

/** A stable 32-bit key per source for pg_try_advisory_lock. */
const lockKey = (name: string) => [...`flint.sync.${name}`].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) | 0, 7);

export async function runLocked(db: Db, r: Registered, tz: string, now = new Date(), enqueue?: Enqueue): Promise<SyncSummary | undefined> {
  const key = lockKey(r.source.name);
  return db.$transaction(async (tx) => {
    const got = await tx.$queryRaw<Array<{ ok: boolean }>>`SELECT pg_try_advisory_xact_lock(${key}::int) AS ok`;
    if (!got[0]?.ok) return undefined;
    const ac = new AbortController();
    return syncOnce(db, r.source, { now, signal: ac.signal, fetch: scopedFetch(r.endpoints) }, tz, enqueue);
  }, { timeout: 5 * 60_000, maxWait: 10_000 });
}
