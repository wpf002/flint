/**
 * The job bus on the real pg-boss schema (migration p2_runtime), as flint_app:
 * it starts without DDL, refuses to start with a queue missing, retries a
 * failing job and then dead-letters it, re-runs a job whose lease ran out (a
 * kill -9), drains on stop without running a job twice, dedupes a stately
 * job on its singletonKey, and the app role cannot make a partitioned queue.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { PgBoss } from 'pg-boss';
import { NO_DB, freshDb, withClient, pgError, type TestUrls } from './db';
import { ALL_QUEUES, PGBOSS_QUEUES, QUEUES, cronFor, pgOptions, startBus, type Bus } from '../src/bus';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => Promise<boolean>, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await sleep(100);
  }
}

describe('cron and connection settings', () => {
  it('turns a cadence into a cron', () => {
    expect(cronFor(30_000)).toBe('* * * * *');
    expect(cronFor(5 * 60_000)).toBe('*/5 * * * *');
    expect(cronFor(2 * 3_600_000)).toBe('0 */2 * * *');
  });
  it('strips an IPv6 host of its brackets', () => {
    expect(pgOptions('postgresql://flint_app:p%40ss@[::1]:5432/flint_test')).toEqual({ host: '::1', port: 5432, user: 'flint_app', password: 'p@ss', database: 'flint_test' });
  });
});

describe.skipIf(NO_DB)('the job bus on pg-boss', () => {
  let urls: TestUrls;
  const owner = (sql: string, params: unknown[] = []) => withClient(urls.owner, (c) => c.query(sql, params));
  const app = (sql: string, params: unknown[] = []) => withClient(urls.app, (c) => c.query(sql, params));
  const jobs = async (name: string) => (await owner(`SELECT id, state, retry_count, data FROM pgboss.job WHERE name = $1 ORDER BY created_on`, [name])).rows;
  let open: Bus[] = [];
  const start = async () => {
    const b = await startBus(urls.app, () => {});
    open.push(b);
    return b;
  };

  beforeAll(async () => {
    urls = await freshDb();
  });
  afterEach(async () => {
    for (const b of open) await b.boss.stop({ graceful: false }).catch(() => {});
    open = [];
    await owner(`DELETE FROM pgboss.job`);
    await owner(`DELETE FROM pgboss.schedule`);
  });

  it('starts as flint_app with every queue of the closed set there', async () => {
    const b = await start();
    const have = (await b.boss.getQueues()).map((q) => q.name).sort();
    expect(have).toEqual([...ALL_QUEUES, ...PGBOSS_QUEUES].sort());
    expect(QUEUES.sync).toContain('sync.nexus_inbox');
    // P3's three, made by its migration (nothing sends to them until the planner is on).
    expect(ALL_QUEUES).toEqual(expect.arrayContaining(['goals.tick', 'goals.review', 'goals.plan']));
    const policy = Object.fromEntries((await b.boss.getQueues()).map((q) => [q.name, q.policy]));
    expect([policy['goals.tick'], policy['goals.review'], policy['goals.plan']]).toEqual(['singleton', 'stately', 'stately']);
  });

  it('missing queue → degraded start: it refuses to start and names the queue', async () => {
    await owner(`UPDATE pgboss.queue SET name = 'drill.check.hidden' WHERE name = 'drill.check'`);
    try {
      await expect(startBus(urls.app, () => {})).rejects.toThrow(/missing queues.*drill\.check/);
    } finally {
      await owner(`UPDATE pgboss.queue SET name = 'drill.check' WHERE name = 'drill.check.hidden'`);
    }
    expect((await start()).boss).toBeTruthy();
  });

  it('failing handler retries with backoff, then lands in dead', async () => {
    const b = await start();
    let calls = 0;
    await b.boss.work('triage', { pollingIntervalSeconds: 0.5 }, async () => {
      calls++;
      throw new Error('boom');
    });
    // The queue's own policy waits 30 s doubling; the same policy, faster, for the test.
    const jobId = await b.boss.send('triage', { eventId: 'se1' }, { singletonKey: 'se1', retryLimit: 2, retryDelay: 1, retryBackoff: true });
    expect(jobId).toBeTruthy();
    await until(async () => (await jobs('dead')).length === 1, 25_000);
    expect(calls).toBe(3);
    const [job] = await jobs('triage');
    expect(job).toMatchObject({ state: 'failed', retry_count: 2 });
    expect((await jobs('dead'))[0].data).toEqual({ eventId: 'se1' });
  });

  it('lease expiry re-runs a job (a runtime killed mid-job)', async () => {
    const b = await start();
    await b.boss.send('health', null, { expireInSeconds: 1, retryLimit: 1, retryDelay: 0 });
    // A worker takes it and dies without settling it (kill -9).
    const [taken] = await b.boss.fetch('health');
    expect(taken).toBeTruthy();
    await sleep(1_500);
    await b.boss.supervise('health');
    let ran = 0;
    await b.boss.work('health', { pollingIntervalSeconds: 0.5 }, async () => {
      ran++;
    });
    await until(async () => (await jobs('health'))[0]?.state === 'completed');
    expect(ran).toBe(1);
    expect((await jobs('health'))[0].retry_count).toBe(1);
  });

  it('SIGTERM drain completes or releases the active job, never twice', async () => {
    const b = await start();
    let ran = 0;
    let started = false;
    await b.boss.work('rollup', { pollingIntervalSeconds: 0.5 }, async () => {
      started = true;
      await sleep(800);
      ran++;
    });
    await b.boss.send('rollup', null);
    await until(async () => started);
    await b.stop();
    open = open.filter((x) => x !== b);
    expect(ran).toBe(1);
    expect((await jobs('rollup'))[0].state).toBe('completed');
    // A second runtime finds nothing left to run.
    const b2 = await start();
    let again = 0;
    await b2.boss.work('rollup', { pollingIntervalSeconds: 0.5 }, async () => {
      again++;
    });
    await sleep(1_500);
    expect(again).toBe(0);
  });

  it('stately singletonKey dedupes', async () => {
    const b = await start();
    expect(await b.boss.send('triage', { eventId: 'se2' }, { singletonKey: 'se2' })).toBeTruthy();
    expect(await b.boss.send('triage', { eventId: 'se2' }, { singletonKey: 'se2' })).toBeNull();
    expect(await b.boss.send('triage', { eventId: 'se3' }, { singletonKey: 'se3' })).toBeTruthy();
    expect((await jobs('triage')).length).toBe(2);
  });

  it('the app role cannot create a partitioned queue, or any table in pgboss', async () => {
    const e = await pgError(app(`SELECT pgboss.create_queue('made.by.app', '{"policy":"standard","partition":true}'::jsonb)`));
    expect(e.code).toBe('42501');
    expect((await pgError(app(`CREATE TABLE pgboss.mine (id int)`))).code).toBe('42501');
    expect((await pgError(app(`UPDATE pgboss.version SET version = version`))).code).toBe('42501');
  });

  it('a full supervise pass and cron passes run as flint_app without a privilege error', async () => {
    const errors: string[] = [];
    const b = await startBus(urls.app, (m) => errors.push(m));
    open.push(b);
    await b.boss.schedule('retention', '* * * * *', null, { tz: 'America/Chicago' });
    await b.boss.supervise();
    await sleep(1_500);
    await b.boss.supervise();
    expect((await b.boss.getSchedules()).map((r) => r.name)).toEqual(['retention']);
    expect(errors).toEqual([]);
  });

  it('runs no DDL at start (migrate and createSchema off)', async () => {
    // A boss that would migrate needs CREATE; flint_app has none, so this start would fail.
    const b = new PgBoss({ ...pgOptions(urls.app), schema: 'pgboss', migrate: false, createSchema: false, supervise: false, schedule: false, persistQueueStats: false, reindex: false });
    await b.start();
    await b.stop({ graceful: false });
  });
});
