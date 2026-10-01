/**
 * Bearer tokens for the runtime's API. Each caller's token is stored only as a
 * sha256 digest with the scopes it may use (config.ts, RUNTIME_TOKENS); every
 * route names the one scope it needs. Comparisons are constant-time and every
 * grant is checked whatever matched, so timing says nothing about which.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { RuntimeScope, TokenGrant } from './config.js';

const digest = (s: string): Buffer => createHash('sha256').update(s).digest();

export interface Caller {
  name: string;
  scopes: ReadonlySet<RuntimeScope>;
}

/** The caller an Authorization header identifies, or undefined. */
export function callerFor(authorization: string | undefined, grants: readonly TokenGrant[]): Caller | undefined {
  const m = /^Bearer ([A-Za-z0-9._~+/=-]{16,512})$/.exec(authorization ?? '');
  const presented = digest(m ? m[1]! : '');
  let found: Caller | undefined;
  for (const g of grants) {
    const hit = timingSafeEqual(presented, Buffer.from(g.sha256, 'hex')) && !!m;
    if (hit && !found) found = { name: g.name, scopes: g.scopes };
  }
  return found;
}
