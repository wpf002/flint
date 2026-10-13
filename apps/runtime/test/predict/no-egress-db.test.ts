/**
 * The night's prediction jobs with the network taken away (P4 part 3; review
 * finding 10). The static test (no-egress.test.ts) reads the files as text,
 * which cannot see a fetch built from pieces, an import decided at run time, or
 * a call inside a helper those files use. This one runs the four jobs as the
 * runtime runs them, in the night's order, on flint_test, with:
 *
 *  - Node's net, tls, http, https and dns made to throw (and fetch with them),
 *    for every caller in the process: the module's own functions are replaced
 *    and its named exports brought in step, so `import { request } from
 *    'node:https'` anywhere is the thrower too;
 *  - every way to start a process made to throw but execFile, which records
 *    what it is asked to run and answers as git would.
 *
 * Nothing may reach for the network, and the only commands are the two fixed
 * git questions about Will's clone, with nothing but a path, two instants and a
 * branch in them. The database is not the network: it is a local socket the
 * client opened before any of this, through its own engine.
 */
import childProcess from 'node:child_process';
import dns from 'node:dns';
import { mkdirSync, mkdtempSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import net, { connect as netConnect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NO_DB, freshDb, id, type TestUrls } from '../db';
import { DAY, TZ, dayStart as kitDayStart, ledgerKit, type LedgerKit } from '../ledger/kit';
import type { Bus } from '../../src/bus';
import type { Config } from '../../src/config';
import { predictJobs, type JobContext } from '../../src/jobs';
import { weekOf } from '../../src/predict/metrics';
import { forecastSeries, freqOf } from '../../src/predict/series';
import { MAIN_REFS } from '../../src/sources/git';
import { localDay } from '@flint/policy';

type Fn = (...args: unknown[]) => unknown;
interface Command {
  cmd: string;
  args: string[];
  env: string[];
}

describe.skipIf(NO_DB)('the prediction jobs with the network taken away', () => {
  let urls: TestUrls;
  let k: LedgerKit;
  const NOW = new Date();
  const dayStart = (daysAgo: number) => kitDayStart(daysAgo, NOW);
  /** What reached for the network, or tried to start a process any other way. Must stay empty. */
  const reached: string[] = [];
  const commands: Command[] = [];
  const undo: Array<() => void> = [];

  /** Replace `name` on a module (or a prototype) until `restore()`. */
  function swap(owner: Record<string, unknown>, name: string, to: Fn): void {
    const was = owner[name];
    owner[name] = to;
    undo.push(() => void (owner[name] = was));
  }
  const thrower = (what: string): Fn => () => {
    reached.push(what);
    throw new Error(`the network is taken away: ${what}`);
  };
  function takeAway(): void {
    for (const name of ['connect', 'createConnection']) swap(net as never, name, thrower(`net.${name}`));
    swap(net.Socket.prototype as never, 'connect', thrower('net.Socket.connect'));
    swap(tls as never, 'connect', thrower('tls.connect'));
    for (const name of ['request', 'get']) {
      swap(http as never, name, thrower(`http.${name}`));
      swap(https as never, name, thrower(`https.${name}`));
    }
    for (const name of ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveAny']) {
      swap(dns as never, name, thrower(`dns.${name}`));
      swap(dns.promises as never, name, thrower(`dns.promises.${name}`));
    }
    swap(globalThis as never, 'fetch', thrower('fetch'));
    for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFileSync', 'fork']) swap(childProcess as never, name, thrower(`child_process.${name}`));
    // The one way a command is run (sources/exec.ts): recorded, and answered as git would.
    swap(childProcess as never, 'execFile', ((cmd: string, args: string[], opts: { env?: Record<string, string> }, done: (err: Error | null, stdout: string) => void) => {
      commands.push({ cmd, args: [...args], env: Object.keys(opts?.env ?? {}).sort() });
      const out = args.includes('for-each-ref') ? 'refs/heads/main\n' : args.includes('rev-list') ? '3\n' : '';
      setImmediate(() => done(null, out));
      return {};
    }) as Fn);
    syncBuiltinESMExports();
  }
  function restore(): void {
    while (undo.length) undo.pop()!();
    syncBuiltinESMExports();
  }

  beforeAll(async () => {
    urls = await freshDb();
    k = await ledgerKit(urls);
  });
  afterAll(async () => {
    restore();
    await k?.db.$disconnect();
  });

  it('nothing reaches for the network, and the only commands are the two fixed git questions about the clone', async () => {
    // Will's clones live under his home: here, one of them, a clone of its own.
    const home = mkdtempSync(join(tmpdir(), 'no-egress-'));
    mkdirSync(join(home, 'Documents', 'GitHub', 'flint', '.git'), { recursive: true });
    // Every kind of number is on, so every builder runs. Deploys has two months of history, so it is forecast.
    for (const key of ['daily.deploys.count', 'daily.spend.anthropic.usd', 'daily.services.incident_minutes', 'daily.threads.open', 'daily.calendar.hours', 'weekly.commits.flint.count', 'weekly.commits.nexus.count']) {
      const d = forecastSeries(key)!;
      await k.series({ key: d.key, unit: d.unit, freq: freqOf(d), sensitivity: d.sensitivity, description: d.description });
      await k.turnOn([key]);
    }
    for (let i = 1; i <= 60; i++) await k.point('daily.deploys.count', dayStart(i), 3 + (i % 5));
    await k.db.runtimeInstance.create({ data: { id: id('ri'), gitSha: 'dev', startedAt: dayStart(70), lastBeatAt: new Date() } });
    // The world the numbers are built from, so every builder has days to write (and every helper they call is called):
    // a service of Flint's seen four days ago and since, a thread, and a calendar event.
    const { applyObservation } = await import('../../src/world/mapper');
    const seen = (kind: string, key: string, state: Record<string, unknown>, at: Date, source: string) =>
      k.db.$transaction((tx) => applyObservation(tx, { kind, key, name: key, state, source, externalId: key, observedAt: at, actor: 'source:test', ...(kind === 'commitment' ? { sensitivity: 'personal' as const } : {}) }));
    const flint = 'service:launchd:com.flint.server';
    const eid = await k.service(flint, { running: true, disabled: false }, new Date(dayStart(4).getTime() + 3_600_000));
    await k.service(flint, { running: false, disabled: false }, new Date(dayStart(2).getTime() + 3_600_000));
    await k.service(flint, { running: true, disabled: false }, new Date(dayStart(2).getTime() + 2 * 3_600_000));
    await k.service(flint, { running: true, disabled: false, lastExit: 0 }, new Date(Date.now() - 300_000));
    await seen('thread', 'thread:nexus:t1', { status: 'open' }, new Date(dayStart(3).getTime() + 3_600_000), 'nexus');
    await seen('commitment', 'commitment:apple_calendar:e1', {
      source: 'apple_calendar', allDay: false, response: 'accepted', eventStatus: 'confirmed', confirmation: 'confirmed',
      startsAt: new Date(dayStart(2).getTime() + 9 * 3_600_000).toISOString(), endsAt: new Date(dayStart(2).getTime() + 10 * 3_600_000).toISOString(),
    }, new Date(dayStart(3).getTime() + 3_600_000), 'apple_calendar');
    // Something for the sweep to settle and the scores to score.
    const due = await k.prediction({ resolverSpec: { entityId: eid, check: 'healthy', at: 'resolveBy' } }, { madeAgo: 3 * 3_600_000, dueAgo: 3_600_000 });

    const said: string[] = [];
    const ctx: JobContext = { db: k.db, bus: {} as Bus, sources: [], log: (m) => void said.push(m), config: { predict: true, triage: false, planner: false, tz: TZ, home } as Config };
    const jobs = predictJobs(ctx);
    expect(jobs.map((j) => j.queue).sort()).toEqual(['forecast.run', 'forecast.series', 'ledger.snapshot', 'ledger.sweep']);
    takeAway();
    let failure: unknown;
    try {
      // The patch is live, for a module's own functions and for a named import of one alike.
      expect(() => net.connect(9, '127.0.0.1')).toThrow('the network is taken away');
      expect(() => netConnect(9, '127.0.0.1')).toThrow('the network is taken away');
      expect(() => https.request('https://example.invalid/')).toThrow('the network is taken away');
      expect(() => (globalThis.fetch as Fn)('https://example.invalid/')).toThrow('the network is taken away');
      expect(reached).toHaveLength(4);
      reached.length = 0;
      // The night, in order: yesterday's numbers, the sweep, the scores, today's forecasts.
      for (const queue of ['forecast.series', 'ledger.sweep', 'ledger.snapshot', 'forecast.run']) await jobs.find((j) => j.queue === queue)!.handler([]);
    } catch (err) {
      failure = err;
    } finally {
      restore();
    }
    expect(failure).toBeUndefined();
    expect(reached).toEqual([]);

    // The jobs did their work (so the empty list above is not the emptiness of jobs that did nothing).
    const audits = (await k.owner(`SELECT action, outcome, inputs FROM "AuditEntry" WHERE action IN ('forecast.series.build', 'forecast.local', 'ledger.sweep', 'ledger.calibration.snapshot') ORDER BY seq`)).rows;
    expect(audits.map((a) => [a.action, a.outcome])).toEqual([['forecast.series.build', 'ok'], ['ledger.sweep', 'ok'], ['ledger.calibration.snapshot', 'ok'], ['forecast.local', 'ok']]);
    expect(audits[0]!.inputs).toMatchObject({ on: 7, failed: 0 });
    expect(audits[0]!.inputs.written).toBeGreaterThanOrEqual(60);
    // Each builder wrote its days: downtime (an hour, two days ago), open threads, calendar hours.
    const day2 = dayStart(2).toISOString();
    const value = async (key: string) => (await k.owner(`SELECT value FROM "MetricPoint" WHERE "seriesKey" = $1 AND at = $2`, [key, day2])).rows[0]?.value as number | undefined;
    expect([await value('daily.services.incident_minutes'), await value('daily.threads.open'), await value('daily.calendar.hours')]).toEqual([60, 1, 1]);
    expect(audits[1]!.inputs).toMatchObject({ resolved: 1, refused: 0 });
    // Deploys is forecast; the commit count, the same every week here, is steady (a run, a flat line, nothing to ask).
    expect(audits[3]!.inputs).toMatchObject({ on: 7, ran: 1, steady: 1, failed: 0, refused: 0 });
    expect(await k.status(due)).toBe('resolved');
    expect((await k.owner(`SELECT count(*)::int AS n FROM "ForecastRun" WHERE ok`)).rows[0].n).toBe(2);
    expect((await k.owner(`SELECT count(*)::int AS n FROM "MetricPoint" WHERE "seriesKey" = 'weekly.commits.flint.count' AND value = 3`)).rows[0].n).toBe(60);

    // The commands: git, asked which branch is main, then for one count a week. Nothing else was run, by anything.
    const path = join(home, 'Documents', 'GitHub', 'flint');
    expect(commands).toHaveLength(61);
    expect(new Set(commands.map((c) => c.cmd))).toEqual(new Set(['/usr/bin/git']));
    expect(commands[0]!.args).toEqual(['-C', path, 'for-each-ref', '--format=%(refname)', ...MAIN_REFS]);
    const monday = new Date(`${weekOf(localDay(TZ, NOW))}T00:00:00.000Z`);
    for (const [i, c] of commands.slice(1).entries()) {
      const since = new Date(monday.getTime() - (60 - i) * 7 * DAY);
      expect(c.args, `week ${i}`).toEqual(['-C', path, 'rev-list', '--count', '--first-parent', `--since=${since.toISOString()}`, `--before=${new Date(since.getTime() + 7 * DAY - 1000).toISOString()}`, 'refs/heads/main']);
    }
    // No fetch, pull or clone; no clone that is not there is asked anything (nexus is on, and has no folder).
    expect(commands.flatMap((c) => c.args).join(' ')).not.toMatch(/fetch|pull|clone|remote\b|https?:|nexus/);
    // Each ran with a bare environment: a path and a home, and nothing of the runtime's own (no database URL, no token).
    for (const c of commands) expect(c.env).toEqual(['HOME', 'PATH']);
    expect(said.join('\n')).not.toMatch(/[1-9]\d* (series )?failed|[1-9]\d* refused|was not recorded|could not be built/);
  }, 120_000);
});
