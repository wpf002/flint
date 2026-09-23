import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeStore } from '../src/knowledge';

type Emb = ConstructorParameters<typeof KnowledgeStore>[1];

/** A tiny deterministic "semantic" embedder: one dimension per keyword. */
const KEYS = ['coffee', 'astros', 'mac', 'studio', 'dallas', 'rust', 'trading'];
function vec(t: string): number[] {
  const s = t.toLowerCase();
  return KEYS.map((k) => (s.includes(k) ? 1 : 0)).concat([0.01]);
}
const upEmbedder: Emb = { embed: async (texts: string[]) => texts.map(vec) };
const downEmbedder: Emb = {
  embed: async () => {
    throw new Error('connect ECONNREFUSED 127.0.0.1:11434');
  },
};
const hungEmbedder: Emb = { embed: () => new Promise<number[][]>(() => {}) };

/** Embedder that can be flipped between down and up. */
function switchable() {
  const s = { up: false, calls: 0 };
  const e: Emb = {
    embed: async (texts: string[]) => {
      s.calls++;
      if (!s.up) throw new Error('down');
      return texts.map(vec);
    },
  };
  return { s, e };
}

describe('KnowledgeStore recall', () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'flint-recall-'));
    path = join(dir, 'knowledge.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function seed(s: KnowledgeStore) {
    await s.add('Will takes his coffee black, no sugar.');
    await s.add("Will's favorite MLB team is the Houston Astros.");
    await s.add("Will's Mac Studio (M4 Max, 64GB) is scheduled to be delivered September 25 - October 3, 2026.");
    await s.add('Will lives in Dallas, Texas.');
  }

  it('semantic recall works when the embedder is up', async () => {
    const s = new KnowledgeStore(path, upEmbedder);
    await seed(s);
    expect(await s.recall('odds the astros make the playoffs')).toEqual([
      "Will's favorite MLB team is the Houston Astros.",
    ]);
  });

  // The live failure: Ollama is down for hours during a training run, and recall
  // used to return [] — Flint forgot everything exactly then.
  it('falls back to lexical match when the embedder is down', async () => {
    const s = new KnowledgeStore(path, downEmbedder);
    await seed(s);
    expect(await s.recall('How do I take my coffee?')).toEqual(['Will takes his coffee black, no sugar.']);
    expect(await s.recall('What are the odds the Astros make the playoffs?')).toEqual([
      "Will's favorite MLB team is the Houston Astros.",
    ]);
    expect((await s.recall('when does the mac studio arrive'))[0]).toMatch(/Mac Studio/);
  });

  it('lexical fallback returns nothing for an unrelated or contentless query', async () => {
    const s = new KnowledgeStore(path, downEmbedder);
    await seed(s);
    expect(await s.recall('hey how are you doing?')).toEqual([]);
    expect(await s.recall('explain quantum chromodynamics')).toEqual([]);
  });

  it('a wedged embedder times out into the lexical path instead of hanging the turn', async () => {
    const s = new KnowledgeStore(path, hungEmbedder, 0.45, 50);
    // add() must not hang either
    await s.add('Will takes his coffee black, no sugar.');
    expect(await s.recall('coffee order?')).toEqual(['Will takes his coffee black, no sugar.']);
  });

  // A fact stored while Ollama was down has no vector; recall used to filter it
  // out forever. Now it is matched lexically and healed once the embedder is back.
  it('facts stored while the embedder was down are still recalled, and re-embedded later', async () => {
    const { s: sw, e } = switchable();
    const s = new KnowledgeStore(path, e);
    await s.add('Will is rewriting the trading stack in Rust.', 'history');
    sw.up = true;
    expect(await s.recall('rust trading stack plans')).toEqual(['Will is rewriting the trading stack in Rust.']);
    // heal runs in the background after a successful query embed
    await s.reembedMissing();
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { facts: Array<{ vector: number[] }> };
    expect(raw.facts[0]!.vector.length).toBeGreaterThan(0);
  });

  it('respects k', async () => {
    const s = new KnowledgeStore(path, downEmbedder);
    await s.add('Will owns a Mac Studio.');
    await s.add('The Mac Studio has 64GB of memory.');
    await s.add('The Mac Studio runs Flint.');
    expect(await s.recall('mac studio', 2)).toHaveLength(2);
  });
});

describe('KnowledgeStore quality + supersede', () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'flint-know2-'));
    path = join(dir, 'knowledge.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reports why a fact was refused', async () => {
    const s = new KnowledgeStore(path, upEmbedder);
    expect((await s.addDetailed('Will lives in Dallas, Texas.')).status).toBe('added');
    expect((await s.addDetailed('will lives in dallas texas')).status).toBe('duplicate');
    expect((await s.addDetailed('It is currently 3:15 pm in Dallas.')).status).toBe('ephemeral');
    expect((await s.addDetailed('Will is flying to Austin tomorrow.', 'history')).status).toBe('ephemeral');
    expect((await s.addDetailed('Will asked about UFC 329 predictions.', 'history')).status).toBe('low-value');
    expect((await s.addDetailed('   ')).status).toBe('empty');
  });

  it('catches paraphrase-level near duplicates but not different facts', async () => {
    const s = new KnowledgeStore(path, upEmbedder);
    await s.add("Will's Mac Studio has 64GB of unified memory.");
    expect((await s.addDetailed('Will’s Mac Studio has 64GB unified memory', 'history')).status).toBe('near-duplicate');
    expect((await s.addDetailed("Will's Mac Studio has 128GB of unified memory.", 'history')).status).toBe('added');
  });

  it('the explicit remember path is not held to the stricter auto bar', async () => {
    const s = new KnowledgeStore(path, upEmbedder);
    expect(await s.add('Will currently works out of Dallas.', 'user')).toBe(true);
  });

  it('stores provenance and keeps it across reloads', async () => {
    const s = new KnowledgeStore(path, upEmbedder);
    await s.add('Will has a friend named Tanner.', 'history', { conversationId: 'c1782584623556', sourceAt: 1782584623556, category: 'person' });
    const f = new KnowledgeStore(path, upEmbedder).all()[0]!;
    expect(f).toMatchObject({ conversationId: 'c1782584623556', sourceAt: 1782584623556, category: 'person', source: 'history' });
    expect(f).not.toHaveProperty('vector');
  });

  it('supersede retires the old fact from recall but keeps it for audit and blocks its return', async () => {
    const s = new KnowledgeStore(path, downEmbedder);
    await s.add('Will is buying a Mac Studio around August 2026.');
    const out = await s.addDetailed("Will's Mac Studio is scheduled to be delivered September 25 - October 3, 2026.", 'history');
    expect(out.status).toBe('added');
    const oldId = s.all()[0]!.id;
    expect(s.supersede(oldId, (out as { id: string }).id)).toBe(true);
    expect(s.size).toBe(1);
    expect(await s.recall('mac studio')).toEqual(["Will's Mac Studio is scheduled to be delivered September 25 - October 3, 2026."]);
    expect(s.history()).toHaveLength(2);
    // an old transcript re-deriving the retired fact is a no-op
    expect((await s.addDetailed('Will is buying a Mac Studio around August 2026.', 'history')).status).toBe('duplicate');
    // persisted
    const s2 = new KnowledgeStore(path, downEmbedder);
    expect(s2.size).toBe(1);
    expect(s2.history().find((f) => f.id === oldId)?.supersededBy).toBe((out as { id: string }).id);
    // can't double-retire or self-retire
    expect(s2.supersede(oldId, (out as { id: string }).id)).toBe(false);
    expect(s2.supersede((out as { id: string }).id, (out as { id: string }).id)).toBe(false);
  });

  it('loads a legacy knowledge.json (no provenance fields) unchanged', async () => {
    const s = new KnowledgeStore(path, upEmbedder);
    await s.add('Will lives in Dallas, Texas.');
    const reloaded = new KnowledgeStore(path, upEmbedder);
    expect(reloaded.size).toBe(1);
    expect(await reloaded.recall('dallas')).toEqual(['Will lives in Dallas, Texas.']);
  });
});
