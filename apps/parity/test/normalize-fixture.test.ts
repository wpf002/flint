import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { poolKey, poolOf } from '../src/pool.js';
import { isNearDuplicate, isTrivial, jaccard, normalize, wordSet } from '../src/prompts.js';
import { sha } from '../src/util.js';

/**
 * The contract apps/train/mlx/parity_text.py and pool.py are ported from. The
 * Python tests (apps/train/mlx/tests/test_parity_text.py, test_pool.py) check the
 * same files; if this side changes, regenerate the fixtures and both must pass.
 * A drift would let an eval prompt slip past the training contamination guard.
 */
const norm = JSON.parse(readFileSync(new URL('./fixtures/normalize-cases.json', import.meta.url), 'utf8')) as {
  cases: Array<{ input: string; normalized: string; id: string; words: string[]; trivial: boolean }>;
  pairs: Array<{ a: string; b: string; jaccard: number; nearDuplicate: boolean; guardMatch: boolean }>;
};
const pool = JSON.parse(readFileSync(new URL('./fixtures/pool-cases.json', import.meta.url), 'utf8')) as {
  cases: Array<{ conversationId: string; prompt: string; key: string; pool: 'eval' | 'train' }>;
};

describe('shared prompt-identity fixture (TypeScript side)', () => {
  it.each(norm.cases)('normalize / id / words / trivial: $input', (c) => {
    expect(normalize(c.input)).toBe(c.normalized);
    expect(sha(normalize(c.input.trim()))).toBe(c.id);
    expect([...wordSet(c.input)].sort()).toEqual(c.words);
    expect(isTrivial(c.input)).toBe(c.trivial);
  });

  it.each(norm.pairs)('near-duplicate and guard: $a | $b', (p) => {
    const a = wordSet(p.a);
    const b = wordSet(p.b);
    expect(jaccard(a, b)).toBeCloseTo(p.jaccard, 5);
    expect(isNearDuplicate(a, b, 0.8)).toBe(p.nearDuplicate);
    expect(isNearDuplicate(a, b, 0.6)).toBe(p.guardMatch);
  });

  it('keeps an id the frozen parity set actually uses', () => {
    expect(sha(normalize('Explain the birthday paradox.'))).toBe('00100cd7a076');
  });
});

describe('pool split (TypeScript side)', () => {
  it.each(pool.cases)('$conversationId / $prompt', (c) => {
    expect(poolKey(c.conversationId, c.prompt)).toBe(c.key);
    expect(poolOf(c.conversationId, c.prompt)).toBe(c.pool);
  });

  it('keys the shared buckets by prompt, so one question lands in one pool', () => {
    expect(poolKey('console', 'Why is the sky blue?')).toBe(poolKey('generate', 'why is the sky blue'));
    expect(poolKey('c123', 'x')).toBe('conv:c123');
  });

  it('puts about 30% of conversations in the eval pool', () => {
    let evals = 0;
    for (let i = 0; i < 5000; i++) if (poolOf(`c${i}`, 'x') === 'eval') evals++;
    expect(evals / 5000).toBeGreaterThan(0.27);
    expect(evals / 5000).toBeLessThan(0.33);
  });
});
