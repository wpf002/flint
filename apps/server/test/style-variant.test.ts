import { describe, expect, it } from 'vitest';
import { Flint, type GenerateArgs, type ProviderAdapter, type StreamEvent } from '@flint/core';
import { FLINT_LOCAL_STYLE_GUIDE, FLINT_STYLE_GUIDE, FLINT_STYLE_GUIDE_V2, Persona } from '@flint/persona';
import {
  DEFAULT_STYLE_VARIANT,
  STYLE_VARIANTS,
  StyledPersonas,
  chooseStyles,
  echoStyle,
  parseStyleVariantRequest,
  readStyleDefaults,
  styleGuideFor,
  styleVariantOf,
  turnPersonas,
  type StyleDefaults,
  type StyleVariant,
  type TurnRequest,
} from '../src/style-variant';
import { LocalPersonaCache, overridePersonaCache, resolveLocalPersona } from '../src/local-model';
import { runWithFallback, type BrainTier } from '../src/brains';

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

describe('chooseStyles', () => {
  const live: StyleDefaults = { frontier: 'v2', local: 'v1' };

  it("uses each brain's live default without a request", () => {
    expect(chooseStyles(undefined, live)).toEqual(live);
  });

  it('applies a requested variant to whichever brain answers, fallback included', () => {
    expect(chooseStyles('local-v1', live)).toEqual({ frontier: 'local-v1', local: 'local-v1' });
  });
});

describe('styleVariantOf: the variant a persona speaks with, from its own guide', () => {
  it("maps each variant's guide back to its name", () => {
    for (const v of STYLE_VARIANTS) expect(styleVariantOf({ styleGuide: styleGuideFor(v) })).toBe(v);
  });

  it('reads a real Persona', () => {
    const f = new Flint({ provider: capture().provider, defaultModel: 'm' });
    expect(styleVariantOf(new Persona(f, { name: 'Flint', styleGuide: FLINT_STYLE_GUIDE_V2 }))).toBe('v2');
  });

  it('names no variant for any other text, an edited guide included', () => {
    const edited = FLINT_STYLE_GUIDE_V2.replace('A search there adds latency and thin sources, not accuracy.', 'A search there adds latency.');
    expect(edited).not.toBe(FLINT_STYLE_GUIDE_V2);
    for (const g of ['', 'You are Flint.', `${FLINT_STYLE_GUIDE} `, edited]) {
      expect(styleVariantOf({ styleGuide: g })).toBeUndefined();
    }
  });
});

describe('echoStyle: the echo names the persona that answered, not the request', () => {
  const guide = (v: StyleVariant) => ({ styleGuide: styleGuideFor(v) });

  it('is undefined until a call has returned', async () => {
    const e = echoStyle(async (_p: { styleGuide: string }) => 'ok');
    expect(e.styleVariant()).toBeUndefined();
    await e.ask(guide('v2'));
    expect(e.styleVariant()).toBe('v2');
  });

  it('names the last persona whose call returned; one that threw (and fell back) does not count', async () => {
    const e = echoStyle(async (p: { styleGuide: string }) => {
      if (p.styleGuide === FLINT_STYLE_GUIDE_V2) throw new Error('down');
      return 'ok';
    });
    await e.ask(guide('local-v1'));
    await expect(e.ask(guide('v2'))).rejects.toThrow('down');
    expect(e.styleVariant()).toBe('local-v1');
  });

  it('echoes v1 when a v2 turn is answered by a v1 persona (wiring that skips turnPersonas)', async () => {
    // The request-derived echo this replaces said "v2" here, so apps/parity would
    // have filed v1 answers under flint#v2 and its echo check could never fire.
    const { styled, tier } = realServer(V1);
    const turn = turnPersonas({ styleVariant: 'v2', localModel: undefined, localThink: undefined }, { styled, model: 'qwen2.5:7b', localModels: undefined });
    if (!turn.ok) throw new Error(turn.error);
    const e = echoStyle((p: Persona) => p.generate({ prompt: 'hi' }));
    await e.ask(tier.persona); // bypass: the tier's own (live, v1) persona
    expect(e.styleVariant()).toBe('v1');
    await e.ask(turn.frontier(tier)); // the persona the turn chose
    expect(e.styleVariant()).toBe('v2');
    await e.ask(styled.local('v1')); // bypass on the local side
    expect(e.styleVariant()).toBe('v1');
    await e.ask(turn.local.persona);
    expect(e.styleVariant()).toBe('v2');
  });

  it('names no variant for a persona whose guide is not a known one', async () => {
    const e = echoStyle(async (_p: { styleGuide: string }) => 'ok');
    await e.ask({ styleGuide: 'something else' });
    expect(e.styleVariant()).toBeUndefined();
  });
});

/** A provider that records the system prompt of every call; with `down.on`, every call throws (after recording). */
function capture(name = 'capture'): { provider: ProviderAdapter; systems: string[]; down: { on: boolean } } {
  const systems: string[] = [];
  const down = { on: false };
  const provider: ProviderAdapter = {
    name,
    getCapabilities: () => ({ toolCalling: 'native', structuredOutput: 'native', streaming: 'full', maxContextTokens: 100_000, maxOutputTokens: 4096 }),
    estimateTokens: (m) => m.reduce((n, x) => n + x.content.length, 0),
    async generate(args: GenerateArgs) {
      systems.push(args.system ?? '');
      if (down.on) throw new Error(`${name} is down`);
      return { message: { id: 'm', role: 'assistant' as const, content: `answer from ${name}`, timestamp: 0 }, usage: { input: 1, output: 1 }, reason: 'complete' as const };
    },
    async *stream(args: GenerateArgs): AsyncIterable<StreamEvent> {
      systems.push(args.system ?? '');
      if (down.on) throw new Error(`${name} is down`);
      yield { type: 'text', delta: `answer from ${name}` };
      yield { type: 'done', reason: 'complete', usage: { input: 1, output: 1 } };
    },
  };
  return { provider, systems, down };
}

/** An Ollama /api/chat stand-in (never the real one) that records each request's system message. */
function captureOllama(): { fetch: typeof globalThis.fetch; systems: string[] } {
  const systems: string[] = [];
  const fetch = (async (_u: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { model: string; messages: Array<{ role: string; content: string }> };
    systems.push(body.messages.find((m) => m.role === 'system')?.content ?? '');
    return new Response(
      JSON.stringify({ model: body.model, message: { role: 'assistant', content: 'answer from override' }, done: true, done_reason: 'stop', prompt_eval_count: 1, eval_count: 1 }),
    );
  }) as unknown as typeof globalThis.fetch;
  return { fetch, systems };
}

/**
 * The persona wiring main() builds, on capture providers: the local persona, two
 * frontier tiers (each with its own persona in the frontier default), the
 * StyledPersonas over them, and the eval local-model override cache over a fake
 * Ollama fetch.
 */
function realServer(defaults: StyleDefaults) {
  const local = capture('ollama');
  const opus = capture('anthropic-opus');
  const sonnet = capture('anthropic-sonnet');
  const ollama = captureOllama();
  const make = (f: Flint, v: StyleVariant) => new Persona(f, { name: 'Flint', styleGuide: styleGuideFor(v) });
  const localFlint = new Flint({ provider: local.provider, defaultModel: 'qwen2.5:7b' });
  const frontierPersona = (p: ProviderAdapter, m: string, v: StyleVariant) => make(new Flint({ provider: p, defaultModel: m }), v);
  const brainOf = (c: ReturnType<typeof capture>, model: string): BrainTier<Persona> => ({
    tier: 'standard',
    provider: c.provider,
    model,
    label: `${c.provider.name}:${model}`,
    persona: frontierPersona(c.provider, model, defaults.frontier),
  });
  const tier = brainOf(opus, 'claude-opus-5');
  const chain = [tier, brainOf(sonnet, 'claude-sonnet-5')];
  const styled = new StyledPersonas<Persona>(defaults, {
    local: make(localFlint, defaults.local),
    buildLocal: (v) => make(localFlint, v),
    buildFrontier: frontierPersona,
  });
  const localModels = overridePersonaCache<Persona>(
    {},
    (candidate, m, v) => make(new Flint({ provider: candidate, defaultModel: m }), v ?? defaults.local),
    { fetch: ollama.fetch },
  );
  return { styled, tier, chain, localModels, captured: { local, opus, sonnet, ollama } };
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

describe('turnPersonas + echoStyle: one /generate turn end to end, on capture providers', () => {
  type Path = 'frontier' | 'frontier-fallback' | 'local-fallback' | 'local' | 'local-model';
  const PATHS: Path[] = ['frontier', 'frontier-fallback', 'local-fallback', 'local', 'local-model'];

  /**
   * Drives a turn the way /generate does (index.ts): choose the turn's personas,
   * ask the frontier chain with fallback and the local persona if every tier
   * fails, or ask the local persona; the echo is echoStyle's.
   */
  async function generate(defaults: StyleDefaults, styleVariant: StyleVariant | undefined, path: Path) {
    const server = realServer(defaults);
    const { opus, sonnet, local, ollama } = server.captured;
    if (path === 'frontier-fallback' || path === 'local-fallback') opus.down.on = true;
    if (path === 'local-fallback') sonnet.down.on = true;
    const req: TurnRequest =
      path === 'local-model'
        ? { styleVariant, localModel: 'muse-glimmer:30b', localThink: false }
        : { styleVariant, localModel: undefined, localThink: undefined };
    const turn = turnPersonas(req, { styled: server.styled, model: 'qwen2.5:7b', localModels: server.localModels });
    if (!turn.ok) throw new Error(turn.error);
    const answered = echoStyle((p: Persona) => p.generate({ prompt: 'How do I run Postgres in Docker?', context: 'Today is Thursday.' }));
    let out;
    if (path === 'local' || path === 'local-model') {
      out = await answered.ask(turn.local.persona);
    } else {
      try {
        out = (await runWithFallback(server.chain, (b) => answered.ask(turn.frontier(b)))).result;
      } catch {
        out = await answered.ask(turn.local.persona);
      }
    }
    const by = { frontier: opus, 'frontier-fallback': sonnet, 'local-fallback': local, local, 'local-model': ollama }[path];
    return { echo: answered.styleVariant(), text: out.text, system: by.systems.at(-1) ?? '', turn };
  }

  const frontierAnswers = (path: Path) => path === 'frontier' || path === 'frontier-fallback';

  for (const defaults of [V1, { frontier: 'v2', local: 'local-v1' }] as StyleDefaults[]) {
    for (const requested of [undefined, ...STYLE_VARIANTS]) {
      it.each(PATHS)(`defaults ${defaults.frontier}/${defaults.local}, styleVariant ${String(requested)}: the %s answer is in that guide and echoes it`, async (path) => {
        const { echo, system, text } = await generate(defaults, requested, path);
        const want = requested ?? (frontierAnswers(path) ? defaults.frontier : defaults.local);
        // The path really was taken: the answer came from that provider.
        const from = { frontier: 'anthropic-opus', 'frontier-fallback': 'anthropic-sonnet', 'local-fallback': 'ollama', local: 'ollama', 'local-model': 'override' }[path];
        expect(text).toBe(`answer from ${from}`);
        expect(echo).toBe(want);
        // The system prompt the answering provider actually received opens with that guide, and no other.
        expect(system.startsWith(styleGuideFor(want))).toBe(true);
        for (const other of STYLE_VARIANTS.filter((v) => v !== want)) expect(system.startsWith(styleGuideFor(other))).toBe(false);
      });
    }
  }

  it('answers live traffic (no styleVariant, no localModel) with exactly the personas main() built', () => {
    const server = realServer(V1);
    const turn = turnPersonas({ styleVariant: undefined, localModel: undefined, localThink: undefined }, { styled: server.styled, model: 'qwen2.5:7b', localModels: server.localModels });
    if (!turn.ok) throw new Error(turn.error);
    expect(turn.frontier(server.tier)).toBe(server.tier.persona);
    expect(turn.local).toEqual({ persona: server.styled.local('v1'), model: 'qwen2.5:7b' });
    expect(server.styled.size).toBe(0);
  });

  it('reports the override model and the think its Ollama client sends', async () => {
    const { turn } = await generate(V1, 'local-v1', 'local-model');
    expect(turn.local).toMatchObject({ model: 'muse-glimmer:30b', think: false });
  });

  it("is a 422 for localModel when the server's local brain isn't Ollama", () => {
    const server = realServer(V1);
    const r = turnPersonas({ styleVariant: 'v2', localModel: 'muse-glimmer:30b', localThink: undefined }, { styled: server.styled, model: 'qwen2.5:7b', localModels: undefined });
    expect(r).toMatchObject({ ok: false, status: 422 });
  });
});
