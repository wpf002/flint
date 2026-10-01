-- Reverses p1_world. Run only after a pg_dump: this drops the whole world model.
-- It also removes its own row from _prisma_migrations, so the next deploy re-applies it.
DROP TABLE IF EXISTS "BackupRun", "MetricPoint", "MetricSeries", "SuppressedKey", "SourceCursor", "SourceEvent", "EntitySource", "Relation", "EntityVersion", "Entity" CASCADE;
DROP FUNCTION IF EXISTS forget_entity(text, text), relation_close_only(), entity_insert_check(), entity_guard(), source_enable_guard(), entity_source_suppressed() CASCADE;
DO $$
BEGIN
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    DELETE FROM _prisma_migrations WHERE migration_name = '20261001000100_p1_world';
  END IF;
END;
$$;
