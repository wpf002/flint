-- Reverses p1_ledger. Run only after a pg_dump: this drops every prediction and
-- its score. Follow with: prisma migrate resolve --rolled-back 20261001000200_p1_ledger
DROP TABLE IF EXISTS "CalibrationSnapshot", "Recommendation", "ResolutionCorrection", "Resolution", "Prediction" CASCADE;
DROP FUNCTION IF EXISTS prediction_insert_check(), prediction_supersede(), prediction_guard(), resolution_leak_guard(),
  resolution_close_prediction(), resolution_correction_check(), recommendation_guard() CASCADE;
