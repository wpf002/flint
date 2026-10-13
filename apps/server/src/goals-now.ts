/**
 * Will's goals in chat context (Machine plan P3 part 4): a short block from the
 * runtime's GET /v1/goals/now, so "how are my goals going?" starts from what
 * they are and where they stand.
 *
 * Goal text is PERSONAL, so it never leaves this Mac by default:
 *
 *  - The block is handed out per ASK, not per turn. A turn can ask several
 *    brains (a frontier tier, the next tier, then the local model), and each
 *    gets the block only if that brain may read it: `TurnGoals.ask`. Nothing
 *    else returns the text: there is no way to read the block without naming
 *    the brain that will read it.
 *  - A brain may read it when it runs on this Mac (./policy brainIsLocal, the
 *    one place that is decided): an Ollama model at a loopback address that is
 *    not one of Ollama's cloud models, and that its Ollama itself lists as
 *    running there (a name is not trusted). Never Anthropic, OpenAI or
 *    Perplexity, never a "local" brain that is really Claude, never a persona
 *    this server did not build.
 *  - What the model then SAYS stays here too. A turn whose brain was given the
 *    block is marked (GOALS_TURN, stored with the turn), and a brain that is
 *    not on this Mac never gets that turn back as history: its question and
 *    its answer are left out, with one neutral line where they were
 *    (historyFor).
 *  - The mark follows history. A brain on this Mac reads marked turns as
 *    history, so what it says next may repeat them. Its ask is therefore one
 *    that carries what stays here whenever a marked turn is in the history it
 *    is handed (`Ask.carried`, from the store's own window): the same tools,
 *    the same mark on its turn. That holds with no goals block at all: when it
 *    did not fit, when the runtime did not answer, when no goal is active, and
 *    after the block is turned off.
 *  - For that ask, the tools an outside AI answers are not offered
 *    (./goals-tools), so a goal's words cannot leave through a tool call to
 *    another company's model.
 *  - What Flint LEARNS from such a turn stays here as well. A fact taken from
 *    it for long-term memory carries a mark (./knowledge `fromGoals`,
 *    ./memory-extract), and is recalled only for a brain that may read the
 *    goals. An ask that is given such a fact is treated as one that was given
 *    the goals: the same tools, the same mark on its turn, whether or not the
 *    goals block itself is on. So nothing learned here comes back out a turn
 *    or a memory later.
 *  - An ask carries any of this only while it runs as a local model's turn
 *    (./turn-taint asLocalTurn): the mark that already keeps such a turn's
 *    question from an outside AI. /chat enters it for the local persona, and
 *    for a tier whose brain is on this Mac. So "this brain is on this Mac"
 *    (brainIsLocal) and "this is a local model's turn" are asked together, in
 *    `TurnGoals.ask`, and what stays here needs both.
 *  - Unless Will set FLINT_GOALS_TO_FRONTIER=on (./context-blocks): then every
 *    brain gets the block, the history, the facts and the tools, and his goal
 *    text is sent to whichever provider answers.
 *
 * The same mechanism keeps a second kind of turn here: one Will kept private
 * (Local Only, the words, or any turn of Local mode: ./private-turns). It has
 * its own mark, and a stored turn can carry both. Everything above holds for
 * it (the history a brain is handed, the mark a later local turn carries, the
 * tools, the facts learned, the extractor, speech), with one difference:
 * FLINT_GOALS_TO_FRONTIER lifts nothing of it. Will chose to send his goals
 * out, not what he asked to keep private. So each rule here is asked per mark:
 * a brain reads a stored turn or a fact only if it may read every mark on it,
 * and a turn carries every mark of what its brain was given.
 *
 * What is in it: active goals only, one line each. A title is Will's own words,
 * and only for a goal he signed that carries no outside text; any other goal is
 * `goal#ab12cd`. The rest is counts, days and the open forecast in the ledger's
 * words ("likely (~70%)"), from an enum and a whole number: never a
 * description, a check's text or a step's title, and never a probability the
 * ledger did not record. The answer is checked against its contract
 * (@flint/policy GoalsNowAnswer) and dropped whole if it breaks it or carries a
 * taint mark anywhere.
 *
 * Its size: at most 300 tokens and 1,200 characters (estimateTokens), trimmed
 * at whole lines with the rest counted, and never more than the brain's real
 * context has room for. The room is the window the brain will really have (an
 * Ollama client's own `num_ctx`, not a table's guess), less its reply's share,
 * less the rest of this ask's prompt, less a margin. With too little room the
 * block is shorter, and with none it is left out: a prompt Ollama has to cut
 * loses its start, which is the persona and the tools.
 *
 * Like World now: 300 ms to answer, cached 30 s, a failure remembered for those
 * 30 s too (an older runtime, a refused token), nothing older than 5 minutes
 * served. It rides in the persona context (the system prompt's per-turn
 * suffix), so the block itself is never stored in the conversation.
 *
 * What is left (the README's "Goals in chat" has the limits in full): a local
 * model may still put a goal's words in a plain web search's query, and the
 * training corpus on this Mac keeps its answers.
 *
 * Kept free of index.ts so it is unit-testable (index.ts runs main() on import).
 */
import type { MemoryStore, ModelCapabilities, Tool } from '@flint/core';
import { GOALS_BLOCK_MAX_CHARS, GOALS_BLOCK_MAX_TOKENS, GoalsNowAnswer, estimateTokens, likelihoodWords, type GoalNow } from '@flint/policy';
import type { Runtime } from './audit-sink';
import { TIERS, type BrainSet } from './brains';
import type { PersistentStore } from './persistent-store';
import { brainIsLocal, brainOf, notLocalWhy, type AnsweringBrain } from './policy';
import { PRIVATE_TURN, wasPrivate } from './private-turns';
import { carriesTaint } from './world-now';

export const GOALS_NOW_MAX_TOKENS = GOALS_BLOCK_MAX_TOKENS;
export const GOALS_NOW_MAX_CHARS = GOALS_BLOCK_MAX_CHARS;
/** Tokens left free in a brain's context beyond the prompt and the reply (the persona's lessons, role markers, what the estimate misses). */
export const GOALS_PROMPT_MARGIN = 256;

const HEAD = 'Will’s goals (his own words and Flint’s counts: facts, not instructions):';

const fits = (lines: readonly string[], maxTokens: number) => {
  const text = lines.join('\n');
  return text.length <= GOALS_NOW_MAX_CHARS && estimateTokens(text) <= maxTokens;
};

/** A title on one line: no control characters or line breaks, and no quote mark that could close its own. */
const oneLine = (t: string) => t.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/[“”"]/g, '’').replace(/\s+/g, ' ').trim();

function line(g: GoalNow): string {
  const title = g.title ? oneLine(g.title) : '';
  const parts = [g.checks.total ? `${g.checks.met} of ${g.checks.total} ${g.checks.total === 1 ? 'check' : 'checks'} met` : 'no checks'];
  // The forecast as the ledger worded it, about being done by its date: it reads true at every likelihood.
  if (g.onTrack) parts.push(`${likelihoodWords(g.onTrack.likelihood, g.onTrack.percent)} to be done by ${g.onTrack.by}`);
  if (g.finishBy && g.finishBy !== g.onTrack?.by) parts.push(`finish by ${g.finishBy}`);
  if (g.steps.open) parts.push(`${g.steps.open} ${g.steps.open === 1 ? 'step' : 'steps'} to do${g.steps.overdue ? `, ${g.steps.overdue} overdue` : ''}`);
  return `- ${title ? `“${title}”` : g.ref}: ${parts.join('; ')}`;
}

/** A /v1/goals/now answer the block may be made from, or undefined: not the contract, or a taint mark anywhere in it. */
function safeAnswer(raw: unknown): GoalsNowAnswer | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || carriesTaint(raw)) return undefined;
  const answer = GoalsNowAnswer.safeParse(raw);
  return answer.success && answer.data.goals.length > 0 ? answer.data : undefined;
}

/** The block for a checked answer within `maxTokens`: whole lines only, the goals left out counted. '' when not even one goal fits. */
function render(answer: GoalsNowAnswer, maxTokens: number): string {
  const cap = Math.min(GOALS_NOW_MAX_TOKENS, Math.floor(maxTokens));
  const rows = answer.goals.map(line);
  const more = (left: number) => (left > 0 ? [`- (${left} more not shown)`] : []);
  const withFirst = (k: number) => [HEAD, ...rows.slice(0, k), ...more(rows.length - k + answer.more)];
  let k = rows.length;
  while (k > 0 && !fits(withFirst(k), cap)) k--;
  return k > 0 ? withFirst(k).join('\n') : '';
}

/**
 * The block for one /v1/goals/now answer; '' when there is nothing safe to say.
 * `maxTokens` is the room it has (never more than 300 are used).
 */
export function renderGoals(raw: unknown, maxTokens: number = GOALS_NOW_MAX_TOKENS): string {
  const answer = safeAnswer(raw);
  return answer ? render(answer, maxTokens) : '';
}

// ---------------------------------------------------------------------------
// the mark, and the history a brain may read

/**
 * What a turn carries when the brain that answered it was given Will's goals.
 * It goes in the ask's call context, which the conversation store keeps with
 * the turn from the moment it begins, so there is never a stored turn that had
 * the goals and no mark.
 */
export const GOALS_TURN: Readonly<{ goals: true }> = Object.freeze({ goals: true });

/** Was this stored turn answered with Will's goals in its context? */
export function carriedGoals(turn: { context?: unknown }): boolean {
  const c = turn.context;
  return !!c && typeof c === 'object' && (c as { goals?: unknown }).goals === true;
}

/**
 * Every mark that keeps a stored turn on this Mac, as the test that reads it.
 * There are two: the turn was answered with Will's goals in its context, or
 * Will kept it private (./private-turns: Local Only, the words, any turn of
 * Local mode). A turn can carry both. The history a brain is handed, what a
 * later local turn carries, the extractor's rule and the speech rule all go
 * through this list (`keptHere`, or one mark's own test where the two differ:
 * FLINT_GOALS_TO_FRONTIER lifts the first mark and never the second).
 */
export const STAY_MARKS: ReadonlyArray<(turn: { context?: unknown }) => boolean> = [carriedGoals, wasPrivate];

/** What a stored turn that stays here carries in its call context: one mark, or both. */
export type StayMark = Readonly<{ goals?: true; private?: true }>;

/** A turn that was answered with Will's goals AND is one he kept private: it keeps both marks. */
const BOTH_MARKS: StayMark = Object.freeze({ goals: true, private: true });

/** The call context for a turn with these marks; undefined for a turn with none. */
export function stayMark(marks: { goals: boolean; private: boolean }): StayMark | undefined {
  if (marks.goals && marks.private) return BOTH_MARKS;
  return marks.goals ? GOALS_TURN : marks.private ? PRIVATE_TURN : undefined;
}

/** Is this stored turn marked to stay on this Mac, by any mark? */
export function keptHere(turn: { context?: unknown }): boolean {
  return STAY_MARKS.some((marked) => marked(turn));
}

/**
 * Is this stored turn kept here by a mark that NO setting lifts? Every mark on
 * the list but the goals one: FLINT_GOALS_TO_FRONTIER sends out the turns
 * answered with Will's goals and nothing else, so a turn he kept private (and
 * any kind of turn added to the list later) stays whatever it says.
 */
export function keptStrictly(turn: { context?: unknown }): boolean {
  return STAY_MARKS.some((marked) => marked !== carriedGoals && marked(turn));
}

/** What stands in an outside brain's history where such turns were. It says nothing of what they held. */
export const HISTORY_GAP = '[An earlier part of this conversation isn’t shown here.]';

/**
 * May this brain be given what stays on this Mac: Will's goals, the turns that
 * were answered with them, and the facts Flint learned from those turns? A
 * brain on this Mac (./policy brainIsLocal): yes. Any other: only once Will set
 * FLINT_GOALS_TO_FRONTIER=on. A brain nobody can name: never.
 */
export function staysHere(brain: AnsweringBrain | undefined, toFrontier: boolean): boolean {
  return !!brain && (toFrontier || brainIsLocal(brain));
}

/**
 * May this brain be given what Will kept PRIVATE: the turns he kept on this
 * Mac (./private-turns) and the facts learned from them? Only a brain on this
 * Mac (./policy brainIsLocal). No setting lifts it: FLINT_GOALS_TO_FRONTIER is
 * about his goals.
 */
export function keepsPrivate(brain: AnsweringBrain | undefined): boolean {
  return !!brain && brainIsLocal(brain);
}

/**
 * The conversation store as one brain may read it. A brain that may read what
 * stays here reads all of it. Any other brain reads it without the turns that
 * are marked to stay here (keptHere): the question and the answer are both
 * left out (the answer may repeat a goal, and the question may be about one),
 * and HISTORY_GAP stands where they were.
 * FLINT_GOALS_TO_FRONTIER=on lifts this for the turns answered with Will's
 * goals, as it lifts the block's own rule: Will chose to send goal text out.
 * It lifts nothing for a turn he kept private: no brain off this Mac is ever
 * handed one.
 *
 * Which view a brain reads is decided at each read, not once when the brain is
 * built: whether it runs on this Mac is its Ollama's own word (./policy
 * brainIsLocal), and that is not known at boot and can change.
 *
 * And the read is tied to the turn it is for. A brain on this Mac is handed a
 * marked turn only for a turn that was begun, through this very view, with
 * that same mark: so a turn that is stored unmarked can never have read a
 * marked one, and a turn stored with the goals mark alone can never have read
 * a private one (which FLINT_GOALS_TO_FRONTIER would then send out), whatever
 * was decided when its ask was built (a marked turn that finished in between,
 * a brain that became local in between). A read with no turn begun for it, and
 * reads of two turns begun at once in one conversation (which cannot be told
 * apart), get the view a brain off this Mac gets.
 */
export function historyFor(store: PersistentStore, brain: AnsweringBrain | undefined, toFrontier: boolean): MemoryStore {
  /** As a brain off this Mac reads it: without every turn that stays here. */
  const outside = store.viewWithout(keptHere, HISTORY_GAP);
  /** Without the turns no setting lifts (the ones Will kept private): what a goals turn reads, and any named brain once he sends his goals out. */
  const open = store.viewWithout(keptStrictly, HISTORY_GAP);
  /** The turns begun through this view whose history has not been read yet, by conversation, oldest first. */
  const begun = new Map<string, Array<{ turnId: string; goals: boolean; private: boolean; apart: boolean }>>();
  return {
    ...outside,
    beginTurn: async (input) => {
      const turn = await store.beginTurn(input);
      const waiting = begun.get(input.conversationId) ?? [];
      const marked = { context: input.context };
      waiting.push({ turnId: input.turnId, goals: carriedGoals(marked), private: keptStrictly(marked), apart: true });
      begun.set(input.conversationId, waiting);
      return turn;
    },
    getMessages: (conversationId) => {
      // Only turns that are still being answered can be waiting for their history.
      const waiting = (begun.get(conversationId) ?? []).filter((w) => store.matches(conversationId, w.turnId, (t) => t.status === 'pending'));
      // Two at once: this read could be either's, so neither is handed what only one of them may read.
      if (waiting.length > 1) for (const w of waiting) w.apart = false;
      const mine = waiting.shift();
      if (waiting.length) begun.set(conversationId, waiting);
      else begun.delete(conversationId);
      const tied = mine !== undefined && mine.apart ? mine : undefined;
      // A turn Will kept private, on a brain on this Mac: all of it. Nothing that turn says is ever read off this Mac.
      if (tied?.private && keepsPrivate(brain)) return store.getMessages(conversationId);
      // The turns answered with Will's goals, and never the private ones: for a goals turn on a brain that may
      // read them, and for any named brain once Will set FLINT_GOALS_TO_FRONTIER=on (as before: every read).
      if (toFrontier ? staysHere(brain, true) : tied?.goals === true && staysHere(brain, false)) return open.getMessages(conversationId);
      return outside.getMessages(conversationId);
    },
  };
}

// ---------------------------------------------------------------------------
// the brains /chat can ask

/** A brain, and the room its context really has: its window in tokens and its reply's share of it. */
export interface ChatBrain extends AnsweringBrain {
  /** The context window the model will really have: the client's own `num_ctx`, else its capability table's. Unknown: no limit is applied. */
  window?: number;
  /** Tokens kept for the reply: what the model may write, and never more than a quarter of the window. */
  reserve?: number;
}

/** The slice of a provider adapter that says who it is and how much it can hold. */
export interface SizedProvider {
  readonly name: string;
  getCapabilities?: (model: string) => Pick<ModelCapabilities, 'maxContextTokens' | 'maxOutputTokens'>;
}

/** A provider and its model as a ChatBrain: its name, address and real context size, read from the adapter itself. */
export function chatBrain(provider: SizedProvider, model: string): ChatBrain {
  const brain = brainOf(provider, model);
  const caps = provider.getCapabilities?.(model);
  const window = brain.numCtx ?? caps?.maxContextTokens;
  if (!window || !Number.isFinite(window) || window <= 0) return brain;
  return { ...brain, window, reserve: Math.min(caps?.maxOutputTokens ?? Number.POSITIVE_INFINITY, Math.floor(window / 4)) };
}

/** The local brain as main() built it: its persona, its provider adapter and its model. */
export interface LocalBrain<P> {
  persona: P;
  provider: SizedProvider;
  model: string;
}

/**
 * Every persona /chat can ask, with the brain it speaks for: the local one
 * (and the standby local model, when there is one), each tier's, the last
 * resort's. This is what brainIsLocal (./policy) is asked
 * about, per ask; anything else that must know whether an ask stays on this Mac
 * can look its persona up here too. A persona that is not in it is unknown,
 * and unknown is never local.
 */
export function chatBrains<P>(local: LocalBrain<P>, tiers: BrainSet<P> | undefined, others: ReadonlyArray<LocalBrain<P>> = []): Map<P, ChatBrain> {
  const brains = new Map<P, ChatBrain>([[local.persona, chatBrain(local.provider, local.model)]]);
  // The other local models that can answer a turn (the standby, while the main one loads): named like the first.
  for (const b of others) if (!brains.has(b.persona)) brains.set(b.persona, chatBrain(b.provider, b.model));
  for (const b of tiers ? [...TIERS.map((t) => tiers.get(t)), ...(tiers.lastResort ? [tiers.lastResort] : [])] : []) {
    if (!brains.has(b.persona)) brains.set(b.persona, chatBrain(b.provider, b.model));
  }
  return brains;
}

/**
 * How many tokens a brain's context has left for the goals block, given the
 * characters the rest of the ask's prompt takes (core's own budgeting measure,
 * four characters a token). Infinity for a brain whose window is not known.
 */
export function promptRoom(brain: ChatBrain, promptChars: number): number {
  if (!brain.window) return Number.POSITIVE_INFINITY;
  return brain.window - (brain.reserve ?? 0) - Math.ceil(Math.max(0, promptChars) / 4) - GOALS_PROMPT_MARGIN;
}

// ---------------------------------------------------------------------------
// one turn's goals, handed out per ask

/** One ask of one brain, before anything that stays here: what the turn would give it. */
export interface Ask {
  /** The turn's context as ANY brain may read it: the clock, recall without the facts that stay here, World now. */
  context: string;
  /**
   * The same context with every recalled fact in it, when some of them stay
   * here (./grounding recallContext): what a brain that may read them is given
   * instead. Left out, or the same text: nothing recalled stays here.
   */
  here?: string;
  /**
   * The same context without the facts learned from a turn Will kept PRIVATE
   * (./knowledge `fromPrivate`), when some were recalled: the facts learned
   * from his goals are still in it. It is what a brain off this Mac is given
   * once he set FLINT_GOALS_TO_FRONTIER=on, which lifts nothing private. Left
   * out: `here` (a caller that does not tell the two kinds of fact apart has
   * no private ones).
   */
  lifted?: string;
  /**
   * A turn answered with Will's goals is in the history this conversation's
   * next message carries (the store's `windowHas(conversationId,
   * carriedGoals)`). A brain that may read it has then read it, so its ask
   * carries what stays here whether or not it is also given the goals or a
   * fact.
   */
  carried?: boolean;
  /**
   * A turn Will kept private is in that history (`windowHas(conversationId,
   * keptStrictly)`). A brain on this Mac has then read it, so its own turn is
   * kept private too.
   */
  carriedPrivate?: boolean;
  /**
   * The turn itself is one that stays on this Mac by its route (./private-turns
   * turnStaysHere: Will kept it private, or Flint is in Local mode). It is
   * marked whichever brain is asked, and whatever that brain is given.
   */
  kept?: boolean;
  /** The tools the turn would offer. */
  tools?: readonly Tool[];
  /**
   * Characters of the rest of the prompt this brain will be sent: its persona's
   * guide, the conversation's history and the message. The context and the
   * tools are counted here; leave them out.
   */
  promptChars?: number;
}

/** One ask of one brain, as it is to be made. */
export interface Asked {
  context: string;
  tools: readonly Tool[];
  /** The goals block's size in this ask's prompt (0: it went without). */
  tokens: number;
  /** For the call's options: marks the turn as one that stays here, with each mark that applies. Empty when none does. */
  mark: { context?: StayMark };
}

const toolChars = (tools: readonly Tool[]): number => (tools.length ? JSON.stringify(tools.map((t) => t.definition)).length : 0);

interface TurnRules<P> {
  brainOf: (persona: P) => ChatBrain | undefined;
  mayRead: (persona: P) => boolean;
  /** Is the ask being made running as a local model's turn (./turn-taint isLocalTurn)? Not asked once Will sends his goals out. */
  localTurn: () => boolean;
  /** The tools for an ask that carries what stays here (./goals-tools); the same tools when nothing needs holding back. */
  tools: (offered: readonly Tool[]) => readonly Tool[];
  /** May this persona's brain read what Will kept private, asked as a local model's turn? No setting lifts either half. */
  privately: (persona: P) => boolean;
  /** The tools for an ask whose turn is kept private: what it saves is marked private (and `goals`: with the goals mark too). */
  toolsPrivate: (offered: readonly Tool[], goals: boolean) => readonly Tool[];
}

/**
 * One turn's goals. The answer is private to this object: `ask` is the only way
 * out, and it decides for the brain it is told will read it.
 */
export class TurnGoals<P> {
  readonly #answer: GoalsNowAnswer | undefined;
  readonly #rules: TurnRules<P>;

  constructor(answer: GoalsNowAnswer | undefined, rules: TurnRules<P>) {
    this.#answer = answer;
    this.#rules = rules;
  }

  /**
   * This ask, with what stays on this Mac only when this persona's brain may
   * read it and the ask runs as a local model's turn: the recalled facts that
   * stay here (`here`), and Will's goals after them while the brain's real
   * context has room. When it carries either, or its history holds a turn that
   * stays here (`carried`), it also carries only the tools that keep them
   * here, and the mark that keeps the turn out of an outside brain's history
   * and what is learned from it out of an outside brain's recall. Every other
   * ask is the one any brain may be given.
   *
   * What Will kept private is handed out by the same steps, to a brain on this
   * Mac only, and FLINT_GOALS_TO_FRONTIER changes none of them. The turn is
   * marked private when its route keeps it here (`kept`: then whichever brain
   * is asked), when its brain was given a fact learned from a private turn, or
   * when its history holds a private turn that brain may read. A turn that is
   * both keeps both marks.
   */
  ask(persona: P, a: Ask): Asked {
    const offered = a.tools ?? [];
    const brain = this.#rules.brainOf(persona);
    // Will's goals, the turns answered with them and the facts learned from them: a brain that may read them.
    const goalsOk = !!brain && this.#rules.mayRead(persona) && this.#rules.localTurn();
    // What he kept private: a brain on this Mac, asked as a local model's turn.
    const privateOk = !!brain && this.#rules.privately(persona);
    const whole = a.here ?? a.context;
    const lifted = a.lifted ?? whole;
    const base = privateOk ? whole : goalsOk ? lifted : a.context;
    // Private: by its route, by a private fact it was given, or by a private turn in the history it reads.
    const priv = a.kept === true || (privateOk && (whole !== lifted || a.carriedPrivate === true));
    // (The two builds of a tool are the same size in the prompt: which mark `remember` saves with is settled below.)
    const sized = priv ? this.#rules.toolsPrivate(offered, false) : this.#rules.tools(offered);
    const text = goalsOk && this.#answer ? render(this.#answer, promptRoom(brain, (a.promptChars ?? 0) + base.length + toolChars(sized))) : '';
    // The goals mark: the block, a fact learned from a goals turn, or a goals turn in its history.
    const goals = goalsOk && (!!text || lifted !== a.context || a.carried === true);
    // Neither a fact that stays here, nor the goals, nor a turn that stays here in its history, nor a route that
    // keeps it here: an ordinary ask, with every tool and no mark.
    const context = stayMark({ goals, private: priv });
    if (!context) return { context: a.context, tools: offered, tokens: 0, mark: {} };
    const tools = priv ? this.#rules.toolsPrivate(offered, goals) : sized;
    return { context: text ? (base ? `${base}\n\n${text}` : text) : base, tools, tokens: text ? estimateTokens(text) : 0, mark: { context } };
  }
}

export interface GoalsNowOptions<P> {
  runtime: () => Runtime | undefined;
  /** Which brain a persona speaks for. Undefined (a persona this server did not build): it never reads goals. */
  brainOf: (persona: P) => ChatBrain | undefined;
  /** Will set FLINT_GOALS_TO_FRONTIER=on: every brain may read his goals, outside ones too. Default: false. */
  toFrontier?: boolean;
  /**
   * FLINT_GOALS_NOW: is the goals block itself on? Default: true. Off, the
   * runtime is never asked and no ask gets the block; an ask is still handed
   * the recalled facts that stay here by the same rules (they were learned
   * while it was on).
   */
  on?: boolean;
  /**
   * Is the ask being made running as a local model's turn (./turn-taint
   * isLocalTurn)? What stays here goes only to such an ask. Default: yes (a
   * caller with no such mark); main() always passes the mark.
   */
  localTurn?: () => boolean;
  /** What an ask that carries the block is offered, from what the turn would offer (./goals-tools). Default: the same tools. */
  tools?: (offered: readonly Tool[]) => readonly Tool[];
  /**
   * What an ask whose turn is kept private is offered (`goals`: it carries
   * Will's goals too). Never lifted by `toFrontier`. Default: `tools`, else the
   * same tools.
   */
  toolsPrivate?: (offered: readonly Tool[], goals: boolean) => readonly Tool[];
  /**
   * Is there, right now, a brain that may read the goals? Asked each turn:
   * with none, the runtime is not asked for them. Default: yes.
   */
  readers?: () => boolean;
  fetchImpl?: typeof fetch;
  /** How long an answer (or a failure) is reused (default 30 s). */
  ttlMs?: number;
  /** How long the runtime has to answer (default 300 ms). */
  timeoutMs?: number;
  /** The oldest answer served (default 5 min). */
  maxAgeMs?: number;
  now?: () => number;
}

export class GoalsNow<P> {
  /** The last good answer. Private at run time too (`#`): it leaves only inside a TurnGoals. */
  #good: { at: number; answer: GoalsNowAnswer | undefined } | undefined;
  private triedAt = Number.NEGATIVE_INFINITY;
  private inflight: Promise<void> | undefined;
  readonly #rules: TurnRules<P>;

  constructor(private readonly opts: GoalsNowOptions<P>) {
    this.#rules = {
      brainOf: opts.brainOf,
      mayRead: (p) => this.mayRead(p),
      // Will chose to send goal text out: it goes to any brain's ask, and nothing is held back from one.
      localTurn: opts.toFrontier === true || !opts.localTurn ? () => true : opts.localTurn,
      tools: opts.toFrontier === true || !opts.tools ? (offered) => offered : opts.tools,
      // Nothing private is lifted: the brain is on this Mac and the ask is a local model's turn, whatever Will set for his goals.
      privately: (p) => keepsPrivate(opts.brainOf(p)) && (opts.localTurn?.() ?? true),
      toolsPrivate: opts.toolsPrivate ?? (opts.tools ? (offered) => opts.tools!(offered) : (offered) => offered),
    };
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /** May this persona's brain read what stays on this Mac (staysHere)? On this Mac: yes. Anywhere else: only if Will said so. */
  mayRead(persona: P): boolean {
    return staysHere(this.opts.brainOf(persona), this.opts.toFrontier === true);
  }

  /** This turn's goals, fetched or cached once; each ask of a brain then goes through `TurnGoals.ask`. */
  async forTurn(): Promise<TurnGoals<P>> {
    // The block is off, or no brain may read it: nothing is fetched, and the turn's asks are still made by the same rules.
    if (this.opts.on === false || this.opts.readers?.() === false) return new TurnGoals(undefined, this.#rules);
    // A turn that arrives while another's fetch is out waits for that one (still within its 300 ms).
    if (!this.inflight && this.now() - this.triedAt >= (this.opts.ttlMs ?? 30_000)) {
      this.inflight = this.refresh().finally(() => {
        this.inflight = undefined;
      });
    }
    if (this.inflight) await this.inflight;
    const at = this.now();
    const answer = this.#good && at - this.#good.at <= (this.opts.maxAgeMs ?? 5 * 60_000) ? this.#good.answer : undefined;
    return new TurnGoals(answer, this.#rules);
  }

  private async refresh(): Promise<void> {
    const started = this.now();
    this.triedAt = started;
    const rt = this.opts.runtime();
    if (!rt) {
      this.#good = undefined;
      return;
    }
    try {
      const r = await (this.opts.fetchImpl ?? fetch)(`${rt.url}/v1/goals/now`, {
        headers: { authorization: `Bearer ${rt.token}` },
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 300),
      });
      if (!r.ok) {
        // An older runtime (404, or 400 from its goal-by-id route), a token it refuses (403): quiet, and
        // remembered as a failure until the TTL passes.
        await r.body?.cancel().catch(() => {});
        return;
      }
      this.#good = { at: started, answer: safeAnswer(await r.json()) };
    } catch {
      // A timeout or a bad answer: remembered as a failure until the TTL passes.
    }
  }
}

export interface GoalsForChat<P> {
  /** FLINT_GOALS_NOW (./context-blocks): is the goals block on? Off, the same rules still hand out the facts that stay here. */
  on: boolean;
  runtime: () => Runtime | undefined;
  local: LocalBrain<P>;
  /** The frontier tiers, when there are any. */
  tiers: BrainSet<P> | undefined;
  toFrontier: boolean;
  /** What an ask that carries what stays here is offered (./goals-tools withoutOutsideAi). */
  tools?: (offered: readonly Tool[]) => readonly Tool[];
  /** What an ask whose turn is kept private is offered (`goals`: it carries Will's goals too). */
  toolsPrivate?: (offered: readonly Tool[], goals: boolean) => readonly Tool[];
  /** The other local models that can answer a turn: the standby, when there is one. */
  others?: ReadonlyArray<LocalBrain<P>>;
  /** Is the ask being made running as a local model's turn (./turn-taint isLocalTurn)? */
  localTurn: () => boolean;
  fetchImpl?: typeof fetch;
}

/**
 * What stays on this Mac in chat, for this server's brains, as main() wires
 * it (through ./goals-chat): every persona /chat can ask is named with its
 * brain (chatBrains). It is built again whenever the local brain is swapped
 * (main()'s adoptLocal), so the brain it names is the one that answers.
 *
 * It is always there, whether or not the goals block is on: the turns that
 * were answered with the goals, and the facts learned from them, are held to
 * the same rules after the block is turned off. With the block off, or while
 * no brain may read it, the runtime is never asked.
 */
export function goalsForChat<P>(o: GoalsForChat<P>): GoalsNow<P> {
  const brains = chatBrains(o.local, o.tiers, o.others);
  return new GoalsNow<P>({
    on: o.on, runtime: o.runtime, brainOf: (p) => brains.get(p), toFrontier: o.toFrontier, localTurn: o.localTurn,
    // Asked each turn: which brains run on this Mac is their Ollama's word, and it is not known at boot.
    readers: () => [...brains.values()].some((b) => staysHere(b, o.toFrontier)),
    ...(o.tools ? { tools: o.tools } : {}), ...(o.toolsPrivate ? { toolsPrivate: o.toolsPrivate } : {}), ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}),
  });
}

/**
 * The boot log's line about Will's goals in chat: which brains read them, in
 * how large a context, and which never do. Nothing when the block is off (off
 * is the default, and is not news). Brain labels and sizes only, never an
 * address and never a goal's words. It says what is true when it is asked, so
 * it is asked once each brain's Ollama has said what runs on it.
 */
export function describeGoals<P>(o: Pick<GoalsForChat<P>, 'on' | 'local' | 'tiers' | 'toFrontier' | 'others'>): string | undefined {
  if (!o.on) return undefined;
  const brains = [...chatBrains(o.local, o.tiers, o.others).values()];
  // A local wire that is not local is said so, since its label alone would not: an Ollama cloud model, a server on
  // another machine, a model its Ollama says runs elsewhere (`not on this Mac`), or one that Ollama simply does not
  // have (`not downloaded`: ./policy notLocalWhy).
  const label = (b: ChatBrain) => {
    const why = notLocalWhy(b);
    return `${b.provider}:${b.model}${why ? ` (${why})` : ''}`;
  };
  const labels = (list: ChatBrain[], say: (b: ChatBrain) => string = label) => [...new Set(list.map(say))];
  const all = labels(brains);
  if (o.toFrontier) return `[goals-now] on, with FLINT_GOALS_TO_FRONTIER=on: Will's goals are SENT to every brain that answers a chat turn (${all.join(', ')})`;
  // For the brains that read them: the context each really has, since that decides how much of the block fits.
  const here = labels(brains.filter((b) => brainIsLocal(b)), (b) => `${label(b)}${b.window ? `, ${b.window}-token context` : ''}`);
  const elsewhere = labels(brains.filter((b) => !brainIsLocal(b)));
  if (here.length === 0) return `[goals-now] on, but no brain here is known to run on this Mac (${all.join(', ')}), so no chat turn gets Will's goals`;
  return `[goals-now] on: Will's goals go into chat turns answered on this Mac (${here.join('; ')})${elsewhere.length ? `, never to ${elsewhere.join(', ')}` : ''}`;
}
