/**
 * Removing old backups (src/backup/prune.ts; the action `backup.prune`): the
 * copies of the database a deploy takes before a migration, in a scratch home.
 *
 *  - the newest 10 stay, and anything under 30 days old, and always the copy
 *    taken before the release that is running now;
 *  - when the running release cannot be told, nothing is removed;
 *  - only a plain file of this user's, in that one folder, whose whole name is
 *    a commit and `.dump`, can ever be removed: not a file beside it, not a
 *    folder, not a link, not a name that points out of the folder;
 *  - what a plan lists is looked at again when it is carried out: the folder
 *    must be the folder the plan read, and each copy the file it saw (the same
 *    size, written at the same time), or it is left.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PREMIGRATE_KEEP, PREMIGRATE_KEEP_DAYS, liveRelease, planPrune, preMigrateDir, prune } from '../src/backup/prune';

const NOW = new Date('2026-10-12T18:00:00Z');
const DAY = 86_400_000;
/** A commit's name, from a number: 40 hex characters. */
const sha = (n: number): string => n.toString(16).padStart(40, '0');

let home: string;
let dir: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'flint-prune-'));
  dir = preMigrateDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  mkdirSync(join(home, '.flint', 'runtime', 'releases'), { recursive: true });
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});

/** A copy taken `daysAgo` days ago, `bytes` long. */
function copy(n: number, daysAgo: number, bytes = 1000): string {
  const name = `${sha(n)}.dump`;
  writeFileSync(join(dir, name), 'x'.repeat(bytes), { mode: 0o600 });
  const at = (NOW.getTime() - daysAgo * DAY) / 1000;
  utimesSync(join(dir, name), at, at);
  return name;
}
/** Say which release is running, as the installer does: `current` points at its folder. */
function running(n: number): void {
  const release = join(home, '.flint', 'runtime', 'releases', sha(n));
  mkdirSync(release, { recursive: true });
  rmSync(join(home, '.flint', 'runtime', 'current'), { force: true });
  symlinkSync(release, join(home, '.flint', 'runtime', 'current'));
}

describe('which copies go', () => {
  it('the newest 10 stay whatever their age, and anything under 30 days stays however many there are', () => {
    running(999);
    // Fourteen old copies (40 to 53 days), and none young: the newest ten stay, the oldest four go, oldest first.
    for (let i = 0; i < 14; i++) copy(i, 40 + i, 1000 + i);
    const plan = planPrune(home, NOW);
    expect(plan.remove.map((r) => r.name)).toEqual([13, 12, 11, 10].map((n) => `${sha(n)}.dump`));
    expect(plan).toMatchObject({ dir, kept: PREMIGRATE_KEEP, bytes: 1013 + 1012 + 1011 + 1010 });
    expect(plan.held).toBeUndefined();
    // Twelve more, all young: every one of them stays, and they take the ten places, so every old one may go.
    for (let i = 100; i < 112; i++) copy(i, i - 100);
    const more = planPrune(home, NOW);
    expect(more.kept).toBe(12);
    expect(more.remove).toHaveLength(14);
    // A copy 29 days old is young; one 31 days old is not.
    rmSync(dir, { recursive: true });
    mkdirSync(dir);
    for (let i = 0; i < PREMIGRATE_KEEP; i++) copy(i, 1);
    const young = copy(500, PREMIGRATE_KEEP_DAYS - 1);
    const old = copy(501, PREMIGRATE_KEEP_DAYS + 1);
    expect(planPrune(home, NOW).remove.map((r) => r.name)).toEqual([old]);
    expect(planPrune(home, NOW).remove.map((r) => r.name)).not.toContain(young);
  });

  it('never the copy taken before the release that is running, however old it is', () => {
    for (let i = 0; i < 12; i++) copy(i, 10 + i);
    const live = copy(77, 400);
    running(77);
    expect(liveRelease(home)).toBe(sha(77));
    const plan = planPrune(home, NOW);
    expect(plan.remove.map((r) => r.name)).not.toContain(live);
    // Everything else past the newest ten and thirty days goes: here the two oldest of the twelve are under 30 days, so nothing.
    expect(plan.remove).toEqual([]);
    for (let i = 20; i < 32; i++) copy(i, 40 + i);
    const later = planPrune(home, NOW);
    expect(later.remove.map((r) => r.name)).not.toContain(live);
    expect(later.remove.length).toBeGreaterThan(0);
    prune(later);
    expect(existsSync(join(dir, live))).toBe(true);
  });

  it('with no release it can tell is running, it removes nothing, and says so when there would be something', () => {
    for (let i = 0; i < 14; i++) copy(i, 40 + i);
    // No `current` at all.
    expect(liveRelease(home)).toBeUndefined();
    expect(planPrune(home, NOW)).toEqual({ dir, folder: expect.any(Object), remove: [], kept: 14, bytes: 0, held: 'no running release' });
    // `current` points at something that is not a release's folder.
    symlinkSync(join(home, '.flint', 'runtime', 'releases'), join(home, '.flint', 'runtime', 'current'));
    expect(liveRelease(home)).toBeUndefined();
    expect(planPrune(home, NOW).remove).toEqual([]);
    // `current` is a real folder, not a link.
    rmSync(join(home, '.flint', 'runtime', 'current'));
    mkdirSync(join(home, '.flint', 'runtime', 'current'));
    expect(planPrune(home, NOW).remove).toEqual([]);
    // With ten or fewer there is nothing to hold back, and nothing to say.
    rmSync(dir, { recursive: true });
    mkdirSync(dir);
    copy(1, 90);
    expect(planPrune(home, NOW)).toEqual({ dir, folder: expect.any(Object), remove: [], kept: 1, bytes: 0 });
  });

  it('no folder, an empty one, or one that is not a folder of ours: nothing', () => {
    rmSync(dir, { recursive: true });
    expect(planPrune(home, NOW)).toEqual({ dir, remove: [], kept: 0, bytes: 0 });
    // The folder replaced by a link to another one full of old copies: not read at all.
    const elsewhere = join(home, 'elsewhere');
    mkdirSync(elsewhere);
    running(999);
    for (let i = 0; i < 14; i++) {
      writeFileSync(join(elsewhere, `${sha(i)}.dump`), 'x');
      utimesSync(join(elsewhere, `${sha(i)}.dump`), (NOW.getTime() - 90 * DAY) / 1000, (NOW.getTime() - 90 * DAY) / 1000);
    }
    symlinkSync(elsewhere, dir);
    expect(planPrune(home, NOW)).toEqual({ dir, remove: [], kept: 0, bytes: 0 });
    expect(readdirSync(elsewhere)).toHaveLength(14);
  });
});

describe('what can be removed is narrow', () => {
  it('only a plain file whose whole name is a commit and .dump: everything else in the folder is neither counted nor touched', () => {
    running(999);
    for (let i = 0; i < 14; i++) copy(i, 40 + i);
    const old = (NOW.getTime() - 300 * DAY) / 1000;
    const others = ['notes.txt', `${sha(50)}.dump.partial`, `${sha(51)}.dump.counts.json`, `${sha(0xabcdef).toUpperCase()}.dump`, `${sha(53).slice(1)}.dump`, `x${sha(54)}.dump`, `${sha(55)}.dump `, '.DS_Store'];
    for (const name of others) {
      writeFileSync(join(dir, name), 'keep');
      utimesSync(join(dir, name), old, old);
    }
    // A folder with a copy's name, and a link with a copy's name that points at a file outside.
    mkdirSync(join(dir, `${sha(60)}.dump`));
    writeFileSync(join(home, 'outside.dump'), 'outside');
    symlinkSync(join(home, 'outside.dump'), join(dir, `${sha(61)}.dump`));
    const plan = planPrune(home, NOW);
    expect(plan.remove.map((r) => r.name)).toEqual([13, 12, 11, 10].map((n) => `${sha(n)}.dump`));
    expect(plan.kept).toBe(10);
    const done = prune(plan);
    expect(done).toEqual({ removed: plan.remove.map((r) => r.name), failed: [], left: [], bytes: 4000 });
    const left = readdirSync(dir).sort();
    expect(left).toEqual([...others, `${sha(60)}.dump`, `${sha(61)}.dump`, ...Array.from({ length: 10 }, (_, i) => `${sha(i)}.dump`)].sort());
    expect(existsSync(join(home, 'outside.dump'))).toBe(true);
  });

  it('a plan is checked again when it is carried out: a name that is not a copy’s, or one that became a link, is left alone', () => {
    running(999);
    for (let i = 0; i < 14; i++) copy(i, 40 + i);
    writeFileSync(join(home, 'FlintBackups', 'flint-newest.dump'), 'the nightly backup');
    writeFileSync(join(home, 'victim'), 'not a backup');
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', `${sha(1)}.dump`), 'in a folder below');
    const plan = planPrune(home, NOW);
    // Names no listing gave, each with the size and time of the file it would reach, so only the name can stop it.
    const aimed = (name: string) => {
      const st = statSync(join(dir, name), { throwIfNoEntry: false });
      return { name, bytes: st?.size ?? 1, mtimeMs: st?.mtimeMs ?? 1 };
    };
    const bad = ['../flint-newest.dump', '../../victim', `sub/${sha(1)}.dump`, `${sha(2)}.dump/..`, '', '.', `${sha(3)}.dump\n`, `${sha(200)}.dump`];
    const doctored = { ...plan, remove: [...bad.map(aimed), ...plan.remove] };
    // Between the plan and the removal, one of the listed copies is replaced by a link to a file outside.
    const swapped = plan.remove[0]!.name;
    rmSync(join(dir, swapped));
    symlinkSync(join(home, 'victim'), join(dir, swapped));
    const done = prune(doctored);
    expect(done.removed).toEqual(plan.remove.slice(1).map((r) => r.name));
    expect(done.failed).toEqual([]);
    expect(done.left).toEqual([...bad, swapped]);
    expect(existsSync(join(home, 'FlintBackups', 'flint-newest.dump'))).toBe(true);
    expect(existsSync(join(home, 'victim'))).toBe(true);
    expect(existsSync(join(dir, 'sub', `${sha(1)}.dump`))).toBe(true);
    expect(existsSync(join(dir, `${sha(2)}.dump`))).toBe(true);
    expect(existsSync(join(dir, `${sha(3)}.dump`))).toBe(true);
    // Run again, it finds them gone and removes nothing more.
    expect(prune(doctored).removed).toEqual([]);
  });

  it('a copy that is not the file the plan saw is left: written again since, another size, or another time', () => {
    running(999);
    for (let i = 0; i < 14; i++) copy(i, 40 + i);
    const plan = planPrune(home, NOW);
    const [a, b, c, d] = plan.remove.map((r) => r.name) as [string, string, string, string];
    // a: replaced by a new file of the same name, written a moment ago (a deploy taking its copy again).
    writeFileSync(join(dir, a), 'x'.repeat(1000));
    // b: the same time as before, another size.
    const was = statSync(join(dir, b));
    writeFileSync(join(dir, b), 'x'.repeat(2000));
    utimesSync(join(dir, b), was.atime, was.mtime);
    // c: the same size, written at another (still old) time.
    utimesSync(join(dir, c), (NOW.getTime() - 300 * DAY) / 1000, (NOW.getTime() - 300 * DAY) / 1000);
    const done = prune(plan);
    expect(done).toEqual({ removed: [d], failed: [], left: [a, b, c], bytes: 1000 });
    expect(readdirSync(dir)).toHaveLength(13);
    // A plan with no size or time for a copy (one made by hand) removes nothing either.
    const bare = { ...plan, remove: [{ name: a } as never, { name: b, bytes: 2000 } as never] };
    expect(prune(bare).removed).toEqual([]);
  });

  it('the folder is looked at again before each removal: swapped for a link or for another folder, nothing more goes', () => {
    running(999);
    for (let i = 0; i < 14; i++) copy(i, 40 + i);
    const plan = planPrune(home, NOW);
    expect(plan.remove).toHaveLength(4);
    // The same names, sizes and times in another folder, and the real one swapped for a link to it.
    const elsewhere = join(home, 'elsewhere');
    mkdirSync(elsewhere);
    for (const r of plan.remove) {
      writeFileSync(join(elsewhere, r.name), 'x'.repeat(r.bytes));
      utimesSync(join(elsewhere, r.name), r.mtimeMs / 1000, r.mtimeMs / 1000);
    }
    renameSync(dir, join(home, 'moved'));
    symlinkSync(elsewhere, dir);
    expect(prune(plan)).toEqual({ removed: [], failed: [], left: plan.remove.map((r) => r.name), bytes: 0 });
    expect(readdirSync(elsewhere)).toHaveLength(4);
    // Swapped for another real folder of ours with the same files in it: it is not the folder the plan read.
    rmSync(dir);
    renameSync(elsewhere, dir);
    expect(prune(plan).removed).toEqual([]);
    expect(readdirSync(dir)).toHaveLength(4);
    // A plan that does not say which folder it read removes nothing.
    rmSync(dir, { recursive: true });
    renameSync(join(home, 'moved'), dir);
    const { folder: _folder, ...unanchored } = plan;
    expect(prune(unanchored).removed).toEqual([]);
    expect(readdirSync(dir)).toHaveLength(14);
    // Back as it was, the plan is carried out.
    expect(prune(plan).removed).toHaveLength(4);
  });

  it('a file or a folder that is another user’s is neither counted nor removed', () => {
    running(999);
    for (let i = 0; i < 14; i++) copy(i, 40 + i);
    const me = process.getuid!();
    const plan = planPrune(home, NOW);
    expect(plan.remove).toHaveLength(4);
    // The folder is ours and every file in it is someone else's (the first look is at the folder).
    let looks = 0;
    const uid = vi.spyOn(process as { getuid: () => number }, 'getuid').mockImplementation(() => (looks++ === 0 ? me : me + 1));
    expect(planPrune(home, NOW)).toMatchObject({ remove: [], kept: 0, bytes: 0 });
    // Carried out: the folder is looked at, then the copy, each time. The copies are someone else's now.
    looks = 0;
    uid.mockImplementation(() => (looks++ % 2 === 0 ? me : me + 1));
    expect(prune(plan)).toEqual({ removed: [], failed: [], left: plan.remove.map((r) => r.name), bytes: 0 });
    // The folder itself is someone else's: not read, and nothing goes.
    uid.mockImplementation(() => me + 1);
    expect(planPrune(home, NOW)).toEqual({ dir, remove: [], kept: 0, bytes: 0 });
    expect(prune(plan).removed).toEqual([]);
    expect(readdirSync(dir)).toHaveLength(14);
  });

  it('a copy that will not delete is said, and the rest still go', () => {
    running(999);
    for (let i = 0; i < 12; i++) copy(i, 40 + i);
    const plan = planPrune(home, NOW);
    expect(plan.remove).toHaveLength(2);
    // The folder made read-only: nothing in it can be removed.
    chmodSync(dir, 0o500);
    try {
      expect(prune(plan)).toEqual({ removed: [], failed: plan.remove.map((r) => r.name), left: [], bytes: 0 });
    } finally {
      chmodSync(dir, 0o700);
    }
    expect(prune(plan).removed).toHaveLength(2);
  });
});
