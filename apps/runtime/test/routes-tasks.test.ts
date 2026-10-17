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
import { AssetsPage, GOAL_SAYS, PAID_DISPATCH, TASK_SAYS, TASK_SIGNED_ACTIONS, TASK_STATUS_SAYS, TaskAnswer, TaskCardFiled, TaskFiled, TaskForm, TasksPage, digestOf } from '@flint/policy';
import { buildApp, type RuntimeStatus } from '../src/app';
import type { RuntimeScope } from '../src/config';
import { createDb, type Db } from '../src/db';
import { SPEND_NEEDS_ESTIMATE, WHOLE_NUMBERS_ONLY } from '../src/governance/proposals';
import { CI_WATCHER, LOCAL_REVIEWER, LOCAL_WORKER } from '../src/assets/registry';
import { checkTaskJob } from '../src/tasks/check';
import { runTaskJob } from '../src/tasks/run';
import { NO_DB, freshDb, id, withClient, type TestUrls } from './db';
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
  ['POST', `/v1/tasks/${TASK}/again`, { draftKey: 'n8Jr3MnP0qRs4tUw' }],
  ['GET', '/v1/task-form'],
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
      // Run Again takes the new task's key and nothing else: no template, no item, no id of its own choosing.
      ['POST', `/v1/tasks/${TASK}/again`, {}],
      ['POST', `/v1/tasks/${TASK}/again`, { draftKey: 'short' }],
      ['POST', `/v1/tasks/${TASK}/again`, { draftKey: DRAFT, params: { item: CANARY } }],
      ['POST', `/v1/tasks/${TASK}/again`, { draftKey: DRAFT, taskId: TASK }],
      ['POST', '/v1/tasks/nope/again', { draftKey: DRAFT }],
      ['GET', '/v1/task-form?kind=person'],
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
        ['POST', `/v1/tasks/${TASK}/again`, { draftKey: CANARY }],
        ['GET', '/v1/task-form?kind=person'],
      ];
      for (const [method, url, body] of sent) {
        const r = await h.call(method, url, body);
        expect([r.statusCode, r.json()], `${method} ${url}`).toEqual([409, { error: TASK_SAYS.off, code: 'off' }]);
        // Whether tasks are on is not told to a caller who may not ask.
        expect((await h.call(method, url, body, null)).statusCode, `${method} ${url}`).toBe(401);
        expect((await h.call(method, url, body, MCP)).statusCode, `${method} ${url}`).toBe(403);
      }
      // Nor a card under any other name of a task, an asset or a review, or the Hive's dispatch.
      for (const action of [...TASK_SIGNED_ACTIONS, PAID_DISPATCH, 'task.note', 'review.local', 'review.trident_panel', 'asset.disable', 'hive.dispatch_job']) {
        for (const origin of ['console', 'chat:turn-1']) {
          const r = await h.call('POST', '/v1/proposals', { kind: 'task', origin, action, args: { taskId: TASK }, argsProvenance: {} });
          expect(r.statusCode, `${action} from ${origin}`).toBe(409);
          expect(r.json()).toEqual({ error: TASK_SAYS.off });
        }
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
    // Every asset the registry holds has a row, each off. This runtime names no local model, so nothing of the
    // local worker's can be run (the form below offers none of its kinds), but Will can still turn the asset on.
    expect(AssetsPage.parse(await ok('GET', '/v1/assets')).assets).toEqual([
      expect.objectContaining({ id: CI_WATCHER.id, on: false, canTurnOn: true }),
      expect.objectContaining({ id: LOCAL_WORKER.id, on: false, canTurnOn: true }),
      expect.objectContaining({ id: LOCAL_REVIEWER.id, on: false, canTurnOn: true }),
    ]);
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

    // The New Task form is told what the watcher can watch, by label; and an ended task can be run again from its
    // own row: a new task of the same kind, with its own card for Will, and the first one as it ended.
    const offered = TaskForm.parse(await ok('GET', '/v1/task-form'));
    expect(offered.templates).toEqual([{ template: 'watch_ci', title: 'Watch a CI Run', runsOn: 'CI Watcher', items: [{ entityId: item, label: 'wpf002/http CI' }], more: false }]);
    expect(TaskAnswer.parse(await ok('GET', `/v1/tasks/${TASK}`)).task.can).toEqual({ cancel: false, accept: false, reject: false, again: true });
    const KEY = 'n8Jr3MnP0qRs4tUw';
    const again = TaskFiled.parse(await ok('POST', `/v1/tasks/${TASK}/again`, { draftKey: KEY }));
    expect(again).toMatchObject({ id: `tk${KEY}`, deduped: false });
    expect(TaskFiled.parse(await ok('POST', `/v1/tasks/${TASK}/again`, { draftKey: KEY }))).toEqual({ ...again, deduped: true });
    expect(TaskAnswer.parse(await ok('GET', `/v1/tasks/${again.id}`)).task).toMatchObject({ status: 'proposed', about: 'wpf002/http CI', card: again.proposalId, can: { cancel: true, again: false } });
    expect(TasksPage.parse(await ok('GET', '/v1/tasks?tab=finished')).tasks.map((t) => [t.id, t.status])).toEqual([[TASK, 'accepted']]);
    const going = await h.call('POST', `/v1/tasks/${again.id}/again`, { draftKey: draft() });
    expect([going.statusCode, going.json()]).toEqual([409, { error: TASK_STATUS_SAYS.proposed, code: 'status.proposed' }]);
    expect(await ok('POST', `/v1/tasks/${again.id}/cancel`, {})).toEqual({ ok: true });
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
    // An item the form would no longer list (it is archived): a task sent by hand about it is refused as Run Again is.
    const archived = await fx.entity('ci_run', { workflow: 'ci', status: 'completed' }, { name: 'Synthetic run, archived over HTTP' });
    await db.entity.update({ where: { id: archived }, data: { status: 'archived' } });
    await say('POST', '/v1/tasks', { draftKey: draft(), template: 'watch_ci', params: { item: archived } }, 409, TASK_SAYS.itemEnded, 'itemEnded');
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

  it('no card about a task, an asset or a review is a caller’s to claim or to report done; from chat no such name is filed; and chat’s token is handed no task’s forecast', async () => {
    await fx.watcherOn();
    const NOT_YET = { error: 'Flint can’t carry this out yet.' };
    const card = (pid: string) => db.proposal.findUniqueOrThrow({ where: { id: pid }, select: { status: true, result: true } });
    // A Hive dispatch from the console is an ordinary card that waits for Will. Signed, it is still nobody's to
    // claim: nothing carries it out, and reported done it would say whatever the caller said.
    const hive = await h.call('POST', '/v1/proposals', { kind: 'tool_call', origin: 'console', action: 'hive.dispatch_job', args: { pool: 'research', job: 'index' }, argsProvenance: {} });
    expect(hive.statusCode).toBe(201);
    const hiveId = (hive.json() as { id: string }).id;
    await ok('POST', `/v1/proposals/${hiveId}/approve`, { approvalId: await fx.sign(hiveId) });
    // Other names, written straight into the table as a caller with the database might: a dispatch that spends, a
    // review, and a name Flint does not know.
    const t = TaskFiled.parse(await ok('POST', '/v1/tasks', { draftKey: draft(), template: 'watch_ci', params: { item: await fx.ciRun('wpf002/http-claim') } }));
    const args = (await db.proposal.findUniqueOrThrow({ where: { id: t.proposalId } })).args as Record<string, unknown>;
    const planted = async (action: string, a: Record<string, unknown>, kind = 'task'): Promise<string> => {
      const pid = id('pr');
      await withClient(urls.app, (c) => c.query(
        `INSERT INTO "Proposal" (id, kind, origin, action, args, "argsDigest", "argsProvenance", tainted, sensitivity, consequential, "estCostUsd", "expiresAt")
         VALUES ($1, $2, 'console', $3, $4::jsonb, $5, '{}'::jsonb, false, 'ops', $6, $7, now() + interval '1 hour')`,
        [pid, kind, action, JSON.stringify(a), digestOf(a), kind === 'spend', kind === 'spend' ? 0.25 : null],
      ));
      return pid;
    };
    const others = [await planted('review.local', { taskId: t.id }), await planted('review.trident_panel', { taskId: t.id }), await planted('task.note', { taskId: t.id }), await planted('asset.disable', { assetId: CI_WATCHER.id })];
    for (const pid of [hiveId, ...others]) {
      const before = await card(pid);
      const claim = await h.call('POST', `/v1/proposals/${pid}/claim`, {});
      expect([claim.statusCode, claim.json()], pid).toEqual([409, NOT_YET]);
      const done = await h.call('POST', `/v1/proposals/${pid}/complete`, { ok: true, result: { anything: 'a caller says' } });
      expect([done.statusCode, done.json()], pid).toEqual([409, NOT_YET]);
      expect(await card(pid)).toEqual(before);
    }
    expect(await card(hiveId)).toEqual({ status: 'approved', result: null });
    // One of the seven is the runtime's own: reporting it done is refused too, as claiming it is.
    for (const step of ['claim', 'complete']) {
      const r = await h.call('POST', `/v1/proposals/${t.proposalId}/${step}`, step === 'complete' ? { ok: true, result: { taskId: t.id } } : {});
      expect([r.statusCode, r.json()], step).toEqual([409, { error: 'task.dispatch.ci_runner is carried out by the runtime: use /run' }]);
    }
    expect(await fx.task(t.id)).toMatchObject({ status: 'proposed' });
    // A card of any other kind is claimed and reported as before.
    const other = await h.call('POST', '/v1/proposals', { kind: 'tool_call', origin: 'console', action: 'mcp:web.fetch_url', args: { url: 'https://example.com/' }, argsProvenance: {} });
    const otherId = (other.json() as { id: string }).id;
    await ok('POST', `/v1/proposals/${otherId}/approve`, { approvalId: await fx.sign(otherId) });
    expect((await h.call('POST', `/v1/proposals/${otherId}/claim`, {})).statusCode).toBe(200);
    expect((await h.call('POST', `/v1/proposals/${otherId}/complete`, { ok: true, result: { status: 200 } })).statusCode).toBe(200);

    // From chat, no name of a task, an asset or a review is filed, known or not: in a sentence, and nothing is written.
    const names = ['task.note', 'task.cancel.v2', 'review.local', 'review.trident_panel', 'asset.disable', 'asset.enable.v2', 'hive.dispatch_job'];
    const filed = () => db.proposal.count({ where: { origin: { startsWith: 'chat:' } } });
    const chatBefore = await filed();
    for (const action of names) {
      const r = await h.call('POST', '/v1/proposals', { kind: 'tool_call', origin: 'chat:turn-7', action, args: { taskId: t.id, pool: 'research' }, argsProvenance: {} });
      expect([r.statusCode, r.json()], action).toEqual([409, { error: TASK_SAYS.fromConsole }]);
    }
    expect(await filed()).toBe(chatBefore);

    // A task that went out has a forecast on record, open. Chat's token reads open predictions, and is handed
    // none of a task's: not its row, and so not its task's id.
    await signRun(t.proposalId);
    const forecast = await db.prediction.findFirstOrThrow({ where: { createdBy: 'runtime:tasks', status: 'open', resolverSpec: { path: ['taskId'], equals: t.id } } });
    const mine = (await ok('POST', '/v1/ledger/predictions', { claim: 'the deploy finishes today', probability: 0.7, domain: 'assets', type: 'event_occurs', resolutionCriteria: 'Will says whether it did.', resolveBy: new Date(Date.now() + 86_400_000).toISOString(), method: 'model_reasoning', resolver: 'will', evidence: [], tainted: false })) as { id: string };
    // A rule of Will's that forbids watching a run: a new task and Run Again are each answered with a sentence and its
    // code, never the engine's words, and nothing is made. (Last here: the rule stays.)
    const KEY2 = draft();
    await fx.signRun((await fx.file('policy.change', { rows: [{ pattern: 'task.dispatch.ci_runner', tier: 'forbidden', expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString() }] }, { kind: 'policy', consequential: true })).id);
    for (const [url, body] of [['/v1/tasks', { draftKey: KEY2, template: 'watch_ci', params: { item: await fx.ciRun('wpf002/http-forbidden') } }], [`/v1/tasks/${TASK}/again`, { draftKey: KEY2 }]] as const) {
      for (let press = 0; press < 2; press++) {
        const r = await h.call('POST', url, body);
        expect([r.statusCode, r.json()], `${url} press ${press}`).toEqual([409, { error: 'A rule you set doesn’t allow this.', code: 'ruleForbids' }]);
        expect(r.body).not.toContain('ActionPolicy');
      }
    }
    expect(await db.task.findUnique({ where: { id: `tk${KEY2}` } })).toBeNull();
    for (const token of [MCP, SERVER]) {
      const open = await h.call('GET', '/v1/ledger/open?limit=200', undefined, token);
      expect(open.statusCode).toBe(200);
      const rows = (open.json() as { predictions: Array<{ id: string; createdBy: string; type: string }> }).predictions;
      expect(rows.some((p) => p.id === mine.id), 'an ordinary prediction in the assets domain is listed').toBe(true);
      expect(rows.filter((p) => p.createdBy === 'runtime:tasks' || p.type === 'task_meets_bar')).toEqual([]);
      expect(open.body).not.toContain(forecast.id);
      expect(open.body).not.toContain(t.id);
    }
  });
});
