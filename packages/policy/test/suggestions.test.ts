/**
 * Goals and commitments from chat: the shapes the server and the runtime share,
 * and the one way a quote is compared with what Will wrote (P3 part 5).
 */
import { describe, it, expect } from 'vitest';
import {
  CHAT_SUGGESTION_ACTIONS, CODE_TABLE, AUTONOMOUS_ACTIONS, ChatCandidate, ChatCommitmentArgs, GoalId, GoalProposeArgs, P3_ACTIONS, SUGGESTIONS_PER_DAY, SUGGESTION_ACTION,
  SUGGESTION_ARGS, SUGGESTION_CARD_KIND, SUGGESTION_QUOTE_MAX, SUGGESTION_QUOTE_MIN, SUGGESTION_TEMPLATE, SourceRef, contentWords, isChatSuggestion, normalizeSaid, resolveTier,
  saidHolds, sharedWords, suggestionGoalId, suggestionSourceRef,
} from '../src/index';

const candidate = (over: Record<string, unknown> = {}) => ({
  kind: 'goal', text: 'run a half marathon', quote: 'I want to run a half marathon by spring', conversationId: 'console-1', turnId: 'turn_1', sourceAt: '2026-10-08T15:00:00.000Z', ...over,
});

describe('the two actions a suggestion from chat is filed as', () => {
  it('are goal.propose (a goal card) and world.commitment.from_chat (a tool-call card), each with its template and its day’s limit', () => {
    expect(CHAT_SUGGESTION_ACTIONS).toEqual(['goal.propose', 'world.commitment.from_chat']);
    expect(SUGGESTION_ACTION).toEqual({ goal: 'goal.propose', commitment: 'world.commitment.from_chat' });
    expect(SUGGESTION_CARD_KIND).toEqual({ 'goal.propose': 'goal', 'world.commitment.from_chat': 'tool_call' });
    expect(SUGGESTION_TEMPLATE).toEqual({ 'goal.propose': 'chat.goal', 'world.commitment.from_chat': 'chat.commitment' });
    expect(SUGGESTIONS_PER_DAY).toEqual({ 'goal.propose': 3, 'world.commitment.from_chat': 10 });
    expect(Object.keys(SUGGESTION_ARGS)).toEqual([...CHAT_SUGGESTION_ACTIONS]);
    for (const a of CHAT_SUGGESTION_ACTIONS) {
      expect(isChatSuggestion(a)).toBe(true);
      expect(P3_ACTIONS).toContain(a);
    }
    for (const a of ['goal.activate', 'goal.propose.x', 'mcp:goal.propose', 'world.commitment.from_mail', '']) expect(isChatSuggestion(a), a).toBe(false);
  });

  it('ship at APPROVAL, in chat context only: promotable by a rule Will signs, with no cap of their own, and never a job’s to take', () => {
    for (const a of CHAT_SUGGESTION_ACTIONS) {
      expect(CODE_TABLE[a], a).toMatchObject({ tier: 'approval', promotable: true });
      expect(CODE_TABLE[a]!.cap, a).toBeUndefined();
      expect(AUTONOMOUS_ACTIONS.has(a), a).toBe(false);
      expect(resolveTier(a, { context: 'chat', tainted: false, sensitivity: 'personal', policies: [] }), a).toMatchObject({ tier: 'approval', rule: 'code' });
      expect(resolveTier(a, { context: 'autonomous', tainted: false, policies: [] }).tier, a).toBe('forbidden');
      // Promoted: alone, under the row's cap, still only in chat context.
      const policies = [{ pattern: a, tier: 'alone' as const, dailyCap: SUGGESTIONS_PER_DAY[a], active: true, expiresAt: new Date(Date.now() + 86_400_000) }];
      expect(resolveTier(a, { context: 'chat', tainted: false, sensitivity: 'personal', policies }), a).toMatchObject({ tier: 'alone', cap: { limit: SUGGESTIONS_PER_DAY[a], period: 'day' } });
      expect(resolveTier(a, { context: 'autonomous', tainted: false, policies }).tier, a).toBe('forbidden');
    }
  });
});

describe('normalizeSaid and saidHolds: is the quote in what Will wrote, word for word?', () => {
  it('makes curly quotes, primes and runs of whitespace alike, and keeps every word and its case', () => {
    expect(normalizeSaid('  I’ll  finish\tthe “Q4 report”\n\nby ‘Friday’ ')).toBe(`I'll finish the "Q4 report" by 'Friday'`);
    expect(normalizeSaid('non breaking   space')).toBe('non breaking space');
    expect(normalizeSaid('café')).toBe('café');
    expect(normalizeSaid('Keep THIS Case')).toBe('Keep THIS Case');
    // Idempotent: what the check leaves is what the runtime accepts.
    const once = normalizeSaid(' “a”  b′ c ');
    expect(normalizeSaid(once)).toBe(once);
    // Dashes, ellipses and other marks are his: they are left as he typed them.
    expect(normalizeSaid('wait — really…')).toBe('wait — really…');
  });

  it('holds only a quote that is in his words: the same words, in order, not starting or ending inside a word', () => {
    const said = 'OK. I’ll  send Dana the draft by Friday, and then see my cardiologist.';
    expect(saidHolds(said, `I'll send Dana the draft by Friday`)).toBe(true);
    expect(saidHolds(said, 'I’ll send Dana the draft by Friday,')).toBe(true);
    expect(saidHolds(said, 'see my cardiologist')).toBe(true);
    for (const not of ['I will send Dana the draft by Friday', `I'll send Dana a draft by Friday`, `I'll send the draft by Friday`, 'see my card', 'end Dana the draft', `i'll send dana the draft by friday`, '', '   ']) {
      expect(saidHolds(said, not), not).toBe(false);
    }
    // A quote that ends on punctuation needs no word boundary after it.
    expect(saidHolds('Done by Friday!Then rest', 'Done by Friday!')).toBe(true);
    expect(saidHolds('', 'anything at all here')).toBe(false);
  });
});

describe('the shapes', () => {
  it('a candidate: ids as the server names turns, a quote of 12 to 300 characters in the check’s own form, a real day, a time to the millisecond; nothing else', () => {
    expect(ChatCandidate.safeParse(candidate()).success).toBe(true);
    expect(ChatCandidate.safeParse(candidate({ kind: 'commitment', dueOn: '2027-03-20' })).success).toBe(true);
    expect([SUGGESTION_QUOTE_MIN, SUGGESTION_QUOTE_MAX]).toEqual([12, 300]);
    expect(ChatCandidate.safeParse(candidate({ quote: 'I will do it' })).success).toBe(true);
    expect(ChatCandidate.safeParse(candidate({ quote: `I will ${'x'.repeat(293)}` })).success).toBe(true);
    const bad: Array<Record<string, unknown>> = [
      { quote: 'I will do x' }, { quote: `I will ${'x'.repeat(294)}` }, { quote: '123456 789012' }, { quote: 'I’ll finish the report' }, { quote: 'I will  finish it' },
      { quote: ' I will finish it' }, { quote: 'I will finish it\nsoon' }, { quote: 42 }, { text: 'ab' }, { text: 'x'.repeat(121) }, { text: '12345' }, { text: ' padded ' },
      { kind: 'task' }, { conversationId: '' }, { conversationId: 'a b' }, { conversationId: 'x'.repeat(81) }, { conversationId: 'chat:c1' }, { turnId: 't.1' },
      { dueOn: '2027-2-3' }, { dueOn: '2027-02-30' }, { dueOn: '2027-13-01' }, { dueOn: '' }, { sourceAt: '2026-10-08' }, { sourceAt: '2026-10-08T15:00:00Z' }, { sourceAt: 1791817200000 },
      { extra: true }, { staysHere: true },
    ];
    for (const over of bad) expect(ChatCandidate.safeParse(candidate(over)).success, JSON.stringify(over)).toBe(false);
    // Characters are counted as the database counts them: twelve UTF-16 units of six emoji are six characters.
    expect(ChatCandidate.safeParse(candidate({ quote: 'a😀😀😀😀😀b' })).success).toBe(false);
    for (const k of ['kind', 'text', 'quote', 'conversationId', 'turnId', 'sourceAt']) {
      const c: Record<string, unknown> = candidate();
      delete c[k];
      expect(ChatCandidate.safeParse(c).success, k).toBe(false);
    }
  });

  it('a card’s args: the candidate’s words, when he said them, and a source and goal id made from the conversation, the turn and the quote', () => {
    const ref = suggestionSourceRef('console-1', 'turn_1', 'I want to run a half marathon by spring');
    expect(SourceRef.safeParse(ref).success).toBe(true);
    expect(ref).toMatch(/^chat:[0-9a-f]{64}$/);
    // The same three are the same source, however the quote's marks were typed; any one of them changed is another.
    expect(suggestionSourceRef('console-1', 'turn_1', 'I  want to run a half marathon by spring ')).toBe(ref);
    for (const other of [suggestionSourceRef('console-2', 'turn_1', 'I want to run a half marathon by spring'), suggestionSourceRef('console-1', 'turn_2', 'I want to run a half marathon by spring'), suggestionSourceRef('console-1', 'turn_1', 'I want to run a marathon by spring')]) {
      expect(other).not.toBe(ref);
    }
    // No joining trick makes two different pairs one source.
    expect(suggestionSourceRef('a', 'b|c', 'I want to run a half marathon')).not.toBe(suggestionSourceRef('a|b', 'c', 'I want to run a half marathon'));
    const goalId = suggestionGoalId(ref);
    expect(GoalId.safeParse(goalId).success).toBe(true);
    expect(goalId).toBe(`go${ref.slice(5, 37)}`);
    const goal = { goalId, title: 'run a half marathon', quote: 'I want to run a half marathon by spring', saidAt: '2026-10-08T15:00:00.000Z', sourceRef: ref };
    expect(GoalProposeArgs.safeParse(goal).success).toBe(true);
    expect(GoalProposeArgs.safeParse({ ...goal, dueOn: '2027-03-20' }).success).toBe(true);
    const { goalId: _g, title, ...rest } = goal;
    expect(ChatCommitmentArgs.safeParse({ text: title, ...rest }).success).toBe(true);
    for (const over of [{ extra: 1 }, { quote: 'too short' }, { sourceRef: 'chat:abc' }, { sourceRef: `chat:${'A'.repeat(64)}` }, { saidAt: 'yesterday' }, { goalId: 'x' }, { dueOn: null }]) {
      expect(GoalProposeArgs.safeParse({ ...goal, ...over }).success, JSON.stringify(over)).toBe(false);
    }
    expect(ChatCommitmentArgs.safeParse(goal).success).toBe(false);
  });

  it('two texts are about the same thing when they share content words: four letters or more, no common words', () => {
    expect([...contentWords('Finish the Dallas marathon training block')].sort()).toEqual(['block', 'dallas', 'finish', 'marathon', 'training']);
    expect([...contentWords('I will do it this week, and that is that')]).toEqual([]);
    expect(sharedWords('Finish the Dallas marathon training block', 'I will add a long run to my marathon training')).toBe(2);
    expect(sharedWords('Renovate the kitchen cabinets', 'my marathon training before the kitchen is done')).toBe(1);
    expect(sharedWords('MARATHON Training', 'marathon training')).toBe(2);
    expect(sharedWords('', 'marathon training')).toBe(0);
  });
});
