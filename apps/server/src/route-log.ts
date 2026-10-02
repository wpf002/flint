/**
 * One `[route]` line per answered message: the tier it was sorted into, what
 * moved it there, and which brain answered.
 *
 * Why: on 2026-09-30 three greetings sent to test the routine tier (then
 * claude-sonnet-5-5) were all answered by Opus 5.5, and the log could not say
 * why: nothing recorded a message's tier, the tools the router appended (any
 * append moves a routine one-liner to standard), or who answered. This line
 * records exactly that, as JSON so it can be counted. Never the message text,
 * the conversation, or anything the user wrote: tier, tool names and scores,
 * model labels, outcome, timing.
 */
import { classifyMessage, LONG_CONVERSATION, type Tier } from '@flint/core';

export type Outcome = 'answered' | 'unanswered' | 'empty' | 'error' | 'aborted';

export interface RouteRecord {
  /** Which endpoint answered: the app's /chat or the one-shot /generate. */
  path: 'chat' | 'generate';
  /** The tier classifyMessage chose. */
  tier: Tier;
  /** Set when context moved the message off the tier its words alone get (see movedBy). */
  movedBy?: string;
  /** Rest tools the router appended, with their similarity scores. */
  appended: ReadonlyArray<{ name: string; score: number }>;
  /** Complete turns of history sent (/chat only). */
  turns?: number;
  /** The tier the spend plan ran, when it is not `tier` (a budget step-down). */
  planTier?: string;
  /** Frontier or the local brain, after any fallback to local. */
  brain: string;
  /** The brain that answered (`provider:model` for the frontier). Only when the outcome is `answered`. */
  answeredBy?: string;
  /** The last brain tried, when none answered: an error, an empty reply, the honest message, a hang-up. */
  tried?: string;
  outcome: Outcome;
  /** Tiers that refused or came back empty before the one that answered (/chat). */
  declined?: number;
  ms: number;
  eval?: boolean;
  /** How memory recall ran: semantic, lexical (embedder failed), timeout, none, skipped or error. The pre-P2 baseline. */
  recall?: string;
  /** Estimated tokens each context block added to the frontier's prompt (plan 3.0.8: chat overhead is measured), e.g. {world: 120}. */
  ctxTokens?: Record<string, number>;
}

/**
 * Why context moved a message off the tier its words alone would get, or
 * undefined when it did not. Only the routine rule reads context: a confident
 * tool match (the router's toolsLikely: the question needs to DO things) or a
 * deep thread send a routine one-liner to standard. An append below the tier
 * score is offered but moves nothing, so it is not a reason.
 */
export function movedBy(message: string, tier: Tier, ctx: { toolsLikely: boolean; turns?: number }): string | undefined {
  if (classifyMessage(message) === tier) return undefined;
  const why: string[] = [];
  if (ctx.toolsLikely) why.push('tools');
  if ((ctx.turns ?? 0) >= LONG_CONVERSATION) why.push('deep thread');
  return why.join('+') || undefined;
}

/**
 * How a /chat turn ended. A provider failure reaches /chat as a streamed error
 * event, not a throw, so `streamErrored` counts as much as `failed`: without it,
 * Ollama being down or every tier failing was logged as `empty`.
 */
export function chatOutcome(t: {
  aborted: boolean;
  failed: boolean;
  streamErrored: boolean;
  gaveUp: boolean;
  answer: string;
}): Outcome {
  if (t.aborted) return 'aborted';
  if (t.failed || t.streamErrored) return 'error';
  if (t.gaveUp) return 'unanswered';
  return t.answer.trim() ? 'answered' : 'empty';
}

/**
 * Who to name. The last brain tried is the one that answered only when the
 * outcome is `answered`; otherwise it is only `tried`, so counting `answeredBy`
 * never credits a failure to a brain (or to the local model that never ran).
 */
export function attribution(outcome: Outcome, lastTried: string | undefined): { answeredBy?: string; tried?: string } {
  if (!lastTried) return {};
  return outcome === 'answered' ? { answeredBy: lastTried } : { tried: lastTried };
}

/** The log line, JSON after the tag. Scores are rounded; they are compared with a 0.55 floor. */
export function routeLine(r: RouteRecord, now: number = Date.now()): string {
  const rec = {
    ts: new Date(now).toISOString(),
    ...r,
    appended: r.appended.map((a) => ({ name: a.name, score: Math.round(a.score * 1000) / 1000 })),
  };
  return `[route] ${JSON.stringify(rec)}`;
}
