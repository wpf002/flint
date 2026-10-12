/**
 * Removing old backups (P7; the action `backup.prune`).
 *
 * Before a deploy changes the database it takes a copy of it, named for the
 * commit being installed (apps/runtime/install-runtime.sh writes
 * ~/FlintBackups/pre-migrate/<commit>.dump). Nothing ever removed them. They
 * hold everything the database held that day, so "a backup ages out" was not
 * true of them: something Will had Flint forget stayed in every one.
 *
 * What is kept:
 *  - the newest 10;
 *  - anything under 30 days old;
 *  - always the copy taken before the release that is running now (the way
 *    back from it), whatever its age.
 * The rest is removed. When the running release cannot be told, nothing is.
 *
 * What may be removed is narrow on purpose: a plain file of this user's, in
 * that one folder, whose whole name is a commit and `.dump`. A name is never
 * taken from anywhere but that folder's own listing, and is checked again
 * before it is removed, so no path can be built that leaves the folder.
 *
 * The encrypted copies offsite are kept to 7 by the offsite job itself, by name
 * (backup.ts, pruneOffsite): there is one way of removing those, and it is not
 * here. The nightly dumps are kept to 14 by the backup job (pruneDumps).
 */
import { lstatSync, readdirSync, readlinkSync, unlinkSync } from 'node:fs';
import { basename, join } from 'node:path';

/** How many of the newest copies are kept whatever their age. */
export const PREMIGRATE_KEEP = 10;
/** A copy younger than this is kept however many there are. */
export const PREMIGRATE_KEEP_DAYS = 30;
/** A copy's whole name: the commit it was taken before, and `.dump`. */
const COPY = /^[0-9a-f]{40}\.dump$/;

export const preMigrateDir = (home: string): string => join(home, 'FlintBackups', 'pre-migrate');

/** The commit of the release that is running (what ~/.flint/runtime/current points at); undefined when it cannot be told. */
export function liveRelease(home: string): string | undefined {
  try {
    const name = basename(readlinkSync(join(home, '.flint', 'runtime', 'current')));
    return /^[0-9a-f]{40}$/.test(name) ? name : undefined;
  } catch {
    return undefined;
  }
}

export interface PrunePlan {
  dir: string;
  /** The copies that would go, oldest first: each a name in `dir`, never a path. */
  remove: Array<{ name: string; bytes: number }>;
  /** How many copies stay. */
  kept: number;
  /** What removing them frees. */
  bytes: number;
  /** Why nothing is removed, when there are copies and none may go. */
  held?: 'no running release';
}

const mine = (path: string): { bytes: number; mtimeMs: number } | undefined => {
  try {
    const st = lstatSync(path);
    return st.isFile() && st.uid === process.getuid?.() ? { bytes: st.size, mtimeMs: st.mtimeMs } : undefined;
  } catch {
    return undefined;
  }
};

/** What would be removed now. Reads the folder and nothing else; removes nothing. */
export function planPrune(home: string, now: Date): PrunePlan {
  const dir = preMigrateDir(home);
  const empty: PrunePlan = { dir, remove: [], kept: 0, bytes: 0 };
  let names: string[];
  try {
    // The folder itself, not something it was replaced with.
    const st = lstatSync(dir);
    if (!st.isDirectory() || st.uid !== process.getuid?.()) return empty;
    names = readdirSync(dir);
  } catch {
    return empty;
  }
  const copies = names
    .filter((n) => COPY.test(n))
    .flatMap((name) => {
      const st = mine(join(dir, name));
      return st ? [{ name, ...st }] : [];
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs || (a.name < b.name ? -1 : 1));
  const live = liveRelease(home);
  if (!live) return { ...empty, kept: copies.length, ...(copies.length > PREMIGRATE_KEEP ? { held: 'no running release' as const } : {}) };
  const young = now.getTime() - PREMIGRATE_KEEP_DAYS * 86_400_000;
  const remove = copies.filter((c, i) => i >= PREMIGRATE_KEEP && c.mtimeMs < young && c.name !== `${live}.dump`).reverse();
  return { dir, remove: remove.map(({ name, bytes }) => ({ name, bytes })), kept: copies.length - remove.length, bytes: remove.reduce((n, c) => n + c.bytes, 0) };
}

/** Remove what a plan lists. Each name is checked again, and only a plain file of this user's with that name goes. */
export function prune(plan: PrunePlan): { removed: string[]; failed: string[]; bytes: number } {
  const removed: string[] = [];
  const failed: string[] = [];
  let bytes = 0;
  for (const { name } of plan.remove) {
    if (!COPY.test(name)) continue;
    const path = join(plan.dir, name);
    const st = mine(path);
    if (!st) continue; // Gone already, or no longer a plain file of ours: left alone.
    try {
      unlinkSync(path);
      removed.push(name);
      bytes += st.bytes;
    } catch {
      failed.push(name);
    }
  }
  return { removed, failed, bytes };
}
