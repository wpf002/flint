/**
 * The runtime's job bus (Machine plan P2): pg-boss 12.35.1 in its own `pgboss`
 * schema, installed by migration p2_runtime as flint_owner. The runtime starts
 * it with migrate:false and createSchema:false and runs no DDL: every queue in
 * QUEUES was made by the migration, on pg-boss's common job table, and a
 * missing one is a startup failure (the runtime then serves its API degraded
 * and retries), never something the app role creates.
 *
 * Jobs survive a restart and a kill -9 (a job's lease expires and it runs
 * again), cron schedules run in Flint's zone, failures retry with backoff
 * before landing in `dead`. Job data is ids only ({eventId}, {escalationId}):
 * pg-boss's tables sit outside retention and forget.
 */
import { PgBoss, fromPrisma } from 'pg-boss';
import { SOURCES } from '@flint/policy';
import type { Tx } from './db.js';

/** The closed queue set (the migration makes exactly these). */
export const QUEUES = {
  sync: SOURCES.map((s) => `sync.${s}`),
  /** One applied event; stately, sent with singletonKey = the event id. */
  triage: 'triage',
  /** One escalation's notes; stately, singletonKey = the escalation id. */
  deliver: 'deliver',
  /** Housekeeping on a schedule, one run at a time. */
  scheduled: ['health', 'digest', 'retention', 'rollup', 'reconcile', 'drill.check', 'expire.escalations'],
  dead: 'dead',
} as const;
export const ALL_QUEUES: readonly string[] = [...QUEUES.sync, QUEUES.triage, QUEUES.deliver, ...QUEUES.scheduled, QUEUES.dead];
/** pg-boss's own: its timekeeper's queue for cron sends (the migration makes it too). */
export const PGBOSS_QUEUES: readonly string[] = ['__pgboss__send-it'];

/** A source's cadence as a cron expression (whole minutes). */
export function cronFor(cadenceMs: number): string {
  const min = Math.max(1, Math.round(cadenceMs / 60_000));
  if (min === 1) return '* * * * *';
  if (min < 60) return `*/${min} * * * *`;
  return `0 */${Math.max(1, Math.round(min / 60))} * * *`;
}

/** pg's connection settings from a URL (its own parser keeps an IPv6 host's brackets). */
export function pgOptions(url: string) {
  const u = new URL(url);
  return {
    host: u.hostname.replace(/^\[|\]$/g, ''),
    port: u.port ? Number(u.port) : 5432,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.slice(1)),
  };
}

export interface Bus {
  boss: PgBoss;
  stop(): Promise<void>;
}

/** Send a job inside a database transaction: it commits, or rolls back, with what made it. */
export function inTx(tx: Tx): { db: ReturnType<typeof fromPrisma> } {
  return { db: fromPrisma(tx as unknown as Parameters<typeof fromPrisma>[0]) };
}

export async function startBus(databaseUrl: string, log: (m: string) => void): Promise<Bus> {
  const boss = new PgBoss({
    ...pgOptions(databaseUrl),
    schema: 'pgboss',
    migrate: false,
    createSchema: false,
    supervise: true,
    schedule: true,
    persistQueueStats: false,
    // Rebuilding indexes needs ownership; flint_app has none.
    reindex: false,
    max: 4,
  });
  boss.on('error', (err: Error) => log(`[bus] ${err.message.slice(0, 300)}`));
  await boss.start();
  const have = new Set((await boss.getQueues()).map((q) => q.name));
  const missing = [...ALL_QUEUES, ...PGBOSS_QUEUES].filter((q) => !have.has(q));
  if (missing.length) {
    await boss.stop({ graceful: false }).catch(() => {});
    throw new Error(`the job queue is missing queues the migration makes: ${missing.join(', ').slice(0, 300)}`);
  }
  return { boss, stop: () => boss.stop({ graceful: true, timeout: 15_000 }) };
}
