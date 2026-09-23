import { describe, it, expect, vi } from 'vitest';
import { FlintError, makeAiError, type ProviderAdapter } from '@flint/core';
import {
  classifyMessage,
  parseTierSpec,
  readTierSpecs,
  buildTiers,
  envProviderFactory,
  runWithFallback,
  shouldFallBack,
  NoFallback,
  type ProviderFactory,
  mediaChain,
  type BrainTier,
} from '../src/brains';

/** A provider that is never called — tier resolution only needs a name. */
function stubProvider(name: string): ProviderAdapter {
  return {
    name,
    getCapabilities: () => {
      throw new Error('not used');
    },
    estimateTokens: () => 0,
    generate: () => Promise.reject(new Error('not used')),
    stream: () => {
      throw new Error('not used');
    },
  };
}

/** Factory that only "has keys" for the named providers. */
function factoryWith(...available: string[]): ProviderFactory {
  const made = new Map<string, ProviderAdapter>();
  return (name) => {
    if (!available.includes(name)) return undefined;
    if (!made.has(name)) made.set(name, stubProvider(name));
    return made.get(name);
  };
}

const LEGACY = { provider: stubProvider('anthropic'), model: 'claude-sonnet-4-6' };
const persona = (p: ProviderAdapter, m: string) => ({ id: `${p.name}:${m}` });

describe('classifyMessage', () => {
  it('sends code to the code tier', () => {
    for (const m of [
      'why does this throw TypeError: x is undefined',
      'write me a script that renames every .png in a folder',
      'refactor apps/server/src/index.ts so main() is smaller',
      '```ts\nconst x = 1\n```\nwhat is wrong here',
      'how do I git rebase onto main without losing commits',
      'SELECT id FROM users WHERE name = 1 is slow',
    ]) {
      expect(classifyMessage(m), m).toBe('code');
    }
  });

  it('sends reasoning / analysis to the hard tier', () => {
    for (const m of [
      'walk me through the trade-offs of leasing vs buying a car step by step',
      'analyze whether I should refinance at 6.1%',
      'what would happen if the fed cut rates twice this year',
      'give me a strategy for negotiating my salary',
      'x'.repeat(900),
      'what is A? what is B? and how is C related?',
    ]) {
      expect(classifyMessage(m), m.slice(0, 40)).toBe('hard');
    }
  });

  it('keeps short chit-chat and quick lookups routine', () => {
    for (const m of ['hey', 'thanks!', 'good morning', "what's the weather", 'ok cool']) {
      expect(classifyMessage(m), m).toBe('routine');
    }
  });

  it('never calls something routine deep in a thread or when tools are needed', () => {
    expect(classifyMessage('thanks', { turns: 40 })).toBe('standard');
    expect(classifyMessage("what's the weather", { toolsLikely: true })).toBe('standard');
  });

  it('defaults to standard when unsure', () => {
    for (const m of ['who won the game last night', 'tell me about the roman empire', 'draft a note to my landlord']) {
      expect(classifyMessage(m), m).toBe('standard');
    }
  });

  it('does not mistake everyday words for code', () => {
    for (const m of ['let me know what Taylor Swift is up to', 'how did markets react to the jobs report', 'import tariffs news']) {
      expect(classifyMessage(m), m).not.toBe('code');
    }
  });
});

describe('tier config from env', () => {
  it('parses provider:model, keeping colons in the model', () => {
    expect(parseTierSpec('anthropic:claude-opus-4-1')).toEqual({ provider: 'anthropic', model: 'claude-opus-4-1' });
    expect(parseTierSpec(' OpenAI : gpt-5 ')).toEqual({ provider: 'openai', model: 'gpt-5' });
    expect(parseTierSpec('ollama:qwen2.5:72b')).toEqual({ provider: 'ollama', model: 'qwen2.5:72b' });
    for (const bad of [undefined, '', 'claude-opus', ':gpt-5', 'openai:']) expect(parseTierSpec(bad)).toBeUndefined();
  });

  it('reads FLINT_TIER_* and reports malformed values', () => {
    const warn = vi.fn();
    const specs = readTierSpecs({ FLINT_TIER_HARD: 'anthropic:claude-opus-4-1', FLINT_TIER_CODE: 'gpt-5' }, warn);
    expect(specs).toEqual({ hard: { provider: 'anthropic', model: 'claude-opus-4-1' } });
    expect(warn).toHaveBeenCalledOnce();
  });

  it('FLINT_TIERS=off ignores every tier', () => {
    expect(readTierSpecs({ FLINT_TIERS: 'off', FLINT_TIER_HARD: 'anthropic:claude-opus-4-1' })).toEqual({});
  });

  it('DEFAULTS: no tier env → every tier is the single legacy frontier', () => {
    const set = buildTiers({ env: {}, factory: factoryWith('anthropic', 'openai'), legacy: LEGACY, makePersona: persona })!;
    expect(set.primary.label).toBe('anthropic:claude-sonnet-4-6');
    expect(set.tiered).toBe(false);
    for (const t of ['routine', 'standard', 'hard', 'code'] as const) {
      expect(set.get(t).label).toBe('anthropic:claude-sonnet-4-6');
      expect(set.chain(t).map((b) => b.label)).toEqual(['anthropic:claude-sonnet-4-6']);
    }
  });

  it('no legacy frontier and no tiers → undefined (local-only)', () => {
    expect(buildTiers({ env: {}, factory: factoryWith(), legacy: undefined, makePersona: persona })).toBeUndefined();
  });

  it('builds configured tiers and shares a persona per distinct provider:model', () => {
    const makePersona = vi.fn(persona);
    const set = buildTiers({
      env: {
        FLINT_TIER_HARD: 'anthropic:claude-opus-4-1',
        FLINT_TIER_CODE: 'openai:gpt-5',
        FLINT_TIER_ROUTINE: 'anthropic:claude-haiku-4-5',
      },
      factory: factoryWith('anthropic', 'openai'),
      legacy: LEGACY,
      makePersona,
    })!;
    expect(set.tiered).toBe(true);
    expect(set.get('hard').label).toBe('anthropic:claude-opus-4-1');
    expect(set.get('code').label).toBe('openai:gpt-5');
    expect(set.get('routine').label).toBe('anthropic:claude-haiku-4-5');
    expect(set.get('standard').label).toBe('anthropic:claude-sonnet-4-6');
    expect(makePersona).toHaveBeenCalledTimes(4);
    expect(set.chain('hard').map((b) => b.label)).toEqual([
      'anthropic:claude-opus-4-1',
      'anthropic:claude-sonnet-4-6',
      'anthropic:claude-haiku-4-5',
    ]);
    expect(set.chain('code').map((b) => b.label)).toEqual([
      'openai:gpt-5',
      'anthropic:claude-sonnet-4-6',
      'anthropic:claude-haiku-4-5',
    ]);
    expect(set.chain('routine').map((b) => b.label)).toEqual(['anthropic:claude-haiku-4-5', 'anthropic:claude-sonnet-4-6']);
  });

  it('skips a tier whose provider has no key — it inherits standard', () => {
    const log = vi.fn();
    const set = buildTiers({
      env: { FLINT_TIER_CODE: 'openai:gpt-5', FLINT_TIER_HARD: 'bogus:model' },
      factory: factoryWith('anthropic'),
      legacy: LEGACY,
      makePersona: persona,
      log,
    })!;
    expect(set.get('code').label).toBe('anthropic:claude-sonnet-4-6');
    expect(set.get('hard').label).toBe('anthropic:claude-sonnet-4-6');
    expect(set.tiered).toBe(false);
    expect(log.mock.calls.map((c) => c[0]).join('\n')).toMatch(/tier code skipped: openai/);
  });

  it('FLINT_TIER_STANDARD overrides the legacy frontier', () => {
    const set = buildTiers({
      env: { FLINT_TIER_STANDARD: 'openai:gpt-5' },
      factory: factoryWith('openai'),
      legacy: LEGACY,
      makePersona: persona,
    })!;
    expect(set.primary.label).toBe('openai:gpt-5');
    expect(set.get('hard').label).toBe('openai:gpt-5');
  });

  it('a lone tier still gives Flint a frontier when there is no legacy one', () => {
    const set = buildTiers({ env: { FLINT_TIER_CODE: 'openai:gpt-5' }, factory: factoryWith('openai'), legacy: undefined, makePersona: persona })!;
    expect(set.primary.label).toBe('openai:gpt-5');
  });

  it('the env factory only builds providers whose key exists, and reuses instances', () => {
    const f = envProviderFactory({ OPENAI_API_KEY: 'sk-test' });
    expect(f('anthropic')).toBeUndefined();
    expect(f('perplexity')).toBeUndefined();
    expect(f('nope')).toBeUndefined();
    const oa = f('openai');
    expect(oa?.name).toBe('openai');
    expect(f('openai')).toBe(oa);
    expect(f('ollama')?.name).toBe('ollama'); // local: no key needed
  });
});

describe('fallback down the tiers', () => {
  const set = buildTiers({
    env: { FLINT_TIER_HARD: 'anthropic:claude-opus-4-1', FLINT_TIER_ROUTINE: 'anthropic:claude-haiku-4-5' },
    factory: factoryWith('anthropic'),
    legacy: LEGACY,
    makePersona: persona,
  })!;
  const rateLimited = () => new FlintError(makeAiError('rate_limit', '429 slow down'));

  it('uses the first brain when it answers', async () => {
    const won = await runWithFallback(set.chain('hard'), async (b) => `answer from ${b.label}`);
    expect(won.brain.label).toBe('anthropic:claude-opus-4-1');
    expect(won.result).toBe('answer from anthropic:claude-opus-4-1');
  });

  it('falls to the next tier on a provider error and reports it', async () => {
    const onFallback = vi.fn();
    const tried: string[] = [];
    const won = await runWithFallback(
      set.chain('hard'),
      async (b) => {
        tried.push(b.label);
        if (b.label.includes('opus')) throw rateLimited();
        return 'ok';
      },
      { onFallback },
    );
    expect(tried).toEqual(['anthropic:claude-opus-4-1', 'anthropic:claude-sonnet-4-6']);
    expect(won.brain.label).toBe('anthropic:claude-sonnet-4-6');
    expect(onFallback).toHaveBeenCalledOnce();
    expect(onFallback.mock.calls[0]![1].label).toBe('anthropic:claude-sonnet-4-6');
  });

  it('a bad key / unknown model on a tier also falls back', async () => {
    const won = await runWithFallback(set.chain('hard'), async (b) => {
      if (b.label.includes('opus')) throw new FlintError(makeAiError('validation', 'unknown model'));
      return 'ok';
    });
    expect(won.brain.label).toBe('anthropic:claude-sonnet-4-6');
  });

  it('rethrows the last error when every tier fails (caller then goes local)', async () => {
    const attempt = vi.fn(async () => {
      throw rateLimited();
    });
    await expect(runWithFallback(set.chain('hard'), attempt)).rejects.toBeInstanceOf(FlintError);
    expect(attempt).toHaveBeenCalledTimes(3);
  });

  it('does not spend another model after the caller aborted', async () => {
    const ac = new AbortController();
    const attempt = vi.fn(async () => {
      ac.abort();
      throw new FlintError(makeAiError('timeout', 'Request aborted', { retryable: false }));
    });
    await expect(runWithFallback(set.chain('hard'), attempt, { signal: ac.signal })).rejects.toBeInstanceOf(FlintError);
    expect(attempt).toHaveBeenCalledOnce();
    expect(shouldFallBack(new FlintError(makeAiError('timeout', 'Request aborted', { retryable: false })))).toBe(false);
    expect(shouldFallBack(new FlintError(makeAiError('timeout', 'deadline', { retryable: true })))).toBe(true);
  });

  it('NoFallback stops the chain (text already streamed) and surfaces the real error', async () => {
    const real = rateLimited();
    const attempt = vi.fn(async () => {
      throw new NoFallback(real);
    });
    await expect(runWithFallback(set.chain('hard'), attempt)).rejects.toBe(real);
    expect(attempt).toHaveBeenCalledOnce();
  });

  it('with defaults the chain is one brain, so a failure goes straight to the caller as before', async () => {
    const one = buildTiers({ env: {}, factory: factoryWith('anthropic'), legacy: LEGACY, makePersona: persona })!;
    const attempt = vi.fn(async () => {
      throw rateLimited();
    });
    await expect(runWithFallback(one.chain('hard'), attempt)).rejects.toBeInstanceOf(FlintError);
    expect(attempt).toHaveBeenCalledOnce();
  });
});

describe('mediaChain', () => {
  const tier = (label: string, vision: boolean, pdf: boolean) =>
    ({
      tier: 'standard',
      provider: { getCapabilities: () => ({ vision, pdfInput: pdf }) },
      model: label,
      label,
      persona: label,
    }) as unknown as BrainTier<string>;
  const sees = tier('sees', true, true);
  const blind = tier('blind', false, false);
  const imagesOnly = tier('images-only', true, false);

  it('leaves a text-only turn alone', () => {
    expect(mediaChain([blind, sees], {}, sees)).toEqual([blind, sees]);
  });

  it('drops tiers that cannot read the attachment', () => {
    expect(mediaChain([blind, imagesOnly, sees], { pdf: true }, sees).map((b) => b.label)).toEqual(['sees']);
    expect(mediaChain([blind, imagesOnly, sees], { image: true }, sees).map((b) => b.label)).toEqual(['images-only', 'sees']);
  });

  it('falls back to the primary when no tier in the chain can', () => {
    expect(mediaChain([blind], { image: true }, sees)).toEqual([sees]);
  });
});
