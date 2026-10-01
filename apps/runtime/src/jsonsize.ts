/**
 * Sizes as Postgres measures them. The CHECKs use octet_length(jsonb::text),
 * and jsonb's text form puts a space after every ':' and ',' (about 10% more
 * than JSON.stringify), so a value that passed a JSON.stringify check could
 * still fail the CHECK and surface as a 500. Measure the same way instead.
 */
export function jsonbBytes(v: unknown): number {
  if (v === null || v === undefined) return 4;
  if (typeof v === 'string') return Buffer.byteLength(JSON.stringify(v));
  if (typeof v === 'number' || typeof v === 'boolean') return Buffer.byteLength(JSON.stringify(v));
  if (Array.isArray(v)) return 2 + v.reduce<number>((n, x, i) => n + jsonbBytes(x) + (i ? 2 : 0), 0);
  if (typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined);
    return 2 + entries.reduce((n, [k, x], i) => n + Buffer.byteLength(JSON.stringify(k)) + 2 + jsonbBytes(x) + (i ? 2 : 0), 0);
  }
  return 0;
}

/** Postgres refuses U+0000 in text and jsonb. */
export function hasNul(v: unknown): boolean {
  if (typeof v === 'string') return v.includes('\u0000');
  if (Array.isArray(v)) return v.some(hasNul);
  if (v && typeof v === 'object') return Object.entries(v as Record<string, unknown>).some(([k, x]) => k.includes('\u0000') || hasNul(x));
  return false;
}
