/**
 * Text from outside, made storable. Postgres refuses NUL and half a surrogate
 * pair in both text and jsonb, and a plain `.slice(0, n)` can cut an emoji in
 * half, so one odd title would make its item unwritable on every run.
 */

/** Lone surrogates become U+FFFD and NULs go; the length never grows. */
export function wellFormed(s: string): string {
  return s.replace(/\u0000/g, '').replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�');
}

/** At most `n` UTF-16 units (what the world kinds' `max()` counts), never ending in half a pair. */
export function clip(s: string, n: number): string {
  return wellFormed(s.slice(0, n).replace(/[\uD800-\uDBFF]$/, ''));
}

/** Every string in a JSON value made well formed (the sync engine's last line of defence). */
export function wellFormedDeep<T>(v: T): T {
  if (typeof v === 'string') return wellFormed(v) as T;
  if (Array.isArray(v)) return v.map(wellFormedDeep) as T;
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [wellFormed(k), wellFormedDeep(x)])) as T;
  }
  return v;
}
