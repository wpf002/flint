/**
 * Best brain per question — the frontier as a set of TIERS.
 *
 * judgeBrain (./policy) still makes the first, highest-consequence call: does
 * this message leave the machine at all? Only once it says `frontier` does this
 * module decide WHICH frontier answers. A cheap regex classifier sorts the
 * message into routine / standard / hard / code, each tier maps to a
 * `provider:model` from env, and a failing tier falls back down the ladder
 * before the caller's existing last resort (the local brain) is reached.
 *
 * Defaults change nothing: with no FLINT_TIER_* set, every tier resolves to the
 * one legacy frontier (buildFrontierProvider — anthropic:claude-sonnet-4-6), so
 * the fallback chain is that single brain, exactly as before.
 *
 * Env (each value is `provider:model`; the model may itself contain colons, e.g.
 * `ollama:qwen2.5:72b`):
 *   FLINT_TIER_STANDARD  the everyday frontier; unset → the legacy frontier
 *   FLINT_TIER_ROUTINE   short chit-chat / quick lookups; unset → standard
 *   FLINT_TIER_HARD      multi-step reasoning, analysis, planning; unset → standard
 *   FLINT_TIER_CODE      writing / debugging code; unset → standard
 *   FLINT_TIER_LAST_RESORT  appended to the END of every fallback chain; unset →
 *                        no extra link (today's chains exactly). Meant for another
 *                        vendor (e.g. `openai:gpt-5`): the Claude tiers refuse the
 *                        same prompts alike, so a refusal only has somewhere to go
 *                        if the last link isn't Claude. Same persona as every tier.
 *   FLINT_TIERS=off      kill switch: ignore every FLINT_TIER_* (legacy only)
 * Providers: anthropic (ANTHROPIC_API_KEY), openai (OPENAI_API_KEY),
 * perplexity (PERPLEXITY_API_KEY; no tool calling), ollama (FLINT_TIER_OLLAMA_HOST
 * → FLINT_FRONTIER_BASE_URL → OLLAMA_HOST). A tier whose provider has no key is
 * skipped with a log line and resolves like an unset tier.
 *
 * Kept free of index.ts so it is unit-testable (index.ts runs main() on import).
 */
import type { MediaFlags } from './policy';
import {
  AnthropicProvider,
  OllamaProvider,
  OpenAiProvider,
  PerplexityProvider,
  TIERS,
  isFlintError,
  type ProviderAdapter,
  type Tier,
} from '@flint/core';


/**
 * Where a failing tier goes next. "Down the ladder": the expensive specialists
 * fall back to the everyday brain, the everyday brain to the cheap one, and the
 * cheap one UP to standard (below routine is only local, which the caller owns).
 * Tiers that resolve to the same provider:model are collapsed, so with defaults
 * every chain is the single legacy frontier.
 */
export const FALLBACK: Record<Tier, readonly Tier[]> = {
  hard: ['hard', 'standard', 'routine'],
  code: ['code', 'standard', 'routine'],
  standard: ['standard', 'routine'],
  routine: ['routine', 'standard'],
};

// ---------------------------------------------------------------------------
// classification: the rules live in @flint/core (tiers.ts), shared with evolve.

export { classifyMessage, LONG_CONVERSATION, TIERS, type ClassifyContext, type Tier } from '@flint/core';

// ---------------------------------------------------------------------------
// configuration

export interface TierSpec {
  provider: string;
  model: string;
}

/** `provider:model` → spec. Splits on the FIRST colon (ollama tags contain colons). */
export function parseTierSpec(raw: string | undefined): TierSpec | undefined {
  const s = raw?.trim();
  if (!s) return undefined;
  const i = s.indexOf(':');
  if (i <= 0 || i === s.length - 1) return undefined;
  const provider = s.slice(0, i).trim().toLowerCase();
  const model = s.slice(i + 1).trim();
  if (!provider || !model) return undefined;
  return { provider, model };
}

type Env = Record<string, string | undefined>;

/** The FLINT_TIER_* specs present in env (malformed ones reported via `warn`). */
export function readTierSpecs(env: Env, warn: (msg: string) => void = () => {}): Partial<Record<Tier, TierSpec>> {
  const out: Partial<Record<Tier, TierSpec>> = {};
  if (env.FLINT_TIERS?.trim().toLowerCase() === 'off') return out;
  for (const tier of TIERS) {
    const key = `FLINT_TIER_${tier.toUpperCase()}`;
    const raw = env[key];
    if (!raw?.trim()) continue;
    const spec = parseTierSpec(raw);
    if (spec) out[tier] = spec;
    else warn(`${key}=${JSON.stringify(raw)} is not provider:model — ignored`);
  }
  return out;
}

/** FLINT_TIER_LAST_RESORT, unless FLINT_TIERS=off (a malformed value is reported via `warn`). */
export function readLastResortSpec(env: Env, warn: (msg: string) => void = () => {}): TierSpec | undefined {
  if (env.FLINT_TIERS?.trim().toLowerCase() === 'off') return undefined;
  const raw = env.FLINT_TIER_LAST_RESORT;
  if (!raw?.trim()) return undefined;
  const spec = parseTierSpec(raw);
  if (!spec) warn(`FLINT_TIER_LAST_RESORT=${JSON.stringify(raw)} is not provider:model — ignored`);
  return spec;
}

/** Build (or reuse) the adapter for a provider name; undefined = no key / unknown. */
export type ProviderFactory = (provider: string) => ProviderAdapter | undefined;

/**
 * The real factory: one adapter per provider, built only when its key exists.
 * Instances are cached so every tier on the same provider shares one client.
 */
export function envProviderFactory(env: Env): ProviderFactory {
  const cache = new Map<string, ProviderAdapter | undefined>();
  const make = (name: string): ProviderAdapter | undefined => {
    switch (name) {
      case 'anthropic': {
        const apiKey = env.ANTHROPIC_API_KEY?.trim();
        return apiKey ? new AnthropicProvider({ apiKey }) : undefined;
      }
      case 'openai': {
        const apiKey = env.OPENAI_API_KEY?.trim();
        return apiKey ? new OpenAiProvider({ apiKey }) : undefined;
      }
      case 'perplexity': {
        const apiKey = env.PERPLEXITY_API_KEY?.trim();
        return apiKey ? new PerplexityProvider({ apiKey }) : undefined;
      }
      case 'ollama':
        return new OllamaProvider({
          baseURL:
            env.FLINT_TIER_OLLAMA_HOST?.trim() ||
            env.FLINT_FRONTIER_BASE_URL?.trim() ||
            env.OLLAMA_HOST?.trim() ||
            'http://127.0.0.1:11434',
          defaultOptions: { num_ctx: Number(env.FLINT_FRONTIER_NUM_CTX ?? 8192) },
        });
      default:
        return undefined;
    }
  };
  return (name) => {
    if (!cache.has(name)) cache.set(name, make(name));
    return cache.get(name);
  };
}

// ---------------------------------------------------------------------------
// the tier set

export interface BrainTier<P> {
  /**
   * The tier this brain was CONFIGURED for (a fallback may serve another tier's
   * request); `last_resort` is FLINT_TIER_LAST_RESORT, the end of every chain.
   */
  tier: Tier | 'last_resort';
  provider: ProviderAdapter;
  model: string;
  /** `provider:model` — what observability records. */
  label: string;
  persona: P;
}

export class BrainSet<P> {
  constructor(
    private readonly byTier: Record<Tier, BrainTier<P>>,
    /** FLINT_TIER_LAST_RESORT: tried after every tier of any chain. */
    readonly lastResort?: BrainTier<P>,
  ) {}

  /** The everyday brain — what `frontier` meant before tiers. */
  get primary(): BrainTier<P> {
    return this.byTier.standard;
  }

  /** More than one distinct brain — i.e. the classifier's answer can change who replies. */
  get tiered(): boolean {
    return new Set(TIERS.map((t) => this.byTier[t].label)).size > 1;
  }

  /** The brain configured for a tier (after unset/skipped tiers resolved to standard). */
  get(tier: Tier): BrainTier<P> {
    return this.byTier[tier];
  }

  /**
   * Ordered, de-duplicated brains to try for a tier: its own, then down the
   * ladder, then the last resort (when set and not already in the chain).
   */
  chain(tier: Tier): BrainTier<P>[] {
    const seen = new Set<string>();
    const out: BrainTier<P>[] = [];
    for (const b of [...FALLBACK[tier].map((t) => this.byTier[t]), ...(this.lastResort ? [this.lastResort] : [])]) {
      if (seen.has(b.label)) continue;
      seen.add(b.label);
      out.push(b);
    }
    return out;
  }

  /** One line per tier for the boot log. */
  describe(): string {
    const tiers = TIERS.map((t) => `${t}=${this.byTier[t].label}`).join(' ');
    return this.lastResort ? `${tiers} last_resort=${this.lastResort.label}` : tiers;
  }
}

export interface BuildTiersOptions<P> {
  env: Env;
  factory: ProviderFactory;
  /** Today's single frontier (buildFrontierProvider) — the default standard tier. */
  legacy: { provider: ProviderAdapter; model: string } | undefined;
  /** Build the Persona that speaks for one brain (called once per distinct provider:model). */
  makePersona: (provider: ProviderAdapter, model: string) => P;
  log?: (msg: string) => void;
}

/**
 * Resolve every tier to a concrete brain. Returns undefined when nothing at all
 * is available (no legacy frontier and no buildable tier) — i.e. local-only.
 *
 * Resolution: a tier with a buildable FLINT_TIER_* spec gets it; otherwise it
 * inherits standard; standard itself is its spec, else the legacy frontier,
 * else the first buildable tier (so a lone FLINT_TIER_CODE still works with no
 * Anthropic key).
 */
export function buildTiers<P>(opts: BuildTiersOptions<P>): BrainSet<P> | undefined {
  const log = opts.log ?? (() => {});
  const specs = readTierSpecs(opts.env, (m) => log(`[brain] ${m}`));
  const personas = new Map<string, P>();
  const brainFor = (tier: Tier | 'last_resort', provider: ProviderAdapter, model: string): BrainTier<P> => {
    const label = `${provider.name}:${model}`;
    let persona = personas.get(label);
    if (persona === undefined) {
      persona = opts.makePersona(provider, model);
      personas.set(label, persona);
    }
    return { tier, provider, model, label, persona };
  };

  const built: Partial<Record<Tier, BrainTier<P>>> = {};
  for (const tier of TIERS) {
    const spec = specs[tier];
    if (!spec) continue;
    const provider = opts.factory(spec.provider);
    if (!provider) {
      log(`[brain] tier ${tier} skipped: ${spec.provider} unavailable (no key / unknown provider) for ${spec.model}`);
      continue;
    }
    if (spec.provider === 'perplexity') {
      log(`[brain] tier ${tier} is perplexity — it cannot call tools, so tool-needing questions there answer without them`);
    }
    built[tier] = brainFor(tier, provider, spec.model);
  }

  const standard =
    built.standard ??
    (opts.legacy ? brainFor('standard', opts.legacy.provider, opts.legacy.model) : undefined) ??
    TIERS.map((t) => built[t]).find((b): b is BrainTier<P> => b !== undefined);
  if (!standard) return undefined;

  const byTier = {} as Record<Tier, BrainTier<P>>;
  for (const tier of TIERS) {
    byTier[tier] = tier === 'standard' ? { ...standard, tier: 'standard' } : built[tier] ?? { ...standard, tier };
  }
  return new BrainSet(byTier, lastResortBrain(opts, brainFor, log));
}

/** The FLINT_TIER_LAST_RESORT brain, or undefined when unset / unbuildable. */
function lastResortBrain<P>(
  opts: BuildTiersOptions<P>,
  brainFor: (tier: 'last_resort', provider: ProviderAdapter, model: string) => BrainTier<P>,
  log: (msg: string) => void,
): BrainTier<P> | undefined {
  const spec = readLastResortSpec(opts.env, (m) => log(`[brain] ${m}`));
  if (!spec) return undefined;
  const provider = opts.factory(spec.provider);
  if (!provider) {
    log(`[brain] last resort skipped: ${spec.provider} unavailable (no key / unknown provider) for ${spec.model}`);
    return undefined;
  }
  if (spec.provider === 'anthropic') {
    log('[brain] the last resort is anthropic — the Claude tiers refuse alike, so it will rarely rescue a refusal');
  }
  return brainFor('last_resort', provider, spec.model);
}

// ---------------------------------------------------------------------------
// fallback

/**
 * Whether a failure should move on to the next brain. Everything a provider can
 * throw qualifies — rate limits and outages obviously, but also a rejected key
 * or unknown model (a misconfigured tier should degrade, not break Flint) and a
 * context overflow (the next brain may have a bigger window). The one exception
 * is the caller's own cancellation: a closed tab must not spend another model.
 */
export function shouldFallBack(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return false;
  if (isFlintError(err) && err.kind === 'timeout' && !err.retryable && /abort/i.test(err.message)) return false;
  return true;
}

/** A short description of an error for logs: its AiError kind when it has one. */
export function describeError(err: unknown): string {
  if (isFlintError(err)) return `${err.kind}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

/**
 * Run `attempt` on each brain of the chain in turn until one succeeds. Throws
 * the LAST error if all of them fail (the caller then falls back to local, as
 * it always has). `attempt` decides for itself whether a failure is still
 * recoverable — e.g. a stream that already sent text must rethrow a non-fallback
 * error by wrapping it with `NoFallback`.
 */
export async function runWithFallback<P, T>(
  chain: readonly BrainTier<P>[],
  attempt: (brain: BrainTier<P>) => Promise<T>,
  opts: { signal?: AbortSignal; onFallback?: (from: BrainTier<P>, to: BrainTier<P>, err: unknown) => void } = {},
): Promise<{ result: T; brain: BrainTier<P> }> {
  if (chain.length === 0) throw new Error('no frontier brain configured');
  let lastErr: unknown;
  for (let i = 0; i < chain.length; i++) {
    const brain = chain[i]!;
    try {
      return { result: await attempt(brain), brain };
    } catch (err) {
      if (err instanceof NoFallback) throw err.inner;
      lastErr = err;
      const next = chain[i + 1];
      if (!next || !shouldFallBack(err, opts.signal)) throw err;
      opts.onFallback?.(brain, next, err);
    }
  }
  throw lastErr;
}

/** Thrown from an attempt to stop the fallback chain and surface `inner` as-is. */
export class NoFallback extends Error {
  constructor(readonly inner: unknown) {
    super('no fallback');
    this.name = 'NoFallback';
  }
}

/** What a tier's model can read, from its provider's capability table. */
export function mediaOf<P>(b: BrainTier<P>): MediaFlags {
  const caps = b.provider.getCapabilities(b.model);
  return { image: caps.vision === true, pdf: caps.pdfInput === true };
}

/**
 * Which brains can read a turn's attachments, or undefined when the turn has
 * no image / PDF (every brain can read text).
 */
export function canReadMedia<P>(needs: MediaFlags): ((b: BrainTier<P>) => boolean) | undefined {
  if (!needs.image && !needs.pdf) return undefined;
  return (b) => {
    const m = mediaOf(b);
    return (!needs.image || m.image === true) && (!needs.pdf || m.pdf === true);
  };
}

/**
 * The fallback chain for a turn, minus tiers whose model can't read its
 * attachments. routeTurn already checked the primary can, so it's the floor.
 */
export function mediaChain<P>(chain: BrainTier<P>[], needs: MediaFlags, primary: BrainTier<P>): BrainTier<P>[] {
  const can = canReadMedia<P>(needs);
  if (!can) return chain;
  const able = chain.filter(can);
  return able.length > 0 ? able : [primary];
}
