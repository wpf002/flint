/**
 * The mark follows history (P3 part 4).
 *
 * A brain on this Mac reads the turns that stay here as history, so what it
 * says next may repeat them. Its turn is therefore one that stays here too,
 * whether or not it was itself given Will's goals: marked where it is stored,
 * offered only the tools that keep it here, and mined only by an extractor
 * that may read it. Without this, the local model's next answer went to an
 * outside brain one turn later, as ordinary history.
 *
 * It holds with no goals block at all: when the block did not fit, when the
 * runtime did not answer, when no goal is active any more, and after the block
 * (or every block) is turned off.
 *
 * The server in miniature (./goals-mini), which makes each ask through the
 * module index.ts uses (../src/goals-chat). No network. Synthetic text only.
 */
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Tool } from '@flint/core';
import { GOALS_TURN, HISTORY_GAP, STAY_MARKS, carriedGoals, keptHere } from '../src/goals-now';
import { withoutOutsideAi } from '../src/goals-tools';
import { KnowledgeStore } from '../src/knowledge';
import { MemoryExtractor } from '../src/memory-extract';
import { brainOf } from '../src/policy';
import { paidToolSpecs } from '../src/spend';
import { CANARY, HERE, answer, cleanup, goal, miniServer as server, storedTurn, tmpStore, type MiniOptions, type Step } from './goals-mini';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flint-goals-carry-'));
});
afterEach(() => {
  cleanup();
  rmSync(dir, { recursive: true, force: true });
});

const claude = [{ name: 'anthropic', model: 'claude-opus-5-5', script: ['answer'] as Step[] }];
const T1 = `Your goal is ${CANARY} goal 1, likely.`;
const T2 = `As I said: ${CANARY} goal 1 (repeated from history).`;
/** A local model that says a goal's words on its first turn and repeats them, from history, on its second. */
const echoing = (numCtx?: number, script: Step[] = [{ say: T1 }, { say: T2 }]) => ({ name: 'ollama', model: 'qwen2.5:14b', baseURL: HERE, ...(numCtx ? { numCtx } : {}), script });
const marks = async (s: { store: ReturnType<typeof tmpStore> }, cid = 'c1') => (await s.store.getTurns(cid)).filter((t) => t.status === 'complete').map((t) => carriedGoals(t));

/**
 * The second server on the first one's conversation store: a restart with
 * something changed. The local model there repeats the goal from history.
 */
const restarted = (first: { storePath: string }, o: Partial<MiniOptions>) => server({ frontier: claude, local: echoing(undefined, [{ say: T2 }]), storePath: first.storePath, ...o });

describe('a local turn that reads a goals turn in its history, and is given no goals block', () => {
  it('the block does not fit any more (a small context, a long message): the turn is marked, and Claude’s next request holds none of it', async () => {
    const s = server({ frontier: claude, local: echoing(4096) });
    expect((await s.chat('local', 'how are my goals going?')).goalsTokens).toBeGreaterThan(0);
    // A long message leaves no room for the block in a 4,096-token window.
    const two = await s.chat('local', `summarize what you just told me ${'x'.repeat(14_000)}`);
    expect(two.goalsTokens).toBe(0);
    expect(s.local.requests[1]!.system ?? '').not.toContain('Will’s goals');
    // The local model was handed turn 1, question and answer, as history: that is what makes turn 2 one that stays here.
    expect(JSON.stringify(s.local.requests[1]!.messages)).toContain(T1);
    expect(await marks(s)).toEqual([true, true]);
    await s.chat('frontier', 'thanks');
    const sent = s.tiers[0]!.seen();
    expect(sent).not.toContain(CANARY);
    expect(sent).toContain(HISTORY_GAP);
    expect(sent).toContain('thanks');
  });

  it('FLINT_GOALS_NOW was turned off after a goals turn (the same store): the same', async () => {
    const on = server({ frontier: claude, local: echoing() });
    await on.chat('local', 'how are my goals going?');
    await new Promise((r) => setTimeout(r, 600)); // the store writes its file
    const off = restarted(on, { goalsOn: false });
    const two = await off.chat('local', 'which goal did you mean?');
    expect(two.goalsTokens).toBe(0);
    expect(off.fetched()).toBe(0);
    expect(JSON.stringify(off.local.requests[0]!.messages)).toContain(T1);
    expect(await marks(off)).toEqual([true, true]);
    await off.chat('frontier', 'thanks');
    expect(off.tiers[0]!.seen()).not.toContain(CANARY);
  });

  it('the runtime has no active goal any more: the same', async () => {
    const on = server({ frontier: claude, local: echoing(), goals: answer([goal(1)]) });
    await on.chat('local', 'how are my goals going?');
    await new Promise((r) => setTimeout(r, 600));
    const none = restarted(on, { goals: answer([]) });
    expect((await none.chat('local', 'which goal did you mean?')).goalsTokens).toBe(0);
    expect(await marks(none)).toEqual([true, true]);
    await none.chat('frontier', 'thanks');
    expect(none.tiers[0]!.seen()).not.toContain(CANARY);
  });

  it('the runtime did not answer: the same', async () => {
    const on = server({ frontier: claude, local: echoing() });
    await on.chat('local', 'how are my goals going?');
    await new Promise((r) => setTimeout(r, 600));
    const down = restarted(on, { runtimeDown: true });
    expect((await down.chat('local', 'which goal did you mean?')).goalsTokens).toBe(0);
    expect(down.fetched()).toBe(1);
    expect(await marks(down)).toEqual([true, true]);
    await down.chat('frontier', 'thanks');
    expect(down.tiers[0]!.seen()).not.toContain(CANARY);
  });

  it('it carries on: every local turn that reads a marked turn is marked, so the third is too, and a frontier turn between them is not', async () => {
    const s = server({ frontier: claude, goals: answer([]), local: echoing(undefined, [{ say: T2 }]) });
    await storedTurn(s.store, { id: 'first', context: GOALS_TURN, user: 'how are my goals going?', assistant: T1 });
    await s.chat('local', 'which goal did you mean?');
    await s.chat('frontier', 'what is the weather?');
    await s.chat('local', 'and again?');
    expect(await marks(s)).toEqual([true, true, false, true]);
    // Claude was asked twice in all (the turn above and this one), and never saw a marked turn's words.
    await s.chat('frontier', 'thanks');
    expect(s.tiers[0]!.seen()).not.toContain(CANARY);
    expect(s.tiers[0]!.requests).toHaveLength(2);
    // Its own earlier turn is ordinary history to it.
    expect(JSON.stringify(s.tiers[0]!.requests[1]!.messages)).toContain('what is the weather?');
  });

  it('it is the history the brain is handed that counts: once the marked turn has left the store’s window, a local turn is an ordinary one again', async () => {
    const s = server({ frontier: claude, goals: answer([]), history: { maxTurns: 2, maxAgeMs: Number.POSITIVE_INFINITY } });
    await storedTurn(s.store, { id: 'first', context: GOALS_TURN, user: 'how are my goals going?', assistant: T1 });
    await s.chat('frontier', 'one');
    await s.chat('frontier', 'two');
    // The window is the last two turns, and neither is marked: the local model is not handed the goals turn.
    await s.chat('local', 'three');
    expect(JSON.stringify(s.local.requests[0]!.messages)).not.toContain(CANARY);
    expect(await marks(s)).toEqual([true, false, false, false]);
  });

  it('a conversation with no marked turn is untouched: no mark, every tool, whatever the block did', async () => {
    const tool = (name: string): Tool => ({ definition: { name, description: name, inputSchema: { type: 'object', properties: {} }, idempotent: true }, handler: async () => ({ ok: true }) });
    const s = server({ frontier: claude, goals: answer([]), tools: [tool('trident.perplexity_search')], goalsTools: withoutOutsideAi({ specs: paidToolSpecs({}) }) });
    await s.chat('local', 'hello');
    await s.chat('local', 'hello again');
    expect(await marks(s)).toEqual([false, false]);
    expect((s.local.requests[1]!.tools ?? []).map((t) => t.name)).toEqual(['trident.perplexity_search']);
  });

  it('an outside brain is never marked by it: it was not handed the marked turn, so there is nothing of it to carry', async () => {
    const s = server({ frontier: claude, goals: answer([]) });
    await storedTurn(s.store, { id: 'first', context: GOALS_TURN, user: 'how are my goals going?', assistant: T1 });
    const out = await s.chat('frontier', 'what is the weather?');
    expect(out.metas.map((m) => m.staysHere)).toEqual([false]);
    expect(await marks(s)).toEqual([true, false]);
    expect(s.tiers[0]!.seen()).not.toContain(CANARY);
  });

  it('nor is a local brain asked outside a local model’s turn, or one that is not on this Mac: neither reads the marked turn', async () => {
    const away = server({ frontier: claude, goals: answer([]), local: { name: 'ollama', model: 'qwen2.5:14b', baseURL: 'http://10.0.0.7:11434' } });
    await storedTurn(away.store, { id: 'first', context: GOALS_TURN, user: 'how are my goals going?', assistant: T1 });
    await away.chat('local', 'which goal did you mean?');
    expect(away.local.seen()).not.toContain(CANARY);
    expect(await marks(away)).toEqual([true, false]);
  });

  it('any mark on the list keeps a later local turn here, not the goals mark alone', async () => {
    const other = (t: { context?: unknown }) => (t.context as { other?: boolean } | undefined)?.other === true;
    const list = STAY_MARKS as Array<typeof other>;
    list.push(other);
    try {
      const s = server({ frontier: claude, goals: answer([]), local: echoing(undefined, [{ say: T2 }]) });
      await storedTurn(s.store, { id: 'first', context: { other: true }, user: `a private thing ${CANARY}`, assistant: T1 });
      expect(s.store.windowHas('c1', keptHere)).toBe(true);
      await s.chat('local', 'what did I just say?');
      // The local model reads it; its own turn then stays here; Claude gets neither.
      expect(JSON.stringify(s.local.requests[0]!.messages)).toContain(CANARY);
      expect((await s.store.getTurns('c1')).map((t) => keptHere(t))).toEqual([true, true]);
      await s.chat('frontier', 'thanks');
      expect(s.tiers[0]!.seen()).not.toContain(CANARY);
    } finally {
      list.pop();
    }
  });
});

describe('the tools such a turn is offered', () => {
  const tool = (name: string): Tool => ({ definition: { name, description: name, inputSchema: { type: 'object', properties: {} }, idempotent: true }, handler: async () => ({ ok: true }) });
  const tools = [tool('trident.perplexity_search'), tool('web.web_search'), tool('remember')];
  const offered = (s: ReturnType<typeof server>, i: number) => (s.local.requests[i]!.tools ?? []).map((t) => t.name);

  it('no tool an outside AI answers, on the turn with the goals and on the turn that only read it', async () => {
    const s = server({ frontier: claude, tools, goalsTools: withoutOutsideAi({ specs: paidToolSpecs({}) }), local: echoing(4096) });
    expect((await s.chat('local', 'how are my goals going?')).goalsTokens).toBeGreaterThan(0);
    expect((await s.chat('local', `please summarize what you just told me about them ${'x'.repeat(14_000)}`)).goalsTokens).toBe(0);
    expect(offered(s, 0)).toEqual(['web.web_search', 'remember']);
    expect(offered(s, 1)).toEqual(['web.web_search', 'remember']);
  });

  it('with the block off as well: the turn that read a marked turn is still offered none, and a conversation with nothing marked is offered all', async () => {
    const s = server({ frontier: claude, tools, goalsTools: withoutOutsideAi({ specs: paidToolSpecs({}) }), goalsOn: false });
    await storedTurn(s.store, { id: 'first', context: GOALS_TURN, user: 'how are my goals going?', assistant: T1 });
    await s.chat('local', 'which goal did you mean?');
    expect(offered(s, 0)).toEqual(['web.web_search', 'remember']);
    await s.chat('local', 'hello', 'c2');
    expect(offered(s, 1)).toEqual(['trident.perplexity_search', 'web.web_search', 'remember']);
  });
});

describe('memory extraction over such a turn', () => {
  /** A scripted extraction model that keeps every prompt it is given. */
  const keeper = () => {
    const prompts: string[] = [];
    return { prompts, brain: { generate: async (i: { system: string; prompt: string }) => (prompts.push(i.prompt), { text: JSON.stringify({ facts: [] }) }) } };
  };
  const knowledge = () => new KnowledgeStore(join(dir, 'k.json'), { embed: async () => Promise.reject(new Error('down')) });

  it('a frontier extractor, wired as main() wires it, is sent neither turn’s words', async () => {
    const s = server({ frontier: claude, local: echoing(4096) });
    await s.chat('local', 'how are my goals going this month?');
    await s.chat('local', `please summarize what you just told me about them ${'x'.repeat(14_000)}`);
    await s.chat('frontier', 'my dentist is Dr Okafor on Elm Street, keep that in mind');
    const k = keeper();
    // As main(): the extractor's brain is the frontier's primary tier.
    const ex = new MemoryExtractor(s.store, knowledge(), k.brain, join(dir, 'state.json'), {
      kind: 'frontier',
      ...s.goalsChat.extractor({ brain: brainOf(s.tiers[0]!.provider, s.tiers[0]!.model), tainted: () => false }),
    });
    await ex.run();
    expect(ex.lastStats.skippedTainted).toBe(2);
    expect(k.prompts).toHaveLength(1);
    expect(k.prompts[0]).toContain('Dr Okafor');
    expect(k.prompts.join('\n')).not.toContain(CANARY);
    // ...and the turn after them is not shown them as "earlier in this conversation" either.
    expect(k.prompts[0]).not.toContain('earlier in this conversation');
  });

  it('the local extractor reads both, and what it learns from either is to be marked', async () => {
    const s = server({ frontier: claude, local: echoing(4096) });
    await s.chat('local', 'how are my goals going this month?');
    await s.chat('local', `please summarize what you just told me about them ${'x'.repeat(14_000)}`);
    const k = keeper();
    const hooks = s.goalsChat.extractor({ brain: { provider: 'ollama', model: 'qwen2.5:14b', baseURL: HERE }, tainted: () => false });
    const ex = new MemoryExtractor(s.store, knowledge(), k.brain, join(dir, 'state.json'), { kind: 'local', ...hooks });
    await ex.run();
    expect(ex.lastStats.skippedTainted).toBe(0);
    expect(k.prompts.join('\n')).toContain(CANARY);
    const ids = s.store.turnIds('c1');
    expect(ids.map((id) => hooks.carriedGoals('c1', id))).toEqual([true, true]);
    expect(ids.map((id) => hooks.isTainted('c1', id))).toEqual([false, false]);
  });

  it('the server’s own rule for a tainted turn is kept beside it, for any brain', async () => {
    const s = server({ frontier: claude, goals: answer([]) });
    await s.chat('frontier', 'my dentist is Dr Okafor on Elm Street, keep that in mind');
    const [id] = s.store.turnIds('c1') as [string];
    const asked: Array<[string, string]> = [];
    for (const brain of [brainOf(s.tiers[0]!.provider, s.tiers[0]!.model), { provider: 'ollama', model: 'qwen2.5:14b', baseURL: HERE }]) {
      const hooks = s.goalsChat.extractor({ brain, tainted: (cid, tid) => (asked.push([cid, tid]), tid === id) });
      expect(hooks.isTainted('c1', id), brain.provider).toBe(true);
      expect(hooks.isTainted('c1', 'another-turn'), brain.provider).toBe(false);
      expect(hooks.carriedGoals('c1', id), brain.provider).toBe(false);
    }
    expect(asked).toEqual([['c1', id], ['c1', 'another-turn'], ['c1', id], ['c1', 'another-turn']]);
  });
});
