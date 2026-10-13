/**
 * What Flint LEARNS from a turn Will kept on this Mac stays here too (the
 * final review's H1). Two ways a fact is learned from such a turn, and both
 * mark it (../src/knowledge `fromPrivate`), by the path the goals turns use:
 *
 *  - the model saves it itself (`remember`): a turn that stays here is offered
 *    the build that marks what it saves;
 *  - the memory extractor mines the turn later: it marks what it learns, and
 *    an extractor whose brain is not on this Mac never reads the turn at all
 *    (a frontier extractor, and the local kind when OLLAMA_HOST is another
 *    machine).
 *
 * A marked fact is recalled only for a brain on this Mac. An outside model's
 * own `remember` never reveals one, /generate never recalls one, and
 * FLINT_GOALS_TO_FRONTIER=on (which sends out the facts learned from Will's
 * goals) sends none of these.
 *
 * The canary tests run the server in miniature (./goals-mini): the real
 * conversation store, the real KnowledgeStore, the real MemoryExtractor with a
 * scripted model behind it, the real GoalsChat. No network. Synthetic text only.
 */
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Tool, Turn } from '@flint/core';
import { recallForAnyBrain, toolsKeptHere } from '../src/goals-chat';
import { GOALS_TURN } from '../src/goals-now';
import { recallContext } from '../src/grounding';
import { KnowledgeStore, rememberTool } from '../src/knowledge';
import { MemoryExtractor, type TurnSource } from '../src/memory-extract';
import { LOCALITY } from '../src/ollama-locality';
import { PRIVATE_TURN } from '../src/private-turns';
import { paidToolSpecs } from '../src/spend';
import { HERE, answer, cleanup, goal, listed, miniServer as server, storedTurn, type MiniOptions } from './goals-mini';

type Emb = ConstructorParameters<typeof KnowledgeStore>[1];
const downEmbedder: Emb = {
  embed: async () => {
    throw new Error('connect ECONNREFUSED 127.0.0.1:11434');
  },
};
/** A tiny deterministic "semantic" embedder: one dimension per keyword. */
const KEYS = ['clinic', 'codename', 'dentist', 'garage'];
const vec = (t: string): number[] => [...KEYS.map((k) => (t.toLowerCase().includes(k) ? 1 : 0)), 0.01];
const upEmbedder: Emb = { embed: async (texts: string[]) => texts.map(vec) };

const FACT_CANARY = 'CANARY-private-fact';
const PRIVATE_FACT = `Will's clinic appointment is at the Harbor clinic ${FACT_CANARY}.`;
const GOALS_FACT = 'Will’s cabin trip codename is Bluebird GOALS-FACT.';
const OPEN_FACT = 'Will’s dentist is Dr Okafor on Elm Street.';
const ASK = 'which clinic is my appointment at, what is the codename, and who is my dentist?';

const PRIVATE = { private: true, mode: 'cloud' } as const;
const LOCAL_MODE = { private: false, mode: 'local' } as const;
const ORDINARY = { private: false, mode: 'cloud' } as const;
const claude = [{ name: 'anthropic', model: 'claude-opus-5-5' }];

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flint-private-facts-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  cleanup();
});
const kpath = () => join(dir, 'knowledge.json');
const spath = () => join(dir, `extract-${Math.random()}.json`);
const call = (t: Tool, fact: string) => t.handler({ id: 'c', toolName: 'remember', args: { fact } });
const marks = (k: KnowledgeStore) => k.all().map((f) => [f.text, f.fromGoals ?? false, f.fromPrivate ?? false]);

/** Three facts: one from a private turn, one from a goals turn, one ordinary. */
async function seeded(embedder: Emb = downEmbedder, path = kpath()): Promise<KnowledgeStore> {
  const k = new KnowledgeStore(path, embedder);
  await k.add(PRIVATE_FACT, 'history', { fromPrivate: true });
  await k.add(GOALS_FACT, 'history', { fromGoals: true });
  await k.add(OPEN_FACT, 'history');
  return k;
}

describe('the mark on a fact', () => {
  it('is one optional field beside the goals mark; a fact can carry both, and every other fact is stored as before', async () => {
    const k = await seeded();
    await k.add('Will’s garage code is in the blue notebook.', 'history', { fromGoals: true, fromPrivate: true });
    const stored = (JSON.parse(readFileSync(kpath(), 'utf8')) as { facts: Array<Record<string, unknown>> }).facts;
    expect(stored.map((f) => [f.fromGoals, f.fromPrivate])).toEqual([[undefined, true], [true, undefined], [undefined, undefined], [true, true]]);
    expect(Object.keys(stored[2]!).sort()).toEqual(['id', 'source', 'text', 'ts', 'vector']);
    // It is on the fact Will can read in his own console, and it survives a restart.
    expect(new KnowledgeStore(kpath(), downEmbedder).all().map((f) => f.fromPrivate ?? false)).toEqual([true, false, false, true]);
  });
});

describe('recall: three views of one memory', () => {
  for (const [name, embedder] of [['by words (the embedder is down)', downEmbedder], ['by meaning', upEmbedder]] as const) {
    it(`${name}: a brain on this Mac gets all of it; one off it gets neither marked fact; FLINT_GOALS_TO_FRONTIER lifts the goals fact and never the private one`, async () => {
      const k = await seeded(embedder);
      const r = await k.recallWithMode(ASK);
      expect([...r.facts].sort()).toEqual([PRIVATE_FACT, GOALS_FACT, OPEN_FACT].sort());
      expect(r.outside).toEqual([OPEN_FACT]);
      expect([...r.lifted].sort()).toEqual([GOALS_FACT, OPEN_FACT].sort());
    });
  }

  it('with no private fact, the lifted view is the very same list; with nothing marked, all three are', async () => {
    const k = new KnowledgeStore(kpath(), downEmbedder);
    await k.add(GOALS_FACT, 'history', { fromGoals: true });
    await k.add(OPEN_FACT, 'history');
    const r = await k.recallWithMode(ASK);
    expect(r.lifted).toBe(r.facts);
    expect(r.outside).not.toBe(r.facts);
    const plain = new KnowledgeStore(join(dir, 'plain.json'), downEmbedder);
    await plain.add(OPEN_FACT, 'history');
    const p = await plain.recallWithMode(ASK);
    expect(p.outside).toBe(p.facts);
    expect(p.lifted).toBe(p.facts);
  });

  it('recallContext builds all three blocks, and /generate (no per-ask gate) is given the one any brain may have', async () => {
    const k = await seeded();
    const r = await recallContext('[base]', ASK, k);
    expect(r.block).toContain(FACT_CANARY);
    expect(r.lifted.block).not.toContain(FACT_CANARY);
    expect(r.lifted.block).toContain('GOALS-FACT');
    expect(r.outside.block).not.toContain(FACT_CANARY);
    expect(r.outside.block).not.toContain('GOALS-FACT');
    expect(r.outside.block).toContain('Dr Okafor');
    const oneShot = recallForAnyBrain(r);
    expect(oneShot.block).toBe(r.outside.block);
    expect(oneShot.facts).toEqual([OPEN_FACT]);
  });

  it('a private fact is sent to the embedder only when the embedder is here, like a goals fact', async () => {
    const sent: string[] = [];
    const spy: Emb = { embed: async (texts: string[]) => (sent.push(...texts), texts.map(vec)) };
    const away = new KnowledgeStore(kpath(), spy, undefined, undefined, { embedderHere: () => false });
    await away.add(PRIVATE_FACT, 'history', { fromPrivate: true });
    await away.add(OPEN_FACT, 'history');
    expect(sent).toEqual([OPEN_FACT]);
    // It is still recalled, by its words, for a brain on this Mac.
    expect((await away.recallWithMode('which clinic is my appointment at?')).facts).toContain(PRIVATE_FACT);
    expect(sent.join('\n')).not.toContain(FACT_CANARY);
    const hereToo = new KnowledgeStore(join(dir, 'here.json'), spy, undefined, undefined, { embedderHere: () => true });
    await hereToo.add(PRIVATE_FACT, 'history', { fromPrivate: true });
    expect(sent).toContain(PRIVATE_FACT);
  });
});

describe('`remember`: the build a turn that stays here is offered, and the one any brain may call', () => {
  it('the kept build saves under the marks of its turn: private, the goals, or both; all are one tool to the model', async () => {
    const k = new KnowledgeStore(kpath(), downEmbedder);
    const standard = rememberTool(k);
    const kept = toolsKeptHere({ search: [], knowledge: k, specs: paidToolSpecs({}) });
    const pick = (marks?: { goals?: boolean; private?: boolean }) => kept([standard], marks)[0]!;
    expect(pick({ private: true }).definition).toEqual(standard.definition);
    await call(standard, OPEN_FACT);
    await call(pick({ private: true }), PRIVATE_FACT);
    await call(pick(), GOALS_FACT);
    await call(pick({ goals: true, private: true }), 'Will’s garage code is in the blue notebook.');
    expect(marks(k)).toEqual([
      [OPEN_FACT, false, false],
      [PRIVATE_FACT, false, true],
      [GOALS_FACT, true, false],
      ['Will’s garage code is in the blue notebook.', true, true],
    ]);
  });

  it('an outside model’s `remember` never reveals a private fact: its very words get "saved", as if it were not there', async () => {
    const k = await seeded();
    const said = (await call(rememberTool(k), PRIVATE_FACT)) as { remembered: boolean; note: string };
    expect(said).toMatchObject({ ok: true, remembered: true, note: 'saved' });
    // (The same words from a source that is not held here are no longer something only this Mac holds.)
    expect(k.all().find((f) => f.text === PRIVATE_FACT)!.fromPrivate).toBeUndefined();
  });

  it('nor does a close rewording get "already known": the private fact is not counted, and stays marked', async () => {
    const k = await seeded();
    const reworded = PRIVATE_FACT.replace('is at the', 'is at');
    expect(await call(rememberTool(k), reworded)).toMatchObject({ remembered: true, note: 'saved' });
    expect(k.all().filter((f) => f.fromPrivate)).toHaveLength(1);
    expect(k.all().find((f) => f.text === PRIVATE_FACT)!.fromPrivate).toBe(true);
  });

  it('a turn that only carries Will’s goals does not learn of one either; a private turn knows every fact', async () => {
    const k = await seeded();
    // The goals build (FLINT_GOALS_TO_FRONTIER could hand it to an outside brain): the private fact is not there for it.
    expect(await call(rememberTool(k, { fromGoals: true }), PRIVATE_FACT)).toMatchObject({ remembered: true, note: 'saved' });
    expect(k.all().find((f) => f.text === PRIVATE_FACT)).toMatchObject({ fromGoals: true });
    expect(k.all().find((f) => f.text === PRIVATE_FACT)!.fromPrivate).toBeUndefined();
    // The private build is told "already known" for a goals fact, an ordinary one, and a private one.
    const again = await seeded(downEmbedder, join(dir, 'again.json'));
    for (const fact of [PRIVATE_FACT, GOALS_FACT, OPEN_FACT]) expect(await call(rememberTool(again, { fromPrivate: true }), fact), fact).toMatchObject({ remembered: false, note: 'already known' });
    expect(marks(again)).toEqual([[PRIVATE_FACT, false, true], [GOALS_FACT, true, false], [OPEN_FACT, false, false]]);
  });
});

let tick = 1_790_000_000_000;
function turn(cid: string, user: string, assistant = 'ok'): Turn {
  tick += 60_000;
  return {
    id: `t${tick}`, conversationId: cid, status: 'complete',
    messages: [{ id: `u${tick}`, role: 'user', content: user, timestamp: tick }, { id: `a${tick}`, role: 'assistant', content: assistant, timestamp: tick }],
    createdAt: tick, updatedAt: tick,
  };
}
const source = (convs: Record<string, Turn[]>): TurnSource => ({ conversationIds: () => Object.keys(convs), getTurns: async (cid) => structuredClone(convs[cid] ?? []) });
const SAY_PRIVATE = `Keep this private: my clinic appointment is at the Harbor clinic ${FACT_CANARY}, keep that in mind`;
const SAY_GOALS = 'How are my goals going? Also my cabin trip codename is Bluebird GOALS-FACT, keep that in mind';
const SAY_OPEN = 'My dentist is Dr Okafor on Elm Street, keep that in mind';
/** A scripted extraction model: it keeps every prompt, and answers each call with the facts its turns hold. */
function curator() {
  const prompts: string[] = [];
  const known: Array<{ has: string; fact: string; quote: string }> = [
    { has: 'Harbor clinic', fact: PRIVATE_FACT, quote: 'my clinic appointment is at the Harbor clinic' },
    { has: 'codename is Bluebird', fact: GOALS_FACT, quote: 'my cabin trip codename is Bluebird' },
    { has: 'dentist is Dr Okafor', fact: OPEN_FACT, quote: 'My dentist is Dr Okafor on Elm Street' },
  ];
  return {
    prompts,
    brain: {
      generate: async (i: { system: string; prompt: string }) => {
        prompts.push(i.prompt);
        const turns = i.prompt.split('TURNS:')[1] ?? '';
        const facts = known.filter((f) => turns.includes(f.has)).map((f) => ({ fact: f.fact, quote: f.quote, turn: Number(/### Turn (\d+)[^#]*$/.exec(turns.slice(0, turns.indexOf(f.has)))?.[1] ?? 1) }));
        return { text: JSON.stringify({ facts }) };
      },
    },
  };
}

describe('memory extraction: what is learned from a turn Will kept private is marked', () => {
  it('a fact from a private turn is marked private; from a goals turn, with the goals mark; from a turn that is both, with both', async () => {
    const priv = turn('c1', SAY_PRIVATE);
    const goals = turn('c2', SAY_GOALS);
    const plain = turn('c3', SAY_OPEN);
    const k = new KnowledgeStore(kpath(), downEmbedder);
    const c = curator();
    await new MemoryExtractor(source({ c1: [priv], c2: [goals], c3: [plain] }), k, c.brain, spath(), {
      carriedGoals: (_cid, tid) => tid === goals.id,
      keptPrivate: (_cid, tid) => tid === priv.id,
    }).run();
    expect(marks(k)).toEqual([[PRIVATE_FACT, false, true], [GOALS_FACT, true, false], [OPEN_FACT, false, false]]);
    // One call per kind of turn: no prompt holds two kinds, so no fact is learned across them.
    expect(c.prompts).toHaveLength(3);
    expect(c.prompts.filter((p) => (p.split('TURNS:')[1] ?? '').includes(FACT_CANARY))).toHaveLength(1);
    const both = new KnowledgeStore(join(dir, 'both.json'), downEmbedder);
    const t = turn('c9', SAY_PRIVATE);
    await new MemoryExtractor(source({ c9: [t] }), both, curator().brain, spath(), { carriedGoals: () => true, keptPrivate: () => true }).run();
    expect(marks(both)).toEqual([[PRIVATE_FACT, true, true]]);
  });

  it('a turn shown with an earlier private turn as its context is marked too: that turn’s words are in the call', async () => {
    const first = turn('c1', SAY_PRIVATE);
    const second = turn('c1', SAY_OPEN);
    const k = new KnowledgeStore(kpath(), downEmbedder);
    await new MemoryExtractor(source({ c1: [first, second] }), k, curator().brain, spath(), { keptPrivate: (_cid, tid) => tid === first.id }).run();
    expect(k.all().map((f) => f.fromPrivate ?? false)).toEqual([true, true]);
  });

  it('the known facts are shown to a call held at least as closely: a private one only to a call about private turns', async () => {
    const k = await seeded();
    const priv = turn('c1', 'Keep this private: what should I ask at my next clinic appointment, and what should I bring to it?');
    const goals = turn('c2', 'How are my goals going this month, and what should I do next about them?');
    const plain = turn('c3', 'What is a good way to remember where I put the spare garage remote?');
    const c = curator();
    await new MemoryExtractor(source({ c1: [priv], c2: [goals], c3: [plain] }), k, c.brain, spath(), {
      carriedGoals: (_cid, tid) => tid === goals.id,
      keptPrivate: (_cid, tid) => tid === priv.id,
    }).run();
    const [forPrivate, forGoals, forPlain] = c.prompts.map((p) => p.split('TURNS:')[0]!) as [string, string, string];
    expect([forPrivate.includes(FACT_CANARY), forPrivate.includes('GOALS-FACT'), forPrivate.includes('Dr Okafor')]).toEqual([true, true, true]);
    expect([forGoals.includes(FACT_CANARY), forGoals.includes('GOALS-FACT'), forGoals.includes('Dr Okafor')]).toEqual([false, true, true]);
    expect([forPlain.includes(FACT_CANARY), forPlain.includes('GOALS-FACT'), forPlain.includes('Dr Okafor')]).toEqual([false, false, true]);
  });
});

describe('the extractor’s brain, as main() names it (../src/goals-chat extractor)', () => {
  const frontier = { provider: 'anthropic', model: 'claude-opus-5-5' };
  const localHere = { provider: 'ollama', model: 'qwen2.5:14b', baseURL: HERE };
  /** The LOCAL kind of extractor with OLLAMA_HOST on another machine: a local wire, and not this Mac. */
  const localAway = { provider: 'ollama', model: 'qwen2.5:14b', baseURL: 'http://gpu-box.lan:11434' };

  async function passOn(brain: { provider: string; model: string; baseURL?: string } | undefined, o: Partial<MiniOptions> = {}) {
    const s = server({ frontier: claude, goals: answer([]), goalsOn: false, ...o });
    await storedTurn(s.store, { conversationId: 'c1', id: 'p', context: PRIVATE_TURN, user: SAY_PRIVATE, assistant: 'noted' });
    await storedTurn(s.store, { conversationId: 'c1', id: 'after', user: SAY_OPEN, assistant: 'noted' });
    await storedTurn(s.store, { conversationId: 'c2', id: 'g', context: GOALS_TURN, user: SAY_GOALS, assistant: 'noted' });
    const k = new KnowledgeStore(kpath(), downEmbedder);
    const c = curator();
    const ex = new MemoryExtractor(s.store, k, c.brain, spath(), { kind: brain?.provider === 'ollama' ? 'local' : 'frontier', ...s.goalsChat.extractor({ brain, tainted: () => false }) });
    await ex.run();
    return { k, prompts: c.prompts.join('\n'), skipped: ex.lastStats.skippedTainted };
  }

  it('on the local model on this Mac: it reads the private turn, and what it learns is marked private', async () => {
    const r = await passOn(localHere);
    expect(r.skipped).toBe(0);
    expect(r.prompts).toContain(FACT_CANARY);
    // The plain turn after it was shown the private one as "earlier in this conversation", so it is marked too.
    expect(marks(r.k)).toEqual([[PRIVATE_FACT, false, true], [OPEN_FACT, false, true], [GOALS_FACT, true, false]]);
  });

  it('on the frontier: it is never sent the private turn, as a turn or as the next one’s context', async () => {
    const r = await passOn(frontier);
    expect(r.skipped).toBe(2); // the private turn and the goals turn
    expect(r.prompts).not.toContain(FACT_CANARY);
    expect(r.prompts).not.toContain('Harbor clinic');
    expect(marks(r.k)).toEqual([[OPEN_FACT, false, false]]);
  });

  it('on the LOCAL kind with OLLAMA_HOST on another machine: the same, it reads no turn that stays here', async () => {
    const r = await passOn(localAway);
    expect(r.skipped).toBe(2);
    expect(r.prompts).not.toContain(FACT_CANARY);
    expect(r.prompts).not.toContain('Bluebird');
    expect(marks(r.k)).toEqual([[OPEN_FACT, false, false]]);
  });

  it('a brain nobody can name reads none either, and a model its Ollama does not list is not on this Mac', async () => {
    expect((await passOn(undefined)).prompts).not.toContain(FACT_CANARY);
    // A model the listing does not hold is not known to run here: the pass waits for it, and reads nothing meanwhile.
    const unlisted = await passOn({ ...localHere, model: 'never-pulled' });
    expect(unlisted.prompts).toBe('');
  });

  // A turn that is skipped is never mined: the pass moves on past it. So "this brain may not read it" has to be a
  // settled answer, and while it is not (Ollama restarting, the first minute after a reboot) the pass waits.
  it('while where its own model runs is not known, the pass waits and skips nothing; once Ollama has said, it mines the private turn', async () => {
    const s = server({ frontier: claude, goals: answer([]), goalsOn: false });
    await storedTurn(s.store, { conversationId: 'c1', id: 'p', context: PRIVATE_TURN, user: SAY_PRIVATE, assistant: 'noted' });
    await storedTurn(s.store, { conversationId: 'c2', id: 'o', user: SAY_OPEN, assistant: 'noted' });
    const k = new KnowledgeStore(kpath(), downEmbedder);
    const c = curator();
    const rules = s.goalsChat.extractor({ brain: localHere, tainted: () => false });
    const ex = new MemoryExtractor(s.store, k, c.brain, spath(), { kind: 'local', ...rules });
    // Ollama has not been heard from (as after five minutes of silence, or before its first answer).
    LOCALITY.clear();
    expect(rules.holdOff()).toBe('the model server has not said that the memory model runs on this Mac');
    expect(await ex.run()).toBe(0);
    expect(await ex.run()).toBe(0);
    expect(c.prompts).toEqual([]); // nothing was read, the ordinary turn included
    expect(ex.lastStats.skippedTainted).toBe(0);
    expect(k.all()).toEqual([]);
    expect(ex.nextDelayMs).toBe(90_000); // it comes back as soon as a first pass would, not at the next six-hourly one
    // It answers: the same extractor now reads both turns, and the private one's fact is marked.
    listed(HERE, ['qwen2.5:14b']);
    expect(rules.holdOff()).toBeUndefined();
    expect(await ex.run()).toBe(2);
    expect(marks(k)).toEqual([[PRIVATE_FACT, false, true], [OPEN_FACT, false, false]]);
  });

  it('a brain that can never read such a turn is not waited for: the frontier, an Ollama elsewhere, a cloud model under a plain name', async () => {
    const s = server({ frontier: claude, goals: answer([]), goalsOn: false, listings: { [HERE]: ['qwen2.5:14b', { name: 'mine', remote_host: 'https://ollama.com:443' }] } });
    for (const brain of [frontier, localAway, { ...localHere, model: 'mine' }, undefined]) {
      expect(s.goalsChat.extractor({ brain, tainted: () => false }).holdOff(), JSON.stringify(brain)).toBeUndefined();
    }
    // ...and a model on this Mac that its Ollama lists is not waited for either.
    expect(s.goalsChat.extractor({ brain: localHere, tainted: () => false }).holdOff()).toBeUndefined();
  });

  it('FLINT_GOALS_TO_FRONTIER=on hands a frontier extractor the goals turn, and still not the private one', async () => {
    const r = await passOn(frontier, { toFrontier: true });
    expect(r.skipped).toBe(1);
    expect(r.prompts).toContain('Bluebird');
    expect(r.prompts).not.toContain(FACT_CANARY);
    expect(marks(r.k)).toEqual([[OPEN_FACT, false, false], [GOALS_FACT, true, false]]);
  });
});

describe('the canary: a fact learned on a turn that stays here, then other turns', () => {
  /** A server with long-term memory, the real kept tools, and one pass of local memory extraction over what it stored. */
  function withMemory(o: Partial<MiniOptions> = {}) {
    const knowledge = o.knowledge ?? new KnowledgeStore(kpath(), downEmbedder);
    const standard = rememberTool(knowledge);
    const s = server({ frontier: claude, goals: answer([]), goalsOn: false, tools: [standard], goalsTools: toolsKeptHere({ search: [], knowledge, specs: paidToolSpecs({}) }), ...o, knowledge });
    const c = curator();
    const extract = () => new MemoryExtractor(s.store, knowledge, c.brain, spath(), { kind: 'local', ...s.goalsChat.extractor({ brain: { provider: 'ollama', model: 'qwen2.5:14b', baseURL: HERE }, tainted: () => false }) }).run();
    return { ...s, knowledge, standard, extract };
  }
  const cloudSaw = (s: ReturnType<typeof withMemory>) => s.tiers.map((t) => t.seen()).join('\n');

  for (const [name, route] of [['a private turn', PRIVATE], ['a turn taken in Local mode', LOCAL_MODE]] as const) {
    it(`the extractor path: learned from ${name}, the fact is marked, and a cloud turn that would recall it never holds it`, async () => {
      const s = withMemory();
      await s.chat('local', SAY_PRIVATE, 'c1', route);
      expect(await s.extract()).toBe(1);
      expect(marks(s.knowledge)).toEqual([[PRIVATE_FACT, false, true]]);
      // Another conversation, a cloud turn, about that very fact.
      await s.chat('frontier', 'which clinic is my appointment at?', 'c2', ORDINARY);
      expect(s.tiers[0]!.requests).toHaveLength(1);
      expect(cloudSaw(s)).not.toContain(FACT_CANARY);
      expect(cloudSaw(s)).not.toContain('Harbor clinic');
      // The local model, asked the same, is given it, and that turn is then kept private too.
      const told = await s.chat('local', 'which clinic is my appointment at?', 'c3', ORDINARY);
      expect(JSON.stringify(s.local.requests.at(-1))).toContain(PRIVATE_FACT);
      expect(told.asks.at(-1)!.mark).toEqual(PRIVATE_TURN);
      expect(told.metas).toMatchObject([{ staysHere: true }]);
    });

    it(`the remember path: what the model saves on ${name} is marked, by the build that turn is offered`, async () => {
      const s = withMemory();
      const r = await s.chat('local', SAY_PRIVATE, 'c1', route);
      // One tool to the model, and not the standard build: what it saves stays here.
      const offered = r.asks.at(-1)!.offered;
      expect(offered.map((t) => t.definition.name)).toEqual(['remember']);
      expect(offered[0]).not.toBe(s.standard);
      await call(offered[0]!, PRIVATE_FACT);
      expect(marks(s.knowledge)).toEqual([[PRIVATE_FACT, false, true]]);
      await s.chat('frontier', 'which clinic is my appointment at?', 'c2', ORDINARY);
      expect(cloudSaw(s)).not.toContain(FACT_CANARY);
      // An ordinary turn is offered the standard build, as before.
      const open = await s.chat('frontier', 'thanks', 'c4', ORDINARY);
      expect(open.asks.at(-1)!.offered[0]).toBe(s.standard);
    });
  }

  it('FLINT_GOALS_TO_FRONTIER=on sends the cloud the fact learned from Will’s goals, and never the private one', async () => {
    const knowledge = await seeded();
    const s = withMemory({ knowledge, toFrontier: true });
    await s.chat('frontier', ASK, 'c1', ORDINARY);
    const sent = cloudSaw(s);
    expect(sent).toContain('GOALS-FACT');
    expect(sent).toContain('Dr Okafor');
    expect(sent).not.toContain(FACT_CANARY);
    // With it off, the cloud gets neither marked fact.
    const off = withMemory({ knowledge });
    await off.chat('frontier', ASK, 'c2', ORDINARY);
    expect(cloudSaw(off)).toContain('Dr Okafor');
    expect(cloudSaw(off)).not.toContain('GOALS-FACT');
    expect(cloudSaw(off)).not.toContain(FACT_CANARY);
  });

  it('a turn that is both (Will’s goals in its context, on a route that keeps it here) saves under both marks', async () => {
    const s = withMemory({ goals: answer([goal(1)]), goalsOn: true });
    const r = await s.chat('local', SAY_PRIVATE, 'c1', PRIVATE);
    expect(r.asks.at(-1)!.mark).toEqual({ goals: true, private: true });
    await call(r.asks.at(-1)!.offered[0]!, PRIVATE_FACT);
    expect(marks(s.knowledge)).toEqual([[PRIVATE_FACT, true, true]]);
  });

  it('/generate has no gate and stores no turn: on a route that stays here its tools are the kept ones, so what it saves is marked', async () => {
    const s = withMemory();
    // Before any brain is named there are no builds: then nothing that saves is offered.
    for (const route of [PRIVATE, LOCAL_MODE]) {
      const tools = s.goalsChat.oneShotTools(route, [s.standard]);
      expect(tools).toHaveLength(1);
      expect(tools[0]).not.toBe(s.standard);
      await call(tools[0]!, `${PRIVATE_FACT} (${route.mode})`);
    }
    expect(s.knowledge.all().map((f) => f.fromPrivate ?? false)).toEqual([true, true]);
    // An ordinary one-shot answer: the same tools, untouched.
    const same = [s.standard];
    expect(s.goalsChat.oneShotTools(ORDINARY, same)).toBe(same);
  });
});
