-- Reverses p4_forecasts. Run it only after a pg_dump, and only after deploying a
-- runtime from before P4 with FLINT_PREDICT off: that runtime's job bus does not
-- expect the six prediction queues this drops. Lost by design: forecast runs,
-- which numbers were turned on, Will's questions and their answers, the record
-- of which approvals turned numbers on, and the scores only P4 keeps (range
-- snapshots, and the coverage, pinball, ECE and Brier-interval columns: all
-- derived, and recomputed by a later snapshot). What stays: every prediction and
-- resolution, every yes/no snapshot's Brier score and base rate (a forecast's
-- predictions lose their range, unit, series and run), every daily metric point,
-- and the on/off history in RowChange (the table is append-only; it holds
-- switches and ids, never numbers). MetricSeries rows keep the labels they have,
-- on a table that is unguarded again; re-applying the migration puts them right
-- again and clears every offBoxAllowed. A forecast card still waiting expires on
-- its own; one approved while rolled back is refused by the runtime ("not carried
-- out by the runtime"). The record of used approvals goes with its table, so a
-- forecast card left executing could act once more after a re-deploy, until it
-- expires (a week at most after it was signed). P3's signed-card helpers go back
-- to P3's own bodies, without the four hardenings this migration gave them, and
-- MetricPoint loses its id-only refusal. It also removes its own row from
-- _prisma_migrations, so the next deploy re-applies it. Every statement tolerates
-- a half-applied state, and an empty database.

-- The triggers this put on older tables.
DROP TRIGGER IF EXISTS "Resolution_will_check" ON "Resolution";
DROP TRIGGER IF EXISTS "Resolution_valid" ON "Resolution";
DROP TRIGGER IF EXISTS "Prediction_valid_update" ON "Prediction";
DROP TRIGGER IF EXISTS "Prediction_valid_forecast" ON "Prediction";
DROP TRIGGER IF EXISTS "Prediction_valid" ON "Prediction";
DROP TRIGGER IF EXISTS "MetricPoint_valid" ON "MetricPoint";
DROP TRIGGER IF EXISTS "MetricSeries_guard" ON "MetricSeries";
DROP TRIGGER IF EXISTS "Proposal_digest_check_forecast" ON "Proposal";
ALTER TABLE IF EXISTS "MetricSeries"
  DROP CONSTRAINT IF EXISTS "MetricSeries_money_check", DROP CONSTRAINT IF EXISTS "MetricSeries_calendar_check",
  DROP CONSTRAINT IF EXISTS "MetricSeries_onbox_check";

-- Prediction_method_check keeps `statistical`: predictions are never deleted, so
-- the list keeps allowing the rows that exist (as p25_google's down keeps its source).
ALTER TABLE IF EXISTS "Prediction"
  DROP COLUMN IF EXISTS "forecastRunId", DROP COLUMN IF EXISTS "seriesKey", DROP COLUMN IF EXISTS "unit",
  DROP COLUMN IF EXISTS "level", DROP COLUMN IF EXISTS "upper", DROP COLUMN IF EXISTS "lower", DROP COLUMN IF EXISTS "pointEstimate";

-- Range rows are derived (any later snapshot recomputes them), and have no Brier
-- score to put back under NOT NULL. This table is made by p1_ledger: when its down
-- has already run (or the migration never applied), there is nothing here to undo.
DO $$
BEGIN
  IF to_regclass('public."CalibrationSnapshot"') IS NULL THEN
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'CalibrationSnapshot' AND column_name = 'kind') THEN
    DELETE FROM "CalibrationSnapshot" WHERE "kind" <> 'binary';
  END IF;
  ALTER TABLE "CalibrationSnapshot"
    DROP CONSTRAINT IF EXISTS "CalibrationSnapshot_kind_check", DROP CONSTRAINT IF EXISTS "CalibrationSnapshot_binary_check",
    DROP CONSTRAINT IF EXISTS "CalibrationSnapshot_interval_check", DROP CONSTRAINT IF EXISTS "CalibrationSnapshot_n100_check",
    DROP CONSTRAINT IF EXISTS "CalibrationSnapshot_scores_check";
  DROP INDEX IF EXISTS "CalibrationSnapshot_windowEnd_domain_type_method_kind_key";
  ALTER TABLE "CalibrationSnapshot"
    DROP COLUMN IF EXISTS "kind", DROP COLUMN IF EXISTS "intervalCoverage", DROP COLUMN IF EXISTS "pinball", DROP COLUMN IF EXISTS "ece",
    DROP COLUMN IF EXISTS "brierCiLow", DROP COLUMN IF EXISTS "brierCiHigh";
  ALTER TABLE "CalibrationSnapshot" ALTER COLUMN "brier" SET NOT NULL, ALTER COLUMN "baseRate" SET NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS "CalibrationSnapshot_windowEnd_domain_type_method_key" ON "CalibrationSnapshot" ("windowEnd", "domain", "type", "method");
END;
$$;

-- P3's signed-card helpers and its link guard, back to P3's own bodies to the letter (each copied from
-- 20261009000000_p3_goals; the round-trip test compares them), and the trigger that used the link's approval
-- after its write goes. Only where P3 is there: on an empty database there is nothing to put back.
DROP TRIGGER IF EXISTS "GoalEntity_bind" ON "GoalEntity";
DO $do$
BEGIN
  IF to_regprocedure('p3_signed_proposal(text, text, text[])') IS NOT NULL THEN
    EXECUTE $fn$
CREATE OR REPLACE FUNCTION p3_signed_proposal(p_approval text, p_goal text, p_actions text[]) RETURNS "Proposal"
LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $p3$
DECLARE
  a "Approval"%ROWTYPE;
  p "Proposal"%ROWTYPE;
BEGIN
  SELECT * INTO a FROM "Approval" WHERE "id" = p_approval;
  IF NOT FOUND OR a."decision" <> 'approve' OR a."subjectType" <> 'proposal'
     OR NOT EXISTS (SELECT 1 FROM "ApprovalCredential" c WHERE c."credentialId" = a."credentialId" AND c."revokedAt" IS NULL) THEN
    RAISE EXCEPTION 'goal %: approval % is not a live signed approval of a card', p_goal, p_approval USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO p FROM "Proposal" WHERE "id" = a."subjectId";
  IF NOT FOUND OR NOT coalesce(
       p."approvalId" = a."id" AND p."status" = 'executing' AND p."expiresAt" > clock_timestamp() AND p."action" = ANY (p_actions)
       AND p."kind" = CASE WHEN p."action" = 'plan.change' THEN 'plan' ELSE 'goal' END
       AND a."payload"->>'action' = p."action" AND a."payload"->>'argsDigest' = p."argsDigest"
       AND jsonb_typeof(p."args") = 'object' AND p."args"->>'goalId' = p_goal, false) THEN
    RAISE EXCEPTION 'goal %: approval % is not for an executing % of this goal', p_goal, p_approval, array_to_string(p_actions, ' or ')
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN p;
END;
$p3$
    $fn$;
  END IF;
  IF to_regprocedure('p3_bind_approval(text, text, text)') IS NOT NULL THEN
    EXECUTE $fn$
CREATE OR REPLACE FUNCTION p3_bind_approval(p_approval text, p_goal text, p_action text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $p3$
DECLARE
  u "GoalApprovalUse"%ROWTYPE;
BEGIN
  PERFORM p3_signed_proposal(p_approval, p_goal, ARRAY[p_action]);
  INSERT INTO "GoalApprovalUse" ("approvalId", "goalId", "action", "xact")
  VALUES (p_approval, p_goal, p_action, pg_current_xact_id()::text)
  ON CONFLICT ("approvalId") DO NOTHING;
  SELECT * INTO u FROM "GoalApprovalUse" WHERE "approvalId" = p_approval;
  IF NOT coalesce(u."xact" = pg_current_xact_id()::text AND u."goalId" = p_goal AND u."action" = p_action, false) THEN
    RAISE EXCEPTION 'goal %: approval % was already used', p_goal, p_approval USING ERRCODE = 'insufficient_privilege';
  END IF;
END;
$p3$
    $fn$;
  END IF;
  IF to_regprocedure('goal_entity_guard()') IS NOT NULL THEN
    EXECUTE $fn$
CREATE OR REPLACE FUNCTION goal_entity_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $p3$
DECLARE
  r "GoalEntity"%ROWTYPE;
  g "Goal"%ROWTYPE;
  p "Proposal"%ROWTYPE;
  cand text;
  link jsonb;
  listed boolean;
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'goal links are removed only by a signed card' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(NEW) - 'seenVersion') IS DISTINCT FROM (to_jsonb(OLD) - 'seenVersion') OR NEW."seenVersion" < OLD."seenVersion" THEN
      RAISE EXCEPTION 'goal %: a link only moves its cursor forward', OLD."goalId" USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    r := NEW;
    SELECT "version" INTO NEW."seenVersion" FROM "Entity" WHERE "id" = NEW."entityId" AND "status" <> 'forgotten';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'goal %: item % is not there to link', NEW."goalId", NEW."entityId" USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    r := OLD;
  END IF;
  SELECT * INTO g FROM "Goal" WHERE "id" = r."goalId";
  link := jsonb_build_object('entityId', r."entityId", 'role', r."role", 'watchPaths', to_jsonb(r."watchPaths"));
  FOR cand IN
    SELECT "approvalId" FROM "Proposal"
    WHERE "status" = 'executing' AND "action" IN ('goal.activate', 'goal.criteria_change') AND "approvalId" IS NOT NULL AND "args"->>'goalId' = r."goalId"
  LOOP
    BEGIN
      p := p3_signed_proposal(cand, r."goalId", ARRAY['goal.activate', 'goal.criteria_change']);
      IF coalesce((p."action" = 'goal.activate' AND g."status" = 'proposed') OR (p."action" = 'goal.criteria_change' AND g."status" IN ('active', 'paused')), false)
         AND coalesce(jsonb_typeof(p."args"->'links'), '') = 'array' THEN
        listed := EXISTS (SELECT 1 FROM jsonb_array_elements(p."args"->'links') AS l WHERE l = link);
        IF (TG_OP = 'INSERT' AND listed) OR (TG_OP = 'DELETE' AND NOT listed) THEN
          -- This card's approval, in this transaction only.
          PERFORM p3_bind_approval(cand, r."goalId", p."action");
          IF TG_OP = 'INSERT' THEN
            RETURN NEW;
          END IF;
          RETURN OLD;
        END IF;
      END IF;
    EXCEPTION WHEN insufficient_privilege THEN
      CONTINUE;
    END;
  END LOOP;
  RAISE EXCEPTION 'goal %: link to % is not what a signed card says', r."goalId", r."entityId" USING ERRCODE = 'insufficient_privilege';
END;
$p3$
    $fn$;
  END IF;
END;
$do$;

DROP TABLE IF EXISTS "PredictionQuestion", "ForecastSeries", "ForecastRun", "ForecastApprovalUse" CASCADE;
DROP FUNCTION IF EXISTS p4_signed_proposal(text, text), p4_bind_approval(text, text), metric_series_guard(), metric_point_valid(),
  forecast_series_guard(), forecast_series_bind(), forecast_series_history(), forecast_run_check(), forecast_run_valid(),
  prediction_forecast_check(), prediction_valid(), prediction_update_valid(), prediction_question_guard(), resolution_will_check(),
  resolution_valid() CASCADE;
DO $$
DECLARE
  q text;
BEGIN
  -- pg-boss's delete_queue fails on a queue that is not there (a half-applied migration),
  -- and its table is not there at all on an empty database: look only once it is.
  IF to_regclass('pgboss.queue') IS NOT NULL THEN
    FOREACH q IN ARRAY ARRAY['forecast.reason', 'ledger.ask', 'ledger.snapshot', 'ledger.sweep', 'forecast.run', 'forecast.series'] LOOP
      IF EXISTS (SELECT 1 FROM pgboss.queue WHERE name = q) THEN
        PERFORM pgboss.delete_queue(q);
      END IF;
    END LOOP;
  END IF;
END;
$$;
DO $$
BEGIN
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    DELETE FROM _prisma_migrations WHERE migration_name = '20261013000000_p4_forecasts';
  END IF;
END;
$$;
