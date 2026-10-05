/**
 * The lanes routes (Machine plan P2), end to end over HTTP: the console's
 * requests are validated before the runtime sees them, the runtime's answers
 * are checked against the wire contracts before the console sees them, a
 * runtime 401/403 is a 502 (the console forgets its token on a 401), and the
 * runtime's own words never pass through.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { inboxRoutes, type InboxDeps } from '../src/inbox-routes';

const AT = '2026-10-02T15:00:00.000Z';
const TOKEN = 'd'.repeat(64);

const item = (over: Record<string, unknown> = {}) => ({
  id: 'td_cm1', at: AT, lane: 'relevant', action: 'escalate', decidedBy: 'rule:service_down', ruleName: 'service_down', relevance: null, reasonCode: 'failure',
  source: 'railway', eventType: 'service.health', entity: { ref: 'service#24ehza', kind: 'service', name: 'api' }, reasoning: null, feedback: null, tainted: false, sensitivity: 'ops',
  escalation: { id: 'es_cm1', templateId: 'service_down', title: 'api is down', body: 'Down for 31 minutes.', status: 'open', channels: ['inapp'], tainted: false, createdAt: AT },
  ...over,
});
const health = { at: AT, instance: { gitSha: 'a'.repeat(40), startedAt: AT, lastBeatAt: AT }, uptime14d: 0.995, components: [{ component: 'postgres', status: 'ok', detail: null, at: AT }], lastHealthRun: AT, triage: 'on' };

/** The runtime: what it was asked, and what it answers (set per test). */
let asked: Array<{ method: string; url: string; auth: string | undefined; body: string }>;
let answer: (req: { method: string; url: string }) => { status: number; body: unknown };
let runtime: Server;
let rtUrl: string;
let server: Server;
let base: string;
let refs: string[];
let deps: InboxDeps;

beforeAll(async () => {
  runtime = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      asked.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, body });
      const a = answer({ method: req.method!, url: req.url! });
      res.writeHead(a.status, { 'content-type': 'application/json' });
      res.end(typeof a.body === 'string' ? a.body : JSON.stringify(a.body));
    });
  });
  await new Promise<void>((r) => runtime.listen(0, '::1', r));
  rtUrl = `http://[::1]:${(runtime.address() as AddressInfo).port}`;
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void inboxRoutes(req, res, req.url ?? '/', deps).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end('{"error":"not found"}');
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '::1', r));
  base = `http://[::1]:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  runtime.close();
  server.close();
});
beforeEach(() => {
  asked = [];
  refs = [];
  answer = () => ({ status: 200, body: { ok: true } });
  deps = { runtime: () => ({ url: rtUrl, token: TOKEN }), errorRef: (_t, err) => (refs.push(String(err)), 'ref123') };
});

const get = (p: string) => fetch(`${base}${p}`);
const post = (p: string, body?: unknown) => fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? '{}' : JSON.stringify(body) });

describe('GET /inbox', () => {
  it('passes a validated page request through and answers the checked page', async () => {
    answer = () => ({ status: 200, body: { items: [item()], next: AT } });
    const r = await get(`/inbox?lane=quiet&before=${encodeURIComponent(AT)}&limit=20`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ items: [item()], next: AT });
    expect(asked).toHaveLength(1);
    expect(asked[0]!.auth).toBe(`Bearer ${TOKEN}`);
    const u = new URL(asked[0]!.url, 'http://x');
    expect(u.pathname).toBe('/v1/inbox');
    expect(Object.fromEntries(u.searchParams)).toEqual({ lane: 'quiet', limit: '20', before: AT });
  });

  it('defaults to the relevant lane, 50 items', async () => {
    answer = () => ({ status: 200, body: { items: [], next: null } });
    await get('/inbox');
    expect(Object.fromEntries(new URL(asked[0]!.url, 'http://x').searchParams)).toEqual({ lane: 'relevant', limit: '50' });
  });

  it('refuses a bad lane, before or limit before asking the runtime', async () => {
    for (const q of ['lane=all', 'lane=', 'before=yesterday', 'before=2026-10-02', 'limit=0', 'limit=101', 'limit=ten', 'limit=1e2']) {
      expect((await get(`/inbox?${q}`)).status).toBe(400);
    }
    expect(asked).toHaveLength(0);
  });

  it("an answer that is not the contract is a 502 with a reference, never the runtime's words", async () => {
    answer = () => ({ status: 200, body: { items: [item({ reasoning: 'x'.repeat(600) })], next: null } });
    const r = await get('/inbox');
    expect(r.status).toBe(502);
    const b = (await r.json()) as { error: string; ref: string };
    expect(b).toEqual({ error: 'the runtime sent an answer the server does not accept', ref: 'ref123' });
    expect(refs[0]).toContain('items.0.reasoning');
    expect(refs[0]).not.toContain('xxxx');
    answer = () => ({ status: 200, body: '<html>oops</html>' });
    expect((await get('/inbox')).status).toBe(502);
  });

  it("a runtime 401 or 403 is a 502 (the console must not drop its token), its message never passed on", async () => {
    for (const status of [401, 403]) {
      answer = () => ({ status, body: { error: 'token sha mismatch for scope events' } });
      const r = await get('/inbox');
      expect(r.status).toBe(502);
      const text = await r.text();
      expect(text).toMatch(/refused the server's token/);
      expect(text).not.toContain('sha mismatch');
    }
  });

  it('a runtime older than the lanes (404) says so; a 5xx is a 502 with a reference', async () => {
    answer = () => ({ status: 404, body: { message: 'Route GET:/v1/inbox not found' } });
    const r = await get('/inbox');
    expect(r.status).toBe(501);
    expect(await r.json()).toEqual({ error: 'the lanes need the P2 runtime' });
    answer = () => ({ status: 500, body: { error: 'PrismaClientKnownRequestError: relation "TriageDecision" does not exist' } });
    const f = await get('/inbox');
    expect(f.status).toBe(502);
    expect(await f.text()).not.toContain('Prisma');
  });

  it('no runtime installed: 503; a runtime that does not answer: 502', async () => {
    deps = { ...deps, runtime: () => undefined };
    expect((await get('/inbox')).status).toBe(503);
    deps = { ...deps, runtime: () => ({ url: 'http://[::1]:9', token: TOKEN }) };
    const r = await get('/inbox');
    expect(r.status).toBe(502);
    expect(await r.json()).toEqual({ error: 'the runtime did not answer' });
  });

  it('times out, and reads or cancels every runtime body', async () => {
    let cancelled = 0;
    const respond = (status: number, body: string) => {
      const r = new Response(body, { status });
      const cancel = r.body!.cancel.bind(r.body);
      r.body!.cancel = (why?: unknown) => (cancelled++, cancel(why));
      return r;
    };
    deps = { ...deps, fetchImpl: (async () => respond(503, 'busy')) as unknown as typeof fetch };
    expect((await get('/inbox')).status).toBe(502);
    expect(cancelled).toBe(1);
    let signal: AbortSignal | undefined;
    deps = {
      ...deps,
      timeoutMs: 30,
      fetchImpl: (async (_u: string, init: RequestInit) => {
        signal = init.signal!;
        return new Promise((_r, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason)));
      }) as unknown as typeof fetch,
    };
    const t = Date.now();
    expect((await get('/inbox')).status).toBe(502);
    expect(Date.now() - t).toBeLessThan(1000);
    expect(signal!.aborted).toBe(true);
  });
});

describe('labels, acks and dismissals', () => {
  it('feedback: a known label on a valid id goes to the runtime', async () => {
    const r = await post('/inbox/td_cm1/feedback', { feedback: 'should_be_quiet' });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
    expect(asked[0]).toMatchObject({ method: 'POST', url: '/v1/inbox/td_cm1/feedback' });
    expect(JSON.parse(asked[0]!.body)).toEqual({ feedback: 'should_be_quiet' });
  });

  it('refuses an unknown label, a bad id or a large body before asking the runtime', async () => {
    expect((await post('/inbox/td_cm1/feedback', { feedback: 'meh' })).status).toBe(400);
    expect((await post('/inbox/td_cm1/feedback', {})).status).toBe(400);
    expect((await post('/inbox/..%2Fadmin/feedback', { feedback: 'ok' })).status).toBe(400);
    expect((await post(`/inbox/${'a'.repeat(41)}/feedback`, { feedback: 'ok' })).status).toBe(400);
    expect((await post('/escalations/es%20cm1/ack')).status).toBe(400);
    expect((await post('/inbox/td_cm1/feedback', { feedback: 'ok', pad: 'x'.repeat(5000) })).status).toBe(413);
    expect(asked).toHaveLength(0);
  });

  it('ack and dismiss go to the escalation routes', async () => {
    expect((await post('/escalations/es_cm1/ack')).status).toBe(200);
    expect((await post('/escalations/es_cm1/dismiss')).status).toBe(200);
    expect(asked.map((a) => `${a.method} ${a.url}`)).toEqual(['POST /v1/escalations/es_cm1/ack', 'POST /v1/escalations/es_cm1/dismiss']);
  });

  it("maps the runtime's refusals to short messages of the server's own", async () => {
    const cases: Array<[number, number, RegExp]> = [
      [404, 404, /no such escalation/],
      [409, 409, /cannot change now/],
      [400, 400, /refused that escalation request/],
      [401, 502, /refused the server's token/],
      [403, 502, /refused the server's token/],
      [429, 429, /busy/],
      [500, 502, /the runtime failed/],
    ];
    for (const [rt, want, msg] of cases) {
      answer = () => ({ status: rt, body: { error: 'escalation es_cm1 is dismissed; internal detail' } });
      const r = await post('/escalations/es_cm1/ack');
      expect(r.status).toBe(want);
      const text = await r.text();
      expect(text).toMatch(msg);
      expect(text).not.toContain('internal detail');
    }
  });

  it('an answer without ok:true is not taken as done', async () => {
    answer = () => ({ status: 200, body: { done: 'maybe' } });
    expect((await post('/escalations/es_cm1/ack')).status).toBe(502);
  });

  it('other methods and paths are not these routes', async () => {
    expect((await get('/inbox/td_cm1/feedback')).status).toBe(404);
    expect((await post('/inbox')).status).toBe(404);
    expect((await get('/escalations/es_cm1/ack')).status).toBe(404);
  });
});

describe('GET /runtime/health', () => {
  it('answers the checked health report', async () => {
    answer = () => ({ status: 200, body: health });
    const r = await get('/runtime/health');
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual(health);
    expect(asked[0]!.url).toBe('/v1/health/report');
  });

  it('refuses a report off the contract, and says when the runtime predates it', async () => {
    answer = () => ({ status: 200, body: { ...health, components: [{ component: 'x', status: 'fine', detail: null, at: AT }] } });
    expect((await get('/runtime/health')).status).toBe(502);
    answer = () => ({ status: 404, body: {} });
    expect((await get('/runtime/health')).status).toBe(501);
  });
});
