import { describe, it, expect, afterEach, vi } from 'vitest';
import { analyse, compareVersions, familyOf, isServed, parseTier } from '../src/discover';
import { allCatalogs, wantsVendors } from '../src/vendors';

const cat = (vendor: string, ids: string[]) => ({ vendor, models: ids.map((id) => ({ id })) });

describe('parseTier', () => {
  it('splits provider from model', () => {
    expect(parseTier('FLINT_TIER_CODE', 'openai:gpt-5.2-codex')).toEqual({
      tier: 'code',
      provider: 'openai',
      model: 'gpt-5.2-codex',
    });
  });

  it('keeps colons inside the model id (ollama tags)', () => {
    expect(parseTier('FLINT_TIER_ROUTINE', 'ollama:qwen2.5:72b')?.model).toBe('qwen2.5:72b');
  });

  it('rejects malformed values', () => {
    for (const v of ['', 'openai', 'openai:', ':gpt-5']) expect(parseTier('FLINT_TIER_HARD', v)).toBeUndefined();
  });
});

describe('isServed', () => {
  // The bug this whole app exists for: gpt-5.2-codex starts with gpt-5.2, which
  // IS served, but the codex id itself is deprecated. Prefix matching here would
  // have hidden it.
  it('does not treat a served prefix as the model being served', () => {
    const c = cat('openai', ['gpt-5.2', 'gpt-5.6-sol']);
    expect(isServed(c, 'gpt-5.2-codex')).toBe(false);
    expect(isServed(c, 'gpt-5.2')).toBe(true);
  });

  it('ignores the models/ prefix Gemini returns', () => {
    expect(isServed(cat('google', ['models/gemini-3.8-flash']), 'gemini-3.8-flash')).toBe(true);
  });
});

describe('compareVersions', () => {
  it('orders within and across families', () => {
    expect(compareVersions('gpt-5.5', 'gpt-5.6')).toBe(1); // b is newer
    expect(compareVersions('gpt-5.6', 'gpt-6')).toBe(1);
    expect(compareVersions('gpt-5.6', 'gpt-5.5')).toBe(-1);
    expect(compareVersions('gpt-5.6', 'gpt-5.6')).toBe(0);
  });
});

describe('familyOf', () => {
  it('strips the version, keeping the line', () => {
    expect(familyOf('gpt-5.6-sol')).toBe('gpt');
    expect(familyOf('claude-opus-5-5')).toBe('claude-opus');
    expect(familyOf('models/gemini-3.8-flash')).toBe('gemini');
  });
});

describe('analyse', () => {
  const tiers = [{ tier: 'code', provider: 'openai', model: 'gpt-5.2-codex' }];

  it('flags a tier whose model the vendor no longer serves', () => {
    const f = analyse({ tiers, catalogs: [cat('openai', ['gpt-5.6-sol', 'gpt-5.2'])] });
    expect(f[0]?.kind).toBe('dead-config');
    expect(f[0]?.severity).toBe('high');
    expect(f[0]?.detail).toContain('gpt-5.2-codex');
  });

  it('stays silent when the vendor could not be reached', () => {
    const f = analyse({ tiers, catalogs: [{ vendor: 'openai', models: [], error: 'HTTP 500' }] });
    expect(f).toEqual([]);
  });

  it('flags a newer model in the same family', () => {
    const f = analyse({
      tiers: [{ tier: 'hard', provider: 'openai', model: 'gpt-5.5' }],
      catalogs: [cat('openai', ['gpt-5.5', 'gpt-5.6-sol', 'gpt-6-sol'])],
    });
    expect(f.some((x) => x.kind === 'missed-upgrade' && x.detail.includes('gpt-6-sol'))).toBe(true);
  });

  it('says nothing when the tier is current', () => {
    const f = analyse({
      tiers: [{ tier: 'hard', provider: 'openai', model: 'gpt-5.6-sol' }],
      catalogs: [cat('openai', ['gpt-5.5', 'gpt-5.6-sol'])],
    });
    expect(f).toEqual([]);
  });

  it('reports what changed since last night, both ways', () => {
    const f = analyse({
      tiers: [],
      catalogs: [cat('openai', ['gpt-5.6-sol', 'gpt-6-sol'])],
      previous: { openai: ['gpt-5.6-sol', 'gpt-5.2-codex'] },
    });
    expect(f.some((x) => x.kind === 'new-model' && x.detail.includes('gpt-6-sol'))).toBe(true);
    expect(f.some((x) => x.kind === 'removed-model' && x.detail.includes('gpt-5.2-codex'))).toBe(true);
  });

  // An empty history must not read as "the vendor deleted everything".
  it('treats a first sighting as news-free', () => {
    const f = analyse({ tiers: [], catalogs: [cat('openai', ['gpt-5.6-sol'])], previous: { openai: [] } });
    expect(f).toEqual([]);
  });
});

// `evolve discover` looks at the models on this Mac. The vendors' lists are free, but they are
// calls to outside AI companies with Will's keys, so they need the flag.
describe('allCatalogs (what discover asks)', () => {
  afterEach(() => vi.unstubAllGlobals());

  const KEYS = { OPENAI_API_KEY: 'sk-test', ANTHROPIC_API_KEY: 'sk-ant-test', GEMINI_API_KEY: 'g-test', OLLAMA_HOST: 'http://127.0.0.1:11434' };

  /** Stands in for global fetch: records each URL, answers every list as empty-but-valid. */
  function recordFetch() {
    const asked: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      asked.push(String(url));
      const body = String(url).includes('/api/tags') ? { models: [{ name: 'qwen3.8:27b', modified_at: '2026-10-01T00:00:00Z' }] } : { data: [], models: [] };
      return new Response(JSON.stringify(body), { status: 200 });
    });
    return asked;
  }

  it('by default asks only the local Ollama, even with every vendor key set', async () => {
    const asked = recordFetch();
    const cats = await allCatalogs(KEYS);
    expect(cats.map((c) => c.vendor)).toEqual(['ollama']);
    expect(cats[0]!.models.map((m) => m.id)).toEqual(['qwen3.8:27b']);
    expect(asked).toEqual(['http://127.0.0.1:11434/api/tags']);
  });

  it('with vendors: true also asks each vendor for its model list', async () => {
    const asked = recordFetch();
    const cats = await allCatalogs(KEYS, { vendors: true });
    expect(cats.map((c) => c.vendor).sort()).toEqual(['anthropic', 'google', 'ollama', 'openai']);
    expect(asked.some((u) => u.startsWith('https://api.openai.com/'))).toBe(true);
    expect(asked.some((u) => u.startsWith('https://api.anthropic.com/'))).toBe(true);
    expect(asked).toHaveLength(4);
  });

  it('the flag is --vendors, exactly, and off without it', () => {
    expect(wantsVendors([])).toBe(false);
    expect(wantsVendors(['--vendor', 'vendors', '--VENDORS', '--vendors=1'])).toBe(false);
    expect(wantsVendors(['--vendors'])).toBe(true);
  });

  // A tier on an outside vendor is neither confirmed nor reported dead when its list was not asked for.
  it('a tier whose vendor was not asked produces no finding', async () => {
    recordFetch();
    const catalogs = await allCatalogs(KEYS);
    expect(analyse({ tiers: [{ tier: 'code', provider: 'openai', model: 'gpt-5.2-codex' }, { tier: 'routine', provider: 'ollama', model: 'qwen3.8:27b' }], catalogs })).toEqual([]);
    // ...while a local tier that is not pulled is still caught.
    const dead = analyse({ tiers: [{ tier: 'routine', provider: 'ollama', model: 'qwen2.5:14b' }], catalogs });
    expect(dead).toHaveLength(1);
    expect(dead[0]).toMatchObject({ kind: 'dead-config', severity: 'high' });
  });
});
