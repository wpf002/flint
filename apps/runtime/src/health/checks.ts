/**
 * The runtime's health checks (Machine plan P2, exit 1), every 5 minutes: a
 * closed list of components, each ok, degraded, down, unknown or disabled.
 * Unknown is never ok; a disabled source is shown and left out.
 *
 *  - postgres; the bus (dead-lettered jobs in the last day, jobs stuck active);
 *  - the server and Ollama, as the health source last saw them (no probe of
 *    their own: an observation older than 15 minutes is unknown);
 *  - each source: fresh within 2 cadences ok, within 6 degraded, else down; an
 *    open circuit (5 failures in a row) is down;
 *  - the last good local backup, the latest restore drill, open audit
 *    intents, the last retention run, a migration marked failed, triage.
 *
 * A detail is redacted and clipped to 300 characters: names and counts, never
 * a stranger's words. One audit entry per run carries the counts.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { redact, HEALTH_STATUS, type HealthReport } from '@flint/policy';
import type { z } from 'zod';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { appendAudit } from '../governance/audit.js';
import { uptime } from './instance.js';
import { CIRCUIT_FAILURES } from './circuits.js';

export type Status = (typeof HEALTH_STATUS)[number];
export interface ComponentCheck {
  component: string;
  status: Status;
  detail?: string;
}

export const OBSERVATION_STALE_MS = 15 * 60_000;
export const STUCK_ACTIVE_MS = 30 * 60_000;
export const DEPLOY_WINDOW_MS = 10 * 60_000;

export interface CheckDeps {
  db: Db;
  config: Pick<Config, 'home' | 'triage'>;
  now: Date;
  sources: ReadonlyArray<{ name: string; cadenceMs: number }>;
}

const clip = (s: string) => redact(s).slice(0, 300);

export async function checkComponents(d: CheckDeps): Promise<ComponentCheck[]> {
  const { db, now } = d;
  const out: ComponentCheck[] = [];
  const ago = (ms: number) => new Date(now.getTime() - ms);
  try {
    await db.$queryRaw`SELECT 1`;
    out.push({ component: 'postgres', status: 'ok' });
  } catch {
    // Nothing else can be read: say so and stop.
    return [{ component: 'postgres', status: 'down' }];
  }

  const bus = await db.$queryRaw<Array<{ dead: bigint; stuck: bigint }>>`
    SELECT (SELECT count(*) FROM pgboss.job WHERE name = 'dead' AND created_on > ${ago(24 * 3_600_000)}) AS dead,
           (SELECT count(*) FROM pgboss.job WHERE state = 'active' AND started_on < ${ago(STUCK_ACTIVE_MS)}) AS stuck`;
  const dead = Number(bus[0]?.dead ?? 0);
  const stuck = Number(bus[0]?.stuck ?? 0);
  out.push({ component: 'bus', status: dead || stuck ? 'degraded' : 'ok', ...(dead || stuck ? { detail: `${dead} dead-lettered in a day, ${stuck} stuck active` } : {}) });

  for (const [component, key] of [['server', 'service:endpoint:flint-server'], ['ollama', 'service:endpoint:ollama']] as const) {
    const e = await db.entity.findUnique({ where: { kind_key: { kind: 'service', key } }, select: { state: true, lastObservedAt: true } });
    const health = (e?.state as { health?: unknown } | null)?.health;
    if (!e || e.lastObservedAt < ago(OBSERVATION_STALE_MS)) out.push({ component, status: 'unknown', detail: e ? 'not observed in 15 minutes' : 'never observed' });
    else out.push({ component, status: health === 'ok' ? 'ok' : health === 'degraded' ? 'degraded' : 'down' });
  }

  const cursors = new Map((await db.sourceCursor.findMany()).map((c) => [c.source, c]));
  for (const s of d.sources) {
    const c = cursors.get(s.name);
    const component = `source:${s.name}`;
    if (!c?.enabled) {
      out.push({ component, status: 'disabled' });
      continue;
    }
    const age = c.lastOkAt ? now.getTime() - c.lastOkAt.getTime() : Infinity;
    const status: Status = c.consecutiveFailures >= CIRCUIT_FAILURES ? 'down' : age <= 2 * s.cadenceMs ? 'ok' : age <= 6 * s.cadenceMs ? 'degraded' : 'down';
    out.push({ component, status, ...(c.consecutiveFailures ? { detail: clip(`${c.consecutiveFailures} failure(s) in a row`) } : c.lastOkAt ? {} : { detail: 'no good run yet' }) });
  }

  const backup = await db.backupRun.findFirst({ where: { kind: 'pg_dump_flint', location: 'local', status: 'ok' }, orderBy: { startedAt: 'desc' }, select: { startedAt: true } });
  const backupH = backup ? (now.getTime() - backup.startedAt.getTime()) / 3_600_000 : Infinity;
  out.push({ component: 'backup', status: backupH <= 26 ? 'ok' : backupH <= 36 ? 'degraded' : 'down', detail: backup ? `${Math.round(backupH)} h old` : 'none yet' });

  // The latest drill only: one that failed and was then passed is passed.
  const drill = await db.backupRun.findFirst({ where: { restoreTestedAt: { not: null } }, orderBy: { restoreTestedAt: 'desc' }, select: { restoreTestedAt: true, restoreOk: true } });
  const drillD = drill?.restoreTestedAt ? (now.getTime() - drill.restoreTestedAt.getTime()) / 86_400_000 : Infinity;
  out.push({ component: 'restore_drill', status: drill?.restoreOk === false ? 'down' : drillD <= 8 ? 'ok' : 'degraded', detail: drill ? `${Math.round(drillD)} d ago` : 'never' });

  const open = Number((await db.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM audit_open_intents`)[0]?.n ?? 0);
  out.push({ component: 'audit_intents', status: open === 0 ? 'ok' : 'degraded', ...(open ? { detail: `${open} intent(s) without an outcome` } : {}) });

  const retention = await db.auditEntry.findFirst({ where: { action: 'maintenance.retention', kind: 'action' }, orderBy: { at: 'desc' }, select: { at: true, outcome: true } });
  out.push(
    !retention
      ? { component: 'retention', status: 'unknown', detail: 'has not run' }
      : { component: 'retention', status: retention.outcome === 'ok' && retention.at > ago(36 * 3_600_000) ? 'ok' : 'degraded', detail: `last run ${Math.round((now.getTime() - retention.at.getTime()) / 3_600_000)} h ago` },
  );

  const marker = join(d.config.home, '.flint', 'runtime', 'migrate-failed');
  const failed = existsSync(marker) ? [...new Set(readFileSync(marker, 'utf8').split('\n').map((l) => l.trim()).filter((l) => /^[0-9a-f]{40}$/.test(l)))] : [];
  out.push({ component: 'migrate_failed', status: failed.length ? 'down' : 'ok', ...(failed.length ? { detail: `not retried: ${failed.map((s) => s.slice(0, 7)).join(', ').slice(0, 200)}` } : {}) });

  if (!d.config.triage) out.push({ component: 'triage', status: 'disabled' });
  else {
    // The worker's own mark (an event decided without the model because chat stayed busy), within the hour.
    const deferred = await db.healthCheck.findFirst({ where: { component: 'triage.deferral', at: { gt: ago(3_600_000) } }, select: { detail: true } });
    out.push({ component: 'triage', status: deferred ? 'degraded' : 'ok', ...(deferred?.detail ? { detail: clip(deferred.detail) } : {}) });
  }
  return out;
}

export async function recordChecks(db: Db, checks: ComponentCheck[], at: Date): Promise<void> {
  await db.healthCheck.createMany({ data: checks.map((c) => ({ component: c.component, status: c.status, detail: c.detail ? clip(c.detail) : null, at })) });
  const counts = Object.fromEntries(HEALTH_STATUS.map((s) => [s, checks.filter((c) => c.status === s).length]));
  await appendAudit(db, [{
    actor: 'runtime:health', context: 'autonomous', kind: 'health', action: 'health.check', outcome: 'ok',
    inputs: { ...counts, notOk: checks.filter((c) => c.status !== 'ok' && c.status !== 'disabled').map((c) => c.component).slice(0, 40) },
  }], at);
}

/** The report the console shows (GET /v1/health/report): each component's latest check. */
export async function healthReport(db: Db, config: Pick<Config, 'triage'>, now = new Date()): Promise<z.infer<typeof HealthReport>> {
  const rows = await db.$queryRaw<Array<{ component: string; status: Status; detail: string | null; at: Date }>>`
    SELECT DISTINCT ON (component) component, status, detail, at FROM "HealthCheck" ORDER BY component, at DESC`;
  const instance = await db.runtimeInstance.findFirst({ where: { stoppedAt: null }, orderBy: { startedAt: 'desc' } });
  const from = new Date(now.getTime() - 14 * 86_400_000);
  const beats = await db.runtimeInstance.findMany({ where: { lastBeatAt: { gt: from } }, select: { startedAt: true, lastBeatAt: true } });
  // A deploy is planned down time: the 10 minutes up to each finished or failed deploy count neither way.
  const deploys = await db.sourceEvent.findMany({ where: { source: 'deploy', occurredAt: { gt: from } }, select: { occurredAt: true } });
  const excluded = deploys.map((e) => ({ start: new Date(e.occurredAt.getTime() - DEPLOY_WINDOW_MS), end: e.occurredAt }));
  const last = rows.reduce<Date | null>((m, r) => (!m || r.at > m ? r.at : m), null);
  return {
    at: now.toISOString(),
    instance: instance ? { gitSha: instance.gitSha, startedAt: instance.startedAt.toISOString(), lastBeatAt: instance.lastBeatAt.toISOString() } : null,
    uptime14d: beats.length ? Math.round(uptime(beats, from, now, excluded) * 10_000) / 10_000 : null,
    components: rows.map((r) => ({ component: r.component, status: r.status, detail: r.detail, at: r.at.toISOString() })),
    lastHealthRun: last ? last.toISOString() : null,
    triage: config.triage ? 'on' : 'off',
  };
}
