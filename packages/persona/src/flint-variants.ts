import { FLINT_STYLE_GUIDE } from './flint.js';
import { FLINT_STYLE_GUIDE_V2 } from './flint-v2.js';
import { FLINT_LOCAL_STYLE_GUIDE } from './flint-local.js';

/**
 * Flint's style guides by variant name — the names the server's
 * FLINT_STYLE_VARIANT / FLINT_LOCAL_STYLE_VARIANT and an eval request's
 * `styleVariant` pick from, and that apps/parity puts in a contestant's name
 * (`flint#v2`). A name means one text: change a guide's rules under a NEW name,
 * or answers cached under the old one stop meaning what they say. (The one
 * exception, 2026-09-25, revised all three in place; see test/flint-variants.test.ts.)
 *
 *  - v1: FLINT_STYLE_GUIDE, what Flint runs on today (frontier and local).
 *  - v2: FLINT_STYLE_GUIDE_V2, the frontier guide revised from parity run 20260924-tiered.
 *  - local-v1: FLINT_LOCAL_STYLE_GUIDE, a compact guide for 27-30B local models.
 */
export const FLINT_STYLE_VARIANTS = {
  v1: FLINT_STYLE_GUIDE,
  v2: FLINT_STYLE_GUIDE_V2,
  'local-v1': FLINT_LOCAL_STYLE_GUIDE,
} as const satisfies Record<string, string>;

export type FlintStyleVariant = keyof typeof FLINT_STYLE_VARIANTS;

/** The variant names, in declaration order (v1 first). */
export const FLINT_STYLE_VARIANT_NAMES = Object.keys(FLINT_STYLE_VARIANTS) as FlintStyleVariant[];

/** Whether `v` names a known style variant (own keys only, so "toString" is not one). */
export function isFlintStyleVariant(v: unknown): v is FlintStyleVariant {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(FLINT_STYLE_VARIANTS, v);
}
