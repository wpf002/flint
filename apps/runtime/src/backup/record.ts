/**
 * A backup's record (BackupRun): one row for each file, named by what it is,
 * where it is and its path (the table's unique index, P7).
 *
 *  - `fileBackup` records a backup that was written. A file written again
 *    under the same name (an older dump sent offsite a second time, an archive
 *    that failed and was then made) is the same row, now saying what is there:
 *    its size, its fingerprint and when, with no restore result, because any
 *    earlier one was of a file that has been replaced.
 *  - `fileFailure` records a run that did not write its file, and only when
 *    nothing is on record for that file: a failure never takes the place of a
 *    good record (the earlier file is still there).
 */
import { Prisma } from '@prisma/client';
import type { Db } from '../db.js';

export type BackupKind = 'pg_dump_flint' | 'flint_tar' | 'nexus_dump';
export type BackupLocation = 'local' | 'icloud';

export interface Written {
  kind: BackupKind;
  location: BackupLocation;
  path: string;
  bytes?: number;
  sha256?: string;
  startedAt: Date;
  finishedAt?: Date;
}

/** Offsite means encrypted: the table refuses an offsite row that says otherwise. */
const encrypted = (location: BackupLocation): boolean => location === 'icloud';

export async function fileBackup(db: Pick<Db, 'backupRun'>, w: Written): Promise<void> {
  const said = {
    bytes: w.bytes === undefined ? null : BigInt(w.bytes),
    sha256: w.sha256 ?? null,
    encrypted: encrypted(w.location),
    status: 'ok',
    startedAt: w.startedAt,
    finishedAt: w.finishedAt ?? new Date(),
  };
  await db.backupRun.upsert({
    where: { kind_location_path: { kind: w.kind, location: w.location, path: w.path } },
    create: { kind: w.kind, location: w.location, path: w.path, ...said },
    update: { ...said, restoreTestedAt: null, restoreOk: null, restoreDetail: Prisma.DbNull },
  });
}

/** True when the failure was recorded (false: that file already has a record, which stands). */
export async function fileFailure(db: Pick<Db, 'backupRun'>, w: Pick<Written, 'kind' | 'location' | 'path' | 'startedAt' | 'finishedAt'>): Promise<boolean> {
  const made = await db.backupRun.createMany({
    data: [{ kind: w.kind, location: w.location, path: w.path, encrypted: encrypted(w.location), status: 'failed', startedAt: w.startedAt, finishedAt: w.finishedAt ?? new Date() }],
    skipDuplicates: true,
  });
  return made.count === 1;
}
