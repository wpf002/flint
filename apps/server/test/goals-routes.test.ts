/**
 * The goals routes (Machine plan P3 part 2), end to end over HTTP against a
 * stand-in runtime: the console's requests are checked with the shared
 * contracts before the runtime sees them; the runtime's answers are checked
 * before the console does (a malformed one is a 502, logged by field paths only);
 * a runtime 401/403 is a 502, a 404 on the list a 501, a runtime that is down a
 * 503 with a sentence, and a write it did not answer in time a 504 that does not
 * claim nothing changed; a refusal passes through only as a code from the closed
 * set, with its fixed sentence; nothing is ever spooled to disk; a goal at the
 * contract's full size fits in any script; the search text travels in a POST
 * body, never a URL; and no goal text reaches a log line.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { goalsRoutes, GOALS_SAY, type GoalsDeps } from '../src/goals-routes';
import { routeOf } from '../src/runtime-events';

const TOKEN = 'd'.repeat(64);
const CANARY = 'CANARY-goal-text';
const DK = 'k7Hq2LmN9pQr3sTv';
const GID = `go${DK}`;
const AT = '2026-10-09T15:00:00.000Z';

const row = (over: Record<string, unknown> = {}) => ({
  id: GID, title: `${CANARY} title`, status: 'active', origin: 'will', checks: { met: 1, total: 2, unknown: 0 }, horizonAt: null, reviewCadence: 'P1W',
  endedAt: null, waiting: 0, late: false, tainted: false, ...over,
});
const view = (over: Record<string, unknown> = {}) => ({
  id: GID, title: `${CANARY} title`, description: '', status: 'active', owner: 'will', origin: 'will', sensitivity: 'personal', tainted: false, nexusProjectId: null,
  successCriteria: [{ id: 'c1', text: `${CANARY} check`, check: { kind: 'manual' } }], criteria: [{ id: 'c1', state: 'unmet' }], checks: { met: 0, total: 1, unknown: 0 },
  horizonAt: null, reviewCadence: 'P1W', activatedAt: AT, endedAt: null, links: [], plan: null, waiting: [], reviews: 'off', late: false, ...over,
});
const args = (over: Record<string, unknown> = {}) => ({
  goalId: GID, owner: 'will', origin: 'will', sensitivity: 'personal', tainted: false, nexusProjectId: null, title: `${CANARY} title`, description: '',
  successCriteria: [{ id: 'c1', text: `${CANARY} check`, check: { kind: 'manual' } }], horizonAt: null, reviewCadence: 'P1W', links: [], plan: null, ...over,
});

let asked: Array<{ method: string; url: string; auth: string | undefined; body: string }>;
let answer: (req: { method: string; url: string; body: string }) => { status: number; body: unknown };
let runtime: Server;
let rtUrl: string;
/** A port nothing listens on: a runtime that is down. */
let downUrl: string;
let server: Server;
let base: string;
let logged: string[];
let deps: GoalsDeps;
let up: boolean;
/** How long the stand-in runtime waits before it answers. */
let delayMs: number;
/** The stand-in runtime reads the request, then drops the connection without answering. */
let drop: boolean;

beforeAll(async () => {
  runtime = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      asked.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, body });
      if (drop) return void req.socket.destroy();
      const a = answer({ method: req.method!, url: req.url!, body });
      setTimeout(() => {
        res.writeHead(a.status, { 'content-type': 'application/json' });
        res.end(typeof a.body === 'string' ? a.body : JSON.stringify(a.body));
      }, delayMs);
    });
  });
  await new Promise<void>((r) => runtime.listen(0, '::1', r));
  rtUrl = `http://[::1]:${(runtime.address() as AddressInfo).port}`;
  const closed = createServer();
  await new Promise<void>((r) => closed.listen(0, '::1', r));
  downUrl = `http://[::1]:${(closed.address() as AddressInfo).port}`;
  await new Promise<void>((r) => closed.close(() => r()));
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void goalsRoutes(req, res, req.url ?? '/', deps).then((handled) => {
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
  logged = [];
  up = true;
  delayMs = 0;
  drop = false;
  answer = () => ({ status: 200, body: { ok: true } });
  // The server's errorRef logs what it is given: here, a record of it.
  deps = { runtime: () => (up ? { url: rtUrl, token: TOKEN } : { url: downUrl, token: TOKEN }), errorRef: (_t, err) => (logged.push(String(err)), 'ref123'), timeoutMs: 2000 };
});

const get = async (p: string) => {
  const r = await fetch(`${base}${p}`);
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};
const post = async (p: string, body?: unknown) => {
  const r = await fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body ?? {}) });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};

describe('reads', () => {
  it('a tab is passed through, validated, and its answer checked', async () => {
    answer = () => ({ status: 200, body: { tab: 'finished', goals: [row({ status: 'done', endedAt: AT })], waiting: [], reviews: 'off' } });
    const r = await get('/goals?tab=finished');
    expect(r).toEqual({ status: 200, body: { tab: 'finished', goals: [row({ status: 'done', endedAt: AT })], waiting: [], reviews: 'off' } });
    expect(asked).toEqual([{ method: 'GET', url: '/v1/goals?tab=finished', auth: `Bearer ${TOKEN}`, body: '' }]);
    answer = () => ({ status: 200, body: { goal: view() } });
    expect((await get(`/goals/${GID}`)).body).toEqual({ goal: view() });
    expect(asked.at(-1)!.url).toBe(`/v1/goals/${GID}`);
  });

  it('bad input never reaches the runtime', async () => {
    for (const p of ['/goals?tab=all', '/goals?tab=active&x=1', '/goals/not-a-goal', '/goals/go1', `/goals/${GID}?x=1`]) {
      expect((await get(p)).status, p).toBe(400);
    }
    expect(asked).toEqual([]);
  });

  it('runtime 401/403 is a 502, a 404 on the list a 501 (an older runtime), down a 503 with a sentence, no runtime at all a 501', async () => {
    for (const s of [401, 403]) {
      answer = () => ({ status: s, body: { error: 'unauthorized' } });
      expect(await get('/goals')).toEqual({ status: 502, body: { error: GOALS_SAY.token } });
    }
    answer = () => ({ status: 404, body: { error: 'Route GET:/v1/goals not found' } });
    expect(await get('/goals')).toEqual({ status: 501, body: { error: 'This needs a newer runtime.' } });
    // One goal gone is a 404 with its code; a runtime without the route, a 501.
    answer = () => ({ status: 404, body: { error: 'This goal no longer exists.', code: 'noGoal' } });
    expect(await get(`/goals/${GID}`)).toEqual({ status: 404, body: { error: 'This goal no longer exists.', code: 'noGoal' } });
    up = false;
    expect(await get('/goals')).toEqual({ status: 503, body: { error: 'The runtime isn’t answering, so goals can’t load.' } });
    expect(await post(`/goals/${GID}/pause`)).toEqual({ status: 503, body: { error: 'The runtime isn’t answering, so nothing changed.' } });
    deps = { ...deps, runtime: () => undefined };
    expect(await get('/goals')).toEqual({ status: 501, body: { error: 'Goals need the runtime.' } });
    expect((await post('/goals', { draftKey: DK, args: args() })).status).toBe(501);
  });

  it('a malformed answer is a 502, logged by field paths only, never a value', async () => {
    answer = () => ({ status: 200, body: { tab: 'active', goals: [row({ late: 'yes', title: `${CANARY} ${'x'.repeat(200)}` })], waiting: [], reviews: 'off' } });
    const r = await get('/goals');
    expect(r).toEqual({ status: 502, body: { error: 'The runtime sent an answer Flint can’t read.', ref: 'ref123' } });
    expect(logged.join('\n')).toMatch(/goals\.0\.(late|title)/);
    expect(logged.join('\n')).not.toContain(CANARY);
  });
});

describe('writes', () => {
  it('a new goal’s card is checked here, then filed with the runtime straight away; nothing is ever spooled', async () => {
    answer = () => ({ status: 200, body: { id: 'pr1', deduped: false } });
    expect(await post('/goals', { draftKey: DK, args: args() })).toEqual({ status: 200, body: { id: 'pr1', deduped: false } });
    expect(asked).toHaveLength(1);
    expect(asked[0]!.url).toBe('/v1/goals');
    expect(JSON.parse(asked[0]!.body)).toEqual({ draftKey: DK, args: args() });
    // Refused before the runtime: not Will's own, an id not from its draft, unknown keys, a title over 120.
    for (const bad of [
      { draftKey: DK, args: args({ origin: 'flint' }) },
      { draftKey: DK, args: args({ goalId: 'goSomethingElse01' }) },
      { draftKey: DK, args: args(), extra: 1 },
      { draftKey: DK, args: args({ title: 'x'.repeat(121) }) },
      { draftKey: DK, args: args({ reviewCadence: 'P9D' }) },
    ]) {
      expect(await post('/goals', bad)).toEqual({ status: 400, body: { error: GOALS_SAY.invalid } });
    }
    expect(asked).toHaveLength(1);
    // Down: a 503, and nothing kept to send later.
    up = false;
    expect(await post('/goals', { draftKey: DK, args: args() })).toEqual({ status: 503, body: { error: 'The runtime isn’t answering, so nothing changed.' } });
    expect(logged.join('\n')).not.toContain(CANARY);
    // The proxy never touches the proposal spool (RuntimeProposals.propose writes a card's args to disk) or any file.
    const src = readFileSync(join(__dirname, '..', 'src', 'goals-routes.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(src).not.toMatch(/RuntimeProposals|\.propose\(|runtime-proposals|appendFile|writeFile|node:fs/);
  });

  it('each card route takes only its card’s args, naming its own goal', async () => {
    answer = () => ({ status: 200, body: { id: 'pr2', deduped: true } });
    expect((await post(`/goals/${GID}/done`, { args: { goalId: GID, goalTitle: 'T' } })).body).toEqual({ id: 'pr2', deduped: true });
    expect((await post(`/goals/${GID}/timing`, { args: { goalId: GID, goalTitle: 'T', horizonAt: null, reviewCadence: 'P2W', from: { horizonAt: null, reviewCadence: 'P1W' } } })).status).toBe(200);
    const def = { title: 'T', description: '', successCriteria: [{ id: 'c1', text: 'x', check: { kind: 'manual' } }], links: [] };
    expect((await post(`/goals/${GID}/edit`, { args: { goalId: GID, ...def, title: 'T2', from: def } })).status).toBe(200);
    expect((await post(`/goals/${GID}/plan`, { args: { goalId: GID, goalTitle: 'T', ops: [{ op: 'add', key: 's3', step: { ordinal: 300, title: 'S', kind: 'will_task', tier: 'approval', dueAt: null, dependsOn: [] } }] } })).status).toBe(200);
    expect((await post(`/goals/${GID}/resume`, { args: args() })).status).toBe(200);
    expect(asked.map((a) => a.url)).toEqual([`/v1/goals/${GID}/done`, `/v1/goals/${GID}/timing`, `/v1/goals/${GID}/edit`, `/v1/goals/${GID}/plan`, `/v1/goals/${GID}/resume`]);
    // What a change changes from goes to the runtime with it.
    expect(JSON.parse(asked[1]!.body)).toEqual({ args: { goalId: GID, goalTitle: 'T', horizonAt: null, reviewCadence: 'P2W', from: { horizonAt: null, reviewCadence: 'P1W' } } });
    asked = [];
    for (const [p, b] of [
      [`/goals/${GID}/done`, { args: { goalId: 'goSomeOtherGoal01', goalTitle: 'T' } }],
      [`/goals/${GID}/done`, { args: { goalId: GID } }],
      // A change to what counts as done, or to the timing, says what it changes from.
      [`/goals/${GID}/timing`, { args: { goalId: GID, goalTitle: 'T', horizonAt: null, reviewCadence: 'P2W' } }],
      [`/goals/${GID}/edit`, { args: { goalId: GID, title: 'T2', description: '', successCriteria: [{ id: 'c1', text: 'x', check: { kind: 'manual' } }], links: [] } }],
      [`/goals/${GID}/abandon`, { args: { goalId: GID, goalTitle: 'T', more: 1 } }],
      [`/goals/${GID}/resume`, { args: args({ plan: { ops: [{ op: 'add', key: 's1', step: { ordinal: 1, title: 'S', kind: 'will_task' } }] }, successCriteria: [{ id: 'c1', text: 'x', check: { kind: 'steps', keys: ['s1'] } }] }) }],
      [`/goals/${GID}/pause`, { why: CANARY }],
      [`/goals/${GID}/criteria/c11`, { met: true }],
      [`/goals/${GID}/criteria/c1`, { met: 1 }],
      [`/goals/${GID}/steps/s1`, { status: 'skipped' }],
      [`/goals/${GID}/steps/one`, { status: 'done' }],
      ['/goals/linkable', { q: 'x'.repeat(81) }],
    ] as const) {
      expect((await post(p, b)).status, p).toBe(400);
    }
    expect(asked).toEqual([]);
    expect((await post(`/goals/${GID}/explode`, {})).status).toBe(404);
  });

  it('a refusal passes through only as a code in the closed set, with its fixed sentence; anything else is the server’s own words', async () => {
    answer = () => ({ status: 409, body: { error: 'The goal changed since you looked. Reload it and try again.', code: 'looked' } });
    expect(await post(`/goals/${GID}/done`, { args: { goalId: GID, goalTitle: 'T' } })).toEqual({ status: 409, body: { error: 'The goal changed since you looked. Reload it and try again.', code: 'looked' } });
    answer = () => ({ status: 409, body: { error: 'This goal is paused.', code: 'status.paused' } });
    expect((await post(`/goals/${GID}/pause`)).body).toEqual({ error: 'This goal is paused.', code: 'status.paused' });
    // A code outside the set, or none: the runtime's words never pass.
    answer = () => ({ status: 409, body: { error: `forbidden: ${CANARY}`, code: 'forbidden' } });
    expect((await post(`/goals/${GID}/done`, { args: { goalId: GID, goalTitle: 'T' } })).body).toEqual({ error: GOALS_SAY.stuck });
    answer = () => ({ status: 400, body: { error: `${CANARY} words` } });
    expect((await post(`/goals/${GID}/criteria/c1`, { met: true })).body).toEqual({ error: GOALS_SAY.refused });
    // Even a known code cannot carry the runtime's own sentence: the server writes it.
    answer = () => ({ status: 400, body: { error: CANARY, code: 'notManual' } });
    expect((await post(`/goals/${GID}/criteria/c1`, { met: true })).body).toEqual({ error: 'Flint checks this one itself.', code: 'notManual' });
    answer = () => ({ status: 500, body: { error: 'internal error', ref: 'err1' } });
    expect(await post(`/goals/${GID}/steps/s1`, { status: 'done' })).toEqual({ status: 502, body: { error: GOALS_SAY.failed, ref: 'ref123' } });
    expect(logged.join('\n')).not.toContain(CANARY);
  });

  it('the item search is a POST: the words travel in its body, never a URL', async () => {
    answer = () => ({ status: 200, body: { items: [{ entityId: 'en1', kind: 'pull_request', label: 'wpf002/flint #57', status: 'active', title: 'Outside words', conditions: [{ key: 'state', value: 'merged' }] }] } });
    const r = await post('/goals/linkable', { q: `${CANARY} search` });
    expect(r.status).toBe(200);
    expect(asked).toEqual([{ method: 'POST', url: '/v1/goals/linkable', auth: `Bearer ${TOKEN}`, body: JSON.stringify({ q: `${CANARY} search` }) }]);
    expect((await get(`/goals/linkable?q=${CANARY}`)).status).toBe(400);
    expect(asked).toHaveLength(1);
  });

  it('a goal at the contract’s full size fits, in any script; a body over 64 KB is a 413 before anything else', async () => {
    // Every field at its longest, in three-byte characters: over 16 KB of JSON, well under 64 KB.
    const w = (n: number) => '界'.repeat(n);
    const full = args({
      title: w(120), description: w(1000),
      successCriteria: Array.from({ length: 10 }, (_, i) => ({ id: `c${i + 1}`, text: w(200), check: { kind: 'manual' } })),
      plan: { ops: Array.from({ length: 10 }, (_, i) => ({ op: 'add', key: `s${i + 1}`, step: { ordinal: (i + 1) * 100, title: w(200), kind: 'will_task', tier: 'approval', dueAt: null, dependsOn: [] } })) },
    });
    expect(Buffer.byteLength(JSON.stringify({ draftKey: DK, args: full }))).toBeGreaterThan(16 * 1024);
    answer = () => ({ status: 200, body: { id: 'pr1', deduped: false } });
    expect((await post('/goals', { draftKey: DK, args: full })).status).toBe(200);
    expect(asked).toHaveLength(1);
    asked = [];
    expect(await post('/goals', `{"draftKey":"${DK}","pad":"${'x'.repeat(70_000)}"}`)).toEqual({ status: 413, body: { error: GOALS_SAY.tooLarge } });
    expect(asked).toEqual([]);
  });

  it('a write the runtime does not answer in time is not called unchanged: Flint says it isn’t sure; a read just did not load', async () => {
    deps = { ...deps, timeoutMs: 150 };
    delayMs = 600;
    answer = () => ({ status: 200, body: { ok: true } });
    expect(await post(`/goals/${GID}/steps/s1`, { status: 'done' })).toEqual({ status: 504, body: { error: 'Flint isn’t sure it went through. Check the goal before trying again.' } });
    expect(await post('/goals', { draftKey: DK, args: args() })).toEqual({ status: 504, body: { error: GOALS_SAY.unsure } });
    expect(await get('/goals')).toEqual({ status: 503, body: { error: GOALS_SAY.down } });
    // The runtime did get each one: it may well have landed.
    expect(asked).toHaveLength(3);
    await new Promise((r) => setTimeout(r, 700));
  });

  it('a connection that drops after the runtime has the request is the same: only a runtime that was never reached got nothing', async () => {
    drop = true;
    expect(await post(`/goals/${GID}/criteria/c1`, { met: true })).toEqual({ status: 504, body: { error: GOALS_SAY.unsure } });
    expect(await post(`/goals/${GID}/done`, { args: { goalId: GID, goalTitle: 'T' } })).toEqual({ status: 504, body: { error: GOALS_SAY.unsure } });
    expect(await get('/goals')).toEqual({ status: 503, body: { error: GOALS_SAY.down } });
    expect(asked).toHaveLength(3);
    // Nothing listening at all: the request never left, so nothing changed.
    up = false;
    expect(await post(`/goals/${GID}/criteria/c1`, { met: true })).toEqual({ status: 503, body: { error: GOALS_SAY.downWrite } });
  });

  it('a goals route is never reported back to the runtime as a route.error', () => {
    for (const p of ['/goals', '/goals?tab=active', `/goals/${GID}`, `/goals/${GID}/done`, '/goals/linkable']) expect(routeOf(p), p).toBeUndefined();
    expect(routeOf('/goalsx')).toBe('other');
  });
});
