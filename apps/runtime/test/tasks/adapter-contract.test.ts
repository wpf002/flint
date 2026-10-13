/**
 * The contract every asset's adapter passes (P5), run against the CI watcher
 * and a stand-in for an asset that spends. No adapter that spends is built, and
 * none is called here: the stand-in is a function in this file.
 *
 *  - An adapter is pure: it is handed the signed spec and the items' clean
 *    facts, and gives back exactly one of a result (its template's shape, with
 *    a sentence about it), a wait, or a failure's class. It never throws, and
 *    never changes what it was given.
 *  - Its estimate is known before any card is filed: nothing for an asset on
 *    this Mac; whole hundreds of millionths of a dollar for one that spends.
 *  - The path money takes, on flint_test: the estimate on the task and on a
 *    spend card only Will files; refused while nothing sets the money aside
 *    ("Paid tasks are off."); and a task that went out ends with what it cost.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PAID_DISPATCH, TASK_FAILURES, TASK_OUTPUTS, TASK_REASONS, TASK_SAYS, TaskSpec, digestOf, noteProblems } from '@flint/policy';
import { NO_DB, freshDb, id, withClient, type TestUrls } from '../db';
import { createDb, type Db } from '../../src/db';
import { Refused } from '../../src/governance/proposals';
import { runInternal } from '../../src/governance/internal';
import { jsonbBytes } from '../../src/jsonsize';
import { ASSETS, assetOf, type AssetDef, enableArgsOf } from '../../src/assets/registry';
import { syncAssets } from '../../src/assets/service';
import { ciWatch } from '../../src/tasks/adapters/ci-watch';
import type { AdapterInput, ItemFact, TaskAdapter } from '../../src/tasks/adapters/types';
import { runTaskCard } from '../../src/tasks/card';
import { checkTaskJob } from '../../src/tasks/check';
import { runTaskJob } from '../../src/tasks/run';
import { createTask } from '../../src/tasks/service';
import { FakeBus, SHA, draft, taskFixture, type TaskFixture } from './fixture';

/** A stand-in for an asset that spends: it "writes" a note and says what that cost. It calls nothing. */
const paid: TaskAdapter = {
  kind: 'nexus_participant',
  estimate: (spec) => (spec.template === 'draft_note' ? 250_000 : 0),
  run: async ({ spec }) => (spec.template === 'draft_note' ? { output: { title: 'A Note', body: 'Its text.' }, summary: 'It wrote a note.' } : { failure: 'invalid' }),
  meter: async () => ({ micros: 200_000, estimate: false }),
};

const ci = (state: ItemFact['state']): ItemFact => ({ id: 'en1', ref: 'ci_run#000en1', kind: 'ci_run', state });
const watch = TaskSpec.parse({ template: 'watch_ci', params: { item: 'en1' } });
const note = TaskSpec.parse({ template: 'draft_note', params: { about: 'What to write' } });

const CASES: Array<{ name: string; adapter: TaskAdapter; spends: boolean; inputs: Array<{ spec: TaskSpec; items: ItemFact[]; gives: 'output' | 'wait' | 'failure' }> }> = [
  {
    name: 'the CI watcher', adapter: ciWatch, spends: false,
    inputs: [
      { spec: watch, items: [ci({ status: 'completed', conclusion: 'success', sha: SHA })], gives: 'output' },
      { spec: watch, items: [ci({ status: 'completed', conclusion: 'made-up', sha: 'not a commit' })], gives: 'output' },
      { spec: watch, items: [ci({ status: 'in_progress', conclusion: null })], gives: 'wait' },
      { spec: watch, items: [ci({})], gives: 'wait' },
      { spec: watch, items: [], gives: 'failure' },
      { spec: watch, items: [{ ...ci({ status: 'completed' }), kind: 'issue' }], gives: 'failure' },
      { spec: watch, items: [{ ...ci({ status: 'completed' }), id: 'another' }], gives: 'failure' },
      { spec: note, items: [], gives: 'failure' },
    ],
  },
  { name: 'an asset that spends', adapter: paid, spends: true, inputs: [{ spec: note, items: [], gives: 'output' }, { spec: watch, items: [], gives: 'failure' }] },
];

function freeze<T>(v: T): T {
  if (v && typeof v === 'object') for (const x of Object.values(v)) freeze(x);
  return Object.freeze(v);
}

describe('the adapter contract', () => {
  for (const c of CASES) {
    it(`${c.name}: one of a result, a wait or a failure's class; never a throw, never a change to what it was given`, async () => {
      for (const i of c.inputs) {
        const input: AdapterInput = freeze({ taskId: 'tkabcdefgh12345678', spec: i.spec, items: i.items, now: new Date('2026-10-12T10:00:00.000Z') });
        const before = JSON.stringify(input);
        const r = await c.adapter.run(input);
        expect(JSON.stringify(input)).toBe(before);
        expect(Object.keys(r).sort(), JSON.stringify(i)).toEqual(i.gives === 'output' ? ['output', 'summary'] : [i.gives]);
        if ('output' in r) {
          // Its template's shape, strictly, within the size the database takes; the sentence about it is fit to show.
          expect(TASK_OUTPUTS[i.spec.template].safeParse(r.output).success).toBe(true);
          expect(jsonbBytes(r.output)).toBeLessThanOrEqual(32_768);
          expect(r.summary.length).toBeGreaterThan(0);
          expect(r.summary.length).toBeLessThanOrEqual(1000);
          expect(noteProblems('A Title', r.summary)).toEqual([]);
        } else if ('failure' in r) expect(TASK_FAILURES).toContain(r.failure);
        else expect(r).toEqual({ wait: true });
      }
    });

    it(`${c.name}: its estimate is known before any card, as whole hundreds of millionths of a dollar${c.spends ? '' : ', and is nothing'}`, () => {
      for (const spec of [watch, note]) {
        const micros = c.adapter.estimate(spec);
        expect(Number.isInteger(micros) && micros >= 0 && micros % 100 === 0, `${spec.template}: ${micros}`).toBe(true);
        if (!c.spends) expect(micros).toBe(0);
      }
      // Only an asset that spends says what a run cost.
      expect(typeof c.adapter.meter).toBe(c.spends ? 'function' : 'undefined');
      expect(c.adapter.kind).toMatch(/^[a-z_]+$/);
    });
  }

  it('the watcher hands in what it saw as structural fields only: an unknown ending is none, a commit that is not hex is none', async () => {
    const seen = await ciWatch.run({ taskId: 'tk1', spec: watch, items: [ci({ status: 'completed', conclusion: 'made-up', sha: 'not a commit' })], now: new Date() });
    expect(seen).toEqual({ output: { ref: 'ci_run#000en1', status: 'completed', conclusion: null, sha: null }, summary: 'The run ended without passing.' });
  });
});

describe.skipIf(NO_DB)('the path money takes, on flint_test', () => {
  let urls: TestUrls;
  let db: Db;
  let fx: TaskFixture;
  const bus = new FakeBus();
  const asset: AssetDef = assetOf({ id: 'as-test-paid-v1', kind: 'nexus_participant', externalRef: 'nexus:test-participant', name: 'Paid Tasks', capabilities: ['draft_note'], spends: true, line: 'It runs on a Nexus participant and costs money.' });
  const registry = [...ASSETS, asset];
  const adapters = { nexus_participant: paid };
  const refusal = async (p: Promise<unknown>): Promise<Refused> => {
    try {
      await p;
    } catch (e) {
      if (e instanceof Refused) return e;
      throw e;
    }
    throw new Error('expected a refusal, got success');
  };
  const newTask = () => createTask(db, { draftKey: draft(), template: 'draft_note', params: { about: 'What to write' }, goalId: null, dueAt: null, ownCheck: null }, { registry, adapters });

  beforeAll(async () => {
    urls = await freshDb();
    db = createDb(urls.app);
    fx = await taskFixture(urls, db, bus);
    // The stand-in asset, turned on by its own signed card. It is not in the code registry: no such asset is built.
    await syncAssets(db, registry);
    const args = enableArgsOf(asset);
    const pid = id('pr');
    await withClient(urls.app, (c) => c.query(
      `INSERT INTO "Proposal" (id, kind, origin, action, args, "argsDigest", "argsProvenance", tainted, sensitivity, consequential, "expiresAt")
       VALUES ($1, 'policy', 'console', 'asset.enable', $2::jsonb, $3, '{}'::jsonb, false, 'ops', true, now() + interval '1 hour')`,
      [pid, JSON.stringify(args), digestOf(args)],
    ));
    await fx.approve(pid);
    await runTaskCard(db, pid, undefined, 'UTC', 'test', { registry });
  });
  afterAll(async () => db?.$disconnect());

  it('estimate before: the task and its card carry it, and the card is a spend card only Will files, marked for his own touch and a review', async () => {
    const t = await newTask();
    expect(Number((await fx.task(t.id)).estCostUsd)).toBe(0.25);
    const card = await db.proposal.findUniqueOrThrow({ where: { id: t.proposalId } });
    expect(card).toMatchObject({ kind: 'spend', origin: 'console', action: PAID_DISPATCH, consequential: true, reason: TASK_REASONS.paid, reviewRequired: true, tainted: false });
    expect(Number(card.estCostUsd)).toBe(0.25);
    expect((card.args as { estCostMicros: number }).estCostMicros).toBe(250_000);
    // As a task card, or with another estimate, it is not filed.
    const args = card.args as Record<string, unknown>;
    expect(await refusal(fx.file(PAID_DISPATCH, args, { kind: 'task' }))).toMatchObject({ status: 400, message: TASK_SAYS.kind });
    expect(await refusal(fx.file(PAID_DISPATCH, { ...args, estCostMicros: 0 }, { kind: 'spend' }))).toMatchObject({ status: 409, message: TASK_SAYS.changed });
  });

  it('refused at $0: nothing carries a paid dispatch out, and with nothing to set the money aside the card fails saying paid tasks are off', async () => {
    const t = await newTask();
    await fx.approve(t.proposalId);
    // The runtime's own executor list does not hold it: it fails closed, and the card is left as it was.
    expect(await refusal(runInternal(db, t.proposalId, undefined, 'UTC', 'test'))).toMatchObject({ status: 409, message: `${PAID_DISPATCH} is not carried out by the runtime` });
    expect(await db.proposal.findUniqueOrThrow({ where: { id: t.proposalId } })).toMatchObject({ status: 'approved' });
    // Handed straight to the task executor, with no way to reserve: refused, in a sentence.
    expect(await refusal(runTaskCard(db, t.proposalId, undefined, 'UTC', 'test', { registry, bus }))).toMatchObject({ status: 409, message: TASK_SAYS.paidOff });
    expect(await db.proposal.findUniqueOrThrow({ where: { id: t.proposalId } })).toMatchObject({ status: 'failed', error: TASK_SAYS.paidOff });
    expect(await fx.task(t.id)).toMatchObject({ status: 'proposed', predictionId: null, costUsd: null });
    // The same when the answer to the reservation is no.
    const u = await newTask();
    const asked: number[] = [];
    await fx.approve(u.proposalId);
    expect(await refusal(runTaskCard(db, u.proposalId, undefined, 'UTC', 'test', { registry, bus, reserve: async (micros) => { asked.push(micros); return false; } }))).toMatchObject({ status: 409, message: TASK_SAYS.paidOff });
    expect(asked).toEqual([250_000]);
    expect(await fx.task(u.id)).toMatchObject({ status: 'proposed' });
    expect(bus.of('tasks.run')).toEqual([]);
  });

  it('cost after: a task that went out ends with what it cost, metered when the asset says so and its estimate otherwise', async () => {
    const reserve = async () => true;
    const t = await newTask();
    await fx.approve(t.proposalId);
    expect(await runTaskCard(db, t.proposalId, undefined, 'UTC', 'test', { registry, bus, reserve })).toMatchObject({ taskId: t.id });
    expect(await fx.task(t.id)).toMatchObject({ status: 'queued', costUsd: null, costIsEstimate: true });
    expect(await runTaskJob({ db, bus, adapters }, { taskId: t.id })).toBe('submitted');
    const submitted = await fx.task(t.id);
    expect(Number(submitted.costUsd)).toBe(0.2);
    expect(submitted.costIsEstimate).toBe(false);
    expect(await checkTaskJob({ db }, { taskId: t.id })).toBe('filed');
    await fx.signRun((await fx.cardFor('task.check_bar', t.id))!.id);
    const done = await fx.task(t.id);
    expect(done).toMatchObject({ status: 'accepted', costIsEstimate: false });
    expect(Number(done.costUsd)).toBe(0.2);
    // Cancelled after it went out, before the asset said anything: it ends with its estimate, marked as one.
    const u = await newTask();
    await fx.approve(u.proposalId);
    await runTaskCard(db, u.proposalId, undefined, 'UTC', 'test', { registry, bus, reserve });
    await runTaskJob({ db, bus, adapters: { nexus_participant: { ...paid, run: async () => ({ wait: true }) } } }, { taskId: u.id });
    expect(await fx.task(u.id)).toMatchObject({ status: 'dispatched', costUsd: null });
    await fx.signRun((await fx.file('task.cancel', { taskId: u.id })).id);
    const cancelled = await fx.task(u.id);
    expect(cancelled).toMatchObject({ status: 'cancelled', costIsEstimate: true });
    expect(Number(cancelled.costUsd)).toBe(0.25);
    // One the asset failed: the same.
    const v = await newTask();
    await fx.approve(v.proposalId);
    await runTaskCard(db, v.proposalId, undefined, 'UTC', 'test', { registry, bus, reserve });
    expect(await runTaskJob({ db, bus, adapters: { nexus_participant: { ...paid, run: async () => ({ failure: 'timeout' }) } } }, { taskId: v.id })).toBe('failed');
    const failed = await fx.task(v.id);
    expect(failed).toMatchObject({ status: 'failed', failure: 'timeout', costIsEstimate: true });
    expect(Number(failed.costUsd)).toBe(0.25);
  });
});
