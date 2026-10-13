/**
 * Two things Settings > Health reads from files the deploy scripts keep in
 * ~/.flint, with no database in between:
 *  - Automatic Updates: a pause on updates (the deploy hold) is an issue for as
 *    long as it lasts, with its age. Its only trace used to be a line in the
 *    deploy log every two minutes;
 *  - Rebuild Rehearsal: how the last rehearsal of a rebuild went (weekly, and in
 *    the deploy gate when a deploy changes what a rebuild is made of).
 * Every run here uses a scratch home folder: nothing reads the real ~/.flint.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HEALTH_NAMES, healthName, noteProblems } from '@flint/policy';
import { REHEARSAL_STALE_DAYS, UPKEEP_HEALTH, deployHold, rebuildRehearsal } from '../src/health/checks';

const NOW = new Date('2026-10-12T18:00:00Z'); // Monday, 1 PM in Chicago
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const SHA = 'a'.repeat(40);

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'health-upkeep-'));
  mkdirSync(join(home, '.flint'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('Automatic Updates: a pause on updates is never silent', () => {
  const pausedFor = (ms: number) => {
    const hold = join(home, '.flint', 'deploy-hold');
    writeFileSync(hold, 'Paused by rollback.sh.\n');
    const at = (NOW.getTime() - ms) / 1000;
    utimesSync(hold, at, at);
    return deployHold(home, NOW);
  };

  it('is normal while there is no hold', () => {
    expect(deployHold(home, NOW)).toEqual({ component: 'deploy_hold', status: 'ok' });
  });

  it('is an issue from the first check, and says how long updates have been paused', () => {
    expect(pausedFor(4 * 60_000)).toEqual({ component: 'deploy_hold', status: 'degraded', detail: 'Updates have been paused for less than an hour.' });
    expect(pausedFor(HOUR).detail).toBe('Updates have been paused for 1 hour.');
    expect(pausedFor(26 * HOUR).detail).toBe('Updates have been paused for 26 hours.');
    expect(pausedFor(47.9 * HOUR).detail).toBe('Updates have been paused for 47 hours.');
    expect(pausedFor(2 * DAY).detail).toBe('Updates have been paused for 2 days.');
    expect(pausedFor(9.5 * DAY)).toEqual({ component: 'deploy_hold', status: 'degraded', detail: 'Updates have been paused for 9 days.' });
  });

  it('a pause that was lifted is still said until the deploy job has looked again: its own mark stands in for the pause', () => {
    // The job leaves this mark at the first tick that finds the pause, and takes it away at its first look after it.
    writeFileSync(join(home, '.flint', 'deploy-hold-seen'), '');
    expect(deployHold(home, NOW)).toEqual({ component: 'deploy_hold', status: 'degraded', detail: 'Updates were paused, and Flint hasn’t checked again yet.' });
    // With the pause itself still there, the pause is what is said.
    expect(pausedFor(2 * HOUR).detail).toBe('Updates have been paused for 2 hours.');
    rmSync(join(home, '.flint', 'deploy-hold'));
    rmSync(join(home, '.flint', 'deploy-hold-seen'));
    expect(deployHold(home, NOW)).toEqual({ component: 'deploy_hold', status: 'ok' });
    // The mark is the script's own name for it.
    expect(readFileSync(join(__dirname, '..', '..', 'server', 'auto_deploy.sh'), 'utf8')).toContain('HOLD_SEEN="$STATE/deploy-hold-seen"');
  });

  it('a hold made by hand, empty, or dated ahead of the clock is a hold all the same', () => {
    writeFileSync(join(home, '.flint', 'deploy-hold'), '');
    const ahead = (NOW.getTime() + HOUR) / 1000;
    utimesSync(join(home, '.flint', 'deploy-hold'), ahead, ahead);
    expect(deployHold(home, NOW)).toEqual({ component: 'deploy_hold', status: 'degraded', detail: 'Updates have been paused for less than an hour.' });
  });
});

describe('Rebuild Rehearsal: how the last rehearsal of a rebuild went', () => {
  const result = (line: string) => writeFileSync(join(home, '.flint', 'rehearsal-result'), line);
  const at = (ms: number) => Math.floor((NOW.getTime() - ms) / 1000);
  const check = () => rebuildRehearsal(home, 'America/Chicago', NOW);

  it('has not reported until a rehearsal has run: unknown is never ok', () => {
    expect(check()).toEqual({ component: 'rebuild_rehearsal', status: 'unknown', detail: 'The rebuild rehearsal has not run yet.' });
  });

  it('a pass is normal for 8 days (it runs weekly), by Will’s calendar days', () => {
    result(`passed ${at(2 * HOUR)} ${SHA}\n`);
    expect(check()).toEqual({ component: 'rebuild_rehearsal', status: 'ok', detail: 'The rebuild rehearsal last passed today.' });
    // Sunday 05:10 in Chicago, read on Monday afternoon.
    result(`passed ${Math.floor(Date.parse('2026-10-11T10:10:00Z') / 1000)} ${SHA}\n`);
    expect(check().detail).toBe('The rebuild rehearsal last passed yesterday.');
    result(`passed ${at(6 * DAY)} ${SHA}\n`);
    expect(check()).toMatchObject({ status: 'ok', detail: 'The rebuild rehearsal last passed 6 days ago.' });
    result(`passed ${at(REHEARSAL_STALE_DAYS * DAY - HOUR)} -\n`);
    expect(check().status).toBe('ok');
  });

  it('a pass older than that is overdue: the weekly run has stopped', () => {
    result(`passed ${at(REHEARSAL_STALE_DAYS * DAY + HOUR)} ${SHA}\n`);
    expect(check()).toEqual({ component: 'rebuild_rehearsal', status: 'degraded', detail: 'The rebuild rehearsal last passed 8 days ago.' });
    result(`passed ${at(30 * DAY)} ${SHA}\n`);
    expect(check()).toEqual({ component: 'rebuild_rehearsal', status: 'degraded', detail: 'The rebuild rehearsal last passed 30 days ago.' });
  });

  it('a failure is down, however recent: a rebuild would not work today', () => {
    result(`failed ${at(20 * 60_000)} ${SHA}\n`);
    expect(check()).toEqual({ component: 'rebuild_rehearsal', status: 'down', detail: 'The rebuild rehearsal failed today.' });
    result(`failed ${at(3 * DAY)}\n`);
    expect(check()).toEqual({ component: 'rebuild_rehearsal', status: 'down', detail: 'The rebuild rehearsal failed 3 days ago.' });
  });

  it('a line it cannot read is no result, never a pass: only the first line counts, and nothing in it is shown', () => {
    for (const line of ['', 'ok\n', 'passed\n', 'passed yesterday\n', `PASSED ${at(HOUR)}\n`, `passed ${at(HOUR)} ~/x; rm\n`, `skipped ${at(HOUR)} ${SHA}\n`, `\npassed ${at(HOUR)} ${SHA}\n`]) {
      result(line);
      expect(check(), JSON.stringify(line)).toEqual({ component: 'rebuild_rehearsal', status: 'unknown', detail: UPKEEP_HEALTH.never });
    }
    result(`failed ${at(HOUR)} ${SHA}\npassed ${at(0)} ${SHA}\n`);
    expect(check().status).toBe('down');
  });
});

describe('what the two say is fit for Settings > Health and the morning digest', () => {
  it('each has a plain name, and every sentence is one Will can read', () => {
    expect(healthName('deploy_hold')).toBe('Automatic Updates');
    expect(healthName('rebuild_rehearsal')).toBe('Rebuild Rehearsal');
    const lines = [
      ...[0, 59 * 60_000, HOUR, 47 * HOUR, 48 * HOUR, 400 * DAY].map((ms) => UPKEEP_HEALTH.paused(ms)),
      ...['today', 'yesterday', '2 days ago', '31 days ago'].flatMap((when) => [UPKEEP_HEALTH.passed(when), UPKEEP_HEALTH.failed(when)]),
      UPKEEP_HEALTH.never,
    ];
    for (const line of lines) {
      for (const name of [HEALTH_NAMES.deploy_hold!, HEALTH_NAMES.rebuild_rehearsal!]) expect(noteProblems(name, line), line).toEqual([]);
      expect(line, line).toMatch(/^[A-Z].*\.$/);
      expect(line.length).toBeLessThanOrEqual(300);
    }
  });

  it('every health run checks both, from the home folder the runtime was given: none of their sentences is put together where it is returned', () => {
    const checks = readFileSync(join(__dirname, '..', 'src', 'health', 'checks.ts'), 'utf8');
    const run = checks.slice(checks.indexOf('export async function checkComponents('), checks.indexOf('/** How many of the latest plan stages Health looks at. */'));
    // Automatic Updates is the pause first (deployHold), then when the deploy job last looked (health-machine-db.test.ts).
    expect(run).toContain('out.push(await updates(d));');
    expect(run).toContain('out.push(rebuildRehearsal(d.config.home, d.config.tz, now));');
    const own = checks.slice(checks.indexOf('export function deployHold('), checks.indexOf('/** How bad a status is, to say the worse of two. */'));
    expect(own.match(/\bdetail: /g)).toHaveLength(5);
    expect(own.match(/detail: UPKEEP_HEALTH\.(paused|resuming|passed|failed|never)\b/g)).toHaveLength(5);
    const updates = checks.slice(checks.indexOf('async function updates('), checks.indexOf('export async function checkComponents('));
    expect(updates).toContain('const hold = deployHold(d.config.home, d.now);\n  if (hold.status !== \'ok\') return hold;');
    expect(updates.match(/\bdetail: /g)).toHaveLength(3);
    expect(updates.match(/detail: UPKEEP_HEALTH\.(neverChecked|notChecked\(age\)|checked\(age\))/g)).toHaveLength(3);
  });
});
