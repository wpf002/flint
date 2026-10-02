/**
 * One life of the runtime's pipeline, for the crash harness (p2-crash.test.ts):
 * the watchdog raises a critical event, triage decides it, delivery sends its
 * note. Run with NODE_ENV=test and FLINT_TEST_FAULT=<point> it dies by SIGKILL
 * at that point; run again without one, it picks up where the last life left.
 */
import { createDb } from '../../src/db';
import { startBus } from '../../src/bus';
import { loadConfig } from '../../src/config';
import { raise } from '../../src/health/watchdog';
import { triageEnqueue } from '../../src/events/record';
import { processEvent } from '../../src/triage/worker';
import { deliver } from '../../src/surface/deliver';

const url = process.env.CRASH_DATABASE_URL!;
const ref = process.env.CRASH_REF!;
const db = createDb(url);
const bus = await startBus(url, () => {});
const config = loadConfig({ DATABASE_URL: url, HOME: '/nonexistent', FLINT_RUNTIME_TRIAGE: 'on', FLINT_TZ: 'UTC', SERVER_INTERNAL_URL: process.env.CRASH_SERVER_URL!, SERVER_INTERNAL_TOKEN: 'c'.repeat(64) });
try {
  const now = new Date();
  await raise(db, [{ type: 'backup.stale', ref, occurredAt: now, payload: { hoursSince: 40 } }], now, triageEnqueue(bus));
  for (const queue of ['triage', 'deliver'] as const) {
    for (;;) {
      const jobs = await bus.boss.fetch<{ eventId?: string; escalationId?: string }>(queue, { batchSize: 10 });
      if (!jobs.length) break;
      for (const j of jobs) {
        if (queue === 'triage') await processEvent({ eventId: j.data.eventId! }, { db, config, bus, load: async () => 'proceed' });
        else await deliver(db, config, j.data.escalationId!);
        await bus.boss.complete(queue, j.id);
      }
    }
  }
  console.log('life done');
} finally {
  await bus.boss.stop({ graceful: false });
  await db.$disconnect();
}
