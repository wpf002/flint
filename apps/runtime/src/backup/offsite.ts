/**
 * The nightly offsite copy, step by step (plan P1 backups; run by cli.ts):
 * encrypt the newest dump into the offsite folder, record it, then prune.
 *
 *  1. Nothing is sent without Will's age key and a folder to send it to: a
 *     missing one is a setup problem (NeedsSetup), which the job's note says.
 *  2. The copy is written whole (backup.ts, encryptTo) before anything else.
 *  3. Its BackupRun row is written next: the copy counts from here.
 *     The dump's row counts go beside it, encrypted the same way, so a rebuild
 *     can compare what it restored with what the backup held. A night that
 *     cannot send them still has its copy.
 *  4. Only then are older copies pruned (the newest 7 stay), from the manifest
 *     and from what the database recorded. A prune that fails is logged and
 *     tried again the next night: it never fails a copy that was made.
 *
 * Nexus's dump goes the same way (P7), as its own set: its own folder here and
 * offsite, its own names and its own records.
 */
import { existsSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import type { BackupConfig } from '../config.js';
import type { Db } from '../db.js';
import { encryptTo, FLINT_SET, NeedsSetup, newestDump, pruneOffsite, stepClock, withinStep, type BackupSet } from './backup.js';
import { fileBackup } from './record.js';

/** How many encrypted copies stay offsite (the studio's own backup keeps 7 there too). */
export const OFFSITE_KEEP = 7;

export type OffsiteConfig = Pick<BackupConfig, 'ageRecipient' | 'offsiteDir' | 'offsiteProblem' | 'offsiteManifest' | 'dumpDir' | 'tools'>;

/** Which set's dump is sent, and the action the job runs under (for its log lines). */
export interface OffsiteOf {
  set: BackupSet;
  action: string;
}

export async function sendOffsite(
  db: Pick<Db, 'backupRun'>, b: OffsiteConfig, now: Date, warn: (line: string) => void = (line) => console.error(line),
  of: OffsiteOf = { set: FLINT_SET, action: 'backup.offsite' },
): Promise<{ bytes: number; sha256: string; pruned: number }> {
  const { set, action } = of;
  // A set with limits (Nexus's): the whole step has a clock of its own, and each run of age its limit or what is left of the step's.
  const clock = stepClock(set, 'the offsite copy');
  return withinStep(clock, () => send(db, b, now, warn, set, action, () => (clock && set.limits ? clock.left(set.limits.offsiteMs) : undefined)));
}

async function send(
  db: Pick<Db, 'backupRun'>, b: OffsiteConfig, now: Date, warn: (line: string) => void, set: BackupSet, action: string, limit: () => number | undefined,
): Promise<{ bytes: number; sha256: string; pruned: number }> {
  if (!b.ageRecipient) throw new NeedsSetup('no age recipient: put Will\'s public key in ~/.flint/backup-age-recipient');
  if (b.offsiteProblem) throw new NeedsSetup(b.offsiteProblem);
  if (!b.offsiteDir) throw new NeedsSetup('nowhere to send it: iCloud Drive is not on this Mac and FLINT_OFFSITE_DIR is not set');
  const dump = newestDump(b.dumpDir, set.prefix);
  if (!dump) throw new Error('no local dump to send');
  // With a limit, age is stopped if it runs past it, and nothing half-written stays offsite.
  const e = await encryptTo(dump, b.ageRecipient, b.tools, b.offsiteDir, limit());
  // One record for each copy: a dump sent again (last night's backup failed, so the newest dump is the one
  // already sent) is the same file under the same name, and its record now says what is there.
  await fileBackup(db, { kind: set.kind, location: 'icloud', path: e.path, bytes: e.bytes, sha256: e.sha256, startedAt: now });
  const counts = `${dump}.counts.json`;
  if (existsSync(counts)) {
    const { ageRecipient, offsiteDir } = b;
    // (The limit is asked for inside the try: with no time left it is the counts that are not sent, and the copy stands.)
    await (async () => encryptTo(counts, ageRecipient, b.tools, offsiteDir, limit()))().catch((err: unknown) =>
      warn(`${action}: the copy is written, but its row counts were not sent: ${err instanceof Error ? err.message : String(err)}`),
    );
  }
  // The new copy is safe and recorded: now the older ones may go. The copy counts even if this does not.
  let pruned = 0;
  try {
    // The copies the database has a row for, in this folder: they heal a manifest that was lost or cut short.
    const rows = await db.backupRun.findMany({ where: { kind: set.kind, location: 'icloud', status: 'ok' }, orderBy: { startedAt: 'desc' }, take: 90, select: { path: true } });
    const recorded = rows.filter((r) => dirname(r.path) === dirname(e.path)).map((r) => basename(r.path));
    pruned = pruneOffsite(b.offsiteDir, b.offsiteManifest, basename(e.path), OFFSITE_KEEP, { recorded, dumpDir: b.dumpDir, prefix: set.prefix }).length;
  } catch (err) {
    warn(`${action}: the copy is written, but the older copies were not pruned: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { bytes: e.bytes, sha256: e.sha256, pruned };
}
