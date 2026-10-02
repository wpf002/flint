/**
 * com.flint.runtime: the always-on runtime (plan 3.0.1). Loopback only; holds
 * no vendor keys and no FLINT_TOKEN.
 */
import { loadRuntimeConfig } from './config.js';
import { createDb } from './db.js';
import { buildApp } from './app.js';
import { expireProposals, sweepExecuting } from './governance/proposals.js';
import { registry } from './sources/registry.js';
import { startScheduler } from './scheduler.js';

async function main(): Promise<void> {
  const config = loadRuntimeConfig();
  if (config.tokens.length === 0) throw new Error('RUNTIME_TOKENS is empty: nothing could call the runtime');
  const db = createDb(config.databaseUrl);
  await db.$queryRaw`SELECT ensure_partitions(2)`;
  const app = buildApp({ db, config, logger: true });
  // Housekeeping that changes only the runtime's own rows and is already
  // bounded by the database: expiring proposals Will did not decide in time.
  const tick = setInterval(() => {
    expireProposals(db).catch((err: unknown) => app.log.error({ err }, 'expiring proposals failed'));
    sweepExecuting(db).catch((err: unknown) => app.log.error({ err }, 'sweeping stuck executions failed'));
  }, 60_000);
  tick.unref();
  const stopSync = startScheduler(db, registry(config, db), config.tz, (msg, extra) => app.log.warn(extra ?? {}, msg));
  const stop = async () => {
    clearInterval(tick);
    stopSync();
    await app.close();
    await db.$disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop());
  process.on('SIGINT', () => void stop());
  await app.listen({ host: config.host, port: config.port });
}

main().catch((err: unknown) => {
  // The message only: config errors name variables, never values.
  console.error(`runtime failed to start: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
