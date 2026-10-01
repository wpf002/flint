-- Reverses p1_world. Run only after a pg_dump: this drops the whole world model.
-- Follow with: prisma migrate resolve --rolled-back 20261001000100_p1_world
DROP TABLE IF EXISTS "BackupRun", "MetricPoint", "MetricSeries", "SuppressedKey", "SourceCursor", "SourceEvent", "EntitySource", "Relation", "EntityVersion", "Entity" CASCADE;
DROP FUNCTION IF EXISTS forget_entity(text, text), relation_close_only(), entity_guard(), source_enable_guard(), entity_source_suppressed() CASCADE;
