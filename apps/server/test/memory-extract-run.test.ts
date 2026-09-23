import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Turn } from '@flint/core';
import { KnowledgeStore } from '../src/knowledge';
import { MemoryExtractor, EXTRACT_SYSTEM, EXTRACT_VERSION, parseCandidates, type TurnSource } from '../src/memory-extract';

const downEmbedder = {
  embed: async () => {
    throw new Error('ollama down');
  },
} as unknown as ConstructorParameters<typeof KnowledgeStore>[1];

let tick = 1_780_000_000_000;
function turn(cid: string, user: string, assistant = 'ok', status: Turn['status'] = 'complete'): Turn {
  tick += 60_000;
  return {
    id: `t${tick}`,
    conversationId: cid,
    status,
    messages: [
      { id: `u${tick}`, role: 'user', content: user, timestamp: tick },
      ...(status === 'complete' ? [{ id: `a${tick}`, role: 'assistant' as const, content: assistant, timestamp: tick }] : []),
    ],
    createdAt: tick,
    updatedAt: tick,
  };
}

function source(convs: Record<string, Turn[]>): TurnSource {
  return {
    conversationIds: () => Object.keys(convs),
    getTurns: async (cid) => structuredClone(convs[cid] ?? []),
  };
}

/** A fake frontier that records prompts and replies with a scripted answer. */
function brain(reply: (prompt: string, n: number) => string) {
  const calls: Array<{ system: string; prompt: string }> = [];
  return {
    calls,
    b: {
      generate: async (i: { system: string; prompt: string }) => {
        calls.push(i);
        return { text: reply(i.prompt, calls.length) };
      },
    },
  };
}

describe('MemoryExtractor.run', () => {
  let dir: string;
  let kpath: string;
  let spath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'flint-extract-'));
    kpath = join(dir, 'knowledge.json');
    spath = join(dir, 'extract-state.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const state = () => JSON.parse(readFileSync(spath, 'utf8'));

  it('skips synthetic corpus, failed turns, trivial probes and repeated probes — but still moves past them', async () => {
    const convs = {
      'bulk-1': [turn('bulk-1', 'How does a catalytic converter chemically neutralize exhaust?')],
      'grow-1': [turn('grow-1', 'When should you choose eventual consistency?', '', 'failed')],
      wq1: [turn('wq1', "what's the weather in Dallas right now?")],
      wq2: [turn('wq2', "what's the weather in Dallas right now?")],
      w0: [turn('w0', 'hi')],
      console: [turn('console', 'My friend Tanner is visiting from Houston next month and he loves brisket')],
    };
    const k = new KnowledgeStore(kpath, downEmbedder);
    const { b, calls } = brain(() => '[]');
    const ex = new MemoryExtractor(source(convs), k, () => b, spath);
    await ex.run();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.system).toBe(EXTRACT_SYSTEM); // curator prompt, not the persona
    expect(calls[0]!.prompt).toContain('Tanner');
    expect(calls[0]!.prompt).not.toContain('catalytic');
    expect(calls[0]!.prompt.match(/weather in Dallas/g)).toHaveLength(1);
    expect(ex.lastStats).toMatchObject({ skippedSynthetic: 1, skippedTrivial: 1, skippedDuplicate: 1, turnsSent: 2 });
    const s = state();
    expect(s.version).toBe(EXTRACT_VERSION);
    expect(Object.keys(s.watermarks).sort()).toEqual(['bulk-1', 'console', 'w0', 'wq1', 'wq2']);

    // idempotent: a second pass has nothing to send
    await ex.run();
    expect(calls).toHaveLength(1);
  });

  it('gives each turn the previous turn as context', async () => {
    const convs = {
      console: [
        turn('console', "I'm about to get you a server to live on full time"),
        turn('console', 'September 25-October 3 is when it’s scheduled to be delivered'),
      ],
    };
    const { b, calls } = brain(() => '[]');
    await new MemoryExtractor(source(convs), new KnowledgeStore(kpath, downEmbedder), () => b, spath).run();
    const second = calls[0]!.prompt.split('### Turn 2')[1]!;
    expect(second).toContain('earlier in this conversation');
    expect(second).toContain('get you a server');
  });

  it('stores facts with provenance and counts rejections by reason', async () => {
    const t1 = turn('console', 'My team is the Houston Astros, have been forever');
    const t2 = turn('c9', 'Tell my friend Drew hi from me please');
    const k = new KnowledgeStore(kpath, downEmbedder);
    await k.add("Will's favorite MLB team is the Houston Astros.");
    const { b } = brain(() =>
      JSON.stringify([
        { fact: "Will's favorite MLB team is the Houston Astros.", turn: 1 },
        { fact: 'Will has a friend named Drew.', category: 'Person', turn: 2 },
        { fact: 'Will asked Flint to say hi to Drew.', turn: 2 },
        'Will is going to the game tonight with Drew.',
      ]),
    );
    const ex = new MemoryExtractor(source({ console: [t1], c9: [t2] }), k, () => b, spath);
    expect(await ex.run()).toBe(1);
    const drew = k.all().find((f) => f.text.includes('Drew'))!;
    expect(drew).toMatchObject({ source: 'history', conversationId: 'c9', sourceAt: t2.updatedAt, category: 'person' });
    expect(ex.lastStats.rejected).toEqual({ duplicate: 1, 'low-value': 1, ephemeral: 1 });
    expect(ex.lastStats.candidates).toBe(4);
  });

  it('supersedes a stale fact only from a turn at least as recent', async () => {
    const k = new KnowledgeStore(kpath, downEmbedder);
    await k.add('Will is buying a Mac Studio around August 2026.', 'user', { sourceAt: tick });
    const oldId = k.all()[0]!.id;
    const newer = turn('console', 'The Mac Studio is scheduled to arrive September 25 to October 3');
    const { b, calls } = brain(() =>
      JSON.stringify([{ fact: "Will's Mac Studio is scheduled to be delivered September 25 - October 3, 2026.", turn: 1, supersedes: [oldId, 'k999'] }]),
    );
    const ex = new MemoryExtractor(source({ console: [newer] }), k, () => b, spath);
    await ex.run();
    expect(calls[0]!.prompt).toContain(`${oldId}: Will is buying a Mac Studio`); // known facts are shown
    expect(ex.lastStats.superseded).toBe(1);
    expect(k.all().map((f) => f.text)).toEqual(["Will's Mac Studio is scheduled to be delivered September 25 - October 3, 2026."]);
  });

  it('an OLD transcript cannot supersede a newer fact (backfill safety)', async () => {
    const old = turn('console', 'I think I will buy a Mac Studio sometime in August');
    const k = new KnowledgeStore(kpath, downEmbedder);
    await k.add("Will's Mac Studio is scheduled to be delivered September 25 - October 3, 2026.", 'user', { sourceAt: tick + 10 * 86_400_000 });
    const newerId = k.all()[0]!.id;
    const { b } = brain(() => JSON.stringify([{ fact: 'Will plans to buy a Mac Studio in August 2026.', turn: 1, supersedes: [newerId] }]));
    const ex = new MemoryExtractor(source({ console: [old] }), k, () => b, spath);
    await ex.run();
    expect(ex.lastStats.superseded).toBe(0);
    expect(k.all().map((f) => f.id)).toContain(newerId);
  });

  // v1 parsed prose as [] and advanced the watermark anyway: turns silently lost.
  it('does not advance past unparseable output; gives up on a poison batch after 3 tries', async () => {
    const convs = { console: [turn('console', 'My dog is named Biscuit and she is a corgi')] };
    const k = new KnowledgeStore(kpath, downEmbedder);
    const { b, calls } = brain(() => 'Sure! Here are some facts about Will: he has a dog.');
    const ex = new MemoryExtractor(source(convs), k, () => b, spath);
    await ex.run();
    expect(state().watermarks.console).toBeUndefined();
    expect(ex.lastStats.unparseable).toBe(1);
    await ex.run();
    expect(state().watermarks.console).toBeUndefined();
    await ex.run();
    expect(state().watermarks.console).toBeDefined();
    expect(calls).toHaveLength(3);
  });

  it('does not advance when the frontier throws', async () => {
    const convs = { console: [turn('console', 'My dog is named Biscuit and she is a corgi')] };
    const k = new KnowledgeStore(kpath, downEmbedder);
    const ex = new MemoryExtractor(source(convs), k, () => ({ generate: async () => { throw new Error('529 overloaded'); } }), spath);
    await expect(ex.run()).rejects.toThrow('529');
    expect(existsWatermark(spath, 'console')).toBe(false);
  });

  it('respects the daily call budget and resumes the next day', async () => {
    const convs: Record<string, Turn[]> = {};
    for (let i = 0; i < 5; i++) convs[`c${i}`] = [turn(`c${i}`, `Distinct durable statement number ${i} about Will's projects`)];
    let now = Date.UTC(2026, 8, 23, 12);
    const { b, calls } = brain(() => '[]');
    const ex = new MemoryExtractor(source(convs), new KnowledgeStore(kpath, downEmbedder), () => b, spath, {
      batchChars: 1, // one turn per call
      maxCallsPerDay: 2,
      now: () => now,
    });
    await ex.run();
    expect(calls).toHaveLength(2);
    await ex.run(); // same day: budget spent, nothing sent
    expect(calls).toHaveLength(2);
    now += 86_400_000;
    await ex.run();
    expect(calls).toHaveLength(4);
    expect(state().budget).toEqual({ day: '2026-09-24', calls: 2 });
    expect(state().totals.calls).toBe(4);
  });

  it('caps turns per pass and resumes where it stopped', async () => {
    const convs: Record<string, Turn[]> = {};
    for (let i = 0; i < 5; i++) convs[`c${i}`] = [turn(`c${i}`, `Distinct durable statement number ${i} about Will's projects`)];
    const { b, calls } = brain(() => '[]');
    const ex = new MemoryExtractor(source(convs), new KnowledgeStore(kpath, downEmbedder), () => b, spath, { maxTurnsPerPass: 3 });
    await ex.run();
    expect(ex.lastStats.turnsSent).toBe(3);
    await ex.run();
    expect(ex.lastStats.turnsSent).toBe(2);
    await ex.run();
    expect(calls).toHaveLength(2);
  });

  // The live extract-state.json is v1 (no version) and has watermarks over every
  // turn. v2 re-reads history once under the new rules.
  it('re-reads history when the state file is from an older extractor version', async () => {
    const t = turn('console', 'My friend Tanner lives in Austin and works in oil and gas');
    writeFileSync(spath, JSON.stringify({ watermarks: { console: t.updatedAt } }));
    const { b, calls } = brain(() => '[]');
    await new MemoryExtractor(source({ console: [t] }), new KnowledgeStore(kpath, downEmbedder), () => b, spath).run();
    expect(calls).toHaveLength(1);
    expect(state().version).toBe(EXTRACT_VERSION);
  });

  it('skips entirely when no frontier is configured', async () => {
    const ex = new MemoryExtractor(source({ console: [turn('console', 'something durable about Will here')] }), new KnowledgeStore(kpath, downEmbedder), () => undefined, spath);
    expect(await ex.run()).toBe(0);
  });
});

function existsWatermark(p: string, cid: string): boolean {
  try {
    return JSON.parse(readFileSync(p, 'utf8')).watermarks?.[cid] !== undefined;
  } catch {
    return false;
  }
}

describe('parseCandidates', () => {
  it('parses objects with category, turn and supersedes', () => {
    expect(parseCandidates('[{"fact":"Will has a friend named Drew.","category":"Person","turn":2,"supersedes":["k3",4]}]')).toEqual([
      { fact: 'Will has a friend named Drew.', category: 'person', turn: 2, supersedes: ['k3'] },
    ]);
  });
  it('accepts v1-style bare strings', () => {
    expect(parseCandidates('["Will lives in Dallas, Texas."]')).toEqual([{ fact: 'Will lives in Dallas, Texas.', supersedes: [] }]);
  });
  it('distinguishes "nothing to remember" ([]) from garbage (null)', () => {
    expect(parseCandidates('[]')).toEqual([]);
    expect(parseCandidates('I found no durable facts.')).toBeNull();
    expect(parseCandidates('[{"fact": "trunc')).toBeNull();
  });
});
