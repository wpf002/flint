/**
 * The watchdog (Machine plan P2, the critical rules' inputs), after each
 * health run: conditions in the world raised as runtime events, each ONCE per
 * occurrence (its sourceRef names the occurrence), with ids and numbers only.
 *
 *  - A service down 30 minutes: Flint's and Nexus's KeepAlive agents (not
 *    running) and the health endpoints (down), measured from the first of
 *    the consecutive down observations; once per outage.
 *  - Backups stopped: the last good local backup over 36 h old; once per last
 *    good backup.
 *  - The restore drill failed: the latest drill only; once per drill.
 *  - A vendor at 100% of its cap; once per vendor a day, and not when the
 *    server already said so today.
 *  - A migration marked failed (~/.flint/runtime/migrate-failed); once per sha.
 *
 * CI failing on flint needs no watchdog: the github source's own event is the
 * critical rule's input.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { localDay, localDayBounds } from '@flint/policy';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { markProcessed, recordEvent, type Enqueue } from '../events/record.js';
import { faultAt } from '../config.js';

export interface Raised {
  type: string;
  /** Names the occurrence: the same one raised again is the same event. */
  ref: string;
  /** When it was seen to hold: a watchdog condition is current when raised (its start is in its ref and payload). */
  occurredAt: Date;
  payload: Record<string, string | number>;
}

export const DOWN_AFTER_MS = 30 * 60_000;
export const BACKUP_STALE_MS = 36 * 3_600_000;
/** Whose services are watched: Flint's own, and Nexus's. */
const WATCHED = /^service:(launchd:com\.(flint|nexus)\.[A-Za-z0-9._-]+|endpoint:[A-Za-z0-9._-]+)$/;

/** Down, as each kind of service says it. Undefined: this state says nothing (a periodic agent). */
export function isDown(key: string, state: unknown): boolean | undefined {
  const s = (state ?? {}) as { health?: unknown; running?: unknown; loaded?: unknown; disabled?: unknown };
  if (key.startsWith('service:endpoint:')) return s.health === undefined ? undefined : s.health === 'down';
  // An agent that is not loaded, or is disabled, was put away on purpose: that says nothing. (A Flint
  // server booted out is still caught: its health endpoint goes down.)
  if (s.loaded === false || s.disabled === true) return undefined;
  return typeof s.running === 'boolean' ? !s.running : undefined;
}

export async function watchdog(db: Db, config: Pick<Config, 'home' | 'tz'>, now: Date): Promise<Raised[]> {
  const out: Raised[] = [];

  const services = await db.entity.findMany({ where: { kind: 'service', status: 'active' }, select: { id: true, key: true, state: true } });
  for (const e of services.filter((x) => WATCHED.test(x.key) && isDown(x.key, x.state))) {
    // Back through the versions while it was down: the outage began at the first of them.
    const versions = await db.entityVersion.findMany({ where: { entityId: e.id }, orderBy: { version: 'desc' }, take: 200, select: { state: true, validFrom: true } });
    let since: Date | undefined;
    for (const v of versions) {
      if (!isDown(e.key, v.state)) break;
      since = v.validFrom;
    }
    if (!since || now.getTime() - since.getTime() < DOWN_AFTER_MS) continue;
    out.push({
      type: 'service.down_30m', ref: `${e.id}:${since.toISOString()}`, occurredAt: now,
      payload: { entityId: e.id, downMinutes: Math.floor((now.getTime() - since.getTime()) / 60_000) },
    });
  }

  const backup = await db.backupRun.findFirst({ where: { kind: 'pg_dump_flint', location: 'local', status: 'ok' }, orderBy: { startedAt: 'desc' }, select: { id: true, startedAt: true } });
  if (backup && now.getTime() - backup.startedAt.getTime() > BACKUP_STALE_MS) {
    out.push({ type: 'backup.stale', ref: `after:${backup.id}`, occurredAt: now, payload: { hoursSince: Math.floor((now.getTime() - backup.startedAt.getTime()) / 3_600_000) } });
  }

  const drill = await db.backupRun.findFirst({ where: { restoreTestedAt: { not: null } }, orderBy: { restoreTestedAt: 'desc' }, select: { id: true, restoreOk: true, restoreTestedAt: true, restoreDetail: true } });
  if (drill?.restoreOk === false) {
    const mismatches = (drill.restoreDetail as { mismatches?: unknown } | null)?.mismatches;
    out.push({ type: 'drill.failed', ref: drill.id, occurredAt: now, payload: { mismatches: Array.isArray(mismatches) ? mismatches.length : 0 } });
  }

  const day = localDay(config.tz, now);
  const { start } = localDayBounds(config.tz, day);
  const capped = await db.entity.findMany({ where: { kind: 'account', status: 'active', key: { startsWith: 'account:vendor:' } }, select: { state: true } });
  for (const a of capped) {
    const s = a.state as { vendor?: unknown; level?: unknown };
    if (s.level !== '100' || typeof s.vendor !== 'string' || !/^[a-z]{1,20}$/.test(s.vendor)) continue;
    const told = await db.sourceEvent.count({ where: { source: 'server', type: 'spend.threshold', occurredAt: { gte: start }, AND: [{ payload: { path: ['vendor'], equals: s.vendor } }, { payload: { path: ['level'], equals: 'exhausted' } }] } });
    if (!told) out.push({ type: 'vendor.cap_100', ref: `${s.vendor}:${day}`, occurredAt: now, payload: { vendor: s.vendor } });
  }

  const marker = join(config.home, '.flint', 'runtime', 'migrate-failed');
  if (existsSync(marker)) {
    for (const sha of new Set(readFileSync(marker, 'utf8').split('\n').map((l) => l.trim()).filter((l) => /^[0-9a-f]{40}$/.test(l)))) {
      out.push({ type: 'migrate.failed', ref: sha, occurredAt: now, payload: { sha } });
    }
  }
  return out;
}

/** Store raised conditions as applied runtime events (once per ref), each with its triage job; returns the new ids. */
export async function raise(db: Db, raised: readonly Raised[], now: Date, enqueue?: Enqueue): Promise<string[]> {
  const ids: string[] = [];
  for (const r of raised) {
    const id = await db.$transaction(async (tx) => {
      const id = await recordEvent(tx, { source: 'runtime', sourceRef: `${r.type}:${r.ref}`, type: r.type, occurredAt: r.occurredAt, sensitivity: 'ops', tainted: false, payload: r.payload }, now);
      if (!id) return null;
      await markProcessed(tx, id, 'applied', now);
      if (enqueue) await enqueue(tx, id);
      return id;
    });
    if (id) {
      ids.push(id);
      faultAt('after_event');
    }
  }
  return ids;
}
