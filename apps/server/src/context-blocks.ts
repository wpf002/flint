/**
 * Which blocks the server may add to a chat turn's context, from the
 * environment (read once, in main()). Each block costs tokens on every turn
 * that carries it, so each is off until Will turns it on:
 *
 *   FLINT_WORLD_NOW=1           "World now" (./world-now), on frontier turns.
 *   FLINT_GOALS_NOW=1           Will's goals (./goals-now), on turns a model on
 *                               this Mac answers, and on no other turn.
 *   FLINT_GOALS_TO_FRONTIER=on  Will's goals go to outside models too. This
 *                               SENDS his goal text to whichever provider
 *                               answers the turn (Anthropic, OpenAI, ...). Only
 *                               `on` turns it on, and only with FLINT_GOALS_NOW=1.
 *   FLINT_CONTEXT_BLOCKS=off    The kill switch: no block at all, whatever the
 *                               settings above say. Unset, blank or `on`: each
 *                               block follows its own setting.
 *
 * A value that is set but not understood never turns anything on: it is
 * reported by name (never by value) and read as off. For the kill switch that
 * means the blocks are off: a mistyped `off` must not leave them running.
 *
 * Kept free of index.ts so it is unit-testable (index.ts runs main() on import).
 */
type Env = Record<string, string | undefined>;

export interface ContextBlocks {
  world: boolean;
  goals: boolean;
  /** Will's goals may be sent to an outside model. False unless he set FLINT_GOALS_TO_FRONTIER=on. */
  goalsToFrontier: boolean;
}

export function readContextBlocks(env: Env, warn: (msg: string) => void = () => {}): ContextBlocks {
  const kill = env.FLINT_CONTEXT_BLOCKS?.trim().toLowerCase();
  if (kill && kill !== 'off' && kill !== 'on') warn('[context] FLINT_CONTEXT_BLOCKS is not "off" or "on"; reading it as off (no context blocks)');
  if (kill && kill !== 'on') return { world: false, goals: false, goalsToFrontier: false };
  const goals = env.FLINT_GOALS_NOW?.trim() === '1';
  const toFrontier = env.FLINT_GOALS_TO_FRONTIER?.trim().toLowerCase();
  if (toFrontier && toFrontier !== 'on' && toFrontier !== 'off') warn('[context] FLINT_GOALS_TO_FRONTIER is not "on" or "off"; reading it as off (goals stay with the local model)');
  if (toFrontier === 'on' && !goals) warn('[context] FLINT_GOALS_TO_FRONTIER=on does nothing without FLINT_GOALS_NOW=1 (the goals block is off)');
  return { world: env.FLINT_WORLD_NOW?.trim() === '1', goals, goalsToFrontier: goals && toFrontier === 'on' };
}
