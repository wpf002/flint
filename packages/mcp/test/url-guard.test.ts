import { describe, it, expect } from 'vitest';
import { UrlRefused, assertPublicUrl, decodeLocation, guardedFetch, isPrivateHost } from '../src/url-guard';

const publicDns = async () => ['93.184.216.34'];

describe('assertPublicUrl', () => {
  // The chain the audit found on 2026-09-30: fetch_url ran without approval and
  // could read Flint's own console, which carries its bearer token.
  it("refuses Flint's own console and every other local address", async () => {
    for (const u of [
      'http://127.0.0.1:8080/',
      'http://localhost:8080/console',
      'http://[::1]:8080/',
      'http://2130706433:8080/', // 127.0.0.1 as one decimal number
      'http://0x7f.0.0.1:8080/', // and in hex
      'http://169.254.169.254/latest/meta-data/', // cloud metadata
      'http://192.168.1.1/',
      'http://100.100.100.100/', // Tailscale
      'https://flint-1.tail7ed2c3.ts.net/',
      'http://[::ffff:127.0.0.1]/',
      'http://224.0.0.1/',
    ]) {
      await expect(assertPublicUrl(u, publicDns), u).rejects.toBeInstanceOf(UrlRefused);
    }
  });

  it('refuses a public-looking name that resolves to a private address', async () => {
    await expect(assertPublicUrl('https://evil.example/', async () => ['127.0.0.1'])).rejects.toThrow(/resolves to a private/);
    await expect(assertPublicUrl('https://evil.example/', async () => ['93.184.216.34', '10.0.0.5'])).rejects.toThrow(/private/);
  });

  it('refuses what is not http(s), what does not parse, and what does not resolve', async () => {
    await expect(assertPublicUrl('file:///etc/passwd', publicDns)).rejects.toThrow(/http\(s\)/);
    await expect(assertPublicUrl('ftp://example.com/', publicDns)).rejects.toThrow(/http\(s\)/);
    await expect(assertPublicUrl('not a url', publicDns)).rejects.toThrow(/valid URL/);
    const dns = assertPublicUrl('https://nx.example/', async () => { throw new Error('ENOTFOUND'); });
    await expect(dns).rejects.toThrow(/did not resolve/);
    // A DNS failure is a failed fetch, not a policy refusal: the tool must not say "refused".
    await expect(dns).rejects.not.toBeInstanceOf(UrlRefused);
  });

  // Review of #33: a service bound to `::` answers on this Mac's PUBLIC IPv6 address,
  // which no address range marks as local.
  it("refuses this machine's own addresses and its IPv6 /64, by literal or by DNS", async () => {
    const local = () => ({ exact: new Set(['2600:1702:5590:6aa0:2dab:1:2:3', '203.0.113.7']), v6Prefixes: new Set(['2600:1702:5590:6aa0']) });
    for (const u of ['http://[2600:1702:5590:6aa0:2dab:1:2:3]:9000/', 'http://[2600:1702:5590:6aa0::99]/', 'http://203.0.113.7/']) {
      await expect(assertPublicUrl(u, publicDns, { local }), u).rejects.toBeInstanceOf(UrlRefused);
    }
    await expect(assertPublicUrl('https://evil.example/', async () => ['2600:1702:5590:6aa0::1'], { local })).rejects.toBeInstanceOf(UrlRefused);
    // A different /64 is someone else's network.
    expect((await assertPublicUrl('http://[2600:1702:5590:6aa1::1]/', publicDns, { local })).hostname).toBe('[2600:1702:5590:6aa1::1]');
  });

  it('gives up on a DNS lookup when the caller aborts', async () => {
    const never = () => new Promise<string[]>(() => {});
    const ac = new AbortController();
    const pending = assertPublicUrl('https://slow.example/', never, { signal: ac.signal });
    ac.abort(new Error('timed out'));
    await expect(pending).rejects.toThrow(/timed out/);
  });

  it('passes a public URL', async () => {
    expect((await assertPublicUrl('https://example.com/a?b=1', publicDns)).href).toBe('https://example.com/a?b=1');
    expect((await assertPublicUrl('http://93.184.216.34/', async () => { throw new Error('no lookup for IPs'); })).hostname).toBe('93.184.216.34');
  });
});

describe('guardedFetch', () => {
  const reply = (status: number, location?: string) =>
    new Response(status >= 300 && status < 400 ? null : 'ok', { status, headers: location ? { location } : {} });

  // deep_research used to follow redirects and check only where it landed, by
  // which point the private request had been made.
  it('refuses a redirect to a private host BEFORE requesting it', async () => {
    const asked: string[] = [];
    const fetchImpl = (async (u: URL | string) => {
      asked.push(String(u));
      return reply(302, 'http://127.0.0.1:8080/');
    }) as unknown as typeof fetch;
    await expect(guardedFetch('https://example.com/', {}, { fetchImpl, resolve: publicDns })).rejects.toBeInstanceOf(UrlRefused);
    expect(asked).toEqual(['https://example.com/']);
  });

  it('follows public redirects (relative ones too) and returns the final response', async () => {
    const asked: string[] = [];
    const fetchImpl = (async (u: URL | string) => {
      asked.push(String(u));
      return asked.length === 1 ? reply(301, '/moved') : reply(200);
    }) as unknown as typeof fetch;
    const res = await guardedFetch('https://example.com/start', {}, { fetchImpl, resolve: publicDns });
    expect(res.status).toBe(200);
    expect(asked).toEqual(['https://example.com/start', 'https://example.com/moved']);
  });

  it('stops after too many redirects, as a failed fetch rather than a refusal', async () => {
    const fetchImpl = (async () => reply(302, 'https://example.com/again')) as unknown as typeof fetch;
    const run = guardedFetch('https://example.com/', {}, { fetchImpl, resolve: publicDns, maxRedirects: 3 });
    await expect(run).rejects.toThrow(/more than 3 redirects/);
    await expect(run).rejects.not.toBeInstanceOf(UrlRefused);
  });

  // Review of #33: a DOI link took exactly 5 hops; fetch's own limit is 20.
  it('follows up to 20 redirects by default, each one checked', async () => {
    let n = 0;
    const fetchImpl = (async () => (++n <= 20 ? reply(302, `https://example.com/${n}`) : reply(200))) as unknown as typeof fetch;
    expect((await guardedFetch('https://example.com/', {}, { fetchImpl, resolve: publicDns })).status).toBe(200);
    expect(n).toBe(21);
  });

  it('follows a Location sent as raw UTF-8 to the right path', async () => {
    const asked: string[] = [];
    const raw = Buffer.from('/target/münchen', 'utf8').toString('latin1'); // how fetch exposes the header
    const fetchImpl = (async (u: URL | string) => {
      asked.push(String(u));
      return asked.length === 1 ? reply(302, raw) : reply(200);
    }) as unknown as typeof fetch;
    await guardedFetch('https://example.com/', {}, { fetchImpl, resolve: publicDns });
    expect(asked[1]).toBe('https://example.com/target/m%C3%BCnchen');
  });

  it('never lets fetch follow redirects itself', async () => {
    let seen: RequestInit | undefined;
    const fetchImpl = (async (_u: URL | string, init?: RequestInit) => {
      seen = init;
      return reply(200);
    }) as unknown as typeof fetch;
    await guardedFetch('https://example.com/', { redirect: 'follow' }, { fetchImpl, resolve: publicDns });
    expect(seen?.redirect).toBe('manual');
  });
});

describe('isPrivateHost', () => {
  it('keeps public hosts public', () => {
    for (const h of ['reuters.com', '8.8.8.8', '172.40.0.1', '100.128.0.1', '2606:4700::1111']) expect(isPrivateHost(h), h).toBe(false);
  });
});

describe('decodeLocation', () => {
  it('leaves ASCII and invalid UTF-8 alone, and decodes raw UTF-8', () => {
    expect(decodeLocation('/a/b?c=1')).toBe('/a/b?c=1');
    expect(decodeLocation(Buffer.from('/münchen', 'utf8').toString('latin1'))).toBe('/münchen');
    expect(decodeLocation('/caf\u00e9')).toBe('/caf\u00e9'); // a lone latin1 byte is not valid UTF-8
  });
});

