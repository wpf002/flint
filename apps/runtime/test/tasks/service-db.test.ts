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
import { AssetEnableArgs, AssetsPage, TASK_FORM_ITEMS_MAX, TASK_SAYS, TASK_STATUS_SAYS, TaskAnswer, TaskForm, TasksPage, noteProblems, titleCase } from '@flint/policy';
import { HEX, NO_DB, freshDb, id, type TestUrls } from '../db';
import { createDb, type Db } from '../../src/db';
import { Refused } from '../../src/governance/proposals';
import { ASSETS, CI_WATCHER, assetDef, assetFor, enableArgsOf, sameAsset } from '../../src/assets/registry';
import { fileEnable, known, syncAssets, turnOff } from '../../src/assets/service';
import { WAITING, assetsPage } from '../../src/assets/view';
import { checkTaskJob } from '../../src/tasks/check';
import { runTaskJob } from '../../src/tasks/run';
import { DUE_MAX_MS, TASK_TITLES, cancelTask, createTask, overrideTask, runAgain } from '../../src/tasks/service';
import { taskForm, taskView, tasksPage } from '../../src/tasks/view';
import { DAY, FakeBus, SHA, draft, taskFixture, type TaskFixture } from './fixture';

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
  it('is a closed list: the CI watcher, which calls nothing and costs nothing; every name and sentence is fit to show', () => {
    expect(ASSETS).toEqual([CI_WATCHER]);
    expect(CI_WATCHER).toMatchObject({ kind: 'ci_runner', externalRef: 'github:ci:v1', capabilities: ['watch_ci'], dispatchAction: 'task.dispatch.ci_runner', spends: false });
    for (const a of ASSETS) {
      expect(noteProblems(a.name, a.line), a.id).toEqual([]);
      expect(a.id).toMatch(/^[a-z0-9-]{1,40}$/);
    }
    expect(noteProblems('A Title', WAITING)).toEqual([]);
    for (const title of Object.values(TASK_TITLES)) expect(titleCase(title), title).toBe(title);
    expect(assetDef(CI_WATCHER.id)).toBe(CI_WATCHER);
    expect(assetDef('nope')).toBeUndefined();
    expect(assetFor('watch_ci')).toBe(CI_WATCHER);
    // No asset runs the local model's templates yet.
    for (const t of ['summarize_items', 'sort_items', 'draft_note'] as const) expect(assetFor(t)).toBeUndefined();
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
    // The row is made by the first read, off. Until the GitHub source is on it says what it needs.
    expect(await page()).toEqual({ assets: [{ ...row, on: false, waiting: false, canTurnOn: false, line: TASK_SAYS.needsGithub }], reviewsRequired: false });
    expect(await refusal(fileEnable(db, CI_WATCHER.id))).toMatchObject({ status: 409, message: TASK_SAYS.needsGithub });
    await fx.sourceOn();
    expect((await page()).assets).toEqual([{ ...row, on: false, waiting: false, canTurnOn: true, line: CI_WATCHER.line }]);
    const filed = await fileEnable(db, CI_WATCHER.id);
    expect((await page()).assets).toEqual([{ ...row, on: false, waiting: true, canTurnOn: false, line: WAITING }]);
    await fx.signRun(filed.proposalId);
    expect((await page()).assets).toEqual([{ ...row, on: true, waiting: false, canTurnOn: false, line: CI_WATCHER.line }]);
    // Turning it off needs no signature and is on record by id.
    await turnOff(db, CI_WATCHER.id);
    expect((await page()).assets[0]).toMatchObject({ on: false, canTurnOn: true, line: CI_WATCHER.line });
    const off = await db.auditEntry.findFirstOrThrow({ where: { action: 'asset.disable' } });
    expect(off).toMatchObject({ actor: 'will:console', kind: 'action', outcome: 'ok', correlationId: `asset:${CI_WATCHER.id}` });
    expect(off.inputs).toEqual({ assetId: CI_WATCHER.id });
    expect(await refusal(turnOff(db, 'as-unknown-v1'))).toMatchObject({ status: 404, message: TASK_SAYS.noAsset });
    // A row the registry does not describe is left out: nothing can run on it.
    await syncAssets(db, [{ ...CI_WATCHER, id: 'as-stray-v1', externalRef: 'github:ci:stray' }]);
    expect((await page()).assets.map((a) => a.id)).toEqual([CI_WATCHER.id]);
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
});
