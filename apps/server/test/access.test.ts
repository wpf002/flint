import { describe, expect, it } from 'vitest';
import { DEFAULT_BIND_HOST, allowedTailnetUser, bearerMatches, consoleGetsToken, hostName, requestVia, tailnetAllowed, tailnetLogin } from '../src/access';

const local = { remoteAddress: '127.0.0.1', headers: { host: 'localhost:8080' } };
/** What `tailscale serve` delivers: it also connects from 127.0.0.1, with the tailnet name and the login. */
const viaServe = (login?: string) => ({
  remoteAddress: '127.0.0.1',
  headers: { host: 'flint-1.tail7ed2c3.ts.net', 'x-forwarded-for': '100.101.102.103', ...(login ? { 'tailscale-user-login': login } : {}) },
});
const WILL = 'wfoti71992@gmail.com';

describe('requestVia', () => {
  it('is local only for a loopback source with a loopback Host and no proxy headers', () => {
    expect(requestVia(local)).toBe('local');
    expect(requestVia({ remoteAddress: '::1', headers: { host: '[::1]:8080' } })).toBe('local');
    expect(requestVia({ remoteAddress: '::ffff:127.0.0.1', headers: { host: '127.0.0.1' } })).toBe('local');
  });

  // The audit's point: serve connects from 127.0.0.1 too, so the source alone proves nothing.
  it('treats anything forwarded or addressed by another name as tailnet', () => {
    expect(requestVia(viaServe(WILL))).toBe('tailnet');
    expect(requestVia({ remoteAddress: '127.0.0.1', headers: { host: 'localhost', 'x-forwarded-for': '100.1.2.3' } })).toBe('tailnet');
    expect(requestVia({ remoteAddress: '127.0.0.1', headers: { host: 'localhost', 'tailscale-user-login': WILL } })).toBe('tailnet');
    expect(requestVia({ remoteAddress: '127.0.0.1', headers: { host: 'localhost', forwarded: 'for=100.1.2.3' } })).toBe('tailnet');
    expect(requestVia({ remoteAddress: '127.0.0.1', headers: { host: 'studio' } })).toBe('tailnet');
    expect(requestVia({ remoteAddress: '127.0.0.1', headers: {} })).toBe('tailnet');
    expect(requestVia({ remoteAddress: '100.64.0.5', headers: { host: 'localhost' } })).toBe('tailnet');
    expect(requestVia({ remoteAddress: undefined, headers: { host: 'localhost' } })).toBe('tailnet');
  });
});

describe('the console token', () => {
  it('goes to this Mac', () => {
    expect(consoleGetsToken(local, undefined)).toBe(true);
    expect(consoleGetsToken(local, WILL)).toBe(true);
  });

  it("goes to Will's own tailnet login once FLINT_TAILNET_USER names it, case-insensitively", () => {
    expect(consoleGetsToken(viaServe('WFoti71992@Gmail.com'), WILL)).toBe(true);
  });

  // Before: every tailnet device and login got it, and so did anything that could make Flint fetch its own page.
  it('does not go to another login, a tagged device (no login), or any tailnet request while the user is unset', () => {
    expect(consoleGetsToken(viaServe('someone@else.com'), WILL)).toBe(false);
    expect(consoleGetsToken(viaServe(), WILL)).toBe(false);
    expect(consoleGetsToken(viaServe(WILL), undefined)).toBe(false);
  });
});

describe('tailnet access', () => {
  it('is restricted to the allowed login once one is set', () => {
    expect(tailnetAllowed(viaServe(WILL), WILL)).toBe(true);
    expect(tailnetAllowed(viaServe('someone@else.com'), WILL)).toBe(false);
    expect(tailnetAllowed(viaServe(), WILL)).toBe(false);
    expect(tailnetAllowed(local, WILL)).toBe(true);
  });

  it('is unrestricted while FLINT_TAILNET_USER is unset (the bearer token still applies)', () => {
    expect(tailnetAllowed(viaServe('someone@else.com'), undefined)).toBe(true);
  });

  it('reads the login and the setting normalised', () => {
    expect(tailnetLogin(viaServe(' Will@X.com '))).toBe('will@x.com');
    expect(tailnetLogin(viaServe())).toBeUndefined();
    expect(allowedTailnetUser({ FLINT_TAILNET_USER: ' Will@X.com ' })).toBe('will@x.com');
    expect(allowedTailnetUser({ FLINT_TAILNET_USER: '  ' })).toBeUndefined();
    expect(allowedTailnetUser({})).toBeUndefined();
  });
});

describe('bearerMatches', () => {
  it('accepts exactly `Bearer <token>`', () => {
    expect(bearerMatches('Bearer s3cret', 's3cret')).toBe(true);
    for (const bad of [undefined, '', 'Bearer s3cre', 'Bearer s3cret ', 'bearer s3cret', 's3cret', 'Bearer S3CRET']) {
      expect(bearerMatches(bad, 's3cret'), String(bad)).toBe(false);
    }
  });
});

// Review of #34: userspace tailscaled forwards peers to 127.0.0.1 raw, so Flint
// listens where that forward cannot reach.
describe('where Flint listens', () => {
  it('is IPv6 loopback, never 127.0.0.1', () => {
    expect(DEFAULT_BIND_HOST).toBe('::1');
  });
});

describe('hostName', () => {
  it('takes the host from a Host header, IPv6 brackets included', () => {
    expect(hostName('localhost:8080')).toBe('localhost');
    expect(hostName('[::1]:8080')).toBe('[::1]');
    expect(hostName('[::1]')).toBe('[::1]');
    expect(hostName('Flint-1.Tail7ed2c3.TS.net')).toBe('flint-1.tail7ed2c3.ts.net');
    expect(hostName(undefined)).toBe('');
  });
});

