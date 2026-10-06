/**
 * Flint Calendar's push route (P2.6), through buildApp and Fastify's inject
 * (no port, no database: the cursor and the bus are stand-ins). Its token
 * reaches this route and nothing else, and no other token reaches it; the
 * token is checked before the body is read; then 413, 400 (paths, never a
 * value), 404 while the source is off, 409 while it is not turned on (what was
 * held is dropped), 422 for a stale or replayed snapshot, 429 within 5
 * seconds, and 202, which holds the snapshot and sends exactly one job with no
 * content. Nothing of a snapshot, nor the token, reaches the log.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildApp, type RuntimeStatus } from '../src/app';
import { CalendarInbox } from '../src/sources/apple/inbox';
import { SNAPSHOT_BODY_LIMIT, SNAPSHOT_PATH } from '../src/routes/apple-calendar';
import type { RuntimeScope } from '../src/config';
import type { Db } from '../src/db';
import type { Bus } from '../src/bus';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const APPLE = 'a'.repeat(32) + 'b'.repeat(32);
const SERVER = 'server-token-0123456789abcdef';
const MCP = 'mcp-token-0123456789abcdef01';
const TITLE = 'CANARY-title Lunch at the safehouse';
const EMAIL = 'canary-mail@example.com';
const H = (s: string) => sha(s);

const tokens = [
  { name: 'server', sha256: sha(SERVER), scopes: new Set<RuntimeScope>(['events', 'audit', 'proposals', 'world:read', 'ledger', 'counters']) },
  { name: 'runtime-mcp', sha256: sha(MCP), scopes: new Set<RuntimeScope>(['world:read', 'ledger']) },
  { name: 'apple-calendar', sha256: sha(APPLE), scopes: new Set<RuntimeScope>(['calendar:push']) },
];

/** A snapshot read `ago` ms before now, with a canary title and attendee. */
const snapshot = (ago = 0, o: Record<string, unknown> = {}) => {
  const at = new Date(Date.now() - ago);
  return {
    v: 1, generatedAt: at.toISOString(), access: 'full', state: 'live', window: { start: at.toISOString(), end: new Date(at.getTime() + 14 * 86_400_000).toISOString() },
    tz: 'America/Chicago', complete: true, calendars: { count: 1, hash: H('cal') },
    events: [{
      id: H('e1'), recurring: false, status: 'confirmed', title: TITLE, start: { at: new Date(at.getTime() + 3_600_000).toISOString() }, end: { at: new Date(at.getTime() + 7_200_000).toISOString() },
      self: 'organizer', attendees: [{ name: 'CANARY-name Ada', email: EMAIL, kind: 'person' }],
    }],
    ...o,
  };
};

function harness(o: { enabled?: boolean | null; registered?: boolean; send?: (q: string, data: unknown) => Promise<unknown> } = {}) {
  const lines: string[] = [];
  const sent: Array<[string, unknown]> = [];
  const db = {
    sourceCursor: { findUnique: async ({ where }: { where: { source: string } }) => (where.source === 'apple_calendar' && o.enabled !== null ? { enabled: o.enabled ?? true } : null) },
  } as unknown as Db;
  const bus = { boss: { send: o.send ?? (async (q: string, data: unknown) => (sent.push([q, data]), 'job1')) } } as unknown as Bus;
  const status: RuntimeStatus = { problems: new Set(), busStartedAt: null, bus };
  const inbox = new CalendarInbox();
  const app = buildApp({
    db, status, logger: true, logStream: { write: (l: string) => void lines.push(l) },
    config: { tz: 'UTC', tokens }, ...(o.registered === false ? {} : { calendarInbox: inbox }),
  });
  const push = (body: unknown, token: string | null = APPLE, raw = false) =>
    app.inject({
      method: 'POST', url: SNAPSHOT_PATH, ...(raw ? { payload: body as string, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } } : { payload: body as object, headers: token ? { authorization: `Bearer ${token}` } : {} }),
    });
  return { app, inbox, sent, lines, push };
}

describe('POST /v1/sources/apple_calendar/snapshot', () => {
  it('only the push token: none is 401, the server\'s and the connector\'s are 403', async () => {
    const h = harness();
    expect((await h.push(snapshot(), null)).statusCode).toBe(401);
    expect((await h.push(snapshot(), 'not-a-real-token-0123456789')).statusCode).toBe(401);
    expect((await h.push(snapshot(), SERVER)).statusCode).toBe(403);
    expect((await h.push(snapshot(), MCP)).statusCode).toBe(403);
    expect(h.inbox.latest()).toBeUndefined();
    expect((await h.push(snapshot())).statusCode).toBe(202);
    await h.app.close();
  });

  it('the push token reaches nothing else: every other route is 403 to it', async () => {
    const h = harness();
    const routes: Array<['GET' | 'POST', string]> = [
      ['GET', '/v1/world/now'], ['GET', '/v1/world/entities/e1'], ['POST', '/v1/audit'], ['POST', '/v1/audit/rollup'], ['GET', '/v1/audit'],
      ['POST', '/v1/proposals'], ['GET', '/v1/proposals'], ['GET', '/v1/proposals/p1'], ['GET', '/v1/policies'], ['POST', '/v1/proposals/p1/approve'],
      ['POST', '/v1/proposals/p1/reject'], ['POST', '/v1/proposals/p1/claim'], ['POST', '/v1/proposals/p1/run'], ['POST', '/v1/proposals/p1/complete'],
      ['POST', '/v1/counters/claim'], ['POST', '/v1/ledger/predictions'], ['GET', '/v1/ledger/open'], ['GET', '/v1/ledger/calibration'],
      ['POST', '/v1/events'], ['GET', '/v1/inbox/titles?ids=x'], ['GET', '/v1/inbox?lane=relevant'], ['POST', '/v1/inbox/d1/feedback'],
      ['POST', '/v1/escalations/x1/ack'], ['POST', '/v1/escalations/x1/dismiss'], ['GET', '/v1/health/report'], ['GET', '/v1/p2/report'],
      ['GET', '/v1/p25/report'], ['GET', '/v1/triage/recent'], ['GET', '/v1/escalations/open'], ['GET', '/v1/triage/decisions/d1/explain'],
    ];
    for (const [method, url] of routes) {
      const r = await h.app.inject({ method, url, headers: { authorization: `Bearer ${APPLE}` }, ...(method === 'POST' ? { payload: {} } : {}) });
      expect(r.statusCode, `${method} ${url}`).toBe(403);
    }
    // A route that does not exist is not a way in either.
    expect((await h.app.inject({ method: 'GET', url: SNAPSHOT_PATH, headers: { authorization: `Bearer ${APPLE}` } })).statusCode).toBe(404);
    await h.app.close();
  });

  it('over 2 MiB is 413; without the token, a big body is 401 before it is read', async () => {
    const h = harness();
    const big = JSON.stringify({ ...snapshot(), pad: 'x'.repeat(SNAPSHOT_BODY_LIMIT) });
    expect((await h.push(big, APPLE, true)).statusCode).toBe(413);
    expect((await h.push(big, null, true)).statusCode).toBe(401);
    // Up to the limit (well over the 64 KB other routes take) is read.
    const full = snapshot(0, { events: Array.from({ length: 600 }, (_, i) => ({ ...snapshot().events[0]!, id: H(`e${i}`), title: 'x'.repeat(300) })) });
    expect(JSON.stringify(full).length).toBeGreaterThan(64 * 1024);
    expect((await h.push(full)).statusCode).toBe(202);
    await h.app.close();
  });

  it('a bad envelope is 400, naming schema paths and never a value; a NUL is 400', async () => {
    const h = harness();
    const r = await h.push(snapshot(0, { access: 'CANARY-access', extra: 'CANARY-extra', events: [{ ...snapshot().events[0]!, self: 'CANARY-self' }] }));
    expect(r.statusCode).toBe(400);
    const body = r.json() as { error: string; issues: Array<{ path: string }> };
    expect(body.error).toBe('invalid input');
    expect(body.issues.length).toBeGreaterThan(0);
    expect(r.body).not.toMatch(/canary/i);
    expect((await h.push(snapshot(0, { v: 2 }))).json()).toEqual({ error: 'invalid input', issues: [{ path: 'v' }] });
    const nul = await h.push(snapshot(0, { events: [{ ...snapshot().events[0]!, title: 'Lunch\u0000' }] }));
    expect(nul.statusCode).toBe(400);
    expect(nul.body).not.toMatch(/Lunch/);
    expect((await h.push('{not json', APPLE, true)).statusCode).toBe(400);
    expect(h.inbox.latest()).toBeUndefined();
    await h.app.close();
  });

  it('404 while the source is off; 409 while it is not turned on, and nothing is held', async () => {
    const off = harness({ registered: false });
    expect((await off.push(snapshot())).statusCode).toBe(404);
    expect(off.sent).toEqual([]);
    await off.app.close();
    for (const enabled of [false, null]) {
      const h = harness({ enabled });
      // Something held from before (turned on, then off): dropped.
      h.inbox.offer(JSON.parse(JSON.stringify(snapshot(60_000))) as never);
      const r = await h.push(snapshot());
      expect(r.statusCode, String(enabled)).toBe(409);
      expect(r.json()).toEqual({ error: 'not_enabled' });
      expect(h.inbox.latest()).toBeUndefined();
      expect(h.sent).toEqual([]);
      await h.app.close();
    }
  });

  it('422 for a snapshot read too long ago, from the future, replayed, or older than the last', async () => {
    const h = harness();
    expect((await h.push(snapshot(11 * 60_000))).statusCode).toBe(422);
    expect((await h.push(snapshot(-3 * 60_000))).statusCode).toBe(422);
    const first = snapshot(60_000);
    expect((await h.push(first)).statusCode).toBe(202);
    await new Promise((r) => setTimeout(r, 5_050));
    expect((await h.push(first)).json()).toEqual({ error: 'stale' });
    expect((await h.push(snapshot(120_000))).statusCode).toBe(422);
    expect((await h.push(snapshot(0))).statusCode).toBe(202);
    await h.app.close();
  }, 15_000);

  it('429 within 5 seconds of the last accepted', async () => {
    const h = harness();
    expect((await h.push(snapshot(2_000))).statusCode).toBe(202);
    const r = await h.push(snapshot(0));
    expect(r.statusCode).toBe(429);
    expect(r.headers['retry-after']).toBe('5');
    expect(h.sent).toHaveLength(1);
    await h.app.close();
  });

  it('202 holds the snapshot and sends exactly one sync.apple_calendar job, with no content', async () => {
    const h = harness();
    const r = await h.push(snapshot());
    expect(r.statusCode).toBe(202);
    expect(r.json()).toEqual({ accepted: true });
    expect(h.sent).toEqual([['sync.apple_calendar', { reason: 'push' }]]);
    const held = h.inbox.latest()!;
    expect(held.snapshot.events[0]!.title).toBe(TITLE);
    // The bus failing loses nothing: still held, still 202 (the 5-minute run reads it).
    const down = harness({ send: async () => { throw new Error(`queue said ${TITLE}`); } });
    expect((await down.push(snapshot())).statusCode).toBe(202);
    expect(down.inbox.latest()).toBeDefined();
    expect(down.lines.join('')).toMatch(/sending sync\.apple_calendar failed: Error/);
    await h.app.close();
    await down.app.close();
  });

  it('nothing of a snapshot, nor the token, reaches the log', async () => {
    const h = harness({ send: async () => { throw new Error(`boom ${TITLE} ${EMAIL}`); } });
    await h.push(snapshot());
    await h.push(snapshot(0, { access: TITLE }));
    await h.push(snapshot(), SERVER);
    await h.push(JSON.stringify({ ...snapshot(), pad: `${TITLE}${'x'.repeat(SNAPSHOT_BODY_LIMIT)}` }), APPLE, true);
    const log = h.lines.join('\n');
    expect(log.length).toBeGreaterThan(0);
    expect(log).not.toMatch(/canary|safehouse/i);
    expect(log).not.toContain(APPLE);
    expect(log).not.toContain(SERVER);
    await h.app.close();
  });

  it('the golden fixture is accepted as it is (read now)', async () => {
    const h = harness();
    const raw = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'apple-calendar-snapshot.json'), 'utf8')) as Record<string, unknown>;
    const now = new Date().toISOString();
    expect((await h.push({ ...raw, generatedAt: now, window: { start: now, end: new Date(Date.now() + 14 * 86_400_000).toISOString() } })).statusCode).toBe(202);
    expect(h.inbox.latest()!.snapshot.events).toHaveLength(9);
    await h.app.close();
  });
});
