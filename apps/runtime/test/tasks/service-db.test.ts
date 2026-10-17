/**
 * What the Tasks panel and Settings > Assets do, on flint_test (P5).
 *
 *  - Settings: each asset with whether it is on, whether its card waits, and
 *    one sentence; the CI watcher waits for the GitHub source.
 *  - A new task is its template and its items, nothing else: every refusal is
 *    a sentence, and nothing is written for a form that is refused. The same
 *    form sent twice is one task and one card.
 *  - Cancelling a task that has not gone out needs no signature and turns its
 *    waiting card away; one that has gone out gets a card.
 *  - The panel's rows and the open task: a title of fixed words, what it is
 *    about by an item's label, a line made from counts, the checks by name,
 *    the forecast from its prediction, and what Will can do next.
 *  - Run Again makes a new task like one that has ended, through the same
 *    checks a new task goes through, with its own card; the New Task form is
 *    offered only what an asset that is on can run, items by label alone.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AssetEnableArgs, AssetsPage, TASK_FORM_ITEMS_MAX, TASK_SAYS, TASK_STATUS_SAYS, TASK_TEMPLATE_IDS, TaskAnswer, TaskForm, TaskSpec, TasksPage, noteProblems, titleCase } from '@flint/policy';
import { HEX, NO_DB, freshDb, id, type TestUrls } from '../db';
import { createDb, type Db } from '../../src/db';
import { Forbidden, Refused } from '../../src/governance/proposals';
import { ASSETS, CI_WATCHER, LOCAL_REVIEWER, LOCAL_WORKER, assetDef, assetFor, enableArgsOf, sameAsset } from '../../src/assets/registry';
import { fileEnable, known, syncAssets, turnOff } from '../../src/assets/service';
import { WAITING, assetsPage } from '../../src/assets/view';
import { checkTaskJob } from '../../src/tasks/check';
import { runTaskJob } from '../../src/tasks/run';
import { ciWatch } from '../../src/tasks/adapters/ci-watch';
import type { TaskAdapter } from '../../src/tasks/adapters/types';
import { DUE_MAX_MS, TASK_TITLES, againProblem, cancelTask, createTask, overrideTask, runAgain } from '../../src/tasks/service';
import { FORM_ITEM_KINDS, WORK_ITEM_KINDS, aboutProblem, offerProblem } from '../../src/tasks/offer';
import { taskForm, taskView, tasksPage } from '../../src/tasks/view';
import { DAY, FakeBus, SHA, draft, taskFixture, type TaskFixture } from './fixture';

/** A stand-in for the local worker's adapter: this file tests what is offered, never what a model answers. */
const stubWorker: TaskAdapter = { kind: 'local_worker', estimate: () => 0, run: async () => ({ failure: 'unavailable' }) };

const refusal = async (p: Promise<unknown>): Promise<Refused> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof Refused) return e;
    throw e;
  }
  throw new Error('expected a refusal, got success');
};

describe('the asset registry, before the database', () => {
  it('is a closed list: the CI watcher, the local worker and Local Reviews, each calling nothing off this Mac and costing nothing; every name and sentence is fit to show', () => {
    expect(ASSETS).toEqual([CI_WATCHER, LOCAL_WORKER, LOCAL_REVIEWER]);
    // Local Reviews runs no task: it reviews cards, handed its work under review.local.
    expect(LOCAL_REVIEWER).toMatchObject({ kind: 'local_reviewer', externalRef: 'ollama:review:v1', name: 'Local Reviews', capabilities: ['review'], dispatchAction: 'review.local', spends: false, entityId: null });
    expect(AssetEnableArgs.safeParse(enableArgsOf(LOCAL_REVIEWER)).success).toBe(true);
    expect(CI_WATCHER).toMatchObject({ kind: 'ci_runner', externalRef: 'github:ci:v1', capabilities: ['watch_ci'], dispatchAction: 'task.dispatch.ci_runner', spends: false });
    expect(LOCAL_WORKER).toMatchObject({
      kind: 'local_worker', externalRef: 'ollama:local:v1', capabilities: ['summarize_items', 'sort_items', 'draft_note'], dispatchAction: 'task.dispatch.local_worker', spends: false, entityId: null,
    });
    // Nothing any asset does spends, and none stands for one item of Will's.
    for (const a of ASSETS) expect([a.spends, a.entityId], a.id).toEqual([false, null]);
    for (const a of ASSETS) {
      expect(noteProblems(a.name, a.line), a.id).toEqual([]);
      expect(a.id).toMatch(/^[a-z0-9-]{1,40}$/);
    }
    expect(noteProblems('A Title', WAITING)).toEqual([]);
    for (const title of Object.values(TASK_TITLES)) expect(titleCase(title), title).toBe(title);
    expect(assetDef(CI_WATCHER.id)).toBe(CI_WATCHER);
    expect(assetDef('nope')).toBeUndefined();
    expect(assetFor('watch_ci')).toBe(CI_WATCHER);
    // The three kinds of task that need words run on the local worker, and nothing else runs them.
    for (const t of ['summarize_items', 'sort_items', 'draft_note'] as const) expect(assetFor(t), t).toBe(LOCAL_WORKER);
    expect(assetDef(LOCAL_WORKER.id)).toBe(LOCAL_WORKER);
    // Will signs what the local worker is, too, its list of what it can do in that order.
    const worker = { kind: 'local_worker', externalRef: 'ollama:local:v1', name: 'Local Worker', capabilities: ['summarize_items', 'sort_items', 'draft_note'], dispatchAction: 'task.dispatch.local_worker', spends: false, entityId: null };
    expect(enableArgsOf(LOCAL_WORKER)).toEqual({ assetId: LOCAL_WORKER.id, ...worker });
    expect(AssetEnableArgs.safeParse(enableArgsOf(LOCAL_WORKER)).success).toBe(true);
    expect(sameAsset(LOCAL_WORKER, { ...worker, capabilities: ['sort_items', 'summarize_items', 'draft_note'] })).toBe(false);
    // An asset is exactly its definition: a changed list of what it can do, or its order, is another asset.
    const facts = { kind: 'ci_runner', externalRef: 'github:ci:v1', name: 'CI Watcher', capabilities: ['watch_ci'], dispatchAction: 'task.dispatch.ci_runner', spends: false, entityId: null as string | null };
    expect(sameAsset(CI_WATCHER, facts)).toBe(true);
    // What Will signs for it is exactly that, the item it stands for included (none).
    expect(enableArgsOf(CI_WATCHER)).toEqual({ assetId: CI_WATCHER.id, ...facts });
    expect(AssetEnableArgs.safeParse(enableArgsOf(CI_WATCHER)).success).toBe(true);
    for (const over of [{ capabilities: ['watch_ci', 'more'] }, { capabilities: [] }, { name: 'CI' }, { spends: true }, { externalRef: 'github:ci:v2' }, { kind: 'local_worker' }, { dispatchAction: 'review.local' }, { entityId: 'en1' }]) {
      expect(sameAsset(CI_WATCHER, { ...facts, ...over }), JSON.stringify(over)).toBe(false);
    }
    expect(known({ id: CI_WATCHER.id, ...facts })).toBe(CI_WATCHER);
    expect(known({ id: CI_WATCHER.id, ...facts, name: 'Other' })).toBeUndefined();
    expect(known({ id: 'as-other', ...facts })).toBeUndefined();
  });
});

describe.skipIf(NO_DB)('the Tasks panel’s writes and views on flint_test', () => {
  let urls: TestUrls;
  let db: Db;
  let fx: TaskFixture;
  const bus = new FakeBus();
  const form = (item: string, over: Record<string, unknown> = {}) => ({ draftKey: draft(), template: 'watch_ci' as const, params: { item } as Record<string, unknown>, goalId: null, dueAt: null, ownCheck: null, ...over });
  const counts = async () => ({ tasks: await db.task.count(), cards: await db.proposal.count({ where: { action: { startsWith: 'task.' } } }) });

  beforeAll(async () => {
    urls = await freshDb();
    db = createDb(urls.app);
    fx = await taskFixture(urls, db, bus, { source: false });
  });
  afterAll(async () => db?.$disconnect());

  it('Settings: the CI watcher is off, waits for the GitHub source, then for Will’s card, then is on', async () => {
    const page = async () => AssetsPage.parse(await assetsPage(db));
    const row = { id: CI_WATCHER.id, name: 'CI Watcher', kind: 'ci_runner', costs: false };
    // Every asset the registry holds has a row, each off; this test is the CI watcher's.
    const worker = { id: LOCAL_WORKER.id, name: 'Local Worker', kind: 'local_worker', costs: false, on: false, waiting: false, canTurnOn: true, line: LOCAL_WORKER.line };
    const reviews = { id: LOCAL_REVIEWER.id, name: 'Local Reviews', kind: 'local_reviewer', costs: false, on: false, waiting: false, canTurnOn: true, line: LOCAL_REVIEWER.line };
    const others = async () => (await page()).assets.filter((a) => a.id !== CI_WATCHER.id);
    // The row is made by the first read, off. Until the GitHub source is on it says what it needs.
    expect(await page()).toEqual({ assets: [{ ...row, on: false, waiting: false, canTurnOn: false, line: TASK_SAYS.needsGithub }, worker, reviews], reviewsRequired: false });
    expect(await others()).toEqual([worker, reviews]);
    expect(await refusal(fileEnable(db, CI_WATCHER.id))).toMatchObject({ status: 409, message: TASK_SAYS.needsGithub });
    await fx.sourceOn();
    const watcher = async () => (await page()).assets.filter((a) => a.id === CI_WATCHER.id);
    expect(await watcher()).toEqual([{ ...row, on: false, waiting: false, canTurnOn: true, line: CI_WATCHER.line }]);
    const filed = await fileEnable(db, CI_WATCHER.id);
    expect(await watcher()).toEqual([{ ...row, on: false, waiting: true, canTurnOn: false, line: WAITING }]);
    await fx.signRun(filed.proposalId);
    expect(await watcher()).toEqual([{ ...row, on: true, waiting: false, canTurnOn: false, line: CI_WATCHER.line }]);
    // One asset waiting for a card, or on, says nothing about another: the others' rows are untouched.
    expect(await others()).toEqual([worker, reviews]);
    // Turning it off needs no signature and is on record by id.
    await turnOff(db, CI_WATCHER.id);
    expect((await watcher())[0]).toMatchObject({ on: false, canTurnOn: true, line: CI_WATCHER.line });
    const off = await db.auditEntry.findFirstOrThrow({ where: { action: 'asset.disable' } });
    expect(off).toMatchObject({ actor: 'will:console', kind: 'action', outcome: 'ok', correlationId: `asset:${CI_WATCHER.id}` });
    expect(off.inputs).toEqual({ assetId: CI_WATCHER.id });
    expect(await refusal(turnOff(db, 'as-unknown-v1'))).toMatchObject({ status: 404, message: TASK_SAYS.noAsset });
    // A row the registry does not describe is left out: nothing can run on it.
    await syncAssets(db, [{ ...CI_WATCHER, id: 'as-stray-v1', externalRef: 'github:ci:stray' }]);
    expect((await page()).assets.map((a) => a.id)).toEqual([CI_WATCHER.id, LOCAL_WORKER.id, LOCAL_REVIEWER.id]);
    await fx.watcherOn();
  });

  it('a new task is its template and its items: every refusal is a sentence, and a refused form writes nothing', async () => {
    const ci = await fx.ciRun('wpf002/new');
    const before = await counts();
    const pr = await fx.entity('pull_request', { number: 3, state: 'open' });
    const person = await fx.person();
    const forgotten = await fx.entity('ci_run', { workflow: 'ci', status: 'queued' });
    await fx.forget(forgotten);
    const no = async (over: Record<string, unknown>, status: number, say: string) => expect(await refusal(createTask(db, form(ci, over) as Parameters<typeof createTask>[1])), JSON.stringify(over)).toMatchObject({ status, message: say });
    await no({ ownCheck: 'It reads clearly.' }, 400, TASK_SAYS.ownCheck);
    await no({ params: { item: ci, command: 'ls' } }, 400, TASK_SAYS.invalid);
    await no({ params: {} }, 400, TASK_SAYS.invalid);
    await no({ params: { item: 'no-such-item' } }, 409, TASK_SAYS.itemGone);
    await no({ params: { item: forgotten } }, 409, TASK_SAYS.itemGone);
    await no({ params: { item: person } }, 400, TASK_SAYS.person);
    await no({ params: { item: pr } }, 400, TASK_SAYS.wrongItem);
    await no({ dueAt: new Date(Date.now() - 60_000).toISOString() }, 400, TASK_SAYS.due);
    await no({ dueAt: new Date(Date.now() + DUE_MAX_MS + DAY).toISOString() }, 400, TASK_SAYS.due);
    await no({ goalId: 'gonosuchgoal0001' }, 404, TASK_SAYS.noGoal);
    // An item that is no longer active, or a goal that is not, is one the form would not list: a task sent by hand
    // about one is refused with the sentence Run Again gives.
    const archived = await fx.entity('ci_run', { workflow: 'ci', status: 'completed' }, { name: 'Synthetic run, archived' });
    await db.entity.update({ where: { id: archived }, data: { status: 'archived' } });
    expect((await taskForm(db, 'UTC')).templates[0]!.items.some((i) => i.entityId === archived)).toBe(false);
    await no({ params: { item: archived } }, 409, TASK_SAYS.itemEnded);
    const paused = `go${draft()}`;
    const g = await fx.file('goal.activate', {
      goalId: paused, title: 'Synthetic goal, paused', description: '', horizonAt: new Date(Date.now() + 30 * DAY).toISOString(), reviewCadence: 'P1W',
      successCriteria: [{ id: 'c1', text: 'Synthetic check', check: { kind: 'manual' } }], links: [], plan: null,
    }, { kind: 'goal', argsProvenance: { args: { source: 'will', tainted: false } }, sensitivity: 'personal' });
    await fx.signRun(g.id);
    await db.goal.updateMany({ where: { id: paused }, data: { status: 'paused' } });
    expect((await taskForm(db, 'UTC')).goals.some((x) => x.id === paused)).toBe(false);
    await no({ goalId: paused }, 409, TASK_SAYS.goalEnded);
    // (The item made active again is taken: the refusal above was about where it stood. And the rule itself, read
    // directly: the item alone is fine, the paused goal is why.)
    await db.entity.update({ where: { id: archived }, data: { status: 'active' } });
    const about = TaskSpec.parse({ template: 'watch_ci', params: { item: archived } });
    expect(await aboutProblem(db, about, null)).toBeUndefined();
    expect(await aboutProblem(db, about, paused)).toBe(TASK_SAYS.goalEnded);
    await no({ params: { item: archived }, goalId: paused }, 409, TASK_SAYS.goalEnded);
    // No asset runs these templates yet; over 12 items is said as that.
    await no({ template: 'summarize_items', params: { items: [ci] } }, 409, TASK_SAYS.cantRun);
    await no({ template: 'summarize_items', params: { items: Array.from({ length: 13 }, (_, i) => `e${i}`) } }, 400, TASK_SAYS.tooMany);
    await no({ template: 'draft_note', params: { about: 'A note' } }, 409, TASK_SAYS.cantRun);
    // A registry that names an asset with no adapter behind it runs nothing either.
    expect(await refusal(createTask(db, form(ci), { adapters: {} }))).toMatchObject({ status: 409, message: TASK_SAYS.cantRun });
    expect(await counts()).toEqual(before);

    // The same form sent twice: one task, one card.
    const f = form(ci, { dueAt: new Date(Date.now() + 2 * DAY).toISOString() });
    const first = await createTask(db, f);
    expect(first).toMatchObject({ id: `tk${f.draftKey}`, deduped: false });
    expect(await createTask(db, f)).toEqual({ ...first, deduped: true });
    expect(await counts()).toEqual({ tasks: before.tasks + 1, cards: before.cards + 1 });
    // The same form sent five times at once (a double tap, a retry that crossed its answer): still one task and one
    // card. One of the five made them; the others found them.
    const twice = form(await fx.ciRun('wpf002/at-once'));
    const race = await Promise.all(Array.from({ length: 5 }, () => createTask(db, twice)));
    expect(new Set(race.map((r) => r.id))).toEqual(new Set([`tk${twice.draftKey}`]));
    expect(new Set(race.map((r) => r.proposalId)).size).toBe(1);
    expect(race.filter((r) => !r.deduped)).toHaveLength(1);
    expect(await counts()).toEqual({ tasks: before.tasks + 2, cards: before.cards + 2 });
    expect(await db.auditEntry.count({ where: { correlationId: `task:tk${twice.draftKey}`, action: 'task.create' } })).toBe(1);
    expect(await fx.task(first.id)).toMatchObject({ title: 'Watch a CI Run', dueAt: new Date(String(f.dueAt)), goalId: null, stepKey: null, origin: 'will' });
    const made = await db.auditEntry.findFirstOrThrow({ where: { correlationId: `task:${first.id}`, action: 'task.create' } });
    expect(made.inputs).toEqual({ taskId: first.id, assetId: CI_WATCHER.id, template: 'watch_ci' });
    // The same key with another task in it is not the task Will was shown.
    expect(await refusal(createTask(db, { ...f, params: { item: ci, sha: SHA.slice(0, 8) } }))).toMatchObject({ status: 409, message: TASK_SAYS.changed });
    // Once it has gone out, its form is spent.
    await fx.signRun(first.proposalId);
    expect(await refusal(createTask(db, f))).toMatchObject({ status: 409, message: TASK_STATUS_SAYS.queued });
  });

  it('cancelling a task that has not gone out needs no signature and turns its waiting card away; one that has gone out gets a card', async () => {
    const t = await fx.newTask(await fx.ciRun('wpf002/cancel-proposed'));
    expect(await cancelTask(db, t.id)).toEqual({ ok: true });
    expect(await fx.task(t.id)).toMatchObject({ status: 'cancelled', dispatchApprovalId: null });
    expect(await db.proposal.findUniqueOrThrow({ where: { id: t.proposalId } })).toMatchObject({ status: 'rejected', error: TASK_STATUS_SAYS.cancelled, approvalId: null });
    // On record under its own name: it is not the signed cancellation, which is for a task that went out.
    const entry = await db.auditEntry.findFirstOrThrow({ where: { correlationId: `task:${t.id}`, action: 'task.withdraw' } });
    expect(entry).toMatchObject({ actor: 'will:console', kind: 'action', outcome: 'ok' });
    expect(entry.inputs).toEqual({ taskId: t.id, why: 'will' });
    expect(await db.auditEntry.count({ where: { correlationId: `task:${t.id}`, action: 'task.cancel' } })).toBe(0);
    // Done once; a task that is not there is said so.
    expect(await refusal(cancelTask(db, t.id))).toMatchObject({ status: 409, message: TASK_STATUS_SAYS.cancelled });
    expect(await refusal(cancelTask(db, 'tk0000000000000000'))).toMatchObject({ status: 404, message: TASK_SAYS.noTask });
    // One that went out: a card, the same one while it waits; the task runs on until he signs.
    const out = await fx.dispatched(await fx.ciRun('wpf002/cancel-out'));
    const card = (await cancelTask(db, out.id)) as { proposalId: string; deduped: boolean };
    expect(card.deduped).toBe(false);
    expect(await cancelTask(db, out.id)).toEqual({ proposalId: card.proposalId, deduped: true });
    expect(await fx.task(out.id)).toMatchObject({ status: 'queued' });
    await fx.signRun(card.proposalId);
    expect(await fx.task(out.id)).toMatchObject({ status: 'cancelled' });
    // An override is filed the same way, and only where there is a check to overrule.
    expect(await refusal(overrideTask(db, out.id, 'accepted'))).toMatchObject({ status: 409, message: TASK_STATUS_SAYS.cancelled });
    expect(await refusal(overrideTask(db, 'tk0000000000000000', 'accepted'))).toMatchObject({ status: 404, message: TASK_SAYS.noTask });
  });

  it('the panel: rows with a title of fixed words, what each is about, and a line from counts; the open task with its checks, forecast and what Will can do', async () => {
    const item = await fx.ciRun('wpf002/panel', { status: 'in_progress' });
    const t = await fx.newTask(item);
    const open = async () => TaskAnswer.parse({ task: await taskView(db, t.id, 'UTC') }).task;
    const row = async (tab: 'active' | 'finished') => TasksPage.parse(await tasksPage(db, tab, 'UTC')).tasks.find((r) => r.id === t.id);
    expect(await taskView(db, 'tk0000000000000000', 'UTC')).toBeUndefined();

    expect(await row('active')).toMatchObject({ title: 'Watch a CI Run', about: 'wpf002/panel CI', status: 'proposed', line: 'It’s waiting for your approval.', runsOn: 'CI Watcher', outside: false, costs: false });
    expect(await row('finished')).toBeUndefined();
    expect(await open()).toMatchObject({
      result: null, checks: [{ id: 'a1', name: 'CI Run Passed', state: 'waiting' }, { id: 'a2', name: 'Names Only Your Items', state: 'waiting' }], checkedBy: null, askedBy: 'you', goalId: null, dueAt: null, chance: null, cost: null,
      card: t.proposalId, can: { cancel: true, accept: false, reject: false },
    });
    await fx.signRun(t.proposalId);
    expect(await open()).toMatchObject({ status: 'queued', line: 'It’s next in line.', chance: { likelihood: 'about_even', percent: 50 }, card: null });
    await runTaskJob({ db, bus }, { taskId: t.id });
    expect(await open()).toMatchObject({ status: 'dispatched', line: 'Flint is watching for the run.' });
    await fx.ciRun('wpf002/panel', { status: 'completed', conclusion: 'success' });
    await runTaskJob({ db, bus }, { taskId: t.id });
    // A result is outside text from the moment there is one.
    expect(await open()).toMatchObject({ status: 'submitted', line: 'Flint is checking the result.', result: 'The run passed.', outside: true });
    await checkTaskJob({ db }, { taskId: t.id });
    const accept = (await fx.cardFor('task.check_bar', t.id))!;
    expect(await open()).toMatchObject({
      status: 'checking', line: 'It passed its checks and is waiting for you.', checks: [{ id: 'a1', name: 'CI Run Passed', state: 'passed' }, { id: 'a2', name: 'Names Only Your Items', state: 'passed' }], checkedBy: 'rules',
      card: accept.id, can: { cancel: true, accept: false, reject: true },
    });
    await fx.signRun(accept.id);
    // Accepted on his own card: his answer, and final.
    expect(await open()).toMatchObject({ status: 'accepted', line: 'It passed 2 of 2 checks.', card: null, can: { cancel: false, accept: false, reject: false } });
    expect(await row('active')).toBeUndefined();
    expect(await row('finished')).toMatchObject({ status: 'accepted', about: 'wpf002/panel CI' });

    // One that failed its check: Flint rejected it, and Will may accept it anyway, once.
    const red = await fx.checked('wpf002/panel-red', 'failure');
    const failed = TaskAnswer.parse({ task: await taskView(db, red, 'UTC') }).task;
    expect(failed).toMatchObject({ status: 'rejected', line: 'It failed 1 of 2 checks.', result: 'The run failed.', checks: [{ id: 'a1', name: 'CI Run Passed', state: 'failed' }, { id: 'a2', name: 'Names Only Your Items', state: 'passed' }], can: { cancel: false, accept: true, reject: false } });
    await fx.signRun((await overrideTask(db, red, 'accepted')).proposalId);
    expect(TaskAnswer.parse({ task: await taskView(db, red, 'UTC') }).task).toMatchObject({ status: 'accepted', line: 'You accepted it.', checkedBy: 'you', can: { accept: false, reject: false } });
    // A task about an item that was forgotten says nothing of it.
    const own = await fx.entity('ci_run', { workflow: 'ci', status: 'queued' });
    const gone = await fx.newTask(own);
    await fx.forget(own);
    const after = TaskAnswer.parse({ task: await taskView(db, gone.id, 'UTC') }).task;
    expect(after).toMatchObject({ about: null, checks: [], title: 'Watch a CI Run' });
    // The pages are bounded, newest first.
    const active = TasksPage.parse(await tasksPage(db, 'active', 'UTC'));
    expect(active.more).toBe(false);
    expect(active.tasks.map((r) => r.createdAt)).toEqual([...active.tasks.map((r) => r.createdAt)].sort().reverse());
  });

  it('Run Again: a new task like one that ended, with its own card; never for one still going, one that is gone, or one whose details are cleared', async () => {
    const goal = `go${draft()}`;
    const g = await fx.file('goal.activate', {
      goalId: goal, title: 'Synthetic goal for a task', description: '', horizonAt: new Date(Date.now() + 30 * DAY).toISOString(), reviewCadence: 'P1W',
      successCriteria: [{ id: 'c1', text: 'Synthetic check', check: { kind: 'manual' } }], links: [], plan: null,
    }, { kind: 'goal', argsProvenance: { args: { source: 'will', tainted: false } }, sensitivity: 'personal' });
    await fx.signRun(g.id);
    const item = await fx.ciRun('wpf002/again', { status: 'in_progress' });
    const first = await fx.newTask(item, { goalId: goal, dueAt: new Date(Date.now() + 2 * DAY).toISOString(), params: { item, sha: SHA.slice(0, 8) } });
    const can = async (taskId: string) => TaskAnswer.parse({ task: await taskView(db, taskId, 'UTC') }).task.can.again;
    const before = await counts();
    // While it is going there is nothing to run again: said as where it stands, and nothing is written.
    expect(await can(first.id)).toBe(false);
    expect(await refusal(runAgain(db, first.id, draft()))).toMatchObject({ status: 409, message: TASK_STATUS_SAYS.proposed });
    await fx.signRun(first.proposalId);
    expect(await refusal(runAgain(db, first.id, draft()))).toMatchObject({ status: 409, message: TASK_STATUS_SAYS.queued });
    expect(await refusal(runAgain(db, 'tk0000000000000000', draft()))).toMatchObject({ status: 404, message: TASK_SAYS.noTask });
    expect(await counts()).toEqual({ tasks: before.tasks, cards: before.cards });
    await fx.signRun(((await cancelTask(db, first.id)) as { proposalId: string }).proposalId);
    expect(await fx.task(first.id)).toMatchObject({ status: 'cancelled' });
    expect(await can(first.id)).toBe(true);

    // Ended: the same template, items and goal, no due time, a task of Will's, and its own card that waits for him.
    const key = draft();
    const again = await runAgain(db, first.id, key);
    expect(again).toMatchObject({ id: `tk${key}`, deduped: false });
    expect(again.id).not.toBe(first.id);
    const [was, now] = [await fx.task(first.id), await fx.task(again.id)];
    expect(now).toMatchObject({ status: 'proposed', origin: 'will', goalId: goal, stepKey: null, dueAt: null, title: was.title, assetId: was.assetId, entityIds: was.entityIds });
    expect(now.spec).toEqual(was.spec);
    expect(now.acceptance).toEqual(was.acceptance);
    const card = await db.proposal.findUniqueOrThrow({ where: { id: again.proposalId } });
    expect(card).toMatchObject({ action: 'task.dispatch.ci_runner', origin: 'console', status: 'pending', approvalId: null });
    expect(card.args).toMatchObject({ taskId: again.id, goalId: goal, dueAt: null, spec: was.spec });
    // The button pressed twice is one task and one card; the first task is as it ended.
    expect(await runAgain(db, first.id, key)).toEqual({ ...again, deduped: true });
    expect(await counts()).toEqual({ tasks: before.tasks + 1, cards: before.cards + 2 });
    expect(await fx.task(first.id)).toMatchObject({ status: 'cancelled' });
    // The key of a task that already went another way is not a new task.
    expect(await refusal(runAgain(db, first.id, first.id.slice(2)))).toMatchObject({ status: 409, message: TASK_STATUS_SAYS.cancelled });

    // It goes through what a new task goes through, as things are now: an asset that was turned off is said so.
    await turnOff(db, CI_WATCHER.id);
    expect(await refusal(runAgain(db, first.id, draft()))).toMatchObject({ status: 409, message: TASK_SAYS.assetOff });
    await fx.watcherOn();
    // Details that are cleared (here: its item was forgotten) cannot run again, and the view does not offer it.
    const own = await fx.entity('ci_run', { workflow: 'ci', status: 'queued' });
    const gone = await fx.newTask(own);
    await cancelTask(db, gone.id);
    expect(await can(gone.id)).toBe(true);
    await fx.forget(own);
    expect((await fx.task(gone.id)).spec).toBeNull();
    expect(await can(gone.id)).toBe(false);
    const tasks = await db.task.count();
    expect(await refusal(runAgain(db, gone.id, draft()))).toMatchObject({ status: 409, message: TASK_SAYS.detailsGone });
    expect(await db.task.count()).toBe(tasks);
  });

  it('Run Again is held to what New Task would offer today, and to tasks Will asked for: otherwise the view does not offer it and the route says why', async () => {
    const view = async (taskId: string) => TaskAnswer.parse({ task: await taskView(db, taskId, 'UTC') }).task;
    const ended = async (item: string, over: Record<string, unknown> = {}) => {
      const t = await fx.newTask(item, over);
      await cancelTask(db, t.id);
      return t.id;
    };
    const no = async (taskId: string, say: string) => {
      const before = await counts();
      expect((await view(taskId)).can.again, say).toBe(false);
      expect(await refusal(runAgain(db, taskId, draft())), say).toMatchObject({ status: 409, message: say });
      expect(await counts(), say).toEqual(before);
    };
    // One Flint asked for is not Will's to run again from here. (Its origin is the database's to keep: only its owner, with the guard set aside, can say otherwise.)
    const flints = await ended(await fx.ciRun('wpf002/again-flint'));
    expect((await view(flints)).can.again).toBe(true);
    await fx.owner(`DO $$ BEGIN
      ALTER TABLE "Task" DISABLE TRIGGER "Task_guard";
      UPDATE "Task" SET origin = 'flint' WHERE id = '${flints.replace(/[^A-Za-z0-9]/g, '')}';
      ALTER TABLE "Task" ENABLE TRIGGER "Task_guard";
    END $$`);
    expect((await view(flints)).askedBy).toBe('flint');
    await no(flints, TASK_SAYS.flintAsked);

    // Its item is no longer one the form would list: archived, or no longer the kind this task is about.
    const own = await fx.entity('ci_run', { workflow: 'ci', status: 'completed' }, { name: 'Synthetic run to archive' });
    const archived = await ended(own);
    expect((await view(archived)).can.again).toBe(true);
    await db.entity.update({ where: { id: own }, data: { status: 'archived' } });
    expect((await taskForm(db, 'UTC')).templates[0]!.items.some((i) => i.entityId === own)).toBe(false);
    await no(archived, TASK_SAYS.itemEnded);
    await db.entity.update({ where: { id: own }, data: { status: 'active' } });
    expect((await view(archived)).can.again).toBe(true);

    // Its goal is no longer one the form would list.
    const goal = `go${draft()}`;
    const g = await fx.file('goal.activate', {
      goalId: goal, title: 'Synthetic goal to pause', description: '', horizonAt: new Date(Date.now() + 30 * DAY).toISOString(), reviewCadence: 'P1W',
      successCriteria: [{ id: 'c1', text: 'Synthetic check', check: { kind: 'manual' } }], links: [], plan: null,
    }, { kind: 'goal', argsProvenance: { args: { source: 'will', tainted: false } }, sensitivity: 'personal' });
    await fx.signRun(g.id);
    const withGoal = await ended(await fx.ciRun('wpf002/again-goal'), { goalId: goal });
    expect((await view(withGoal)).can.again).toBe(true);
    await db.goal.updateMany({ where: { id: goal }, data: { status: 'paused' } });
    expect((await taskForm(db, 'UTC')).goals.some((x) => x.id === goal)).toBe(false);
    await no(withGoal, TASK_SAYS.goalEnded);

    // Its asset is off, or nothing is behind it to run it: the form offers no such task, and neither does the button.
    const plain = await ended(await fx.ciRun('wpf002/again-plain'));
    const row = await fx.task(plain);
    expect(await againProblem(db, row)).toBeUndefined();
    expect(await againProblem(db, row, { adapters: {} })).toBe(TASK_SAYS.cantRun);
    expect(await againProblem(db, row, { registry: [] })).toBe(TASK_SAYS.cantRun);
    expect(await againProblem(db, row, { registry: [{ ...CI_WATCHER, name: 'Another Name' }] })).toBe(TASK_SAYS.assetOff);
    await turnOff(db, CI_WATCHER.id);
    await no(plain, TASK_SAYS.assetOff);
    await fx.watcherOn();
    expect((await view(plain)).can.again).toBe(true);
    // The rules are the form's own: one table says which items each kind of task is about, and both read it. Every
    // kind of task has its entry, so adding one is a change here too.
    expect(Object.keys(FORM_ITEM_KINDS).sort()).toEqual([...TASK_TEMPLATE_IDS].sort());
    expect(FORM_ITEM_KINDS.watch_ci).toEqual(['ci_run']);
    expect(FORM_ITEM_KINDS.summarize_items).toBe(WORK_ITEM_KINDS);
    const spec = { template: 'watch_ci' as const, params: { item: 'no-such-item', sha: null } };
    expect(await offerProblem(db, spec, null)).toBe(TASK_SAYS.itemGone);
    // The local worker's own kinds of task: with no local model named this runtime has nothing behind it, so none
    // of them is offered, whatever asset says it could run one.
    const note = { template: 'draft_note' as const, params: { about: 'A note', items: [], titles: false } };
    expect(await offerProblem(db, note, null)).toBe(TASK_SAYS.cantRun);
    // An asset that claims a kind of task its row was not signed for is not that asset: it reads as off, not as one
    // that could run it.
    const reach = { registry: [{ ...CI_WATCHER, capabilities: [...CI_WATCHER.capabilities, 'draft_note' as const] }] };
    expect(await offerProblem(db, note, null, reach)).toBe(TASK_SAYS.assetOff);
    // With its asset on and an adapter behind it, a note (which needs no item) is offered, and a summary is held to
    // the same items as any other task: one that is archived is not offered.
    const worker = { adapters: { ci_runner: ciWatch, local_worker: stubWorker }, registry: ASSETS };
    await fx.assetOn(LOCAL_WORKER.id);
    expect(await offerProblem(db, note, null, worker)).toBeUndefined();
    const stale = await fx.entity('pull_request', { number: 7, state: 'closed' });
    await db.entity.update({ where: { id: stale }, data: { status: 'archived' } });
    expect(await offerProblem(db, { template: 'summarize_items', params: { items: [stale], titles: false } }, null, worker)).toBe(TASK_SAYS.itemEnded);
    await turnOff(db, LOCAL_WORKER.id);
    expect(await offerProblem(db, note, null, worker)).toBe(TASK_SAYS.assetOff);
    expect(await offerProblem(db, { ...spec, params: { item: await fx.entity('pull_request', { number: 4, state: 'open' }), sha: null } }, null)).toBe(TASK_SAYS.itemEnded);
  });

  it('the New Task form: only what an asset that is on can run, its items by label alone (never a title, a person or a forgotten one), and active goals', async () => {
    const form = async (deps?: Parameters<typeof taskForm>[2]) => TaskForm.parse(await taskForm(db, 'UTC', deps));
    const run = await fx.ciRun('wpf002/form');
    const archived = await fx.entity('ci_run', { workflow: 'ci', status: 'completed' }, { name: 'Synthetic archived run' });
    await db.entity.update({ where: { id: archived }, data: { status: 'archived' } });
    const pr = await fx.entity('pull_request', { number: 9, state: 'open' });
    const person = await fx.person();
    // A run whose name is a stranger's words is named by what it is, never by them.
    const named = await fx.entity('ci_run', { workflow: 'ci', status: 'queued' }, { name: 'Synthetic CANARY-p5tasks title', taintedPaths: ['name'] });
    const f = await form();
    expect(f.templates.map((t) => [t.template, t.title, t.runsOn, t.more])).toEqual([['watch_ci', 'Watch a CI Run', 'CI Watcher', false]]);
    const items = f.templates[0]!.items;
    expect(items.find((i) => i.entityId === run)).toEqual({ entityId: run, label: 'wpf002/form CI' });
    for (const hidden of [archived, pr, person]) expect(items.some((i) => i.entityId === hidden), hidden).toBe(false);
    expect(items.find((i) => i.entityId === named)!.label).toMatch(/^CI Run( \d+)? from [A-Z][a-z]{2} \d{1,2}$/);
    expect(JSON.stringify(f)).not.toContain('CANARY');
    // Every item offered is one a new task takes.
    for (const i of items) expect((await db.entity.findUniqueOrThrow({ where: { id: i.entityId } })).kind).toBe('ci_run');
    // Goals: the active ones, by id and title.
    const goals = await db.goal.findMany({ where: { status: 'active' }, select: { id: true, title: true } });
    expect(goals.length).toBeGreaterThan(0);
    expect([...f.goals].sort((a, b) => a.id.localeCompare(b.id))).toEqual([...goals].sort((a, b) => a.id.localeCompare(b.id)));
    await db.goal.updateMany({ where: { id: goals[0]!.id }, data: { status: 'paused' } });
    expect((await form()).goals.some((x) => x.id === goals[0]!.id)).toBe(false);

    // The list is bounded, the latest seen first, and says when there is more.
    const many = Array.from({ length: TASK_FORM_ITEMS_MAX }, (_, i) => {
      const eid = id('en');
      return { id: eid, kind: 'ci_run', key: `ci_run:test:${eid}`, name: `Synthetic run ${i}`, state: {}, stateHash: HEX('d'), sensitivity: 'ops', lastObservedAt: new Date(Date.now() + 60_000 + i) };
    });
    await db.entity.createMany({ data: many });
    const full = await form();
    expect(full.templates[0]).toMatchObject({ more: true });
    expect(full.templates[0]!.items).toHaveLength(TASK_FORM_ITEMS_MAX);
    expect(full.templates[0]!.items[0]!.entityId).toBe(many[many.length - 1]!.id);
    expect(full.templates[0]!.items.some((i) => i.entityId === run)).toBe(false);

    // No template without its asset on, as the registry says it is, with something behind it to run it.
    expect((await form({ adapters: {} })).templates).toEqual([]);
    expect((await form({ registry: [{ ...CI_WATCHER, name: 'Another Name' }] })).templates).toEqual([]);
    expect((await form({ registry: [] })).templates).toEqual([]);
    await turnOff(db, CI_WATCHER.id);
    expect(await form()).toMatchObject({ templates: [] });
    await fx.watcherOn();
    expect((await form()).templates).toHaveLength(1);
  });

  it('a card a rule of Will’s forbids is not filed, and neither is its task: no row is left behind, and the same form is refused the same way again', async () => {
    const item = await fx.ciRun('wpf002/forbidden');
    const done = await fx.newTask(await fx.ciRun('wpf002/forbidden-again'));
    await cancelTask(db, done.id);
    await fx.policy('task.dispatch.ci_runner', 'forbidden');
    const before = { ...(await counts()), made: await db.auditEntry.count({ where: { action: 'task.create' } }), withdrawn: await db.auditEntry.count({ where: { action: 'task.withdraw' } }) };
    const f = form(item);
    for (let press = 0; press < 2; press++) {
      const err = await refusal(createTask(db, f));
      // The engine's own refusal, typed: which rule forbade it travels with it, and its words are for the log.
      expect(err).toBeInstanceOf(Forbidden);
      expect(err).toMatchObject({ status: 409, rule: 'policy', message: 'forbidden: ActionPolicy task.dispatch.ci_runner' });
      // Nothing was written: no task (not even a cancelled one), no card, no entry saying a task was made or withdrawn.
      expect(await db.task.findUnique({ where: { id: `tk${f.draftKey}` } }), `press ${press}`).toBeNull();
      expect({ ...(await counts()), made: await db.auditEntry.count({ where: { action: 'task.create' } }), withdrawn: await db.auditEntry.count({ where: { action: 'task.withdraw' } }) }).toEqual(before);
    }
    // The refusal itself is on record, by ids.
    const denied = await db.auditEntry.findFirstOrThrow({ where: { action: 'task.dispatch.ci_runner', outcome: 'denied' }, orderBy: { seq: 'desc' } });
    expect(denied).toMatchObject({ kind: 'decision', tier: 'forbidden', decision: 'deny' });
    // Run Again goes the same way, with the same key twice.
    const key = draft();
    for (let press = 0; press < 2; press++) expect(await refusal(runAgain(db, done.id, key))).toBeInstanceOf(Forbidden);
    expect(await db.task.findUnique({ where: { id: `tk${key}` } })).toBeNull();
  });
});
