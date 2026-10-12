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
 *    not one of Ollama's cloud models. Never Anthropic, OpenAI or Perplexity,
 *    never a "local" brain that is really Claude, never a persona this server
 *    did not build.
 *  - What the model then SAYS stays here too. A turn whose brain was given the
 *    block is marked (GOALS_TURN, stored with the turn), and a brain that is
 *    not on this Mac never gets that turn back as history: its question and
 *    its answer are left out, with one neutral line where they were
 *    (historyFor).
 *  - For that ask, the tools an outside AI answers are not offered
 *    (./goals-tools), so a goal's words cannot leave through a tool call to
 *    another company's model.
 *  - Unless Will set FLINT_GOALS_TO_FRONTIER=on (./context-blocks): then every
 *    brain gets the block, the history and the tools, and his goal text is
 *    sent to whichever provider answers.
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
 * model may still put a goal's words in a plain web search's query; what it
 * learns from a turn can become a fact in long-term memory; and the training
 * corpus on this Mac keeps its answers.
 *
 * Kept free of index.ts so it is unit-testable (index.ts runs main() on import).
 */
import type { MemoryStore, ModelCapabilities, Tool } from '@flint/core';
import { GOALS_BLOCK_MAX_CHARS, GOALS_BLOCK_MAX_TOKENS, GoalsNowAnswer, estimateTokens, likelihoodWords, type GoalNow } from '@flint/policy';
import type { Runtime } from './audit-sink';
import { TIERS, type BrainSet } from './brains';
import type { PersistentStore } from './persistent-store';
import { LOCAL_WIRES, brainIsLocal, brainOf, type AnsweringBrain } from './policy';
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

/** What stands in an outside brain's history where such turns were. It says nothing of what they held. */
export const HISTORY_GAP = '[An earlier part of this conversation isn’t shown here.]';

/**
 * The conversation store as one brain may read it. A brain on this Mac reads
 * all of it. Any other brain reads it without the turns that were answered
 * with Will's goals in their context: the question and the answer are both
 * left out (the answer may repeat a goal, and the question may be about one),
 * and HISTORY_GAP stands where they were. FLINT_GOALS_TO_FRONTIER=on lifts
 * this, as it lifts the block's own rule: Will chose to send goal text out.
 */
export function historyFor(store: PersistentStore, brain: AnsweringBrain | undefined, toFrontier: boolean): MemoryStore {
  return toFrontier || brainIsLocal(brain) ? store : store.viewWithout(carriedGoals, HISTORY_GAP);
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
 * Every persona /chat can ask, with the brain it speaks for: the local one,
 * each tier's, the last resort's. This is what brainIsLocal (./policy) is asked
 * about, per ask; anything else that must know whether an ask stays on this Mac
 * can look its persona up here too. A persona that is not in it is unknown,
 * and unknown is never local.
 */
export function chatBrains<P>(local: LocalBrain<P>, tiers: BrainSet<P> | undefined): Map<P, ChatBrain> {
  const brains = new Map<P, ChatBrain>([[local.persona, chatBrain(local.provider, local.model)]]);
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

/** One ask of one brain, before the goals: what the turn would give it. */
export interface Ask {
  /** The turn's context so far (the clock, recall, World now). */
  context: string;
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
  /** For the call's options: marks the turn as answered with Will's goals. Empty when it went without. */
  mark: { context?: typeof GOALS_TURN };
}

const toolChars = (tools: readonly Tool[]): number => (tools.length ? JSON.stringify(tools.map((t) => t.definition)).length : 0);

interface TurnRules<P> {
  brainOf: (persona: P) => ChatBrain | undefined;
  mayRead: (persona: P) => boolean;
  /** The tools for an ask that carries the block (./goals-tools); the same tools when nothing needs holding back. */
  tools: (offered: readonly Tool[]) => readonly Tool[];
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
   * This ask, with Will's goals after its context only when this persona's
   * brain may read them and its real context has room. When it carries them,
   * it also carries only the tools that keep them here, and the mark that
   * keeps the turn out of an outside brain's history.
   */
  ask(persona: P, a: Ask): Asked {
    const offered = a.tools ?? [];
    const without: Asked = { context: a.context, tools: offered, tokens: 0, mark: {} };
    const brain = this.#rules.brainOf(persona);
    if (!this.#answer || !brain || !this.#rules.mayRead(persona)) return without;
    const tools = this.#rules.tools(offered);
    const room = promptRoom(brain, (a.promptChars ?? 0) + a.context.length + toolChars(tools));
    const text = render(this.#answer, room);
    if (!text) return without;
    return { context: a.context ? `${a.context}\n\n${text}` : text, tools, tokens: estimateTokens(text), mark: { context: GOALS_TURN } };
  }
}

export interface GoalsNowOptions<P> {
  runtime: () => Runtime | undefined;
  /** Which brain a persona speaks for. Undefined (a persona this server did not build): it never reads goals. */
  brainOf: (persona: P) => ChatBrain | undefined;
  /** Will set FLINT_GOALS_TO_FRONTIER=on: every brain may read his goals, outside ones too. Default: false. */
  toFrontier?: boolean;
  /** What an ask that carries the block is offered, from what the turn would offer (./goals-tools). Default: the same tools. */
  tools?: (offered: readonly Tool[]) => readonly Tool[];
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
      // Will chose to send goal text out: nothing is held back from an ask.
      tools: opts.toFrontier === true || !opts.tools ? (offered) => offered : opts.tools,
    };
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /** May this persona's brain read Will's goals? On this Mac: yes. Anywhere else: only if Will said so. */
  mayRead(persona: P): boolean {
    const brain = this.opts.brainOf(persona);
    if (!brain) return false;
    return this.opts.toFrontier === true || brainIsLocal(brain);
  }

  /** This turn's goals, fetched or cached once; each ask of a brain then goes through `TurnGoals.ask`. */
  async forTurn(): Promise<TurnGoals<P>> {
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
  runtime: () => Runtime | undefined;
  local: LocalBrain<P>;
  /** The frontier tiers, when there are any. */
  tiers: BrainSet<P> | undefined;
  toFrontier: boolean;
  /** What an ask that carries the block is offered (./goals-tools withoutOutsideAi). */
  tools?: (offered: readonly Tool[]) => readonly Tool[];
  log: (msg: string) => void;
  fetchImpl?: typeof fetch;
}

/**
 * The goals block for this server's brains, as main() wires it: every persona
 * /chat can ask is named with its brain (chatBrains), and the boot log says
 * which of them read Will's goals, in how large a context, and which never do.
 * With no brain that may read them there is nothing to fetch: undefined. Log
 * lines carry brain labels and sizes only, never an address and never a goal's
 * words.
 */
export function goalsForChat<P>(o: GoalsForChat<P>): GoalsNow<P> | undefined {
  const brains = chatBrains(o.local, o.tiers);
  // A local wire that is not local (an Ollama cloud model, or a server on another machine) is said so: its label alone would not.
  const label = (b: ChatBrain) => `${b.provider}:${b.model}${LOCAL_WIRES.has(b.provider) && !brainIsLocal(b) ? ' (not on this Mac)' : ''}`;
  const labels = (list: ChatBrain[], say: (b: ChatBrain) => string = label) => [...new Set(list.map(say))];
  const all = labels([...brains.values()]);
  // For the brains that read them: the context each really has, since that decides how much of the block fits.
  const here = labels([...brains.values()].filter((b) => brainIsLocal(b)), (b) => `${label(b)}${b.window ? `, ${b.window}-token context` : ''}`);
  const elsewhere = labels([...brains.values()].filter((b) => !brainIsLocal(b)));
  if (o.toFrontier) {
    o.log(`[goals-now] on, with FLINT_GOALS_TO_FRONTIER=on: Will's goals are SENT to every brain that answers a chat turn (${all.join(', ')})`);
  } else if (here.length === 0) {
    o.log(`[goals-now] on, but no brain here runs on this Mac (${all.join(', ')}), so no chat turn gets Will's goals`);
    return undefined;
  } else {
    o.log(`[goals-now] on: Will's goals go into chat turns answered on this Mac (${here.join('; ')})${elsewhere.length ? `, never to ${elsewhere.join(', ')}` : ''}`);
  }
  return new GoalsNow<P>({
    runtime: o.runtime, brainOf: (p) => brains.get(p), toFrontier: o.toFrontier,
    ...(o.tools ? { tools: o.tools } : {}), ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}),
  });
}
