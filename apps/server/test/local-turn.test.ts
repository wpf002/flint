/**
 * A turn the local model is answering keeps its question on this machine.
 *
 * deep_research's planner was sent the question (its prompt IS the question) on
 * the frontier's routine tier whatever the turn: Local-only, a question Will
 * asked to keep private, a fallback. asLocalTurn marks the local model's turn,
 * through any scope opened inside it, and the planner's `never` check
 * (./spend pausable) refuses there, so deep_research plans by its heuristic.
 * The same check holds for an eval replay, which is exempt from budgets only.
 */
import { describe, it, expect } from 'vitest';
import { GoalsChat } from '../src/goals-chat';
import { asLocalTurn, isLocalTurn, withTurnTaint } from '../src/turn-taint';
import { TurnSpend, pausable } from '../src/spend';
import { planQueries, DEFAULT_LIMITS } from '../src/deep-research';
import { FrontierBreaker } from '../src/frontier-breaker';
import { makeAiError } from '@flint/core';

const NOW = new Date('2026-10-12T15:00:00Z');
const QUESTION = 'what did my doctor say about the scan';
const PLANNED = '["doctor scan results explained", "what a radiology report means", "follow-up after an abnormal scan"]';

/** What main() asks about the local turn (../src/goals-chat plannerHeld). Nothing else of it is used here. */
const goalsChat = new GoalsChat({ memory: undefined as never, blocks: { goals: false, goalsToFrontier: false }, runtime: () => undefined, log: () => {} });

/** The planner as main() wires it: budgets in `paused`, the local turn and the breaker in `never`. */
function planner(opts: { budget?: string; breaker?: FrontierBreaker } = {}) {
  const sent: string[] = [];
  const complete = pausable(
    async (prompt) => {
      sent.push(prompt); // this is the question leaving for the frontier
      return PLANNED;
    },
    () => opts.budget,
    () => {
      const held = goalsChat.plannerHeld(true); // the planner is a frontier model
      if (held) return held;
      const paused = opts.breaker?.paused('anthropic');
      return paused ? `the frontier is paused (${paused})` : undefined;
    },
  );
  return { complete, sent };
}

describe('asLocalTurn / isLocalTurn', () => {
  it('marks what runs inside it, across awaits, and nothing outside', async () => {
    expect(isLocalTurn()).toBe(false);
    await asLocalTurn(async () => {
      expect(isLocalTurn()).toBe(true);
      await new Promise((r) => setTimeout(r, 1));
      expect(isLocalTurn()).toBe(true);
    });
    expect(isLocalTurn()).toBe(false);
  });

  // deep_research runs in a scope of its own, opened by the tier gate inside the turn.
  it('reaches a turn scope opened inside it', async () => {
    const seen = await asLocalTurn(() => withTurnTaint(async () => isLocalTurn(), { eval: false }));
    expect(seen).toBe(true);
    expect(await withTurnTaint(async () => isLocalTurn())).toBe(false);
  });

  it('two turns at once do not see each other\'s', async () => {
    const seen: boolean[] = [];
    await Promise.all([
      asLocalTurn(async () => {
        await new Promise((r) => setTimeout(r, 5));
        seen.push(isLocalTurn());
      }),
      (async () => {
        await new Promise((r) => setTimeout(r, 2));
        seen.push(isLocalTurn());
      })(),
    ]);
    expect(seen).toEqual([false, true]);
  });
});

describe('the research planner on a turn the local model is answering', () => {
  it('is not asked: the question does not go to the frontier, and the heuristic plans', async () => {
    const p = planner();
    const logs: string[] = [];
    const plan = await asLocalTurn(() => withTurnTaint(() => planQueries(QUESTION, { complete: p.complete, log: (m) => logs.push(m) }, NOW, DEFAULT_LIMITS)));
    expect(p.sent).toEqual([]);
    expect(plan.planner).toBe('heuristic');
    expect(plan.queries.length).toBeGreaterThan(0);
    expect(logs).toEqual(['[research] planner failed (the local model is answering this turn, so its question stays here); using heuristics']);
  });

  it('a frontier turn still plans with the brain', async () => {
    const p = planner();
    const plan = await withTurnTaint(() => planQueries(QUESTION, { complete: p.complete, log: () => {} }, NOW, DEFAULT_LIMITS));
    expect(p.sent).toHaveLength(1);
    expect(p.sent[0]).toContain(QUESTION);
    expect(plan.planner).toBe('brain');
  });
});

// An eval replay is exempt from Flint's budgets (the harness has its own). It is not exempt from these.
describe('an eval replay and the planner', () => {
  const inEval = <T>(fn: () => Promise<T>) => new TurnSpend('eval').run(fn);

  it('is not paused by a budget, as before', async () => {
    const p = planner({ budget: 'Claude (Anthropic) at 85% of today\'s $10.00 cap; background work waits' });
    expect(await inEval(() => p.complete('q'))).toBe(PLANNED);
    await expect(p.complete('q')).rejects.toThrow(/background work waits/); // a turn of Will's is
  });

  it('respects the breaker: a paused provider is not asked by a replay either', async () => {
    const breaker = new FrontierBreaker({ probe: async () => {}, now: () => 0 });
    breaker.failed('anthropic', makeAiError('validation', '400 Your credit balance is too low', { providerCode: '400', retryable: false }));
    const p = planner({ breaker });
    await expect(inEval(() => p.complete('q'))).rejects.toThrow('the frontier is paused (credit)');
    expect(p.sent).toEqual([]);
  });

  it('respects a local turn: an eval asked of the local brain keeps its question here too', async () => {
    const p = planner();
    await expect(inEval(() => asLocalTurn(() => p.complete('q')))).rejects.toThrow(/stays here/);
    expect(p.sent).toEqual([]);
  });
});
