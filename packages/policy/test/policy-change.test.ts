import { describe, it, expect } from 'vitest';
import { POLICY_CHANGE_SHAPE, coversPolicyChange, noteProblems, policyChangeKind, patternMatches } from '../src/index';

describe('a policy change says one thing', () => {
  const row = { pattern: 'goal.propose', tier: 'alone', expiresAt: '2027-04-05T00:00:00.000Z' };
  const off = { id: 'ap1', pattern: 'goal.propose', tier: 'approval' };

  it('rows, or off: one key holding a list that is not empty', () => {
    expect(policyChangeKind({ rows: [row] })).toBe('rows');
    expect(policyChangeKind({ off: [off] })).toBe('off');
    expect(policyChangeKind({ rows: [row, row] })).toBe('rows');
  });

  it('never both, never anything beside them, never an empty list, never another shape', () => {
    for (const args of [
      { rows: [row], off: [off] }, { off: [off], rows: [] }, { rows: [row], off: [] }, { rows: [], off: [] },
      { rows: [row], note: 'x' }, { off: [off], also: 1 }, { rows: [] }, { off: [] }, { rows: row }, { off: off }, { rows: 'all' }, { off: null },
      {}, { switchOff: [off] }, [], [{ off: [off] }], null, undefined, 'off', 0, true,
    ]) {
      expect(policyChangeKind(args), JSON.stringify(args)).toBeUndefined();
    }
    // A key the object only inherits is not one it has.
    expect(policyChangeKind(Object.create({ off: [off] }))).toBeUndefined();
  });

  it('what Will reads for any other card is a sentence', () => {
    expect(noteProblems('Rule', POLICY_CHANGE_SHAPE)).toEqual([]);
  });
});

describe('no rule covers a policy change', () => {
  it('policy.change, the whole family, and anything under it; nothing else', () => {
    for (const p of ['policy.change', 'policy.*', 'policy.change.*', 'policy.anything', 'policy']) expect(coversPolicyChange(p), p).toBe(true);
    for (const p of ['goal.propose', 'goal.*', 'policyx.change', 'my.policy.change', 'mcp:policy.change', 'mcp:policy.*', 'polic.*']) expect(coversPolicyChange(p), p).toBe(false);
    // Every pattern the engine would match against a policy change is one of them.
    for (const p of ['policy.change', 'policy.*']) expect(patternMatches(p, 'policy.change') && coversPolicyChange(p), p).toBe(true);
  });
});
