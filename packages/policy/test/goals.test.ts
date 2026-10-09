/**
 * P3's goal contracts: strict, bounded and normalized (what is signed is what
 * the database compares), plan operations that compose and carry their
 * preconditions, fixed reasons, and the review calendar across DST.
 */
import { describe, it, expect } from 'vitest';
import {
  CHECK_PATHS,
  GOAL_ARGS,
  GOAL_KIND,
  GOAL_REASONS,
  GOAL_SIGNED_ACTIONS,
  GoalActivateArgs,
  GoalCriteriaChangeArgs,
  GoalDoneArgs,
  GoalHorizonChangeArgs,
  PlanChangeArgs,
  PlanOps,
  checkFits,
  composePlan,
  isGoalSignedAction,
  jsonbSize,
  type PlanOp,
  type PlanStepState,
} from '../src/goals';
import { addLocalDays, addLocalMonths, localWallTime, nextReviewAt } from '../src/zone';

// Synthetic text only: nothing here is anyone's real goal.
const crit = (id: string, check: Record<string, unknown> = { kind: 'manual' }) => ({ id, text: `Synthetic check ${id}`, check });
const activate = (over: Record<string, unknown> = {}) => ({ goalId: 'gotest0001', title: 'Synthetic goal', successCriteria: [crit('c1')], ...over });
const issues = (r: { success: boolean; error?: { issues: Array<{ path: (string | number)[]; message: string }> } }) =>
  (r.error?.issues ?? []).map((i) => `${i.path.join('.')}: ${i.message}`);
const step = (key: string, over: Partial<PlanStepState> = {}): PlanStepState => ({
  key, ordinal: 100, title: `Synthetic step ${key}`, kind: 'will_task', tier: 'approval', status: 'todo', dueAt: null, dependsOn: [],
  doneAt: null, doneAuditId: null, proposalId: null, taskId: null, ...over,
});

describe('goal args', () => {
  it('fills in the defaults, sorts lists and links, so what is signed is what is stored', () => {
    const a = GoalActivateArgs.parse(activate({
      links: [
        { entityId: 'enb', role: 'watch', watchPaths: ['state', 'status', 'state'] },
        { entityId: 'ena', role: 'target', watchPaths: [] },
      ],
      successCriteria: [crit('c1', { kind: 'item', entityId: 'ena', key: 'state', value: 'merged' })],
    }));
    expect(a).toMatchObject({ description: '', horizonAt: null, reviewCadence: 'P1W', plan: null });
    // What the goal is, signed with it: Will's own, personal, untainted, no Nexus project, unless the card says so.
    expect(a).toMatchObject({ owner: 'will', origin: 'will', sensitivity: 'personal', tainted: false, nexusProjectId: null });
    expect(GoalActivateArgs.safeParse(activate({ sensitivity: 'ops' })).success).toBe(false);
    expect(GoalActivateArgs.safeParse(activate({ nexusProjectId: 'has space' })).success).toBe(false);
    expect(GoalActivateArgs.parse(activate({ sensitivity: 'financial', owner: 'flint' }))).toMatchObject({ sensitivity: 'financial', owner: 'flint' });
    expect(a.links.map((l: { entityId: string }) => l.entityId)).toEqual(['ena', 'enb']);
    expect(a.links[1]!.watchPaths).toEqual(['state', 'status']);
  });

  it('is strict and bounded: unknown keys, a title over 120, 0 or 11 checks, a bad cadence, a sub-millisecond time', () => {
    expect(GoalActivateArgs.safeParse(activate({ extra: 1 })).success).toBe(false);
    expect(GoalActivateArgs.safeParse(activate({ title: 'x'.repeat(121) })).success).toBe(false);
    expect(GoalActivateArgs.safeParse(activate({ title: '   ' })).success).toBe(false);
    expect(GoalActivateArgs.safeParse(activate({ title: 'x'.repeat(120) })).success).toBe(true);
    expect(GoalActivateArgs.safeParse(activate({ successCriteria: [] })).success).toBe(false);
    expect(GoalActivateArgs.safeParse(activate({ successCriteria: Array.from({ length: 11 }, (_, i) => crit(`c${(i % 10) + 1}`)) })).success).toBe(false);
    expect(GoalActivateArgs.safeParse(activate({ successCriteria: [crit('c1'), crit('c1')] })).success).toBe(false);
    expect(GoalActivateArgs.safeParse(activate({ successCriteria: [crit('c11')] })).success).toBe(false);
    expect(GoalActivateArgs.safeParse(activate({ reviewCadence: 'P2D' })).success).toBe(false);
    expect(GoalActivateArgs.safeParse(activate({ horizonAt: '2026-12-01T00:00:00Z' })).success).toBe(false);
    expect(GoalActivateArgs.safeParse(activate({ horizonAt: '2026-12-01T00:00:00.000Z' })).success).toBe(true);
    expect(GoalActivateArgs.safeParse(activate({ horizonAt: '2026-02-30T00:00:00.000Z' })).success).toBe(false);
    expect(GoalActivateArgs.safeParse(activate({ goalId: 'not-a-goal' })).success).toBe(false);
    expect(GoalActivateArgs.safeParse(activate({ description: 'x'.repeat(1001) })).success).toBe(false);
  });

  it('checks: manual, steps, or one structural field of an item from CHECK_PATHS, whose item is linked', () => {
    const item = (key: string, value: string) => activate({ successCriteria: [crit('c1', { kind: 'item', entityId: 'en1', key, value })], links: [{ entityId: 'en1', role: 'target', watchPaths: [key] }] });
    expect(GoalActivateArgs.safeParse(item('state', 'merged')).success).toBe(true);
    expect(GoalActivateArgs.safeParse(item('conclusion', 'success')).success).toBe(true);
    expect(GoalActivateArgs.safeParse(item('title', 'Ship it')).success).toBe(false);
    expect(GoalActivateArgs.safeParse(item('state', 'shipped')).success).toBe(false);
    const unlinked = activate({ successCriteria: [crit('c1', { kind: 'item', entityId: 'en1', key: 'state', value: 'merged' })] });
    expect(issues(GoalActivateArgs.safeParse(unlinked))).toEqual(['successCriteria.0.check.entityId: an item check needs its item linked']);
    expect(GoalActivateArgs.safeParse(activate({ successCriteria: [crit('c1', { kind: 'manual', note: 'x' })] })).success).toBe(false);
    expect(checkFits('pull_request', 'state', 'merged')).toBe(true);
    expect(checkFits('issue', 'state', 'merged')).toBe(false);
    expect(checkFits('person', 'email', 'x')).toBe(false);
    expect(Object.keys(CHECK_PATHS).sort()).toEqual(['ci_run', 'deployment', 'issue', 'project', 'pull_request', 'service', 'thread']);
  });

  it('links: at most 20, one per item, and a name or title is never watched', () => {
    const links = (n: number) => Array.from({ length: n }, (_, i) => ({ entityId: `en${i}`, role: 'watch', watchPaths: [] }));
    expect(GoalActivateArgs.safeParse(activate({ links: links(20) })).success).toBe(true);
    expect(GoalActivateArgs.safeParse(activate({ links: links(21) })).success).toBe(false);
    expect(GoalActivateArgs.safeParse(activate({ links: [...links(1), ...links(1)] })).success).toBe(false);
    for (const p of ['name', 'title', '1state', 'state.health']) {
      expect(GoalActivateArgs.safeParse(activate({ links: [{ entityId: 'en1', role: 'watch', watchPaths: [p] }] })).success, p).toBe(false);
    }
    expect(GoalActivateArgs.safeParse(activate({ links: [{ entityId: 'en1', role: 'owner', watchPaths: [] }] })).success).toBe(false);
  });

  it('a first plan only adds steps, and a steps check names one of them', () => {
    const add = (key: string, over: Record<string, unknown> = {}) => ({ op: 'add', key, step: { ordinal: 100, title: `Synthetic step ${key}`, kind: 'will_task', ...over } });
    const ok = GoalActivateArgs.parse(activate({ plan: { ops: [add('s1'), add('s2', { dependsOn: ['s1'] })] }, successCriteria: [crit('c1', { kind: 'steps', keys: ['s2', 's1'] })] }));
    expect(ok.plan?.ops[0]).toMatchObject({ step: { ordinal: 100, title: 'Synthetic step s1', kind: 'will_task', tier: 'approval', dueAt: null, dependsOn: [] } });
    expect(ok.successCriteria[0]!.check).toEqual({ kind: 'steps', keys: ['s1', 's2'] });
    expect(GoalActivateArgs.safeParse(activate({ plan: { ops: [add('s1')] }, successCriteria: [crit('c1', { kind: 'steps', keys: ['s9'] })] })).success).toBe(false);
    const set = { op: 'set', key: 's1', from: { title: 'Synthetic step s1', status: 'todo' }, to: { status: 'blocked' } };
    expect(issues(GoalActivateArgs.safeParse(activate({ plan: { ops: [set] } })))).toContain('plan.ops.0.op: a first plan only adds steps');
    expect(GoalActivateArgs.safeParse(activate({ plan: { ops: [add('s1', { dependsOn: ['s2'] }), add('s2', { dependsOn: ['s1'] })] } })).success).toBe(false);
    expect(GoalActivateArgs.safeParse(activate({ plan: { ops: [add('s1', { dependsOn: ['s7'] })] } })).success).toBe(false);
  });

  it('the other cards: exact fields, a title for display, and every args object under 64 KB', () => {
    expect(GoalCriteriaChangeArgs.safeParse({ goalId: 'gotest0001', title: 'T', successCriteria: [crit('c1')] }).success).toBe(false); // links are required
    expect(GoalCriteriaChangeArgs.parse({ goalId: 'gotest0001', title: 'T', successCriteria: [crit('c1')], links: [] })).toMatchObject({ description: '' });
    expect(GoalHorizonChangeArgs.safeParse({ goalId: 'gotest0001', goalTitle: 'T', horizonAt: null, reviewCadence: 'P1M' }).success).toBe(true);
    expect(GoalHorizonChangeArgs.safeParse({ goalId: 'gotest0001', goalTitle: 'T', reviewCadence: 'P1M' }).success).toBe(false);
    expect(GoalDoneArgs.safeParse({ goalId: 'gotest0001', goalTitle: 'T', note: 'x' }).success).toBe(false);
    const big = activate({ description: 'x'.repeat(1000), successCriteria: Array.from({ length: 10 }, (_, i) => crit(`c${i + 1}`)) });
    expect(jsonbSize(big)).toBeLessThan(65536);
    expect(jsonbSize({ a: [1, 'b'] })).toBe(JSON.stringify({ a: [1, 'b'] }).length + 2);
    for (const a of GOAL_SIGNED_ACTIONS) {
      expect(GOAL_ARGS[a], a).toBeDefined();
      expect(GOAL_KIND[a]).toBe(a === 'plan.change' ? 'plan' : 'goal');
      expect(isGoalSignedAction(a)).toBe(true);
    }
    expect(isGoalSignedAction('goal.propose')).toBe(false);
  });

  it('reasons are fixed sentences, with no room for a goal\'s words', () => {
    for (const r of Object.values(GOAL_REASONS)) expect(r).toMatch(/^[A-Z][^{}<>]*\.$/);
    expect(GOAL_REASONS.start).toBe('Approving starts this goal.');
    expect(GOAL_REASONS.planFlint).toBe('Flint suggests this after its review.');
  });
});

describe('plan operations', () => {
  const ops = (x: unknown[]) => PlanOps.safeParse(x);
  it('at most 20, one per step, never done, each set naming what it changes from and changing something', () => {
    const set = (over: Record<string, unknown>) => ({ op: 'set', key: 's1', from: { title: 'Synthetic step s1', status: 'todo' }, to: { status: 'blocked' }, ...over });
    expect(ops([set({})]).success).toBe(true);
    expect(ops([set({}), set({})]).success).toBe(false);
    expect(ops(Array.from({ length: 21 }, (_, i) => set({ key: `s${i}` }))).success).toBe(false);
    expect(ops([set({ to: { status: 'done' } })]).success).toBe(false);
    expect(issues(ops([set({ to: { status: 'todo' } })]))).toEqual(['0.to.status: changes nothing']);
    expect(issues(ops([set({ to: {} })]))).toEqual(['0.to: changes nothing']);
    expect(issues(ops([set({ from: { status: 'todo' } })]))).toEqual(['0.from.title: names the step as it is']);
    expect(issues(ops([set({ to: { ordinal: 300 } })]))).toEqual(['0.from.ordinal: says what it changes from']);
    expect(ops([set({ to: { kind: 'flint_action' }, from: { title: 'x', kind: 'will_task' } })]).success).toBe(false);
    expect(ops([set({ to: { dependsOn: ['s1'] }, from: { title: 'x', dependsOn: [] } })]).success).toBe(false);
    expect(ops([{ op: 'move', key: 's1' }]).success).toBe(false);
    // Sub-millisecond due times are refused; a millisecond one is fine.
    expect(ops([set({ from: { title: 'x', dueAt: null }, to: { dueAt: '2026-10-20T22:00:00.000Z' } })]).success).toBe(true);
    expect(ops([set({ from: { title: 'x', dueAt: null }, to: { dueAt: '2026-10-20T22:00:00.0001Z' } })]).success).toBe(false);
  });

  it('compose: every previous step survives, adds start todo, a set applies only where its precondition holds', () => {
    const prev = [step('s1', { ordinal: 100 }), step('s2', { ordinal: 200, status: 'done', doneAt: '2026-10-01T12:00:00.000Z' })];
    // A `to` names only what `from` names.
    expect(PlanOps.safeParse([{ op: 'set', key: 's1', from: { title: 'x', status: 'todo' }, to: { status: 'in_progress', dueAt: null } }]).success).toBe(false);
    const ops2 = PlanOps.parse([
      { op: 'set', key: 's1', from: { title: 'Synthetic step s1', status: 'todo', dueAt: null }, to: { status: 'in_progress', dueAt: '2026-10-20T22:00:00.000Z' } },
      { op: 'add', key: 's3', step: { ordinal: 150, title: 'Synthetic step s3', kind: 'wait', dependsOn: ['s1'] } },
    ]);
    const c = composePlan(prev, ops2);
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.steps.map((s) => [s.key, s.status])).toEqual([['s1', 'in_progress'], ['s3', 'todo'], ['s2', 'done']]);
    expect(c.steps.find((s) => s.key === 's2')).toEqual(prev[1]);
    expect(c.steps.find((s) => s.key === 's1')!.dueAt).toBe('2026-10-20T22:00:00.000Z');
  });

  it('a done step stays done: no set may change its status, in the contract or in composition', () => {
    const reopen = { op: 'set', key: 's1', from: { title: 'Synthetic step s1', status: 'done' }, to: { status: 'todo' } };
    expect(issues(PlanOps.safeParse([reopen]))).toEqual(['0.to.status: a done step stays done']);
    expect(issues(PlanOps.safeParse([{ ...reopen, to: { status: 'skipped' } }]))).toEqual(['0.to.status: a done step stays done']);
    // Its other fields may still change.
    expect(PlanOps.safeParse([{ op: 'set', key: 's1', from: { title: 'Synthetic step s1', status: 'done' }, to: { title: 'Renamed' } }]).success).toBe(true);
    // A card made while the step was open, run after it was done, is stale (its `from` says todo).
    const prev = [step('s1', { status: 'done', doneAt: '2026-10-01T12:00:00.000Z' })];
    const later = PlanOps.parse([{ op: 'set', key: 's1', from: { title: 'Synthetic step s1', status: 'todo' }, to: { status: 'blocked' } }]);
    expect(composePlan(prev, later)).toEqual({ ok: false, why: 'stale', key: 's1' });
    const rename = PlanOps.parse([{ op: 'set', key: 's1', from: { title: 'Synthetic step s1' }, to: { title: 'Synthetic step s1, renamed' } }]);
    expect(composePlan(prev, rename).ok).toBe(true);
    // And composition refuses it on its own, for operations that never went through the contract.
    for (const status of ['todo', 'skipped', 'blocked'] as const) {
      const raw = [{ op: 'set', key: 's1', from: { title: 'Synthetic step s1' }, to: { status } }] as unknown as PlanOp[];
      expect(composePlan(prev, raw)).toEqual({ ok: false, why: 'done', key: 's1' });
    }
  });

  it('compose refuses: a changed step (stale), a taken key, a missing step, a missing dependency, a circle', () => {
    const prev = [step('s1'), step('s2', { dependsOn: ['s1'] })];
    const set = (key: string, from: Record<string, unknown>, to: Record<string, unknown>) => PlanOps.parse([{ op: 'set', key, from: { title: `Synthetic step ${key}`, ...from }, to }]);
    expect(composePlan(prev, set('s1', { status: 'blocked' }, { status: 'todo' }))).toEqual({ ok: false, why: 'stale', key: 's1' });
    expect(composePlan(prev, PlanOps.parse([{ op: 'set', key: 's1', from: { title: 'Another title' }, to: { title: 'New' } }]))).toEqual({ ok: false, why: 'stale', key: 's1' });
    expect(composePlan(prev, PlanOps.parse([{ op: 'add', key: 's2', step: { ordinal: 1, title: 'x', kind: 'wait' } }]))).toEqual({ ok: false, why: 'exists', key: 's2' });
    expect(composePlan(prev, set('s9', {}, { title: 'x' }))).toEqual({ ok: false, why: 'missing', key: 's9' });
    expect(composePlan(prev, set('s1', { dependsOn: [] }, { dependsOn: ['s7'] }))).toEqual({ ok: false, why: 'depends', key: 's1' });
    expect(composePlan(prev, set('s1', { dependsOn: [] }, { dependsOn: ['s2'] }))).toEqual({ ok: false, why: 'circle' });
  });

  it('two cards on different steps compose in either order; a precondition on a dependency list ignores its order', () => {
    const prev = [step('s1'), step('s2'), step('s3', { dependsOn: ['s2', 's1'] })];
    const a = PlanOps.parse([{ op: 'set', key: 's1', from: { title: 'Synthetic step s1', status: 'todo' }, to: { status: 'blocked' } }]);
    const b = PlanOps.parse([{ op: 'set', key: 's3', from: { title: 'Synthetic step s3', dependsOn: ['s1', 's2'] }, to: { dependsOn: ['s2'] } }]);
    const ab = composePlan((composePlan(prev, a) as { steps: PlanStepState[] }).steps, b);
    const ba = composePlan((composePlan(prev, b) as { steps: PlanStepState[] }).steps, a);
    expect(ab).toEqual(ba);
    expect(ab.ok).toBe(true);
  });

  it('plan.change args: the goal, its title for the card, and the operations', () => {
    expect(PlanChangeArgs.safeParse({ goalId: 'gotest0001', goalTitle: 'T', ops: [] }).success).toBe(false);
    expect(PlanChangeArgs.safeParse({ goalId: 'gotest0001', goalTitle: 'T', ops: [{ op: 'add', key: 's1', step: { ordinal: 1, title: 'x', kind: 'will_task' } }] }).success).toBe(true);
    expect(PlanChangeArgs.safeParse({ goalId: 'gotest0001', goalTitle: 'T', planId: 'pl1', ops: [{ op: 'add', key: 's1', step: { ordinal: 1, title: 'x', kind: 'will_task' } }] }).success).toBe(false);
  });
});

describe('the review calendar', () => {
  const tz = 'America/Chicago';
  it('a wall time a spring-forward skips lands past the gap, not before it', () => {
    // Clocks jump 02:00 -> 03:00 CDT on Sun Mar 8 2026: 02:30 lands at 03:30 CDT (08:30Z), not 01:30 CST.
    expect(localWallTime(tz, '2026-03-08', 2, 30).toISOString()).toBe('2026-03-08T08:30:00.000Z');
    expect(localWallTime(tz, '2026-03-08', 3, 0).toISOString()).toBe('2026-03-08T08:00:00.000Z');
    expect(localWallTime(tz, '2026-03-08', 1, 59).toISOString()).toBe('2026-03-08T07:59:00.000Z');
    // A repeated time (fall back, Nov 1) lands on one of its two instants.
    expect(['2026-11-01T06:30:00.000Z', '2026-11-01T07:30:00.000Z']).toContain(localWallTime(tz, '2026-11-01', 1, 30).toISOString());
  });

  it('steps local calendar dates and lands at 09:00 local, the same weekday across DST', () => {
    // Fri Oct 30 2026 (CDT, UTC-5); the clocks fall back on Sun Nov 1.
    const due = localWallTime(tz, '2026-10-30', 9, 0);
    expect(due.toISOString()).toBe('2026-10-30T14:00:00.000Z');
    const next = nextReviewAt('P1W', tz, due, due);
    expect(next.toISOString()).toBe('2026-11-06T15:00:00.000Z'); // 09:00 CST
    expect(nextReviewAt('P1D', tz, due, due).toISOString()).toBe('2026-10-31T14:00:00.000Z');
    // Spring forward (Sun Mar 8 2026): still 09:00 local.
    expect(nextReviewAt('P1D', tz, localWallTime(tz, '2026-03-07', 9, 0), localWallTime(tz, '2026-03-07', 9, 0)).toISOString()).toBe('2026-03-08T14:00:00.000Z');
  });

  it('a late run steps on until it is after now, without piling up; months keep their day, clamped', () => {
    const due = localWallTime(tz, '2026-01-05', 9, 0);
    const now = localWallTime(tz, '2026-03-20', 12, 0);
    expect(nextReviewAt('P1W', tz, due, now).toISOString()).toBe(localWallTime(tz, '2026-03-23', 9, 0).toISOString());
    expect(nextReviewAt('P2W', tz, due, now).toISOString()).toBe(localWallTime(tz, '2026-03-30', 9, 0).toISOString());
    const jan31 = localWallTime(tz, '2026-01-31', 9, 0);
    expect(nextReviewAt('P1M', tz, jan31, jan31).toISOString()).toBe(localWallTime(tz, '2026-02-28', 9, 0).toISOString());
    expect(nextReviewAt('P1M', tz, jan31, localWallTime(tz, '2026-03-01', 9, 0)).toISOString()).toBe(localWallTime(tz, '2026-03-31', 9, 0).toISOString());
    expect(addLocalMonths('2028-01-31', 1, 31)).toBe('2028-02-29');
    expect(addLocalMonths('2026-12-15', 1, 15)).toBe('2027-01-15');
    expect(addLocalDays('2026-12-31', 1)).toBe('2027-01-01');
    // A chain of monthly reviews keeps the goal's own day, clamped month by month: never drifting to the 28th.
    let at = jan31;
    const chain: string[] = [];
    for (let i = 0; i < 5; i++) {
      at = nextReviewAt('P1M', tz, at, at, 31);
      chain.push(at.toISOString().slice(0, 10));
    }
    expect(chain).toEqual(['2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30']);
    // Without an anchor, the due day's own (the drift the anchor prevents).
    expect(nextReviewAt('P1M', tz, localWallTime(tz, '2026-02-28', 9, 0), localWallTime(tz, '2026-02-28', 9, 0)).toISOString().slice(0, 10)).toBe('2026-03-28');
    // A due time in the future: one step after it.
    expect(nextReviewAt('P3D', tz, localWallTime(tz, '2026-05-01', 9, 0), localWallTime(tz, '2026-04-01', 9, 0)).toISOString()).toBe(localWallTime(tz, '2026-05-04', 9, 0).toISOString());
  });
});
