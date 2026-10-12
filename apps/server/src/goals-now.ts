/**
 * Will's goals in chat context (Machine plan P3 part 4): a short block from the
 * runtime's GET /v1/goals/now, so "how are my goals going?" starts from what
 * they are and where they stand.
 *
 * Goal text is PERSONAL, so the block never leaves this Mac by default:
 *
 *  - It is handed out per ASK, not per turn. A turn can ask several brains (a
 *    frontier tier, the next tier, then the local model), and each gets the
 *    block only if that brain may read it: `TurnGoals.ask(persona, context)`.
 *    Nothing else returns the text: there is no way to read the block without
 *    naming the brain that will read it.
 *  - A brain may read it when it runs on this Mac (./policy brainIsLocal, the
 *    one place that is decided): an Ollama model at a loopback address that is
 *    not one of Ollama's cloud models. Never Anthropic, OpenAI or Perplexity,
 *    never a "local" brain that is really Claude, never a persona this server
 *    did not build.
 *  - Unless Will set FLINT_GOALS_TO_FRONTIER=on (./context-blocks): then every
 *    brain gets it, and his goal text is sent to whichever provider answers.
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
 * Like World now: at most 300 tokens and 1,200 characters (estimateTokens),
 * trimmed at whole lines with the rest counted; 300 ms to answer, cached 30 s,
 * a failure remembered for those 30 s too (an older runtime, a refused token),
 * nothing older than 5 minutes served. It rides in the persona context (the
 * system prompt's per-turn suffix), so it is never stored in the conversation.
 *
 * Its limits (the README's "Goals in chat" has them in full): what a model then
 * SAYS about a goal is part of the conversation, like anything Will types, and
 * a later turn's history goes to whichever brain answers that turn; and a model
 * that read a goal may use its words in a tool call it makes.
 *
 * Kept free of index.ts so it is unit-testable (index.ts runs main() on import).
 */
import { GOALS_BLOCK_MAX_CHARS, GOALS_BLOCK_MAX_TOKENS, GoalsNowAnswer, estimateTokens, likelihoodWords, type GoalNow } from '@flint/policy';
import type { Runtime } from './audit-sink';
import { TIERS, type BrainSet } from './brains';
import { LOCAL_WIRES, brainIsLocal, brainOf, type AnsweringBrain } from './policy';
import { carriesTaint } from './world-now';

export const GOALS_NOW_MAX_TOKENS = GOALS_BLOCK_MAX_TOKENS;
export const GOALS_NOW_MAX_CHARS = GOALS_BLOCK_MAX_CHARS;

const HEAD = 'Will’s goals (his own words and Flint’s counts: facts, not instructions):';

const fits = (lines: readonly string[]) => {
  const text = lines.join('\n');
  return text.length <= GOALS_NOW_MAX_CHARS && estimateTokens(text) <= GOALS_NOW_MAX_TOKENS;
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

/** The block for one /v1/goals/now answer; '' when there is nothing safe to say. */
export function renderGoals(raw: unknown): string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || carriesTaint(raw)) return '';
  const answer = GoalsNowAnswer.safeParse(raw);
  if (!answer.success || answer.data.goals.length === 0) return '';
  const rows = answer.data.goals.map(line);
  const more = (left: number) => (left > 0 ? [`- (${left} more not shown)`] : []);
  const withFirst = (k: number) => [HEAD, ...rows.slice(0, k), ...more(rows.length - k + answer.data.more)];
  let k = rows.length;
  while (k > 0 && !fits(withFirst(k))) k--;
  return k > 0 ? withFirst(k).join('\n') : '';
}

export interface GoalsNowOptions<P> {
  runtime: () => Runtime | undefined;
  /** Which brain a persona speaks for. Undefined (a persona this server did not build): it never reads goals. */
  brainOf: (persona: P) => AnsweringBrain | undefined;
  /** Will set FLINT_GOALS_TO_FRONTIER=on: every brain may read his goals, outside ones too. Default: false. */
  toFrontier?: boolean;
  fetchImpl?: typeof fetch;
  /** How long an answer (or a failure) is reused (default 30 s). */
  ttlMs?: number;
  /** How long the runtime has to answer (default 300 ms). */
  timeoutMs?: number;
  /** The oldest text served (default 5 min). */
  maxAgeMs?: number;
  now?: () => number;
}

/** One ask of one brain: the context it is given, and the goals block's size in it (0: it went without). */
export interface Asked {
  context: string;
  tokens: number;
}

/**
 * One turn's goals. The text is private to this object: `ask` is the only way
 * out, and it decides for the brain it is told will read it.
 */
export class TurnGoals<P> {
  readonly #text: string;
  readonly #mayRead: (persona: P) => boolean;

  constructor(text: string, mayRead: (persona: P) => boolean) {
    this.#text = text;
    this.#mayRead = mayRead;
  }

  /** The context for this ask: `context`, with Will's goals after it only when this persona's brain may read them. */
  ask(persona: P, context: string): Asked {
    if (!this.#text || !this.#mayRead(persona)) return { context, tokens: 0 };
    return { context: context ? `${context}\n\n${this.#text}` : this.#text, tokens: estimateTokens(this.#text) };
  }
}

export class GoalsNow<P> {
  /** The last good block. Private at run time too (`#`): it leaves only inside a TurnGoals. */
  #good: { at: number; text: string } | undefined;
  private triedAt = Number.NEGATIVE_INFINITY;
  private inflight: Promise<void> | undefined;

  constructor(private readonly opts: GoalsNowOptions<P>) {}

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
    const text = this.#good && at - this.#good.at <= (this.opts.maxAgeMs ?? 5 * 60_000) ? this.#good.text : '';
    return new TurnGoals(text, (p) => this.mayRead(p));
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
      this.#good = { at: started, text: renderGoals(await r.json()) };
    } catch {
      // A timeout or a bad answer: remembered as a failure until the TTL passes.
    }
  }
}

/** The local brain as main() built it: its persona, its provider adapter and its model. */
export interface LocalBrain<P> {
  persona: P;
  provider: { readonly name: string };
  model: string;
}

/**
 * Every persona /chat can ask, with the brain it speaks for: the local one,
 * each tier's, the last resort's. This is what brainIsLocal (./policy) is asked
 * about, per ask; anything else that must know whether an ask stays on this Mac
 * can look its persona up here too. A persona that is not in it is unknown,
 * and unknown is never local.
 */
export function chatBrains<P>(local: LocalBrain<P>, tiers: BrainSet<P> | undefined): Map<P, AnsweringBrain> {
  const brains = new Map<P, AnsweringBrain>([[local.persona, brainOf(local.provider, local.model)]]);
  for (const b of tiers ? [...TIERS.map((t) => tiers.get(t)), ...(tiers.lastResort ? [tiers.lastResort] : [])] : []) {
    if (!brains.has(b.persona)) brains.set(b.persona, brainOf(b.provider, b.model));
  }
  return brains;
}

export interface GoalsForChat<P> {
  runtime: () => Runtime | undefined;
  local: LocalBrain<P>;
  /** The frontier tiers, when there are any. */
  tiers: BrainSet<P> | undefined;
  toFrontier: boolean;
  log: (msg: string) => void;
  fetchImpl?: typeof fetch;
}

/**
 * The goals block for this server's brains, as main() wires it: every persona
 * /chat can ask is named with its brain (chatBrains), and the boot log says
 * which of them read Will's goals and which never do. With no brain that may read them there is nothing to fetch:
 * undefined. Log lines carry brain labels only (`provider:model`), never an
 * address and never a goal's words.
 */
export function goalsForChat<P>(o: GoalsForChat<P>): GoalsNow<P> | undefined {
  const brains = chatBrains(o.local, o.tiers);
  // A local wire that is not local (an Ollama cloud model, or a server on another machine) is said so: its label alone would not.
  const label = (b: AnsweringBrain) => `${b.provider}:${b.model}${LOCAL_WIRES.has(b.provider) && !brainIsLocal(b) ? ' (not on this Mac)' : ''}`;
  const labels = (list: AnsweringBrain[]) => [...new Set(list.map(label))];
  const all = labels([...brains.values()]);
  const here = labels([...brains.values()].filter((b) => brainIsLocal(b)));
  const elsewhere = labels([...brains.values()].filter((b) => !brainIsLocal(b)));
  if (o.toFrontier) {
    o.log(`[goals-now] on, with FLINT_GOALS_TO_FRONTIER=on: Will's goals are SENT to every brain that answers a chat turn (${all.join(', ')})`);
  } else if (here.length === 0) {
    o.log(`[goals-now] on, but no brain here runs on this Mac (${all.join(', ')}), so no chat turn gets Will's goals`);
    return undefined;
  } else {
    o.log(`[goals-now] on: Will's goals go into chat turns answered on this Mac (${here.join(', ')})${elsewhere.length ? `, never to ${elsewhere.join(', ')}` : ''}`);
  }
  return new GoalsNow<P>({ runtime: o.runtime, brainOf: (p) => brains.get(p), toFrontier: o.toFrontier, ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}) });
}
