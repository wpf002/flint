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
  /** The brain that answered, `provider:model` for the frontier. */
  answeredBy: string;
  outcome: 'answered' | 'unanswered' | 'empty' | 'error';
  /** Tiers that refused or came back empty before the one that answered (/chat). */
  declined?: number;
  ms: number;
  eval?: boolean;
}

/**
 * Why context moved a message off the tier its words alone would get, or
 * undefined when it did not. Only the routine rule reads context: appended
 * tools (the question needs to DO things) or a deep thread send a routine
 * one-liner to standard.
 */
export function movedBy(
  message: string,
  tier: Tier,
  ctx: { appended: readonly unknown[]; turns?: number },
): string | undefined {
  if (classifyMessage(message) === tier) return undefined;
  const why: string[] = [];
  if (ctx.appended.length > 0) why.push('tools');
  if ((ctx.turns ?? 0) >= LONG_CONVERSATION) why.push('deep thread');
  return why.join('+') || undefined;
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
