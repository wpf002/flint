/**
 * Goals and commitments Flint takes from chat (Machine plan P3 part 5): the
 * shapes the server and the runtime share, and the one way a quote is compared
 * with what Will wrote.
 *
 * A suggestion rests on Will's own words. The server's memory extractor (its
 * local model only) proposes one with a quote; the server keeps it only if that
 * quote is in Will's own message of the turn it names (saidHolds), then hands
 * it to the runtime's POST /v1/goals/candidates. The runtime trusts none of
 * that: it holds the request to these shapes again, files the card itself, and
 * the database refuses a card without Will's quoted words (migration p3_goals).
 *
 * The words are PERSONAL: nothing here puts them in a log, a reason or an error.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { GoalId, IsoMs } from './goals.js';

/** The two actions a suggestion from chat is filed as. Only the runtime's candidates intake files them. */
export const CHAT_SUGGESTION_ACTIONS = ['goal.propose', 'world.commitment.from_chat'] as const;
export type ChatSuggestionAction = (typeof CHAT_SUGGESTION_ACTIONS)[number];
export function isChatSuggestion(action: string): action is ChatSuggestionAction {
  return (CHAT_SUGGESTION_ACTIONS as readonly string[]).includes(action);
}

/** The action each kind of suggestion is filed as, the kind of card it is, and the template it is filed under. */
export const SUGGESTION_ACTION = { goal: 'goal.propose', commitment: 'world.commitment.from_chat' } as const satisfies Readonly<Record<string, ChatSuggestionAction>>;
export type SuggestionKind = keyof typeof SUGGESTION_ACTION;
export const SUGGESTION_CARD_KIND = { 'goal.propose': 'goal', 'world.commitment.from_chat': 'tool_call' } as const satisfies Readonly<Record<ChatSuggestionAction, 'goal' | 'tool_call'>>;
export const SUGGESTION_TEMPLATE = { 'goal.propose': 'chat.goal', 'world.commitment.from_chat': 'chat.commitment' } as const satisfies Readonly<Record<ChatSuggestionAction, string>>;

/**
 * How many of each Flint takes from chat in a local day: the cards it files
 * while each one waits for Will, and what it adds on its own once he has
 * signed the promotion table (whose caps are these numbers).
 */
export const SUGGESTIONS_PER_DAY = { 'goal.propose': 3, 'world.commitment.from_chat': 10 } as const satisfies Readonly<Record<ChatSuggestionAction, number>>;

/** A quote shorter than this could be anyone's words; the database refuses one too (proposal_quote_check). */
export const SUGGESTION_QUOTE_MIN = 12;
export const SUGGESTION_QUOTE_MAX = 300;
export const SUGGESTION_TEXT_MIN = 3;
export const SUGGESTION_TEXT_MAX = 120;
/** A chat older than this is not suggested from: an extractor that re-reads history must not bring back last year's plans. */
export const SUGGESTION_MAX_AGE_DAYS = 30;

/**
 * Text as a quote is compared with it, the same on both sides: NFC, curly and
 * prime quote marks straightened, every run of whitespace one space, trimmed.
 * Case and every word are kept: a word added, dropped or changed fails the match.
 */
export function normalizeSaid(s: string): string {
  return s
    .normalize('NFC')
    .replace(/[‘’‚‛′´]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

const WORD = /[\p{L}\p{N}]/u;

/**
 * Is `quote` in what Will wrote, word for word? Both are normalised
 * (normalizeSaid), and the quote may not start or end inside one of his words
 * ("my card" is not in "my cardiologist").
 */
export function saidHolds(said: string, quote: string): boolean {
  const hay = normalizeSaid(said);
  const needle = normalizeSaid(quote);
  if (!needle) return false;
  const startsWord = WORD.test(needle[0]!);
  const endsWord = WORD.test(needle[needle.length - 1]!);
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) {
    const before = hay[i - 1];
    const after = hay[i + needle.length];
    if ((!startsWord || before === undefined || !WORD.test(before)) && (!endsWord || after === undefined || !WORD.test(after))) return true;
  }
  return false;
}

/** Characters as the database counts them (char_length: code points, not UTF-16 units). */
const chars = (s: string): number => [...s].length;

/** Words as they are kept: already in normal form (a text that is not never went through the check), of a set length, with a letter in them. */
const kept = (min: number, max: number) =>
  z
    .string()
    .refine((s) => normalizeSaid(s) === s, 'not in normal form')
    .refine((s) => chars(s) >= min && chars(s) <= max, `not ${min} to ${max} characters`)
    .refine((s) => /\p{L}/u.test(s), 'no words');

/** Will's own words, quoted: 12 to 300 characters. */
export const SuggestionQuote = kept(SUGGESTION_QUOTE_MIN, SUGGESTION_QUOTE_MAX);
/** The goal or the promise in a few words (the local model's, shown to Will as its title). */
export const SuggestionText = kept(SUGGESTION_TEXT_MIN, SUGGESTION_TEXT_MAX);
/** A calendar day, and a real one. */
export const DayOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00.000Z`)) && new Date(`${d}T00:00:00.000Z`).toISOString().slice(0, 10) === d, 'not a real day');
/** A conversation's or a turn's id, as the server names them. */
export const ChatId = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
/** Where a suggestion came from: `chat:` and a sha256 over the conversation, the turn and the quote. Never words. */
export const SourceRef = z.string().regex(/^chat:[0-9a-f]{64}$/);

/** POST /v1/goals/candidates: one suggestion, as the server hands it over. */
export const ChatCandidate = z
  .object({
    kind: z.enum(['goal', 'commitment']),
    text: SuggestionText,
    quote: SuggestionQuote,
    /** Only when Will gave a date. */
    dueOn: DayOnly.optional(),
    conversationId: ChatId,
    turnId: ChatId,
    /** When the turn ended, on the server's clock. */
    sourceAt: IsoMs,
  })
  .strict();
export type ChatCandidate = z.infer<typeof ChatCandidate>;

/** What the runtime did with it: filed a card, added it on its own (once Will signed the promotion), or had it already. */
export const CandidateAnswer = z.object({ outcome: z.enum(['filed', 'added', 'known']) }).strict();
export type CandidateAnswer = z.infer<typeof CandidateAnswer>;

/** A goal.propose card's args: everything Will signs. */
export const GoalProposeArgs = z
  .object({ goalId: GoalId, title: SuggestionText, quote: SuggestionQuote, dueOn: DayOnly.optional(), saidAt: IsoMs, sourceRef: SourceRef })
  .strict();
export type GoalProposeArgs = z.infer<typeof GoalProposeArgs>;
/** A world.commitment.from_chat card's args. */
export const ChatCommitmentArgs = z
  .object({ text: SuggestionText, quote: SuggestionQuote, dueOn: DayOnly.optional(), saidAt: IsoMs, sourceRef: SourceRef })
  .strict();
export type ChatCommitmentArgs = z.infer<typeof ChatCommitmentArgs>;
export const SUGGESTION_ARGS = { 'goal.propose': GoalProposeArgs, 'world.commitment.from_chat': ChatCommitmentArgs } as const satisfies Readonly<Record<ChatSuggestionAction, z.ZodTypeAny>>;

/** The source of a suggestion: the same conversation, turn and quote is always the same one. */
export function suggestionSourceRef(conversationId: string, turnId: string, quote: string): string {
  return `chat:${createHash('sha256').update(`${conversationId}\u0000${turnId}\u0000${normalizeSaid(quote)}`).digest('hex')}`;
}
/** The id of the goal a suggestion becomes, made from its source: filed twice, it is the same goal. */
export function suggestionGoalId(sourceRef: string): string {
  return `go${sourceRef.slice('chat:'.length, 'chat:'.length + 32)}`;
}

/** Words too common to say two texts are about the same thing. */
const STOP = new Set([
  'about', 'after', 'again', 'also', 'been', 'before', 'being', 'could', 'does', 'doing', 'done', 'each', 'every', 'from', 'going', 'have', 'into', 'just', 'like', 'make',
  'more', 'most', 'much', 'need', 'next', 'only', 'over', 'really', 'should', 'some', 'such', 'than', 'that', 'them', 'then', 'there', 'these', 'they', 'this', 'those',
  'want', 'week', 'well', 'were', 'what', 'when', 'which', 'will', 'with', 'would', 'year', 'your',
]);

/** A text's content words: lower case, four letters or more, no stop words. */
export function contentWords(text: string): Set<string> {
  return new Set((normalizeSaid(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => [...w].length >= 4 && !STOP.has(w)));
}
/** How many content words two texts share. */
export function sharedWords(a: string, b: string): number {
  const A = contentWords(a);
  return [...contentWords(b)].filter((w) => A.has(w)).length;
}
