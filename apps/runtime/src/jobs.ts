/**
 * Everything the runtime does on its own, as jobs on the bus (Machine plan P2):
 * each world source on its cadence, and the rest as later work packages add
 * them. A job is a queue the migration made, an optional cron (in Flint's zone)
 * and a handler; startJobs registers the set it is given and unschedules every
 * other scheduled queue, so a job switched off (triage off) stops firing
 * instead of piling up unworked. A source that is pushed to (P2.6, Apple
 * Calendar) is also sent its job when a push arrives.
 */
import type { Job, ScheduleOptions, WorkOptions } from 'pg-boss';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { ALL_QUEUES, cronFor, type Bus } from './bus.js';
import { runLocked } from './scheduler.js';
import { IDLE } from './sources/sync.js';
import type { Registered } from './sources/registry.js';
import { triageEnqueue } from './events/record.js';
import { reconcile, sweepEvents } from './triage/reconcile.js';
import { processEvent, TriageJob } from './triage/worker.js';
import { deliver } from './surface/deliver.js';
import { expireEscalations } from './surface/expire.js';
import { checkComponents, recordChecks } from './health/checks.js';
import { raise, watchdog } from './health/watchdog.js';
import { noStandby, readMachine } from './health/machine.js';
import { ingestBackupEvents } from './backup/ingest.js';
import { circuitAllows, circuitEvents } from './health/circuits.js';
import { pushSpend } from './spend/push.js';
import { runDigest } from './digest.js';
import { runRetention } from './retention.js';
import { runRollups } from './rollup.js';
import { cardGate } from './backup/nightly.js';
import { completeProposal } from './governance/proposals.js';
import { resolveTier, runsInShadow } from '@flint/policy';
import { activePolicies } from './governance/proposals.js';
import { z } from 'zod';
import { failureClass } from './dbcodes.js';
import { TICK_CRON, tick } from './goals/tick.js';
import { PlanJob, ReviewJob, runReview } from './goals/review.js';
import { runPlan } from './goals/batch.js';
import { TASK_TICK_CRON, taskTick } from './tasks/tick.js';
import { TaskJob, runTaskJob } from './tasks/run.js';
import { checkTaskJob } from './tasks/check.js';
import { predictionsStarted, sweep } from './ledger/sweep.js';
import { SNAPSHOT_ACTION, runSnapshot } from './ledger/calibration.js';
import { runForecasts, runSeries } from './predict/run.js';
import { askQuestions } from './predict/questions.js';
import { makeRun } from './sources/exec.js';
import { clones } from './sources/registry.js';

const DeliverJob = z.object({ escalationId: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/) }).strict();

export interface JobContext {
  db: Db;
  config: Config;
  bus: Bus;
  sources: Registered[];
  log: (msg: string, extra?: object) => void;
}

export interface JobSpec {
  queue: string;
  /** Fires on this cron in config.tz; absent, the job is only ever sent. */
  cron?: string;
  /** What a cron owes for occurrences missed while the runtime was down. */
  missed?: ScheduleOptions['missed'];
  work?: WorkOptions;
  handler: (jobs: Job<object>[]) => Promise<void>;
}

/**
 * A sync job sent because something new arrived (P2.6: Flint Calendar pushed
 * a snapshot to the runtime's route), not by the source's cron. It carries no
 * content, only why it was sent.
 */
export const PushJob = z.object({ reason: z.literal('push') }).strict();

/** The world sources, one queue each, run under the same advisory lock as before. */
export function syncJobs(ctx: JobContext): JobSpec[] {
  // Triage off: the sources keep running, and nothing is queued for triage.
  const enqueue = ctx.config.triage ? triageEnqueue(ctx.bus) : undefined;
  return ctx.sources.map((r) => ({
    queue: `sync.${r.source.name}`,
    cron: cronFor(r.source.cadenceMs),
    handler: async (jobs) => {
      const now = new Date();
      const cursor = () => ctx.db.sourceCursor.findUnique({ where: { source: r.source.name }, select: { consecutiveFailures: true, lastOkAt: true, updatedAt: true } });
      const before = await cursor();
      // An open circuit: skipped, but for one try every 6 cadences. A push is let through: a fresh
      // snapshot is the source saying it is back (the cron's own runs still wait for the circuit).
      const pushed = jobs.some((j) => PushJob.safeParse(j.data).success);
      if (!pushed && !circuitAllows(before, r.source.cadenceMs, now)) return;
      const s = await runLocked(ctx.db, r, ctx.config.tz, now, enqueue);
      if (s?.failed || (s && !s.ran && s.reason && !s.reason.startsWith('not enabled') && s.reason !== IDLE)) ctx.log(`sync ${r.source.name}: ${s.reason ?? `${s.failed} failed`}`, { failed: s.failed });
      if (s?.ran) await raise(ctx.db, circuitEvents(r.source.name, before, await cursor(), new Date()), new Date(), enqueue);
      // The server's unified spend view, fresh after each spend sync.
      if (r.source.name === 'spend' && s?.ran && !s.failed && (await pushSpend(ctx.config)) === 'failed') ctx.log('pushing the spend view to the server failed');
    },
  }));
}

/** Triage's own jobs, only while it is on. */
export function triageJobs(ctx: JobContext): JobSpec[] {
  if (!ctx.config.triage) return [];
  return [
    {
      // One event at a time: the model runs one call at a time, and yields to chat.
      queue: 'triage',
      work: { batchSize: 1, localConcurrency: 1 },
      handler: async (jobs) => {
        for (const job of jobs) {
          const data = TriageJob.safeParse(job.data);
          // A job that is not {eventId} is nobody's: it completes and does nothing.
          if (!data.success) continue;
          await processEvent(data.data, { db: ctx.db, config: ctx.config, bus: ctx.bus });
        }
      },
    },
    {
      // One escalation's notes; the queue retries with backoff, then dead-letters.
      queue: 'deliver',
      handler: async (jobs) => {
        for (const job of jobs) {
          const data = DeliverJob.safeParse(job.data);
          if (data.success) await deliver(ctx.db, ctx.config, data.data.escalationId);
        }
      },
    },
    {
      queue: 'reconcile',
      cron: '*/5 * * * *',
      handler: async () => {
        const r = await reconcile(ctx.db, ctx.bus);
        if (r.resent || r.redelivered) ctx.log(`reconcile: ${r.resent} event(s) and ${r.redelivered} note(s) sent again`);
      },
    },
  ];
}

/** Triage and the console note are promoted: escalations are delivered, not held. */
async function promoted(ctx: JobContext): Promise<boolean> {
  const policies = await activePolicies(ctx.db);
  const alone = (a: string) => resolveTier(a, { context: 'autonomous', tainted: false, policies }).tier === 'alone';
  return ctx.config.triage && alone('triage.rule') && alone('notify.inapp');
}

/** An autonomous action's tier now, and whether it may run: promoted, or in shadow at APPROVAL. */
async function standingOf(ctx: JobContext, action: string): Promise<{ may: boolean; tier: 'alone' | 'approval' | 'forbidden' }> {
  const t = resolveTier(action, { context: 'autonomous', tainted: false, policies: await activePolicies(ctx.db) });
  return { may: t.tier === 'alone' || (t.tier === 'approval' && runsInShadow(action)), tier: t.tier };
}

/** May an autonomous action run now: promoted, or in shadow at APPROVAL. */
async function mayRun(ctx: JobContext, action: string): Promise<boolean> {
  return (await standingOf(ctx, action)).may;
}

/** Housekeeping that runs whether triage is on or not. */
export function housekeepingJobs(ctx: JobContext): JobSpec[] {
  const enqueue = ctx.config.triage ? triageEnqueue(ctx.bus) : undefined;
  const sources = ctx.sources.map((r) => ({ name: r.source.name, cadenceMs: r.source.cadenceMs }));
  return [
    {
      // Every 5 minutes: the checks, then the watchdog raises what is critical.
      queue: 'health',
      cron: '*/5 * * * *',
      handler: async () => {
        if (!(await mayRun(ctx, 'health.check'))) return;
        const now = new Date();
        // What the files backup wrote down since the last run (its own lines, one row for each archive): read
        // first, so this run's checks see it. A file that cannot be read costs the checks nothing.
        const lines = await ingestBackupEvents(ctx.db, ctx.config.home).catch((err: unknown) => {
          ctx.log(`the files backup's record could not be read (${err instanceof Error ? err.name : 'error'})`);
          return undefined;
        });
        if (lines?.skipped) ctx.log(`the files backup's record has lines that are not its own, which were skipped (${lines.skipped})`);
        // The Mac itself, read once for the checks and the watchdog both: free space, remote access, the local models.
        const wantsModels = ctx.config.ollama !== undefined || (ctx.config.standbyModel !== undefined && !noStandby(ctx.config.standbyModel));
        const machine = await readMachine({ home: ctx.config.home, ...(wantsModels ? { ollama: { url: ctx.config.ollama?.url ?? ctx.config.ollamaUrl ?? 'http://127.0.0.1:11434' } } : {}) }, now);
        const checks = await checkComponents({ db: ctx.db, config: ctx.config, now, sources, machine });
        await recordChecks(ctx.db, checks, now);
        const raised = await raise(ctx.db, await watchdog(ctx.db, ctx.config, now, machine), now, enqueue, await promoted(ctx));
        if (raised.length) ctx.log(`watchdog raised ${raised.length} event(s)`);
      },
    },
    {
      // Weekly: the restore drill's age on its own, in case the 5-minute run is wedged.
      queue: 'drill.check',
      cron: '15 9 * * 1',
      missed: 'once',
      handler: async () => {
        if (!(await mayRun(ctx, 'health.check'))) return;
        const now = new Date();
        const drill = (await checkComponents({ db: ctx.db, config: ctx.config, now, sources: [] })).filter((c) => c.component === 'restore_drill');
        await recordChecks(ctx.db, drill, now);
      },
    },
    {
      // 07:30 local: the previous day, once (a digest missed while down is sent when back).
      queue: 'digest',
      cron: '30 7 * * *',
      missed: 'once',
      handler: async () => {
        const r = await runDigest(ctx.db, ctx.config);
        if (r === 'failed') ctx.log('the digest was refused by the server');
      },
    },
    {
      // 03:10 local: retention clears and deletes, so it runs on Will's nightly card until promoted.
      queue: 'retention',
      cron: '10 3 * * *',
      missed: 'once',
      handler: async () => {
        const now = new Date();
        const g = await cardGate(ctx.db, { action: 'maintenance.retention', job: 'retention', templateId: 'nightly.retention' }, ctx.config.tz, ctx.config.rp, now);
        if (!g.go) return void ctx.log(`retention: not run (${g.why})`);
        try {
          const counts = await runRetention(ctx.db, ctx.config.tz, now, g.proposalId);
          if (g.proposalId) await completeProposal(ctx.db, g.proposalId, { ok: true, result: counts }, 'runtime');
        } catch (err) {
          // Its outcome is known: failed (runRetention audited what it had done). The card says so too.
          if (g.proposalId) await completeProposal(ctx.db, g.proposalId, { ok: false, error: failureClass(err) }, 'runtime').catch(() => {});
          throw err;
        }
      },
    },
    {
      // 03:20 local: yesterday's P2 measures, before retention takes the payloads they come from.
      queue: 'rollup',
      cron: '20 3 * * *',
      missed: 'once',
      handler: async () => void (await runRollups(ctx.db, ctx.config.tz)),
    },
    {
      queue: 'expire.escalations',
      cron: '7 * * * *',
      // Hourly housekeeping: open escalations past their time, and events that will never apply.
      handler: async () => {
        const n = await expireEscalations(ctx.db);
        const { dead } = await sweepEvents(ctx.db);
        if (n || dead) ctx.log(`expired ${n} escalation(s); ${dead} event(s) dead`);
      },
    },
  ];
}

/**
 * Goal reviews (P3), only while the planner is on (FLINT_PLANNER). Off, this is
 * empty: startJobs unschedules the tick, nothing is worked, and no review runs.
 * Job data is ids and times only, checked strictly; a job that is not its
 * queue's shape is nobody's and does nothing. Log lines carry counts and ids.
 */
export function goalJobs(ctx: JobContext): JobSpec[] {
  if (!ctx.config.planner) return [];
  return [
    {
      // Every 2 minutes: the reviews that are due, and the changes that set one off. It never asks the model.
      queue: 'goals.tick',
      cron: TICK_CRON,
      handler: async () => {
        const r = await tick({ db: ctx.db, bus: ctx.bus, tz: ctx.config.tz });
        if (r.due || r.triggered || r.capped) ctx.log(`goals: ${r.due} scheduled and ${r.triggered} triggered review(s) sent; ${r.capped} left to the next scheduled one`);
      },
    },
    {
      // Stage 1, one goal at a time: the checks, the forecast and the review's row. No model.
      queue: 'goals.review',
      handler: async (jobs) => {
        for (const job of jobs) {
          const data = ReviewJob.safeParse(job.data);
          if (data.success) await runReview({ db: ctx.db, bus: ctx.bus, tz: ctx.config.tz }, data.data);
        }
      },
    },
    {
      // Stage 2, one at a time: the local model's plan suggestions, as cards or (in the trial week) as a record.
      queue: 'goals.plan',
      handler: async (jobs) => {
        for (const job of jobs) {
          const data = PlanJob.safeParse(job.data);
          if (data.success) await runPlan({ db: ctx.db, bus: ctx.bus, config: ctx.config, log: ctx.log }, data.data);
        }
      },
    },
  ];
}

/** The night, in order (Flint's zone): yesterday's numbers, the sweep that settles what they decide, the scores, today's forecasts. */
export const SERIES_CRON = '30 3 * * *';
/** When the sweep runs: hourly at :40, so the 03:40 run settles the night's numbers before the 03:45 snapshot scores them. */
export const SWEEP_CRON = '40 * * * *';
/** When the snapshot runs: 03:45 local, after the sweep. */
export const SNAPSHOT_CRON = '45 3 * * *';
export const FORECAST_CRON = '50 3 * * *';
/** When Flint picks the day's questions for Will: 07:20 local, ahead of the 07:30 digest that may count them. */
export const ASK_CRON = '20 7 * * *';

/**
 * Predictions (P4), only while FLINT_PREDICT is on. Off, this is empty:
 * startJobs unschedules both and nothing is checked or scored. On is not
 * enough either: each job does nothing until Will has signed the Turn On
 * Predictions card (predictionsStarted), so "ships off" does not depend on a
 * setting being remembered.
 *
 *  - forecast.series: yesterday's value of each number that is on (predict/metrics.ts).
 *  - ledger.sweep: Flint checks its own predictions (ledger/sweep.ts).
 *  - ledger.snapshot: the night's scores (ledger/calibration.ts).
 *  - forecast.run: today's forecast of each number that is on (predict/run.ts).
 *  - ledger.ask: the day's questions for Will, about predictions only he can settle (predict/questions.ts).
 * None has job data. Log lines carry counts, ids and series keys, never a value or a prediction's words.
 */
export function predictJobs(ctx: JobContext): JobSpec[] {
  if (!ctx.config.predict) return [];
  return [
    {
      queue: 'forecast.series',
      cron: SERIES_CRON,
      missed: 'once',
      handler: async () => {
        if (!(await predictionsStarted(ctx.db))) return;
        const c = await runSeries({ db: ctx.db, tz: ctx.config.tz, run: makeRun(ctx.config.home), repos: clones(ctx.config.home), log: ctx.log });
        if (c.ran) ctx.log(`forecast: ${c.written} number(s) kept for ${c.on} series; ${c.down} day(s) left missing, ${c.failed} series failed`);
      },
    },
    {
      queue: 'forecast.run',
      cron: FORECAST_CRON,
      missed: 'once',
      handler: async () => {
        if (!(await predictionsStarted(ctx.db))) return;
        const c = await runForecasts({ db: ctx.db, tz: ctx.config.tz, log: ctx.log });
        if (c.allowed) ctx.log(`forecast: ${c.ran} forecast(s) and ${c.steady} steady of ${c.on} on; ${c.waiting} waiting for history, ${c.late} waiting for the latest number, ${c.same} already made, ${c.capped} capped, ${c.refused} refused, ${c.failed} failed`);
      },
    },
    {
      queue: 'ledger.sweep',
      cron: SWEEP_CRON,
      handler: async () => {
        if (!(await predictionsStarted(ctx.db))) return;
        const [resolve, expire] = [await standingOf(ctx, 'ledger.resolve.auto'), await standingOf(ctx, 'ledger.expire')];
        // A rule forbids both: nothing runs, and Health says a rule stops the checks.
        if (!resolve.may && !expire.may) return;
        const c = await sweep(ctx.db, { tz: ctx.config.tz, resolve: resolve.may, expire: expire.may, tiers: { resolve: resolve.tier, expire: expire.tier }, log: ctx.log });
        // Another sweep was still running (one that outlived its job, a second runtime during a deploy): this one did nothing.
        if (c.busy) return;
        if (c.resolved || c.expired || c.conditionUnmet || c.unknownSpec || c.refused) {
          ctx.log(`ledger: ${c.resolved} resolved, ${c.expired} expired, ${c.conditionUnmet} condition unmet; ${c.unknownSpec} with a rule no resolver knows, ${c.refused} refused, ${c.waiting} waiting`);
        }
      },
    },
    {
      queue: 'ledger.snapshot',
      cron: SNAPSHOT_CRON,
      missed: 'once',
      handler: async () => {
        if (!(await predictionsStarted(ctx.db))) return;
        const s = await standingOf(ctx, SNAPSHOT_ACTION);
        if (!s.may) return;
        const c = await runSnapshot(ctx.db, { tz: ctx.config.tz, tier: s.tier });
        ctx.log(`ledger: scored ${c.scored} yes/no prediction(s) and ${c.ranges} range(s) in ${c.groups} group(s)`);
      },
    },
    {
      // At most five new questions a day, oldest first. In shadow they wait in the panel, and nothing announces them.
      queue: 'ledger.ask',
      cron: ASK_CRON,
      missed: 'once',
      handler: async () => {
        if (!(await predictionsStarted(ctx.db))) return;
        const c = await askQuestions(ctx.db, { tz: ctx.config.tz });
        if (c.allowed && (c.asked || c.capped || c.refused)) ctx.log(`ledger: asked ${c.asked} question(s)${c.shadow ? ' in shadow' : ''}; ${c.capped} left for another day, ${c.refused} refused`);
      },
    },
  ];
}

/**
 * Tasks (P5). Scheduled only while they are switched on (FLINT_ASSETS=on);
 * otherwise this is empty, startJobs unschedules the tick and nothing is
 * worked or read. On, with no asset on, there is no task and the jobs idle:
 * what runs is still Will's signed cards. Job data is a task's id, checked
 * strictly; log lines carry ids, classes and counts.
 */
export function taskJobs(ctx: JobContext): JobSpec[] {
  if (!ctx.config.assets) return [];
  const log = (msg: string) => ctx.log(msg);
  return [
    {
      // Every 2 minutes: tasks still out are sent again or ended, and ended ones' forecasts scored. It runs no adapter.
      queue: 'tasks.tick',
      cron: TASK_TICK_CRON,
      handler: async () => {
        const r = await taskTick({ db: ctx.db, bus: ctx.bus, log });
        if (r.failed || r.cancelled || r.scored || r.ranOut) ctx.log(`tasks: ${r.failed} ended as failed, ${r.cancelled} cancelled, ${r.scored} forecast(s) scored, ${r.ranOut} run out`);
      },
    },
    {
      // One task's run on its asset.
      queue: 'tasks.run',
      handler: async (jobs) => {
        for (const job of jobs) {
          const data = TaskJob.safeParse(job.data);
          if (data.success) await runTaskJob({ db: ctx.db, bus: ctx.bus, log }, data.data);
        }
      },
    },
    {
      // One result against its bar; a passing one is offered to Will on a card, or accepted once he has promoted that.
      queue: 'tasks.check',
      handler: async (jobs) => {
        for (const job of jobs) {
          const data = TaskJob.safeParse(job.data);
          if (data.success) await checkTaskJob({ db: ctx.db, log }, data.data);
        }
      },
    },
  ];
}

/** The job set this runtime runs. */
export function jobSpecs(ctx: JobContext): JobSpec[] {
  return [...syncJobs(ctx), ...triageJobs(ctx), ...housekeepingJobs(ctx), ...goalJobs(ctx), ...predictJobs(ctx), ...taskJobs(ctx)];
}

/** What failed, not what it said (dbcodes.ts; kept here for the modules that import it from the jobs). */
export { failureClass };

export async function startJobs(ctx: JobContext, specs: JobSpec[]): Promise<void> {
  const { boss } = ctx.bus;
  const known = new Set(ALL_QUEUES);
  for (const s of specs) if (!known.has(s.queue)) throw new Error(`job ${s.queue} has no queue (the migration makes the closed set)`);
  const scheduled = new Set(specs.filter((s) => s.cron).map((s) => s.queue));
  for (const row of await boss.getSchedules()) if (!scheduled.has(row.name)) await boss.unschedule(row.name);
  for (const s of specs) {
    if (s.cron) await boss.schedule(s.queue, s.cron, null, { tz: ctx.config.tz, missed: s.missed ?? 'skip' });
    await boss.work<object>(s.queue, { batchSize: 1, localConcurrency: 1, ...s.work }, async (jobs) => {
      try {
        await s.handler(jobs);
      } catch (err) {
        // pg-boss keeps a failure in the job row (outside retention and forget):
        // it gets the class and code of the failure, never a source's or a model's words.
        const what = failureClass(err);
        ctx.log(`job ${s.queue} failed: ${what}`);
        throw new Error(what);
      }
    });
  }
}
