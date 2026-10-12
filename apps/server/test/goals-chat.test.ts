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
import { asLocalTurn } from '../src/turn-taint';
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
    const store = tmpStore();
    const turn = new ChatTurn<Persona>(store, undefined, 'c1', 0);
    const asked = turn.ask(undefined as never, { context: 'ctx', whole: 'ctx', outside: 'ctx', tools: [] });
    expect(asked.meta()).toBeUndefined();
    await store.beginTurn({ conversationId: 'c1', turnId: 't1', createdAt: 1, userMessage: { id: 'u', role: 'user', content: 'hi', timestamp: 1 } });
    expect(asked.meta()).toEqual({ type: 'meta', staysHere: false, turn: 't1' });
    expect(asked.meta()).toBeUndefined();
    // Two turns begun at once in one conversation cannot be told apart: the event then names none.
    const both = turn.ask(undefined as never, { context: 'ctx', whole: 'ctx', outside: 'ctx', tools: [] });
    for (const id of ['t2', 't3']) await store.beginTurn({ conversationId: 'c1', turnId: id, createdAt: 2, userMessage: { id: `u${id}`, role: 'user', content: 'hi', timestamp: 2 } });
    expect(both.meta()).toEqual({ type: 'meta', staysHere: false });
  });
});

// ---------------------------------------------------------------------------
describe('speechStaysHere: a reply that stays on this Mac is never sent to an outside speech service', () => {
  /** /speak as index.ts answers it: the refusal the client falls back on, or the outside call. */
  async function speak(s: { goalsChat: GoalsChat<Persona> }, body: { text: string; conversationId?: unknown; turnId?: unknown }, synth: (text: string) => Promise<string>) {
    if (s.goalsChat.speechStaysHere({ conversationId: body.conversationId, turnId: body.turnId })) return { status: 409, body: { error: SPEECH_STAYS_HERE, fallback: 'browser' } };
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

  it('a request that names the conversation and no turn the store holds is about its newest turn, pending ones included', async () => {
    const s = server({ frontier: claude });
    await s.chat('frontier', 'what is the weather?');
    expect(s.goalsChat.speechStaysHere({ conversationId: 'c1' })).toBe(false);
    // A reply being streamed: its turn is pending, and marked from the moment it began.
    await s.store.beginTurn({ conversationId: 'c1', turnId: 'streaming', createdAt: Date.now(), context: GOALS_TURN, userMessage: { id: 'u', role: 'user', content: 'goals?', timestamp: Date.now() } });
    expect(s.goalsChat.speechStaysHere({ conversationId: 'c1' })).toBe(true);
    expect(s.goalsChat.speechStaysHere({ conversationId: 'c1', turnId: 'no-such-turn' })).toBe(true);
    expect(s.goalsChat.speechStaysHere({ conversationId: 'c1', turnId: 42 })).toBe(true);
    // A conversation nobody has had holds nothing that stays here.
    expect(s.goalsChat.speechStaysHere({ conversationId: 'elsewhere' })).toBe(false);
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
    const asked = asLocalTurn(() => turn.ask(s.localPersona, { context: '[ctx]', whole: '[ctx]', outside: '[ctx]', tools: [] }));
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

  it('held on a local model’s turn, with a sentence that says why; not held on any other', () => {
    const c = chat();
    expect(c.plannerHeld(true)).toBeUndefined();
    expect(asLocalTurn(() => c.plannerHeld(true))).toBe('the local model is answering this turn, so its question stays here');
    // A tier on this Mac answers as a local model's turn, so its research plans by rule too.
    expect(c.run({ provider: recording('ollama', ['answer'], { baseURL: HERE }).provider, model: 'qwen2.5:72b' }, () => c.plannerHeld(true))).toMatch(/stays here/);
    expect(c.run({ provider: recording('anthropic', ['answer']).provider, model: 'claude-opus-5-5' }, () => c.plannerHeld(true))).toBeUndefined();
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
    const ask = async (name: string, model: string, baseURL?: string) => {
      const r = recording(name, ['answer'], baseURL ? { baseURL } : {});
      const flint = new Flint({ provider: r.provider, defaultModel: model, memory: chat.history(r.provider, model), retryPolicy: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 } });
      for await (const _ev of flint.chat({ conversationId: 'c1', message: `and then? (${name}:${model})` })) void _ev;
      return r.seen();
    };
    // The frontier's client, an eval candidate that is a cloud model under a plain name, the adopted local brain.
    expect(await ask('anthropic', 'claude-opus-5-5')).not.toContain(CANARY);
    listed(HERE, ['qwen2.5:14b', { name: 'candidate', remote_host: 'https://ollama.com' }]);
    const candidate = await ask('ollama', 'candidate', HERE);
    expect(candidate).not.toContain(CANARY);
    expect(candidate).toContain(HISTORY_GAP);
    expect(await ask('ollama', 'qwen2.5:14b', HERE)).toContain(CANARY);
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
