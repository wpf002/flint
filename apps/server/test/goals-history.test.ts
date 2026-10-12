/**
 * What a later turn's history carries (P3 part 4). A turn whose answering
 * brain was given Will's goals is marked, with the turn, from the moment it
 * begins; and a brain that does not run on this Mac never gets that turn back
 * as history. Its question and its answer are both left out, and one neutral
 * line stands where they were. A brain on this Mac still reads everything.
 * FLINT_GOALS_TO_FRONTIER=on lifts it: Will chose to send goal text out.
 *
 * First the store's view on its own, then the canary on the server in
 * miniature (./goals-mini): a local turn that used the goals, then a frontier
 * turn in the same conversation, with and without tier fallback.
 * Synthetic text only. No network.
 */
import { afterEach, describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message, Turn } from '@flint/core';
import { GOALS_TURN, HISTORY_GAP, carriedGoals, historyFor, staysHere } from '../src/goals-now';
import { PersistentStore } from '../src/persistent-store';
import { CANARY, HERE, answer, cleanup, miniServer as server, type Step } from './goals-mini';

const dirs: string[] = [];
afterEach(() => {
  cleanup();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmpStore = (opts: ConstructorParameters<typeof PersistentStore>[1] = { history: null }) => {
  const dir = mkdtempSync(join(tmpdir(), 'flint-goals-hist-'));
  dirs.push(dir);
  return new PersistentStore(join(dir, 'c.json'), opts);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A complete turn in the store, marked or not, as Flint.chat writes one. */
async function turn(store: PersistentStore, i: number, marked: boolean, at = 1_000 + i): Promise<void> {
  await store.beginTurn({
    conversationId: 'c', turnId: `t${i}`, createdAt: at, ...(marked ? { context: GOALS_TURN } : {}),
    userMessage: { id: `u${i}`, role: 'user', content: `question ${i}${marked ? ` ${CANARY}` : ''}`, timestamp: at },
  });
  await store.commitTurn({
    conversationId: 'c', turnId: `t${i}`, updatedAt: at, usage: { input: 1, output: 1 },
    responseMessages: [{ id: `a${i}`, role: 'assistant', content: `answer ${i}${marked ? ` ${CANARY}` : ''}`, timestamp: at }],
  });
}
const said = (messages: Message[]) => messages.map((m) => `${m.role}: ${m.content}`);

describe('the mark', () => {
  it('is the goals flag in a turn’s stored context, and nothing else', () => {
    expect(carriedGoals({ context: GOALS_TURN })).toBe(true);
    expect(carriedGoals({ context: { goals: true, spendKind: 'chat' } })).toBe(true);
    for (const context of [undefined, null, 'goals', true, {}, { goals: 'true' }, { goals: 1 }, { spendKind: 'chat' }, ['goals']]) expect(carriedGoals({ context }), JSON.stringify(context)).toBe(false);
    expect(carriedGoals({})).toBe(false);
    expect(Object.isFrozen(GOALS_TURN)).toBe(true);
  });

  it('the neutral line says nothing of what it stands for', () => {
    expect(HISTORY_GAP).toBe('[An earlier part of this conversation isn’t shown here.]');
    expect(HISTORY_GAP).not.toMatch(/goal|local|private|hidden/i);
  });
});

describe('PersistentStore.viewWithout: the store as one reader sees it', () => {
  it('leaves the named turns out, question and answer both, with one placeholder exchange where a run of them was', async () => {
    const store = tmpStore();
    for (const [i, marked] of [[1, false], [2, true], [3, true], [4, false], [5, true]] as const) await turn(store, i, marked);
    const view = store.viewWithout(carriedGoals, HISTORY_GAP);
    expect(said(await view.getMessages('c'))).toEqual([
      'user: question 1', 'assistant: answer 1',
      `user: ${HISTORY_GAP}`, `assistant: ${HISTORY_GAP}`,
      'user: question 4', 'assistant: answer 4',
      `user: ${HISTORY_GAP}`, `assistant: ${HISTORY_GAP}`,
    ]);
    expect(JSON.stringify(await view.getMessages('c'))).not.toContain(CANARY);
    // The store itself, and so a reader of all of it, is as it was.
    expect(said(await store.getMessages('c'))).toHaveLength(10);
    expect(JSON.stringify(await store.getMessages('c'))).toContain(`answer 3 ${CANARY}`);
  });

  it('user and assistant turns still alternate, wherever the gap falls: every provider takes it', async () => {
    for (const marks of [[true], [true, false], [false, true], [true, true, true], [false, true, false], [true, false, true, false, true]]) {
      const store = tmpStore();
      for (const [i, m] of marks.entries()) await turn(store, i + 1, m);
      const roles = (await store.viewWithout(carriedGoals, HISTORY_GAP).getMessages('c')).map((m) => m.role);
      // ...and the next message is the user's.
      expect([...roles, 'user'].every((r, i) => r === (i % 2 === 0 ? 'user' : 'assistant')), JSON.stringify(marks)).toBe(true);
    }
  });

  it('the placeholder is its own message: no stored message is changed, and ids are unique', async () => {
    const store = tmpStore();
    for (const [i, marked] of [[1, false], [2, true], [3, false], [4, true]] as const) await turn(store, i, marked);
    const messages = await store.viewWithout(carriedGoals, HISTORY_GAP).getMessages('c');
    expect(new Set(messages.map((m) => m.id)).size).toBe(messages.length);
    expect(messages.filter((m) => m.content === HISTORY_GAP)).toHaveLength(4);
    expect((await store.getTurns('c')).flatMap((t) => t.messages).some((m) => m.content.includes('isn’t shown'))).toBe(false);
  });

  it('the history check sees exactly the turns that reader is handed', async () => {
    const store = tmpStore();
    for (const [i, marked] of [[1, false], [2, true], [3, false]] as const) await turn(store, i, marked);
    const handed: string[][] = [];
    store.onHistory = (_c, ids) => void handed.push(ids);
    await store.viewWithout(carriedGoals, HISTORY_GAP).getMessages('c');
    await store.getMessages('c');
    expect(handed).toEqual([['t1', 't3'], ['t1', 't2', 't3']]);
  });

  it('writes go to the one store: a turn begun through a view is every reader’s turn', async () => {
    const store = tmpStore();
    const view = store.viewWithout(carriedGoals, HISTORY_GAP);
    await view.beginTurn({ conversationId: 'c', turnId: 't1', createdAt: 1, userMessage: { id: 'u1', role: 'user', content: 'q', timestamp: 1 } });
    await view.commitTurn({ conversationId: 'c', turnId: 't1', updatedAt: 2, usage: { input: 1, output: 1 }, responseMessages: [{ id: 'a1', role: 'assistant', content: 'a', timestamp: 2 }] });
    await view.beginTurn({ conversationId: 'c', turnId: 't2', createdAt: 3, userMessage: { id: 'u2', role: 'user', content: 'lost', timestamp: 3 } });
    await view.failTurn({ conversationId: 'c', turnId: 't2', updatedAt: 4, error: { kind: 'internal', message: 'x', retryable: false } });
    expect(said(await store.getMessages('c'))).toEqual(['user: q', 'assistant: a']);
    expect((await view.getTurns('c')).map((t: Turn) => t.status)).toEqual(['complete', 'failed']);
    expect(view.schemaVersion).toBe(store.schemaVersion);
  });

  it('the history window is the store’s own, applied first; a failed or pending turn is never history', async () => {
    const store = tmpStore({ history: { maxTurns: 2, maxAgeMs: Number.MAX_SAFE_INTEGER }, now: () => 2_000 });
    for (const [i, marked] of [[1, false], [2, false], [3, true]] as const) await turn(store, i, marked);
    await store.beginTurn({ conversationId: 'c', turnId: 't9', createdAt: 1_900, context: GOALS_TURN, userMessage: { id: 'u9', role: 'user', content: 'pending', timestamp: 1_900 } });
    expect(said(await store.viewWithout(carriedGoals, HISTORY_GAP).getMessages('c'))).toEqual(['user: question 2', 'assistant: answer 2', `user: ${HISTORY_GAP}`, `assistant: ${HISTORY_GAP}`]);
  });

  it('matches and historyChars read a turn and the window without handing anything out', async () => {
    const store = tmpStore();
    await turn(store, 1, false);
    await turn(store, 2, true);
    const handed: string[][] = [];
    store.onHistory = (_c, ids) => void handed.push(ids);
    expect(store.matches('c', 't2', carriedGoals)).toBe(true);
    expect(store.matches('c', 't1', carriedGoals)).toBe(false);
    expect(store.matches('c', 'nope', carriedGoals)).toBe(false);
    expect(store.matches('other', 't2', carriedGoals)).toBe(false);
    expect(store.historyChars('c')).toBe(['question 1', 'answer 1', `question 2 ${CANARY}`, `answer 2 ${CANARY}`].join('').length);
    expect(store.historyChars('other')).toBe(0);
    expect(handed).toEqual([]);
  });
});

describe('historyFor: which brain reads what', () => {
  const here = { provider: 'ollama', model: 'qwen2.5:14b', baseURL: HERE };
  it('a brain on this Mac reads the store itself; any other reads the view; unknown is not local', async () => {
    const store = tmpStore();
    await turn(store, 1, true);
    expect(historyFor(store, here, false)).toBe(store);
    for (const brain of [
      { provider: 'anthropic', model: 'claude-opus-5-5' }, { provider: 'openai', model: 'gpt-5' }, { provider: 'perplexity', model: 'sonar-pro' },
      { provider: 'ollama', model: 'gpt-oss:120b-cloud', baseURL: HERE }, { provider: 'ollama', model: 'qwen2.5:72b', baseURL: 'http://rented-gpu.example.com:11434' },
      { provider: 'ollama', model: 'qwen2.5:14b' }, undefined,
    ]) {
      const view = historyFor(store, brain, false);
      expect(view, JSON.stringify(brain)).not.toBe(store);
      expect(JSON.stringify(await view.getMessages('c')), JSON.stringify(brain)).not.toContain(CANARY);
    }
  });

  it('FLINT_GOALS_TO_FRONTIER=on lifts it for every brain that can be named; one that cannot is never given it', () => {
    const store = tmpStore();
    expect(historyFor(store, { provider: 'anthropic', model: 'claude-opus-5-5' }, true)).toBe(store);
    expect(historyFor(store, undefined, true)).not.toBe(store);
  });

  it('staysHere is the one answer for the history, the facts and the goals: on this Mac, or lifted, and never for a brain nobody can name', () => {
    const here = { provider: 'ollama', model: 'qwen2.5:14b', baseURL: HERE };
    const cloud = { provider: 'ollama', model: 'gpt-oss:120b-cloud', baseURL: HERE };
    const away = { provider: 'ollama', model: 'qwen2.5:14b', baseURL: 'http://10.0.0.7:11434' };
    const claude = { provider: 'anthropic', model: 'claude-opus-5-5' };
    expect([here, cloud, away, claude, undefined].map((b) => staysHere(b, false))).toEqual([true, false, false, false, false]);
    expect([here, cloud, away, claude, undefined].map((b) => staysHere(b, true))).toEqual([true, true, true, true, false]);
  });
});

describe('the canary across turns: a local turn that used the goals, then a frontier turn', () => {
  const claudeThenGpt = [
    { name: 'anthropic', model: 'claude-opus-5-5', script: ['answer'] as Step[] },
    { name: 'openai', model: 'gpt-5', script: ['answer'] as Step[] },
  ];
  /** A local model that repeats a goal's title in what it says. */
  const echoing = { name: 'ollama', model: 'qwen2.5:14b', baseURL: HERE, script: [{ say: `You are working on ${CANARY} goal 1, and it is likely.` }] as Step[] };
  const QUESTION = `how is ${CANARY}-in-my-question going?`;

  it('no outside request holds the canary: not the block, not the answer that repeated a goal, not the question that named one', async () => {
    const s = server({ frontier: claudeThenGpt, local: echoing });
    // An ordinary turn first, answered by Claude: it is nobody's secret.
    expect((await s.chat('frontier', 'what is the capital of France?')).answeredBy).toBe('frontier');
    // Then a turn the local model answers, with Will's goals in its context.
    const local = await s.chat('local', QUESTION);
    expect(local.goalsTokens).toBeGreaterThan(0);
    expect(local.answer).toContain(CANARY);
    // Then Claude again, in the same conversation.
    expect((await s.chat('frontier', 'and what is the weather?')).answeredBy).toBe('frontier');

    const claude = s.tiers[0]!;
    expect(claude.requests).toHaveLength(2);
    expect(claude.seen()).not.toContain(CANARY);
    expect(claude.seen()).not.toContain('You are working on');
    expect(claude.seen()).not.toContain('Will’s goals');
    // What Claude was sent for the last turn: the ordinary turn, one placeholder exchange, the new message.
    expect(said(claude.requests[1]!.messages)).toEqual([
      'user: what is the capital of France?', 'assistant: answer from anthropic',
      `user: ${HISTORY_GAP}`, `assistant: ${HISTORY_GAP}`,
      'user: and what is the weather?',
    ]);
    expect(s.tiers[1]!.requests).toHaveLength(0);
  });

  it('the same with tier fallback: the tier that fails and the tier that answers are both sent the history without it', async () => {
    const s = server({ frontier: [{ ...claudeThenGpt[0]!, script: ['fail'] }, claudeThenGpt[1]!], local: echoing });
    await s.chat('local', QUESTION);
    const r = await s.chat('frontier', 'and what is the weather?');
    expect(r).toMatchObject({ answeredBy: 'frontier', answer: 'answer from openai', goalsTokens: 0 });
    for (const t of s.tiers) {
      expect(t.requests, t.provider.name).toHaveLength(1);
      expect(t.seen(), t.provider.name).not.toContain(CANARY);
      expect(said(t.requests[0]!.messages), t.provider.name).toEqual([`user: ${HISTORY_GAP}`, `assistant: ${HISTORY_GAP}`, 'user: and what is the weather?']);
    }
  });

  it('and when every tier fails and the local model answers with the goals: that turn is marked too, and the next frontier turn goes without it', async () => {
    const s = server({ frontier: [{ ...claudeThenGpt[0]!, script: ['fail', 'answer'] }, { ...claudeThenGpt[1]!, script: ['fail', 'answer'] }], local: echoing });
    const first = await s.chat('frontier', QUESTION);
    expect(first.answeredBy).toBe('local');
    expect(first.goalsTokens).toBeGreaterThan(0);
    // The tiers were each asked that question themselves (it was the frontier's turn), and neither got the goals.
    for (const t of s.tiers) expect(t.seen(), t.provider.name).not.toContain('Will’s goals');
    const second = await s.chat('frontier', 'thanks');
    expect(second).toMatchObject({ answeredBy: 'frontier', answer: 'answer from anthropic' });
    const sent = s.tiers[0]!.requests[1]!;
    expect(said(sent.messages)).toEqual([`user: ${HISTORY_GAP}`, `assistant: ${HISTORY_GAP}`, 'user: thanks']);
    expect(JSON.stringify(sent)).not.toContain('You are working on');
    // Of the stored turns, only the one the local model answered is marked: the failed attempts are no history at all.
    const turns = await s.store.getTurns('c1');
    expect(turns.filter((t) => t.status === 'complete').map((t) => carriedGoals(t))).toEqual([true, false]);
    expect(turns.filter((t) => t.status === 'failed').every((t) => !carriedGoals(t))).toBe(true);
  });

  it('the local brain still sees everything: the turn, its own answer, and no placeholder', async () => {
    const s = server({ frontier: claudeThenGpt, local: echoing });
    await s.chat('local', QUESTION);
    await s.chat('frontier', 'and what is the weather?');
    await s.chat('local', 'which goal did you mean?');
    const sent = s.local.requests[1]!;
    expect(said(sent.messages)).toEqual([
      `user: ${QUESTION}`, `assistant: You are working on ${CANARY} goal 1, and it is likely.`,
      'user: and what is the weather?', 'assistant: answer from anthropic',
      'user: which goal did you mean?',
    ]);
    expect(JSON.stringify(sent.messages)).not.toContain(HISTORY_GAP);
    // And Claude, asked once in between, never got the first turn.
    expect(s.tiers[0]!.seen()).not.toContain(CANARY);
  });

  it('an `ollama:` tier on this Mac reads everything too; an Ollama tier on another machine does not', async () => {
    const onMac = server({ frontier: [{ name: 'ollama', model: 'qwen2.5:72b', baseURL: HERE }], local: echoing });
    await onMac.chat('local', QUESTION);
    await onMac.chat('frontier', 'go on');
    expect(onMac.tiers[0]!.seen()).toContain(`You are working on ${CANARY} goal 1`);

    const remote = server({ frontier: [{ name: 'ollama', model: 'qwen2.5:72b', baseURL: 'http://rented-gpu.example.com:11434' }], local: echoing });
    await remote.chat('local', QUESTION);
    await remote.chat('frontier', 'go on');
    expect(remote.tiers[0]!.seen()).not.toContain(CANARY);
    expect(said(remote.tiers[0]!.requests[0]!.messages)).toEqual([`user: ${HISTORY_GAP}`, `assistant: ${HISTORY_GAP}`, 'user: go on']);
  });

  it('a turn the local model answered WITHOUT the goals is ordinary history: nothing is hidden that did not carry them', async () => {
    // The runtime has no active goal, so there is no block and no mark.
    const s = server({ frontier: claudeThenGpt, goals: answer([]) });
    const local = await s.chat('local', 'what time is it?');
    expect(local.goalsTokens).toBe(0);
    await s.chat('frontier', 'and tomorrow?');
    expect(said(s.tiers[0]!.requests[0]!.messages)).toEqual(['user: what time is it?', 'assistant: answer from ollama', 'user: and tomorrow?']);
    expect((await s.store.getTurns('c1')).some((t) => carriedGoals(t))).toBe(false);
  });

  it('the mark is stored with the turn, from its start, and holds across a restart', async () => {
    const s = server({ frontier: claudeThenGpt, local: echoing });
    await s.chat('local', QUESTION);
    const [stored] = await s.store.getTurns('c1');
    expect(stored).toMatchObject({ status: 'complete', context: { goals: true } });
    // The store writes itself to disk a moment after a change; a server started later reads the mark back.
    await sleep(600);
    const again = server({ frontier: claudeThenGpt, local: echoing, storePath: s.storePath });
    expect((await again.store.getTurns('c1')).map((t) => carriedGoals(t))).toEqual([true]);
    await again.chat('frontier', 'thanks');
    expect(again.tiers[0]!.seen()).not.toContain(CANARY);
    expect(said(again.tiers[0]!.requests[0]!.messages)).toEqual([`user: ${HISTORY_GAP}`, `assistant: ${HISTORY_GAP}`, 'user: thanks']);
  });

  it('FLINT_GOALS_TO_FRONTIER=on lifts it: Claude gets the block and the history; turned off again, the marked turns are held back again', async () => {
    const open = server({ frontier: claudeThenGpt, local: echoing, toFrontier: true });
    await open.chat('local', QUESTION);
    const r = await open.chat('frontier', 'thanks');
    expect(r.goalsTokens).toBeGreaterThan(0);
    const sent = open.tiers[0]!.seen();
    expect(sent).toContain(`You are working on ${CANARY} goal 1`);
    expect(sent).toContain(QUESTION);
    expect(sent).not.toContain(HISTORY_GAP);
    // Both turns carried the goals, Claude's own included, and both are marked.
    expect((await open.store.getTurns('c1')).map((t) => carriedGoals(t))).toEqual([true, true]);

    // Will turns the setting off: from then on neither turn goes out again.
    await sleep(600);
    const shut = server({ frontier: claudeThenGpt, local: echoing, storePath: open.storePath });
    await shut.chat('frontier', 'and now?');
    expect(shut.tiers[0]!.seen()).not.toContain(CANARY);
    expect(said(shut.tiers[0]!.requests[0]!.messages)).toEqual([`user: ${HISTORY_GAP}`, `assistant: ${HISTORY_GAP}`, 'user: and now?']);
  });

  it('another conversation is another history: nothing is held back there', async () => {
    const s = server({ frontier: claudeThenGpt, local: echoing });
    await s.chat('local', QUESTION, 'c1');
    await s.chat('frontier', 'hello', 'c2');
    expect(said(s.tiers[0]!.requests[0]!.messages)).toEqual(['user: hello']);
  });
});
