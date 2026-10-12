/**
 * What Flint LEARNS from a turn answered with Will's goals stays on this Mac
 * (P3 part 4). A fact taken from such a turn for long-term memory carries a
 * mark, and:
 *
 *  - it is recalled only for a brain that may read his goals: one on this Mac,
 *    asked as a local model's turn. A brain anywhere else gets the same recall
 *    without it. Recall for a local brain is what it was;
 *  - an ask that is given such a fact is treated as one that was given the
 *    goals, whether or not the goals block is on: no tool an outside AI
 *    answers, and its turn marked, so the answer never goes back out as
 *    history and what is learned from it is marked too;
 *  - FLINT_GOALS_TO_FRONTIER=on lifts it; a fact with no mark (every fact
 *    stored before the mark existed) behaves as before.
 *
 * The canary tests run the server in miniature (./goals-mini): the real
 * conversation store, the real KnowledgeStore, the real MemoryExtractor with a
 * scripted local model behind it, and /chat's own wiring. No network.
 * Synthetic text only.
 */
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Tool, Turn } from '@flint/core';
import { embedderHere } from '../src/goals-chat';
import { carriedGoals } from '../src/goals-now';
import { withoutOutsideAi } from '../src/goals-tools';
import { contextOutside, recallContext } from '../src/grounding';
import { KnowledgeStore, rememberTool } from '../src/knowledge';
import { MemoryExtractor, type TurnSource } from '../src/memory-extract';
import { paidToolSpecs } from '../src/spend';
import { asLocalTurn } from '../src/turn-taint';
import { HERE, answer, cleanup, miniServer as server, type MiniOptions, type Step } from './goals-mini';

type Emb = ConstructorParameters<typeof KnowledgeStore>[1];
const downEmbedder: Emb = {
  embed: async () => {
    throw new Error('connect ECONNREFUSED 127.0.0.1:11434');
  },
};
/** A tiny deterministic "semantic" embedder: one dimension per keyword. */
const KEYS = ['cabin', 'codename', 'dentist', 'coffee', 'sister', 'garage'];
const vec = (t: string): number[] => [...KEYS.map((k) => (t.toLowerCase().includes(k) ? 1 : 0)), 0.01];
const upEmbedder: Emb = { embed: async (texts: string[]) => texts.map(vec) };

const FACT_CANARY = 'CANARY-p3facts';
const SECRET = `Will's cabin trip codename is Bluebird ${FACT_CANARY}.`;
const OPEN = 'Will’s dentist is Dr Okafor on Elm Street.';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flint-goal-facts-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  cleanup();
});
const kpath = () => join(dir, 'knowledge.json');

describe('the mark on a fact', () => {
  it('is one optional field, set only when the fact was learned from a goals turn; every other fact is stored exactly as before', async () => {
    const k = new KnowledgeStore(kpath(), downEmbedder);
    await k.add(OPEN, 'history', { conversationId: 'c1', sourceAt: 5 });
    await k.add(SECRET, 'history', { conversationId: 'c2', sourceAt: 6, fromGoals: true });
    await k.add('Will’s sister is named Kate.', 'history', { fromGoals: false });
    const stored = (JSON.parse(readFileSync(kpath(), 'utf8')) as { facts: Array<Record<string, unknown>> }).facts;
    expect(stored.map((f) => f.fromGoals)).toEqual([undefined, true, undefined]);
    expect(Object.keys(stored[0]!).sort()).toEqual(['conversationId', 'id', 'source', 'sourceAt', 'text', 'ts', 'vector']);
    // It is on the fact Will can read in his own console, and it survives a restart.
    const again = new KnowledgeStore(kpath(), downEmbedder);
    expect(again.all().map((f) => f.fromGoals ?? false)).toEqual([false, true, false]);
  });

  it('a store written before the mark existed loads as it was: nothing is held back from anyone', async () => {
    writeFileSync(kpath(), JSON.stringify({ seq: 2, facts: [{ id: 'k1', text: SECRET, source: 'history', ts: 1, vector: [] }, { id: 'k2', text: OPEN, source: 'user', ts: 2, vector: [] }], rejected: [] }));
    const k = new KnowledgeStore(kpath(), downEmbedder);
    const r = await k.recallWithMode('what is my cabin trip codename?');
    expect(r.facts).toEqual([SECRET]);
    expect(r.outside).toBe(r.facts);
  });
});

describe('recall, for a brain on this Mac and for one that is not', () => {
  async function filled(embedder: Emb) {
    // The embedder is on this Mac, so a fact that stays here may be embedded.
    const k = new KnowledgeStore(kpath(), embedder, undefined, undefined, { embedderHere: () => true });
    await k.add(SECRET, 'history', { fromGoals: true });
    await k.add('Will’s cabin trip is in the spring.', 'history');
    await k.add(OPEN, 'history');
    return k;
  }

  it('by meaning: the marked fact is in the local recall and not in the outside one, where the next most relevant takes its place', async () => {
    const k = await filled(upEmbedder);
    const r = await k.recallWithMode('what is my cabin trip codename?', 1);
    expect(r.mode).toBe('semantic');
    expect(r.facts).toEqual([SECRET]);
    expect(r.outside).toEqual(['Will’s cabin trip is in the spring.']);
    expect(r.outside.join(' ')).not.toContain(FACT_CANARY);
  });

  it('by words, when the embedder is down: the same', async () => {
    const k = await filled(downEmbedder);
    const r = await k.recallWithMode('what is my cabin trip codename?');
    expect(r.mode).toBe('lexical');
    expect(r.facts).toContain(SECRET);
    expect(r.outside).toEqual(['Will’s cabin trip is in the spring.']);
  });

  it('a fact stored while the embedder was down (no vector yet) is held back the same way', async () => {
    const k = new KnowledgeStore(kpath(), downEmbedder);
    await k.add(SECRET, 'history', { fromGoals: true });
    await k.add(OPEN, 'history');
    // The embedder comes back for the query; the stored facts still have no vector.
    const up = new KnowledgeStore(kpath(), { embed: async (texts: string[]) => (texts.length === 1 && texts[0]!.startsWith('what') ? texts.map(vec) : Promise.reject(new Error('down'))) });
    const r = await up.recallWithMode('what is my cabin trip codename?');
    expect(r.facts).toEqual([SECRET]);
    expect(r.outside).toEqual([]);
  });

  it('with nothing marked among what was recalled, both are the very same list', async () => {
    const k = await filled(downEmbedder);
    const r = await k.recallWithMode('who is my dentist on Elm Street?');
    expect(r.facts).toEqual([OPEN]);
    expect(r.outside).toEqual(r.facts);
    // recall() itself is unchanged: the local view.
    expect(await k.recall('what is my cabin trip codename?')).toContain(SECRET);
  });

  it('recallContext builds both blocks; contextOutside swaps one for the other and keeps what followed', async () => {
    const k = await filled(downEmbedder);
    const r = await recallContext('[Context]', 'what is my cabin trip codename?', k);
    expect(r.block).toContain(FACT_CANARY);
    expect(r.outside.block).not.toContain(FACT_CANARY);
    expect(r.outside.block).toContain('cabin trip is in the spring');
    expect(r.outside.facts).toEqual(['Will’s cabin trip is in the spring.']);
    // The frontier's context is the block and World now after it.
    expect(contextOutside(`${r.block}\n\nWORLD`, r.block, r.outside.block)).toBe(`${r.outside.block}\n\nWORLD`);
    expect(contextOutside(r.block, r.block, r.outside.block)).toBe(r.outside.block);
    // A context that is not this turn's gets the outside block alone: never the whole one.
    expect(contextOutside('something else', r.block, r.outside.block)).toBe(r.outside.block);
    // Nothing held back: the same objects, and the context is left as it is.
    const plain = await recallContext('[Context]', 'who is my dentist on Elm Street?', k);
    expect(plain.outside.block).toBe(plain.block);
    expect(plain.outside.facts).toBe(plain.facts);
    expect(contextOutside(`${plain.block}\n\nWORLD`, plain.block, plain.outside.block)).toBe(`${plain.block}\n\nWORLD`);
    // Recall that fails, or is skipped, holds nothing for anyone.
    const failed = await recallContext('[Context]', 'x', { recall: async () => [], recallWithMode: async () => Promise.reject(new Error('boom')) });
    expect(failed).toMatchObject({ block: '[Context]', facts: [], mode: 'error', outside: { block: '[Context]', facts: [] } });
    expect((await recallContext('[Context]', 'what is my cabin trip codename?', k, { skip: true })).outside.block).toBe('[Context]');
  });
});

describe('the `remember` tool an ask that carries the goals is offered', () => {
  it('saves what it is told as a fact that stays here; the standard one saves an ordinary fact; they are one tool to the model', async () => {
    const k = new KnowledgeStore(kpath(), downEmbedder);
    const standard = rememberTool(k);
    const local = rememberTool(k, { fromGoals: true });
    expect(local.definition).toEqual(standard.definition);
    const call = (t: Tool, fact: string) => t.handler({ id: 'c', toolName: 'remember', args: { fact } });
    await call(standard, OPEN);
    await call(local, SECRET);
    expect(k.all().map((f) => [f.text, f.fromGoals ?? false])).toEqual([[OPEN, false], [SECRET, true]]);
    // The swap is by name, like deep_research's: the ask that carries the goals gets the local build.
    const swap = withoutOutsideAi({ specs: paidToolSpecs({}), local: [local] });
    expect(swap([standard])[0]).toBe(local);
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
/** A scripted extraction model: it keeps every prompt, and answers each call with the facts its turns hold. */
function curator() {
  const prompts: string[] = [];
  const known: Array<{ has: string; fact: string; quote: string }> = [
    { has: 'codename is Bluebird', fact: SECRET, quote: 'my cabin trip codename is Bluebird' },
    { has: 'dentist is Dr Okafor', fact: OPEN, quote: 'My dentist is Dr Okafor on Elm Street' },
    { has: 'garage door code', fact: 'Will keeps his garage door code in the blue notebook.', quote: 'I keep my garage door code in the blue notebook' },
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
const SAY_SECRET = `How are my goals going? Also my cabin trip codename is Bluebird ${FACT_CANARY}, keep that in mind`;
const SAY_OPEN = 'My dentist is Dr Okafor on Elm Street, keep that in mind';
const SAY_GARAGE = 'I keep my garage door code in the blue notebook, keep that in mind';

describe('memory extraction: what is learned from a goals turn is marked', () => {
  const spath = () => join(dir, 'extract-state.json');

  it('a fact from a turn that carried the goals is marked; one from any other turn is not', async () => {
    const goalsTurn = turn('c1', SAY_SECRET);
    const plain = turn('c2', SAY_OPEN);
    const k = new KnowledgeStore(kpath(), downEmbedder);
    const c = curator();
    await new MemoryExtractor(source({ c1: [goalsTurn], c2: [plain] }), k, c.brain, spath(), { carriedGoals: (_cid, tid) => tid === goalsTurn.id }).run();
    expect(k.all().map((f) => [f.text, f.conversationId, f.fromGoals ?? false])).toEqual([[SECRET, 'c1', true], [OPEN, 'c2', false]]);
  });

  it('a call is all goals turns or none: the two never share a prompt, so no fact can be learned across them', async () => {
    const turns = { c1: [turn('c1', SAY_OPEN)], c2: [turn('c2', SAY_SECRET)], c3: [turn('c3', SAY_GARAGE)], c4: [turn('c4', 'I also keep a spare cabin key under the mat, keep that in mind')] };
    const marked = new Set([turns.c2[0]!.id]);
    const c = curator();
    await new MemoryExtractor(source(turns), new KnowledgeStore(kpath(), downEmbedder), c.brain, spath(), { carriedGoals: (_cid, tid) => marked.has(tid) }).run();
    const withCanary = c.prompts.filter((p) => p.includes(FACT_CANARY));
    expect(c.prompts).toHaveLength(3); // the ordinary turn before it, the goals turn alone, the two ordinary turns after it together
    expect(withCanary).toHaveLength(1);
    // Its turns are the goals turn alone (the facts already known are a goals call's to see, the dentist's among them).
    expect(withCanary[0]!.split('TURNS:')[1]).not.toMatch(/dentist|garage|spare cabin key/);
    expect(withCanary[0]!.split('TURNS:')[1]!.match(/### Turn/g)).toHaveLength(1);
    expect(c.prompts[2]).toContain('garage door code');
    expect(c.prompts[2]).toContain('spare cabin key');
  });

  it('a turn shown with an earlier goals turn as its context is marked too: that turn’s words are in the call', async () => {
    const first = turn('c1', SAY_SECRET);
    const second = turn('c1', SAY_GARAGE);
    const k = new KnowledgeStore(kpath(), downEmbedder);
    const c = curator();
    await new MemoryExtractor(source({ c1: [first, second] }), k, c.brain, spath(), { carriedGoals: (_cid, tid) => tid === first.id }).run();
    expect(c.prompts).toHaveLength(1);
    expect(k.all().map((f) => f.fromGoals ?? false)).toEqual([true, true]);
  });

  it('the known facts that stay here are shown only to a call about goals turns', async () => {
    const k = new KnowledgeStore(kpath(), downEmbedder);
    await k.add(SECRET, 'history', { fromGoals: true });
    await k.add('Will’s sister is named Kate.', 'history');
    const goalsTurn = turn('c1', 'How are my goals going this month, and what should I do next about them?');
    const plain = turn('c2', SAY_OPEN);
    const c = curator();
    await new MemoryExtractor(source({ c1: [goalsTurn], c2: [plain] }), k, c.brain, spath(), { carriedGoals: (_cid, tid) => tid === goalsTurn.id }).run();
    expect(c.prompts).toHaveLength(2);
    const [forGoals, forPlain] = c.prompts as [string, string];
    expect(forGoals).toContain(FACT_CANARY);
    expect(forGoals).toContain('sister is named Kate');
    expect(forPlain).not.toContain(FACT_CANARY);
    expect(forPlain).toContain('sister is named Kate');
  });

  it('an extractor whose brain is not on this Mac never reads a goals turn (main() names it untrusted for that brain), so it is never shown such a fact either', async () => {
    const k = new KnowledgeStore(kpath(), downEmbedder);
    await k.add(SECRET, 'history', { fromGoals: true });
    const goalsTurn = turn('c1', SAY_SECRET.replace('Bluebird', 'Bluebird again'));
    const plain = turn('c2', SAY_OPEN);
    const c = curator();
    const carried = (_cid: string, tid: string) => tid === goalsTurn.id;
    const ex = new MemoryExtractor(source({ c1: [goalsTurn], c2: [plain] }), k, c.brain, spath(), { kind: 'frontier', isTainted: carried, carriedGoals: carried });
    await ex.run();
    expect(ex.lastStats.skippedTainted).toBe(1);
    expect(c.prompts).toHaveLength(1);
    expect(c.prompts[0]).not.toContain(FACT_CANARY);
  });
});

describe('memory extraction: a turn the extractor may not read is not context for the next one either', () => {
  const spath = () => join(dir, 'extract-state.json');

  it('a frontier extractor mining the plain turn after a goals turn is not shown the goals turn as "earlier in this conversation"', async () => {
    const k = new KnowledgeStore(kpath(), downEmbedder);
    const goalsTurn = turn('c1', SAY_SECRET, `Noted: Bluebird ${FACT_CANARY}.`);
    const plain = turn('c1', SAY_OPEN);
    const c = curator();
    const carried = (_cid: string, tid: string) => tid === goalsTurn.id;
    const ex = new MemoryExtractor(source({ c1: [goalsTurn, plain] }), k, c.brain, spath(), { kind: 'frontier', isTainted: carried, carriedGoals: carried });
    await ex.run();
    expect(ex.lastStats.skippedTainted).toBe(1);
    expect(c.prompts).toHaveLength(1);
    expect(c.prompts[0]).toContain('Dr Okafor');
    expect(c.prompts[0]).not.toContain('earlier in this conversation');
    expect(c.prompts.join('\n')).not.toContain(FACT_CANARY);
    expect(c.prompts.join('\n')).not.toContain('Bluebird');
    // What it learned there is an ordinary fact: nothing of the goals turn was in the call.
    expect(k.all().map((f) => [f.text, f.fromGoals ?? false])).toEqual([[OPEN, false]]);
  });

  it('with nothing held back, the earlier turn is shown as context, as it always was', async () => {
    const first = turn('c1', SAY_GARAGE);
    const second = turn('c1', SAY_OPEN);
    const c = curator();
    await new MemoryExtractor(source({ c1: [first, second] }), new KnowledgeStore(kpath(), downEmbedder), c.brain, spath(), { kind: 'frontier' }).run();
    expect(c.prompts.join('\n')).toContain('(earlier in this conversation — WILL: I keep my garage door code in the blue notebook');
  });
});

describe('a fact that stays here and the embedder', () => {
  /** An embedder that keeps every text it is sent. */
  const recordingEmbedder = () => {
    const sent: string[] = [];
    return { sent, embedder: { embed: async (texts: string[]) => (sent.push(...texts), texts.map(vec)) } as Emb };
  };
  const vectors = () => (JSON.parse(readFileSync(kpath(), 'utf8')) as { facts: Array<{ text: string; vector: number[] }> }).facts.map((f) => [f.text, f.vector.length > 0]);

  it('with the embedder on another machine (a remote OLLAMA_HOST), it is stored without an embedding and never sent there; ordinary facts are embedded as before', async () => {
    const e = recordingEmbedder();
    const k = new KnowledgeStore(kpath(), e.embedder, undefined, undefined, { embedderHere: () => embedderHere('http://rented-gpu.example.com:11434') });
    await k.add(SECRET, 'history', { fromGoals: true });
    await k.add(OPEN, 'history');
    expect(e.sent).toEqual([OPEN]);
    expect(vectors()).toEqual([[SECRET, false], [OPEN, true]]);
    // Recall still finds it, by its words, for a brain that may read it; and recall does not send it off to be embedded later.
    const r = await k.recallWithMode('what is my cabin trip codename?');
    expect(r.facts).toContain(SECRET);
    expect(r.outside.join(' ')).not.toContain(FACT_CANARY);
    expect(await k.reembedMissing()).toBe(0);
    expect(e.sent.join(' ')).not.toContain(FACT_CANARY);
    expect(vectors()).toEqual([[SECRET, false], [OPEN, true]]);
  });

  it('with the embedder on this Mac, it is embedded like any fact', async () => {
    const e = recordingEmbedder();
    const k = new KnowledgeStore(kpath(), e.embedder, undefined, undefined, { embedderHere: () => embedderHere('http://127.0.0.1:11434') });
    await k.add(SECRET, 'history', { fromGoals: true });
    expect(e.sent).toEqual([SECRET]);
    expect(vectors()).toEqual([[SECRET, true]]);
  });

  it('an embedder nobody vouched for is not here: the default holds a marked fact back', async () => {
    const e = recordingEmbedder();
    const k = new KnowledgeStore(kpath(), e.embedder);
    await k.add(SECRET, 'history', { fromGoals: true });
    expect(e.sent).toEqual([]);
    expect(embedderHere(undefined)).toBe(false);
    expect(embedderHere('http://localhost:11434')).toBe(true);
    expect(embedderHere('http://10.0.0.7:11434')).toBe(false);
  });

  it('a marked fact stored while the embedder was down is healed only by an embedder on this Mac', async () => {
    const down = new KnowledgeStore(kpath(), downEmbedder, undefined, undefined, { embedderHere: () => true });
    await down.add(SECRET, 'history', { fromGoals: true });
    await down.add(OPEN, 'history');
    const away = recordingEmbedder();
    expect(await new KnowledgeStore(kpath(), away.embedder, undefined, undefined, { embedderHere: () => false }).reembedMissing()).toBe(1);
    expect(away.sent).toEqual([OPEN]);
    const here = recordingEmbedder();
    expect(await new KnowledgeStore(kpath(), here.embedder, undefined, undefined, { embedderHere: () => true }).reembedMissing()).toBe(1);
    expect(here.sent).toEqual([SECRET]);
  });
});

describe('`remember` from a brain that may not know of a fact that stays here', () => {
  const call = (t: Tool, fact: string) => t.handler({ id: 'c', toolName: 'remember', args: { fact } });

  it('the standard build answers "saved" for the very words of a marked fact, as it would if the fact were not there', async () => {
    const k = new KnowledgeStore(kpath(), downEmbedder);
    await k.add(SECRET, 'history', { fromGoals: true });
    const standard = rememberTool(k);
    expect(await call(standard, SECRET)).toEqual({ ok: true, remembered: true, note: 'saved' });
    // Those words are no longer something only this Mac holds: the one fact has lost its mark, and is recalled for any brain.
    expect(k.all().map((f) => [f.text, f.fromGoals ?? false])).toEqual([[SECRET, false]]);
    expect((await k.recallWithMode('what is my cabin trip codename?')).outside).toEqual([SECRET]);
    // Told again, it is known, as any saved fact is.
    expect(await call(standard, SECRET)).toEqual({ ok: true, remembered: false, note: 'already known' });
  });

  it('nor does a close rewording get "already known": the marked fact is not counted, and stays marked', async () => {
    const k = new KnowledgeStore(kpath(), downEmbedder);
    await k.add(SECRET, 'history', { fromGoals: true });
    const reworded = SECRET.replace('codename is', 'codename is now');
    expect((await k.addDetailed(reworded, 'history')).status).toBe('added');
    expect(k.all().map((f) => f.fromGoals ?? false)).toEqual([true, false]);
    // Against an ordinary fact the rule is what it was.
    const plain = new KnowledgeStore(join(dir, 'plain.json'), downEmbedder);
    await plain.add(OPEN, 'history');
    expect((await plain.addDetailed(OPEN, 'history')).status).toBe('duplicate');
    expect((await plain.addDetailed(OPEN.replace('dentist is', 'dentist is now'), 'history')).status).toBe('near-duplicate');
    // ...and a marked add counts every fact, as before.
    expect((await k.addDetailed(SECRET.replace('codename is', 'codename is just'), 'history', { fromGoals: true })).status).toBe('near-duplicate');
  });

  it('the build an ask that stays here is offered knows every fact: it answers "already known" for a marked one and for an ordinary one', async () => {
    const k = new KnowledgeStore(kpath(), downEmbedder);
    await k.add(SECRET, 'history', { fromGoals: true });
    await k.add(OPEN, 'history');
    const local = rememberTool(k, { fromGoals: true });
    expect(await call(local, SECRET)).toEqual({ ok: true, remembered: false, note: 'already known' });
    expect(await call(local, OPEN)).toEqual({ ok: true, remembered: false, note: 'already known' });
    // An ordinary fact does not become one that stays here by being told again on such an ask.
    expect(k.all().map((f) => f.fromGoals ?? false)).toEqual([true, false]);
  });

  it('what the extractor learns from an ordinary turn is held to the same rule', async () => {
    const k = new KnowledgeStore(kpath(), downEmbedder);
    await k.add(SECRET, 'history', { fromGoals: true });
    const c = curator();
    const ex = new MemoryExtractor(source({ c2: [turn('c2', SAY_SECRET)] }), k, c.brain, join(dir, 'extract-state.json'), { kind: 'frontier' });
    await ex.run();
    // The frontier extractor was not shown the marked fact as a known one, and its own find is an ordinary fact.
    expect(c.prompts[0]!.split('TURNS:')[0]).not.toContain(FACT_CANARY);
    expect(k.all().map((f) => [f.text, f.fromGoals ?? false])).toEqual([[SECRET, false]]);
  });
});

describe('the canary: a fact learned from a goals turn, then other turns', () => {
  const claudeThenGpt = [{ name: 'anthropic', model: 'claude-opus-5-5' }, { name: 'openai', model: 'gpt-5.2' }];
  const ASK = 'what is my cabin trip codename?';

  /** A server with long-term memory, and one pass of memory extraction on the local model over what it has stored. */
  function withMemory(o: Partial<MiniOptions> & { knowledge?: KnowledgeStore } = {}) {
    const knowledge = o.knowledge ?? new KnowledgeStore(kpath(), downEmbedder);
    const s = server({ frontier: claudeThenGpt, ...o, knowledge });
    const c = curator();
    const extract = () =>
      new MemoryExtractor(s.store, knowledge, c.brain, join(dir, `extract-${Math.random()}.json`), {
        kind: 'local',
        // As main(): the extractor's rules for the turns that stay here, for the brain it runs on (the local model).
        ...s.goalsChat.extractor({ brain: { provider: 'ollama', model: 'qwen2.5:14b', baseURL: HERE }, tainted: () => false }),
      }).run();
    return { ...s, knowledge, extract, curator: c };
  }
  /** Everything every outside provider was ever sent. */
  const outside = (s: ReturnType<typeof withMemory>) => s.tiers.map((t) => t.seen()).join('\n');

  it('learned locally from a goals turn, it is marked; a frontier turn that would recall it never holds it, nor does the tier it falls back from', async () => {
    const s = withMemory({ frontier: [{ ...claudeThenGpt[0]!, script: ['fail'] }, claudeThenGpt[1]!] });
    // The local model answers a turn with Will's goals in its context. In it, Will says something worth keeping.
    expect((await s.chat('local', SAY_SECRET, 'c1')).goalsTokens).toBeGreaterThan(0);
    expect(await s.extract()).toBe(1);
    expect(s.knowledge.all()).toMatchObject([{ text: SECRET, conversationId: 'c1', fromGoals: true }]);
    // Another conversation, routed to the frontier, about that very fact. Claude fails; GPT answers.
    expect((await s.chat('frontier', ASK, 'c2')).answeredBy).toBe('frontier');
    expect(s.tiers[0]!.requests).toHaveLength(1);
    expect(s.tiers[1]!.requests).toHaveLength(1);
    expect(outside(s)).not.toContain(FACT_CANARY);
    expect(outside(s)).not.toContain('Bluebird');
    // The rest of what the frontier is given is what it always was.
    expect(s.tiers[1]!.seen()).toContain('RECALL-MARK');
    expect(s.tiers[1]!.seen()).toContain('WORLD-MARK');
  });

  it('recall for a local brain is unchanged: asked the same thing, the local model is given the fact', async () => {
    const s = withMemory();
    await s.chat('local', SAY_SECRET, 'c1');
    await s.extract();
    await s.chat('local', ASK, 'c2');
    expect(JSON.stringify(s.local.requests[1])).toContain(SECRET);
    // And when the frontier fails and the local model answers in its place: the tier went without, the local model did not.
    const f = withMemory({ frontier: [{ ...claudeThenGpt[0]!, script: ['fail'] }], knowledge: s.knowledge });
    expect((await f.chat('frontier', ASK, 'c3')).answeredBy).toBe('local');
    expect(outside(f)).not.toContain(FACT_CANARY);
    expect(f.local.seen()).toContain(SECRET);
  });

  it('a turn that was given such a fact is held like a goals turn, with the goals block off: marked, its answer kept from an outside brain’s history, and what is learned from it marked too', async () => {
    const knowledge = new KnowledgeStore(kpath(), downEmbedder);
    await knowledge.add(SECRET, 'history', { fromGoals: true });
    // FLINT_GOALS_NOW is off now. The local model repeats the fact in its answer.
    const s = withMemory({ knowledge, goalsOn: false, local: { name: 'ollama', model: 'qwen2.5:14b', baseURL: HERE, script: [{ say: `Your codename is Bluebird ${FACT_CANARY}.` }] as Step[] } });
    const told = await s.chat('local', ASK, 'c1');
    expect(told.goalsTokens).toBe(0);
    expect(s.fetched()).toBe(0); // the runtime is never asked for goals while the block is off
    expect(s.local.seen()).toContain(SECRET);
    const [stored] = await s.store.getTurns('c1');
    expect(carriedGoals(stored!)).toBe(true);
    // The next turn of that conversation goes to the frontier: it gets neither the fact nor the turn that held it.
    await s.chat('frontier', 'and what did you just tell me?', 'c1');
    expect(outside(s)).not.toContain(FACT_CANARY);
    expect(outside(s)).not.toContain('Bluebird');
    expect(s.tiers[0]!.seen()).toContain('An earlier part of this conversation');
    // A turn that was given no such fact is an ordinary one.
    await s.chat('local', 'what time is it in Lisbon right now?', 'c9');
    expect(carriedGoals((await s.store.getTurns('c9'))[0]!)).toBe(false);
  });

  it('such an ask is offered no tool an outside AI answers, like one that carries the goals; an ask given no such fact is offered everything', async () => {
    const stub = (name: string): Tool => ({ definition: { name, description: name, inputSchema: { type: 'object', properties: {} }, idempotent: true }, handler: async () => ({ ok: true }) });
    const tools = [stub('remember'), stub('web.web_search'), stub('trident.perplexity_search')];
    const knowledge = new KnowledgeStore(kpath(), downEmbedder);
    await knowledge.add(SECRET, 'history', { fromGoals: true });
    const s = withMemory({ knowledge, goalsOn: false, tools, goalsTools: withoutOutsideAi({ specs: paidToolSpecs({}) }) });
    const names = (i: number) => (s.local.requests[i]!.tools ?? []).map((t) => t.name);
    await s.chat('local', ASK, 'c1');
    expect(names(0)).toEqual(['remember', 'web.web_search']);
    await s.chat('local', 'what time is it in Lisbon right now?', 'c2');
    expect(names(1)).toEqual(['remember', 'web.web_search', 'trident.perplexity_search']);
  });

  it('an `ollama:` tier on this Mac is given the fact; one on another machine, an Ollama cloud tier and a "local" model on another machine are not', async () => {
    const knowledge = new KnowledgeStore(kpath(), downEmbedder);
    await knowledge.add(SECRET, 'history', { fromGoals: true });
    const onMac = withMemory({ knowledge, frontier: [{ name: 'ollama', model: 'qwen2.5:72b', baseURL: HERE }] });
    await onMac.chat('frontier', ASK, 'c1');
    expect(onMac.tiers[0]!.seen()).toContain(SECRET);
    for (const tier of [{ name: 'ollama', model: 'qwen2.5:72b', baseURL: 'http://10.0.0.7:11434' }, { name: 'ollama', model: 'gpt-oss:120b-cloud', baseURL: HERE }]) {
      const away = withMemory({ knowledge, frontier: [tier] });
      await away.chat('frontier', ASK, 'c1');
      expect(away.tiers[0]!.seen(), tier.model).not.toContain(FACT_CANARY);
    }
    // #62 calls the local persona's turn a local turn wherever its Ollama runs; a fact that stays here needs the brain to be here as well.
    const remote = withMemory({ knowledge, local: { name: 'ollama', model: 'qwen2.5:14b', baseURL: 'http://10.0.0.7:11434' } });
    await remote.chat('local', ASK, 'c1');
    expect(remote.local.seen()).not.toContain(FACT_CANARY);
  });

  it('a fact with no mark goes to every brain as before, beside one that is held back', async () => {
    const s = withMemory();
    // Learned from a turn the frontier answered: an ordinary turn, an ordinary fact.
    await s.chat('frontier', SAY_OPEN, 'c1');
    await s.chat('local', SAY_SECRET, 'c2');
    expect(await s.extract()).toBe(2);
    expect(s.knowledge.all().map((f) => f.fromGoals ?? false)).toEqual([false, true]);
    await s.chat('frontier', 'who is my dentist, and what is my cabin trip codename?', 'c3');
    const sent = JSON.stringify(s.tiers[0]!.requests[1]);
    expect(sent).toContain('Dr Okafor');
    expect(sent).not.toContain(FACT_CANARY);
  });

  it('FLINT_GOALS_TO_FRONTIER=on lifts it: Will chose to send goal text out, and what was learned from it goes with it', async () => {
    const knowledge = new KnowledgeStore(kpath(), downEmbedder);
    await knowledge.add(SECRET, 'history', { fromGoals: true });
    const s = withMemory({ knowledge, toFrontier: true });
    await s.chat('frontier', ASK, 'c1');
    expect(s.tiers[0]!.seen()).toContain(SECRET);
    // Turned off again, it is held back again.
    const off = withMemory({ knowledge });
    await off.chat('frontier', ASK, 'c1');
    expect(outside(off)).not.toContain(FACT_CANARY);
  });

  it('the gate needs the local model’s turn as well as its brain: asked outside one, even the local persona is given neither the fact nor the goals', async () => {
    const s = withMemory({ goals: answer() });
    const turn = await s.goalsChat.forTurn('c1', ASK);
    // As /chat's pump asks: the turn's whole context, its recalled block, and that block's outside twin.
    const whole = `[whole] ${SECRET}`;
    const ask = (persona = s.localPersona) => turn.ask(persona, { context: whole, whole, outside: '[outside]', tools: [] });
    expect(ask()).toMatchObject({ context: '[outside]', tools: [], tokens: 0, mark: {}, staysHere: false });
    const inTurn = asLocalTurn(() => ask());
    expect(inTurn.context).toContain(SECRET);
    expect(inTurn.context).toContain('Will’s goals');
    expect(inTurn.mark).toEqual({ context: { goals: true } });
    expect(inTurn.staysHere).toBe(true);
    // A frontier tier, in or out of a local turn, gets the outside context alone.
    expect(asLocalTurn(() => ask(s.chain[0]!.persona))).toMatchObject({ context: '[outside]', tools: [], tokens: 0, mark: {}, staysHere: false });
  });
});
