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
  // A block is turned on by `1` and nothing else; `0`, blank or unset is off, and says nothing.
  const one = (name: 'FLINT_WORLD_NOW' | 'FLINT_GOALS_NOW', what: string): boolean => {
    const v = env[name]?.trim();
    if (v && v !== '1' && v !== '0') warn(`[context] ${name} is not "1" or "0"; reading it as off (${what})`);
    return v === '1';
  };
  const world = one('FLINT_WORLD_NOW', 'no World now block');
  const goals = one('FLINT_GOALS_NOW', 'no goals in chat');
  const toFrontier = env.FLINT_GOALS_TO_FRONTIER?.trim().toLowerCase();
  if (toFrontier && toFrontier !== 'on' && toFrontier !== 'off') warn('[context] FLINT_GOALS_TO_FRONTIER is not "on" or "off"; reading it as off (goals stay with the local model)');
  if (toFrontier === 'on' && !goals) warn('[context] FLINT_GOALS_TO_FRONTIER=on does nothing without FLINT_GOALS_NOW=1 (the goals block is off)');
  return { world, goals, goalsToFrontier: goals && toFrontier === 'on' };
}
