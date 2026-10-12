/**
 * Running and checking a task on flint_test (P5).
 *
 *  - An adapter sees each item as its ref, its kind and its clean state fields:
 *    never a title, never a field someone else's text reached, never a
 *    forgotten item.
 *  - A run ends a task only as a class: the asset turned off, an item gone, a
 *    result that is not its template's shape or is too large, an adapter that
 *    throws. No error's words reach the log.
 *  - The watcher waits while CI runs, and while the finished run is for another
 *    commit than the one asked for.
 *  - A result that fails its bar is rejected by Flint, with no card; the bar,
 *    who checked it and its evidence are written once; the decision on record
 *    is ids and counts.
 *  - Job data is a task's id, strictly; the jobs are scheduled unless tasks are
 *    switched off.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NO_DB, freshDb, type TestUrls } from '../db';
import { createDb, type Db } from '../../src/db';
import { loadConfig } from '../../src/config';
import { taskJobs, type JobContext } from '../../src/jobs';
import { turnOff } from '../../src/assets/service';
import { CI_WATCHER } from '../../src/assets/registry';
import { ciSummary, ciWatch } from '../../src/tasks/adapters/ci-watch';
import type { TaskAdapter } from '../../src/tasks/adapters/types';
import { checkStanding, checkTaskJob } from '../../src/tasks/check';
import { ADAPTERS, TaskJob, itemFacts, runTaskJob } from '../../src/tasks/run';
import { TASK_TICK_CRON } from '../../src/tasks/tick';
import { taskLog, taskStatusWords } from '../../src/tasks/errors';
import { CANARY, FakeBus, SHA, taskFixture, type TaskFixture } from './fixture';

describe('a task job, before the database', () => {
  it('is a task’s id and nothing else', () => {
    expect(TaskJob.safeParse({ taskId: 'tkabcdefgh12345678' }).success).toBe(true);
    for (const bad of [{}, { taskId: 'abc' }, { taskId: 'tkabcdefgh12345678', title: 'x' }, { taskId: 7 }, null]) expect(TaskJob.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });
  it('a log line is the task’s id, where it stands and a class; a status outside the set still gets a sentence', () => {
    expect(taskLog('tk1', 'failed', 'expired')).toBe('task tk1: failed (expired)');
    expect(taskLog('tk1', 'submitted')).toBe('task tk1: submitted');
    expect(taskStatusWords('queued')).toBe('It’s next in line.');
    expect(taskStatusWords('constructor')).toBe('This task can’t change now.');
  });
  it('the CI watcher says how a run ended in a sentence, and is the only adapter there is', () => {
    expect(ciSummary('success')).toBe('The run passed.');
    expect(ciSummary('failure')).toBe('The run failed.');
    expect(ciSummary('timed_out')).toBe('The run failed.');
    for (const c of ['cancelled', 'skipped', 'neutral', 'action_required', null]) expect(ciSummary(c)).toBe('The run ended without passing.');
    expect(Object.keys(ADAPTERS)).toEqual(['ci_runner']);
    expect(ADAPTERS.ci_runner).toBe(ciWatch);
  });
});

describe.skipIf(NO_DB)('running and checking a task on flint_test', () => {
  let urls: TestUrls;
  let db: Db;
  let fx: TaskFixture;
  const bus = new FakeBus();
  const run = (taskId: string, adapters?: Record<string, TaskAdapter>, log?: (m: string) => void) => runTaskJob({ db, bus, ...(adapters ? { adapters } : {}), ...(log ? { log } : {}) }, { taskId });

  beforeAll(async () => {
    urls = await freshDb();
    db = createDb(urls.app);
    fx = await taskFixture(urls, db, bus);
    await fx.watcherOn();
  });
  afterAll(async () => db?.$disconnect());

  it('an adapter sees an item’s ref, kind and clean state fields, in the spec’s order: never a title, a tainted field or a forgotten item', async () => {
    const ci = await fx.ciRun('wpf002/facts', { status: 'completed', conclusion: 'success' });
    const pr = await fx.entity('pull_request', { number: 7, state: 'open', draft: true, title: `${CANARY} title`, note: 'Free text with spaces' }, { name: `${CANARY} title`, taintedPaths: ['name', 'state.title'] });
    const gone = await fx.entity('issue', { number: 8, state: 'open' });
    await fx.forget(gone);
    const facts = await itemFacts(db, [pr, gone, ci, 'no-such-item']);
    expect(facts).toEqual([
      { id: pr, ref: `pull_request#${pr.slice(-6)}`, kind: 'pull_request', state: { number: 7, state: 'open', draft: true } },
      { id: ci, ref: `ci_run#${ci.slice(-6)}`, kind: 'ci_run', state: { workflow: 'ci', status: 'completed', conclusion: 'success', sha: SHA } },
    ]);
    expect(JSON.stringify(facts)).not.toContain('CANARY');
    expect(await itemFacts(db, [])).toEqual([]);
  });

  it('the watcher waits while CI runs and while the finished run is for another commit; it never runs a second time once handed in', async () => {
    const item = await fx.ciRun('wpf002/commit', { status: 'completed', conclusion: 'success', sha: `fff${SHA.slice(3)}` });
    const t = await fx.dispatched(item, { params: { item, sha: SHA.slice(0, 10) } });
    expect(await run(t.id)).toBe('waiting');
    expect(await run(t.id)).toBe('waiting');
    expect(await fx.task(t.id)).toMatchObject({ status: 'dispatched', attempts: 0 });
    await fx.ciRun('wpf002/commit', { status: 'queued', sha: SHA });
    expect(await run(t.id)).toBe('waiting');
    await fx.ciRun('wpf002/commit', { status: 'completed', conclusion: 'success', sha: SHA });
    expect(await run(t.id)).toBe('submitted');
    expect(await run(t.id)).toBe('skipped');
    expect(await db.taskOutput.count({ where: { taskId: t.id } })).toBe(1);
    expect(await checkTaskJob({ db }, { taskId: t.id })).toBe('filed');
    expect((await fx.task(t.id)).barEvidence).toEqual([{ id: 'a1', op: 'ci', met: true }]);
  });

  it('a run ends a task only as a class, and no error’s words reach the log', async () => {
    const logs: string[] = [];
    const log = (m: string) => logs.push(m);
    const start = async (repo: string) => (await fx.dispatched(await fx.ciRun(repo, { status: 'completed', conclusion: 'success' }))).id;
    const failedAs = async (id: string, failure: string) => expect(await fx.task(id)).toMatchObject({ status: 'failed', failure, outputRef: null });
    const adapter = (r: TaskAdapter['run']): Record<string, TaskAdapter> => ({ ci_runner: { kind: 'ci_runner', estimate: () => 0, run: r } });

    // The adapter gives a class.
    const a = await start('wpf002/class');
    expect(await run(a, adapter(async () => ({ failure: 'unavailable' })), log)).toBe('failed');
    await failedAs(a, 'unavailable');
    // It throws: a bug, told by its class only.
    const b = await start('wpf002/throws');
    expect(await run(b, adapter(async () => { throw new TypeError(`${CANARY} secret words`); }), log)).toBe('failed');
    await failedAs(b, 'error');
    // A result that is not its template's shape, or is too large, is never stored.
    const c = await start('wpf002/shape');
    expect(await run(c, adapter(async () => ({ output: { ref: 'ci_run#abc123', status: 'completed', conclusion: 'success', sha: null, note: `${CANARY} extra` }, summary: 'x' })), log)).toBe('failed');
    await failedAs(c, 'invalid');
    expect(await db.taskOutput.count({ where: { taskId: c } })).toBe(0);
    // No adapter for its asset's kind.
    const d = await start('wpf002/none');
    expect(await run(d, {}, log)).toBe('failed');
    await failedAs(d, 'error');
    // The run it was to watch was forgotten: nothing to hand in, ever.
    const item = await fx.ciRun('wpf002/forgotten', { status: 'completed', conclusion: 'success' });
    const e = await fx.dispatched(item);
    expect(await ciWatch.run({ taskId: e.id, spec: { template: 'watch_ci', params: { item, sha: null } }, items: [], now: new Date() })).toEqual({ failure: 'invalid' });
    expect(await ciWatch.run({ taskId: e.id, spec: { template: 'draft_note', params: { about: 'x', items: [], titles: false } }, items: [], now: new Date() })).toEqual({ failure: 'invalid' });
    // Its asset turned off while it waits (no signature needed): it fails as that, and is not handed to the adapter.
    const f = await start('wpf002/off');
    await turnOff(db, CI_WATCHER.id);
    let asked = 0;
    expect(await run(f, adapter(async () => { asked += 1; return { wait: true }; }), log)).toBe('failed');
    await failedAs(f, 'asset_off');
    expect(asked).toBe(0);
    expect((await fx.task(f)).dispatchedAt).toBeNull();
    await fx.watcherOn();

    expect(logs).toEqual([
      `task ${a}: failed (unavailable)`, `task ${b}: adapter threw (TypeError)`, `task ${b}: failed (error)`, `task ${c}: failed (invalid)`, `task ${d}: failed (error)`, `task ${f}: failed (asset_off)`,
    ]);
    expect(`${logs.join('\n')}\n${await fx.everythingButTasks()}`).not.toContain('CANARY');
    // A task that failed, or was never there, is nobody's to run.
    expect(await run(a)).toBe('skipped');
    expect(await run('tk0000000000000000')).toBe('skipped');
  });

  it('a result that fails its bar is rejected by Flint, with no card; the bar is written once; the decision on record is ids and counts', async () => {
    const item = await fx.ciRun('wpf002/red', { status: 'completed', conclusion: 'failure' });
    const t = await fx.dispatched(item);
    expect(await run(t.id)).toBe('submitted');
    expect(await fx.task(t.id)).toMatchObject({ outputSummary: 'The run failed.' });
    const logs: string[] = [];
    expect(await checkTaskJob({ db, log: (m) => logs.push(m) }, { taskId: t.id })).toBe('rejected');
    const rejected = await fx.task(t.id);
    expect(rejected).toMatchObject({ status: 'rejected', metBar: false, barCheckedBy: 'flint:rule', barEvidence: [{ id: 'a1', op: 'ci', met: false }], acceptedAuditId: null });
    expect(rejected.completedAt).toBeInstanceOf(Date);
    expect(await fx.cardFor('task.check_bar', t.id)).toBeNull();
    expect(logs).toEqual([`task ${t.id}: rejected (0 of 1)`]);
    const decision = await db.auditEntry.findFirstOrThrow({ where: { correlationId: `task:${t.id}`, kind: 'decision', action: 'task.check_bar' } });
    expect(decision).toMatchObject({ actor: 'runtime:tasks', context: 'autonomous', outcome: 'ok', tier: 'approval' });
    expect(decision.inputs).toEqual({ taskId: t.id, checks: 1, met: 0, by: 'flint:rule' });
    // Checked again: nothing more is written.
    expect(await checkTaskJob({ db }, { taskId: t.id })).toBe('skipped');
    expect(await db.auditEntry.count({ where: { correlationId: `task:${t.id}`, kind: 'decision', action: 'task.check_bar' } })).toBe(1);
    // A task that is not handed in yet is not checked.
    const waiting = await fx.dispatched(await fx.ciRun('wpf002/early'));
    expect(await checkTaskJob({ db }, { taskId: waiting.id })).toBe('skipped');
    expect(await checkStanding(db, new Date())).toBe('shadow');
  });

  it('a task whose result is missing is not checked on a guess: it fails as unusable', async () => {
    const item = await fx.ciRun('wpf002/lost', { status: 'completed', conclusion: 'success' });
    const t = await fx.dispatched(item);
    await run(t.id);
    // Its result goes missing (only a forget may delete one before the task ends).
    await fx.owner(`DO $$ BEGIN PERFORM set_config('flint.forget_approval', 'test', true); DELETE FROM "TaskOutput" WHERE "taskId" = '${t.id}'; END $$`);
    expect(await db.taskOutput.count({ where: { taskId: t.id } })).toBe(0);
    expect(await checkTaskJob({ db }, { taskId: t.id })).toBe('failed');
    expect(await fx.task(t.id)).toMatchObject({ status: 'failed', failure: 'invalid', metBar: null });
  });

  it('the task jobs: the tick every 2 minutes and one worker each for runs and checks; none while tasks are switched off; a job that is not a task’s id does nothing', async () => {
    const ctx = (over: Record<string, string> = {}): JobContext => ({ db, bus: bus as unknown as JobContext['bus'], sources: [], log: () => {}, config: loadConfig({ DATABASE_URL: urls.app, HOME: '/tmp/none', ...over }) });
    expect(taskJobs(ctx({ FLINT_ASSETS: 'off' }))).toEqual([]);
    const specs = taskJobs(ctx());
    expect(specs.map((s) => [s.queue, s.cron])).toEqual([['tasks.tick', TASK_TICK_CRON], ['tasks.run', undefined], ['tasks.check', undefined]]);
    const job = (data: unknown) => [{ id: 'j1', name: 'q', data }] as unknown as Parameters<(typeof specs)[number]['handler']>[0];
    const item = await fx.ciRun('wpf002/jobs', { status: 'completed', conclusion: 'success' });
    const t = await fx.dispatched(item);
    await specs[1]!.handler(job({ taskId: t.id, title: 'not a task job' }));
    await specs[1]!.handler(job(null));
    expect(await fx.task(t.id)).toMatchObject({ status: 'queued' });
    await specs[1]!.handler(job({ taskId: t.id }));
    expect(await fx.task(t.id)).toMatchObject({ status: 'submitted' });
    await specs[2]!.handler(job({ nope: true }));
    await specs[2]!.handler(job({ taskId: t.id }));
    expect(await fx.task(t.id)).toMatchObject({ status: 'checking', metBar: true });
    await specs[0]!.handler(job(null));
  });
});
