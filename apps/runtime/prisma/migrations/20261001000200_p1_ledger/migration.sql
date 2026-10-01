-- p1_ledger (Machine plan P1, "Migration p1_ledger").
-- Generated tables first, then the hand-written CHECKs, guards and grants.
-- Reversed by down.sql in this directory.

-- CreateTable
CREATE TABLE "Prediction" (
    "id" TEXT NOT NULL,
    "claim" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'binary',
    "probability" DOUBLE PRECISION,
    "method" TEXT NOT NULL,
    "model" TEXT,
    "modelConfig" JSONB,
    "domain" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "resolutionCriteria" TEXT NOT NULL,
    "resolver" TEXT NOT NULL,
    "resolverSpec" JSONB,
    "conditionRecommendationId" TEXT,
    "resolveBy" TIMESTAMPTZ(3) NOT NULL,
    "subjectEntityId" TEXT,
    "supersedesId" TEXT,
    "supersededAt" TIMESTAMPTZ(3),
    "lateSupersession" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'open',
    "voidApprovalId" TEXT,
    "tainted" BOOLEAN NOT NULL DEFAULT false,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Prediction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Resolution" (
    "id" TEXT NOT NULL,
    "predictionId" TEXT NOT NULL,
    "outcome" BOOLEAN,
    "outcomeValue" DOUBLE PRECISION,
    "eventAt" TIMESTAMPTZ(3) NOT NULL,
    "resolvedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedBy" TEXT NOT NULL,
    "evidence" JSONB,
    "brier" DOUBLE PRECISION,

    CONSTRAINT "Resolution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResolutionCorrection" (
    "id" TEXT NOT NULL,
    "resolutionId" TEXT NOT NULL,
    "outcome" BOOLEAN,
    "outcomeValue" DOUBLE PRECISION,
    "reason" TEXT NOT NULL,
    "approvalId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResolutionCorrection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Recommendation" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "domain" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "text" TEXT,
    "rationale" TEXT,
    "expectedEffect" TEXT,
    "predictionId" TEXT NOT NULL,
    "proposalId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "decidedAt" TIMESTAMPTZ(3),
    "approvalId" TEXT,
    "effectObserved" BOOLEAN,
    "outcomeAt" TIMESTAMPTZ(3),
    "outcomeNote" TEXT,
    "tainted" BOOLEAN NOT NULL DEFAULT false,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Recommendation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CalibrationSnapshot" (
    "id" TEXT NOT NULL,
    "computedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "windowStart" TIMESTAMPTZ(3) NOT NULL,
    "windowEnd" TIMESTAMPTZ(3) NOT NULL,
    "domain" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "n" INTEGER NOT NULL,
    "nOpen" INTEGER NOT NULL,
    "nExpired" INTEGER NOT NULL,
    "nConditionUnmet" INTEGER NOT NULL,
    "nVoid" INTEGER NOT NULL,
    "nLateSuperseded" INTEGER NOT NULL,
    "brier" DOUBLE PRECISION NOT NULL,
    "baseRate" DOUBLE PRECISION NOT NULL,
    "brierSkill" DOUBLE PRECISION,
    "reliability" JSONB NOT NULL,
    "unresolvedRate" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "CalibrationSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Prediction_supersedesId_key" ON "Prediction"("supersedesId");

-- CreateIndex
CREATE INDEX "Prediction_status_resolveBy_idx" ON "Prediction"("status", "resolveBy");

-- CreateIndex
CREATE INDEX "Prediction_domain_type_createdAt_idx" ON "Prediction"("domain", "type", "createdAt");

-- CreateIndex
CREATE INDEX "Prediction_subjectEntityId_idx" ON "Prediction"("subjectEntityId");

-- CreateIndex
CREATE UNIQUE INDEX "Resolution_predictionId_key" ON "Resolution"("predictionId");

-- CreateIndex
CREATE UNIQUE INDEX "Recommendation_predictionId_key" ON "Recommendation"("predictionId");

-- CreateIndex
CREATE UNIQUE INDEX "Recommendation_proposalId_key" ON "Recommendation"("proposalId");

-- CreateIndex
CREATE INDEX "Recommendation_domain_status_createdAt_idx" ON "Recommendation"("domain", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CalibrationSnapshot_windowEnd_domain_type_method_key" ON "CalibrationSnapshot"("windowEnd", "domain", "type", "method");

-- AddForeignKey
ALTER TABLE "Prediction" ADD CONSTRAINT "Prediction_subjectEntityId_fkey" FOREIGN KEY ("subjectEntityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Prediction" ADD CONSTRAINT "Prediction_supersedesId_fkey" FOREIGN KEY ("supersedesId") REFERENCES "Prediction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Resolution" ADD CONSTRAINT "Resolution_predictionId_fkey" FOREIGN KEY ("predictionId") REFERENCES "Prediction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResolutionCorrection" ADD CONSTRAINT "ResolutionCorrection_resolutionId_fkey" FOREIGN KEY ("resolutionId") REFERENCES "Resolution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Recommendation" ADD CONSTRAINT "Recommendation_predictionId_fkey" FOREIGN KEY ("predictionId") REFERENCES "Prediction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===========================================================================
-- Hand-written below this line.
-- ===========================================================================

-- ---- CHECKs -------------------------------------------------------------------
ALTER TABLE "Prediction"
  ADD CONSTRAINT "Prediction_kind_check" CHECK ("kind" IN ('binary', 'interval')),
  ADD CONSTRAINT "Prediction_method_check" CHECK ("method" IN ('model_reasoning', 'prophet', 'rule', 'base_rate', 'human')),
  ADD CONSTRAINT "Prediction_domain_check" CHECK ("domain" IN ('services', 'deploys', 'spend', 'repos', 'projects', 'calendar', 'goals', 'assets', 'selfmod', 'triage', 'recommendation')),
  ADD CONSTRAINT "Prediction_type_check" CHECK ("type" IN ('event_occurs', 'deadline_met', 'threshold_cross', 'trend', 'relevance', 'task_meets_bar', 'effect_given_accept')),
  ADD CONSTRAINT "Prediction_resolver_check" CHECK ("resolver" IN ('auto_world', 'auto_metric', 'will', 'conditional')),
  ADD CONSTRAINT "Prediction_status_check" CHECK ("status" IN ('open', 'resolved', 'expired', 'superseded', 'condition_unmet', 'void')),
  -- Flint never claims certainty: only Will's own predictions may go below 5% or above 95%.
  ADD CONSTRAINT "Prediction_probability_check" CHECK (
    "probability" IS NULL OR "probability" BETWEEN 0 AND 1 AND ("method" = 'human' OR "probability" BETWEEN 0.05 AND 0.95)
  ),
  ADD CONSTRAINT "Prediction_binary_check" CHECK ("kind" <> 'binary' OR "probability" IS NOT NULL),
  ADD CONSTRAINT "Prediction_claim_check" CHECK (char_length("claim") BETWEEN 1 AND 300),
  ADD CONSTRAINT "Prediction_criteria_check" CHECK (char_length("resolutionCriteria") BETWEEN 1 AND 1000),
  ADD CONSTRAINT "Prediction_evidence_check" CHECK (jsonb_typeof("evidence") = 'array' AND octet_length("evidence"::text) <= 16384),
  ADD CONSTRAINT "Prediction_horizon_check" CHECK ("resolveBy" > "createdAt" AND "resolveBy" <= "createdAt" + interval '180 days'),
  ADD CONSTRAINT "Prediction_conditional_check" CHECK (("resolver" = 'conditional') = ("conditionRecommendationId" IS NOT NULL)),
  ADD CONSTRAINT "Prediction_not_self_check" CHECK ("supersedesId" IS NULL OR "supersedesId" <> "id");

ALTER TABLE "Resolution"
  ADD CONSTRAINT "Resolution_resolvedBy_check" CHECK ("resolvedBy" IN ('auto_world', 'auto_metric', 'will')),
  ADD CONSTRAINT "Resolution_outcome_check" CHECK ("outcome" IS NOT NULL OR "outcomeValue" IS NOT NULL),
  ADD CONSTRAINT "Resolution_brier_check" CHECK ("brier" IS NULL OR "brier" BETWEEN 0 AND 1),
  ADD CONSTRAINT "Resolution_evidence_check" CHECK ("evidence" IS NULL OR octet_length("evidence"::text) <= 16384);

ALTER TABLE "ResolutionCorrection"
  ADD CONSTRAINT "ResolutionCorrection_outcome_check" CHECK ("outcome" IS NOT NULL OR "outcomeValue" IS NOT NULL),
  ADD CONSTRAINT "ResolutionCorrection_reason_check" CHECK (char_length("reason") BETWEEN 1 AND 500);

ALTER TABLE "Recommendation"
  ADD CONSTRAINT "Recommendation_type_check" CHECK ("type" IN ('tool_call', 'goal', 'plan_change', 'task_dispatch', 'pr', 'escalation_action')),
  ADD CONSTRAINT "Recommendation_status_check" CHECK ("status" IN ('proposed', 'accepted', 'rejected', 'expired', 'superseded')),
  ADD CONSTRAINT "Recommendation_text_check" CHECK ("text" IS NULL OR char_length("text") <= 1000),
  ADD CONSTRAINT "Recommendation_rationale_check" CHECK ("rationale" IS NULL OR char_length("rationale") <= 300),
  ADD CONSTRAINT "Recommendation_effect_check" CHECK ("expectedEffect" IS NULL OR char_length("expectedEffect") <= 300),
  ADD CONSTRAINT "Recommendation_note_check" CHECK ("outcomeNote" IS NULL OR char_length("outcomeNote") <= 300),
  ADD CONSTRAINT "Recommendation_params_check" CHECK (jsonb_typeof("params") = 'object' AND octet_length("params"::text) <= 16384);

ALTER TABLE "CalibrationSnapshot"
  ADD CONSTRAINT "CalibrationSnapshot_counts_check" CHECK ("n" >= 0 AND "nOpen" >= 0 AND "nExpired" >= 0 AND "nConditionUnmet" >= 0 AND "nVoid" >= 0 AND "nLateSuperseded" >= 0),
  ADD CONSTRAINT "CalibrationSnapshot_brier_check" CHECK ("brier" BETWEEN 0 AND 1 AND "baseRate" BETWEEN 0 AND 1),
  ADD CONSTRAINT "CalibrationSnapshot_rate_check" CHECK ("unresolvedRate" BETWEEN 0 AND 1),
  ADD CONSTRAINT "CalibrationSnapshot_window_check" CHECK ("windowEnd" > "windowStart"),
  ADD CONSTRAINT "CalibrationSnapshot_reliability_check" CHECK (jsonb_typeof("reliability") = 'array');

-- ---- Predictions ----------------------------------------------------------------
-- A prediction is made now (createdAt cannot be backdated past its own event)
-- and starts open.
CREATE FUNCTION prediction_insert_check() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  -- The wall clock, not the transaction start: a transaction held open must not
  -- backdate a prediction past the events it is about.
  NEW."createdAt" := clock_timestamp();
  IF NEW."status" <> 'open' OR NEW."supersededAt" IS NOT NULL OR NEW."voidApprovalId" IS NOT NULL OR NEW."lateSupersession" THEN
    RAISE EXCEPTION 'a prediction starts open';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Prediction_insert_check" BEFORE INSERT ON "Prediction"
  FOR EACH ROW EXECUTE FUNCTION prediction_insert_check();

-- Making a prediction that supersedes another closes the old one, and flags it
-- when that happens late: within 48 hours of its resolveBy, or in the last 10%
-- of its horizon (a forecaster who revises only at the end gets no credit).
CREATE FUNCTION prediction_supersede() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  old "Prediction"%ROWTYPE;
BEGIN
  SELECT * INTO old FROM "Prediction" WHERE "id" = NEW."supersedesId" FOR UPDATE;
  IF NOT FOUND OR old."status" <> 'open' THEN
    RAISE EXCEPTION 'prediction %: only an open prediction can be superseded', NEW."supersedesId";
  END IF;
  UPDATE "Prediction" SET
    "status" = 'superseded',
    "supersededAt" = NEW."createdAt",
    "lateSupersession" = (old."resolveBy" - NEW."createdAt" < interval '48 hours'
                          OR NEW."createdAt" >= old."createdAt" + (old."resolveBy" - old."createdAt") * 0.9)
  WHERE "id" = old."id";
  RETURN NULL;
END;
$$;
CREATE TRIGGER "Prediction_supersede" AFTER INSERT ON "Prediction"
  FOR EACH ROW WHEN (NEW."supersedesId" IS NOT NULL) EXECUTE FUNCTION prediction_supersede();

-- Only status, supersededAt, lateSupersession and voidApprovalId ever change,
-- the last three once; voiding needs Will's approval. A forget may replace the
-- words, never the numbers.
CREATE FUNCTION prediction_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  forgetting boolean := current_user = 'flint_owner' AND coalesce(current_setting('flint.forget_approval', true), '') <> '';
  mutable text[] := ARRAY['status', 'supersededAt', 'lateSupersession', 'voidApprovalId'];
  words text[] := ARRAY['claim', 'evidence', 'resolutionCriteria', 'resolverSpec', 'modelConfig'];
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'predictions are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF forgetting AND (to_jsonb(NEW) - words) = (to_jsonb(OLD) - words) THEN
    IF NEW."claim" <> '[forgotten]' OR NEW."evidence" <> '[]'::jsonb OR NEW."resolutionCriteria" <> '[forgotten]'
       OR NEW."resolverSpec" IS NOT NULL OR NEW."modelConfig" IS NOT NULL THEN
      RAISE EXCEPTION 'prediction %: a forget only blanks the words', OLD."id";
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - mutable) IS DISTINCT FROM (to_jsonb(OLD) - mutable) THEN
    RAISE EXCEPTION 'prediction %: a prediction is never edited (supersede it instead)', OLD."id" USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (OLD."supersededAt" IS NOT NULL AND NEW."supersededAt" IS DISTINCT FROM OLD."supersededAt")
     OR (OLD."voidApprovalId" IS NOT NULL AND NEW."voidApprovalId" IS DISTINCT FROM OLD."voidApprovalId")
     OR (OLD."lateSupersession" AND NOT NEW."lateSupersession") THEN
    RAISE EXCEPTION 'prediction %: supersededAt, lateSupersession and voidApprovalId are set once', OLD."id";
  END IF;
  IF NEW."status" = OLD."status" THEN
    IF NEW."supersededAt" IS DISTINCT FROM OLD."supersededAt" OR NEW."voidApprovalId" IS DISTINCT FROM OLD."voidApprovalId"
       OR NEW."lateSupersession" <> OLD."lateSupersession" THEN
      RAISE EXCEPTION 'prediction %: these change only with the status', OLD."id";
    END IF;
    RETURN NEW;
  END IF;

  IF NOT ((OLD."status" = 'open' AND NEW."status" IN ('resolved', 'expired', 'superseded', 'condition_unmet', 'void'))
       OR (OLD."status" IN ('resolved', 'expired', 'superseded', 'condition_unmet') AND NEW."status" = 'void')) THEN
    RAISE EXCEPTION 'prediction %: % -> % is not allowed', OLD."id", OLD."status", NEW."status" USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."supersededAt" IS DISTINCT FROM OLD."supersededAt" AND NEW."status" <> 'superseded'
     OR NEW."lateSupersession" <> OLD."lateSupersession" AND NEW."status" <> 'superseded'
     OR NEW."voidApprovalId" IS DISTINCT FROM OLD."voidApprovalId" AND NEW."status" <> 'void' THEN
    RAISE EXCEPTION 'prediction %: field set without its transition', OLD."id";
  END IF;

  CASE NEW."status"
    WHEN 'resolved' THEN
      IF NOT EXISTS (SELECT 1 FROM "Resolution" r WHERE r."predictionId" = OLD."id") THEN
        RAISE EXCEPTION 'prediction %: resolved only by recording a Resolution', OLD."id";
      END IF;
    WHEN 'expired' THEN
      IF now() <= OLD."resolveBy" OR EXISTS (SELECT 1 FROM "Resolution" r WHERE r."predictionId" = OLD."id") THEN
        RAISE EXCEPTION 'prediction %: expires only unresolved and past resolveBy', OLD."id";
      END IF;
    WHEN 'superseded' THEN
      IF NEW."supersededAt" IS NULL OR NOT EXISTS (SELECT 1 FROM "Prediction" p WHERE p."supersedesId" = OLD."id") THEN
        RAISE EXCEPTION 'prediction %: superseded only by a newer prediction', OLD."id";
      END IF;
    WHEN 'condition_unmet' THEN
      IF NOT EXISTS (SELECT 1 FROM "Recommendation" r WHERE r."id" = OLD."conditionRecommendationId" AND r."status" IN ('rejected', 'expired')) THEN
        RAISE EXCEPTION 'prediction %: its recommendation was not rejected or expired', OLD."id";
      END IF;
    WHEN 'void' THEN
      IF NEW."voidApprovalId" IS NULL THEN
        RAISE EXCEPTION 'prediction %: voiding needs Will''s approval', OLD."id" USING ERRCODE = 'insufficient_privilege';
      END IF;
      PERFORM consume_approval(NEW."voidApprovalId", 'void', OLD."id", 'approve', 'ledger.void', NULL);
  END CASE;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Prediction_guard" BEFORE UPDATE OR DELETE ON "Prediction"
  FOR EACH ROW EXECUTE FUNCTION prediction_guard();
CREATE TRIGGER "Prediction_no_truncate" BEFORE TRUNCATE ON "Prediction"
  FOR EACH STATEMENT EXECUTE FUNCTION prediction_guard();

-- ---- Resolutions --------------------------------------------------------------------
-- No leakage: the event must happen after the prediction was made and before it
-- is recorded. Binary predictions get their Brier score here, so it cannot
-- disagree with the probability. A superseded prediction is still scored.
CREATE FUNCTION resolution_leak_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  p "Prediction"%ROWTYPE;
BEGIN
  SELECT * INTO p FROM "Prediction" WHERE "id" = NEW."predictionId" FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'resolution: no prediction %', NEW."predictionId";
  END IF;
  NEW."resolvedAt" := clock_timestamp();
  IF NEW."eventAt" < p."createdAt" THEN
    RAISE EXCEPTION 'resolution %: the event (%) precedes the prediction (%), which would leak', p."id", NEW."eventAt", p."createdAt"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."eventAt" > NEW."resolvedAt" THEN
    RAISE EXCEPTION 'resolution %: the event is in the future', p."id" USING ERRCODE = 'check_violation';
  END IF;
  IF p."status" NOT IN ('open', 'superseded') THEN
    RAISE EXCEPTION 'resolution %: a % prediction is not resolved', p."id", p."status";
  END IF;
  IF p."resolver" = 'will' AND NEW."resolvedBy" <> 'will' THEN
    RAISE EXCEPTION 'resolution %: only Will resolves this one', p."id";
  END IF;
  IF p."kind" = 'binary' THEN
    IF NEW."outcome" IS NULL THEN
      RAISE EXCEPTION 'resolution %: a binary prediction needs a true/false outcome', p."id";
    END IF;
    NEW."brier" := power(p."probability" - CASE WHEN NEW."outcome" THEN 1 ELSE 0 END, 2);
  ELSE
    IF NEW."outcomeValue" IS NULL THEN
      RAISE EXCEPTION 'resolution %: an interval prediction needs a value', p."id";
    END IF;
    NEW."brier" := NULL;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Resolution_leak_guard" BEFORE INSERT ON "Resolution"
  FOR EACH ROW EXECUTE FUNCTION resolution_leak_guard();

CREATE FUNCTION resolution_close_prediction() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE "Prediction" SET "status" = 'resolved' WHERE "id" = NEW."predictionId" AND "status" = 'open';
  RETURN NULL;
END;
$$;
CREATE TRIGGER "Resolution_close_prediction" AFTER INSERT ON "Resolution"
  FOR EACH ROW EXECUTE FUNCTION resolution_close_prediction();

CREATE TRIGGER "Resolution_append_only" BEFORE UPDATE OR DELETE ON "Resolution"
  FOR EACH ROW EXECUTE FUNCTION guard_append_only('evidence');
CREATE TRIGGER "Resolution_no_truncate" BEFORE TRUNCATE ON "Resolution"
  FOR EACH STATEMENT EXECUTE FUNCTION guard_append_only();

-- A correction is an approved, append-only note against a resolution.
-- Will signs the corrected outcome itself (payload.fields.outcome, outcomeValue
-- and reason), so an approval for one correction cannot carry another.
CREATE FUNCTION resolution_correction_check() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  f jsonb;
BEGIN
  NEW."createdAt" := clock_timestamp();
  SELECT a."payload"->'fields' INTO f FROM "Approval" a WHERE a."id" = NEW."approvalId";
  IF f IS NULL
     OR coalesce(f->'outcome', 'null'::jsonb) IS DISTINCT FROM coalesce(to_jsonb(NEW."outcome"), 'null'::jsonb)
     OR coalesce(f->'outcomeValue', 'null'::jsonb) IS DISTINCT FROM coalesce(to_jsonb(NEW."outcomeValue"), 'null'::jsonb)
     OR f->>'reason' IS DISTINCT FROM NEW."reason" THEN
    RAISE EXCEPTION 'correction: the approval was signed for a different correction' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM consume_approval(NEW."approvalId", 'correction', NEW."resolutionId", 'approve', 'ledger.resolution.correct', NULL);
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ResolutionCorrection_approval" BEFORE INSERT ON "ResolutionCorrection"
  FOR EACH ROW EXECUTE FUNCTION resolution_correction_check();
CREATE TRIGGER "ResolutionCorrection_append_only" BEFORE UPDATE OR DELETE ON "ResolutionCorrection"
  FOR EACH ROW EXECUTE FUNCTION guard_append_only('reason');
CREATE TRIGGER "ResolutionCorrection_no_truncate" BEFORE TRUNCATE ON "ResolutionCorrection"
  FOR EACH STATEMENT EXECUTE FUNCTION guard_append_only();

-- ---- Recommendations ----------------------------------------------------------------
-- What was recommended never changes. It is decided once; its outcome is
-- recorded once; its words may be cleared (retention, forget), never rewritten.
CREATE FUNCTION recommendation_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  fixed text[] := ARRAY['id', 'templateId', 'params', 'domain', 'type', 'predictionId', 'tainted', 'createdBy', 'createdAt'];
  k text;
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'recommendations are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  FOREACH k IN ARRAY fixed LOOP
    IF (to_jsonb(NEW) -> k) IS DISTINCT FROM (to_jsonb(OLD) -> k) THEN
      RAISE EXCEPTION 'recommendation %: % never changes', OLD."id", k USING ERRCODE = 'insufficient_privilege';
    END IF;
  END LOOP;
  FOREACH k IN ARRAY ARRAY['text', 'rationale', 'expectedEffect'] LOOP
    IF (to_jsonb(NEW) -> k) IS DISTINCT FROM (to_jsonb(OLD) -> k) AND (to_jsonb(NEW) -> k) <> 'null'::jsonb THEN
      RAISE EXCEPTION 'recommendation %: % may only be cleared', OLD."id", k;
    END IF;
  END LOOP;
  FOREACH k IN ARRAY ARRAY['proposalId', 'decidedAt', 'approvalId', 'effectObserved', 'outcomeAt'] LOOP
    IF (to_jsonb(OLD) -> k) <> 'null'::jsonb AND (to_jsonb(NEW) -> k) IS DISTINCT FROM (to_jsonb(OLD) -> k) THEN
      RAISE EXCEPTION 'recommendation %: % is set once', OLD."id", k;
    END IF;
  END LOOP;
  IF OLD."outcomeNote" IS NOT NULL AND NEW."outcomeNote" IS NOT NULL AND NEW."outcomeNote" <> OLD."outcomeNote" THEN
    RAISE EXCEPTION 'recommendation %: the outcome note may only be cleared', OLD."id";
  END IF;
  IF NEW."status" <> OLD."status" THEN
    IF OLD."status" <> 'proposed' THEN
      RAISE EXCEPTION 'recommendation %: it was already %', OLD."id", OLD."status";
    END IF;
    IF NEW."decidedAt" IS NULL THEN
      RAISE EXCEPTION 'recommendation %: a decision needs decidedAt', OLD."id";
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Recommendation_guard" BEFORE UPDATE OR DELETE ON "Recommendation"
  FOR EACH ROW EXECUTE FUNCTION recommendation_guard();
CREATE TRIGGER "Recommendation_no_truncate" BEFORE TRUNCATE ON "Recommendation"
  FOR EACH STATEMENT EXECUTE FUNCTION recommendation_guard();

-- ---- Grants ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION prediction_insert_check(), prediction_supersede(), prediction_guard(), resolution_leak_guard(),
  resolution_close_prediction(), resolution_correction_check(), recommendation_guard() FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE ON "Prediction", "Recommendation", "CalibrationSnapshot" TO flint_app;
GRANT SELECT, INSERT ON "Resolution", "ResolutionCorrection" TO flint_app;
