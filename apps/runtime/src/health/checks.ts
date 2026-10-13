/**
 * The runtime's health checks (Machine plan P2, exit 1), every 5 minutes: a
 * closed list of components, each ok, degraded, down, unknown or disabled.
 * Unknown is never ok; a disabled source is shown and left out.
 *
 *  - postgres; the bus (dead-lettered jobs in the last day, jobs stuck active);
 *  - the server and Ollama, as the health source last saw them (no probe of
 *    their own: an observation older than 15 minutes is unknown);
 *  - each source: fresh within 2 cadences ok, within 6 degraded, else down; an
 *    open circuit (5 failures in a row) is down; a good run's warnings in
 *    words (degraded when Will has something to see to); Apple Calendar
 *    disconnected in Flint Calendar is ok, quiet on purpose, and never stale;
 *  - the last good local backup, the last encrypted copy offsite (off until
 *    Will's age key is here), the latest restore drill, open audit intents,
 *    the last retention run, a migration marked failed, triage;
 *  - whether updates are paused (the deploy hold: degraded for as long as it is
 *    there, with its age), and how the last rebuild rehearsal went (run weekly
 *    and by the deploy gate; a pass over 8 days old is degraded, a failure is
 *    down, none yet is unknown). Both are read from files the deploy scripts keep;
 *  - goal reviews (P3): disabled while the planner is off; degraded when an
 *    active goal's review is over an hour late, when a review gave up waiting
 *    for chat within the hour, or when a rule forbids reviews; down when one is
 *    over a day late (which must not happen in normal operation);
 *  - prediction checks (P4): disabled while predictions are off (the switch, or
 *    no signed Turn On Predictions card yet); degraded when the hourly check has
 *    not run in 3 hours, when the database refused one of its writes, when a
 *    prediction's rule is one no resolver knows, when the night's scores are
 *    over two days old, or when a rule forbids the checks; down when no check
 *    ran in 26 hours;
 *  - forecasts (P4): disabled while predictions are off or no number is on;
 *    degraded when last night's forecasts or numbers did not run, when one
 *    failed, or when a rule forbids forecasting; down after two nights;
 *  - tasks (P5): disabled while they are switched off or no asset that runs
 *    tasks is on; degraded when a task is still out well past the day the task
 *    tick gives it (the tick is not running), or when a rule stops Flint from
 *    checking results.
 *
 * A detail is redacted and clipped to 300 characters: names and counts, never
 * a stranger's words. One audit entry per run carries the counts.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { localDay, redact, resolveTier, runsInShadow, HEALTH_STATUS, REVIEW_DOWN_MS, REVIEW_LATE_MS, TASK_ASSET_KINDS, type HealthReport } from '@flint/policy';
import type { z } from 'zod';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { appendAudit } from '../governance/audit.js';
import { revokedIn } from '../sources/apple/calendar.js';
import { uptime } from './instance.js';
import { standbyModelCheck, diskCheck, localModelCheck, remoteAccessCheck, type MachineReading } from './machine.js';
import { CIRCUIT_FAILURES } from './circuits.js';
import { REVIEWS_STOPPED, waitedMs } from '../goals/late.js';
import { reviewStanding } from '../goals/review.js';
import { activePolicies } from '../governance/proposals.js';
import { SNAPSHOT_ACTION } from '../ledger/calibration.js';
import { LEDGER_ACTOR, SWEEP_ACTION } from '../ledger/sweep.js';
import { FORECAST_ACTOR, RUN_ACTION, SERIES_ACTION } from '../predict/run.js';
import { checkStanding } from '../tasks/check.js';
import { STALE_MS } from '../tasks/tick.js';

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
  config: Pick<Config, 'home' | 'triage' | 'tz'> & Partial<Pick<Config, 'planner' | 'ollama' | 'predict' | 'standbyModel' | 'assets'>>;
  now: Date;
  sources: ReadonlyArray<{ name: string; cadenceMs: number }>;
  /**
   * What was read from the Mac itself for this run (machine.ts): free space,
   * remote access, the local models. Absent (a test of the other checks), the
   * components that need it are left out.
   */
  machine?: MachineReading;
}

const clip = (s: string) => redact(s).slice(0, 300);
/** How many of Will's calendar days lie between two times (0: the same local day). */
export const calendarDaysBetween = (tz: string, from: Date, to: Date): number =>
  Math.round((Date.parse(`${localDay(tz, to)}T00:00:00Z`) - Date.parse(`${localDay(tz, from)}T00:00:00Z`)) / 86_400_000);
/** "1 hour", "3 hours": each detail is a sentence Will reads in Settings > Health. */
const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * A good run's warnings (its last error, with no failure counted), matched on the calendar sources' own
 * wording: an item set aside or a listing cut at its limit (calendar/core.ts, google/calendar.ts,
 * apple/calendar.ts) skipped something (how much is not kept: "at least one item"); Apple's other three
 * skip nothing. Only a skip or no calendars at all is degraded: a change of calendars lasts one run, and
 * events missing are archived or come back within the hour, so neither puts Apple Calendar in the
 * morning digest.
 */
const WARNINGS: ReadonlyArray<{ said: RegExp; detail: string; degraded: boolean }> = [
  { said: /\bset aside\b|the rest are not read|sent only part of/, detail: 'The last read skipped at least one item.', degraded: true },
  { said: /no calendars are chosen in Flint Calendar/, detail: 'No calendars are chosen in Flint Calendar, or iCloud Calendar is off.', degraded: true },
  { said: /the calendars Flint Calendar reads have changed/, detail: 'The calendars Flint Calendar reads changed, so nothing missing was archived.', degraded: false },
  { said: /events ahead are missing from Flint Calendar/, detail: 'Some events are missing from Flint Calendar. They’re archived if still missing in an hour.', degraded: false },
];
/** What a good run's warnings say, and whether that is an issue. Wording no rule knows is one, said plainly. */
function warned(lastError: string): { detail: string; degraded: boolean } {
  const hits = WARNINGS.filter((w) => w.said.test(lastError));
  if (!hits.length) return { detail: 'The last read finished with a warning.', degraded: true };
  return { detail: hits.map((w) => w.detail).join(' '), degraded: hits.some((w) => w.degraded) };
}

/** Whether the nightly job sends an offsite copy at all: Will's age key is on this Mac (a file that is not empty). */
export function offsiteWanted(home: string): boolean {
  try {
    return statSync(join(home, '.flint', 'backup-age-recipient')).size > 0;
  } catch {
    return false;
  }
}

/** What Automatic Updates and Rebuild Rehearsal say in Settings > Health: sentences from a time, never a file's words. */
export const UPKEEP_HEALTH = {
  paused: (ms: number) => {
    const h = Math.floor(ms / 3_600_000);
    return `Updates have been paused for ${h < 1 ? 'less than an hour' : h < 48 ? count(h, 'hour') : count(Math.floor(h / 24), 'day')}.`;
  },
  /** The pause was lifted and the deploy job has not looked since. */
  resuming: 'Updates were paused, and Flint hasn’t checked again yet.',
  /** How long ago the deploy job last looked for an update (it looks every two minutes). */
  checked: (ms: number) => {
    const m = Math.floor(ms / 60_000);
    const h = Math.floor(m / 60);
    return `Flint checked for updates ${m < 1 ? 'less than a minute' : m < 120 ? count(m, 'minute') : h < 48 ? count(h, 'hour') : count(Math.floor(h / 24), 'day')} ago.`;
  },
  notChecked: (ms: number) => {
    const h = Math.floor(ms / 3_600_000);
    return `Flint hasn’t checked for updates in ${h < 48 ? count(Math.max(1, h), 'hour') : count(Math.floor(h / 24), 'day')}.`;
  },
  neverChecked: 'Flint hasn’t checked for updates since it was installed.',
  passed: (when: string) => `The rebuild rehearsal last passed ${when}.`,
  failed: (when: string) => `The rebuild rehearsal failed ${when}.`,
  never: 'The rebuild rehearsal has not run yet.',
} as const;

/** A weekly rehearsal, a day's grace: a last pass older than this is overdue. */
export const REHEARSAL_STALE_DAYS = 8;

/**
 * Automatic updates: paused while ~/.flint/deploy-hold exists (apps/server/auto_deploy.sh skips every
 * tick; apps/studio/rollback.sh makes the file after putting an earlier version back). A pause is
 * meant to be short, and nothing else on screen would say it is still on, so it is an issue for as
 * long as it lasts, with its age: the hold file's own time.
 */
export function deployHold(home: string, now: Date): ComponentCheck {
  const component = 'deploy_hold';
  const age = (file: string): number | undefined => {
    try {
      return Math.max(0, now.getTime() - statSync(join(home, '.flint', file)).mtimeMs);
    } catch {
      return undefined;
    }
  };
  const held = age('deploy-hold');
  if (held !== undefined) return { component, status: 'degraded', detail: UPKEEP_HEALTH.paused(held) };
  // The pause was lifted and the deploy job has not looked since: it keeps this mark from the first tick that found
  // the pause until its first look after it. Said as that, so the time it was paused is never read as time it
  // failed to look. (Minutes, normally. If the job has died it stays, as an issue, which it is.)
  if (pausedMarkThere(home)) return { component, status: 'degraded', detail: UPKEEP_HEALTH.resuming };
  return { component, status: 'ok' };
}

/** The deploy job's own mark that updates were paused and it has not looked since (apps/server/auto_deploy.sh, HOLD_SEEN). */
export function pausedMarkThere(home: string): boolean {
  return existsSync(join(home, '.flint', 'deploy-hold-seen'));
}

/**
 * The rebuild rehearsal (apps/studio/run_rehearsal.sh: a made-up Flint backed up and rebuilt into a
 * scratch folder, every Sunday and whenever a deploy changes what a rebuild is made of). Its last
 * line in ~/.flint/rehearsal-result, "<passed|failed> <when, in seconds> <commit>", is all that is
 * read. A failure is down: a rebuild would not work today. A line that cannot be read is no result.
 */
export function rebuildRehearsal(home: string, tz: string, now: Date): ComponentCheck {
  const component = 'rebuild_rehearsal';
  let line = '';
  try {
    line = readFileSync(join(home, '.flint', 'rehearsal-result'), 'utf8').split('\n')[0]!.trim();
  } catch {
    // No result yet.
  }
  const m = /^(passed|failed) (\d{9,11})(?: (?:[0-9a-f]{40}|-))?$/.exec(line);
  if (!m) return { component, status: 'unknown', detail: UPKEEP_HEALTH.never };
  const at = new Date(Number(m[2]) * 1000);
  const days = calendarDaysBetween(tz, at, now);
  const when = days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${count(days, 'day')} ago`;
  if (m[1] === 'failed') return { component, status: 'down', detail: UPKEEP_HEALTH.failed(when) };
  return { component, status: (now.getTime() - at.getTime()) / 86_400_000 <= REHEARSAL_STALE_DAYS ? 'ok' : 'degraded', detail: UPKEEP_HEALTH.passed(when) };
}

/** How bad a status is, to say the worse of two. */
const HEALTH_RANK: Record<Status, number> = { disabled: 0, ok: 1, unknown: 2, degraded: 3, down: 4 };

/** What Database says in Settings > Health when it is up and something in it is not Flint's. */
export const DATABASE_HEALTH = {
  largeObjects: (n: number) => (n === 1 ? 'The database holds 1 large object that isn’t Flint’s. No backup includes it.' : `The database holds ${n} large objects that aren’t Flint’s. No backup includes them.`),
} as const;

/** What Backups, Files Backup, Offsite Backup and Offsite Restore Test say beyond a copy's age. */
export const BACKUP_HEALTH = {
  failed: 'The last backup failed.',
  filesNone: 'No files backup is on record yet.',
  filesFailed: 'The last files backup failed.',
  filesAge: (hours: number) => `The last files backup is ${count(hours, 'hour')} old.`,
  filesOffsiteNone: 'There’s no offsite copy of your files yet.',
  filesOffsiteFailed: 'The last files copy didn’t go offsite.',
  filesOffsiteAge: (hours: number) => `The offsite copy of your files is ${count(hours, 'hour')} old.`,
  drillPassed: (when: string) => `Your MacBook restored an offsite copy ${when}.`,
  drillFailed: (when: string) => `Your MacBook’s last test of an offsite copy failed ${when}.`,
  drillLate: (days: number) => `Your MacBook hasn’t tested an offsite copy in ${days < 14 ? count(days, 'day') : count(Math.floor(days / 7), 'week')}.`,
} as const;

/** A copy older than this is late (degraded); older than the next, missing (down). The nightly jobs run a day apart. */
const LATE_HOURS = 26;
const MISSING_HOURS = 36;
/** A weekly test, a day's grace. */
export const OFFSITE_DRILL_STALE_DAYS = 8;
/** The deploy job looks for an update every two minutes; a deploy's own checks can hold one look for a quarter of an hour. */
export const UPDATE_LATE_MS = 60 * 60_000;
/** A runtime that just started is given this long before a missing first look is said. */
export const UPDATE_GRACE_MS = 15 * 60_000;

type Backups = Pick<Db, 'backupRun'>;

/** Did a run of this kind fail after `since` (the last good one), or ever, when there is no good one? */
async function newerFailure(db: Backups, kind: string, location: string, since: Date | undefined): Promise<boolean> {
  return (await db.backupRun.findFirst({ where: { kind, location, status: 'failed', ...(since ? { startedAt: { gt: since } } : {}) }, select: { id: true } })) !== null;
}

async function newestGood(db: Backups, kind: string, location: string): Promise<Date | undefined> {
  return (await db.backupRun.findFirst({ where: { kind, location, status: 'ok' }, orderBy: { startedAt: 'desc' }, select: { startedAt: true } }))?.startedAt;
}

/**
 * The nightly archive of Flint's files (apps/studio/backup_flint.sh), from the
 * records the runtime reads out of that job's own lines (backup/ingest.ts). A
 * run that failed since the last good archive is said at once; with nothing on
 * record at all it has not reported yet (it does from its first night).
 */
async function filesBackup(db: Backups, now: Date): Promise<ComponentCheck> {
  const component = 'files_backup';
  const good = await newestGood(db, 'flint_tar', 'local');
  const failed = await newerFailure(db, 'flint_tar', 'local', good);
  if (!good && !failed) return { component, status: 'unknown', detail: BACKUP_HEALTH.filesNone };
  const hours = good ? (now.getTime() - good.getTime()) / 3_600_000 : Infinity;
  return {
    component, status: hours > MISSING_HOURS ? 'down' : hours > LATE_HOURS || failed ? 'degraded' : 'ok',
    detail: failed || !good ? BACKUP_HEALTH.filesFailed : BACKUP_HEALTH.filesAge(Math.round(hours)),
  };
}

/** The files archive's encrypted copy offsite; undefined until the files backup has written its first record. */
async function filesOffsite(db: Backups, now: Date): Promise<ComponentCheck | undefined> {
  const component = 'offsite_backup';
  if (!(await db.backupRun.findFirst({ where: { kind: 'flint_tar' }, select: { id: true } }))) return undefined;
  const good = await newestGood(db, 'flint_tar', 'icloud');
  const failed = await newerFailure(db, 'flint_tar', 'icloud', good);
  const hours = good ? (now.getTime() - good.getTime()) / 3_600_000 : Infinity;
  return {
    component, status: hours > MISSING_HOURS ? 'down' : hours > LATE_HOURS || failed ? 'degraded' : 'ok',
    detail: failed ? BACKUP_HEALTH.filesOffsiteFailed : good ? BACKUP_HEALTH.filesOffsiteAge(Math.round(hours)) : BACKUP_HEALTH.filesOffsiteNone,
  };
}

/**
 * The MacBook's own test of the offsite copies: it restores one and reports
 * the result, which is kept on that copy's record. Off until a first result
 * arrives (nothing reports one yet); from then on a failure is down and a week
 * without one is late.
 */
async function offsiteDrill(db: Backups, tz: string, now: Date): Promise<ComponentCheck> {
  const component = 'offsite_drill';
  const t = await db.backupRun.findFirst({ where: { location: 'icloud', restoreTestedAt: { not: null } }, orderBy: { restoreTestedAt: 'desc' }, select: { restoreTestedAt: true, restoreOk: true } });
  if (!t?.restoreTestedAt) return { component, status: 'disabled' };
  const days = calendarDaysBetween(tz, t.restoreTestedAt, now);
  const when = days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${count(days, 'day')} ago`;
  if (t.restoreOk === false) return { component, status: 'down', detail: BACKUP_HEALTH.drillFailed(when) };
  if ((now.getTime() - t.restoreTestedAt.getTime()) / 86_400_000 <= OFFSITE_DRILL_STALE_DAYS) return { component, status: 'ok', detail: BACKUP_HEALTH.drillPassed(when) };
  return { component, status: 'degraded', detail: BACKUP_HEALTH.drillLate(Math.max(days, OFFSITE_DRILL_STALE_DAYS + 1)) };
}

/** When the deploy job last looked for an update: the time on ~/.flint/deploy-tick, which it touches at every look. */
export function lastUpdateCheck(home: string): number | undefined {
  try {
    return statSync(join(home, '.flint', 'deploy-tick')).mtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * Automatic updates, whole: paused (deployHold), or not looking. The deploy job
 * looks for an update every two minutes and leaves the time of each look; an
 * hour without one means the job has stopped, and nothing else would say so.
 *
 * The hour is counted from the last look or from when this runtime started,
 * whichever is later. So the hours the Mac was off are not hours of not
 * looking, and neither is the age of a mark that came back from a backup with
 * its old time (a rebuild): each is given its hour first. With no look on
 * record at all, a runtime that just started says nothing yet.
 */
async function updates(d: CheckDeps): Promise<ComponentCheck> {
  const hold = deployHold(d.config.home, d.now);
  if (hold.status !== 'ok') return hold;
  const component = hold.component;
  const at = lastUpdateCheck(d.config.home);
  const instance = await d.db.runtimeInstance.findFirst({ where: { stoppedAt: null }, orderBy: { startedAt: 'desc' }, select: { startedAt: true } });
  if (at === undefined) {
    if (!instance || d.now.getTime() - instance.startedAt.getTime() <= UPDATE_GRACE_MS) return hold;
    return { component, status: 'unknown', detail: UPKEEP_HEALTH.neverChecked };
  }
  const age = Math.max(0, d.now.getTime() - at);
  const quiet = d.now.getTime() - Math.max(at, instance?.startedAt.getTime() ?? 0);
  return quiet > UPDATE_LATE_MS ? { component, status: 'degraded', detail: UPKEEP_HEALTH.notChecked(age) } : { component, status: 'ok', detail: UPKEEP_HEALTH.checked(age) };
}

export async function checkComponents(d: CheckDeps): Promise<ComponentCheck[]> {
  const { db, now } = d;
  const out: ComponentCheck[] = [];
  const ago = (ms: number) => new Date(now.getTime() - ms);
  try {
    // Flint keeps nothing in large objects, and its backups leave them out (backup.ts, DUMP_FORMAT). One that is
    // there was put there by something else, and is in no backup: said, so it is not found out at a restore.
    const large = Number((await db.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM pg_largeobject_metadata`)[0]?.n ?? 0);
    out.push(large === 0 ? { component: 'postgres', status: 'ok' } : { component: 'postgres', status: 'degraded', detail: DATABASE_HEALTH.largeObjects(large) });
  } catch {
    // Nothing else can be read: say so and stop.
    return [{ component: 'postgres', status: 'down' }];
  }

  const bus = await db.$queryRaw<Array<{ dead: bigint; stuck: bigint }>>`
    SELECT (SELECT count(*) FROM pgboss.job WHERE name = 'dead' AND created_on > ${ago(24 * 3_600_000)}) AS dead,
           (SELECT count(*) FROM pgboss.job WHERE state = 'active' AND started_on < ${ago(STUCK_ACTIVE_MS)}) AS stuck`;
  const dead = Number(bus[0]?.dead ?? 0);
  const stuck = Number(bus[0]?.stuck ?? 0);
  const busDetail = dead && stuck
    ? `The queue had ${count(dead, 'failed job')} in the last day and has ${stuck} stuck now.`
    : dead ? `The queue had ${count(dead, 'failed job')} in the last day.` : `The queue has ${count(stuck, 'job')} stuck for over 30 minutes.`;
  out.push({ component: 'bus', status: dead || stuck ? 'degraded' : 'ok', ...(dead || stuck ? { detail: busDetail } : {}) });

  for (const [component, key] of [['server', 'service:endpoint:flint-server'], ['ollama', 'service:endpoint:ollama']] as const) {
    const e = await db.entity.findUnique({ where: { kind_key: { kind: 'service', key } }, select: { state: true, lastObservedAt: true } });
    const health = (e?.state as { health?: unknown } | null)?.health;
    const seen: ComponentCheck = !e || e.lastObservedAt < ago(OBSERVATION_STALE_MS)
      ? { component, status: 'unknown', detail: e ? 'It hasn’t been checked in 15 minutes.' : 'It hasn’t been checked yet.' }
      : { component, status: health === 'ok' ? 'ok' : health === 'degraded' ? 'degraded' : 'down' };
    // "Ollama answers" is not "the model Flint asks is there": with the Mac's own reading, the local model says which.
    out.push(component === 'ollama' && d.machine ? localModelCheck(seen, d.config.ollama?.model, d.machine.models) : seen);
  }
  const standby = d.machine ? standbyModelCheck(d.config.standbyModel, d.machine.models) : undefined;
  if (standby) out.push(standby);
  else if (d.config.standbyModel === undefined) {
    // No standby is named any more. A line about one that was (that it isn't installed, say) would stand as the
    // latest word on it until it is cleaned up a month later: it is said to be off, once.
    const last = await db.healthCheck.findFirst({ where: { component: 'standby_model' }, orderBy: { at: 'desc' }, select: { status: true } });
    if (last && last.status !== 'disabled') out.push({ component: 'standby_model', status: 'disabled' });
  }

  const cursors = new Map((await db.sourceCursor.findMany()).map((c) => [c.source, c]));
  for (const s of d.sources) {
    const c = cursors.get(s.name);
    const component = `source:${s.name}`;
    if (!c?.enabled) {
      out.push({ component, status: 'disabled' });
      continue;
    }
    // Disconnected in Flint Calendar: every run is idle until it connects again, so lastOkAt stands still on purpose.
    if (s.name === 'apple_calendar' && !c.consecutiveFailures && revokedIn(c.cursor)) {
      out.push({ component, status: 'ok', detail: 'It’s disconnected in Flint Calendar.' });
      continue;
    }
    const age = c.lastOkAt ? now.getTime() - c.lastOkAt.getTime() : Infinity;
    const fresh: Status = c.consecutiveFailures >= CIRCUIT_FAILURES ? 'down' : age <= 2 * s.cadenceMs ? 'ok' : age <= 6 * s.cadenceMs ? 'degraded' : 'down';
    // A run that succeeded with warnings (a calendar item set aside, no calendars chosen) says so: its last error holds what.
    // One Will has to see to is degraded, not ok, so the console lists it as an issue rather than folding it under "Normal".
    const warning = !c.consecutiveFailures && !!c.lastOkAt && !!c.lastError ? warned(c.lastError) : undefined;
    const status: Status = fresh === 'ok' && warning?.degraded ? 'degraded' : fresh;
    const detail = c.consecutiveFailures
      ? c.consecutiveFailures === 1 ? 'The last read failed.' : `The last ${c.consecutiveFailures} reads failed.`
      : !c.lastOkAt ? 'It hasn’t had a good read yet.' : warning?.detail;
    out.push({ component, status, ...(detail ? { detail: clip(detail) } : {}) });
  }

  const backup = await db.backupRun.findFirst({ where: { kind: 'pg_dump_flint', location: 'local', status: 'ok' }, orderBy: { startedAt: 'desc' }, select: { startedAt: true } });
  const backupH = backup ? (now.getTime() - backup.startedAt.getTime()) / 3_600_000 : Infinity;
  // A run that failed since the last good one is said at once, not left to show as a backup growing old.
  const backupFailed = await newerFailure(db, 'pg_dump_flint', 'local', backup?.startedAt);
  out.push({
    component: 'backup', status: backupH > 36 ? 'down' : backupH > 26 || backupFailed ? 'degraded' : 'ok',
    detail: backupFailed ? BACKUP_HEALTH.failed : backup ? `The last backup is ${count(Math.round(backupH), 'hour')} old.` : 'There’s no backup yet.',
  });
  out.push(await filesBackup(db, now));

  // The encrypted copy off this Mac. The nightly job sends one only once Will's age key is here
  // (backup-nightly.sh), so without the key it is off, not failing. With it, a copy that is missing or
  // stale is an issue Settings > Health and the morning digest name, whatever the job's own note said.
  if (!offsiteWanted(d.config.home)) out.push({ component: 'offsite_backup', status: 'disabled' });
  else {
    const offsite = await db.backupRun.findFirst({ where: { kind: 'pg_dump_flint', location: 'icloud', status: 'ok' }, orderBy: { startedAt: 'desc' }, select: { startedAt: true } });
    const offsiteH = offsite ? (now.getTime() - offsite.startedAt.getTime()) / 3_600_000 : Infinity;
    const database: ComponentCheck = {
      component: 'offsite_backup', status: offsiteH <= 26 ? 'ok' : offsiteH <= 36 ? 'degraded' : 'down',
      detail: offsite ? `The last offsite copy is ${count(Math.round(offsiteH), 'hour')} old.` : 'There’s no offsite copy yet.',
    };
    // The files archive goes offsite too, by its own job. Its copy is looked at once that job has written its
    // first record, and what is said is whichever of the two copies is worse off.
    const files = await filesOffsite(db, now);
    out.push(files && HEALTH_RANK[files.status] > HEALTH_RANK[database.status] ? files : database);
  }

  // The latest drill only: one that failed and was then passed is passed.
  // (The copies on this Mac: an offsite copy's test is the MacBook's, and has its own line below.)
  const drill = await db.backupRun.findFirst({ where: { location: 'local', restoreTestedAt: { not: null } }, orderBy: { restoreTestedAt: 'desc' }, select: { restoreTestedAt: true, restoreOk: true } });
  const drillD = drill?.restoreTestedAt ? (now.getTime() - drill.restoreTestedAt.getTime()) / 86_400_000 : Infinity;
  // "today" and "yesterday" are Will's calendar days, not 24-hour spans: a 2:15 AM test is "today" all that day.
  const days = drill?.restoreTestedAt ? calendarDaysBetween(d.config.tz, drill.restoreTestedAt, now) : 0;
  const tested = days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${count(days, 'day')} ago`;
  out.push({
    component: 'restore_drill', status: drill?.restoreOk === false ? 'down' : drillD <= 8 ? 'ok' : 'degraded',
    detail: !drill ? 'No restore test has run yet.' : drill.restoreOk === false ? `The last restore test failed ${tested}.` : `The last restore test was ${tested}.`,
  });
  out.push(await offsiteDrill(db, d.config.tz, now));

  const open = Number((await db.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM audit_open_intents`)[0]?.n ?? 0);
  out.push({ component: 'audit_intents', status: open === 0 ? 'ok' : 'degraded', ...(open ? { detail: open === 1 ? 'The log is missing the result for 1 action.' : `The log is missing results for ${open} actions.` } : {}) });

  const retention = await db.auditEntry.findFirst({ where: { action: 'maintenance.retention', kind: 'action' }, orderBy: { at: 'desc' }, select: { at: true, outcome: true } });
  out.push(
    !retention
      ? { component: 'retention', status: 'unknown', detail: 'It hasn’t run yet.' }
      : (() => {
          const ok = retention.outcome === 'ok' && retention.at > ago(36 * 3_600_000);
          const h = Math.round((now.getTime() - retention.at.getTime()) / 3_600_000);
          const ran = h ? `${count(h, 'hour')} ago` : 'less than an hour ago';
          // At APPROVAL it waits for Will's nightly card: overdue until he approves or promotes it.
          // A run that failed says so, however recent; an ok one is overdue only past 36 hours.
          const detail = retention.outcome !== 'ok' ? `Its last run failed ${ran}.` : ok ? `It last ran ${ran}.` : `It’s overdue. It last ran ${ran}.`;
          return { component: 'retention', status: ok ? ('ok' as const) : ('degraded' as const), detail };
        })(),
  );

  const marker = join(d.config.home, '.flint', 'runtime', 'migrate-failed');
  const failed = existsSync(marker) ? [...new Set(readFileSync(marker, 'utf8').split('\n').map((l) => l.trim()).filter((l) => /^[0-9a-f]{40}$/.test(l)))] : [];
  out.push({ component: 'migrate_failed', status: failed.length ? 'down' : 'ok', ...(failed.length ? { detail: failed.length === 1 ? 'A database update failed and won’t be retried until it’s fixed.' : 'Several database updates failed and won’t be retried until they’re fixed.' } : {}) });

  out.push(await updates(d));
  if (d.machine) {
    out.push(diskCheck(d.machine.freeBytes));
    out.push(remoteAccessCheck(d.machine.remote, now));
  }
  out.push(rebuildRehearsal(d.config.home, d.config.tz, now));

  if (!d.config.triage) out.push({ component: 'triage', status: 'disabled' });
  else {
    // The worker's own mark (an event decided without the model because chat stayed busy), within the hour.
    const deferred = await db.healthCheck.findFirst({ where: { component: 'triage.deferral', at: { gt: ago(3_600_000) } }, select: { detail: true } });
    out.push({ component: 'triage', status: deferred ? 'degraded' : 'ok', ...(deferred?.detail ? { detail: clip(deferred.detail) } : {}) });
  }

  out.push(await goalReviews(d));
  out.push(await predictionChecks(d));
  out.push(await forecasts(d));
  out.push(await tasks(d));
  return out;
}

/** What Tasks says in Settings > Health: sentences from counts, never a task's words. */
export const TASK_HEALTH = {
  none: 'No task has run yet.',
  stuck: (n: number) => (n === 1 ? 'A task is past its time and hasn’t been ended.' : `${n} tasks are past their time and haven’t been ended.`),
  stopped: 'A rule stops Flint from checking results, so finished tasks wait.',
} as const;
/** How long past the tick's own limit a task may sit before Health says so. */
const TASK_STUCK_SLACK_MS = 3_600_000;

/**
 * Tasks (P5): are they moving? Counts only: a detail never names a task.
 * Nothing can run while they are switched off or no asset that runs tasks is
 * on, so the row is shown and left out. The tick ends a task that has not moved
 * for a day; one still out an hour past that means the tick is not running. (A
 * result waiting for Will's accept card is not stuck: it waits as long as its
 * card does.)
 */
async function tasks(d: CheckDeps): Promise<ComponentCheck> {
  const { db, now } = d;
  const component = 'tasks';
  if (d.config.assets === false || !(await db.asset.count({ where: { enabled: true, kind: { in: [...TASK_ASSET_KINDS] } } }))) return { component, status: 'disabled' };
  const stuck = await db.task.count({ where: { status: { in: ['queued', 'dispatched', 'running', 'submitted'] }, updatedAt: { lt: new Date(now.getTime() - STALE_MS - TASK_STUCK_SLACK_MS) } } });
  if (stuck) return { component, status: 'degraded', detail: TASK_HEALTH.stuck(stuck) };
  if ((await checkStanding(db, now)) === 'stopped') return { component, status: 'degraded', detail: TASK_HEALTH.stopped };
  const ran = await db.task.count({ where: { dispatchedAt: { not: null } } });
  return { component, status: 'ok', ...(ran ? {} : { detail: TASK_HEALTH.none }) };
}

/** Last night's run is this old: it was missed (the jobs run once a night). */
export const FORECASTS_LATE_MS = 26 * 3_600_000;
/** Two nights were missed: down. */
export const FORECASTS_DOWN_MS = 50 * 3_600_000;
/** How long a runtime that just started is given to catch up on a night it missed (the jobs run once at start when one was). */
export const FORECASTS_RESTART_GRACE_MS = 70 * 60_000;

/** What Forecasts says in Settings > Health: sentences from counts, never a number a series took or a series' key. */
export const FORECAST_HEALTH = {
  stopped: 'A rule stops Flint from forecasting.',
  starting: 'Forecasts start tonight.',
  /** Last night's run, inside the last 26 hours: how many numbers have their forecast, and how many are waiting for yesterday's number. Never said of none. */
  ran: (n: number, late = 0) =>
    late === 0 ? `Last night’s forecasts ran for ${count(n, 'number')}.` : `Last night’s forecasts ran for ${count(n, 'number')}, and ${late} ${late === 1 ? 'is' : 'are'} waiting for yesterday’s number.`,
  waiting: (n: number) => (n === 1 ? 'Flint needs more history before it forecasts its number.' : `Flint needs more history before it forecasts its ${n} numbers.`),
  late: (n: number) => (n === 1 ? 'Yesterday’s number isn’t in, so Flint didn’t forecast it.' : `Yesterday’s numbers aren’t in for ${n} numbers, so Flint didn’t forecast them.`),
  missed: 'Forecasts didn’t run last night.',
  down: (days: number) => `Forecasts haven’t run in ${count(days, 'day')}.`,
  failed: (n: number) => `${count(n, 'forecast')} failed last night.`,
  refused: (n: number) => `The database refused ${count(n, 'forecast')} last night.`,
  capped: (n: number) => `The daily limit on forecasts was reached, so ${n === 1 ? '1 number waits' : `${n} numbers wait`} until tomorrow.`,
  noNumbers: 'Flint didn’t record yesterday’s numbers.',
  numbersFailed: (n: number) => `Flint couldn’t record ${count(n, 'number')} last night.`,
} as const;

/**
 * Forecasts (P4): did last night's numbers and forecasts run? Counts only, read
 * from the two jobs' own audit entries (one per run, the forecast writer's
 * alone).
 *  - Off while FLINT_PREDICT is off, and while no number is on.
 *  - How long since the last run is counted from that run, or from the first
 *    turn-on when there has been none: the days before predictions were on
 *    never read as a missed night.
 *  - A runtime that just started is given 70 minutes to catch up (the jobs run
 *    once at start when a night was missed): inside it, the quiet time counts
 *    from the start. After it a restart excuses nothing, so a runtime that
 *    restarts every day and never forecasts reads missed, then down. (Before,
 *    a restart 20 hours earlier made a forecaster dead for 40 days read
 *    Normal.)
 *  - "Ran" is said only of a run inside the last 26 hours, and never of none.
 *    A run that had a write refused, or stopped at its daily limit, or had a
 *    forecast fail, needs a look and says which.
 *  - A number without enough history yet, or waiting for yesterday's number,
 *    is not a fault: it is said, as ok.
 */
async function forecasts(d: CheckDeps): Promise<ComponentCheck> {
  const { db, now } = d;
  const component = 'forecasts';
  if (!d.config.predict) return { component, status: 'disabled' };
  const first = await db.forecastSeries.findFirst({ where: { on: true }, orderBy: { enabledAt: 'asc' }, select: { enabledAt: true } });
  if (!first) return { component, status: 'disabled' };
  const policies = await activePolicies(db, now);
  const may = (action: string) => {
    const t = resolveTier(action, { context: 'autonomous', tainted: false, policies, now });
    return t.tier === 'alone' || (t.tier === 'approval' && runsInShadow(action));
  };
  if (!may(RUN_ACTION) || !may('ledger.prediction.record')) return { component, status: 'degraded', detail: FORECAST_HEALTH.stopped };
  // The latest run each job itself recorded as done (a run a rule forbade is `skipped`, and is not a run).
  const latest = (action: string) => db.auditEntry.findFirst({ where: { kind: 'action', action, actor: FORECAST_ACTOR, outcome: 'ok', at: { lte: now } }, orderBy: { at: 'desc' }, select: { at: true, inputs: true } });
  const n = (inputs: unknown, key: string): number => {
    const v = inputs && typeof inputs === 'object' ? (inputs as Record<string, unknown>)[key] : undefined;
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
  };
  const instance = await db.runtimeInstance.findFirst({ where: { stoppedAt: null }, orderBy: { startedAt: 'desc' }, select: { startedAt: true } });
  const started = instance?.startedAt.getTime() ?? 0;
  const fresh = started > 0 && now.getTime() - started <= FORECASTS_RESTART_GRACE_MS;
  /** How long it has been quiet: since the last run (or the first turn-on), or, for a runtime that only just started, since it did. */
  const quietSince = (ran: Date | undefined): number => {
    const last = Math.max(ran?.getTime() ?? 0, first.enabledAt.getTime());
    return now.getTime() - (fresh ? Math.max(last, started) : last);
  };
  const run = await latest(RUN_ACTION);
  const quiet = quietSince(run?.at);
  if (quiet > FORECASTS_DOWN_MS) return { component, status: 'down', detail: FORECAST_HEALTH.down(Math.floor(quiet / 86_400_000)) };
  if (quiet > FORECASTS_LATE_MS) return { component, status: 'degraded', detail: FORECAST_HEALTH.missed };
  // No run inside the last 26 hours, and not yet late (just turned on, or just started): nothing is said to have run.
  if (!run || now.getTime() - run.at.getTime() > FORECASTS_LATE_MS) return { component, status: 'ok', detail: FORECAST_HEALTH.starting };
  if (n(run.inputs, 'failed')) return { component, status: 'degraded', detail: FORECAST_HEALTH.failed(n(run.inputs, 'failed')) };
  if (n(run.inputs, 'refused')) return { component, status: 'degraded', detail: FORECAST_HEALTH.refused(n(run.inputs, 'refused')) };
  if (n(run.inputs, 'capped')) return { component, status: 'degraded', detail: FORECAST_HEALTH.capped(n(run.inputs, 'capped')) };
  // Yesterday's numbers, unless a rule forbids keeping them.
  if (may(SERIES_ACTION)) {
    const kept = await latest(SERIES_ACTION);
    if (quietSince(kept?.at) > FORECASTS_LATE_MS) return { component, status: 'degraded', detail: FORECAST_HEALTH.noNumbers };
    if (kept && n(kept.inputs, 'failed')) return { component, status: 'degraded', detail: FORECAST_HEALTH.numbersFailed(n(kept.inputs, 'failed')) };
  }
  const made = n(run.inputs, 'ran') + n(run.inputs, 'steady') + n(run.inputs, 'same');
  const late = n(run.inputs, 'late');
  if (made) return { component, status: 'ok', detail: FORECAST_HEALTH.ran(made, late) };
  // None has its forecast: said as what they wait for, never as "ran for 0 numbers".
  if (late) return { component, status: 'ok', detail: FORECAST_HEALTH.late(late) };
  if (n(run.inputs, 'waiting')) return { component, status: 'ok', detail: FORECAST_HEALTH.waiting(n(run.inputs, 'waiting')) };
  return { component, status: 'ok', detail: FORECAST_HEALTH.starting };
}

/** The hourly check has not run in this long: degraded. */
export const LEDGER_LATE_MS = 3 * 3_600_000;
/** No check in this long: down (a whole night's run was missed). */
export const LEDGER_DOWN_MS = 26 * 3_600_000;
/** The night's scores are this old: degraded (two nights were missed). */
export const SCORES_OLD_MS = 50 * 3_600_000;
/** How long a runtime that just started is given to run its first check: one hourly slot, and ten minutes. */
export const LEDGER_RESTART_GRACE_MS = 70 * 60_000;

/** What Prediction Checks says in Settings > Health: sentences from counts, never a prediction's words or a number it was about. */
export const LEDGER_HEALTH = {
  stopped: 'A rule stops Flint from checking its predictions.',
  starting: 'Prediction checks start within the hour.',
  /** The last day's checks: how many predictions were checked (a result written, or set aside with declined advice), and how many ran out unchecked. */
  checked: (n: number, ranOut = 0) =>
    ranOut === 0 ? (n === 0 ? 'Flint had no predictions to check in the last day.' : `Flint checked ${count(n, 'prediction')} in the last day.`)
    : n === 0 ? `In the last day, ${count(ranOut, 'prediction')} ran out unchecked.`
    : `Flint checked ${count(n, 'prediction')} in the last day, and ${ranOut} ran out unchecked.`,
  late: (hours: number) => `Prediction checks haven’t run in ${count(hours, 'hour')}.`,
  down: 'Prediction checks didn’t run in the last day.',
  refused: (n: number) => `The database refused ${count(n, 'prediction check')}.`,
  noRule: (n: number) => (n === 1 ? 'Flint can’t check 1 prediction, so it will run out unchecked.' : `Flint can’t check ${n} predictions, so they will run out unchecked.`),
  noScores: 'Flint hasn’t scored its predictions yet.',
  scoresOld: (days: number) => `Flint’s accuracy scores are ${count(days, 'day')} old.`,
} as const;

/**
 * Prediction checks (P4): is Flint settling and scoring its own predictions?
 * Counts only. Read from the sweep's own audit entries (one per run, the
 * ledger's actor alone) and the snapshot's, so a job that died shows within
 * hours.
 *  - Off while FLINT_PREDICT is off, and while no number was ever turned on
 *    (the jobs do nothing until Will signs the card).
 *  - How long since the last check is counted from that check, or from the
 *    first turn-on when there has been none: the hours before predictions
 *    were on never read as a missed check.
 *  - A runtime that just started is given one hourly slot to run its first
 *    check (70 minutes): inside it, the quiet time counts from the start.
 *    After it a restart excuses nothing, so a runtime that restarts every few
 *    hours and never checks reads late, then down, like any other.
 */
async function predictionChecks(d: CheckDeps): Promise<ComponentCheck> {
  const { db, now } = d;
  const component = 'ledger';
  if (!d.config.predict) return { component, status: 'disabled' };
  const first = await db.forecastSeries.findFirst({ orderBy: { enabledAt: 'asc' }, select: { enabledAt: true } });
  if (!first) return { component, status: 'disabled' };
  const policies = await activePolicies(db, now);
  const may = (action: string) => {
    const t = resolveTier(action, { context: 'autonomous', tainted: false, policies, now });
    return t.tier === 'alone' || (t.tier === 'approval' && runsInShadow(action));
  };
  // A FORBIDDEN rule on both stops every check: said plainly, since nothing else would.
  if (!may('ledger.resolve.auto') && !may('ledger.expire')) return { component, status: 'degraded', detail: LEDGER_HEALTH.stopped };
  const day = new Date(now.getTime() - 24 * 3_600_000);
  const sweeps = await db.auditEntry.findMany({
    where: { kind: 'action', action: SWEEP_ACTION, actor: LEDGER_ACTOR, at: { gt: new Date(now.getTime() - LEDGER_DOWN_MS), lte: now } },
    orderBy: { at: 'desc' }, take: 60, select: { at: true, inputs: true },
  });
  const instance = await db.runtimeInstance.findFirst({ where: { stoppedAt: null }, orderBy: { startedAt: 'desc' }, select: { startedAt: true } });
  const started = instance?.startedAt.getTime() ?? 0;
  const last = Math.max(sweeps[0]?.at.getTime() ?? 0, first.enabledAt.getTime());
  const since = started > 0 && now.getTime() - started <= LEDGER_RESTART_GRACE_MS ? Math.max(last, started) : last;
  const quiet = now.getTime() - since;
  if (quiet > LEDGER_DOWN_MS) return { component, status: 'down', detail: LEDGER_HEALTH.down };
  if (quiet > LEDGER_LATE_MS) return { component, status: 'degraded', detail: LEDGER_HEALTH.late(Math.floor(quiet / 3_600_000)) };
  if (!sweeps[0]) return { component, status: 'ok', detail: LEDGER_HEALTH.starting };
  const n = (inputs: unknown, key: string): number => {
    const v = inputs && typeof inputs === 'object' ? (inputs as Record<string, unknown>)[key] : undefined;
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
  };
  // The latest check's own trouble: a write the database refused, or a prediction it has no way to check.
  if (n(sweeps[0].inputs, 'refused')) return { component, status: 'degraded', detail: LEDGER_HEALTH.refused(n(sweeps[0].inputs, 'refused')) };
  if (n(sweeps[0].inputs, 'unknownSpec')) return { component, status: 'degraded', detail: LEDGER_HEALTH.noRule(n(sweeps[0].inputs, 'unknownSpec')) };
  // The night's scores, unless a rule forbids them: late once two nights have gone by without any.
  if (may(SNAPSHOT_ACTION)) {
    const scored = await db.auditEntry.findFirst({ where: { kind: 'action', action: SNAPSHOT_ACTION, actor: LEDGER_ACTOR, at: { lte: now } }, orderBy: { at: 'desc' }, select: { at: true } });
    // None yet, two nights after predictions were turned on: said as that, never as scores of some age.
    if (!scored && now.getTime() - first.enabledAt.getTime() > SCORES_OLD_MS) return { component, status: 'degraded', detail: LEDGER_HEALTH.noScores };
    const age = scored ? now.getTime() - scored.at.getTime() : 0;
    if (age > SCORES_OLD_MS) return { component, status: 'degraded', detail: LEDGER_HEALTH.scoresOld(Math.floor(age / 86_400_000)) };
  }
  // The last day's checks. None ran in it (the last was just over a day ago, and this runtime has only now started): said as starting, never as a day with nothing to check.
  const recent = sweeps.filter((s) => s.at > day);
  if (!recent.length) return { component, status: 'ok', detail: LEDGER_HEALTH.starting };
  const sum = (key: string) => recent.reduce((t, s) => t + n(s.inputs, key), 0);
  // Run out is not checked: it is counted beside.
  return { component, status: 'ok', detail: LEDGER_HEALTH.checked(sum('resolved') + sum('conditionUnmet'), sum('expired')) };
}

/** How many of the latest plan stages Health looks at. */
const PLAN_STAGES_WATCHED = 3;

/** What Goal Reviews says in Settings > Health: sentences from counts, never a goal's words. */
export const GOAL_HEALTH = {
  stopped: REVIEWS_STOPPED,
  down: (n: number) => (n === 1 ? 'A goal’s review is over a day late.' : `${n} goals’ reviews are over a day late.`),
  late: (n: number) => (n === 1 ? 'A goal’s review is over an hour late.' : `${n} goals’ reviews are over an hour late.`),
  noModel: 'No local model is set up, so goal reviews suggest no plan changes.',
  noAnswer: (n: number) => `The local model gave no usable answer to the last ${n === 1 ? 'goal review' : `${n} goal reviews`}, so Flint suggested no plan changes.`,
} as const;

/**
 * Goal reviews (P3): are they running, on time, and getting answers? Counts
 * only: a detail never names a goal.
 *  - A review is late against the goal's own next review time, which every
 *    scheduled review moves on, so a tick or a review job that died shows here
 *    within the hour. Late is counted in reviewing time (goals/late.ts): the
 *    stretches this very check has been writing its row with reviews on. So the
 *    time before reviews were turned on, a restart or a night asleep never
 *    makes a review late, and a review stuck for days is down once it has
 *    waited 24 hours of reviewing time, however many deploys and nights that
 *    is spread over.
 *  - The plan stage: when the last few (up to 3) of the active goals' reviews
 *    that asked the local model all got no usable answer, reviews still run
 *    but suggest nothing, and nothing else would say so.
 */
async function goalReviews(d: CheckDeps): Promise<ComponentCheck> {
  const { db, now } = d;
  const component = 'goals';
  if (!d.config.planner) return { component, status: 'disabled' };
  // A FORBIDDEN rule on goal.review.local stops every review: said plainly, since nothing else would.
  if (!(await reviewStanding(db, now)).may) return { component, status: 'degraded', detail: GOAL_HEALTH.stopped };
  const due = await db.goal.findMany({
    where: { status: 'active', nextReviewAt: { lt: new Date(now.getTime() - REVIEW_LATE_MS) } }, orderBy: [{ nextReviewAt: 'asc' }, { id: 'asc' }], take: 500, select: { nextReviewAt: true },
  });
  const waited = await waitedMs(db, due.map((g) => g.nextReviewAt), now);
  const day = waited.filter((ms) => ms > REVIEW_DOWN_MS).length;
  const hour = waited.filter((ms) => ms > REVIEW_LATE_MS).length;
  if (day) return { component, status: 'down', detail: GOAL_HEALTH.down(day) };
  if (hour) return { component, status: 'degraded', detail: GOAL_HEALTH.late(hour) };
  // Reviews are on with no local model to ask (FLINT_TRIAGE_MODEL is not set): every plan stage would end `none:off`.
  if (!d.config.ollama) return { component, status: 'degraded', detail: GOAL_HEALTH.noModel };
  // The plan stages that asked the model, latest first: an answer, or none that could be used.
  const stages = await db.goalReview.findMany({
    where: { goal: { status: 'active' }, createdAt: { gt: new Date(now.getTime() - 14 * 86_400_000) }, OR: [{ planner: { startsWith: 'ollama:' } }, { planner: { in: ['none:unavailable', 'none:invalid'] } }] },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: PLAN_STAGES_WATCHED, select: { planner: true },
  });
  if (stages.length && stages.every((r) => r.planner?.startsWith('none:'))) return { component, status: 'degraded', detail: GOAL_HEALTH.noAnswer(stages.length) };
  // The plan stage's own mark (a review that gave up waiting for chat), within the hour.
  const deferred = await db.healthCheck.findFirst({ where: { component: 'goals.deferral', at: { gt: new Date(now.getTime() - 3_600_000) } }, select: { detail: true } });
  return { component, status: deferred ? 'degraded' : 'ok', ...(deferred?.detail ? { detail: clip(deferred.detail) } : {}) };
}

export async function recordChecks(db: Db, checks: ComponentCheck[], at: Date): Promise<void> {
  await db.healthCheck.createMany({ data: checks.map((c) => ({ component: c.component, status: c.status, detail: c.detail ? clip(c.detail) : null, at })) });
  const counts = Object.fromEntries(HEALTH_STATUS.map((s) => [s, checks.filter((c) => c.status === s).length]));
  await appendAudit(db, [{
    actor: 'runtime:health', context: 'autonomous', kind: 'health', action: 'health.check', outcome: 'ok',
    inputs: { ...counts, notOk: checks.filter((c) => c.status !== 'ok' && c.status !== 'disabled').map((c) => c.component).slice(0, 40) },
  }], at);
}

/**
 * The report the console shows (GET /v1/health/report): each component's latest check.
 * A dotted name is a mark of its own (the triage worker's 'triage.deferral', a goal
 * review's 'goals.deferral'), not a component: nothing writes it an ok row, so it is
 * left out, as the digest leaves it out. The 'triage' and 'goals' rows already
 * reflect a deferral within the hour.
 */
export async function healthReport(db: Db, config: Pick<Config, 'triage'>, now = new Date()): Promise<z.infer<typeof HealthReport>> {
  const rows = await db.$queryRaw<Array<{ component: string; status: Status; detail: string | null; at: Date }>>`
    SELECT DISTINCT ON (component) component, status, detail, at FROM "HealthCheck" WHERE component NOT LIKE '%.%' ORDER BY component, at DESC`;
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
