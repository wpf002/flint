/**
 * P3's goal contracts: strict, bounded and normalized (what is signed is what
 * the database compares), plan operations that compose and carry their
 * preconditions, fixed reasons, and the review calendar across DST.
 */
import { describe, it, expect } from 'vitest';
import {
  CHECK_PATHS,
  GOAL_ARGS,
  GOAL_CARD_BODIES,
  GOAL_CARD_VERBS,
  GOAL_CONDITIONS,
  GOAL_SAYS,
  GOAL_STATUSES,
  GOAL_STATUS_SAYS,
  GoalId,
  GoalsPage,
  GoalView,
  GOAL_BUDGETS,
  GOAL_PLAIN_VERBS,
  LIKELIHOODS,
  PLAN_CARDS_COUNTER,
  PLAN_STAGES,
  REVIEW_DOWN_MS,
  REVIEW_KINDS,
  REVIEW_LATE_MS,
  ReviewChange,
  ReviewView,
  likelihoodOf,
  reviewCounter,
  Linkable,
  LinkableBody,
  MarkBody,
  NewGoalBody,
  StepBody,
  goalCodeOf,
  goalIdOf,
  goalSayOf,
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
  classifyPlanOp,
  MINOR_DUE_SHIFT_MS,
  isGoalSignedAction,
  jsonbSize,
  type PlanOp,
  type PlanStepState,
} from '../src/goals';
import { addLocalDays, addLocalMonths, localWallTime, nextReviewAt } from '../src/zone';
import { noteProblems } from '../src/notes';

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
    // A change says what it changes from (its precondition, signed with it): what the goal was.
    const was = { title: 'Was', description: '', successCriteria: [crit('c1')], links: [] };
    const timingWas = { horizonAt: null, reviewCadence: 'P1W' };
    expect(GoalCriteriaChangeArgs.safeParse({ goalId: 'gotest0001', title: 'T', successCriteria: [crit('c1')], from: was }).success).toBe(false); // links are required
    expect(GoalCriteriaChangeArgs.parse({ goalId: 'gotest0001', title: 'T', successCriteria: [crit('c1')], links: [], from: was })).toMatchObject({ description: '' });
    expect(GoalCriteriaChangeArgs.safeParse({ goalId: 'gotest0001', title: 'T', successCriteria: [crit('c1')], links: [] }).success).toBe(false); // so is what it changes from
    expect(GoalHorizonChangeArgs.safeParse({ goalId: 'gotest0001', goalTitle: 'T', horizonAt: null, reviewCadence: 'P1M', from: timingWas }).success).toBe(true);
    expect(GoalHorizonChangeArgs.safeParse({ goalId: 'gotest0001', goalTitle: 'T', horizonAt: null, reviewCadence: 'P1M' }).success).toBe(false);
    expect(GoalHorizonChangeArgs.safeParse({ goalId: 'gotest0001', goalTitle: 'T', reviewCadence: 'P1M', from: timingWas }).success).toBe(false);
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

  it('a plan operation is a small change or a bigger one by rule, from the operation and the step as it stands', () => {
    const DAY = 86_400_000;
    const due = new Date(Date.parse('2026-10-12T14:02:00.000Z') + 3 * DAY).toISOString();
    const at = (days: number) => new Date(Date.parse(due) + days * DAY).toISOString();
    const horizon = at(30);
    const step = { kind: 'will_task' as const, status: 'todo' as const, dueAt: due };
    const one = (o: unknown) => PlanOps.parse([o])[0]!;
    const set = (to: Record<string, unknown>, was = 'todo') => one({ op: 'set', key: 's1', from: { title: 'T', ...Object.fromEntries(Object.keys(to).map((k) => [k, k === 'dueAt' ? due : k === 'status' ? was : k === 'ordinal' ? 100 : k === 'title' ? 'T' : []])) }, to });
    expect(MINOR_DUE_SHIFT_MS).toBe(7 * DAY);
    // Small: a status among todo, in progress and blocked; a date moved by at most 7 days, not past the finish date; a place.
    for (const to of [{ status: 'in_progress' }, { status: 'blocked' }, { dueAt: at(7) }, { dueAt: at(-7) }, { ordinal: 50 }, { status: 'blocked', dueAt: at(2), ordinal: 50 }]) {
      expect(classifyPlanOp(set(to), step, horizon), JSON.stringify(to)).toBe('minor');
    }
    // Bigger: everything else.
    for (const to of [{ status: 'skipped' }, { dueAt: at(8) }, { dueAt: at(-8) }, { dueAt: null }, { title: 'New words' }, { dependsOn: ['s2'] }, { status: 'blocked', dueAt: at(8) }]) {
      expect(classifyPlanOp(set(to), step, horizon), JSON.stringify(to)).toBe('material');
    }
    expect(classifyPlanOp(set({ dueAt: at(5) }), step, at(4))).toBe('material');
    expect(classifyPlanOp(set({ dueAt: at(5) }), step, null)).toBe('minor');
    expect(classifyPlanOp(set({ dueAt: at(2) }), { ...step, dueAt: null }, horizon)).toBe('material');
    expect(classifyPlanOp(set({ status: 'todo' }, 'skipped'), { ...step, status: 'skipped' }, horizon)).toBe('material');
    expect(classifyPlanOp(set({ status: 'blocked' }), { ...step, kind: 'decision' }, horizon)).toBe('material');
    expect(classifyPlanOp(set({ ordinal: 50 }), { ...step, kind: 'flint_action' }, horizon)).toBe('material');
    expect(classifyPlanOp(set({ status: 'blocked' }), undefined, horizon)).toBe('material');
    expect(classifyPlanOp(one({ op: 'add', key: 's9', step: { ordinal: 900, title: 'T', kind: 'will_task' } }), undefined, horizon)).toBe('material');
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

describe('the goals panel’s wire (P3 part 2)', () => {
  const dk = 'k7Hq2LmN9pQr3sTv';
  const body = (over: Record<string, unknown> = {}) => ({ draftKey: dk, args: activate({ goalId: `go${dk}`, ...over }) });

  it('a refusal is a fixed sentence with a code, and only a code in the closed set has one', () => {
    for (const [code, say] of Object.entries(GOAL_SAYS)) {
      expect(say, code).toMatch(/^[A-Z][^{}<>$]*\.$/);
      expect(goalSayOf(code)).toBe(say);
      expect(goalCodeOf(say)).toBe(code);
    }
    for (const s of GOAL_STATUSES) {
      expect(goalCodeOf(GOAL_STATUS_SAYS[s])).toBe(`status.${s}`);
      expect(goalSayOf(`status.${s}`)).toBe(GOAL_STATUS_SAYS[s]);
    }
    for (const bad of ['toString', '__proto__', 'status.toString', 'status.', 'forbidden: goal.done', 42, null]) expect(goalSayOf(bad), String(bad)).toBeUndefined();
    expect(goalCodeOf('Some runtime words.')).toBeUndefined();
  });

  it('a new goal is Will’s own and its id is made from the form’s draft key', () => {
    expect(NewGoalBody.safeParse(body()).success).toBe(true);
    expect(goalIdOf(dk)).toBe(`go${dk}`);
    expect(GoalId.safeParse(goalIdOf('a'.repeat(32))).success).toBe(true);
    for (const over of [{ goalId: 'goSomethingElse1' }, { origin: 'flint' }, { owner: 'flint' }, { tainted: true }, { nexusProjectId: 'p1' }, { sensitivity: 'ops' }]) {
      expect(NewGoalBody.safeParse(body(over)).success, JSON.stringify(over)).toBe(false);
    }
    expect(NewGoalBody.safeParse({ ...body(), extra: 1 }).success).toBe(false);
    expect(NewGoalBody.safeParse({ draftKey: 'short', args: activate({ goalId: 'goshort' }) }).success).toBe(false);
    expect(NewGoalBody.safeParse(body({ sensitivity: 'financial' })).success).toBe(true);
  });

  it('each card route takes that card’s args; resuming brings no plan; the plain writes are strict', () => {
    // Each signed action has its route; goal.activate has two (resume, and start: a suggestion made a goal, part 5).
    expect([...new Set(Object.values(GOAL_CARD_VERBS))].sort()).toEqual([...GOAL_SIGNED_ACTIONS].sort());
    expect(Object.keys(GOAL_CARD_VERBS).sort()).toEqual(['abandon', 'done', 'edit', 'plan', 'resume', 'start', 'timing']);
    expect(Object.keys(GOAL_CARD_BODIES).sort()).toEqual(Object.keys(GOAL_CARD_VERBS).sort());
    // Start: one Flint suggested, as Will's own goal: it may bring a first plan, and is never his own new goal's route.
    const suggested = { origin: 'flint' };
    expect(GOAL_CARD_BODIES.start.safeParse({ args: activate(suggested) }).success).toBe(true);
    expect(GOAL_CARD_BODIES.start.safeParse({ args: activate({ ...suggested, plan: { ops: [{ op: 'add', key: 's1', step: { ordinal: 1, title: 'S', kind: 'will_task' } }] }, successCriteria: [crit('c1', { kind: 'steps', keys: ['s1'] })] }) }).success).toBe(true);
    for (const over of [{}, { origin: 'flint', owner: 'flint' }, { origin: 'flint', tainted: true }, { origin: 'flint', sensitivity: 'financial' }, { origin: 'flint', nexusProjectId: 'p1' }]) {
      expect(GOAL_CARD_BODIES.start.safeParse({ args: activate(over) }).success, JSON.stringify(over)).toBe(false);
    }
    expect(GOAL_CARD_BODIES.start.safeParse({ args: activate(suggested), x: 1 }).success).toBe(false);
    expect(GOAL_CARD_BODIES.done.safeParse({ args: { goalId: 'gotest0001', goalTitle: 'T' } }).success).toBe(true);
    expect(GOAL_CARD_BODIES.done.safeParse({ args: { goalId: 'gotest0001', goalTitle: 'T' }, x: 1 }).success).toBe(false);
    expect(GOAL_CARD_BODIES.resume.safeParse({ args: activate() }).success).toBe(true);
    expect(GOAL_CARD_BODIES.resume.safeParse({ args: activate({ plan: { ops: [{ op: 'add', key: 's1', step: { ordinal: 1, title: 'S', kind: 'will_task' } }] }, successCriteria: [crit('c1', { kind: 'steps', keys: ['s1'] })] }) }).success).toBe(false);
    // A change to what counts as done, or to the timing, says what it changes from (the card's precondition, signed with it).
    const def = { title: 'T', description: '', successCriteria: [crit('c1')], links: [] };
    const edit = { goalId: 'gotest0001', ...def, title: 'T2' };
    expect(GOAL_CARD_BODIES.edit.safeParse({ args: edit }).success).toBe(false);
    expect(GOAL_CARD_BODIES.edit.safeParse({ args: { ...edit, from: def } }).success).toBe(true);
    expect(GOAL_CARD_BODIES.edit.safeParse({ args: { ...edit, from: { ...def, extra: 1 } } }).success).toBe(false);
    const timing = { goalId: 'gotest0001', goalTitle: 'T', horizonAt: null, reviewCadence: 'P2W' };
    expect(GOAL_CARD_BODIES.timing.safeParse({ args: timing }).success).toBe(false);
    expect(GOAL_CARD_BODIES.timing.safeParse({ args: { ...timing, from: { horizonAt: null, reviewCadence: 'P1W' } } }).success).toBe(true);
    expect(GOAL_CARD_BODIES.timing.safeParse({ args: { ...timing, from: { horizonAt: null } } }).success).toBe(false);
    // The contract itself requires it: a card filed by any other way (the CLI, straight at the runtime) is held to it too.
    expect(GoalHorizonChangeArgs.safeParse(timing).success).toBe(false);
    expect(GoalCriteriaChangeArgs.safeParse(edit).success).toBe(false);
    expect(StepBody.safeParse({ status: 'skipped' }).success).toBe(false);
    expect(MarkBody.safeParse({ met: true, at: 'x' }).success).toBe(false);
    expect(LinkableBody.safeParse({ q: 'x'.repeat(81) }).success).toBe(false);
  });

  it('the conditions the panel offers fit CHECK_PATHS; answers are strict, and a row can never be late until reviews exist', () => {
    expect(Object.keys(GOAL_CONDITIONS).sort()).toEqual(Object.keys(CHECK_PATHS).sort());
    for (const [kind, cs] of Object.entries(GOAL_CONDITIONS)) for (const c of cs) expect(checkFits(kind, c.key, c.value)).toBe(true);
    const row = { id: 'gotest0001', title: 'T', status: 'active', origin: 'will', checks: { met: 0, total: 1, unknown: 0 }, horizonAt: null, reviewCadence: 'P1W', endedAt: null, waiting: 0, late: false, tainted: false };
    expect(GoalsPage.safeParse({ tab: 'active', goals: [row], waiting: [], reviews: 'off' }).success).toBe(true);
    expect(GoalsPage.safeParse({ tab: 'active', goals: [{ ...row, extra: 1 }], waiting: [], reviews: 'off' }).success).toBe(false);
    expect(GoalsPage.safeParse({ tab: 'active', goals: [{ ...row, title: 'x'.repeat(121) }], waiting: [], reviews: 'off' }).success).toBe(false);
    // The Suggested tab's rows (part 5): an answer without them still reads (an older runtime), and each row is strict.
    expect(GoalsPage.parse({ tab: 'suggested', goals: [], waiting: [], reviews: 'off' }).suggestions).toEqual([]);
    const said = { goalId: 'gotest0001', title: 'Run a half marathon', quote: 'I want to run a half marathon by spring', saidAt: '2026-10-08T15:00:00.000Z', dueOn: '2027-03-20', waiting: true };
    expect(GoalsPage.safeParse({ tab: 'suggested', goals: [], waiting: [], reviews: 'off', suggestions: [said, { ...said, saidAt: null, dueOn: null, waiting: false }] }).success).toBe(true);
    for (const bad of [{ ...said, extra: 1 }, { ...said, quote: '' }, { ...said, dueOn: 'next spring' }, { ...said, saidAt: '2026-10-08' }, { ...said, goalId: 'x' }, { ...said, title: '' }]) {
      expect(GoalsPage.safeParse({ tab: 'suggested', goals: [], waiting: [], reviews: 'off', suggestions: [bad] }).success, JSON.stringify(bad)).toBe(false);
    }
    expect(Linkable.safeParse({ items: [{ entityId: 'en1', kind: 'pull_request', label: 'wpf002/flint #57', status: 'active', title: null, conditions: [] }] }).success).toBe(true);
  });
});

describe('goal reviews on the wire (P3 part 3)', () => {
  const AT = '2026-10-12T14:02:00.000Z';
  const view = (over: Record<string, unknown> = {}) => ({
    id: 'gotest0001', title: 'Synthetic goal', description: '', status: 'active', owner: 'will', origin: 'will', sensitivity: 'personal', tainted: false, nexusProjectId: null,
    successCriteria: [crit('c1')], criteria: [{ id: 'c1', state: 'unmet' }], checks: { met: 0, total: 1, unknown: 0 }, horizonAt: null, reviewCadence: 'P1W',
    activatedAt: AT, endedAt: null, links: [], plan: null, waiting: [], reviews: 'on', late: false, ...over,
  });
  const change = (over: Record<string, unknown> = {}) => ({ kind: 'due', title: 'Synthetic step', dueAt: AT, status: null, after: null, material: false, later: false, ...over });
  const review = (over: Record<string, unknown> = {}) => ({ at: AT, kind: 'scheduled', summary: '0 of 1 check is met.', shadow: true, planner: 'ok', changes: [change()], ...over });

  it('the budgets and counters are fixed, and the cap’s sentence says the same number', () => {
    expect(GOAL_BUDGETS).toEqual({ reviewsPerGoalPerDay: 12, planCardsPerDay: 9, materialPerReview: 2, opsPerReview: 6 });
    expect(GOAL_SAYS.reviewCap).toContain(` ${GOAL_BUDGETS.reviewsPerGoalPerDay} times today`);
    expect(reviewCounter('gotest0001')).toBe('goal.review:gotest0001');
    expect(PLAN_CARDS_COUNTER).toBe('goal.plan.cards');
    expect([REVIEW_LATE_MS, REVIEW_DOWN_MS]).toEqual([3_600_000, 86_400_000]);
    expect([...REVIEW_KINDS]).toEqual(['scheduled', 'triggered', 'requested']);
    // Review Now is one of the unsigned writes.
    expect([...GOAL_PLAIN_VERBS]).toEqual(['pause', 'dismiss', 'review']);
    for (const code of ['reviewsOff', 'reviewCap', 'notReady', 'replacedReview']) expect(goalSayOf(code), code).toMatch(/^[A-Z].*\.$/);
  });

  it('how likely is one of seven words, cut where the ledger’s phrase cuts', () => {
    expect([0.05, 0.1, 0.34, 0.35, 0.44, 0.45, 0.5, 0.55, 0.56, 0.64, 0.65, 0.89, 0.9, 0.95].map(likelihoodOf)).toEqual([
      'very_unlikely', 'unlikely', 'unlikely', 'somewhat_unlikely', 'somewhat_unlikely', 'about_even', 'about_even', 'about_even', 'somewhat_likely', 'somewhat_likely', 'likely', 'likely', 'very_likely', 'very_likely',
    ]);
    for (let p = 0; p <= 1.0001; p += 0.01) expect(LIKELIHOODS).toContain(likelihoodOf(p));
  });

  it('every refusal a goal card or a goal route answers with is a plain sentence, by the rules for a note', () => {
    for (const code of ['reviewsOff', 'reviewCap', 'notReady', 'replacedReview', 'reviewsStopped', 'minorCard', 'reviewStep', 'runtimeOrigin'] as const) {
      expect(goalSayOf(code)).toBe(GOAL_SAYS[code]);
      expect(goalCodeOf(GOAL_SAYS[code])).toBe(code);
    }
    for (const [code, sentence] of [...Object.entries(GOAL_SAYS), ...Object.entries(GOAL_STATUS_SAYS)]) {
      expect(noteProblems('Goals', sentence), code).toEqual([]);
      expect(sentence, code).toMatch(/^[A-Z].*\.$/);
    }
  });

  it('a view from a runtime without reviews still reads: next review, forecast and latest review default to nothing', () => {
    const older = GoalView.parse(view({ reviews: 'off' }));
    expect(older).toMatchObject({ nextReviewAt: null, onTrack: null, review: null });
    const full = view({ late: true, nextReviewAt: AT, onTrack: { likelihood: 'likely', percent: 70, by: AT }, review: review() });
    expect(GoalView.parse(full)).toEqual(full);
    expect(GoalView.safeParse(view({ extra: 1 })).success).toBe(false);
  });

  it('a review on the wire is strict: closed sets, counts and times, a step’s title, and never done', () => {
    expect(ReviewView.safeParse(review()).success).toBe(true);
    expect([...PLAN_STAGES]).toEqual(['pending', 'ok', 'off', 'capped', 'unavailable', 'invalid', 'deferred', 'skipped']);
    for (const bad of [
      review({ planner: 'ollama:muse-glimmer:30b' }), review({ kind: 'manual' }), review({ note: 'free text' }), review({ summary: '' }), review({ filed: 2 }), review({ at: '2026-10-12' }),
      review({ changes: Array.from({ length: 21 }, () => change()) }),
    ]) expect(ReviewView.safeParse(bad).success, JSON.stringify(bad).slice(0, 120)).toBe(false);
    for (const kind of ['add', 'due', 'status', 'move', 'skip']) expect(ReviewChange.safeParse(change({ kind })).success, kind).toBe(true);
    // Held back by a limit, on no card yet: a mark, true or false. A runtime that does not send it means not held.
    expect(ReviewChange.parse(change({ later: true })).later).toBe(true);
    const { later: _l, ...unmarked } = change();
    expect(ReviewChange.parse(unmarked).later).toBe(false);
    expect(ReviewChange.safeParse(change({ later: 'soon' })).success).toBe(false);
    expect(ReviewChange.safeParse(change({ kind: 'status', status: 'blocked', dueAt: null })).success).toBe(true);
    for (const bad of [change({ kind: 'done' }), change({ status: 'done' }), change({ status: 'skipped' }), change({ title: '' }), change({ title: 'x'.repeat(201) }), change({ reason: 'the model’s words' }), change({ dueAt: 'soon' })]) {
      expect(ReviewChange.safeParse(bad).success, JSON.stringify(bad).slice(0, 120)).toBe(false);
    }
    // The forecast: a word from the closed set, a whole percent, a time.
    expect(GoalView.safeParse(view({ onTrack: { likelihood: 'certain', percent: 100, by: AT } })).success).toBe(false);
    expect(GoalView.safeParse(view({ onTrack: { likelihood: 'likely', percent: 70.5, by: AT } })).success).toBe(false);
    expect(GoalView.safeParse(view({ onTrack: { likelihood: 'likely', percent: 70, by: AT, claim: 'x' } })).success).toBe(false);
  });
});
