-- P7: every backup has one record. Until now only the database's own nightly
-- dump was recorded in BackupRun. The nightly archive of Flint's files is
-- recorded too from here on, read from the lines its script writes, and reading
-- those lines twice must add nothing: so a backup is one row, named by what it
-- is, where it is and its file.
--  - The third kind was named for a host Nexus has left. No row uses it; the
--    name is put right before anything is filed under it.
--  - Two rows for one file would stop the index below. They are counted first,
--    and the migration stops there with nothing changed.
-- No new table, column, queue or grant. Reversed by down.sql in this directory.

DO $$
DECLARE
  n bigint;
BEGIN
  SELECT count(*) INTO n FROM (SELECT 1 FROM "BackupRun" GROUP BY "kind", "location", "path" HAVING count(*) > 1) AS twice;
  IF n > 0 THEN
    RAISE EXCEPTION 'p7_resilience: % recorded more than once, under the same kind, location and path; nothing was changed',
      CASE WHEN n = 1 THEN '1 backup file is' ELSE n || ' backup files are' END
      USING HINT = 'Keep the newest record of each and remove the others, then deploy again.';
  END IF;
END;
$$;

ALTER TABLE "BackupRun" DROP CONSTRAINT "BackupRun_kind_check";
UPDATE "BackupRun" SET "kind" = 'nexus_dump' WHERE "kind" = 'nexus_railway_dump';
ALTER TABLE "BackupRun" ADD CONSTRAINT "BackupRun_kind_check" CHECK ("kind" IN ('pg_dump_flint', 'flint_tar', 'nexus_dump'));

-- CreateIndex
CREATE UNIQUE INDEX "BackupRun_kind_location_path_key" ON "BackupRun"("kind", "location", "path");
