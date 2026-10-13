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
 * A brain whose provider keeps failing (no credit, a rejected key, an outage) is
 * left out of the chain for a while by the breaker (./frontier-breaker).
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
 * → FLINT_FRONTIER_BASE_URL → OLLAMA_HOST), local (an OpenAI-compatible local
 * server at FLINT_LOCAL_BASE_URL, see ./inference-config). A tier whose provider
 * has no key (or whose address was refused) is skipped with a log line and
 * resolves like an unset tier.
 *   FLINT_FRONTIER_MAX_RETRIES / FLINT_FRONTIER_TIMEOUT_MS  how the Anthropic
 *                        client fails (frontierClientOptions): 0 retries of its
 *                        own and 60 s for a response to start, unless set.
 *
 * Kept free of index.ts so it is unit-testable (index.ts runs main() on import).
 */
import type { MediaFlags } from './policy';
import {
  AnthropicProvider,
  LocalOpenAiProvider,
  OllamaProvider,
  OpenAiProvider,
  PerplexityProvider,
  TIERS,
  isFlintError,
  type AiError,
  localCapabilities,
  type ProviderAdapter,
  type Tier,
} from '@flint/core';
import { readContextSize, readInferenceConfig } from './inference-config';
import { guardedFetch, openAiPaths } from './local-backend';
import { plainErrors } from './local-errors';


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

/** The Anthropic SDK's own retries of a failed request, for the frontier's client. */
export const FRONTIER_MAX_RETRIES = 0;
/** How long the frontier's Anthropic client waits for a response to start. */
export const FRONTIER_TIMEOUT_MS = 60_000;

/**
 * How the frontier's Anthropic client is told to fail, so one failing try is
 * over quickly and the next brain, or the local model, answers. The SDK's
 * defaults are 2 retries and 10 minutes; Flint's own loop already retries a
 * retryable failure (RetryPolicy, 3 attempts), so the two multiplied to 9
 * requests of up to 10 minutes each before a turn fell back.
 *  - no SDK retries (FLINT_FRONTIER_MAX_RETRIES, 0 to 5);
 *  - 60 s for a response to start (FLINT_FRONTIER_TIMEOUT_MS, 1 s to 10 min).
 *    Every call streams, so this is the wait for the response headers, not for
 *    the whole answer; it still covers uploading a turn's attachments.
 * A value outside its range is reported via `warn` and ignored.
 */
export function frontierClientOptions(env: Env, warn: (msg: string) => void = () => {}): { maxRetries: number; timeoutMs: number } {
  const read = (key: string, fallback: number, min: number, max: number): number => {
    const raw = env[key]?.trim();
    if (!raw) return fallback;
    const n = Number(raw);
    if (Number.isInteger(n) && n >= min && n <= max) return n;
    warn(`${key}=${JSON.stringify(raw.slice(0, 40))} is not a whole number from ${min} to ${max}; using ${fallback}`);
    return fallback;
  };
  return {
    maxRetries: read('FLINT_FRONTIER_MAX_RETRIES', FRONTIER_MAX_RETRIES, 0, 5),
    timeoutMs: read('FLINT_FRONTIER_TIMEOUT_MS', FRONTIER_TIMEOUT_MS, 1_000, 600_000),
  };
}

/**
 * Today's single frontier, the default standard tier: the escalation brain, and
 * the swappable bridge toward independence. It is Claude while there is an
 * ANTHROPIC_API_KEY. The day a bigger LOCAL model is good enough, set
 * FLINT_FRONTIER_PROVIDER=ollama + FLINT_FRONTIER_BASE_URL (e.g. a 70B on a home
 * box) + FLINT_FRONTIER_MODEL and escalation points there instead: no other
 * code changes, and Flint is fully independent. undefined: frontier off (pure
 * local).
 */
export function buildFrontierProvider(env: Env, warn: (msg: string) => void = () => {}): { provider: ProviderAdapter; model: string } | undefined {
  const kind = env.FLINT_FRONTIER_PROVIDER?.trim().toLowerCase();
  const baseURL = env.FLINT_FRONTIER_BASE_URL?.trim();
  if (kind === 'ollama' || (!kind && baseURL && !env.ANTHROPIC_API_KEY)) {
    const model = env.FLINT_FRONTIER_MODEL?.trim();
    if (!model) return undefined;
    return {
      // (A model server's own words when it fails are not repeated, for this brain as for the main model: ./local-errors.)
      provider: plainErrors(
        new OllamaProvider({
          baseURL: baseURL ?? 'http://127.0.0.1:11434',
          defaultOptions: { num_ctx: Number(env.FLINT_FRONTIER_NUM_CTX ?? 8192) },
        }),
      ),
      model,
    };
  }
  const key = env.ANTHROPIC_API_KEY?.trim();
  if (key) {
    return {
      provider: new AnthropicProvider({ apiKey: key, ...frontierClientOptions(env, warn) }),
      model: env.FLINT_FRONTIER_MODEL?.trim() || 'claude-sonnet-4-6',
    };
  }
  return undefined;
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
        // Fails fast, like the legacy frontier's client (frontierClientOptions).
        return apiKey ? new AnthropicProvider({ apiKey, ...frontierClientOptions(env) }) : undefined;
      }
      case 'openai': {
        const apiKey = env.OPENAI_API_KEY?.trim();
        return apiKey ? new OpenAiProvider({ apiKey }) : undefined;
      }
      case 'perplexity': {
        const apiKey = env.PERPLEXITY_API_KEY?.trim();
        return apiKey ? new PerplexityProvider({ apiKey }) : undefined;
      }
      // A tier on a local wire (`ollama`, `local`) is a model server of Will's own, asked with whatever the turn
      // carries: what it says when it fails is not repeated, exactly as for the main model and the standby
      // (./local-errors plainErrors). The error keeps its class, so the chain still moves on as it did.
      case 'ollama':
        return plainErrors(
          new OllamaProvider({
            baseURL:
              env.FLINT_TIER_OLLAMA_HOST?.trim() ||
              env.FLINT_FRONTIER_BASE_URL?.trim() ||
              env.OLLAMA_HOST?.trim() ||
              'http://127.0.0.1:11434',
            defaultOptions: { num_ctx: Number(env.FLINT_FRONTIER_NUM_CTX ?? 8192) },
          }),
        );
      case 'local': {
        // An OpenAI-compatible local server (llama.cpp, Ollama's /v1) as a tier: FLINT_LOCAL_BASE_URL,
        // held to this Mac unless FLINT_LOCAL_ALLOW_REMOTE=1 (./inference-config). A refused address
        // builds nothing, so the tier resolves like one with no key. Tools only when Will says the
        // model can call them (FLINT_LOCAL_TOOLS=on): a tier is not probed.
        const cfg = readInferenceConfig(env).local;
        const at = cfg.openai;
        if (!at) return undefined;
        // Held to the rule every context size is (./inference-config readContextSize): anything else is the default.
        const context = readContextSize(env.FLINT_FRONTIER_NUM_CTX) ?? 8192;
        return plainErrors(
          new LocalOpenAiProvider({
            baseURL: at.baseURL,
            allowRemote: cfg.allowRemote,
            ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}),
            fetch: guardedFetch({ origin: at.origin, paths: openAiPaths(at.path), connectTimeoutMs: cfg.connectTimeoutMs }),
            firstTokenTimeoutMs: cfg.firstTokenTimeoutMs,
            toolPassTimeoutMs: cfg.toolPassTimeoutMs,
            capabilities: () => localCapabilities({ contextTokens: context, tools: cfg.tools === 'on' }),
          }),
        );
      }
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

  /**
   * The cheapest brain configured on `provider`, for the breaker's one-token
   * check: the routine chain's first on it, else any tier's, else the last
   * resort. With `model`, the brain on that model (the one being checked).
   * `usable` leaves brains out: a provider-wide check must not ask a model
   * that has a pause of its own (the key may not use it), or that model's 403
   * would be read as the provider's answer, every time. When none is usable it
   * asks one anyway.
   */
  cheapestOn(provider: string, model?: string, usable: (brain: BrainTier<P>) => boolean = () => true): BrainTier<P> | undefined {
    const all = [...this.chain('routine'), ...TIERS.map((t) => this.byTier[t]), ...(this.lastResort ? [this.lastResort] : [])];
    if (model !== undefined) return all.find((b) => b.provider.name === provider && b.model === model);
    const on = all.filter((b) => b.provider.name === provider);
    // With every model on the provider paused on its own there is none to prefer: any brain is asked,
    // rather than none. A provider-wide check with nobody to ask could never pass, and the provider
    // would stay paused for good.
    return on.find(usable) ?? on[0];
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

/** The tool loop's own failures, as @flint/core words them (core/tool-loop.ts): a tool handler that threw, a loop that ran out of iterations. */
const TOOL_LOOP_FAILURE = /^Tool (?:'[^']*' failed|loop exceeded)/;

/**
 * Is this the PROVIDER failing to serve the request (an outage, a timeout, a
 * rate limit, a rejected key, no credit, an unknown model, an over-long prompt,
 * a broken stream), or the turn going wrong after the brain was reached: a tool
 * that threw, a tool loop that ran out? Those two are `internal` errors core
 * raises itself, and another brain would only do the same thing again.
 */
export function providerFailure(err: Pick<AiError, 'kind' | 'message'>): boolean {
  return !(err.kind === 'internal' && TOOL_LOOP_FAILURE.test(err.message));
}

/**
 * Whether a failure should move on to the next brain. Everything a provider can
 * throw qualifies — rate limits and outages obviously, but also a rejected key
 * or unknown model (a misconfigured tier should degrade, not break Flint) and a
 * context overflow (the next brain may have a bigger window). Two exceptions:
 * the caller's own cancellation (a closed tab must not spend another model), and
 * a failure that is not the provider's (providerFailure: a tool's own error).
 */
export function shouldFallBack(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return false;
  if (isFlintError(err) && err.kind === 'timeout' && !err.retryable && /abort/i.test(err.message)) return false;
  if (isFlintError(err) && !providerFailure(err.error)) return false;
  return true;
}

/**
 * May a failed attempt be asked again of ANOTHER brain: the next tier, or the
 * local model? Never once the turn has acted (`acted`: a tool was called, so it
 * ran, or was filed for approval). The second brain would start the turn over
 * and call it again: on 2026-10-12 a review showed calendar.create_event run
 * twice that way, once by the tier that then failed and once by the fallback.
 * Otherwise as shouldFallBack says.
 */
export function mayAskAnother(err: unknown, o: { acted: boolean; signal?: AbortSignal | undefined }): boolean {
  return !o.acted && shouldFallBack(err, o.signal);
}

/**
 * Run `attempt` on each brain of the chain in turn until one succeeds. Throws
 * the LAST error if all of them fail (the caller then falls back to local, as
 * it always has). `attempt` decides for itself whether a failure is still
 * recoverable — e.g. a stream that already sent text must rethrow a non-fallback
 * error by wrapping it with `NoFallback`.
 *
 * `acted` says whether the turn has called a tool yet: once it has, a failure
 * is thrown as it is and no later brain is asked (mayAskAnother).
 */
export async function runWithFallback<P, T>(
  chain: readonly BrainTier<P>[],
  attempt: (brain: BrainTier<P>) => Promise<T>,
  opts: { signal?: AbortSignal; acted?: () => boolean; onFallback?: (from: BrainTier<P>, to: BrainTier<P>, err: unknown) => void } = {},
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
      if (!next || !mayAskAnother(err, { acted: opts.acted?.() ?? false, signal: opts.signal })) throw err;
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
