import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message } from '@flint/core';
import { PersistentStore, ATTACHMENT_RETAIN_TURNS, shedMessage } from '../src/persistent-store';

const IMG = { kind: 'image' as const, mediaType: 'image/png', name: 'a.png', data: 'iVBORw0KGgo=', bytes: 8 };

function userMsg(i: number, withImage: boolean): Message {
  return { id: `u${i}`, role: 'user', content: `q${i}`, timestamp: i, ...(withImage ? { attachments: [IMG] } : {}) };
}

async function turn(store: PersistentStore, i: number, withImage = true): Promise<void> {
  await store.beginTurn({ conversationId: 'c', turnId: `t${i}`, userMessage: userMsg(i, withImage), createdAt: i });
  await store.commitTurn({
    conversationId: 'c',
    turnId: `t${i}`,
    responseMessages: [{ id: `a${i}`, role: 'assistant', content: `a${i}`, timestamp: i }],
    usage: { input: 1, output: 1 },
    updatedAt: i,
  });
}

let dir: string | undefined;
afterEach(() => {
  vi.useRealTimers();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

// The turns here are timestamped 0..n (1970), so these stores turn the history
// window off (`history: null`): the default 48h window would send none of them.
describe('PersistentStore attachment retention', () => {
  it('shedMessage drops bodies, keeps metadata, and leaves plain messages untouched', () => {
    const plain = userMsg(1, false);
    expect(shedMessage(plain)).toBe(plain);
    expect(shedMessage(userMsg(1, true)).attachments).toEqual([{ kind: 'image', mediaType: 'image/png', name: 'a.png', bytes: 8 }]);
  });

  it('keeps bodies only on the most recent turns in RAM', async () => {
    dir = mkdtempSync(join(tmpdir(), 'flint-store-'));
    const store = new PersistentStore(join(dir, 'c.json'), { history: null });
    const n = ATTACHMENT_RETAIN_TURNS + 2;
    for (let i = 0; i < n; i++) await turn(store, i);
    const users = (await store.getMessages('c')).filter((m) => m.role === 'user');
    const withBody = users.map((m) => typeof m.attachments?.[0]?.data === 'string');
    expect(withBody).toEqual(users.map((_, i) => i >= n - ATTACHMENT_RETAIN_TURNS));
    // Shed turns still say what was attached.
    expect(users[0]!.attachments?.[0]?.name).toBe('a.png');
  });

  // For reading a PDF ahead of the request that will carry it (../src/inference routeFirst).
  it('windowAttachments: the files the next message carries that still hold their bytes, with no history check set off', async () => {
    dir = mkdtempSync(join(tmpdir(), 'flint-store-'));
    const store = new PersistentStore(join(dir, 'c.json'), { history: null });
    let checks = 0;
    store.onHistory = () => void checks++;
    expect(store.windowAttachments('c')).toEqual([]);
    const n = ATTACHMENT_RETAIN_TURNS + 2;
    for (let i = 0; i < n; i++) await turn(store, i);
    await turn(store, n, false);
    const held = store.windowAttachments('c');
    // Only the turns whose bodies are still in RAM count, and a turn with no file adds nothing.
    expect(held.length).toBeGreaterThan(0);
    expect(held.length).toBeLessThanOrEqual(ATTACHMENT_RETAIN_TURNS);
    for (const a of held) expect(a).toEqual(IMG);
    expect(checks).toBe(0);
    expect(store.windowAttachments('another')).toEqual([]);
    // A failed turn's file is not history: it is not handed to the next message.
    await store.beginTurn({ conversationId: 'f', turnId: 't1', userMessage: userMsg(1, true), createdAt: 1 });
    await store.failTurn({ conversationId: 'f', turnId: 't1', error: { kind: 'internal', message: 'x', retryable: false }, updatedAt: 2 });
    expect(store.windowAttachments('f')).toEqual([]);
  });

  it('never writes attachment bodies to disk', async () => {
    vi.useFakeTimers();
    dir = mkdtempSync(join(tmpdir(), 'flint-store-'));
    const path = join(dir, 'c.json');
    const store = new PersistentStore(path, { history: null });
    await turn(store, 1);
    vi.advanceTimersByTime(1000);
    const disk = readFileSync(path, 'utf8');
    expect(disk).toContain('a.png');
    expect(disk).not.toContain(IMG.data);
    // RAM still has it for follow-ups.
    const [u] = await store.getMessages('c');
    expect(u!.attachments?.[0]?.data).toBe(IMG.data);
    // And a reload restores the metadata-only form cleanly.
    const reloaded = new PersistentStore(path, { history: null });
    const [r] = await reloaded.getMessages('c');
    expect(r!.attachments).toEqual([{ kind: 'image', mediaType: 'image/png', name: 'a.png', bytes: 8 }]);
  });
});
