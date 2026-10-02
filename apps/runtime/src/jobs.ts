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
import { reconcile } from './triage/reconcile.js';
import { processEvent, TriageJob } from './triage/worker.js';
import { deliver } from './surface/deliver.js';
import { expireEscalations } from './surface/expire.js';
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
      const s = await runLocked(ctx.db, r, ctx.config.tz, new Date(), enqueue);
      if (s?.failed || (s && !s.ran && s.reason && !s.reason.startsWith('not enabled'))) ctx.log(`sync ${r.source.name}: ${s.reason ?? `${s.failed} failed`}`, s);
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
        if (r.resent || r.dead) ctx.log(`reconcile: ${r.resent} re-sent, ${r.dead} dead`);
      },
    },
  ];
}

/** Housekeeping that runs whether triage is on or not. */
export function housekeepingJobs(ctx: JobContext): JobSpec[] {
  return [
    {
      queue: 'expire.escalations',
      cron: '7 * * * *',
      handler: async () => {
        const n = await expireEscalations(ctx.db);
        if (n) ctx.log(`expired ${n} escalation(s)`);
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
