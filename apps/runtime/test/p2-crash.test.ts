/**
 * Exit criterion 2 (nothing lost), on flint_test with the real bus: the
 * pipeline runs in a child process that kill -9s itself after the event
 * commits, after the decision (with its escalation, intents and deliver job)
 * commits, and after the note is sent but before its outcome is written.
 * After the leases run out and a restart, every row and side effect exists
 * exactly once: one event, one decision and its audit, one escalation, three
 * deliveries sent with their outcomes, one note stored and one ping; every
 * intent closed, every event terminal. And Postgres dropping the runtime's
 * connections while it idles does not take it down.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { digestOf } from '@flint/policy';
import { NO_DB, freshDb, withClient, type TestUrls, RUNTIME } from './db';
import { enrollTestKey } from './sign';
import { createDb, type Db } from '../src/db';
import { startBus } from '../src/bus';
import { createProposal, approveProposal } from '../src/governance/proposals';
import { runInternal } from '../src/governance/internal';

const TSX = join(RUNTIME, 'node_modules', '.bin', 'tsx');
const CHILD = join(RUNTIME, 'test', 'fixtures', 'crash-child.ts');

describe.skipIf(NO_DB)('crash safety (kill -9)', () => {
  let urls: TestUrls;
  let db: Db;
  let server: Server;
  let serverUrl = '';
  /** The server's notes, deduped on ref as the real one does. */
  const notes = new Map<string, { stored: number; pings: number }>();
  const owner = (sql: string, params: unknown[] = []) => withClient(urls.owner, (c) => c.query(sql, params));

  /** One life, asynchronously: the stub server lives in this process and must keep answering. */
  function life(ref: string, fault?: string): Promise<{ status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
    return new Promise((done) => {
      const child = spawn(TSX, [CHILD], {
        cwd: RUNTIME,
        env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', NODE_ENV: 'test', CRASH_DATABASE_URL: urls.app, CRASH_REF: ref, CRASH_SERVER_URL: serverUrl, ...(fault ? { FLINT_TEST_FAULT: fault } : {}) },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c) => (stdout += c));
      child.stderr.on('data', (c) => (stderr += c));
      const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
      child.on('close', (status, signal) => {
        clearTimeout(timer);
        done({ status, signal, stdout, stderr });
      });
    });
  }

  beforeAll(async () => {
    urls = await freshDb();
    db = createDb(urls.app);
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c)).on('end', () => {
        const b = JSON.parse(body || '{}') as { ref?: string; channels?: string[] };
        const n = notes.get(b.ref ?? '') ?? { stored: 0, pings: 0 };
        const fresh = n.stored === 0;
        if (fresh) {
          n.stored = 1;
          if (b.channels?.includes('push')) n.pings += 1;
        }
        notes.set(b.ref ?? '', n);
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, stored: fresh, pinged: fresh && !!b.channels?.includes('push') }));
      });
    });
    await new Promise<void>((ok) => server.listen(0, '::1', ok));
    serverUrl = `http://[::1]:${(server.address() as { port: number }).port}`;
    // Promoted, so the note is really delivered.
    const key = await enrollTestKey(urls);
    const args = { rows: ['triage.*', 'notify.*'].map((pattern) => ({ pattern, tier: 'alone', expiresAt: new Date(Date.now() + 86_400_000).toISOString(), reason: 'crash harness' })) };
    const p = await createProposal(db, { kind: 'policy', origin: 'console', action: 'policy.change', args, argsProvenance: { rows: { source: 'will', tainted: false } }, tainted: false, sensitivity: 'ops', destructive: false, consequential: false, ttlMinutes: 60 }, 'test');
    await approveProposal(db, p.id, await key.approve({ subjectId: p.id, action: 'policy.change', argsDigest: digestOf(args) }), undefined, 'test');
    await runInternal(db, p.id, undefined, 'UTC', 'test');
  });
  afterAll(async () => {
    server?.close();
    await db?.$disconnect();
  });

  // After the intent is the same instant as after the decision: they commit in one transaction.
  for (const fault of ['after_event', 'after_decision', 'after_notify']) {
    it(`killed ${fault.replace('_', ' ')}: after a restart, everything exactly once`, async () => {
      const ref = `crash-${fault}`;
      const killed = await life(ref, fault);
      // tsx runs node as its child: a SIGKILLed node is tsx's exit status 137.
      expect(killed.signal === 'SIGKILL' || killed.status === 137, `${killed.status} ${killed.signal} ${killed.stderr.slice(-2000)}`).toBe(true);
      expect(killed.stdout).not.toContain('life done');
      // The killed life's leases run out (pg-boss's supervisor does this after expireInSeconds).
      await owner(`UPDATE pgboss.job SET state = 'retry', started_on = NULL WHERE state = 'active'`);
      const again = await life(ref);
      expect(again.status, again.stderr.slice(-2000)).toBe(0);

      const events = await db.sourceEvent.findMany({ where: { sourceRef: `backup.stale:${ref}` } });
      expect(events.map((e) => e.status)).toEqual(['applied']);
      const d = await db.triageDecision.findUniqueOrThrow({ where: { sourceEventId: events[0]!.id }, include: { escalation: { include: { deliveries: true } } } });
      expect(await db.auditEntry.count({ where: { correlationId: d.id, kind: 'decision' } })).toBe(1);
      const esc = d.escalation!;
      expect(esc.deliveries.map((x) => x.status)).toEqual(['sent', 'sent', 'sent']);
      expect(notes.get(esc.id)).toEqual({ stored: 1, pings: 1 });
      for (const ch of ['inapp', 'banner', 'push']) {
        expect(await db.auditEntry.count({ where: { correlationId: `${esc.id}.${ch}`, kind: 'intent' } }), ch).toBe(1);
        expect(await db.auditEntry.count({ where: { correlationId: `${esc.id}.${ch}`, kind: 'escalation', outcome: 'ok' } }), ch).toBe(1);
      }
      expect(await db.escalation.count({ where: { triageDecision: { sourceEventId: events[0]!.id } } })).toBe(1);
      expect(Number((await owner(`SELECT count(*) AS n FROM "SourceEvent" WHERE status NOT IN ('applied', 'ignored', 'dead')`)).rows[0].n)).toBe(0);
      expect(Number((await owner(`SELECT count(*) AS n FROM pgboss.job WHERE state IN ('created', 'retry', 'active')`)).rows[0].n)).toBe(0);
    });
  }

  it('Postgres dropping the runtime\'s connections while it idles does not take it down', async () => {
    const app = createDb(urls.app);
    const bus = await startBus(urls.app, () => {});
    try {
      await app.$queryRaw`SELECT 1`;
      // The app role may end its own role's other connections (the runtime's pools, pg-boss's included).
      const ended = await withClient(urls.app, (c) => c.query(`SELECT count(pg_terminate_backend(pid))::int AS n FROM pg_stat_activity WHERE usename = current_user AND pid <> pg_backend_pid() AND datname = current_database()`));
      expect(ended.rows[0].n).toBeGreaterThan(0);
      await new Promise((ok) => setTimeout(ok, 500));
      // Each pooled connection that was dropped fails the one query that finds it (the job holding it is
      // retried by pg-boss; nothing is retried blindly, a write might have landed); then the pool has
      // replaced them all, and the process never went down.
      const recovers = async <T>(f: () => Promise<T>): Promise<{ value: T; failures: number }> => {
        let last = '';
        for (let failures = 0; failures < 64; failures++) {
          try {
            return { value: await f(), failures };
          } catch (err) {
            // The next attempt takes another connection.
            last = err instanceof Error ? err.message.split('\n').slice(-1)[0]! : String(err);
          }
        }
        throw new Error(`the pool never recovered: ${last}`);
      };
      expect((await recovers(() => app.$queryRaw<Array<{ ok: number }>>`SELECT 1 AS ok`)).value).toEqual([{ ok: 1 }]);
      for (let i = 0; i < 10; i++) expect(await app.$queryRaw<Array<{ ok: number }>>`SELECT 1 AS ok`).toEqual([{ ok: 1 }]);
      expect((await recovers(() => bus.boss.send('rollup', null))).value).toBeTruthy();
      expect(await bus.boss.send('rollup', null, { singletonKey: 'after' })).toBeTruthy();
    } finally {
      await bus.boss.stop({ graceful: false });
      await app.$disconnect();
    }
  });
});
