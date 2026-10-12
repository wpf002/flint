/**
 * "A model on this Mac is answering": one notion, asked in one place (P3 part
 * 4, with #62's local-turn mark).
 *
 *  - ./policy brainIsLocal is the fact: this brain runs on this Mac.
 *  - ./turn-taint asLocalTurn is the mark on an ask: this is a local model's
 *    turn, and nothing it sets off sends the question to an outside AI. /chat
 *    enters it for the local persona (as #62 did) and, now, for a tier whose
 *    brain is on this Mac.
 *  - What stays on this Mac (Will's goals, the facts learned from goals turns)
 *    goes to an ask only when both hold: the gate asks the mark as well as the
 *    fact. So an ask can carry them only where #62's protections are on.
 *
 * Also here: the gate is named again when the local brain is swapped (main()'s
 * adoptLocal), so the brain that reads Will's goals is the one that answers.
 * The server in miniature (./goals-mini). No network. Synthetic text only.
 */
import { afterEach, describe, it, expect } from 'vitest';
import { Flint } from '@flint/core';
import { Persona } from '@flint/persona';
import { GoalsNow, chatBrain, goalsForChat } from '../src/goals-now';
import { asLocalTurn, isLocalTurn } from '../src/turn-taint';
import { CANARY, HERE, RT, answer, cleanup, goal, miniServer as server, recording } from './goals-mini';

afterEach(cleanup);

const claude = { name: 'anthropic', model: 'claude-opus-5-5' };
const AWAY = 'http://10.0.0.7:11434';

describe('the mark: which asks are a local model’s turn', () => {
  it('the local persona’s ask is one, first choice or fallback; an outside tier’s is not', async () => {
    const s = server({ frontier: [{ ...claude, script: ['fail', 'answer'] }] });
    await s.chat('local');
    expect(s.local.localTurns).toEqual([true]);
    expect((await s.chat('frontier')).answeredBy).toBe('local');
    expect(s.tiers[0]!.localTurns).toEqual([false]);
    expect(s.local.localTurns).toEqual([true, true]);
    await s.chat('frontier');
    expect(s.tiers[0]!.localTurns).toEqual([false, false]);
  });

  it('a tier whose brain is on this Mac answers as a local model: its ask is a local turn, and it is given the goals', async () => {
    const s = server({ frontier: [{ name: 'ollama', model: 'qwen2.5:72b', baseURL: HERE }] });
    const out = await s.chat('frontier');
    expect(s.tiers[0]!.localTurns).toEqual([true]);
    expect(out.goalsTokens).toBeGreaterThan(0);
    expect(s.tiers[0]!.seen()).toContain(CANARY);
  });

  it('an Ollama tier on another machine, or an Ollama cloud model, is not: no local turn, no goals', async () => {
    for (const tier of [{ name: 'ollama', model: 'qwen2.5:72b', baseURL: AWAY }, { name: 'ollama', model: 'gpt-oss:120b-cloud', baseURL: HERE }]) {
      const s = server({ frontier: [tier] });
      expect((await s.chat('frontier')).goalsTokens, tier.model).toBe(0);
      expect(s.tiers[0]!.localTurns, tier.model).toEqual([false]);
      expect(s.tiers[0]!.seen(), tier.model).not.toContain(CANARY);
    }
  });

  it('the local persona on another machine keeps #62’s mark (its question still stays from the planner) and is still given no goals: both must hold', async () => {
    const s = server({ frontier: [claude], local: { name: 'ollama', model: 'qwen2.5:14b', baseURL: AWAY } });
    expect((await s.chat('local')).goalsTokens).toBe(0);
    expect(s.local.localTurns).toEqual([true]);
    expect(s.local.seen()).not.toContain(CANARY);
  });

  it('a tier that fails on this Mac and an outside tier that answers: the first was a local turn with the goals, the second neither', async () => {
    const s = server({ frontier: [{ name: 'ollama', model: 'qwen2.5:72b', baseURL: HERE, script: ['fail'] }, claude] });
    const out = await s.chat('frontier');
    expect(out.answeredBy).toBe('frontier');
    expect(s.tiers[0]!.localTurns).toEqual([true]);
    expect(s.tiers[0]!.seen()).toContain(CANARY);
    expect(s.tiers[1]!.localTurns).toEqual([false]);
    expect(s.tiers[1]!.seen()).not.toContain(CANARY);
    expect(out.goalsTokens).toBe(0); // the brain asked last went without
    // The mark does not outlive the ask it was entered for.
    expect(isLocalTurn()).toBe(false);
  });
});

describe('the gate asks the mark as well as the fact', () => {
  const local = recording('ollama', ['answer'], { baseURL: HERE });
  const persona = new Persona(new Flint({ provider: local.provider, defaultModel: 'qwen2.5:14b' }), { name: 'Flint', styleGuide: 'Be brief.' });
  const fetchImpl = (async () => new Response(JSON.stringify(answer([goal(1)])))) as unknown as typeof fetch;
  const gate = (o: { toFrontier?: boolean; localTurn?: () => boolean }) =>
    new GoalsNow<Persona>({ runtime: () => RT, brainOf: (p) => (p === persona ? chatBrain(local.provider, 'qwen2.5:14b') : undefined), fetchImpl, ...o });

  it('a brain on this Mac, asked outside a local model’s turn, goes without; asked inside one, it is given the goals', async () => {
    const turn = await gate({ localTurn: isLocalTurn }).forTurn();
    expect(turn.ask(persona, { context: 'ctx' })).toEqual({ context: 'ctx', tools: [], tokens: 0, mark: {} });
    const inside = asLocalTurn(() => turn.ask(persona, { context: 'ctx' }));
    expect(inside.context).toContain(CANARY);
    expect(inside.mark).toEqual({ context: { goals: true } });
    // The mark is read when the ask is made, not when the turn's goals were fetched.
    expect(turn.ask(persona, { context: 'ctx' }).tokens).toBe(0);
  });

  it('FLINT_GOALS_TO_FRONTIER=on lifts the mark’s rule with the rest: Will chose to send goal text out', async () => {
    const turn = await gate({ toFrontier: true, localTurn: () => false }).forTurn();
    expect(turn.ask(persona, { context: 'ctx' }).context).toContain(CANARY);
  });

  it('onThisMac is brainIsLocal for a persona’s brain; a persona nobody named is not on this Mac', async () => {
    const turn = await gate({}).forTurn();
    expect(turn.onThisMac(persona)).toBe(true);
    expect(turn.onThisMac(new Persona(new Flint({ provider: local.provider, defaultModel: 'x' }), { name: 'Flint', styleGuide: '' }))).toBe(false);
  });
});

describe('when the local brain is swapped (Ollama answered late): the gate is named again', () => {
  it('the stand-in persona no longer reads the goals; the adopted one does, at its own context size, and the boot line says so again', async () => {
    const mk = (model: string, numCtx: number) => {
      const r = recording('ollama', ['answer'], { baseURL: HERE, numCtx });
      return { ...r, model, persona: new Persona(new Flint({ provider: r.provider, defaultModel: model }), { name: 'Flint', styleGuide: 'Be brief.' }) };
    };
    const standIn = mk('qwen2.5:7b', 4096);
    const adopted = mk('qwen2.5:14b', 16384);
    const logs: string[] = [];
    const fetchImpl = (async () => new Response(JSON.stringify(answer([goal(1)])))) as unknown as typeof fetch;
    // As main(): makeGoals reads the local brain as it is NOW.
    let now = standIn;
    const makeGoals = () => goalsForChat<Persona>({ on: true, runtime: () => RT, local: { persona: now.persona, provider: now.provider, model: now.model }, tiers: undefined, toFrontier: false, localTurn: isLocalTurn, log: (m) => logs.push(m), fetchImpl });
    let GOALS = makeGoals();
    const given = async (p: Persona) => asLocalTurn(async () => (await GOALS.forTurn()).ask(p, { context: '' }).tokens > 0);
    expect(await given(standIn.persona)).toBe(true);
    // adoptLocal: the local brain is another one, and the gate is made again.
    now = adopted;
    GOALS = makeGoals();
    expect(await given(adopted.persona)).toBe(true);
    expect(await given(standIn.persona)).toBe(false);
    expect(logs).toEqual([
      "[goals-now] on: Will's goals go into chat turns answered on this Mac (ollama:qwen2.5:7b, 4096-token context)",
      "[goals-now] on: Will's goals go into chat turns answered on this Mac (ollama:qwen2.5:14b, 16384-token context)",
    ]);
  });

  it('with the goals block off it is silent, asks the runtime for nothing, and still names who may read what stays here', async () => {
    const s = server({ frontier: [claude], goalsOn: false });
    expect((await s.chat('local')).goalsTokens).toBe(0);
    expect(s.logs).toEqual([]);
    expect(s.fetched()).toBe(0);
    expect(s.local.seen()).not.toContain(CANARY);
    expect(s.GOALS.mayRead(s.localPersona)).toBe(true);
    expect(s.GOALS.mayRead(s.chain[0]!.persona)).toBe(false);
  });
});
