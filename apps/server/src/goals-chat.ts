/**
 * What stays on this Mac in chat, as the server wires it (Machine plan P3
 * part 4). Every place index.ts decides something about Will's goals, the
 * turns answered with them and the facts learned from them is a call into this
 * module, and the tests drive the same calls (test/goals-mini.ts). The rules
 * themselves are in ./goals-now (the gate), ./goals-tools, ./knowledge and
 * ./policy; this is where they meet a chat turn.
 *
 * The turns Will kept private (./private-turns: Local Only, the words, any
 * turn of Local mode) stay here by the same calls, under a mark of their own
 * that FLINT_GOALS_TO_FRONTIER never lifts: index.ts tells `forTurn` the
 * turn's route, and everything below then holds for it too.
 *
 * What it decides, and where index.ts asks:
 *  - which history a brain reads (`history`): every Flint client is built on
 *    it, the adopted local brain's and an eval candidate's included;
 *  - who the brains are (`name`): called at boot and again whenever the local
 *    brain is swapped, so the gate names the brain that answers. Each brain's
 *    Ollama is asked what really runs on it (./ollama-locality), and the boot
 *    log's line is written once it has answered;
 *  - each ask of a turn (`forTurn`, then `ask`): the context a brain may be
 *    given (the outside twin of the turn's recall for any brain, the whole one
 *    through the gate only), whether its history holds a turn that stays here,
 *    the tools that go with that, the mark for the call's options, the size of
 *    the goals block in the prompt as it was really sent, and the `meta` event
 *    that tells the client the reply stays here;
 *  - whether an ask runs as a local model's turn (`run`): for a tier whose
 *    brain is on this Mac, on /chat and on /generate;
 *  - the tools an ask that carries what stays here is offered (`toolsKeptHere`:
 *    the two local builds, and none an outside AI answers), and the same for a
 *    one-shot answer that stays here (`oneShotTools`);
 *  - what the memory extractor skips and marks (`extractor`);
 *  - whether deep_research's planner, an outside model, is asked (`plannerHeld`);
 *  - recall for a one-shot answer (`recallForAnyBrain`): /generate has no
 *    per-ask gate, so it gets the facts any brain may have;
 *  - whether a fact that stays here may be sent to the embedder (`embedderHere`);
 *  - whether a reply may be sent to an outside speech service (`speechStaysHere`).
 *
 * Kept free of index.ts so it is unit-testable (index.ts runs main() on import).
 */
import type { MemoryStore, Tool } from '@flint/core';
import { estimateTokens } from '@flint/policy';
import type { Runtime } from './audit-sink';
import type { BrainSet } from './brains';
import { deepResearchTool, type DeepResearchDeps } from './deep-research';
import { carriedGoals, chatBrains, describeGoals, goalsForChat, historyFor, keepsPrivate, keptHere, keptStrictly, staysHere, type GoalsNow, type LocalBrain, type StayMark, type TurnGoals } from './goals-now';
import { isAiBacked, withoutOutsideAi } from './goals-tools';
import { contextOutside } from './grounding';
import { rememberTool, type KnowledgeStore } from './knowledge';
import { LOCALITY, type OllamaLocality } from './ollama-locality';
import type { PersistentStore } from './persistent-store';
import { brainIsLocal, brainOf, listedAt, placeUnknown, placedHere, type AnsweringBrain } from './policy';
import { LOCAL_MODE_TURN, PRIVATE_TURN, corpusMark, keptByModeAlone, privateByRequest, turnStaysHere, type StayRoute } from './private-turns';
import type { PaidToolSpec } from './spend';
import { isPartOf } from './spoken-text';
import { asLocalTurn, isLocalTurn } from './turn-taint';

/** What the gate reads off a persona to size its prompt. */
export interface Speaker {
  readonly styleGuide: string;
  readonly engine?: string | undefined;
}

/**
 * The tools an ask that carries what stays here is offered, from what the turn
 * would offer. `marks`: which marks the turn carries, and so which marks what
 * `remember` saves on it carries (Will's goals alone when left out).
 */
export type KeptTools = (offered: readonly Tool[], marks?: { goals?: boolean; private?: boolean }) => readonly Tool[];

/**
 * The tools for an ask that carries what stays on this Mac (./goals-tools):
 * none that an outside AI answers, and local builds of two. `deep_research`
 * with no planner (it plans by rule) and only the search tools that are left;
 * `remember` saving what it is told as a fact that stays here, under the marks
 * of the turn it is called on (a turn answered with Will's goals, one he kept
 * private, or both).
 */
export function toolsKeptHere(o: {
  /** The tools deep_research searches with (the server's MCP tools). */
  search: readonly Tool[];
  embedder?: DeepResearchDeps['embedder'];
  knowledge: KnowledgeStore;
  /** The paid tools, as the spend guard knows them (./spend paidToolSpecs). */
  specs: readonly PaidToolSpec[];
  /** The server's gate for its built-in tools (./tier-gate gateBuiltins). */
  gate?: (tools: Tool[]) => Tool[];
}): KeptTools {
  const research = deepResearchTool({ tools: o.search.filter((t) => !isAiBacked(t.definition.name, o.specs)), ...(o.embedder ? { embedder: o.embedder } : {}) });
  const build = (marks: { fromGoals?: boolean; fromPrivate?: boolean }) => {
    const builds = [research, rememberTool(o.knowledge, marks)];
    return withoutOutsideAi({ specs: o.specs, local: o.gate ? o.gate(builds) : builds });
  };
  const goals = build({ fromGoals: true });
  // The builds for a turn Will kept private are made when the first such turn asks for them.
  let kept: ReturnType<typeof build> | undefined;
  let both: ReturnType<typeof build> | undefined;
  return (offered, marks = { goals: true }) => {
    if (!marks.private) return goals(offered);
    return marks.goals ? (both ??= build({ fromGoals: true, fromPrivate: true }))(offered) : (kept ??= build({ fromPrivate: true }))(offered);
  };
}

/**
 * Is the embedder here? It is an Ollama at OLLAMA_HOST, whatever any brain's
 * own address is: with that host on another machine, the text it is sent
 * leaves this Mac (unless that machine is the model server Will said is his:
 * ./policy placedHere). A fact that stays here is then stored without an
 * embedding (./knowledge), and recall matches it by its words.
 *
 * `model`: the embedding model, when the caller knows it. The address is not
 * the whole of it: a cloud model under a plain name answers at this Mac's own
 * Ollama. With a model named, the embedder is here only while that Ollama
 * lists the model as its own (./policy brainIsLocal, the one rule; the server
 * has that Ollama asked: `GoalsChat.hears`). A fact stored before the answer
 * is in has no embedding, and gets one after.
 */
export function embedderHere(host: string | undefined, model?: string): boolean {
  if (model === undefined) return placedHere(host);
  return brainIsLocal({ provider: 'ollama', model, baseURL: host });
}

/** A recall with the part of it any brain may be given (./grounding recallContext). */
interface Recalled {
  mode: string;
  outside: { block: string; facts: string[] };
}

/**
 * Recall for an answer that has no per-ask gate (/generate): the facts any
 * brain may have, never the ones that stay on this Mac. An eval replay's
 * answer and grounding go on to its judges.
 */
export function recallForAnyBrain(recall: Recalled): { block: string; facts: string[]; mode: string } {
  return { ...recall.outside, mode: recall.mode };
}

/**
 * Must this reply be spoken on the device, and never sent to an outside speech
 * service? Yes when the turn it belongs to is marked to stay on this Mac, by
 * any mark (./goals-now keptHere).
 *
 * The client names the reply: the conversation, and the turn its `meta` event
 * gave it. What it names is not taken on trust:
 *  - a request that names a turn is about that turn, and the words it sends
 *    must be that turn's own reply (`text`, ./spoken-text isPartOf: against
 *    what the server streamed for the turn, `spoken`, or the stored reply).
 *    Another reply's words under an ordinary turn's name are refused;
 *  - a request that names a conversation and no turn could be about any reply
 *    in it, so it is refused while ANY turn the conversation's next message
 *    carries stays here (its window), and when its newest turn does;
 *  - a request that cannot be placed is held to the strictest answer: it stays
 *    here while ANY conversation's newest turn is marked (however old that
 *    turn is), or a marked turn is in any conversation's history window. That
 *    is a request that names nothing, one that names a conversation the store
 *    does not hold, and one that names a turn its conversation does not hold:
 *    a wrong name is not a weaker claim than no name.
 * So whatever a client sends, a reply that stays here is not sent out by it.
 */
export function speechStaysHere(
  store: Pick<PersistentStore, 'matches' | 'turnIds' | 'windowHas' | 'conversationIds'>,
  said: { conversationId?: unknown; turnId?: unknown; text?: unknown },
  spoken?: (conversationId: string, turnId: string) => string | undefined,
): boolean {
  const newest = (cid: string): boolean => {
    const ids = store.turnIds(cid);
    const last = ids[ids.length - 1];
    return last !== undefined && store.matches(cid, last, keptHere);
  };
  const anywhere = (): boolean => store.conversationIds().some((c) => newest(c) || store.windowHas(c, keptHere));
  const cid = typeof said.conversationId === 'string' && said.conversationId ? said.conversationId : undefined;
  if (cid === undefined) return anywhere();
  const held = store.turnIds(cid);
  if (held.length === 0) return anywhere(); // a conversation the store does not hold
  if (said.turnId === undefined || said.turnId === null || said.turnId === '') return newest(cid) || store.windowHas(cid, keptHere);
  if (typeof said.turnId !== 'string' || !held.includes(said.turnId)) return anywhere(); // a turn that is not this conversation's
  const turnId = said.turnId;
  if (store.matches(cid, turnId, keptHere)) return true;
  // The turn may go out. The words must be its own: what the server streamed for it, or the reply it is stored with.
  if (said.text === undefined) return false; // (a caller that asks about the turn alone)
  if (typeof said.text !== 'string') return true;
  const text = said.text;
  const live = spoken?.(cid, turnId);
  if (live !== undefined && isPartOf(text, live)) return false;
  return !store.matches(cid, turnId, (t) => isPartOf(text, t.messages.filter((m) => m.role === 'assistant').map((m) => m.content).join('\n')));
}

/** What `/speak` answers instead of calling an outside speech service. The client then speaks with its own voice. */
export const SPEECH_STAYS_HERE = 'this reply stays on this Mac, so it is spoken with this device’s own voice';

/** The `meta` event that tells the client whether the reply being streamed stays on this Mac, and which stored turn it is. */
export interface StaysHereEvent {
  type: 'meta';
  staysHere: boolean;
  /** The stored turn the reply belongs to, for `/speak`. */
  turn?: string;
}

/** One ask of one brain, as /chat is to make it. */
export interface ChatAsk {
  /** The context this brain is given. */
  context: string;
  /** The tools it is offered. */
  tools: readonly Tool[];
  /** For the call's options: marks the stored turn as one that stays here (with each mark that applies). Empty for an ordinary ask. */
  mark: { context?: StayMark };
  /** Does this ask carry anything that stays on this Mac? Its reply then stays here too. */
  staysHere: boolean;
  /** The goals block's size in the prompt as it was really sent (0: it went without). */
  tokens: number;
  /**
   * The event to send the client ahead of this ask's first event: whether the
   * reply stays here, and which stored turn it is (for `/speak`). Asked as each
   * event arrives: undefined until the turn is stored, and after it was given.
   */
  meta(): StaysHereEvent | undefined;
  /**
   * What the server has just streamed to the client as this ask's reply: the
   * model's text, and any line of the server's own shown with it. Kept (for a
   * while, in memory) under the stored turn, so `/speak` can tell that words a
   * client asks to have spoken are that turn's own.
   */
  said(text: string): void;
}

export interface GoalsChatOptions {
  /** The conversation store. */
  memory: PersistentStore;
  /** ./context-blocks: is the goals block on, and did Will choose to send his goals out? */
  blocks: { goals: boolean; goalsToFrontier: boolean };
  runtime: () => Runtime | undefined;
  log: (msg: string) => void;
  /** What each brain's Ollama says runs on it. Default: the server's own record. */
  locality?: Pick<OllamaLocality, 'watch'>;
  fetchImpl?: typeof fetch;
}

/** How many turns' streamed replies are kept for `/speak` (a reply is spoken within moments of being streamed). */
const SPOKEN_TURNS = 64;

export class GoalsChat<P extends Speaker> {
  #gate: GoalsNow<P> | undefined;
  #tools: KeptTools | undefined;
  #named: Promise<void> = Promise.resolve();
  /** What was streamed as each recent turn's reply, by conversation and turn: the newest SPOKEN_TURNS of them. */
  readonly #spoken = new Map<string, string>();
  readonly #o: GoalsChatOptions;

  constructor(opts: GoalsChatOptions) {
    this.#o = opts;
  }

  /** Did Will choose to send his goals to every brain (FLINT_GOALS_TO_FRONTIER=on)? */
  get #out(): boolean {
    return this.#o.blocks.goalsToFrontier;
  }

  /** Ask this brain's Ollama what runs on it, when it has one that is here (./policy listedAt). */
  #watch(brain: AnsweringBrain | undefined): Promise<void> {
    const url = listedAt(brain);
    return url ? (this.#o.locality ?? LOCALITY).watch(url) : Promise.resolve();
  }

  /**
   * Have a server that is no chat brain's asked what runs on it too: Ollama's
   * own address, which the embedder and memory extraction use whatever wire
   * the local brain is on. What it says is what `embedderHere` and the
   * helpers' own rule read (./inference helpersOff).
   */
  hears(server: AnsweringBrain): void {
    void this.#watch(server);
  }

  /**
   * The conversation as this brain may read it (./goals-now historyFor): all
   * of it for a brain on this Mac; for any other, without the turns that stay
   * here. Every Flint client the server builds reads through this.
   */
  history(provider: { readonly name: string }, model: string): MemoryStore {
    const brain = brainOf(provider, model);
    void this.#watch(brain);
    return historyFor(this.#o.memory, brain, this.#out);
  }

  /**
   * Name the brains /chat can ask: the local one and every tier's, and the
   * other local models that can answer a turn (`others`: the standby). Called
   * at boot, and again whenever the local brain is swapped, so the gate
   * decides for the brain that answers. Nothing waits for it: the gate is
   * there at once and hands out nothing until a brain's Ollama has said the
   * model runs on it. The boot log's line follows that answer (`settled`).
   */
  name(local: LocalBrain<P>, tiers: BrainSet<P> | undefined, tools: KeptTools, others: ReadonlyArray<LocalBrain<P>> = []): void {
    const wiring = {
      on: this.#o.blocks.goals, runtime: this.#o.runtime, local, tiers, others, toFrontier: this.#out, localTurn: isLocalTurn,
      tools: (offered: readonly Tool[]) => tools(offered),
      // A turn Will kept private: what `remember` saves on it carries that mark (and the goals mark when it carries them too).
      toolsPrivate: (offered: readonly Tool[], goals: boolean) => tools(offered, { private: true, goals }),
      ...(this.#o.fetchImpl ? { fetchImpl: this.#o.fetchImpl } : {}),
    };
    this.#gate = goalsForChat<P>(wiring);
    this.#tools = tools;
    const asked = [...chatBrains(local, tiers, others).values()].map((b) => this.#watch(b));
    const named: Promise<void> = Promise.all(asked)
      .then(() => {
        // Only the newest naming speaks: a swap that came first has been replaced.
        if (this.#named !== named) return;
        const line = describeGoals(wiring);
        if (line) this.#o.log(line);
      })
      // A log line is never worth the server: nothing here may reject.
      .catch(() => {});
    this.#named = named;
  }

  /** Resolves once the brains last named have been asked about (and the boot log's line is written). */
  get settled(): Promise<void> {
    return this.#named;
  }

  /**
   * One /chat turn: Will's goals, fetched or cached once, for whichever brain
   * ends up asked. Each ask then goes through `ChatTurn.ask`. `route`: how the
   * turn was routed; one that stays here by its route (Will kept it private,
   * or Flint is in Local mode: ./private-turns turnStaysHere) is marked
   * whichever brain is asked.
   */
  async forTurn(conversationId: string, message: string, route?: StayRoute): Promise<ChatTurn<P>> {
    const goals = await this.#gate?.forTurn();
    // With the persona's own words, the rest of the prompt: what the block's room is measured against.
    const restChars = message.length + this.#o.memory.historyChars(conversationId);
    return new ChatTurn<P>(
      this.#o.memory, goals, conversationId, restChars, route !== undefined && turnStaysHere(route), this.#tools,
      (turnId, text) => this.#streamed(conversationId, turnId, text),
      route !== undefined && keptByModeAlone(route),
    );
  }

  /** Keep what was just streamed as a turn's reply (`ChatAsk.said`). */
  #streamed(conversationId: string, turnId: string, text: string): void {
    const key = `${conversationId}\u0000${turnId}`;
    const so_far = this.#spoken.get(key);
    // (Set again, so the newest turn is the last one out.)
    this.#spoken.delete(key);
    this.#spoken.set(key, (so_far ?? '') + text);
    while (this.#spoken.size > SPOKEN_TURNS) this.#spoken.delete(this.#spoken.keys().next().value!);
  }

  /**
   * The tools for a one-shot answer (/generate, which has no per-ask gate and
   * stores no turn). One that stays here by its route is offered the tools
   * that keep it here: what its `remember` saves is marked like a fact learned
   * from a private turn, so it is not recalled for a brain off this Mac a turn
   * later. Any other answer: the same tools.
   */
  oneShotTools<T extends Tool>(route: StayRoute, offered: readonly T[]): readonly Tool[] {
    if (!turnStaysHere(route)) return offered;
    // Before the brains are named there are no builds to offer: then nothing that saves is offered at all.
    return this.#tools ? this.#tools(offered, { private: true }) : offered.filter((t) => t.definition.name !== 'remember');
  }

  /**
   * The mark a one-shot answer's entry in the training corpus carries when its
   * route keeps it here (./private-turns corpusMark). A /chat turn asks its
   * own turn instead (`ChatTurn.corpus`), which also knows what its brain was
   * given.
   */
  corpus(route: StayRoute): { staysHere?: true } {
    return corpusMark(route);
  }

  /**
   * Run an ask as a local model's turn (./turn-taint asLocalTurn) when its
   * brain is on this Mac (./policy brainIsLocal): a tier named `ollama:` at
   * this Mac's own address answers as a local model does. One mark, then, for
   * "a model on this Mac is answering": it is what an ask needs to be given
   * anything that stays here, and what keeps the turn's question from an
   * outside AI. Any other brain's ask runs as it is.
   */
  run<T>(brain: { provider: { readonly name: string }; model: string }, ask: () => T): T {
    return brainIsLocal(brainOf(brain.provider, brain.model)) ? asLocalTurn(ask) : ask();
  }

  /**
   * The memory extractor's rules for the turns that stay here, for the brain
   * it runs on. A brain that may not read such a turn never mines one (it is
   * skipped as a tainted turn is, and is not context for the next either);
   * what a brain that may read one learns from it is marked, and stays on this
   * Mac (./knowledge fromGoals, fromPrivate). Each mark by its own rule: a
   * turn answered with Will's goals is read by a brain on this Mac, or by any
   * once he set FLINT_GOALS_TO_FRONTIER=on; a turn he kept private only by a
   * brain on this Mac, whatever he set. So an extractor on an Ollama on
   * another machine reads neither. `tainted` is the server's own rule, kept.
   *
   * `holdOff`: a turn that is skipped is never mined (the pass moves on past
   * it), so "this brain may not read it" must be a settled answer. While where
   * the extractor's own model runs is simply not known (its Ollama has not been
   * heard from yet, or not for a few minutes: ./policy placeUnknown), the pass
   * does not run at all, and comes back in a moment. Otherwise a pass that
   * began while Ollama was restarting would skip every turn taken in Local
   * mode, for good.
   */
  extractor(o: { brain: AnsweringBrain | undefined; tainted: (conversationId: string, turnId: string) => boolean }): {
    isTainted: (conversationId: string, turnId: string) => boolean;
    carriedGoals: (conversationId: string, turnId: string) => boolean;
    keptPrivate: (conversationId: string, turnId: string) => boolean;
    privateByRequest: (conversationId: string, turnId: string) => boolean;
    holdOff: () => string | undefined;
  } {
    void this.#watch(o.brain);
    const goals = (cid: string, tid: string) => this.#o.memory.matches(cid, tid, carriedGoals);
    const kept = (cid: string, tid: string) => this.#o.memory.matches(cid, tid, keptStrictly);
    return {
      // Asked each time: whether the extractor's brain is on this Mac is its Ollama's word.
      isTainted: (cid, tid) => o.tainted(cid, tid) || (goals(cid, tid) && !staysHere(o.brain, this.#out)) || (kept(cid, tid) && !keepsPrivate(o.brain)),
      carriedGoals: goals,
      keptPrivate: kept,
      // The narrower notion, as stored: a turn Will himself asked to keep private is never asked for a goal.
      privateByRequest: (cid, tid) => this.#o.memory.matches(cid, tid, privateByRequest),
      holdOff: () => {
        if (!placeUnknown(o.brain)) return undefined;
        // (That Ollama is being asked: at once when it has never answered, and every minute after.)
        void this.#watch(o.brain);
        return 'the model server has not said that the memory model runs on this Mac';
      },
    };
  }

  /**
   * Why deep_research's planner is not asked on the ask being made; undefined
   * when it may be. The planner's prompt is the question itself, and the
   * planner is an outside model (`outside`): on a turn a local model is
   * answering (Local-only, a private question, a fallback, a tier on this Mac)
   * it is not asked.
   */
  plannerHeld(outside: boolean): string | undefined {
    return outside && isLocalTurn() ? 'the local model is answering this turn, so its question stays here' : undefined;
  }

  /** Must this reply be spoken on the device (`speechStaysHere`)? `text`: the words the client asks to have spoken. */
  speechStaysHere(said: { conversationId?: unknown; turnId?: unknown; text?: unknown }): boolean {
    return speechStaysHere(this.#o.memory, said, (cid, tid) => this.#spoken.get(`${cid}\u0000${tid}`));
  }
}

/** One /chat turn's asks. */
export class ChatTurn<P extends Speaker> {
  /** Did the ask made last (the one whose answer the turn ends with) carry a mark that keeps its turn here? */
  #stays = false;

  constructor(
    private readonly memory: PersistentStore,
    private readonly goals: TurnGoals<P> | undefined,
    private readonly conversationId: string,
    private readonly restChars: number,
    /** The turn stays here by its route: Will kept it private, or Flint is in Local mode. */
    private readonly kept = false,
    private readonly keptTools?: KeptTools,
    /** Told what was streamed as a stored turn's reply (GoalsChat keeps it for `/speak`). */
    private readonly streamed?: (turnId: string, text: string) => void,
    /** ...and it is the mode alone that keeps it here (Local mode, and Will did not ask for this turn to be private): its mark says so. */
    private readonly byMode = false,
  ) {}

  /**
   * One ask of one brain. `context` is the turn's whole context for it, which
   * begins with the turn's recalled block (`whole`); `outside` is that block
   * without the facts that stay here, and `lifted` is it without the facts
   * from a turn Will kept private only (left out: no fact is told apart that
   * way). Any brain may be given the outside twin. Only the gate hands out the
   * others, Will's goals, and the mark: to a brain that may read them, asked
   * as a local model's turn. An ask whose history holds a turn that stays here
   * carries that turn's mark too, and a turn that stays here by its route is
   * marked whichever brain is asked.
   */
  ask(persona: P, a: { context: string; whole: string; outside: string; lifted?: string; tools: readonly Tool[] }): ChatAsk {
    const open = contextOutside(a.context, a.whole, a.outside);
    const asked = this.goals
      ? this.goals.ask(persona, {
          context: open,
          here: a.context,
          ...(a.lifted !== undefined ? { lifted: contextOutside(a.context, a.whole, a.lifted) } : {}),
          // The history this brain is about to be handed, as the store will hand it.
          carried: this.memory.windowHas(this.conversationId, carriedGoals),
          carriedPrivate: this.memory.windowHas(this.conversationId, keptStrictly),
          kept: this.kept,
          byMode: this.byMode,
          tools: a.tools,
          promptChars: persona.styleGuide.length + (persona.engine?.length ?? 0) + this.restChars,
        })
      : // No brain has been named yet: nothing that stays here is handed out. A turn its route keeps here is still
        // marked, and saves nothing unmarked.
        this.kept
        ? { context: open, tools: this.keptTools ? this.keptTools(a.tools, { private: true }) : a.tools.filter((t) => t.definition.name !== 'remember'), tokens: 0, mark: { context: this.byMode ? LOCAL_MODE_TURN : PRIVATE_TURN } }
        : { context: open, tools: a.tools, tokens: 0, mark: {} };
    const staysHere = asked.mark.context !== undefined;
    this.#stays = staysHere;
    // Measured from the context as it is sent, not from what the gate meant to add: a block that came out
    // larger than its limit shows in the number.
    const added = staysHere && asked.context.length > a.context.length && asked.context.startsWith(a.context) ? asked.context.slice(a.context.length).trim() : '';
    const before = new Set(this.memory.turnIds(this.conversationId));
    let given = false;
    /** The stored turn this ask began, once it is known (and only when it is the one turn begun since). */
    let turn: string | undefined;
    return {
      context: asked.context,
      tools: asked.tools,
      mark: asked.mark,
      staysHere,
      // (A brain that was given the context without Will's private facts does not start with the whole one: the gate's own count stands.)
      tokens: added ? estimateTokens(added) : staysHere && !asked.context.startsWith(a.context) ? asked.tokens : 0,
      meta: () => {
        if (given) return undefined;
        const begun = this.memory.turnIds(this.conversationId).filter((id) => !before.has(id));
        if (begun.length === 0) return undefined; // the turn is not stored yet
        given = true;
        // Two turns begun at once in one conversation cannot be told apart here: the client then names none.
        if (begun.length === 1) turn = begun[0]!;
        return { type: 'meta', staysHere, ...(turn !== undefined ? { turn } : {}) };
      },
      said: (text) => {
        if (turn !== undefined && text) this.streamed?.(turn, text);
      },
    };
  }

  /**
   * The mark this turn's entry in the training corpus carries (./training
   * `staysHere`): set when the turn stays on this Mac, by its route or because
   * the brain that answered was given something that stays here (Will's
   * goals, a fact or a turn that does). Local training uses the example; no
   * set that leaves this Mac takes it. Asked once the turn has been answered:
   * it speaks for the ask made last.
   */
  corpus(): { staysHere?: true } {
    return this.kept || this.#stays ? { staysHere: true } : {};
  }
}
