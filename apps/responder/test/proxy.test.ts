import { describe, it, expect } from 'vitest';
import { hostAllowed, ALLOWED_HOSTS } from '../src/proxy.js';

/*
 * The proxy is the only way out of a build container, so its allowlist is the security
 * boundary. These are the cases that matter: not that npm works, but that everything
 * dressed up to look like npm does not.
 */

describe('what the build container may reach', () => {
  it('allows the package registries', () => {
    expect(hostAllowed('registry.npmjs.org:443')).toBe(true);
    expect(hostAllowed('files.pythonhosted.org:443')).toBe(true);
  });

  it('allows a subdomain of an allowed host', () => {
    expect(hostAllowed('cdn.registry.npmjs.org:443')).toBe(true);
  });

  /*
   * A plain endsWith would let this through, and it is exactly what an attacker
   * registers. The match has to be the whole host or a dot-separated suffix of it.
   */
  it('refuses a host merely ending in an allowed name', () => {
    expect(hostAllowed('registry.npmjs.org.evil.test:443')).toBe(false);
    expect(hostAllowed('notnpmjs.com:443')).toBe(false);
  });

  it('refuses everywhere else', () => {
    expect(hostAllowed('example.com:443')).toBe(false);
    expect(hostAllowed('169.254.169.254:80')).toBe(false);
    expect(hostAllowed('localhost:8080')).toBe(false);
  });

  it('refuses nothing at all', () => {
    expect(hostAllowed('')).toBe(false);
    expect(hostAllowed(':443')).toBe(false);
  });

  it('is case-insensitive, since a hostname is', () => {
    expect(hostAllowed('REGISTRY.NPMJS.ORG:443')).toBe(true);
  });

  it('honours a caller-supplied list rather than only the default', () => {
    expect(hostAllowed('internal.test:443', ['internal.test'])).toBe(true);
    expect(hostAllowed('registry.npmjs.org:443', ['internal.test'])).toBe(false);
  });

  it('lists the registries a build actually needs', () => {
    expect(ALLOWED_HOSTS).toContain('registry.npmjs.org');
    expect(ALLOWED_HOSTS).toContain('pypi.org');
  });
});
