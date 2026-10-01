-- Reverses p1_rollup_batches: the batch ids go (a resent batch could then be
-- counted twice again). Removes its own row from _prisma_migrations, so the
-- next deploy re-applies it.
DROP TABLE IF EXISTS "AuditRollupBatch";
DO $$
BEGIN
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    DELETE FROM _prisma_migrations WHERE migration_name = '20261001000250_p1_rollup_batches';
  END IF;
END;
$$;
