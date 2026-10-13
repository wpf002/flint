-- P7: every backup has one record. Until now only the database's own nightly
-- dump was recorded in BackupRun. The nightly archive of Flint's files is
-- recorded too from here on, read from the lines its script writes, and reading
-- those lines twice must add nothing: so a backup is one row, named by what it
-- is, where it is and its file.
--  - The third kind was named for a host Nexus has left. No row uses it; the
--    name is put right before anything is filed under it.
--  - Two rows for one file would stop the index below, and a migration that
--    stops leaves a deploy that cannot go on. Until now the offsite step wrote
--    a new row each time the same dump was sent again. So the migration settles
--    them itself: for each file it keeps one row, a good record before a failed
--    one and then the newest, and removes the others. The file itself is not
--    touched, and the row that stays says what is there now.
-- No new table, column, queue or grant. Reversed by down.sql in this directory
-- (which does not bring removed rows back: they were second records of a file).

DELETE FROM "BackupRun" b
USING (
  SELECT "id", row_number() OVER (
    PARTITION BY "kind", "location", "path"
    ORDER BY ("status" = 'ok') DESC, "startedAt" DESC, "id" DESC
  ) AS n
  FROM "BackupRun"
) AS ranked
WHERE ranked."id" = b."id" AND ranked.n > 1;

ALTER TABLE "BackupRun" DROP CONSTRAINT "BackupRun_kind_check";
UPDATE "BackupRun" SET "kind" = 'nexus_dump' WHERE "kind" = 'nexus_railway_dump';
ALTER TABLE "BackupRun" ADD CONSTRAINT "BackupRun_kind_check" CHECK ("kind" IN ('pg_dump_flint', 'flint_tar', 'nexus_dump'));

-- CreateIndex
CREATE UNIQUE INDEX "BackupRun_kind_location_path_key" ON "BackupRun"("kind", "location", "path");
