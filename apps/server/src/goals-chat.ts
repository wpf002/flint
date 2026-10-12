/**
 * What stays on this Mac in chat, as the server wires it (Machine plan P3
 * part 4). Every place index.ts decides something about Will's goals, the
 * turns answered with them and the facts learned from them is a call into this
 * module, and the tests drive the same calls (test/goals-mini.ts). The rules
 * themselves are in ./goals-now (the gate), ./goals-tools, ./knowledge and
 * ./policy; this is where they meet a chat turn.
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
 *    the two local builds, and none an outside AI answers);
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
import { GOALS_TURN, chatBrains, describeGoals, goalsForChat, historyFor, keptHere, staysHere, type GoalsNow, type LocalBrain, type TurnGoals } from './goals-now';
import { isAiBacked, withoutOutsideAi } from './goals-tools';
import { contextOutside } from './grounding';
import { rememberTool, type KnowledgeStore } from './knowledge';
import { LOCALITY, type OllamaLocality } from './ollama-locality';
import type { PersistentStore } from './persistent-store';
import { brainIsLocal, brainOf, listedAt, onThisMachine, type AnsweringBrain } from './policy';
import type { PaidToolSpec } from './spend';
import { asLocalTurn, isLocalTurn } from './turn-taint';

/** What the gate reads off a persona to size its prompt. */
export interface Speaker {
  readonly styleGuide: string;
  readonly engine?: string | undefined;
}

/** The tools an ask that carries what stays here is offered, from what the turn would offer. */
export type KeptTools = (offered: readonly Tool[]) => readonly Tool[];

/**
 * The tools for an ask that carries what stays on this Mac (./goals-tools):
 * none that an outside AI answers, and local builds of two. `deep_research`
 * with no planner (it plans by rule) and only the search tools that are left;
 * `remember` saving what it is told as a fact that stays here.
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
  const builds = [
    deepResearchTool({ tools: o.search.filter((t) => !isAiBacked(t.definition.name, o.specs)), ...(o.embedder ? { embedder: o.embedder } : {}) }),
    rememberTool(o.knowledge, { fromGoals: true }),
  ];
  return withoutOutsideAi({ specs: o.specs, local: o.gate ? o.gate(builds) : builds });
}

/**
 * Is the embedder on this Mac? It is an Ollama at OLLAMA_HOST, whatever any
 * brain's own address is: with that host on another machine, the text it is
 * sent leaves this Mac. A fact that stays here is then stored without an
 * embedding (./knowledge), and recall matches it by its words.
 */
export function embedderHere(host: string | undefined): boolean {
  return onThisMachine(host);
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
 * gave it. A request that names a conversation and no turn is about that
 * conversation's newest turn. A request that cannot be placed is held to the
 * strictest answer: it stays here while ANY conversation's newest turn is
 * marked (however old that turn is), or a marked turn is in any
 * conversation's history window. That is a request that names nothing, one
 * that names a conversation the store does not hold, and one that names a
 * turn its conversation does not hold: a wrong name is not a weaker claim
 * than no name.
 */
export function speechStaysHere(
  store: Pick<PersistentStore, 'matches' | 'turnIds' | 'windowHas' | 'conversationIds'>,
  said: { conversationId?: unknown; turnId?: unknown },
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
  if (said.turnId === undefined || said.turnId === null || said.turnId === '') return newest(cid);
  if (typeof said.turnId !== 'string' || !held.includes(said.turnId)) return anywhere(); // a turn that is not this conversation's
  return store.matches(cid, said.turnId, keptHere);
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
  /** For the call's options: marks the stored turn as one that stays here. Empty for an ordinary ask. */
  mark: { context?: typeof GOALS_TURN };
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

export class GoalsChat<P extends Speaker> {
  #gate: GoalsNow<P> | undefined;
  #named: Promise<void> = Promise.resolve();
  readonly #o: GoalsChatOptions;

  constructor(opts: GoalsChatOptions) {
    this.#o = opts;
  }

  /** Did Will choose to send his goals to every brain (FLINT_GOALS_TO_FRONTIER=on)? */
  get #out(): boolean {
    return this.#o.blocks.goalsToFrontier;
  }

  /** Ask this brain's Ollama what runs on it, when it has one on this Mac (./policy listedAt). */
  #watch(brain: AnsweringBrain | undefined): Promise<void> {
    const url = listedAt(brain);
    return url ? (this.#o.locality ?? LOCALITY).watch(url) : Promise.resolve();
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
   * Name the brains /chat can ask: the local one and every tier's. Called at
   * boot, and again whenever the local brain is swapped, so the gate decides
   * for the brain that answers. Nothing waits for it: the gate is there at
   * once and hands out nothing until a brain's Ollama has said the model runs
   * on it. The boot log's line follows that answer (`settled`).
   */
  name(local: LocalBrain<P>, tiers: BrainSet<P> | undefined, tools: KeptTools): void {
    const wiring = { on: this.#o.blocks.goals, runtime: this.#o.runtime, local, tiers, toFrontier: this.#out, tools, localTurn: isLocalTurn, ...(this.#o.fetchImpl ? { fetchImpl: this.#o.fetchImpl } : {}) };
    this.#gate = goalsForChat<P>(wiring);
    const asked = [...chatBrains(local, tiers).values()].map((b) => this.#watch(b));
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
   * ends up asked. Each ask then goes through `ChatTurn.ask`.
   */
  async forTurn(conversationId: string, message: string): Promise<ChatTurn<P>> {
    const goals = await this.#gate?.forTurn();
    // With the persona's own words, the rest of the prompt: what the block's room is measured against.
    const restChars = message.length + this.#o.memory.historyChars(conversationId);
    return new ChatTurn<P>(this.#o.memory, goals, conversationId, restChars);
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
   * Mac (./knowledge fromGoals). `tainted` is the server's own rule, kept.
   */
  extractor(o: { brain: AnsweringBrain | undefined; tainted: (conversationId: string, turnId: string) => boolean }): {
    isTainted: (conversationId: string, turnId: string) => boolean;
    carriedGoals: (conversationId: string, turnId: string) => boolean;
  } {
    void this.#watch(o.brain);
    const kept = (cid: string, tid: string) => this.#o.memory.matches(cid, tid, keptHere);
    return {
      // Asked each time: whether the extractor's brain is on this Mac is its Ollama's word.
      isTainted: (cid, tid) => o.tainted(cid, tid) || (kept(cid, tid) && !staysHere(o.brain, this.#out)),
      carriedGoals: kept,
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

  /** Must this reply be spoken on the device (`speechStaysHere`)? */
  speechStaysHere(said: { conversationId?: unknown; turnId?: unknown }): boolean {
    return speechStaysHere(this.#o.memory, said);
  }
}

/** One /chat turn's asks. */
export class ChatTurn<P extends Speaker> {
  constructor(
    private readonly memory: PersistentStore,
    private readonly goals: TurnGoals<P> | undefined,
    private readonly conversationId: string,
    private readonly restChars: number,
  ) {}

  /**
   * One ask of one brain. `context` is the turn's whole context for it, which
   * begins with the turn's recalled block (`whole`); `outside` is that block
   * without the facts that stay here. Any brain may be given the outside twin.
   * Only the gate hands out the whole one, Will's goals, and the mark: to a
   * brain that may read them, asked as a local model's turn. An ask whose
   * history holds a turn that stays here carries the mark too.
   */
  ask(persona: P, a: { context: string; whole: string; outside: string; tools: readonly Tool[] }): ChatAsk {
    const open = contextOutside(a.context, a.whole, a.outside);
    const asked = this.goals
      ? this.goals.ask(persona, {
          context: open,
          here: a.context,
          // The history this brain is about to be handed, as the store will hand it.
          carried: this.memory.windowHas(this.conversationId, keptHere),
          tools: a.tools,
          promptChars: persona.styleGuide.length + (persona.engine?.length ?? 0) + this.restChars,
        })
      : { context: open, tools: a.tools, tokens: 0, mark: {} };
    const staysHere = asked.mark.context !== undefined;
    // Measured from the context as it is sent, not from what the gate meant to add: a block that came out
    // larger than its limit shows in the number.
    const added = staysHere && asked.context.length > a.context.length && asked.context.startsWith(a.context) ? asked.context.slice(a.context.length).trim() : '';
    const before = new Set(this.memory.turnIds(this.conversationId));
    let given = false;
    return {
      context: asked.context,
      tools: asked.tools,
      mark: asked.mark,
      staysHere,
      tokens: added ? estimateTokens(added) : 0,
      meta: () => {
        if (given) return undefined;
        const begun = this.memory.turnIds(this.conversationId).filter((id) => !before.has(id));
        if (begun.length === 0) return undefined; // the turn is not stored yet
        given = true;
        // Two turns begun at once in one conversation cannot be told apart here: the client then names none.
        return { type: 'meta', staysHere, ...(begun.length === 1 ? { turn: begun[0]! } : {}) };
      },
    };
  }
}
