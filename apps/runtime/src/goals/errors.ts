/**
 * How a goal card's failure may be told (P3). A goal's words are personal and a
 * database error can carry them: a CHECK's refusal names the row it refused
 * ("Failing row contains (...)"), and a validation error the call's arguments.
 * So past an executor an error is its class and SQLSTATE only, in the log and
 * on the card alike, and what Will reads under a card is one of the fixed
 * sentences below. A proposal's error is kept for good, like its reason.
 */
import type { GoalStatus } from '@flint/policy';
import { Refused } from '../governance/proposals.js';
import { failureOf, framesOf, sqlState } from '../dbcodes.js';

/**
 * An executor's failure with its words taken out: what failed, its SQLSTATE and
 * the constraint it names (`failure`; the SQLSTATE also as `code`, which
 * dbRefused reads), and where it failed (the original error's top frames).
 */
export class GoalFailure extends Error {
  readonly code: string | undefined;
  constructor(readonly failure: string, code?: string, readonly frames: readonly string[] = []) {
    super(failure);
    this.name = 'GoalFailure';
    this.code = code;
  }
}

/** A refusal stays as it is (its message is one of Flint's sentences); anything else becomes its class, SQLSTATE, constraint and frames. */
export function sanitize(err: unknown): Refused | GoalFailure {
  if (err instanceof Refused || err instanceof GoalFailure) return err;
  return new GoalFailure(failureOf(err), sqlState(err), framesOf(err));
}

/** What Will reads under a goal card: sentences, never a goal's words, never a database's. */
export const SAY = {
  invalid: 'This goal card isn’t valid.',
  kindGoal: 'A goal card is filed as kind goal.',
  kindPlan: 'A plan change is filed as kind plan.',
  fromConsole: 'Goals are changed from the console.',
  template: 'Flint files a plan change only from its review’s templates.',
  nothing: 'It changes nothing.',
  noGoal: 'This goal no longer exists.',
  looked: 'The goal changed since you looked. Reload it and try again.',
  planLooked: 'The plan changed since you looked. Reload it and try again.',
  goalChanged: 'The goal changed since this card was filed.',
  staleFlint: 'The plan changed since Flint suggested this.',
  staleWill: 'The plan changed since you asked for this.',
  resumePlan: 'Resuming a goal doesn’t change its plan.',
  itemGone: 'One of its items is no longer there.',
  person: 'A person can’t be linked to a goal.',
  checkItem: 'A check doesn’t fit its item.',
  checkStep: 'A check names a step the plan doesn’t have.',
  future: 'The finish date has to be in the future.',
  passed: 'The finish date is before the goal was added.',
  reshaped: 'Flint reads this card differently since you approved it. File it again.',
  provenance: 'A goal card names where its parts came from by id only.',
  stepDone: 'A done step stays done.',
  exists: 'It adds a step the plan already has.',
  missing: 'It changes a step the plan doesn’t have.',
  depends: 'A step depends on a step the plan doesn’t have.',
  circle: 'Its steps would depend on each other in a circle.',
} as const;

/** Why a goal cannot take this step from where it stands, as a sentence. */
export function goalStatusWords(status: GoalStatus | string): string {
  const words: Record<string, string> = {
    proposed: 'This goal hasn’t started yet.',
    active: 'This goal is already active.',
    paused: 'This goal is paused.',
    done: 'This goal is already done.',
    abandoned: 'This goal was abandoned.',
    rejected: 'This goal was dismissed.',
  };
  return words[status] ?? 'This goal can’t change now.';
}
