-- p2_runtime (Machine plan P2): triage, surfacing, runtime health and the job queue.
-- Tables first, then the hand-written CHECKs, guards and grants, then pg-boss's
-- own schema. P1 data is untouched. Reversed by down.sql in this directory.

-- CreateTable
CREATE TABLE "TriageRule" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "predicate" JSONB NOT NULL,
    "action" TEXT NOT NULL,
    "lane" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "perSenderDailyCap" INTEGER,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT NOT NULL,
    "approvalId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TriageRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TriageDecision" (
    "id" TEXT NOT NULL,
    "sourceEventId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "lane" TEXT NOT NULL,
    "relevance" DOUBLE PRECISION,
    "reasonCode" TEXT,
    "ruleName" TEXT,
    "decidedBy" TEXT NOT NULL,
    "critical" BOOLEAN NOT NULL DEFAULT false,
    "shadow" BOOLEAN NOT NULL DEFAULT true,
    "reasoning" TEXT,
    "modelMs" INTEGER,
    "relevancePredictionId" TEXT,
    "feedback" TEXT,
    "feedbackAt" TIMESTAMPTZ(3),
    "tainted" BOOLEAN NOT NULL DEFAULT false,
    "sensitivity" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TriageDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Escalation" (
    "id" TEXT NOT NULL,
    "triageDecisionId" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "fields" JSONB NOT NULL,
    "title" TEXT,
    "body" TEXT,
    "predictionId" TEXT,
    "recommendationId" TEXT,
    "channels" TEXT[],
    "status" TEXT NOT NULL DEFAULT 'open',
    "actedAuditId" TEXT,
    "useful" BOOLEAN,
    "tainted" BOOLEAN NOT NULL DEFAULT false,
    "sensitivity" TEXT NOT NULL,
    "contentPurgedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ackedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Escalation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EscalationDelivery" (
    "id" TEXT NOT NULL,
    "escalationId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "sentAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EscalationDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RuntimeInstance" (
    "id" TEXT NOT NULL,
    "gitSha" TEXT NOT NULL,
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastBeatAt" TIMESTAMPTZ(3) NOT NULL,
    "stoppedAt" TIMESTAMPTZ(3),
    "stopReason" TEXT,

    CONSTRAINT "RuntimeInstance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HealthCheck" (
    "id" TEXT NOT NULL,
    "component" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "detail" TEXT,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HealthCheck_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TriageRule_name_key" ON "TriageRule"("name");

-- CreateIndex
CREATE UNIQUE INDEX "TriageDecision_sourceEventId_key" ON "TriageDecision"("sourceEventId");

-- CreateIndex
CREATE UNIQUE INDEX "TriageDecision_relevancePredictionId_key" ON "TriageDecision"("relevancePredictionId");

-- CreateIndex
CREATE INDEX "TriageDecision_lane_createdAt_idx" ON "TriageDecision"("lane", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Escalation_triageDecisionId_key" ON "Escalation"("triageDecisionId");

-- CreateIndex
CREATE INDEX "Escalation_status_createdAt_idx" ON "Escalation"("status", "createdAt");

-- CreateIndex
CREATE INDEX "EscalationDelivery_status_createdAt_idx" ON "EscalationDelivery"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "EscalationDelivery_escalationId_channel_key" ON "EscalationDelivery"("escalationId", "channel");

-- CreateIndex
CREATE INDEX "RuntimeInstance_lastBeatAt_idx" ON "RuntimeInstance"("lastBeatAt");

-- CreateIndex
CREATE INDEX "HealthCheck_component_at_idx" ON "HealthCheck"("component", "at");

-- AddForeignKey
ALTER TABLE "TriageDecision" ADD CONSTRAINT "TriageDecision_sourceEventId_fkey" FOREIGN KEY ("sourceEventId") REFERENCES "SourceEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Escalation" ADD CONSTRAINT "Escalation_triageDecisionId_fkey" FOREIGN KEY ("triageDecisionId") REFERENCES "TriageDecision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EscalationDelivery" ADD CONSTRAINT "EscalationDelivery_escalationId_fkey" FOREIGN KEY ("escalationId") REFERENCES "Escalation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===========================================================================
-- Hand-written below this line. Every RAISE names its SQLSTATE: 23514
-- (check_violation) refuses what the caller sent, and the API answers 4xx;
-- 42501 (insufficient_privilege) is a rule no caller may break.
-- ===========================================================================

ALTER TABLE "TriageRule"
  ADD CONSTRAINT "TriageRule_action_check" CHECK ("action" IN ('ignore', 'log', 'act', 'escalate')),
  ADD CONSTRAINT "TriageRule_lane_check" CHECK ("lane" IN ('quiet', 'relevant')),
  ADD CONSTRAINT "TriageRule_lane_action_check" CHECK (("action" <> 'escalate' OR "lane" = 'relevant') AND ("action" <> 'ignore' OR "lane" = 'quiet')),
  ADD CONSTRAINT "TriageRule_createdBy_check" CHECK ("createdBy" IN ('will', 'flint')),
  ADD CONSTRAINT "TriageRule_predicate_check" CHECK (jsonb_typeof("predicate") = 'object' AND octet_length("predicate"::text) <= 4096),
  ADD CONSTRAINT "TriageRule_name_check" CHECK ("name" ~ '^[a-z0-9_.-]{1,80}$'),
  ADD CONSTRAINT "TriageRule_source_check" CHECK ("source" ~ '^[a-z_]{1,40}$'),
  ADD CONSTRAINT "TriageRule_eventType_check" CHECK ("eventType" ~ '^(\*|[a-z_]{1,40}(\.[a-z0-9_]{1,40}){0,3})$'),
  ADD CONSTRAINT "TriageRule_priority_check" CHECK ("priority" BETWEEN 0 AND 1000),
  ADD CONSTRAINT "TriageRule_perSender_check" CHECK ("perSenderDailyCap" IS NULL OR "perSenderDailyCap" >= 1);

ALTER TABLE "TriageDecision"
  ADD CONSTRAINT "TriageDecision_action_check" CHECK ("action" IN ('ignore', 'log', 'act', 'escalate')),
  ADD CONSTRAINT "TriageDecision_lane_check" CHECK ("lane" IN ('quiet', 'relevant')),
  ADD CONSTRAINT "TriageDecision_decidedBy_check" CHECK ("decidedBy" ~ '^(code:[a-z0-9_.]{1,60}|rule:[a-z0-9_.-]{1,80}|model:ollama:[A-Za-z0-9._:/-]{1,80}|fallback:(invalid|unavailable|capped|deferred|skipped|backfill)|default)$'),
  ADD CONSTRAINT "TriageDecision_reasonCode_check" CHECK ("reasonCode" IS NULL OR "reasonCode" IN ('needs_will', 'deadline', 'security', 'money', 'failure', 'fyi', 'routine', 'noise')),
  ADD CONSTRAINT "TriageDecision_ruleName_check" CHECK ("ruleName" IS NULL OR "ruleName" ~ '^[a-z0-9_.-]{1,120}$'),
  ADD CONSTRAINT "TriageDecision_feedback_check" CHECK ("feedback" IS NULL OR "feedback" IN ('should_escalate', 'should_be_quiet', 'ok')),
  ADD CONSTRAINT "TriageDecision_reasoning_check" CHECK ("reasoning" IS NULL OR char_length("reasoning") <= 500),
  ADD CONSTRAINT "TriageDecision_relevance_check" CHECK ("relevance" IS NULL OR "relevance" BETWEEN 0 AND 1),
  ADD CONSTRAINT "TriageDecision_modelMs_check" CHECK ("modelMs" IS NULL OR "modelMs" >= 0),
  ADD CONSTRAINT "TriageDecision_sensitivity_check" CHECK ("sensitivity" IN ('ops', 'personal', 'financial'));

ALTER TABLE "Escalation"
  ADD CONSTRAINT "Escalation_status_check" CHECK ("status" IN ('open', 'acked', 'dismissed', 'acted', 'expired')),
  ADD CONSTRAINT "Escalation_templateId_check" CHECK ("templateId" ~ '^[a-z_]{1,40}$'),
  ADD CONSTRAINT "Escalation_title_check" CHECK ("title" IS NULL OR char_length("title") BETWEEN 1 AND 80),
  ADD CONSTRAINT "Escalation_body_check" CHECK ("body" IS NULL OR char_length("body") <= 500),
  ADD CONSTRAINT "Escalation_channels_check" CHECK ("channels" <@ ARRAY['inapp', 'banner', 'push']::text[]),
  ADD CONSTRAINT "Escalation_fields_check" CHECK (jsonb_typeof("fields") = 'object' AND octet_length("fields"::text) <= 4096),
  ADD CONSTRAINT "Escalation_sensitivity_check" CHECK ("sensitivity" IN ('ops', 'personal', 'financial'));

ALTER TABLE "EscalationDelivery"
  ADD CONSTRAINT "EscalationDelivery_channel_check" CHECK ("channel" IN ('inapp', 'banner', 'push')),
  ADD CONSTRAINT "EscalationDelivery_status_check" CHECK ("status" IN ('pending', 'sent', 'failed', 'held')),
  ADD CONSTRAINT "EscalationDelivery_attempts_check" CHECK ("attempts" >= 0),
  ADD CONSTRAINT "EscalationDelivery_lastError_check" CHECK ("lastError" IS NULL OR char_length("lastError") <= 200);

ALTER TABLE "HealthCheck"
  ADD CONSTRAINT "HealthCheck_status_check" CHECK ("status" IN ('ok', 'degraded', 'down', 'unknown', 'disabled')),
  ADD CONSTRAINT "HealthCheck_detail_check" CHECK ("detail" IS NULL OR char_length("detail") <= 300),
  ADD CONSTRAINT "HealthCheck_component_check" CHECK ("component" ~ '^[a-z0-9_.:-]{1,80}$');

ALTER TABLE "RuntimeInstance"
  ADD CONSTRAINT "RuntimeInstance_sha_check" CHECK ("gitSha" ~ '^([0-9a-f]{7,40}|dev)$'),
  ADD CONSTRAINT "RuntimeInstance_stopReason_check" CHECK ("stopReason" IS NULL OR char_length("stopReason") <= 200);

-- The P2 sources (deploy, knowledge, nexus_inbox) raise events only.
ALTER TABLE "SourceCursor" DROP CONSTRAINT "SourceCursor_source_check",
  ADD CONSTRAINT "SourceCursor_source_check" CHECK ("source" IN ('launchd', 'health', 'git', 'spend', 'github', 'railway', 'nexus', 'google', 'deploy', 'knowledge', 'nexus_inbox'));
ALTER TABLE "EntitySource" DROP CONSTRAINT "EntitySource_source_check",
  ADD CONSTRAINT "EntitySource_source_check" CHECK ("source" IN ('launchd', 'health', 'git', 'spend', 'github', 'railway', 'nexus', 'google', 'deploy', 'knowledge', 'nexus_inbox'));

-- ---- Caps: an hourly period, and a counted bypass --------------------------------------
-- An hour is the UTC hour (YYYY-MM-DDTHH).
ALTER TABLE "ActionCounter" DROP CONSTRAINT "ActionCounter_day_check",
  ADD CONSTRAINT "ActionCounter_day_check" CHECK ("day" ~ '^\d{4}-(\d{2}-\d{2}(T\d{2})?|W\d{2})$');

-- A critical push goes out past the push cap and is still counted (plan P2 tiers):
-- claim_action() never counts past its cap, so this counts unconditionally.
CREATE FUNCTION count_action(p_action text, p_period text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  c integer;
BEGIN
  INSERT INTO "ActionCounter" ("action", "day", "count") VALUES (p_action, p_period, 1)
  ON CONFLICT ("action", "day") DO UPDATE SET "count" = "ActionCounter"."count" + 1
  RETURNING "count" INTO c;
  RETURN c;
END;
$$;

-- ---- Triage rules are policy -------------------------------------------------------------
-- A rule exists only as the exact rule in an approved triage.rule.create
-- proposal being executed (the ActionPolicy pattern); afterwards it can only be
-- switched off, and every change is in RowChange.
CREATE FUNCTION triage_rule_matches_approval() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  a "Approval"%ROWTYPE;
  p "Proposal"%ROWTYPE;
  r jsonb;
BEGIN
  SELECT * INTO a FROM "Approval" WHERE "id" = NEW."approvalId";
  IF NOT FOUND OR a."decision" <> 'approve' OR a."subjectType" <> 'proposal' THEN
    RAISE EXCEPTION 'triage rule %: approval % is not an approved proposal', NEW."name", NEW."approvalId" USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO p FROM "Proposal" WHERE "id" = a."subjectId";
  IF NOT FOUND OR p."kind" <> 'rule' OR p."action" <> 'triage.rule.create' OR p."approvalId" IS DISTINCT FROM a."id"
     OR p."status" <> 'executing' OR p."args" IS NULL OR jsonb_typeof(p."args"->'rule') <> 'object' THEN
    RAISE EXCEPTION 'triage rule %: proposal % is not an approved rule being executed', NEW."name", a."subjectId" USING ERRCODE = 'insufficient_privilege';
  END IF;
  r := p."args"->'rule';
  IF r->>'name' IS DISTINCT FROM NEW."name" OR r->>'source' IS DISTINCT FROM NEW."source" OR r->>'eventType' IS DISTINCT FROM NEW."eventType"
     OR (r->'predicate') IS DISTINCT FROM NEW."predicate" OR r->>'action' IS DISTINCT FROM NEW."action" OR r->>'lane' IS DISTINCT FROM NEW."lane"
     OR coalesce((r->>'priority')::int, 100) <> NEW."priority"
     OR coalesce(r->'perSenderDailyCap', 'null'::jsonb) IS DISTINCT FROM coalesce(to_jsonb(NEW."perSenderDailyCap"), 'null'::jsonb)
     OR r->>'createdBy' IS DISTINCT FROM NEW."createdBy" OR NOT NEW."enabled" THEN
    RAISE EXCEPTION 'triage rule %: not the rule in the signed proposal', NEW."name" USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "TriageRule_matches_approval" BEFORE INSERT ON "TriageRule"
  FOR EACH ROW EXECUTE FUNCTION triage_rule_matches_approval();

CREATE FUNCTION triage_rule_update_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'triage rules are switched off, never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (to_jsonb(NEW) - 'enabled') IS DISTINCT FROM (to_jsonb(OLD) - 'enabled') OR (NEW."enabled" AND NOT OLD."enabled") THEN
    RAISE EXCEPTION 'triage rule %: it can only be switched off', OLD."name" USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "TriageRule_update_guard" BEFORE UPDATE OR DELETE ON "TriageRule"
  FOR EACH ROW EXECUTE FUNCTION triage_rule_update_guard();
CREATE TRIGGER "TriageRule_no_truncate" BEFORE TRUNCATE ON "TriageRule"
  FOR EACH STATEMENT EXECUTE FUNCTION triage_rule_update_guard();
CREATE TRIGGER "TriageRule_history" AFTER UPDATE ON "TriageRule"
  FOR EACH ROW EXECUTE FUNCTION row_history();

-- ---- A decision is what was decided -------------------------------------------------------
-- Only Will's label is added later, and the reasoning may only be purged.
CREATE FUNCTION triage_decision_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'triage decisions are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (to_jsonb(NEW) - 'feedback' - 'feedbackAt' - 'reasoning') IS DISTINCT FROM (to_jsonb(OLD) - 'feedback' - 'feedbackAt' - 'reasoning') THEN
    RAISE EXCEPTION 'triage decision %: what was decided does not change', OLD."id" USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."reasoning" IS DISTINCT FROM OLD."reasoning" AND NEW."reasoning" IS NOT NULL THEN
    RAISE EXCEPTION 'triage decision %: the reasoning may only be purged', OLD."id" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "TriageDecision_guard" BEFORE UPDATE OR DELETE ON "TriageDecision"
  FOR EACH ROW EXECUTE FUNCTION triage_decision_guard();
CREATE TRIGGER "TriageDecision_no_truncate" BEFORE TRUNCATE ON "TriageDecision"
  FOR EACH STATEMENT EXECUTE FUNCTION triage_decision_guard();

-- ---- What an escalation said never changes; "acted" needs proof (plan 3.0.9) ------------------
-- Statuses: open -> acked|dismissed|acted|expired, acked -> dismissed|acted|expired.
-- "acted" needs an AuditEntry of kind action, outcome ok, correlated with this
-- escalation (or its recommendation). Its text may be purged (retention,
-- forget): body and fields go, the title becomes the template's field-free one.
CREATE FUNCTION escalation_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  mutable text[] := ARRAY['status', 'actedAuditId', 'useful', 'ackedAt', 'title', 'body', 'fields', 'contentPurgedAt'];
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'escalations are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (to_jsonb(NEW) - mutable) IS DISTINCT FROM (to_jsonb(OLD) - mutable) THEN
    RAISE EXCEPTION 'escalation %: what it said does not change', OLD."id" USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."title" IS DISTINCT FROM OLD."title" OR NEW."body" IS DISTINCT FROM OLD."body" OR NEW."fields" IS DISTINCT FROM OLD."fields" THEN
    IF NEW."contentPurgedAt" IS NULL OR NEW."body" IS NOT NULL OR NEW."fields" <> '{}'::jsonb THEN
      RAISE EXCEPTION 'escalation %: its text may only be purged', OLD."id" USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF OLD."contentPurgedAt" IS NOT NULL AND NEW."contentPurgedAt" IS DISTINCT FROM OLD."contentPurgedAt" THEN
    RAISE EXCEPTION 'escalation %: purged once', OLD."id" USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" <> OLD."status" THEN
    IF NOT ((OLD."status" = 'open' AND NEW."status" IN ('acked', 'dismissed', 'acted', 'expired'))
         OR (OLD."status" = 'acked' AND NEW."status" IN ('dismissed', 'acted', 'expired'))) THEN
      RAISE EXCEPTION 'escalation %: % -> % is not allowed', OLD."id", OLD."status", NEW."status" USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" = 'acted' AND NOT EXISTS (
      SELECT 1 FROM "AuditEntry" a
      WHERE a."id" = NEW."actedAuditId" AND a."kind" = 'action' AND a."outcome" = 'ok'
        AND a."correlationId" IN (NEW."id", coalesce(NEW."recommendationId", NEW."id"))
    ) THEN
      RAISE EXCEPTION 'escalation %: "acted" needs a correlated action with outcome ok', OLD."id" USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."actedAuditId" IS DISTINCT FROM OLD."actedAuditId" THEN
    RAISE EXCEPTION 'escalation %: the proof is attached only when it is marked acted', OLD."id" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Escalation_guard" BEFORE UPDATE OR DELETE ON "Escalation"
  FOR EACH ROW EXECUTE FUNCTION escalation_guard();
CREATE TRIGGER "Escalation_no_truncate" BEFORE TRUNCATE ON "Escalation"
  FOR EACH STATEMENT EXECUTE FUNCTION escalation_guard();

-- A delivery is sent once: pending -> sent|failed, failed -> sent|failed (a retry);
-- held (its notify action was not promoted) never changes.
CREATE FUNCTION escalation_delivery_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'deliveries are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."id" <> OLD."id" OR NEW."escalationId" <> OLD."escalationId" OR NEW."channel" <> OLD."channel" OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'delivery %: what it is for does not change', OLD."id" USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" <> OLD."status" AND NOT ((OLD."status" = 'pending' AND NEW."status" IN ('sent', 'failed')) OR (OLD."status" = 'failed' AND NEW."status" IN ('sent', 'failed'))) THEN
    RAISE EXCEPTION 'delivery %: % -> % is not allowed', OLD."id", OLD."status", NEW."status" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "EscalationDelivery_guard" BEFORE UPDATE OR DELETE ON "EscalationDelivery"
  FOR EACH ROW EXECUTE FUNCTION escalation_delivery_guard();
CREATE TRIGGER "EscalationDelivery_no_truncate" BEFORE TRUNCATE ON "EscalationDelivery"
  FOR EACH STATEMENT EXECUTE FUNCTION escalation_delivery_guard();

-- ---- Forget reaches P2 (plan 3.0.5 step 9) ------------------------------------------------
-- forget_entity() marks the entity forgotten while its sources and events still
-- carry their real ids; this then clears what P2 kept about those events: the
-- model's reasoning, the escalation text, and the payloads of events the
-- runtime raised about the entity itself (which name it only by id).
CREATE FUNCTION entity_forgotten_p2() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  events text[];
BEGIN
  SELECT coalesce(array_agg(DISTINCT x), '{}') INTO events FROM (
    SELECT "sourceEventId" AS x FROM "EntityVersion" WHERE "entityId" = NEW."id" AND "sourceEventId" IS NOT NULL
    UNION SELECT ev."id" FROM "SourceEvent" ev JOIN "EntitySource" es ON es."entityId" = NEW."id" AND es."source" = ev."source"
      WHERE left(ev."sourceRef", length(es."externalId") + 1) = es."externalId" || '@'
    UNION SELECT ev."id" FROM "SourceEvent" ev WHERE ev."payload"->>'entityId' = NEW."id"
  ) s;
  UPDATE "SourceEvent" SET "payload" = NULL WHERE "id" = ANY (events) AND "payload"->>'entityId' = NEW."id";
  UPDATE "TriageDecision" SET "reasoning" = NULL WHERE "sourceEventId" = ANY (events) AND "reasoning" IS NOT NULL;
  UPDATE "Escalation" SET "title" = 'Something needs a look', "body" = NULL, "fields" = '{}'::jsonb, "contentPurgedAt" = now()
  WHERE "contentPurgedAt" IS NULL AND "triageDecisionId" IN (SELECT "id" FROM "TriageDecision" WHERE "sourceEventId" = ANY (events));
  RETURN NULL;
END;
$$;
CREATE TRIGGER "Entity_forgotten_p2" AFTER UPDATE OF "status" ON "Entity"
  FOR EACH ROW WHEN (NEW."status" = 'forgotten' AND OLD."status" <> 'forgotten') EXECUTE FUNCTION entity_forgotten_p2();

-- ---- Grants ------------------------------------------------------------------------------------
REVOKE ALL ON FUNCTION count_action(text, text), triage_rule_matches_approval(), triage_rule_update_guard(), triage_decision_guard(),
  escalation_guard(), escalation_delivery_guard(), entity_forgotten_p2() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION count_action(text, text) TO flint_app;
GRANT SELECT, INSERT, UPDATE ("enabled") ON "TriageRule" TO flint_app;
GRANT SELECT, INSERT, UPDATE ("feedback", "feedbackAt", "reasoning") ON "TriageDecision" TO flint_app;
GRANT SELECT, INSERT, UPDATE ("status", "actedAuditId", "useful", "ackedAt", "title", "body", "fields", "contentPurgedAt") ON "Escalation" TO flint_app;
GRANT SELECT, INSERT, UPDATE ("status", "attempts", "lastError", "sentAt") ON "EscalationDelivery" TO flint_app;
GRANT SELECT, INSERT, UPDATE ("lastBeatAt", "stoppedAt", "stopReason"), DELETE ON "RuntimeInstance" TO flint_app;
GRANT SELECT, INSERT, DELETE ON "HealthCheck" TO flint_app;

-- ===========================================================================
-- The job queue: pg-boss 12.35.1 (its schema version 43), installed here by
-- flint_owner so flint_app runs no DDL (it starts pg-boss with migrate:false).
-- What follows is pg-boss's own getConstructionPlans('pgboss') for that
-- version, with its transaction wrapper and advisory lock taken out (the
-- migration is its own transaction). A test checks it still matches.
-- ===========================================================================
-- BEGIN pg-boss 12.35.1 schema 43
CREATE SCHEMA pgboss;

    CREATE TYPE pgboss.job_state AS ENUM (
      'created',
      'retry',
      'active',
      'completed',
      'cancelled',
      'failed'
    )
  ;

    CREATE FUNCTION pgboss.job_now()
    RETURNS timestamp with time zone AS
    $$
      SELECT pg_catalog.now();
    $$
    LANGUAGE sql STABLE;
  ;

    CREATE TABLE pgboss.version (
      version int primary key,
      cron_on timestamp with time zone,
      bam_on timestamp with time zone,
      flow_on timestamp with time zone,
      reindex_on timestamp with time zone,
      monitor_backoff_on timestamp with time zone
    )
  ;

    CREATE TABLE pgboss.queue (
      name text NOT NULL,
      policy text NOT NULL,
      retry_limit int NOT NULL,
      retry_delay int NOT NULL,
      retry_backoff bool NOT NULL,
      retry_delay_max int,
      expire_seconds int NOT NULL,
      retention_seconds int NOT NULL,
      deletion_seconds int NOT NULL,
      dead_letter text REFERENCES pgboss.queue (name) CHECK (dead_letter IS DISTINCT FROM name),
      partition bool NOT NULL,
      table_name text NOT NULL,
      deferred_count int NOT NULL default 0,
      queued_count int NOT NULL default 0,
      ready_count int NOT NULL default 0,
      warning_queued int NOT NULL default 0,
      active_count int NOT NULL default 0,
      failed_count int NOT NULL default 0,
      total_count int NOT NULL default 0,
      created_delta int NOT NULL default 0,
      completed_delta int NOT NULL default 0,
      failed_delta int NOT NULL default 0,
      delta_on timestamp with time zone,
      delta_seconds int,
      ready_history int[] NOT NULL default '{}',
      heartbeat_seconds int,
      notify bool NOT NULL DEFAULT false,
      singletons_active text[],
      monitor_claim_on timestamp with time zone,
      monitor_on timestamp with time zone,
      maintain_on timestamp with time zone,
      created_on timestamp with time zone not null default now(),
      updated_on timestamp with time zone not null default now(),
      PRIMARY KEY (name)
    )
  ;

    CREATE TABLE pgboss.schedule (
      name text REFERENCES pgboss.queue ON DELETE CASCADE,
      key text not null DEFAULT '',
      kind text not null DEFAULT 'cron' CHECK (kind IN ('cron', 'rrule')),
      cron text not null,
      timezone text DEFAULT 'UTC',
      data jsonb,
      options jsonb,
      created_on timestamp with time zone not null default now(),
      updated_on timestamp with time zone not null default now(),
      last_job_id uuid,
      PRIMARY KEY (name, key)
    )
  ;

    CREATE TABLE pgboss.subscription (
      event text not null,
      name text not null REFERENCES pgboss.queue ON DELETE CASCADE,
      created_on timestamp with time zone not null default now(),
      updated_on timestamp with time zone not null default now(),
      PRIMARY KEY(event, name)
    )
  ;

    CREATE TABLE pgboss.bam (
      id uuid PRIMARY KEY default gen_random_uuid(),
      name text NOT NULL,
      version int NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      queue text,
      table_name text NOT NULL,
      command text NOT NULL,
      error text,
      created_on timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
      started_on timestamp with time zone,
      completed_on timestamp with time zone
    )
  ;

    CREATE FUNCTION pgboss.job_table_format(command text, table_name text)
    RETURNS text AS
    $$
      SELECT format(
        regexp_replace(
          regexp_replace(command, '\.job\y', '.%1$I', 'g'),
          '\yjob_i(\d+)', '%1$s_i\1', 'g'
        ),
        table_name
      );
    $$
    LANGUAGE sql IMMUTABLE;
  ;

    CREATE FUNCTION pgboss.job_table_run(command text, tbl_name text DEFAULT NULL, queue_name text DEFAULT NULL)
    RETURNS VOID AS
    $$
    DECLARE
      tbl RECORD;
    BEGIN
      IF queue_name IS NOT NULL THEN
        SELECT table_name INTO tbl_name FROM pgboss.queue WHERE name = queue_name;
      END IF;

      IF tbl_name IS NOT NULL THEN
        EXECUTE pgboss.job_table_format(command, tbl_name);
        RETURN;
      END IF;

      EXECUTE pgboss.job_table_format(command, 'job_common');

      FOR tbl IN SELECT table_name FROM pgboss.queue WHERE partition = true
      LOOP
        EXECUTE pgboss.job_table_format(command, tbl.table_name);
      END LOOP;
    END;
    $$
    LANGUAGE plpgsql;
  ;

    CREATE FUNCTION pgboss.job_table_run_async(command_name text, version int, command text, tbl_name text DEFAULT NULL, queue_name text DEFAULT NULL)
    RETURNS VOID AS
    $$
    BEGIN
      IF queue_name IS NOT NULL THEN
        SELECT table_name INTO tbl_name FROM pgboss.queue WHERE name = queue_name;
      END IF;

      IF tbl_name IS NOT NULL THEN
        INSERT INTO pgboss.bam (name, version, status, queue, table_name, command)
        VALUES (
          command_name,
          version,
          'pending',
          queue_name,
          tbl_name,
          pgboss.job_table_format(command, tbl_name)
        );
        RETURN;
      END IF;

      INSERT INTO pgboss.bam (name, version, status, queue, table_name, command)
      SELECT
        command_name,
        version,
        'pending',
        NULL,
        'job_common',
        pgboss.job_table_format(command, 'job_common')
      UNION ALL
      SELECT
        command_name,
        version,
        'pending',
        queue.name,
        queue.table_name,
        pgboss.job_table_format(command, queue.table_name)
      FROM pgboss.queue
      WHERE partition = true;
    END;
    $$
    LANGUAGE plpgsql;
  ;

    CREATE TABLE pgboss.job (
      id uuid not null default gen_random_uuid(),
      name text not null,
      priority integer not null default(0),
      data jsonb,
      state pgboss.job_state not null default 'created',
      retry_limit integer not null default 2,
      retry_count integer not null default 0,
      retry_delay integer not null default 0,
      retry_backoff boolean not null default false,
      retry_delay_max integer,
      expire_seconds int not null default 900,
      deletion_seconds int not null default 604800,
      singleton_key text,
      singleton_on timestamp without time zone,
      group_id text,
      group_tier text,
      start_after timestamp with time zone not null default now(),
      created_on timestamp with time zone not null default now(),
      started_on timestamp with time zone,
      completed_on timestamp with time zone,
      keep_until timestamp with time zone NOT NULL default now() + interval '1209600',
      output jsonb,
      dead_letter text,
      policy text,
      heartbeat_on timestamp with time zone,
      heartbeat_seconds int,
      blocked boolean not null default false,
      blocking boolean not null default false,
      pending_dependencies int not null default 0,
      source_name text,
      source_id uuid,
      source_created_on timestamp with time zone,
      source_retry_count int,
      source_output jsonb,
      source_root_id uuid
    ) PARTITION BY LIST (name)
  ;
ALTER TABLE pgboss.job ADD PRIMARY KEY (name, id);

    CREATE TABLE pgboss.job_common (LIKE pgboss.job INCLUDING GENERATED INCLUDING DEFAULTS);

    SELECT pgboss.job_table_run($cmd$ALTER TABLE pgboss.job ADD PRIMARY KEY (name, id)$cmd$, 'job_common');
    SELECT pgboss.job_table_run($cmd$ALTER TABLE pgboss.job ADD CONSTRAINT q_fkey FOREIGN KEY (name) REFERENCES pgboss.queue (name) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED$cmd$, 'job_common');
    SELECT pgboss.job_table_run($cmd$ALTER TABLE pgboss.job ADD CONSTRAINT dlq_fkey FOREIGN KEY (dead_letter) REFERENCES pgboss.queue (name) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED$cmd$, 'job_common');
    SELECT pgboss.job_table_run($cmd$CREATE UNIQUE INDEX job_i1 ON pgboss.job (name, COALESCE(singleton_key, '')) WHERE state = 'created' AND policy = 'short'$cmd$, 'job_common');
    SELECT pgboss.job_table_run($cmd$CREATE UNIQUE INDEX job_i2 ON pgboss.job (name, COALESCE(singleton_key, '')) WHERE state = 'active' AND policy = 'singleton'$cmd$, 'job_common');
    SELECT pgboss.job_table_run($cmd$CREATE UNIQUE INDEX job_i3 ON pgboss.job (name, state, COALESCE(singleton_key, '')) WHERE state <= 'active' AND policy = 'stately'$cmd$, 'job_common');
    SELECT pgboss.job_table_run($cmd$CREATE UNIQUE INDEX job_i6 ON pgboss.job (name, COALESCE(singleton_key, '')) WHERE state <= 'active' AND policy = 'exclusive'$cmd$, 'job_common');
    SELECT pgboss.job_table_run($cmd$CREATE UNIQUE INDEX job_i8 ON pgboss.job (name, singleton_key) WHERE state IN ('active', 'retry', 'failed') AND policy = 'key_strict_fifo'$cmd$, 'job_common');
    SELECT pgboss.job_table_run($cmd$CREATE INDEX job_i10 ON pgboss.job (name, singleton_key, state DESC, created_on, id) INCLUDE (start_after) WHERE state < 'active' AND NOT blocked AND policy = 'key_strict_fifo'$cmd$, 'job_common');
    SELECT pgboss.job_table_run($cmd$ALTER TABLE pgboss.job ADD CONSTRAINT job_key_strict_fifo_singleton_key_check CHECK (NOT (policy = 'key_strict_fifo' AND singleton_key IS NULL))$cmd$, 'job_common');
    SELECT pgboss.job_table_run($cmd$CREATE UNIQUE INDEX job_i4 ON pgboss.job (name, singleton_on, COALESCE(singleton_key, '')) WHERE state <> 'cancelled' AND singleton_on IS NOT NULL$cmd$, 'job_common');
    SELECT pgboss.job_table_run($cmd$CREATE INDEX job_i11 ON pgboss.job (name, priority DESC, created_on, start_after) WHERE state < 'active' AND NOT blocked$cmd$, 'job_common');
    SELECT pgboss.job_table_run($cmd$CREATE INDEX job_i7 ON pgboss.job (name, group_id) WHERE state = 'active' AND group_id IS NOT NULL$cmd$, 'job_common');
    SELECT pgboss.job_table_run($cmd$CREATE INDEX job_i9 ON pgboss.job (name, id) WHERE blocking AND state = 'completed'$cmd$, 'job_common');
    SELECT pgboss.job_table_run($cmd$CREATE INDEX job_i12 ON pgboss.job (source_root_id) WHERE source_root_id IS NOT NULL$cmd$, 'job_common');

    ALTER TABLE pgboss.job ATTACH PARTITION pgboss.job_common DEFAULT;
  ;

    CREATE TABLE pgboss.warning (
      id uuid PRIMARY KEY default gen_random_uuid(),
      type text NOT NULL,
      message text NOT NULL,
      data jsonb,
      created_on timestamp with time zone NOT NULL DEFAULT now()
    )
  ;
CREATE INDEX warning_i1 ON pgboss.warning (created_on DESC);

    CREATE TABLE pgboss.queue_stats (
      id uuid NOT NULL DEFAULT gen_random_uuid(),
      name text NOT NULL,
      deferred_count int NOT NULL DEFAULT 0,
      queued_count   int NOT NULL DEFAULT 0,
      ready_count    int NOT NULL DEFAULT 0,
      active_count   int NOT NULL DEFAULT 0,
      failed_count   int NOT NULL DEFAULT 0,
      total_count    int NOT NULL DEFAULT 0,
      created_delta   int,
      completed_delta int,
      failed_delta    int,
      delta_seconds   int,
      delta_on        timestamptz,
      captured_on timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (id, captured_on)
    ) PARTITION BY RANGE (captured_on)
  ;
CREATE INDEX queue_stats_i1 ON pgboss.queue_stats (name, captured_on DESC) INCLUDE (deferred_count, queued_count, ready_count, active_count, failed_count, total_count);

    DO $$
    DECLARE
      d date;
      i int;
      part_name text;
    BEGIN
      FOR i IN 0..1 LOOP
        d := (pgboss.job_now() AT TIME ZONE 'UTC')::date + i;
        part_name := 'queue_stats_' || to_char(d, 'YYYYMMDD');
        IF NOT EXISTS (
          SELECT 1 FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'pgboss' AND c.relname = part_name
        ) THEN
          EXECUTE format(
            'CREATE TABLE pgboss.%I PARTITION OF pgboss.queue_stats FOR VALUES FROM (%L) TO (%L)',
            part_name,
            to_char(d, 'YYYY-MM-DD') || ' 00:00:00+00',
            to_char(d + 1, 'YYYY-MM-DD') || ' 00:00:00+00'
          );
        END IF;
      END LOOP;
    END;
    $$
  ;

    CREATE TABLE pgboss.job_dependency (
      child_name text NOT NULL,
      child_id uuid NOT NULL,
      parent_name text NOT NULL,
      parent_id uuid NOT NULL,
      PRIMARY KEY (child_name, child_id, parent_name, parent_id)
    )
  ;
CREATE INDEX IF NOT EXISTS job_dep_parent_idx ON pgboss.job_dependency (parent_name, parent_id);

    CREATE FUNCTION pgboss.create_queue(queue_name text, options jsonb)
    RETURNS VOID AS
    $$
    DECLARE
      tablename varchar := CASE WHEN options->>'partition' = 'true'
                            THEN 'j' || encode(sha224(queue_name::bytea), 'hex')
                            ELSE 'job_common'
                            END;
      queue_created_on timestamptz;
    BEGIN

      WITH q as (
        INSERT INTO pgboss.queue (
          name,
          policy,
          retry_limit,
          retry_delay,
          retry_backoff,
          retry_delay_max,
          expire_seconds,
          retention_seconds,
          deletion_seconds,
          warning_queued,
          dead_letter,
          partition,
          table_name,
          heartbeat_seconds,
          notify,
          created_on,
          updated_on
        )
        VALUES (
          queue_name,
          options->>'policy',
          COALESCE((options->>'retryLimit')::int, 2),
          COALESCE((options->>'retryDelay')::int, 0),
          COALESCE((options->>'retryBackoff')::bool, false),
          (options->>'retryDelayMax')::int,
          COALESCE((options->>'expireInSeconds')::int, 900),
          COALESCE((options->>'retentionSeconds')::int, 1209600),
          COALESCE((options->>'deleteAfterSeconds')::int, 604800),
          COALESCE((options->>'warningQueueSize')::int, 0),
          options->>'deadLetter',
          COALESCE((options->>'partition')::bool, false),
          tablename,
          (options->>'heartbeatSeconds')::int,
          COALESCE((options->>'notify')::bool, false),
          pgboss.job_now(),
          pgboss.job_now()
        )
        ON CONFLICT DO NOTHING
        RETURNING created_on
      )
      SELECT created_on into queue_created_on from q;

      IF queue_created_on IS NULL OR options->>'partition' IS DISTINCT FROM 'true' THEN
        RETURN;
      END IF;

      EXECUTE format('CREATE TABLE pgboss.%I (LIKE pgboss.job INCLUDING DEFAULTS)', tablename);

      EXECUTE pgboss.job_table_format($cmd$ALTER TABLE pgboss.job ADD PRIMARY KEY (name, id)$cmd$, tablename);
      EXECUTE pgboss.job_table_format($cmd$ALTER TABLE pgboss.job ADD CONSTRAINT q_fkey FOREIGN KEY (name) REFERENCES pgboss.queue (name) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED$cmd$, tablename);
      EXECUTE pgboss.job_table_format($cmd$ALTER TABLE pgboss.job ADD CONSTRAINT dlq_fkey FOREIGN KEY (dead_letter) REFERENCES pgboss.queue (name) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED$cmd$, tablename);

      EXECUTE pgboss.job_table_format($cmd$CREATE INDEX job_i11 ON pgboss.job (name, priority DESC, created_on, start_after) WHERE state < 'active' AND NOT blocked$cmd$, tablename);
      EXECUTE pgboss.job_table_format($cmd$CREATE UNIQUE INDEX job_i4 ON pgboss.job (name, singleton_on, COALESCE(singleton_key, '')) WHERE state <> 'cancelled' AND singleton_on IS NOT NULL$cmd$, tablename);
      EXECUTE pgboss.job_table_format($cmd$CREATE INDEX job_i7 ON pgboss.job (name, group_id) WHERE state = 'active' AND group_id IS NOT NULL$cmd$, tablename);
      EXECUTE pgboss.job_table_format($cmd$CREATE INDEX job_i9 ON pgboss.job (name, id) WHERE blocking AND state = 'completed'$cmd$, tablename);
      EXECUTE pgboss.job_table_format($cmd$CREATE INDEX job_i12 ON pgboss.job (source_root_id) WHERE source_root_id IS NOT NULL$cmd$, tablename);

      IF options->>'policy' = 'short' THEN
        EXECUTE pgboss.job_table_format($cmd$CREATE UNIQUE INDEX job_i1 ON pgboss.job (name, COALESCE(singleton_key, '')) WHERE state = 'created' AND policy = 'short'$cmd$, tablename);
      ELSIF options->>'policy' = 'singleton' THEN
        EXECUTE pgboss.job_table_format($cmd$CREATE UNIQUE INDEX job_i2 ON pgboss.job (name, COALESCE(singleton_key, '')) WHERE state = 'active' AND policy = 'singleton'$cmd$, tablename);
      ELSIF options->>'policy' = 'stately' THEN
        EXECUTE pgboss.job_table_format($cmd$CREATE UNIQUE INDEX job_i3 ON pgboss.job (name, state, COALESCE(singleton_key, '')) WHERE state <= 'active' AND policy = 'stately'$cmd$, tablename);
      ELSIF options->>'policy' = 'exclusive' THEN
        EXECUTE pgboss.job_table_format($cmd$CREATE UNIQUE INDEX job_i6 ON pgboss.job (name, COALESCE(singleton_key, '')) WHERE state <= 'active' AND policy = 'exclusive'$cmd$, tablename);
      ELSIF options->>'policy' = 'key_strict_fifo' THEN
        EXECUTE pgboss.job_table_format($cmd$CREATE UNIQUE INDEX job_i8 ON pgboss.job (name, singleton_key) WHERE state IN ('active', 'retry', 'failed') AND policy = 'key_strict_fifo'$cmd$, tablename);
        EXECUTE pgboss.job_table_format($cmd$CREATE INDEX job_i10 ON pgboss.job (name, singleton_key, state DESC, created_on, id) INCLUDE (start_after) WHERE state < 'active' AND NOT blocked AND policy = 'key_strict_fifo'$cmd$, tablename);
        EXECUTE pgboss.job_table_format($cmd$ALTER TABLE pgboss.job ADD CONSTRAINT job_key_strict_fifo_singleton_key_check CHECK (NOT (policy = 'key_strict_fifo' AND singleton_key IS NULL))$cmd$, tablename);
      END IF;

      EXECUTE format('ALTER TABLE pgboss.%I ADD CONSTRAINT cjc CHECK (name=%L)', tablename, queue_name);
      EXECUTE format('ALTER TABLE pgboss.job ATTACH PARTITION pgboss.%I FOR VALUES IN (%L)', tablename, queue_name);
    END;
    $$
    LANGUAGE plpgsql;
  ;

    CREATE FUNCTION pgboss.delete_queue(queue_name text)
    RETURNS VOID AS
    $$
    DECLARE
      v_table varchar;
      v_partition bool;
    BEGIN
      
      SELECT table_name, partition
      FROM pgboss.queue
      WHERE name = queue_name
      INTO v_table, v_partition;

      IF v_partition THEN
        EXECUTE format('DROP TABLE IF EXISTS pgboss.%I', v_table);
      ELSE
        EXECUTE format('DELETE FROM pgboss.%I WHERE name = %L', v_table, queue_name);
      END IF;
    
      DELETE FROM pgboss.queue WHERE name = queue_name;
    END;
    $$
    LANGUAGE plpgsql;
  ;
INSERT INTO pgboss.version(version) VALUES ('43');
-- END pg-boss 12.35.1 schema 43

-- ---- The queues: a closed set, made here so flint_app never makes one -------------------------
-- Every queue shares pg-boss's common job table (no partition: a new queue is a
-- row, not a table). A job that fails its last retry lands in `dead`.
--   sync.<source>  each world source on its cadence (one run at a time)
--   triage         one applied event (stately: one waiting and one running per event)
--   deliver        one escalation's notes (stately per escalation)
--   the rest       housekeeping on a schedule, one run at a time
SELECT pgboss.create_queue('dead', '{"policy":"standard","retentionSeconds":1209600}'::jsonb);
SELECT pgboss.create_queue('sync.' || s, '{"policy":"singleton","retryLimit":1,"retryDelay":30,"expireInSeconds":600,"deadLetter":"dead"}'::jsonb)
  FROM unnest(ARRAY['launchd', 'health', 'git', 'spend', 'github', 'railway', 'nexus', 'deploy', 'knowledge', 'nexus_inbox']) AS s;
SELECT pgboss.create_queue('triage', '{"policy":"stately","retryLimit":3,"retryDelay":30,"retryBackoff":true,"expireInSeconds":600,"deadLetter":"dead"}'::jsonb);
SELECT pgboss.create_queue('deliver', '{"policy":"stately","retryLimit":5,"retryDelay":30,"retryBackoff":true,"expireInSeconds":120,"deadLetter":"dead"}'::jsonb);
SELECT pgboss.create_queue(q, '{"policy":"singleton","retryLimit":2,"retryDelay":60,"expireInSeconds":900,"deadLetter":"dead"}'::jsonb)
  FROM unnest(ARRAY['health', 'digest', 'retention', 'rollup', 'reconcile', 'drill.check', 'expire.escalations']) AS q;

-- ---- pg-boss's grants: data only ---------------------------------------------------------------
REVOKE ALL ON SCHEMA pgboss FROM PUBLIC;
GRANT USAGE ON SCHEMA pgboss TO flint_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO flint_app;
-- Its schema version and its async-migration ledger are written by migrations only.
REVOKE INSERT, UPDATE, DELETE ON pgboss.version, pgboss.bam FROM flint_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA pgboss TO flint_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pgboss TO flint_app;
