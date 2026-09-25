/**
 * A frontier reply that isn't an answer: the model refused, or it said nothing
 * and did nothing. Parity run 20260924-tiered lost 11 of 300 prompts this way —
 * Anthropic's refusal stop was reported as a normal completion, so the empty
 * reply went straight to the user and no fallback fired.
 *
 * Here such a reply counts as a FAILED attempt: the tier chain (./brains) moves
 * on to the next brain, and when the last one fails the same way the user gets
 * a short, honest message instead of an empty bubble. Nothing here touches the
 * local brain's replies.
 *
 * Kept out of index.ts so it is unit-testable (index.ts runs main() on import).
 */
import type { StreamEvent } from '@flint/core';
import { runWithFallback, type BrainTier } from './brains';

export type Unanswered = 'refusal' | 'empty';

/** The parts of a collected reply (GenerateOutcome) this module reads. */
export interface ReplyLike {
  text: string;
  reason: string;
  /** Every message the turn produced; a `tool` message means the model called a tool. */
  messages: ReadonlyArray<{ role: string }>;
}

/**
 * Why a finished reply is not an answer, or undefined when it is one.
 *  - `refusal`: the provider stopped on a policy decision, whatever text it had
 *    streamed before (a refused answer is cut off, not finished).
 *  - `empty`: no text AND no tool call. A turn that called tools and then said
 *    nothing still did something (e.g. proposed an action for approval), so it
 *    is left alone, as before.
 */
export function unanswered(reply: { text: string; reason: string; usedTools: boolean }): Unanswered | undefined {
  if (reply.reason === 'refusal') return 'refusal';
  if (reply.text.trim().length === 0 && !reply.usedTools) return 'empty';
  return undefined;
}

/** Thrown from a tier attempt whose reply wasn't an answer, so the chain moves on. */
export class NoAnswer extends Error {
  constructor(
    readonly why: Unanswered,
    /** What answerWithFallback needs back if this was the last attempt. */
    readonly carried?: unknown,
  ) {
    // Reads well in logFallback: "<label> failed (declined to answer: refusal)".
    super(why === 'refusal' ? 'declined to answer: refusal' : 'empty answer: no text and no tool call');
    this.name = 'NoAnswer';
  }
}

/**
 * The first sentences of the honest messages. Stable on purpose: the training
 * logger recognises them (isUnansweredMessage) so a canned fallback never
 * becomes a "teacher" answer in the distillation corpus.
 */
const REFUSAL_LEAD = "I can't get you an answer on that one:";
const EMPTY_LEAD = 'I came back empty on that one:';

/** What the user reads when no brain in the chain produced an answer. */
export function unansweredMessage(why: Unanswered, tried: number): string {
  const who = tried > 1 ? `all ${tried} models I tried` : 'the model I asked';
  return why === 'refusal'
    ? `${REFUSAL_LEAD} ${who} declined it. If it's a legitimate ask, rephrase it or add why you need it.`
    : `${EMPTY_LEAD} ${who} returned nothing. Ask again, or rephrase it.`;
}

/** Whether `text` is one of the honest fallback messages above. */
export function isUnansweredMessage(text: string): boolean {
  const t = text.trim();
  return t.startsWith(REFUSAL_LEAD) || t.startsWith(EMPTY_LEAD);
}

/**
 * /generate's frontier call: runWithFallback, where a refused or empty reply is
 * a failed attempt like a thrown error. When the LAST attempt fails that way the
 * result is that reply with its text replaced by the honest message (and
 * `unanswered` set) rather than an error, so the caller does not hand a refusal
 * to the local brain — local fallback stays what it was, the answer to an outage.
 * Any other failure is thrown exactly as runWithFallback throws it.
 */
export async function answerWithFallback<P, T extends ReplyLike>(
  chain: readonly BrainTier<P>[],
  ask: (brain: BrainTier<P>) => Promise<T>,
  opts: { signal?: AbortSignal; onFallback?: (from: BrainTier<P>, to: BrainTier<P>, err: unknown) => void } = {},
): Promise<{ result: T; brain: BrainTier<P>; unanswered?: Unanswered }> {
  let tried = 0;
  try {
    return await runWithFallback(
      chain,
      async (brain) => {
        tried++;
        const reply = await ask(brain);
        const why = unanswered({ text: reply.text, reason: reply.reason, usedTools: reply.messages.some((m) => m.role === 'tool') });
        if (why) throw new NoAnswer(why, { reply, brain });
        return reply;
      },
      opts,
    );
  } catch (err) {
    if (!(err instanceof NoAnswer) || err.carried === undefined) throw err;
    const { reply, brain } = err.carried as { reply: T; brain: BrainTier<P> };
    return { result: { ...reply, text: unansweredMessage(err.why, tried) }, brain, unanswered: err.why };
  }
}

/**
 * /chat's frontier stream for one tier, passed through event by event, except
 * that a refused or empty reply is caught at its `done` before anything was
 * shown: on a `recoverable` tier (one with another tier after it) it throws
 * NoAnswer instead of forwarding the `done`, so the chain tries the next brain;
 * on the last tier it adds the honest message as text ahead of the `done`.
 *
 * A reply that already streamed text is always passed through as it is: the
 * user has seen it, so it can be neither retried nor replaced.
 *
 * Stopping at the `done` also keeps a retried turn out of memory: the chat turn
 * commits only after its `done` is consumed, so leaving there fails the turn.
 */
export async function* guardAnswer(
  events: AsyncIterable<StreamEvent>,
  opts: { recoverable: boolean; tried: number },
): AsyncGenerator<StreamEvent, void, void> {
  let text = '';
  let usedTools = false;
  for await (const ev of events) {
    if (ev.type === 'text') text += ev.delta;
    if (ev.type === 'tool_call') usedTools = true;
    if (ev.type === 'done') {
      const why = unanswered({ text, reason: ev.reason, usedTools });
      if (why && text.trim().length === 0) {
        // Retry only when not even whitespace went out: the caller refuses to
        // fall back once its streamed answer is non-empty.
        if (opts.recoverable && text.length === 0) throw new NoAnswer(why);
        yield { type: 'text', delta: unansweredMessage(why, opts.tried) };
      }
    }
    yield ev;
  }
}
