/**
 * The turns Will kept on this Mac: the mark they carry.
 *
 * A turn Will kept on this Mac (Local Only, the words "keep this private", or
 * any turn while Flint was in Local mode) was answered here. But the NEXT turn
 * in that conversation could go to a cloud model, and a cloud model is sent the
 * conversation so far: the private question and its answer went out one turn
 * late, as history. The routing review reproduced it in hybrid and across a
 * switch from Local to Cloud.
 *
 * So such a turn is MARKED where it is stored: `{ private: true }` in the
 * turn's call context, which the conversation store keeps with the turn from
 * the moment it begins, so there is never a stored private turn with no mark.
 *
 * What the mark then does is not decided here. It is one of the marks that
 * keep a stored turn on this Mac (./goals-now STAY_MARKS, beside the mark of a
 * turn answered with Will's goals), and everything that follows from such a
 * mark is the one mechanism in ./goals-now and ./goals-chat:
 *  - no brain off this Mac is handed the turn back as history;
 *  - a brain on this Mac that reads it has its own turn marked too;
 *  - what Flint learns from it for long-term memory is marked (./knowledge
 *    `fromPrivate`) and is recalled only for a brain on this Mac;
 *  - the memory extractor reads it only on a brain on this Mac;
 *  - its reply is never sent out to be spoken.
 *
 * One thing is this mark's own: FLINT_GOALS_TO_FRONTIER=on, which sends Will's
 * goals and the turns answered with them to any brain, lifts nothing here. He
 * chose that for his goals, not for what he asked to keep private.
 *
 * Kept free of index.ts so it is unit-testable (index.ts runs main() on import).
 */

/** What a turn carries, in its call context, when Will kept it on this Mac. */
export const PRIVATE_TURN: Readonly<{ private: true }> = Object.freeze({ private: true });

/** Was this stored turn one Will kept on this Mac? */
export function wasPrivate(turn: { context?: unknown }): boolean {
  const c = turn.context;
  return !!c && typeof c === 'object' && (c as { private?: unknown }).private === true;
}

/**
 * What a turn of Local mode carries when Will did not himself ask for it to
 * stay private: the same mark, and a note that it is the MODE that keeps it
 * here. Everything the mark does, it does for this turn too. The note is read
 * for one thing: such a turn may be asked for the goals he set in it
 * (./memory-extract, FLINT_EXTRACT_CANDIDATES), and a turn he asked to keep
 * private is not.
 */
export const LOCAL_MODE_TURN: Readonly<{ private: true; byMode: true }> = Object.freeze({ private: true, byMode: true });

/**
 * Is this stored turn kept here by Will's own word for it (the Local Only
 * switch, or a message that asked to stay private), and not only because
 * Flint was in Local mode? The narrower of the two notions, as stored.
 *
 * A private mark with no note is read as his own word: that is every turn
 * marked before the note existed, a turn outside Local mode that was marked
 * because its model was handed one (a private turn in its history, or a fact
 * from one), and a turn OF Local mode whose conversation still carried a turn
 * he asked to keep private when it was answered (./goals-chat ChatTurn.ask:
 * its model read that turn, and may have said it back). Only the note makes a
 * turn the mode's.
 */
export function privateByRequest(turn: { context?: unknown }): boolean {
  return wasPrivate(turn) && (turn.context as { byMode?: unknown }).byMode !== true;
}

/** What a route says about keeping a turn here: Will's own word for this turn, and the mode. */
export interface StayRoute {
  private: boolean;
  mode: 'local' | 'cloud' | 'hybrid';
}

/**
 * Does this turn STAY HERE, for the stored mark? Will kept it private (Local
 * Only, or the words: `route.private`), or Flint was in Local mode, where he
 * chose that for every turn. What follows from the mark: no brain off this Mac
 * reads the turn as history, what is learned from it stays here, and its reply
 * is not sent out to be spoken.
 *
 * This is the wider of two notions. The narrower one is `route.private` alone
 * ("explicitly private"): on such a turn nothing at all leaves this Mac, so it
 * is offered only the tools that run here (./outside-ai). An ordinary turn in
 * Local mode stays here in the sense above and may still search the web.
 */
export function turnStaysHere(route: StayRoute): boolean {
  return route.private || route.mode === 'local';
}

/**
 * Does this turn stay here by the MODE alone, as far as its route says: Flint
 * is in Local mode, and Will did not ask for this turn to be private? Its
 * stored mark then carries the note (LOCAL_MODE_TURN), unless the conversation
 * it is answered in still carries a turn he asked to keep private
 * (./goals-chat ChatTurn.ask).
 */
export function keptByModeAlone(route: StayRoute): boolean {
  return !route.private && route.mode === 'local';
}

/**
 * The same, for the training corpus's entry (./training `staysHere`): local
 * training uses the example, and no set that leaves this Mac takes it.
 */
export function corpusMark(route: StayRoute): { staysHere?: true } {
  return turnStaysHere(route) ? { staysHere: true } : {};
}
