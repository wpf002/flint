/**
 * The goals panel's runtime routes on flint_test (P3 part 2), through buildApp
 * and Fastify's inject, the way the server's proxy calls them; cards are signed
 * with a test key and run with runInternal, as the server's approval routes do.
 *
 *  - POST /v1/goals, then sign, then run: the goal is active with its links and
 *    plan v1, and the card's digest is the digest of the args the panel showed.
 *    The same draft twice is one card; a changed draft's card replaces the older.
 *    While it waits, the Active tab lists it as waiting.
 *  - Pause, dismiss, manual marks and step ticks are unsigned, each audited as
 *    will:console with ids only; progress follows. Resume files goal.activate;
 *    Add Step files plan.change; edit, timing, done and abandon file theirs.
 *  - A newer change to what counts as done, or to the timing, replaces an older
 *    card still waiting; and a card filed before a later change does not apply
 *    (each says what it changes from). An overdue goal's cadence can still change.
 *  - The unsigned writes move progress only: never a Flint action's or an asset's
 *    step, never a skipped one, never another goal's step or check, never an
 *    active goal into dismissed, and never a paused goal back to active.
 *  - A linked pull request whose sync sets state merged and status archived
 *    makes "Is Merged" met (finished items count).
 *  - A step tick takes the goal's lock before it touches the plan.
 *  - Reviews are off and nothing is late. No goal text in the Fastify log, an
 *    audit entry, or a card's reason.
 * Synthetic text only.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import pg from 'pg';
import { digestOf, type GoalView, type GoalsPage } from '@flint/policy';
import { NO_DB, freshDb, withClient, pgConfig, id, HEX, type TestUrls } from './db';
import { enrollTestKey } from './sign';
import { buildApp } from '../src/app';
import { createDb, type Db } from '../src/db';
import type { RuntimeScope } from '../src/config';
import { approveProposal, createProposal } from '../src/governance/proposals';
import { runInternal } from '../src/governance/internal';
import { syncOnce } from '../src/sources/sync';
import type { Source, SourceObservation, SourceRun } from '../src/sources/types';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const SERVER = 'server-token-0123456789abcdef';
const CANARY = 'Synthetic CANARY-p3panel';
const DAY = 86_400_000;
const draftKey = () => randomBytes(12).toString('hex');
const runAt = (now: Date): Omit<SourceRun, 'cursor'> => ({ now, signal: new AbortController().signal, fetch: async () => new Response(null, { status: 599 }) });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(NO_DB)('the goals panel’s routes on flint_test', () => {
  let urls: TestUrls;
  let db: Db;
  let key: Awaited<ReturnType<typeof enrollTestKey>>;
  let app: ReturnType<typeof buildApp>;
  const lines: string[] = [];
  const owner = (sql: string, params: unknown[] = []) => withClient(urls.owner, (c) => c.query(sql, params));
  const call = async (method: 'GET' | 'POST', url: string, body?: unknown) => {
    const r = await app.inject({ method, url, ...(body !== undefined ? { payload: body as object } : {}), headers: { authorization: `Bearer ${SERVER}` } });
    return { status: r.statusCode, body: r.body ? (JSON.parse(r.body) as Record<string, unknown>) : {} };
  };
  async function sign(pid: string) {
    const p = await db.proposal.findUniqueOrThrow({ where: { id: pid } });
    await approveProposal(db, pid, await key.approve({ subjectId: pid, action: p.action, argsDigest: p.argsDigest }), undefined, 'test');
  }
  const run = (pid: string) => runInternal(db, pid, undefined, 'UTC', 'test');
  async function signRun(pid: string) {
    await sign(pid);
    return run(pid);
  }
  async function entity(kind: string, state: Record<string, unknown>, k = `${kind}:test:${id('k')}`) {
    const eid = id('en');
    await owner(`INSERT INTO "Entity" (id, kind, key, name, state, "stateHash", "lastObservedAt", "updatedAt") VALUES ($1, $2, $3, $1, $4::jsonb, $5, now(), now())`, [eid, kind, k, JSON.stringify(state), HEX('d')]);
    return eid;
  }
  const view = async (gid: string) => ((await call('GET', `/v1/goals/${gid}`)).body.goal as GoalView);
  const page = async (tab: string) => (await call('GET', `/v1/goals?tab=${tab}`)).body as unknown as GoalsPage;

  /** A new goal's args exactly as the console builds them: every field, lists sorted, links in item order. */
  function shown(dk: string, over: Record<string, unknown> = {}) {
    return {
      goalId: `go${dk}`, owner: 'will', origin: 'will', sensitivity: 'personal', tainted: false, nexusProjectId: null,
      title: `${CANARY} goal`, description: `${CANARY} why`, horizonAt: new Date(Date.now() + 60 * DAY).toISOString(), reviewCadence: 'P1W',
      successCriteria: [{ id: 'c1', text: `${CANARY} done when`, check: { kind: 'manual' } }],
      links: [], plan: null, ...over,
    };
  }
  const step = (k: string, n: number, title = `${CANARY} step ${k}`, kind = 'will_task') => ({ op: 'add', key: k, step: { ordinal: 100 * n, title, kind, tier: 'approval', dueAt: null, dependsOn: [] } });
  /** What a goal is now, as the console says it in a card's `from`. */
  const definitionOf = (v: GoalView) => ({ title: v.title, description: v.description, successCriteria: v.successCriteria, links: v.links.map((l) => ({ entityId: l.entityId, role: l.role, watchPaths: l.watchPaths })) });
  const timingOf = (v: GoalView) => ({ horizonAt: v.horizonAt, reviewCadence: v.reviewCadence });
  /** A goal filed, signed and run through the routes; its id and the args it was shown with. */
  async function started(over: Record<string, unknown> = {}) {
    const dk = draftKey();
    const args = shown(dk, over);
    await signRun((await call('POST', '/v1/goals', { draftKey: dk, args })).body.id as string);
    return { gid: args.goalId, args };
  }
  const statusOf = async (pid: string) => (await db.proposal.findUniqueOrThrow({ where: { id: pid } })).status;

  beforeAll(async () => {
    urls = await freshDb();
    db = createDb(urls.app);
    key = await enrollTestKey(urls);
    app = buildApp({
      db, logger: true, logStream: { write: (l: string) => void lines.push(l) },
      config: { tz: 'UTC', tokens: [{ name: 'server', sha256: sha(SERVER), scopes: new Set<RuntimeScope>(['events', 'audit', 'proposals', 'world:read', 'ledger', 'counters']) }] },
    });
  });
  afterAll(async () => {
    await app?.close();
    await db?.$disconnect();
  });
  afterEach(() => {
    // The log never carries a goal's words: not a title, a check, a step, or what was searched for.
    expect(lines.join('\n')).not.toContain('CANARY');
  });

  it('a new goal: filed, signed and run it is active with its links and plan v1; the digest is the shown args’; one card per draft', async () => {
    const pr = await entity('pull_request', { number: 57, state: 'open' }, 'pull_request:github:wpf002/flint#57');
    const dk = draftKey();
    const args = shown(dk, {
      successCriteria: [
        { id: 'c1', text: `${CANARY} merged`, check: { kind: 'item', entityId: pr, key: 'state', value: 'merged' } },
        { id: 'c2', text: `${CANARY} steps`, check: { kind: 'steps', keys: ['s1', 's2'] } },
      ],
      links: [{ entityId: pr, role: 'target', watchPaths: ['state'] }],
      plan: { ops: [step('s1', 1), step('s2', 2)] },
    });
    const filed = await call('POST', '/v1/goals', { draftKey: dk, args });
    expect(filed).toEqual({ status: 200, body: { id: expect.any(String), deduped: false } });
    const pid = filed.body.id as string;
    const card = await db.proposal.findUniqueOrThrow({ where: { id: pid } });
    // What Will signs is the digest of exactly what the panel showed him.
    expect(card).toMatchObject({ action: 'goal.activate', kind: 'goal', origin: 'console', argsDigest: digestOf(args), consequential: true, sensitivity: 'personal', reason: 'Approving starts this goal.' });
    expect(Math.abs(card.expiresAt.getTime() - card.createdAt.getTime() - 7 * DAY)).toBeLessThan(5_000);
    // The same draft again is the same card.
    expect((await call('POST', '/v1/goals', { draftKey: dk, args })).body).toEqual({ id: pid, deduped: true });
    // While it waits, the Active tab lists it as waiting, by its own words, and it is not a goal yet.
    const before = await page('active');
    expect(before.waiting).toEqual([{ proposalId: pid, goalId: args.goalId, title: args.title, checks: 2 }]);
    expect(before.goals).toEqual([]);
    expect(before.reviews).toBe('off');
    expect((await call('GET', `/v1/goals/${args.goalId}`)).status).toBe(404);

    expect(await signRun(pid)).toMatchObject({ goalId: args.goalId, links: 1, steps: 2 });
    const v = await view(args.goalId);
    expect(v).toMatchObject({
      id: args.goalId, status: 'active', title: args.title, origin: 'will', reviews: 'off', late: false,
      checks: { met: 0, total: 2, unknown: 0 }, plan: { version: 1 }, waiting: [],
      links: [{ entityId: pr, role: 'target', watchPaths: ['state'], label: 'wpf002/flint #57', kind: 'pull_request', status: 'active' }],
    });
    expect(v.plan!.steps.map((s) => [s.key, s.status])).toEqual([['s1', 'todo'], ['s2', 'todo']]);
    const after = await page('active');
    expect(after.waiting).toEqual([]);
    expect(after.goals).toEqual([expect.objectContaining({ id: args.goalId, status: 'active', checks: { met: 0, total: 2, unknown: 0 }, waiting: 0, late: false })]);
    // Abandoned: a card of its own, and it moves to Finished for good.
    const abandon = await call('POST', `/v1/goals/${args.goalId}/abandon`, { args: { goalId: args.goalId, goalTitle: args.title } });
    expect((await db.proposal.findUniqueOrThrow({ where: { id: abandon.body.id as string } }))).toMatchObject({ action: 'goal.abandon', reason: 'Approving abandons it for good.', consequential: true });
    await signRun(abandon.body.id as string);
    expect((await page('finished')).goals.find((g) => g.id === args.goalId)).toMatchObject({ status: 'abandoned', late: false });
    expect((await page('active')).goals.find((g) => g.id === args.goalId)).toBeUndefined();
  });

  it('a changed draft’s card replaces the one still waiting; another goal’s waiting card is left alone', async () => {
    const dk = draftKey();
    const first = await call('POST', '/v1/goals', { draftKey: dk, args: shown(dk) });
    const other = await call('POST', '/v1/goals', { draftKey: draftKey(), args: shown(draftKey(), {}) }).catch(() => undefined);
    expect(other?.status).toBe(400); // a goal id not made from its draft key
    const unrelatedDk = draftKey();
    const unrelated = await call('POST', '/v1/goals', { draftKey: unrelatedDk, args: shown(unrelatedDk) });
    const second = await call('POST', '/v1/goals', { draftKey: dk, args: shown(dk, { title: `${CANARY} goal, sharper` }) });
    expect(second.body.deduped).toBe(false);
    expect(await db.proposal.findUniqueOrThrow({ where: { id: first.body.id as string } })).toMatchObject({ status: 'rejected', error: 'A newer version of this card replaced it.' });
    expect((await db.proposal.findUniqueOrThrow({ where: { id: unrelated.body.id as string } })).status).toBe('pending');
    expect((await db.proposal.findUniqueOrThrow({ where: { id: second.body.id as string } })).status).toBe('pending');
  });

  it('pause, marks and step ticks are unsigned and audited as will:console with ids only; resume, Add Step, edit, timing, done and abandon are cards', async () => {
    const dk = draftKey();
    const gid = `go${dk}`;
    const args = shown(dk, {
      successCriteria: [{ id: 'c1', text: `${CANARY} mark me`, check: { kind: 'manual' } }, { id: 'c2', text: `${CANARY} steps`, check: { kind: 'steps', keys: ['s1'] } }],
      plan: { ops: [step('s1', 1)] },
    });
    await signRun((await call('POST', '/v1/goals', { draftKey: dk, args })).body.id as string);

    // Will's mark on his own check, and back; then a step ticked: progress follows each.
    expect(await call('POST', `/v1/goals/${gid}/criteria/c1`, { met: true })).toEqual({ status: 200, body: { ok: true } });
    const marked = await db.goal.findUniqueOrThrow({ where: { id: gid } });
    expect(Object.keys(marked.criteriaMet as object)).toEqual(['c1']);
    expect(marked.progress).toBeCloseTo(0.5);
    expect((await call('POST', `/v1/goals/${gid}/criteria/c2`, { met: true })).body).toMatchObject({ code: 'notManual', error: 'Flint checks this one itself.' });
    expect((await call('POST', `/v1/goals/${gid}/criteria/c9`, { met: true })).body).toMatchObject({ code: 'noCheck' });
    expect((await call('POST', `/v1/goals/${gid}/steps/s1`, { status: 'done' })).status).toBe(200);
    expect((await view(gid)).checks).toEqual({ met: 2, total: 2, unknown: 0 });
    expect((await db.goal.findUniqueOrThrow({ where: { id: gid } })).progress).toBe(1);
    expect((await call('POST', `/v1/goals/${gid}/steps/s1`, { status: 'todo' })).status).toBe(200);
    expect((await db.planStep.findFirstOrThrow({ where: { key: 's1', plan: { goalId: gid, status: 'active' } } })).doneAt).toBeNull();
    expect((await call('POST', `/v1/goals/${gid}/steps/s9`, { status: 'done' })).body).toMatchObject({ code: 'noStep' });
    expect((await call('POST', `/v1/goals/${gid}/criteria/c1`, { met: false })).status).toBe(200);
    expect((await db.goal.findUniqueOrThrow({ where: { id: gid } })).criteriaMet).toEqual({});

    // Add Step: a plan change Will signs.
    const add = await call('POST', `/v1/goals/${gid}/plan`, { args: { goalId: gid, goalTitle: args.title, ops: [step('s2', 2)] } });
    const planCard = await db.proposal.findUniqueOrThrow({ where: { id: add.body.id as string } });
    expect(planCard).toMatchObject({ action: 'plan.change', kind: 'plan', consequential: true, reason: 'You asked for this change.' });
    expect((await view(gid)).waiting).toEqual([{ id: planCard.id, action: 'plan.change' }]);
    expect((await page('active')).goals.find((g) => g.id === gid)?.waiting).toBe(1);
    expect(await signRun(planCard.id)).toMatchObject({ version: 2, steps: 2 });

    // Pause (unsigned), then resume: a goal.activate card with exactly what the goal is.
    expect((await call('POST', `/v1/goals/${gid}/pause`, {})).status).toBe(200);
    expect((await call('POST', `/v1/goals/${gid}/pause`, {})).body).toMatchObject({ code: 'status.paused', error: 'This goal is paused.' });
    expect((await page('active')).goals.find((g) => g.id === gid)?.status).toBe('paused');
    const resume = await call('POST', `/v1/goals/${gid}/resume`, { args: { ...args, plan: null } });
    const resumeCard = await db.proposal.findUniqueOrThrow({ where: { id: resume.body.id as string } });
    expect(resumeCard).toMatchObject({ action: 'goal.activate', reason: 'Approving resumes this goal.', consequential: true });
    expect(await signRun(resumeCard.id)).toEqual({ goalId: gid, resumed: true });

    // What counts as done, and its timing.
    const editArgs = { goalId: gid, title: `${CANARY} goal, sharper`, description: '', successCriteria: [args.successCriteria[0]], links: [], from: definitionOf(await view(gid)) };
    // A card that does not say what it changes from is not one the panel files.
    expect((await call('POST', `/v1/goals/${gid}/edit`, { args: { ...editArgs, from: undefined } })).body).toMatchObject({ code: 'invalid' });
    const edit = await call('POST', `/v1/goals/${gid}/edit`, { args: editArgs });
    expect((await db.proposal.findUniqueOrThrow({ where: { id: edit.body.id as string } })).argsDigest).toBe(digestOf(editArgs));
    await signRun(edit.body.id as string);
    const horizonAt = new Date(Date.now() + 30 * DAY).toISOString();
    const timing = await call('POST', `/v1/goals/${gid}/timing`, { args: { goalId: gid, goalTitle: editArgs.title, horizonAt, reviewCadence: 'P2W', from: timingOf(await view(gid)) } });
    await signRun(timing.body.id as string);
    expect(await view(gid)).toMatchObject({ title: editArgs.title, horizonAt, reviewCadence: 'P2W', checks: { total: 1 } });
    // A card naming the goal as it no longer is, or another goal, is refused with a sentence and a code.
    expect((await call('POST', `/v1/goals/${gid}/done`, { args: { goalId: gid, goalTitle: args.title } })).body).toMatchObject({ code: 'looked' });
    expect((await call('POST', `/v1/goals/${gid}/done`, { args: { goalId: 'goSomeOtherGoal01', goalTitle: args.title } })).body).toMatchObject({ code: 'invalid' });

    // Done: Flint stops; it moves to Finished.
    const done = await call('POST', `/v1/goals/${gid}/done`, { args: { goalId: gid, goalTitle: editArgs.title } });
    expect((await db.proposal.findUniqueOrThrow({ where: { id: done.body.id as string } })).reason).toBe('Approving marks it done.');
    await signRun(done.body.id as string);
    const finished = await page('finished');
    expect(finished.goals.find((g) => g.id === gid)).toMatchObject({ status: 'done', endedAt: expect.any(String) });
    expect((await call('POST', `/v1/goals/${gid}/steps/s1`, { status: 'done' })).body).toMatchObject({ code: 'status.done' });

    // Every unsigned write is audited as Will in the console, with ids only.
    const audits = await db.auditEntry.findMany({ where: { actor: 'will:console', inputs: { path: ['goalId'], equals: gid } }, orderBy: { seq: 'asc' } });
    expect(audits.map((a) => a.action)).toEqual(['goal.criterion.mark', 'goal.step.status', 'goal.step.status', 'goal.criterion.mark', 'goal.pause']);
    expect(audits.every((a) => a.context === 'console' && a.kind === 'action')).toBe(true);
    const everything = JSON.stringify(await db.auditEntry.findMany({ where: { OR: [{ actor: 'will:console' }, { correlationId: { in: [planCard.id, resumeCard.id] } }] } }), (_k, v: unknown) => (typeof v === 'bigint' ? String(v) : v));
    expect(everything).not.toContain('CANARY');
  });

  it('a newer edit or timing card replaces the one still waiting; done, plan and other goals’ cards are left alone', async () => {
    const { gid, args } = await started();
    const other = await started();
    const v = await view(gid);
    const edit = (title: string) => call('POST', `/v1/goals/${gid}/edit`, { args: { goalId: gid, title, description: v.description, successCriteria: v.successCriteria, links: [], from: definitionOf(v) } });
    const timing = (reviewCadence: string) => call('POST', `/v1/goals/${gid}/timing`, { args: { goalId: gid, goalTitle: v.title, horizonAt: v.horizonAt, reviewCadence, from: timingOf(v) } });
    const editA = (await edit(`${CANARY} edit A`)).body.id as string;
    const timingA = (await timing('P1D')).body.id as string;
    const done = (await call('POST', `/v1/goals/${gid}/done`, { args: { goalId: gid, goalTitle: args.title } })).body.id as string;
    const plan = (await call('POST', `/v1/goals/${gid}/plan`, { args: { goalId: gid, goalTitle: args.title, ops: [step('s1', 1)] } })).body.id as string;
    const otherView = await view(other.gid);
    const otherEdit = (await call('POST', `/v1/goals/${other.gid}/edit`, { args: { goalId: other.gid, title: `${CANARY} other edit`, description: '', successCriteria: otherView.successCriteria, links: [], from: definitionOf(otherView) } })).body.id as string;
    // A card filed at the terminal (origin cli, straight at the runtime's proposals) is held to the same rule: it
    // says what it changes from, or it is not a card; and a newer change from the console replaces it too.
    const cli = (a: Record<string, unknown>) => call('POST', '/v1/proposals', { kind: 'goal', origin: 'cli', action: 'goal.criteria_change', args: a, argsProvenance: { args: { source: 'will', tainted: false } }, sensitivity: 'personal' });
    const cliArgs = { goalId: gid, title: `${CANARY} cli edit`, description: v.description, successCriteria: v.successCriteria, links: [] };
    expect(await cli(cliArgs)).toMatchObject({ status: 400, body: { error: 'This goal card isn’t valid.' } });
    expect(await call('POST', '/v1/proposals', { kind: 'goal', origin: 'cli', action: 'goal.horizon_change', args: { goalId: gid, goalTitle: v.title, horizonAt: null, reviewCadence: 'P1D' }, argsProvenance: {}, sensitivity: 'personal' }))
      .toMatchObject({ status: 400, body: { error: 'This goal card isn’t valid.' } });
    const cliCard = await cli({ ...cliArgs, from: definitionOf(v) });
    expect(cliCard.status).toBe(201);
    // The same card again is that card, and replaces nothing.
    expect((await edit(`${CANARY} edit A`)).body).toEqual({ id: editA, deduped: true });
    expect(await statusOf(editA)).toBe('pending');
    const editB = (await edit(`${CANARY} edit B`)).body.id as string;
    const timingB = (await timing('P2W')).body.id as string;
    expect(await db.proposal.findUniqueOrThrow({ where: { id: editA } })).toMatchObject({ status: 'rejected', error: 'A newer version of this card replaced it.' });
    expect(await db.proposal.findUniqueOrThrow({ where: { id: timingA } })).toMatchObject({ status: 'rejected', error: 'A newer version of this card replaced it.' });
    expect(await db.proposal.findUniqueOrThrow({ where: { id: cliCard.body.id as string } })).toMatchObject({ status: 'rejected', error: 'A newer version of this card replaced it.' });
    for (const pid of [editB, timingB, done, plan, otherEdit]) expect(await statusOf(pid), pid).toBe('pending');
    expect((await view(gid)).waiting.map((w) => w.id).sort()).toEqual([editB, timingB, done, plan].sort());
  });

  it('a card filed before a later change does not undo it: it says what it changes from, and is refused when the goal has moved on', async () => {
    const { gid, args } = await started();
    const v = await view(gid);
    const from = definitionOf(v);
    const file = (action: string, a: Record<string, unknown>) => createProposal(db, {
      kind: 'goal', origin: 'console', action, args: a, argsProvenance: { args: { source: 'will', tainted: false } }, tainted: false, sensitivity: 'personal', destructive: false, consequential: true, ttlMinutes: 60,
    }, 'test');
    // Two edits and two timing changes, each from the goal as it is now; filed past the routes so neither replaces the other.
    const editA = await file('goal.criteria_change', { goalId: gid, title: `${CANARY} stale title`, description: v.description, successCriteria: v.successCriteria, links: [], from });
    const editB = await file('goal.criteria_change', { goalId: gid, title: `${CANARY} newer title`, description: v.description, successCriteria: v.successCriteria, links: [], from });
    const timingA = await file('goal.horizon_change', { goalId: gid, goalTitle: args.title, horizonAt: v.horizonAt, reviewCadence: 'P1D', from: timingOf(v) });
    const timingB = await file('goal.horizon_change', { goalId: gid, goalTitle: args.title, horizonAt: v.horizonAt, reviewCadence: 'P1M', from: timingOf(v) });
    await signRun(timingB.id);
    await signRun(editB.id);
    // The older ones, approved later (they sat in Approvals after a cancelled prompt): refused, and nothing reverts.
    await sign(editA.id);
    await expect(run(editA.id)).rejects.toMatchObject({ status: 409, message: 'The goal changed since this card was filed.' });
    await sign(timingA.id);
    await expect(run(timingA.id)).rejects.toMatchObject({ status: 409, message: 'The goal changed since this card was filed.' });
    expect(await db.proposal.findUniqueOrThrow({ where: { id: editA.id } })).toMatchObject({ status: 'failed', error: 'The goal changed since this card was filed.' });
    expect(await view(gid)).toMatchObject({ title: `${CANARY} newer title`, reviewCadence: 'P1M' });
    // And a card that says it changes from something the goal no longer is cannot even be filed.
    expect(await call('POST', `/v1/goals/${gid}/edit`, { args: { goalId: gid, title: `${CANARY} third`, description: '', successCriteria: v.successCriteria, links: [], from } }))
      .toMatchObject({ status: 409, body: { code: 'looked' } });
    expect(await call('POST', `/v1/goals/${gid}/timing`, { args: { goalId: gid, goalTitle: `${CANARY} newer title`, horizonAt: null, reviewCadence: 'P1W', from: timingOf(v) } }))
      .toMatchObject({ status: 409, body: { code: 'looked' } });
  });

  it('an overdue goal keeps its date while its cadence changes; only a new date has to be in the future', async () => {
    const soon = new Date(Date.now() + 1500).toISOString();
    const { gid, args } = await started({ horizonAt: soon });
    await sleep(1700);
    const v = await view(gid);
    expect(Date.parse(v.horizonAt!)).toBeLessThan(Date.now());
    const timing = (a: Record<string, unknown>) => call('POST', `/v1/goals/${gid}/timing`, { args: { goalId: gid, goalTitle: args.title, from: timingOf(v), ...a } });
    const past = new Date(Date.now() - DAY).toISOString();
    expect(await timing({ horizonAt: past, reviewCadence: 'P2W' })).toMatchObject({ status: 400, body: { code: 'future' } });
    const kept = await timing({ horizonAt: soon, reviewCadence: 'P2W' });
    expect(kept.status).toBe(200);
    await signRun(kept.body.id as string);
    expect(await view(gid)).toMatchObject({ horizonAt: soon, reviewCadence: 'P2W' });
  });

  it('the unsigned writes move progress only: no Flint or asset step, no skipped step, no other goal’s step or check, no dismissing a started goal, no resuming', async () => {
    const a = await started({
      successCriteria: [{ id: 'c1', text: `${CANARY} mine`, check: { kind: 'manual' } }, { id: 'c2', text: `${CANARY} second`, check: { kind: 'manual' } }],
      plan: { ops: [step('s1', 1), step('s2', 2, `${CANARY} flint step`, 'flint_action'), step('s3', 3, `${CANARY} asset step`, 'asset_task'), step('s4', 4)] },
    });
    const b = await started({ plan: { ops: [step('s1', 1)] } });
    const bare = await started();
    const tick = (gid: string, key: string, status = 'done') => call('POST', `/v1/goals/${gid}/steps/${key}`, { status });
    const stepOf = (gid: string, key: string) => db.planStep.findFirstOrThrow({ where: { key, plan: { goalId: gid, status: 'active' } } });
    // A Flint action is done by doing it, an asset's task by its asset: neither is Will's to tick.
    expect(await tick(a.gid, 's2')).toMatchObject({ status: 400, body: { code: 'notTickable', error: 'Flint carries out this step itself.' } });
    expect(await tick(a.gid, 's3')).toMatchObject({ status: 400, body: { code: 'notTickable' } });
    expect((await stepOf(a.gid, 's2')).status).toBe('todo');
    expect((await stepOf(a.gid, 's3')).status).toBe('todo');
    // A skipped step (a signed plan change) stays skipped.
    const skip = await call('POST', `/v1/goals/${a.gid}/plan`, { args: { goalId: a.gid, goalTitle: a.args.title, ops: [{ op: 'set', key: 's4', from: { title: `${CANARY} step s4`, status: 'todo' }, to: { status: 'skipped' } }] } });
    await signRun(skip.body.id as string);
    for (const status of ['done', 'todo', 'in_progress', 'blocked']) expect(await tick(a.gid, 's4', status)).toMatchObject({ status: 409, body: { code: 'skipped' } });
    expect((await stepOf(a.gid, 's4')).status).toBe('skipped');
    // A goal with no plan has no step to tick.
    expect(await tick(bare.gid, 's1')).toMatchObject({ status: 404, body: { code: 'noPlan', error: 'This goal has no steps yet.' } });
    // Another goal's step or check is not reachable through this one: b has s1 and c1 only.
    expect(await tick(b.gid, 's2')).toMatchObject({ status: 404, body: { code: 'noStep' } });
    expect(await tick(b.gid, 's4')).toMatchObject({ status: 404, body: { code: 'noStep' } });
    expect((await stepOf(a.gid, 's2')).status).toBe('todo');
    expect(await call('POST', `/v1/goals/${b.gid}/criteria/c2`, { met: true })).toMatchObject({ status: 404, body: { code: 'noCheck' } });
    expect((await db.goal.findUniqueOrThrow({ where: { id: a.gid } })).criteriaMet).toEqual({});
    expect((await db.goal.findUniqueOrThrow({ where: { id: b.gid } })).criteriaMet).toEqual({});
    expect(await tick('goNoSuchGoalAtAll01', 's1')).toMatchObject({ status: 404, body: { code: 'noGoal' } });
    // Dismissing is for a goal Flint suggested, never one that has started.
    expect(await call('POST', `/v1/goals/${a.gid}/dismiss`, {})).toMatchObject({ status: 409, body: { code: 'status.active', error: 'This goal is already active.' } });
    // Pausing never resumes: a paused goal comes back only with Will's signature.
    expect((await call('POST', `/v1/goals/${b.gid}/pause`, {})).status).toBe(200);
    expect(await call('POST', `/v1/goals/${b.gid}/pause`, {})).toMatchObject({ status: 409, body: { code: 'status.paused' } });
    expect(await call('POST', `/v1/goals/${b.gid}/dismiss`, {})).toMatchObject({ status: 409, body: { code: 'status.paused' } });
    expect((await call('POST', `/v1/goals/${b.gid}/resume`, {})).status).toBe(400);
    expect((await tick(b.gid, 's1')).status).toBe(200);
    expect((await call('POST', `/v1/goals/${b.gid}/criteria/c1`, { met: true })).status).toBe(200);
    const resume = await call('POST', `/v1/goals/${b.gid}/resume`, { args: { ...b.args, plan: null } });
    expect(resume.status).toBe(200);
    // Still paused through all of that, the resume card included: only its signature starts it again.
    expect((await db.goal.findUniqueOrThrow({ where: { id: b.gid } })).status).toBe('paused');
    await signRun(resume.body.id as string);
    expect((await db.goal.findUniqueOrThrow({ where: { id: b.gid } })).status).toBe('active');
  });

  it('a goal with more than 50 cards waiting still opens: the view names the oldest 50', async () => {
    const { gid, args } = await started();
    for (let i = 0; i < 53; i++) {
      await createProposal(db, {
        kind: 'plan', origin: 'console', action: 'plan.change', args: { goalId: gid, goalTitle: args.title, ops: [step('s1', 1, `Synthetic waiting step ${i}`)] },
        argsProvenance: { args: { source: 'will', tainted: false } }, tainted: false, sensitivity: 'personal', destructive: false, consequential: true, ttlMinutes: 60,
      }, 'test');
    }
    const r = await call('GET', `/v1/goals/${gid}`);
    expect(r.status).toBe(200);
    expect((r.body.goal as GoalView).waiting).toHaveLength(50);
    expect((await page('active')).goals.find((g) => g.id === gid)?.waiting).toBe(53);
  });

  it('dismissing a goal Flint suggested is unsigned and audited; it moves to Finished', async () => {
    const gid = `go${draftKey()}`;
    await owner(`INSERT INTO "Goal" (id, title, owner, origin, "sourceRef", "successCriteria") VALUES ($1, $2, 'flint', 'flint', $3, $4::jsonb)`, [
      gid, `${CANARY} suggested`, `chat:${sha(gid)}`, JSON.stringify([{ id: 'c1', text: `${CANARY} check`, check: { kind: 'manual' } }]),
    ]);
    expect((await page('suggested')).goals.map((g) => [g.id, g.origin])).toEqual([[gid, 'flint']]);
    expect((await call('POST', `/v1/goals/${gid}/dismiss`, {})).status).toBe(200);
    expect((await call('POST', `/v1/goals/${gid}/dismiss`, {})).body).toMatchObject({ code: 'status.rejected' });
    expect((await page('suggested')).goals).toEqual([]);
    expect((await page('finished')).goals.find((g) => g.id === gid)?.status).toBe('rejected');
    expect((await db.auditEntry.findFirstOrThrow({ where: { action: 'goal.dismiss', inputs: { path: ['goalId'], equals: gid } } }))).toMatchObject({ actor: 'will:console', context: 'console' });
  });

  it('a linked pull request whose sync sets state merged and status archived makes “Is Merged” met', async () => {
    const p = await createProposal(db, { kind: 'tool_call', origin: 'console', action: 'world.source.enable', args: { source: 'github' }, argsProvenance: { source: { source: 'will', tainted: false } }, tainted: false, sensitivity: 'ops', destructive: false, consequential: false, ttlMinutes: 60 }, 'test');
    await signRun(p.id);
    const k = 'pull_request:github:wpf002/flint#88';
    const ob = (state: 'open' | 'merged'): SourceObservation => ({
      type: 'pull_request.state', kind: 'pull_request', key: k, name: `${CANARY} PR title`, sensitivity: 'ops', externalId: 'pull_request:wpf002/flint#88',
      taintedPaths: ['name', 'state.title'], state: { number: 88, state, title: `${CANARY} PR title` }, ...(state === 'open' ? {} : { status: 'archived' as const }),
    });
    let next: SourceObservation = ob('open');
    const github: Source = { name: 'github', cadenceMs: 300_000, run: async () => ({ observations: [next], metrics: [] }) };
    await syncOnce(db, github, runAt(new Date()), 'UTC');
    const pr = (await db.entity.findFirstOrThrow({ where: { key: k } })).id;
    const dk = draftKey();
    const args = shown(dk, {
      successCriteria: [{ id: 'c1', text: `${CANARY} merged`, check: { kind: 'item', entityId: pr, key: 'state', value: 'merged' } }],
      links: [{ entityId: pr, role: 'target', watchPaths: ['state'] }],
    });
    await signRun((await call('POST', '/v1/goals', { draftKey: dk, args })).body.id as string);
    expect((await view(args.goalId)).criteria).toEqual([{ id: 'c1', state: 'unmet' }]);
    next = ob('merged');
    await syncOnce(db, github, runAt(new Date(Date.now() + 60_000)), 'UTC');
    expect(await db.entity.findUniqueOrThrow({ where: { id: pr } })).toMatchObject({ status: 'archived', state: { state: 'merged' } });
    const v = await view(args.goalId);
    expect(v.criteria).toEqual([{ id: 'c1', state: 'met' }]);
    expect(v.checks).toEqual({ met: 1, total: 1, unknown: 0 });
    // Named by its key, never its title.
    expect(v.links[0]).toMatchObject({ label: 'wpf002/flint #88', status: 'archived' });
    expect(JSON.stringify(v.links)).not.toContain('PR title');
    // Found in the picker by number, its title kept apart (outside text), its label from its key.
    const found = await call('POST', '/v1/goals/linkable', { q: '#88' });
    expect(found.body).toEqual({ items: [expect.objectContaining({ entityId: pr, label: 'wpf002/flint #88', status: 'archived', title: `${CANARY} PR title` })] });
    await call('POST', '/v1/goals/linkable', { q: `${CANARY} never logged` });
  });

  it('a step tick takes the goal’s lock before it touches the plan, and waits for it', async () => {
    const dk = draftKey();
    const gid = `go${dk}`;
    await signRun((await call('POST', '/v1/goals', { draftKey: dk, args: shown(dk, { successCriteria: [{ id: 'c1', text: `${CANARY} steps`, check: { kind: 'steps', keys: ['s1'] } }], plan: { ops: [step('s1', 1)] } }) })).body.id as string);
    const holder = new pg.Client(pgConfig(urls.owner));
    const prober = new pg.Client(pgConfig(urls.owner));
    await holder.connect();
    await prober.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT id FROM "Goal" WHERE id = $1 FOR UPDATE`, [gid]);
      const tick = call('POST', `/v1/goals/${gid}/steps/s1`, { status: 'done' });
      await sleep(400);
      // The tick is waiting on the goal, and holds nothing of the plan: the plan can be locked at once.
      await prober.query('BEGIN');
      await prober.query(`SELECT id FROM "Plan" WHERE "goalId" = $1 AND status = 'active' FOR UPDATE NOWAIT`, [gid]);
      await prober.query('ROLLBACK');
      expect((await db.planStep.findFirstOrThrow({ where: { key: 's1', plan: { goalId: gid, status: 'active' } } })).status).toBe('todo');
      await holder.query('COMMIT');
      expect((await tick).status).toBe(200);
      expect((await db.planStep.findFirstOrThrow({ where: { key: 's1', plan: { goalId: gid, status: 'active' } } })).status).toBe('done');
    } finally {
      await holder.end();
      await prober.end();
    }
  });
});
