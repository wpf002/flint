/**
 * Runs each source on its cadence. One run of a source at a time: an in-process
 * flag, and a Postgres advisory lock so a second runtime (a deploy overlap)
 * cannot run it at the same moment.
 */
import type { Db } from './db.js';
import { scopedFetch } from './policy/egress.js';
import type { Registered } from './sources/registry.js';
import { syncOnce, type SyncSummary } from './sources/sync.js';

/** A stable 32-bit key per source for pg_try_advisory_lock. */
const lockKey = (name: string) => [...`flint.sync.${name}`].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) | 0, 7);

export async function runLocked(db: Db, r: Registered, tz: string, now = new Date()): Promise<SyncSummary | undefined> {
  const key = lockKey(r.source.name);
  return db.$transaction(async (tx) => {
    const got = await tx.$queryRaw<Array<{ ok: boolean }>>`SELECT pg_try_advisory_xact_lock(${key}::int) AS ok`;
    if (!got[0]?.ok) return undefined;
    const ac = new AbortController();
    return syncOnce(db, r.source, { now, signal: ac.signal, fetch: scopedFetch(r.endpoints) }, tz);
  }, { timeout: 5 * 60_000, maxWait: 10_000 });
}

export function startScheduler(db: Db, sources: Registered[], tz: string, log: (msg: string, extra?: object) => void): () => void {
  const timers: NodeJS.Timeout[] = [];
  for (const r of sources) {
    let busy = false;
    const tick = async () => {
      if (busy) return;
      busy = true;
      try {
        const s = await runLocked(db, r, tz);
        if (s?.failed || (s && !s.ran && s.reason && !s.reason.startsWith('not enabled'))) log(`sync ${r.source.name}: ${s.reason ?? `${s.failed} failed`}`, s);
      } catch (err) {
        log(`sync ${r.source.name} crashed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        busy = false;
      }
    };
    const first = setTimeout(() => void tick(), 5_000 + Math.floor(Math.random() * 5_000));
    const every = setInterval(() => void tick(), r.source.cadenceMs);
    first.unref();
    every.unref();
    timers.push(first, every);
  }
  return () => timers.forEach((t) => clearInterval(t));
}
