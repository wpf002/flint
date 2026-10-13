/**
 * The predictions routes (P4 part 4), end to end over HTTP against a stand-in
 * runtime: the console's requests are checked with the shared contracts before
 * the runtime sees them; the runtime's answers are checked before the console
 * does (a malformed one is a 502, logged by field paths only); a runtime
 * 401/403 is a 502, a 404 on the page a 501 (an older runtime: the console
 * hides its button), a runtime that is down a 503 with a sentence, and a write
 * it did not answer in time a 504 that does not claim nothing changed; a
 * refusal passes through only as a code from the closed set, with its fixed
 * sentence; nothing is spooled to disk; bodies are capped at 16 KB; no read
 * takes a query; and no number's value or question's words reach a log line.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PREDICT_SAYS } from '@flint/policy';
import { predictionsRoutes, PREDICTIONS_BODY_BYTES, PREDICTIONS_SAY, type PredictionsDeps } from '../src/predictions-routes';
import { routeOf } from '../src/runtime-events';
import { scopeAllows } from '../src/access';

const TOKEN = 'd'.repeat(64);
const CANARY = 'CANARY-forecast-words';
/** A number no fixture writes anywhere but into a sentence about a series: it must never reach a log line. */
const VALUE = '$31,337.42';
const KEY = 'daily.spend.anthropic.usd';
const PID = 'pdabc123def456';

const row = (over: Record<string, unknown> = {}) => ({
  key: KEY, name: 'Anthropic Spend', about: 'This is what Flint spends with Anthropic each day.', step: 'day', on: true, state: 'range', value: `About ${VALUE}`,
  says: `Flint expects about ${VALUE}, with an 80% range of $2.00 to $6.00.`, ...over,
});
const page = (over: Record<string, unknown> = {}) => ({ state: 'on', numbers: [row()], waiting: [], questions: 1, announce: false, secondOpinion: false, ...over });
const fact = { label: 'Today', value: `About ${VALUE}`, says: 'The 80% range is $2.00 to $6.00.' };
const seriesView = (over: Record<string, unknown> = {}) => ({
  number: row(), forecast: [fact], chance: { label: 'Above $3.00', value: 'Likely · 70%', says: 'It’s likely, around 70%, that today runs above $3.00.' }, opinion: null, record: '22 of its last 27 ranges held.', waiting: false, offHere: false, ...over,
});
const question = (over: Record<string, unknown> = {}) => ({ id: PID, title: `${CANARY} lands by Friday`, says: 'Flint said likely, around 70%, on Oct 3. It was due Oct 5 at 3:00 PM.', answer: null, answerable: true, ...over });
const accuracy = { scored: true, scoring: 'on', areas: [{ name: 'Spend', value: '41 Scored', lines: ['When Flint said about 70%, it happened 64% of the time, over 41 predictions.'] }], unsettled: ['3 predictions ran out before they could be checked.'] };

let asked: Array<{ method: string; url: string; auth: string | undefined; body: string }>;
let answer: (req: { method: string; url: string; body: string }) => { status: number; body: unknown };
let runtime: Server;
let rtUrl: string;
/** A port nothing listens on: a runtime that is down. */
let downUrl: string;
let server: Server;
let base: string;
let logged: string[];
/** What errorRef was handed, as it was handed. */
let given: unknown[];
let deps: PredictionsDeps;
let up: boolean;
let delayMs: number;
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
    void predictionsRoutes(req, res, req.url ?? '/', deps).then((handled) => {
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
  given = [];
  up = true;
  delayMs = 0;
  drop = false;
  answer = () => ({ status: 200, body: { ok: true } });
  deps = { runtime: () => (up ? { url: rtUrl, token: TOKEN } : { url: downUrl, token: TOKEN }), errorRef: (_t, err) => (given.push(err), logged.push(String(err)), 'ref123'), timeoutMs: 2000 };
});

/** How many of the proxy's own answers these helpers have seen, and checked for `no-store`. */
let answersSeen = 0;
/** Every answer the proxy gives, whatever its status, says it is not to be kept (the harness's own 404 is not the proxy's). */
const unkept = (r: Response, body: Record<string, unknown>) => {
  if (r.status === 404 && body.error === 'not found') return;
  expect(r.headers.get('cache-control'), `${r.status} ${r.url}`).toBe('no-store');
  answersSeen += 1;
};
const get = async (p: string) => {
  const r = await fetch(`${base}${p}`);
  const body = (await r.json()) as Record<string, unknown>;
  unkept(r, body);
  return { status: r.status, body };
};
const post = async (p: string, body?: unknown) => {
  const r = await fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body ?? {}) });
  const answer = (await r.json()) as Record<string, unknown>;
  unkept(r, answer);
  return { status: r.status, body: answer };
};

describe('reads', () => {
  it('what the console asks on load is two facts, and nothing of a number: an answer that carries more never reaches it', async () => {
    answer = () => ({ status: 200, body: { questions: 2, announce: true } });
    expect(await get('/predictions/waiting')).toEqual({ status: 200, body: { questions: 2, announce: true } });
    expect(asked).toEqual([{ method: 'GET', url: '/v1/predictions/waiting', auth: `Bearer ${TOKEN}`, body: '' }]);
    for (const bad of [{ questions: 2, announce: true, numbers: [row()] }, { ...page() }, { questions: 2 }, { questions: '2', announce: true }]) {
      answer = () => ({ status: 200, body: bad });
      expect(await get('/predictions/waiting')).toEqual({ status: 502, body: { error: PREDICTIONS_SAY.unreadable, ref: 'ref123' } });
    }
    expect(logged.join('\n')).not.toContain(VALUE);
    expect((await get('/predictions/waiting?since=1')).status).toBe(400);
    // An older runtime has no such route: a 501, and the console leaves its button hidden.
    answer = () => ({ status: 404, body: { error: 'Route GET:/v1/predictions/waiting not found' } });
    expect(await get('/predictions/waiting')).toEqual({ status: 501, body: { error: 'This needs a newer runtime.' } });
    deps = { ...deps, runtime: () => undefined };
    expect(await get('/predictions/waiting')).toEqual({ status: 501, body: { error: 'Predictions need the runtime.' } });
  });

  it('the page, one number, the questions and the scores are passed through, each checked against its contract', async () => {
    answer = () => ({ status: 200, body: page() });
    expect(await get('/predictions')).toEqual({ status: 200, body: page() });
    expect(asked).toEqual([{ method: 'GET', url: '/v1/predictions', auth: `Bearer ${TOKEN}`, body: '' }]);
    answer = () => ({ status: 200, body: { series: seriesView() } });
    expect((await get(`/predictions/series/${KEY}`)).body).toEqual({ series: seriesView() });
    expect(asked.at(-1)!.url).toBe(`/v1/predictions/series/${KEY}`);
    const tab = { waiting: [question(), question({ id: 'pdunsaid1', title: 'Flint made this prediction in a chat.', says: 'Flint can’t show what this one was about, so it can only be skipped.', answerable: false })], answered: [question({ answer: 'yes', says: 'You said yes on Oct 12.' })], offHere: false };
    answer = () => ({ status: 200, body: tab });
    expect((await get('/predictions/questions')).body).toEqual(tab);
    expect(asked.at(-1)!.url).toBe('/v1/predictions/questions');
    answer = () => ({ status: 200, body: accuracy });
    expect((await get('/predictions/accuracy')).body).toEqual(accuracy);
    expect(asked.at(-1)!.url).toBe('/v1/predictions/accuracy');
    expect(asked.every((a) => a.method === 'GET' && a.auth === `Bearer ${TOKEN}`)).toBe(true);
  });

  it('bad input never reaches the runtime; no read takes a query, so nothing about a number rides in a URL', async () => {
    for (const p of [
      '/predictions?tab=forecasts', '/predictions/questions?limit=500', '/predictions/accuracy?area=spend', `/predictions/series/${KEY}?values=1`,
      '/predictions/series/Daily%20Spend', '/predictions/series/NOPE', `/predictions/series/${'a.'.repeat(45)}b`, '/predictions/series/daily',
    ]) {
      expect(await get(p), p).toEqual({ status: 400, body: { error: PREDICTIONS_SAY.invalid } });
    }
    expect(asked).toEqual([]);
    // What is not a predictions route is not handled here at all.
    for (const p of ['/predictions/turn-on', `/predictions/questions/${PID}/answer`, `/predictions/series/${KEY}/turn-off`, `/predictions/series/${KEY}/second-opinion-off`, '/predictions/everything', '/predictionsx']) expect((await get(p)).status, p).toBe(404);
    for (const p of ['/predictions', '/predictions/accuracy', `/predictions/series/${KEY}`, `/predictions/questions/${PID}/resolve`, '/predictions/turn-off']) expect((await post(p, {})).status, p).toBe(404);
    expect(asked).toEqual([]);
  });

  it('what does not fit the contract never reaches the console: a raw number beside the words, a state outside the set, JSON or an aside in a sentence', async () => {
    for (const bad of [
      page({ numbers: [row({ mean: 31337.42 })] }),
      page({ numbers: [row({ points: [{ mean: 4, lo: 2, hi: 6 }] })] }),
      page({ numbers: [row({ state: `${CANARY} sure` })] }),
      page({ numbers: [row({ says: `{"mean": "${VALUE}"}.` })] }),
      page({ numbers: [row({ says: `About 4 (${VALUE}).` })] }),
      page({ numbers: [row({ says: `No stop ${VALUE}` })] }),
      page({ numbers: [row({ key: 'Anthropic Spend' })] }),
      page({ state: 'maybe' }),
      page({ note: CANARY }),
      page({ questions: -1 }),
    ]) {
      answer = () => ({ status: 200, body: bad });
      expect(await get('/predictions')).toEqual({ status: 502, body: { error: 'The runtime sent an answer Flint can’t read.', ref: 'ref123' } });
    }
    // During a deploy the server is new and the runtime is not yet: its page says nothing of a second opinion, and
    // its open number has no such key. Both are read as they are (no 502), with nothing added.
    const olderPage = (({ secondOpinion: _s, ...rest }) => rest)(page());
    const olderSeries = (({ opinion: _o, ...rest }) => rest)(seriesView());
    expect(olderPage).not.toHaveProperty('secondOpinion');
    answer = () => ({ status: 200, body: olderPage });
    expect(await get('/predictions')).toEqual({ status: 200, body: olderPage });
    answer = () => ({ status: 200, body: { series: olderSeries } });
    expect(await get(`/predictions/series/${KEY}`)).toEqual({ status: 200, body: { series: olderSeries } });
    // The local model's second opinion passes as its one sentence, its switch and whether it can be turned on.
    for (const opinion of [{ on: true, says: 'The local model said about 60%.', offer: false }, { on: false, says: 'The local model doesn’t estimate this number.', offer: true }]) {
      answer = () => ({ status: 200, body: { series: seriesView({ opinion }) } });
      expect((await get(`/predictions/series/${KEY}`)).body).toEqual({ series: seriesView({ opinion }) });
    }
    // Anything else the model said (its number, its reason, its name) never reaches the console beside the sentence.
    for (const opinion of [{ on: true, says: 'The local model said about 60%.', offer: false, probability: 0.6 }, { on: true, says: 'The local model said about 60%.', offer: false, reasonCode: 'trend' }, { on: true, says: 'The local model said about 60%.', offer: false, model: 'muse-glimmer:30b' }, { on: true, offer: false }]) {
      answer = () => ({ status: 200, body: { series: seriesView({ opinion }) } });
      expect((await get(`/predictions/series/${KEY}`)).status, JSON.stringify(opinion)).toBe(502);
    }
    for (const bad of [seriesView({ values: [1, 2, 3] }), seriesView({ chance: { label: 'Above 3', value: 'Likely', says: 'It’s likely.', probability: 0.7 } }), seriesView({ record: CANARY })]) {
      answer = () => ({ status: 200, body: { series: bad } });
      expect((await get(`/predictions/series/${KEY}`)).status).toBe(502);
    }
    const { answerable: _unsaid, ...silent } = question();
    for (const bad of [
      { waiting: [question({ answer: 'maybe' })], answered: [], offHere: false }, { waiting: [question({ probability: 0.7 })], answered: [], offHere: false },
      { waiting: [question({ resolutionCriteria: CANARY })], answered: [], offHere: false }, { waiting: [question()], offHere: false },
      // Whether a question can be answered Yes or No, and whether anything can be answered here, is always said: an answer that leaves either out is not passed on.
      { waiting: [silent], answered: [], offHere: false }, { waiting: [question()], answered: [] }, { waiting: [question({ title: 'x'.repeat(301) })], answered: [], offHere: false },
    ]) {
      answer = () => ({ status: 200, body: bad });
      expect((await get('/predictions/questions')).status).toBe(502);
    }
    answer = () => ({ status: 200, body: { ...accuracy, areas: [{ ...accuracy.areas[0], brier: 0.21 }] } });
    expect((await get('/predictions/accuracy')).status).toBe(502);
    const { scoring: _s, ...unsaid } = accuracy;
    answer = () => ({ status: 200, body: unsaid });
    expect((await get('/predictions/accuracy')).status).toBe(502);
    // Each was logged by where it broke, never by what it held.
    const log = logged.join('\n');
    expect(log).toMatch(/malformed page answer \(numbers\.0/);
    expect(log).not.toContain(CANARY);
    expect(log).not.toContain(VALUE);
    expect(log).not.toContain('31337');
  });

  it('runtime 401/403 is a 502, a 404 on the page a 501 (an older runtime), down a 503 with a sentence, no runtime at all a 501', async () => {
    for (const s of [401, 403]) {
      answer = () => ({ status: s, body: { error: 'unauthorized' } });
      expect(await get('/predictions')).toEqual({ status: 502, body: { error: PREDICTIONS_SAY.token } });
    }
    answer = () => ({ status: 404, body: { error: 'Route GET:/v1/predictions not found' } });
    expect(await get('/predictions')).toEqual({ status: 501, body: { error: 'This needs a newer runtime.' } });
    // A number outside the registry is a 404 with its code.
    answer = () => ({ status: 404, body: { error: CANARY, code: 'unknown' } });
    expect(await get(`/predictions/series/${KEY}`)).toEqual({ status: 404, body: { error: 'That number can’t be forecast.', code: 'unknown' } });
    up = false;
    expect(await get('/predictions')).toEqual({ status: 503, body: { error: 'The runtime isn’t answering, so predictions can’t load.' } });
    expect(await post(`/predictions/series/${KEY}/turn-off`)).toEqual({ status: 503, body: { error: 'The runtime isn’t answering, so nothing changed.' } });
    expect(await post(`/predictions/questions/${PID}/answer`, { answer: 'yes' })).toEqual({ status: 503, body: { error: 'The runtime isn’t answering, so nothing changed.' } });
    deps = { ...deps, runtime: () => undefined };
    expect(await get('/predictions')).toEqual({ status: 501, body: { error: 'Predictions need the runtime.' } });
    expect((await post('/predictions/turn-on', { series: [KEY] })).status).toBe(501);
    expect((await get('/predictions/accuracy')).status).toBe(501);
  });

  it('what goes to the log is a sentence of the server\'s own, as a string: a status, a field path, never a value', async () => {
    answer = () => ({ status: 200, body: page({ numbers: [row({ says: 42, value: `${CANARY} ${VALUE}` })] }) });
    expect(await get('/predictions')).toEqual({ status: 502, body: { error: PREDICTIONS_SAY.unreadable, ref: 'ref123' } });
    answer = () => ({ status: 500, body: { error: 'internal error' } });
    expect(await get('/predictions/accuracy')).toEqual({ status: 502, body: { error: PREDICTIONS_SAY.failed, ref: 'ref123' } });
    await post('/predictions/turn-on', { series: [CANARY] });
    expect(given.length).toBe(3);
    for (const e of given) expect(typeof e, String(e)).toBe('string');
    expect(logged).toEqual(['malformed page answer (numbers.0.says)', 'the runtime answered 500 for a accuracy request', 'refused a turn on request (series.0)']);
    const src = readFileSync(join(__dirname, '..', 'src', 'predictions-routes.ts'), 'utf8');
    expect(src).not.toMatch(/errorRef\([^)]*new Error/);
    expect(src.match(/deps\.errorRef\('predictions', `/g)).toHaveLength(3);
    // The proxy keeps nothing and tells no one: no spool, no file, no note, no log line of its own.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).not.toMatch(/RuntimeProposals|\.propose\(|runtime-proposals|appendFile|writeFile|node:fs|console\.(log|warn|error|info)|notes\.push|notifier|actionLog/);
  });
});

describe('writes', () => {
  it('Turn On Predictions is checked here, then filed with the runtime straight away; nothing rides along with the keys', async () => {
    answer = () => ({ status: 200, body: { id: 'pr1', deduped: false } });
    expect(await post('/predictions/turn-on', { series: [KEY, 'daily.deploys.count'] })).toEqual({ status: 200, body: { id: 'pr1', deduped: false } });
    expect(asked).toEqual([{ method: 'POST', url: '/v1/predictions/turn-on', auth: `Bearer ${TOKEN}`, body: JSON.stringify({ series: [KEY, 'daily.deploys.count'] }) }]);
    for (const bad of [{}, { series: [] }, { series: ['Anthropic Spend'] }, { series: [KEY], reason: [KEY] }, { series: [KEY], note: CANARY }, { series: KEY }, { series: Array.from({ length: 41 }, (_, i) => `daily.x${i}.count`) }]) {
      expect(await post('/predictions/turn-on', bad), JSON.stringify(bad).slice(0, 60)).toEqual({ status: 400, body: { error: PREDICTIONS_SAY.invalid } });
    }
    expect((await post('/predictions/turn-on?now=1', { series: [KEY] })).status).toBe(400);
    expect(asked).toHaveLength(1);
    // With the local model's second opinion switched on: the one switch rides along, as it was sent, and nothing else.
    expect(await post('/predictions/turn-on', { series: [KEY], opinion: true })).toEqual({ status: 200, body: { id: 'pr1', deduped: false } });
    expect(asked.at(-1)).toEqual({ method: 'POST', url: '/v1/predictions/turn-on', auth: `Bearer ${TOKEN}`, body: JSON.stringify({ series: [KEY], opinion: true }) });
    expect(await post('/predictions/turn-on', { series: [KEY], opinion: false })).toEqual({ status: 200, body: { id: 'pr1', deduped: false } });
    expect(asked.at(-1)!.body).toBe(JSON.stringify({ series: [KEY], opinion: false }));
    asked = [];
    for (const bad of [{ series: [KEY], opinion: 'yes' }, { series: [KEY], opinion: 1 }, { series: [KEY], opinion: [KEY] }, { series: [KEY], opinion: true, model: 'gpt-oss:120b-cloud' }, { series: [KEY], opinion: true, reason: [KEY] }]) {
      expect(await post('/predictions/turn-on', bad), JSON.stringify(bad).slice(0, 80)).toEqual({ status: 400, body: { error: PREDICTIONS_SAY.invalid } });
    }
    expect(asked).toEqual([]);
    asked = [{ method: 'POST', url: '', auth: '', body: '' }];
    // The runtime says when the card it filed changes second opinions only (every number on it is already on):
    // that reaches the console as it was said, so the card is worded from the runtime's word and nobody else's.
    answer = () => ({ status: 200, body: { id: 'pr1', deduped: false, onlyOpinion: true } });
    expect(await post('/predictions/turn-on', { series: [KEY], opinion: true })).toEqual({ status: 200, body: { id: 'pr1', deduped: false, onlyOpinion: true } });
    // It is said only when it is so: any other value there is not this contract's answer.
    for (const not of [false, 'true', 1, null]) {
      answer = () => ({ status: 200, body: { id: 'pr1', deduped: false, onlyOpinion: not } });
      expect((await post('/predictions/turn-on', { series: [KEY], opinion: true })).status, String(not)).toBe(502);
    }
    // An answer that is not the contract's never reaches the console.
    answer = () => ({ status: 200, body: { id: 'pr1', deduped: false, args: { series: [KEY] } } });
    expect((await post('/predictions/turn-on', { series: [KEY] })).status).toBe(502);
    // Down: a 503, and nothing kept to send later.
    up = false;
    expect(await post('/predictions/turn-on', { series: [KEY] })).toEqual({ status: 503, body: { error: 'The runtime isn’t answering, so nothing changed.' } });
    expect(logged.join('\n')).not.toContain(CANARY);
  });

  it('Turn Off sends nothing but the number\'s key; an answer is yes, no or skip, and nothing else', async () => {
    expect(await post(`/predictions/series/${KEY}/turn-off`)).toEqual({ status: 200, body: { ok: true } });
    expect(asked).toEqual([{ method: 'POST', url: `/v1/predictions/series/${KEY}/turn-off`, auth: `Bearer ${TOKEN}`, body: '{}' }]);
    for (const a of ['yes', 'no', 'skip']) {
      expect(await post(`/predictions/questions/${PID}/answer`, { answer: a })).toEqual({ status: 200, body: { ok: true } });
      expect(asked.at(-1)).toEqual({ method: 'POST', url: `/v1/predictions/questions/${PID}/answer`, auth: `Bearer ${TOKEN}`, body: JSON.stringify({ answer: a }) });
    }
    // The second opinion alone: its own route, the number's key, and nothing in the body.
    expect(await post(`/predictions/series/${KEY}/second-opinion-off`)).toEqual({ status: 200, body: { ok: true } });
    expect(asked.at(-1)).toEqual({ method: 'POST', url: `/v1/predictions/series/${KEY}/second-opinion-off`, auth: `Bearer ${TOKEN}`, body: '{}' });
    expect(await post(`/predictions/series/${KEY}/second-opinion-off`, {})).toEqual({ status: 200, body: { ok: true } });
    asked = [];
    for (const [p, b] of [
      [`/predictions/series/${KEY}/second-opinion-off`, { reason: false }],
      [`/predictions/series/${KEY}/second-opinion-off`, { why: CANARY }],
      ['/predictions/series/NOPE/second-opinion-off', {}],
      [`/predictions/series/${KEY}/second-opinion-off?force=1`, {}],
      [`/predictions/series/${KEY}/turn-off`, { on: false }],
      [`/predictions/series/${KEY}/turn-off`, { why: CANARY }],
      ['/predictions/series/NOPE/turn-off', {}],
      [`/predictions/questions/${PID}/answer`, {}],
      [`/predictions/questions/${PID}/answer`, { answer: 'maybe' }],
      [`/predictions/questions/${PID}/answer`, { answer: true }],
      // An answer is a word: it carries no result, no resolver and no time of its own.
      [`/predictions/questions/${PID}/answer`, { answer: 'yes', outcome: true }],
      [`/predictions/questions/${PID}/answer`, { answer: 'yes', resolvedBy: 'will' }],
      [`/predictions/questions/${PID}/answer`, { answer: 'no', eventAt: '2026-10-01T00:00:00.000Z' }],
      [`/predictions/questions/${PID}/answer`, { answer: 'yes', note: CANARY }],
      ['/predictions/questions/pd%20abc/answer', { answer: 'yes' }],
      [`/predictions/questions/${'p'.repeat(41)}/answer`, { answer: 'yes' }],
      [`/predictions/questions/${PID}/answer?force=1`, { answer: 'yes' }],
    ] as const) {
      expect(await post(p, b), `${p} ${JSON.stringify(b)}`).toEqual({ status: 400, body: { error: PREDICTIONS_SAY.invalid } });
    }
    expect(asked).toEqual([]);
    expect(logged.join('\n')).not.toContain(CANARY);
  });

  it('a refusal passes through only as a code in the closed set, with its fixed sentence; anything else is the server\'s own words', async () => {
    for (const [status, code] of [[409, 'answered'], [404, 'noQuestion'], [409, 'noQuestion'], [409, 'busy'], [409, 'unanswerable'], [409, 'offHere']] as const) {
      // Even a known code cannot carry the runtime's own sentence: the server writes it.
      answer = () => ({ status, body: { error: CANARY, code } });
      expect(await post(`/predictions/questions/${PID}/answer`, { answer: 'yes' })).toEqual({ status, body: { error: PREDICT_SAYS[code], code } });
    }
    for (const [status, code] of [[400, 'unknown'], [400, 'nothing'], [409, 'offHere'], [409, 'forgotten'], [409, 'mislabeled'], [400, 'invalid']] as const) {
      answer = () => ({ status, body: { error: CANARY, code } });
      expect(await post('/predictions/turn-on', { series: [KEY] })).toEqual({ status, body: { error: PREDICT_SAYS[code], code } });
    }
    answer = () => ({ status: 409, body: { error: CANARY, code: 'alreadyOff' } });
    expect(await post(`/predictions/series/${KEY}/turn-off`)).toEqual({ status: 409, body: { error: 'Forecasts for this number are already off.', code: 'alreadyOff' } });
    // The second opinion's two refusals: no local model to give one, and one that is already off.
    answer = () => ({ status: 409, body: { error: CANARY, code: 'noModel' } });
    expect(await post('/predictions/turn-on', { series: [KEY], opinion: true })).toEqual({ status: 409, body: { error: 'No local model is set on this Mac, so there is no second opinion to turn on.', code: 'noModel' } });
    answer = () => ({ status: 409, body: { error: CANARY, code: 'opinionOff' } });
    expect(await post(`/predictions/series/${KEY}/second-opinion-off`)).toEqual({ status: 409, body: { error: 'The second opinion for this number is already off.', code: 'opinionOff' } });
    // A code outside the set, or none: the runtime's words never pass.
    answer = () => ({ status: 409, body: { error: `forbidden: ${CANARY}`, code: 'forbidden' } });
    expect((await post('/predictions/turn-on', { series: [KEY] })).body).toEqual({ error: PREDICTIONS_SAY.stuck });
    answer = () => ({ status: 400, body: { error: `${CANARY} words` } });
    expect((await post(`/predictions/questions/${PID}/answer`, { answer: 'no' })).body).toEqual({ error: PREDICTIONS_SAY.refused });
    answer = () => ({ status: 404, body: { error: 'Route POST:/v1/predictions/turn-on not found' } });
    expect(await post('/predictions/turn-on', { series: [KEY] })).toEqual({ status: 501, body: { error: PREDICTIONS_SAY.older } });
    answer = () => ({ status: 429, body: { error: CANARY } });
    expect(await post('/predictions/turn-on', { series: [KEY] })).toEqual({ status: 429, body: { error: PREDICTIONS_SAY.busy } });
    answer = () => ({ status: 500, body: { error: 'internal error', ref: 'err1' } });
    expect(await post(`/predictions/questions/${PID}/answer`, { answer: 'yes' })).toEqual({ status: 502, body: { error: PREDICTIONS_SAY.failed, ref: 'ref123' } });
    expect(logged.join('\n')).not.toContain(CANARY);
  });

  it('a body over 16 KB is a 413 before anything else; the largest real request fits many times over', async () => {
    expect(PREDICTIONS_BODY_BYTES).toBe(16 * 1024);
    const most = { series: Array.from({ length: 40 }, (_, i) => `daily.${'x'.repeat(60)}${String(i).padStart(2, '0')}.count`) };
    expect(Buffer.byteLength(JSON.stringify(most))).toBeLessThan(PREDICTIONS_BODY_BYTES / 4);
    answer = () => ({ status: 200, body: { id: 'pr1', deduped: false } });
    expect((await post('/predictions/turn-on', most)).status).toBe(200);
    asked = [];
    for (const p of ['/predictions/turn-on', `/predictions/questions/${PID}/answer`, `/predictions/series/${KEY}/turn-off`]) {
      expect(await post(p, `{"answer":"yes","pad":"${'x'.repeat(17_000)}"}`), p).toEqual({ status: 413, body: { error: PREDICTIONS_SAY.tooLarge } });
    }
    expect(asked).toEqual([]);
  });

  it('a write the runtime does not answer in time is not called unchanged: Flint says it isn\'t sure; a read just did not load', async () => {
    deps = { ...deps, timeoutMs: 150 };
    delayMs = 600;
    expect(await post(`/predictions/questions/${PID}/answer`, { answer: 'yes' })).toEqual({ status: 504, body: { error: 'Flint isn’t sure it went through. Check Predictions before trying again.' } });
    expect(await post('/predictions/turn-on', { series: [KEY] })).toEqual({ status: 504, body: { error: PREDICTIONS_SAY.unsure } });
    expect(await get('/predictions')).toEqual({ status: 503, body: { error: PREDICTIONS_SAY.down } });
    // The runtime did get each one: it may well have landed.
    expect(asked).toHaveLength(3);
    await new Promise((r) => setTimeout(r, 700));
  });

  it('a connection that drops after the runtime has the request is the same: only a runtime that was never reached got nothing', async () => {
    drop = true;
    expect(await post(`/predictions/series/${KEY}/turn-off`)).toEqual({ status: 504, body: { error: PREDICTIONS_SAY.unsure } });
    expect(await get('/predictions/questions')).toEqual({ status: 503, body: { error: PREDICTIONS_SAY.down } });
    expect(asked).toHaveLength(2);
    up = false;
    expect(await post(`/predictions/series/${KEY}/turn-off`)).toEqual({ status: 503, body: { error: PREDICTIONS_SAY.downWrite } });
  });
});

describe('nothing is kept', () => {
  it('every answer of the proxy, whatever its status, says no-store: a forecast\'s numbers and a question\'s words never land in a disk cache', async () => {
    const before = answersSeen;
    answer = () => ({ status: 200, body: page() });
    const seen: number[] = [(await get('/predictions')).status];
    answer = () => ({ status: 200, body: { series: seriesView() } });
    seen.push((await get(`/predictions/series/${KEY}`)).status);
    seen.push((await get('/predictions?x=1')).status);
    answer = () => ({ status: 200, body: { nonsense: true } });
    seen.push((await get('/predictions/questions')).status);
    answer = () => ({ status: 409, body: { error: 'x', code: 'answered' } });
    seen.push((await post(`/predictions/questions/${PID}/answer`, { answer: 'yes' })).status);
    answer = () => ({ status: 401, body: {} });
    seen.push((await get('/predictions/accuracy')).status);
    seen.push((await post('/predictions/turn-on', `{"pad":"${'x'.repeat(17_000)}"}`)).status);
    up = false;
    seen.push((await get('/predictions')).status);
    seen.push((await post(`/predictions/series/${KEY}/turn-off`)).status);
    deps = { ...deps, runtime: () => undefined };
    seen.push((await get('/predictions/waiting')).status);
    expect(seen).toEqual([200, 200, 400, 502, 409, 502, 413, 503, 503, 501]);
    // Each of those ten was checked for the header by the helper that made it.
    expect(answersSeen - before).toBe(10);
    // It is set in the one place every answer leaves from.
    const src = readFileSync(join(__dirname, '..', 'src', 'predictions-routes.ts'), 'utf8');
    expect(src).toContain("res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });");
    expect(src.match(/res\.writeHead\(/g)).toHaveLength(1);
    expect(src.match(/res\.end\(/g)).toHaveLength(1);
  });
});

describe('where the routes sit', () => {
  it('a predictions route is never reported back to the runtime as a route.error: a number\'s key in a path is no event', () => {
    for (const p of ['/predictions', '/predictions/waiting', '/predictions/accuracy', '/predictions/questions', `/predictions/series/${KEY}`, `/predictions/series/${KEY}/turn-off`, `/predictions/series/${KEY}/second-opinion-off`, `/predictions/questions/${PID}/answer`, '/predictions/turn-on']) expect(routeOf(p), p).toBeUndefined();
    expect(routeOf('/predictionsx')).toBe('other');
  });

  it('only the console\'s full token reaches them: a voice or eval token reaches none', () => {
    for (const [method, p] of [['GET', '/predictions'], ['GET', '/predictions/waiting'], ['GET', `/predictions/series/${KEY}`], ['GET', '/predictions/questions'], ['GET', '/predictions/accuracy'], ['POST', '/predictions/turn-on'], ['POST', `/predictions/series/${KEY}/turn-off`], ['POST', `/predictions/series/${KEY}/second-opinion-off`], ['POST', `/predictions/questions/${PID}/answer`]] as const) {
      expect(scopeAllows('full', method, p), p).toBe(true);
      expect(scopeAllows('voice', method, p), p).toBe(false);
      expect(scopeAllows('eval', method, p), p).toBe(false);
    }
  });

  it('every sentence the server says here is one sentence in plain words, and the same words the design gives the refusals', () => {
    for (const s of Object.values(PREDICTIONS_SAY)) expect(s, s).toMatch(/^[A-Z][^()`{}]*\.$/);
    expect(PREDICTIONS_SAY.noRuntime).toBe('Predictions need the runtime.');
    expect(PREDICTIONS_SAY.downWrite).toBe('The runtime isn’t answering, so nothing changed.');
    expect([PREDICT_SAYS.unknown, PREDICT_SAYS.answered, PREDICT_SAYS.noQuestion]).toEqual(['That number can’t be forecast.', 'That question was already answered.', 'That question no longer exists.']);
  });
});
