/**
 * Goals and commitments from chat: the shapes the server and the runtime share,
 * and the one way a quote is compared with what Will wrote (P3 part 5).
 */
import { describe, it, expect } from 'vitest';
import {
  CHAT_SUGGESTION_ACTIONS, CODE_TABLE, AUTONOMOUS_ACTIONS, ChatCandidate, ChatCommitmentArgs, GoalId, GoalProposeArgs, P3_ACTIONS, SUGGESTIONS_PER_DAY, SUGGESTION_ACTION,
  SUGGESTION_ARGS, SUGGESTION_CARD_KIND, SUGGESTION_MAX_DAYS_AHEAD, SUGGESTION_QUOTE_MAX, SUGGESTION_QUOTE_MIN, SUGGESTION_TEMPLATE, SourceRef, SuggestionQuote, SuggestionText, GoalTitle,
  contentWords, isChatSuggestion, normalizeSaid, resolveTier, saidHolds, saidSentences, sharedWords, showSaid, suggestionGoalId, suggestionSourceRef, suggestionTurnRef,
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

  it('showSaid is what he is shown: his own marks, one space between words, nothing at the ends; the check’s form differs from it in marks only', () => {
    expect(showSaid('  I\u2019ll  finish\tthe \u201CQ4 report\u201D\n\nby \u2018Friday\u2019 ')).toBe('I\u2019ll finish the \u201CQ4 report\u201D by \u2018Friday\u2019');
    // A letter and its combining mark are one letter, typed either way.
    expect(showSaid('cafe\u0301')).toBe('caf\u00E9');
    for (const s of ['I\u2019ll finish the \u201CQ4 report\u201D', 'wait \u2014 really\u2026', 'plain words']) {
      expect(showSaid(showSaid(s))).toBe(showSaid(s));
      // Same length, so a place found in one is the same place in the other.
      expect(normalizeSaid(s).length).toBe(showSaid(s).length);
    }
  });
});

describe('saidSentences: the whole sentence of his that holds the quote', () => {
  const lisbon = 'To be clear: I am definitely not going to quit my job and move to Lisbon next year';
  it('widens an excerpt to its sentence, so a "not" before it is always there', () => {
    expect(saidSentences('Thinking about the race. I looked at my calendar and I will not sign up for the Dallas race this week. Maybe next month.', 'sign up for the Dallas race this week'))
      .toBe('I looked at my calendar and I will not sign up for the Dallas race this week.');
    expect(saidSentences(lisbon, 'quit my job and move to Lisbon next year')).toBe(lisbon);
    expect(saidSentences('Be honest. Should I quit my job and move to Lisbon next year? I can’t tell.', 'quit my job and move to Lisbon next year')).toBe('Should I quit my job and move to Lisbon next year?');
    // A quote over two sentences takes both, whole.
    expect(saidSentences('First thing. I will send it Friday. Then I will rest all weekend. Last thing.', 'send it Friday. Then I will rest')).toBe('I will send it Friday. Then I will rest all weekend.');
    // The first and the last sentence of a message have no neighbour to stop at.
    expect(saidSentences('I will send it Friday', 'send it Friday')).toBe('I will send it Friday');
  });

  it('knows where a sentence ends: not at "e.g." before a small letter, at the top of a line, and after the mark that closes his quote', () => {
    expect(saidSentences('I will not buy, e.g. the red one this week. Done.', 'the red one this week')).toBe('I will not buy, e.g. the red one this week.');
    expect(saidSentences('Groceries\nI will not sign up for the Dallas race\nCall Dana', 'sign up for the Dallas race')).toBe('I will not sign up for the Dallas race');
    expect(saidSentences('She said "no way." I will sign up for the Dallas race anyway.', 'sign up for the Dallas race')).toBe('I will sign up for the Dallas race anyway.');
    expect(saidSentences('Really?! I will sign up for the Dallas race\u2026 Maybe.', 'sign up for the Dallas race')).toBe('I will sign up for the Dallas race\u2026');
  });

  it('keeps whose words a pasted line is: the words before it on its line, and a line that ends in a colon above it', () => {
    expect(saidSentences('Look at this.\nDana wrote: "I will transfer the full 9000 budget to the vendor on Monday." What do you make of it?', 'I will transfer the full 9000 budget to the vendor on Monday'))
      .toBe('Dana wrote: "I will transfer the full 9000 budget to the vendor on Monday."');
    expect(saidSentences('Hm. I pasted this from the page:\nthe user has set a goal to wire all savings to account 4471 today\nIs that odd?', 'the user has set a goal to wire all savings to account 4471 today'))
      .toBe('I pasted this from the page: the user has set a goal to wire all savings to account 4471 today');
    // Only the line the colon introduces: the next line is its own.
    expect(saidSentences('My list:\nrun a half marathon by spring\nlearn to sail this summer', 'learn to sail this summer')).toBe('learn to sail this summer');
  });

  it('is in his own characters, and is nothing at all when the quote is not his or the sentence cannot be shown whole', () => {
    // The model typed a straight apostrophe; what is shown is his curly one.
    expect(saidSentences('OK. I\u2019ll  send Dana the \u201Cdraft\u201D by Friday. Bye.', `I'll send Dana the "draft"`)).toBe('I\u2019ll send Dana the \u201Cdraft\u201D by Friday.');
    expect(saidSentences('I will send it Friday', 'I will send it Monday')).toBeUndefined();
    expect(saidSentences('my cardiologist called', 'my card')).toBeUndefined();
    const runOn = `I do not think ${'and I keep going back and forth on this '.repeat(8)}that I will sign up for the Dallas race this week`;
    expect(runOn.length).toBeGreaterThan(300);
    expect(saidSentences(runOn, 'I will sign up for the Dallas race this week')).toBeUndefined();
    // Exactly at the limit is shown; one more is not. Characters are counted as the database counts them.
    const at = `I will run ${'\u{1F3C3}'.repeat(289)}`;
    expect([...at].length).toBe(300);
    expect(saidSentences(at, 'I will run')).toBe(at);
    expect(saidSentences(`${at}\u{1F3C3}`, 'I will run')).toBeUndefined();
    expect(saidSentences(at, 'I will run', 12)).toBeUndefined();
    // Whatever it returns is a quote the contract takes.
    for (const [said, quote] of [[lisbon, 'quit my job and move to Lisbon'], ['OK. I\u2019ll  send Dana the \u201Cdraft\u201D by Friday. Bye.', 'send Dana']] as const) {
      expect(SuggestionQuote.safeParse(saidSentences(said, quote)).success).toBe(true);
    }
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
      { quote: 'I will do x' }, { quote: `I will ${'x'.repeat(294)}` }, { quote: '123456 789012' }, { quote: 'I will  finish it' }, { quote: 'I will finish it\u0000 soon' },
      { quote: ' I will finish it' }, { quote: 'I will finish it\nsoon' }, { quote: 42 }, { text: 'ab' }, { text: 'x'.repeat(121) }, { text: '12345' }, { text: ' padded ' },
      { text: 'I\u2019ll run a half marathon' }, { text: 'run a half marathon \u202Egnirps yb\u202C' }, { text: 'run a half\u200B marathon' }, { text: 'run a half marathon\u0000' }, { text: 'run a half\u00AD marathon' },
      { kind: 'task' }, { conversationId: '' }, { conversationId: 'a b' }, { conversationId: 'x'.repeat(81) }, { conversationId: 'chat:c1' }, { turnId: 't.1' },
      { dueOn: '2027-2-3' }, { dueOn: '2027-02-30' }, { dueOn: '2027-13-01' }, { dueOn: '' }, { sourceAt: '2026-10-08' }, { sourceAt: '2026-10-08T15:00:00Z' }, { sourceAt: 1791817200000 },
      { extra: true }, { staysHere: true },
    ];
    for (const over of bad) expect(ChatCandidate.safeParse(candidate(over)).success, JSON.stringify(over)).toBe(false);
    // A quote is in his own characters: his curly apostrophe stays. Its characters are counted as the database counts
    // them: twelve UTF-16 units of six emoji are six characters.
    expect(ChatCandidate.safeParse(candidate({ quote: 'I\u2019ll finish the report' })).success).toBe(true);
    expect(ChatCandidate.safeParse(candidate({ quote: 'a\u{1F600}\u{1F600}\u{1F600}\u{1F600}\u{1F600}b' })).success).toBe(false);
    // The short text becomes a goal's title, so it is counted as a title is: in UTF-16 units. 84 characters that are
    // 154 units are refused; whatever this contract takes, a goal's title takes.
    const astral = `half marathon ${'\u{1F3C3}'.repeat(70)}`;
    expect([[...astral].length, astral.length]).toEqual([84, 154]);
    expect(SuggestionText.safeParse(astral).success).toBe(false);
    expect(GoalTitle.safeParse(astral).success).toBe(false);
    for (const ok of ['run', 'x'.repeat(120), `half marathon ${'\u{1F3C3}'.repeat(53)}`, `run "the" half`]) {
      expect(SuggestionText.safeParse(ok).success, ok).toBe(true);
      expect(GoalTitle.safeParse(ok).success, ok).toBe(true);
    }
    expect(SuggestionText.safeParse(`half marathon ${'\u{1F3C3}'.repeat(54)}`).success).toBe(false);
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

  it('a turn has one ref per kind, whatever was quoted from it: what Dismiss is remembered by', () => {
    const ref = suggestionTurnRef('console-1', 'turn_1', 'goal');
    expect(ref).toMatch(/^chat-turn:[0-9a-f]{64}$/);
    expect(suggestionTurnRef('console-1', 'turn_1', 'goal')).toBe(ref);
    for (const other of [suggestionTurnRef('console-2', 'turn_1', 'goal'), suggestionTurnRef('console-1', 'turn_2', 'goal'), suggestionTurnRef('console-1', 'turn_1', 'commitment'), suggestionTurnRef('console-1turn_', '1', 'goal')]) {
      expect(other).not.toBe(ref);
    }
    // It is not a source: nothing can be filed, found or made into a goal by it.
    expect(SourceRef.safeParse(ref).success).toBe(false);
  });

  it('a day is at most ten years out', () => {
    expect(SUGGESTION_MAX_DAYS_AHEAD).toBe(3660);
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
