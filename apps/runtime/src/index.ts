/**
 * com.flint.runtime: the always-on runtime (plan 3.0.1). Loopback only; holds
 * no vendor keys and no FLINT_TOKEN.
 *
 * The API listens first, then the rest starts (lifecycle.ts). SIGTERM
 * (launchd's ExitTimeOut is 30 s): the bus drains for up to 15 s, the instance
 * is marked stopped, then the API and the database close.
 */
import { loadRuntimeConfig } from './config.js';
import { createDb } from './db.js';
import { buildApp, type RuntimeStatus } from './app.js';
import { run } from './lifecycle.js';
import { CalendarInbox } from './sources/apple/inbox.js';

async function main(): Promise<void> {
  const config = loadRuntimeConfig();
  if (config.tokens.length === 0) throw new Error('RUNTIME_TOKENS is empty: nothing could call the runtime');
  const db = createDb(config.databaseUrl);
  await db.$queryRaw`SELECT ensure_partitions(2)`;
  const status: RuntimeStatus = { problems: new Set(), busStartedAt: null };
  // P2.6: one Apple Calendar inbox, while that source is on: the push route fills it and the source reads it.
  const calendarInbox = config.appleCalendar ? new CalendarInbox() : undefined;
  const app = buildApp({ db, config, logger: true, status, ...(calendarInbox ? { calendarInbox } : {}) });
  await app.listen({ host: config.host, port: config.port });
  const life = await run(db, config, status, (msg, extra) => app.log.warn(extra ?? {}, msg), { ...(calendarInbox ? { calendarInbox } : {}) });
  let exiting = false;
  const exit = (signal: string) => {
    if (exiting) return;
    exiting = true;
    void (async () => {
      await life.stop(signal);
      await app.close();
      await db.$disconnect();
      process.exit(0);
    })();
  };
  process.on('SIGTERM', () => exit('SIGTERM'));
  process.on('SIGINT', () => exit('SIGINT'));
}

main().catch((err: unknown) => {
  // The message only: config errors name variables, never values.
  console.error(`runtime failed to start: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
