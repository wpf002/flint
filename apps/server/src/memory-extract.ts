import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Turn } from '@flint/core';
import { DayOnly, SUGGESTION_MAX_AGE_DAYS, SUGGESTION_MAX_DAYS_AHEAD, SUGGESTION_QUOTE_MAX, SUGGESTION_QUOTE_MIN, SuggestionQuote, SuggestionText, localDay, normalizeSaid, saidHolds, saidSentences } from '@flint/policy';
import { contentTokens, type KnowledgeStore } from './knowledge';

/**
 * Automatic long-term memory.
 *
 * THE PROBLEM THIS SOLVES: `remember` was the only writer to the KnowledgeStore,
 * and it only fires when the model spontaneously elects to call an optional tool
 * while competing with ~38 other schemas. So this re-reads the conversation
 * turns written since the last pass, asks a model to pull out the DURABLE facts
 * about Will, and writes them through `KnowledgeStore.addDetailed` — which
 * dedupes, honours tombstones and rejects ephemeral junk.
 *
 * WHY v1 YIELDED ALMOST NOTHING (measured on the live store, 2026-09-23): of
 * 1,478 stored turns only 638 were complete, and 417 of those were synthetic
 * training-corpus prompts (bulk-/grow-/seed- conversations: "how does a
 * catalytic converter work?") — pure spend, zero facts about Will. Of the ~221
 * real turns, most were repeated probes ("weather in Dallas right now" ×40,
 * "say OK"). The few fact-bearing turns were judged one at a time with no
 * surrounding context ("September 25–October 3 is when it's scheduled to be
 * delivered" is meaningless without the previous turn), through Flint's full
 * persona system prompt, under an instruction that an empty array is "the
 * common answer", and prose or truncated output silently parsed as [] while the
 * watermark advanced anyway. Net: 2 facts from the whole backlog.
 *
 * v2: skip synthetic conversations and trivial/duplicate probes, give each turn
 * its preceding turn as context, extract with a dedicated curator system prompt
 * (not the persona), show the model the facts it already has so it can SUPERSEDE
 * stale ones instead of piling contradictions, record provenance (conversation +
 * turn time), never advance past a batch whose output could not be parsed, and
 * cap calls per day. Bumping EXTRACT_VERSION re-walks old turns under the new
 * rules — resumable via the per-conversation watermarks, rate-limited by the
 * daily call budget, and idempotent because the store dedupes.
 *
 * ON THE LOCAL MODEL (2026-10): extraction used to run only on the frontier
 * primary tier, so with no API key it never ran, and with the provider down
 * every retry spent the day's calls. It now runs on the local Ollama model by
 * default (./memory-brain); the frontier is an explicit opt-in
 * (FLINT_MEMORY_BRAIN=frontier), never a fallback. A local model is less
 * precise, so:
 *  - its reply is held to FACTS_SCHEMA (Ollama's `format`, then factsReply);
 *  - every fact carries `quote`, Will's own words it rests on, and is dropped
 *    unless that quote is in a WILL line of the turns it was given, as whole
 *    words, and that line also holds most of what the fact says. An
 *    assistant's words never ground a fact (locateQuote).
 *  - a fact may retire only a known fact the model was shown, and only one
 *    about the same thing (store).
 *  - a pass yields to Will's chat (`chatActive`): it waits while a turn runs or
 *    has just ended, and the local brain cuts off a request a new turn would
 *    wait behind. A deferral moves no watermark and spends none of the day's
 *    calls.
 *  - a call with no answer at all (Ollama down, the model not pulled) moves no
 *    watermark, spends none of the day's calls, and backs the next pass off.
 *    Nor does an outage the server reports (502, 503, 504). Any other error it
 *    answers with, or running out of time, is a strike against the batch; 3
 *    strikes halve the batch, and only a single turn is ever skipped, so one
 *    bad turn can't stall everything behind it and an outage that fails every
 *    batch costs at most a turn at a time. A reply cut off at its token limit
 *    is asked again with half the turns.
 * Logs carry ids and counts only: never a fact, a quote or transcript text.
 *
 * GOALS AND COMMITMENTS FROM CHAT (P3 part 5; FLINT_EXTRACT_CANDIDATES=1, off
 * by default; commitments also need FLINT_EXTRACT_COMMITMENTS=1). With it on,
 * the LOCAL model is also asked for any goal Will set (and, with the second
 * setting, anything he said he would do), each with his own words quoted.
 *  - Only a model on this Mac is asked, and that is asked again at every pass
 *    (`candidates` is a question, ./goal-candidates): the frontier's prompt
 *    never changes and a suggestion in its reply is never read; a local model
 *    that turns out to run elsewhere (a cloud-backed name, an Ollama on another
 *    machine) is asked for facts alone. With it off the prompt is byte for
 *    byte what it was, and nothing is filed.
 *  - The quote check comes first and is deterministic: a suggestion is kept
 *    only if its quote, 12 to 300 characters, is in Will's OWN message of the
 *    turn it names (@flint/policy saidHolds: curly quotes and runs of
 *    whitespace made alike on both sides, every word kept). Never the
 *    assistant's words, never the earlier turn shown for context, never
 *    another turn of the batch. A tainted turn is never sent at all.
 *  - What is handed on is not the model's excerpt but the WHOLE sentence (or
 *    sentences) of his that holds it, in his own characters (saidSentences):
 *    a "not" a few words before the excerpt is then always on the card. A
 *    sentence over 300 characters cannot be shown whole, so it is not used.
 *    One sentence gives one suggestion: a second quote that overlaps one
 *    already kept from the same turn is dropped.
 *  - Its short text must be his too: most of its words, and every number in
 *    it, are in that same message; no control or format character. A day is
 *    the model's reading of his words (the card says so): a real one, not
 *    before the turn and not over ten years out.
 *  - What is kept is handed to `onCandidate` (./goal-candidates: the runtime on
 *    this Mac, which checks it again and files the card). Nothing is kept here.
 *  - What is dropped is counted by reason (`rejected`), never logged as text.
 *  - Nothing in this step can stall or repeat the facts: a failure in it is
 *    counted, and the pass goes on.
 */

/**
 * A brain's reply: */

/**
 * A brain's reply: `facts`, already checked against FACTS_SCHEMA (the local
 * model's), or `text` for the extractor to parse (the frontier's).
 */
export type BrainReply = { facts: FactEntry[]; suggestions?: unknown[] } | { text: string };

/**
 * The model a pass asks: the local Ollama model by default, the frontier only
 * when Will opts in (./memory-brain). `generate` throws a MemoryBrainError when
 * it has no usable reply; anything else it throws counts as `unavailable`.
 */
/** What a call may ask for beside facts: goals alone, or goals and commitments. */
export type Suggesting = 'goals' | 'all';

export interface ExtractBrain {
  /** `suggestions`: the prompt also asks for goals (and commitments, with `all`), so the reply is held to the schema with them (the local brain only). */
  generate(input: { system: string; prompt: string; suggestions?: Suggesting }): Promise<BrainReply>;
  /**
   * Characters of system prompt + prompt one call can hold: a local model's
   * context window less its reply. Unset, a call is sized by batchChars alone.
   */
  promptChars?: number;
}

/**
 * Why a brain has no usable reply, and what the pass does about it:
 *  - deferred: Will's chat needs the model (nothing ran, or the request was cut
 *    off). The pass stops, the call isn't one of the day's, and the next pass
 *    comes in deferMs.
 *  - unavailable: no answer at all (the server unreachable), or one that says
 *    it can't serve anyone right now (404: the model isn't pulled; 429; 502,
 *    503, 504: busy or down). Not the batch's fault: no strike, the call isn't
 *    one of the day's, and the next pass backs off.
 *  - server-error: the server answered with another error status (a 4xx, a
 *    500). It may be this batch: a strike, the call counts, and it backs off.
 *  - timeout: the model was still working when the call's time ran out. The
 *    same as server-error.
 *  - truncated: the reply hit its token limit. The batch is asked again at half
 *    its turns; a single turn still cut off is a strike.
 *  - invalid: it replied, but not in FACTS_SCHEMA's shape. A strike.
 * Three strikes in a row against the same batch halve it (the next try sends
 * half its turns, and the count starts over); three against a single turn
 * skip that turn.
 */
export type BrainFailure = 'deferred' | 'unavailable' | 'server-error' | 'timeout' | 'truncated' | 'invalid';

export class MemoryBrainError extends Error {
  /** `detail`: what the last request failed with, as a kind and status ("validation 404"), never a message. */
  constructor(
    readonly why: BrainFailure,
    readonly detail?: string,
  ) {
    super(`memory brain: ${why}`);
    this.name = 'MemoryBrainError';
  }
}

/** The slice of PersistentStore the extractor reads. */
export interface TurnSource {
  conversationIds(): string[];
  getTurns(conversationId: string): Promise<Turn[]>;
}

/** Bump when extraction rules change enough to be worth re-reading history. */
export const EXTRACT_VERSION = 2;

interface ExtractState {
  version: number;
  /** Highest turn `updatedAt` already processed, per conversation. */
  watermarks: Record<string, number>;
  /** Model calls made on `day` (UTC date): dollars on the frontier, GPU time on the local model. */
  budget: { day: string; calls: number };
  /**
   * Strikes in a row against the batch starting at `key`, and `cap`: how many
   * turns that batch may send, once strikes have halved it.
   */
  failures?: { key: string; count: number; cap?: number };
  /** Lifetime counters, for anyone asking "is memory actually growing?". */
  totals: PassStats;
}

export interface PassStats {
  turnsSeen: number;
  skippedSynthetic: number;
  skippedTrivial: number;
  skippedDuplicate: number;
  /** Turns that read untrusted text (./conversation-taint): never mined for facts. */
  skippedTainted: number;
  turnsSent: number;
  calls: number;
  /** Times the pass waited for Will's chat: a call not made, or cut off. */
  deferred: number;
  /** Calls with no answer (unavailable), an error answer (server-error) or none in time (timeout). */
  failed: number;
  /** Calls whose reply hit its token limit. */
  truncated: number;
  unparseable: number;
  candidates: number;
  stored: number;
  superseded: number;
  /** Supersedes refused: an id the model wasn't shown, or a fact about something else. */
  supersedeRefused: number;
  /** Goals and commitments the local model proposed (FLINT_EXTRACT_CANDIDATES), those whose quote was Will's own, and those the runtime filed. */
  suggested: number;
  suggestionsKept: number;
  suggestionsFiled: number;
  rejected: Record<string, number>;
}

function emptyStats(): PassStats {
  return {
    turnsSeen: 0,
    skippedSynthetic: 0,
    skippedTrivial: 0,
    skippedDuplicate: 0,
    skippedTainted: 0,
    turnsSent: 0,
    calls: 0,
    deferred: 0,
    failed: 0,
    truncated: 0,
    unparseable: 0,
    candidates: 0,
    stored: 0,
    superseded: 0,
    supersedeRefused: 0,
    suggested: 0,
    suggestionsKept: 0,
    suggestionsFiled: 0,
    rejected: {},
  };
}

export const EXTRACT_SYSTEM = `You are the memory curator for Flint, Will's personal AI. You read transcripts of Will talking to Flint and write the durable facts Flint should still know about Will months from now. You never chat; you output JSON only.`;

export const FACT_CATEGORIES = ['project', 'system', 'preference', 'person', 'hardware', 'goal', 'decision', 'other'] as const;

const EXTRACT_PROMPT = `Extract DURABLE FACTS about Will from the conversation turns below.

Worth keeping — anything specific that would still be true and useful months from now:
- his projects and systems: what they are, what they do, how they're built, their status and decisions about them
- his preferences, habits, constraints, and opinions he stated
- people in his life or work (names and how they relate to him)
- hardware, accounts, tools and services he owns or uses
- goals and plans he committed to (with the target date if he gave one)

Rules:
- Only what WILL said or clearly confirmed. The assistant's answers are context, not evidence: never turn an assistant claim, guess or search result into a fact about Will.
- Every fact needs "quote": the words of Will's it rests on, copied exactly from a WILL line (a few words up to one sentence). Never quote ASSISTANT text. If you can't quote Will saying it, leave the fact out.
- Never infer or embellish personal details. "My team is the Astros" is a fact; guessing his pets, family or tastes from a question he asked is not.
- A question is not a fact. "Will asked about UFC 329" is worthless; skip it.
- No expiring details: weather, prices, scores, what he's doing today, "right now", "currently".
- Nothing about Flint's own behaviour, tests, bugs or this extraction task.
- Each fact is ONE standalone sentence in the third person naming Will ("Will's friend Tanner …", not "he" or "my"). Be specific: include names, numbers, dates he gave.
- Do not repeat a KNOWN FACT. If a turn UPDATES or CONTRADICTS a known fact, write the corrected fact and put the old fact's id in "supersedes": ids from KNOWN FACTS only, never one you made up. Otherwise "supersedes" is [].
- {"facts": []} is correct when a batch has nothing durable. Do not pad.

Output ONLY a JSON object, no prose, no code fence:
{"facts": [{"turn": <number of the turn it came from>, "quote": "<Will's exact words>", "fact": "...", "category": "${FACT_CATEGORIES.join('|')}", "supersedes": []}]}`;

/**
 * Added to EXTRACT_PROMPT only when suggestions are asked for
 * (FLINT_EXTRACT_CANDIDATES, a model on this Mac). With it off, the prompt is
 * EXTRACT_PROMPT alone, byte for byte. Goals alone, or goals and commitments
 * (FLINT_EXTRACT_COMMITMENTS): one text for both, so the two cannot drift.
 */
function suggestPrompt(all: boolean): string {
  return `

ALSO list under "suggestions" any GOAL Will set for himself${all ? ', and anything he said HE WILL DO,' : ''} in these turns. Most batches have none: then "suggestions" is [].
- "kind": ${all ? '"goal" for something he is working toward; "commitment" for something he said he will do.' : 'always "goal": something he is working toward.'}
- "quote": his exact words, copied from the WILL line of that turn (the whole sentence). Never ASSISTANT text, and never the "(earlier in this conversation …)" line.
- "text": the goal${all ? ' or the promise' : ''} in a few of his own words (3 to 120 characters), with no date in it.
- "dueOn": the day he named, as YYYY-MM-DD, or "" when he named none. Never guess one.
- Not a suggestion: a question, an idea he is only weighing, something he said he will NOT do, something the assistant proposed, something another person will do, something already done, words of someone else that he pasted or repeated.
With them the JSON object is:
{"facts": [...], "suggestions": [{"turn": <number of the turn>, "kind": "${all ? 'goal|commitment' : 'goal'}", "quote": "<Will's exact words>", "text": "...", "dueOn": ""}]}`;
}
export const SUGGEST_PROMPT = suggestPrompt(true);
export const SUGGEST_GOALS_PROMPT = suggestPrompt(false);
/** The lines a call adds for what it asks. */
export const suggestLines = (asking: Suggesting): string => (asking === 'all' ? SUGGEST_PROMPT : SUGGEST_GOALS_PROMPT);

/**
 * The reply EXTRACT_PROMPT asks for, as a JSON schema: Ollama's `format` holds
 * the local model to it. `quote` comes before `fact`, so the model commits to
 * Will's words first and then says what they mean.
 */
export const FACTS_SCHEMA = {
  type: 'object',
  properties: {
    facts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          turn: { type: 'integer', minimum: 1 },
          quote: { type: 'string', maxLength: 300 },
          fact: { type: 'string', maxLength: 400 },
          category: { type: 'string', enum: [...FACT_CATEGORIES] },
          supersedes: { type: 'array', items: { type: 'string' } },
        },
        required: ['turn', 'quote', 'fact', 'category', 'supersedes'],
        additionalProperties: false,
      },
    },
  },
  required: ['facts'],
  additionalProperties: false,
} as const;

export interface FactEntry {
  turn: number;
  quote: string;
  fact: string;
  category: string;
  supersedes: string[];
}

/** FACTS_SCHEMA and the suggestions the added lines ask for: `quote` before `text`, as a fact's is. */
function suggestionsSchema<K extends readonly string[]>(kinds: K) {
  return {
    type: 'object',
    properties: {
      facts: FACTS_SCHEMA.properties.facts,
      suggestions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            turn: { type: 'integer', minimum: 1 },
            kind: { type: 'string', enum: [...kinds] },
            quote: { type: 'string', maxLength: 300 },
            text: { type: 'string', maxLength: 120 },
            dueOn: { type: 'string', maxLength: 10 },
          },
          required: ['turn', 'kind', 'quote', 'text', 'dueOn'],
          additionalProperties: false,
        },
      },
    },
    required: ['facts', 'suggestions'],
    additionalProperties: false,
  } as const;
}
/** Goals and commitments (SUGGEST_PROMPT). */
export const SUGGESTIONS_SCHEMA = suggestionsSchema(['goal', 'commitment'] as const);
/** Goals alone (SUGGEST_GOALS_PROMPT): the model cannot answer with a commitment. */
export const GOAL_SUGGESTIONS_SCHEMA = suggestionsSchema(['goal'] as const);
/** The schema a call's reply is held to. */
export const suggestSchema = (asking: Suggesting) => (asking === 'all' ? SUGGESTIONS_SCHEMA : GOAL_SUGGESTIONS_SCHEMA);

/** A reply's suggestions, as they came: an array, or none. Each entry is checked on its own (suggestionOf). */
export function suggestionsReply(v: unknown): unknown[] {
  return isRecord(v) && Array.isArray(v.suggestions) ? v.suggestions : [];
}

/** One proposed suggestion, read tolerantly: undefined when it is not the shape (it is dropped; the facts beside it are kept). */
export function suggestionOf(e: unknown): { turn: number; kind: 'goal' | 'commitment'; quote: string; text: string; dueOn: string } | undefined {
  if (!isRecord(e)) return undefined;
  const { turn, kind, quote, text, dueOn } = e;
  if (typeof turn !== 'number' || !Number.isInteger(turn) || turn < 1) return undefined;
  if (kind !== 'goal' && kind !== 'commitment') return undefined;
  if (typeof quote !== 'string' || typeof text !== 'string') return undefined;
  if (dueOn !== undefined && dueOn !== null && typeof dueOn !== 'string') return undefined;
  return { turn, kind, quote, text, dueOn: typeof dueOn === 'string' ? dueOn.trim() : '' };
}

/** A goal or commitment whose quote is Will's own, as it is handed on (./goal-candidates). */
export interface ChatSuggestion {
  kind: 'goal' | 'commitment';
  /** The goal or the promise in a few words (the local model's). */
  text: string;
  /** Will's own words: the whole sentence or sentences of his message that hold what the model quoted, in his own characters (saidSentences). */
  quote: string;
  dueOn?: string;
  conversationId: string;
  turnId: string;
  /** When the turn ended. */
  sourceAt: number;
  /** The turn stays on this Mac (it carried Will's goals): so does everything about this suggestion. */
  staysHere: boolean;
}
/** What became of one: `filed` (a card, or added under a signed rule), or why not. A reason is a word, never text. */
export type SuggestionOutcome = 'filed' | 'known' | 'refused' | 'capped' | 'unreachable' | 'held';

/**
 * A reply checked against FACTS_SCHEMA's types and required fields, or null
 * when it doesn't match (a schema mismatch: the reply is unusable, not empty).
 * Lengths and the category list are left to the filters downstream, so one
 * over-long fact doesn't cost the whole batch.
 */
export function factsReply(v: unknown): { facts: FactEntry[] } | null {
  if (!isRecord(v) || !Array.isArray(v.facts)) return null;
  const facts: FactEntry[] = [];
  for (const e of v.facts) {
    if (!isRecord(e)) return null;
    const { turn, quote, fact, category, supersedes } = e;
    if (typeof turn !== 'number' || !Number.isInteger(turn) || turn < 1) return null;
    if (typeof quote !== 'string' || typeof fact !== 'string' || typeof category !== 'string') return null;
    if (!Array.isArray(supersedes) || !supersedes.every((s): s is string => typeof s === 'string')) return null;
    facts.push({ turn, quote, fact, category, supersedes });
  }
  return { facts };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

interface Item {
  cid: string;
  at: number;
  /** Non-empty when this turn is sent to the model. */
  chunk: string;
  /** This turn's id, and Will's own message in it, whole (SAID_CHARS at most): what a suggestion's quote must be in. Never the turn before, never the answer. */
  turnId?: string;
  said?: string;
  skip?: 'synthetic' | 'trivial' | 'duplicate' | 'tainted';
  /** Will's words as the model is shown them (this turn's, then the previous turn's): what a quote must come from. */
  will?: string[];
  /** The assistant's words as shown: a quote found only here grounds nothing. */
  assistant?: string[];
  /**
   * This turn, or the earlier one shown with it, was answered with Will's
   * goals in its context. What is learned from it stays on this Mac
   * (KnowledgeStore `fromGoals`), and it never shares a call with a turn that
   * was not.
   */
  goals?: boolean;
  /**
   * This turn, or the earlier one shown with it, is one Will kept private
   * (./private-turns). What is learned from it stays on this Mac too
   * (KnowledgeStore `fromPrivate`, which no setting sends out), and it shares
   * a call only with turns that carry the same marks.
   */
  private?: boolean;
  /**
   * ...and it (or the earlier one shown with it) is one he ASKED to keep
   * private, not one that only Local mode kept (./private-turns
   * privateByRequest). A call that holds such a turn is never asked for a
   * goal; in a pass that asks, it never shares a call with a turn that may be.
   */
  byRequest?: boolean;
}

/** How closely what is learned from this turn is held, like a fact's own marks (./knowledge): 0, 1 for Will's goals, 2 for a private turn. */
const heldAs = (it: { goals?: boolean; private?: boolean }): 0 | 1 | 2 => (it.private ? 2 : it.goals ? 1 : 0);

/** Chars of a turn's own text, and of the previous turn's, that the model is shown. */
const WILL_CHARS = 1500;
const ASSISTANT_CHARS = 600;
const CONTEXT_CHARS = 300;
/** Will's own message, as a suggestion's quote is looked for in it: all of it, up to this (the model is shown WILL_CHARS). */
const SAID_CHARS = 8000;
/** Suggestions read from one reply, at most: a reply that lists more is a model gone wrong. */
const SUGGESTIONS_PER_CALL = 5;
/** Known facts shown per call, at most. */
const KNOWN_CAP = 150;
/** "### Turn N (YYYY-MM-DD)" and the blank lines around it, per turn. */
const TURN_HEADER = 40;
/** The prompt's labels around the facts and the turns. */
const PROMPT_FRAME = 200;
/** In a bounded window: the known facts' share of what the instructions leave. */
const KNOWN_SHARE = 0.35;
/** A batch never gets less than this, however small the window. */
const MIN_BATCH_CHARS = 1000;
/** Strikes in a row against a batch before it is halved (or, a single turn, skipped). */
const STRIKES = 3;

/** What one call can give: the transcript (batchChars), the known facts, and at most one turn (turnChars, the window's limit). */
interface Room {
  batchChars: number;
  knownChars: number;
  turnChars: number;
}

export interface ExtractorOptions {
  /**
   * Which brain the pass asks, for its defaults and its log lines. `local`
   * (the default): batches of 8,000 chars and 48 calls a day, since a local
   * model is slower and its time is Will's chat's too. `frontier`: 24,000 and 24.
   */
  kind?: 'local' | 'frontier';
  /** Base interval between passes. */
  everyMs?: number;
  /** Interval while a backlog remains and the day's budget isn't spent. */
  backlogEveryMs?: number;
  /** Interval while Will is chatting (see chatActive). */
  deferMs?: number;
  /** Turns sent per pass. */
  maxTurnsPerPass?: number;
  /** Model calls per UTC day: the spend cap on the frontier, the GPU cap on the local model. */
  maxCallsPerDay?: number;
  /** Prompt characters of transcript per call. */
  batchChars?: number;
  /** Conversations never mined — synthetic training-corpus traffic. */
  skipConversations?: RegExp;
  /**
   * Why optional frontier work must wait right now, or undefined to go ahead.
   * The server passes the spend guard's check when extraction is on the
   * frontier (paused at 80% of the vendor's cap: extraction is background work,
   * so it yields before Will's own turns do). Checked before EVERY call, so a
   * pass that crosses the line mid-way stops at the next batch and keeps the
   * progress it already paid for.
   */
  gate?: () => string | undefined;
  /**
   * Why a pass must not run at all right now, or undefined to go ahead. The
   * server passes "where the extractor's own model runs is not known yet"
   * (./goals-chat extractor). Until it is known, a turn that stays on this Mac
   * cannot be told from one this brain may never read, and a turn that is
   * skipped is a turn never mined: so the whole pass waits, and comes back
   * soon (as soon as a first pass would run). Said in the log once, not at
   * every check.
   */
  holdOff?: () => string | undefined;
  /**
   * Is Will chatting right now (./memory-brain liveChat: a /chat turn in
   * flight, or one that ended moments ago)? The local model is his first: a
   * pass checks before every call, and waits `deferMs` while he is.
   */
  chatActive?: () => boolean;
  /**
   * Did this turn read untrusted text (a web page, a Nexus thread, mail)? Such a
   * turn is never mined: a fact lifted from it would come back through recall
   * into later, untainted turns.
   */
  isTainted?: (conversationId: string, turnId: string) => boolean;
  /**
   * Was this turn answered with Will's goals in its context (./goals-now)? A
   * fact learned from such a turn is stored with that mark, and is then
   * recalled only for a brain that may read his goals. Such turns are sent in
   * calls of their own, and only those calls are shown the known facts that
   * carry the mark: a call about any other turn holds nothing that stays here.
   */
  carriedGoals?: (conversationId: string, turnId: string) => boolean;
  /**
   * Is this turn one Will kept private (./private-turns: Local Only, the
   * words, any turn of Local mode)? A fact learned from it is stored with that
   * mark and recalled only for a brain on this Mac. Like the goals turns, such
   * turns are sent in calls of their own, and only those calls are shown the
   * known facts that carry the mark.
   */
  keptPrivate?: (conversationId: string, turnId: string) => boolean;
  /**
   * Of the turns he kept private: is this one kept by his own word for it (the
   * Local Only switch, or a message that asked to stay private), and not only
   * because Flint was in Local mode (./private-turns privateByRequest)? Such a
   * turn is never asked for a goal. Left out: every turn he kept private is
   * read as one he asked to.
   */
  privateByRequest?: (conversationId: string, turnId: string) => boolean;
  /**
   * Send a call as one that carries text which stays on this Mac (the server
   * passes ./goals-chat keptText). A call about turns answered with Will's
   * goals, or turns he kept private, is made through it: where the request is
   * sent, it goes only to a model the model server lists as its own at that
   * moment (./inference helperFetch). `isTainted` read what was known when the
   * pass began. Default: sent as it is.
   */
  kept?: <T>(send: () => T) => T;
  /**
   * Also ask for the goals Will set (FLINT_EXTRACT_CANDIDATES=1). Only with
   * the local brain (`kind` local) and somewhere to hand them (`onCandidate`):
   * otherwise it is off, and the prompt is what it always was. And never of a
   * call about a turn he asked to keep private (`privateByRequest`): those are
   * asked for facts alone. A turn taken in Local mode is asked like any other. Given as a
   * question, it is asked again at the start of every pass (does the model
   * run on this Mac right now?): a pass it says no to asks for facts alone.
   */
  candidates?: boolean | (() => boolean);
  /** And the things he said he would do (FLINT_EXTRACT_COMMITMENTS=1). Off: goals alone are asked for, and a commitment in a reply is dropped. */
  commitments?: boolean;
  /** One suggestion whose quote is Will's own: hand it on, and say what became of it. Its words are never logged. */
  onCandidate?: (s: ChatSuggestion) => Promise<SuggestionOutcome>;
  /** Will's zone, for "has the day the model read passed". */
  tz?: string;
  now?: () => number;
}

export class MemoryExtractor {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private stopped = true;
  private readonly kind: 'local' | 'frontier';
  private readonly firstPassMs: number;
  private readonly everyMs: number;
  private readonly backlogEveryMs: number;
  private readonly deferMs: number;
  private readonly maxTurnsPerPass: number;
  private readonly maxCallsPerDay: number;
  private readonly batchChars: number;
  private readonly skipConversations: RegExp;
  private readonly gate: (() => string | undefined) | undefined;
  private readonly holdOff: (() => string | undefined) | undefined;
  /** What the pass is waiting for, while it is held off (so the log says it once). */
  private heldFor: string | undefined;
  /** How often a held-off pass checks again: as soon as a first pass would run, and never less often than a deferred one. */
  private get heldEveryMs(): number {
    return Math.min(this.deferMs, this.firstPassMs);
  }
  private readonly chatActive: (() => boolean) | undefined;
  private readonly isTainted: (conversationId: string, turnId: string) => boolean;
  private readonly carriedGoals: (conversationId: string, turnId: string) => boolean;
  private readonly keptPrivate: (conversationId: string, turnId: string) => boolean;
  private readonly privateByRequest: (conversationId: string, turnId: string) => boolean;
  private readonly kept: <T>(send: () => T) => T;
  private readonly candidates: boolean;
  private readonly mayPropose: () => boolean;
  private readonly commitments: boolean;
  private readonly onCandidate: ((s: ChatSuggestion) => Promise<SuggestionOutcome>) | undefined;
  private readonly tz: string;
  private readonly now: () => number;
  /** Whether the last pass left work queued (drives the faster backlog cadence). */
  private backlog = false;
  /** Whether the last pass waited for Will's chat. */
  private deferred = false;
  /** Passes in a row that waited for Will's chat (only the first is logged). */
  private deferStreak = 0;
  /** Passes in a row that ended on a call with no reply (backs the cadence off). */
  private failStreak = 0;
  lastStats: PassStats = emptyStats();

  constructor(
    private readonly memory: TurnSource,
    private readonly knowledge: KnowledgeStore,
    private readonly brain: ExtractBrain,
    private readonly statePath: string,
    opts: ExtractorOptions = {},
  ) {
    const env = (k: string, d: number) => {
      const v = Number(process.env[k]);
      return Number.isFinite(v) && v > 0 ? v : d;
    };
    this.kind = opts.kind ?? 'local';
    const local = this.kind === 'local';
    // How long after boot the first pass runs. A minute and a half by default: the server has settled by then.
    this.firstPassMs = env('FLINT_EXTRACT_FIRST_PASS_MS', 90_000);
    this.everyMs = opts.everyMs ?? env('FLINT_EXTRACT_INTERVAL_MS', 6 * 60 * 60 * 1000);
    this.backlogEveryMs = opts.backlogEveryMs ?? env('FLINT_EXTRACT_BACKLOG_INTERVAL_MS', 15 * 60 * 1000);
    this.deferMs = opts.deferMs ?? 2 * 60 * 1000;
    this.maxTurnsPerPass = opts.maxTurnsPerPass ?? env('FLINT_EXTRACT_MAX_TURNS', 60);
    this.maxCallsPerDay = opts.maxCallsPerDay ?? env('FLINT_EXTRACT_MAX_CALLS_PER_DAY', local ? 48 : 24);
    this.batchChars = opts.batchChars ?? env('FLINT_EXTRACT_BATCH_CHARS', local ? 8_000 : 24_000);
    this.skipConversations =
      opts.skipConversations ?? new RegExp(process.env.FLINT_EXTRACT_SKIP_CONVERSATIONS ?? '^(bulk|grow|seed)-');
    this.gate = opts.gate;
    this.holdOff = opts.holdOff;
    this.chatActive = opts.chatActive;
    this.isTainted = opts.isTainted ?? (() => false);
    this.carriedGoals = opts.carriedGoals ?? (() => false);
    this.keptPrivate = opts.keptPrivate ?? (() => false);
    this.privateByRequest = opts.privateByRequest ?? this.keptPrivate;
    this.kept = opts.kept ?? ((send) => send());
    // Goals and commitments are asked of the local model alone, and only with somewhere to hand them.
    const asked = opts.candidates;
    this.candidates = (asked === true || typeof asked === 'function') && local && opts.onCandidate !== undefined;
    this.mayPropose = typeof asked === 'function' ? asked : () => asked === true;
    this.commitments = opts.commitments === true;
    this.onCandidate = this.candidates ? opts.onCandidate : undefined;
    this.tz = safeZone(opts.tz);
    this.now = opts.now ?? Date.now;
  }

  /** Is this extractor set up to ask its model for suggestions (whether a given pass does is asked then: `asks`)? */
  get suggests(): boolean {
    return this.candidates;
  }

  /**
   * What the next call would ask for beside facts: nothing, goals, or goals
   * and commitments. Asked once a pass, so a model that is not on this Mac
   * (or stops being) is asked for facts alone. A question that throws is a no.
   */
  asks(): Suggesting | undefined {
    if (!this.candidates) return undefined;
    let here = false;
    try {
      here = this.mayPropose() === true;
    } catch {
      here = false;
    }
    return here ? (this.commitments ? 'all' : 'goals') : undefined;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    // First pass shortly after boot (FLINT_EXTRACT_FIRST_PASS_MS). Unref'd so it never holds the process open.
    this.schedule(this.firstPassMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /**
   * How long until the next pass, as the last one left things: soon while Will
   * is chatting, backed off (doubling up to the base interval) while the model
   * gives no reply, faster while a backlog remains.
   */
  get nextDelayMs(): number {
    // Held off until the model server has said where the model runs: that is usually moments away (the server
    // has just started), so the next check comes as soon as a first pass would.
    if (this.heldFor !== undefined) return this.heldEveryMs;
    if (this.deferred) return this.deferMs;
    if (this.failStreak > 0) return Math.min(this.everyMs, this.backlogEveryMs * 2 ** (this.failStreak - 1));
    return this.backlog ? this.backlogEveryMs : this.everyMs;
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.runSafe().finally(() => this.schedule(this.nextDelayMs));
    }, ms);
    this.timer.unref?.();
  }

  private async runSafe(): Promise<void> {
    try {
      await this.run();
    } catch (err) {
      console.error(`[memory-extract] pass failed: ${errorKind(err)}`);
    }
  }

  /**
   * One extraction pass. Returns how many new facts were stored.
   *
   * Takes the OLDEST unprocessed turns up to the per-pass cap (and the day's call
   * budget) and advances each conversation's watermark only over what it
   * actually handled, so the backlog is worked off a slice at a time and an
   * interrupted pass loses at most one batch.
   */
  async run(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      return await this.pass();
    } finally {
      this.running = false;
    }
  }

  private async pass(): Promise<number> {
    const stats = emptyStats();
    this.lastStats = stats;
    this.deferred = false;

    const state = this.loadState();
    const today = new Date(this.now()).toISOString().slice(0, 10);
    if (state.budget.day !== today) state.budget = { day: today, calls: 0 };

    // The cheap checks first: none of them needs the history, and reading all
    // of it (every turn, cloned) while Will chats would be work for nothing.
    const held = this.holdOff?.();
    if (held) {
      // Nothing is read and nothing is skipped: the turns wait, and the next check comes soon.
      if (this.heldFor !== held) console.error(`[memory-extract] waiting: ${held}; checking again every ${this.heldEveryMs < 60_000 ? `${Math.round(this.heldEveryMs / 1000)} s` : minutes(this.heldEveryMs)}`);
      this.heldFor = held;
      this.deferred = true;
      this.saveState(state);
      return 0;
    }
    this.heldFor = undefined;
    const paused = this.gate?.();
    if (paused) {
      console.error(`[memory-extract] paused (${paused})`);
      this.backlog = false; // nothing to do until the budget allows; base cadence
      this.saveState(state);
      return 0;
    }
    if (this.chatActive?.()) {
      this.defer(stats);
      state.totals.deferred++; // only that: nothing else happened
      this.saveState(state);
      return 0;
    }
    if (state.budget.calls >= this.maxCallsPerDay) {
      console.error(`[memory-extract] daily budget spent (${state.budget.calls}/${this.maxCallsPerDay} calls)`);
      this.backlog = false; // nothing to do until tomorrow; base cadence
      this.saveState(state);
      return 0;
    }

    const pending = await this.collect(state, stats);
    if (pending.length === 0) {
      this.backlog = false;
      this.deferStreak = 0;
      this.failStreak = 0;
      this.saveState(state);
      return 0;
    }

    // Asked once, for the whole pass: every call of it is sized and worded alike.
    const asking = this.asks();
    const room = this.room(asking);
    let sent = 0;
    let idx = 0;
    let gated: string | undefined;
    let failure: { why: BrainFailure; detail?: string } | undefined;
    /**
     * Turns a batch may send: halved after a reply cut off at its token limit,
     * and kept for the rest of the pass (the turns that follow are as dense).
     */
    let turnCap = Infinity;
    try {
      while (idx < pending.length) {
        // Assemble the next batch: skipped items ride along (they only move the
        // watermark), sent items fill up to the char budget.
        const batch: Item[] = [];
        let chars = 0;
        let turns = 0;
        // A call is all turns with the same marks (answered with Will's goals, kept private, both, neither): what
        // is learned from a marked turn stays on this Mac under its marks, and a call that mixed them could not
        // say which fact came from where.
        let marks: string | undefined;
        // (A pass that asks for goals also keeps the turns he asked to keep private apart from the ones Local mode
        // kept: the first are never asked, the second are. A pass that asks for facts alone batches as it always did.)
        const marksOf = (it: Item) => `${it.goals ? 'g' : ''}${it.private ? 'p' : ''}${asking && it.byRequest ? 'r' : ''}`;
        // A batch that strikes have halved keeps that size until it goes through.
        const head = pending.slice(idx).find((it) => !it.skip);
        const struck = head && state.failures?.key === `${head.cid}@${head.at}` ? state.failures.cap : undefined;
        const cap = Math.min(turnCap, struck ?? Infinity);
        let j = idx;
        while (j < pending.length) {
          const it = pending[j]!;
          if (!it.skip) {
            if (sent + turns >= this.maxTurnsPerPass || turns >= cap) break;
            if (marks !== undefined && marks !== marksOf(it)) break;
            const size = it.chunk.length + TURN_HEADER;
            if (chars > 0 && chars + size > room.batchChars) break;
            chars += size;
            turns++;
            marks = marksOf(it);
          }
          batch.push(it);
          j++;
        }
        if (batch.length === 0) break; // per-pass cap reached
        const toSend = batch.filter((b) => !b.skip);

        if (toSend.length > 0) {
          if (state.budget.calls >= this.maxCallsPerDay) break;
          gated = this.gate?.();
          if (gated) break;
          if (this.chatActive?.()) {
            this.defer(stats);
            break;
          }
          const key = `${toSend[0]!.cid}@${toSend[0]!.at}`;
          state.budget.calls++;
          stats.calls++;
          // A call about turns Will ASKED to keep private (the Local Only switch, or the words) asks for facts
          // alone, whatever the pass asks (a call is all turns of one kind, so it is all of them or none). A
          // suggestion is his own sentence on its way to being a goal, and his goals can be sent to every brain
          // (FLINT_GOALS_TO_FRONTIER): what he asked to keep on this Mac is never put on that road. The facts are
          // learned and marked as ever. A turn taken in Local mode is asked: the mode keeps its answer here, and
          // a goal he then approves is a goal like any he typed.
          const asked = asking && !toSend.some((it) => it.byRequest) ? asking : undefined;
          const ask = this.prompt(toSend, room, asked);
          let reply: BrainReply | undefined;
          let why: BrainFailure | undefined;
          let detail: string | undefined;
          try {
            const send = (): Promise<BrainReply> => this.brain.generate({ system: EXTRACT_SYSTEM, prompt: ask.text, ...(asked ? { suggestions: asked } : {}) });
            // (A call's turns all carry the same marks: it stays here, or none of it does.)
            reply = await (toSend.some((it) => it.goals || it.private) ? this.kept(send) : send());
          } catch (err) {
            why = err instanceof MemoryBrainError ? err.why : 'unavailable';
            detail = err instanceof MemoryBrainError ? err.detail : errorKind(err);
          }
          if (why === 'deferred' || why === 'unavailable') {
            // The model did no work for this call, so it isn't one of the day's.
            state.budget.calls--;
            stats.calls--;
          }
          if (why === 'deferred') {
            this.defer(stats);
            break;
          }
          if (why === 'unavailable') {
            // Nothing answered: not the batch's fault, so no strike, and the turns wait.
            stats.failed++;
            failure = { why, ...(detail ? { detail } : {}) };
            break;
          }
          if (why === 'truncated') {
            stats.truncated++;
            if (toSend.length > 1) {
              // Too much to answer in one reply: the same turns again, half as many at a time.
              turnCap = Math.max(1, Math.floor(toSend.length / 2));
              continue;
            }
          }
          if (why === 'server-error' || why === 'timeout') {
            stats.failed++;
            failure = { why, ...(detail ? { detail } : {}) };
          } else {
            this.failStreak = 0; // the model answered
          }
          let cands: Candidate[] | null = null;
          if (reply) cands = 'facts' in reply ? candidatesOf(reply.facts) : parseCandidates(reply.text);
          if (cands === null) {
            // A strike against this batch. Don't advance: the turns are retried
            // next pass instead of being silently marked done with nothing
            // extracted. Three strikes halve the batch, and only a single turn
            // is ever skipped: one turn the model or the server can never
            // handle doesn't stall the rest, and an outage that fails every
            // batch costs a turn at a time, not a whole backlog.
            const reason = why ?? 'invalid';
            if (reason === 'invalid') stats.unparseable++;
            const count = state.failures?.key === key ? state.failures.count + 1 : 1;
            if (count < STRIKES) {
              state.failures = { key, count, ...(struck !== undefined ? { cap: struck } : {}) };
              console.error(`[memory-extract] no usable reply for batch ${key} (${reason}, attempt ${count}/${STRIKES}); will retry`);
              break;
            }
            if (toSend.length > 1) {
              const half = Math.max(1, Math.floor(toSend.length / 2));
              state.failures = { key, count: 0, cap: half };
              console.error(`[memory-extract] batch ${key} had no usable reply ${STRIKES} times (${reason}); trying ${half} of its ${toSend.length} turns`);
              if (failure) break; // the server's doing: wait for the back-off
              continue;
            }
            console.error(`[memory-extract] turn ${key} had no usable reply ${STRIKES} times (${reason}); skipping it`);
            delete state.failures;
          } else {
            delete state.failures;
            await this.store(cands, toSend, ask.shown, stats);
            // Suggestions: only when this pass asked, and only from the local brain's own reply (a text reply is the
            // frontier's, and is never read for them). The facts above are stored; whatever happens in this step
            // (a bad zone, a hook that throws) is counted, and the watermark below still moves.
            if (asked && reply && 'facts' in reply) {
              try {
                await this.suggest(reply.suggestions ?? [], toSend, stats, asked);
              } catch (err) {
                stats.rejected['suggestion-failed'] = (stats.rejected['suggestion-failed'] ?? 0) + 1;
                console.error(`[memory-extract] the suggestions step failed (${errorKind(err)}); the facts are kept and the pass goes on`);
              }
            }
          }
          // Counted, so the log says why a pass that asks made no suggestion of them (no word of any turn is in it).
          if (asking && !asked) stats.rejected['suggestion-private-turn'] = (stats.rejected['suggestion-private-turn'] ?? 0) + toSend.length;
          sent += toSend.length;
          stats.turnsSent += toSend.length;
        }
        // Advance per batch so a mid-pass failure keeps the progress already paid for.
        for (const b of batch) state.watermarks[b.cid] = Math.max(state.watermarks[b.cid] ?? 0, b.at);
        idx = j;
        this.saveState(state);
        if (failure) break; // a turn the server kept failing was skipped: the next waits for the back-off
      }
    } finally {
      this.backlog = !gated && !this.deferred && !failure && idx < pending.length && state.budget.calls < this.maxCallsPerDay;
      if (failure) this.failStreak++;
      if (!this.deferred) this.deferStreak = 0;
      addStats(state.totals, stats);
      this.saveState(state);
    }

    const rej = Object.entries(stats.rejected).map(([k, v]) => `${k}=${v}`).join(' ') || 'none';
    const ended = failure
      ? `; no reply (${failure.why}${failure.detail ? `: ${failure.detail}` : ''}), next try in ${minutes(this.nextDelayMs)}`
      : this.deferred
        ? `; waiting for Will's chat`
        : '';
    console.error(
      `[memory-extract] v${EXTRACT_VERSION} ${this.kind} pass: sent ${stats.turnsSent} turn(s) in ${stats.calls} call(s) ` +
        `(skipped synthetic=${stats.skippedSynthetic} trivial=${stats.skippedTrivial} duplicate=${stats.skippedDuplicate} tainted=${stats.skippedTainted}); ` +
        `${stats.candidates} candidate(s) → stored ${stats.stored}, superseded ${stats.superseded}, rejected ${rej}` +
        `${stats.supersedeRefused ? `, supersede refused ${stats.supersedeRefused}` : ''}` +
        `${stats.unparseable ? `, unparseable ${stats.unparseable}` : ''}${stats.truncated ? `, cut off ${stats.truncated}` : ''}` +
        `${asking ? `; ${stats.suggested} suggestion(s) → kept ${stats.suggestionsKept}, filed ${stats.suggestionsFiled}` : ''}; ` +
        `${pending.length - idx} turn(s) still queued; ` +
        `budget ${state.budget.calls}/${this.maxCallsPerDay} today${gated ? `; paused (${gated})` : ''}${ended}`,
    );
    return stats.stored;
  }

  /** Will is chatting: this pass stops here, and the next comes in deferMs. */
  private defer(stats: PassStats): void {
    this.deferred = true;
    stats.deferred++;
    this.deferStreak++;
    if (this.deferStreak === 1) {
      console.error(`[memory-extract] waiting for Will's chat; checking again every ${minutes(this.deferMs)}`);
    }
  }

  /**
   * What one call can give the transcript and the known facts. A brain with a
   * bounded window (the local model) gets what its instructions leave, shared
   * out; one without gets batchChars and every known fact up to KNOWN_CAP.
   */
  private room(asking?: Suggesting): Room {
    const limit = this.brain.promptChars;
    if (limit === undefined || !Number.isFinite(limit)) return { batchChars: this.batchChars, knownChars: Infinity, turnChars: Infinity };
    const free = Math.max(0, limit - EXTRACT_SYSTEM.length - EXTRACT_PROMPT.length - (asking ? suggestLines(asking).length : 0) - PROMPT_FRAME);
    const knownChars = Math.floor(free * KNOWN_SHARE);
    const turnChars = Math.max(MIN_BATCH_CHARS, free - knownChars);
    return { batchChars: Math.min(this.batchChars, turnChars), knownChars, turnChars };
  }

  /** Every unprocessed complete turn, oldest conversation first, in order. */
  private async collect(state: ExtractState, stats: PassStats): Promise<Item[]> {
    const convs: Item[][] = [];
    const seenUser = new Set<string>();
    for (const cid of this.memory.conversationIds()) {
      const since = state.watermarks[cid] ?? 0;
      // In time order, whatever order they were stored in: a turn finished on
      // another device (or a double send) can land after a later one, and the
      // watermark, a time, would pass it over for good.
      const turns = (await this.memory.getTurns(cid)).filter((t) => t.status === 'complete').sort((a, b) => a.updatedAt - b.updatedAt);
      const items: Item[] = [];
      let prev: Turn | undefined;
      for (const t of turns) {
        if (t.updatedAt > since) {
          stats.turnsSeen++;
          const user = userText(t);
          const asst = assistantText(t);
          const norm = user.toLowerCase().replace(/[^a-z0-9 ]+/g, '').replace(/\s+/g, ' ').trim();
          let skip: Item['skip'];
          if (this.skipConversations.test(cid)) skip = 'synthetic';
          else if (this.isTainted(cid, t.id)) skip = 'tainted';
          else if (norm.split(' ').filter(Boolean).length < 3) skip = 'trivial';
          else if (seenUser.has(norm)) skip = 'duplicate';
          if (skip === 'synthetic') stats.skippedSynthetic++;
          else if (skip === 'trivial') stats.skippedTrivial++;
          else if (skip === 'duplicate') stats.skippedDuplicate++;
          else if (skip === 'tainted') stats.skippedTainted++;
          else seenUser.add(norm);
          if (skip) {
            items.push({ cid, at: t.updatedAt, chunk: '', skip });
          } else {
            // The user's words carry the facts; the answer and the previous turn
            // are context, clipped so one long reply can't crowd out the batch.
            // A tainted previous turn is not context either.
            const context = prev && !this.isTainted(cid, prev.id) ? prev : undefined;
            const before = context
              ? `(earlier in this conversation — WILL: ${clip(userText(context), CONTEXT_CHARS)} / ASSISTANT: ${clip(assistantText(context), CONTEXT_CHARS)})\n`
              : '';
            items.push({
              cid,
              at: t.updatedAt,
              turnId: t.id,
              said: head(user, SAID_CHARS),
              chunk: `${before}WILL: ${clip(user, WILL_CHARS)}\nASSISTANT: ${clip(asst, ASSISTANT_CHARS)}`,
              will: [head(user, WILL_CHARS), ...(context ? [head(userText(context), CONTEXT_CHARS)] : [])],
              assistant: [head(asst, ASSISTANT_CHARS), ...(context ? [head(assistantText(context), CONTEXT_CHARS)] : [])],
              // The earlier turn's words are in the call too: either one having carried Will's goals marks it,
              // and either one being a turn he kept private marks it private.
              ...(this.carriedGoals(cid, t.id) || (context && this.carriedGoals(cid, context.id)) ? { goals: true } : {}),
              ...(this.keptPrivate(cid, t.id) || (context && this.keptPrivate(cid, context.id)) ? { private: true } : {}),
              // ...and either one being a turn he ASKED to keep private keeps the call from being asked for a goal.
              ...(this.privateByRequest(cid, t.id) || (context && this.privateByRequest(cid, context.id)) ? { byRequest: true } : {}),
            });
          }
        }
        prev = t;
      }
      if (items.length) convs.push(items);
    }
    // Oldest conversation first; turns stay together and in order, so a
    // conversation's watermark is always a clean cut.
    convs.sort((a, b) => a[0]!.at - b[0]!.at);
    return convs.flat();
  }

  /** The call's prompt, and the ids of the known facts it shows (the only ones a fact may supersede). */
  private prompt(items: Item[], room: Room, asking?: Suggesting): { text: string; shown: Set<string> } {
    // The known facts that stay on this Mac are shown only to a call whose turns do too, and are held as closely.
    const known = this.knownFacts(items, room.knownChars, Math.max(0, ...items.map(heldAs)) as 0 | 1 | 2);
    const knownBlock = known.length
      ? known.map((f) => `${f.id}: ${f.text}`).join('\n')
      : '(none yet)';
    // A single turn longer than a small window allows is cut to fit (only it
    // can be: a batch otherwise stops before the turn that would overflow).
    // batchChars never cuts a turn: it only decides how many go in a call.
    const fit = Math.max(1, room.turnChars - TURN_HEADER);
    const turns = items
      .map((it, i) => `### Turn ${i + 1} (${new Date(it.at).toISOString().slice(0, 10)})\n${clip(it.chunk, fit)}`)
      .join('\n\n');
    return {
      text: `${EXTRACT_PROMPT}${asking ? suggestLines(asking) : ''}\n\nKNOWN FACTS (id: text):\n${knownBlock}\n\nTURNS:\n\n${turns}`,
      shown: new Set(known.map((f) => f.id)),
    };
  }

  /** The known facts worth showing the model: all of them while they fit, else
   *  the ones sharing the most words with this batch, up to KNOWN_CAP and
   *  `maxChars`. */
  private knownFacts(items: Item[], maxChars: number, held: 0 | 1 | 2 = 0): Array<{ id: string; text: string }> {
    // A fact is shown to a call held at least as closely as the fact is: one from a private turn only to a call
    // about private turns, one from Will's goals to those and to a call about goals turns.
    const all = this.knowledge.all().filter((f) => heldAs({ goals: f.fromGoals === true, private: f.fromPrivate === true }) <= held);
    const size = (f: { id: string; text: string }) => f.id.length + f.text.length + 3;
    if (all.length <= KNOWN_CAP && all.reduce((n, f) => n + size(f), 0) <= maxChars) return all;
    const words = new Set(items.flatMap((i) => i.chunk.toLowerCase().split(/[^a-z0-9]+/)).filter((w) => w.length > 3));
    const ranked = all
      .map((f) => ({ f, s: f.text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => words.has(w)).length }))
      .sort((a, b) => b.s - a.s)
      .map((x) => x.f);
    const out: Array<{ id: string; text: string }> = [];
    let used = 0;
    for (const f of ranked) {
      if (out.length >= KNOWN_CAP) break;
      if (used + size(f) > maxChars) continue;
      out.push(f);
      used += size(f);
    }
    return out;
  }

  private async store(cands: Candidate[], sent: Item[], shown: ReadonlySet<string>, stats: PassStats): Promise<void> {
    const turns = sent.map((s) => ({ will: s.will ?? [], assistant: s.assistant ?? [], at: s.at }));
    for (const c of cands) {
      stats.candidates++;
      // A fact stands on Will's own words or not at all. The quote also says
      // which turn it came from, whatever turn number the model gave.
      const at = locateQuote(c.quote, turns, c.turn, c.fact);
      if (typeof at !== 'number') {
        stats.rejected[at] = (stats.rejected[at] ?? 0) + 1;
        continue;
      }
      const src = sent[at]!;
      const sourceAt = src.at;
      const res = await this.knowledge.addDetailed(c.fact, 'history', {
        conversationId: src.cid,
        sourceAt,
        ...(c.category ? { category: c.category } : {}),
        // Learned from a turn answered with Will's goals, or from one he kept private: it stays on this Mac.
        ...(src.goals ? { fromGoals: true } : {}),
        ...(src.private ? { fromPrivate: true } : {}),
      });
      if (res.status !== 'added') {
        stats.rejected[res.status] = (stats.rejected[res.status] ?? 0) + 1;
        continue;
      }
      stats.stored++;
      for (const oldId of c.supersedes.slice(0, 3)) {
        // Only a fact the model was shown (an id copied from an example, or
        // guessed, would retire whatever fact holds it, and a retired fact
        // blocks its own text from coming back), and only one about the same
        // thing: the two must share two content words.
        const old = shown.has(oldId) ? this.knowledge.all().find((f) => f.id === oldId) : undefined;
        if (!old || !sharesContent(old.text, c.fact)) {
          stats.supersedeRefused++;
          continue;
        }
        // An old transcript must not overrule something learned later: only a
        // turn at least as recent as the old fact may replace it.
        const oldAt = old.sourceAt ?? old.ts;
        if (sourceAt < oldAt) continue;
        if (this.knowledge.supersede(oldId, res.id)) {
          stats.superseded++;
          console.error(`[memory-extract] ${res.id} supersedes ${oldId}`);
        }
      }
    }
  }

  /**
   * The suggestions one reply proposed. Each is held to Will's own message of
   * the turn it names before anything else is looked at, widened to his whole
   * sentence, then handed on; what fails is counted by reason and never logged.
   */
  private async suggest(raw: readonly unknown[], sent: Item[], stats: PassStats, asking: Suggesting): Promise<void> {
    const drop = (why: string): void => {
      stats.rejected[`suggestion-${why}`] = (stats.rejected[`suggestion-${why}`] ?? 0) + 1;
    };
    const today = localDay(this.tz, new Date(this.now()));
    /** What is already kept from each turn of this reply, as it is compared. */
    const kept = new Map<number, string[]>();
    stats.suggested += raw.length;
    for (const e of raw.slice(0, SUGGESTIONS_PER_CALL)) {
      const s = suggestionOf(e);
      if (!s) {
        drop('shape');
        continue;
      }
      // Commitments have their own switch: with it off none was asked for, and none is taken.
      if (s.kind === 'commitment' && asking !== 'all') {
        drop('kind');
        continue;
      }
      // The turn it names, and no other: a suggestion without one of this batch's turns rests on nothing.
      const src = sent[s.turn - 1];
      if (!src || src.skip || !src.turnId || !src.said) {
        drop('turn');
        continue;
      }
      // THE QUOTE CHECK. The model's excerpt as it is compared: normalised, without the quote marks and end
      // punctuation a model wraps it in (taking them off only makes it shorter, so what is left must still be his words).
      const excerpt = normalizeSaid(s.quote).replace(/^[\s"'.,;:!?\u2026-]+|[\s"'.,;:!?\u2026-]+$/gu, '');
      const length = [...excerpt].length;
      if (length < SUGGESTION_QUOTE_MIN || length > SUGGESTION_QUOTE_MAX || !saidHolds(src.said, excerpt)) {
        drop('quote');
        continue;
      }
      // What is handed on, and shown on the card: not the excerpt, but his whole sentence (or sentences) that holds
      // it, in his own characters. A sentence that cannot be shown whole in 300 characters is not used in part.
      const quote = saidSentences(src.said, excerpt);
      if (quote === undefined || !SuggestionQuote.safeParse(quote).success) {
        drop('long');
        continue;
      }
      // What it says is his too: a short text, most of whose words, and every number, are in that same message.
      // It starts with a capital, as a title does.
      const text = capital(normalizeSaid(s.text));
      if (!SuggestionText.safeParse(text).success || factCoverage([src.said], text) < FACT_COVERAGE || !numbersGrounded([src.said], text, src.at)) {
        drop('text');
        continue;
      }
      // A day, if the model read one in his words: a real one, not before the turn itself and not over ten years
      // out. One that has passed since is left off. (It is the model's reading: the card says so.)
      let dueOn: string | undefined;
      if (s.dueOn) {
        if (!DayOnly.safeParse(s.dueOn).success || s.dueOn < localDay(this.tz, new Date(src.at)) || Date.parse(`${s.dueOn}T00:00:00.000Z`) > this.now() + SUGGESTION_MAX_DAYS_AHEAD * 86_400_000) {
          drop('date');
          continue;
        }
        if (s.dueOn >= today) dueOn = s.dueOn;
      }
      if (this.now() - src.at > SUGGESTION_MAX_AGE_DAYS * 86_400_000) {
        drop('old');
        continue;
      }
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(src.cid) || !/^[A-Za-z0-9_-]{1,80}$/.test(src.turnId)) {
        drop('id');
        continue;
      }
      // One sentence, one suggestion: a quote that holds, or is held by, one already kept from this turn is the
      // same thing said again (three wordings of one goal would otherwise be three cards, the day's whole limit).
      const mine = normalizeSaid(quote);
      const others = kept.get(s.turn) ?? [];
      if (others.some((o) => o.includes(mine) || mine.includes(o))) {
        drop('overlap');
        continue;
      }
      kept.set(s.turn, [...others, mine]);
      stats.suggestionsKept++;
      let outcome: SuggestionOutcome;
      try {
        outcome = await this.onCandidate!({ kind: s.kind, text, quote, ...(dueOn ? { dueOn } : {}), conversationId: src.cid, turnId: src.turnId, sourceAt: src.at, staysHere: src.goals === true || src.private === true });
      } catch {
        outcome = 'unreachable';
      }
      if (outcome === 'filed') stats.suggestionsFiled++;
      else drop(outcome);
    }
    if (raw.length > SUGGESTIONS_PER_CALL) stats.rejected['suggestion-extra'] = (stats.rejected['suggestion-extra'] ?? 0) + raw.length - SUGGESTIONS_PER_CALL;
  }

  private loadState(): ExtractState {
    const fresh = (): ExtractState => ({ version: EXTRACT_VERSION, watermarks: {}, budget: { day: '', calls: 0 }, totals: emptyStats() });
    if (!existsSync(this.statePath)) return fresh();
    try {
      const raw = JSON.parse(readFileSync(this.statePath, 'utf8')) as Partial<ExtractState>;
      const s = fresh();
      // Every field is checked: a hand-edited or half-written file loses what
      // doesn't fit, never the pass.
      const b = raw.budget as { day?: unknown; calls?: unknown } | undefined;
      if (b && typeof b.day === 'string' && Number.isInteger(b.calls) && (b.calls as number) >= 0) s.budget = { day: b.day, calls: b.calls as number };
      if (isRecord(raw.totals)) {
        const t = raw.totals as Record<string, unknown>;
        for (const k of Object.keys(s.totals) as Array<keyof PassStats>) {
          if (k === 'rejected') {
            if (isRecord(t.rejected)) for (const [r, n] of Object.entries(t.rejected)) if (Number.isFinite(n)) s.totals.rejected[r] = n as number;
          } else if (Number.isFinite(t[k])) {
            s.totals[k] = t[k] as number;
          }
        }
      }
      const f = raw.failures as { key?: unknown; count?: unknown; cap?: unknown } | undefined;
      if (f && typeof f.key === 'string' && Number.isInteger(f.count) && (f.count as number) >= 0) {
        s.failures = { key: f.key, count: f.count as number };
        if (Number.isInteger(f.cap) && (f.cap as number) >= 1) s.failures.cap = f.cap as number;
      }
      // Watermarks from an older extractor version are dropped on purpose: the
      // rules changed, so history is re-read (resumably, under the daily cap).
      // Re-reading is idempotent — the store dedupes and honours tombstones.
      if (raw.version === EXTRACT_VERSION && isRecord(raw.watermarks)) {
        for (const [cid, at] of Object.entries(raw.watermarks)) if (typeof at === 'number' && Number.isFinite(at)) s.watermarks[cid] = at;
      } else if (raw.watermarks) console.error(`[memory-extract] extractor v${raw.version ?? 1} → v${EXTRACT_VERSION}: re-reading history under the new rules`);
      return s;
    } catch {
      return fresh();
    }
  }

  private saveState(s: ExtractState): void {
    try {
      mkdirSync(dirname(this.statePath), { recursive: true });
      writeFileSync(this.statePath, JSON.stringify(s), 'utf8');
    } catch (err) {
      console.error(`[memory-extract] could not persist watermarks: ${errorKind(err)}`);
    }
  }
}

/** A zone the day arithmetic can use: the one given, or UTC when it is not a zone at all (said once; never a reason for a pass to fail). */
function safeZone(tz: string | undefined): string {
  const z = tz?.trim() || 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: z }).format(0);
    return z;
  } catch {
    console.error('[memory-extract] the time zone it was given is not one; days are read in UTC');
    return 'UTC';
  }
}

/** `s` with its first letter a capital: a title starts with one. */
function capital(s: string): string {
  const first = [...s][0];
  return first ? first.toUpperCase() + s.slice(first.length) : s;
}

function userText(t: Turn): string {
  return t.messages.find((m) => m.role === 'user')?.content ?? '';
}

function assistantText(t: Turn): string {
  return t.messages.filter((m) => m.role === 'assistant').map((m) => m.content).join(' ');
}

function addStats(into: PassStats, s: PassStats): void {
  for (const k of Object.keys(s) as Array<keyof PassStats>) {
    if (k === 'rejected') {
      for (const [r, n] of Object.entries(s.rejected)) into.rejected[r] = (into.rejected[r] ?? 0) + n;
    } else {
      into[k] = (into[k] ?? 0) + s[k];
    }
  }
}

/** The first `n` code points of `s`: never half of an emoji's surrogate pair. */
function head(s: string, n: number): string {
  if (s.length <= n) return s; // n UTF-16 units are at most n code points
  let i = 0;
  for (let count = 0; i < s.length && count < n; count++) i += s.codePointAt(i)! > 0xffff ? 2 : 1;
  return s.slice(0, i);
}

/** `s` cut to `n` code points, with an ellipsis when anything was cut. */
function clip(s: string, n: number): string {
  const h = head(s, n);
  return h.length === s.length ? s : `${h}…`;
}

function minutes(ms: number): string {
  return `${Math.max(1, Math.round(ms / 60_000))}m`;
}

/**
 * A thrown error as a log line can carry it: its kind or name, and a status or
 * code. Never its message, which can hold what a provider was sent or
 * answered, and never its stack, whose first lines are the message (a message
 * with a line of its own that starts "  at " would pass for a frame).
 */
export function errorKind(err: unknown): string {
  if (!err || typeof err !== 'object') return 'error';
  const e = err as { name?: unknown; kind?: unknown; code?: unknown; error?: { providerCode?: unknown } };
  const name = typeof e.kind === 'string' ? e.kind : typeof e.name === 'string' ? e.name : '';
  const code = e.error?.providerCode ?? e.code;
  const safe = (s: string) => s.replace(/[^\w.-]/g, '').slice(0, 40);
  return [safe(name), typeof code === 'string' || typeof code === 'number' ? safe(String(code)) : ''].filter(Boolean).join(' ') || 'error';
}

export interface Candidate {
  fact: string;
  category?: string;
  /** 1-based index of the source turn within the batch. */
  turn?: number;
  /** Will's own words the fact rests on (see locateQuote). */
  quote?: string;
  supersedes: string[];
}

/**
 * Tolerant parse of the frontier's reply: the `{"facts": [...]}` object, or a
 * bare array of fact objects (v2). A bare string (v1) carries no quote, so it
 * could never be grounded and is dropped here. Returns null when there's no
 * usable reply at all (no array, or JSON that isn't this shape), so the caller
 * can retry instead of treating a garbled reply as "nothing to remember".
 */
export function parseCandidates(text: string): Candidate[] | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fenced?.[1] ?? text;
  let whole: unknown; // JSON.parse never returns undefined: undefined means it didn't parse
  try {
    whole = JSON.parse(body);
  } catch {
    whole = undefined;
  }
  let parsed: unknown;
  if (whole !== undefined) {
    // The whole reply is JSON (the local model's always is): it is the shape, or unusable.
    if (Array.isArray(whole)) parsed = whole;
    else if (isRecord(whole) && Array.isArray(whole.facts)) parsed = whole.facts;
    else return null;
  } else {
    // The model sometimes answers "[]", then reasons in prose, then gives its real
    // array. First-'[' to last-']' spans the prose and never parses, so take the
    // LAST balanced array that does: that's its final answer.
    for (const chunk of topLevelArrays(body).reverse()) {
      try {
        const v: unknown = JSON.parse(chunk);
        if (Array.isArray(v)) {
          parsed = v;
          break;
        }
      } catch {
        /* try the previous one */
      }
    }
  }
  return Array.isArray(parsed) ? candidatesOf(parsed) : null;
}

/** The entries that are fact objects of a sane length, as candidates. */
export function candidatesOf(entries: readonly unknown[]): Candidate[] {
  const out: Candidate[] = [];
  for (const e of entries) {
    if (!isRecord(e) || typeof e.fact !== 'string') continue;
    const c: Candidate = { fact: e.fact.trim(), supersedes: Array.isArray(e.supersedes) ? e.supersedes.filter((x): x is string => typeof x === 'string') : [] };
    if (typeof e.category === 'string' && e.category.trim()) c.category = e.category.trim().toLowerCase();
    const turn = Number(e.turn);
    if (Number.isInteger(turn) && turn > 0) c.turn = turn;
    if (typeof e.quote === 'string') c.quote = e.quote;
    if (c.fact.length >= 8 && c.fact.length <= 400) out.push(c);
  }
  return out;
}

/** Every top-level `[...]` span in `text`, bracket-balanced and string-aware. */
function topLevelArrays(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"' && depth > 0) inStr = true;
    else if (ch === '[') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === ']' && depth > 0) {
      depth--;
      if (depth === 0) out.push(text.slice(start, i + 1));
    }
  }
  return out;
}

/** Fact texts only; malformed output degrades to []. Kept for tests. */
export function parseFacts(text: string): string[] {
  return (parseCandidates(text) ?? []).map((c) => c.fact);
}

/**
 * QUOTE GROUNDING. A quote must be Will's words, and "verbatim" is held at the
 * level of words, not typography: a model retyping a quote straightens curly
 * quotes, swaps an en dash for a hyphen, changes a capital or the spacing.
 * Both the quote and what Will wrote are normalised the same way:
 *  - curly and prime single quotes and the acute accent → ' (backticks are left: they mark code);
 *  - curly, prime and angle double quotes → ";
 *  - hyphens, en and em dashes and the minus sign → -;
 *  - NFKC: full-width letters, ligatures and the no-break space become their
 *    plain forms, and "…" becomes "...";
 *  - every run of whitespace → one space, trimmed, lower case.
 * Nothing else changes: a word added, dropped or reordered fails the match.
 */
export function normalizeQuoteText(s: string): string {
  return s
    .replace(/[‘’‚‛′´]/g, "'")
    .replace(/[“”„‟″«»]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** A quote shorter than this can't tell one remark from another. */
export const QUOTE_MIN_CHARS = 6;
export const QUOTE_MIN_WORDS = 2;

/**
 * The quote as it is searched for: normalised, with the quote marks, ellipses
 * and end punctuation a model wraps it in taken off (they only make it longer,
 * so what is left must still be Will's words). Undefined when there is no
 * quote, or too little of one to ground anything.
 */
export function quoteNeedle(quote: string | undefined): string | undefined {
  if (typeof quote !== 'string') return undefined;
  const q = normalizeQuoteText(quote).replace(/^[\s"'.,;:!?-]+|[\s"'.,;:!?-]+$/g, '');
  if (q.length < QUOTE_MIN_CHARS || q.split(' ').length < QUOTE_MIN_WORDS) return undefined;
  return q;
}

/** Why a candidate's quote grounds nothing: no usable quote, or one found only in the assistant's words. */
export type Ungrounded = 'ungrounded' | 'assistant-quote';

const WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * Does `hay` hold `needle` as whole words: not starting or ending inside a
 * word ("my card" is not in "my cardiologist")? Both already normalised.
 */
export function holdsWords(hay: string, needle: string): boolean {
  if (!needle) return false;
  const edgeStart = WORD_CHAR.test(needle[0]!);
  const edgeEnd = WORD_CHAR.test(needle[needle.length - 1]!);
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) {
    const before = hay[i - 1];
    const after = hay[i + needle.length];
    if ((!edgeStart || before === undefined || !WORD_CHAR.test(before)) && (!edgeEnd || after === undefined || !WORD_CHAR.test(after))) return true;
  }
  return false;
}

/**
 * How much of what a fact says is in Will's words: the share of the fact's
 * content words (./knowledge contentTokens: no stop words, no "Will") that
 * appear in `will`. A quote proves Will said something; this, that he said
 * this. 0 when the fact has no content words at all.
 */
export function factCoverage(will: string[], fact: string): number {
  const said = new Set(contentTokens(normalizeQuoteText(will.join(' '))));
  const claims = [...new Set(contentTokens(normalizeQuoteText(fact)))];
  return claims.length === 0 ? 0 : claims.filter((t) => said.has(t)).length / claims.length;
}

/** A grounded fact's content words must be at least this much Will's (see factCoverage). */
export const FACT_COVERAGE = 0.5;

/** The numbers in `s`, as digits: "1,200" is 1200 and "09" is 9, so how they are written doesn't matter. */
function numbersIn(s: string): string[] {
  return (s.replace(/(\d)[,_](?=\d{3}\b)/g, '$1').match(/\d+/g) ?? []).map((d) => d.replace(/^0+(?=\d)/, ''));
}

/**
 * Is every number in the fact one Will gave in `will`, or the year of the
 * turn (`at`: "August 2026" said in 2026)? Only the year: the month and day
 * would vouch for any small number ("Mia is 9" on September 21). A model fills
 * in numbers readily ("192GB", "October 3", "Mia is 6"), and a number is the
 * detail a quote and word coverage can't vouch for.
 */
export function numbersGrounded(will: string[], fact: string, at?: number): boolean {
  const year = at !== undefined && Number.isFinite(at) ? String(new Date(at).getUTCFullYear()) : undefined;
  const have = new Set([...numbersIn(will.join(' ')), ...(year ? [year] : [])]);
  return numbersIn(fact).every((n) => have.has(n));
}

/**
 * Are two facts about the same thing? They share at least two content words,
 * or, when both are that short (two content words at most: "Will lives in
 * Dallas" and "Will lives in Austin"), one. One shared word between longer
 * facts isn't enough ("Will works from home on Fridays" and "Will's sister Ana
 * works as a nurse" share "work"). A real update that falls short is stored
 * beside the old fact instead of replacing it: a contradiction Will can see,
 * never a silent loss.
 */
export function sharesContent(a: string, b: string): boolean {
  const A = new Set(contentTokens(normalizeQuoteText(a)));
  const B = new Set(contentTokens(normalizeQuoteText(b)));
  const shared = [...B].filter((t) => A.has(t)).length;
  return shared >= 2 || (shared === 1 && A.size <= 2 && B.size <= 2);
}

/**
 * Which turn of the batch (0-based) holds the quote in Will's words, as whole
 * words, looking at the cited turn first (`cited` is 1-based, as the model
 * numbers them), or why the candidate isn't grounded. With `fact`, that turn's
 * Will text must also cover the fact (FACT_COVERAGE), and hold every number
 * in it, or the number is the turn's year (numbersGrounded): a few words he did type
 * ("my Mac Studio") can't carry a claim he never made ("has 192GB"). A quote
 * found in Will's words grounds a fact even when the assistant also said it; a
 * quote found only in the assistant's words never does.
 */
export function locateQuote(
  quote: string | undefined,
  turns: Array<{ will: string[]; assistant: string[]; at?: number }>,
  cited?: number,
  fact?: string,
): number | Ungrounded {
  const needle = quoteNeedle(quote);
  if (!needle) return 'ungrounded';
  const holds = (texts: string[]) => texts.some((t) => holdsWords(normalizeQuoteText(t), needle));
  const first = cited !== undefined && Number.isInteger(cited) && cited >= 1 && cited <= turns.length ? cited - 1 : undefined;
  const order = first === undefined ? [...turns.keys()] : [first, ...[...turns.keys()].filter((i) => i !== first)];
  let quoted = false;
  for (const i of order) {
    if (!holds(turns[i]!.will)) continue;
    quoted = true;
    const t = turns[i]!;
    if (fact === undefined || (factCoverage(t.will, fact) >= FACT_COVERAGE && numbersGrounded(t.will, fact, t.at))) return i;
  }
  if (quoted) return 'ungrounded'; // he said the words, not what the fact claims
  return turns.some((t) => holds(t.assistant)) ? 'assistant-quote' : 'ungrounded';
}
