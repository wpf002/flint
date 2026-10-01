/**
 * One byte-exact JSON form for anything Flint hashes or signs: an approval's
 * payload, a proposal's args digest, a world entity's state hash.
 *
 * WHY. An approval binds Will's signature to `sha256(canonical(payload))`, and
 * the runtime re-derives that digest from the stored payload before it executes.
 * Two serialisations of the same object must therefore give the same bytes, and
 * anything that has no single JSON form (NaN, a Date, a Map, undefined in an
 * array) must be refused, not quietly turned into `null` or `{}` as
 * JSON.stringify would.
 *
 * Form: object keys sorted by UTF-16 code unit (as Array.prototype.sort does),
 * no whitespace, strings and finite numbers exactly as JSON.stringify writes
 * them. Object members whose value is `undefined` are left out, as JSON does.
 */
import { createHash } from 'node:crypto';

export class NotCanonical extends Error {
  constructor(path: string, why: string) {
    super(`${path || '<root>'}: ${why}`);
    this.name = 'NotCanonical';
  }
}

function walk(v: unknown, path: string, seen: Set<object>): string {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'string':
      return JSON.stringify(v);
    case 'boolean':
      return v ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(v)) throw new NotCanonical(path, `${v} has no JSON form`);
      return JSON.stringify(v);
    case 'object':
      break;
    default:
      throw new NotCanonical(path, `a ${typeof v} has no JSON form`);
  }
  const o = v as object;
  if (seen.has(o)) throw new NotCanonical(path, 'circular reference');
  seen.add(o);
  try {
    if (Array.isArray(o)) {
      return `[${o.map((x, i) => {
        if (x === undefined) throw new NotCanonical(`${path}[${i}]`, 'undefined in an array');
        return walk(x, `${path}[${i}]`, seen);
      }).join(',')}]`;
    }
    const proto = Object.getPrototypeOf(o);
    if (proto !== Object.prototype && proto !== null) {
      throw new NotCanonical(path, `${proto?.constructor?.name ?? 'object'} is not a plain object`);
    }
    const rec = o as Record<string, unknown>;
    const keys = Object.keys(rec).filter((k) => rec[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${walk(rec[k], path ? `${path}.${k}` : k, seen)}`).join(',')}}`;
  } finally {
    seen.delete(o);
  }
}

/** The canonical JSON text of `v`; throws NotCanonical for anything without one. */
export function canonicalJson(v: unknown): string {
  return walk(v, '', new Set());
}

/** SHA-256 of a string (UTF-8) or bytes, as lowercase hex. */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** SHA-256 of `v`'s canonical JSON, as lowercase hex: the digest every signature and hash in Flint uses. */
export function digestOf(v: unknown): string {
  return sha256Hex(canonicalJson(v));
}
