import { describe, expect, it } from 'vitest';
import { dbFromEnv } from '../src/db';

// The connectors used to fall back to a development URL with its password in the
// (public) source when their env var was missing.
describe('dbFromEnv', () => {
  it('connects to nothing without its env var, and every query says what to set', async () => {
    const db = dbFromEnv('HIVE_DATABASE_URL', {});
    expect(db.configured).toBe(false);
    await expect(db.q('select 1')).rejects.toThrow(/HIVE_DATABASE_URL is not set/);
  });

  it('treats a blank value as unset', async () => {
    expect(dbFromEnv('X_DATABASE_URL', { X_DATABASE_URL: '   ' }).configured).toBe(false);
  });

  it('is configured when the URL is given (no connection is made until a query)', () => {
    expect(dbFromEnv('X_DATABASE_URL', { X_DATABASE_URL: 'postgresql://u:p@[::1]:1/x' }).configured).toBe(true);
  });
});
