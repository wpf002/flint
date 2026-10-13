/**
 * One temp folder for a whole test run, removed when the run ends.
 *
 * Tests make scratch folders in the system temp folder and mostly remove them.
 * "Mostly" left tens of thousands behind on the Mac that runs the deploy gate:
 * a test that fails before its cleanup, one that never had any, a run that was
 * stopped. So every vitest run in the repo starts here (each vitest.config.ts
 * lists this file in globalSetup; apps/server/test/tests-leave-no-temp.test.ts
 * checks that): it makes one folder, points TMPDIR at it for the tests and for
 * every script they start, and removes it, with whatever any test left in it,
 * when the run is over. A run that is stopped (Ctrl-C, a kill, a closed
 * window) removes it too, before it ends.
 *
 * A run that is killed outright (kill -9) leaves that one folder. Its name
 * starts with TEMP_ROOT_PREFIX, which test-support/temp-prefixes lists, so
 * apps/studio/free_space.sh can find it later.
 *
 * The folder's name is short on purpose: a Unix socket's whole path must fit in
 * 103 characters on a Mac.
 */
import { chmodSync, lstatSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const TEMP_ROOT_PREFIX = 'flint-t-';
/** The signals a run is stopped with, and what a process that ends on each exits with. */
const STOPS = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 } as const;

/**
 * Make every folder under `dir` one its owner can empty (a test may have made
 * one read-only). Folders only: a file's mode is never changed (a hard link
 * in here is another name for a file outside), and no link is followed.
 */
function unlock(dir: string): void {
  try {
    const st = lstatSync(dir);
    if (!st.isDirectory()) return;
    chmodSync(dir, 0o700);
    for (const name of readdirSync(dir)) unlock(join(dir, name));
  } catch {
    // Gone, or not ours to change: the removal below says what it could not do.
  }
}

/** Remove a run's folder with everything in it. Never throws: a run that passed does not fail over a folder that would not go. */
export function removeRoot(root: string): void {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 2 });
  } catch {
    unlock(root);
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 2 });
    } catch (err) {
      console.warn(`[temp-root] could not remove ${root}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export default function setup(): () => void {
  const before = process.env.TMPDIR;
  const root = mkdtempSync(join(tmpdir(), TEMP_ROOT_PREFIX));
  process.env.TMPDIR = root;
  // Stopped: the folder goes first. Then the run ends as it would have: by whatever else is listening for the
  // signal (the test runner's own handler), or, when nothing is, by ending the process the way the signal does.
  const stops = (Object.keys(STOPS) as Array<keyof typeof STOPS>).map((signal) => {
    const onStop = (): void => {
      removeRoot(root);
      if (process.listenerCount(signal) <= 1) process.exit(STOPS[signal]);
    };
    process.on(signal, onStop);
    return { signal, onStop };
  });
  return () => {
    for (const s of stops) process.off(s.signal, s.onStop);
    if (before === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = before;
    removeRoot(root);
  };
}
