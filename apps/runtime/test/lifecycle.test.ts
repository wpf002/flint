/**
 * The runtime's life around its API (src/lifecycle.ts): the P1 routes serve
 * while the bus cannot start, the heartbeat beats without the bus, the bus is
 * retried until it starts, /health names what is degraded (an overdue health
 * run included), and a stop drains the bus and marks the instance stopped.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { NO_DB, freshDb, withClient, type TestUrls } from './db';
import { createDb, type Db } from '../src/db';
import { buildApp, HEALTH_RUN_STALE_MS, type RuntimeStatus } from '../src/app';
import { loadConfig } from '../src/config';
import { run, type Lifecycle } from '../src/lifecycle';
import { startBus } from '../src/bus';
import { uptime } from '../src/health/instance';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await sleep(50);
  }
}

describe('uptime', () => {
  const t = (min: number) => new Date(Date.UTC(2026, 9, 2, 0, min));
  it('counts each instance to its last beat plus two minutes, and excluded windows neither way', () => {
    expect(uptime([{ startedAt: t(0), lastBeatAt: t(58) }], t(0), t(60))).toBe(1);
    expect(uptime([{ startedAt: t(0), lastBeatAt: t(28) }], t(0), t(60))).toBeCloseTo(0.5);
    expect(uptime([], t(0), t(60))).toBe(0);
    // Down 30..60, but 30..60 was a deploy: up the whole of what counts.
    expect(uptime([{ startedAt: t(0), lastBeatAt: t(28) }], t(0), t(60), [{ start: t(30), end: t(60) }])).toBe(1);
    // Overlapping instances count once.
    expect(uptime([{ startedAt: t(0), lastBeatAt: t(40) }, { startedAt: t(10), lastBeatAt: t(28) }], t(0), t(60))).toBeCloseTo(42 / 60);
  });
});

describe.skipIf(NO_DB)('the runtime lifecycle', () => {
  let urls: TestUrls;
  let db: Db;
  let app: FastifyInstance;
  let status: RuntimeStatus;
  const owner = (sql: string, params: unknown[] = []) => withClient(urls.owner, (c) => c.query(sql, params));
  const health = async () => (await app.inject({ method: 'GET', url: '/health' })).json() as { ok: boolean; degraded: string[] };
  const config = () => loadConfig({ DATABASE_URL: urls.app, HOME: '/nonexistent-home' });
  const lives: Lifecycle[] = [];

  beforeAll(async () => {
    urls = await freshDb();
    db = createDb(urls.app);
  });
  afterAll(async () => {
    for (const l of lives) await l.stop('test over').catch(() => {});
    await app?.close();
    await db?.$disconnect();
  });
  const fresh = () => {
    status = { problems: new Set(), busStartedAt: null };
    app = buildApp({ db, config: { tokens: [], tz: 'America/Chicago' }, status });
  };

  it('the P1 API serves when pg-boss can\'t start, and the heartbeat beats without it', async () => {
    fresh();
    let tries = 0;
    const life = await run(db, config(), status, () => {}, {
      startBus: async () => {
        tries++;
        throw new Error('no bus');
      },
      backoffMs: () => 50,
      beatMs: 100,
      jobs: () => [],
    });
    lives.push(life);
    await until(() => tries >= 3);
    expect(await health()).toEqual({ ok: true, db: 'up', degraded: ['bus'] });
    const before = (await owner(`SELECT "lastBeatAt" FROM "RuntimeInstance" WHERE id = $1`, [life.instanceId])).rows[0].lastBeatAt as Date;
    await sleep(400);
    const after = (await owner(`SELECT "lastBeatAt", "gitSha" FROM "RuntimeInstance" WHERE id = $1`, [life.instanceId])).rows[0];
    expect(after.lastBeatAt.getTime()).toBeGreaterThan(before.getTime());
    expect(after.gitSha).toBe('dev');
    await life.stop('SIGTERM');
    const n = tries;
    await sleep(200);
    // Stopped: no more tries, and the instance says why it stopped.
    expect(tries).toBe(n);
    expect((await owner(`SELECT "stopReason" FROM "RuntimeInstance" WHERE id = $1`, [life.instanceId])).rows[0].stopReason).toBe('SIGTERM');
  });

  it('retries the bus until it starts, then drains it on stop', async () => {
    fresh();
    let tries = 0;
    let ran = 0;
    const life = await run(db, config(), status, () => {}, {
      startBus: async (url, log) => {
        if (tries++ === 0) throw new Error('not yet');
        return startBus(url, log);
      },
      backoffMs: () => 50,
      jobs: () => [{ queue: 'rollup', handler: async () => void (await sleep(500), ran++) }],
    });
    lives.push(life);
    await until(() => !!life.bus());
    expect(await health()).toEqual({ ok: true, db: 'up', degraded: [] });
    await life.bus()!.boss.send('rollup', null);
    await until(async () => (await owner(`SELECT state FROM pgboss.job WHERE name = 'rollup'`)).rows[0]?.state === 'active');
    await life.stop('SIGTERM');
    expect(ran).toBe(1);
    expect((await owner(`SELECT state FROM pgboss.job WHERE name = 'rollup'`)).rows[0].state).toBe('completed');
    expect((await owner(`SELECT "stoppedAt" IS NOT NULL AS s FROM "RuntimeInstance" WHERE id = $1`, [life.instanceId])).rows[0].s).toBe(true);
  });

  it('/health degraded when the last health run is over 10 min old', async () => {
    fresh();
    await owner(`DELETE FROM "HealthCheck"`);
    status.busStartedAt = new Date(Date.now() - HEALTH_RUN_STALE_MS - 60_000);
    expect((await health()).degraded).toEqual(['health-overdue']);
    await owner(`INSERT INTO "HealthCheck" (id, component, status, at) VALUES ('hc1', 'runtime', 'ok', now() - interval '11 minutes')`);
    expect((await health()).degraded).toEqual(['health-overdue']);
    await owner(`INSERT INTO "HealthCheck" (id, component, status, at) VALUES ('hc2', 'runtime', 'ok', now())`);
    expect((await health()).degraded).toEqual([]);
    // A bus that only just started has not had the time to run it.
    await owner(`DELETE FROM "HealthCheck"`);
    status.busStartedAt = new Date();
    expect((await health()).degraded).toEqual([]);
  });
});
