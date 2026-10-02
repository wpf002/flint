/**
 * Chat turns in flight (POST /internal/load): counted while a /chat turn runs,
 * released however it ends.
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
});
