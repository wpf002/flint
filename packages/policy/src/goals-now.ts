/**
 * Will's goals for chat (Machine plan P3 part 4): what the runtime's GET
 * /v1/goals/now answers, and the server checks before a word of it reaches a
 * prompt. Active goals only, each as one row of closed values: a ref, counts,
 * local days, and its open onTrack forecast as an enum and a whole number.
 *
 * The one free text is `title`: Will's own words, sent only for a goal he
 * signed that carries no outside text. Any other goal is named by its ref
 * alone (`goal#ab12cd`). There is no description, no check's text, no step's
 * title and no taint mark: a row has no room for them.
 *
 * Goal text is PERSONAL. The route needs the runtime's `proposals` scope, which
 * the runtime connector's token never holds, and the server adds the block only
 * to a prompt read by a model on this Mac (apps/server/src/goals-now.ts).
 */
import { z } from 'zod';
import { GoalTitle, LIKELIHOODS, type Likelihood } from './goals.js';

/** At most this many goals are listed; the rest are counted (`more`). */
export const GOALS_NOW_ROWS = 20;
/**
 * The goals block's size in a prompt (exit criterion 8): what the server holds it
 * to, by estimateTokens, and what the runtime's P3 report checks the measured
 * sizes against.
 */
export const GOALS_BLOCK_MAX_TOKENS = 300;
export const GOALS_BLOCK_MAX_CHARS = 1200;

const Count = z.number().int().min(0).max(10_000);
/** A calendar day in Will's time zone, as the runtime counts days. */
const LocalDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** A goal named without its words: `goal#` and the last 6 characters of its id (entityRef). */
export const GoalRef = z.string().regex(/^goal#[A-Za-z0-9]{1,12}$/);

export const GoalNow = z
  .object({
    ref: GoalRef,
    /** Will's own title, or null for a goal that is named by its ref only. */
    title: GoalTitle.nullable(),
    checks: z.object({ met: Count, total: Count, unknown: Count }).strict(),
    /** Its open forecast, from the ledger's row: how likely it is to be done by `by`. Never a model's words. */
    onTrack: z.object({ likelihood: z.enum(LIKELIHOODS), percent: z.number().int().min(0).max(100), by: LocalDay }).strict().nullable(),
    /** The day it is to be finished by, or null. */
    finishBy: LocalDay.nullable(),
    /** Its plan's steps still to do, and how many of those are past their date. */
    steps: z.object({ open: Count, overdue: Count }).strict(),
  })
  .strict();
export type GoalNow = z.infer<typeof GoalNow>;

export const GoalsNowAnswer = z.object({ goals: z.array(GoalNow).max(GOALS_NOW_ROWS), more: Count }).strict();
export type GoalsNowAnswer = z.infer<typeof GoalsNowAnswer>;

/** A forecast in the ledger's words: "likely (~70%)". The same words the Goals panel and the digest use. */
export function likelihoodWords(likelihood: Likelihood, percent: number): string {
  return `${likelihood.replace(/_/g, ' ')} (~${percent}%)`;
}
