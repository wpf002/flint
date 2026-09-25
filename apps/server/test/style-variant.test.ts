import { describe, expect, it } from 'vitest';
import { Flint, type GenerateArgs, type ProviderAdapter, type StreamEvent } from '@flint/core';
import { FLINT_LOCAL_STYLE_GUIDE, FLINT_STYLE_GUIDE, FLINT_STYLE_GUIDE_V2, Persona } from '@flint/persona';
import {
  DEFAULT_STYLE_VARIANT,
  STYLE_VARIANTS,
  StyledPersonas,
  chooseStyles,
  parseStyleVariantRequest,
  readStyleDefaults,
  styleEcho,
  styleGuideFor,
  type StyleDefaults,
  type StyleVariant,
} from '../src/style-variant';
import { LocalPersonaCache, resolveLocalPersona } from '../src/local-model';

const V1: StyleDefaults = { frontier: 'v1', local: 'v1' };

describe('the known variants', () => {
  it('are v1, v2 and local-v1, each its own guide (what /health reports)', () => {
    expect(STYLE_VARIANTS).toEqual(['v1', 'v2', 'local-v1']);
    expect(DEFAULT_STYLE_VARIANT).toBe('v1');
    expect(styleGuideFor('v1')).toBe(FLINT_STYLE_GUIDE);
    expect(styleGuideFor('v2')).toBe(FLINT_STYLE_GUIDE_V2);
    expect(styleGuideFor('local-v1')).toBe(FLINT_LOCAL_STYLE_GUIDE);
  });
});

describe('parseStyleVariantRequest', () => {
  it('is a no-op when no variant is asked for (normal traffic)', () => {
    for (const body of [{ prompt: 'hi' }, { prompt: 'hi', eval: true }, { prompt: 'hi', styleVariant: null }, { eval: true, localOnly: true, localModel: 'qwen3.8:27b' }]) {
      expect(parseStyleVariantRequest(body), JSON.stringify(body)).toEqual({ ok: true, variant: undefined });
    }
  });

  it('accepts every known variant with eval: true, on either brain', () => {
    for (const v of STYLE_VARIANTS) {
      expect(parseStyleVariantRequest({ eval: true, styleVariant: v })).toEqual({ ok: true, variant: v });
      expect(parseStyleVariantRequest({ eval: true, localOnly: true, styleVariant: v })).toEqual({ ok: true, variant: v });
      expect(parseStyleVariantRequest({ eval: true, localOnly: true, localModel: 'muse-glimmer:30b', localThink: false, styleVariant: v })).toEqual({ ok: true, variant: v });
    }
  });

  it('refuses a variant without eval: true', () => {
    for (const body of [{ styleVariant: 'v2' }, { eval: 'true', styleVariant: 'v2' }, { eval: false, styleVariant: 'v1' }, { localOnly: true, styleVariant: 'local-v1' }]) {
      const r = parseStyleVariantRequest(body);
      expect(r, JSON.stringify(body)).toMatchObject({ ok: false, status: 400 });
      if (!r.ok) expect(r.error).toMatch(/only accepted with eval: true/);
    }
  });

  it('refuses an unknown variant, naming the known ones', () => {
    for (const bad of ['v3', 'V2', ' v2', 'v2 ', '', 'local', 'toString', '__proto__']) {
      const r = parseStyleVariantRequest({ eval: true, styleVariant: bad });
      expect(r, JSON.stringify(bad)).toMatchObject({ ok: false, status: 400 });
      if (!r.ok) expect(r.error).toMatch(/unknown styleVariant.*known: v1, v2, local-v1/);
    }
  });

  it('refuses a variant that is not a string', () => {
    for (const bad of [2, true, {}, ['v2']]) {
      const r = parseStyleVariantRequest({ eval: true, styleVariant: bad });
      expect(r, JSON.stringify(bad)).toMatchObject({ ok: false, status: 400 });
      if (!r.ok) expect(r.error).toMatch(/must be a string/);
    }
  });

  it('checks the value before the eval rule, like localModel', () => {
    const r = parseStyleVariantRequest({ styleVariant: 'v9' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/unknown styleVariant/);
  });
});

describe('readStyleDefaults (FLINT_STYLE_VARIANT / FLINT_LOCAL_STYLE_VARIANT)', () => {
  it('is v1 for both brains when unset or blank, and logs nothing', () => {
    const logs: string[] = [];
    for (const env of [{}, { FLINT_STYLE_VARIANT: '', FLINT_LOCAL_STYLE_VARIANT: '  ' }]) {
      expect(readStyleDefaults(env, (m) => logs.push(m))).toEqual(V1);
    }
    expect(logs).toEqual([]);
  });

  it('takes each brain from its own var, trimmed, and logs what it selected', () => {
    const logs: string[] = [];
    expect(readStyleDefaults({ FLINT_STYLE_VARIANT: 'v2' }, (m) => logs.push(m))).toEqual({ frontier: 'v2', local: 'v1' });
    expect(readStyleDefaults({ FLINT_LOCAL_STYLE_VARIANT: ' local-v1 ' }, (m) => logs.push(m))).toEqual({ frontier: 'v1', local: 'local-v1' });
    expect(readStyleDefaults({ FLINT_STYLE_VARIANT: 'v2', FLINT_LOCAL_STYLE_VARIANT: 'v2' })).toEqual({ frontier: 'v2', local: 'v2' });
    expect(logs).toEqual(['[style] frontier style variant v2 (FLINT_STYLE_VARIANT)', '[style] local style variant local-v1 (FLINT_LOCAL_STYLE_VARIANT)']);
  });

  it('falls back to v1 on an unknown value, and says so', () => {
    const logs: string[] = [];
    expect(readStyleDefaults({ FLINT_STYLE_VARIANT: 'V2', FLINT_LOCAL_STYLE_VARIANT: 'local' }, (m) => logs.push(m))).toEqual(V1);
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatch(/FLINT_STYLE_VARIANT="V2" is not one of v1, v2, local-v1; frontier uses v1/);
    expect(logs[1]).toMatch(/FLINT_LOCAL_STYLE_VARIANT="local" is not one of .*; local uses v1/);
  });
});

describe('chooseStyles and styleEcho', () => {
  const live: StyleDefaults = { frontier: 'v2', local: 'v1' };

  it("uses each brain's live default without a request", () => {
    expect(chooseStyles(undefined, live)).toEqual(live);
    expect(styleEcho('frontier', chooseStyles(undefined, live))).toBe('v2');
    expect(styleEcho('local', chooseStyles(undefined, live))).toBe('v1');
  });

  it('applies a requested variant to whichever brain answers, fallback included', () => {
    const chosen = chooseStyles('local-v1', live);
    expect(chosen).toEqual({ frontier: 'local-v1', local: 'local-v1' });
    expect(styleEcho('frontier', chosen)).toBe('local-v1');
    expect(styleEcho('local', chosen)).toBe('local-v1');
  });
});

/** A provider that records the system prompt of every call. */
function capture(name = 'capture'): { provider: ProviderAdapter; systems: string[] } {
  const systems: string[] = [];
  const provider: ProviderAdapter = {
    name,
    getCapabilities: () => ({ toolCalling: 'native', structuredOutput: 'native', streaming: 'full', maxContextTokens: 100_000, maxOutputTokens: 4096 }),
    estimateTokens: (m) => m.reduce((n, x) => n + x.content.length, 0),
    async generate(args: GenerateArgs) {
      systems.push(args.system ?? '');
      return { message: { id: 'm', role: 'assistant' as const, content: 'ok', timestamp: 0 }, usage: { input: 1, output: 1 }, reason: 'complete' as const };
    },
    async *stream(args: GenerateArgs): AsyncIterable<StreamEvent> {
      systems.push(args.system ?? '');
      yield { type: 'done', reason: 'complete', usage: { input: 0, output: 0 } };
    },
  };
  return { provider, systems };
}

describe('StyledPersonas', () => {
  type Fake = { variant: StyleVariant; who: string };
  const setup = (defaults: StyleDefaults) => {
    const built: string[] = [];
    const livePersona: Fake = { variant: defaults.local, who: 'local' };
    const tier = { label: 'anthropic:claude-opus-5', provider: capture('anthropic').provider, model: 'claude-opus-5', persona: { variant: defaults.frontier, who: 'tier' } as Fake };
    const styled = new StyledPersonas<Fake>(defaults, {
      local: livePersona,
      buildLocal: (v) => (built.push(`local#${v}`), { variant: v, who: 'local' }),
      buildFrontier: (p, m, v) => (built.push(`${p.name}:${m}#${v}`), { variant: v, who: `${p.name}:${m}` }),
    });
    return { styled, built, livePersona, tier };
  };

  it("hands back the live personas for the default variants, building nothing (all live traffic)", () => {
    const { styled, built, livePersona, tier } = setup(V1);
    expect(styled.local('v1')).toBe(livePersona);
    expect(styled.frontier(tier, 'v1')).toBe(tier.persona);
    expect(built).toEqual([]);
    expect(styled.size).toBe(0);
  });

  it('builds another variant once per brain and reuses it', () => {
    const { styled, built, tier } = setup(V1);
    const other = { ...tier, label: 'anthropic:claude-sonnet-5', model: 'claude-sonnet-5' };
    const a = styled.frontier(tier, 'v2');
    expect(a).toEqual({ variant: 'v2', who: 'anthropic:claude-opus-5' });
    expect(styled.frontier(tier, 'v2')).toBe(a);
    expect(styled.frontier(other, 'v2')).not.toBe(a);
    const l = styled.local('local-v1');
    expect(l).toEqual({ variant: 'local-v1', who: 'local' });
    expect(styled.local('local-v1')).toBe(l);
    expect(built).toEqual(['anthropic:claude-opus-5#v2', 'anthropic:claude-sonnet-5#v2', 'local#local-v1']);
    expect(styled.size).toBe(3);
  });

  it('follows the env defaults: with FLINT_STYLE_VARIANT=v2 the tier persona is the v2 one and v1 is built', () => {
    const { styled, built, livePersona, tier } = setup({ frontier: 'v2', local: 'local-v1' });
    expect(styled.frontier(tier, 'v2')).toBe(tier.persona);
    expect(styled.local('local-v1')).toBe(livePersona);
    expect(styled.frontier(tier, 'v1')).toEqual({ variant: 'v1', who: 'anthropic:claude-opus-5' });
    expect(built).toEqual(['anthropic:claude-opus-5#v1']);
  });

  it('with real personas, the requested guide is the system prompt each brain answers with', async () => {
    const local = capture('ollama');
    const front = capture('anthropic');
    const localFlint = new Flint({ provider: local.provider, defaultModel: 'qwen2.5:7b' });
    const make = (f: Flint, v: StyleVariant) => new Persona(f, { name: 'Flint', styleGuide: styleGuideFor(v) });
    const tier = { label: 'anthropic:claude-opus-5', provider: front.provider, model: 'claude-opus-5', persona: make(new Flint({ provider: front.provider, defaultModel: 'claude-opus-5' }), 'v1') };
    const styled = new StyledPersonas<Persona>(V1, {
      local: make(localFlint, 'v1'),
      buildLocal: (v) => make(localFlint, v),
      buildFrontier: (p, m, v) => make(new Flint({ provider: p, defaultModel: m }), v),
    });

    const ask = (p: Persona) => p.generate({ prompt: 'When did the Western Roman Empire fall?' });
    await ask(styled.frontier(tier, chooseStyles(undefined, V1).frontier));
    await ask(styled.frontier(tier, chooseStyles('v2', V1).frontier));
    await ask(styled.local(chooseStyles(undefined, V1).local));
    await ask(styled.local(chooseStyles('local-v1', V1).local));

    expect(front.systems).toHaveLength(2);
    expect(front.systems[0]).toContain(FLINT_STYLE_GUIDE);
    expect(front.systems[1]).toContain(FLINT_STYLE_GUIDE_V2);
    expect(front.systems[1]).not.toContain('A three-word answer is a fine answer.');
    expect(local.systems[0]).toContain(FLINT_STYLE_GUIDE);
    expect(local.systems[1]).toContain(FLINT_LOCAL_STYLE_GUIDE);
    expect(local.systems[1]).not.toContain('YOU REMEMBER, AND YOU GROW');
  });
});

describe('style variants on the eval local-model override personas', () => {
  it('builds one override persona per variant and resolves the one the turn asked for', () => {
    const made: string[] = [];
    const cache = new LocalPersonaCache((m, think, variant) => {
      made.push(`${m}/${String(think)}/${String(variant)}`);
      return { persona: `${m}:${String(variant)}`, think };
    });
    const base = { persona: 'main', model: 'qwen2.5:7b' };
    const turn = (requested: StyleVariant | undefined) => chooseStyles(requested, { frontier: 'v1', local: 'v1' }).local;

    expect(resolveLocalPersona('muse-glimmer:30b', base, cache, false, turn(undefined))).toMatchObject({ ok: true, persona: 'muse-glimmer:30b:v1', think: false });
    expect(resolveLocalPersona('muse-glimmer:30b', base, cache, false, turn('local-v1'))).toMatchObject({ ok: true, persona: 'muse-glimmer:30b:local-v1', think: false });
    expect(resolveLocalPersona('muse-glimmer:30b', base, cache, false, turn('local-v1'))).toMatchObject({ persona: 'muse-glimmer:30b:local-v1' });
    expect(made).toEqual(['muse-glimmer:30b/false/v1', 'muse-glimmer:30b/false/local-v1']);
  });
});
