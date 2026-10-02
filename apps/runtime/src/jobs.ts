/**
 * Everything the runtime does on its own, as jobs on the bus (Machine plan P2):
 * each world source on its cadence, and the rest as later work packages add
 * them. A job is a queue the migration made, an optional cron (in Flint's zone)
 * and a handler; startJobs registers the set it is given and unschedules every
 * other scheduled queue, so a job switched off (triage off) stops firing
 * instead of piling up unworked.
 */
import type { Job, ScheduleOptions, WorkOptions } from 'pg-boss';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { ALL_QUEUES, cronFor, type Bus } from './bus.js';
import { runLocked } from './scheduler.js';
import type { Registered } from './sources/registry.js';
import { triageEnqueue } from './events/record.js';
import { reconcile, sweepEvents } from './triage/reconcile.js';
import { processEvent, TriageJob } from './triage/worker.js';
import { deliver } from './surface/deliver.js';
import { expireEscalations } from './surface/expire.js';
import { checkComponents, recordChecks } from './health/checks.js';
import { raise, watchdog } from './health/watchdog.js';
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

/** The world sources, one queue each, run under the same advisory lock as before. */
export function syncJobs(ctx: JobContext): JobSpec[] {
  // Triage off: the sources keep running, and nothing is queued for triage.
  const enqueue = ctx.config.triage ? triageEnqueue(ctx.bus) : undefined;
  return ctx.sources.map((r) => ({
    queue: `sync.${r.source.name}`,
    cron: cronFor(r.source.cadenceMs),
    handler: async () => {
      const now = new Date();
      const cursor = () => ctx.db.sourceCursor.findUnique({ where: { source: r.source.name }, select: { consecutiveFailures: true, lastOkAt: true, updatedAt: true } });
      const before = await cursor();
      // An open circuit: skipped, but for one try every 6 cadences.
      if (!circuitAllows(before, r.source.cadenceMs, now)) return;
      const s = await runLocked(ctx.db, r, ctx.config.tz, now, enqueue);
      if (s?.failed || (s && !s.ran && s.reason && !s.reason.startsWith('not enabled'))) ctx.log(`sync ${r.source.name}: ${s.reason ?? `${s.failed} failed`}`, { failed: s.failed });
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

/** May an autonomous action run now: promoted, or in shadow at APPROVAL. */
async function mayRun(ctx: JobContext, action: string): Promise<boolean> {
  const t = resolveTier(action, { context: 'autonomous', tainted: false, policies: await activePolicies(ctx.db) });
  return t.tier === 'alone' || (t.tier === 'approval' && runsInShadow(action));
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
        const checks = await checkComponents({ db: ctx.db, config: ctx.config, now, sources });
        await recordChecks(ctx.db, checks, now);
        const raised = await raise(ctx.db, await watchdog(ctx.db, ctx.config, now), now, enqueue);
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

/** The job set this runtime runs. */
export function jobSpecs(ctx: JobContext): JobSpec[] {
  return [...syncJobs(ctx), ...triageJobs(ctx), ...housekeepingJobs(ctx)];
}

/** `TypeError`, `PrismaClientKnownRequestError P2002`, `Error ECONNREFUSED`: what failed, not what it said. */
export function failureClass(err: unknown): string {
  if (!(err instanceof Error)) return 'error';
  const code = (err as { code?: unknown }).code;
  return `${err.name.slice(0, 60)}${typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? ` ${code}` : ''}`;
}

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
