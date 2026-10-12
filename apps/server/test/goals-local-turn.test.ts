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
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { Flint } from '@flint/core';
import { Persona } from '@flint/persona';
import { GoalsChat } from '../src/goals-chat';
import { GOALS_TURN, GoalsNow, chatBrain } from '../src/goals-now';
import { LOCALITY } from '../src/ollama-locality';
import { asLocalTurn, isLocalTurn } from '../src/turn-taint';
import { CANARY, HERE, RT, answer, cleanup, goal, listed, miniServer as server, recording, storedTurn, tmpStore } from './goals-mini';

// What this Mac's Ollama lists as running on it (../src/ollama-locality): the gate takes its word, not a name's.
beforeEach(() => listed(HERE, ['qwen2.5:14b', 'qwen2.5:72b', 'm', 'x']));
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

});

describe('GoalsChat.run: an ask runs as a local model’s turn when its brain is on this Mac, on /chat and on /generate', () => {
  const chat = () => new GoalsChat<Persona>({ memory: undefined as never, blocks: { goals: true, goalsToFrontier: false }, runtime: () => RT, log: () => {}, locality: { watch: () => Promise.resolve() } });
  const ollama = (baseURL: string) => recording('ollama', ['answer'], { baseURL }).provider;

  it('a brain on this Mac: the ask is made inside the mark, and its result is handed back', async () => {
    const inside = chat().run({ provider: ollama(HERE), model: 'qwen2.5:72b' }, () => isLocalTurn());
    expect(inside).toBe(true);
    // An async ask keeps the mark across its awaits, and it does not outlive the ask.
    const later = await chat().run({ provider: ollama(HERE), model: 'qwen2.5:72b' }, async () => {
      await Promise.resolve();
      return isLocalTurn();
    });
    expect(later).toBe(true);
    expect(isLocalTurn()).toBe(false);
  });

  it('any other brain: the ask runs as it is, with no mark', () => {
    listed(HERE, ['qwen2.5:72b', { name: 'mine', remote_host: 'https://ollama.com' }]);
    for (const brain of [
      { provider: recording('anthropic', ['answer']).provider, model: 'claude-opus-5-5' },
      { provider: ollama(AWAY), model: 'qwen2.5:72b' },
      { provider: ollama(HERE), model: 'gpt-oss:120b-cloud' },
      // A cloud model under a plain name, and one this Mac's Ollama does not list.
      { provider: ollama(HERE), model: 'mine' },
      { provider: ollama(HERE), model: 'never-pulled:7b' },
    ]) {
      expect(chat().run(brain, () => isLocalTurn()), brain.model).toBe(false);
    }
    // FLINT_GOALS_TO_FRONTIER=on sends goals out; it does not make an outside brain a local one.
    const out = new GoalsChat<Persona>({ memory: undefined as never, blocks: { goals: true, goalsToFrontier: true }, runtime: () => RT, log: () => {}, locality: { watch: () => Promise.resolve() } });
    expect(out.run({ provider: recording('anthropic', ['answer']).provider, model: 'claude-opus-5-5' }, () => isLocalTurn())).toBe(false);
  });
});

describe('when the local brain is swapped (Ollama answered late): the gate is named again', () => {
  it('the stand-in persona no longer reads the goals; the adopted one does, at its own context size, and the boot line says so again', async () => {
    listed(HERE, ['qwen2.5:7b', 'qwen2.5:14b']);
    const s = server({ frontier: [], listings: { [HERE]: ['qwen2.5:7b', 'qwen2.5:14b'] }, local: { name: 'ollama', model: 'qwen2.5:7b', baseURL: HERE, numCtx: 4096 }, goals: answer([goal(1)]) });
    const standIn = s.localPersona;
    const given = async (p: Persona) => asLocalTurn(async () => (await s.goalsChat.forTurn('c1', 'hello')).ask(p, { context: '', whole: '', outside: '', tools: [] }).tokens > 0);
    expect(await given(standIn)).toBe(true);
    await s.goalsChat.settled;
    // adoptLocal: the local brain is another one, and main() names the brains again.
    const r = recording('ollama', ['answer'], { baseURL: HERE, numCtx: 16384 });
    const adopted = new Persona(new Flint({ provider: r.provider, defaultModel: 'qwen2.5:14b', memory: s.goalsChat.history(r.provider, 'qwen2.5:14b') }), { name: 'Flint', styleGuide: 'Be brief.' });
    s.goalsChat.name({ persona: adopted, provider: r.provider, model: 'qwen2.5:14b' }, undefined, (offered) => offered);
    expect(await given(adopted)).toBe(true);
    expect(await given(standIn)).toBe(false);
    await s.goalsChat.settled;
    expect(s.logs).toEqual([
      "[goals-now] on: Will's goals go into chat turns answered on this Mac (ollama:qwen2.5:7b, 4096-token context)",
      "[goals-now] on: Will's goals go into chat turns answered on this Mac (ollama:qwen2.5:14b, 16384-token context)",
    ]);
  });

  it('a naming that is replaced before its Ollama answered says nothing: only the brains named last are spoken of', async () => {
    let answerFirst: () => void = () => {};
    const logs: string[] = [];
    const slow = new GoalsChat<Persona>({
      memory: undefined as never, blocks: { goals: true, goalsToFrontier: false }, runtime: () => RT, log: (m) => logs.push(m),
      locality: { watch: () => new Promise<void>((resolve) => (answerFirst = resolve)) },
    });
    const mk = (model: string) => {
      const r = recording('ollama', ['answer'], { baseURL: HERE });
      return { persona: new Persona(new Flint({ provider: r.provider, defaultModel: model }), { name: 'Flint', styleGuide: '' }), provider: r.provider, model };
    };
    slow.name(mk('qwen2.5:7b'), undefined, (t) => t);
    const first = slow.settled;
    const release = answerFirst;
    slow.name(mk('qwen2.5:14b'), undefined, (t) => t);
    release();
    answerFirst();
    await Promise.all([first, slow.settled]);
    expect(logs).toEqual(["[goals-now] on: Will's goals go into chat turns answered on this Mac (ollama:qwen2.5:14b, 100000-token context)"]);
  });

  it('nothing waits for an Ollama to answer: the gate is there at once and hands out nothing, and the boot line follows the answer', async () => {
    LOCALITY.clear(); // boot: nothing has been heard from any Ollama
    const logs: string[] = [];
    let heard: () => void = () => {};
    let fetched = 0;
    const boot = new GoalsChat<Persona>({
      memory: tmpStore(), blocks: { goals: true, goalsToFrontier: false }, runtime: () => RT, log: (m) => logs.push(m),
      locality: { watch: () => new Promise<void>((resolve) => (heard = resolve)) },
      fetchImpl: (async () => (fetched++, new Response(JSON.stringify(answer([goal(1)]))))) as unknown as typeof fetch,
    });
    const r = recording('ollama', ['answer'], { baseURL: HERE });
    const persona = new Persona(new Flint({ provider: r.provider, defaultModel: 'qwen2.5:14b' }), { name: 'Flint', styleGuide: '' });
    boot.name({ persona, provider: r.provider, model: 'qwen2.5:14b' }, undefined, (t) => t);
    const given = () => asLocalTurn(async () => (await boot.forTurn('c1', 'hello')).ask(persona, { context: '', whole: '', outside: '', tools: [] }).tokens);
    expect(await given()).toBe(0);
    expect(fetched).toBe(0); // with no brain that may read them, the runtime is not asked for the goals
    expect(logs).toEqual([]);
    // Ollama answers, and lists the model as its own.
    listed(HERE, ['qwen2.5:14b']);
    heard();
    await boot.settled;
    expect(await given()).toBeGreaterThan(0);
    expect(fetched).toBe(1);
    expect(logs).toEqual(["[goals-now] on: Will's goals go into chat turns answered on this Mac (ollama:qwen2.5:14b, 100000-token context)"]);
  });

  it('with the goals block off it is silent, asks the runtime for nothing, and still names who may read what stays here', async () => {
    const s = server({ frontier: [claude], goalsOn: false });
    expect((await s.chat('local')).goalsTokens).toBe(0);
    expect(s.logs).toEqual([]);
    expect(s.fetched()).toBe(0);
    expect(s.local.seen()).not.toContain(CANARY);
    // It still decides who reads what stays here: a turn stored with the mark goes back to the local model
    // as history, and never to Claude.
    await storedTurn(s.store, { id: 'marked', context: GOALS_TURN, user: `about ${CANARY}`, assistant: `yes, ${CANARY}` });
    await s.chat('local', 'and then?');
    expect(s.local.seen()).toContain(CANARY);
    await s.chat('frontier', 'thanks');
    expect(s.tiers[0]!.seen()).not.toContain(CANARY);
    expect(s.fetched()).toBe(0);
  });
});
