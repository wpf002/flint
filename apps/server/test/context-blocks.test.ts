/**
 * Which context blocks are on (./context-blocks): each is off until Will turns
 * it on, the kill switch turns them all off, and sending Will's goals to an
 * outside model takes exactly FLINT_GOALS_TO_FRONTIER=on. A value that is set
 * but not understood turns nothing on, and is reported by name, never by value.
 */
import { describe, it, expect } from 'vitest';
import { readContextBlocks } from '../src/context-blocks';

const read = (env: Record<string, string>) => {
  const warned: string[] = [];
  return { blocks: readContextBlocks(env, (m) => warned.push(m)), warned };
};

describe('readContextBlocks', () => {
  it('everything is off by default: the goals block ships off, and never goes to an outside model', () => {
    expect(read({})).toEqual({ blocks: { world: false, goals: false, goalsToFrontier: false }, warned: [] });
  });

  it('FLINT_WORLD_NOW=1 and FLINT_GOALS_NOW=1 each turn on their own block, and only "1" does', () => {
    expect(read({ FLINT_WORLD_NOW: '1' }).blocks).toEqual({ world: true, goals: false, goalsToFrontier: false });
    expect(read({ FLINT_GOALS_NOW: ' 1 ' }).blocks).toEqual({ world: false, goals: true, goalsToFrontier: false });
    for (const v of ['0', 'on', 'true', 'yes', '', '11']) {
      expect(read({ FLINT_GOALS_NOW: v, FLINT_WORLD_NOW: v }).blocks, v).toEqual({ world: false, goals: false, goalsToFrontier: false });
    }
  });

  it('goals stay with the local model unless FLINT_GOALS_TO_FRONTIER is exactly on', () => {
    expect(read({ FLINT_GOALS_NOW: '1', FLINT_GOALS_TO_FRONTIER: 'on' })).toEqual({ blocks: { world: false, goals: true, goalsToFrontier: true }, warned: [] });
    expect(read({ FLINT_GOALS_NOW: '1', FLINT_GOALS_TO_FRONTIER: ' ON ' }).blocks.goalsToFrontier).toBe(true);
    expect(read({ FLINT_GOALS_NOW: '1', FLINT_GOALS_TO_FRONTIER: 'off' })).toEqual({ blocks: { world: false, goals: true, goalsToFrontier: false }, warned: [] });
    for (const v of ['1', 'true', 'yes', 'anthropic', 'onn', 'o n']) {
      const r = read({ FLINT_GOALS_NOW: '1', FLINT_GOALS_TO_FRONTIER: v });
      expect(r.blocks.goalsToFrontier, v).toBe(false);
      expect(r.warned, v).toEqual(['[context] FLINT_GOALS_TO_FRONTIER is not "on" or "off"; reading it as off (goals stay with the local model)']);
      // By name, never by value.
      if (v.length > 2) expect(r.warned.join(' '), v).not.toContain(v);
    }
  });

  it('FLINT_GOALS_TO_FRONTIER=on does nothing without the goals block, and says so', () => {
    expect(read({ FLINT_GOALS_TO_FRONTIER: 'on' })).toEqual({
      blocks: { world: false, goals: false, goalsToFrontier: false },
      warned: ['[context] FLINT_GOALS_TO_FRONTIER=on does nothing without FLINT_GOALS_NOW=1 (the goals block is off)'],
    });
  });

  it('FLINT_CONTEXT_BLOCKS=off is the kill switch: no block, whatever else is set', () => {
    const all = { FLINT_WORLD_NOW: '1', FLINT_GOALS_NOW: '1', FLINT_GOALS_TO_FRONTIER: 'on' };
    expect(read(all).blocks).toEqual({ world: true, goals: true, goalsToFrontier: true });
    for (const v of ['off', 'OFF', ' off ']) expect(read({ ...all, FLINT_CONTEXT_BLOCKS: v }), v).toEqual({ blocks: { world: false, goals: false, goalsToFrontier: false }, warned: [] });
    // `on`, unset or blank: each block follows its own setting.
    for (const v of ['on', '', '  ']) expect(read({ ...all, FLINT_CONTEXT_BLOCKS: v }), v).toEqual({ blocks: { world: true, goals: true, goalsToFrontier: true }, warned: [] });
    // A mistyped `off` must not leave the blocks running: anything else that is set reads as off, and says so.
    for (const v of ['disabled', '0', 'false', 'of', 'none']) {
      const odd = read({ ...all, FLINT_CONTEXT_BLOCKS: v });
      expect(odd.blocks, v).toEqual({ world: false, goals: false, goalsToFrontier: false });
      expect(odd.warned, v).toEqual(['[context] FLINT_CONTEXT_BLOCKS is not "off" or "on"; reading it as off (no context blocks)']);
    }
  });
});
