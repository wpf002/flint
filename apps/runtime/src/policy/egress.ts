/**
 * The only network calls a source may make: a fixed list of endpoints per
 * source (plan P1: "any network call outside the fixed source endpoints" is
 * FORBIDDEN in an autonomous context). Matching is on the exact origin plus a
 * path prefix; redirects are not followed, so a 30x cannot take a source
 * anywhere else. A self-modification PR may not touch this file (P6 allowlist).
 */
export interface Endpoint {
  /** `https://api.github.com` or `http://localhost:8080`. */
  origin: string;
  /** Path prefix, e.g. `/repos/wpf002/`. */
  pathPrefix: string;
  methods: ReadonlyArray<'GET' | 'POST'>;
}

export class EgressRefused extends Error {}

export function allowed(endpoints: readonly Endpoint[], url: string, method: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  return endpoints.some((e) => u.origin === e.origin && u.pathname.startsWith(e.pathPrefix) && e.methods.includes(method.toUpperCase() as 'GET'));
}

/** fetch() limited to `endpoints`, with no redirects and a timeout. */
export function scopedFetch(endpoints: readonly Endpoint[], base: typeof fetch = fetch, timeoutMs = 10_000) {
  return async (url: string, init: RequestInit = {}): Promise<Response> => {
    const method = init.method ?? 'GET';
    if (!allowed(endpoints, url, method)) throw new EgressRefused(`refused: ${method} ${new URL(url).origin} is not one of this source's endpoints`);
    const signal = init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    return base(url, { ...init, redirect: 'manual', signal });
  };
}
