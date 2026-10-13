/**
 * Where the database tests get their URLs (test/db.ts). Only the deploy gate may
 * read this Mac's own settings: a run started by hand with nothing in its
 * environment gets no database, so it can never reset the gate's under it.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { testUrls } from './db';

const KEYS = ['HOME', 'FLINT_DEPLOY_GATE', 'FLINT_DB_TEST_OWNER_URL', 'FLINT_DB_TEST_URL', 'FLINT_DB_TEST_APPROVER_URL', 'FLINT_DB_TEST_BACKUP_URL', 'FLINT_DB_TEST_RESTORE_URL'] as const;
const url = (role: string, db = 'flint_test', port = 5432) => `postgresql://${role}:pw@[::1]:${port}/${db}`;

describe('the URLs the database tests use', () => {
  let home = '';
  const saved: Partial<Record<(typeof KEYS)[number], string | undefined>> = {};

  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    // A stand-in home with the settings the real one has, so the fallback has something to find.
    home = mkdtempSync(join(tmpdir(), 'flint-dburls-'));
    mkdirSync(join(home, '.flint'));
    writeFileSync(
      join(home, '.flint', 'secrets.env'),
      [`FLINT_DB_TEST_OWNER_URL=${url('flint_owner')}`, `FLINT_DB_TEST_URL=${url('flint_app')}`, `FLINT_DB_APPROVER_URL=${url('flint_approver', 'flint')}`, ''].join('\n'),
    );
    process.env.HOME = home;
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(home, { recursive: true, force: true });
  });

  it('a run with nothing in its environment gets no database, whatever this Mac has saved', () => {
    expect(testUrls()).toBeUndefined();
  });

  it('any value but 1 for the gate flag is not the gate', () => {
    for (const v of ['0', 'true', 'yes', '']) {
      process.env.FLINT_DEPLOY_GATE = v;
      expect(testUrls(), v).toBeUndefined();
    }
  });

  it('the deploy gate reads the saved settings, and the approver is pointed at flint_test', () => {
    process.env.FLINT_DEPLOY_GATE = '1';
    const got = testUrls();
    expect(got?.owner).toBe(url('flint_owner'));
    expect(got?.app).toBe(url('flint_app'));
    expect(new URL(got!.approver).pathname).toBe('/flint_test');
  });

  it('URLs in the environment are used as they are, and the saved settings are not read', () => {
    process.env.FLINT_DB_TEST_OWNER_URL = url('flint_owner', 'flint_test', 55432);
    process.env.FLINT_DB_TEST_URL = url('flint_app', 'flint_test', 55432);
    process.env.FLINT_DB_TEST_APPROVER_URL = url('flint_approver', 'flint_test', 55432);
    process.env.FLINT_DEPLOY_GATE = '1';
    const got = testUrls();
    expect([got?.owner, got?.app, got?.approver].every((u) => new URL(u!).port === '55432')).toBe(true);
  });

  it('a URL that names any database but flint_test is refused, in the gate too', () => {
    writeFileSync(
      join(home, '.flint', 'secrets.env'),
      [`FLINT_DB_TEST_OWNER_URL=${url('flint_owner', 'flint')}`, `FLINT_DB_TEST_URL=${url('flint_app')}`, `FLINT_DB_APPROVER_URL=${url('flint_approver', 'flint')}`, ''].join('\n'),
    );
    process.env.FLINT_DEPLOY_GATE = '1';
    expect(() => testUrls()).toThrow(/only ever touch the flint_test database/);
  });
});
