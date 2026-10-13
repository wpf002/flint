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
 *
 * Both look for the file's row first and then change or make it. Neither
 * leans on the index: the nightly jobs run from the checkout the moment it is
 * updated, which can be before the runtime's deploy has applied the migration
 * that makes the index (and for as long as that deploy is held). With the index
 * there, two writers at once cannot make two rows; without it they could, and
 * the migration keeps the newest of them.
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

/** The row for this file, the newest when an older database (before the index) holds more than one. */
async function rowOf(db: Pick<Db, 'backupRun'>, w: Pick<Written, 'kind' | 'location' | 'path'>): Promise<{ id: string } | null> {
  return db.backupRun.findFirst({ where: { kind: w.kind, location: w.location, path: w.path }, orderBy: [{ startedAt: 'desc' }, { id: 'desc' }], select: { id: true } });
}

/** A second writer made the row between the look and the write (the unique index refused ours). */
const madeMeanwhile = (err: unknown): boolean => err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

export async function fileBackup(db: Pick<Db, 'backupRun'>, w: Written): Promise<void> {
  const said = {
    bytes: w.bytes === undefined ? null : BigInt(w.bytes),
    sha256: w.sha256 ?? null,
    encrypted: encrypted(w.location),
    status: 'ok',
    startedAt: w.startedAt,
    finishedAt: w.finishedAt ?? new Date(),
  };
  const now = { ...said, restoreTestedAt: null, restoreOk: null, restoreDetail: Prisma.DbNull };
  const have = await rowOf(db, w);
  if (have) {
    await db.backupRun.update({ where: { id: have.id }, data: now });
    return;
  }
  try {
    await db.backupRun.create({ data: { kind: w.kind, location: w.location, path: w.path, ...said } });
  } catch (err) {
    if (!madeMeanwhile(err)) throw err;
    const made = await rowOf(db, w);
    if (!made) throw err;
    await db.backupRun.update({ where: { id: made.id }, data: now });
  }
}

/** True when the failure was recorded (false: that file already has a record, which stands). */
export async function fileFailure(db: Pick<Db, 'backupRun'>, w: Pick<Written, 'kind' | 'location' | 'path' | 'startedAt' | 'finishedAt'>): Promise<boolean> {
  if (await rowOf(db, w)) return false;
  try {
    await db.backupRun.create({ data: { kind: w.kind, location: w.location, path: w.path, encrypted: encrypted(w.location), status: 'failed', startedAt: w.startedAt, finishedAt: w.finishedAt ?? new Date() } });
    return true;
  } catch (err) {
    if (madeMeanwhile(err)) return false;
    throw err;
  }
}
