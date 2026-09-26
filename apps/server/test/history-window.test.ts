import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Flint } from '@flint/core';
import type { GenerateArgs, Message, ProviderAdapter, StreamEvent, Turn } from '@flint/core';
import {
  DEFAULT_HISTORY_MAX_AGE_HOURS,
  DEFAULT_HISTORY_TURNS,
  describeHistoryWindow,
  readHistoryWindow,
  windowTurns,
  type HistoryWindow,
} from '../src/history-window';
import { PersistentStore } from '../src/persistent-store';
import { KnowledgeStore } from '../src/knowledge';
import { MemoryExtractor } from '../src/memory-extract';

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 26, 3, 0); // 2026-09-26 03:00Z
const WIN: HistoryWindow = { maxTurns: 12, maxAgeMs: 48 * HOUR };

function turn(i: number, createdAt: number, status: Turn['status'] = 'complete'): Turn {
  return {
    id: `t${i}`,
    conversationId: 'console',
    status,
    messages: [
      { id: `u${i}`, role: 'user', content: `question number ${i} about the watchlist`, timestamp: createdAt },
      ...(status === 'complete' ? [{ id: `a${i}`, role: 'assistant' as const, content: `answer ${i}`, timestamp: createdAt }] : []),
    ],
    createdAt,
    updatedAt: createdAt,
  };
}

describe('readHistoryWindow', () => {
  it('defaults to 12 turns within 48 hours', () => {
    expect(DEFAULT_HISTORY_TURNS).toBe(12);
    expect(DEFAULT_HISTORY_MAX_AGE_HOURS).toBe(48);
    expect(readHistoryWindow({})).toEqual({ maxTurns: 12, maxAgeMs: 48 * HOUR });
    expect(describeHistoryWindow(readHistoryWindow({}))).toBe('last 12 turn(s) within 48h');
  });

  it('reads FLINT_HISTORY_TURNS and FLINT_HISTORY_MAX_AGE_HOURS', () => {
    expect(readHistoryWindow({ FLINT_HISTORY_TURNS: '4', FLINT_HISTORY_MAX_AGE_HOURS: '1.5' })).toEqual({ maxTurns: 4, maxAgeMs: 1.5 * HOUR });
    expect(readHistoryWindow({ FLINT_HISTORY_TURNS: ' 0 ', FLINT_HISTORY_MAX_AGE_HOURS: '0' })).toEqual({ maxTurns: 0, maxAgeMs: 0 });
  });

  it('falls back to the default, and says so, for a value that is not a number >= 0', () => {
    const logs: string[] = [];
    const w = readHistoryWindow({ FLINT_HISTORY_TURNS: 'lots', FLINT_HISTORY_MAX_AGE_HOURS: '-3' }, (m) => logs.push(m));
    expect(w).toEqual({ maxTurns: 12, maxAgeMs: 48 * HOUR });
    expect(logs).toHaveLength(2);
    expect(readHistoryWindow({ FLINT_HISTORY_TURNS: '2.5' }).maxTurns).toBe(12); // turns are whole
    expect(readHistoryWindow({ FLINT_HISTORY_TURNS: '' }).maxTurns).toBe(12);
  });
});

describe('windowTurns', () => {
  it('by count: keeps the last maxTurns complete turns, in order', () => {
    const turns = Array.from({ length: 20 }, (_, i) => turn(i, NOW - (20 - i) * 60_000));
    const kept = windowTurns(turns, WIN, NOW);
    expect(kept.map((t) => t.id)).toEqual(turns.slice(-12).map((t) => t.id));
  });

  it('by age: drops turns started before now - maxAge even when under the count', () => {
    const turns = [turn(1, NOW - 72 * HOUR), turn(2, NOW - 49 * HOUR), turn(3, NOW - 47 * HOUR), turn(4, NOW - 60_000)];
    expect(windowTurns(turns, WIN, NOW).map((t) => t.id)).toEqual(['t3', 't4']);
  });

  it('both: whichever limit is smaller wins', () => {
    // 30 turns in the last hour: the count binds.
    const burst = Array.from({ length: 30 }, (_, i) => turn(i, NOW - HOUR + i * 60_000));
    expect(windowTurns(burst, WIN, NOW)).toHaveLength(12);
    // The console: 35 turns since June, two in the last two days: the age binds.
    const console = [
      ...Array.from({ length: 33 }, (_, i) => turn(i, NOW - (90 - i) * 24 * HOUR)),
      turn(33, NOW - 20 * 60_000),
      turn(34, NOW - 10 * 60_000),
    ];
    expect(windowTurns(console, WIN, NOW).map((t) => t.id)).toEqual(['t33', 't34']);
    // Tighten the count below what the age leaves and the count binds again.
    expect(windowTurns(console, { ...WIN, maxTurns: 1 }, NOW).map((t) => t.id)).toEqual(['t34']);
  });

  it('never counts pending or failed turns', () => {
    const turns = [turn(1, NOW - 3000), turn(2, NOW - 2000, 'failed'), turn(3, NOW - 1000, 'pending')];
    expect(windowTurns(turns, { maxTurns: 1, maxAgeMs: HOUR }, NOW).map((t) => t.id)).toEqual(['t1']);
  });

  it('a zero window sends no earlier turns', () => {
    expect(windowTurns([turn(1, NOW)], { maxTurns: 0, maxAgeMs: HOUR }, NOW)).toEqual([]);
  });
});

describe('PersistentStore with a history window', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  async function fill(store: PersistentStore, times: number[]): Promise<void> {
    for (const [i, at] of times.entries()) {
      await store.beginTurn({
        conversationId: 'console',
        turnId: `t${i}`,
        userMessage: { id: `u${i}`, role: 'user', content: `question number ${i} about the watchlist`, timestamp: at },
        createdAt: at,
      });
      await store.commitTurn({
        conversationId: 'console',
        turnId: `t${i}`,
        responseMessages: [{ id: `a${i}`, role: 'assistant', content: `answer ${i}`, timestamp: at }],
        usage: { input: 1, output: 1 },
        updatedAt: at,
      });
    }
  }

  const userTexts = (ms: Message[]) => ms.filter((m) => m.role === 'user').map((m) => m.content);

  it('by count: getMessages carries only the last maxTurns turns', async () => {
    dir = mkdtempSync(join(tmpdir(), 'flint-hist-'));
    const store = new PersistentStore(join(dir, 'c.json'), { history: { maxTurns: 3, maxAgeMs: 48 * HOUR }, now: () => NOW });
    await fill(store, Array.from({ length: 8 }, (_, i) => NOW - (8 - i) * 60_000));
    expect(userTexts(await store.getMessages('console'))).toEqual([5, 6, 7].map((i) => `question number ${i} about the watchlist`));
  });

  it('by age: getMessages drops turns older than maxAge', async () => {
    dir = mkdtempSync(join(tmpdir(), 'flint-hist-'));
    const store = new PersistentStore(join(dir, 'c.json'), { history: WIN, now: () => NOW });
    await fill(store, [NOW - 30 * 24 * HOUR, NOW - 3 * 24 * HOUR, NOW - 5 * HOUR]);
    expect(userTexts(await store.getMessages('console'))).toEqual(['question number 2 about the watchlist']);
  });

  it('both: count and age together, whichever is smaller', async () => {
    dir = mkdtempSync(join(tmpdir(), 'flint-hist-'));
    const store = new PersistentStore(join(dir, 'c.json'), { history: { maxTurns: 2, maxAgeMs: 48 * HOUR }, now: () => NOW });
    // four recent turns (count binds to 2), plus two old ones (age drops them)
    await fill(store, [NOW - 400 * HOUR, NOW - 100 * HOUR, NOW - 4 * HOUR, NOW - 3 * HOUR, NOW - 2 * HOUR, NOW - HOUR]);
    expect(userTexts(await store.getMessages('console'))).toEqual([4, 5].map((i) => `question number ${i} about the watchlist`));
  });

  it('keeps every turn stored: getTurns and a reload from disk still hold all of them', async () => {
    dir = mkdtempSync(join(tmpdir(), 'flint-hist-'));
    const path = join(dir, 'c.json');
    const store = new PersistentStore(path, { history: { maxTurns: 1, maxAgeMs: HOUR }, now: () => NOW });
    await fill(store, [NOW - 1000 * HOUR, NOW - 500 * HOUR, NOW - 60_000]);
    expect(await store.getMessages('console')).toHaveLength(2);
    expect(await store.getTurns('console')).toHaveLength(3);
    // Flush the debounced snapshot, then read it back with no window.
    await new Promise((r) => setTimeout(r, 450));
    const reloaded = new PersistentStore(path);
    expect(await reloaded.getTurns('console')).toHaveLength(3);
    expect(userTexts(await reloaded.getMessages('console'))).toHaveLength(3);
  });

  it('without a window it returns the full history, as before', async () => {
    dir = mkdtempSync(join(tmpdir(), 'flint-hist-'));
    const store = new PersistentStore(join(dir, 'c.json'));
    await fill(store, [1, 2, 3]); // 1970 timestamps: an age window would drop them all
    expect(userTexts(await store.getMessages('console'))).toHaveLength(3);
  });

  it('the memory extractor still reads every stored turn, old ones included', async () => {
    dir = mkdtempSync(join(tmpdir(), 'flint-hist-'));
    const store = new PersistentStore(join(dir, 'c.json'), { history: { maxTurns: 1, maxAgeMs: HOUR }, now: () => NOW });
    await fill(store, [NOW - 900 * HOUR, NOW - 400 * HOUR, NOW - 60_000]);
    const knowledge = new KnowledgeStore(join(dir, 'knowledge.json'), {
      embed: async () => {
        throw new Error('ollama down');
      },
    } as unknown as ConstructorParameters<typeof KnowledgeStore>[1]);
    const prompts: string[] = [];
    const ex = new MemoryExtractor(
      store,
      knowledge,
      () => ({
        generate: async (i: { system: string; prompt: string }) => {
          prompts.push(i.prompt);
          return { text: '[]' };
        },
      }),
      join(dir, 'extract-state.json'),
      { now: () => NOW },
    );
    await ex.run();
    const seen = prompts.join('\n');
    for (const i of [0, 1, 2]) expect(seen).toContain(`question number ${i} about the watchlist`);
    expect(ex.lastStats.turnsSeen).toBe(3);
  });

  it('Flint.chat sends the model only the windowed history, and still stores the new turn', async () => {
    dir = mkdtempSync(join(tmpdir(), 'flint-hist-'));
    const store = new PersistentStore(join(dir, 'c.json'), { history: { maxTurns: 2, maxAgeMs: 48 * HOUR }, now: () => NOW });
    await fill(store, [NOW - 30 * 24 * HOUR, NOW - 3 * HOUR, NOW - 2 * HOUR, NOW - HOUR]);
    let sent: Message[] = [];
    const provider: ProviderAdapter = {
      name: 'capture',
      getCapabilities: () => ({ toolCalling: 'native', structuredOutput: 'native', streaming: 'full', maxContextTokens: 100_000, maxOutputTokens: 1000 }),
      estimateTokens: (ms) => ms.reduce((n, m) => n + m.content.length, 0),
      async generate() {
        throw new Error('unused');
      },
      async *stream(args: GenerateArgs): AsyncIterable<StreamEvent> {
        sent = args.messages;
        yield { type: 'text', delta: 'Running clean.' };
        yield { type: 'done', reason: 'complete', usage: { input: 1, output: 1 } };
      },
    };
    const flint = new Flint({ provider, defaultModel: 'm', memory: store });
    for await (const _ of flint.chat({ conversationId: 'console', message: 'How are you doing today Flint?' })) void _;
    expect(userTexts(sent)).toEqual([
      'question number 2 about the watchlist',
      'question number 3 about the watchlist',
      'How are you doing today Flint?',
    ]);
    const turns = await store.getTurns('console');
    expect(turns).toHaveLength(5);
    expect(turns.at(-1)?.status).toBe('complete');
  });
});
