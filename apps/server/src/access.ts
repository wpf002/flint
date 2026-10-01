/**
 * Who is asking, and what they may have: the console's bearer token and access
 * over the tailnet.
 *
 * WHY. The console HTML carried FLINT_TOKEN for ANY request that reached it, on
 * the reasoning that Flint is only reachable over the private tailnet. The
 * 2026-09-30 audit found that this handed the token to every device and login on
 * the tailnet, and to anything that could make Flint fetch its own page (the
 * fetch_url hole, closed in #33). The server listens on 127.0.0.1 only, so a
 * request comes either from this Mac directly or through `tailscale serve`,
 * which connects from 127.0.0.1 as well, so the source address alone can't tell
 * them apart. What serve does add, for tailnet users, is `Tailscale-User-Login`,
 * and it strips that header from what clients send, so it cannot be spoofed over
 * the tailnet (https://tailscale.com/kb/1312/serve). Tagged devices and Funnel get
 * no identity at all.
 *
 * Rules:
 *  - The token is injected into the console only for a direct request from this
 *    Mac (the desktop app), or for a tailnet request from FLINT_TAILNET_USER.
 *  - With FLINT_TAILNET_USER set, a tailnet request from any other login, or none,
 *    is refused outright, token or not. Unset, tailnet requests behave as before
 *    except that the console no longer carries the token (paste it in Settings).
 *  - A process running as the same macOS user is out of scope: it can read
 *    ~/.flint/token anyway.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

export type Via = 'local' | 'tailnet';

export interface RequestFacts {
  remoteAddress: string | undefined;
  headers: Record<string, string | string[] | undefined>;
}

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\]|::1)(:\d+)?$/i;
/** Headers a proxy adds; their presence means the request did not come straight from this Mac. */
const FORWARDED = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded', 'tailscale-user-login', 'tailscale-user-name'];

const header = (h: RequestFacts['headers'], name: string): string | undefined => {
  const v = h[name];
  return Array.isArray(v) ? v[0] : v;
};

/**
 * `local` only for a request that is unmistakably from this Mac: loopback source,
 * a loopback Host, and no proxy or identity headers. Anything else is `tailnet`.
 */
export function requestVia(r: RequestFacts): Via {
  if (!r.remoteAddress || !LOOPBACK_ADDRESSES.has(r.remoteAddress)) return 'tailnet';
  if (!LOOPBACK_HOST.test(header(r.headers, 'host') ?? '')) return 'tailnet';
  if (FORWARDED.some((name) => header(r.headers, name) !== undefined)) return 'tailnet';
  return 'local';
}

/** The Tailscale login `tailscale serve` vouched for, lowercased, or undefined. */
export function tailnetLogin(r: RequestFacts): string | undefined {
  const v = header(r.headers, 'tailscale-user-login')?.trim().toLowerCase();
  return v || undefined;
}

/** FLINT_TAILNET_USER, normalised; undefined when unset. */
export function allowedTailnetUser(env: Record<string, string | undefined>): string | undefined {
  const v = env.FLINT_TAILNET_USER?.trim().toLowerCase();
  return v || undefined;
}

/** May this request be served at all? Local always; tailnet only from the allowed login once one is set. */
export function tailnetAllowed(r: RequestFacts, allowedUser: string | undefined): boolean {
  if (requestVia(r) === 'local' || !allowedUser) return true;
  return tailnetLogin(r) === allowedUser;
}

/** May the console page carry the bearer token for this request? */
export function consoleGetsToken(r: RequestFacts, allowedUser: string | undefined): boolean {
  if (requestVia(r) === 'local') return true;
  return !!allowedUser && tailnetLogin(r) === allowedUser;
}

const digest = (s: string): Buffer => createHash('sha256').update(s).digest();

/** `Authorization: Bearer <token>`, compared in constant time (digests make the lengths equal). */
export function bearerMatches(authorization: string | undefined, token: string): boolean {
  return timingSafeEqual(digest(authorization ?? ''), digest(`Bearer ${token}`));
}
