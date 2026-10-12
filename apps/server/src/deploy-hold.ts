/**
 * A pause on updates must not be silent.
 *
 * Updates are paused while ~/.flint/deploy-hold exists: auto_deploy.sh skips
 * every tick, and apps/studio/rollback.sh makes the file after putting an
 * earlier version back. The pause is meant to be short (until the fix is
 * merged), and its only trace used to be a line in the deploy log every two
 * minutes. Now Settings > Health shows it with its age from the first tick
 * (the runtime's deploy_hold component reads the same file), and once a pause
 * has lasted a day the server posts one note: one per pause, not one per check.
 * The file's own time is when the pause began (rollback.sh never rewrites a
 * hold that is already there), so it is also what tells one pause from the next.
 */
import { statSync } from 'node:fs';
import { join } from 'node:path';

/** How long a pause lasts before it gets its note. */
export const HOLD_NOTE_AFTER_MS = 24 * 3_600_000;
/** How often the server looks. */
export const HOLD_CHECK_EVERY_MS = 10 * 60_000;

/** When updates were paused, in milliseconds; undefined when they are not paused. */
export function holdSince(home: string): number | undefined {
  try {
    return statSync(join(home, '.flint', 'deploy-hold')).mtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * The note, written to Will's rules for one (2026-10-12): no file's name and no
 * command. The recovery runbook has the command (docs/RECOVERY.md, entry 1).
 */
export function deployHoldNote(): { title: string; body: string } {
  return {
    title: 'Updates Have Been Paused for a Day',
    body: 'Flint stays on the version it has until you resume them. The recovery runbook says how.',
  };
}

/**
 * The note for a pause that has lasted a day, with the key that keeps it to one
 * note per pause (the feed remembers its keys across restarts); undefined
 * before that, and when updates are not paused.
 */
export function holdNoteDue(home: string, now: number): { title: string; body: string; dedupe: string } | undefined {
  const since = holdSince(home);
  if (since === undefined || now - since < HOLD_NOTE_AFTER_MS) return undefined;
  return { ...deployHoldNote(), dedupe: `deploy-hold:${Math.floor(since / 1000)}` };
}
