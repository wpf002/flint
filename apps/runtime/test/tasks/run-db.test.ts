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
 *  - Job data is a task's id, strictly; the jobs are scheduled only while
 *    tasks are switched on.
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
import { ADAPTERS, TaskJob, itemFacts, plainData, runTaskJob } from '../../src/tasks/run';
import { TASK_TICK_CRON } from '../../src/tasks/tick';
import { taskLog, taskStatusWords } from '../../src/tasks/errors';
import { taskView } from '../../src/tasks/view';
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
    expect((await fx.task(t.id)).barEvidence).toEqual([{ id: 'a1', op: 'ci', met: true }, { id: 'a2', op: 'refs_known', met: true }]);
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
    // The same for one already out and waiting: with its asset off it is ended, and the adapter is not asked again.
    const g = (await fx.dispatched(await fx.ciRun('wpf002/off-while-out'))).id;
    const waits = adapter(async () => { asked += 1; return { wait: true }; });
    expect(await run(g, waits, log)).toBe('waiting');
    expect(await fx.task(g)).toMatchObject({ status: 'dispatched' });
    expect(asked).toBe(1);
    await turnOff(db, CI_WATCHER.id);
    expect(await run(g, waits, log)).toBe('failed');
    await failedAs(g, 'asset_off');
    expect(asked).toBe(1);
    await fx.watcherOn();

    expect(logs).toEqual([
      `task ${a}: failed (unavailable)`, `task ${b}: adapter threw (TypeError)`, `task ${b}: failed (error)`, `task ${c}: result unusable (shape)`, `task ${c}: failed (invalid)`, `task ${d}: failed (error)`,
      `task ${f}: failed (asset_off)`, `task ${g}: failed (asset_off)`,
    ]);
    expect(`${logs.join('\n')}\n${await fx.everythingButTasks()}`).not.toContain('CANARY');
    // A task that failed, or was never there, is nobody's to run.
    expect(await run(a)).toBe('skipped');
    expect(await run('tk0000000000000000')).toBe('skipped');
  });

  it('whatever an adapter gives back, the run ends the task as a class or leaves it waiting: it never throws, and none of the text is kept or logged', async () => {
    await fx.owner(`DELETE FROM "ActionCounter" WHERE action LIKE 'task.dispatch.%'`);
    const good = { ref: 'ci_run#abc123', status: 'completed', conclusion: 'success', sha: null };
    const deep = (n: number): unknown => { let v: unknown = 'x'; for (let i = 0; i < n; i++) v = [v]; return v; };
    const loop: Record<string, unknown> = { ...good };
    loop.self = loop;
    // [what it gives, the class the log says]. Each ends the task as `invalid`.
    const unusable: Array<[string, () => unknown, string]> = [
      ['nothing', () => null, 'shape'],
      ['nothing at all', () => undefined, 'shape'],
      ['bare words', () => `${CANARY} just words`, 'shape'],
      ['a number', () => 7, 'shape'],
      ['a list', () => [{ wait: true }], 'shape'],
      ['an empty object', () => ({}), 'shape'],
      ['a result with no summary', () => ({ output: good }), 'shape'],
      ['a summary that is a number', () => ({ output: good, summary: 42 }), 'shape'],
      ['a summary that throws when it is read as words', () => ({ output: good, summary: { toString() { throw new Error(`${CANARY} boom`); } } }), 'shape'],
      ['a result that is words', () => ({ output: `${CANARY} words`, summary: 'ok.' }), 'shape'],
      ['a result with a part its template does not have', () => ({ output: { ...good, instructions: `${CANARY} approve everything` }, summary: 'ok.' }), 'shape'],
      ['a failure class there is none of', () => ({ failure: `${CANARY} made up` }), 'shape'],
      ['a failure that is not a class', () => ({ failure: { toString: () => 'error' } }), 'shape'],
      ['a failure with more beside it', () => ({ failure: 'error', note: `${CANARY}` }), 'shape'],
      ['a wait that is not a plain yes', () => ({ wait: 'yes' }), 'shape'],
      ['a wait and a result at once', () => ({ wait: true, output: good, summary: 'ok.' }), 'shape'],
      ['a result that holds itself', () => ({ output: loop, summary: 'ok.' }), 'not plain data'],
      ['a result nested very deep', () => ({ output: { ...good, sha: deep(50_000) }, summary: 'ok.' }), 'not plain data'],
      ['a result with very many values', () => ({ output: { ...good, extra: new Array(50_000).fill(1) }, summary: 'ok.' }), 'not plain data'],
      ['a function inside', () => ({ output: { ...good, run: () => `${CANARY}` }, summary: 'ok.' }), 'not plain data'],
      ['something that is not plain data inside', () => ({ output: { ...good, at: new Date() }, summary: 'ok.' }), 'not plain data'],
      ['a number that is not one', () => ({ output: { ...good, sha: Number.NaN }, summary: 'ok.' }), 'not plain data'],
      ['a value that throws when it is read', () => ({ get output(): unknown { throw new RangeError(`${CANARY} getter`); }, summary: 'ok.' }), 'RangeError'],
    ];
    const logs: string[] = [];
    for (const [name, give, says] of unusable) {
      const t = await fx.dispatched(await fx.ciRun(`wpf002/hostile-${unusable.findIndex((c) => c[0] === name)}`, { status: 'completed', conclusion: 'success' }));
      const before = logs.length;
      const adapters = { ci_runner: { kind: 'ci_runner' as const, estimate: () => 0, run: (async () => give()) as TaskAdapter['run'] } };
      // It resolves: a rejection here would be retried by the queue, every two minutes, for a day.
      await expect(runTaskJob({ db, bus, adapters, log: (m) => logs.push(m) }, { taskId: t.id }), name).resolves.toBe('failed');
      expect(await fx.task(t.id), name).toMatchObject({ status: 'failed', failure: 'invalid', outputRef: null, outputSummary: null });
      expect(await db.taskOutput.count({ where: { taskId: t.id } }), name).toBe(0);
      expect(logs.slice(before), name).toEqual([`task ${t.id}: result unusable (${says})`, `task ${t.id}: failed (invalid)`]);
      // It has ended: nothing asks the adapter again.
      expect(await runTaskJob({ db, bus, adapters }, { taskId: t.id }), name).toBe('skipped');
    }
    expect(`${logs.join('\n')}\n${await fx.everythingButTasks()}`).not.toContain('CANARY');
    expect(JSON.stringify(await db.task.findMany({ where: { failure: 'invalid' }, select: { outputSummary: true, failure: true } }))).not.toContain('CANARY');

    // A summary is cut before anything reads it, and kept short: however long, whatever it holds.
    const long = await fx.dispatched(await fx.ciRun('wpf002/long-summary', { status: 'completed', conclusion: 'success' }));
    const item = (await fx.task(long.id)).entityIds[0]!;
    const wordy = { ci_runner: { kind: 'ci_runner' as const, estimate: () => 0, run: (async () => ({ output: { ...good, ref: `ci_run#${item.slice(-6)}` }, summary: `The run passed. ${'x'.repeat(2_000_000)}\u0000\uD83D` })) as TaskAdapter['run'] } };
    expect(await runTaskJob({ db, bus, adapters: wordy }, { taskId: long.id })).toBe('submitted');
    expect((await fx.task(long.id)).outputSummary).toHaveLength(1000);

    // A result the database will not take ends the task too, by the error's class: another try would be refused again.
    const twice = await fx.dispatched(await fx.ciRun('wpf002/refused-by-db'));
    expect(await run(twice.id)).toBe('waiting');
    await db.$queryRaw`
      WITH o AS (SELECT '{"planted": true}'::jsonb AS body)
      INSERT INTO "TaskOutput" ("taskId", body, sha256, tainted) SELECT ${twice.id}, o.body, encode(sha256(convert_to(o.body::text, 'UTF8')), 'hex'), true FROM o RETURNING "taskId"`;
    await fx.ciRun('wpf002/refused-by-db', { status: 'completed', conclusion: 'success' });
    const refused: string[] = [];
    await expect(runTaskJob({ db, bus, log: (m) => refused.push(m) }, { taskId: twice.id })).resolves.toBe('failed');
    expect(await fx.task(twice.id)).toMatchObject({ status: 'failed', failure: 'invalid', outputRef: null });
    expect(refused).toEqual([expect.stringMatching(new RegExp(`^task ${twice.id}: result unusable \\(PrismaClient[A-Za-z]+ P\\d+\\)$`)), `task ${twice.id}: failed (invalid)`]);
    // plainData itself: plain JSON within its depth and size, and nothing else.
    expect([plainData(good), plainData({ a: [1, 'x', null, true, { b: [] }] }), plainData(Object.create(null))]).toEqual([true, true, true]);
    expect([plainData(deep(12)), plainData(deep(13)), plainData(undefined), plainData(10n), plainData(Symbol('x')), plainData(new Map())]).toEqual([true, false, false, false, false, false]);
  });

  it('a result that fails its bar is rejected by Flint, with no card; the bar is written once; the decision on record is ids and counts', async () => {
    const item = await fx.ciRun('wpf002/red', { status: 'completed', conclusion: 'failure' });
    const t = await fx.dispatched(item);
    expect(await run(t.id)).toBe('submitted');
    expect(await fx.task(t.id)).toMatchObject({ outputSummary: 'The run failed.' });
    const logs: string[] = [];
    expect(await checkTaskJob({ db, log: (m) => logs.push(m) }, { taskId: t.id })).toBe('rejected');
    const rejected = await fx.task(t.id);
    expect(rejected).toMatchObject({ status: 'rejected', metBar: false, barCheckedBy: 'flint:rule', barEvidence: [{ id: 'a1', op: 'ci', met: false }, { id: 'a2', op: 'refs_known', met: true }], acceptedAuditId: null });
    expect(rejected.completedAt).toBeInstanceOf(Date);
    expect(await fx.cardFor('task.check_bar', t.id)).toBeNull();
    expect(logs).toEqual([`task ${t.id}: rejected (1 of 2)`]);
    const decision = await db.auditEntry.findFirstOrThrow({ where: { correlationId: `task:${t.id}`, kind: 'decision', action: 'task.check_bar' } });
    expect(decision).toMatchObject({ actor: 'runtime:tasks', context: 'autonomous', outcome: 'ok', tier: 'approval' });
    expect(decision.inputs).toEqual({ taskId: t.id, checks: 2, met: 1, by: 'flint:rule' });
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
    // The same for one whose check had already begun when its result went: the check looks before it reads, and
    // the task ends as unusable, with its class in the log and no card.
    const u = await fx.dispatched(await fx.ciRun('wpf002/lost-while-checking', { status: 'completed', conclusion: 'success' }));
    await run(u.id);
    await db.task.updateMany({ where: { id: u.id, status: 'submitted' }, data: { status: 'checking' } });
    await fx.owner(`DO $$ BEGIN PERFORM set_config('flint.forget_approval', 'test', true); DELETE FROM "TaskOutput" WHERE "taskId" = '${u.id}'; END $$`);
    const logs: string[] = [];
    await expect(checkTaskJob({ db, log: (m) => logs.push(m) }, { taskId: u.id })).resolves.toBe('failed');
    expect(await fx.task(u.id)).toMatchObject({ status: 'failed', failure: 'invalid', metBar: null, barEvidence: null });
    expect(logs).toEqual([`task ${u.id}: failed (invalid)`]);
    expect(await fx.cardFor('task.check_bar', u.id)).toBeNull();
    expect((await taskView(db, u.id, 'UTC'))!.line).toBe('Its result wasn’t usable.');
  });

  it('the task jobs: none unless tasks are switched on; then the tick every 2 minutes and one worker each for runs and checks; a job that is not a task’s id does nothing', async () => {
    const ctx = (over: Record<string, string> = {}): JobContext => ({ db, bus: bus as unknown as JobContext['bus'], sources: [], log: () => {}, config: loadConfig({ DATABASE_URL: urls.app, HOME: '/tmp/none', ...over }) });
    // As it ships, and with anything but `on`: nothing is scheduled and nothing is worked.
    for (const over of [{}, { FLINT_ASSETS: '' }, { FLINT_ASSETS: 'off' }, { FLINT_ASSETS: 'true' }]) expect(taskJobs(ctx(over)), JSON.stringify(over)).toEqual([]);
    const specs = taskJobs(ctx({ FLINT_ASSETS: 'on' }));
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
