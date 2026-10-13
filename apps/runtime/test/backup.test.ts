/**
 * Backups and the restore drill (plan P1 exit criterion 8), against flint_test:
 * the dump is read-only (flint_backup), 0600, and its counts come from the same
 * snapshot; the drill restores into a scratch database as flint_restore and
 * catches a mismatch; offsite copies are never plaintext.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmdirSync, rmSync, statSync, utimesSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MIGRATIONS, NO_DB, URLS, freshDb, migrateUp, withClient } from './db';
import { createDb } from '../src/db';
import { fileBackup, fileFailure } from '../src/backup/record';
import { execFileSync, spawnSync } from 'node:child_process';
import type pg from 'pg';
import { createHash, randomBytes } from 'node:crypto';
import { DUMP_FORMAT, dumpDatabase, encryptTo, needsSetup, NeedsSetup, newestDump, pruneDumps, pruneOffsite, restoreDrill, STALE_PARTIAL_MS, type Tools } from '../src/backup/backup';
import { sendOffsite, type OffsiteConfig } from '../src/backup/offsite';

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
/** The real age and its key maker, where Homebrew puts them (the round trip below is skipped without them). */
const AGE = bin('age');
const AGE_KEYGEN = bin('age-keygen');

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

describe('how a dump is taken', () => {
  it('every dump of Flint’s database is taken without large objects: the nightly one, and the deploy’s before a migration', () => {
    expect([...DUMP_FORMAT]).toEqual(['-Fc', '--no-large-objects']);
    const src = (f: string) => readFileSync(join(__dirname, '..', f), 'utf8');
    // Each place pg_dump is run: with the format above, or for the schema alone (which never holds one).
    const calls = ['src/backup/backup.ts', 'src/backup/restore.ts'].flatMap((f) => src(f).split('\n').filter((l) => /run\(tools\.pgDump,/.test(l)));
    expect(calls.length).toBe(2);
    for (const l of calls) expect(l).toMatch(/\.\.\.DUMP_FORMAT|'--schema-only'/);
    const deploy = src('install-runtime.sh').split('\n').filter((l) => /"\$PG_DUMP" /.test(l));
    expect(deploy).toHaveLength(1);
    expect(deploy[0]).toContain('"$PG_DUMP" -Fc --no-large-objects ');
  });
});

describe('the encrypted copies offsite', () => {
  const RECIPIENT = `age1${'q'.repeat(58)}`;
  /** What the stand-in for age writes: an age file's first line, then ciphertext that is not the dump. */
  const SEALED = 'age-encryption.org/v1\n-> X25519 stand-in\nsealed';
  /** A stand-in for age: its ciphertext on stdout (as age does without -o). `how`: it stops part way, or passes the dump through. */
  function fakeAge(dir: string, how: 'ok' | 'fails' | 'plaintext' = 'ok'): string {
    const bin = join(dir, `age-${how}`);
    // A single-quoted shell string keeps its newlines as they are.
    const body = how === 'plaintext' ? 'for last; do :; done\ncat "$last"\n' : `printf '%s' '${SEALED}'\n${how === 'fails' ? 'echo "age: error: disk full" >&2\necho "age: report unexpected or unhelpful errors at the usual place" >&2\nexit 1\n' : ''}`;
    writeFileSync(bin, `#!/bin/sh\n${body}`);
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
  const manifestOf = (f: { manifest: string }) => readFileSync(f.manifest, 'utf8').trim().split('\n');

  it('keep the newest 7, by name from the manifest, and only ciphertext is ever written there', async () => {
    const f = fixture();
    for (let n = 1; n <= 10; n++) {
      writeFileSync(join(f.dumps, night(n)), `PLAINTEXT rows of night ${n}`);
      const e = await encryptTo(join(f.dumps, night(n)), RECIPIENT, { ...tools, age: f.age }, f.offsite);
      const gone = pruneOffsite(f.offsite, f.manifest, `${night(n)}.age`, 7, { dumpDir: f.dumps });
      expect(e.path).toBe(join(f.offsite, `${night(n)}.age`));
      // Its size and hash are the ciphertext's, taken as it was written (nothing is read back from the folder).
      expect(e).toMatchObject({ bytes: SEALED.length, sha256: createHash('sha256').update(SEALED).digest('hex') });
      expect(gone).toEqual(n > 7 ? [`${night(n - 7)}.age`] : []);
    }
    const kept = readdirSync(f.offsite).sort();
    expect(kept).toEqual([4, 5, 6, 7, 8, 9, 10].map((n) => `${night(n)}.age`));
    // Nothing but encrypted copies, and none of them holds the dump's bytes.
    for (const name of kept) {
      expect(name).toMatch(/\.dump\.age$/);
      expect(readFileSync(join(f.offsite, name), 'utf8')).toBe(SEALED);
      expect(statSync(join(f.offsite, name)).mode & 0o777).toBe(0o600);
    }
    expect(manifestOf(f)).toEqual(kept);
    expect(statSync(f.manifest).mode & 0o777).toBe(0o600);
    // The local dumps are not the offsite job's to prune.
    expect(readdirSync(f.dumps).filter((x) => x.endsWith('.dump'))).toHaveLength(10);
  });

  it('nothing is written until the stream begins as an age file does: a stand-in that passes the dump through never puts a byte offsite, not even as a partial', async () => {
    const f = fixture();
    mkdirSync(f.offsite, { recursive: true });
    const pass = fakeAge(f.root, 'plaintext');
    // The offsite folder refuses every write: had the code opened a file before seeing age's header, this
    // would fail as a refused write. It fails as "not an age file" instead: no file was ever asked for.
    chmodSync(f.offsite, 0o500);
    try {
      for (const dump of ['PLAINTEXT rows', `PLAINTEXT ${'rows of the database, '.repeat(40_000)}`]) {
        writeFileSync(join(f.dumps, night(1)), dump);
        const err = await encryptTo(join(f.dumps, night(1)), RECIPIENT, { ...tools, age: pass }, f.offsite).then(() => undefined, (e: unknown) => e);
        expect(err).toBeInstanceOf(NeedsSetup);
        expect(String(err)).toMatch(/did not write an age file, so nothing was written/);
        expect((err as { code?: string }).code).toBeUndefined();
        expect(readdirSync(f.offsite)).toEqual([]);
      }
      // The folder really does refuse: the real stand-in, which writes age's header first, is stopped at the file.
      const refused = await encryptTo(join(f.dumps, night(1)), RECIPIENT, { ...tools, age: f.age }, f.offsite).then(() => undefined, (e: unknown) => e);
      expect((refused as { code?: string }).code).toBe('EACCES');
      expect(needsSetup(refused)).toBe(true);
    } finally {
      chmodSync(f.offsite, 0o700);
    }
    expect(readdirSync(f.offsite)).toEqual([]);
    // A header that comes in pieces is still a header: the copy is whole, and its hash is the stream's.
    const slow = join(f.root, 'age-slow');
    writeFileSync(slow, `#!/bin/sh\nprintf 'age-encry'\nsleep 0.1\nprintf 'ption.org/v1'\nsleep 0.1\nprintf '\\n-> X25519 stand-in\\nsealed'\n`);
    chmodSync(slow, 0o755);
    const e = await encryptTo(join(f.dumps, night(1)), RECIPIENT, { ...tools, age: slow }, f.offsite);
    expect(readFileSync(e.path, 'utf8')).toBe(SEALED);
    expect(e).toMatchObject({ bytes: SEALED.length, sha256: createHash('sha256').update(SEALED).digest('hex') });
    // An age that says nothing at all, or stops inside its header, wrote no age file either.
    for (const said of ['', 'age-encryption.org']) {
      const quiet = join(f.root, 'age-quiet');
      writeFileSync(quiet, `#!/bin/sh\nprintf '%s' '${said}'\n`);
      chmodSync(quiet, 0o755);
      await expect(encryptTo(join(f.dumps, night(2)), RECIPIENT, { ...tools, age: quiet }, f.offsite)).rejects.toThrow(/did not write an age file/);
    }
    expect(readdirSync(f.offsite)).toEqual([`${night(1)}.age`]);
  });

  it('never lists the offsite folder: a stray file there is left alone, and a copy no record names is found by its dump’s name', () => {
    const f = fixture();
    mkdirSync(f.offsite, { recursive: true });
    for (let n = 1; n <= 9; n++) {
      writeFileSync(join(f.dumps, night(n)), '');
      writeFileSync(join(f.offsite, `${night(n)}.age`), 'sealed');
    }
    writeFileSync(join(f.offsite, 'notes.txt'), 'not Flint’s');
    writeFileSync(join(f.offsite, 'flint-0000.dump.age'), 'a copy no manifest, no record and no local dump names');
    // No manifest and no records: night 9's copy was just written; the others are asked for by name.
    expect(pruneOffsite(f.offsite, f.manifest, `${night(9)}.age`, 7, { dumpDir: f.dumps })).toEqual([`${night(1)}.age`, `${night(2)}.age`]);
    expect(readdirSync(f.offsite).sort()).toEqual(['flint-0000.dump.age', ...[3, 4, 5, 6, 7, 8, 9].map((n) => `${night(n)}.age`), 'notes.txt'].sort());
    // Recording the same copy twice changes nothing.
    expect(pruneOffsite(f.offsite, f.manifest, `${night(9)}.age`, 7, { dumpDir: f.dumps })).toEqual([]);
    expect(manifestOf(f)).toEqual([3, 4, 5, 6, 7, 8, 9].map((n) => `${night(n)}.age`));
  });

  it('a local dump whose copy was never made is not counted as one: it never pushes a real copy out', () => {
    const f = fixture();
    mkdirSync(f.offsite, { recursive: true });
    // Fourteen local dumps (the backup has run for two weeks); the offsite copy has only ever worked tonight.
    for (let n = 1; n <= 14; n++) writeFileSync(join(f.dumps, night(n)), '');
    writeFileSync(join(f.offsite, `${night(14)}.age`), 'sealed');
    expect(pruneOffsite(f.offsite, f.manifest, `${night(14)}.age`, 7, { dumpDir: f.dumps })).toEqual([]);
    expect(manifestOf(f)).toEqual([`${night(14)}.age`]);
  });

  it('tonight’s copy is never the one that goes, whatever its name: an older dump sent again with seven newer copies on record', () => {
    const f = fixture();
    mkdirSync(f.offsite, { recursive: true });
    // The backup has failed for a while, so tonight the offsite job sent night 3's dump again. Seven newer copies are on record.
    const newer = [10, 11, 12, 13, 14, 15, 16].map((n) => `${night(n)}.age`);
    for (const name of [...newer, `${night(3)}.age`]) writeFileSync(join(f.offsite, name), 'sealed');
    writeFileSync(f.manifest, newer.join('\n'));
    // By name, tonight's is the oldest of eight: it used to be the one removed, in the run that wrote it.
    expect(pruneOffsite(f.offsite, f.manifest, `${night(3)}.age`, 7, { recorded: newer })).toEqual([`${night(10)}.age`]);
    expect(readdirSync(f.offsite).sort()).toEqual([`${night(3)}.age`, ...newer.slice(1)].sort());
    expect(manifestOf(f)).toEqual([`${night(3)}.age`, ...newer.slice(1)]);
    // The same the next night: it still has its place.
    expect(pruneOffsite(f.offsite, f.manifest, `${night(3)}.age`, 7, { recorded: newer })).toEqual([]);
    expect(readdirSync(f.offsite)).toHaveLength(7);
  });

  it('a name on record whose file is gone never costs a real copy: the folder cannot end empty while the row says ok', () => {
    const f = fixture();
    mkdirSync(f.offsite, { recursive: true });
    // Seven rows for copies that are no longer there (removed by hand, say), all newer by name than tonight's.
    const gone = [10, 11, 12, 13, 14, 15, 16].map((n) => `${night(n)}.age`);
    const real = [1, 2].map((n) => `${night(n)}.age`);
    for (const name of [...real, `${night(5)}.age`]) writeFileSync(join(f.offsite, name), 'sealed');
    writeFileSync(f.manifest, [...real, ...gone].join('\n'));
    // Tonight's copy and the two real older ones all stay: only a copy that is there takes a place.
    expect(pruneOffsite(f.offsite, f.manifest, `${night(5)}.age`, 7, { recorded: gone })).toEqual([]);
    expect(readdirSync(f.offsite).sort()).toEqual([...real, `${night(5)}.age`]);
    expect(manifestOf(f)).toEqual([...real, `${night(5)}.age`]);
    // Keeping one: tonight's is that one, and the newest copy there is by name is never removed either.
    writeFileSync(join(f.offsite, `${night(9)}.age`), 'sealed');
    writeFileSync(f.manifest, [...real, `${night(9)}.age`, ...gone].join('\n'));
    expect(pruneOffsite(f.offsite, f.manifest, `${night(5)}.age`, 1, { recorded: gone })).toEqual(real);
    expect(readdirSync(f.offsite).sort()).toEqual([`${night(5)}.age`, `${night(9)}.age`]);
    // Were tonight's own file somehow not there, the newest copy present still stays.
    expect(pruneOffsite(f.offsite, f.manifest, `${night(20)}.age`, 1)).toEqual([`${night(5)}.age`]);
    expect(readdirSync(f.offsite)).toEqual([`${night(9)}.age`]);
  });

  it('a manifest that is missing, empty or cut short heals from what the database recorded, so no copy is left for nothing to prune', () => {
    for (const damage of ['missing', 'empty', 'cut short'] as const) {
      const f = fixture();
      mkdirSync(f.offsite, { recursive: true });
      const recorded = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `${night(n)}.age`);
      for (const name of recorded) writeFileSync(join(f.offsite, name), 'sealed');
      // The last line was cut mid-name: it is not a copy's name, and it is never a path to delete.
      if (damage === 'empty') writeFileSync(f.manifest, '');
      if (damage === 'cut short') writeFileSync(f.manifest, `${night(8)}.age\nflint-2026-10-09T07-15`);
      expect(pruneOffsite(f.offsite, f.manifest, `${night(9)}.age`, 7, { recorded }), damage).toEqual([`${night(1)}.age`, `${night(2)}.age`]);
      expect(readdirSync(f.offsite).sort(), damage).toEqual([3, 4, 5, 6, 7, 8, 9].map((n) => `${night(n)}.age`));
      expect(manifestOf(f), damage).toEqual([3, 4, 5, 6, 7, 8, 9].map((n) => `${night(n)}.age`));
    }
    // What the database recorded is held to the same rule: only an encrypted copy's name, only in this folder.
    const f = fixture();
    mkdirSync(f.offsite, { recursive: true });
    const outside = join(f.root, 'keep.txt');
    writeFileSync(outside, 'keep');
    expect(pruneOffsite(f.offsite, f.manifest, `${night(2)}.age`, 1, { recorded: ['../../keep.txt', '/etc/hosts', `${night(1)}.age`] })).toEqual([]);
    expect(existsSync(outside)).toBe(true);
    expect(manifestOf(f)).toEqual([`${night(2)}.age`]);
  });

  it('says how many files it really removed, and keeps at least one', () => {
    const f = fixture();
    mkdirSync(f.offsite, { recursive: true });
    // Three names on record; only nights 2 and 3 are still there.
    writeFileSync(f.manifest, [1, 2, 3].map((n) => `${night(n)}.age`).join('\n'));
    for (const n of [2, 3, 5]) writeFileSync(join(f.offsite, `${night(n)}.age`), 'sealed');
    expect(pruneOffsite(f.offsite, f.manifest, `${night(5)}.age`, 2, { dumpDir: f.dumps })).toEqual([`${night(2)}.age`]);
    expect(readdirSync(f.offsite).sort()).toEqual([`${night(3)}.age`, `${night(5)}.age`]);
    for (const keep of [0, -1, 1.5, Number.NaN]) expect(() => pruneOffsite(f.offsite, f.manifest, `${night(5)}.age`, keep)).toThrow(/at least one/);
    expect(readdirSync(f.offsite).sort()).toEqual([`${night(3)}.age`, `${night(5)}.age`]);
  });

  it('clears a half-written copy a dead run left once it is an hour old; a younger one may be a run still writing, and is left alone', () => {
    const f = fixture();
    mkdirSync(f.offsite, { recursive: true });
    const now = Date.now();
    const half = (n: number, minutesOld: number) => {
      const file = join(f.offsite, `${night(n)}.age.partial`);
      writeFileSync(file, 'half');
      utimesSync(file, new Date(now - minutesOld * 60_000), new Date(now - minutesOld * 60_000));
    };
    writeFileSync(f.manifest, `${night(3)}.age\n`);
    writeFileSync(join(f.offsite, `${night(3)}.age`), 'sealed');
    writeFileSync(join(f.offsite, `${night(5)}.age`), 'sealed');
    // A name on record, a local dump's (its run died before it was recorded), and tonight's own name from an earlier try.
    writeFileSync(join(f.dumps, night(4)), '');
    half(3, 61);
    half(4, 24 * 60);
    half(5, 90);
    // Another job writing night 6's copy at this very moment, and one that began 59 minutes ago.
    writeFileSync(join(f.dumps, night(6)), '');
    writeFileSync(join(f.dumps, night(7)), '');
    half(6, 0);
    half(7, 59);
    // Not this code's to touch, however old.
    writeFileSync(join(f.offsite, 'notes.txt.partial'), 'not Flint’s');
    utimesSync(join(f.offsite, 'notes.txt.partial'), new Date(now - 86_400_000), new Date(now - 86_400_000));
    expect(pruneOffsite(f.offsite, f.manifest, `${night(5)}.age`, 7, { dumpDir: f.dumps, now })).toEqual([]);
    expect(readdirSync(f.offsite).sort()).toEqual([`${night(3)}.age`, `${night(5)}.age`, `${night(6)}.age.partial`, `${night(7)}.age.partial`, 'notes.txt.partial'].sort());
    // An hour on, the one that was 59 minutes old has had its hour; the live one of a moment ago has not.
    expect(STALE_PARTIAL_MS).toBe(3_600_000);
    pruneOffsite(f.offsite, f.manifest, `${night(5)}.age`, 7, { dumpDir: f.dumps, now: now + 2 * 60_000 });
    expect(readdirSync(f.offsite)).not.toContain(`${night(7)}.age.partial`);
    expect(readdirSync(f.offsite)).toContain(`${night(6)}.age.partial`);
  });

  it('removes only names it wrote: a manifest line that is not an encrypted copy’s name is never a path to delete', () => {
    const f = fixture();
    mkdirSync(f.offsite, { recursive: true });
    const outside = join(f.root, 'keep.txt');
    writeFileSync(outside, 'keep');
    for (const n of [1, 2, 3]) writeFileSync(join(f.offsite, `${night(n)}.age`), 'sealed');
    writeFileSync(f.manifest, ['../../keep.txt', '/etc/hosts', 'flint-x.dump', ...[1, 2].map((n) => `${night(n)}.age`)].join('\n'));
    expect(pruneOffsite(f.offsite, f.manifest, `${night(3)}.age`, 1, { dumpDir: f.dumps })).toEqual([`${night(1)}.age`, `${night(2)}.age`]);
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
    writeFileSync(join(f.offsite, `${night(2)}.age`), 'sealed');
    expect(pruneOffsite(f.offsite, f.manifest, `${night(2)}.age`, 1)).toEqual([]);
    expect(readFileSync(f.manifest, 'utf8')).toBe(`${night(1)}.age\n${night(2)}.age\n`);
    // Once it can go, it does, and the manifest is back to what is kept.
    rmdirSync(join(f.offsite, `${night(1)}.age`));
    writeFileSync(join(f.offsite, `${night(1)}.age`), 'sealed');
    writeFileSync(join(f.offsite, `${night(3)}.age`), 'sealed');
    expect(pruneOffsite(f.offsite, f.manifest, `${night(3)}.age`, 1)).toEqual([`${night(1)}.age`, `${night(2)}.age`]);
    expect(readFileSync(f.manifest, 'utf8')).toBe(`${night(3)}.age\n`);
  });

  it('a night that cannot encrypt writes nothing offsite and costs no older copy', async () => {
    const f = fixture();
    mkdirSync(f.offsite, { recursive: true });
    writeFileSync(join(f.offsite, `${night(1)}.age`), 'sealed');
    writeFileSync(join(f.dumps, night(2)), 'PLAINTEXT');
    // A half-written copy from an earlier try of the same night is written over, never left beside the new one.
    writeFileSync(join(f.offsite, `${night(2)}.age.partial`), 'half');
    await expect(encryptTo(join(f.dumps, night(2)), RECIPIENT, { ...tools, age: '/nonexistent/age' }, f.offsite)).rejects.toThrow(/not installed/);
    await expect(encryptTo(join(f.dumps, night(2)), 'not-a-key', { ...tools, age: f.age }, f.offsite)).rejects.toThrow(/age public key/);
    // age stopping part way leaves no half-written copy under any name, and its own error is what is logged.
    await expect(encryptTo(join(f.dumps, night(2)), RECIPIENT, { ...tools, age: fakeAge(f.root, 'fails') }, f.offsite)).rejects.toThrow(/^age exited 1: age: error: disk full$/);
    expect(readdirSync(f.offsite)).toEqual([`${night(1)}.age`]);
  });

  it('knows a failure another try cannot change from one that may pass', async () => {
    const f = fixture();
    writeFileSync(join(f.dumps, night(1)), 'PLAINTEXT');
    const failure = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e);
    // No key, no age: setup.
    expect(needsSetup(await failure(encryptTo(join(f.dumps, night(1)), 'not-a-key', { ...tools, age: f.age }, f.offsite)))).toBe(true);
    expect(needsSetup(await failure(encryptTo(join(f.dumps, night(1)), RECIPIENT, { ...tools, age: '/nonexistent/age' }, f.offsite)))).toBe(true);
    // A folder that cannot be written (a file stands where it should be): setup.
    writeFileSync(join(f.root, 'blocked'), '');
    expect(needsSetup(await failure(encryptTo(join(f.dumps, night(1)), RECIPIENT, { ...tools, age: f.age }, join(f.root, 'blocked', 'pg'))))).toBe(true);
    for (const code of ['EPERM', 'EACCES', 'EROFS', '28P01', '42501']) expect(needsSetup(Object.assign(new Error('refused'), { code })), code).toBe(true);
    expect(needsSetup(new Error('age exited 1: age: error: malformed recipient "age1qq": invalid checksum'))).toBe(true);
    expect(needsSetup(new Error('pg_dump exited 1: FATAL:  password authentication failed for user "flint_backup"'))).toBe(true);
    expect(needsSetup(new NeedsSetup('nowhere to send it'))).toBe(true);
    // A pg_dump older than the server refuses every night until it is upgraded: setup.
    expect(needsSetup(new Error('pg_dump exited 1: pg_dump: error: aborting because of server version mismatch'))).toBe(true);
    // A database that is not there is setup, by its code or its words...
    expect(needsSetup(Object.assign(new Error('database "flint" does not exist'), { code: '3D000' }))).toBe(true);
    expect(needsSetup(new Error('pg_restore exited 1: FATAL:  database "flint_old" does not exist'))).toBe(true);
    // ...but never the drill's own scratch database, which it makes and drops each run: next week's drill makes it again.
    expect(needsSetup(Object.assign(new Error('database "flint_restore_test" does not exist'), { code: '3D000' }))).toBe(false);
    expect(needsSetup(new Error('pg_restore exited 1: pg_restore: error: connection to server failed: FATAL:  database "flint_restore_test" does not exist'))).toBe(false);
    // A full disk, a dropped connection, no dump yet: another night may pass.
    expect(needsSetup(await failure(encryptTo(join(f.dumps, night(1)), RECIPIENT, { ...tools, age: fakeAge(f.root, 'fails') }, f.offsite)))).toBe(false);
    for (const e of [new Error('no local dump to send'), Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }), Object.assign(new Error('no space'), { code: 'ENOSPC' }), 'a string', undefined]) expect(needsSetup(e)).toBe(false);
  });

  describe('the nightly offsite job, step by step (sendOffsite, as cli.ts runs it)', () => {
    type Row = { path: string; location: string; encrypted: boolean; status: string; sha256: string; bytes: bigint };
    function job(over: Partial<OffsiteConfig> = {}) {
      const f = fixture();
      const steps: string[] = [];
      const rows: Row[] = [];
      const warned: string[] = [];
      const db = {
        backupRun: {
          // One record for each copy (record.ts): it looks for the copy's row, then changes it or makes it. A copy
          // written again under its name is the same row, saying what is there now.
          findFirst: async ({ where }: { where: { path: string } }) => {
            const at = rows.findIndex((r) => r.path === where.path);
            return at === -1 ? null : { id: String(at) };
          },
          create: async ({ data }: { data: Row }) => {
            // When the row is written the copy is whole and under its name, and nothing has been pruned yet.
            steps.push(`row (copy there: ${existsSync(data.path)}, partial: ${existsSync(`${data.path}.partial`)}, manifest: ${existsSync(f.manifest)})`);
            rows.push(data);
            return data;
          },
          update: async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
            const row = rows[Number(where.id)]!;
            steps.push(`row (copy there: ${existsSync(row.path)}, partial: ${existsSync(`${row.path}.partial`)}, manifest: ${existsSync(f.manifest)})`);
            rows[Number(where.id)] = { ...row, ...data };
            return rows[Number(where.id)];
          },
          findMany: async () => (steps.push('rows read'), rows.map((r) => ({ path: r.path }))),
        },
      } as unknown as Parameters<typeof sendOffsite>[0];
      const config: OffsiteConfig = { ageRecipient: RECIPIENT, offsiteDir: f.offsite, offsiteManifest: f.manifest, dumpDir: f.dumps, tools: { ...tools, age: f.age }, ...over };
      return { f, steps, rows, warned, run: () => sendOffsite(db, config, new Date('2026-10-12T07:15:00Z'), (line) => warned.push(line)) };
    }

    it('encrypts, then records, then prunes: the newest dump, in that order, with the copy’s own size and hash', async () => {
      const j = job();
      for (let n = 1; n <= 9; n++) {
        writeFileSync(join(j.f.dumps, night(n)), `PLAINTEXT ${n}`);
        j.steps.length = 0;
        const r = await j.run();
        expect(j.steps).toEqual(['row (copy there: true, partial: false, manifest: ' + (n > 1) + ')', 'rows read']);
        expect(r).toEqual({ bytes: SEALED.length, sha256: createHash('sha256').update(SEALED).digest('hex'), pruned: n > 7 ? 1 : 0 });
      }
      expect(j.rows).toHaveLength(9);
      expect(j.rows.at(-1)).toMatchObject({ path: join(j.f.offsite, `${night(9)}.age`), location: 'icloud', encrypted: true, status: 'ok', bytes: BigInt(SEALED.length) });
      expect(readdirSync(j.f.offsite).sort()).toEqual([3, 4, 5, 6, 7, 8, 9].map((n) => `${night(n)}.age`));
      expect(j.warned).toEqual([]);
    });

    it('a dump sent a second time (the next night made no new one) is still one record, of the copy that is there now', async () => {
      const j = job();
      writeFileSync(join(j.f.dumps, night(1)), 'PLAINTEXT 1');
      await j.run();
      const first = { ...j.rows[0]! };
      await j.run();
      expect(j.rows).toHaveLength(1);
      expect(j.rows[0]).toMatchObject({ path: first.path, status: 'ok', bytes: BigInt(SEALED.length) });
      // Whatever was known about the earlier file (a restore test of it) is not carried over to the one that replaced it.
      expect(j.rows[0]).toMatchObject({ restoreTestedAt: null, restoreOk: null });
      expect(readdirSync(j.f.offsite)).toEqual([`${night(1)}.age`]);
      expect(j.warned).toEqual([]);
    });

    it('the row counts go offsite beside their dump, encrypted the same way, and are pruned with it; a night that cannot send them still has its copy', async () => {
      const j = job();
      for (let n = 1; n <= 9; n++) {
        writeFileSync(join(j.f.dumps, night(n)), `PLAINTEXT ${n}`);
        writeFileSync(join(j.f.dumps, `${night(n)}.counts.json`), '{"public.\\"Proposal\\"": 4}');
        await j.run();
      }
      const there = readdirSync(j.f.offsite).sort();
      // Seven copies, each with its counts; the two oldest and THEIR counts are gone.
      expect(there).toEqual([3, 4, 5, 6, 7, 8, 9].flatMap((n) => [`${night(n)}.age`, `${night(n)}.counts.json.age`]).sort());
      for (const name of there) expect(readFileSync(join(j.f.offsite, name), 'utf8'), name).toBe(SEALED);
      // Only copies are counted and recorded: a counts file is never mistaken for one.
      expect(manifestOf(j.f)).toEqual([3, 4, 5, 6, 7, 8, 9].map((n) => `${night(n)}.age`));
      expect(j.rows).toHaveLength(9);
      expect(j.warned).toEqual([]);
      // A dump with no counts beside it is sent as it is.
      writeFileSync(join(j.f.dumps, night(10)), 'PLAINTEXT 10');
      await j.run();
      expect(existsSync(join(j.f.offsite, `${night(10)}.age`))).toBe(true);
      expect(existsSync(join(j.f.offsite, `${night(10)}.counts.json.age`))).toBe(false);
      expect(j.warned).toEqual([]);
    });

    it('heals a lost manifest from its own rows, whatever way the folder is written (a trailing slash is the same folder)', async () => {
      const j = job();
      const slashed = job({ offsiteDir: `${j.f.offsite}/`, offsiteManifest: j.f.manifest, dumpDir: j.f.dumps });
      for (let n = 1; n <= 9; n++) {
        writeFileSync(join(j.f.dumps, night(n)), `PLAINTEXT ${n}`);
        // The manifest is lost before every run, and the local dumps are gone too: only the rows remember.
        rmSync(j.f.manifest, { force: true });
        for (let old = 1; old < n; old++) rmSync(join(j.f.dumps, night(old)), { force: true });
        expect((await slashed.run()).pruned).toBe(n > 7 ? 1 : 0);
      }
      expect(readdirSync(j.f.offsite).sort()).toEqual([3, 4, 5, 6, 7, 8, 9].map((n) => `${night(n)}.age`));
    });

    it('a prune that fails is logged and never fails a copy that was made', async () => {
      // The manifest cannot be written (its folder is not there).
      const j = job({ offsiteManifest: join(tmpdir(), `flint-no-such-${process.pid}`, 'offsite-copies.txt') });
      writeFileSync(join(j.f.dumps, night(1)), 'PLAINTEXT');
      const r = await j.run();
      expect(r).toMatchObject({ bytes: SEALED.length, pruned: 0 });
      expect(j.rows).toHaveLength(1);
      expect(readdirSync(j.f.offsite)).toEqual([`${night(1)}.age`]);
      expect(j.warned).toHaveLength(1);
      expect(j.warned[0]).toMatch(/^backup\.offsite: the copy is written, but the older copies were not pruned: /);
    });

    it('with no key, no folder or a folder setting it cannot use, nothing is written or recorded, and the failure is a setup one', async () => {
      for (const over of [{ ageRecipient: undefined }, { offsiteDir: undefined }, { offsiteProblem: 'FLINT_OFFSITE_DIR is not an absolute path' }, { ageRecipient: 'not-a-key' }] as Array<Partial<OffsiteConfig>>) {
        const j = job(over);
        writeFileSync(join(j.f.dumps, night(1)), 'PLAINTEXT');
        const err = await j.run().then(() => undefined, (e: unknown) => e);
        expect(needsSetup(err), JSON.stringify(over)).toBe(true);
        expect(j.rows).toEqual([]);
        expect(existsSync(j.f.offsite) ? readdirSync(j.f.offsite) : []).toEqual([]);
      }
      // No dump to send is not a setup failure: tonight's backup may make one.
      const j = job();
      const err = await j.run().then(() => undefined, (e: unknown) => e);
      expect(String(err)).toMatch(/no local dump to send/);
      expect(needsSetup(err)).toBe(false);
    });
  });

  // The nightly jobs run from the checkout as soon as it is updated: that can be before the runtime's deploy has
  // applied the update that gives each file one record (and for as long as that deploy is held).
  describe.skipIf(NO_DB)('on a database one update behind, which has no one-record index yet (flint_test)', () => {
    const P7 = '20261015000000_p7_resilience';
    const sql = (file: string) => readFileSync(join(MIGRATIONS, P7, file), 'utf8');

    it('the offsite step records its copy, once, with or without the index; and the update settles what was recorded twice', async () => {
      const urls = await freshDb();
      const owner = <T>(fn: (c: pg.Client) => Promise<T>) => withClient(urls.owner, fn);
      const indexed = () => owner(async (c) => (await c.query(`SELECT to_regclass('public."BackupRun_kind_location_path_key"') IS NOT NULL AS t`)).rows[0].t as boolean);
      const db = createDb(urls.app);
      try {
        await owner((c) => c.query(sql('down.sql')));
        expect(await indexed()).toBe(false);
        const f = fixture();
        const warned: string[] = [];
        const config: OffsiteConfig = { ageRecipient: RECIPIENT, offsiteDir: f.offsite, offsiteManifest: f.manifest, dumpDir: f.dumps, tools: { ...tools, age: f.age } };
        const copy = join(f.offsite, `${night(1)}.age`);
        const rowsOf = (path: string) => db.backupRun.findMany({ where: { path }, orderBy: { startedAt: 'asc' }, select: { status: true, startedAt: true, location: true } });
        writeFileSync(join(f.dumps, night(1)), 'PLAINTEXT 1');
        // The first night, and the next (no new dump, so the same copy is sent again): the job succeeds both times.
        expect(await sendOffsite(db, config, new Date('2026-10-12T07:15:00Z'), (l) => warned.push(l))).toMatchObject({ bytes: SEALED.length, pruned: 0 });
        expect(await sendOffsite(db, config, new Date('2026-10-13T07:15:00Z'), (l) => warned.push(l))).toMatchObject({ bytes: SEALED.length, pruned: 0 });
        expect(warned).toEqual([]);
        // One record of the copy, saying what is there now.
        expect(await rowsOf(copy)).toEqual([{ status: 'ok', location: 'icloud', startedAt: new Date('2026-10-13T07:15:00Z') }]);
        // A failure is recorded only where nothing is, here too.
        expect(await fileFailure(db, { kind: 'pg_dump_flint', location: 'icloud', path: copy, startedAt: new Date('2026-10-14T07:15:00Z') })).toBe(false);
        expect(await fileFailure(db, { kind: 'pg_dump_flint', location: 'local', path: '/b/never-written.dump', startedAt: new Date('2026-10-14T07:15:00Z') })).toBe(true);
        expect(await fileFailure(db, { kind: 'pg_dump_flint', location: 'local', path: '/b/never-written.dump', startedAt: new Date('2026-10-15T07:15:00Z') })).toBe(false);

        // What an older Flint left: the same copy recorded on two nights, and a failure beside a good record.
        const row = (id: string, path: string, status: string, at: string, location = 'icloud') => owner((c) => c.query(
          `INSERT INTO "BackupRun" ("id", "kind", "location", "path", "encrypted", "status", "startedAt") VALUES ($1, 'pg_dump_flint', $2, $3, $4, $5, $6)`, [id, location, path, location === 'icloud', status, at]));
        await row('twice-old', '/o/twice.dump.age', 'ok', '2026-10-01T07:15:00Z');
        await row('twice-new', '/o/twice.dump.age', 'ok', '2026-10-02T07:15:00Z');
        await row('good-old', '/o/mixed.dump.age', 'ok', '2026-10-03T07:15:00Z');
        await row('bad-new', '/o/mixed.dump.age', 'failed', '2026-10-04T07:15:00Z');
        // The same path here and offsite is two files, not one twice.
        await row('same-path-local', '/o/twice.dump.age', 'ok', '2026-09-30T07:15:00Z', 'local');
        // The update does not stop on them: it keeps one record of each file and goes on.
        await migrateUp(urls.owner);
        expect(await indexed()).toBe(true);
        const left = await owner(async (c) => (await c.query(`SELECT "id" FROM "BackupRun" WHERE "path" LIKE '/o/%' ORDER BY 1`)).rows.map((r) => r.id as string));
        // The newest of two good records; the good one, though older, before a failure; and both files of one path.
        expect(left).toEqual(['good-old', 'same-path-local', 'twice-new']);
        expect(await rowsOf(copy)).toHaveLength(1);
        // With the index there the job goes on exactly as before.
        expect(await sendOffsite(db, config, new Date('2026-10-16T07:15:00Z'), (l) => warned.push(l))).toMatchObject({ bytes: SEALED.length });
        expect(await rowsOf(copy)).toEqual([{ status: 'ok', location: 'icloud', startedAt: new Date('2026-10-16T07:15:00Z') }]);
        expect(warned).toEqual([]);
      } finally {
        await db.$disconnect();
        await migrateUp(urls.owner);
      }
    });

    it('two writers at once make one record when the index is there: the second finds the first’s row', async () => {
      const urls = await freshDb();
      const db = createDb(urls.app);
      try {
        const w = { kind: 'flint_tar' as const, location: 'local' as const, path: '/b/flint-20261012-0215.tar.gz' };
        await Promise.all(Array.from({ length: 6 }, (_, i) => fileBackup(db, { ...w, bytes: 100 + i, startedAt: new Date(Date.UTC(2026, 9, 12, 7, 15, i)) })));
        expect(await db.backupRun.count({ where: { path: w.path } })).toBe(1);
        expect((await Promise.all(Array.from({ length: 4 }, () => fileFailure(db, { ...w, path: '/b/flint-20261013-0215.tar.gz', startedAt: new Date() })))).filter(Boolean)).toHaveLength(1);
        expect(await db.backupRun.count({ where: { path: '/b/flint-20261013-0215.tar.gz' } })).toBe(1);
      } finally {
        await db.$disconnect();
      }
    });
  });

  describe.skipIf(!AGE || !AGE_KEYGEN)('against the real age, with a key made for the test', () => {
    it('the copy decrypts to the dump’s own bytes, and the size and hash returned are the file’s', async () => {
      const f = fixture();
      const key = join(f.root, 'key.txt');
      execFileSync(AGE_KEYGEN!, ['-o', key], { stdio: 'ignore' });
      const recipient = /age1[0-9a-z]+/.exec(readFileSync(key, 'utf8'))![0];
      const dump = join(f.dumps, night(1));
      const bytes = randomBytes(300_000);
      writeFileSync(dump, bytes);
      const e = await encryptTo(dump, recipient, { ...tools, age: AGE! }, f.offsite);
      const copy = readFileSync(e.path);
      expect(e.bytes).toBe(copy.length);
      expect(e.sha256).toBe(createHash('sha256').update(copy).digest('hex'));
      expect(copy.subarray(0, 22).toString()).toBe('age-encryption.org/v1\n');
      expect(copy.includes(bytes.subarray(0, 64))).toBe(false);
      expect(execFileSync(AGE!, ['-d', '-i', key, e.path], { maxBuffer: 1 << 22 }).equals(bytes)).toBe(true);
      expect(readdirSync(f.offsite)).toEqual([`${night(1)}.age`]);
      // A key age itself refuses is a setup failure, and age's own first line is what is logged.
      const bad = await encryptTo(dump, `age1${'q'.repeat(58)}`, { ...tools, age: AGE! }, join(f.root, 'elsewhere')).then(() => undefined, (x: unknown) => x);
      expect(String(bad)).toMatch(/age exited 1: age: error: malformed recipient/);
      expect(needsSetup(bad)).toBe(true);
      expect(readdirSync(join(f.root, 'elsewhere'))).toEqual([]);
    });
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

  // Any role that can connect can make a large object, and pg_dump stops at one its own role may not read. Flint
  // keeps nothing in them, so every dump leaves them out (DUMP_FORMAT): one the runtime's role made costs no backup.
  it('a large object the runtime’s role made does not stop the backup, and the restore test still passes', async () => {
    const asApp = <T>(fn: (c: pg.Client) => Promise<T>) => withClient(URLS!.app, fn);
    let oid: number | undefined;
    try {
      oid = await asApp(async (c) => (await c.query<{ oid: number }>(`SELECT lo_from_bytea(0, 'not Flint''s'::bytea) AS oid`)).rows[0]!.oid);
      // What used to happen, to the letter: the same pg_dump without the flag refuses the object.
      const t = new URL(URLS!.backup!);
      const plain = spawnSync(tools.pgDump, ['-Fc', '-h', t.hostname.replace(/^\[|\]$/g, ''), '-p', t.port || '5432', '-U', decodeURIComponent(t.username), '-d', t.pathname.slice(1), '-f', join(dir, 'refused.dump')], {
        env: { PATH: process.env.PATH ?? '', PGPASSWORD: decodeURIComponent(t.password) }, encoding: 'utf8',
      });
      expect(plain.status).not.toBe(0);
      expect(plain.stderr).toMatch(/permission denied for large object/);
      const d = await dumpDatabase(URLS!.backup!, dir, tools, new Date());
      const r = await restoreDrill(d.path, URLS!.restore!, tools);
      expect(r).toMatchObject({ ok: true, mismatches: [] });
      // And it is not in the dump at all: nothing of another role's is carried into a restore.
      expect(execFileSync(tools.pgRestore, ['-l', d.path], { encoding: 'utf8' })).not.toMatch(/BLOB|LARGE OBJECT/i);
    } finally {
      // Its maker takes it away again (only its owner may).
      if (oid !== undefined) await asApp((c) => c.query('SELECT lo_unlink($1)', [oid])).catch(() => {});
      rmSync(join(dir, 'refused.dump'), { force: true });
    }
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
