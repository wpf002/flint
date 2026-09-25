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
 *    variant of the persona that actually produced the answer, read from that
 *    persona's own style guide (styleVariantOf / echoStyle), never copied from
 *    the request. So if a turn is ever answered by the wrong persona (a merge
 *    that routes around turnPersonas, say), the echo says so and apps/parity's
 *    echo check stops the run instead of filing v1 answers under "v2".
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
import { resolveLocalPersona, type LocalPersonaCache, type OverridePersona } from './local-model';

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

/** A persona, as far as naming its style goes: the guide it speaks with (@flint/persona's Persona.styleGuide). */
export interface StyledPersona {
  readonly styleGuide: string;
}

/**
 * The variant whose guide `p` actually speaks with, or undefined when its guide
 * is no known variant's text. Read from the persona, not from what a request
 * asked for: this is what an eval /generate echoes. (Each variant's text is
 * distinct and pinned, @flint/persona test/flint-variants.test.ts.)
 */
export function styleVariantOf(p: StyledPersona): StyleVariant | undefined {
  return STYLE_VARIANTS.find((v) => FLINT_STYLE_VARIANTS[v] === p.styleGuide);
}

/**
 * Wraps a turn's call to a persona (`ask`) so the eval echo can name the style of
 * the persona that produced the answer: the last one whose call returned. A tier
 * that threw and fell back to the next doesn't count, and nor does the variant the
 * request asked for. `styleVariant()` is undefined until a call has returned, or
 * when the answering persona's guide is no known variant (the field is then left
 * out of the response, and apps/parity's echo check fails).
 */
export function echoStyle<P extends StyledPersona, R>(ask: (p: P) => Promise<R>): {
  ask: (p: P) => Promise<R>;
  styleVariant: () => StyleVariant | undefined;
} {
  let answered: P | undefined;
  return {
    ask: async (p) => {
      const out = await ask(p);
      answered = p;
      return out;
    },
    styleVariant: () => (answered === undefined ? undefined : styleVariantOf(answered)),
  };
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

/** What one /generate turn asked for, already validated (parseLocalModelRequest, parseStyleVariantRequest). */
export interface TurnRequest {
  /** Eval `styleVariant`; undefined for all live traffic. */
  styleVariant: StyleVariant | undefined;
  /** Eval `localModel` (a bake-off candidate); undefined for the live local model. */
  localModel: string | undefined;
  /** Eval `localThink`, only with localModel. */
  localThink: boolean | undefined;
}

/** The personas one /generate turn may be answered by, each in the turn's style variant. */
export interface TurnPersonas<P> {
  /** The local brain: the live local persona, or the eval localModel override, and its model label. */
  local: { persona: P; model: string; think?: boolean };
  /** A frontier tier's persona (the tier's own for the live default). */
  frontier: (brain: StyledBrain<P>) => P;
}

/**
 * Every persona choice a /generate turn makes, in one place: the variant for each
 * brain (the requested one on either, else each brain's live default), the local
 * persona (the live one, or the (model, think, variant) override for an eval
 * localModel), and the frontier chooser. With no styleVariant and no localModel
 * (all live traffic) these are exactly the personas main() built at boot. A 422
 * when localModel is asked of a server whose local brain isn't Ollama.
 */
export function turnPersonas<P>(
  req: TurnRequest,
  server: {
    styled: StyledPersonas<P>;
    /** The live local model's label. */
    model: string;
    /** Eval local-model override personas; undefined when the local brain isn't Ollama. */
    localModels: LocalPersonaCache<OverridePersona<P>> | undefined;
  },
): ({ ok: true } & TurnPersonas<P>) | { ok: false; status: 422; error: string } {
  const style = chooseStyles(req.styleVariant, server.styled.defaults);
  const local = resolveLocalPersona(
    req.localModel,
    { persona: server.styled.local(style.local), model: server.model },
    server.localModels,
    req.localThink,
    style.local,
  );
  if (!local.ok) return local;
  return {
    ok: true,
    local: { persona: local.persona, model: local.model, ...(local.think !== undefined ? { think: local.think } : {}) },
    frontier: (brain) => server.styled.frontier(brain, style.frontier),
  };
}
