import { describe, it, expect } from 'vitest';
import { UrlRefused, assertPublicUrl, guardedFetch, isPrivateHost } from '../src/url-guard';

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
    await expect(assertPublicUrl('https://nx.example/', async () => { throw new Error('ENOTFOUND'); })).rejects.toThrow(/did not resolve/);
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

  it('stops after too many redirects', async () => {
    const fetchImpl = (async () => reply(302, 'https://example.com/again')) as unknown as typeof fetch;
    await expect(guardedFetch('https://example.com/', {}, { fetchImpl, resolve: publicDns, maxRedirects: 3 })).rejects.toThrow(/more than 3 redirects/);
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
