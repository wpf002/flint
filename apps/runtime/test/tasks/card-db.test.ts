/**
 * Asset and task cards on flint_test (P5): each of the seven is filed, signed
 * with a real key and carried out through the database's own triggers.
 *
 *  - The whole path with the CI watcher on: create, signed dispatch (forecast,
 *    queued and the run's job in one transaction), run, rule check, accept
 *    card, accepted with its proof on record.
 *  - A fault after a dispatch's writes leaves nothing dispatched and the card
 *    approved.
 *  - Every executor against a real signed approval: turning an asset on,
 *    requiring reviews, both local dispatches, accepting, cancelling,
 *    overruling a check.
 *  - Chat can never file or run any of them, nor a card under any other name
 *    of a task, an asset or a review; a job files only the accept card.
 *  - A dispatch that names a trading pool is refused at filing and at claim,
 *    and a Hive card that does not name its one pool plainly is never filed.
 *  - Switched off, no card is filed or run, and a card that waits stays so.
 *  - Of two cards Will signed about one task, only the later acts: the earlier
 *    fails with a sentence, also when the later signature lands while the
 *    earlier card is running, and an accept card that failed (that way, or
 *    because a rule stopped it) is asked for again. Only his own no ends the
 *    wait.
 *  - A refused dispatch uses none of the day's cap; accepting alone has a cap
 *    of its own and takes Will's rule for that check by name.
 *  - When a cancellation or an override runs, the task's other waiting cards
 *    are set aside with a sentence.
 *  - What the executor's own checks say when they refuse: a card that reads
 *    differently, one that names another result or another task, a result no
 *    longer kept.
 *  - A card whose subject he had Flint forget does not run, and ends with a
 *    sentence and no result.
 *  - A spend card says what it will cost, and a task or spend card holds whole
 *    numbers only: each said as a sentence when the card is filed.
 *  - A result is cleaned of what cannot be stored and kept under the digest
 *    the database computes for it.
 * Audit entries, results and logs carry ids, classes and counts only.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { ACCEPT_TEMPLATE, PAID_DISPATCH, TASKS_ORIGIN, TASK_REASONS, TASK_SAYS, TASK_SIGNED_ACTIONS, TASK_STATUS_SAYS, digestOf } from '@flint/policy';
import { NO_DB, freshDb, id, withClient, type TestUrls } from '../db';
import { createDb, type Db } from '../../src/db';
import { Refused, SPEND_NEEDS_ESTIMATE, WHOLE_NUMBERS_ONLY, claimProposal, createProposal, expireProposals, hasFraction, hivePoolNamed, rejectProposal } from '../../src/governance/proposals';
import { INTERNAL_ACTIONS, runInternal } from '../../src/governance/internal';
import { NEVER_PROMOTED } from '../../src/governance/promotion';
import { ASSETS, CI_WATCHER, assetOf, type AssetDef, enableArgsOf } from '../../src/assets/registry';
import { fileEnable, syncAssets, turnOff } from '../../src/assets/service';
import { cardProblem, checkTaskCard, runTask, runTaskCard } from '../../src/tasks/card';
import { acceptDeclined, checkTaskJob } from '../../src/tasks/check';
import { taskTick } from '../../src/tasks/tick';
import { taskView } from '../../src/tasks/view';
import { runTaskJob } from '../../src/tasks/run';
import type { TaskAdapter } from '../../src/tasks/adapters/types';
import { createTask, overrideTask } from '../../src/tasks/service';
import { runRetention } from '../../src/retention';
import { CANARY, FakeBus, draft, taskFixture, type TaskFixture } from './fixture';

const refusal = async (p: Promise<unknown>): Promise<Refused> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof Refused) return e;
    throw e;
  }
  throw new Error('expected a refusal, got success');
};

describe.skipIf(NO_DB)('asset and task cards on flint_test', () => {
  let urls: TestUrls;
  let db: Db;
  let fx: TaskFixture;
  const bus = new FakeBus();

  beforeAll(async () => {
    urls = await freshDb();
    db = createDb(urls.app);
    fx = await taskFixture(urls, db, bus);
  });
  afterAll(async () => db?.$disconnect());

  /** A card as chat or a broken caller might plant it: written straight into the table, pending. */
  async function planted(action: string, args: Record<string, unknown>, over: Record<string, unknown> = {}): Promise<string> {
    const pid = id('pr');
    const o = { kind: 'task', origin: 'chat:turn1', templateId: null, tainted: false, consequential: false, sensitivity: 'ops', ...over };
    await withClient(urls.app, (c) => c.query(
      `INSERT INTO "Proposal" (id, kind, origin, action, "templateId", args, "argsDigest", "argsProvenance", tainted, sensitivity, consequential, "expiresAt")
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, '{}'::jsonb, $8, $9, $10, now() + interval '1 hour')`,
      [pid, o.kind, o.origin, action, o.templateId, JSON.stringify(args), digestOf(args), o.tainted, o.sensitivity, o.consequential],
    ));
    return pid;
  }

  it('turning the CI watcher on: its card signs what the registry says it is, waits for the GitHub source, and the asset is on only once Will signed', async () => {
    await syncAssets(db);
    expect(await db.asset.findUniqueOrThrow({ where: { id: CI_WATCHER.id } })).toMatchObject({ enabled: false, approvalId: null, kind: 'ci_runner', dispatchAction: 'task.dispatch.ci_runner', spends: false });
    const filed = await fileEnable(db, CI_WATCHER.id);
    const card = await db.proposal.findUniqueOrThrow({ where: { id: filed.proposalId } });
    expect(card).toMatchObject({ kind: 'policy', origin: 'console', action: 'asset.enable', tainted: false, consequential: true, sensitivity: 'ops', reason: TASK_REASONS.enable, reviewRequired: true });
    expect(card.args).toEqual({ assetId: CI_WATCHER.id, kind: 'ci_runner', externalRef: 'github:ci:v1', name: 'CI Watcher', capabilities: ['watch_ci'], dispatchAction: 'task.dispatch.ci_runner', spends: false, entityId: null });
    expect(card.expiresAt.getTime() - card.createdAt.getTime()).toBeLessThanOrEqual(7 * 86_400_000 + 1000);
    // The same card while it waits; nothing is on yet.
    expect(await fileEnable(db, CI_WATCHER.id)).toEqual({ proposalId: filed.proposalId, deduped: true });
    expect((await db.asset.findUniqueOrThrow({ where: { id: CI_WATCHER.id } })).enabled).toBe(false);
    expect(await fx.signRun(filed.proposalId)).toEqual({ assetId: CI_WATCHER.id, enabled: true });
    const on = await db.asset.findUniqueOrThrow({ where: { id: CI_WATCHER.id } });
    expect(on).toMatchObject({ enabled: true, approvalId: (await db.proposal.findUniqueOrThrow({ where: { id: filed.proposalId } })).approvalId });
    // Already on: there is nothing to sign. An asset the registry does not know is not one.
    expect(await refusal(fileEnable(db, CI_WATCHER.id))).toMatchObject({ status: 400, message: TASK_SAYS.nothing });
    expect(await refusal(fileEnable(db, 'as-unknown-v1'))).toMatchObject({ status: 404, message: TASK_SAYS.noAsset });
    // A card that says the asset is something else is never filed.
    const lie = { ...(card.args as object), capabilities: ['watch_ci', 'run_anything'] };
    expect(await refusal(fx.file('asset.enable', lie, { kind: 'policy', consequential: true }))).toMatchObject({ status: 400, message: TASK_SAYS.noAsset });
    expect(await refusal(fx.file('asset.enable', card.args as Record<string, unknown>, { kind: 'task' }))).toMatchObject({ status: 400, message: TASK_SAYS.kind });
  });

  it('the whole path: create, signed dispatch, forecast, run, rule check, accept card, accepted', async () => {
    const item = await fx.ciRun('wpf002/flint', { status: 'in_progress' });
    bus.clear();
    const t = await fx.newTask(item);
    const created = await fx.task(t.id);
    expect(created).toMatchObject({ status: 'proposed', title: 'Watch a CI Run', origin: 'will', sensitivity: 'ops', tainted: false, entityIds: [item], dispatchApprovalId: null, predictionId: null });
    const card = await db.proposal.findUniqueOrThrow({ where: { id: t.proposalId } });
    expect(card).toMatchObject({ kind: 'task', origin: 'console', action: 'task.dispatch.ci_runner', templateId: null, tainted: false, sensitivity: 'ops', consequential: false, reason: TASK_REASONS.dispatch, estCostUsd: null });
    expect(card.args).toMatchObject({ taskId: t.id, assetId: CI_WATCHER.id, assetKind: 'ci_runner', title: 'Watch a CI Run', goalId: null, stepKey: null, dueAt: null, sensitivity: 'ops', tainted: false, estCostMicros: 0 });
    expect((card.args as { spec: unknown }).spec).toEqual(created.spec);
    expect((card.args as { acceptance: unknown }).acceptance).toEqual(created.acceptance);

    // Will signs: the forecast, the move to queued and the run's job, in the card's one transaction.
    expect(await fx.signRun(t.proposalId)).toMatchObject({ taskId: t.id });
    const queued = await fx.task(t.id);
    expect(queued).toMatchObject({ status: 'queued', dispatchApprovalId: (await db.proposal.findUniqueOrThrow({ where: { id: t.proposalId } })).approvalId });
    const forecast = await db.prediction.findUniqueOrThrow({ where: { id: queued.predictionId! } });
    expect(forecast).toMatchObject({ domain: 'assets', type: 'task_meets_bar', method: 'base_rate', resolver: 'auto_world', createdBy: 'runtime:tasks', status: 'open', kind: 'binary', probability: 0.5, tainted: false });
    expect(forecast.claim).toBe(`task#${t.id.slice(-6)} meets its bar by ${forecast.resolveBy.toISOString().slice(0, 10)}`);
    expect(bus.of('tasks.run')).toHaveLength(1);
    expect(bus.of('tasks.run')[0]).toMatchObject({ data: { taskId: t.id }, options: { singletonKey: t.id } });
    expect(bus.of('tasks.run')[0]!.options.db, 'sent in the card’s transaction').toBeDefined();
    expect((await db.proposal.findUniqueOrThrow({ where: { id: t.proposalId } }))).toMatchObject({ status: 'executed', result: { taskId: t.id, predictionId: forecast.id } });

    // The run: dispatched, and waiting while CI is still going.
    expect(await runTaskJob({ db, bus }, { taskId: t.id })).toBe('waiting');
    expect(await fx.task(t.id)).toMatchObject({ status: 'dispatched', outputRef: null, attempts: 0 });
    expect((await fx.task(t.id)).dispatchedAt).toBeInstanceOf(Date);
    // CI finishes: the result is stored (as outside text) and the check is sent, together.
    await fx.ciRun('wpf002/flint', { status: 'completed', conclusion: 'success' });
    expect(await runTaskJob({ db, bus }, { taskId: t.id })).toBe('submitted');
    const submitted = await fx.task(t.id);
    expect(submitted).toMatchObject({ status: 'submitted', outputSummary: 'The run passed.', attempts: 1, metBar: null });
    const output = await db.taskOutput.findUniqueOrThrow({ where: { taskId: t.id } });
    expect(output).toMatchObject({ tainted: true, body: { ref: `ci_run#${item.slice(-6)}`, status: 'completed', conclusion: 'success', sha: expect.stringMatching(/^[0-9a-f]{40}$/) } });
    expect(submitted.outputRef).toBe(`out:${output.sha256.slice(0, 16)}`);
    expect(bus.of('tasks.check')).toHaveLength(1);
    expect(bus.of('tasks.check')[0]!.options.db).toBeDefined();

    // The check: by rule, written once; it passed, so Will is offered the result on a card of ids and counts.
    expect(await checkTaskJob({ db }, { taskId: t.id })).toBe('filed');
    expect(await fx.task(t.id)).toMatchObject({ status: 'checking', metBar: true, barCheckedBy: 'flint:rule', barEvidence: [{ id: 'a1', op: 'ci', met: true }, { id: 'a2', op: 'refs_known', met: true }], acceptedAuditId: null });
    const accept = (await fx.cardFor('task.check_bar', t.id))!;
    expect(accept).toMatchObject({ kind: 'task', origin: TASKS_ORIGIN, templateId: ACCEPT_TEMPLATE, status: 'pending', tainted: false, sensitivity: 'ops', reason: TASK_REASONS.accept, reviewRequired: false });
    // It names the result it accepts (the start of the digest the database gave its output) and that it met its bar.
    const handedIn = await fx.task(t.id);
    expect(handedIn.outputRef).toMatch(/^out:[0-9a-f]{16}$/);
    expect(accept.args).toEqual({ taskId: t.id, outputRef: handedIn.outputRef, metBar: true, checks: 2, met: 2, by: 'flint:rule' });
    expect(accept.createdAt.getTime()).toBeGreaterThanOrEqual(handedIn.submittedAt!.getTime());
    // Checked again (a job run twice): the same card, the bar as it was.
    expect(await checkTaskJob({ db }, { taskId: t.id })).toBe('waiting');
    expect(await db.proposal.count({ where: { action: 'task.check_bar', args: { path: ['taskId'], equals: t.id } } })).toBe(1);

    // Will signs it: the proof, then accepted, in the card's transaction.
    expect(await fx.signRun(accept.id)).toEqual({ taskId: t.id, accepted: true });
    const accepted = await fx.task(t.id);
    expect(accepted).toMatchObject({ status: 'accepted', metBar: true, barCheckedBy: 'flint:rule' });
    expect(accepted.completedAt).toBeInstanceOf(Date);
    const proof = await db.auditEntry.findFirstOrThrow({ where: { id: accepted.acceptedAuditId! } });
    expect(proof).toMatchObject({ kind: 'action', action: 'task.check_bar', outcome: 'ok', correlationId: `task:${t.id}`, tier: 'approval', context: 'console' });
    expect(proof.inputs).toMatchObject({ taskId: t.id, proposalId: accept.id, checks: 2, met: 2, by: 'flint:rule' });
    // A run or a check sent again for a task that has ended does nothing.
    expect(await runTaskJob({ db, bus }, { taskId: t.id })).toBe('skipped');
    expect(await checkTaskJob({ db }, { taskId: t.id })).toBe('skipped');
  });

  it('a fault after a dispatch’s writes leaves nothing dispatched, no forecast, no job, and the card approved to run again', async () => {
    const item = await fx.ciRun('wpf002/fault');
    const t = await fx.newTask(item);
    await fx.approve(t.proposalId);
    const before = await db.prediction.count({ where: { domain: 'assets' } });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const err = await refusal(runTaskCard(db, t.proposalId, undefined, 'UTC', 'test', { assets: true }, { afterWrites: async () => { throw new Error(`${CANARY} boom`); } }));
    expect(err).toMatchObject({ status: 409, message: 'Flint couldn’t carry it out.' });
    expect(errors.mock.calls.flat().join(' ')).not.toContain(CANARY);
    errors.mockRestore();
    expect(await fx.task(t.id)).toMatchObject({ status: 'proposed', dispatchApprovalId: null, predictionId: null });
    expect(await db.prediction.count({ where: { domain: 'assets' } })).toBe(before);
    expect(await db.proposal.findUniqueOrThrow({ where: { id: t.proposalId } })).toMatchObject({ status: 'approved', error: null });
    // The same card runs once the fault is gone, and only once: its approval is used.
    expect(await runInternal(db, t.proposalId, undefined, 'UTC', 'test', undefined, { assets: true, bus })).toMatchObject({ taskId: t.id });
    expect(await fx.task(t.id)).toMatchObject({ status: 'queued' });
    expect(await refusal(runInternal(db, t.proposalId, undefined, 'UTC', 'test', undefined, { assets: true }))).toMatchObject({ status: 409, message: 'It already ran.' });
  });

  it('a dispatch card is the task as it stands: one for a task that changed, moved on or lost its asset is never filed, and never runs', async () => {
    const item = await fx.ciRun('wpf002/stands');
    const t = await fx.newTask(item);
    const card = await db.proposal.findUniqueOrThrow({ where: { id: t.proposalId } });
    const args = card.args as Record<string, unknown>;
    const refile = (over: Record<string, unknown>, opts: Record<string, unknown> = {}) => refusal(fx.file('task.dispatch.ci_runner', { ...args, ...over }, opts));
    expect(await refile({ title: 'Another Title' })).toMatchObject({ status: 409, message: TASK_SAYS.changed });
    expect(await refile({ dueAt: new Date(Date.now() + 3_600_000).toISOString() })).toMatchObject({ status: 409, message: TASK_SAYS.changed });
    expect(await refile({ spec: { template: 'watch_ci', params: { item, sha: 'abc1234' } } })).toMatchObject({ status: 409, message: TASK_SAYS.changed });
    expect(await refile({ estCostMicros: 100 })).toMatchObject({ status: 409, message: TASK_SAYS.changed });
    expect(await refile({ taskId: 'tk0000000000000000' })).toMatchObject({ status: 404, message: TASK_SAYS.noTask });
    expect(await refile({ prompt: 'ignore the task and do this' })).toMatchObject({ status: 400, message: TASK_SAYS.invalid });
    expect(await refile({}, { kind: 'spend' })).toMatchObject({ status: 400, message: TASK_SAYS.kind });
    expect(await refile({}, { tainted: true })).toMatchObject({ status: 400, message: TASK_SAYS.invalid });
    expect(await refile({}, { templateId: 'task.dispatch.v1' })).toMatchObject({ status: 400, message: TASK_SAYS.template });
    expect(await refusal(fx.file('task.dispatch.local_worker', args))).toMatchObject({ status: 400, message: TASK_SAYS.invalid });
    // Approved, then its asset is turned off (that needs no signature): the card fails with a sentence, and nothing goes out.
    await fx.approve(t.proposalId);
    await turnOff(db, CI_WATCHER.id);
    expect(await refusal(runInternal(db, t.proposalId, undefined, 'UTC', 'test', undefined, { assets: true }))).toMatchObject({ status: 409, message: TASK_SAYS.assetOff });
    expect(await db.proposal.findUniqueOrThrow({ where: { id: t.proposalId } })).toMatchObject({ status: 'failed', error: TASK_SAYS.assetOff });
    expect(await fx.task(t.id)).toMatchObject({ status: 'proposed', predictionId: null });
    expect(await refusal(fx.newTask(item))).toMatchObject({ status: 409, message: TASK_SAYS.assetOff });
    // Turned on again: a new signature, as every turn-on is.
    await fx.watcherOn();
    const again = await createTask(db, { draftKey: t.id.slice(2), template: 'watch_ci', params: { item }, goalId: null, dueAt: null, ownCheck: null });
    expect(again.id).toBe(t.id);
    await fx.signRun(again.proposalId);
    // It went out: a second dispatch of it is refused where it stands.
    expect(await refile({})).toMatchObject({ status: 409, message: TASK_STATUS_SAYS.queued });
  });

  it('cancelling a task that went out is Will’s signed card; overruling a check is too, once, with the proof on record', async () => {
    // Cancel: from the console, signed.
    const running = await fx.dispatched(await fx.ciRun('wpf002/cancel'));
    await runTaskJob({ db, bus }, { taskId: running.id });
    const cancel = await fx.file('task.cancel', { taskId: running.id });
    expect(await db.proposal.findUniqueOrThrow({ where: { id: cancel.id } })).toMatchObject({ kind: 'task', reason: TASK_REASONS.cancel, consequential: false });
    expect(await fx.signRun(cancel.id)).toEqual({ taskId: running.id, cancelled: true });
    expect(await fx.task(running.id)).toMatchObject({ status: 'cancelled', failure: null });
    expect(await refusal(fx.file('task.cancel', { taskId: running.id }))).toMatchObject({ status: 409, message: TASK_STATUS_SAYS.cancelled });

    // A run that failed its check is rejected by Flint; Will accepts it anyway.
    const failed = await fx.checked('wpf002/override', 'failure');
    expect(await fx.task(failed)).toMatchObject({ status: 'rejected', metBar: false, barCheckedBy: 'flint:rule', acceptedAuditId: null });
    expect(await refusal(fx.file('task.bar_override', { taskId: failed, to: 'rejected' }))).toMatchObject({ status: 400, message: TASK_SAYS.notOverride });
    const over = await fx.file('task.bar_override', { taskId: failed, to: 'accepted' });
    expect(await db.proposal.findUniqueOrThrow({ where: { id: over.id } })).toMatchObject({ kind: 'task', reason: TASK_REASONS.overrideAccept, consequential: true });
    expect(await fx.signRun(over.id)).toEqual({ taskId: failed, to: 'accepted' });
    const overruled = await fx.task(failed);
    expect(overruled).toMatchObject({ status: 'accepted', metBar: false, barCheckedBy: 'will' });
    expect(await db.auditEntry.findFirstOrThrow({ where: { id: overruled.acceptedAuditId! } })).toMatchObject({ action: 'task.bar_override', outcome: 'ok', correlationId: `task:${failed}` });
    // His decision is final: no second override either way.
    expect(await refusal(fx.file('task.bar_override', { taskId: failed, to: 'rejected' }))).toMatchObject({ status: 409, message: TASK_SAYS.decided });

    // A result that passed and waits for him: he may reject it anyway. One he accepted on his own card stays accepted.
    const passed = await fx.checked('wpf002/passed');
    const reject = await fx.file('task.bar_override', { taskId: passed, to: 'rejected' });
    expect(await fx.signRun(reject.id)).toEqual({ taskId: passed, to: 'rejected' });
    expect(await fx.task(passed)).toMatchObject({ status: 'rejected', metBar: true, barCheckedBy: 'will', acceptedAuditId: null });
    const his = await fx.checked('wpf002/his');
    await fx.signRun((await fx.cardFor('task.check_bar', his))!.id);
    expect(await refusal(fx.file('task.bar_override', { taskId: his, to: 'rejected' }))).toMatchObject({ status: 409, message: TASK_SAYS.decided });
    // Before there is a check there is nothing to overrule.
    const fresh = await fx.dispatched(await fx.ciRun('wpf002/fresh'));
    expect(await refusal(fx.file('task.bar_override', { taskId: fresh.id, to: 'accepted' }))).toMatchObject({ status: 409, message: TASK_STATUS_SAYS.queued });
  });

  it('once Will promotes task.check_bar by name, Flint accepts a passing result itself, with the same proof and under a daily cap; a rule that forbids it stops checking', async () => {
    await fx.policy('task.check_bar', 'alone');
    const item = await fx.ciRun('wpf002/alone', { status: 'completed', conclusion: 'success' });
    const t = await fx.dispatched(item);
    await runTaskJob({ db, bus }, { taskId: t.id });
    expect(await checkTaskJob({ db }, { taskId: t.id })).toBe('accepted');
    const done = await fx.task(t.id);
    expect(done).toMatchObject({ status: 'accepted', metBar: true, barCheckedBy: 'flint:rule' });
    expect(await db.auditEntry.findFirstOrThrow({ where: { id: done.acceptedAuditId! } })).toMatchObject({ action: 'task.check_bar', outcome: 'ok', tier: 'alone', context: 'autonomous', actor: 'runtime:tasks' });
    expect(await fx.cardFor('task.check_bar', t.id)).toBeNull();
    // What Flint accepted by itself, Will can still overrule.
    const over = await fx.file('task.bar_override', { taskId: t.id, to: 'rejected' });
    expect(await fx.signRun(over.id)).toMatchObject({ to: 'rejected' });
    expect(await fx.task(t.id)).toMatchObject({ status: 'rejected', barCheckedBy: 'will', acceptedAuditId: done.acceptedAuditId });

    // Accepting alone has a cap the code holds, 20 a day: past it, a passing result goes to Will on a card like any
    // other, and his signature on that card is not counted under it.
    const today = new Date().toISOString().slice(0, 10);
    const alone = async () => (await db.actionCounter.findUnique({ where: { action_day: { action: 'task.check_bar', day: today } } }))?.count ?? 0;
    expect(await alone()).toBe(1);
    await db.$queryRaw`SELECT claim_action('task.check_bar', ${today}, 20) FROM generate_series(1, 19)`;
    expect(await alone()).toBe(20);
    const capped = await fx.dispatched(await fx.ciRun('wpf002/alone-capped', { status: 'completed', conclusion: 'success' }));
    await runTaskJob({ db, bus }, { taskId: capped.id });
    expect(await checkTaskJob({ db }, { taskId: capped.id })).toBe('filed');
    expect(await fx.task(capped.id)).toMatchObject({ status: 'checking', metBar: true, acceptedAuditId: null });
    expect(await fx.signRun((await fx.cardFor('task.check_bar', capped.id))!.id)).toEqual({ taskId: capped.id, accepted: true });
    expect(await alone()).toBe(20);
    await fx.owner(`UPDATE "ActionPolicy" SET active = false WHERE pattern = 'task.check_bar'`);
    await fx.owner(`DELETE FROM "ActionCounter" WHERE action = 'task.check_bar'`);
    // A rule over all task actions does not promote it: it takes a rule that names it.
    await fx.policy('task.*', 'alone');
    const wide = await fx.dispatched(await fx.ciRun('wpf002/alone-wildcard', { status: 'completed', conclusion: 'success' }));
    await runTaskJob({ db, bus }, { taskId: wide.id });
    expect(await checkTaskJob({ db }, { taskId: wide.id })).toBe('filed');
    expect(await alone()).toBe(0);
    await fx.owner(`UPDATE "ActionPolicy" SET active = false WHERE pattern = 'task.*'`);

    await fx.policy('task.check_bar', 'forbidden');
    const stopped = await fx.dispatched(await fx.ciRun('wpf002/stopped', { status: 'completed', conclusion: 'success' }));
    await runTaskJob({ db, bus }, { taskId: stopped.id });
    expect(await checkTaskJob({ db }, { taskId: stopped.id })).toBe('stopped');
    expect(await fx.task(stopped.id)).toMatchObject({ status: 'submitted', metBar: null });
    await fx.owner(`UPDATE "ActionPolicy" SET active = false WHERE pattern = 'task.check_bar'`);
  });

  it('requiring reviews is Will’s signed card, needs a reviewer that is on, and holds the last reviewer on', async () => {
    const reviewer: AssetDef = assetOf({ id: 'as-test-reviewer-v1', kind: 'local_reviewer', externalRef: 'ollama:reviewer:test', name: 'Local Reviews', capabilities: ['review'], spends: false, line: 'The local model reviews cards before you approve them.' });
    const registry = [...ASSETS, reviewer];
    expect(await refusal(fx.file('review.enforce', { gate: 'proposal', enforced: true }, { kind: 'policy', consequential: true }))).toMatchObject({ status: 409, message: TASK_SAYS.reviewerFirst });
    expect(await refusal(fx.file('review.enforce', { gate: 'proposal', enforced: false }, { kind: 'policy', consequential: true }))).toMatchObject({ status: 400, message: TASK_SAYS.nothing });
    // The reviewer joins the registry in a later part: here it is a test's, turned on by its own real signed card.
    await syncAssets(db, registry);
    const enableArgs = enableArgsOf(reviewer);
    const input = await checkTaskCard(db, { kind: 'policy', origin: 'console', action: 'asset.enable', args: enableArgs, argsProvenance: {}, tainted: false, sensitivity: 'ops', destructive: false, consequential: true, ttlMinutes: 60 }, registry);
    expect(input).toMatchObject({ reason: TASK_REASONS.enable, consequential: true });
    // Outside the code registry it is not an asset: the card is never filed through the front door.
    expect(await refusal(fx.file('asset.enable', enableArgs, { kind: 'policy', consequential: true }))).toMatchObject({ status: 400, message: TASK_SAYS.noAsset });
    const enable = await planted('asset.enable', enableArgs, { kind: 'policy', origin: 'console', consequential: true });
    // ...and the executor holds to the registry it is given too.
    await fx.approve(enable);
    expect(await runTaskCard(db, enable, undefined, 'UTC', 'test', { assets: true, registry })).toEqual({ assetId: reviewer.id, enabled: true });

    const require = await fx.file('review.enforce', { gate: 'proposal', enforced: true }, { kind: 'policy', consequential: true });
    expect(await db.proposal.findUniqueOrThrow({ where: { id: require.id } })).toMatchObject({ kind: 'policy', reason: TASK_REASONS.require, consequential: true, reviewRequired: false });
    expect(await fx.signRun(require.id)).toEqual({ gate: 'proposal', enforced: true });
    expect(await db.reviewGate.findUniqueOrThrow({ where: { id: 'proposal' } })).toMatchObject({ enforced: true, approvalId: (await db.proposal.findUniqueOrThrow({ where: { id: require.id } })).approvalId });
    // While reviews are required, the last reviewer stays on: Will reads why.
    expect(await refusal(turnOff(db, reviewer.id))).toMatchObject({ status: 409, message: TASK_SAYS.reviewerStays });
    // The card that stops requiring them never waits for a review itself.
    const stop = await fx.file('review.enforce', { gate: 'proposal', enforced: false }, { kind: 'policy', consequential: true });
    expect(await db.proposal.findUniqueOrThrow({ where: { id: stop.id } })).toMatchObject({ reason: TASK_REASONS.stopRequiring, reviewRequired: false });
    expect(await fx.signRun(stop.id)).toEqual({ gate: 'proposal', enforced: false });
    await turnOff(db, reviewer.id);
    expect(await refusal(turnOff(db, reviewer.id))).toMatchObject({ status: 400, message: TASK_SAYS.nothing });
  });

  it('chat can never file any of them, nor run one however it got there; a job files only the accept card', async () => {
    const item = await fx.ciRun('wpf002/chat', { status: 'completed', conclusion: 'success' });
    const t = await fx.newTask(item);
    const dispatchArgs = (await db.proposal.findUniqueOrThrow({ where: { id: t.proposalId } })).args as Record<string, unknown>;
    const checkedId = await fx.checked('wpf002/chat-checked');
    const argsOf: Record<string, Record<string, unknown>> = {
      'asset.enable': enableArgsOf(CI_WATCHER),
      'review.enforce': { gate: 'proposal', enforced: true },
      'task.dispatch.local_worker': dispatchArgs,
      'task.dispatch.ci_runner': dispatchArgs,
      'task.check_bar': { taskId: checkedId, checks: 2, met: 2, by: 'flint:rule' },
      'task.cancel': { taskId: checkedId },
      'task.bar_override': { taskId: checkedId, to: 'rejected' },
      [PAID_DISPATCH]: dispatchArgs,
    };
    expect(Object.keys(argsOf).sort()).toEqual([...TASK_SIGNED_ACTIONS, PAID_DISPATCH].sort());
    const audited = () => db.auditEntry.count({ where: { outcome: 'denied', decision: 'deny' } });
    for (const [action, args] of Object.entries(argsOf)) {
      for (const kind of ['task', 'policy', 'spend', 'tool_call'] as const) {
        expect(await refusal(fx.file(action, args, { origin: 'chat:turn1', kind })), `${action} as ${kind}`).toMatchObject({ status: 409, message: TASK_SAYS.fromConsole });
      }
      // A job: nothing off the closed list (the tier engine refuses and audits that), and of the list only the accept card, under its template.
      const before = await audited();
      const e = await refusal(createProposal(db, { kind: 'task', origin: 'runtime:tasks', action, templateId: 'task.other.v1', args, argsProvenance: {}, tainted: false, sensitivity: 'ops', destructive: false, consequential: false, ttlMinutes: 60 }, 'runtime:tasks'));
      expect(e.status, action).toBe(409);
      if (action !== 'task.check_bar') {
        // No dispatch is a job's to ask for either: only checking a result is on the closed list.
        expect(e.message, action).toMatch(/^forbidden: .* is not an autonomous action$/);
        expect(await audited()).toBe(before + 1);
      } else expect(e.message, action).toBe(TASK_SAYS.fromConsole);
      // Will files the accept card for nobody: Flint does, once a task passed its checks.
      if (action === 'task.check_bar') expect(await refusal(fx.file(action, args))).toMatchObject({ status: 409, message: TASK_SAYS.flintFiles });
    }
    // Nor a card under any other name of a task, an asset or a review, known or not: the database reads what a
    // signature is for from such a name, so none from chat is ever there to be signed.
    const lookAlikes = ['task.note', 'task.', 'task.dispatch.', 'task.dispatch.hive_bot', 'task.cancel ', 'task.cancel.v2', 'review.local', 'review.trident_panel', 'review.anything', 'asset.disable', 'asset.enable.v2', 'hive.dispatch_job'];
    for (const action of lookAlikes) {
      for (const kind of ['task', 'tool_call'] as const) {
        const e = await refusal(createProposal(db, { kind, origin: 'chat:turn1', action, args: { taskId: checkedId, pool: 'research' }, argsProvenance: {}, tainted: false, sensitivity: 'ops', destructive: false, consequential: false, ttlMinutes: 60 }, 'test'));
        expect(e, `${action} as ${kind}`).toMatchObject({ status: 409, message: TASK_SAYS.fromConsole });
      }
    }
    expect(await db.proposal.count({ where: { action: { in: lookAlikes } } })).toBe(0);
    // So a card he approved cannot be undone from chat: his cancellation of a task still runs after chat tried.
    const live = await fx.dispatched(await fx.ciRun('wpf002/chat-cannot-void'));
    const stop = await fx.file('task.cancel', { taskId: live.id });
    await fx.approve(stop.id);
    expect(await refusal(createProposal(db, { kind: 'tool_call', origin: 'chat:turn2', action: 'task.note', args: { taskId: live.id }, argsProvenance: {}, tainted: false, sensitivity: 'ops', destructive: false, consequential: false, ttlMinutes: 60 }, 'test'))).toMatchObject({ status: 409, message: TASK_SAYS.fromConsole });
    expect(await runInternal(db, stop.id, undefined, 'UTC', 'test', undefined, { assets: true, bus })).toEqual({ taskId: live.id, cancelled: true });
    // A card planted as chat's (written straight into the table) cannot be approved: his signature for it is
    // refused and left unused, and it never runs. Nothing changes.
    for (const action of TASK_SIGNED_ACTIONS) {
      const pid = await planted(action, argsOf[action]!, { kind: action === 'asset.enable' || action === 'review.enforce' ? 'policy' : 'task' });
      expect(await refusal(fx.approve(pid)), action).toMatchObject({ status: 409, message: 'Flint isn’t allowed to run this.' });
      expect(await db.proposal.findUniqueOrThrow({ where: { id: pid } })).toMatchObject({ status: 'pending', approvalId: null });
      expect(await refusal(runInternal(db, pid, undefined, 'UTC', 'test', undefined, { assets: true })), action).toMatchObject({ status: 409 });
      expect(await db.proposal.findUniqueOrThrow({ where: { id: pid } })).toMatchObject({ status: 'pending', approvalId: null });
      // Whatever the tier engine says, the executor itself runs no card of chat's: by who filed it, as what kind, under which template.
      expect(cardProblem(action, { origin: 'chat:turn1', templateId: null, kind: action === 'asset.enable' || action === 'review.enforce' ? 'policy' : 'task', tainted: false }), action).toBe(TASK_SAYS.fromConsole);
    }
    expect(cardProblem('task.cancel', { origin: 'console', templateId: null, kind: 'task', tainted: false })).toBeUndefined();
    expect(cardProblem('task.cancel', { origin: 'runtime:tasks', templateId: null, kind: 'task', tainted: false })).toBe(TASK_SAYS.fromConsole);
    // And such a card, while it waits, does not stand in for his own: the console's filing of the same card is
    // another card, which he can approve.
    const planted_ = await db.proposal.findFirstOrThrow({ where: { action: 'task.cancel', origin: 'chat:turn1', status: 'pending', args: { path: ['taskId'], equals: checkedId } } });
    const own = await fx.file('task.cancel', { taskId: checkedId });
    expect(own).toMatchObject({ deduped: false });
    expect(own.id).not.toBe(planted_.id);
    expect(await fx.file('task.cancel', { taskId: checkedId })).toMatchObject({ id: own.id, deduped: true });
    await rejectProposal(db, own.id, {}, undefined, 'test');
    expect(await fx.task(t.id)).toMatchObject({ status: 'proposed' });
    expect(await fx.task(checkedId)).toMatchObject({ status: 'checking' });
    expect((await db.reviewGate.findUniqueOrThrow({ where: { id: 'proposal' } })).enforced).toBe(false);
    // Nor an accept card of Will's own filing, or under another template, however it got there.
    for (const over of [{ origin: 'console' }, { origin: TASKS_ORIGIN, templateId: 'task.other.v1' }]) {
      const pid = await planted('task.check_bar', argsOf['task.check_bar']!, over);
      await fx.approve(pid);
      expect(await refusal(runInternal(db, pid, undefined, 'UTC', 'test', undefined, { assets: true }))).toMatchObject({ status: 409, message: TASK_SAYS.flintFiles });
    }
    expect(await fx.task(checkedId)).toMatchObject({ status: 'checking', acceptedAuditId: null });
    // The seven are the runtime's own to carry out (never claimed by the server), and a dispatch that spends is nobody's.
    for (const a of TASK_SIGNED_ACTIONS) expect(INTERNAL_ACTIONS.has(a), a).toBe(true);
    expect(INTERNAL_ACTIONS.has(PAID_DISPATCH)).toBe(false);
    for (const a of ['asset.enable', 'review.enforce', 'task.cancel', 'task.bar_override', PAID_DISPATCH, 'review.trident_panel', 'hive.dispatch_job']) expect(NEVER_PROMOTED.has(a), a).toBe(true);
  });

  it('a dispatch that names a trading pool is refused at filing and again at claim, whoever signed it', async () => {
    const hive = (pool: string) => ({ pool, job: 'rebalance' });
    for (const pool of ['crypto-trading', 'Broker-East-1', 'fx.exchange']) {
      const before = await db.auditEntry.count({ where: { action: 'hive.dispatch_job', outcome: 'denied' } });
      const e = await refusal(fx.file('hive.dispatch_job', hive(pool), { kind: 'tool_call' }));
      expect(e, pool).toMatchObject({ status: 409 });
      expect(e.message, pool).toMatch(/^forbidden: pool \S+ trades$/);
      expect(await db.auditEntry.count({ where: { action: 'hive.dispatch_job', outcome: 'denied' } })).toBe(before + 1);
    }
    // A pool that does not trade is an ordinary card that waits for Will (and nothing carries it out).
    const ok = await fx.file('hive.dispatch_job', hive('research'), { kind: 'tool_call' });
    expect(ok).toMatchObject({ tier: 'approval' });
    // The rule reads one name, said once at the top of the card. A card that says its pool any other way would
    // not be read at all, so it is never filed: a list, an object, no pool, words with spaces, a look-alike
    // letter, another spelling of the key, a pool further down, or a second one beside the first.
    const filed = () => db.proposal.count({ where: { action: 'hive.dispatch_job' } });
    const before = await filed();
    const unreadable: Array<Record<string, unknown>> = [
      { pool: ['crypto-trading'], job: 'rebalance' }, { pool: { name: 'crypto-trading' }, job: 'rebalance' }, { job: 'rebalance' }, { pool: '', job: 'rebalance' }, { pool: 7, job: 'rebalance' },
      { pool: 'Broker East 1', job: 'rebalance' }, { pool: 'сrypto-trading', job: 'rebalance' }, { pool: '-research', job: 'rebalance' }, { pool: 'r'.repeat(65), job: 'rebalance' },
      { Pool: 'crypto-trading', job: 'rebalance' }, { pools: ['crypto-trading'], job: 'rebalance' }, { target: { pool: 'crypto-trading' }, job: 'rebalance' },
      { pool: 'research', pools: ['crypto-trading'] }, { pool: 'research', Pool: 'crypto-trading' }, { pool: 'research', target: { pool: 'crypto-trading' } }, { pool: 'research', jobs: [{ poolName: 'crypto-trading' }] },
    ];
    for (const args of unreadable) {
      for (const origin of ['console', 'cli']) {
        expect(await refusal(fx.file('hive.dispatch_job', args, { kind: 'tool_call', origin })), JSON.stringify(args)).toMatchObject({ status: 400, message: TASK_SAYS.pool });
      }
    }
    expect(await filed()).toBe(before);
    expect([hivePoolNamed(hive('research')), hivePoolNamed(null), hivePoolNamed([hive('research')]), hivePoolNamed('research')]).toEqual([true, false, false, false]);
    // A card of any other action is not held to this: only the Hive's dispatch names a pool.
    expect(hivePoolNamed({ url: 'https://example.com/' })).toBe(false);
    expect(await fx.file('mcp:web.fetch_url', { url: 'https://example.com/pools' }, { kind: 'tool_call' })).toMatchObject({ tier: expect.any(String) });
    // One that reached the table some other way: approving it through the runtime is refused as well, and his signature is left unused...
    const pid = await planted('hive.dispatch_job', hive('crypto-trading'), { kind: 'tool_call', origin: 'console' });
    expect(await refusal(fx.approve(pid))).toMatchObject({ status: 409, message: 'Flint isn’t allowed to run this.' });
    expect(await db.proposal.findUniqueOrThrow({ where: { id: pid } })).toMatchObject({ status: 'pending', approvalId: null });
    // ...and one approved all the same (his signature on record, the row moved by hand) is refused when it is claimed, and fails.
    const approvalId = await fx.sign(pid);
    await withClient(urls.app, (c) => c.query(`UPDATE "Proposal" SET status = 'approved', "approvalId" = $2 WHERE id = $1`, [pid, approvalId]));
    expect(await refusal(claimProposal(db, pid, undefined, 'UTC', 'test'))).toMatchObject({ status: 409, message: 'Flint didn’t run it because it isn’t allowed now.' });
    expect(await db.proposal.findUniqueOrThrow({ where: { id: pid } })).toMatchObject({ status: 'failed' });
    const denied = await db.auditEntry.findFirstOrThrow({ where: { correlationId: pid, kind: 'action', outcome: 'denied' } });
    expect(denied.reasoning).toContain('forbidden: pool crypto-trading trades');
  });

  it('of two cards Will signed about the same task, only the later acts: the earlier fails with a sentence, and an accept card that failed that way is asked for again', async () => {
    await fx.watcherOn();
    const card = (pid: string) => db.proposal.findUniqueOrThrow({ where: { id: pid } });
    // A dispatch card he approved, kept; then he signs against a second card to run the same task.
    const kept = await fx.newTask(await fx.ciRun('wpf002/superseded'));
    await fx.approve(kept.proposalId);
    const again = await planted('task.dispatch.ci_runner', (await card(kept.proposalId)).args as Record<string, unknown>, { origin: 'console' });
    await rejectProposal(db, again, { approvalId: await fx.sign(again, 'reject') }, undefined, 'test');
    expect(await refusal(runInternal(db, kept.proposalId, undefined, 'UTC', 'test', undefined, { assets: true, bus }))).toMatchObject({ status: 409, message: TASK_SAYS.superseded });
    expect(await card(kept.proposalId)).toMatchObject({ status: 'failed', error: TASK_SAYS.superseded, result: null });
    expect(await fx.task(kept.id)).toMatchObject({ status: 'proposed', dispatchApprovalId: null, predictionId: null });
    expect(bus.of('tasks.run').some((j) => j.data.taskId === kept.id)).toBe(false);

    // An accept card he approved, kept; then he turns down a card to stop the same task. The accept card no longer acts...
    const taskId = await fx.checked('wpf002/superseded-accept');
    const accept = (await fx.cardFor('task.check_bar', taskId))!;
    await fx.approve(accept.id);
    const stop = await fx.file('task.cancel', { taskId });
    await rejectProposal(db, stop.id, { approvalId: await fx.sign(stop.id, 'reject') }, undefined, 'test');
    expect(await refusal(runInternal(db, accept.id, undefined, 'UTC', 'test', undefined, { assets: true, bus }))).toMatchObject({ status: 409, message: TASK_SAYS.superseded });
    expect(await card(accept.id)).toMatchObject({ status: 'failed', error: TASK_SAYS.superseded, result: null });
    expect(await fx.task(taskId)).toMatchObject({ status: 'checking', acceptedAuditId: null });
    // ...and that is no answer about the result: the tick sends its check, which asks him again, and his new signature accepts it.
    expect(await acceptDeclined(db, taskId)).toBe(false);
    bus.clear();
    expect(await taskTick({ db, bus })).toMatchObject({ failed: 0 });
    expect(bus.of('tasks.check').some((j) => j.data.taskId === taskId)).toBe(true);
    expect(await checkTaskJob({ db }, { taskId })).toBe('filed');
    const asked = (await fx.cardFor('task.check_bar', taskId))!;
    expect(asked.id).not.toBe(accept.id);
    expect(await fx.signRun(asked.id)).toEqual({ taskId, accepted: true });
    expect(await fx.task(taskId)).toMatchObject({ status: 'accepted' });

    // Turning the accept card itself down is his answer: none is filed again, the task ends, and its line says why.
    const declined = await fx.checked('wpf002/declined');
    const offered = (await fx.cardFor('task.check_bar', declined))!;
    await rejectProposal(db, offered.id, { approvalId: await fx.sign(offered.id, 'reject') }, undefined, 'test');
    expect(await acceptDeclined(db, declined)).toBe(true);
    expect(await checkTaskJob({ db }, { taskId: declined })).toBe('waiting');
    expect(await taskTick({ db, bus })).toMatchObject({ failed: 1 });
    expect(await fx.task(declined)).toMatchObject({ status: 'failed', failure: 'expired', metBar: true });
    expect((await taskView(db, declined, 'UTC'))!.line).toBe('You didn’t accept its result.');
  });

  it('a card whose subject Will had Flint forget does not run: it ends with a sentence and no result', async () => {
    await fx.watcherOn();
    const item = await fx.ciRun('wpf002/forgotten');
    const t = await fx.newTask(item);
    await fx.approve(t.proposalId);
    await fx.forget(item);
    // The forget cleared the task's words and its card's args; the card is still approved.
    expect(await db.proposal.findUniqueOrThrow({ where: { id: t.proposalId } })).toMatchObject({ status: 'approved', args: null });
    expect(await fx.task(t.id)).toMatchObject({ status: 'proposed', spec: null });
    expect(await refusal(runInternal(db, t.proposalId, undefined, 'UTC', 'test', undefined, { assets: true, bus }))).toMatchObject({ status: 409, message: TASK_SAYS.forgotten });
    expect(await db.proposal.findUniqueOrThrow({ where: { id: t.proposalId } })).toMatchObject({ status: 'failed', error: TASK_SAYS.forgotten, result: null, args: null });
    expect(await fx.task(t.id)).toMatchObject({ status: 'proposed', dispatchApprovalId: null, predictionId: null });
    const entry = await db.auditEntry.findFirstOrThrow({ where: { correlationId: t.proposalId, outcome: 'denied' }, orderBy: { seq: 'desc' } });
    expect(entry).toMatchObject({ kind: 'action', action: 'task.dispatch.ci_runner', decision: 'deny' });
    expect(entry.inputs).toMatchObject({ proposalId: t.proposalId, why: 'forgotten' });
    // Run again (a retry): it has ended, and says so.
    expect((await refusal(runInternal(db, t.proposalId, undefined, 'UTC', 'test', undefined, { assets: true, bus }))).status).toBe(409);
  });

  it('a spend card says what it will cost, and a task or spend card holds whole numbers only: each is a sentence when the card is filed, not the database’s refusal', async () => {
    for (const estCostUsd of [undefined, 0]) {
      expect(await refusal(fx.file('pay.vendor', { vendor: 'synthetic' }, { kind: 'spend', ...(estCostUsd === undefined ? {} : { estCostUsd }) })), String(estCostUsd)).toMatchObject({ status: 400, message: SPEND_NEEDS_ESTIMATE });
    }
    for (const kind of ['spend', 'task']) {
      expect(await refusal(fx.file('pay.vendor', { vendor: 'synthetic', share: 0.5 }, { kind, estCostUsd: 1 })), kind).toMatchObject({ status: 400, message: WHOLE_NUMBERS_ONLY });
      expect(await refusal(fx.file('pay.vendor', { vendor: 'synthetic', parts: [{ n: 2 ** 60 }] }, { kind, estCostUsd: 1 })), kind).toMatchObject({ status: 400, message: WHOLE_NUMBERS_ONLY });
    }
    expect([hasFraction({ a: [1, { b: 2 }] }), hasFraction({ a: [1, { b: 2.5 }] }), hasFraction('1.5'), hasFraction(null)]).toEqual([false, true, false, false]);
    // A card of another kind may hold a fraction, as before (its digest is not computed again by the database).
    const other = await fx.file('mcp:web.fetch_url', { url: 'https://example.com/', ratio: 0.5 }, { kind: 'tool_call' });
    expect(await db.proposal.findUniqueOrThrow({ where: { id: other.id } })).toMatchObject({ status: 'pending' });
    expect(await db.proposal.count({ where: { action: 'pay.vendor' } })).toBe(0);
  });

  it('a signature that lands between the executor’s look and its write: the card fails with the plain sentence, nothing changes, and a passing result is offered again', async () => {
    await fx.watcherOn();
    const card = (pid: string) => db.proposal.findUniqueOrThrow({ where: { id: pid } });
    const errs = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // An accept card, approved. As it runs, after it has looked for a later signature and found none, Will signs
      // against a card to stop the same task. The database refuses the write (his later signature is on record).
      const taskId = await fx.checked('wpf002/race-accept');
      const accept = (await fx.cardFor('task.check_bar', taskId))!;
      await fx.approve(accept.id);
      const stop = await fx.file('task.cancel', { taskId });
      let landed = 0;
      const lands = (pid: string) => ({ afterOrderCheck: async () => { landed += 1; await fx.sign(pid, 'reject'); } });
      expect(await refusal(runTaskCard(db, accept.id, undefined, 'UTC', 'test', { assets: true, bus }, lands(stop.id)))).toMatchObject({ status: 409, message: TASK_SAYS.superseded });
      expect(landed).toBe(1);
      expect(await card(accept.id)).toMatchObject({ status: 'failed', error: TASK_SAYS.superseded, result: null });
      expect(await fx.task(taskId)).toMatchObject({ status: 'checking', metBar: true, acceptedAuditId: null });
      expect(await db.auditEntry.count({ where: { action: 'task.check_bar', kind: 'action', outcome: 'ok', correlationId: `task:${taskId}` } })).toBe(0);
      // It is not his answer about the result: the task is not ended, and he is asked again.
      expect(await acceptDeclined(db, taskId)).toBe(false);
      bus.clear();
      expect(await taskTick({ db, bus })).toMatchObject({ failed: 0 });
      expect(await fx.task(taskId)).toMatchObject({ status: 'checking' });
      expect(bus.of('tasks.check').some((j) => j.data.taskId === taskId)).toBe(true);
      expect(await checkTaskJob({ db }, { taskId })).toBe('filed');
      const again = (await fx.cardFor('task.check_bar', taskId))!;
      expect(again.id).not.toBe(accept.id);
      expect(await fx.signRun(again.id)).toEqual({ taskId, accepted: true });

      // The same for a dispatch: the card fails with the sentence, and nothing went out.
      const t = await fx.newTask(await fx.ciRun('wpf002/race-dispatch'));
      await fx.approve(t.proposalId);
      const other = await planted('task.dispatch.ci_runner', (await card(t.proposalId)).args as Record<string, unknown>, { origin: 'console' });
      const forecasts = await db.prediction.count({ where: { domain: 'assets' } });
      expect(await refusal(runTaskCard(db, t.proposalId, undefined, 'UTC', 'test', { assets: true }, lands(other)))).toMatchObject({ status: 409, message: TASK_SAYS.superseded });
      expect(await card(t.proposalId)).toMatchObject({ status: 'failed', error: TASK_SAYS.superseded });
      expect(await fx.task(t.id)).toMatchObject({ status: 'proposed', dispatchApprovalId: null, predictionId: null });
      expect(await db.prediction.count({ where: { domain: 'assets' } })).toBe(forecasts);
      // And for a cancellation, by a signature against the accept card.
      const running = await fx.checked('wpf002/race-cancel');
      const cancel = await fx.file('task.cancel', { taskId: running });
      await fx.approve(cancel.id);
      expect(await refusal(runTaskCard(db, cancel.id, undefined, 'UTC', 'test', { assets: true }, lands((await fx.cardFor('task.check_bar', running))!.id)))).toMatchObject({ status: 409, message: TASK_SAYS.superseded });
      expect(await fx.task(running)).toMatchObject({ status: 'checking' });
      // None of these is logged as a failure: each is the plain sentence, as it would have been a moment earlier.
      expect(errs.mock.calls.flat().join(' ')).not.toMatch(/running proposal/);
      // A refusal of the database's that no later signature explains is still said as before, by a reference.
      const lone = await fx.newTask(await fx.ciRun('wpf002/race-none'));
      await fx.approve(lone.proposalId);
      const boom = Object.assign(new Error('permission denied'), { code: '42501' });
      expect(await refusal(runTaskCard(db, lone.proposalId, undefined, 'UTC', 'test', { assets: true }, { afterWrites: async () => { throw boom; } }))).toMatchObject({ status: 409, message: 'Flint couldn’t carry it out.' });
      expect((await card(lone.proposalId)).error).toMatch(/^could not carry it out \(err[a-z0-9]+\)$/);
    } finally {
      errs.mockRestore();
    }
  });

  it('an accept card stopped by a rule after Will approved it fails, and the task keeps waiting: it is offered again once the rule is gone', async () => {
    await fx.watcherOn();
    const taskId = await fx.checked('wpf002/forbidden-after');
    const accept = (await fx.cardFor('task.check_bar', taskId))!;
    await fx.approve(accept.id);
    await fx.policy('task.check_bar', 'forbidden');
    try {
      expect(await refusal(runInternal(db, accept.id, undefined, 'UTC', 'test', undefined, { assets: true, bus }))).toMatchObject({ status: 409, message: 'Flint didn’t run it because it isn’t allowed now.' });
      expect(await db.proposal.findUniqueOrThrow({ where: { id: accept.id } })).toMatchObject({ status: 'failed' });
      // A card that failed is not his no: the tick does not end the task, and its line does not say he turned it down.
      expect(await acceptDeclined(db, taskId)).toBe(false);
      for (let i = 0; i < 2; i++) expect(await taskTick({ db, bus })).toMatchObject({ failed: 0 });
      expect(await fx.task(taskId)).toMatchObject({ status: 'checking', metBar: true, failure: null });
      expect((await taskView(db, taskId, 'UTC'))!.line).toBe('Flint is checking the result.');
      // While the rule stands nothing is filed.
      expect(await checkTaskJob({ db }, { taskId })).toBe('stopped');
      expect(await db.proposal.count({ where: { action: 'task.check_bar', status: 'pending', args: { path: ['taskId'], equals: taskId } } })).toBe(0);
    } finally {
      await fx.owner(`UPDATE "ActionPolicy" SET active = false WHERE pattern = 'task.check_bar'`);
    }
    // The rule gone: he is asked again, and his signature accepts it.
    expect(await checkTaskJob({ db }, { taskId })).toBe('filed');
    const again = (await fx.cardFor('task.check_bar', taskId))!;
    expect(again.id).not.toBe(accept.id);
    expect(await fx.signRun(again.id)).toEqual({ taskId, accepted: true });
    // Only his own no ends the wait: a card he lets lapse does, as one he turns down does. (A card's expiry is
    // the database's to keep and cannot be moved, so this one is offered for a second: a result that passed, and
    // its accept card as the check files it, written straight into the table with that expiry.)
    const t = await fx.dispatched(await fx.ciRun('wpf002/lapsed', { status: 'completed', conclusion: 'success' }));
    await runTaskJob({ db, bus }, { taskId: t.id });
    await db.task.update({ where: { id: t.id }, data: { status: 'checking' } });
    await db.task.update({ where: { id: t.id }, data: { metBar: true, barCheckedBy: 'flint:rule', barEvidence: [{ id: 'a1', op: 'ci', met: true }, { id: 'a2', op: 'refs_known', met: true }] } });
    const brief = { taskId: t.id, outputRef: (await fx.task(t.id)).outputRef, metBar: true, checks: 2, met: 2, by: 'flint:rule' };
    const offered = id('pr');
    await withClient(urls.app, (c) => c.query(
      `INSERT INTO "Proposal" (id, kind, origin, action, "templateId", args, "argsDigest", "argsProvenance", tainted, sensitivity, consequential, "expiresAt")
       VALUES ($1, 'task', $2, 'task.check_bar', $3, $4::jsonb, $5, '{}'::jsonb, false, 'ops', false, now() + interval '1 second')`,
      [offered, TASKS_ORIGIN, ACCEPT_TEMPLATE, JSON.stringify(brief), digestOf(brief)],
    ));
    // While it waits, the task waits with it.
    expect(await acceptDeclined(db, t.id)).toBe(false);
    await new Promise((r) => setTimeout(r, 1200));
    expect(await expireProposals(db)).toBeGreaterThanOrEqual(1);
    expect(await db.proposal.findUniqueOrThrow({ where: { id: offered } })).toMatchObject({ status: 'expired', approvalId: null });
    expect(await acceptDeclined(db, t.id)).toBe(true);
    expect(await checkTaskJob({ db }, { taskId: t.id })).toBe('waiting');
    expect((await taskTick({ db, bus })).failed).toBeGreaterThanOrEqual(1);
    expect(await fx.task(t.id)).toMatchObject({ status: 'failed', failure: 'expired', metBar: true });
    expect((await taskView(db, t.id, 'UTC'))!.line).toBe('You didn’t accept its result.');
  });

  it('a refused dispatch uses none of the day’s cap: its place is taken only once the task goes out', async () => {
    await fx.watcherOn();
    const today = new Date().toISOString().slice(0, 10);
    const used = async () => (await db.actionCounter.findUnique({ where: { action_day: { action: 'task.dispatch.ci_runner', day: today } } }))?.count ?? 0;
    const t = await fx.newTask(await fx.ciRun('wpf002/no-slot'));
    await fx.approve(t.proposalId);
    const before = await used();
    await turnOff(db, CI_WATCHER.id);
    expect(await refusal(runInternal(db, t.proposalId, undefined, 'UTC', 'test', undefined, { assets: true }))).toMatchObject({ status: 409, message: TASK_SAYS.assetOff });
    expect(await db.proposal.findUniqueOrThrow({ where: { id: t.proposalId } })).toMatchObject({ status: 'failed', error: TASK_SAYS.assetOff });
    expect(await used()).toBe(before);
    await fx.watcherOn();
    // One that is superseded uses none either; one that goes out uses one.
    const u = await fx.newTask(await fx.ciRun('wpf002/no-slot-superseded'));
    await fx.approve(u.proposalId);
    const other = await planted('task.dispatch.ci_runner', (await db.proposal.findUniqueOrThrow({ where: { id: u.proposalId } })).args as Record<string, unknown>, { origin: 'console' });
    await rejectProposal(db, other, { approvalId: await fx.sign(other, 'reject') }, undefined, 'test');
    expect(await refusal(runInternal(db, u.proposalId, undefined, 'UTC', 'test', undefined, { assets: true }))).toMatchObject({ status: 409, message: TASK_SAYS.superseded });
    expect(await used()).toBe(before);
    const v = await fx.dispatched(await fx.ciRun('wpf002/slot'));
    expect(await fx.task(v.id)).toMatchObject({ status: 'queued' });
    expect(await used()).toBe(before + 1);
  });

  it('when an override or a cancellation runs, the task’s other waiting cards are set aside with a sentence; another task’s are left alone', async () => {
    await fx.watcherOn();
    const card = (pid: string) => db.proposal.findUniqueOrThrow({ where: { id: pid } });
    // A result that passed and waits: its accept card, a card to stop it, and Will's card to reject it anyway.
    const passed = await fx.checked('wpf002/aside');
    const accept = (await fx.cardFor('task.check_bar', passed))!;
    const stop = await fx.file('task.cancel', { taskId: passed });
    const bystander = await fx.checked('wpf002/aside-other');
    const theirs = (await fx.cardFor('task.check_bar', bystander))!;
    const reject = await fx.file('task.bar_override', { taskId: passed, to: 'rejected' });
    expect(await fx.signRun(reject.id)).toEqual({ taskId: passed, to: 'rejected' });
    for (const pid of [accept.id, stop.id]) {
      expect(await card(pid), pid).toMatchObject({ status: 'rejected', error: TASK_SAYS.setAside, approvalId: null });
      const entry = await db.auditEntry.findFirstOrThrow({ where: { correlationId: pid, kind: 'rejection' } });
      expect(entry).toMatchObject({ decision: 'deny', outcome: 'denied' });
      expect(entry.inputs).toMatchObject({ proposalId: pid, why: 'set_aside', by: reject.id });
      // Approving one now says where it stands, as any card that is no longer waiting does.
      expect((await refusal(fx.approve(pid))).status).toBe(409);
    }
    expect(await card(theirs.id)).toMatchObject({ status: 'pending', error: null });
    expect(await card(reject.id)).toMatchObject({ status: 'executed' });
    expect(TASK_SAYS.setAside).toBe('You ended this task another way, so this card wasn’t needed.');
    // A cancellation does the same for the accept card of the task it stops.
    const cancelled = (await fx.cardFor('task.cancel', bystander)) ?? (await fx.file('task.cancel', { taskId: bystander }));
    expect(await fx.signRun(cancelled.id)).toEqual({ taskId: bystander, cancelled: true });
    expect(await card(theirs.id)).toMatchObject({ status: 'rejected', error: TASK_SAYS.setAside });
    // Nothing is filed again for a task that has ended.
    expect(await checkTaskJob({ db }, { taskId: passed })).toBe('skipped');
  });

  it('what the executor’s own checks say when they refuse a signed card: one it reads differently, one for another task or another result, and a result no longer kept', async () => {
    await fx.watcherOn();
    const card = (pid: string) => db.proposal.findUniqueOrThrow({ where: { id: pid } });
    const run = (pid: string) => refusal(runInternal(db, pid, undefined, 'UTC', 'test', undefined, { assets: true, bus }));
    // A dispatch card whose args are valid and not as the contract writes them (a default left out): what Will
    // signed is not what Flint would read now. It fails with that sentence, and nothing goes out.
    const item = await fx.ciRun('wpf002/reshaped');
    const t = await fx.newTask(item);
    const args = (await card(t.proposalId)).args as Record<string, unknown>;
    expect((args.spec as { params: Record<string, unknown> }).params).toEqual({ item, sha: null });
    const loose = await planted('task.dispatch.ci_runner', { ...args, spec: { template: 'watch_ci', params: { item } } }, { origin: 'console' });
    await fx.approve(loose);
    expect(await run(loose)).toMatchObject({ status: 409, message: TASK_SAYS.reshaped });
    expect(await card(loose)).toMatchObject({ status: 'failed', error: TASK_SAYS.reshaped });
    expect(await fx.task(t.id)).toMatchObject({ status: 'proposed', predictionId: null });
    // A dispatch card that is not the task as it stands (another title): the task changed, in a sentence.
    const drifted = await planted('task.dispatch.ci_runner', { ...args, title: 'Another Title' }, { origin: 'console' });
    await fx.approve(drifted);
    expect(await run(drifted)).toMatchObject({ status: 409, message: TASK_SAYS.changed });
    expect(await card(drifted)).toMatchObject({ status: 'failed', error: TASK_SAYS.changed });
    expect(await fx.task(t.id)).toMatchObject({ status: 'proposed', predictionId: null });

    // An accept card that names the task's result and says other counts, or another checker, than the task has:
    // the database does not compare those, so only this check stands between such a card and an acceptance.
    const taskId = await fx.checked('wpf002/other-counts');
    const real = (await fx.cardFor('task.check_bar', taskId))!.args as Record<string, unknown>;
    for (const over of [{ checks: 9, met: 9 }, { checks: 1, met: 1 }, { by: 'ollama:worker:test' }]) {
      const pid = await planted('task.check_bar', { ...real, ...over }, { origin: TASKS_ORIGIN, templateId: ACCEPT_TEMPLATE });
      await fx.approve(pid);
      expect(await run(pid), JSON.stringify(over)).toMatchObject({ status: 409, message: TASK_SAYS.changed });
      expect(await card(pid)).toMatchObject({ status: 'failed', error: TASK_SAYS.changed });
    }
    expect(await fx.task(taskId)).toMatchObject({ status: 'checking', acceptedAuditId: null });

    // Accept Anyway needs the result still on record. The panel offers it while it is, and a card filed then...
    const failed = await fx.checked('wpf002/result-gone', 'failure');
    expect((await taskView(db, failed, 'UTC'))!.can).toMatchObject({ accept: true, reject: false });
    const early = await fx.file('task.bar_override', { taskId: failed, to: 'accepted' });
    await fx.approve(early.id);
    // ...fails with a sentence once the result is no longer kept (its raw output goes a week after the task ended),
    await fx.endedAgo(failed, 8 * 24);
    await runRetention(db, 'UTC');
    expect(await db.taskOutput.count({ where: { taskId: failed } })).toBe(0);
    expect(await run(early.id)).toMatchObject({ status: 409, message: TASK_SAYS.outputGone });
    expect(await card(early.id)).toMatchObject({ status: 'failed', error: TASK_SAYS.outputGone });
    expect(await fx.task(failed)).toMatchObject({ status: 'rejected', barCheckedBy: 'flint:rule', acceptedAuditId: null });
    // a new one is not filed, and the panel no longer offers it.
    expect(await refusal(fx.file('task.bar_override', { taskId: failed, to: 'accepted' }))).toMatchObject({ status: 409, message: TASK_SAYS.outputGone });
    expect(await refusal(overrideTask(db, failed, 'accepted'))).toMatchObject({ status: 409, message: TASK_SAYS.outputGone });
    expect((await taskView(db, failed, 'UTC'))!.can).toMatchObject({ accept: false, reject: false });
    expect(TASK_SAYS.outputGone).toBe('Its result is no longer kept, so it can’t be accepted.');
  });

  it('switched off, which is how it ships, no card runs: it stays approved, nothing is read, and it runs once tasks are on', async () => {
    const t = await fx.newTask(await fx.ciRun('wpf002/off'));
    await fx.approve(t.proposalId);
    // Not said to be on is off: a caller that forgets the switch runs nothing.
    for (const deps of [undefined, {}, { assets: false }, { bus }]) {
      expect(await refusal(runInternal(db, t.proposalId, undefined, 'UTC', 'test', undefined, deps)), JSON.stringify(deps)).toMatchObject({ status: 409, message: TASK_SAYS.off });
    }
    expect(await db.proposal.findUniqueOrThrow({ where: { id: t.proposalId } })).toMatchObject({ status: 'approved', error: null });
    expect(await fx.task(t.id)).toMatchObject({ status: 'proposed' });
    // The executor itself refuses before it reads anything: any use of this client fails the test.
    let touched = 0;
    const untouchable = new Proxy({}, { get: () => { touched++; throw new Error('the database was touched'); } }) as unknown as Db;
    for (const deps of [undefined, {}, { assets: false }]) {
      expect(await refusal(runTask(untouchable, t.proposalId, undefined, 'UTC', 'test', deps))).toMatchObject({ status: 409, message: TASK_SAYS.off });
      expect(await refusal(runTaskCard(untouchable, t.proposalId, undefined, 'UTC', 'test', deps))).toMatchObject({ status: 409, message: TASK_SAYS.off });
    }
    expect(touched).toBe(0);
    expect(await runTask(db, t.proposalId, undefined, 'UTC', 'test', { assets: true, bus })).toMatchObject({ taskId: t.id });
  });

  it('a task for the local model goes out on its own signed card, under the day’s cap, and no result of it reaches a log, a card or the audit trail', async () => {
    const worker: AssetDef = assetOf({ id: 'as-test-worker-v1', kind: 'local_worker', externalRef: 'ollama:worker:test', name: 'Local Tasks', capabilities: ['draft_note'], spends: false, line: 'The local model runs tasks on this Mac.' });
    const registry = [...ASSETS, worker];
    // A stand-in for the local model: it writes what it was asked to, with a canary in every field.
    // Its words carry what the database cannot store (a NUL, half of a surrogate pair), as a model's may.
    const fake: TaskAdapter = { kind: 'local_worker', estimate: () => 0, run: async () => ({ output: { title: `${CANARY} ti\u0000tle`, body: `${CANARY} body \uD83D` }, summary: `${CANARY} sum\u0000mary` }) };
    await syncAssets(db, registry);
    const args = enableArgsOf(worker);
    const enable = await planted('asset.enable', args, { kind: 'policy', origin: 'console', consequential: true });
    await fx.approve(enable);
    await runTaskCard(db, enable, undefined, 'UTC', 'test', { assets: true, registry });

    const t = await createTask(db, { draftKey: draft(), template: 'draft_note', params: { about: `${CANARY} what to write` }, goalId: null, dueAt: null, ownCheck: null }, { registry, adapters: { local_worker: fake } });
    const card = await db.proposal.findUniqueOrThrow({ where: { id: t.proposalId } });
    // Will's own words make it personal; the card holds them (its args are cleared with the other cards'), its reason does not.
    expect(card).toMatchObject({ kind: 'task', action: 'task.dispatch.local_worker', sensitivity: 'personal', tainted: false, reason: TASK_REASONS.dispatch });
    expect(await fx.task(t.id)).toMatchObject({ title: 'Draft a Note', sensitivity: 'personal' });
    const logs: string[] = [];
    await fx.signRun(t.proposalId);
    expect(await runTaskJob({ db, bus, adapters: { local_worker: fake }, log: (m) => logs.push(m) }, { taskId: t.id })).toBe('submitted');
    // Cleaned before it is kept, under the digest the database computes over the body as it stores it; the task is handed in under that reference.
    const out = await db.taskOutput.findUniqueOrThrow({ where: { taskId: t.id } });
    expect(out.body).toEqual({ title: `${CANARY} title`, body: `${CANARY} body \uFFFD` });
    const [own] = await db.$queryRaw<Array<{ d: string }>>`SELECT encode(sha256(convert_to(body::text, 'UTF8')), 'hex') AS d FROM "TaskOutput" WHERE "taskId" = ${t.id}`;
    expect(out.sha256).toBe(own!.d);
    expect(out.sha256).not.toBe(digestOf(out.body));
    expect((await fx.task(t.id)).outputRef).toBe(`out:${out.sha256.slice(0, 16)}`);
    expect(await checkTaskJob({ db, log: (m) => logs.push(m) }, { taskId: t.id })).toBe('filed');
    expect(await fx.task(t.id)).toMatchObject({ status: 'checking', metBar: true, outputSummary: `${CANARY} summary` });
    const accept = (await fx.cardFor('task.check_bar', t.id))!;
    expect(accept).toMatchObject({ sensitivity: 'personal', tainted: false });
    await fx.signRun(accept.id);
    expect(await fx.task(t.id)).toMatchObject({ status: 'accepted' });
    expect(logs.join('\n')).toMatch(new RegExp(`^task ${t.id}: submitted\\ntask ${t.id}: checking \\(accept card filed\\)$`));
    expect(`${logs.join('\n')}\n${await fx.everythingButTasks()}`).not.toContain('CANARY');

    // The day's 20: the 21st card stays approved and says so.
    const today = new Date().toISOString().slice(0, 10);
    await db.$queryRaw`SELECT claim_action('task.dispatch.local_worker', ${today}, 20) FROM generate_series(1, 19)`;
    const next = await createTask(db, { draftKey: draft(), template: 'draft_note', params: { about: 'Another note' }, goalId: null, dueAt: null, ownCheck: null }, { registry, adapters: { local_worker: fake } });
    await fx.approve(next.proposalId);
    expect(await refusal(runInternal(db, next.proposalId, undefined, 'UTC', 'test', undefined, { assets: true }))).toMatchObject({ status: 429, message: 'Today’s limit of 20 is reached.' });
    expect(await db.proposal.findUniqueOrThrow({ where: { id: next.proposalId } })).toMatchObject({ status: 'approved' });
    expect(await fx.task(next.id)).toMatchObject({ status: 'proposed' });
  });
});
