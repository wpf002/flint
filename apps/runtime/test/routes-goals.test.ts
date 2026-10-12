/**
 * The runtime's goal routes (P3 part 2) through buildApp and Fastify's inject,
 * with no database: every check here happens before one is touched (the stand-in
 * throws if it is). 401 without a token; 403 for the runtime connector's token
 * (world:read|ledger), on every route, reads included, so a model can never read
 * a goal's words; 400 on the strict contracts (unknown keys, a title over 120, a
 * bad cadence, a bad draft key, a goal id that is not the draft's, a goal that is
 * not Will's own), with a code and field paths only; 413 over 64 KB; bad ids and
 * step keys refused. Nothing a request carried reaches the log.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { buildApp } from '../src/app';
import type { RuntimeScope } from '../src/config';
import type { Db } from '../src/db';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const SERVER = 'server-token-0123456789abcdef';
const MCP = 'mcp-token-0123456789abcdef01';
const CANARY = 'CANARY-goal-words';
const DRAFT = 'k7Hq2LmN9pQr3sTv';
const GOAL = `go${DRAFT}`;

const tokens = [
  { name: 'server', sha256: sha(SERVER), scopes: new Set<RuntimeScope>(['events', 'audit', 'proposals', 'world:read', 'ledger', 'counters']) },
  { name: 'runtime-mcp', sha256: sha(MCP), scopes: new Set<RuntimeScope>(['world:read', 'ledger']) },
];

function harness() {
  const lines: string[] = [];
  let touched = 0;
  // Any use of the database fails the test: validation comes first.
  const db = new Proxy({}, { get: () => { touched++; throw new Error('the database was touched'); } }) as unknown as Db;
  const app = buildApp({ db, config: { tokens, tz: 'UTC' }, logger: true, logStream: { write: (l: string) => void lines.push(l) } });
  const call = (method: 'GET' | 'POST', url: string, body?: unknown, token: string | null = SERVER) =>
    app.inject({
      method, url,
      ...(body !== undefined ? { payload: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } } : { headers: token ? { authorization: `Bearer ${token}` } : {} }),
    });
  return { app, call, lines, touched: () => touched };
}

const args = (over: Record<string, unknown> = {}) => ({
  goalId: GOAL, owner: 'will', origin: 'will', sensitivity: 'personal', tainted: false, nexusProjectId: null,
  title: `${CANARY} title`, description: '', successCriteria: [{ id: 'c1', text: `${CANARY} check`, check: { kind: 'manual' } }],
  horizonAt: null, reviewCadence: 'P1W', links: [], plan: null, ...over,
});

const ROUTES: Array<['GET' | 'POST', string, unknown?]> = [
  ['GET', '/v1/goals?tab=active'],
  ['GET', `/v1/goals/${GOAL}`],
  ['POST', '/v1/goals', { draftKey: DRAFT, args: args() }],
  ['POST', '/v1/goals/linkable', { q: 'flint' }],
  ['POST', `/v1/goals/${GOAL}/done`, { args: { goalId: GOAL, goalTitle: 'x' } }],
  ['POST', `/v1/goals/${GOAL}/pause`, {}],
  ['POST', `/v1/goals/${GOAL}/criteria/c1`, { met: true }],
  ['POST', `/v1/goals/${GOAL}/steps/s1`, { status: 'done' }],
];

describe('the goal routes, before the database', () => {
  it('401 without a token, 403 for the runtime connector on every route (reads included)', async () => {
    const h = harness();
    for (const [method, url, body] of ROUTES) {
      expect((await h.call(method, url, body, null)).statusCode, `${method} ${url}`).toBe(401);
      expect((await h.call(method, url, body, 'not-a-token-at-all-0123')).statusCode, `${method} ${url}`).toBe(401);
      const r = await h.call(method, url, body, MCP);
      expect(r.statusCode, `${method} ${url}`).toBe(403);
      expect(r.body).not.toContain(CANARY);
    }
    expect(h.touched()).toBe(0);
    await h.app.close();
  });

  it('400 on the strict contracts, with a code and never a value; nothing reaches the database', async () => {
    const h = harness();
    const bad: Array<[string, string, unknown]> = [
      ['GET', '/v1/goals?tab=everything', undefined],
      ['GET', '/v1/goals?tab=active&extra=1', undefined],
      ['POST', '/v1/goals', { draftKey: DRAFT, args: args(), extra: 1 }],
      ['POST', '/v1/goals', { draftKey: DRAFT, args: args({ extra: 1 }) }],
      ['POST', '/v1/goals', { draftKey: DRAFT, args: args({ title: 'x'.repeat(121) }) }],
      ['POST', '/v1/goals', { draftKey: DRAFT, args: args({ reviewCadence: 'P2D' }) }],
      ['POST', '/v1/goals', { draftKey: 'short', args: args({ goalId: 'goshort' }) }],
      ['POST', '/v1/goals', { draftKey: 'has-a-dash-0123456', args: args() }],
      // The goal's id is made from the draft key; a goal Will adds is his own, untainted, with no Nexus project.
      ['POST', '/v1/goals', { draftKey: DRAFT, args: args({ goalId: 'goSomethingElse01' }) }],
      ['POST', '/v1/goals', { draftKey: DRAFT, args: args({ origin: 'flint' }) }],
      ['POST', '/v1/goals', { draftKey: DRAFT, args: args({ owner: 'flint' }) }],
      ['POST', '/v1/goals', { draftKey: DRAFT, args: args({ tainted: true }) }],
      ['POST', '/v1/goals', { draftKey: DRAFT, args: args({ nexusProjectId: 'p1' }) }],
      ['POST', '/v1/goals', { draftKey: DRAFT, args: args({ sensitivity: 'ops' }) }],
      ['POST', '/v1/goals/linkable', { q: 'x'.repeat(81) }],
      ['POST', '/v1/goals/linkable', { q: 'flint', more: true }],
      ['POST', `/v1/goals/${GOAL}/done`, { args: { goalId: GOAL } }],
      ['POST', `/v1/goals/${GOAL}/done`, { args: { goalId: GOAL, goalTitle: CANARY }, extra: 1 }],
      ['POST', `/v1/goals/${GOAL}/timing`, { args: { goalId: GOAL, goalTitle: CANARY, horizonAt: null, reviewCadence: 'P5Y' } }],
      // A change to what counts as done, or to the timing, says what it changes from.
      ['POST', `/v1/goals/${GOAL}/timing`, { args: { goalId: GOAL, goalTitle: CANARY, horizonAt: null, reviewCadence: 'P2W' } }],
      ['POST', `/v1/goals/${GOAL}/timing`, { args: { goalId: GOAL, goalTitle: CANARY, horizonAt: null, reviewCadence: 'P2W', from: { horizonAt: null } } }],
      ['POST', `/v1/goals/${GOAL}/edit`, { args: { goalId: GOAL, title: CANARY, description: '', successCriteria: [{ id: 'c1', text: CANARY, check: { kind: 'manual' } }], links: [] } }],
      ['POST', `/v1/goals/${GOAL}/resume`, { args: args({ plan: { ops: [{ op: 'add', key: 's1', step: { ordinal: 100, title: CANARY, kind: 'will_task' } }] } }) }],
      ['POST', `/v1/goals/${GOAL}/plan`, { args: { goalId: GOAL, goalTitle: CANARY, ops: [] } }],
      ['POST', `/v1/goals/${GOAL}/pause`, { why: CANARY }],
      ['POST', `/v1/goals/${GOAL}/criteria/c1`, { met: 'yes' }],
      ['POST', `/v1/goals/${GOAL}/steps/s1`, { status: 'skipped' }],
      ['POST', `/v1/goals/${GOAL}/steps/s1`, { status: 'done', note: CANARY }],
    ];
    for (const [method, url, body] of bad) {
      const r = await h.call(method as 'GET' | 'POST', url, body);
      expect(r.statusCode, `${method} ${url} ${JSON.stringify(body)?.slice(0, 80)}`).toBe(400);
      expect(r.body).not.toContain(CANARY);
      if (method === 'POST') expect(JSON.parse(r.body), url).toMatchObject({ error: 'This goal card isn’t valid.', code: 'invalid' });
    }
    expect(h.touched()).toBe(0);
    expect(h.lines.join('\n')).not.toContain(CANARY);
    await h.app.close();
  });

  it('bad ids, verbs, check ids and step keys are refused', async () => {
    const h = harness();
    for (const url of [
      '/v1/goals/not-a-goal/done', '/v1/goals/go1/done', `/v1/goals/${GOAL}/explode`, `/v1/goals/${GOAL}/criteria/c11`, `/v1/goals/${GOAL}/criteria/x1`,
      `/v1/goals/${GOAL}/steps/s1000`, `/v1/goals/${GOAL}/steps/step1`, `/v1/goals/${GOAL}/steps/s1;drop`,
    ]) {
      const r = await h.call('POST', url, { met: true });
      expect([400, 404], url).toContain(r.statusCode);
    }
    expect((await h.call('GET', '/v1/goals/x')).statusCode).toBe(400);
    expect(h.touched()).toBe(0);
    await h.app.close();
  });

  it('413 over 64 KB, before anything is parsed', async () => {
    const h = harness();
    const r = await h.call('POST', '/v1/goals', { draftKey: DRAFT, args: args({ description: CANARY.repeat(5000) }) });
    expect(r.statusCode).toBe(413);
    expect(h.touched()).toBe(0);
    expect(h.lines.join('\n')).not.toContain(CANARY);
    await h.app.close();
  });
});
