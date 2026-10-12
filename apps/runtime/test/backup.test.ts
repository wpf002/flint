/**
 * Backups and the restore drill (plan P1 exit criterion 8), against flint_test:
 * the dump is read-only (flint_backup), 0600, and its counts come from the same
 * snapshot; the drill restores into a scratch database as flint_restore and
 * catches a mismatch; offsite copies are never plaintext.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmdirSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NO_DB, URLS, freshDb } from './db';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dumpDatabase, encryptTo, newestDump, pruneDumps, pruneOffsite, restoreDrill, type Tools } from '../src/backup/backup';

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

describe('the encrypted copies offsite', () => {
  const RECIPIENT = `age1${'q'.repeat(58)}`;
  /** A stand-in for age: ciphertext that is not the dump, on its stdout (as age does without -o). `fail`: it stops part way. */
  function fakeAge(dir: string, fail = false): string {
    const bin = join(dir, fail ? 'age-failing' : 'age');
    writeFileSync(bin, `#!/bin/sh\nprintf "age-encryption.org/v1 sealed"\n${fail ? 'echo "age: error: disk full" >&2\nexit 1\n' : ''}`);
    chmodSync(bin, 0o755);
    return bin;
  }
  const night = (n: number) => `flint-2026-10-${String(n).padStart(2, '0')}T07-15-00-000Z.dump`;
  const fixture = () => {
    const root = mkdtempSync(join(tmpdir(), 'flint-off-'));
    const dumps = join(root, 'pg');
    const offsite = join(root, 'icloud', 'FlintBackups', 'pg');
    mkdirSync(dumps, { recursive: true });
    return { root, dumps, offsite, manifest: join(dumps, 'offsite-copies.txt'), age: fakeAge(root) };
  };

  it('keep the newest 7, by name from the manifest, and only ciphertext is ever written there', async () => {
    const f = fixture();
    for (let n = 1; n <= 10; n++) {
      writeFileSync(join(f.dumps, night(n)), `PLAINTEXT rows of night ${n}`);
      const e = await encryptTo(join(f.dumps, night(n)), RECIPIENT, { ...tools, age: f.age }, f.offsite);
      const gone = pruneOffsite(f.offsite, f.manifest, `${night(n)}.age`, 7, f.dumps);
      expect(e.path).toBe(join(f.offsite, `${night(n)}.age`));
      // Its size and hash are the ciphertext's, taken as it was written (nothing is read back from the folder).
      expect(e).toMatchObject({ bytes: 'age-encryption.org/v1 sealed'.length, sha256: createHash('sha256').update('age-encryption.org/v1 sealed').digest('hex') });
      expect(gone).toEqual(n > 7 ? [`${night(n - 7)}.age`] : []);
    }
    const kept = readdirSync(f.offsite).sort();
    expect(kept).toEqual([4, 5, 6, 7, 8, 9, 10].map((n) => `${night(n)}.age`));
    // Nothing but encrypted copies, and none of them holds the dump's bytes.
    for (const name of kept) {
      expect(name).toMatch(/\.dump\.age$/);
      expect(readFileSync(join(f.offsite, name), 'utf8')).not.toContain('PLAINTEXT');
    }
    expect(readFileSync(f.manifest, 'utf8').trim().split('\n')).toEqual(kept);
    expect(statSync(f.manifest).mode & 0o777).toBe(0o600);
    // The local dumps are not the offsite job's to prune.
    expect(readdirSync(f.dumps).filter((x) => x.endsWith('.dump'))).toHaveLength(10);
  });

  it('never lists the offsite folder: a stray file there is left alone, and a first run starts from the local dumps’ names', () => {
    const f = fixture();
    mkdirSync(f.offsite, { recursive: true });
    for (let n = 1; n <= 9; n++) {
      writeFileSync(join(f.dumps, night(n)), '');
      writeFileSync(join(f.offsite, `${night(n)}.age`), 'sealed');
    }
    writeFileSync(join(f.offsite, 'notes.txt'), 'not Flint’s');
    writeFileSync(join(f.offsite, 'flint-0000.dump.age'), 'a copy no manifest and no local dump names');
    // No manifest yet: night 9's copy was just written; the names come from the local dumps.
    expect(pruneOffsite(f.offsite, f.manifest, `${night(9)}.age`, 7, f.dumps)).toEqual([`${night(1)}.age`, `${night(2)}.age`]);
    expect(readdirSync(f.offsite).sort()).toEqual(['flint-0000.dump.age', ...[3, 4, 5, 6, 7, 8, 9].map((n) => `${night(n)}.age`), 'notes.txt'].sort());
    // Recording the same copy twice changes nothing.
    expect(pruneOffsite(f.offsite, f.manifest, `${night(9)}.age`, 7, f.dumps)).toEqual([]);
    expect(readFileSync(f.manifest, 'utf8').trim().split('\n')).toEqual([3, 4, 5, 6, 7, 8, 9].map((n) => `${night(n)}.age`));
  });

  it('removes only names it wrote: a manifest line that is not an encrypted copy’s name is never a path to delete', () => {
    const f = fixture();
    mkdirSync(f.offsite, { recursive: true });
    const outside = join(f.root, 'keep.txt');
    writeFileSync(outside, 'keep');
    writeFileSync(f.manifest, ['../../keep.txt', '/etc/hosts', 'flint-x.dump', ...[1, 2].map((n) => `${night(n)}.age`)].join('\n'));
    expect(pruneOffsite(f.offsite, f.manifest, `${night(3)}.age`, 1, f.dumps)).toEqual([`${night(1)}.age`, `${night(2)}.age`]);
    expect(existsSync(outside)).toBe(true);
    expect(readFileSync(f.manifest, 'utf8')).toBe(`${night(3)}.age\n`);
    expect(() => pruneOffsite(f.offsite, f.manifest, '../x.age', 7)).toThrow(/encrypted copy/);
  });

  it('a copy that will not delete stays in the manifest and is tried again the next night', () => {
    const f = fixture();
    mkdirSync(f.offsite, { recursive: true });
    // Night 1's copy cannot be removed as a file (it is a folder here, standing in for a refusal).
    mkdirSync(join(f.offsite, `${night(1)}.age`));
    writeFileSync(f.manifest, `${night(1)}.age\n`);
    expect(pruneOffsite(f.offsite, f.manifest, `${night(2)}.age`, 1)).toEqual([]);
    expect(readFileSync(f.manifest, 'utf8')).toBe(`${night(1)}.age\n${night(2)}.age\n`);
    // Once it can go, it does, and the manifest is back to what is kept.
    rmdirSync(join(f.offsite, `${night(1)}.age`));
    writeFileSync(join(f.offsite, `${night(1)}.age`), 'sealed');
    expect(pruneOffsite(f.offsite, f.manifest, `${night(3)}.age`, 1)).toEqual([`${night(1)}.age`, `${night(2)}.age`]);
    expect(readFileSync(f.manifest, 'utf8')).toBe(`${night(3)}.age\n`);
  });

  it('a night that cannot encrypt writes nothing offsite and costs no older copy', async () => {
    const f = fixture();
    mkdirSync(f.offsite, { recursive: true });
    writeFileSync(join(f.offsite, `${night(1)}.age`), 'sealed');
    writeFileSync(join(f.dumps, night(2)), 'PLAINTEXT');
    await expect(encryptTo(join(f.dumps, night(2)), RECIPIENT, { ...tools, age: '/nonexistent/age' }, f.offsite)).rejects.toThrow(/not installed/);
    await expect(encryptTo(join(f.dumps, night(2)), 'not-a-key', { ...tools, age: f.age }, f.offsite)).rejects.toThrow(/age public key/);
    // age stopping part way leaves no half-written copy under any name.
    await expect(encryptTo(join(f.dumps, night(2)), RECIPIENT, { ...tools, age: fakeAge(f.root, true) }, f.offsite)).rejects.toThrow(/age exited 1: age: error: disk full/);
    expect(readdirSync(f.offsite)).toEqual([`${night(1)}.age`]);
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
