/**
 * The module index.ts hands every goals decision to (../src/goals-chat), piece
 * by piece (P3 part 4). The canary tests in the goals-*.test.ts files drive
 * the same module through a whole chat turn; here each call is asked on its
 * own: the reply's `meta` event and what `/speak` does with it, the size of
 * the goals block as it was really sent, recall for a one-shot answer, the
 * research planner, and the history each Flint client is built on.
 * No network. Synthetic text only.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { Flint } from '@flint/core';
import { Persona } from '@flint/persona';
import { ChatTurn, GoalsChat, SPEECH_STAYS_HERE, recallForAnyBrain, speechStaysHere } from '../src/goals-chat';
import { GOALS_TURN, GoalsNow, HISTORY_GAP, STAY_MARKS, renderGoals, type TurnGoals } from '../src/goals-now';
import { recallContext } from '../src/grounding';
import { KnowledgeStore } from '../src/knowledge';
import { asLocalTurn, turnCarriesKept } from '../src/turn-taint';
import { estimateTokens } from '../src/world-now';
import { CANARY, HERE, RT, answer, cleanup, goal, listed, miniServer as server, recording, storedTurn, tmpDir, tmpStore, type Step } from './goals-mini';
import { join } from 'node:path';

beforeEach(() => listed(HERE, ['qwen2.5:14b', 'qwen2.5:72b']));
afterEach(cleanup);

const claude = [{ name: 'anthropic', model: 'claude-opus-5-5', script: ['answer'] as Step[] }];
const T1 = `Your goal is ${CANARY} goal 1, likely.`;

// ---------------------------------------------------------------------------
describe('the `meta` event: the client is told whether the reply stays here, and which stored turn it is', () => {
  it('a turn answered with the goals says so before its first text, and names the turn the store holds', async () => {
    const s = server({ frontier: claude });
    const out = await s.chat('local');
    const [only] = await s.store.getTurns('c1');
    expect(out.metas).toEqual([{ type: 'meta', staysHere: true, turn: only!.id }]);
  });

  it('an ordinary reply says it does not, and names its turn too', async () => {
    const s = server({ frontier: claude });
    const out = await s.chat('frontier');
    expect(out.metas).toEqual([{ type: 'meta', staysHere: false, turn: s.store.turnIds('c1')[0] }]);
  });

  it('each ask of a turn says it for itself: a tier that failed, then the local model with the goals', async () => {
    const s = server({ frontier: [{ ...claude[0]!, script: ['fail'] as Step[] }] });
    const out = await s.chat('frontier');
    expect(out.answeredBy).toBe('local');
    const ids = s.store.turnIds('c1');
    expect(out.metas).toEqual([{ type: 'meta', staysHere: false, turn: ids[0] }, { type: 'meta', staysHere: true, turn: ids[1] }]);
  });

  it('a turn that only read a marked turn as history says it stays here as well', async () => {
    const s = server({ frontier: claude, goalsOn: false });
    await storedTurn(s.store, { id: 'first', context: GOALS_TURN, user: 'how are my goals going?', assistant: T1 });
    expect((await s.chat('local', 'which goal?')).metas.map((m) => m.staysHere)).toEqual([true]);
  });

  it('it is given once, and not before the turn is stored', async () => {
    const s = server({ frontier: claude, goalsOn: false });
    const { store } = s;
    const turn = await s.goalsChat.forTurn('c1', 'hi');
    const none = { styleGuide: '' } as never;
    const asked = turn.ask(none, { context: 'ctx', whole: 'ctx', outside: 'ctx', tools: [] });
    expect(asked.meta()).toBeUndefined();
    await store.beginTurn({ conversationId: 'c1', turnId: 't1', createdAt: 1, userMessage: { id: 'u', role: 'user', content: 'hi', timestamp: 1 } });
    expect(asked.meta()).toEqual({ type: 'meta', staysHere: false, turn: 't1' });
    expect(asked.meta()).toBeUndefined();
    // Two turns begun at once in one conversation cannot be told apart: the event then names none.
    const both = turn.ask(none, { context: 'ctx', whole: 'ctx', outside: 'ctx', tools: [] });
    for (const id of ['t2', 't3']) await store.beginTurn({ conversationId: 'c1', turnId: id, createdAt: 2, userMessage: { id: `u${id}`, role: 'user', content: 'hi', timestamp: 2 } });
    expect(both.meta()).toEqual({ type: 'meta', staysHere: false });
  });
});

// ---------------------------------------------------------------------------
// A turn is marked by the gate, and the gate is there only once the brains are named. index.ts names them before the
// server listens (test/index-wiring.test.ts pins the order), so a turn with no gate cannot happen there. There used
// to be a second, simpler rule for that case; it could not be reached and was not tested, and it is gone.
describe('a turn has no rule to be marked by until the brains are named', () => {
  it('forTurn before name() is an error, not a turn with a rule of its own', async () => {
    const unnamed = new GoalsChat<Persona>({ memory: tmpStore(), blocks: { goals: false, goalsToFrontier: false }, runtime: () => RT, log: () => {}, locality: { watch: () => Promise.resolve() } });
    await expect(unnamed.forTurn('c1', 'hi', { private: true, mode: 'cloud' })).rejects.toThrow('GoalsChat.forTurn was called before the brains were named (GoalsChat.name)');
    await expect(unnamed.forTurn('c1', 'hi')).rejects.toThrow(/before the brains were named/);
  });
});

describe('speechStaysHere: a reply that stays on this Mac is never sent to an outside speech service', () => {
  /** /speak as index.ts answers it: the refusal the client falls back on, or the outside call. */
  async function speak(s: { goalsChat: GoalsChat<Persona> }, body: { text: string; conversationId?: unknown; turnId?: unknown }, synth: (text: string) => Promise<string>) {
    if (s.goalsChat.speechStaysHere({ conversationId: body.conversationId, turnId: body.turnId, text: body.text })) return { status: 409, body: { error: SPEECH_STAYS_HERE, fallback: 'browser' } };
    return { status: 200, audio: await synth(body.text) };
  }

  it('the reply to a goals turn: the outside service is not called, and the answer tells the client to use its own voice', async () => {
    const s = server({ frontier: claude, local: { name: 'ollama', model: 'qwen2.5:14b', baseURL: HERE, script: [{ say: T1 }] } });
    const out = await s.chat('local');
    const synth = vi.fn(async (text: string) => `mp3:${text}`);
    const said = await speak(s, { text: out.answer, conversationId: 'c1', turnId: out.metas[0]!.turn }, synth);
    expect(said).toEqual({ status: 409, body: { error: SPEECH_STAYS_HERE, fallback: 'browser' } });
    expect(synth).not.toHaveBeenCalled();
    expect(SPEECH_STAYS_HERE).not.toMatch(/goal/i);
  });

  it('an ordinary reply is spoken as before', async () => {
    const s = server({ frontier: claude });
    const out = await s.chat('frontier', 'what is the weather?');
    const synth = vi.fn(async (text: string) => `mp3:${text}`);
    expect(await speak(s, { text: out.answer, conversationId: 'c1', turnId: out.metas[0]!.turn }, synth)).toEqual({ status: 200, audio: 'mp3:answer from anthropic' });
    expect(synth).toHaveBeenCalledTimes(1);
  });

  it('it is the named turn that decides: an ordinary reply after a goals turn is spoken, and the goals turn’s is not, whichever is newest', async () => {
    const s = server({ frontier: claude });
    const first = await s.chat('local');
    const second = await s.chat('frontier', 'what is the weather?');
    const about = (turnId: unknown) => s.goalsChat.speechStaysHere({ conversationId: 'c1', turnId });
    expect(about(first.metas[0]!.turn)).toBe(true);
    expect(about(second.metas[0]!.turn)).toBe(false);
  });

  it('a request that names the conversation and no turn could be about any reply in it: it stays here while any turn the conversation still carries does, pending ones included', async () => {
    const s = server({ frontier: claude });
    await s.chat('frontier', 'what is the weather?');
    expect(s.goalsChat.speechStaysHere({ conversationId: 'c1' })).toBe(false);
    // A reply being streamed: its turn is pending, and marked from the moment it began.
    await s.store.beginTurn({ conversationId: 'c1', turnId: 'streaming', createdAt: Date.now(), context: GOALS_TURN, userMessage: { id: 'u', role: 'user', content: 'goals?', timestamp: Date.now() } });
    expect(s.goalsChat.speechStaysHere({ conversationId: 'c1' })).toBe(true);
    expect(s.goalsChat.speechStaysHere({ conversationId: 'c1', turnId: '' })).toBe(true);
    expect(s.goalsChat.speechStaysHere({ conversationId: 'c1', turnId: null })).toBe(true);
  });

  // The privacy review's N3. The conversation alone named the NEWEST turn, so a kept reply's words sent after a newer
  // ordinary turn went out. It names no reply at all, so every reply the conversation still carries answers for it.
  it('a newer ordinary turn does not free a kept reply: the conversation alone is refused while the kept turn is in its window, and spoken again once it has left', async () => {
    const store = tmpStore({ history: { maxTurns: 2, maxAgeMs: Number.POSITIVE_INFINITY } });
    await storedTurn(store, { id: 'kept', context: GOALS_TURN, user: 'goals?', assistant: T1 });
    await storedTurn(store, { id: 'after', user: 'thanks', assistant: 'ok' });
    expect(speechStaysHere(store, { conversationId: 'c1', text: T1 })).toBe(true);
    expect(speechStaysHere(store, { conversationId: 'c1', text: 'ok' })).toBe(true);
    // Named by its turn, the ordinary reply is still spoken.
    expect(speechStaysHere(store, { conversationId: 'c1', turnId: 'after', text: 'ok' })).toBe(false);
    // Two ordinary turns later the kept one is no longer carried by the conversation's next message.
    await storedTurn(store, { id: 'later', user: 'and the weather?', assistant: 'sunny' });
    expect(speechStaysHere(store, { conversationId: 'c1', text: 'sunny' })).toBe(false);
    expect(speechStaysHere(store, { conversationId: 'c1', turnId: 'kept', text: T1 })).toBe(true); // its own name still holds
  });

  it('a wrong name is not a weaker claim than no name: an unknown conversation, or a turn that is not the named conversation’s, is treated as naming nothing', async () => {
    const store = tmpStore();
    const ask = (said: Record<string, unknown>) => speechStaysHere(store, said);
    await storedTurn(store, { conversationId: 'c2', id: 'plain', user: 'weather?', assistant: 'sunny' });
    // Nothing anywhere is marked: every shape may go out.
    for (const said of [{}, { conversationId: 'never-seen' }, { conversationId: 'c2', turnId: 'nope' }, { conversationId: 'c2' }]) expect(ask(said), JSON.stringify(said)).toBe(false);
    await storedTurn(store, { conversationId: 'c1', id: 'old', user: 'hi', assistant: 'hello' });
    await storedTurn(store, { conversationId: 'c1', id: 'marked', context: GOALS_TURN, user: 'goals?', assistant: T1 });
    const answers = (cases: Array<[Record<string, unknown>, boolean]>) => {
      for (const [said, stays] of cases) expect(ask(said), JSON.stringify(said)).toBe(stays);
    };
    answers([
      // Named rightly: the turn decides, and the conversation's newest when no turn is named.
      [{ conversationId: 'c1', turnId: 'marked' }, true], [{ conversationId: 'c1', turnId: 'old' }, false], [{ conversationId: 'c1' }, true], [{ conversationId: 'c2' }, false], [{ conversationId: 'c2', turnId: 'plain' }, false],
      // Named wrongly, or not at all: held to the strictest answer, since somewhere a marked turn is newest.
      [{}, true], [{ conversationId: 'never-seen' }, true], [{ conversationId: 'never-seen', turnId: 'marked' }, true], [{ conversationId: 'c2', turnId: 'marked' }, true],
      [{ conversationId: 'c1', turnId: 'nope' }, true], [{ conversationId: 'c2', turnId: 'nope' }, true], [{ conversationId: 'c2', turnId: 42 }, true], [{ conversationId: 'c2', turnId: ['plain'] }, true],
      [{ conversationId: 5 }, true], [{ conversationId: '' }, true], [{ conversationId: ['c1'] }, true], [{ turnId: 'marked' }, true],
    ]);
    // A newer ordinary turn after the marked one: the conversation alone still carries the marked turn (this store keeps
    // every turn in its window), the newer turn may be named, and the marked turn's own name still holds.
    await storedTurn(store, { conversationId: 'c1', id: 'after', user: 'thanks', assistant: 'ok' });
    answers([[{ conversationId: 'c1' }, true], [{ conversationId: 'c1', turnId: 'after' }, false], [{ conversationId: 'c1', turnId: 'marked' }, true], [{}, true], [{ conversationId: 'never-seen' }, true]]);
  });

  it('the rule for a request that cannot be placed is not bounded by time: a conversation that ends on a marked turn holds it for good', async () => {
    const later = tmpStore({ history: { maxTurns: 12, maxAgeMs: 48 * 3600_000 }, now: () => Date.now() + 400 * 86_400_000 });
    await storedTurn(later, { id: 'marked', context: GOALS_TURN, user: 'goals?', assistant: T1 });
    expect(speechStaysHere(later, {})).toBe(true);
    // Once a newer ordinary turn follows it, and it has left the history window, nothing unplaced is held any more.
    const aged = tmpStore({ history: { maxTurns: 1, maxAgeMs: Number.POSITIVE_INFINITY } });
    await storedTurn(aged, { id: 'marked', context: GOALS_TURN, user: 'goals?', assistant: T1 });
    await storedTurn(aged, { id: 'after', user: 'thanks', assistant: 'ok' });
    expect(speechStaysHere(aged, {})).toBe(false);
    expect(speechStaysHere(aged, { conversationId: 'c1', turnId: 'marked' })).toBe(true);
  });

  // The other half of N3: a turn that may be spoken vouches for its own words and no others.
  it('a named turn speaks for its own reply only: another reply’s words under an ordinary turn’s name are refused', async () => {
    const store = tmpStore();
    const PRIVATE_REPLY = 'The synthetic appointment is at the JUNIPER clinic on Tuesday.';
    await storedTurn(store, { id: 'kept', context: GOALS_TURN, user: 'a private thing', assistant: PRIVATE_REPLY });
    await storedTurn(store, { id: 'plain', user: 'weather?', assistant: 'It is **97°F** and sunny in Austin. Winds are 5 mph from the south.' });
    const about = (text: unknown, turnId = 'plain') => speechStaysHere(store, { conversationId: 'c1', turnId, text });
    // Its own reply: whole, a sentence at a time, and made sayable as the console does before it asks.
    expect(about('It is **97°F** and sunny in Austin. Winds are 5 mph from the south.')).toBe(false);
    expect(about('Winds are 5 mph from the south.')).toBe(false);
    expect(about('It is 97 degrees Fahrenheit and sunny in Austin.')).toBe(false);
    expect(about('Winds are 5 miles per hour from the south.')).toBe(false);
    // Another reply's words, however they are dressed: refused.
    expect(about(PRIVATE_REPLY)).toBe(true);
    expect(about('at the JUNIPER clinic')).toBe(true);
    expect(about(`It is sunny. ${PRIVATE_REPLY}`)).toBe(true);
    expect(about('sunny It is')).toBe(true); // its words, but not as it said them
    // Text that is no words, or no text at all, is no part of any reply.
    for (const text of ['', '   ', '...', 42, null, ['sunny'], { text: 'sunny' }]) expect(about(text), JSON.stringify(text)).toBe(true);
    // A caller that asks about the turn alone (no text given) is answered about the turn.
    expect(speechStaysHere(store, { conversationId: 'c1', turnId: 'plain' })).toBe(false);
    // The kept turn's own words under its own name stay here, as ever.
    expect(about(PRIVATE_REPLY, 'kept')).toBe(true);
  });

  it('while a reply is being streamed its turn holds no reply yet: the words the server sent for that turn are what it may speak', async () => {
    const s = server({ frontier: claude });
    const turn = await s.goalsChat.forTurn('c1', 'what is the weather?');
    const asked = turn.ask({ styleGuide: '' } as never, { context: 'ctx', whole: 'ctx', outside: 'ctx', tools: [] });
    await s.store.beginTurn({ conversationId: 'c1', turnId: 'live', createdAt: Date.now(), userMessage: { id: 'u', role: 'user', content: 'what is the weather?', timestamp: Date.now() } });
    const about = (text: string, turnId = 'live') => s.goalsChat.speechStaysHere({ conversationId: 'c1', turnId, text });
    // Before the server has said which turn the reply is, nothing was sent under its name.
    asked.said('Too early. ');
    expect(about('Too early.')).toBe(true);
    expect(asked.meta()).toEqual({ type: 'meta', staysHere: false, turn: 'live' });
    asked.said('It is sunny in ');
    asked.said('Austin. Winds are light.');
    expect(about('It is sunny in Austin.')).toBe(false);
    expect(about('Winds are light.')).toBe(false);
    expect(about('The synthetic appointment is on Tuesday.')).toBe(true);
    // Another turn's live words are not this turn's.
    await storedTurn(s.store, { id: 'other', user: 'hi', assistant: 'hello there' });
    expect(about('It is sunny in Austin.', 'other')).toBe(true);
    expect(about('hello there', 'other')).toBe(false);
  });

  it('a whole turn through the server: the reply it streamed is spoken under its turn, and no other text is', async () => {
    const s = server({ frontier: claude });
    const out = await s.chat('frontier', 'what is the weather?');
    const turnId = out.metas[0]!.turn;
    expect(s.goalsChat.speechStaysHere({ conversationId: 'c1', turnId, text: out.answer })).toBe(false);
    expect(s.goalsChat.speechStaysHere({ conversationId: 'c1', turnId, text: 'Some other reply entirely.' })).toBe(true);
  });

  it('a request that names nothing cannot be placed (an older client): it stays here while any conversation’s newest turn or recent history is marked', async () => {
    const s = server({ frontier: claude });
    await s.chat('frontier', 'what is the weather?', 'plain');
    for (const said of [{}, { conversationId: '' }, { conversationId: 7 }, { turnId: 'x' }]) expect(s.goalsChat.speechStaysHere(said), JSON.stringify(said)).toBe(false);
    await s.chat('local', 'how are my goals going?', 'goals');
    await s.chat('frontier', 'thanks', 'goals');
    for (const said of [{}, { conversationId: '' }, { conversationId: 7 }, { turnId: 'x' }]) expect(s.goalsChat.speechStaysHere(said), JSON.stringify(said)).toBe(true);
    // The conversation that has nothing marked is still spoken when it is named.
    expect(s.goalsChat.speechStaysHere({ conversationId: 'plain' })).toBe(false);
  });

  it('it asks "marked to stay here, by any mark", not the goals mark alone', async () => {
    const other = (t: { context?: unknown }) => (t.context as { other?: boolean } | undefined)?.other === true;
    const list = STAY_MARKS as Array<typeof other>;
    list.push(other);
    try {
      const store = tmpStore();
      await storedTurn(store, { id: 't1', context: { other: true }, user: 'a private thing', assistant: 'noted' });
      expect(speechStaysHere(store, { conversationId: 'c1', turnId: 't1' })).toBe(true);
      expect(speechStaysHere(store, {})).toBe(true);
    } finally {
      list.pop();
    }
  });
});

// ---------------------------------------------------------------------------
describe('the goals block’s size, for the [route] line and the chat.turn event', () => {
  const local = { styleGuide: 'Be brief.' };

  it('is measured on the context as it was sent: exactly the block that was added to it', async () => {
    const s = server({ frontier: claude, goals: answer([goal(1), goal(2), goal(3)]) });
    const turn = await s.goalsChat.forTurn('c1', 'hello');
    let carried = false;
    const asked = asLocalTurn(() => {
      const a = turn.ask(s.localPersona, { context: '[ctx]', whole: '[ctx]', outside: '[ctx]', tools: [] });
      carried = turnCarriesKept();
      return a;
    });
    // Handed what stays here (the goals), the local model's turn is marked so: a long wait for a read before it is
    // sent then asks again that the model runs here (./inference lookAgain).
    expect(carried).toBe(true);
    const block = renderGoals(answer([goal(1), goal(2), goal(3)]));
    expect(asked.context).toBe(`[ctx]\n\n${block}`);
    expect(asked.tokens).toBe(estimateTokens(block));
    // With no context before it, the block is the whole of it.
    expect(asLocalTurn(() => turn.ask(s.localPersona, { context: '', whole: '', outside: '', tools: [] })).tokens).toBe(estimateTokens(block));
    // An ask that went without reports nothing.
    expect(turn.ask(s.chain[0]!.persona, { context: '[ctx]', whole: '[ctx]', outside: '[ctx]', tools: [] }).tokens).toBe(0);
  });

  it('it is not the gate’s own figure: a block that came out over its limit shows in the number', () => {
    const huge = Array.from({ length: 200 }, (_, i) => `- “goal ${i}”: 1 of 2 checks met`).join('\n');
    // A gate that says it added 12 tokens, and added far more.
    const lying = { ask: (_p: unknown, a: { here?: string; context: string; tools?: readonly unknown[] }) => ({ context: `${a.here}\n\n${huge}`, tools: a.tools ?? [], tokens: 12, mark: { context: GOALS_TURN } }) } as unknown as TurnGoals<typeof local>;
    const asked = new ChatTurn(tmpStore(), lying, 'c1', 0).ask(local, { context: '[ctx]', whole: '[ctx]', outside: '[ctx]', tools: [] });
    expect(asked.tokens).toBe(estimateTokens(huge));
    expect(asked.tokens).toBeGreaterThan(300);
  });

  it('a turn that stays here for another reason, with no block in it, reports no block', async () => {
    const s = server({ frontier: claude, goalsOn: false });
    await storedTurn(s.store, { id: 'first', context: GOALS_TURN, user: 'how are my goals going?', assistant: T1 });
    const out = await s.chat('local', 'which goal?');
    expect(out.goalsTokens).toBe(0);
    expect(out.metas[0]!.staysHere).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('recallForAnyBrain: /generate has no per-ask gate, so it is given the facts any brain may have', () => {
  it('the recalled block and facts without the ones that stay here, and the recall’s mode', async () => {
    const k = new KnowledgeStore(join(tmpDir(), 'k.json'), { embed: async () => Promise.reject(new Error('down')) });
    await k.add(`Will's cabin trip codename is Bluebird ${CANARY}.`, 'history', { fromGoals: true });
    await k.add('Will’s cabin trip is in the spring.', 'history');
    const recall = await recallContext('[Context]', 'what is my cabin trip codename?', k);
    expect(recall.block).toContain(CANARY);
    const any = recallForAnyBrain(recall);
    expect(any).toEqual({ block: recall.outside.block, facts: ['Will’s cabin trip is in the spring.'], mode: 'lexical' });
    expect(JSON.stringify(any)).not.toContain(CANARY);
  });
});

// ---------------------------------------------------------------------------
describe('plannerHeld: deep_research’s planner is an outside model, and a local model’s turn does not ask it', () => {
  const chat = () => new GoalsChat<Persona>({ memory: tmpStore(), blocks: { goals: false, goalsToFrontier: false }, runtime: () => RT, log: () => {}, locality: { watch: () => Promise.resolve() } });

  it('held on a local model’s turn, with a sentence that says why; not held on any other', async () => {
    const c = chat();
    expect(c.plannerHeld(true)).toBeUndefined();
    expect(asLocalTurn(() => c.plannerHeld(true))).toBe('the local model is answering this turn, so its question stays here');
    // A tier on this Mac answers as a local model's turn, so its research plans by rule too.
    expect(await c.run({ provider: recording('ollama', ['answer'], { baseURL: HERE }).provider, model: 'qwen2.5:72b' }, () => c.plannerHeld(true))).toMatch(/stays here/);
    expect(await c.run({ provider: recording('anthropic', ['answer']).provider, model: 'claude-opus-5-5' }, () => c.plannerHeld(true))).toBeUndefined();
  });

  it('with no outside planner there is nothing to hold', () => {
    expect(asLocalTurn(() => chat().plannerHeld(false))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
describe('history: every Flint client reads the conversation through it', () => {
  it('a client built on it for an outside brain never sends a marked turn; one for a brain on this Mac sends all of it', async () => {
    const store = tmpStore();
    const chat = new GoalsChat<Persona>({ memory: store, blocks: { goals: true, goalsToFrontier: false }, runtime: () => RT, log: () => {}, locality: { watch: () => Promise.resolve() } });
    await storedTurn(store, { id: 'first', context: GOALS_TURN, user: 'how are my goals going?', assistant: T1 });
    // Each asks as a turn that stays here (the mark in the call's options), which is the most any of them could be given.
    const ask = async (name: string, model: string, baseURL?: string, marked = true) => {
      const r = recording(name, ['fail'], baseURL ? { baseURL } : {});
      const flint = new Flint({ provider: r.provider, defaultModel: model, memory: chat.history(r.provider, model), retryPolicy: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 } });
      for await (const _ev of flint.chat({ conversationId: 'c1', message: `and then? (${name}:${model})` }, marked ? { context: GOALS_TURN } : {})) void _ev;
      return r.seen();
    };
    // The frontier's client, an eval candidate that is a cloud model under a plain name, the adopted local brain.
    expect(await ask('anthropic', 'claude-opus-5-5')).not.toContain(CANARY);
    listed(HERE, ['qwen2.5:14b', { name: 'candidate', remote_host: 'https://ollama.com' }]);
    const candidate = await ask('ollama', 'candidate', HERE);
    expect(candidate).not.toContain(CANARY);
    expect(candidate).toContain(HISTORY_GAP);
    expect(await ask('ollama', 'qwen2.5:14b', HERE)).toContain(CANARY);
    // ...and the brain on this Mac reads it only for a turn that is itself stored with the mark.
    const unmarked = await ask('ollama', 'qwen2.5:14b', HERE, false);
    expect(unmarked).not.toContain(CANARY);
    expect(unmarked).toContain(HISTORY_GAP);
  });

  it('naming a brain has its Ollama asked what runs on it: this Mac’s address, and no other', () => {
    const watched: string[] = [];
    const chat = new GoalsChat<Persona>({ memory: tmpStore(), blocks: { goals: true, goalsToFrontier: false }, runtime: () => RT, log: () => {}, locality: { watch: async (url) => void watched.push(url) } });
    chat.history(recording('ollama', ['answer'], { baseURL: HERE }).provider, 'qwen2.5:14b');
    chat.history(recording('ollama', ['answer'], { baseURL: 'http://10.0.0.7:11434' }).provider, 'qwen2.5:14b');
    chat.history(recording('anthropic', ['answer']).provider, 'claude-opus-5-5');
    chat.extractor({ brain: { provider: 'ollama', model: 'qwen2.5:7b', baseURL: 'http://localhost:11434' }, tainted: () => false });
    expect(watched).toEqual([HERE, 'http://localhost:11434']);
  });
});

// ---------------------------------------------------------------------------
describe('the runtime is given 300 ms for the goals, and no more', () => {
  it('a runtime that accepts the request and never answers costs a turn about 300 ms, once', async () => {
    const deadline = vi.spyOn(AbortSignal, 'timeout');
    let calls = 0;
    const hang = ((_url: string, init: RequestInit) => {
      calls++;
      return new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason)));
    }) as unknown as typeof fetch;
    const g = new GoalsNow<string>({ runtime: () => RT, brainOf: () => ({ provider: 'ollama', model: 'qwen2.5:14b', baseURL: HERE }), fetchImpl: hang });
    const started = Date.now();
    const turn = await g.forTurn();
    const took = Date.now() - started;
    expect(deadline).toHaveBeenCalledWith(300);
    expect(took).toBeGreaterThanOrEqual(280);
    expect(took).toBeLessThan(900);
    expect(turn.ask('local', { context: 'ctx' })).toEqual({ context: 'ctx', tools: [], tokens: 0, mark: {} });
    // The failure is remembered: the next turn does not wait again.
    const again = Date.now();
    await g.forTurn();
    expect(Date.now() - again).toBeLessThan(100);
    expect(calls).toBe(1);
    deadline.mockRestore();
  });
});
