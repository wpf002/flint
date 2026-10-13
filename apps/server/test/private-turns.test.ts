/**
 * Privacy covers history. The routing review's P1 to P8: a private turn was
 * answered on this Mac, and the NEXT turn in the conversation, sent to a cloud
 * model, carried the private question and its answer along as history.
 *
 * A turn Will kept on this Mac (Local Only, the words, or any turn of Local
 * mode) is marked where it is stored, and the mark is one of the two on the
 * list that keeps a stored turn here (../src/goals-now STAY_MARKS, beside the
 * mark of a turn answered with his goals). So what follows from it is the one
 * mechanism the goals turns use, driven here as the server drives it
 * (./goals-mini: real Flint clients and personas on the real store, the real
 * GoalsChat, scripted providers that keep what they were sent). One thing is
 * the private mark's own: FLINT_GOALS_TO_FRONTIER=on lifts nothing of it.
 *
 * No network. Synthetic text only.
 */
import { afterEach, describe, it, expect } from 'vitest';
import { speechStaysHere } from '../src/goals-chat';
import { GOALS_TURN, HISTORY_GAP, STAY_MARKS, carriedGoals, historyFor, keepsPrivate, keptHere, keptStrictly, stayMark, staysHere } from '../src/goals-now';
import { PersistentStore } from '../src/persistent-store';
import { LOCAL_MODE_TURN, PRIVATE_TURN, corpusMark, keptByModeAlone, privateByRequest, turnStaysHere, wasPrivate } from '../src/private-turns';
import { CANARY, HERE, answer, cleanup, goal, listed, miniServer as server, storedTurn, tmpStore } from './goals-mini';

afterEach(cleanup);

const SECRET = 'my diagnosis is ZEBRA-PRIVATE-7781';
const SECRET_REPLY = 'QUOKKA-PRIVATE-REPLY about the diagnosis';
const claude = [{ name: 'anthropic', model: 'claude-opus-5-5' }];
const PRIVATE = { private: true, mode: 'cloud' } as const;
const LOCAL_MODE = { private: false, mode: 'local' } as const;
const ORDINARY = { private: false, mode: 'cloud' } as const;
const here = { provider: 'ollama', model: 'qwen2.5:14b', baseURL: HERE };
const outside = { provider: 'anthropic', model: 'claude-opus-5-5' };
/** The local model, answering with words of its own that must not go out either. */
const localSaying = (...say: string[]) => ({ name: 'ollama', model: 'qwen2.5:14b', baseURL: HERE, script: say.map((s) => ({ say: s })) });
const contexts = async (store: PersistentStore, cid = 'c1') => (await store.getTurns(cid)).map((t) => t.context);

describe('the mark', () => {
  it('a turn stays here when Will kept it private (Local Only, or the words), and every turn in Local mode does', () => {
    expect(turnStaysHere({ private: true, mode: 'hybrid' })).toBe(true);
    expect(turnStaysHere({ private: true, mode: 'cloud' })).toBe(true);
    expect(turnStaysHere({ private: false, mode: 'local' })).toBe(true);
    expect(turnStaysHere({ private: false, mode: 'hybrid' })).toBe(false);
    expect(turnStaysHere({ private: false, mode: 'cloud' })).toBe(false);
    // The training corpus's entry carries the same word (../src/training).
    expect(corpusMark(PRIVATE)).toEqual({ staysHere: true });
    expect(corpusMark(LOCAL_MODE)).toEqual({ staysHere: true });
    expect(corpusMark(ORDINARY)).toEqual({});
  });

  it('is read from the stored turn’s context, and from nothing else', () => {
    expect(PRIVATE_TURN).toEqual({ private: true });
    expect(wasPrivate({ context: PRIVATE_TURN })).toBe(true);
    expect(wasPrivate({ context: { private: true, goals: true } })).toBe(true);
    for (const context of [undefined, null, {}, { private: 'yes' }, { private: false }, 'private', { spendKind: 'chat' }, GOALS_TURN]) expect(wasPrivate({ context }), JSON.stringify(context)).toBe(false);
  });

  it('is on the list of marks that keep a stored turn here, beside the goals mark, and a turn can carry both', () => {
    expect(STAY_MARKS).toEqual([carriedGoals, wasPrivate]);
    expect(keptHere({ context: PRIVATE_TURN })).toBe(true);
    expect(keptHere({ context: GOALS_TURN })).toBe(true);
    expect(keptHere({ context: {} })).toBe(false);
    // No setting lifts it: the goals mark alone is the one FLINT_GOALS_TO_FRONTIER lifts.
    expect(keptStrictly({ context: PRIVATE_TURN })).toBe(true);
    expect(keptStrictly({ context: { goals: true, private: true } })).toBe(true);
    expect(keptStrictly({ context: GOALS_TURN })).toBe(false);
    // The call context for a turn, by the marks it carries.
    expect(stayMark({ goals: false, private: false })).toBeUndefined();
    expect(stayMark({ goals: true, private: false })).toBe(GOALS_TURN);
    expect(stayMark({ goals: false, private: true })).toBe(PRIVATE_TURN);
    expect(stayMark({ goals: true, private: true })).toEqual({ goals: true, private: true });
  });

  // "Stays here" (history, memory, speech: a private turn OR any turn of Local mode) and "explicitly private" (the
  // tools a turn is offered, and whether it is asked for a goal) are two notions. A route says both while the turn
  // runs. Stored, the mark is one, and a note tells the turns the mode alone kept from the ones Will asked to keep.
  it('two notions, as stored: a turn of Local mode carries the same mark with a note, and only the note makes a turn the mode’s', () => {
    expect(LOCAL_MODE_TURN).toEqual({ private: true, byMode: true });
    // Everything the mark does, it does for both.
    for (const context of [PRIVATE_TURN, LOCAL_MODE_TURN, { goals: true, private: true, byMode: true }]) {
      expect(wasPrivate({ context })).toBe(true);
      expect(keptHere({ context })).toBe(true);
      expect(keptStrictly({ context })).toBe(true);
    }
    // By Will's own word: the mark with no note. That is also every turn marked before the note existed.
    expect(privateByRequest({ context: PRIVATE_TURN })).toBe(true);
    expect(privateByRequest({ context: { goals: true, private: true } })).toBe(true);
    expect(privateByRequest({ context: LOCAL_MODE_TURN })).toBe(false);
    expect(privateByRequest({ context: { goals: true, private: true, byMode: true } })).toBe(false);
    // Anything but `true` is no note, and a note without the mark is nothing.
    for (const byMode of [false, 'true', 1, null, undefined, {}]) expect(privateByRequest({ context: { private: true, byMode } }), String(byMode)).toBe(true);
    for (const context of [undefined, null, {}, { byMode: true }, GOALS_TURN, { private: false, byMode: true }]) expect(privateByRequest({ context }), JSON.stringify(context)).toBe(false);
    // Which route is the mode's alone: Local mode, and he did not ask for the turn to be private.
    expect(keptByModeAlone(LOCAL_MODE)).toBe(true);
    expect(keptByModeAlone({ private: true, mode: 'local' })).toBe(false);
    expect(keptByModeAlone(PRIVATE)).toBe(false);
    expect(keptByModeAlone(ORDINARY)).toBe(false);
    expect(keptByModeAlone({ private: false, mode: 'hybrid' })).toBe(false);
    // The call context, by the marks and the note.
    expect(stayMark({ goals: false, private: true, byMode: true })).toBe(LOCAL_MODE_TURN);
    expect(stayMark({ goals: false, private: true, byMode: false })).toBe(PRIVATE_TURN);
    expect(stayMark({ goals: true, private: true, byMode: true })).toEqual({ goals: true, private: true, byMode: true });
    expect(stayMark({ goals: true, private: false, byMode: true })).toBe(GOALS_TURN);
    expect(stayMark({ goals: false, private: false, byMode: true })).toBeUndefined();
  });

  it('the note is written by the route alone: Local Only in Local mode is his word, and a turn outside Local mode that read a private one carries none', async () => {
    const s = server({ frontier: claude, goals: answer([]), goalsOn: false, local: localSaying('a', 'b', 'c', 'd', 'e') });
    await s.chat('local', 'a turn of Local mode', 'mode', LOCAL_MODE);
    await s.chat('local', 'Local Only, while in Local mode', 'both', { private: true, mode: 'local' });
    await s.chat('local', SECRET, 'word', PRIVATE);
    // An ordinary turn by its route, answered by the local model, which read the private turn before it.
    await s.chat('local', 'and remind me of it', 'word', ORDINARY);
    expect(await contexts(s.store, 'mode')).toEqual([LOCAL_MODE_TURN]);
    expect(await contexts(s.store, 'both')).toEqual([PRIVATE_TURN]);
    expect(await contexts(s.store, 'word')).toEqual([PRIVATE_TURN, PRIVATE_TURN]);
    // A turn of Local mode that read a private one is still the mode's: Will did not ask for THAT turn to be private.
    await s.chat('local', 'and again, in Local mode', 'word', LOCAL_MODE);
    expect((await contexts(s.store, 'word')).at(-1)).toEqual(LOCAL_MODE_TURN);
  });

  it('who may read it: a brain on this Mac, and no other, whatever Will set for his goals', () => {
    listed(HERE, ['qwen2.5:14b']);
    expect(keepsPrivate(here)).toBe(true);
    expect(keepsPrivate(outside)).toBe(false);
    expect(keepsPrivate({ ...here, baseURL: 'http://gpu-box.lan:11434' })).toBe(false);
    expect(keepsPrivate({ ...here, model: 'not-pulled' })).toBe(false);
    expect(keepsPrivate(undefined)).toBe(false);
    // The goals rule has a switch (FLINT_GOALS_TO_FRONTIER); this one has none.
    expect(staysHere(outside, true)).toBe(true);
    expect(keepsPrivate.length).toBe(1);
  });

  it('is stored with the turn from the moment it begins, and survives a reload from disk', async () => {
    const s = server({ frontier: claude, goals: answer([]), goalsOn: false });
    await s.chat('local', SECRET, 'c1', PRIVATE);
    await s.chat('frontier', 'and what about lunch?', 'c2', ORDINARY);
    expect(await contexts(s.store, 'c1')).toEqual([PRIVATE_TURN]);
    expect(await contexts(s.store, 'c2')).toEqual([undefined]);
    const [first] = await s.store.getTurns('c1');
    expect(s.store.matches('c1', first!.id, wasPrivate)).toBe(true);
    expect(s.store.matches('c1', 'no-such-turn', wasPrivate)).toBe(false);
    // Flush the debounced snapshot, then read it back.
    await new Promise((r) => setTimeout(r, 450));
    const again = new PersistentStore(s.storePath, { history: null });
    expect((await again.getTurns('c1')).map((t) => wasPrivate(t))).toEqual([true]);
  });
});

describe('a private turn never goes out later as history', () => {
  // P1 + P2 (the words), P3 + P4 (Local Only): a private turn, then one that is not.
  it('the next turn, on a cloud brain: the private question and its answer are left out, with one neutral exchange in their place', async () => {
    const s = server({ frontier: claude, goals: answer([]), goalsOn: false, local: localSaying(SECRET_REPLY) });
    const first = await s.chat('local', SECRET, 'c1', PRIVATE);
    expect(s.local.seen()).toContain('ZEBRA-PRIVATE-7781'); // the local brain was asked it, of course
    // The client is told, ahead of the reply, that it stays here, and which stored turn it is (for /speak).
    const [stored] = await s.store.getTurns('c1');
    expect(first.metas).toEqual([{ type: 'meta', staysHere: true, turn: stored!.id }]);
    const next = await s.chat('frontier', 'think hard: summarise what I told you', 'c1', ORDINARY);
    expect(next.metas).toMatchObject([{ type: 'meta', staysHere: false }]);
    const sent = s.tiers[0]!.seen();
    expect(sent).not.toContain('ZEBRA-PRIVATE-7781');
    expect(sent).not.toContain('QUOKKA-PRIVATE-REPLY');
    expect(s.tiers[0]!.requests[0]!.messages.map((m) => [m.role, m.content])).toEqual([
      ['user', HISTORY_GAP],
      ['assistant', HISTORY_GAP],
      ['user', 'think hard: summarise what I told you'],
    ]);
    expect(HISTORY_GAP).toBe('[An earlier part of this conversation isn’t shown here.]');
    expect(await contexts(s.store)).toEqual([PRIVATE_TURN, undefined]);
  });

  // P6 + P7 + P8: a turn in Local mode, then the mode is switched to Cloud.
  it('a turn taken in Local mode stays here after the mode changes: it was marked when it was stored', async () => {
    const s = server({ frontier: claude, goals: answer([]), goalsOn: false, local: localSaying(SECRET_REPLY) });
    await s.chat('local', SECRET, 'c3', LOCAL_MODE);
    // (The same mark, with the note that it is the mode that keeps it here: see "two notions, as stored" below.)
    expect(await contexts(s.store, 'c3')).toEqual([LOCAL_MODE_TURN]);
    expect((await s.store.getTurns('c3')).map((t) => wasPrivate(t))).toEqual([true]);
    await s.chat('frontier', 'what did I just say?', 'c3', ORDINARY);
    expect(s.tiers[0]!.seen()).not.toContain('ZEBRA-PRIVATE-7781');
    expect(s.tiers[0]!.seen()).not.toContain('QUOKKA-PRIVATE-REPLY');
  });

  it('the local brain still reads all of it, and a local turn that read a private one is kept private too', async () => {
    const s = server({ frontier: claude, goals: answer([]), goalsOn: false, local: localSaying(SECRET_REPLY, `you said: ${SECRET}`) });
    await s.chat('local', SECRET, 'c1', PRIVATE);
    await s.chat('frontier', 'a public question', 'c1', ORDINARY);
    // An ordinary turn by its route (the frontier failed over, or no cloud is set up): the local model answers it.
    const third = await s.chat('local', 'remind me what my diagnosis was', 'c1', ORDINARY);
    const sent = JSON.stringify(s.local.requests[1]!.messages);
    expect(sent).toContain('ZEBRA-PRIVATE-7781');
    expect(sent).toContain('QUOKKA-PRIVATE-REPLY');
    expect(sent).toContain('answer from anthropic');
    expect(sent).not.toContain(HISTORY_GAP);
    // It read a private turn, so what it says is held the same way: marked, and never the cloud's to read.
    expect(third.metas).toMatchObject([{ staysHere: true }]);
    expect(await contexts(s.store)).toEqual([PRIVATE_TURN, undefined, PRIVATE_TURN]);
    await s.chat('frontier', 'go on', 'c1', ORDINARY);
    expect(s.tiers[0]!.seen()).not.toContain('ZEBRA-PRIVATE-7781');
    expect(s.tiers[0]!.seen()).not.toContain('QUOKKA-PRIVATE-REPLY');
  });

  it('the standby local model is named like the main one: it reads a private turn, and its own turn is kept private', async () => {
    const s = server({ frontier: claude, goals: answer([]), goalsOn: false, local: localSaying(SECRET_REPLY), standby: { name: 'ollama', model: 'qwen2.5:3b', baseURL: HERE } });
    await s.chat('local', SECRET, 'c1', PRIVATE);
    await s.chat('standby', 'and again?', 'c1', LOCAL_MODE); // (a turn of Local mode: the mark, with its note)
    expect(JSON.stringify(s.standby!.requests[0]!.messages)).toContain('ZEBRA-PRIVATE-7781');
    expect(await contexts(s.store)).toEqual([PRIVATE_TURN, LOCAL_MODE_TURN]);
  });

  it('a run of private turns is one gap, each run its own, and roles still alternate', async () => {
    const s = server({ frontier: claude, goals: answer([]), goalsOn: false });
    await s.chat('frontier', 'public one', 'c', ORDINARY);
    await s.chat('local', `${SECRET} (first)`, 'c', PRIVATE);
    await s.chat('local', `${SECRET} (second)`, 'c', PRIVATE);
    await s.chat('frontier', 'public two', 'c', ORDINARY);
    await s.chat('local', `${SECRET} (third)`, 'c', LOCAL_MODE);
    await s.chat('frontier', 'public three', 'c', ORDINARY);
    const messages = s.tiers[0]!.requests.at(-1)!.messages.map((m) => [m.role, m.content]);
    expect(messages).toEqual([
      ['user', 'public one'],
      ['assistant', 'answer from anthropic'],
      ['user', HISTORY_GAP],
      ['assistant', HISTORY_GAP],
      ['user', 'public two'],
      ['assistant', 'answer from anthropic'],
      ['user', HISTORY_GAP],
      ['assistant', HISTORY_GAP],
      ['user', 'public three'],
    ]);
    for (let i = 1; i < messages.length; i++) expect(messages[i]![0]).not.toBe(messages[i - 1]![0]);
    expect(s.tiers[0]!.seen()).not.toContain('ZEBRA');
  });

  it('nothing stored is changed: the view only differs in what it hands out', async () => {
    const s = server({ frontier: claude, goals: answer([]), goalsOn: false });
    await s.chat('local', SECRET, 'c1', PRIVATE);
    await s.chat('frontier', 'public', 'c1', ORDINARY);
    const all = await s.store.getTurns('c1');
    expect(all).toHaveLength(2);
    expect(JSON.stringify(all)).toContain('ZEBRA-PRIVATE-7781');
    expect(JSON.stringify(await s.store.getMessages('c1'))).toContain('ZEBRA-PRIVATE-7781');
    // The cloud's own turn was stored through its view, in the one store.
    expect(all[1]!.messages.map((m) => m.content)).toEqual(['public', 'answer from anthropic']);
  });

  it('a private turn asked of a brain that is not known to run here is still marked, and that brain reads nothing that stays here', async () => {
    // The "local" model is on another machine Will has not allowed (in the server such a turn is refused before
    // this: ../src/local-serve; the mark and the view hold whoever is asked).
    const s = server({ frontier: claude, goals: answer([goal(1)]), local: { name: 'ollama', model: 'qwen2.5:14b', baseURL: 'http://10.0.0.7:11434' } });
    await storedTurn(s.store, { id: 'first', context: PRIVATE_TURN, user: SECRET, assistant: SECRET_REPLY });
    const r = await s.chat('local', 'what did I say before?', 'c1', PRIVATE);
    expect(s.local.seen()).not.toContain('ZEBRA-PRIVATE-7781');
    expect(s.local.seen()).not.toContain(CANARY); // nor Will's goals
    expect(JSON.stringify(s.local.requests[0]!.messages)).toContain(HISTORY_GAP);
    expect(r.metas).toMatchObject([{ staysHere: true }]);
    expect(await contexts(s.store)).toEqual([PRIVATE_TURN, PRIVATE_TURN]);
  });
});

describe('FLINT_GOALS_TO_FRONTIER=on is about Will’s goals: it lifts nothing he kept private', () => {
  it('with it on, an outside brain is handed the turns answered with his goals, and never a private one', async () => {
    const s = server({ frontier: claude, toFrontier: true, goals: answer([goal(1)]) });
    await storedTurn(s.store, { id: 'g', context: GOALS_TURN, user: 'how are my goals going?', assistant: `GOALS-ANSWER ${CANARY}` });
    await storedTurn(s.store, { id: 'p', context: PRIVATE_TURN, user: SECRET, assistant: SECRET_REPLY });
    await storedTurn(s.store, { id: 'b', context: { goals: true, private: true }, user: `both: ${SECRET}`, assistant: 'BOTH-ANSWER' });
    await s.chat('frontier', 'and now?', 'c1', ORDINARY);
    const sent = s.tiers[0]!.seen();
    expect(sent).toContain('GOALS-ANSWER'); // his choice: goal text goes out
    expect(sent).not.toContain('ZEBRA-PRIVATE-7781');
    expect(sent).not.toContain('QUOKKA-PRIVATE-REPLY');
    expect(sent).not.toContain('BOTH-ANSWER');
    expect(JSON.stringify(s.tiers[0]!.requests[0]!.messages)).toContain(HISTORY_GAP);
  });

  it('a private turn on the local model reads everything; the cloud turn after it gets neither it nor what it repeated', async () => {
    const s = server({ frontier: claude, toFrontier: true, goals: answer([goal(1)]), local: localSaying(`you said ${SECRET}`) });
    await storedTurn(s.store, { id: 'p', context: PRIVATE_TURN, user: SECRET, assistant: SECRET_REPLY });
    const r = await s.chat('local', 'what did I say?', 'c1', ORDINARY);
    expect(JSON.stringify(s.local.requests[0]!.messages)).toContain('ZEBRA-PRIVATE-7781');
    // It was given Will's goals too (the block is on): a turn that is both keeps BOTH marks.
    expect(r.goalsTokens).toBeGreaterThan(0);
    expect((await contexts(s.store)).at(-1)).toEqual({ goals: true, private: true });
    await s.chat('frontier', 'go on', 'c1', ORDINARY);
    expect(s.tiers[0]!.seen()).not.toContain('ZEBRA-PRIVATE-7781');
    expect(s.tiers[0]!.seen()).not.toContain('QUOKKA-PRIVATE-REPLY');
  });
});

describe('a turn that is both private and a goals turn', () => {
  it('keeps both marks: Will’s goals were in its context, and its route keeps it here', async () => {
    const s = server({ frontier: claude, goals: answer([goal(1)]) });
    const r = await s.chat('local', 'privately: how are my goals going?', 'c1', PRIVATE);
    expect(r.goalsTokens).toBeGreaterThan(0);
    expect(s.local.seen()).toContain(CANARY);
    expect(await contexts(s.store)).toEqual([{ goals: true, private: true }]);
    const [t] = await s.store.getTurns('c1');
    expect([carriedGoals(t!), wasPrivate(t!), keptHere(t!)]).toEqual([true, true, true]);
    expect(r.asks.at(-1)!.mark).toEqual({ goals: true, private: true });
  });

  it('a goals turn that is not private carries the goals mark alone, as before', async () => {
    const s = server({ frontier: claude, goals: answer([goal(1)]) });
    await s.chat('local', 'how are my goals going?', 'c1', ORDINARY);
    expect(await contexts(s.store)).toEqual([GOALS_TURN]);
  });
});

describe('the history view is tied to the turn it is read for (../src/goals-now historyFor)', () => {
  const begin = (view: ReturnType<typeof historyFor>, id: string, context?: unknown) =>
    view.beginTurn({ conversationId: 'c1', turnId: id, createdAt: Date.now(), ...(context !== undefined ? { context } : {}), userMessage: { id: `${id}_u`, role: 'user', content: 'next', timestamp: Date.now() } });
  const texts = async (view: ReturnType<typeof historyFor>) => JSON.stringify(await view.getMessages('c1'));
  async function seeded() {
    const store = tmpStore();
    listed(HERE, ['qwen2.5:14b']);
    await storedTurn(store, { id: 'g', context: GOALS_TURN, user: 'how are my goals going?', assistant: 'GOALS-ANSWER' });
    await storedTurn(store, { id: 'p', context: PRIVATE_TURN, user: SECRET, assistant: SECRET_REPLY });
    return store;
  }

  it('a brain on this Mac reads a private turn only for a turn that was begun private', async () => {
    const store = await seeded();
    const view = historyFor(store, here, false);
    // No turn begun: what a brain off this Mac reads.
    expect(await texts(view)).not.toContain('ZEBRA');
    // An unmarked turn: the same. (It would be stored unmarked, and go out a turn later.)
    await begin(view, 'u');
    const unmarked = await texts(view);
    expect(unmarked).not.toContain('ZEBRA');
    expect(unmarked).not.toContain('GOALS-ANSWER');
    // A goals turn: the goals turns, and never the private one (FLINT_GOALS_TO_FRONTIER could send a goals turn out).
    await begin(view, 'g2', GOALS_TURN);
    const goalsOnly = await texts(view);
    expect(goalsOnly).toContain('GOALS-ANSWER');
    expect(goalsOnly).not.toContain('ZEBRA');
    // A private turn, or one with both marks: all of it.
    await begin(view, 'p2', PRIVATE_TURN);
    const priv = await texts(view);
    expect(priv).toContain('ZEBRA');
    expect(priv).toContain('GOALS-ANSWER');
    await begin(view, 'b2', { goals: true, private: true });
    expect(await texts(view)).toContain('ZEBRA');
  });

  it('a brain off this Mac never reads one, whatever its turn carries and whatever Will set for his goals', async () => {
    const store = await seeded();
    for (const toFrontier of [false, true]) {
      const view = historyFor(store, outside, toFrontier);
      for (const [n, context] of [undefined, GOALS_TURN, PRIVATE_TURN, { goals: true, private: true }].entries()) {
        await begin(view, `x${toFrontier}${n}`, context);
        const read = await texts(view);
        expect(read, `${toFrontier} ${JSON.stringify(context)}`).not.toContain('ZEBRA');
        expect(read.includes('GOALS-ANSWER'), `${toFrontier} ${JSON.stringify(context)}`).toBe(toFrontier);
      }
    }
    // A brain nobody can name reads nothing that stays here either.
    expect(await texts(historyFor(store, undefined, true))).not.toContain('GOALS-ANSWER');
  });

  it('two private turns begun at once in one conversation cannot be told apart: neither is handed what stays here', async () => {
    const store = await seeded();
    const view = historyFor(store, here, false);
    await begin(view, 'a', PRIVATE_TURN);
    await begin(view, 'b', PRIVATE_TURN);
    expect(await texts(view)).not.toContain('ZEBRA');
    expect(await texts(view)).not.toContain('ZEBRA');
  });

  it('the history check is told exactly the turns a reader was handed: a turn left out cannot taint what never reads it', async () => {
    const store = await seeded();
    await storedTurn(store, { id: 'o', user: 'public', assistant: 'public answer' });
    const handed: string[][] = [];
    store.onHistory = (_cid, ids) => handed.push(ids);
    await historyFor(store, outside, false).getMessages('c1');
    const mine = historyFor(store, here, false);
    await begin(mine, 'p3', PRIVATE_TURN);
    await mine.getMessages('c1');
    expect(handed).toEqual([['o'], ['g', 'p', 'o']]);
  });
});

describe('the training corpus: a turn that stays here is written with the mark (../src/goals-chat ChatTurn.corpus)', () => {
  it('by its route, or by what the brain that answered was given: a private turn it read, Will’s goals', async () => {
    const s = server({ frontier: claude, goals: answer([goal(1)]), goalsOn: false });
    expect((await s.chat('local', SECRET, 'c1', PRIVATE)).corpus).toEqual({ staysHere: true });
    expect((await s.chat('local', 'a Local mode turn', 'c2', LOCAL_MODE)).corpus).toEqual({ staysHere: true });
    expect((await s.chat('frontier', 'an ordinary one', 'c3', ORDINARY)).corpus).toEqual({});
    // An ordinary turn by its route that the local model answered with the private turn in its history.
    expect((await s.chat('local', 'what did I say?', 'c1', ORDINARY)).corpus).toEqual({ staysHere: true });
    // The frontier answering in that conversation read none of it: an ordinary example.
    expect((await s.chat('frontier', 'thanks', 'c1', ORDINARY)).corpus).toEqual({});
    // A turn answered with Will's goals in its context is one that stays here too.
    const withGoals = server({ frontier: claude, goals: answer([goal(1)]) });
    expect((await withGoals.chat('local', 'how are my goals going?', 'g1', ORDINARY)).corpus).toEqual({ staysHere: true });
    expect((await withGoals.chat('frontier', 'how are my goals going?', 'g2', ORDINARY)).corpus).toEqual({});
  });

  it('a frontier that failed over to the local model: the mark is the answering ask’s', async () => {
    const s = server({ frontier: [{ ...claude[0]!, script: ['fail'] }], goals: answer([]), goalsOn: false });
    await storedTurn(s.store, { id: 'p', context: PRIVATE_TURN, user: SECRET, assistant: SECRET_REPLY });
    const r = await s.chat('frontier', 'go on', 'c1', ORDINARY);
    expect(r.answeredBy).toBe('local');
    expect(r.corpus).toEqual({ staysHere: true });
    expect(s.tiers[0]!.seen()).not.toContain('ZEBRA-PRIVATE-7781');
  });
});

describe('speech: a reply that stays here is never sent out to be spoken (../src/goals-chat speechStaysHere)', () => {
  it('a private turn’s reply, and one from Local mode, are held like a goals turn’s; an ordinary reply is not', async () => {
    const s = server({ frontier: claude, goals: answer([]), goalsOn: false });
    await s.chat('local', SECRET, 'priv', PRIVATE);
    await s.chat('local', 'a Local mode turn', 'mode', LOCAL_MODE);
    await s.chat('frontier', 'an ordinary one', 'open', ORDINARY);
    const id = async (cid: string) => (await s.store.getTurns(cid))[0]!.id;
    expect(speechStaysHere(s.store, { conversationId: 'priv', turnId: await id('priv') })).toBe(true);
    expect(speechStaysHere(s.store, { conversationId: 'mode', turnId: await id('mode') })).toBe(true);
    expect(speechStaysHere(s.store, { conversationId: 'open', turnId: await id('open') })).toBe(false);
    // A request that names no turn is about the conversation's newest one; one that names nothing is held to the strictest answer.
    expect(s.goalsChat.speechStaysHere({ conversationId: 'priv' })).toBe(true);
    expect(s.goalsChat.speechStaysHere({ conversationId: 'open' })).toBe(false);
    expect(s.goalsChat.speechStaysHere({})).toBe(true);
  });
});
