/**
 * The nightly offsite copy, step by step (plan P1 backups; run by cli.ts):
 * encrypt the newest dump into the offsite folder, record it, then prune.
 *
 *  1. Nothing is sent without Will's age key and a folder to send it to: a
 *     missing one is a setup problem (NeedsSetup), which the job's note says.
 *  2. The copy is written whole (backup.ts, encryptTo) before anything else.
 *  3. Its BackupRun row is written next: the copy counts from here.
 *  4. Only then are older copies pruned (the newest 7 stay), from the manifest
 *     and from what the database recorded. A prune that fails is logged and
 *     tried again the next night: it never fails a copy that was made.
 */
import { basename, dirname } from 'node:path';
import type { BackupConfig } from '../config.js';
import type { Db } from '../db.js';
import { encryptTo, NeedsSetup, newestDump, pruneOffsite } from './backup.js';

/** How many encrypted copies stay offsite (the studio's own backup keeps 7 there too). */
export const OFFSITE_KEEP = 7;

export type OffsiteConfig = Pick<BackupConfig, 'ageRecipient' | 'offsiteDir' | 'offsiteProblem' | 'offsiteManifest' | 'dumpDir' | 'tools'>;

export async function sendOffsite(db: Pick<Db, 'backupRun'>, b: OffsiteConfig, now: Date, warn: (line: string) => void = (line) => console.error(line)): Promise<{ bytes: number; sha256: string; pruned: number }> {
  if (!b.ageRecipient) throw new NeedsSetup('no age recipient: put Will\'s public key in ~/.flint/backup-age-recipient');
  if (b.offsiteProblem) throw new NeedsSetup(b.offsiteProblem);
  if (!b.offsiteDir) throw new NeedsSetup('nowhere to send it: iCloud Drive is not on this Mac and FLINT_OFFSITE_DIR is not set');
  const dump = newestDump(b.dumpDir);
  if (!dump) throw new Error('no local dump to send');
  const e = await encryptTo(dump, b.ageRecipient, b.tools, b.offsiteDir);
  await db.backupRun.create({ data: { kind: 'pg_dump_flint', location: 'icloud', path: e.path, bytes: BigInt(e.bytes), sha256: e.sha256, encrypted: true, status: 'ok', startedAt: now, finishedAt: new Date() } });
  // The new copy is safe and recorded: now the older ones may go. The copy counts even if this does not.
  let pruned = 0;
  try {
    // The copies the database has a row for, in this folder: they heal a manifest that was lost or cut short.
    const rows = await db.backupRun.findMany({ where: { kind: 'pg_dump_flint', location: 'icloud', status: 'ok' }, orderBy: { startedAt: 'desc' }, take: 90, select: { path: true } });
    const recorded = rows.filter((r) => dirname(r.path) === dirname(e.path)).map((r) => basename(r.path));
    pruned = pruneOffsite(b.offsiteDir, b.offsiteManifest, basename(e.path), OFFSITE_KEEP, { recorded, dumpDir: b.dumpDir }).length;
  } catch (err) {
    warn(`backup.offsite: the copy is written, but the older copies were not pruned: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { bytes: e.bytes, sha256: e.sha256, pruned };
}
