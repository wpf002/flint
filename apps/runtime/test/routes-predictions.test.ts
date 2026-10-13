/**
 * The runtime's prediction routes (P4 part 4) through buildApp and Fastify's
 * inject, with no database: every check here happens before one is touched
 * (the stand-in throws if it is). 401 without a token; 403 for the runtime
 * connector's token (world:read|ledger) on every route, reads included, so a
 * model can never read a forecast's numbers or a question's words, nor answer
 * one for Will; 400 on the strict contracts, with a code and field paths only;
 * turning predictions on is refused in a sentence while they are switched off
 * on this Mac. Nothing a request carried reaches the log.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { PREDICT_SAYS } from '@flint/policy';
import { buildApp } from '../src/app';
import type { RuntimeScope } from '../src/config';
import type { Db } from '../src/db';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const SERVER = 'server-token-0123456789abcdef';
const MCP = 'mcp-token-0123456789abcdef01';
const CANARY = 'CANARY-predict-words';
const KEY = 'daily.deploys.count';
const PID = 'pdabc123def456';

const tokens = [
  { name: 'server', sha256: sha(SERVER), scopes: new Set<RuntimeScope>(['events', 'audit', 'proposals', 'world:read', 'ledger', 'counters']) },
  { name: 'runtime-mcp', sha256: sha(MCP), scopes: new Set<RuntimeScope>(['world:read', 'ledger']) },
];

function harness(predict?: boolean) {
  const lines: string[] = [];
  let touched = 0;
  // Any use of the database fails the test: validation comes first.
  const db = new Proxy({}, { get: () => { touched++; throw new Error('the database was touched'); } }) as unknown as Db;
  const app = buildApp({ db, config: { tokens, tz: 'UTC', ...(predict === undefined ? {} : { predict }) }, logger: true, logStream: { write: (l: string) => void lines.push(l) } });
  const call = (method: 'GET' | 'POST', url: string, body?: unknown, token: string | null = SERVER) =>
    app.inject({
      method, url,
      ...(body !== undefined
        ? { payload: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } }
        : { headers: token ? { authorization: `Bearer ${token}` } : {} }),
    });
  return { app, call, lines, touched: () => touched };
}

const ROUTES: Array<['GET' | 'POST', string, unknown?]> = [
  ['GET', '/v1/predictions'],
  ['GET', '/v1/predictions/waiting'],
  ['GET', `/v1/predictions/series/${KEY}`],
  ['GET', '/v1/predictions/questions'],
  ['GET', '/v1/predictions/accuracy'],
  ['POST', '/v1/predictions/turn-on', { series: [KEY] }],
  ['POST', `/v1/predictions/series/${KEY}/turn-off`, {}],
  ['POST', `/v1/predictions/questions/${PID}/answer`, { answer: 'yes' }],
];

describe('the prediction routes, before the database', () => {
  it('401 without a token, 403 for the runtime connector on every route (reads included)', async () => {
    const h = harness(true);
    for (const [method, url, body] of ROUTES) {
      expect((await h.call(method, url, body, null)).statusCode, `${method} ${url}`).toBe(401);
      expect((await h.call(method, url, body, 'not-a-token-at-all-0123')).statusCode, `${method} ${url}`).toBe(401);
      const r = await h.call(method, url, body, MCP);
      expect(r.statusCode, `${method} ${url}`).toBe(403);
      expect(r.body).not.toContain(KEY);
    }
    expect(h.touched()).toBe(0);
    await h.app.close();
  });

  it('400 on the strict contracts, with a code and never a value; nothing reaches the database', async () => {
    const h = harness(true);
    const bad: Array<['GET' | 'POST', string, unknown]> = [
      ['GET', '/v1/predictions?tab=forecasts', undefined],
      ['GET', '/v1/predictions/waiting?since=1', undefined],
      ['GET', '/v1/predictions/questions?limit=500', undefined],
      ['GET', '/v1/predictions/accuracy?domain=spend', undefined],
      ['GET', `/v1/predictions/series/${KEY}?values=1`, undefined],
      ['GET', '/v1/predictions/series/Daily%20Deploys', undefined],
      ['GET', `/v1/predictions/series/${'a.'.repeat(45)}b`, undefined],
      ['POST', '/v1/predictions/turn-on', {}],
      ['POST', '/v1/predictions/turn-on', { series: [] }],
      ['POST', '/v1/predictions/turn-on', { series: [CANARY] }],
      ['POST', '/v1/predictions/turn-on', { series: [KEY], reason: [KEY] }],
      ['POST', '/v1/predictions/turn-on', { series: [KEY], note: CANARY }],
      ['POST', '/v1/predictions/turn-on', { series: Array.from({ length: 41 }, (_, i) => `daily.x${i}.count`) }],
      ['POST', `/v1/predictions/series/${KEY}/turn-off`, { on: false }],
      ['POST', `/v1/predictions/series/${KEY}/turn-off`, { why: CANARY }],
      ['POST', '/v1/predictions/series/NOPE/turn-off', {}],
      ['POST', `/v1/predictions/questions/${PID}/answer`, {}],
      ['POST', `/v1/predictions/questions/${PID}/answer`, { answer: 'maybe' }],
      ['POST', `/v1/predictions/questions/${PID}/answer`, { answer: true }],
      // An answer is a word. It can't carry a result, who resolved it, or when.
      ['POST', `/v1/predictions/questions/${PID}/answer`, { answer: 'yes', outcome: true }],
      ['POST', `/v1/predictions/questions/${PID}/answer`, { answer: 'yes', resolvedBy: 'will' }],
      ['POST', `/v1/predictions/questions/${PID}/answer`, { answer: 'no', eventAt: '2026-10-01T00:00:00.000Z' }],
      ['POST', `/v1/predictions/questions/${PID}/answer`, { answer: 'yes', note: CANARY }],
      ['POST', '/v1/predictions/questions/pd%20abc/answer', { answer: 'yes' }],
      ['POST', `/v1/predictions/questions/${'p'.repeat(41)}/answer`, { answer: 'yes' }],
    ];
    for (const [method, url, body] of bad) {
      const r = await h.call(method, url, body);
      expect(r.statusCode, `${method} ${url} ${JSON.stringify(body)?.slice(0, 80)}`).toBe(400);
      expect(r.body).not.toContain(CANARY);
      const answer = JSON.parse(r.body) as { error: string; code: string; ref: string };
      expect(answer, url).toMatchObject({ error: PREDICT_SAYS.request, code: 'request' });
      expect(answer.ref).toMatch(/^ref[a-z0-9]+$/);
    }
    expect(h.touched()).toBe(0);
    // What was refused is logged by field path and code, never by what was sent.
    const log = h.lines.join('\n');
    expect(log).toContain('predictions route refused');
    expect(log).toMatch(/"why":"series\.0: invalid_string"/);
    expect(log).not.toContain(CANARY);
    await h.app.close();
  });

  it('turning predictions on is refused in a sentence while they are switched off on this Mac (the default), before the database', async () => {
    for (const predict of [undefined, false]) {
      const h = harness(predict);
      const r = await h.call('POST', '/v1/predictions/turn-on', { series: [KEY] });
      expect(r.statusCode).toBe(409);
      expect(JSON.parse(r.body)).toEqual({ error: 'Predictions are switched off on this Mac.', code: 'offHere' });
      expect(h.touched()).toBe(0);
      await h.app.close();
    }
  });

  it('a number outside the registry is not a number: 404 with the sentence, before the database', async () => {
    const h = harness(true);
    for (const [method, url, body] of [['GET', '/v1/predictions/series/daily.made_up.count', undefined], ['POST', '/v1/predictions/series/daily.made_up.count/turn-off', {}]] as const) {
      const r = await h.call(method, url, body);
      expect(r.statusCode, url).toBe(404);
      expect(JSON.parse(r.body), url).toEqual({ error: 'That number can’t be forecast.', code: 'unknown' });
    }
    expect(h.touched()).toBe(0);
    await h.app.close();
  });

  it('no other method and no other path is a predictions route', async () => {
    const h = harness(true);
    for (const [method, url] of [['POST', '/v1/predictions'], ['GET', '/v1/predictions/turn-on'], ['GET', `/v1/predictions/questions/${PID}/answer`], ['POST', '/v1/predictions/accuracy'], ['POST', `/v1/predictions/series/${KEY}`], ['POST', `/v1/predictions/questions/${PID}/resolve`], ['POST', '/v1/predictions/turn-off']] as const) {
      expect((await h.call(method, url, method === 'POST' ? {} : undefined)).statusCode, `${method} ${url}`).toBe(404);
    }
    expect(h.touched()).toBe(0);
    await h.app.close();
  });
});
