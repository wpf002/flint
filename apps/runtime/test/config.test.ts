import { describe, it, expect } from 'vitest';
import { loadConfig, parseTokens } from '../src/config';

const DB = 'postgresql://flint_app:x@[::1]:5432/flint';
const HOME = '/Users/test';
const H = 'a'.repeat(64);

describe('runtime config', () => {
  it('defaults to IPv6 loopback on 8090', () => {
    expect(loadConfig({ DATABASE_URL: DB, HOME })).toMatchObject({ host: '::1', port: 8090, tokens: [] });
  });

  it('refuses a non-loopback host and a non-postgres URL', () => {
    expect(() => loadConfig({ DATABASE_URL: DB, RUNTIME_HOST: '0.0.0.0' })).toThrow(/RUNTIME_HOST/);
    expect(() => loadConfig({ DATABASE_URL: 'mysql://a@localhost/flint' })).toThrow(/DATABASE_URL/);
  });

  it('never echoes a value in its error', () => {
    for (const env of [{ DATABASE_URL: 'not a url with hunter2' }, { DATABASE_URL: DB, RUNTIME_TOKENS: 'server:hunter2hunter2:audit' }]) {
      try {
        loadConfig(env);
        throw new Error('should have thrown');
      } catch (e) {
        expect(String(e)).not.toMatch(/hunter2/);
        expect(String(e)).toMatch(/invalid/);
      }
    }
  });

  it('parses token grants with their scopes, and refuses unknown scopes and repeats', () => {
    const [g] = parseTokens(`server:${H}:audit|proposals|world:read`);
    expect(g!.name).toBe('server');
    expect([...g!.scopes]).toEqual(['audit', 'proposals', 'world:read']);
    expect(() => parseTokens(`server:${H}:root`)).toThrow(/unknown scope/);
    expect(() => parseTokens(`a:${H}:audit,a:${H}:ledger`)).toThrow(/twice/);
    expect(() => parseTokens('server:short:audit')).toThrow(/malformed/);
  });

  it('reads caps and off-box health URLs, and refuses credentials in them', () => {
    const c = loadConfig({ DATABASE_URL: DB, HOME, FLINT_BUDGET_ANTHROPIC_DAILY_USD: '10', FLINT_BUDGET_ANTHROPIC_MONTHLY_USD: '150', HEALTH_EXTRA: 'nexus-mcp=https://nexus.example.app/health' });
    expect(c.caps.anthropic).toEqual({ dailyUsd: 10, monthlyUsd: 150 });
    expect(c.caps.openai).toEqual({});
    expect(c.healthExtra).toEqual([{ name: 'nexus-mcp', url: 'https://nexus.example.app/health' }]);
    expect(() => loadConfig({ DATABASE_URL: DB, HOME, HEALTH_EXTRA: 'x=https://u:p@h.example/health' })).toThrow(/credentials/);
    expect(() => loadConfig({ DATABASE_URL: DB, HOME, HEALTH_EXTRA: 'x=http://h.example/health' })).toThrow(/https/);
  });

  it('passkey origins must be https', () => {
    expect(() => loadConfig({ DATABASE_URL: DB, HOME, FLINT_RP_ID: 'flint.example.ts.net', FLINT_RP_ORIGINS: 'http://flint.example.ts.net' })).toThrow(/https/);
    expect(loadConfig({ DATABASE_URL: DB, HOME, FLINT_RP_ID: 'flint.example.ts.net', FLINT_RP_ORIGINS: 'https://flint.example.ts.net' }).rp).toEqual({ rpId: 'flint.example.ts.net', origins: ['https://flint.example.ts.net'] });
  });
});
