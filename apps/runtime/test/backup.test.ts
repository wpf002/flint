/**
 * Backups and the restore drill (plan P1 exit criterion 8), against flint_test:
 * the dump is read-only (flint_backup), 0600, and its counts come from the same
 * snapshot; the drill restores into a scratch database as flint_restore and
 * catches a mismatch; offsite copies are never plaintext.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmdirSync, rmSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NO_DB, URLS, freshDb } from './db';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { dumpDatabase, encryptTo, needsSetup, NeedsSetup, newestDump, pruneDumps, pruneOffsite, restoreDrill, type Tools } from '../src/backup/backup';
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

  it('what is written must begin as an age file does: a stand-in that passes the dump through writes nothing, under any name', async () => {
    const f = fixture();
    writeFileSync(join(f.dumps, night(1)), 'PLAINTEXT rows');
    const err = await encryptTo(join(f.dumps, night(1)), RECIPIENT, { ...tools, age: fakeAge(f.root, 'plaintext') }, f.offsite).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(NeedsSetup);
    expect(String(err)).toMatch(/did not write an age file/);
    expect(readdirSync(f.offsite)).toEqual([]);
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

  it('says how many files it really removed, keeps at least one, and clears a half-written copy a dead run left', () => {
    const f = fixture();
    mkdirSync(f.offsite, { recursive: true });
    // Three names on record; only night 2's file is still there.
    writeFileSync(f.manifest, [1, 2, 3].map((n) => `${night(n)}.age`).join('\n'));
    writeFileSync(join(f.offsite, `${night(2)}.age`), 'sealed');
    writeFileSync(join(f.offsite, `${night(3)}.age`), 'sealed');
    writeFileSync(join(f.offsite, `${night(3)}.age.partial`), 'half');
    writeFileSync(join(f.dumps, night(4)), '');
    writeFileSync(join(f.offsite, `${night(4)}.age.partial`), 'half, from a run that died before it was recorded');
    writeFileSync(join(f.offsite, `${night(5)}.age`), 'sealed');
    expect(pruneOffsite(f.offsite, f.manifest, `${night(5)}.age`, 2, { dumpDir: f.dumps })).toEqual([`${night(2)}.age`]);
    expect(readdirSync(f.offsite).sort()).toEqual([`${night(3)}.age`, `${night(5)}.age`]);
    for (const keep of [0, -1, 1.5, Number.NaN]) expect(() => pruneOffsite(f.offsite, f.manifest, `${night(5)}.age`, keep)).toThrow(/at least one/);
    expect(readdirSync(f.offsite).sort()).toEqual([`${night(3)}.age`, `${night(5)}.age`]);
  });

  it('removes only names it wrote: a manifest line that is not an encrypted copy’s name is never a path to delete', () => {
    const f = fixture();
    mkdirSync(f.offsite, { recursive: true });
    const outside = join(f.root, 'keep.txt');
    writeFileSync(outside, 'keep');
    for (const n of [1, 2]) writeFileSync(join(f.offsite, `${night(n)}.age`), 'sealed');
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
    expect(pruneOffsite(f.offsite, f.manifest, `${night(2)}.age`, 1)).toEqual([]);
    expect(readFileSync(f.manifest, 'utf8')).toBe(`${night(1)}.age\n${night(2)}.age\n`);
    // Once it can go, it does, and the manifest is back to what is kept.
    rmdirSync(join(f.offsite, `${night(1)}.age`));
    writeFileSync(join(f.offsite, `${night(1)}.age`), 'sealed');
    writeFileSync(join(f.offsite, `${night(2)}.age`), 'sealed');
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
          create: async ({ data }: { data: Row }) => {
            // When the row is written the copy is whole and under its name, and nothing has been pruned yet.
            steps.push(`row (copy there: ${existsSync(data.path)}, partial: ${existsSync(`${data.path}.partial`)}, manifest: ${existsSync(f.manifest)})`);
            rows.push(data);
            return data;
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

  it('the drill catches a mismatch', async () => {
    const counts = JSON.parse(readFileSync(`${dump}.counts.json`, 'utf8')) as Record<string, number>;
    counts['public."Proposal"'] = (counts['public."Proposal"'] ?? 0) + 1;
    writeFileSync(`${dump}.counts.json`, JSON.stringify(counts));
    const r = await restoreDrill(dump, URLS!.restore!, tools);
    expect(r.ok).toBe(false);
    expect(r.mismatches).toEqual([{ table: 'public."Proposal"', expected: counts['public."Proposal"'], restored: counts['public."Proposal"']! - 1 }]);
  });
});
