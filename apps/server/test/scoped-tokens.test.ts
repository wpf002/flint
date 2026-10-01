import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureScopedTokens } from '../src/scoped-tokens';

describe('ensureScopedTokens', () => {
  it('makes one 0600 token per client in a 0700 dir, and keeps them across restarts', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'tok-')), 'tokens');
    const first = ensureScopedTokens(dir);
    expect(first.map((t) => t.name)).toEqual(['evolve', 'parity', 'voice']);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    for (const t of first) {
      expect(t.token).toMatch(/^[0-9a-f]{64}$/);
      expect(statSync(join(dir, `${t.name}.token`)).mode & 0o777).toBe(0o600);
      expect(readFileSync(join(dir, `${t.name}.token`), 'utf8').trim()).toBe(t.token);
    }
    expect(new Set(first.map((t) => t.token)).size).toBe(3);
    expect(ensureScopedTokens(dir).map((t) => t.token)).toEqual(first.map((t) => t.token));
  });

  // Review of #36: an empty or truncated file used to be kept, scope silently off.
  it('replaces an empty or cut-short token file', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'tok-')), 'tokens');
    ensureScopedTokens(dir);
    writeFileSync(join(dir, 'evolve.token'), '');
    writeFileSync(join(dir, 'parity.token'), 'abc123\n');
    const again = ensureScopedTokens(dir);
    for (const t of again) expect(t.token, t.name).toMatch(/^[0-9a-f]{64}$/);
  });
});

