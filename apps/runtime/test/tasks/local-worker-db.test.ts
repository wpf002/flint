/**
 * The local worker end to end on flint_test (P5): the asset Will turns on, a
 * task of his that goes out on its signed card, and the real adapter over a
 * stand-in Ollama.
 *
 *  - A summary task: its card is the local worker's dispatch, its result is
 *    stored under the database's own digest, its summary is Flint's sentence of
 *    counts, and the refs in it are the items the task was given.
 *  - Titles: the prompt holds an item's own title only for a task Will signed
 *    with titles on, and such a task is marked as having read outside text.
 *    Nothing of a title reaches a log, a card or the audit trail.
 *  - The requests one task may make in a day are counted in the database by its
 *    id: once they are used up the task fails as capped, and nothing is sent.
 *  - With no local model named, the runtime has no local worker: the form
 *    offers none of its kinds of task and a task sent by hand is refused.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TASK_SAYS, TaskForm } from '@flint/policy';
import { NO_DB, freshDb, type TestUrls } from '../db';
import { createDb, type Db } from '../../src/db';
import { Refused } from '../../src/governance/proposals';
import { ASSETS, LOCAL_WORKER } from '../../src/assets/registry';
import { modelsHere } from '../ollama-kit';
import { adaptersFor } from '../../src/tasks/run';
import { REQUESTS_A_DAY, WORK_REQUESTS, requestsCounter, taskAttempt, workerDeps } from '../../src/tasks/local-worker';
import { runTaskJob } from '../../src/tasks/run';
import { createTask } from '../../src/tasks/service';
import { taskForm, taskView } from '../../src/tasks/view';
import { CANARY, FakeBus, draft, taskFixture, type TaskFixture } from './fixture';

const OLLAMA = { url: 'http://127.0.0.1:11434', model: 'muse-glimmer:30b' };
modelsHere([OLLAMA.model]);

const reply = (content: unknown) =>
  new Response(JSON.stringify({ model: 'm', message: { role: 'assistant', content: JSON.stringify(content) }, done: true, done_reason: 'stop', prompt_eval_count: 10, eval_count: 5 }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

/** Everything the stand-in was asked, as the model would have read it. */
function standIn(answer: unknown) {
  const sent: string[] = [];
  const fetch = (async (_url: string, init?: RequestInit) => {
    sent.push(String(init?.body ?? ''));
    return reply(answer);
  }) as typeof globalThis.fetch;
  return { sent, fetch, prompts: () => sent.map((b) => (JSON.parse(b) as { messages: Array<{ content: string }> }).messages.map((m) => m.content).join('\n')) };
}

describe.skipIf(NO_DB)('the local worker on flint_test', () => {
  let urls: TestUrls;
  let db: Db;
  let bus: FakeBus;
  let fx: TaskFixture;

  beforeAll(async () => {
    urls = await freshDb();
    db = createDb(urls.app);
    bus = new FakeBus();
    fx = await taskFixture(urls, db, bus, { source: true });
    await fx.assetOn(LOCAL_WORKER.id);
  });
  afterAll(async () => {
    await db.$disconnect();
  });

  /** The runtime's own deps, with a stand-in in place of Ollama. */
  const deps = (base: typeof fetch) => ({ registry: ASSETS, adapters: adaptersFor(workerDeps(db, { tz: 'UTC', ollama: OLLAMA }, base)) });

  it('a summary goes out on its signed card and comes back as a result, with the refs of the items it was given', async () => {
    const pr = await fx.entity('pull_request', { number: 12, state: 'open' });
    const issue = await fx.entity('issue', { state: 'open' });
    const model = standIn({ headline: 'Two Items Are Open', points: [{ text: 'Both are open.', items: [1, 2] }], attention: [2] });
    const d = deps(model.fetch);
    const t = await createTask(db, { draftKey: draft(), template: 'summarize_items', params: { items: [pr, issue] }, goalId: null, dueAt: null, ownCheck: null }, d);
    const card = await db.proposal.findUniqueOrThrow({ where: { id: t.proposalId } });
    expect(card).toMatchObject({ kind: 'task', action: 'task.dispatch.local_worker', tainted: false });
    const made = await fx.task(t.id);
    expect(made).toMatchObject({ title: 'Summarize Items', tainted: false });
    // A task on this Mac costs nothing: its estimate is zero, and its card is not a spend card.
    expect(Number(made.estCostUsd)).toBe(0);
    expect(card.kind).not.toBe('spend');

    const logs: string[] = [];
    await fx.signRun(t.proposalId);
    expect(await runTaskJob({ db, bus, adapters: d.adapters, log: (m) => logs.push(m) }, { taskId: t.id })).toBe('submitted');
    expect(model.sent).toHaveLength(1);
    const out = await db.taskOutput.findUniqueOrThrow({ where: { taskId: t.id } });
    // Every ref in it is one of the two items, named by the code and not by the model.
    const refs = [pr, issue].map((id) => `${id === pr ? 'pull_request' : 'issue'}#${id.slice(-6)}`);
    expect(out.body).toEqual({ headline: 'Two Items Are Open', points: [{ text: 'Both are open.', refs }], attention: [refs[1]] });
    expect(out.tainted).toBe(true);
    const task = await fx.task(t.id);
    expect(task.outputSummary).toBe('It made 1 point about 2 items. It marked 1 item to look at.');
    expect(task.outputRef).toBe(`out:${out.sha256.slice(0, 16)}`);
    // Its own rule checks are met, so it waits for Will's accept card and not for a rejection.
    expect(logs.join('\n')).toBe(`task ${t.id}: submitted`);
  });

  it('a task Will signed with titles on shows the model the items’ titles, and is marked as having read outside text', async () => {
    const titled = await fx.entity('pull_request', { number: 3, state: 'open' }, { name: `${CANARY} pull request title`, taintedPaths: ['name'] });
    const answer = { headline: 'One Item Is Open', points: [{ text: 'It is open.', items: [1] }], attention: [] };

    // Titles off (how a form sends it unless Will asks): the prompt holds no title, and the task is not tainted.
    const plain = standIn(answer);
    const off = await createTask(db, { draftKey: draft(), template: 'summarize_items', params: { items: [titled] }, goalId: null, dueAt: null, ownCheck: null }, deps(plain.fetch));
    await fx.signRun(off.proposalId);
    await runTaskJob({ db, bus, adapters: deps(plain.fetch).adapters }, { taskId: off.id });
    expect(plain.prompts().join('\n')).not.toContain('CANARY');
    expect(await fx.task(off.id)).toMatchObject({ tainted: false, status: 'submitted' });

    // Titles on: his card says so, the task is tainted, and the prompt holds the title as data.
    const shown = standIn(answer);
    const on = await createTask(db, { draftKey: draft(), template: 'summarize_items', params: { items: [titled], titles: true }, goalId: null, dueAt: null, ownCheck: null }, deps(shown.fetch));
    expect(await db.proposal.findUniqueOrThrow({ where: { id: on.proposalId } })).toMatchObject({ tainted: true });
    expect(await fx.task(on.id)).toMatchObject({ tainted: true });
    const logs: string[] = [];
    await fx.signRun(on.proposalId);
    expect(await runTaskJob({ db, bus, adapters: deps(shown.fetch).adapters, log: (m) => logs.push(m) }, { taskId: on.id })).toBe('submitted');
    expect(shown.prompts().join('\n')).toContain(`Title: ${CANARY} pull request title`);
    // The title is the model's to read and nobody else's: not a log line, not a card, not an audit entry.
    expect(`${logs.join('\n')}\n${await fx.everythingButTasks()}`).not.toContain('CANARY');
    // Nor is a ref ever shown to it: the model answers with numbers.
    expect(shown.prompts().join('\n')).not.toContain('pull_request#');
    // The panel marks it: the task read outside text, and so its result is shown as outside text too.
    expect((await taskView(db, on.id, 'UTC'))!.outside).toBe(true);
  });

  it('the requests one task may make in a day are counted in the database: used up, it fails as capped and nothing is sent', async () => {
    const item = await fx.entity('issue', { state: 'open' });
    const model = standIn({ headline: 'One Item', points: [{ text: 'It is open.', items: [1] }], attention: [] });
    const d = deps(model.fetch);
    const t = await createTask(db, { draftKey: draft(), template: 'summarize_items', params: { items: [item] }, goalId: null, dueAt: null, ownCheck: null }, d);
    await fx.signRun(t.proposalId);
    // Its requests for the day, claimed by its own id: taken up before the job runs.
    const attempt = taskAttempt(db, 'UTC');
    for (let n = 0; n < REQUESTS_A_DAY; n++) expect(await attempt(t.id), `request ${n + 1}`).toBe(true);
    expect(await attempt(t.id)).toBe(false);
    // Another task's count is its own.
    const other = await createTask(db, { draftKey: draft(), template: 'summarize_items', params: { items: [item] }, goalId: null, dueAt: null, ownCheck: null }, d);
    expect(await attempt(other.id)).toBe(true);

    expect(await runTaskJob({ db, bus, adapters: d.adapters }, { taskId: t.id })).toBe('failed');
    expect(await fx.task(t.id)).toMatchObject({ status: 'failed', failure: 'capped' });
    expect(model.sent).toHaveLength(0);
    // The counter is the task's own, by its id, and one run could never have made more than its own requests.
    const counted = await db.actionCounter.findFirstOrThrow({ where: { action: requestsCounter(t.id) } });
    expect(counted.count).toBe(REQUESTS_A_DAY);
    expect(REQUESTS_A_DAY).toBeGreaterThanOrEqual(WORK_REQUESTS);
  });

  it('with no local model named there is no local worker: the form offers none of its kinds, and a task sent by hand is refused', async () => {
    const item = await fx.entity('issue', { state: 'open' });
    // workerDeps gives nothing without a model, so adaptersFor has only the CI watcher.
    const none = { registry: ASSETS, adapters: adaptersFor(workerDeps(db, { tz: 'UTC' })) };
    expect(Object.keys(none.adapters)).toEqual(['ci_runner']);
    const form = TaskForm.parse(await taskForm(db, 'UTC', none));
    expect(form.templates.map((t) => t.template)).not.toContain('summarize_items');
    const refused = await createTask(db, { draftKey: draft(), template: 'summarize_items', params: { items: [item] }, goalId: null, dueAt: null, ownCheck: null }, none).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(Refused);
    expect((refused as Refused).message).toBe(TASK_SAYS.cantRun);
    // With one named, every kind of task the worker runs is offered, each on it.
    const withModel = TaskForm.parse(await taskForm(db, 'UTC', { registry: ASSETS, adapters: adaptersFor(workerDeps(db, { tz: 'UTC', ollama: OLLAMA })) }));
    expect(withModel.templates.filter((t) => t.runsOn === LOCAL_WORKER.name).map((t) => t.template)).toEqual(['summarize_items', 'sort_items', 'draft_note']);
  });
});
