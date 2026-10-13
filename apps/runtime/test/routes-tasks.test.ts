/**
 * The runtime's asset and task routes (P5) through buildApp and Fastify's
 * inject, the way the server's proxy calls them.
 *
 * Before the database (the stand-in throws if it is touched): 401 without a
 * token; 403 for the runtime connector's token (world:read|ledger) on every
 * route, reads included, so a model can never read a task or start one; 400 on
 * the strict contracts, with a code and field paths only; and, switched off
 * (as it ships: FLINT_ASSETS is not `on`), every route answered with the same
 * one sentence, whatever it was sent. Over the wire no task or asset card is
 * filed as a job's.
 *
 * On flint_test: Settings and the whole of a task's life over HTTP, every
 * refusal as a sentence with its code, and the seven cards never filed, claimed
 * or run for chat.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { AssetsPage, GOAL_SAYS, PAID_DISPATCH, TASK_SAYS, TASK_SIGNED_ACTIONS, TASK_STATUS_SAYS, TaskAnswer, TaskCardFiled, TaskFiled, TasksPage } from '@flint/policy';
import { buildApp, type RuntimeStatus } from '../src/app';
import type { RuntimeScope } from '../src/config';
import { createDb, type Db } from '../src/db';
import { SPEND_NEEDS_ESTIMATE, WHOLE_NUMBERS_ONLY } from '../src/governance/proposals';
import { CI_WATCHER } from '../src/assets/registry';
import { checkTaskJob } from '../src/tasks/check';
import { runTaskJob } from '../src/tasks/run';
import { NO_DB, freshDb, type TestUrls } from './db';
import { FakeBus, draft, taskFixture, type TaskFixture } from './tasks/fixture';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const SERVER = 'server-token-0123456789abcdef';
const MCP = 'mcp-token-0123456789abcdef01';
const CANARY = 'CANARY-task-words';
const DRAFT = 'k7Hq2LmN9pQr3sTv';
const TASK = `tk${DRAFT}`;

const tokens = [
  { name: 'server', sha256: sha(SERVER), scopes: new Set<RuntimeScope>(['events', 'audit', 'proposals', 'world:read', 'ledger', 'counters']) },
  { name: 'runtime-mcp', sha256: sha(MCP), scopes: new Set<RuntimeScope>(['world:read', 'ledger']) },
];

/** The app with tasks switched on, unless `assets` says otherwise: `false`, or `undefined` for a config that does not name them. */
function harness(db: Db, over: { assets?: boolean | undefined; status?: RuntimeStatus } = {}) {
  const lines: string[] = [];
  const assets = 'assets' in over ? over.assets : true;
  const app = buildApp({ db, config: { tokens, tz: 'UTC', ...(assets === undefined ? {} : { assets }) }, logger: true, logStream: { write: (l: string) => void lines.push(l) }, ...(over.status ? { status: over.status } : {}) });
  const call = (method: 'GET' | 'POST', url: string, body?: unknown, token: string | null = SERVER) =>
    app.inject({
      method, url,
      ...(body !== undefined ? { payload: JSON.stringify(body), headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } } : { headers: token ? { authorization: `Bearer ${token}` } : {} }),
    });
  return { app, call, lines };
}

const form = (over: Record<string, unknown> = {}) => ({ draftKey: DRAFT, template: 'watch_ci', params: { item: 'en1' }, ...over });
const ROUTES: Array<['GET' | 'POST', string, unknown?]> = [
  ['GET', '/v1/assets'],
  ['POST', `/v1/assets/${CI_WATCHER.id}/on`, {}],
  ['POST', `/v1/assets/${CI_WATCHER.id}/off`, {}],
  ['GET', '/v1/tasks?tab=active'],
  ['GET', `/v1/tasks/${TASK}`],
  ['POST', '/v1/tasks', form()],
  ['POST', `/v1/tasks/${TASK}/cancel`, {}],
  ['POST', `/v1/tasks/${TASK}/accept`, {}],
  ['POST', `/v1/tasks/${TASK}/reject`, {}],
];

describe('the task routes, before the database', () => {
  let touched = 0;
  // Any use of the database fails the test: validation comes first.
  const untouchable = new Proxy({}, { get: () => { touched++; throw new Error('the database was touched'); } }) as unknown as Db;

  it('401 without a token, 403 for the runtime connector on every route (reads included)', async () => {
    const h = harness(untouchable);
    for (const [method, url, body] of ROUTES) {
      expect((await h.call(method, url, body, null)).statusCode, `${method} ${url}`).toBe(401);
      expect((await h.call(method, url, body, 'not-a-token-at-all-0123')).statusCode, `${method} ${url}`).toBe(401);
      expect((await h.call(method, url, body, MCP)).statusCode, `${method} ${url}`).toBe(403);
    }
    expect(touched).toBe(0);
    await h.app.close();
  });

  it('400 on the strict contracts, with a code and never a value; nothing reaches the database or the log', async () => {
    const h = harness(untouchable);
    const bad: Array<['GET' | 'POST', string, unknown?]> = [
      ['GET', '/v1/tasks?tab=everything'],
      ['GET', '/v1/tasks?tab=active&extra=1'],
      ['GET', '/v1/tasks/not-a-task-id'],
      ['POST', '/v1/tasks', form({ extra: CANARY })],
      ['POST', '/v1/tasks', form({ draftKey: 'short' })],
      ['POST', '/v1/tasks', form({ template: 'run_shell' })],
      ['POST', '/v1/tasks', form({ taskId: TASK })],
      ['POST', '/v1/tasks', form({ dueAt: 'tomorrow' })],
      ['POST', '/v1/tasks', form({ ownCheck: CANARY.repeat(40) })],
      ['POST', '/v1/tasks', { [CANARY]: true }],
      ['POST', `/v1/tasks/${TASK}/cancel`, { why: CANARY }],
      ['POST', `/v1/tasks/${TASK}/destroy`, {}],
      ['POST', '/v1/tasks/nope/cancel', {}],
      ['POST', `/v1/assets/${CI_WATCHER.id}/on`, { force: true }],
      ['POST', `/v1/assets/${CI_WATCHER.id}/toggle`, {}],
      ['POST', '/v1/assets/bad%20id/on', {}],
    ];
    for (const [method, url, body] of bad) {
      const r = await h.call(method, url, body);
      expect(r.statusCode, `${method} ${url} ${JSON.stringify(body)}`).toBe(400);
      expect(r.json()).toMatchObject({ error: TASK_SAYS.invalid, code: 'invalid', ref: expect.stringMatching(/^ref[a-z0-9]+$/) });
      expect(r.body).not.toContain(CANARY);
    }
    expect(touched).toBe(0);
    expect(h.lines.join('\n')).not.toContain(CANARY);
    expect(h.lines.filter((l) => l.includes('task route refused')).length).toBe(bad.length);
    await h.app.close();
  });

  it('switched off, which is how it ships: every route answers with the one sentence whatever it is sent, a task card is not filed over the wire, and nothing touches the database or the log', async () => {
    expect(TASK_SAYS.off).toBe('Tasks are turned off on this Mac.');
    // A config that does not name them, and one that says off.
    for (const over of [{ assets: undefined }, { assets: false }]) {
      const h = harness(untouchable, over);
      const sent: typeof ROUTES = [
        ...ROUTES,
        // What would be a 400 with tasks on: its input is not read.
        ['GET', '/v1/tasks?tab=everything'],
        ['GET', '/v1/tasks/not-a-task-id'],
        ['POST', '/v1/tasks', { [CANARY]: true }],
        ['POST', `/v1/tasks/${TASK}/cancel`, { why: CANARY }],
        ['POST', `/v1/assets/${CI_WATCHER.id}/on`, { force: CANARY }],
      ];
      for (const [method, url, body] of sent) {
        const r = await h.call(method, url, body);
        expect([r.statusCode, r.json()], `${method} ${url}`).toEqual([409, { error: TASK_SAYS.off, code: 'off' }]);
        // Whether tasks are on is not told to a caller who may not ask.
        expect((await h.call(method, url, body, null)).statusCode, `${method} ${url}`).toBe(401);
        expect((await h.call(method, url, body, MCP)).statusCode, `${method} ${url}`).toBe(403);
      }
      for (const action of [...TASK_SIGNED_ACTIONS, PAID_DISPATCH]) {
        const r = await h.call('POST', '/v1/proposals', { kind: 'task', origin: 'console', action, args: { taskId: TASK }, argsProvenance: {} });
        expect(r.statusCode, action).toBe(409);
        expect(r.json()).toEqual({ error: TASK_SAYS.off });
      }
      expect(h.lines.join('\n')).not.toContain(CANARY);
      expect(h.lines.some((l) => l.includes('task route refused'))).toBe(false);
      await h.app.close();
    }
    expect(touched).toBe(0);
  });

  it('over the wire no card is a job’s: a task card under a runtime origin is refused before anything reads it', async () => {
    const h = harness(untouchable);
    for (const action of [...TASK_SIGNED_ACTIONS, PAID_DISPATCH]) {
      const r = await h.call('POST', '/v1/proposals', { kind: 'task', origin: 'runtime:tasks', action, templateId: 'task.accept.v1', args: { taskId: TASK, checks: 1, met: 1, by: 'flint:rule' }, argsProvenance: {} });
      expect(r.statusCode, action).toBe(400);
      expect(r.json()).toEqual({ error: GOAL_SAYS.runtimeOrigin });
    }
    expect(touched).toBe(0);
    await h.app.close();
  });
});

describe.skipIf(NO_DB)('the task routes on flint_test', () => {
  let urls: TestUrls;
  let db: Db;
  let fx: TaskFixture;
  const bus = new FakeBus();
  let h: ReturnType<typeof harness>;
  const ok = async (method: 'GET' | 'POST', url: string, body?: unknown) => {
    const r = await h.call(method, url, body);
    expect(r.statusCode, `${method} ${url}: ${r.body}`).toBeLessThan(300);
    return r.json() as Record<string, unknown>;
  };
  /** Will signs a card in the console, and the server asks the runtime to carry it out. */
  const signRun = async (proposalId: string) => {
    await ok('POST', `/v1/proposals/${proposalId}/approve`, { approvalId: await fx.sign(proposalId) });
    return ok('POST', `/v1/proposals/${proposalId}/run`, {});
  };

  beforeAll(async () => {
    urls = await freshDb();
    db = createDb(urls.app);
    fx = await taskFixture(urls, db, bus);
    h = harness(db, { status: { problems: new Set(), busStartedAt: new Date(), bus } });
  });
  afterAll(async () => {
    await h?.app.close();
    await db?.$disconnect();
  });

  it('Settings and a task’s whole life over HTTP: turn the watcher on, create, dispatch, run, check, accept', async () => {
    expect(AssetsPage.parse(await ok('GET', '/v1/assets')).assets).toEqual([expect.objectContaining({ id: CI_WATCHER.id, on: false, canTurnOn: true })]);
    const on = TaskCardFiled.parse(await ok('POST', `/v1/assets/${CI_WATCHER.id}/on`, {}));
    expect(await signRun(on.proposalId)).toEqual({ assetId: CI_WATCHER.id, enabled: true });
    expect(AssetsPage.parse(await ok('GET', '/v1/assets')).assets[0]).toMatchObject({ on: true, waiting: false });

    const item = await fx.ciRun('wpf002/http', { status: 'completed', conclusion: 'success' });
    const filed = TaskFiled.parse(await ok('POST', '/v1/tasks', { draftKey: DRAFT, template: 'watch_ci', params: { item } }));
    expect(filed).toMatchObject({ id: TASK, deduped: false });
    expect(await signRun(filed.proposalId)).toMatchObject({ taskId: TASK });
    // The run's job went out on the process's bus, in the card's transaction.
    expect(bus.of('tasks.run').map((j) => j.data)).toEqual([{ taskId: TASK }]);
    await runTaskJob({ db, bus }, { taskId: TASK });
    await checkTaskJob({ db }, { taskId: TASK });
    const open = TaskAnswer.parse(await ok('GET', `/v1/tasks/${TASK}`)).task;
    expect(open).toMatchObject({ status: 'checking', line: 'It passed its checks and is waiting for you.', about: 'wpf002/http CI', result: 'The run passed.' });
    expect(await signRun(open.card!)).toMatchObject({ taskId: TASK, accepted: true });
    expect(TasksPage.parse(await ok('GET', '/v1/tasks?tab=finished')).tasks.map((t) => [t.id, t.status])).toEqual([[TASK, 'accepted']]);
    expect(TasksPage.parse(await ok('GET', '/v1/tasks')).tasks).toEqual([]);
  });

  it('every refusal is a sentence with its code; cancelling and overruling go through their routes', async () => {
    const say = async (method: 'GET' | 'POST', url: string, body: unknown, status: number, error: string, code: string) => {
      const r = await h.call(method, url, body);
      expect([r.statusCode, r.json()], `${method} ${url}`).toEqual([status, { error, code }]);
    };
    await say('GET', '/v1/tasks/tk0000000000000000', undefined, 404, TASK_SAYS.noTask, 'noTask');
    await say('POST', '/v1/tasks/tk0000000000000000/cancel', {}, 404, TASK_SAYS.noTask, 'noTask');
    await say('POST', `/v1/tasks/${TASK}/cancel`, {}, 409, TASK_STATUS_SAYS.accepted, 'status.accepted');
    await say('POST', `/v1/tasks/${TASK}/reject`, {}, 409, TASK_SAYS.decided, 'decided');
    await say('POST', `/v1/tasks/${TASK}/accept`, {}, 400, TASK_SAYS.notOverride, 'notOverride');
    await say('POST', '/v1/tasks', { draftKey: draft(), template: 'watch_ci', params: { item: 'no-such-item' } }, 409, TASK_SAYS.itemGone, 'itemGone');
    await say('POST', '/v1/tasks', { draftKey: draft(), template: 'draft_note', params: { about: 'A note' } }, 409, TASK_SAYS.cantRun, 'cantRun');
    await say('POST', `/v1/assets/${CI_WATCHER.id}/on`, {}, 400, TASK_SAYS.nothing, 'nothing');
    await say('POST', '/v1/assets/as-unknown-v1/on', {}, 404, TASK_SAYS.noAsset, 'noAsset');
    // The card route itself: a spend card that says no cost, and a task or spend card whose details hold a number
    // that is not whole, are each answered with a sentence (the database would refuse them, which is a 500).
    const filed = (body: Record<string, unknown>) => h.call('POST', '/v1/proposals', { origin: 'console', action: 'pay.vendor', argsProvenance: {}, ...body });
    for (const body of [{ kind: 'spend', args: { vendor: 'synthetic' } }, { kind: 'spend', args: { vendor: 'synthetic' }, estCostUsd: 0 }]) {
      const r = await filed(body);
      expect([r.statusCode, r.json()], JSON.stringify(body)).toEqual([400, { error: SPEND_NEEDS_ESTIMATE }]);
    }
    for (const body of [{ kind: 'spend', args: { vendor: 'synthetic', share: 0.5 }, estCostUsd: 1 }, { kind: 'task', args: { share: 0.5 } }]) {
      const r = await filed(body);
      expect([r.statusCode, r.json()], JSON.stringify(body)).toEqual([400, { error: WHOLE_NUMBERS_ONLY }]);
    }
    expect(await db.proposal.count({ where: { action: 'pay.vendor' } })).toBe(0);

    // Not gone out: cancelled there and then. Gone out: a card. A failed check: Accept Anyway is a card too.
    const item = await fx.ciRun('wpf002/http-two', { status: 'completed', conclusion: 'failure' });
    const a = TaskFiled.parse(await ok('POST', '/v1/tasks', { draftKey: draft(), template: 'watch_ci', params: { item } }));
    expect(await ok('POST', `/v1/tasks/${a.id}/cancel`, {})).toEqual({ ok: true });
    const b = TaskFiled.parse(await ok('POST', '/v1/tasks', { draftKey: draft(), template: 'watch_ci', params: { item } }));
    await signRun(b.proposalId);
    const cancel = TaskCardFiled.parse(await ok('POST', `/v1/tasks/${b.id}/cancel`, {}));
    await db.proposal.update({ where: { id: cancel.proposalId }, data: { status: 'rejected' } });
    await runTaskJob({ db, bus }, { taskId: b.id });
    await checkTaskJob({ db }, { taskId: b.id });
    const over = TaskCardFiled.parse(await ok('POST', `/v1/tasks/${b.id}/accept`, {}));
    expect(await signRun(over.proposalId)).toMatchObject({ taskId: b.id, to: 'accepted' });
    expect(TaskAnswer.parse(await ok('GET', `/v1/tasks/${b.id}`)).task).toMatchObject({ status: 'accepted', line: 'You accepted it.' });
  });

  it('the seven cards are never filed for chat, never claimed by the server, and never run while tasks are switched off', async () => {
    const item = await fx.ciRun('wpf002/http-chat');
    const t = TaskFiled.parse(await ok('POST', '/v1/tasks', { draftKey: draft(), template: 'watch_ci', params: { item } }));
    const args = (await db.proposal.findUniqueOrThrow({ where: { id: t.proposalId } })).args;
    for (const action of [...TASK_SIGNED_ACTIONS, PAID_DISPATCH]) {
      const r = await h.call('POST', '/v1/proposals', { kind: 'task', origin: 'chat:turn-1', action, args, argsProvenance: {} });
      expect([r.statusCode, r.json()], action).toEqual([409, { error: TASK_SAYS.fromConsole }]);
    }
    // Approved: it is the runtime's to carry out, not the server's to claim.
    await ok('POST', `/v1/proposals/${t.proposalId}/approve`, { approvalId: await fx.sign(t.proposalId) });
    const claim = await h.call('POST', `/v1/proposals/${t.proposalId}/claim`, {});
    expect([claim.statusCode, claim.json()]).toEqual([409, { error: 'task.dispatch.ci_runner is carried out by the runtime: use /run' }]);
    // Switched off after it was on: the card does not run and stays approved, and every task route
    // says so. Nothing is changed: the asset is as Will left it, and so is the task.
    const off = harness(db, { assets: false });
    const run = await off.call('POST', `/v1/proposals/${t.proposalId}/run`, {});
    expect([run.statusCode, run.json()]).toEqual([409, { error: TASK_SAYS.off }]);
    expect(await db.proposal.findUniqueOrThrow({ where: { id: t.proposalId } })).toMatchObject({ status: 'approved' });
    for (const [method, url, body] of [['GET', '/v1/tasks'], ['GET', '/v1/assets'], ['GET', `/v1/tasks/${t.id}`], ['POST', `/v1/tasks/${t.id}/cancel`, {}], ['POST', `/v1/assets/${CI_WATCHER.id}/off`, {}]] as typeof ROUTES) {
      const r = await off.call(method, url, body);
      expect([r.statusCode, r.json()], `${method} ${url}`).toEqual([409, { error: TASK_SAYS.off, code: 'off' }]);
    }
    expect(await db.asset.findUniqueOrThrow({ where: { id: CI_WATCHER.id } })).toMatchObject({ enabled: true });
    expect(await fx.task(t.id)).toMatchObject({ status: 'proposed' });
    await off.app.close();
    // Back on, and Will turns the asset off: the card fails with that sentence.
    expect(await ok('POST', `/v1/assets/${CI_WATCHER.id}/off`, {})).toEqual({ ok: true });
    const late = await h.call('POST', `/v1/proposals/${t.proposalId}/run`, {});
    expect([late.statusCode, late.json()]).toEqual([409, { error: TASK_SAYS.assetOff }]);
  });
});
