-- Reverses p7_resilience. The records stay, and a kind is given its earlier name
-- back. (A second record of one file that the migration removed is not brought
-- back: the file was never touched, and its one record stands.) Run it only after deploying a runtime from before this
-- migration: this one's nightly jobs write one record for each file and rely on
-- the index to say so. It also removes its own row from _prisma_migrations, so
-- the next deploy re-applies it. Every statement tolerates a half-applied state,
-- and an empty database.
DO $$
BEGIN
  IF to_regclass('public."BackupRun"') IS NULL THEN
    RETURN;
  END IF;
  DROP INDEX IF EXISTS "BackupRun_kind_location_path_key";
  ALTER TABLE "BackupRun" DROP CONSTRAINT IF EXISTS "BackupRun_kind_check";
  UPDATE "BackupRun" SET "kind" = 'nexus_railway_dump' WHERE "kind" = 'nexus_dump';
  ALTER TABLE "BackupRun" ADD CONSTRAINT "BackupRun_kind_check" CHECK ("kind" IN ('pg_dump_flint', 'flint_tar', 'nexus_railway_dump'));
END;
$$;
DO $$
BEGIN
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    DELETE FROM _prisma_migrations WHERE migration_name = '20261015000000_p7_resilience';
  END IF;
END;
$$;
