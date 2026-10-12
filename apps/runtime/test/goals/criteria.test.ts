/**
 * The criteria evaluator (goals/criteria.ts): manual checks by Will's marks,
 * steps checks by the active plan, item checks by one structural field. An item
 * is read as it stands, finished or not: GitHub archives a merged pull request,
 * Nexus an ended thread, Railway a removed deployment, and each still meets the
 * check that looks for exactly that. A forgotten item is unknown; a merged one is
 * read as the item it became; a tainted field is unknown; unknown is never met.
 * progress = met / total.
 */
import { describe, it, expect } from 'vitest';
import type { Criterion } from '@flint/policy';
import { evaluate, itemState, resolveItem, type ItemFacts } from '../../src/goals/criteria';

const item = (id: string, kind: string, state: Record<string, unknown>, over: Partial<ItemFacts> = {}): ItemFacts => ({
  id, kind, status: 'active', state, taintedPaths: [], mergedIntoId: null, ...over,
});
const items = (...xs: ItemFacts[]) => new Map(xs.map((x) => [x.id, x]));
const crit = (id: string, check: Criterion['check']): Criterion => ({ id, text: `Synthetic ${id}`, check });
const check = (entityId: string, key: string, value: string) => ({ entityId, key, value });

describe('item checks', () => {
  it('meets when the field has the value, and not otherwise', () => {
    const m = items(item('pr', 'pull_request', { number: 57, state: 'open' }), item('ci', 'ci_run', { workflow: 'ci', status: 'completed', conclusion: null }));
    expect(itemState(check('pr', 'state', 'merged'), m)).toBe('unmet');
    expect(itemState(check('ci', 'conclusion', 'success'), m)).toBe('unmet');
  });

  it('a finished item counts: archived is read normally (merged PR, closed issue, ended thread, removed deploy)', () => {
    const m = items(
      // As GitHub's source writes it: the PR merged, and archived because it is no longer open.
      item('pr', 'pull_request', { number: 57, state: 'merged', title: 'Outside words' }, { status: 'archived', taintedPaths: ['name', 'state.title'] }),
      item('is', 'issue', { number: 8, state: 'closed' }, { status: 'archived' }),
      item('th', 'thread', { status: 'archived' }, { status: 'archived', taintedPaths: ['name'] }),
      item('dp', 'deployment', { target: 'railway', status: 'removed' }, { status: 'archived' }),
    );
    expect(itemState(check('pr', 'state', 'merged'), m)).toBe('met');
    expect(itemState(check('pr', 'state', 'closed'), m)).toBe('unmet');
    expect(itemState(check('is', 'state', 'closed'), m)).toBe('met');
    expect(itemState(check('th', 'status', 'archived'), m)).toBe('met');
    expect(itemState(check('dp', 'status', 'success'), m)).toBe('unmet');
    expect(itemState(check('dp', 'status', 'removed'), m)).toBe('met');
  });

  it('a forgotten or missing item is unknown, never met', () => {
    const m = items(item('pr', 'pull_request', { number: 57, state: 'merged' }, { status: 'forgotten' }));
    expect(itemState(check('pr', 'state', 'merged'), m)).toBe('unknown');
    expect(itemState(check('gone', 'state', 'merged'), m)).toBe('unknown');
  });

  it('a merged entity is read as the item it became (up to three merges), else unknown', () => {
    const m = items(
      item('a', 'pull_request', { number: 1, state: 'open' }, { status: 'merged', mergedIntoId: 'b' }),
      item('b', 'pull_request', { number: 1, state: 'merged' }, { status: 'archived' }),
      item('loop1', 'pull_request', { number: 2, state: 'merged' }, { status: 'merged', mergedIntoId: 'loop2' }),
      item('loop2', 'pull_request', { number: 2, state: 'merged' }, { status: 'merged', mergedIntoId: 'loop1' }),
      item('dangling', 'pull_request', { number: 3, state: 'merged' }, { status: 'merged', mergedIntoId: null }),
    );
    expect(resolveItem('a', m)?.id).toBe('b');
    expect(itemState(check('a', 'state', 'merged'), m)).toBe('met');
    expect(itemState(check('loop1', 'state', 'merged'), m)).toBe('unknown');
    expect(itemState(check('dangling', 'state', 'merged'), m)).toBe('unknown');
  });

  it('a tainted field, a field the item lacks, or a check its kind cannot make is unknown', () => {
    const m = items(
      item('t', 'pull_request', { number: 5, state: 'merged' }, { taintedPaths: ['state'] }),
      item('svc', 'service', { managedBy: 'launchd' }),
      item('iss', 'issue', { number: 9, state: 'closed' }),
    );
    expect(itemState(check('t', 'state', 'merged'), m)).toBe('unknown');
    expect(itemState(check('svc', 'health', 'ok'), m)).toBe('unknown');
    // An issue is never merged: the check does not fit its kind.
    expect(itemState(check('iss', 'state', 'merged'), m)).toBe('unknown');
  });
});

describe('evaluate', () => {
  const criteria = [
    crit('c1', { kind: 'manual' }),
    crit('c2', { kind: 'steps', keys: ['s1', 's2'] }),
    crit('c3', { kind: 'item', entityId: 'pr', key: 'state', value: 'merged' }),
  ];
  const pr = (state: string, status = 'active') => items(item('pr', 'pull_request', { number: 57, state }, { status }));

  it('manual by Will’s mark, steps by the plan (done or skipped), items by their field; progress is met / total', () => {
    const none = evaluate(criteria, {}, [{ key: 's1', status: 'todo' }, { key: 's2', status: 'done' }], pr('open'));
    expect(none).toEqual({ criteria: [{ id: 'c1', state: 'unmet' }, { id: 'c2', state: 'unmet' }, { id: 'c3', state: 'unmet' }], met: 0, unknown: 0, total: 3, progress: 0 });
    const all = evaluate(criteria, { c1: '2026-10-09' }, [{ key: 's1', status: 'skipped' }, { key: 's2', status: 'done' }], pr('merged', 'archived'));
    expect(all).toMatchObject({ met: 3, unknown: 0, total: 3, progress: 1 });
    const two = evaluate(criteria, { c1: '2026-10-09' }, [{ key: 's1', status: 'done' }, { key: 's2', status: 'blocked' }], pr('merged', 'archived'));
    expect(two.criteria.map((c) => c.state)).toEqual(['met', 'unmet', 'met']);
    expect(two.progress).toBeCloseTo(2 / 3);
  });

  it('a steps check with no plan, or naming a step the plan lacks, is unknown; unknown never counts as met', () => {
    expect(evaluate(criteria, {}, null, pr('open')).criteria[1]).toEqual({ id: 'c2', state: 'unknown' });
    const e = evaluate(criteria, {}, [{ key: 's1', status: 'done' }], items());
    expect(e.criteria.map((c) => c.state)).toEqual(['unmet', 'unknown', 'unknown']);
    expect(e).toMatchObject({ met: 0, unknown: 2, total: 3, progress: 0 });
  });

  it('a mark is a date string; anything else is not a mark', () => {
    expect(evaluate([crit('c1', { kind: 'manual' })], { c1: true }, null, items()).met).toBe(0);
    expect(evaluate([], {}, null, items())).toEqual({ criteria: [], met: 0, unknown: 0, total: 0, progress: 0 });
  });
});
