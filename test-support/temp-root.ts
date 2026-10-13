/**
 * One temp folder for a whole test run, removed when the run ends.
 *
 * Tests make scratch folders in the system temp folder and mostly remove them.
 * "Mostly" left tens of thousands behind on the Mac that runs the deploy gate:
 * a test that fails before its cleanup, one that never had any, a run that was
 * stopped. So every vitest run in the repo starts here (each vitest.config.ts
 * lists this file in globalSetup; apps/server/test/tests-stay-quiet.test.ts
 * checks that): it makes one folder, points TMPDIR at it for the tests and for
 * every script they start, and removes it, with whatever any test left in it,
 * when the run is over.
 *
 * A run that is killed outright leaves that one folder. Its name starts with
 * TEMP_ROOT_PREFIX, which test-support/temp-prefixes lists, so
 * apps/studio/free_space.sh can find it later.
 *
 * The folder's name is short on purpose: a Unix socket's whole path must fit in
 * 103 characters on a Mac, and the test database's socket lives under here.
 */
import { chmodSync, lstatSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const TEMP_ROOT_PREFIX = 'flint-t-';

/** Make every folder under `dir` one its owner can empty (a test may have made one read-only), following no link. */
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

export default function setup(): () => void {
  const before = process.env.TMPDIR;
  const root = mkdtempSync(join(tmpdir(), TEMP_ROOT_PREFIX));
  process.env.TMPDIR = root;
  return () => {
    if (before === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = before;
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 2 });
    } catch {
      unlock(root);
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 2 });
      } catch (err) {
        // Never fail a run that passed over a folder that would not go: say where it is.
        console.warn(`[temp-root] could not remove ${root}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };
}
