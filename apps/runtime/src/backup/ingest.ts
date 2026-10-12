/**
 * The files backup's own lines, read into the list of backups (P7).
 *
 * The nightly archive of Flint's files is made by a shell script that runs with
 * no database (apps/studio/backup_flint.sh). It leaves one line for each
 * archive it wrote or could not write in ~/.flint/backup-events.jsonl. The
 * health job reads that file here, every five minutes, and keeps one BackupRun
 * row for each archive, so Settings > Health can say how old the last files
 * backup is and whether the last one failed.
 *
 *  - Only the end of the file is read (the last quarter megabyte: years of
 *    nights would be needed to fill more), and only when the file is a plain
 *    one that nobody but its owner can write.
 *  - A line is taken only when it is exactly the contract's shape
 *    (@flint/policy BackupEvent): ids, enums, numbers, hashes, and the
 *    archive's own name, which is a time and nothing else. A line that is
 *    anything else is skipped and counted. No path is ever read from the file:
 *    where an archive is, is worked out here from its name.
 *  - Reading the same lines again writes nothing: a row is written only for an
 *    archive with no row, or one whose line is newer than its row. A failure
 *    never takes the place of a good record of the same archive.
 */
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { BackupEvent } from '@flint/policy';
import type { Db } from '../db.js';
import { fileBackup, fileFailure, type BackupLocation } from './record.js';

/** How much of the end of the file is read. */
export const EVENTS_TAIL_BYTES = 256 * 1024;

export const backupEventsFile = (home: string): string => join(home, '.flint', 'backup-events.jsonl');

/**
 * Where the script writes its archives, by its own defaults: on this Mac, and in
 * iCloud Drive. (A folder set by hand for one run of the script is not known
 * here; the row then names the default folder, and nothing reads a files
 * archive by its row's path.)
 */
export const archiveFolders = (home: string): Record<BackupLocation, string> => ({
  local: join(home, 'FlintBackups'),
  icloud: join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'FlintBackups'),
});

/** The lines at the end of the file that are whole and of the contract's shape, oldest first, and how many were not. */
export function readBackupEvents(file: string): { events: BackupEvent[]; skipped: number } {
  let fd: number;
  try {
    fd = openSync(file, 'r');
  } catch {
    return { events: [], skipped: 0 };
  }
  let text: string;
  let cut: boolean;
  try {
    const st = fstatSync(fd);
    // A plain file of this user's that nobody else can write: anything else is not the script's record.
    if (!st.isFile() || st.uid !== process.getuid?.() || (st.mode & 0o022) !== 0) return { events: [], skipped: 0 };
    const length = Math.min(st.size, EVENTS_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, st.size - length);
    text = buffer.toString('utf8');
    cut = st.size > length;
  } finally {
    closeSync(fd);
  }
  const lines = text.split('\n');
  // The first line of a cut read is the tail of a line; the last, with no newline after it, may still be being written.
  if (cut) lines.shift();
  if (!text.endsWith('\n')) lines.pop();
  const events: BackupEvent[] = [];
  let skipped = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      skipped += 1;
      continue;
    }
    const event = BackupEvent.safeParse(parsed);
    if (event.success) events.push(event.data);
    else skipped += 1;
  }
  return { events, skipped };
}

export interface Ingested {
  /** Lines of the contract's shape that were read. */
  read: number;
  /** Rows written or changed by this run (0 when the lines were all seen before). */
  written: number;
  /** Lines that were not of the contract's shape. */
  skipped: number;
}

export async function ingestBackupEvents(db: Pick<Db, 'backupRun'>, home: string): Promise<Ingested> {
  const { events, skipped } = readBackupEvents(backupEventsFile(home));
  if (!events.length) return { read: 0, written: 0, skipped };
  const folders = archiveFolders(home);
  // The newest line for each archive is the one that says what is there now.
  const latest = new Map<string, { event: BackupEvent; at: Date; path: string }>();
  for (const event of events) {
    const at = new Date(event.at);
    const path = join(folders[event.location], event.name);
    const key = `${event.location}\n${path}`;
    const seen = latest.get(key);
    if (!seen || at.getTime() >= seen.at.getTime()) latest.set(key, { event, at, path });
  }
  const rows = await db.backupRun.findMany({
    where: { kind: 'flint_tar', path: { in: [...new Set([...latest.values()].map((l) => l.path))] } },
    select: { location: true, path: true, status: true, startedAt: true },
  });
  const have = new Map(rows.map((r) => [`${r.location}\n${r.path}`, r]));
  let written = 0;
  for (const [key, { event, at, path }] of latest) {
    const row = have.get(key);
    if (row && row.startedAt.getTime() >= at.getTime()) continue; // Seen before.
    if (event.outcome === 'ok') {
      await fileBackup(db, { kind: 'flint_tar', location: event.location, path, startedAt: at, finishedAt: at, ...(event.bytes !== undefined ? { bytes: event.bytes } : {}), ...(event.sha256 ? { sha256: event.sha256 } : {}) });
      written += 1;
    } else if (!row) {
      if (await fileFailure(db, { kind: 'flint_tar', location: event.location, path, startedAt: at, finishedAt: at })) written += 1;
    } else if (row.status === 'failed') {
      // A later failure of an archive that never was: its record moves to the later time, and stays a failure.
      const moved = await db.backupRun.updateMany({ where: { kind: 'flint_tar', location: event.location, path, status: 'failed' }, data: { startedAt: at, finishedAt: at } });
      written += moved.count;
    }
    // (A failure after a good record of the same archive changes nothing: the good file is still there.)
  }
  return { read: events.length, written, skipped };
}
