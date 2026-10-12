-- P4: the forecast store. Where Flint's forecasts of its own numbers will be kept,
-- and what the database guarantees about them whatever the runtime does:
--  - no forecast run, and no prediction that names a run or a series, is recorded
--    until Will signs the card that turns that number on, and that card acts in
--    one transaction only;
--  - a forecast is recorded as a statistical one only when its run beat a naive
--    guess, and as a base rate only when it did not;
--  - a series' sensitivity never changes, and no series is ever marked as allowed
--    to leave this Mac (Flint forecasts here and sends no series anywhere);
--  - a prediction only Will resolves is settled only by his answer;
--  - ECE and the Brier interval are stored only at 100 or more scored.
-- A forecast's numbers come from financial and personal series: a row refused on
-- INSERT or UPDATE never puts them in the error's message or DETAIL. Also the six
-- prediction job queues (nothing sends to them yet). It also carries four
-- hardenings back to P3's signed-card helpers (at the end of this file), and
-- gives MetricPoint the same id-only refusal. The only P4 migration. Reversed by
-- down.sql in this directory.

-- DropIndex
DROP INDEX "CalibrationSnapshot_windowEnd_domain_type_method_key";

-- AlterTable
ALTER TABLE "Prediction" ADD COLUMN     "forecastRunId" TEXT,
ADD COLUMN     "level" DOUBLE PRECISION,
ADD COLUMN     "lower" DOUBLE PRECISION,
ADD COLUMN     "pointEstimate" DOUBLE PRECISION,
ADD COLUMN     "seriesKey" TEXT,
ADD COLUMN     "unit" TEXT,
ADD COLUMN     "upper" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "CalibrationSnapshot" ADD COLUMN     "brierCiHigh" DOUBLE PRECISION,
ADD COLUMN     "brierCiLow" DOUBLE PRECISION,
ADD COLUMN     "ece" DOUBLE PRECISION,
ADD COLUMN     "intervalCoverage" DOUBLE PRECISION,
ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'binary',
ADD COLUMN     "pinball" DOUBLE PRECISION,
ALTER COLUMN "brier" DROP NOT NULL,
ALTER COLUMN "baseRate" DROP NOT NULL;

-- CreateTable
CREATE TABLE "ForecastRun" (
    "id" TEXT NOT NULL,
    "seriesKey" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "requestDigest" TEXT NOT NULL,
    "horizon" INTEGER NOT NULL,
    "level" DOUBLE PRECISION NOT NULL,
    "beatsNaive" BOOLEAN,
    "naiveMase" DOUBLE PRECISION,
    "modelMase" DOUBLE PRECISION,
    "scale" DOUBLE PRECISION,
    "points" JSONB NOT NULL,
    "latencyMs" INTEGER NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "error" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ForecastRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ForecastSeries" (
    "seriesKey" TEXT NOT NULL,
    "on" BOOLEAN NOT NULL DEFAULT false,
    "reason" BOOLEAN NOT NULL DEFAULT false,
    "approvalId" TEXT NOT NULL,
    "enabledAt" TIMESTAMPTZ(3) NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ForecastSeries_pkey" PRIMARY KEY ("seriesKey")
);

-- CreateTable
CREATE TABLE "PredictionQuestion" (
    "predictionId" TEXT NOT NULL,
    "askedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "shadow" BOOLEAN NOT NULL DEFAULT true,
    "answer" TEXT,
    "answeredAt" TIMESTAMPTZ(3),

    CONSTRAINT "PredictionQuestion_pkey" PRIMARY KEY ("predictionId")
);

-- CreateTable
CREATE TABLE "ForecastApprovalUse" (
    "approvalId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "xact" TEXT NOT NULL,
    "usedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ForecastApprovalUse_pkey" PRIMARY KEY ("approvalId")
);

-- CreateIndex
CREATE INDEX "ForecastRun_seriesKey_createdAt_idx" ON "ForecastRun"("seriesKey", "createdAt");

-- CreateIndex
CREATE INDEX "PredictionQuestion_answeredAt_askedAt_idx" ON "PredictionQuestion"("answeredAt", "askedAt");

-- CreateIndex
CREATE INDEX "Prediction_seriesKey_createdAt_idx" ON "Prediction"("seriesKey", "createdAt");

-- CreateIndex
CREATE INDEX "Prediction_forecastRunId_idx" ON "Prediction"("forecastRunId");

-- CreateIndex
CREATE UNIQUE INDEX "CalibrationSnapshot_windowEnd_domain_type_method_kind_key" ON "CalibrationSnapshot"("windowEnd", "domain", "type", "method", "kind");

-- AddForeignKey
ALTER TABLE "Prediction" ADD CONSTRAINT "Prediction_seriesKey_fkey" FOREIGN KEY ("seriesKey") REFERENCES "MetricSeries"("key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Prediction" ADD CONSTRAINT "Prediction_forecastRunId_fkey" FOREIGN KEY ("forecastRunId") REFERENCES "ForecastRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ForecastRun" ADD CONSTRAINT "ForecastRun_seriesKey_fkey" FOREIGN KEY ("seriesKey") REFERENCES "MetricSeries"("key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ForecastSeries" ADD CONSTRAINT "ForecastSeries_seriesKey_fkey" FOREIGN KEY ("seriesKey") REFERENCES "MetricSeries"("key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PredictionQuestion" ADD CONSTRAINT "PredictionQuestion_predictionId_fkey" FOREIGN KEY ("predictionId") REFERENCES "Prediction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ===========================================================================
-- Hand-written below this line. Every RAISE names its SQLSTATE: 23514
-- (check_violation) refuses what the caller sent; 42501 (insufficient_privilege)
-- is a rule no caller may break; 40001 (serialization_failure) is a write above
-- READ COMMITTED (try again). Messages name ids, series keys and the rule, never a
-- value: an error's words reach logs, cards and Postgres's own log.
-- ===========================================================================

-- ---- Rules on each row ------------------------------------------------------------
-- No Prisma enums. A forecast run, a prediction made from one and its resolution
-- hold numbers from financial and personal series, and a refused CHECK or NOT
-- NULL writes the whole row into its error's DETAIL ("Failing row contains
-- (...)"), which Postgres also logs. So their rules are validation triggers
-- (forecast_run_valid, prediction_valid, prediction_update_valid,
-- resolution_valid, below) that name the row and the rule only, and run before
-- any constraint could, on INSERT and on UPDATE. (COPY is out of their reach: it
-- quotes the start of the line it was given in the error's CONTEXT. The runtime
-- never uses COPY.) Tables that hold ids, switches and scores keep plain CHECKs.

-- ---- Series as they stand, before their labels are fixed for good -------------------
-- Until now nothing stopped a runtime relabeling a series or marking one as
-- allowed to leave this Mac, and from here on a series' label never changes and
-- none may leave. So what is already there is put right first, in the stricter
-- direction only: nothing was ever legitimately cleared to leave (no code sets
-- it), money is financial, and the calendar is never ops data.
UPDATE "MetricSeries" SET "offBoxAllowed" = false WHERE "offBoxAllowed";
UPDATE "MetricSeries" SET "sensitivity" = 'financial'
  WHERE (lower("unit") = 'usd' OR "key" ~ '(^|[.])spend([.]|$)') AND "sensitivity" <> 'financial';
UPDATE "MetricSeries" SET "sensitivity" = 'personal'
  WHERE "key" ~ '(^|[.])calendar([.]|$)' AND "sensitivity" = 'ops';
-- The labels the database can tell from a series itself (metric_series_guard says
-- the same on insert, by key only): a series in dollars, or with a `spend` segment
-- in its key, is financial; one with a `calendar` segment is never ops.
-- And no series is allowed to leave this Mac, whatever it is: there is no card for
-- it and no path to it. (P1's own CHECK allowed it for an ops series; if Flint is
-- ever to compare itself with an outside forecaster, a later migration adds a
-- signed way, and nothing before then can have opened one.)
ALTER TABLE "MetricSeries"
  ADD CONSTRAINT "MetricSeries_money_check" CHECK (NOT (lower("unit") = 'usd' OR "key" ~ '(^|[.])spend([.]|$)') OR "sensitivity" = 'financial'),
  ADD CONSTRAINT "MetricSeries_calendar_check" CHECK ("key" !~ '(^|[.])calendar([.]|$)' OR "sensitivity" <> 'ops'),
  ADD CONSTRAINT "MetricSeries_onbox_check" CHECK (NOT "offBoxAllowed");

-- A forecast computed on this Mac has its own method name, `statistical`. (P1's
-- list also has `prophet`, for a service Flint does not use: the name stays in
-- the list, and prediction_valid, below, records nothing new under it.)
ALTER TABLE "Prediction"
  DROP CONSTRAINT IF EXISTS "Prediction_method_check",
  ADD CONSTRAINT "Prediction_method_check" CHECK ("method" IN ('model_reasoning', 'prophet', 'statistical', 'rule', 'base_rate', 'human'));

ALTER TABLE "ForecastSeries"
  -- The local model estimates only a number that is forecast.
  ADD CONSTRAINT "ForecastSeries_reason_check" CHECK ("on" OR NOT "reason"),
  ADD CONSTRAINT "ForecastSeries_approval_check" CHECK ("approvalId" ~ '^[A-Za-z0-9_-]{1,40}$');

ALTER TABLE "PredictionQuestion"
  ADD CONSTRAINT "PredictionQuestion_answer_check" CHECK ("answer" IS NULL OR "answer" IN ('yes', 'no', 'skip')),
  ADD CONSTRAINT "PredictionQuestion_answered_check" CHECK (("answer" IS NULL) = ("answeredAt" IS NULL));

ALTER TABLE "ForecastApprovalUse"
  ADD CONSTRAINT "ForecastApprovalUse_action_check" CHECK ("action" = 'forecast.series.enable');

-- A yes/no group has its Brier score and base rate; a range group has its coverage
-- and neither of those (storing 0 would be a lie). ECE and the Brier interval need
-- 100 scored (exit 4): below that they would be noise with a decimal point.
ALTER TABLE "CalibrationSnapshot"
  ADD CONSTRAINT "CalibrationSnapshot_kind_check" CHECK ("kind" IN ('binary', 'interval')),
  ADD CONSTRAINT "CalibrationSnapshot_binary_check" CHECK (
    "kind" <> 'binary' OR ("brier" IS NOT NULL AND "baseRate" IS NOT NULL AND "intervalCoverage" IS NULL AND "pinball" IS NULL)
  ),
  ADD CONSTRAINT "CalibrationSnapshot_interval_check" CHECK (
    "kind" <> 'interval' OR ("intervalCoverage" IS NOT NULL AND "brier" IS NULL AND "baseRate" IS NULL AND "brierSkill" IS NULL
                             AND "ece" IS NULL AND "brierCiLow" IS NULL AND "brierCiHigh" IS NULL)
  ),
  ADD CONSTRAINT "CalibrationSnapshot_n100_check" CHECK ("n" >= 100 OR ("ece" IS NULL AND "brierCiLow" IS NULL AND "brierCiHigh" IS NULL)),
  -- NaN sorts above every number here, so BETWEEN and < refuse it too.
  ADD CONSTRAINT "CalibrationSnapshot_scores_check" CHECK (
    ("intervalCoverage" IS NULL OR "intervalCoverage" BETWEEN 0 AND 1)
    AND ("ece" IS NULL OR "ece" BETWEEN 0 AND 1)
    AND ("pinball" IS NULL OR ("pinball" >= 0 AND "pinball" < 'Infinity'::float8))
    AND (("brierCiLow" IS NULL) = ("brierCiHigh" IS NULL))
    AND ("brierCiLow" IS NULL OR ("brierCiLow" >= 0 AND "brierCiHigh" <= 1 AND "brierCiLow" <= "brierCiHigh"))
  );

-- ---- Partial indexes (Prisma's diff does not see them) -----------------------------
-- The same input forecast twice is one run: a retried job finds the first.
CREATE UNIQUE INDEX "ForecastRun_request_key" ON "ForecastRun" ("seriesKey", "requestDigest") WHERE "ok";
-- A run backs at most one range and one yes/no question from the forecaster, and
-- one estimate from the local model: a retried job records nothing twice, and a
-- run's record is not padded with copies.
CREATE UNIQUE INDEX "Prediction_run_forecast_key" ON "Prediction" ("forecastRunId", "kind") WHERE "forecastRunId" IS NOT NULL AND "createdBy" = 'runtime:forecast';
CREATE UNIQUE INDEX "Prediction_run_reason_key" ON "Prediction" ("forecastRunId") WHERE "forecastRunId" IS NOT NULL AND "createdBy" = 'runtime:reason';

-- ---- The signed card a guarded change rides on -------------------------------------
-- An approval Will signed (approve, a live credential) for a card that is
-- executing now and not expired (by the wall clock: a transaction opened before
-- the card expired gains nothing), for this action, filed from the console or the
-- CLI with nothing untrusted in it, whose stored args are the args he signed
-- (their digest is computed again here, as digestOf computes it). The card is
-- marked for Will's own fresh touch (consequential: one filed without the mark,
-- to slip into an approve-all, acts on nothing), and it expires no later than
-- 7 days after his approval does (an approval lives a day at most, and the
-- runtime files a card for a week at most): a card filed with a far-off expiry
-- cannot be signed now and kept to turn things on months later. It never
-- consumes the approval (proposal_transition did that when the card was
-- approved); p4_bind_approval, below, makes each one act in one transaction only.
-- Raises otherwise. VOLATILE (the default): each call reads the wall clock and what
-- is committed now. Called from trigger bodies, which run as flint_app: it has EXECUTE.
CREATE FUNCTION p4_signed_proposal(p_approval text, p_action text) RETURNS "Proposal"
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  a "Approval"%ROWTYPE;
  p "Proposal"%ROWTYPE;
BEGIN
  SELECT * INTO a FROM "Approval" WHERE "id" = p_approval;
  IF NOT FOUND OR a."decision" <> 'approve' OR a."subjectType" <> 'proposal'
     OR NOT EXISTS (SELECT 1 FROM "ApprovalCredential" c WHERE c."credentialId" = a."credentialId" AND c."revokedAt" IS NULL) THEN
    RAISE EXCEPTION 'forecast card: approval % is not a live signed approval of a card', left(p_approval, 40) USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO p FROM "Proposal" WHERE "id" = a."subjectId";
  IF NOT FOUND OR NOT coalesce(
       p."approvalId" = a."id" AND p."status" = 'executing' AND p."expiresAt" > clock_timestamp()
       AND p."expiresAt" <= a."expiresAt" + interval '7 days'
       AND p."action" = p_action AND p_action = 'forecast.series.enable'
       AND p."kind" = 'tool_call' AND p."origin" IN ('console', 'cli') AND NOT p."tainted" AND p."consequential"
       AND a."payload"->>'action' = p."action" AND a."payload"->>'argsDigest' = p."argsDigest"
       AND jsonb_typeof(p."args") = 'object' AND p3_args_digest(p."args") = p."argsDigest", false) THEN
    RAISE EXCEPTION 'forecast card: approval % is not for an executing % card', left(p_approval, 40), left(p_action, 40) USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN p;
END;
$$;

-- An approval acts in one transaction only: the first use records the
-- transaction, and any use from another one (the card left executing, a replay
-- after Will turned the number off again) is refused, as is its use for another
-- action. Only a live, executing card for that action is ever recorded, and only
-- from inside a trigger (forecast_series_bind, below, is the only one that calls
-- it, and flint_app can create none): a call of its own can neither spend a card
-- nor fill the table. SECURITY DEFINER: flint_app has no grant on
-- ForecastApprovalUse, so it can only use an approval, never free one.
CREATE FUNCTION p4_bind_approval(p_approval text, p_action text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  u "ForecastApprovalUse"%ROWTYPE;
  -- This transaction: its id, and when it began (so the same id met again after a restore into a new cluster is not it).
  me text := pg_current_xact_id()::text || '@' || (extract(epoch FROM transaction_timestamp()) * 1000000)::bigint::text;
BEGIN
  IF pg_trigger_depth() < 1 THEN
    RAISE EXCEPTION 'forecast card: an approval is used only by the change it signed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM p4_signed_proposal(p_approval, p_action);
  INSERT INTO "ForecastApprovalUse" ("approvalId", "action", "xact")
  VALUES (p_approval, p_action, me)
  ON CONFLICT ("approvalId") DO NOTHING;
  SELECT * INTO u FROM "ForecastApprovalUse" WHERE "approvalId" = p_approval;
  IF NOT coalesce(u."xact" = me AND u."action" = p_action, false) THEN
    RAISE EXCEPTION 'forecast card: approval % was already used', left(p_approval, 40) USING ERRCODE = 'insufficient_privilege';
  END IF;
END;
$$;

-- ---- Series -------------------------------------------------------------------------
-- A series is born on this Mac and stays on it: offBoxAllowed is false at birth
-- and never becomes true, for any role, under any card (there is none). It is
-- never born already forgotten, and it is born under the label the database can
-- tell from it: a series in dollars (or with a `spend` segment in its key) is
-- financial, and one with a `calendar` segment is never ops. What it is never
-- changes: its key, its unit, its step, when it was made, the entity it is
-- about (or that it is about none) and, above all, its SENSITIVITY (before
-- this, a runtime could relabel a financial series as ops and then mark it as
-- allowed to leave). The entity is fixed at birth both ways: unlinking a series
-- would hide it from a forget, and linking one later would let a runtime tie
-- any number to an unrelated item, whose forget would then stop that number
-- for good. Only a forget marks it forgotten (as flint_owner, inside
-- forget_entity: a runtime that wrote the mark itself would stop a number for
-- good), and a forgotten series stays forgotten.
CREATE FUNCTION metric_series_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  forgetting boolean := current_user = 'flint_owner' AND coalesce(current_setting('flint.forget_approval', true), '') <> '';
  k text;
BEGIN
  IF NEW."offBoxAllowed" IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'series %: no series leaves this Mac', left(NEW."key", 80) USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."description" = '[forgotten]' THEN
      RAISE EXCEPTION 'series %: only a forget marks a series forgotten', left(NEW."key", 80) USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- Since the label can never change, it must be right from the start wherever the database can tell.
    IF (lower(NEW."unit") = 'usd' OR NEW."key" ~ '(^|[.])spend([.]|$)') AND NEW."sensitivity" IS DISTINCT FROM 'financial' THEN
      RAISE EXCEPTION 'series %: a series in dollars, or of spend, is financial', left(NEW."key", 80) USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."key" ~ '(^|[.])calendar([.]|$)' AND NEW."sensitivity" = 'ops' THEN
      RAISE EXCEPTION 'series %: a calendar series is never ops data', left(NEW."key", 80) USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  FOREACH k IN ARRAY ARRAY['key', 'entityId', 'unit', 'freq', 'sensitivity', 'createdAt'] LOOP
    IF (to_jsonb(NEW) -> k) IS DISTINCT FROM (to_jsonb(OLD) -> k) THEN
      RAISE EXCEPTION 'series %: its % never changes', OLD."key", k USING ERRCODE = 'insufficient_privilege';
    END IF;
  END LOOP;
  IF OLD."description" = '[forgotten]' AND NEW."description" IS DISTINCT FROM OLD."description" THEN
    RAISE EXCEPTION 'series %: it was forgotten and stays forgotten', OLD."key" USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."description" = '[forgotten]' AND OLD."description" IS DISTINCT FROM '[forgotten]' AND NOT forgetting THEN
    RAISE EXCEPTION 'series %: only a forget marks a series forgotten', OLD."key" USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

-- A metric point's own rules (its NOT NULLs), named by its series and nothing
-- else: a refused point would otherwise print its value in the error's DETAIL,
-- and spend is a series like any other. On INSERT and UPDATE.
CREATE FUNCTION metric_point_valid() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW."seriesKey" IS NULL OR NEW."at" IS NULL OR NEW."value" IS NULL THEN
    RAISE EXCEPTION 'metric point of %: its series, time and value are required',
      CASE WHEN NEW."seriesKey" ~ '^[a-z0-9_.-]{1,120}$' THEN NEW."seriesKey" ELSE '?' END USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- Which numbers Flint forecasts. A row is turned on (its `on`, its `reason`, the
-- approval it names, or its enabled time changing, and every insert) only while
-- the signed forecast.series.enable card whose approval it names is executing,
-- with that number in the card's signed `series` list (and, for the local
-- model's estimate, in its `reason` list), in that approval's one transaction
-- (forecast_series_bind, below, once the row is written), at READ COMMITTED,
-- and never for a forgotten series. The card is at least as sensitive as the
-- number (a card for a spend series is a financial card, which asks on its
-- own). So after a signed change, what a row says is within what its approval
-- signed. Turning `on` or `reason` off needs nothing: it only narrows what
-- Flint does. Rows are never deleted, and a row's key never changes. Its times
-- come from the wall clock.
CREATE FUNCTION forecast_series_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  p "Proposal"%ROWTYPE;
  signed boolean;
  label text;
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'forecast series are turned off, never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."seriesKey" IS DISTINCT FROM OLD."seriesKey" THEN
    RAISE EXCEPTION 'forecast series %: its key never changes', OLD."seriesKey" USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    signed := true;
  ELSE
    signed := (NEW."on" IS DISTINCT FROM OLD."on" AND NEW."on" IS DISTINCT FROM false)
              OR (NEW."reason" IS DISTINCT FROM OLD."reason" AND NEW."reason" IS DISTINCT FROM false)
              OR NEW."approvalId" IS DISTINCT FROM OLD."approvalId" OR NEW."enabledAt" IS DISTINCT FROM OLD."enabledAt";
  END IF;
  NEW."updatedAt" := clock_timestamp();
  IF NOT signed THEN
    RETURN NEW;
  END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'forecast series %: it is turned on at read committed only', left(NEW."seriesKey", 80) USING ERRCODE = 'serialization_failure';
  END IF;
  IF NEW."on" IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'forecast series %: a card turns a number on (turning it off needs none)', left(NEW."seriesKey", 80) USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT s."sensitivity" INTO label FROM "MetricSeries" s WHERE s."key" = NEW."seriesKey" AND s."description" <> '[forgotten]';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'forecast series %: it is not there to forecast', left(NEW."seriesKey", 80) USING ERRCODE = 'check_violation';
  END IF;
  p := p4_signed_proposal(NEW."approvalId", 'forecast.series.enable');
  IF NOT coalesce(p."sensitivity" = 'financial' OR label = 'ops' OR (label = 'personal' AND p."sensitivity" = 'personal'), false) THEN
    RAISE EXCEPTION 'forecast series %: approval % signed a card less sensitive than this number', NEW."seriesKey", NEW."approvalId" USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT coalesce(jsonb_typeof(p."args"->'series') = 'array' AND p."args"->'series' ? NEW."seriesKey", false) THEN
    RAISE EXCEPTION 'forecast series %: approval % did not sign turning it on', NEW."seriesKey", NEW."approvalId" USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."reason" IS DISTINCT FROM false AND NOT coalesce(jsonb_typeof(p."args"->'reason') = 'array' AND p."args"->'reason' ? NEW."seriesKey", false) THEN
    RAISE EXCEPTION 'forecast series %: approval % did not sign the local model''s estimate of it', NEW."seriesKey", NEW."approvalId" USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW."enabledAt" := clock_timestamp();
  RETURN NEW;
END;
$$;

-- The approval is used when a signed change has landed, not when one was only
-- tried: an insert that met an existing row and did nothing (ON CONFLICT DO
-- NOTHING) fired the guard above and wrote no row, so it spends nothing. This
-- fires after the row is written, for the same changes the guard holds to a card
-- (the guard stamps enabledAt on each), and refuses the write if the approval
-- was already used in another transaction.
CREATE FUNCTION forecast_series_bind() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM p4_bind_approval(NEW."approvalId", 'forecast.series.enable');
  ELSIF (NEW."on" AND NOT OLD."on") OR (NEW."reason" AND NOT OLD."reason")
        OR NEW."approvalId" IS DISTINCT FROM OLD."approvalId" OR NEW."enabledAt" IS DISTINCT FROM OLD."enabledAt" THEN
    PERFORM p4_bind_approval(NEW."approvalId", 'forecast.series.enable');
  END IF;
  RETURN NULL;
END;
$$;

-- Every on and off, with who did it (flint.actor): row_history, keyed by the
-- series key (ForecastSeries has no id), and for the first turn-on too (an
-- INSERT). What changed is switches, an approval id and a time: no text. A
-- write that changed only updatedAt is not history.
CREATE FUNCTION forecast_series_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  o jsonb := CASE WHEN TG_OP = 'INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;
  n jsonb := to_jsonb(NEW);
  changed jsonb := '{}'::jsonb;
  k text;
BEGIN
  FOREACH k IN ARRAY ARRAY['on', 'reason', 'approvalId', 'enabledAt'] LOOP
    IF (o -> k) IS DISTINCT FROM (n -> k) THEN
      changed := changed || jsonb_build_object(k, jsonb_build_array(coalesce(o -> k, 'null'::jsonb), n -> k));
    END IF;
  END LOOP;
  IF changed <> '{}'::jsonb THEN
    INSERT INTO "RowChange" ("id", "tableName", "rowId", "actor", "changed")
    VALUES ('rc' || replace(gen_random_uuid()::text, '-', ''), TG_TABLE_NAME, NEW."seriesKey",
            left(coalesce(nullif(current_setting('flint.actor', true), ''), session_user), 80), changed);
  END IF;
  RETURN NEW;
END;
$$;

-- ---- Forecast runs --------------------------------------------------------------------
-- A run is recorded now (the wall clock), at READ COMMITTED, only for a series
-- that is there, was not forgotten and that Will turned on (the signed card is
-- the on-switch; without it nothing is forecast). Every run is local: its own
-- rules, below, refuse any other provider (exit 6: no series leaves this Mac).
CREATE FUNCTION forecast_run_check() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  s "MetricSeries"%ROWTYPE;
BEGIN
  IF NOT coalesce(NEW."id" ~ '^[A-Za-z0-9_-]{1,40}$', false) THEN
    RAISE EXCEPTION 'forecast run: its id is not valid' USING ERRCODE = 'check_violation';
  END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'forecast run %: runs are recorded at read committed only', NEW."id" USING ERRCODE = 'serialization_failure';
  END IF;
  NEW."createdAt" := clock_timestamp();
  SELECT * INTO s FROM "MetricSeries" WHERE "key" = NEW."seriesKey";
  IF NOT FOUND OR s."description" = '[forgotten]' THEN
    RAISE EXCEPTION 'forecast run %: its series is not there to forecast', NEW."id" USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "ForecastSeries" f WHERE f."seriesKey" = s."key" AND f."on") THEN
    RAISE EXCEPTION 'forecast run %: series % is not turned on', NEW."id", s."key" USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

-- A run's own rules (the CHECKs it would otherwise have), naming the rule, never a
-- value. It was computed on this Mac: its provider is `local`, and nothing
-- else, and its endpoint names the local forecaster that made it (`local:` and
-- a short name; never a URL, a host or a path, so a run recorded as local
-- cannot name somewhere else). Its points are numbers and times only: [{at, mean, lo, hi}], nothing else
-- in them. A run that failed says a short code for why (one word of letters,
-- digits, `_ . : -`; never a sentence) and has no points, no scores and no
-- verdict; a verdict has both error scores, and a run that beat naive has the
-- lower one. NaN and the infinities are refused (NaN sorts above every number
-- here, so each bound is written to exclude it). No pattern here uses a
-- backslash, so none depends on the session's standard_conforming_strings.
CREATE FUNCTION forecast_run_valid() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  bad text;
  e jsonb;
BEGIN
  bad := CASE
    WHEN NEW."seriesKey" IS NULL OR NEW."points" IS NULL OR NEW."ok" IS NULL OR NEW."createdAt" IS NULL THEN 'a required field'
    WHEN NOT coalesce(NEW."provider" = 'local', false) THEN 'provider'
    WHEN NOT coalesce(NEW."endpoint" ~ '^local:[a-z0-9._-]{1,60}$', false) THEN 'endpoint'
    WHEN NOT coalesce(NEW."requestDigest" ~ '^[0-9a-f]{64}$', false) THEN 'digest'
    WHEN NOT coalesce(NEW."horizon" BETWEEN 1 AND 720, false) THEN 'horizon'
    WHEN NOT coalesce(NEW."level" > 0 AND NEW."level" < 1, false) THEN 'level'
    WHEN NOT coalesce(NEW."latencyMs" >= 0, false) THEN 'latency'
    WHEN NOT coalesce((NEW."naiveMase" IS NULL OR (NEW."naiveMase" >= 0 AND NEW."naiveMase" < 'Infinity'::float8))
                      AND (NEW."modelMase" IS NULL OR (NEW."modelMase" >= 0 AND NEW."modelMase" < 'Infinity'::float8))
                      AND (NEW."scale" IS NULL OR (NEW."scale" >= 0 AND NEW."scale" < 'Infinity'::float8)), false) THEN 'error scores'
    WHEN NOT coalesce(NEW."beatsNaive" IS NULL OR (NEW."ok" AND NEW."naiveMase" IS NOT NULL AND NEW."modelMase" IS NOT NULL
                                                  AND (NOT NEW."beatsNaive" OR NEW."modelMase" < NEW."naiveMase")), false) THEN 'verdict'
    WHEN NOT coalesce(NEW."error" IS NULL OR NEW."error" ~ '^[A-Za-z0-9_.:-]{1,80}$', false) THEN 'error'
    -- CASE tests its branches in order: nothing below reads the points as an array until this says they are one.
    WHEN jsonb_typeof(NEW."points") <> 'array' OR octet_length(NEW."points"::text) > 65536 THEN 'points'
    WHEN jsonb_array_length(NEW."points") > 720 THEN 'points'
    WHEN NOT ((NEW."ok" AND NEW."error" IS NULL AND jsonb_array_length(NEW."points") >= 1)
              OR (NOT NEW."ok" AND NEW."error" IS NOT NULL AND jsonb_array_length(NEW."points") = 0
                  AND NEW."naiveMase" IS NULL AND NEW."modelMase" IS NULL AND NEW."scale" IS NULL)) THEN 'outcome'
  END;
  IF bad IS NULL THEN
    FOR e IN SELECT * FROM jsonb_array_elements(NEW."points") LOOP
      -- One test per step, so a later one never reads a value an earlier one refused.
      IF jsonb_typeof(e) <> 'object' THEN
        bad := 'points';
      ELSIF (e - ARRAY['at', 'mean', 'lo', 'hi']) <> '{}'::jsonb
            OR NOT coalesce(jsonb_typeof(e->'at') = 'string' AND jsonb_typeof(e->'mean') = 'number' AND jsonb_typeof(e->'lo') = 'number'
                            AND jsonb_typeof(e->'hi') = 'number', false) THEN
        bad := 'points';
      ELSIF (e->>'at') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
            OR (e->'lo')::numeric > (e->'mean')::numeric OR (e->'mean')::numeric > (e->'hi')::numeric THEN
        bad := 'points';
      END IF;
      EXIT WHEN bad IS NOT NULL;
    END LOOP;
  END IF;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'forecast run %: its % is not valid', NEW."id", bad USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- ---- Predictions made from a run -----------------------------------------------------
-- A prediction that names a run (exit 2): the run is there, ok and for the same
-- series, and that number is still on and was not forgotten (turning a number
-- off, or forgetting it, stops its predictions too, from an old run as much as
-- a new one). `statistical` only on a run that beat naive, and `base_rate` only
-- on a run that did not (false, or too short to tell): the method on the record
-- is what the backtest earned. The local model's estimate
-- may ride on any ok run, but only for a number whose `reason` switch Will
-- signed and has not turned off. A range carries the run's level. And the row
-- says what its series is: it carries the series' own unit, and it is filed
-- under `spend` exactly when its series is financial, and under `calendar`
-- exactly when its series is a calendar one (the two domains the database can
-- tell from a series), so a forecast of dollars is never on record as a count
-- of deploys, where whatever reads forecasts by unit or domain would take it
-- for ops data. At READ COMMITTED.
CREATE FUNCTION prediction_forecast_check() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  r "ForecastRun"%ROWTYPE;
  f "ForecastSeries"%ROWTYPE;
  s "MetricSeries"%ROWTYPE;
  pid text := CASE WHEN NEW."id" ~ '^[A-Za-z0-9_-]{1,40}$' THEN NEW."id" ELSE '?' END;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'prediction %: a forecast''s prediction is recorded at read committed only', pid USING ERRCODE = 'serialization_failure';
  END IF;
  SELECT * INTO r FROM "ForecastRun" WHERE "id" = NEW."forecastRunId";
  IF NOT FOUND OR NOT r."ok" OR r."seriesKey" IS DISTINCT FROM NEW."seriesKey" THEN
    RAISE EXCEPTION 'prediction %: it needs an ok forecast run of its own series', pid USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO f FROM "ForecastSeries" WHERE "seriesKey" = r."seriesKey";
  IF NOT FOUND OR NOT f."on" THEN
    RAISE EXCEPTION 'prediction %: series % is not turned on', pid, r."seriesKey" USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO s FROM "MetricSeries" WHERE "key" = r."seriesKey";
  IF NOT FOUND OR s."description" = '[forgotten]' THEN
    RAISE EXCEPTION 'prediction %: its series was forgotten', pid USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."unit" IS DISTINCT FROM s."unit" THEN
    RAISE EXCEPTION 'prediction %: it carries the unit of its series (%)', pid, s."key" USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."domain" IS NOT DISTINCT FROM 'spend') <> (s."sensitivity" = 'financial')
     OR (NEW."domain" IS NOT DISTINCT FROM 'calendar') <> (s."key" ~ '(^|[.])calendar([.]|$)') THEN
    RAISE EXCEPTION 'prediction %: its domain is not that of its series (%)', pid, s."key" USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."method" = 'statistical' AND NOT coalesce(r."beatsNaive", false) THEN
    RAISE EXCEPTION 'prediction %: statistical only on a run that beat naive (run %)', pid, r."id" USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."method" = 'base_rate' AND coalesce(r."beatsNaive", false) THEN
    RAISE EXCEPTION 'prediction %: base_rate only on a run that did not beat naive (run %)', pid, r."id" USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."method" = 'model_reasoning' AND NOT f."reason" THEN
    RAISE EXCEPTION 'prediction %: the local model''s estimate is not turned on for series %', pid, r."seriesKey" USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."kind" = 'interval' AND NEW."level" IS DISTINCT FROM r."level" THEN
    RAISE EXCEPTION 'prediction %: a range carries its run''s level (run %)', pid, r."id" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- A forecast's row (it names a run or a series, carries a range's numbers or a
-- unit, is a range, claims a forecast method, or was written by one of the two
-- forecast writers) is checked here against EVERY rule a prediction has, P1's
-- and P3's CHECKs included, before any of them could refuse it and write its
-- numbers into an error. Any other prediction is left to the plain
-- constraints. P4's own rules:
--  - a range has its middle, both ends and a level (finite, lower <= middle <=
--    upper, 0 < level < 1); a yes/no has none of them;
--  - a run and a series are named together; `statistical` needs a run, and nothing
--    is recorded as `prophet` (Flint forecasts on this Mac; the name stays in P1's
--    list for a later comparison, if one is ever built);
--  - a prediction with a run was written by the forecaster (runtime:forecast) or,
--    for the local model's estimate, by runtime:reason; it resolves by itself
--    from the metric, is untainted, and is about no goal and no entity;
--  - and the other way round: a row either writer makes ALWAYS names its run
--    and its series (and so meets every rule prediction_forecast_check holds a
--    forecast to: the number is on, the run is its own, the unit is the
--    series'). A forecast writer has no way to record a series' numbers as a
--    loose prediction, which chat's list of open predictions would then show.
-- BEFORE INSERT: prediction_guard lets none of these columns change afterwards
-- (prediction_update_valid, below, covers what an UPDATE can still get wrong).
CREATE FUNCTION prediction_valid() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  bad text;
  n integer := (NEW."pointEstimate" IS NOT NULL)::int + (NEW."lower" IS NOT NULL)::int + (NEW."upper" IS NOT NULL)::int + (NEW."level" IS NOT NULL)::int;
BEGIN
  IF NOT (NEW."forecastRunId" IS NOT NULL OR NEW."seriesKey" IS NOT NULL OR NEW."unit" IS NOT NULL OR n > 0
          OR coalesce(NEW."kind" = 'interval', false) OR coalesce(NEW."method" IN ('statistical', 'prophet'), false)
          OR coalesce(NEW."createdBy" IN ('runtime:forecast', 'runtime:reason'), false)) THEN
    RETURN NEW;
  END IF;
  IF NOT coalesce(NEW."id" ~ '^[A-Za-z0-9_-]{1,40}$', false) THEN
    RAISE EXCEPTION 'prediction: its id is not valid' USING ERRCODE = 'check_violation';
  END IF;
  bad := CASE
    WHEN NEW."claim" IS NULL OR NEW."evidence" IS NULL OR NEW."resolutionCriteria" IS NULL OR NEW."resolveBy" IS NULL OR NEW."tainted" IS NULL
         OR NEW."createdBy" IS NULL OR NEW."createdAt" IS NULL OR NEW."lateSupersession" IS NULL THEN 'a required field'
    -- P1's and P3's rules.
    WHEN NOT coalesce(NEW."kind" IN ('binary', 'interval'), false) THEN 'kind'
    WHEN NOT coalesce(NEW."method" IN ('model_reasoning', 'prophet', 'statistical', 'rule', 'base_rate', 'human'), false) THEN 'method'
    WHEN NOT coalesce(NEW."domain" IN ('services', 'deploys', 'spend', 'repos', 'projects', 'calendar', 'goals', 'assets', 'selfmod', 'triage', 'recommendation'), false) THEN 'domain'
    WHEN NOT coalesce(NEW."type" IN ('event_occurs', 'deadline_met', 'threshold_cross', 'trend', 'relevance', 'task_meets_bar', 'effect_given_accept'), false) THEN 'type'
    WHEN NOT coalesce(NEW."resolver" IN ('auto_world', 'auto_metric', 'will', 'conditional'), false) THEN 'resolver'
    WHEN NOT coalesce(NEW."status" IN ('open', 'resolved', 'expired', 'superseded', 'condition_unmet', 'void'), false) THEN 'status'
    WHEN NOT coalesce(NEW."probability" IS NULL
                      OR (NEW."probability" BETWEEN 0 AND 1 AND (NEW."method" = 'human' OR NEW."probability" BETWEEN 0.05 AND 0.95)), false) THEN 'probability'
    WHEN NOT coalesce(NEW."kind" <> 'binary' OR NEW."probability" IS NOT NULL, false) THEN 'probability'
    WHEN NOT coalesce(char_length(NEW."claim") BETWEEN 1 AND 300, false) THEN 'claim'
    WHEN NOT coalesce(char_length(NEW."resolutionCriteria") BETWEEN 1 AND 1000, false) THEN 'criteria'
    WHEN NOT coalesce(jsonb_typeof(NEW."evidence") = 'array' AND octet_length(NEW."evidence"::text) <= 16384, false) THEN 'evidence'
    WHEN NOT coalesce(NEW."resolveBy" > NEW."createdAt" AND NEW."resolveBy" <= NEW."createdAt" + interval '180 days', false) THEN 'horizon'
    WHEN NOT coalesce((NEW."resolver" = 'conditional') = (NEW."conditionRecommendationId" IS NOT NULL), false) THEN 'condition'
    WHEN NOT coalesce(NEW."supersedesId" IS NULL OR NEW."supersedesId" <> NEW."id", false) THEN 'supersession'
    WHEN NOT coalesce(NEW."goalId" IS NULL OR (NEW."domain" = 'goals' AND NEW."createdBy" = 'runtime:goals'), false) THEN 'goal'
    -- P4's rules.
    WHEN NEW."kind" = 'binary' AND n > 0 THEN 'range'
    WHEN NEW."kind" = 'interval' AND NOT coalesce(
           NEW."lower" > '-Infinity'::float8 AND NEW."upper" < 'Infinity'::float8 AND NEW."lower" <= NEW."pointEstimate" AND NEW."pointEstimate" <= NEW."upper"
           AND NEW."level" > 0 AND NEW."level" < 1, false) THEN 'range'
    WHEN (NEW."forecastRunId" IS NULL) <> (NEW."seriesKey" IS NULL) THEN 'run and series'
    WHEN NEW."createdBy" IN ('runtime:forecast', 'runtime:reason') AND NEW."forecastRunId" IS NULL THEN 'run and series'
    WHEN NEW."method" = 'prophet' THEN 'method'
    WHEN NEW."method" = 'statistical' AND NEW."forecastRunId" IS NULL THEN 'run'
    WHEN NOT coalesce(NEW."unit" IS NULL OR NEW."unit" ~ '^[a-z_]{1,20}$', false) THEN 'unit'
    WHEN NEW."forecastRunId" IS NOT NULL AND NOT coalesce(
           NEW."method" IN ('statistical', 'base_rate', 'model_reasoning')
           AND NEW."createdBy" = CASE WHEN NEW."method" = 'model_reasoning' THEN 'runtime:reason' ELSE 'runtime:forecast' END
           AND NEW."resolver" = 'auto_metric' AND NOT NEW."tainted" AND NEW."goalId" IS NULL AND NEW."subjectEntityId" IS NULL, false) THEN 'writer'
  END;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'prediction %: its % is not valid', NEW."id", bad USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- On UPDATE, P1's prediction_guard lets only four columns change, and two of them
-- may not be NULL. It does not refuse a NULL there itself, so the NOT NULL
-- constraint would, printing the row (a forecast's range, any prediction's
-- claim). This does, first and by id. Fires after Prediction_guard (name order).
CREATE FUNCTION prediction_update_valid() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW."status" IS NULL OR NEW."lateSupersession" IS NULL THEN
    RAISE EXCEPTION 'prediction %: its status and its late mark are never empty', OLD."id" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- ---- Will's questions ---------------------------------------------------------------------
-- A question is asked once (the prediction is its key), at READ COMMITTED, only
-- about a yes/no prediction that Will resolves, still open or superseded,
-- unresolved and past its resolve time; it starts unanswered, asked now. Only its
-- answer is ever written, once, in a transaction that says it is Will's
-- (flint.actor `will:...`: the console's answer route sets it; the runtime's own
-- writers do not), stamped now. Never deleted.
CREATE FUNCTION prediction_question_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  p "Prediction"%ROWTYPE;
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'prediction questions are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF current_setting('transaction_isolation') <> 'read committed' THEN
      RAISE EXCEPTION 'question: asked at read committed only' USING ERRCODE = 'serialization_failure';
    END IF;
    SELECT * INTO p FROM "Prediction" WHERE "id" = NEW."predictionId";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'question: its prediction is not there' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."answer" IS NOT NULL OR NEW."answeredAt" IS NOT NULL THEN
      RAISE EXCEPTION 'question %: a question starts unanswered', p."id" USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT coalesce(p."resolver" = 'will' AND p."kind" = 'binary' AND p."status" IN ('open', 'superseded') AND p."resolveBy" <= clock_timestamp()
                    AND NOT EXISTS (SELECT 1 FROM "Resolution" r WHERE r."predictionId" = p."id"), false) THEN
      RAISE EXCEPTION 'question %: asked only about a due, unresolved yes/no prediction that Will resolves', p."id" USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW."askedAt" := clock_timestamp();
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['answer', 'answeredAt']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['answer', 'answeredAt']) THEN
    RAISE EXCEPTION 'question %: only its answer is ever written', OLD."predictionId" USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD."answer" IS NOT NULL THEN
    IF NEW."answer" IS DISTINCT FROM OLD."answer" OR NEW."answeredAt" IS DISTINCT FROM OLD."answeredAt" THEN
      RAISE EXCEPTION 'question %: it was already answered', OLD."predictionId" USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."answer" IS NULL THEN
    IF NEW."answeredAt" IS NOT NULL THEN
      RAISE EXCEPTION 'question %: an answer and its time are written together', OLD."predictionId" USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF coalesce(current_setting('flint.actor', true), '') NOT LIKE 'will:%' THEN
    RAISE EXCEPTION 'question %: only Will answers it', OLD."predictionId" USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW."answeredAt" := clock_timestamp();
  RETURN NEW;
END;
$$;

-- A resolution recorded as Will's (resolvedBy `will`; P1's leak guard already
-- makes every resolution of a prediction only Will resolves one of these) is his:
-- his yes or no to that prediction's question, with that outcome; or, for a
-- goal's forecast, the signed goal.done or goal.abandon card finishing its goal
-- in this very transaction (P3's executor resolves a goal's forecasts as Will,
-- in the transaction that finishes the goal: p3_bind_approval holds that
-- approval to the one transaction that used it, so a card left executing gives
-- no cover later). A job, or the model, cannot settle Will's predictions for
-- him. At READ COMMITTED.
-- (resolution_leak_guard is untouched and fires first: trigger names sort.)
CREATE FUNCTION resolution_will_check() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  pid text := CASE WHEN NEW."predictionId" ~ '^[A-Za-z0-9_-]{1,40}$' THEN NEW."predictionId" ELSE '?' END;
  answer text;
  goal text;
  g "Goal"%ROWTYPE;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'resolution of %: Will''s resolutions are recorded at read committed only', pid USING ERRCODE = 'serialization_failure';
  END IF;
  SELECT q."answer" INTO answer FROM "PredictionQuestion" q WHERE q."predictionId" = NEW."predictionId";
  IF answer IN ('yes', 'no') THEN
    IF NEW."outcome" IS DISTINCT FROM (answer = 'yes') THEN
      RAISE EXCEPTION 'resolution of %: its outcome is not Will''s answer', pid USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  SELECT p."goalId" INTO goal FROM "Prediction" p WHERE p."id" = NEW."predictionId";
  IF goal IS NOT NULL THEN
    SELECT * INTO g FROM "Goal" WHERE "id" = goal;
    IF FOUND AND g."status" IN ('done', 'abandoned') AND g."approvalId" IS NOT NULL THEN
      -- Raises (42501) unless that card is Will's, for this goal, executing now, and used by this transaction alone.
      PERFORM p3_bind_approval(g."approvalId", g."id", CASE g."status" WHEN 'done' THEN 'goal.done' ELSE 'goal.abandon' END);
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'resolution of %: recorded as Will''s without his answer', pid USING ERRCODE = 'insufficient_privilege';
END;
$$;

-- A resolution's own rules (Resolution's CHECKs and NOT NULLs), checked first and
-- named by id: a forecast's resolution carries the number the series took, and a
-- refused CHECK would write it into the error's DETAIL. Fires after the leak
-- guard (which computes the Brier score) and before any constraint.
CREATE FUNCTION resolution_valid() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  pid text := CASE WHEN NEW."predictionId" ~ '^[A-Za-z0-9_-]{1,40}$' THEN NEW."predictionId" ELSE '?' END;
  bad text;
BEGIN
  bad := CASE
    WHEN NOT coalesce(NEW."id" ~ '^[A-Za-z0-9_-]{1,40}$', false) THEN 'id'
    WHEN NEW."predictionId" IS NULL OR NEW."eventAt" IS NULL OR NEW."resolvedAt" IS NULL THEN 'a required field'
    WHEN NOT coalesce(NEW."resolvedBy" IN ('auto_world', 'auto_metric', 'will'), false) THEN 'resolver'
    WHEN NEW."outcome" IS NULL AND NEW."outcomeValue" IS NULL THEN 'outcome'
    WHEN NOT coalesce(NEW."outcomeValue" IS NULL OR (NEW."outcomeValue" > '-Infinity'::float8 AND NEW."outcomeValue" < 'Infinity'::float8), false) THEN 'value'
    WHEN NOT coalesce(NEW."brier" IS NULL OR NEW."brier" BETWEEN 0 AND 1, false) THEN 'score'
    WHEN NOT coalesce(NEW."evidence" IS NULL OR octet_length(NEW."evidence"::text) <= 16384, false) THEN 'evidence'
  END;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'resolution of %: its % is not valid', pid, bad USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- ---- Triggers --------------------------------------------------------------------------------------
CREATE TRIGGER "MetricSeries_guard" BEFORE INSERT OR UPDATE ON "MetricSeries"
  FOR EACH ROW EXECUTE FUNCTION metric_series_guard();
CREATE TRIGGER "MetricPoint_valid" BEFORE INSERT OR UPDATE ON "MetricPoint"
  FOR EACH ROW EXECUTE FUNCTION metric_point_valid();

CREATE TRIGGER "ForecastSeries_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ForecastSeries"
  FOR EACH ROW EXECUTE FUNCTION forecast_series_guard();
CREATE TRIGGER "ForecastSeries_no_truncate" BEFORE TRUNCATE ON "ForecastSeries"
  FOR EACH STATEMENT EXECUTE FUNCTION forecast_series_guard();
-- AFTER triggers fire in name order too: the approval is bound, then the change is history.
CREATE TRIGGER "ForecastSeries_bind" AFTER INSERT OR UPDATE ON "ForecastSeries"
  FOR EACH ROW EXECUTE FUNCTION forecast_series_bind();
CREATE TRIGGER "ForecastSeries_history" AFTER INSERT OR UPDATE ON "ForecastSeries"
  FOR EACH ROW EXECUTE FUNCTION forecast_series_history();

-- BEFORE triggers fire in name order: the check (which stamps the time and reads
-- the series), then the row's own rules, and both before any constraint.
CREATE TRIGGER "ForecastRun_check" BEFORE INSERT ON "ForecastRun"
  FOR EACH ROW EXECUTE FUNCTION forecast_run_check();
CREATE TRIGGER "ForecastRun_valid" BEFORE INSERT ON "ForecastRun"
  FOR EACH ROW EXECUTE FUNCTION forecast_run_valid();
CREATE TRIGGER "ForecastRun_append_only" BEFORE UPDATE OR DELETE ON "ForecastRun"
  FOR EACH ROW EXECUTE FUNCTION guard_append_only();
CREATE TRIGGER "ForecastRun_no_truncate" BEFORE TRUNCATE ON "ForecastRun"
  FOR EACH STATEMENT EXECUTE FUNCTION guard_append_only();

-- Prediction_valid fires after P1's Prediction_insert_check (which stamps createdAt, used by the horizon rule).
CREATE TRIGGER "Prediction_valid" BEFORE INSERT ON "Prediction"
  FOR EACH ROW EXECUTE FUNCTION prediction_valid();
-- Named to fire after Prediction_valid: it reads the run only once the row itself is sound.
CREATE TRIGGER "Prediction_valid_forecast" BEFORE INSERT ON "Prediction"
  FOR EACH ROW WHEN (NEW."forecastRunId" IS NOT NULL) EXECUTE FUNCTION prediction_forecast_check();
-- After P1's Prediction_guard (name order), before any constraint.
CREATE TRIGGER "Prediction_valid_update" BEFORE UPDATE ON "Prediction"
  FOR EACH ROW EXECUTE FUNCTION prediction_update_valid();

CREATE TRIGGER "PredictionQuestion_guard" BEFORE INSERT OR UPDATE OR DELETE ON "PredictionQuestion"
  FOR EACH ROW EXECUTE FUNCTION prediction_question_guard();
CREATE TRIGGER "PredictionQuestion_no_truncate" BEFORE TRUNCATE ON "PredictionQuestion"
  FOR EACH STATEMENT EXECUTE FUNCTION prediction_question_guard();

-- Name order on Resolution: P1's Resolution_leak_guard, then Resolution_valid, then Resolution_will_check.
CREATE TRIGGER "Resolution_valid" BEFORE INSERT ON "Resolution"
  FOR EACH ROW EXECUTE FUNCTION resolution_valid();
CREATE TRIGGER "Resolution_will_check" BEFORE INSERT ON "Resolution"
  FOR EACH ROW WHEN (NEW."resolvedBy" = 'will') EXECUTE FUNCTION resolution_will_check();

-- What Will signs is what is stored, for the predictions card too: P3's digest check
-- (the card's digest is its args' digest, computed in SQL as digestOf computes it),
-- on a second trigger so P3's own stays as it is.
CREATE TRIGGER "Proposal_digest_check_forecast" BEFORE INSERT ON "Proposal"
  FOR EACH ROW WHEN (NEW."action" = 'forecast.series.enable') EXECUTE FUNCTION proposal_digest_check();

-- ---- P3's signed cards, with what the forecast card's helper learned ---------------------------------
-- Four hardenings, carried back to the goal and plan cards. CREATE OR REPLACE keeps
-- each function's owner, its grants and its REVOKE FROM PUBLIC; down.sql puts P3's own
-- bodies back to the letter.
--  1. The 7-day bound (p3_signed_proposal): a card expires no later than 7 days after
--     Will's approval of it does, so one filed with a far-off expiry cannot be signed
--     now and kept to move a goal months later.
--  2. Only from a trigger (p3_bind_approval): a call of its own is refused, so a
--     runtime cannot spend a card Will signed without making the change he signed.
--  3. Used when the change has landed (goal_entity_guard): a link's approval is bound
--     after the link is written or removed (GoalEntity_bind, an AFTER trigger running
--     the same checks), so an insert that meets a link already there and does nothing
--     spends nothing. goal_guard and plan_guard keep their bind where it is: both
--     guard an UPDATE, whose BEFORE trigger fires only for a row that is then
--     written (or the statement fails, and the use goes with it), so there the
--     approval is already used only by a change that lands.
--  4. Which transaction used it (p3_bind_approval): recorded as its id AND when it
--     began, as p4_bind_approval records it. A transaction id comes round again
--     after a restore into a new cluster, and a bare id would then let another
--     transaction pass for the one that used the card. A use recorded before this
--     (a bare id) never equals the new form, so it stays used.
CREATE OR REPLACE FUNCTION p3_signed_proposal(p_approval text, p_goal text, p_actions text[]) RETURNS "Proposal"
LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
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
       AND p."expiresAt" <= a."expiresAt" + interval '7 days'
       AND p."kind" = CASE WHEN p."action" = 'plan.change' THEN 'plan' ELSE 'goal' END
       AND a."payload"->>'action' = p."action" AND a."payload"->>'argsDigest' = p."argsDigest"
       AND jsonb_typeof(p."args") = 'object' AND p."args"->>'goalId' = p_goal, false) THEN
    RAISE EXCEPTION 'goal %: approval % is not for an executing % of this goal', p_goal, p_approval, array_to_string(p_actions, ' or ')
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN p;
END;
$$;

CREATE OR REPLACE FUNCTION p3_bind_approval(p_approval text, p_goal text, p_action text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  u "GoalApprovalUse"%ROWTYPE;
  -- This transaction, named as p4_bind_approval names it: its id, and when it began.
  me text := pg_current_xact_id()::text || '@' || (extract(epoch FROM transaction_timestamp()) * 1000000)::bigint::text;
BEGIN
  IF pg_trigger_depth() < 1 THEN
    RAISE EXCEPTION 'goal %: an approval is used only by the change it signed', left(p_goal, 40) USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM p3_signed_proposal(p_approval, p_goal, ARRAY[p_action]);
  INSERT INTO "GoalApprovalUse" ("approvalId", "goalId", "action", "xact")
  VALUES (p_approval, p_goal, p_action, me)
  ON CONFLICT ("approvalId") DO NOTHING;
  SELECT * INTO u FROM "GoalApprovalUse" WHERE "approvalId" = p_approval;
  IF NOT coalesce(u."xact" = me AND u."goalId" = p_goal AND u."action" = p_action, false) THEN
    RAISE EXCEPTION 'goal %: approval % was already used', p_goal, p_approval USING ERRCODE = 'insufficient_privilege';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION goal_entity_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
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
    IF TG_WHEN = 'BEFORE' THEN
      SELECT "version" INTO NEW."seenVersion" FROM "Entity" WHERE "id" = NEW."entityId" AND "status" <> 'forgotten';
      IF NOT FOUND THEN
        RAISE EXCEPTION 'goal %: item % is not there to link', NEW."goalId", NEW."entityId" USING ERRCODE = 'check_violation';
      END IF;
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
          -- This card's approval, in this transaction only, used once the link is written or removed (the AFTER
          -- trigger): an insert that meets a link already there and does nothing writes no row, and spends nothing.
          IF TG_WHEN = 'AFTER' THEN
            PERFORM p3_bind_approval(cand, r."goalId", p."action");
            RETURN NULL;
          END IF;
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
$$;

CREATE TRIGGER "GoalEntity_bind" AFTER INSERT OR DELETE ON "GoalEntity"
  FOR EACH ROW EXECUTE FUNCTION goal_entity_guard();

-- ---- The prediction queues (the closed set; nothing sends to them until predictions are on) ---------
--   forecast.series   keeps each day's numbers for the registered series
--   forecast.run      forecasts each number Will turned on
--   ledger.sweep      resolves what is due and expires what ran out
--   ledger.snapshot   scores the ledger
--   ledger.ask        picks Will's questions for the day
--   forecast.reason   the local model's estimate for one run (stately per series)
SELECT pgboss.create_queue(q, '{"policy":"singleton","retryLimit":2,"retryDelay":60,"expireInSeconds":900,"deadLetter":"dead"}'::jsonb)
  FROM unnest(ARRAY['forecast.series', 'forecast.run', 'ledger.sweep', 'ledger.snapshot', 'ledger.ask']) AS q;
SELECT pgboss.create_queue('forecast.reason', '{"policy":"stately","retryLimit":2,"retryDelay":60,"expireInSeconds":900,"deadLetter":"dead"}'::jsonb);

-- ---- Grants ------------------------------------------------------------------------------------------------
-- flint_app records runs (never changes one), flips the switches the guard lets
-- it, and writes a question's answer; it deletes nothing here. The two helpers
-- run inside trigger bodies as flint_app, so it may execute them: one only reads,
-- and p4_bind_approval writes only ForecastApprovalUse, on which flint_app has no
-- grant at all. flint_approver gets nothing.
REVOKE ALL ON FUNCTION p4_signed_proposal(text, text), p4_bind_approval(text, text), metric_series_guard(), metric_point_valid(),
  forecast_series_guard(), forecast_series_bind(), forecast_series_history(), forecast_run_check(), forecast_run_valid(),
  prediction_forecast_check(), prediction_valid(), prediction_update_valid(), prediction_question_guard(), resolution_will_check(),
  resolution_valid() FROM PUBLIC;
REVOKE ALL ON "ForecastRun", "ForecastSeries", "PredictionQuestion", "ForecastApprovalUse" FROM PUBLIC;
GRANT EXECUTE ON FUNCTION p4_signed_proposal(text, text), p4_bind_approval(text, text) TO flint_app;

GRANT SELECT, INSERT ON "ForecastRun" TO flint_app;
-- enabledAt is the database's to stamp (forecast_series_guard, on each signed change): the runtime never updates it.
GRANT SELECT, INSERT, UPDATE ("on", "reason", "approvalId", "updatedAt") ON "ForecastSeries" TO flint_app;
GRANT SELECT, INSERT, UPDATE ("answer", "answeredAt") ON "PredictionQuestion" TO flint_app;
