/**
 * The tasks and assets routes (P5 part 4), end to end over HTTP against a
 * stand-in runtime: the console's requests are checked with the shared
 * contracts before the runtime sees them; the runtime's answers are checked
 * before the console does (a malformed one is a 502, logged by field paths
 * only); a runtime 401/403 is a 502, a 404 on a page a 501 (an older runtime:
 * the console hides what it cannot offer), a runtime that is down a 503 with a
 * sentence, and a write it did not answer in time a 504 that does not claim
 * nothing changed; a refusal passes through only as a code from the closed
 * set, with its fixed sentence (switched off is one of them, on every route);
 * a server and a runtime of different versions still read each other; nothing
 * is spooled to disk; bodies are capped at 32 KB; and no task's words reach a
 * log line. No model reaches any of it.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { TASK_SAYS, TASK_STATUS_SAYS } from '@flint/policy';
import { MAX_ANSWER, tasksRoutes, TASKS_BODY_BYTES, TASKS_SAY, type TasksDeps } from '../src/tasks-routes';
import { routeOf } from '../src/runtime-events';
import { scopeAllows } from '../src/access';

const TOKEN = 'd'.repeat(64);
const CANARY = 'CANARY-task-words';
const DRAFT = 'k7Hq2LmN9pQr3sTv';
const TID = `tk${DRAFT}`;
const AID = 'as-ci-watcher-v1';

const asset = (over: Record<string, unknown> = {}) => ({ id: AID, name: 'CI Watcher', kind: 'ci_runner', on: true, waiting: false, line: 'Flint reports how your CI runs end.', canTurnOn: false, costs: false, ...over });
const assets = (over: Record<string, unknown> = {}) => ({ assets: [asset()], reviewsRequired: false, ...over });
const row = (over: Record<string, unknown> = {}) => ({
  id: TID, title: 'Watch a CI Run', about: 'wpf002/flint CI', status: 'checking', line: 'It passed its checks and is waiting for you.', runsOn: 'CI Watcher', outside: true, costs: false, createdAt: '2026-10-12T10:00:00.000Z', ...over,
});
const tab = (over: Record<string, unknown> = {}) => ({ tasks: [row()], more: false, ...over });
const view = (over: Record<string, unknown> = {}) => ({
  ...row(), result: `The run passed. ${CANARY}`, checks: [{ id: 'a1', name: 'CI Run Passed', state: 'passed' }, { id: 'a2', name: 'Names Only Your Items', state: 'passed' }], checkedBy: 'rules', askedBy: 'you',
  goalId: null, dueAt: null, chance: { likelihood: 'about_even', percent: 50 }, cost: null, card: 'pr1', can: { cancel: true, accept: false, reject: true, again: false }, ...over,
});
const form = (over: Record<string, unknown> = {}) => ({
  templates: [{ template: 'watch_ci', title: 'Watch a CI Run', runsOn: 'CI Watcher', items: [{ entityId: 'en1', label: 'wpf002/flint CI' }], more: false }], goals: [{ id: 'goabc12345', title: `Finish ${CANARY}` }], ...over,
});
const fresh = (over: Record<string, unknown> = {}) => ({ draftKey: DRAFT, template: 'watch_ci', params: { item: 'en1' }, ...over });

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
let deps: TasksDeps;
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
    void tasksRoutes(req, res, req.url ?? '/', deps).then((handled) => {
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
  const got = (await r.json()) as Record<string, unknown>;
  unkept(r, got);
  return { status: r.status, body: got };
};
/** Every route the proxy has, with a request it takes. */
const EVERY: ReadonlyArray<readonly ['GET' | 'POST', string, unknown?]> = [
  ['GET', '/assets'], ['POST', `/assets/${AID}/on`, {}], ['POST', `/assets/${AID}/off`, {}],
  ['GET', '/tasks'], ['GET', '/tasks?tab=finished'], ['GET', '/tasks/form'], ['GET', `/tasks/${TID}`],
  ['POST', '/tasks', fresh()], ['POST', `/tasks/${TID}/cancel`, {}], ['POST', `/tasks/${TID}/accept`, {}], ['POST', `/tasks/${TID}/reject`, {}], ['POST', `/tasks/${TID}/again`, { draftKey: DRAFT }],
];
const send = (method: 'GET' | 'POST', p: string, body?: unknown) => (method === 'GET' ? get(p) : post(p, body));

describe('reads', () => {
  it('Settings’ assets, a tab, the form and one task are passed through, each to its own runtime route and checked against its contract', async () => {
    answer = () => ({ status: 200, body: assets() });
    expect(await get('/assets')).toEqual({ status: 200, body: assets() });
    expect(asked).toEqual([{ method: 'GET', url: '/v1/assets', auth: `Bearer ${TOKEN}`, body: '' }]);
    answer = () => ({ status: 200, body: tab() });
    expect(await get('/tasks')).toEqual({ status: 200, body: tab() });
    expect(asked.at(-1)!.url).toBe('/v1/tasks?tab=active');
    expect((await get('/tasks?tab=finished')).status).toBe(200);
    expect(asked.at(-1)!.url).toBe('/v1/tasks?tab=finished');
    answer = () => ({ status: 200, body: form() });
    expect(await get('/tasks/form')).toEqual({ status: 200, body: form() });
    expect(asked.at(-1)!.url).toBe('/v1/task-form');
    answer = () => ({ status: 200, body: { task: view() } });
    expect(await get(`/tasks/${TID}`)).toEqual({ status: 200, body: { task: view() } });
    expect(asked.at(-1)!.url).toBe(`/v1/tasks/${TID}`);
    expect(asked.every((a) => a.method === 'GET' && a.auth === `Bearer ${TOKEN}` && a.body === '')).toBe(true);
  });

  it('bad input never reaches the runtime: a tab outside the set, anything else in a query, an id that is not a task’s', async () => {
    for (const p of [
      '/tasks?tab=everything', '/tasks?tab=active&limit=500', '/tasks?limit=500', '/tasks?tab=active&tab=finished', '/tasks?tab=',
      '/assets?all=1', '/tasks/form?kind=person', `/tasks/${TID}?full=1`,
      '/tasks/not-a-task', '/tasks/tkshort', `/tasks/tk${'a'.repeat(33)}`, '/tasks/tk%20abcdefgh12345678', `/tasks/go${DRAFT}`,
    ]) {
      expect(await get(p), p).toEqual({ status: 400, body: { error: TASKS_SAY.invalid } });
    }
    expect(asked).toEqual([]);
    // What is not one of these routes is not handled here at all.
    for (const p of ['/assets/on', `/assets/${AID}`, `/assets/${AID}/on`, `/tasks/${TID}/cancel`, `/tasks/${TID}/again`, '/tasks/form/items', '/tasksx', '/assetsx', '/task-form', '/v1/tasks']) expect((await get(p)).status, p).toBe(404);
    for (const p of ['/assets', `/assets/${AID}`, `/assets/${AID}/toggle`, `/assets/${AID}/on/now`, `/tasks/${TID}`, '/tasks/form', `/tasks/${TID}/run`, `/tasks/${TID}/destroy`, `/tasks/${TID}/accept/now`]) expect((await post(p, {})).status, p).toBe(404);
    for (const [method, p] of [['PUT', '/tasks'], ['DELETE', `/tasks/${TID}`], ['PATCH', `/assets/${AID}/on`]] as const) {
      const r = await fetch(`${base}${p}`, { method });
      expect(r.status, `${method} ${p}`).toBe(404);
      await r.text();
    }
    expect(asked).toEqual([]);
  });

  it('what does not fit the contract never reaches the console: a spec, a raw output, a title for an item, a state outside the set', async () => {
    const bad: Array<[string, unknown]> = [
      ['/assets', assets({ assets: [asset({ externalRef: 'github:ci:v1' })] })],
      ['/assets', assets({ assets: [asset({ kind: 'shell' })] })],
      ['/assets', { assets: [asset()] }],
      ['/assets', assets({ note: CANARY })],
      ['/tasks', tab({ tasks: [row({ spec: { template: 'watch_ci', params: { item: 'en1' } } })] })],
      ['/tasks', tab({ tasks: [row({ status: `${CANARY}` })] })],
      ['/tasks', tab({ tasks: [row({ line: '' })] })],
      ['/tasks', { tasks: [row()] }],
      ['/tasks/form', form({ templates: [{ template: 'watch_ci', title: 'Watch a CI Run', runsOn: 'CI Watcher', items: [{ entityId: 'en1', label: 'wpf002/flint CI', title: CANARY }], more: false }] })],
      ['/tasks/form', form({ templates: [{ template: 'run_shell', title: 'Run a Command', runsOn: 'CI Watcher', items: [], more: false }] })],
      ['/tasks/form', { templates: [] }],
      [`/tasks/${TID}`, { task: view({ output: { raw: CANARY } }) }],
      [`/tasks/${TID}`, { task: view({ can: { cancel: true, accept: false, reject: true, again: 'yes' } }) }],
      [`/tasks/${TID}`, { task: view({ can: { cancel: true, accept: false, reject: true, run: true } }) }],
      [`/tasks/${TID}`, { task: view({ checks: [{ id: 'a1', name: 'CI Run Passed', state: 'maybe' }] }) }],
      // A cost no task's row could hold, and a kind of task offered twice.
      [`/tasks/${TID}`, { task: view({ cost: { micros: 999_999_999_901, estimate: false } }) }],
      ['/tasks/form', form({ templates: [form().templates[0], form().templates[0]] })],
      [`/tasks/${TID}`, view()],
    ];
    for (const [p, body] of bad) {
      answer = () => ({ status: 200, body });
      expect(await get(p), `${p} ${JSON.stringify(body).slice(0, 80)}`).toEqual({ status: 502, body: { error: 'The runtime sent an answer Flint can’t read.', ref: 'ref123' } });
    }
    // Each was logged by where it broke, never by what it held.
    const log = logged.join('\n');
    expect(logged).toHaveLength(bad.length);
    expect(log).toMatch(/malformed assets answer \(assets\.0/);
    expect(log).toMatch(/malformed task answer \(task/);
    expect(log).not.toContain(CANARY);
  });

  it('a server and a runtime of different versions read each other: no Run Again from an older runtime is no; no form is "newer runtime"', async () => {
    // An older runtime's open task says nothing of Run Again: it reads, and the console is told nothing it was not.
    const { again: _unsaid, ...older } = view().can as Record<string, unknown>;
    answer = () => ({ status: 200, body: { task: view({ can: older }) } });
    const got = await get(`/tasks/${TID}`);
    expect(got.status).toBe(200);
    expect((got.body.task as { can: Record<string, unknown> }).can).toEqual({ cancel: true, accept: false, reject: true });
    // It has no form route: a plain 404, which is a 501 here. The same for each page.
    answer = () => ({ status: 404, body: { message: 'Route GET:/v1/task-form not found', error: 'Not Found', statusCode: 404 } });
    for (const p of ['/tasks/form', '/tasks', '/assets']) expect(await get(p), p).toEqual({ status: 501, body: { error: 'This needs a newer runtime.' } });
    // It does not know the verb: what the proxy sent was checked first, so "invalid" there means "older", never a mistake of Will's.
    answer = () => ({ status: 400, body: { error: TASK_SAYS.invalid, code: 'invalid', ref: 'refabc' } });
    expect(await post(`/tasks/${TID}/again`, { draftKey: DRAFT })).toEqual({ status: 501, body: { error: TASKS_SAY.older } });
    // Any other write the runtime calls invalid is said as the runtime said it.
    expect(await post('/tasks', fresh())).toEqual({ status: 400, body: { error: TASK_SAYS.invalid, code: 'invalid' } });
    // A newer runtime's real refusals of Run Again pass as themselves.
    for (const [status, code, say] of [[409, 'detailsGone', TASK_SAYS.detailsGone], [409, 'status.queued', TASK_STATUS_SAYS.queued], [404, 'noTask', TASK_SAYS.noTask], [409, 'assetOff', TASK_SAYS.assetOff], [400, 'person', TASK_SAYS.person]] as const) {
      answer = () => ({ status, body: { error: CANARY, code } });
      expect(await post(`/tasks/${TID}/again`, { draftKey: DRAFT })).toEqual({ status, body: { error: say, code } });
    }
  });

  it('an answer is one task’s and no other’s: a task answered under another id, and a filing that names another task, never reach the console', async () => {
    const OTHER = 'tkZZZZZZZZZZZZZZZZ';
    answer = () => ({ status: 200, body: { task: view({ id: OTHER, title: `Summarize ${CANARY}` }) } });
    expect(await get(`/tasks/${TID}`)).toEqual({ status: 502, body: { error: TASKS_SAY.unreadable, ref: 'ref123' } });
    // A new task's id is the one its form's key makes, and so is Run Again's.
    answer = () => ({ status: 200, body: { id: OTHER, proposalId: 'pr1', deduped: false } });
    expect(await post('/tasks', fresh())).toEqual({ status: 502, body: { error: TASKS_SAY.unreadable, ref: 'ref123' } });
    expect(await post(`/tasks/${TID}/again`, { draftKey: 'n8Jr3MnP0qRs4tUw' })).toEqual({ status: 502, body: { error: TASKS_SAY.unreadable, ref: 'ref123' } });
    answer = () => ({ status: 200, body: { id: TID, proposalId: 'pr1', deduped: false } });
    // (The key that made the task asked about is not Run Again's own key: its answer must name the NEW task.)
    expect((await post(`/tasks/${TID}/again`, { draftKey: 'n8Jr3MnP0qRs4tUw' })).status).toBe(502);
    expect((await post(`/tasks/${TID}/again`, { draftKey: DRAFT })).status).toBe(200);
    expect(logged).toEqual(['a task answer about another task', 'a new task answer about another task', 'a run again answer about another task', 'a run again answer about another task']);
    expect(logged.join('\n')).not.toContain(CANARY);
  });

  it('at most 1 MB of an answer is read, and a 2xx that is not JSON is unreadable: neither is "not answering", and neither is parsed', async () => {
    expect(MAX_ANSWER).toBe(1024 * 1024);
    // Well-formed JSON, over the limit: refused by its size, before anything reads what it holds.
    const big = JSON.stringify({ task: view(), pad: 'x'.repeat(2 * MAX_ANSWER) });
    answer = () => ({ status: 200, body: big });
    expect(await get(`/tasks/${TID}`)).toEqual({ status: 502, body: { error: 'The runtime sent an answer Flint can’t read.', ref: 'ref123' } });
    expect(await post(`/tasks/${TID}/cancel`)).toEqual({ status: 502, body: { error: TASKS_SAY.unreadable, ref: 'ref123' } });
    // A refusal over the limit is no refusal Flint can read either.
    answer = () => ({ status: 409, body: JSON.stringify({ error: 'x', code: 'off', pad: 'x'.repeat(2 * MAX_ANSWER) }) });
    expect(await get('/tasks')).toEqual({ status: 502, body: { error: TASKS_SAY.unreadable, ref: 'ref123' } });
    expect(logged).toEqual(['an answer over 1 MB for a task request', 'an answer over 1 MB for a cancel request', 'an answer over 1 MB for a tab request']);
    // Right at the limit an answer is read (and then held to its contract like any other).
    logged = [];
    const most = { tasks: [row()], more: false };
    const room = MAX_ANSWER - Buffer.byteLength(JSON.stringify(most));
    answer = () => ({ status: 200, body: `${' '.repeat(room)}${JSON.stringify(most)}` });
    expect((await get('/tasks')).status).toBe(200);
    answer = () => ({ status: 200, body: `${' '.repeat(room + 1)}${JSON.stringify(most)}` });
    expect((await get('/tasks')).status).toBe(502);
    expect(logged).toEqual(['an answer over 1 MB for a tab request']);
    // Not JSON at all, or nothing: the runtime did answer.
    logged = [];
    for (const body of ['<html>502 Bad Gateway</html>', '', 'undefined', `{"task":${CANARY}`]) {
      answer = () => ({ status: 200, body });
      expect(await get(`/tasks/${TID}`), body).toEqual({ status: 502, body: { error: TASKS_SAY.unreadable, ref: 'ref123' } });
      expect(await post('/tasks', fresh()), body).toEqual({ status: 502, body: { error: TASKS_SAY.unreadable, ref: 'ref123' } });
    }
    expect([...new Set(logged)]).toEqual(['an answer that is not JSON for a task request', 'an answer that is not JSON for a new task request']);
    expect(logged.join('\n')).not.toContain(CANARY);
  });

  it('switched off on this Mac: every route answers with the runtime’s code and the one fixed sentence, never its words', async () => {
    answer = () => ({ status: 409, body: { error: `${CANARY} off`, code: 'off' } });
    for (const [method, p, body] of EVERY) {
      expect(await send(method, p, body), `${method} ${p}`).toEqual({ status: 409, body: { error: 'Tasks are turned off on this Mac.', code: 'off' } });
    }
    expect(asked).toHaveLength(EVERY.length);
    expect(logged).toEqual([]);
  });

  it('runtime 401/403 is a 502, a missing task a 404 with a sentence, down a 503 with a sentence, no runtime at all a 501', async () => {
    for (const s of [401, 403]) {
      answer = () => ({ status: s, body: { error: 'unauthorized' } });
      expect(await get('/tasks')).toEqual({ status: 502, body: { error: TASKS_SAY.token } });
      expect(await post(`/assets/${AID}/off`)).toEqual({ status: 502, body: { error: TASKS_SAY.token } });
    }
    answer = () => ({ status: 404, body: { error: CANARY, code: 'noTask' } });
    expect(await get(`/tasks/${TID}`)).toEqual({ status: 404, body: { error: 'This task no longer exists.', code: 'noTask' } });
    answer = () => ({ status: 404, body: { error: CANARY } });
    expect(await get(`/tasks/${TID}`)).toEqual({ status: 404, body: { error: TASKS_SAY.gone } });
    up = false;
    for (const p of ['/assets', '/tasks', '/tasks/form', `/tasks/${TID}`]) expect(await get(p), p).toEqual({ status: 503, body: { error: 'The runtime isn’t answering, so tasks can’t load.' } });
    for (const [p, b] of [['/tasks', fresh()], [`/assets/${AID}/on`, {}], [`/tasks/${TID}/cancel`, {}], [`/tasks/${TID}/again`, { draftKey: DRAFT }]] as const) {
      expect(await post(p, b), p).toEqual({ status: 503, body: { error: 'The runtime isn’t answering, so nothing changed.' } });
    }
    deps = { ...deps, runtime: () => undefined };
    for (const [method, p, body] of EVERY) expect(await send(method, p, body), `${method} ${p}`).toEqual({ status: 501, body: { error: 'Tasks need the runtime.' } });
  });

  it('what goes to the log is a sentence of the server’s own, as a string: a status, a field path, never a value', async () => {
    answer = () => ({ status: 200, body: tab({ tasks: [row({ line: 42, title: `${CANARY} title` })] }) });
    expect(await get('/tasks')).toEqual({ status: 502, body: { error: TASKS_SAY.unreadable, ref: 'ref123' } });
    answer = () => ({ status: 500, body: { error: `internal error ${CANARY}` } });
    expect(await get('/assets')).toEqual({ status: 502, body: { error: TASKS_SAY.failed, ref: 'ref123' } });
    await post('/tasks', fresh({ template: CANARY }));
    expect(given.length).toBe(3);
    for (const e of given) expect(typeof e, String(e)).toBe('string');
    expect(logged).toEqual(['malformed tab answer (tasks.0.line)', 'the runtime answered 500 for an assets request', 'refused a new task request (template)']);
    const src = readFileSync(join(__dirname, '..', 'src', 'tasks-routes.ts'), 'utf8');
    expect(src).not.toMatch(/errorRef\([^)]*new Error/);
    // Six places log, each a sentence made here: too long, not JSON, an error status, a broken contract, a refused request, another task's answer.
    expect(src.match(/deps\.errorRef\('tasks', `/g)).toHaveLength(6);
    expect(src.match(/errorRef\(/g)).toHaveLength(6);
    // The proxy keeps nothing and tells no one: no spool, no file, no note, no log line of its own.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).not.toMatch(/RuntimeProposals|\.propose\(|runtime-proposals|appendFile|writeFile|node:fs|console\.(log|warn|error|info)|notes\.push|notifier|actionLog/);
  });
});

describe('writes', () => {
  it('a new task is checked here, then filed with the runtime straight away, as the contract reads it', async () => {
    answer = () => ({ status: 200, body: { id: TID, proposalId: 'pr1', deduped: false } });
    expect(await post('/tasks', fresh())).toEqual({ status: 200, body: { id: TID, proposalId: 'pr1', deduped: false } });
    // Its params go on as its own kind of task's contract reads them: every field said, nothing else.
    expect(asked).toEqual([{ method: 'POST', url: '/v1/tasks', auth: `Bearer ${TOKEN}`, body: JSON.stringify({ draftKey: DRAFT, template: 'watch_ci', params: { item: 'en1', sha: null }, goalId: null, dueAt: null, ownCheck: null }) }]);
    const due = '2026-11-01T22:00:00.000Z';
    expect((await post('/tasks', fresh({ goalId: 'goabc12345', dueAt: due, params: { item: 'en1', sha: 'abc1234' } }))).status).toBe(200);
    expect(JSON.parse(asked.at(-1)!.body)).toEqual({ draftKey: DRAFT, template: 'watch_ci', params: { item: 'en1', sha: 'abc1234' }, goalId: 'goabc12345', dueAt: due, ownCheck: null });
    asked = [];
    for (const bad of [
      {}, fresh({ draftKey: 'short' }), fresh({ template: 'run_shell' }), fresh({ params: 'en1' }), fresh({ taskId: TID }), fresh({ assetId: AID }), fresh({ tainted: false }),
      fresh({ dueAt: 'tomorrow' }), fresh({ dueAt: '2026-11-01' }), fresh({ goalId: 'not-a-goal' }), fresh({ ownCheck: 'x'.repeat(301) }), fresh({ note: CANARY }), [fresh()], 'watch_ci',
      // Its params are its own kind of task's, and nothing more: no stray key, no field of another kind, no item that is no id.
      fresh({ params: {} }), fresh({ params: { item: 'en1', command: 'ls' } }), fresh({ params: { item: 'en1', [CANARY]: 1 } }), fresh({ params: { item: { deep: [CANARY] } } }), fresh({ params: { item: 'en1', sha: 'main' } }),
      fresh({ params: { items: ['en1'] } }), fresh({ template: 'draft_note', params: { item: 'en1' } }), fresh({ template: 'sort_items', params: { items: ['en1'], labels: ['Only One'] } }),
      fresh({ params: { item: 'en1', constructor: { prototype: { x: 1 } } } }),
    ]) {
      expect(await post('/tasks', bad), JSON.stringify(bad).slice(0, 70)).toEqual({ status: 400, body: { error: TASKS_SAY.invalid } });
    }
    expect((await post('/tasks?force=1', fresh())).status).toBe(400);
    // Too many items is said as that, here as in the runtime.
    expect(await post('/tasks', fresh({ template: 'summarize_items', params: { items: Array.from({ length: 13 }, (_, i) => `en${i}`) } }))).toEqual({ status: 400, body: { error: 'A task takes up to 12 items.', code: 'tooMany' } });
    expect(asked).toEqual([]);
    // A field path in the log is the contracts' own words: a key a caller made up is never written there, however it is spelled.
    logged = [];
    await post('/tasks', fresh({ params: { item: 'en1', [`${CANARY}-key`]: 1 } }));
    await post('/tasks', fresh({ params: { [`${CANARY}${'k'.repeat(40)}`]: 1 } }));
    await post('/tasks', fresh({ [`${CANARY}-top`]: 1 }));
    await post('/tasks', fresh({ params: { item: 'en1', sha: 'main' } }));
    expect(logged).toEqual(['refused a new task request (params)', 'refused a new task request (params.?)', 'refused a new task request ((root))', 'refused a new task request (params.sha)']);
    expect(asked).toEqual([]);
    // An answer that is not the contract's never reaches the console.
    for (const body of [{ id: TID, proposalId: 'pr1', deduped: false, args: { title: CANARY } }, { proposalId: 'pr1', deduped: false }, { id: 'tk1', proposalId: 'pr1', deduped: false }, { ok: true }]) {
      answer = () => ({ status: 200, body });
      expect((await post('/tasks', fresh())).status, JSON.stringify(body)).toBe(502);
    }
    expect(logged.join('\n')).not.toContain(CANARY);
  });

  it('Turn On files a card and Turn Off is plain; each sends the asset’s id in the path and nothing in the body', async () => {
    answer = () => ({ status: 200, body: { proposalId: 'pr2', deduped: false } });
    expect(await post(`/assets/${AID}/on`)).toEqual({ status: 200, body: { proposalId: 'pr2', deduped: false } });
    expect(asked).toEqual([{ method: 'POST', url: `/v1/assets/${AID}/on`, auth: `Bearer ${TOKEN}`, body: '{}' }]);
    answer = () => ({ status: 200, body: { ok: true } });
    expect(await post(`/assets/${AID}/off`)).toEqual({ status: 200, body: { ok: true } });
    expect(asked.at(-1)).toEqual({ method: 'POST', url: `/v1/assets/${AID}/off`, auth: `Bearer ${TOKEN}`, body: '{}' });
    // Each answer is its own: turning on is never "done" without a card, and turning off never comes back as a card.
    expect((await post(`/assets/${AID}/on`)).status).toBe(502);
    answer = () => ({ status: 200, body: { proposalId: 'pr2', deduped: false } });
    expect((await post(`/assets/${AID}/off`)).status).toBe(502);
    asked = [];
    for (const [p, b] of [
      [`/assets/${AID}/on`, { force: true }], [`/assets/${AID}/on`, { approvalId: 'ap1' }], [`/assets/${AID}/off`, { why: CANARY }], [`/assets/${AID}/on?now=1`, {}],
      ['/assets/bad%20id/on', {}], [`/assets/${'a'.repeat(41)}/off`, {}], ['/assets/as.watcher/on', {}],
    ] as const) {
      expect(await post(p, b), `${p} ${JSON.stringify(b)}`).toEqual({ status: 400, body: { error: TASKS_SAY.invalid } });
    }
    expect(asked).toEqual([]);
    expect(logged.join('\n')).not.toContain(CANARY);
  });

  it('Cancel is done or a card; Accept Anyway and Reject Anyway are always a card; Run Again sends the new task’s key alone', async () => {
    answer = () => ({ status: 200, body: { ok: true } });
    expect(await post(`/tasks/${TID}/cancel`)).toEqual({ status: 200, body: { ok: true } });
    expect(asked.at(-1)).toEqual({ method: 'POST', url: `/v1/tasks/${TID}/cancel`, auth: `Bearer ${TOKEN}`, body: '{}' });
    // Ending a task against its check is never done without his card.
    for (const v of ['accept', 'reject']) expect((await post(`/tasks/${TID}/${v}`)).status, v).toBe(502);
    answer = () => ({ status: 200, body: { proposalId: 'pr3', deduped: true } });
    for (const v of ['cancel', 'accept', 'reject']) {
      expect(await post(`/tasks/${TID}/${v}`), v).toEqual({ status: 200, body: { proposalId: 'pr3', deduped: true } });
      expect(asked.at(-1)).toEqual({ method: 'POST', url: `/v1/tasks/${TID}/${v}`, auth: `Bearer ${TOKEN}`, body: '{}' });
    }
    // A card answer that also says "done", or a done that carries more, is neither.
    for (const body of [{ ok: true, proposalId: 'pr3', deduped: false }, { ok: false }, { proposalId: 'pr3' }]) {
      answer = () => ({ status: 200, body });
      expect((await post(`/tasks/${TID}/cancel`)).status, JSON.stringify(body)).toBe(502);
    }
    const KEY = 'n8Jr3MnP0qRs4tUw';
    answer = () => ({ status: 200, body: { id: `tk${KEY}`, proposalId: 'pr4', deduped: false } });
    expect(await post(`/tasks/${TID}/again`, { draftKey: KEY })).toEqual({ status: 200, body: { id: `tk${KEY}`, proposalId: 'pr4', deduped: false } });
    expect(asked.at(-1)).toEqual({ method: 'POST', url: `/v1/tasks/${TID}/again`, auth: `Bearer ${TOKEN}`, body: JSON.stringify({ draftKey: KEY }) });
    // Run Again makes a task: an answer without one is not passed on.
    answer = () => ({ status: 200, body: { proposalId: 'pr4', deduped: false } });
    expect((await post(`/tasks/${TID}/again`, { draftKey: KEY })).status).toBe(502);
    asked = [];
    for (const [p, b] of [
      [`/tasks/${TID}/cancel`, { why: CANARY }], [`/tasks/${TID}/accept`, { to: 'accepted' }], [`/tasks/${TID}/reject`, { approvalId: 'ap1' }], [`/tasks/${TID}/cancel?force=1`, {}],
      ['/tasks/not-a-task/cancel', {}], [`/tasks/go${DRAFT}/accept`, {}],
      // Run Again names no template, no item and no id of its own choosing.
      [`/tasks/${TID}/again`, {}], [`/tasks/${TID}/again`, { draftKey: 'short' }], [`/tasks/${TID}/again`, { draftKey: KEY, params: { item: 'en2' } }], [`/tasks/${TID}/again`, { draftKey: KEY, template: 'draft_note' }],
      [`/tasks/${TID}/again`, { draftKey: KEY, taskId: TID }], ['/tasks/nope/again', { draftKey: KEY }], [`/tasks/${TID}/again?x=1`, { draftKey: KEY }],
    ] as const) {
      expect(await post(p, b), `${p} ${JSON.stringify(b)}`).toEqual({ status: 400, body: { error: TASKS_SAY.invalid } });
    }
    expect(asked).toEqual([]);
    expect(logged.join('\n')).not.toContain(CANARY);
  });

  it('a refusal passes through only as a code in the closed set, with its fixed sentence; anything else is the server’s own words', async () => {
    for (const [status, code] of [[409, 'assetOff'], [409, 'itemGone'], [400, 'wrongItem'], [400, 'person'], [400, 'due'], [404, 'noGoal'], [409, 'cantRun'], [400, 'ownCheck'], [409, 'changed'], [400, 'tooMany']] as const) {
      // Even a known code cannot carry the runtime's own sentence: the server writes it.
      answer = () => ({ status, body: { error: CANARY, code } });
      expect(await post('/tasks', fresh())).toEqual({ status, body: { error: TASK_SAYS[code], code } });
    }
    for (const [status, code] of [[409, 'needsGithub'], [400, 'nothing'], [404, 'noAsset'], [409, 'reviewerStays']] as const) {
      answer = () => ({ status, body: { error: CANARY, code } });
      expect(await post(`/assets/${AID}/on`)).toEqual({ status, body: { error: TASK_SAYS[code], code } });
    }
    // Where a task stands, as why it cannot take a step: the status's own sentence.
    for (const st of ['accepted', 'cancelled', 'queued'] as const) {
      answer = () => ({ status: 409, body: { error: CANARY, code: `status.${st}` } });
      expect(await post(`/tasks/${TID}/cancel`)).toEqual({ status: 409, body: { error: TASK_STATUS_SAYS[st], code: `status.${st}` } });
    }
    answer = () => ({ status: 409, body: { error: CANARY, code: 'decided' } });
    expect(await post(`/tasks/${TID}/reject`)).toEqual({ status: 409, body: { error: 'You already decided this result.', code: 'decided' } });
    // A code outside the set, a status that is none, a code on a status it cannot ride, or no code: the runtime's words never pass.
    answer = () => ({ status: 409, body: { error: `forbidden: ${CANARY}`, code: 'forbidden' } });
    expect((await post('/tasks', fresh())).body).toEqual({ error: TASKS_SAY.stuck });
    answer = () => ({ status: 409, body: { error: CANARY, code: 'status.exploded' } });
    expect((await post(`/tasks/${TID}/cancel`)).body).toEqual({ error: TASKS_SAY.stuck });
    answer = () => ({ status: 409, body: { error: CANARY, code: 'constructor' } });
    expect((await post(`/tasks/${TID}/cancel`)).body).toEqual({ error: TASKS_SAY.stuck });
    answer = () => ({ status: 500, body: { error: CANARY, code: 'assetOff' } });
    expect(await post('/tasks', fresh())).toEqual({ status: 502, body: { error: TASKS_SAY.failed, ref: 'ref123' } });
    answer = () => ({ status: 400, body: { error: `${CANARY} words` } });
    expect((await post(`/tasks/${TID}/accept`)).body).toEqual({ error: TASKS_SAY.refused });
    answer = () => ({ status: 404, body: { error: 'Route POST:/v1/tasks not found' } });
    expect(await post('/tasks', fresh())).toEqual({ status: 501, body: { error: TASKS_SAY.older } });
    answer = () => ({ status: 429, body: { error: CANARY } });
    expect(await post('/tasks', fresh())).toEqual({ status: 429, body: { error: TASKS_SAY.busy } });
    answer = () => ({ status: 413, body: { error: CANARY } });
    expect(await post('/tasks', fresh())).toEqual({ status: 413, body: { error: TASKS_SAY.tooLarge } });
    expect(logged.join('\n')).not.toContain(CANARY);
  });

  it('a body over 32 KB is a 413 before anything else; the largest real form fits', async () => {
    expect(TASKS_BODY_BYTES).toBe(32 * 1024);
    // The largest form there is (a note in 300 characters about 12 items) is a fraction of it.
    const most = fresh({ template: 'draft_note', params: { about: 'x'.repeat(300), items: Array.from({ length: 12 }, (_, i) => `en${'a'.repeat(36)}${String(i).padStart(2, '0')}`), titles: true }, goalId: `go${'a'.repeat(38)}`, dueAt: '2026-11-01T22:00:00.000Z' });
    expect(Buffer.byteLength(JSON.stringify(most))).toBeLessThan(TASKS_BODY_BYTES / 16);
    answer = () => ({ status: 200, body: { id: TID, proposalId: 'pr1', deduped: false } });
    expect((await post('/tasks', most)).status).toBe(200);
    // Right up to the limit a body is read (the padding is the JSON's own white space), and one byte past it is not.
    const padded = (bytes: number) => `${' '.repeat(bytes - Buffer.byteLength(JSON.stringify(fresh())))}${JSON.stringify(fresh())}`;
    expect((await post('/tasks', padded(TASKS_BODY_BYTES))).status).toBe(200);
    expect((await post('/tasks', padded(TASKS_BODY_BYTES + 1))).status).toBe(413);
    asked = [];
    for (const p of ['/tasks', `/assets/${AID}/on`, `/tasks/${TID}/cancel`, `/tasks/${TID}/again`]) {
      expect(await post(p, `{"draftKey":"${DRAFT}","pad":"${'x'.repeat(33_000)}"}`), p).toEqual({ status: 413, body: { error: TASKS_SAY.tooLarge } });
    }
    expect(asked).toEqual([]);
  });

  it('a write the runtime does not answer in time is not called unchanged: Flint says it isn’t sure; a read just did not load', async () => {
    deps = { ...deps, timeoutMs: 150 };
    delayMs = 600;
    expect(await post('/tasks', fresh())).toEqual({ status: 504, body: { error: 'Flint isn’t sure it went through. Check Tasks before trying again.' } });
    expect(await post(`/assets/${AID}/off`)).toEqual({ status: 504, body: { error: TASKS_SAY.unsure } });
    expect(await get('/tasks')).toEqual({ status: 503, body: { error: TASKS_SAY.down } });
    // The runtime did get each one: it may well have landed.
    expect(asked).toHaveLength(3);
    await new Promise((r) => setTimeout(r, 700));
  });

  it('a connection that drops after the runtime has the request is the same: only a runtime that was never reached got nothing', async () => {
    drop = true;
    expect(await post(`/tasks/${TID}/cancel`)).toEqual({ status: 504, body: { error: TASKS_SAY.unsure } });
    expect(await get('/assets')).toEqual({ status: 503, body: { error: TASKS_SAY.down } });
    expect(asked).toHaveLength(2);
    up = false;
    expect(await post(`/tasks/${TID}/cancel`)).toEqual({ status: 503, body: { error: TASKS_SAY.downWrite } });
  });
});

describe('nothing is kept', () => {
  it('every answer of the proxy, whatever its status, says no-store: a task’s words and its result never land in a disk cache', async () => {
    const before = answersSeen;
    answer = () => ({ status: 200, body: tab() });
    const seen: number[] = [(await get('/tasks')).status];
    answer = () => ({ status: 200, body: { task: view() } });
    seen.push((await get(`/tasks/${TID}`)).status);
    seen.push((await get('/assets?x=1')).status);
    answer = () => ({ status: 200, body: { nonsense: true } });
    seen.push((await get('/tasks/form')).status);
    answer = () => ({ status: 409, body: { error: 'x', code: 'off' } });
    seen.push((await post(`/tasks/${TID}/cancel`)).status);
    answer = () => ({ status: 401, body: {} });
    seen.push((await get('/assets')).status);
    seen.push((await post('/tasks', `{"pad":"${'x'.repeat(33_000)}"}`)).status);
    up = false;
    seen.push((await get('/tasks')).status);
    seen.push((await post(`/assets/${AID}/off`)).status);
    deps = { ...deps, runtime: () => undefined };
    seen.push((await get('/assets')).status);
    expect(seen).toEqual([200, 200, 400, 502, 409, 502, 413, 503, 503, 501]);
    // Each of those ten was checked for the header by the helper that made it.
    expect(answersSeen - before).toBe(10);
    // It is set in the one place every answer leaves from.
    const src = readFileSync(join(__dirname, '..', 'src', 'tasks-routes.ts'), 'utf8');
    expect(src).toContain("res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });");
    expect(src.match(/res\.writeHead\(/g)).toHaveLength(1);
    expect(src.match(/res\.end\(/g)).toHaveLength(1);
  });
});

describe('where the routes sit', () => {
  it('a tasks or assets route is never reported back to the runtime as a route.error: a task’s id in a path is no event', () => {
    for (const [, p] of EVERY) expect(routeOf(p), p).toBeUndefined();
    expect(routeOf('/tasksx')).toBe('other');
    expect(routeOf('/assetsx')).toBe('other');
  });

  it('only the console’s full token reaches them: a voice or eval token reaches none', () => {
    for (const [method, p] of EVERY) {
      expect(scopeAllows('full', method, p), p).toBe(true);
      expect(scopeAllows('voice', method, p), p).toBe(false);
      expect(scopeAllows('eval', method, p), p).toBe(false);
    }
  });

  it('no model reaches a task: this proxy is the server’s one way to the runtime’s task routes, and chat’s runtime tools have none', () => {
    const dir = join(__dirname, '..', 'src');
    const names = /\/v1\/(tasks|assets|task-form)/;
    const users = readdirSync(dir).filter((f) => f.endsWith('.ts') && names.test(readFileSync(join(dir, f), 'utf8')));
    expect(users).toEqual(['tasks-routes.ts']);
    // The tools a model is offered for the runtime are the runtime connector's: none of them asks for a task or an asset.
    const connector = readFileSync(join(__dirname, '..', '..', '..', 'packages', 'mcp', 'connectors', 'runtime-server.ts'), 'utf8');
    expect(connector).toMatch(/\/v1\/world\/now/);
    expect(connector).not.toMatch(names);
    expect(connector).not.toMatch(/task\.|asset\./);
    // The proxy itself is handed the runtime link and a logger: no tool list, no chat context, nothing a model's words steer.
    const src = readFileSync(join(dir, 'tasks-routes.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(src).not.toMatch(/@flint\/core|Tool\b|tools\b|convos|memory|knowledge/);
  });

  it('every line the server says here is one plain sentence, or the two it is listed as: a second sentence slipped into any other fails here', () => {
    /** The lines that say what happened and then what to do: two sentences each. Every other line is one. */
    const TWO = new Set(['unsure', 'token', 'busy', 'failed']);
    const sentences = (s: string) => s.split(/(?<=[.!?])\s+/);
    for (const [key, s] of Object.entries(TASKS_SAY)) {
      expect(sentences(s).length, `${key}: ${s}`).toBe(TWO.has(key) ? 2 : 1);
      // Each sentence starts with a capital, ends with its one stop, and holds no aside, code or brace.
      for (const one of sentences(s)) expect(one, one).toMatch(/^[A-Z][^.!?()`{}]*\.$/);
    }
    // The check itself tells one sentence from two.
    expect(sentences('Tasks need the runtime.')).toHaveLength(1);
    expect(sentences('Tasks need the runtime. Install it.')).toHaveLength(2);
    expect('Tasks need the runtime. Install it.').not.toMatch(/^[A-Z][^.!?()`{}]*\.$/);
    // What the runtime may say through here is held the same way (each of its lines is one or two sentences, none with an aside).
    for (const s of Object.values(TASK_SAYS)) for (const one of sentences(s)) expect(one, one).toMatch(/^[A-Z][^.!?()`{}]*\.$/);
    expect(TASKS_SAY.noRuntime).toBe('Tasks need the runtime.');
    expect(TASKS_SAY.downWrite).toBe('The runtime isn’t answering, so nothing changed.');
    expect([TASK_SAYS.off, TASK_SAYS.noTask, TASK_SAYS.assetOff]).toEqual(['Tasks are turned off on this Mac.', 'This task no longer exists.', 'Its asset is off. Turn it on in Settings.']);
  });
});
