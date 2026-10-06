/**
 * The runtime's life after its API is listening (index.ts listens first, so
 * the P1 routes serve whatever else fails): the heartbeat, every 30 s and apart
 * from the bus; the proposal tick; and the job bus, retried with backoff until
 * it starts (until then /health says `bus` is degraded and nothing runs on its
 * own). Stopping drains the bus for up to 15 s, then marks the instance stopped.
 */
import type { Config } from './config.js';
import type { Db } from './db.js';
import type { RuntimeStatus } from './app.js';
import { expireProposals, sweepExecuting } from './governance/proposals.js';
import { registry } from './sources/registry.js';
import { startBus, type Bus } from './bus.js';
import { jobSpecs, startJobs, failureClass } from './jobs.js';
import { startInstance, type Instance } from './health/instance.js';
import type { CalendarInbox } from './sources/apple/inbox.js';

export const BEAT_MS = 30_000;

export interface Lifecycle {
  instanceId: string;
  /** The bus once it started (the tests wait on it). */
  bus(): Bus | undefined;
  stop(reason: string): Promise<void>;
}

export interface RunOptions {
  startBus?: typeof startBus;
  /** The wait before bus attempt n+1: 5 s doubling, at most 5 minutes. */
  backoffMs?: (attempt: number) => number;
  beatMs?: number;
  /** The job set (default jobSpecs). */
  jobs?: typeof jobSpecs;
  /** P2.6: the Apple Calendar inbox the API's push route fills; the source reads the same one. */
  calendarInbox?: CalendarInbox;
}

export async function run(db: Db, config: Config, status: RuntimeStatus, log: (msg: string, extra?: object) => void, opts: RunOptions = {}): Promise<Lifecycle> {
  const startBusFn = opts.startBus ?? startBus;
  const backoffMs = opts.backoffMs ?? ((attempt: number) => Math.min(300_000, 5_000 * 2 ** attempt));
  const instance: Instance = await startInstance(db, config.gitSha);
  const beat = setInterval(() => void instance.beat().catch((err: unknown) => log(`heartbeat failed: ${failureClass(err)}`)), opts.beatMs ?? BEAT_MS);
  beat.unref();
  // Housekeeping that changes only the runtime's own rows and is already
  // bounded by the database: proposals Will did not decide in time, and
  // executions that never reported back.
  const tick = setInterval(() => {
    expireProposals(db).catch((err: unknown) => log(`expiring proposals failed: ${failureClass(err)}`));
    sweepExecuting(db).catch((err: unknown) => log(`sweeping stuck executions failed: ${failureClass(err)}`));
  }, 60_000);
  tick.unref();

  let bus: Bus | undefined;
  let stopping = false;
  let retry: NodeJS.Timeout | undefined;
  status.problems.add('bus');
  const connect = async (attempt: number): Promise<void> => {
    if (stopping) return;
    try {
      const b = await startBusFn(config.databaseUrl, log);
      if (stopping) return void (await b.stop().catch(() => {}));
      bus = b;
      status.bus = b;
      const ctx = { db, config, bus: b, sources: registry(config, db, { ...(opts.calendarInbox ? { calendarInbox: opts.calendarInbox } : {}) }), log };
      await startJobs(ctx, (opts.jobs ?? jobSpecs)(ctx));
      status.problems.delete('bus');
      status.busStartedAt = new Date();
      log('bus started');
    } catch (err) {
      if (bus) {
        const b = bus;
        bus = undefined;
        delete status.bus;
        await b.stop().catch(() => {});
      }
      const wait = backoffMs(attempt);
      log(`bus did not start (${failureClass(err)}); trying again in ${Math.round(wait / 1000)} s`);
      if (!stopping) {
        retry = setTimeout(() => void connect(attempt + 1), wait);
        retry.unref();
      }
    }
  };
  void connect(0);

  let stopped: Promise<void> | undefined;
  const stop = (reason: string) =>
    (stopped ??= (async () => {
      stopping = true;
      clearTimeout(retry);
      clearInterval(beat);
      clearInterval(tick);
      // Running jobs get 15 s to finish; one that does not is released (its
      // lease runs out and it runs again), never run twice at once.
      delete status.bus;
      await bus?.stop().catch((err: unknown) => log(`bus stop failed: ${failureClass(err)}`));
      await instance.stop(reason).catch((err: unknown) => log(`marking the instance stopped failed: ${failureClass(err)}`));
    })());
  return { instanceId: instance.id, bus: () => bus, stop };
}
