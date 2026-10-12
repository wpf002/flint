-- Reverses p25_google. Run only after a pg_dump, and only after deploying a
-- runtime from before P2.5: calendar titles go, and the calendar source is
-- turned off. Entities it made stay (an entity is never deleted), and so do
-- their google_calendar source rows (the source list keeps allowing them), so a
-- forget made while rolled back still suppresses them for good. It also removes
-- its own row from _prisma_migrations, so the next deploy re-applies it.
DROP TRIGGER IF EXISTS "Entity_forgotten_p25" ON "Entity";
DROP TRIGGER IF EXISTS "Entity_person_guard" ON "Entity";
DROP TRIGGER IF EXISTS "EntitySource_person_guard" ON "EntitySource";
DROP TABLE IF EXISTS "EntityText" CASCADE;
DROP FUNCTION IF EXISTS entity_forgotten_p25(), person_insert_guard(), person_source_guard() CASCADE;
DO $$
BEGIN
  -- pg-boss's delete_queue fails on a queue that is not there (a half-applied migration), and its table is
  -- not there at all on an empty database. The two tests are nested: Postgres plans a whole IF condition at
  -- once, so `to_regclass(...) IS NOT NULL AND EXISTS (SELECT ... FROM pgboss.queue ...)` fails without the table.
  IF to_regclass('pgboss.queue') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM pgboss.queue WHERE name = 'sync.google_calendar') THEN
      PERFORM pgboss.delete_queue('sync.google_calendar');
    END IF;
  END IF;
END;
$$;
-- P2's cursor list again (no calendar cursor); the source rows' list keeps google_calendar (see above).
-- Only where the table is: on an empty database (the test helpers' first run) there is nothing to put back.
DO $$
BEGIN
  IF to_regclass('public."SourceCursor"') IS NOT NULL THEN
    DELETE FROM "SourceCursor" WHERE "source" = 'google_calendar';
    ALTER TABLE "SourceCursor" DROP CONSTRAINT IF EXISTS "SourceCursor_source_check",
      ADD CONSTRAINT "SourceCursor_source_check" CHECK ("source" IN ('launchd', 'health', 'git', 'spend', 'github', 'railway', 'nexus', 'google', 'deploy', 'knowledge', 'nexus_inbox'));
  END IF;
END;
$$;
DO $$
BEGIN
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    DELETE FROM _prisma_migrations WHERE migration_name = '20261001000400_p25_google';
  END IF;
END;
$$;
