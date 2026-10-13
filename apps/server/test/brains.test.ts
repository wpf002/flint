import { describe, it, expect, vi, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { FlintError, OllamaProvider, isFlintError, makeAiError, type ProviderAdapter } from '@flint/core';
import {
  classifyMessage,
  parseTierSpec,
  readTierSpecs,
  readLastResortSpec,
  buildTiers,
  buildFrontierProvider,
  frontierClientOptions,
  FRONTIER_MAX_RETRIES,
  FRONTIER_TIMEOUT_MS,
  envProviderFactory,
  runWithFallback,
  shouldFallBack,
  NoFallback,
  type ProviderFactory,
  mediaChain,
  type BrainTier,
  LONG_CONVERSATION,
} from '../src/brains';
import { DEFAULT_HISTORY_TURNS } from '../src/history-window';
import { LOCAL_ERROR_SENTENCES } from '../src/local-errors';
import { brainOf } from '../src/policy';

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

  it('sizes "deep in a thread" to what the history window can carry (complete turns, not messages)', () => {
    // The default window sends at most 12 turns: a full one is a deep thread.
    expect(LONG_CONVERSATION).toBeLessThanOrEqual(DEFAULT_HISTORY_TURNS);
    expect(classifyMessage('ok so what about the second position then?', { turns: DEFAULT_HISTORY_TURNS })).toBe('standard');
    expect(classifyMessage('ok, and the other one?', { turns: LONG_CONVERSATION })).toBe('standard');
    // A greeting after a quiet stretch (nothing recent in the window) stays routine.
    expect(classifyMessage('How are you doing today Flint?', { turns: 0 })).toBe('routine');
    expect(classifyMessage('ok, and the other one?', { turns: LONG_CONVERSATION - 1 })).toBe('routine');
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

describe('FLINT_TIER_LAST_RESORT', () => {
  const LAST = { FLINT_TIER_LAST_RESORT: 'openai:gpt-5' };

  it('unset: no extra link anywhere (today exactly)', () => {
    const set = buildTiers({ env: {}, factory: factoryWith('anthropic', 'openai'), legacy: LEGACY, makePersona: persona })!;
    expect(set.lastResort).toBeUndefined();
    expect(set.describe()).not.toMatch(/last_resort/);
  });

  it('is appended to the end of every chain, with the same persona builder as the tiers', () => {
    const makePersona = vi.fn(persona);
    const set = buildTiers({
      env: { ...LAST, FLINT_TIER_HARD: 'anthropic:claude-opus-4-1', FLINT_TIER_ROUTINE: 'anthropic:claude-haiku-4-5' },
      factory: factoryWith('anthropic', 'openai'),
      legacy: LEGACY,
      makePersona,
    })!;
    expect(set.chain('hard').map((b) => b.label)).toEqual([
      'anthropic:claude-opus-4-1',
      'anthropic:claude-sonnet-4-6',
      'anthropic:claude-haiku-4-5',
      'openai:gpt-5',
    ]);
    expect(set.chain('routine').map((b) => b.label)).toEqual(['anthropic:claude-haiku-4-5', 'anthropic:claude-sonnet-4-6', 'openai:gpt-5']);
    expect(set.lastResort).toMatchObject({ tier: 'last_resort', label: 'openai:gpt-5', persona: { id: 'openai:gpt-5' } });
    expect(makePersona.mock.calls.map(([p, m]) => `${p.name}:${m}`)).toContain('openai:gpt-5');
    expect(set.describe()).toMatch(/ last_resort=openai:gpt-5$/);
    // It never becomes a tier: the classifier's tiers are unchanged.
    expect(set.get('code').label).toBe('anthropic:claude-sonnet-4-6');
  });

  it('extends the single legacy brain too', () => {
    const set = buildTiers({ env: LAST, factory: factoryWith('anthropic', 'openai'), legacy: LEGACY, makePersona: persona })!;
    expect(set.chain('standard').map((b) => b.label)).toEqual(['anthropic:claude-sonnet-4-6', 'openai:gpt-5']);
    expect(set.tiered).toBe(false); // classification still can't change who answers first
  });

  it('is not repeated when a tier already is that brain', () => {
    const set = buildTiers({
      env: { ...LAST, FLINT_TIER_CODE: 'openai:gpt-5' },
      factory: factoryWith('anthropic', 'openai'),
      legacy: LEGACY,
      makePersona: persona,
    })!;
    expect(set.chain('code').map((b) => b.label)).toEqual(['openai:gpt-5', 'anthropic:claude-sonnet-4-6']);
    expect(set.chain('standard').map((b) => b.label)).toEqual(['anthropic:claude-sonnet-4-6', 'openai:gpt-5']);
  });

  it('is skipped (logged) without a key, ignored when malformed, and off with FLINT_TIERS=off', () => {
    const log = vi.fn();
    const noKey = buildTiers({ env: LAST, factory: factoryWith('anthropic'), legacy: LEGACY, makePersona: persona, log })!;
    expect(noKey.lastResort).toBeUndefined();
    expect(log.mock.calls.map((c) => c[0]).join('\n')).toMatch(/last resort skipped: openai/);

    const warn = vi.fn();
    expect(readLastResortSpec({ FLINT_TIER_LAST_RESORT: 'gpt-5' }, warn)).toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
    expect(readLastResortSpec({ ...LAST, FLINT_TIERS: 'off' })).toBeUndefined();
    const off = buildTiers({ env: { ...LAST, FLINT_TIERS: 'off' }, factory: factoryWith('anthropic', 'openai'), legacy: LEGACY, makePersona: persona })!;
    expect(off.chain('hard').map((b) => b.label)).toEqual(['anthropic:claude-sonnet-4-6']);
  });

  it('never makes a frontier on its own (no standard → still local-only)', () => {
    expect(buildTiers({ env: LAST, factory: factoryWith('openai'), legacy: undefined, makePersona: persona })).toBeUndefined();
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

describe('the frontier\'s Anthropic client fails fast', () => {
  it('no SDK retries and 60 s for a response to start, by default', () => {
    expect(frontierClientOptions({})).toEqual({ maxRetries: 0, timeoutMs: 60_000 });
    expect(FRONTIER_MAX_RETRIES).toBe(0);
    expect(FRONTIER_TIMEOUT_MS).toBe(60_000);
  });

  it('FLINT_FRONTIER_MAX_RETRIES / FLINT_FRONTIER_TIMEOUT_MS override them, within their ranges', () => {
    expect(frontierClientOptions({ FLINT_FRONTIER_MAX_RETRIES: '2', FLINT_FRONTIER_TIMEOUT_MS: ' 20000 ' })).toEqual({ maxRetries: 2, timeoutMs: 20_000 });
    const warn = vi.fn();
    for (const env of [
      { FLINT_FRONTIER_MAX_RETRIES: '-1' },
      { FLINT_FRONTIER_MAX_RETRIES: '6' },
      { FLINT_FRONTIER_MAX_RETRIES: 'two' },
      { FLINT_FRONTIER_MAX_RETRIES: '1.5' },
      { FLINT_FRONTIER_TIMEOUT_MS: '999' },
      { FLINT_FRONTIER_TIMEOUT_MS: '600001' },
      { FLINT_FRONTIER_TIMEOUT_MS: '30s' },
    ]) {
      expect(frontierClientOptions(env, warn), JSON.stringify(env)).toEqual({ maxRetries: 0, timeoutMs: 60_000 });
    }
    expect(warn).toHaveBeenCalledTimes(7);
    expect(warn.mock.calls[0]![0]).toBe('FLINT_FRONTIER_MAX_RETRIES="-1" is not a whole number from 0 to 5; using 0');
    // Blank is unset, not a mistake.
    expect(frontierClientOptions({ FLINT_FRONTIER_MAX_RETRIES: ' ' }, warn)).toEqual({ maxRetries: 0, timeoutMs: 60_000 });
    expect(warn).toHaveBeenCalledTimes(7);
  });

  // A loopback server stands in for the API: the SDK reads ANTHROPIC_BASE_URL, so the
  // clients the server really builds are the ones asked. Nothing leaves this machine.
  let api: Server | undefined;
  afterEach(async () => {
    vi.unstubAllEnvs();
    api?.closeAllConnections();
    await new Promise((r) => (api ? api.close(() => r(undefined)) : r(undefined)));
    api = undefined;
  });
  async function overloadedApi(): Promise<() => number> {
    let n = 0;
    api = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        n++;
        res.writeHead(529, { 'content-type': 'application/json', 'retry-after-ms': '1' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }));
      });
    });
    await new Promise<void>((r) => api!.listen(0, '127.0.0.1', r));
    vi.stubEnv('ANTHROPIC_BASE_URL', `http://127.0.0.1:${(api.address() as AddressInfo).port}`);
    return () => n;
  }
  const ask = { model: 'claude-test', messages: [{ id: 'm1', role: 'user' as const, content: 'hi', timestamp: 0 }] };
  const kindOf = async (p: ProviderAdapter) => p.generate(ask).then(() => 'answered', (e: unknown) => (isFlintError(e) ? `${e.kind} ${e.error.providerCode}` : 'other'));

  it('a tier\'s client (envProviderFactory) makes one request for one failing call', async () => {
    const requests = await overloadedApi();
    const p = envProviderFactory({ ANTHROPIC_API_KEY: 'sk-ant-test' })('anthropic')!;
    expect(await kindOf(p)).toBe('provider_unavailable 529');
    expect(requests()).toBe(1);
  });

  it('so does the legacy frontier\'s (buildFrontierProvider), and the env can give it retries back', async () => {
    const requests = await overloadedApi();
    const legacy = buildFrontierProvider({ ANTHROPIC_API_KEY: 'sk-ant-test' })!;
    expect(legacy.model).toBe('claude-sonnet-4-6');
    expect(await kindOf(legacy.provider)).toBe('provider_unavailable 529');
    expect(requests()).toBe(1);
    const retrying = buildFrontierProvider({ ANTHROPIC_API_KEY: 'sk-ant-test', FLINT_FRONTIER_MAX_RETRIES: '2' })!;
    await kindOf(retrying.provider);
    expect(requests()).toBe(1 + 3);
  });
});

describe('buildFrontierProvider (the legacy frontier)', () => {
  it('Claude while there is a key, on FLINT_FRONTIER_MODEL or Sonnet', () => {
    expect(buildFrontierProvider({ ANTHROPIC_API_KEY: ' sk-ant-test ' })).toMatchObject({ model: 'claude-sonnet-4-6', provider: { name: 'anthropic' } });
    expect(buildFrontierProvider({ ANTHROPIC_API_KEY: 'sk-ant-test', FLINT_FRONTIER_MODEL: 'claude-opus-5-5' })?.model).toBe('claude-opus-5-5');
  });

  it('a self-hosted model when Will points it at one, key or no key', () => {
    const own = { FLINT_FRONTIER_PROVIDER: 'ollama', FLINT_FRONTIER_BASE_URL: 'http://box:11434', FLINT_FRONTIER_MODEL: 'big:70b' };
    expect(buildFrontierProvider({ ...own, ANTHROPIC_API_KEY: 'sk-ant-test' })).toMatchObject({ model: 'big:70b', provider: { name: 'ollama' } });
    expect(buildFrontierProvider({ FLINT_FRONTIER_BASE_URL: 'http://box:11434', FLINT_FRONTIER_MODEL: 'big:70b' })).toMatchObject({ provider: { name: 'ollama' } });
    expect(buildFrontierProvider({ FLINT_FRONTIER_PROVIDER: 'ollama' })).toBeUndefined(); // no model named
  });

  it('nothing configured: no frontier (pure local)', () => {
    expect(buildFrontierProvider({})).toBeUndefined();
    expect(buildFrontierProvider({ ANTHROPIC_API_KEY: '  ' })).toBeUndefined();
  });
});

describe('BrainSet.cheapestOn (the brain the breaker\'s check asks)', () => {
  it('the routine tier\'s brain on that provider, else any tier\'s, else the last resort', () => {
    const set = buildTiers({
      env: { FLINT_TIER_HARD: 'anthropic:claude-opus-4-1', FLINT_TIER_ROUTINE: 'anthropic:claude-haiku-4-5', FLINT_TIER_CODE: 'perplexity:sonar', FLINT_TIER_LAST_RESORT: 'openai:gpt-5' },
      factory: factoryWith('anthropic', 'openai', 'perplexity'),
      legacy: LEGACY,
      makePersona: persona,
    })!;
    expect(set.cheapestOn('anthropic')?.label).toBe('anthropic:claude-haiku-4-5');
    expect(set.cheapestOn('perplexity')?.label).toBe('perplexity:sonar');
    expect(set.cheapestOn('openai')?.label).toBe('openai:gpt-5');
    expect(set.cheapestOn('ollama')).toBeUndefined();
    // One model's own pause is checked on that model.
    expect(set.cheapestOn('anthropic', 'claude-opus-4-1')?.label).toBe('anthropic:claude-opus-4-1');
    expect(set.cheapestOn('anthropic', 'claude-nope')).toBeUndefined();
  });

  it('with defaults it is the one legacy frontier', () => {
    const set = buildTiers({ env: {}, factory: factoryWith('anthropic'), legacy: LEGACY, makePersona: persona })!;
    expect(set.cheapestOn('anthropic')?.label).toBe('anthropic:claude-sonnet-4-6');
  });
});

describe("envProviderFactory: 'local', an OpenAI-compatible local server as a tier", () => {
  it('builds the local adapter at FLINT_LOCAL_BASE_URL, one instance for every tier on it', () => {
    const factory = envProviderFactory({ FLINT_LOCAL_BASE_URL: 'http://127.0.0.1:8080/v1' });
    const p = factory('local');
    expect(p?.name).toBe('local');
    expect(factory('local')).toBe(p);
    // Not probed: no tools unless Will says the model can call them, and a modest window.
    expect(p!.getCapabilities('any')).toMatchObject({ toolCalling: 'unsupported', maxContextTokens: 8192 });
    const on = envProviderFactory({ FLINT_LOCAL_TOOLS: 'on', FLINT_FRONTIER_NUM_CTX: '32768' })('local');
    expect(on!.getCapabilities('any')).toMatchObject({ toolCalling: 'native', maxContextTokens: 32768 });
  });

  // The final review's L6: this site read the number as it came ("1e9" was a billion-token window).
  it('its window is a context size by the one rule: a value that is not one is the default, never a guess', () => {
    for (const bad of ['1e9', '99999999999', '8192.5', '-1', '0', 'big', '100', '']) {
      const p = envProviderFactory({ FLINT_FRONTIER_NUM_CTX: bad })('local');
      expect(p!.getCapabilities('any').maxContextTokens, bad).toBe(8192);
    }
    expect(envProviderFactory({ FLINT_FRONTIER_NUM_CTX: '4096' })('local')!.getCapabilities('any').maxContextTokens).toBe(4096);
  });

  it('an address that is not this Mac builds nothing, so the tier resolves like one with no key', () => {
    expect(envProviderFactory({ FLINT_LOCAL_BASE_URL: 'http://10.0.0.9:8080/v1' })('local')).toBeUndefined();
    // Another machine needs Will's say, and https (or his word that the network is private).
    expect(envProviderFactory({ FLINT_LOCAL_BASE_URL: 'http://10.0.0.9:8080/v1', FLINT_LOCAL_ALLOW_REMOTE: '1' })('local')).toBeUndefined();
    expect(envProviderFactory({ FLINT_LOCAL_BASE_URL: 'https://10.0.0.9:8443/v1', FLINT_LOCAL_ALLOW_REMOTE: '1' })('local')?.name).toBe('local');
    expect(envProviderFactory({ FLINT_LOCAL_BASE_URL: 'http://10.0.0.9:8080/v1', FLINT_LOCAL_ALLOW_REMOTE: '1', FLINT_LOCAL_ALLOW_INSECURE_REMOTE: '1' })('local')?.name).toBe('local');
  });
});

// A review (2026-10-13): the main model and the standby no longer repeat what their model server says when it
// fails (../src/local-errors), and a tier brain on the same kind of server still did.
describe('a tier brain on a local wire: what its model server says when it fails is not repeated', () => {
  let server: Server | undefined;
  afterEach(async () => {
    await new Promise((r) => (server ? server.close(r) : r(undefined)));
    server = undefined;
  });
  /** A model server that answers every request with an error that repeats the request. */
  const echoing = async (): Promise<string> => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (d: Buffer) => (body += d.toString()));
      req.on('end', () => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: `decode failed ECHOMARK ${body.slice(0, 4000)}` }));
      });
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };
  const args = { model: 'big:70b', messages: [{ id: 'u', role: 'user' as const, content: 'TIERSECRETQ what is this?', timestamp: 0 }] };
  const failure = (p: ProviderAdapter): Promise<unknown> =>
    p.generate(args).then(
      () => undefined,
      (e: unknown) => e,
    );

  it('the ollama tier, the OpenAI-compatible tier and a legacy frontier on a server of Will’s own: the class, a fixed sentence, none of the request', async () => {
    const origin = await echoing();
    // (Bare, the adapter does repeat it: this is what the wrap is for.)
    const bare = await failure(new OllamaProvider({ baseURL: origin }));
    expect(isFlintError(bare) && bare.error.message).toContain('TIERSECRETQ');
    const brains: Array<[string, ProviderAdapter]> = [
      ['the ollama tier', envProviderFactory({ FLINT_TIER_OLLAMA_HOST: origin })('ollama')!],
      ['the local tier', envProviderFactory({ FLINT_LOCAL_BASE_URL: `${origin}/v1` })('local')!],
      ['the legacy frontier', buildFrontierProvider({ FLINT_FRONTIER_PROVIDER: 'ollama', FLINT_FRONTIER_BASE_URL: origin, FLINT_FRONTIER_MODEL: 'big:70b' })!.provider],
    ];
    for (const [what, p] of brains) {
      const err = await failure(p);
      expect(isFlintError(err), what).toBe(true);
      if (!isFlintError(err)) continue;
      expect(JSON.stringify(err.error), what).not.toMatch(/ECHOMARK|TIERSECRETQ|decode failed/);
      expect(err.error.message, what).toBe(LOCAL_ERROR_SENTENCES[err.error.kind]);
      // Its class is kept: the chain moves on to the next brain as it did.
      expect(shouldFallBack(err), what).toBe(true);
      const events: unknown[] = [];
      for await (const ev of p.stream(args)) events.push(ev);
      expect(JSON.stringify(events), what).not.toMatch(/ECHOMARK|TIERSECRETQ|decode failed/);
      expect(events.at(-1), what).toMatchObject({ type: 'error' });
    }
    // Where the brain is, and its window, still read through the wrap: that is what says whether it is on this Mac.
    expect(brainOf(brains[0]![1], 'big:70b')).toEqual({ provider: 'ollama', model: 'big:70b', baseURL: origin, numCtx: 8192 });
    expect(brainOf(brains[2]![1], 'big:70b')).toEqual({ provider: 'ollama', model: 'big:70b', baseURL: origin, numCtx: 8192 });
    expect(brainOf(brains[1]![1], 'm')).toMatchObject({ provider: 'local', baseURL: `${origin}/v1` });
  });
});
