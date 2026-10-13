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
/** A day further ahead than this (ten years) is not a day anyone named: the server drops the suggestion, and the runtime refuses it. */
export const SUGGESTION_MAX_DAYS_AHEAD = 3660;

/**
 * Text as Will is shown it: NFC, every run of whitespace one space, trimmed.
 * Every other character is as he typed it (his apostrophes and quote marks
 * stay his). What a card quotes is in this form.
 */
export function showSaid(s: string): string {
  return s.normalize('NFC').replace(/\s+/g, ' ').trim();
}

/**
 * Text as a quote is compared with it, the same on both sides: showSaid, with
 * curly and prime quote marks straightened. Each mark becomes one mark, so the
 * result is as long as showSaid's and a place in one is the same place in the
 * other. Case and every word are kept: a word added, dropped or changed fails
 * the match.
 */
export function normalizeSaid(s: string): string {
  return showSaid(s)
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u00B4]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"');
}

const WORD = /[\p{L}\p{N}]/u;

/** Where `needle` first sits in `hay` as whole words (both normalised), or -1. */
function whereHeld(hay: string, needle: string): number {
  if (!needle) return -1;
  const startsWord = WORD.test(needle[0]!);
  const endsWord = WORD.test(needle[needle.length - 1]!);
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) {
    const before = hay[i - 1];
    const after = hay[i + needle.length];
    if ((!startsWord || before === undefined || !WORD.test(before)) && (!endsWord || after === undefined || !WORD.test(after))) return i;
  }
  return -1;
}

/**
 * Is `quote` in what Will wrote, word for word? Both are normalised
 * (normalizeSaid), and the quote may not start or end inside one of his words
 * ("my card" is not in "my cardiologist").
 */
export function saidHolds(said: string, quote: string): boolean {
  return whereHeld(normalizeSaid(said), normalizeSaid(quote)) !== -1;
}

/**
 * The whole sentence, or sentences, of what Will wrote that hold `quote`, in
 * his own characters (showSaid): what a card quotes, so that a "not" a few
 * words before the model's excerpt is always on it. A sentence starts at the
 * top of a line, or after a full stop, a question mark, an exclamation mark or
 * an ellipsis that is followed by anything but a lower-case letter ("e.g. so"
 * does not end one). A line that follows one ending in a colon is the rest of
 * that sentence ("I pasted this from the page:" stays on what it introduces).
 * Undefined when the quote is not in his words, or when the
 * sentences that hold it run past `max` characters: a sentence that cannot be
 * shown whole is not quoted in part.
 */
export function saidSentences(said: string, quote: string, max: number = SUGGESTION_QUOTE_MAX): string | undefined {
  const lines = said.split(/[\r\n]+/).map(showSaid).filter(Boolean);
  const shown = lines.join(' ');
  const hay = normalizeSaid(shown);
  const needle = normalizeSaid(quote);
  const at = whereHeld(hay, needle);
  if (at === -1) return undefined;
  const starts = new Set<number>([0]);
  let pos = 0;
  let before = '';
  for (const l of lines) {
    if (!/[:\uFF1A]$/.test(before)) starts.add(pos);
    pos += l.length + 1;
    before = l;
  }
  for (const m of shown.matchAll(/[.!?\u2026]+["'\u2019\u201D)\]]*\s(?!\p{Ll})/gu)) starts.add(m.index + m[0].length);
  const sorted = [...starts].sort((x, y) => x - y);
  const end = at + needle.length;
  const from = sorted.filter((x) => x <= at).pop() ?? 0;
  const to = sorted.find((x) => x >= end) ?? shown.length;
  const out = shown.slice(from, to).trim();
  return chars(out) <= max ? out : undefined;
}

/** Characters as the database counts them (char_length: code points, not UTF-16 units). */
function chars(s: string): number {
  return [...s].length;
}

/**
 * Will's own words, quoted: 12 to 300 characters as the database counts them,
 * in the form he is shown them (showSaid: one that is not never went through
 * the check), with a letter in them and no control character.
 */
export const SuggestionQuote = z
  .string()
  .refine((s) => showSaid(s) === s, 'not in the shown form')
  .refine((s) => chars(s) >= SUGGESTION_QUOTE_MIN && chars(s) <= SUGGESTION_QUOTE_MAX, `not ${SUGGESTION_QUOTE_MIN} to ${SUGGESTION_QUOTE_MAX} characters`)
  .refine((s) => !/\p{Cc}/u.test(s), 'holds a control character')
  .refine((s) => /\p{L}/u.test(s), 'no words');
/**
 * The goal or the promise in a few words (the local model's, shown to Will as
 * its title). Its length is counted as a goal's title is (GoalTitle: 120
 * UTF-16 units at most), so every one that is accepted can be a goal's title.
 * No control or format character: a title never carries a direction override
 * or a zero-width mark, which a card would show as something it is not.
 */
export const SuggestionText = z
  .string()
  .refine((s) => normalizeSaid(s) === s, 'not in normal form')
  .refine((s) => s.length >= SUGGESTION_TEXT_MIN && s.length <= SUGGESTION_TEXT_MAX, `not ${SUGGESTION_TEXT_MIN} to ${SUGGESTION_TEXT_MAX} characters`)
  .refine((s) => !/[\p{Cc}\p{Cf}]/u.test(s), 'holds a control or format character')
  .refine((s) => /\p{L}/u.test(s), 'no words');
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
/**
 * The turn a suggestion came from, by kind: `chat-turn:` and a sha256 over the
 * conversation, the turn and the kind. Once Will has turned a suggestion down,
 * nothing else of that kind is taken from that turn, however it is quoted.
 */
export function suggestionTurnRef(conversationId: string, turnId: string, kind: SuggestionKind): string {
  return `chat-turn:${createHash('sha256').update(`${conversationId}\u0000${turnId}\u0000${kind}`).digest('hex')}`;
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
