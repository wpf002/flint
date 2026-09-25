/**
 * Style variants: which persona text (style guide) Flint answers with.
 *
 * The guides live in @flint/persona (FLINT_STYLE_VARIANTS): "v1" is
 * FLINT_STYLE_GUIDE, what Flint runs on today; "v2" is the revised frontier
 * guide; "local-v1" is the compact local guide. A new guide changes Flint's
 * answers, so it goes live only after a judged A/B says it wins. Two ways in:
 *
 *  - Eval only, per request: POST /generate { eval: true, styleVariant: "v2" }
 *    (apps/parity --flint-variant v2). Anything but a known variant, or one
 *    without eval: true, is a 400. The eval response echoes `styleVariant`: the
 *    variant of the brain that actually answered.
 *  - Live, from env: FLINT_STYLE_VARIANT picks the frontier tiers' guide and
 *    FLINT_LOCAL_STYLE_VARIANT the local brain's (and the eval local-model
 *    override personas'). Unset, both are "v1", so nothing changes; an unknown
 *    value is logged and ignored (v1), so a typo can't take Flint down.
 *
 * A requested variant applies to whichever brain answers: frontier, local, or a
 * local fallback after a frontier failure. Personas are built once per (brain,
 * variant) and reused. The default variant's persona is the one main() already
 * built, so a request without `styleVariant` (all live traffic) is answered by
 * exactly the persona it always was.
 *
 * Kept free of index.ts so it is unit-testable (index.ts runs main() on import).
 */
import type { ProviderAdapter } from '@flint/core';
import { FLINT_STYLE_VARIANTS, FLINT_STYLE_VARIANT_NAMES, isFlintStyleVariant, type FlintStyleVariant } from '@flint/persona';

export type StyleVariant = FlintStyleVariant;

/** Every known variant, v1 first. What /health reports as `styleVariants`. */
export const STYLE_VARIANTS: readonly StyleVariant[] = FLINT_STYLE_VARIANT_NAMES;

/** What an unset (or unknown) FLINT_STYLE_VARIANT / FLINT_LOCAL_STYLE_VARIANT means: today's guide. */
export const DEFAULT_STYLE_VARIANT: StyleVariant = 'v1';

/** The style guide text for a variant. */
export function styleGuideFor(variant: StyleVariant): string {
  return FLINT_STYLE_VARIANTS[variant];
}

export type StyleVariantRequest =
  | { ok: true; variant: StyleVariant | undefined }
  | { ok: false; status: 400; error: string };

/**
 * Validate the `styleVariant` field of a /generate body. `variant` is undefined
 * when none was asked for (all normal traffic). Like `localModel`, the value is
 * checked first, then the eval-only rule; the name must match exactly.
 */
export function parseStyleVariantRequest(body: Record<string, unknown>): StyleVariantRequest {
  const raw = body.styleVariant;
  if (raw === undefined || raw === null) return { ok: true, variant: undefined };
  if (typeof raw !== 'string') return { ok: false, status: 400, error: 'styleVariant must be a string' };
  if (!isFlintStyleVariant(raw)) {
    return { ok: false, status: 400, error: `unknown styleVariant ${JSON.stringify(raw)}; known: ${STYLE_VARIANTS.join(', ')}` };
  }
  if (body.eval !== true) return { ok: false, status: 400, error: 'styleVariant is only accepted with eval: true' };
  return { ok: true, variant: raw };
}

/** The live variant for each brain. */
export interface StyleDefaults {
  /** FLINT_STYLE_VARIANT: every frontier tier's persona. */
  frontier: StyleVariant;
  /** FLINT_LOCAL_STYLE_VARIANT: the local brain's persona and the eval local-model override personas. */
  local: StyleVariant;
}

/**
 * FLINT_STYLE_VARIANT and FLINT_LOCAL_STYLE_VARIANT, each "v1" when unset or
 * unknown. `log` gets one boot line for each that is set: the variant it selects,
 * or that it was ignored. Unset logs nothing.
 */
export function readStyleDefaults(env: Record<string, string | undefined>, log: (msg: string) => void = () => {}): StyleDefaults {
  return {
    frontier: envVariant(env, 'FLINT_STYLE_VARIANT', 'frontier', log),
    local: envVariant(env, 'FLINT_LOCAL_STYLE_VARIANT', 'local', log),
  };
}

function envVariant(env: Record<string, string | undefined>, key: string, brain: string, log: (msg: string) => void): StyleVariant {
  const raw = env[key];
  const v = raw?.trim();
  if (!v) return DEFAULT_STYLE_VARIANT;
  if (isFlintStyleVariant(v)) {
    log(`[style] ${brain} style variant ${v} (${key})`);
    return v;
  }
  log(`[style] ${key}=${JSON.stringify(raw)} is not one of ${STYLE_VARIANTS.join(', ')}; ${brain} uses ${DEFAULT_STYLE_VARIANT}`);
  return DEFAULT_STYLE_VARIANT;
}

/** The variants one turn answers with: the requested one on either brain, else each brain's live default. */
export function chooseStyles(requested: StyleVariant | undefined, defaults: StyleDefaults): StyleDefaults {
  return requested === undefined ? defaults : { frontier: requested, local: requested };
}

/** The `styleVariant` an eval /generate echoes: the variant of the brain that actually answered. */
export function styleEcho(brain: 'local' | 'frontier', chosen: StyleDefaults): StyleVariant {
  return brain === 'frontier' ? chosen.frontier : chosen.local;
}

/** The part of a frontier tier (brains.ts BrainTier) a variant persona is built from. */
export interface StyledBrain<P> {
  label: string;
  provider: ProviderAdapter;
  model: string;
  /** The tier's own persona, built with the frontier default. */
  persona: P;
}

/**
 * Personas per (brain, variant), built on first use and reused. There are at
 * most (frontier tiers + 1) x variants of them, so no eviction.
 */
export class StyledPersonas<P> {
  private readonly built = new Map<string, P>();

  constructor(
    readonly defaults: StyleDefaults,
    private readonly own: {
      /** The server's local persona, built with defaults.local. */
      local: P;
      /** The local persona for another variant (same Flint, memory, lesson store). */
      buildLocal: (variant: StyleVariant) => P;
      /** A frontier tier's persona for another variant (same provider, model, caching). */
      buildFrontier: (provider: ProviderAdapter, model: string, variant: StyleVariant) => P;
    },
  ) {}

  /** The local brain's persona in `variant`: the live one for the default. */
  local(variant: StyleVariant): P {
    if (variant === this.defaults.local) return this.own.local;
    return this.cached(`local#${variant}`, () => this.own.buildLocal(variant));
  }

  /** A frontier tier's persona in `variant`: the tier's own for the default. */
  frontier(brain: StyledBrain<P>, variant: StyleVariant): P {
    if (variant === this.defaults.frontier) return brain.persona;
    return this.cached(`frontier:${brain.label}#${variant}`, () => this.own.buildFrontier(brain.provider, brain.model, variant));
  }

  /** How many non-default personas have been built. */
  get size(): number {
    return this.built.size;
  }

  private cached(key: string, build: () => P): P {
    let p = this.built.get(key);
    if (p === undefined) {
      p = build();
      this.built.set(key, p);
    }
    return p;
  }
}
