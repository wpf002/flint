-- Reverses p1_ledger. Run only after a pg_dump: this drops every prediction and
-- its score. It also removes its own row from _prisma_migrations,
-- so the next deploy re-applies it.
DROP TABLE IF EXISTS "CalibrationSnapshot", "Recommendation", "ResolutionCorrection", "Resolution", "Prediction" CASCADE;
DROP FUNCTION IF EXISTS prediction_insert_check(), prediction_supersede(), prediction_guard(), resolution_leak_guard(),
  resolution_close_prediction(), resolution_correction_check(), recommendation_guard() CASCADE;
DO $$
BEGIN
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    DELETE FROM _prisma_migrations WHERE migration_name = '20261001000200_p1_ledger';
  END IF;
END;
$$;
