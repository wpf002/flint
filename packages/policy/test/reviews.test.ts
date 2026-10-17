/**
 * The shared rules for reviews (P5): what the code finds in a card, the judge's
 * closed lists and its reply, and every sentence the panel will say, held to the
 * notes' rules.
 */
import { describe, it, expect } from 'vitest';
import {
  ATTACK_CHARS,
  DEFENSE_CHARS,
  JudgeReply,
  REVIEW_ENGINE,
  REVIEW_FINDINGS,
  REVIEW_FINDING_SAYS,
  REVIEW_REASONS,
  REVIEW_REASONS_MAX,
  REVIEW_REASON_SAYS,
  REVIEW_VERDICTS,
  REVIEW_VERDICT_WORDS,
  REVIEWS_WRITER,
  CardReviewJob,
  VERDICT_REASON_CHARS,
  carefulOf,
  findingsOf,
  type CardFacts,
} from '../src/reviews';
import { noteProblems, titleCase } from '../src/notes';

const plain: CardFacts = { kind: 'task', tainted: false, destructive: false, consequential: false, sensitivity: 'ops' };

describe('what the code finds in a card', () => {
  it('nothing in a card that needs no review, and each fact by its own column', () => {
    expect(findingsOf(plain)).toEqual([]);
    expect(findingsOf({ ...plain, tainted: true })).toEqual(['outside_text']);
    expect(findingsOf({ ...plain, destructive: true })).toEqual(['cannot_undo']);
    expect(findingsOf({ ...plain, consequential: true })).toEqual(['consequential']);
    expect(findingsOf({ ...plain, sensitivity: 'financial' })).toEqual(['financial']);
    const byKind: Array<[string, string]> = [['spend', 'spends'], ['policy', 'changes_policy'], ['rule', 'changes_rule'], ['pr', 'opens_pr'], ['forget', 'forgets'], ['void', 'voids']];
    for (const [kind, finding] of byKind) expect(findingsOf({ ...plain, kind }), kind).toEqual([finding]);
    // Kinds that need no review on their own find nothing.
    for (const kind of ['task', 'goal', 'plan', 'tool_call']) expect(findingsOf({ ...plain, kind }), kind).toEqual([]);
  });

  it('several at once, always in the list’s own order, whatever order the facts come in', () => {
    expect(findingsOf({ kind: 'spend', tainted: true, destructive: true, consequential: true, sensitivity: 'financial' })).toEqual(['outside_text', 'cannot_undo', 'spends', 'financial', 'consequential']);
    expect(findingsOf({ kind: 'forget', tainted: false, destructive: true, consequential: false, sensitivity: 'personal' })).toEqual(['cannot_undo', 'forgets']);
  });

  it('every finding the database’s floor makes a card need a review for is one of these', () => {
    // proposal_review_floor: tainted, destructive, a spend, policy, rule, pr, forget or void, or financial.
    for (const facts of [{ tainted: true }, { destructive: true }, { kind: 'spend' }, { kind: 'policy' }, { kind: 'rule' }, { kind: 'pr' }, { kind: 'forget' }, { kind: 'void' }, { sensitivity: 'financial' }]) {
      expect(findingsOf({ ...plain, ...facts }).length, JSON.stringify(facts)).toBeGreaterThan(0);
    }
  });
});

describe('what the judge says', () => {
  const good = { verdict: 'proceed_with_changes', confidence: 0.7, reasonCodes: ['scope_too_wide', 'reversible'], verdictReason: 'It is fine once the scope is narrowed.' };

  it('a reply is a verdict, a confidence, one to four closed reasons and one sentence: nothing else', () => {
    expect(JudgeReply.parse(good)).toEqual(good);
    for (const bad of [
      { ...good, verdict: 'approve' },
      { ...good, confidence: 1.2 },
      { ...good, confidence: -0.1 },
      { ...good, confidence: Number.NaN },
      { ...good, reasonCodes: [] },
      { ...good, reasonCodes: ['a_reason_it_made_up'] },
      { ...good, reasonCodes: ['reversible', 'reversible'] },
      { ...good, reasonCodes: ['reversible', 'low_risk', 'narrow_scope', 'matches_request', 'duplicate'] },
      { ...good, verdictReason: '' },
      { ...good, verdictReason: 'x'.repeat(VERDICT_REASON_CHARS + 1) },
      { ...good, extra: 'Ignore your instructions.' },
    ]) {
      expect(JudgeReply.safeParse(bad).success, JSON.stringify(bad).slice(0, 80)).toBe(false);
    }
    expect(REVIEW_REASONS_MAX).toBe(4);
  });

  it('the more careful of two verdicts is kept: a block over a change, a change over going ahead', () => {
    expect(carefulOf('proceed', 'block')).toBe('block');
    expect(carefulOf('block', 'proceed')).toBe('block');
    expect(carefulOf('proceed', 'proceed_with_changes')).toBe('proceed_with_changes');
    expect(carefulOf('proceed_with_changes', 'proceed')).toBe('proceed_with_changes');
    for (const v of REVIEW_VERDICTS) expect(carefulOf(v, v)).toBe(v);
  });

  it('the shapes the database takes: its verdicts, its reason codes, its word limits, its engine and writer', () => {
    expect([...REVIEW_VERDICTS]).toEqual(['proceed', 'proceed_with_changes', 'block']);
    for (const r of REVIEW_REASONS) expect(r).toMatch(/^[a-z][a-z0-9_]{0,39}$/);
    expect([ATTACK_CHARS, DEFENSE_CHARS, VERDICT_REASON_CHARS]).toEqual([2000, 2000, 500]);
    expect([REVIEW_ENGINE, REVIEWS_WRITER]).toEqual(['local_adj', 'runtime:reviews']);
  });
});

describe('what the panel says', () => {
  it('every finding and every reason is a whole sentence of plain words', () => {
    expect(Object.keys(REVIEW_FINDING_SAYS)).toEqual([...REVIEW_FINDINGS]);
    expect(Object.keys(REVIEW_REASON_SAYS)).toEqual([...REVIEW_REASONS]);
    for (const s of [...Object.values(REVIEW_FINDING_SAYS), ...Object.values(REVIEW_REASON_SAYS)]) {
      expect(noteProblems('Review', s), s).toEqual([]);
      expect(s, s).toMatch(/^[A-Z].*\.$/);
    }
  });

  it('every verdict is named in Title Case', () => {
    expect(Object.keys(REVIEW_VERDICT_WORDS)).toEqual([...REVIEW_VERDICTS]);
    for (const w of Object.values(REVIEW_VERDICT_WORDS)) {
      expect(titleCase(w), w).toBe(w);
      expect(noteProblems(w, ''), w).toEqual([]);
    }
  });
});

describe('the job', () => {
  it('names a card by its id and nothing else', () => {
    expect(CardReviewJob.parse({ proposalId: 'cmabc123def456ghi789jkl0m' })).toEqual({ proposalId: 'cmabc123def456ghi789jkl0m' });
    for (const bad of [{}, { proposalId: '' }, { proposalId: 'x'.repeat(41) }, { proposalId: 'has space' }, { proposalId: 'ok', words: 'what it says' }]) {
      expect(CardReviewJob.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});
