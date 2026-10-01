/**
 * Who is asking, and what they may have: the console's bearer token and access
 * over the tailnet.
 *
 * WHY. The console HTML carried FLINT_TOKEN for ANY request that reached it, on
 * the reasoning that Flint is only reachable over the private tailnet. The
 * 2026-09-30 audit found that this handed the token to every device and login on
 * the tailnet, and to anything that could make Flint fetch its own page (the
 * fetch_url hole, closed in #33). A request reaches Flint either from this Mac or
 * through `tailscale serve`, which also connects from loopback, so the source
 * address alone can't tell them apart. What serve does add, for tailnet users, is
 * `Tailscale-User-Login`, and it strips that header from what clients send, so it
 * cannot be spoofed THROUGH SERVE (https://tailscale.com/kb/1312/serve). Tagged
 * devices and Funnel get no identity at all.
 *
 * That only holds if serve is the only way in. This Mac's tailscaled runs with
 * --tun=userspace-networking, and in that mode it forwards a tailnet peer's TCP
 * connection to any port serve doesn't own straight to 127.0.0.1:<port>, raw, with
 * whatever headers the peer chose (wgengine/netstack: dialIP = ipv4Loopback). So
 * Flint listens on ::1 (DEFAULT_BIND_HOST), which that forward never dials, and
 * serve points at http://localhost:8080 (tailscale 1.102 mangles an [::1] target;
 * localhost resolves to ::1). The review of #34 found this.
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

/**
 * Where the server listens: IPv6 loopback, which userspace tailscaled's forward of
 * peer connections (to 127.0.0.1 only) cannot reach. Clients use `localhost`.
 */
export const DEFAULT_BIND_HOST = '::1';

/** BIND_HOST, or ::1. index.ts listens on exactly this. */
export function bindHost(env: Record<string, string | undefined>): string {
  return env.BIND_HOST?.trim() || DEFAULT_BIND_HOST;
}

/** The host part of a Host header, lowercased: `localhost:8080` -> localhost, `[::1]:8080` -> [::1]. */
export function hostName(header: string | undefined): string {
  const h = (header ?? '').trim().toLowerCase();
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    return end > 0 ? h.slice(0, end + 1) : h;
  }
  return h.split(':')[0] ?? '';
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

// ---------------------------------------------------------------------------
// Scoped tokens
//
// FLINT_TOKEN can do everything Flint can, and evolve, parity and voice all used
// it (read out of the server plist, at that). Each now gets its own token in
// ~/.flint/tokens/<name>.token (0600), made at startup when missing, that reaches
// only what that client calls: a leaked eval token can ask eval questions, not
// chat (which can act) or approve anything.

export type Scope = 'full' | 'eval' | 'voice';

/** The scoped clients and what each may do. */
export const SCOPED_CLIENTS: ReadonlyArray<{ name: string; scope: Exclude<Scope, 'full'> }> = [
  { name: 'evolve', scope: 'eval' },
  { name: 'parity', scope: 'eval' },
  { name: 'voice', scope: 'voice' },
];

/**
 * Which scope this Authorization header carries, or undefined. Every token is
 * compared (in constant time) whatever matched, so timing says nothing about which.
 */
export function bearerScope(
  authorization: string | undefined,
  tokens: { full: string; scoped: ReadonlyArray<{ token: string; scope: Exclude<Scope, 'full'> }> },
): Scope | undefined {
  let found: Scope | undefined = bearerMatches(authorization, tokens.full) ? 'full' : undefined;
  for (const t of tokens.scoped) {
    const hit = !!t.token && bearerMatches(authorization, t.token);
    if (hit && !found) found = t.scope;
  }
  return found;
}

/**
 * May a token of this scope make this request? `eval` reaches /generate (and
 * /generate itself refuses it unless the body says eval: true) and the eval
 * discovery routes; `voice` reaches chat and speech.
 */
export function scopeAllows(scope: Scope, method: string, url: string): boolean {
  if (scope === 'full') return true;
  const path = url.split('?')[0];
  if (scope === 'eval') {
    return (method === 'POST' && (path === '/generate' || path === '/eval/tool')) || (method === 'GET' && path === '/eval/tools');
  }
  return method === 'POST' && (path === '/chat' || path === '/speak' || path === '/transcribe');
}
