/**
 * Backups and the restore drill (plan P1 exit criterion 8), against flint_test:
 * the dump is read-only (flint_backup), 0600, and its counts come from the same
 * snapshot; the drill restores into a scratch database as flint_restore and
 * catches a mismatch; offsite copies are never plaintext.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NO_DB, URLS, freshDb } from './db';
import { execFileSync } from 'node:child_process';
import { dumpDatabase, encryptTo, newestDump, pruneDumps, restoreDrill, type Tools } from '../src/backup/backup';

const bin = (n: string) => ['/opt/homebrew/opt/postgresql@17/bin', '/usr/lib/postgresql/17/bin', '/opt/homebrew/bin', '/usr/bin'].map((d) => join(d, n)).find((p) => existsSync(p));
const tools: Tools = { pgDump: bin('pg_dump') ?? 'pg_dump', pgRestore: bin('pg_restore') ?? 'pg_restore' };
/** pg_dump refuses a newer server, so the drill needs a version-17 client (CI images may carry 16). */
const clientMajor = (() => {
  try {
    return Number(/(\d+)\./.exec(execFileSync(tools.pgDump, ['--version'], { encoding: 'utf8' }))?.[1] ?? 0);
  } catch {
    return 0;
  }
})();
const READY = !NO_DB && !!URLS?.backup && !!URLS?.restore && clientMajor >= 17;

describe('offsite copies', () => {
  it('are refused without a real age recipient or without age, never written in plaintext', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'flint-bk-'));
    writeFileSync(join(dir, 'x.dump'), 'data');
    await expect(encryptTo(join(dir, 'x.dump'), 'not-a-key', tools, dir)).rejects.toThrow(/age public key/);
    await expect(encryptTo(join(dir, 'x.dump'), `age1${'q'.repeat(58)}`, { ...tools, age: '/nonexistent/age' }, dir)).rejects.toThrow(/not installed/);
    expect(readdirSync(dir)).toEqual(['x.dump']);
  });

  it('pruning keeps the newest dumps and their counts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flint-bk-'));
    for (const d of ['2026-09-01', '2026-09-02', '2026-09-03']) {
      writeFileSync(join(dir, `flint-${d}.dump`), '');
      writeFileSync(join(dir, `flint-${d}.dump.counts.json`), '{}');
    }
    expect(pruneDumps(dir, 2)).toEqual(['flint-2026-09-01.dump']);
    expect(readdirSync(dir).sort()).toEqual(['flint-2026-09-02.dump', 'flint-2026-09-02.dump.counts.json', 'flint-2026-09-03.dump', 'flint-2026-09-03.dump.counts.json']);
    expect(newestDump(dir)).toBe(join(dir, 'flint-2026-09-03.dump'));
  });
});

describe.skipIf(!READY)('dump and restore drill (flint_test)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flint-bk-'));
  let dump = '';

  beforeAll(async () => {
    await freshDb();
  });

  it('dumps as flint_backup, 0600, with counts from the same snapshot', async () => {
    const d = await dumpDatabase(URLS!.backup!, dir, tools, new Date());
    dump = d.path;
    expect(statSync(d.path).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(d.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(d.counts)).toContain('public."Proposal"');
    expect(readdirSync(dir).some((f) => f.endsWith('.partial'))).toBe(false);
  });

  it('the drill restores into a scratch database and matches every count', async () => {
    const r = await restoreDrill(dump, URLS!.restore!, tools);
    expect(r).toMatchObject({ ok: true, mismatches: [] });
    expect(r.tables).toBeGreaterThan(15);
  });

  it('the drill catches a mismatch', async () => {
    const counts = JSON.parse(readFileSync(`${dump}.counts.json`, 'utf8')) as Record<string, number>;
    counts['public."Proposal"'] = (counts['public."Proposal"'] ?? 0) + 1;
    writeFileSync(`${dump}.counts.json`, JSON.stringify(counts));
    const r = await restoreDrill(dump, URLS!.restore!, tools);
    expect(r.ok).toBe(false);
    expect(r.mismatches).toEqual([{ table: 'public."Proposal"', expected: counts['public."Proposal"'], restored: counts['public."Proposal"']! - 1 }]);
  });
});
