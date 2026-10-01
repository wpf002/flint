import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config';

describe('runtime config', () => {
  it('defaults to IPv6 loopback on 8090', () => {
    expect(loadConfig({ DATABASE_URL: 'postgresql://flint_app:x@[::1]:5432/flint' })).toMatchObject({ RUNTIME_HOST: '::1', RUNTIME_PORT: 8090 });
  });

  it('refuses a non-loopback host and a non-postgres URL', () => {
    expect(() => loadConfig({ DATABASE_URL: 'postgresql://a@[::1]/flint', RUNTIME_HOST: '0.0.0.0' })).toThrow(/RUNTIME_HOST/);
    expect(() => loadConfig({ DATABASE_URL: 'mysql://a@localhost/flint' })).toThrow(/DATABASE_URL/);
  });

  it('never echoes a value in its error', () => {
    try {
      loadConfig({ DATABASE_URL: 'not a url with hunter2', RUNTIME_TOKEN_SHA256: 'secretsecret' });
      throw new Error('should have thrown');
    } catch (e) {
      expect(String(e)).not.toMatch(/hunter2|secretsecret/);
    }
  });
});
