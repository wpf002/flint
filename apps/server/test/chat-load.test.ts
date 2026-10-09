/**
 * Chat turns in flight (POST /internal/load): counted while a /chat turn runs,
 * released however it ends. `busy` adds the quiet spell after one ends, for
 * the memory extractor.
 */
import { describe, it, expect } from 'vitest';
import { ChatLoad } from '../src/chat-load';

describe('ChatLoad', () => {
  it('counts each turn while it runs, and releases it when it ends, thrown or not', async () => {
    const load = new ChatLoad();
    let release!: () => void;
    const a = load.run(() => new Promise<void>((r) => (release = r)));
    const b = load.run(async () => {
      throw new Error('the turn failed');
    });
    expect(load.inFlight).toBe(2);
    await expect(b).rejects.toThrow('the turn failed');
    expect(load.inFlight).toBe(1);
    release();
    await a;
    expect(load.inFlight).toBe(0);
  });

  it('is busy while a turn runs and for quietMs after the last one ends, however it ended', async () => {
    let now = 5_000;
    const load = new ChatLoad(() => now);
    expect(load.busy(60_000)).toBe(false); // no turn yet
    let release!: () => void;
    const a = load.run(() => new Promise<void>((r) => (release = r)));
    now += 10 * 60_000;
    expect(load.busy(60_000)).toBe(true); // a long turn is still a turn
    release();
    await a;
    expect(load.busy(60_000)).toBe(true);
    now += 59_999;
    expect(load.busy(60_000)).toBe(true);
    now += 1;
    expect(load.busy(60_000)).toBe(false);
    await expect(load.run(async () => {
      throw new Error('the turn failed');
    })).rejects.toThrow();
    expect(load.busy(60_000)).toBe(true);
    expect(load.busy(0)).toBe(false);
  });
});
