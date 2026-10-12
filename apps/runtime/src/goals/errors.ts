/**
 * How a goal card's failure may be told (P3). A goal's words are personal and a
 * database error can carry them: a CHECK's refusal names the row it refused
 * ("Failing row contains (...)"), and a validation error the call's arguments.
 * So past an executor an error is its class and SQLSTATE only, in the log and
 * on the card alike, and what Will reads under a card is one of the fixed
 * sentences below. A proposal's error is kept for good, like its reason.
 */
import { GOAL_SAYS, GOAL_STATUS_SAYS, type GoalStatus } from '@flint/policy';
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

/** What Will reads under a goal card: sentences, never a goal's words, never a database's (@flint/policy's, so the server can pass them on by code). */
export const SAY = GOAL_SAYS;

/** Why a goal cannot take this step from where it stands, as a sentence. */
export function goalStatusWords(status: GoalStatus | string): string {
  return Object.prototype.hasOwnProperty.call(GOAL_STATUS_SAYS, status) ? GOAL_STATUS_SAYS[status as GoalStatus] : 'This goal can’t change now.';
}
