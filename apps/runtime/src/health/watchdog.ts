/**
 * The watchdog (Machine plan P2, the critical rules' inputs), after each
 * health run: conditions in the world raised as runtime events, each ONCE per
 * occurrence (its sourceRef names the occurrence), with ids and numbers only.
 *
 *  - A service down 30 minutes: Flint's and Nexus's KeepAlive agents (not
 *    running) and the health endpoints (down), measured from the first of
 *    the consecutive down observations; once per outage.
 *  - Backups stopped: the last good local backup over 36 h old; once per last
 *    good backup. The same for Nexus's own backup while it is switched on.
 *  - The restore drill failed: the latest drill of Flint's own database only;
 *    once per drill.
 *  - A vendor at 100% of its cap; once per vendor a day, and not when the
 *    server already said so today.
 *  - A migration marked failed (~/.flint/runtime/migrate-failed); once per sha.
 *  - The Mac nearly full (under 5 GB free): critical; once a day while it lasts.
 *  - No offsite copy written in 72 hours (the database's; or, when that one is
 *    current, the files'); once per last good copy.
 *  - Remote access: its sign-in runs out within 14 days (once, and once more
 *    within 3); or it has been down 30 minutes (once per outage).
 *  - The deploy job has not looked for an update in 3 hours of this runtime
 *    being up, while updates are not paused; once per stall.
 *  - The MacBook has not tested an offsite copy in 5 weeks; once per last test.
 *
 * CI failing on flint needs no watchdog: the github source's own event is the
 * critical rule's input.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { localDay, localDayBounds } from '@flint/policy';
import type { Config } from '../config.js';
import type { Db, Tx } from '../db.js';
import { markProcessed, recordEvent, refreshUndecided, type Enqueue } from '../events/record.js';
import { faultAt, nexusBackupWanted, offsiteFolder, runtimeEnv } from '../config.js';
import { lastUpdateCheck, offsiteWanted, pausedMarkThere } from './checks.js';
import { DISK_FULL_BYTES, EXPIRY_WARN_DAYS, daysUntil, type MachineReading } from './machine.js';

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
/** No copy written offsite in this long is said once (Health has shown it as late since 26 hours). */
export const OFFSITE_STALE_MS = 72 * 3_600_000;
/** The deploy job looks every two minutes: this long without a look, it has stopped. */
export const UPDATES_STALLED_MS = 3 * 3_600_000;
/** A weekly test: five weeks without one, the MacBook has stopped testing. */
export const OFFSITE_DRILL_STALE_MS = 35 * 86_400_000;
/** Whose services are watched: Flint's own, and Nexus's. */
const WATCHED = /^service:(launchd:com\.(flint|nexus)\.[A-Za-z0-9._-]+|endpoint:[A-Za-z0-9._-]+)$/;

/** Down, as each kind of service says it. Undefined: this state says nothing (a periodic agent). */
export function isDown(key: string, state: unknown): boolean | undefined {
  const s = (state ?? {}) as { health?: unknown; running?: unknown; loaded?: unknown; disabled?: unknown };
  if (key.startsWith('service:endpoint:')) return s.health === undefined ? undefined : s.health === 'down';
  // A disabled agent was put away on purpose: that says nothing. One that is merely not loaded (a
  // bootstrap that kept failing) is down. A state that does not say (written before the source
  // read `launchctl print-disabled`) says nothing either.
  if (s.disabled !== false) return undefined;
  return typeof s.running === 'boolean' ? !s.running : undefined;
}

/** Is the offsite folder iCloud Drive (the default)? Read from the backup settings by name; unreadable, it is not said to be. */
function offsiteIsICloud(home: string): boolean {
  try {
    return offsiteFolder(home, runtimeEnv(join(home, '.flint', 'backup.env'), {}).FLINT_OFFSITE_DIR).icloud;
  } catch {
    return false;
  }
}

/**
 * Since when this component has been down: its first down check since it was last seen working (normal, degraded)
 * or off. A check that could not tell (unknown) between two downs does not start the count again: something in
 * trouble answers slowly, and "could not be read" is not "it is back".
 */
async function downSince(db: Db, component: string): Promise<Date | undefined> {
  const up = await db.healthCheck.findFirst({ where: { component, status: { in: ['ok', 'degraded', 'disabled'] } }, orderBy: { at: 'desc' }, select: { at: true } });
  return (await db.healthCheck.findFirst({ where: { component, status: 'down', ...(up ? { at: { gt: up.at } } : {}) }, orderBy: { at: 'asc' }, select: { at: true } }))?.at;
}

/** The conditions that come from the Mac itself and from the offsite copies (P7). `machine`: this run's reading, when there is one. */
async function machineConditions(db: Db, config: Pick<Config, 'home' | 'tz'>, now: Date, machine: MachineReading | undefined): Promise<Raised[]> {
  const out: Raised[] = [];
  const t = now.getTime();

  if (machine?.freeBytes !== undefined && machine.freeBytes < DISK_FULL_BYTES) {
    out.push({ type: 'disk.low', ref: `low:${localDay(config.tz, now)}`, occurredAt: now, payload: { gb: Math.floor(machine.freeBytes / 1e9) } });
  }

  if (machine?.remote.state === 'ok' && machine.remote.expiresAt) {
    const days = daysUntil(machine.remote.expiresAt, now);
    // Said once at two weeks, and once more in the last three days.
    if (days <= EXPIRY_WARN_DAYS) out.push({ type: 'remote_access.expiring', ref: `${machine.remote.expiresAt.toISOString().slice(0, 10)}:${days <= 3 ? 3 : EXPIRY_WARN_DAYS}`, occurredAt: now, payload: { days } });
  }
  if (machine?.remote.state === 'down') {
    const since = await downSince(db, 'remote_access');
    if (since && t - since.getTime() >= DOWN_AFTER_MS) out.push({ type: 'remote_access.down', ref: `down:${since.toISOString()}`, occurredAt: now, payload: { downMinutes: Math.floor((t - since.getTime()) / 60_000) } });
  }

  // Offsite copies: only once Will's key is here (before that none is sent, on purpose).
  if (offsiteWanted(config.home)) {
    const newest = (kind: string, location: string) => db.backupRun.findFirst({ where: { kind, location, status: 'ok' }, orderBy: { startedAt: 'desc' }, select: { id: true, startedAt: true } });
    const local = await newest('pg_dump_flint', 'local');
    const facts = { icloud: offsiteIsICloud(config.home) ? 1 : 0, local: local && t - local.startedAt.getTime() <= 26 * 3_600_000 ? 1 : 0 };
    const database = await newest('pg_dump_flint', 'icloud');
    // With no copy ever written there is no last good one to count from: the first is what the nightly job's own note is for.
    if (database && t - database.startedAt.getTime() > OFFSITE_STALE_MS) {
      out.push({ type: 'offsite.stale', ref: `database:after:${database.id}`, occurredAt: now, payload: { days: Math.floor((t - database.startedAt.getTime()) / 86_400_000), what: 'database', ...facts } });
    } else {
      // The database's copy is current: the files' copy is looked at on its own (one note for one outage, never two).
      const files = await newest('flint_tar', 'icloud');
      if (files && t - files.startedAt.getTime() > OFFSITE_STALE_MS) {
        out.push({ type: 'offsite.stale', ref: `files:after:${files.id}`, occurredAt: now, payload: { days: Math.floor((t - files.startedAt.getTime()) / 86_400_000), what: 'files', ...facts } });
      }
    }
  }

  // The deploy job stopped looking for updates, and nobody paused them (a pause has its own line in Health and its
  // own note; so has a pause that was lifted and not yet picked up). Three hours are counted from the last look or
  // from when this runtime started, whichever is later: the Mac being off, and a mark that came back from a backup
  // with its old time, are not three hours of not looking.
  const looked = lastUpdateCheck(config.home);
  if (looked !== undefined && !existsSync(join(config.home, '.flint', 'deploy-hold')) && !pausedMarkThere(config.home)) {
    const instance = await db.runtimeInstance.findFirst({ where: { stoppedAt: null }, orderBy: { startedAt: 'desc' }, select: { startedAt: true } });
    if (t - Math.max(looked, instance?.startedAt.getTime() ?? 0) > UPDATES_STALLED_MS) {
      out.push({ type: 'auto_update.stalled', ref: `since:${new Date(looked).toISOString()}`, occurredAt: now, payload: { hours: Math.floor((t - looked) / 3_600_000) } });
    }
  }

  // The MacBook's test of the offsite copies: only once it has reported one (it has its own line in Health from then on).
  const tested = await db.backupRun.findFirst({ where: { location: 'icloud', restoreTestedAt: { not: null } }, orderBy: { restoreTestedAt: 'desc' }, select: { id: true, restoreTestedAt: true } });
  if (tested?.restoreTestedAt && t - tested.restoreTestedAt.getTime() > OFFSITE_DRILL_STALE_MS) {
    out.push({ type: 'offsite_drill.stale', ref: `after:${tested.id}`, occurredAt: now, payload: { weeks: Math.floor((t - tested.restoreTestedAt.getTime()) / (7 * 86_400_000)) } });
  }
  return out;
}

export async function watchdog(db: Db, config: Pick<Config, 'home' | 'tz'>, now: Date, machine?: MachineReading): Promise<Raised[]> {
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
  // The same rule for Nexus's own backup (P7), while it is switched on, as an event of its own: once per last
  // good Nexus dump, whatever Flint's own backup is doing. Switched off nothing is looked at, and an old dump
  // left from when it was on raises nothing.
  if (nexusBackupWanted(config.home)) {
    const nexus = await db.backupRun.findFirst({ where: { kind: 'nexus_dump', location: 'local', status: 'ok' }, orderBy: { startedAt: 'desc' }, select: { id: true, startedAt: true } });
    if (nexus && now.getTime() - nexus.startedAt.getTime() > BACKUP_STALE_MS) {
      out.push({ type: 'nexus_backup.stale', ref: `after:${nexus.id}`, occurredAt: now, payload: { hoursSince: Math.floor((now.getTime() - nexus.startedAt.getTime()) / 3_600_000) } });
    }
  }

  // (The copies on this Mac: a test of an offsite copy is the MacBook's, and is not this one. And Flint's own
  // database: a test of Nexus's dump that failed is the Nexus job's own note, and Nexus Backup's line in Health.)
  const drill = await db.backupRun.findFirst({ where: { kind: 'pg_dump_flint', location: 'local', restoreTestedAt: { not: null } }, orderBy: { restoreTestedAt: 'desc' }, select: { id: true, restoreOk: true, restoreTestedAt: true, restoreDetail: true } });
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
  out.push(...(await machineConditions(db, config, now, machine)));
  return out;
}

/** The event's decision escalated and every one of its deliveries was held (shadow, or notify.* not promoted). */
async function heldOnly(tx: Tx, sourceRef: string): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ held: boolean }>>`
    SELECT bool_and(d.status = 'held') AS held FROM "SourceEvent" e
    JOIN "TriageDecision" t ON t."sourceEventId" = e.id
    JOIN "Escalation" x ON x."triageDecisionId" = t.id
    JOIN "EscalationDelivery" d ON d."escalationId" = x.id
    WHERE e.source = 'runtime' AND e."sourceRef" = ${sourceRef}`;
  return rows[0]?.held === true;
}

/**
 * Store raised conditions as applied runtime events (once per ref), each with
 * its triage job; returns the new ids. `retell`: triage and the console note
 * are promoted now, so a condition still holding whose only escalation was
 * held is told once more.
 */
export async function raise(db: Db, raised: readonly Raised[], now: Date, enqueue?: Enqueue, retell = false): Promise<string[]> {
  const ids: string[] = [];
  for (const r of raised) {
    const id = await db.$transaction(async (tx) => {
      const sourceRef = `${r.type}:${r.ref}`;
      const id = await recordEvent(tx, { source: 'runtime', sourceRef, type: r.type, occurredAt: r.occurredAt, sensitivity: 'ops', tainted: false, payload: r.payload }, now);
      if (!id) {
        // Seen before and still holding: if it is still undecided (triage was off), it is current, not old news.
        const again = await refreshUndecided(tx, 'runtime', sourceRef, now, r.payload);
        if (again && enqueue) await enqueue(tx, again);
        // Decided only in shadow (nothing delivered) and promoted since: told once more, as its own occurrence.
        if (!again && retell && (await heldOnly(tx, sourceRef))) {
          const told = await recordEvent(tx, { source: 'runtime', sourceRef: `${sourceRef}:retold`, type: r.type, occurredAt: now, sensitivity: 'ops', tainted: false, payload: r.payload }, now);
          if (told) {
            await markProcessed(tx, told, 'applied', now);
            if (enqueue) await enqueue(tx, told);
          }
          return told;
        }
        return null;
      }
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
