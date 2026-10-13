/**
 * The task tick, forecasts, retention and health on flint_test (P5), on a
 * given clock: the tick, the scorer and retention take the time they are
 * handed, and the bus is a stand-in that keeps what was sent.
 *
 *  - A task still out is sent to its run again; one handed in, to its check.
 *    Its asset turned off, its due time passed, or a day without moving ends
 *    it, as a class.
 *  - A proposed task whose dispatch card is gone is cancelled (nothing went
 *    out); one whose card still waits is left alone.
 *  - A result that passed waits for Will as long as his card does, and the
 *    task ends once he turned the card down.
 *  - A forecast is a base rate over tasks like it, counted under its own
 *    counter, and names its task under the tasks rule. It is scored 24 hours
 *    after the task ended, by the tick alone, unless a rule of Will's forbids
 *    that: accepted is true, rejected or failed is false. Once it is scored,
 *    an override is refused. A cancelled task's forecast is never scored: it
 *    runs out once its date has passed.
 *  - Retention clears a task's words and deletes its output only once it has
 *    ended; Health says when tasks are off, idle, stuck or stopped.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MEETS_BAR_COUNTER, TASK_FORECAST_RULE, TASK_SAYS, TASKS_WRITER } from '@flint/policy';
import { NO_DB, freshDb, type TestUrls } from '../db';
import { createDb, type Db } from '../../src/db';
import { Refused, rejectProposal } from '../../src/governance/proposals';
import { Invalid, emitPrediction } from '../../src/ledger/emit';
import { runRetention } from '../../src/retention';
import { TASK_HEALTH, checkComponents } from '../../src/health/checks';
import { turnOff } from '../../src/assets/service';
import { CI_WATCHER } from '../../src/assets/registry';
import { checkTaskJob } from '../../src/tasks/check';
import { OVERRIDE_WINDOW_MS, TASK_FORECAST, expireCancelledForecast, forecastResolveBy, mayExpire, mayScore, meetsBarProbability, scoreTaskForecast } from '../../src/tasks/forecast';
import { failTask, runTaskJob } from '../../src/tasks/run';
import { ruleOwner } from '../../src/predict/resolvers';
import { backdatePrediction } from '../ledger/kit';
import { FILING_GRACE_MS, STALE_MS, taskTick } from '../../src/tasks/tick';
import { DAY, FakeBus, taskFixture, type TaskFixture } from './fixture';

const HOUR = 3_600_000;
const later = (ms: number) => new Date(Date.now() + ms);

describe('a task’s forecast, before the database', () => {
  it('is a base rate with one imagined success and one imagined failure, within 5% and 95%', () => {
    expect(meetsBarProbability(0, 0)).toBe(0.5);
    expect(meetsBarProbability(3, 4)).toBe(0.67);
    expect(meetsBarProbability(0, 8)).toBe(0.1);
    expect(meetsBarProbability(200, 200)).toBe(0.95);
    expect(meetsBarProbability(0, 200)).toBe(0.05);
    expect(meetsBarProbability(-1, -5)).toBe(0.5);
  });
  it('resolves 8 days after the task’s due time, or 9 days from now without one', () => {
    const now = new Date('2026-10-12T10:00:00.000Z');
    expect(forecastResolveBy(null, now)).toEqual(new Date(now.getTime() + 9 * DAY));
    expect(forecastResolveBy(new Date(now.getTime() + 30 * DAY), now)).toEqual(new Date(now.getTime() + 38 * DAY));
    expect(forecastResolveBy(new Date(now.getTime() + HOUR), now)).toEqual(new Date(now.getTime() + 9 * DAY));
  });
  it('the task template is the tasks writer’s alone, and that writer records nothing else', async () => {
    const noDb = {} as Db;
    const p = { kind: 'binary' as const, probability: 0.5, method: 'base_rate' as const, domain: 'assets' as const, type: 'task_meets_bar' as const, evidence: [], resolutionCriteria: 'x', resolver: 'auto_world' as const, resolverSpec: { taskId: 'tkabcdefghij123456', rule: 'task_meets_bar' } as Record<string, unknown> | undefined, resolveBy: later(DAY).toISOString(), tainted: false };
    const template = { id: 'task_meets_bar' as const, params: { task: 'task#abc123', by: '2026-12-01' } };
    for (const [body, by] of [
      [{ ...p, template }, 'runtime:goals'], [{ ...p, template }, 'client:server'],
      [{ ...p, claim: 'a task passes' }, TASKS_WRITER], [{ ...p, template, domain: 'goals' as const }, TASKS_WRITER], [{ ...p, template, method: 'rule' as const }, TASKS_WRITER],
      [{ ...p, template, tainted: true }, TASKS_WRITER], [{ ...p, template, resolver: 'will' as const }, TASKS_WRITER],
      [{ ...p, template: { id: 'task_meets_bar' as const, params: { task: 'A task’s own title', by: '2026-12-01' } } }, TASKS_WRITER],
      // Without the rule that names its task, or under another rule: not a task's forecast.
      [{ ...p, template, resolverSpec: undefined }, TASKS_WRITER], [{ ...p, template, resolverSpec: { taskId: 'tkabcdefghij123456', rule: 'goal_done_by' } }, TASKS_WRITER],
    ] as const) await expect(emitPrediction(noDb, body, by), `${JSON.stringify(body)} by ${by}`).rejects.toBeInstanceOf(Invalid);
  });
});

describe.skipIf(NO_DB)('the task tick on flint_test', () => {
  let urls: TestUrls;
  let db: Db;
  let fx: TaskFixture;
  const bus = new FakeBus();
  const tick = (now = new Date(), logs?: string[]) => taskTick({ db, bus, now: () => now, ...(logs ? { log: (m: string) => logs.push(m) } : {}) });
  const sentTo = (queue: string, taskId: string) => bus.of(queue).filter((j) => j.data.taskId === taskId).length;
  /** A task that ended 25 hours ago, its forecast made two days ago and due in a week: a test's stand-in for a day passing. */
  const dayOn = async (taskId: string) => {
    await fx.endedAgo(taskId, 25);
    await backdatePrediction(urls, (await fx.task(taskId)).predictionId!, { madeAgo: 2 * DAY, dueAgo: -7 * DAY });
  };
  /** End every task still open, so each test starts from none. */
  const settle = async () => {
    for (const t of await db.task.findMany({ where: { status: { in: ['proposed'] } }, select: { id: true } })) await db.task.updateMany({ where: { id: t.id, status: 'proposed' }, data: { status: 'cancelled' } });
    for (const t of await db.task.findMany({ where: { status: { in: ['queued', 'dispatched', 'running', 'submitted', 'checking'] } }, select: { id: true, status: true } })) await db.task.update({ where: { id: t.id }, data: { status: 'failed', failure: 'error' } });
  };

  beforeAll(async () => {
    urls = await freshDb();
    db = createDb(urls.app);
    fx = await taskFixture(urls, db, bus);
    await fx.watcherOn();
  });
  beforeEach(async () => {
    await settle();
    bus.clear();
  });
  afterAll(async () => db?.$disconnect());

  it('Health: off, and nothing of a task or an asset read, unless tasks are switched on; on, off while no asset that runs tasks is on; idle, moving, stuck, or stopped by a rule', async () => {
    // Every read of the task and asset tables through this client is counted.
    const read: string[] = [];
    const watched = new Proxy(db, {
      get: (target, key) => {
        if (key === 'task' || key === 'asset' || key === 'taskOutput') read.push(key);
        const v = Reflect.get(target, key) as unknown;
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    const tasks = async (config: Record<string, unknown> = { assets: true }, now = new Date()) =>
      (await checkComponents({ db: watched, config: { home: '/tmp/none', triage: false, tz: 'UTC', ...config }, now, sources: [] })).find((c) => c.component === 'tasks');
    // As it ships (unset) and switched off: the row is Off although the watcher is on, and nothing was read.
    for (const config of [{}, { assets: false }]) expect(await tasks(config)).toEqual({ component: 'tasks', status: 'disabled' });
    expect(read).toEqual([]);
    expect(await tasks()).toEqual({ component: 'tasks', status: 'ok', detail: TASK_HEALTH.none });
    expect(read).toContain('asset');
    const t = await fx.dispatched(await fx.ciRun('wpf002/health'));
    await runTaskJob({ db, bus }, { taskId: t.id });
    // Still out an hour past the day the tick gives it: the tick is not running.
    expect(await tasks({ assets: true }, later(STALE_MS + 30 * 60_000))).toEqual({ component: 'tasks', status: 'ok' });
    expect(await tasks({ assets: true }, later(STALE_MS + 2 * HOUR))).toEqual({ component: 'tasks', status: 'degraded', detail: TASK_HEALTH.stuck(1) });
    expect(TASK_HEALTH.stuck(3)).toBe('3 tasks are past their time and haven’t been ended.');
    await fx.policy('task.check_bar', 'forbidden');
    expect(await tasks()).toEqual({ component: 'tasks', status: 'degraded', detail: TASK_HEALTH.stopped });
    await fx.owner(`UPDATE "ActionPolicy" SET active = false WHERE pattern = 'task.check_bar'`);
    await turnOff(db, CI_WATCHER.id);
    expect(await tasks()).toEqual({ component: 'tasks', status: 'disabled' });
    await fx.watcherOn();
  });

  it('a task still out is sent to its run again, one handed in to its check; a job that is already waiting is the same job', async () => {
    const out = await fx.dispatched(await fx.ciRun('wpf002/out'));
    bus.clear();
    expect(await tick()).toEqual({ sent: 1, failed: 0, cancelled: 0, scored: 0, ranOut: 0 });
    expect(bus.of('tasks.run')).toEqual([expect.objectContaining({ data: { taskId: out.id }, options: { singletonKey: out.id } })]);
    // Still waiting on the bus: not sent twice.
    expect(await tick()).toMatchObject({ sent: 0 });
    bus.take('tasks.run');
    await runTaskJob({ db, bus }, { taskId: out.id });
    expect((await tick()).sent).toBe(1);
    expect(sentTo('tasks.run', out.id)).toBe(2);
    // Handed in: its check is sent (the job a run sends may have died).
    await fx.ciRun('wpf002/out', { status: 'completed', conclusion: 'success' });
    await runTaskJob({ db, bus: new FakeBus() }, { taskId: out.id });
    bus.clear();
    expect(await tick()).toMatchObject({ sent: 1 });
    expect(sentTo('tasks.check', out.id)).toBe(1);
    // Checked, and its accept card waits for Will: nothing is sent, and it is not given up on, however long he takes within the card's week.
    await checkTaskJob({ db }, { taskId: out.id });
    bus.clear();
    expect(await tick(later(3 * DAY))).toEqual({ sent: 0, failed: 0, cancelled: 0, scored: 0, ranOut: 0 });
    expect(await fx.task(out.id)).toMatchObject({ status: 'checking', metBar: true });
    // He turns the card down: the wait is over, and the task ends.
    const card = (await fx.cardFor('task.check_bar', out.id))!;
    await rejectProposal(db, card.id, { approvalId: await fx.sign(card.id, 'reject') }, undefined, 'test');
    const logs: string[] = [];
    expect(await tick(new Date(), logs)).toMatchObject({ failed: 1 });
    expect(await fx.task(out.id)).toMatchObject({ status: 'failed', failure: 'expired', metBar: true });
    expect(logs).toEqual([`task ${out.id}: failed (expired)`]);
    // A check run again for it files no second card.
    expect(await checkTaskJob({ db }, { taskId: out.id })).toBe('skipped');
  });

  it('a result that passed with no card yet (a crash between the bar and the filing) is sent to its check, which files it', async () => {
    const item = await fx.ciRun('wpf002/nocard', { status: 'completed', conclusion: 'success' });
    const t = await fx.dispatched(item);
    await runTaskJob({ db, bus }, { taskId: t.id });
    // The bar is written and the process dies before the card is filed.
    await db.task.update({ where: { id: t.id }, data: { status: 'checking' } });
    await db.task.update({ where: { id: t.id }, data: { metBar: true, barCheckedBy: 'flint:rule', barEvidence: [{ id: 'a1', op: 'ci', met: true }] } });
    bus.clear();
    expect(await tick()).toMatchObject({ sent: 1, failed: 0 });
    expect(sentTo('tasks.check', t.id)).toBe(1);
    expect(await checkTaskJob({ db }, { taskId: t.id })).toBe('filed');
    expect((await fx.cardFor('task.check_bar', t.id))!.args).toEqual({ outputRef: (await fx.task(t.id)).outputRef, metBar: true, taskId: t.id, checks: 1, met: 1, by: 'flint:rule' });
  });

  it('its asset turned off, its due time passed, or a day without moving ends a task, as a class', async () => {
    const due = await fx.dispatched(await fx.ciRun('wpf002/due'), { dueAt: later(2 * HOUR).toISOString() });
    const idle = await fx.dispatched(await fx.ciRun('wpf002/idle'));
    await runTaskJob({ db, bus }, { taskId: idle.id });
    const handedIn = await fx.dispatched(await fx.ciRun('wpf002/handed', { status: 'completed', conclusion: 'success' }));
    await runTaskJob({ db, bus }, { taskId: handedIn.id });
    bus.clear();
    // An hour on: all three are still in time.
    expect(await tick(later(HOUR))).toEqual({ sent: 3, failed: 0, cancelled: 0, scored: 0, ranOut: 0 });
    // Three hours on: the one with a due time is past it.
    expect(await tick(later(3 * HOUR))).toMatchObject({ failed: 1 });
    expect(await fx.task(due.id)).toMatchObject({ status: 'failed', failure: 'expired' });
    expect(await fx.task(idle.id)).toMatchObject({ status: 'dispatched' });
    // A day on: nothing moved, so the rest are given up on, the one waiting for its check included.
    expect(await tick(later(STALE_MS + HOUR))).toMatchObject({ failed: 2 });
    expect(await fx.task(idle.id)).toMatchObject({ status: 'failed', failure: 'expired' });
    expect(await fx.task(handedIn.id)).toMatchObject({ status: 'failed', failure: 'expired' });
    expect((await fx.task(idle.id)).completedAt).toBeInstanceOf(Date);

    const off = await fx.dispatched(await fx.ciRun('wpf002/tick-off'));
    await turnOff(db, CI_WATCHER.id);
    expect(await tick()).toMatchObject({ failed: 1, sent: 0 });
    expect(await fx.task(off.id)).toMatchObject({ status: 'failed', failure: 'asset_off' });
    await fx.watcherOn();
  });

  it('a proposed task whose dispatch card is gone is cancelled, with its reason on record; one whose card waits is left alone', async () => {
    const waiting = await fx.newTask(await fx.ciRun('wpf002/waiting'));
    const turnedDown = await fx.newTask(await fx.ciRun('wpf002/turned-down'));
    await rejectProposal(db, turnedDown.proposalId, { approvalId: await fx.sign(turnedDown.proposalId, 'reject') }, undefined, 'test');
    // Inside the grace a new task has (its card is filed a moment after its row): nothing.
    expect(await tick()).toEqual({ sent: 0, failed: 0, cancelled: 0, scored: 0, ranOut: 0 });
    expect(await tick(later(FILING_GRACE_MS + 60_000))).toMatchObject({ cancelled: 1 });
    expect(await fx.task(turnedDown.id)).toMatchObject({ status: 'cancelled', dispatchApprovalId: null });
    expect(await fx.task(waiting.id)).toMatchObject({ status: 'proposed' });
    const entry = await db.auditEntry.findFirstOrThrow({ where: { correlationId: `task:${turnedDown.id}`, action: 'task.cancel' } });
    expect(entry).toMatchObject({ actor: 'runtime:tasks', kind: 'decision', outcome: 'ok' });
    expect(entry.inputs).toEqual({ taskId: turnedDown.id, why: 'card_gone' });
  });

  it('the base rate follows tasks like it, the forecast names its task under the tasks rule and is counted under its own counter, and it is scored a day after the task ended, as it ended', async () => {
    const before = await db.task.count({ where: { status: { in: ['accepted', 'rejected', 'failed'] }, asset: { kind: 'ci_runner' }, completedAt: { not: null } } });
    const acceptedBefore = await db.task.count({ where: { status: 'accepted', asset: { kind: 'ci_runner' } } });
    const accepted = await fx.checked('wpf002/score-yes');
    await fx.signRun((await fx.cardFor('task.check_bar', accepted))!.id);
    const rejected = await fx.checked('wpf002/score-no', 'failure');
    const next = await fx.dispatched(await fx.ciRun('wpf002/score-next'));
    const forecast = await db.prediction.findUniqueOrThrow({ where: { id: (await fx.task(next.id)).predictionId! } });
    expect(forecast.probability).toBe(meetsBarProbability(acceptedBefore + 1, before + 2));
    expect(forecast.evidence).toEqual([{ kind: 'base_rate', ref: 'tasks.meets_bar.base_rate.v1', note: `${acceptedBefore + 1} of ${before + 2} like it were accepted in the last 90 days` }]);
    // It names its task under the tasks rule, which the ledger's own sweep does not know: only this tick settles it.
    expect(forecast).toMatchObject({ resolver: 'auto_world', resolverSpec: { taskId: next.id, rule: TASK_FORECAST_RULE }, createdBy: TASKS_WRITER, domain: 'assets', type: 'task_meets_bar' });
    expect(ruleOwner({ resolver: forecast.resolver, resolverSpec: forecast.resolverSpec, recType: null })).toBe('other');
    const counted = await db.$queryRaw<Array<{ count: number }>>`SELECT count FROM "ActionCounter" WHERE action = ${MEETS_BAR_COUNTER}`;
    expect(counted[0]!.count).toBe(await db.prediction.count({ where: { domain: 'assets' } }));
    expect(await db.$queryRaw<unknown[]>`SELECT 1 FROM "ActionCounter" WHERE action = 'ledger.prediction.record'`).toEqual([]);
    // A task that failed: its run gave up.
    expect(await failTask(db, next.id, ['queued'], 'timeout')).toBe(true);

    // Inside the day Will has to overrule a check: not yet. Nor a task that is still out.
    expect(await mayScore(db, new Date())).toBe(true);
    expect((await tick()).scored).toBe(0);
    expect(await db.$transaction((tx) => scoreTaskForecast(tx, accepted, new Date()))).toBe('not_yet');
    const stillOut = await fx.dispatched(await fx.ciRun('wpf002/score-out'));
    expect(await db.$transaction((tx) => scoreTaskForecast(tx, stillOut.id, later(2 * DAY)))).toBe('not_yet');
    // A clock that runs ahead of the database's does not score one early: the database holds the day itself, the
    // forecast is left for the next tick, and the tick goes on.
    const early: string[] = [];
    expect((await tick(later(OVERRIDE_WINDOW_MS + HOUR), early)).scored).toBe(0);
    expect(early).toEqual(expect.arrayContaining([expect.stringMatching(new RegExp(`^task ${accepted}: not scored \\(`))]));
    expect(await db.resolution.count({ where: { predictionId: (await fx.task(accepted)).predictionId! } })).toBe(0);

    // A day on (said by the database's owner: nobody else can move a task's end, or when its forecast was made).
    for (const id of [accepted, rejected, next.id]) await dayOn(id);
    // A rule of Will's that forbids settling predictions stops it, whatever it is scoped to (a rule tightens outside its scope too).
    await fx.policy('ledger.resolve.auto', 'forbidden', { domain: 'goals' });
    expect(await mayScore(db, new Date())).toBe(false);
    expect((await tick()).scored).toBe(0);
    await fx.owner(`UPDATE "ActionPolicy" SET active = false WHERE pattern = 'ledger.resolve.auto'`);
    expect(await mayScore(db, new Date())).toBe(true);

    const logs: string[] = [];
    const scored = await tick(new Date(), logs);
    expect(scored.scored).toBe(3);
    expect(logs).toEqual(expect.arrayContaining([`task ${accepted}: scored`, `task ${rejected}: scored`, `task ${next.id}: scored`]));
    const resolutionOf = async (taskId: string) => db.resolution.findUnique({ where: { predictionId: (await fx.task(taskId)).predictionId! } });
    const yes = (await resolutionOf(accepted))!;
    expect(yes).toMatchObject({ outcome: true, resolvedBy: 'auto_world', evidence: { taskId: accepted, status: 'accepted', via: 'tasks.tick' } });
    expect(yes.eventAt).toEqual((await fx.task(accepted)).completedAt);
    expect(await resolutionOf(rejected)).toMatchObject({ outcome: false, resolvedBy: 'auto_world' });
    expect(await resolutionOf(next.id)).toMatchObject({ outcome: false, evidence: { taskId: next.id, status: 'failed', via: 'tasks.tick' } });
    expect((await db.prediction.findUniqueOrThrow({ where: { id: yes.predictionId } })).status).toBe('resolved');
    // Scored once: a second tick finds nothing, and the scorer leaves a scored one alone.
    expect((await tick()).scored).toBe(0);
    expect(await db.$transaction((tx) => scoreTaskForecast(tx, accepted, new Date()))).toBe('left');
    expect(await db.$transaction((tx) => scoreTaskForecast(tx, 'tk0000000000000000', new Date()))).toBe('left');
    // Once it is scored, the result is final: an override is refused when it is filed.
    const e = await fx.file('task.bar_override', { taskId: rejected, to: 'accepted' }).then(() => undefined, (err: unknown) => err);
    expect(e).toBeInstanceOf(Refused);
    expect(e).toMatchObject({ status: 409, message: TASK_SAYS.scored });
  });

  it('a cancelled task’s forecast is never scored: it runs out once its date has passed, and not before', async () => {
    const cancelled = await fx.dispatched(await fx.ciRun('wpf002/score-cancelled'));
    await fx.signRun((await fx.file('task.cancel', { taskId: cancelled.id })).id);
    const pid = (await fx.task(cancelled.id)).predictionId!;
    const status = async () => (await db.prediction.findUniqueOrThrow({ where: { id: pid } })).status;
    await dayOn(cancelled.id);
    // Never scored, however long ago it was cancelled; and its date has not passed, so it stays open.
    expect(await db.$transaction((tx) => scoreTaskForecast(tx, cancelled.id, new Date()))).toBe('left');
    expect(await tick()).toMatchObject({ scored: 0, ranOut: 0 });
    expect(await db.$transaction((tx) => expireCancelledForecast(tx, cancelled.id, new Date()))).toBe(false);
    expect(await status()).toBe('open');
    // Its date passes (a test's stand-in: the forecast as it was made, moved into the past).
    await backdatePrediction(urls, pid, { madeAgo: 12 * DAY, dueAgo: HOUR });
    // A rule of Will's that forbids running predictions out stops it.
    await fx.policy('ledger.expire', 'forbidden');
    expect(await mayExpire(db, new Date())).toBe(false);
    expect((await tick()).ranOut).toBe(0);
    await fx.owner(`UPDATE "ActionPolicy" SET active = false WHERE pattern = 'ledger.expire'`);
    const logs: string[] = [];
    expect(await tick(new Date(), logs)).toMatchObject({ scored: 0, ranOut: 1 });
    expect(logs).toContain(`task ${cancelled.id}: forecast ran out`);
    expect(await status()).toBe('expired');
    expect(await db.resolution.count({ where: { predictionId: pid } })).toBe(0);
    // Once: a second tick finds nothing. And a task that is not cancelled is not run out here, whatever its date.
    expect((await tick()).ranOut).toBe(0);
    const out = await fx.dispatched(await fx.ciRun('wpf002/score-not-cancelled'));
    await backdatePrediction(urls, (await fx.task(out.id)).predictionId!, { madeAgo: 12 * DAY, dueAgo: HOUR });
    expect(await db.$transaction((tx) => expireCancelledForecast(tx, out.id, new Date()))).toBe(false);
    expect((await tick()).ranOut).toBe(0);
  });

  it('retention clears a task’s words and deletes its output only once it has ended: 30 days after for ops, 7 for a personal one; the title stays', async () => {
    const ended = await fx.checked('wpf002/kept', 'failure');
    const open = await fx.checked('wpf002/kept-open');
    // A run kept as personal (a test's own item): the task that watches it is as sensitive.
    const own = await fx.dispatched(await fx.entity('ci_run', { workflow: 'ci', status: 'completed', conclusion: 'failure' }, { sensitivity: 'personal' }));
    await runTaskJob({ db, bus }, { taskId: own.id });
    await checkTaskJob({ db }, { taskId: own.id });
    expect(await fx.task(own.id)).toMatchObject({ status: 'rejected', sensitivity: 'personal' });
    /** Ended that many days ago (the fixture's stand-in for time passing). */
    const endedAgo = (id: string, days: number) => fx.endedAgo(id, days * 24);
    const row = async (id: string) => ({ ...(await fx.task(id)), output: await db.taskOutput.count({ where: { taskId: id } }) });
    // Ended six days ago: nothing yet.
    await endedAgo(ended, 6);
    await endedAgo(own.id, 6);
    expect(await runRetention(db, 'UTC')).toMatchObject({ taskText: 0, taskOutputs: 0 });
    // Eight days: both raw outputs go; the personal task's words go too, the ops one's stay. The one still open keeps everything.
    await endedAgo(ended, 8);
    await endedAgo(own.id, 8);
    const week = await runRetention(db, 'UTC');
    expect(week).toMatchObject({ taskText: 1, taskOutputs: 2 });
    expect(await row(ended)).toMatchObject({ output: 0, textPurgedAt: null, outputSummary: 'The run failed.' });
    expect(await row(own.id)).toMatchObject({ output: 0, spec: null, acceptance: null, outputSummary: null, barEvidence: null, sensitivity: 'personal' });
    expect(await row(open)).toMatchObject({ output: 1, textPurgedAt: null, status: 'checking' });
    // Thirty-one days: its spec, bar, summary and evidence are cleared, and say so; what it is stays.
    await endedAgo(ended, 31);
    const month = await runRetention(db, 'UTC');
    expect(month).toMatchObject({ taskText: 1, taskOutputs: 0 });
    const cleared = await row(ended);
    expect(cleared).toMatchObject({ spec: null, acceptance: null, outputSummary: null, barEvidence: null, title: 'Watch a CI Run', status: 'rejected', metBar: false });
    expect(cleared.textPurgedAt).toBeInstanceOf(Date);
    expect(await row(open)).toMatchObject({ output: 1, textPurgedAt: null });
    expect((await row(open)).spec).not.toBeNull();
    // Once cleared, nothing is written back, and the views still read.
    await expect(db.task.update({ where: { id: ended }, data: { outputSummary: 'again' } })).rejects.toThrow();
    // Counts only on record.
    const audit = await db.auditEntry.findFirstOrThrow({ where: { action: 'maintenance.retention' }, orderBy: { seq: 'desc' } });
    expect(audit.inputs).toMatchObject({ taskText: month.taskText, taskOutputs: month.taskOutputs });
  });

});
