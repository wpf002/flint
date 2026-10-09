/**
 * P3's goal cards on flint_test, the way the runtime runs them: filed
 * (createProposal), signed with a test key, approved (approveProposal) and run
 * (runInternal), as P2.5's cards are.
 *
 *  - A new goal with its links and first plan takes one signature; resuming,
 *    re-scoping (with a link change) and re-timing each take one more.
 *  - Done and abandoned resolve the goal's forecasts as Will.
 *  - Plan cards on different steps compose in either order; one whose step
 *    changed fails with a sentence and leaves the plan as it was.
 *  - Filing refuses what could not apply; reasons are fixed sentences.
 *  - A change and its card's completion commit together: a fault leaves nothing
 *    applied and the card approved.
 *  - No goal text in a log line, an audit entry, a card's reason, error or
 *    result, or the history (a CHECK's DETAIL carries the row: it never gets out).
 * Synthetic text only.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { NO_DB, freshDb, withClient, id, HEX, type TestUrls } from './db';
import { enrollTestKey } from './sign';
import { createDb, type Db, type Tx } from '../src/db';
import { digestOf } from '@flint/policy';
import { approveProposal, createProposal } from '../src/governance/proposals';
import { runInternal } from '../src/governance/internal';
import { runGoal, runGoalCard } from '../src/goals/apply';
import { SAY } from '../src/goals/errors';

const DAY = 86_400_000;
const CANARY = 'Synthetic CANARY-p3';
const crit = (cid: string, check: Record<string, unknown> = { kind: 'manual' }) => ({ id: cid, text: `${CANARY} check ${cid}`, check });
const addOp = (key: string, over: Record<string, unknown> = {}) => ({ op: 'add', key, step: { ordinal: 100 * Number(key.slice(1)), title: `${CANARY} step ${key}`, kind: 'will_task', ...over } });

describe.skipIf(NO_DB)('P3 goal cards on flint_test', () => {
  let urls: TestUrls;
  let db: Db;
  let key: Awaited<ReturnType<typeof enrollTestKey>>;
  let said: string[] = [];
  const owner = (sql: string, params: unknown[] = []) => withClient(urls.owner, (c) => c.query(sql, params));

  beforeAll(async () => {
    urls = await freshDb();
    db = createDb(urls.app);
    key = await enrollTestKey(urls);
  });
  afterAll(async () => db?.$disconnect());
  beforeEach(() => {
    said = [];
    for (const level of ['error', 'warn', 'log', 'info'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void said.push(args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : String(a))).join(' ')));
    }
  });
  afterEach(() => {
    vi.restoreAllMocks();
    // Nothing any test here logged carries a goal's words.
    expect(said.join('\n')).not.toContain('CANARY');
  });

  const file = (action: string, args: Record<string, unknown>, over: Record<string, unknown> = {}) =>
    createProposal(db, {
      kind: action === 'plan.change' ? 'plan' : 'goal', origin: 'console', action, args, argsProvenance: { goal: { source: 'will', tainted: false } },
      tainted: false, sensitivity: 'personal', destructive: false, consequential: false, ttlMinutes: 60, ...over,
    } as Parameters<typeof createProposal>[1], 'test');
  async function sign(pid: string) {
    const p = await db.proposal.findUniqueOrThrow({ where: { id: pid } });
    await approveProposal(db, pid, await key.approve({ subjectId: pid, action: p.action, argsDigest: p.argsDigest }), undefined, 'test');
  }
  const run = (pid: string) => runInternal(db, pid, undefined, 'UTC', 'test');
  async function fileSignRun(action: string, args: Record<string, unknown>, over: Record<string, unknown> = {}) {
    const p = await file(action, args, over);
    await sign(p.id);
    return { id: p.id, result: await run(p.id) };
  }
  async function entity(kind: string, state: Record<string, unknown>): Promise<string> {
    const eid = id('en');
    await owner(`INSERT INTO "Entity" (id, kind, key, name, state, "stateHash", "lastObservedAt", "updatedAt") VALUES ($1, $2, $3, $1, $4::jsonb, $5, now(), now())`, [eid, kind, `${kind}:test:${eid}`, JSON.stringify(state), HEX('d')]);
    return eid;
  }
  const iso = (ms: number) => new Date(ms).toISOString();
  /** A new goal's card args: two checks, two links, a first plan of two steps. */
  async function newGoal(over: Record<string, unknown> = {}) {
    const pr = await entity('pull_request', { number: 57, state: 'open' });
    const svc = await entity('service', { managedBy: 'launchd', health: 'ok' });
    return {
      pr, svc,
      args: {
        goalId: id('go'), title: `${CANARY} goal`, description: `${CANARY} why`, horizonAt: iso(Date.now() + 90 * DAY), reviewCadence: 'P1W',
        successCriteria: [crit('c1', { kind: 'item', entityId: pr, key: 'state', value: 'merged' }), crit('c2', { kind: 'steps', keys: ['s1', 's2'] })],
        links: [{ entityId: pr, role: 'target', watchPaths: ['state'] }, { entityId: svc, role: 'watch', watchPaths: ['health'] }],
        plan: { ops: [addOp('s1'), addOp('s2', { dependsOn: ['s1'] })] },
        ...over,
      } as Record<string, unknown>,
    };
  }
  const goalTitle = `${CANARY} goal`;

  it('a new goal with its links and first plan takes one signature', async () => {
    const { args, pr } = await newGoal();
    const filed = await file('goal.activate', args);
    const card = await db.proposal.findUniqueOrThrow({ where: { id: filed.id } });
    expect(card).toMatchObject({ reason: 'Approving starts this goal.', sensitivity: 'personal', consequential: true, kind: 'goal' });
    await sign(filed.id);
    const result = await run(filed.id);
    expect(result).toMatchObject({ goalId: args.goalId, links: 2, linksAdded: 2, steps: 2 });
    const goal = await db.goal.findUniqueOrThrow({ where: { id: args.goalId as string }, include: { links: true, plans: { include: { steps: true } } } });
    const approved = await db.proposal.findUniqueOrThrow({ where: { id: filed.id } });
    expect(goal).toMatchObject({ status: 'active', approvalId: approved.approvalId, title: args.title, origin: 'will', sensitivity: 'personal' });
    expect(goal.activatedAt).toBeTruthy();
    expect(goal.nextReviewAt).toBeTruthy();
    expect(goal.links.map((l) => [l.entityId, l.seenVersion]).sort()).toContainEqual([pr, 1]);
    expect(goal.plans).toHaveLength(1);
    expect(goal.plans[0]).toMatchObject({ version: 1, status: 'active', approvalId: approved.approvalId, createdBy: 'will' });
    expect(goal.plans[0]!.steps.map((s) => s.key).sort()).toEqual(['s1', 's2']);
    expect(approved).toMatchObject({ status: 'executed', error: null });
    expect(JSON.stringify(approved.result)).not.toContain('CANARY');
    // The same card filed twice while it waits is that card; the goal is now active, so another is refused.
    await expect(file('goal.activate', args)).rejects.toMatchObject({ status: 409, message: 'This goal is already active.' });
  });

  it('filing refuses what could not apply: kind, context, template, args, state, items, steps; reasons are fixed', async () => {
    const { args, pr } = await newGoal();
    const gid = args.goalId as string;
    await expect(file('goal.activate', args, { kind: 'tool_call' })).rejects.toMatchObject({ status: 400, message: SAY.kindGoal });
    await expect(file('plan.change', { goalId: gid, goalTitle, ops: [addOp('s9')] }, { kind: 'goal' })).rejects.toMatchObject({ status: 400, message: SAY.kindPlan });
    await expect(file('goal.activate', args, { origin: 'chat:c1' })).rejects.toMatchObject({ status: 409, message: SAY.fromConsole });
    await expect(file('goal.activate', args, { templateId: 'p3.anything' })).rejects.toMatchObject({ status: 400, message: SAY.template });
    await expect(file('plan.change', { goalId: gid, goalTitle, ops: [addOp('s9')] }, { origin: 'runtime:goals' })).rejects.toMatchObject({ status: 400, message: SAY.template });
    // A job may not ask for any other goal action: FORBIDDEN, and audited as such.
    await expect(file('goal.done', { goalId: gid, goalTitle }, { origin: 'runtime:goals', templateId: 'plan.diff.minor' })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/^forbidden: goal\.done is not an autonomous action/) });
    await expect(file('goal.activate', { ...args, title: 'x'.repeat(121) })).rejects.toMatchObject({ status: 400, message: SAY.invalid });
    await expect(file('goal.activate', { ...args, extra: true })).rejects.toMatchObject({ status: 400, message: SAY.invalid });
    await expect(file('goal.activate', { ...args, horizonAt: iso(Date.now() - DAY) })).rejects.toMatchObject({ status: 400, message: SAY.future });
    await expect(file('goal.activate', { ...args, plan: null })).rejects.toMatchObject({ status: 400, message: SAY.checkStep });
    // Someone from Will's calendar (PersonGuard: a person exists only with that source row).
    const person = id('en');
    await withClient(urls.owner, async (c) => {
      await c.query('BEGIN');
      await c.query(`INSERT INTO "Entity" (id, kind, key, name, state, "stateHash", sensitivity, "lastObservedAt", "updatedAt") VALUES ($1, 'person', $2, 'Synthetic Person', '{}', $3, 'personal', now(), now())`, [person, `person:test:${person}`, HEX('d')]);
      await c.query(`INSERT INTO "EntitySource" (id, "entityId", source, "externalId", "accountOwner", "lastSyncedAt") VALUES ($1, $2, 'google_calendar', $3, 'will', now())`, [id('es'), person, `person:${person}`]);
      await c.query('COMMIT');
    });
    await expect(file('goal.activate', { ...args, links: [...(args.links as unknown[]), { entityId: person, role: 'watch', watchPaths: [] }] })).rejects.toMatchObject({ status: 400, message: SAY.person });
    await expect(file('goal.activate', { ...args, links: [...(args.links as unknown[]), { entityId: 'en-not-there', role: 'watch', watchPaths: [] }] })).rejects.toMatchObject({ status: 400, message: SAY.itemGone });
    // A check that does not fit its item's kind (an issue is never merged).
    const issue = await entity('issue', { number: 8, state: 'open' });
    await expect(file('goal.activate', { ...args, successCriteria: [crit('c1', { kind: 'item', entityId: issue, key: 'state', value: 'merged' })], links: [{ entityId: issue, role: 'target', watchPaths: [] }] })).rejects.toMatchObject({ status: 400, message: SAY.checkItem });
    // Cards for a goal that does not exist yet, or not in a state to take them.
    for (const [action, a] of [['goal.done', { goalId: gid, goalTitle }], ['goal.abandon', { goalId: gid, goalTitle }], ['goal.horizon_change', { goalId: gid, goalTitle, horizonAt: null, reviewCadence: 'P1D' }]] as const) {
      await expect(file(action, a)).rejects.toMatchObject({ status: 409, message: SAY.noGoal });
    }
    await fileSignRun('goal.activate', args);
    await expect(file('goal.done', { goalId: gid, goalTitle: 'Another title' })).rejects.toMatchObject({ status: 409, message: SAY.looked });
    await expect(file('goal.horizon_change', { goalId: gid, goalTitle, horizonAt: args.horizonAt, reviewCadence: 'P1W' })).rejects.toMatchObject({ status: 400, message: SAY.nothing });
    await expect(file('goal.criteria_change', { goalId: gid, title: args.title, description: args.description, successCriteria: args.successCriteria, links: args.links })).rejects.toMatchObject({ status: 400, message: SAY.nothing });
    await expect(file('goal.criteria_change', { goalId: gid, title: 'T', successCriteria: [crit('c1', { kind: 'steps', keys: ['s7'] })], links: [] })).rejects.toMatchObject({ status: 400, message: SAY.checkStep });
    // Reasons: each card's own fixed sentence, whatever the caller sent.
    const reasons = {
      'goal.done': [{ goalId: gid, goalTitle }, 'Approving marks it done.'],
      'goal.abandon': [{ goalId: gid, goalTitle }, 'Approving abandons it for good.'],
      'goal.horizon_change': [{ goalId: gid, goalTitle, horizonAt: null, reviewCadence: 'P1M' }, 'Approving changes its timing.'],
      'goal.criteria_change': [{ goalId: gid, title: 'Synthetic other title', successCriteria: [crit('c1')], links: [] }, 'Approving changes what counts as done.'],
      'plan.change': [{ goalId: gid, goalTitle, ops: [addOp('s3')] }, 'You asked for this change.'],
    } as const;
    for (const [action, [a, reason]] of Object.entries(reasons)) {
      const p = await file(action, a as Record<string, unknown>, { reason: `${CANARY} in a reason` });
      expect((await db.proposal.findUniqueOrThrow({ where: { id: p.id } })).reason, action).toBe(reason);
    }
    expect(pr).toBeTruthy();
  });

  it('pause and resume: resuming is one signature and changes nothing else; a criteria change moves links and clears stale marks; a timing change brings the next review forward', async () => {
    const { args, svc } = await newGoal();
    const gid = args.goalId as string;
    await fileSignRun('goal.activate', args);
    await db.goal.update({ where: { id: gid }, data: { status: 'paused' } });
    await expect(file('goal.activate', { ...args, plan: null, title: 'Synthetic, retitled' })).rejects.toMatchObject({ status: 409, message: SAY.looked });
    await expect(file('goal.activate', args)).rejects.toMatchObject({ status: 400, message: SAY.resumePlan });
    const resumed = await file('goal.activate', { ...args, plan: null });
    expect((await db.proposal.findUniqueOrThrow({ where: { id: resumed.id } })).reason).toBe('Approving resumes this goal.');
    await sign(resumed.id);
    expect(await run(resumed.id)).toEqual({ goalId: gid, resumed: true });
    expect((await db.goal.findUniqueOrThrow({ where: { id: gid } })).status).toBe('active');

    // What counts as done changes, with one link swapped for another and the mark on a dropped check cleared.
    await db.goal.update({ where: { id: gid }, data: { criteriaMet: { c2: '2026-10-08' } } });
    const thread = await entity('thread', { status: 'open' });
    const links = [(args.links as Array<{ entityId: string }>).find((l) => l.entityId !== svc)!, { entityId: thread, role: 'watch', watchPaths: ['status'] }];
    const changed = await fileSignRun('goal.criteria_change', { goalId: gid, title: `${CANARY} goal, sharper`, successCriteria: [(args.successCriteria as unknown[])[0], crit('c3')], links });
    expect(changed.result).toMatchObject({ goalId: gid, criteria: 2, linksAdded: 1, linksRemoved: 1, marksCleared: 1 });
    const after = await db.goal.findUniqueOrThrow({ where: { id: gid }, include: { links: true } });
    expect(after.criteriaMet).toEqual({});
    expect(after.links.map((l) => l.entityId).sort()).toEqual(links.map((l) => l.entityId).sort());

    // A shorter cadence brings the next review forward to its first slot; the horizon moves as signed.
    await db.goal.update({ where: { id: gid }, data: { nextReviewAt: new Date(Date.now() + 6 * DAY) } });
    const horizonAt = iso(Date.now() + 30 * DAY);
    const retimed = await fileSignRun('goal.horizon_change', { goalId: gid, goalTitle: `${CANARY} goal, sharper`, horizonAt, reviewCadence: 'P1D' });
    expect(retimed.result).toEqual({ goalId: gid, reviewMoved: true });
    const t = await db.goal.findUniqueOrThrow({ where: { id: gid } });
    expect(t.horizonAt?.toISOString()).toBe(horizonAt);
    expect(t.nextReviewAt!.getTime()).toBeLessThanOrEqual(Date.now() + 2 * DAY);
    expect(t.nextReviewAt!.getUTCHours()).toBe(9);
  });

  it('done and abandoned resolve the goal\'s forecasts, open and superseded, as Will: done is true by each one\'s own date', async () => {
    const forecasts = async (goalId: string) => {
      const mk = (resolveBy: Date, supersedesId?: string) =>
        db.prediction.create({
          data: {
            id: id('pd'), claim: `goal#${goalId.slice(-6)} meets its success criteria`, probability: 0.6, method: 'rule', domain: 'goals', type: 'deadline_met',
            evidence: [], resolutionCriteria: 'Synthetic resolution criteria', resolver: 'auto_world', resolveBy, createdBy: 'runtime:goals', goalId, ...(supersedesId ? { supersedesId } : {}),
          },
        });
      const old = await mk(new Date(Date.now() + 20 * DAY));
      const current = await mk(new Date(Date.now() + 30 * DAY), old.id);
      const passed = await mk(new Date(Date.now() + 1500));
      return { old: old.id, current: current.id, passed: passed.id };
    };
    const a = await newGoal();
    const b = await newGoal();
    await fileSignRun('goal.activate', a.args);
    await fileSignRun('goal.activate', b.args);
    const fa = await forecasts(a.args.goalId as string);
    const fb = await forecasts(b.args.goalId as string);
    await new Promise((r) => setTimeout(r, 1700));
    const done = await fileSignRun('goal.done', { goalId: a.args.goalId, goalTitle });
    expect(done.result).toEqual({ goalId: a.args.goalId, predictionsResolved: 3 });
    const abandoned = await fileSignRun('goal.abandon', { goalId: b.args.goalId, goalTitle });
    expect(abandoned.result).toEqual({ goalId: b.args.goalId, predictionsResolved: 3 });
    const outcome = async (pid: string) => db.resolution.findUniqueOrThrow({ where: { predictionId: pid } });
    expect([(await outcome(fa.old)).outcome, (await outcome(fa.current)).outcome, (await outcome(fa.passed)).outcome]).toEqual([true, true, false]);
    for (const pid of Object.values(fb)) expect((await outcome(pid)).outcome).toBe(false);
    const r = await outcome(fa.current);
    const approval = (await db.proposal.findUniqueOrThrow({ where: { id: done.id } })).approvalId;
    expect(r).toMatchObject({ resolvedBy: 'will', evidence: { goalId: a.args.goalId, approvalId: approval, via: 'goal.done' } });
    expect(r.brier).toBeCloseTo(0.16, 5);
    expect((await db.prediction.findUniqueOrThrow({ where: { id: fa.old } })).status).toBe('superseded');
    expect((await db.prediction.findUniqueOrThrow({ where: { id: fa.current } })).status).toBe('resolved');
    expect((await db.goal.findUniqueOrThrow({ where: { id: a.args.goalId as string } })).status).toBe('done');
    expect((await db.goal.findUniqueOrThrow({ where: { id: b.args.goalId as string } })).status).toBe('abandoned');
    await expect(file('goal.abandon', { goalId: a.args.goalId, goalTitle })).rejects.toMatchObject({ status: 409, message: 'This goal is already done.' });
  });

  it('two plan cards on different steps both apply, in either order', async () => {
    for (const order of [['a', 'b'], ['b', 'a']] as const) {
      const { args } = await newGoal();
      const gid = args.goalId as string;
      await fileSignRun('goal.activate', args);
      const cards = {
        a: await file('plan.change', { goalId: gid, goalTitle, ops: [{ op: 'set', key: 's1', from: { title: `${CANARY} step s1`, status: 'todo' }, to: { status: 'blocked' } }] }),
        b: await file('plan.change', { goalId: gid, goalTitle, ops: [{ op: 'set', key: 's2', from: { title: `${CANARY} step s2`, dueAt: null }, to: { dueAt: iso(Date.now() + 5 * DAY) } }, addOp('s3')] }),
      };
      for (const k of order) await sign(cards[k].id);
      const first = (await run(cards[order[0]].id)) as { version?: number };
      const second = (await run(cards[order[1]].id)) as { version?: number };
      expect([first.version, second.version]).toEqual([2, 3]);
      const plans = await db.plan.findMany({ where: { goalId: gid }, orderBy: { version: 'asc' }, include: { steps: true } });
      expect(plans.map((p) => p.status)).toEqual(['superseded', 'superseded', 'active']);
      const steps = Object.fromEntries(plans[2]!.steps.map((s) => [s.key, s]));
      expect(steps.s1!.status).toBe('blocked');
      expect(steps.s2!.dueAt).toBeTruthy();
      expect(steps.s3!.status).toBe('todo');
      expect(plans[2]!.createdBy).toBe('will');
    }
  });

  it('a card whose step changed since it was suggested fails with a sentence and leaves the plan as it was', async () => {
    const { args } = await newGoal();
    const gid = args.goalId as string;
    await fileSignRun('goal.activate', args);
    const from = { title: `${CANARY} step s1`, status: 'todo' };
    const flint = await file('plan.change', { goalId: gid, goalTitle, ops: [{ op: 'set', key: 's1', from, to: { status: 'in_progress' } }] }, { origin: 'runtime:goals', templateId: 'plan.diff.minor' });
    expect((await db.proposal.findUniqueOrThrow({ where: { id: flint.id } })).reason).toBe('Flint suggests this after its review.');
    await sign(flint.id);
    await fileSignRun('plan.change', { goalId: gid, goalTitle, ops: [{ op: 'set', key: 's1', from, to: { status: 'blocked' } }] });
    const versions = await db.plan.count({ where: { goalId: gid } });
    await expect(run(flint.id)).rejects.toMatchObject({ status: 409, message: 'The plan changed since Flint suggested this.' });
    expect(await db.plan.count({ where: { goalId: gid } })).toBe(versions);
    expect(await db.proposal.findUniqueOrThrow({ where: { id: flint.id } })).toMatchObject({ status: 'failed', error: 'The plan changed since Flint suggested this.' });
    // At filing, a precondition that no longer holds is refused with a sentence too.
    await expect(file('plan.change', { goalId: gid, goalTitle, ops: [{ op: 'set', key: 's1', from, to: { status: 'in_progress' } }] })).rejects.toMatchObject({ status: 409, message: SAY.planLooked });
    await expect(file('plan.change', { goalId: gid, goalTitle, ops: [addOp('s1')] })).rejects.toMatchObject({ status: 400, message: SAY.exists });
  });

  it('the change and its card commit together: a fault after the writes leaves nothing applied and the card approved', async () => {
    const { args } = await newGoal();
    const gid = args.goalId as string;
    await fileSignRun('goal.activate', args);
    const p = await file('plan.change', { goalId: gid, goalTitle, ops: [addOp('s3')] });
    await sign(p.id);
    const crash = { afterWrites: async () => { throw new Error('the process died here'); } };
    await expect(runGoal(db, p.id, undefined, 'UTC', 'test', crash)).rejects.toMatchObject({ name: 'GoalFailure', failure: 'Error' });
    expect(await db.plan.count({ where: { goalId: gid } })).toBe(1);
    expect((await db.proposal.findUniqueOrThrow({ where: { id: p.id } })).status).toBe('approved');
    expect(await db.auditEntry.count({ where: { correlationId: p.id, kind: 'intent' } })).toBe(0);
    // runInternal's branch says so with a reference, and leaves it approved to run again; it then runs.
    await expect(runGoalCard(db, p.id, undefined, 'UTC', 'test', crash)).rejects.toMatchObject({ status: 409, message: 'Flint couldn’t carry it out.' });
    // The class, then where (frames of this file), never the error's words.
    const line = said.find((l) => /^\[runtime\] err\w+ running proposal \w+ failed: Error\n/.test(l));
    expect(line).toBeTruthy();
    expect(line).toMatch(/\n {2}at .+p3-db\.test\.ts:\d+:\d+\)?/);
    expect(line).not.toContain('the process died here');
    expect((await db.proposal.findUniqueOrThrow({ where: { id: p.id } })).status).toBe('approved');
    expect(await run(p.id)).toMatchObject({ goalId: gid, version: 2 });
    expect((await db.proposal.findUniqueOrThrow({ where: { id: p.id } })).status).toBe('executed');
  });

  it('a database refusal and a validation error reach the log as class and SQLSTATE only, never the row\'s words', async () => {
    const { args } = await newGoal();
    const gid = args.goalId as string;
    await fileSignRun('goal.activate', args);
    // A step's rule refusing it: the error names the step and the rule, and holds none of its words.
    const p = await file('goal.done', { goalId: gid, goalTitle });
    await sign(p.id);
    let stepError = '';
    const longStep = {
      afterWrites: async (tx: Tx) => {
        const plan = `pl${Date.now().toString(36)}`;
        await tx.$executeRaw`INSERT INTO "Plan" (id, "goalId", version, "createdBy") VALUES (${plan}, ${gid}, 99, 'will')`;
        try {
          await tx.$executeRaw`INSERT INTO "PlanStep" (id, "planId", key, ordinal, title, kind) VALUES (${`${plan}s`}, ${plan}, 's1', 1, ${`${CANARY} `.repeat(12)}, 'will_task')`;
        } catch (err) {
          stepError = String((err as Error).message);
          throw err;
        }
      },
    };
    await expect(runGoalCard(db, p.id, undefined, 'UTC', 'test', longStep)).rejects.toMatchObject({ status: 400, message: 'The database refused this change.' });
    expect(stepError).toMatch(/step \w+: its title is not valid/);
    expect(stepError).not.toMatch(/CANARY|Failing row/);
    const failed = await db.proposal.findUniqueOrThrow({ where: { id: p.id } });
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatch(/^could not carry it out \(err\w+\)$/);
    expect((await db.goal.findUniqueOrThrow({ where: { id: gid } })).status).toBe('active');
    expect(said.some((l) => l.includes('prisma:error sqlstate 23514'))).toBe(true);
    expect(said.some((l) => /running proposal \w+ failed: PrismaClientKnownRequestError P2010 23514\n {2}at /.test(l))).toBe(true);

    // A plain CHECK still carries the refused row in its DETAIL (an entity's name here): it never reaches a log line.
    const r = await file('goal.done', { goalId: gid, goalTitle });
    await sign(r.id);
    let detail = '';
    const longName = {
      afterWrites: async (tx: Tx) => {
        try {
          await tx.$executeRaw`INSERT INTO "Entity" (id, kind, key, name, state, "stateHash", "lastObservedAt", "updatedAt") VALUES (${id('en')}, 'service', ${id('k')}, ${`${CANARY} `.repeat(20)}, '{}', ${HEX('d')}, now(), now())`;
        } catch (err) {
          detail = String((err as Error).message);
          throw err;
        }
      },
    };
    await expect(runGoalCard(db, r.id, undefined, 'UTC', 'test', longName)).rejects.toMatchObject({ status: 400 });
    // The format this guards against, confirmed: Postgres's DETAIL carries the refused row.
    expect(detail).toMatch(/Failing row contains/);
    expect(detail).toContain('CANARY');
    expect(said.some((l) => l.includes('prisma:error sqlstate 23514, constraint Entity_name_check'))).toBe(true);
    expect(said.some((l) => /running proposal \w+ failed: PrismaClientKnownRequestError P2010 23514 Entity_name_check\n {2}at /.test(l))).toBe(true);

    // A validation error prints the call's arguments in its message: it never gets out either, and the card stays approved.
    const q = await file('goal.abandon', { goalId: gid, goalTitle });
    await sign(q.id);
    const invalid = { afterWrites: async (tx: Tx) => void (await tx.goal.update({ where: { id: gid }, data: { title: { canary: `${CANARY} title` } as unknown as string } })) };
    await expect(runGoalCard(db, q.id, undefined, 'UTC', 'test', invalid)).rejects.toMatchObject({ status: 409 });
    expect(said.some((l) => /failed: PrismaClientValidationError(\n|$)/.test(l))).toBe(true);
    expect((await db.proposal.findUniqueOrThrow({ where: { id: q.id } })).status).toBe('approved');
  });

  it('a schema the code does not expect yet (a deploy out of order) leaves the card approved, to run again', async () => {
    const { args } = await newGoal();
    const gid = args.goalId as string;
    await fileSignRun('goal.activate', args);
    const p = await file('goal.done', { goalId: gid, goalTitle });
    await sign(p.id);
    for (const sql of ['SELECT 1 FROM "NoSuchTable"', 'SELECT "noSuchColumn" FROM "Goal"', 'SELECT no_such_function()']) {
      const skew = { afterWrites: async (tx: Tx) => void (await tx.$executeRawUnsafe(sql)) };
      await expect(runGoalCard(db, p.id, undefined, 'UTC', 'test', skew)).rejects.toMatchObject({ status: 409 });
      expect((await db.proposal.findUniqueOrThrow({ where: { id: p.id } })).status, sql).toBe('approved');
    }
    expect(await run(p.id)).toMatchObject({ goalId: gid });
  });

  it('a mark stays only while its check is the same check: an id reused for a new one starts unmarked', async () => {
    const { args } = await newGoal();
    const gid = args.goalId as string;
    await fileSignRun('goal.activate', args);
    const c1 = (args.successCriteria as Array<Record<string, unknown>>)[0]!;
    await db.goal.update({ where: { id: gid }, data: { criteriaMet: { c1: '2026-10-08', c2: '2026-10-08' } } });
    // c1 as it was; c2's id now holds another check.
    const changed = await fileSignRun('goal.criteria_change', { goalId: gid, title: `${CANARY} goal`, successCriteria: [c1, crit('c2')], links: args.links });
    expect(changed.result).toMatchObject({ marksCleared: 1 });
    expect((await db.goal.findUniqueOrThrow({ where: { id: gid } })).criteriaMet).toEqual({ c1: '2026-10-08' });
  });

  it('cards that did not come through filing still never run: one from chat, one whose args normalize differently', async () => {
    const { args } = await newGoal();
    const gid = args.goalId as string;
    await fileSignRun('goal.activate', args);
    /** A card written straight into the table (as a runtime that skipped filing could), with its args' true digest. */
    const raw = async (action: string, a: Record<string, unknown>, origin: string) => {
      const pid = id('pr');
      await withClient(urls.app, (c) => c.query(
        `INSERT INTO "Proposal" (id, kind, origin, action, args, "argsDigest", "argsProvenance", sensitivity, "expiresAt") VALUES ($1, 'goal', $2, $3, $4::jsonb, $5, '{}', 'personal', now() + interval '1 hour')`,
        [pid, origin, action, JSON.stringify(a), digestOf(a)],
      ));
      await sign(pid);
      return pid;
    };
    const chat = await raw('goal.done', { goalId: gid, goalTitle }, 'chat:c1');
    await expect(run(chat)).rejects.toMatchObject({ status: 409, message: SAY.fromConsole });
    expect((await db.proposal.findUniqueOrThrow({ where: { id: chat } })).status).toBe('failed');
    // A new goal's card without its description: valid, but read back it gains description '' and so a new digest.
    const { args: other } = await newGoal();
    const { description: _drop, ...bare } = other;
    const reshaped = await raw('goal.activate', bare, 'console');
    await expect(run(reshaped)).rejects.toMatchObject({ status: 409, message: SAY.reshaped });
    expect(await db.goal.count({ where: { id: other.goalId as string } })).toBe(0);
    expect((await db.goal.findUniqueOrThrow({ where: { id: gid } })).status).toBe('active');
  });

  it('filing: the same card from Will and from a review are two cards; provenance names ids; a chat suggestion without a quote is a 400', async () => {
    const { args } = await newGoal();
    const gid = args.goalId as string;
    await fileSignRun('goal.activate', args);
    const ops = [{ op: 'set', key: 's1', from: { title: `${CANARY} step s1`, status: 'todo' }, to: { status: 'blocked' } }];
    const will = await file('plan.change', { goalId: gid, goalTitle, ops });
    const again = await file('plan.change', { goalId: gid, goalTitle, ops });
    const flint = await file('plan.change', { goalId: gid, goalTitle, ops }, { origin: 'runtime:goals', templateId: 'plan.diff.minor' });
    expect(again).toMatchObject({ id: will.id, deduped: true });
    expect(flint.id).not.toBe(will.id);
    expect((await db.proposal.findUniqueOrThrow({ where: { id: flint.id } })).reason).toBe('Flint suggests this after its review.');
    await expect(file('goal.done', { goalId: gid, goalTitle }, { argsProvenance: { goalTitle: { source: 'will', ref: `${CANARY} said so`, tainted: false } } })).rejects.toMatchObject({ status: 400, message: SAY.provenance });
    expect(await file('goal.done', { goalId: gid, goalTitle }, { argsProvenance: { goalTitle: { source: 'will', ref: `goal:${gid}`, tainted: false } } })).toMatchObject({ deduped: false });
    await expect(file('goal.propose', { goalId: id('go'), title: 'Synthetic', quote: 'too short' }, { kind: 'goal' })).rejects.toMatchObject({ status: 400, message: 'A suggestion from chat needs your own words, quoted.' });
  });

  it('nothing P3 keeps for good carries a goal\'s words: reasons, errors, results, audit entries, history', async () => {
    const leaks = await owner(`
      SELECT 'proposal' AS t, count(*)::int AS n FROM "Proposal" WHERE coalesce(reason, '') LIKE '%CANARY%' OR coalesce(error, '') LIKE '%CANARY%' OR coalesce(result::text, '') LIKE '%CANARY%'
      UNION ALL SELECT 'audit', count(*)::int FROM "AuditEntry" WHERE inputs::text LIKE '%CANARY%' OR coalesce(reasoning, '') LIKE '%CANARY%' OR coalesce("outcomeDetail"::text, '') LIKE '%CANARY%'
      UNION ALL SELECT 'history', count(*)::int FROM "RowChange" WHERE coalesce(changed::text, '') LIKE '%CANARY%'
      UNION ALL SELECT 'resolution', count(*)::int FROM "Resolution" WHERE coalesce(evidence::text, '') LIKE '%CANARY%'
      UNION ALL SELECT 'jobs', count(*)::int FROM pgboss.job WHERE coalesce(data::text, '') LIKE '%CANARY%'`);
    expect(leaks.rows).toEqual([
      { t: 'proposal', n: 0 }, { t: 'audit', n: 0 }, { t: 'history', n: 0 }, { t: 'resolution', n: 0 }, { t: 'jobs', n: 0 },
    ]);
    // ...while the goals themselves, and their cards' args (until retention), do hold them.
    expect((await owner(`SELECT count(*)::int AS n FROM "Goal" WHERE title LIKE '%CANARY%'`)).rows[0].n).toBeGreaterThan(0);
    expect((await owner(`SELECT count(*)::int AS n FROM "RowChange" WHERE "tableName" = 'Goal'`)).rows[0].n).toBeGreaterThan(0);
  });
});
