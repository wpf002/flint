-- p1_world (Machine plan P1, 3.0.5).
-- Generated tables first, then the hand-written CHECKs, triggers, forget procedure and grants.
-- Reversed by down.sql in this directory.

-- CreateTable
CREATE TABLE "Entity" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "state" JSONB NOT NULL,
    "stateHash" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'active',
    "sensitivity" TEXT NOT NULL DEFAULT 'ops',
    "taintedPaths" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "confidence" DOUBLE PRECISION,
    "mergedIntoId" TEXT,
    "firstSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastObservedAt" TIMESTAMPTZ(3) NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Entity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EntityVersion" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "changeKind" TEXT NOT NULL,
    "state" JSONB,
    "patch" JSONB,
    "actor" TEXT NOT NULL,
    "sourceEventId" TEXT,
    "tainted" BOOLEAN NOT NULL DEFAULT false,
    "validFrom" TIMESTAMPTZ(3) NOT NULL,
    "recordedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EntityVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Relation" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "fromId" TEXT NOT NULL,
    "toId" TEXT NOT NULL,
    "attrs" JSONB,
    "confidence" DOUBLE PRECISION,
    "tainted" BOOLEAN NOT NULL DEFAULT false,
    "validFrom" TIMESTAMPTZ(3) NOT NULL,
    "validTo" TIMESTAMPTZ(3),
    "sourceEventId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Relation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EntitySource" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "namespace" TEXT,
    "accountOwner" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSyncedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "EntitySource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SourceEvent" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceRef" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sensitivity" TEXT NOT NULL,
    "tainted" BOOLEAN NOT NULL DEFAULT false,
    "payload" JSONB,
    "payloadHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'received',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "processedAt" TIMESTAMPTZ(3),

    CONSTRAINT "SourceEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SourceCursor" (
    "source" TEXT NOT NULL,
    "cursor" TEXT NOT NULL,
    "etag" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "lastOkAt" TIMESTAMPTZ(3),
    "lastError" TEXT,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "SourceCursor_pkey" PRIMARY KEY ("source")
);

-- CreateTable
CREATE TABLE "SuppressedKey" (
    "source" TEXT NOT NULL,
    "externalIdHash" TEXT NOT NULL,
    "approvalId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SuppressedKey_pkey" PRIMARY KEY ("source","externalIdHash")
);

-- CreateTable
CREATE TABLE "MetricSeries" (
    "key" TEXT NOT NULL,
    "entityId" TEXT,
    "unit" TEXT NOT NULL,
    "freq" TEXT NOT NULL,
    "sensitivity" TEXT NOT NULL,
    "offBoxAllowed" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MetricSeries_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "MetricPoint" (
    "seriesKey" TEXT NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "MetricPoint_pkey" PRIMARY KEY ("seriesKey","at")
);

-- CreateTable
CREATE TABLE "BackupRun" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "bytes" BIGINT,
    "sha256" TEXT,
    "encrypted" BOOLEAN NOT NULL,
    "status" TEXT NOT NULL,
    "startedAt" TIMESTAMPTZ(3) NOT NULL,
    "finishedAt" TIMESTAMPTZ(3),
    "restoreTestedAt" TIMESTAMPTZ(3),
    "restoreOk" BOOLEAN,
    "restoreDetail" JSONB,

    CONSTRAINT "BackupRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Entity_kind_status_updatedAt_idx" ON "Entity"("kind", "status", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Entity_kind_key_key" ON "Entity"("kind", "key");

-- CreateIndex
CREATE INDEX "EntityVersion_entityId_validFrom_idx" ON "EntityVersion"("entityId", "validFrom");

-- CreateIndex
CREATE INDEX "EntityVersion_sourceEventId_idx" ON "EntityVersion"("sourceEventId");

-- CreateIndex
CREATE UNIQUE INDEX "EntityVersion_entityId_version_key" ON "EntityVersion"("entityId", "version");

-- CreateIndex
CREATE INDEX "Relation_fromId_type_validTo_idx" ON "Relation"("fromId", "type", "validTo");

-- CreateIndex
CREATE INDEX "Relation_toId_type_validTo_idx" ON "Relation"("toId", "type", "validTo");

-- CreateIndex
CREATE INDEX "Relation_sourceEventId_idx" ON "Relation"("sourceEventId");

-- CreateIndex
CREATE INDEX "EntitySource_entityId_idx" ON "EntitySource"("entityId");

-- CreateIndex
CREATE UNIQUE INDEX "EntitySource_source_externalId_key" ON "EntitySource"("source", "externalId");

-- CreateIndex
CREATE INDEX "SourceEvent_status_receivedAt_idx" ON "SourceEvent"("status", "receivedAt");

-- CreateIndex
CREATE INDEX "SourceEvent_source_occurredAt_idx" ON "SourceEvent"("source", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "SourceEvent_source_sourceRef_key" ON "SourceEvent"("source", "sourceRef");

-- CreateIndex
CREATE INDEX "BackupRun_kind_startedAt_idx" ON "BackupRun"("kind", "startedAt");

-- AddForeignKey
ALTER TABLE "EntityVersion" ADD CONSTRAINT "EntityVersion_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Relation" ADD CONSTRAINT "Relation_fromId_fkey" FOREIGN KEY ("fromId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Relation" ADD CONSTRAINT "Relation_toId_fkey" FOREIGN KEY ("toId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EntitySource" ADD CONSTRAINT "EntitySource_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MetricPoint" ADD CONSTRAINT "MetricPoint_seriesKey_fkey" FOREIGN KEY ("seriesKey") REFERENCES "MetricSeries"("key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===========================================================================
-- Hand-written below this line.
-- ===========================================================================

-- ---- CHECKs -------------------------------------------------------------------
ALTER TABLE "Entity"
  ADD CONSTRAINT "Entity_kind_check" CHECK ("kind" IN ('service', 'repo', 'deployment', 'account', 'project', 'thread', 'pull_request', 'issue', 'ci_run', 'commitment', 'deadline', 'organization', 'person')),
  ADD CONSTRAINT "Entity_status_check" CHECK ("status" IN ('active', 'archived', 'merged', 'forgotten')),
  ADD CONSTRAINT "Entity_sensitivity_check" CHECK ("sensitivity" IN ('ops', 'personal', 'financial')),
  ADD CONSTRAINT "Entity_key_check" CHECK (char_length("key") BETWEEN 1 AND 300),
  ADD CONSTRAINT "Entity_name_check" CHECK (char_length("name") BETWEEN 1 AND 300),
  ADD CONSTRAINT "Entity_state_check" CHECK (jsonb_typeof("state") = 'object' AND octet_length("state"::text) <= 16384),
  ADD CONSTRAINT "Entity_stateHash_check" CHECK ("stateHash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "Entity_version_check" CHECK ("version" >= 1),
  ADD CONSTRAINT "Entity_confidence_check" CHECK ("confidence" IS NULL OR "confidence" BETWEEN 0 AND 1),
  ADD CONSTRAINT "Entity_merged_check" CHECK (("status" = 'merged') = ("mergedIntoId" IS NOT NULL));

ALTER TABLE "EntityVersion"
  ADD CONSTRAINT "EntityVersion_changeKind_check" CHECK ("changeKind" IN ('created', 'updated', 'archived', 'restored', 'merged', 'corrected', 'forgotten')),
  ADD CONSTRAINT "EntityVersion_version_check" CHECK ("version" >= 1);

ALTER TABLE "Relation"
  ADD CONSTRAINT "Relation_type_check" CHECK ("type" IN ('owns', 'depends_on', 'runs', 'deploys', 'of_repo', 'has_thread', 'has_pr', 'has_issue', 'committed_to', 'due_for', 'member_of', 'attends', 'blocks')),
  ADD CONSTRAINT "Relation_not_self_check" CHECK ("fromId" <> "toId"),
  ADD CONSTRAINT "Relation_window_check" CHECK ("validTo" IS NULL OR "validTo" >= "validFrom"),
  ADD CONSTRAINT "Relation_confidence_check" CHECK ("confidence" IS NULL OR "confidence" BETWEEN 0 AND 1);
-- At most one open relation of a type between two entities.
CREATE UNIQUE INDEX "Relation_open_key" ON "Relation" ("type", "fromId", "toId") WHERE "validTo" IS NULL;

ALTER TABLE "EntitySource"
  ADD CONSTRAINT "EntitySource_source_check" CHECK ("source" IN ('launchd', 'health', 'git', 'spend', 'github', 'railway', 'nexus', 'google')),
  -- PersonGuard: only what Will's own accounts already show him.
  ADD CONSTRAINT "EntitySource_owner_check" CHECK ("accountOwner" = 'will');

ALTER TABLE "SourceEvent"
  ADD CONSTRAINT "SourceEvent_status_check" CHECK ("status" IN ('received', 'applied', 'ignored', 'failed', 'dead')),
  ADD CONSTRAINT "SourceEvent_sensitivity_check" CHECK ("sensitivity" IN ('ops', 'personal', 'financial')),
  ADD CONSTRAINT "SourceEvent_payload_check" CHECK ("payload" IS NULL OR octet_length("payload"::text) <= 16384),
  ADD CONSTRAINT "SourceEvent_payloadHash_check" CHECK ("payloadHash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "SourceEvent_lastError_check" CHECK ("lastError" IS NULL OR char_length("lastError") <= 500),
  ADD CONSTRAINT "SourceEvent_attempts_check" CHECK ("attempts" >= 0);

ALTER TABLE "SourceCursor"
  ADD CONSTRAINT "SourceCursor_source_check" CHECK ("source" IN ('launchd', 'health', 'git', 'spend', 'github', 'railway', 'nexus', 'google')),
  ADD CONSTRAINT "SourceCursor_failures_check" CHECK ("consecutiveFailures" >= 0),
  ADD CONSTRAINT "SourceCursor_lastError_check" CHECK ("lastError" IS NULL OR char_length("lastError") <= 500);

ALTER TABLE "SuppressedKey"
  ADD CONSTRAINT "SuppressedKey_hash_check" CHECK ("externalIdHash" ~ '^[0-9a-f]{64}$');

ALTER TABLE "MetricSeries"
  ADD CONSTRAINT "MetricSeries_freq_check" CHECK ("freq" IN ('raw', 'D', 'W', 'M')),
  ADD CONSTRAINT "MetricSeries_sensitivity_check" CHECK ("sensitivity" IN ('ops', 'personal', 'financial')),
  ADD CONSTRAINT "MetricSeries_key_check" CHECK ("key" ~ '^[a-z0-9_]+(\.[a-z0-9_-]+)+$'),
  -- Only OPS series may ever leave the box (plan decision 21).
  ADD CONSTRAINT "MetricSeries_offbox_check" CHECK (NOT "offBoxAllowed" OR "sensitivity" = 'ops');

ALTER TABLE "BackupRun"
  ADD CONSTRAINT "BackupRun_kind_check" CHECK ("kind" IN ('pg_dump_flint', 'flint_tar', 'nexus_railway_dump')),
  ADD CONSTRAINT "BackupRun_location_check" CHECK ("location" IN ('local', 'icloud')),
  ADD CONSTRAINT "BackupRun_status_check" CHECK ("status" IN ('ok', 'failed')),
  ADD CONSTRAINT "BackupRun_sha256_check" CHECK ("sha256" IS NULL OR "sha256" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "BackupRun_bytes_check" CHECK ("bytes" IS NULL OR "bytes" >= 0),
  -- Anything stored off the box is encrypted.
  ADD CONSTRAINT "BackupRun_offsite_check" CHECK ("location" = 'local' OR "encrypted");

-- ---- Append-only versions -----------------------------------------------------------
CREATE TRIGGER "EntityVersion_append_only" BEFORE UPDATE OR DELETE ON "EntityVersion"
  FOR EACH ROW EXECUTE FUNCTION guard_append_only('state', 'patch');
CREATE TRIGGER "EntityVersion_no_truncate" BEFORE TRUNCATE ON "EntityVersion"
  FOR EACH STATEMENT EXECUTE FUNCTION guard_append_only();

-- ---- Entities -------------------------------------------------------------------------
-- What an entity is (kind, first sighting) never changes; it is never deleted;
-- and once forgotten it stays forgotten. Only forget_entity() changes its key or
-- makes it forgotten.
CREATE FUNCTION entity_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  forgetting boolean := current_user = 'flint_owner' AND coalesce(current_setting('flint.forget_approval', true), '') <> '';
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'entities are archived or forgotten, never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."id" <> OLD."id" OR NEW."kind" <> OLD."kind" OR NEW."firstSeenAt" <> OLD."firstSeenAt" THEN
    RAISE EXCEPTION 'entity %: id, kind and firstSeenAt never change', OLD."id";
  END IF;
  IF forgetting THEN
    RETURN NEW;
  END IF;
  IF OLD."status" = 'forgotten' THEN
    RAISE EXCEPTION 'entity % was forgotten', OLD."id" USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."status" = 'forgotten' OR NEW."key" <> OLD."key" THEN
    RAISE EXCEPTION 'entity %: only forget_entity() forgets or rekeys', OLD."id" USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."version" < OLD."version" THEN
    RAISE EXCEPTION 'entity %: the version cannot go down', OLD."id";
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Entity_guard" BEFORE UPDATE OR DELETE ON "Entity"
  FOR EACH ROW EXECUTE FUNCTION entity_guard();
CREATE TRIGGER "Entity_no_truncate" BEFORE TRUNCATE ON "Entity"
  FOR EACH STATEMENT EXECUTE FUNCTION entity_guard();

-- ---- Relations --------------------------------------------------------------------------
-- A relation is closed, never edited: only validTo changes, only from NULL. A
-- forget may also clear its attrs.
CREATE FUNCTION relation_close_only() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  forgetting boolean := current_user = 'flint_owner' AND coalesce(current_setting('flint.forget_approval', true), '') <> '';
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'relations are closed, never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF forgetting AND (to_jsonb(NEW) - 'attrs') = (to_jsonb(OLD) - 'attrs') AND NEW."attrs" IS NULL THEN
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - 'validTo') IS DISTINCT FROM (to_jsonb(OLD) - 'validTo') THEN
    RAISE EXCEPTION 'relation %: only validTo may change', OLD."id" USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD."validTo" IS NOT NULL THEN
    RAISE EXCEPTION 'relation % is already closed', OLD."id" USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Relation_close_only" BEFORE UPDATE OR DELETE ON "Relation"
  FOR EACH ROW EXECUTE FUNCTION relation_close_only();
CREATE TRIGGER "Relation_no_truncate" BEFORE TRUNCATE ON "Relation"
  FOR EACH STATEMENT EXECUTE FUNCTION relation_close_only();

-- ---- Sources ------------------------------------------------------------------------------
-- Turning a source on is an approval (plan P1 rollout): it happens only while an
-- approved world.source.enable proposal for that source is being executed.
CREATE FUNCTION source_enable_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."enabled" AND (TG_OP = 'INSERT' OR NOT OLD."enabled") THEN
    IF NOT EXISTS (
      SELECT 1 FROM "Proposal" p
      WHERE p."action" = 'world.source.enable' AND p."status" = 'executing'
        AND p."approvalId" IS NOT NULL AND p."args"->>'source' = NEW."source"
    ) THEN
      RAISE EXCEPTION 'source %: turning it on needs an approved world.source.enable proposal', NEW."source"
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "SourceCursor_enable_guard" BEFORE INSERT OR UPDATE ON "SourceCursor"
  FOR EACH ROW EXECUTE FUNCTION source_enable_guard();

-- A sync never recreates what Will asked Flint to forget.
CREATE FUNCTION entity_source_suppressed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "SuppressedKey" s
             WHERE s."source" = NEW."source" AND s."externalIdHash" = encode(sha256(convert_to(NEW."externalId", 'UTF8')), 'hex')) THEN
    RAISE EXCEPTION 'source %: this record was forgotten and stays forgotten', NEW."source" USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "EntitySource_suppressed" BEFORE INSERT ON "EntitySource"
  FOR EACH ROW EXECUTE FUNCTION entity_source_suppressed();

-- ---- Forget (plan 3.0.5) -------------------------------------------------------------------
-- world.forget, with Will's passkey approval, in one transaction. Ledger and
-- later-phase tables are cleared when they exist (to_regclass), so this
-- function does not have to be replaced each time one is added.
CREATE FUNCTION forget_entity(p_entity text, p_approval text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  e "Entity"%ROWTYPE;
  h text;
  n integer;
  counts jsonb := '{}'::jsonb;
  events text[];
BEGIN
  SELECT * INTO e FROM "Entity" WHERE "id" = p_entity FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'forget: no entity %', p_entity;
  END IF;
  IF e."status" = 'forgotten' THEN
    RAISE EXCEPTION 'forget: entity % is already forgotten', p_entity;
  END IF;
  PERFORM consume_approval(p_approval, 'forget', p_entity, 'approve', 'world.forget', NULL);
  PERFORM set_config('flint.forget_approval', p_approval, true);
  h := encode(sha256(convert_to(e."kind" || ':' || e."key", 'UTF8')), 'hex');

  SELECT coalesce(array_agg(DISTINCT x), '{}') INTO events FROM (
    SELECT "sourceEventId" AS x FROM "EntityVersion" WHERE "entityId" = p_entity AND "sourceEventId" IS NOT NULL
    UNION SELECT "sourceEventId" FROM "Relation" WHERE ("fromId" = p_entity OR "toId" = p_entity) AND "sourceEventId" IS NOT NULL
  ) s;

  -- 11. Never recreated by a sync.
  INSERT INTO "SuppressedKey" ("source", "externalIdHash", "approvalId")
  SELECT s."source", encode(sha256(convert_to(s."externalId", 'UTF8')), 'hex'), p_approval
  FROM "EntitySource" s WHERE s."entityId" = p_entity
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('suppressedKeys', n);

  -- 1. The entity becomes a tombstone.
  UPDATE "Entity" SET "name" = 'forgotten:' || left(h, 16), "key" = 'forgotten:' || h, "state" = '{}'::jsonb,
    "stateHash" = encode(sha256(convert_to('{}', 'UTF8')), 'hex'), "status" = 'forgotten', "taintedPaths" = '{}',
    "confidence" = NULL, "version" = e."version" + 1, "lastObservedAt" = now()
  WHERE "id" = p_entity;

  -- 2. Every version loses its content; a tombstone version is appended.
  UPDATE "EntityVersion" SET "state" = NULL, "patch" = NULL WHERE "entityId" = p_entity AND ("state" IS NOT NULL OR "patch" IS NOT NULL);
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('versions', n);
  INSERT INTO "EntityVersion" ("id", "entityId", "version", "changeKind", "actor", "validFrom")
  VALUES ('ev' || replace(gen_random_uuid()::text, '-', ''), p_entity, e."version" + 1, 'forgotten', 'forget:' || p_approval, now());

  -- 3. External ids become hashes.
  UPDATE "EntitySource" SET "externalId" = 'forgotten:' || encode(sha256(convert_to("externalId", 'UTF8')), 'hex')
  WHERE "entityId" = p_entity AND "externalId" NOT LIKE 'forgotten:%';
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('sources', n);

  -- 4. Relations keep their shape, lose their attributes.
  UPDATE "Relation" SET "attrs" = NULL WHERE ("fromId" = p_entity OR "toId" = p_entity) AND "attrs" IS NOT NULL;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('relations', n);

  -- 5. The raw events it came from.
  UPDATE "SourceEvent" SET "payload" = NULL WHERE "id" = ANY (events) AND "payload" IS NOT NULL;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('sourceEvents', n);

  -- 6. Audit entries about it keep their ids and outcome, lose their text.
  UPDATE "AuditEntry" SET "reasoning" = NULL, "outcomeDetail" = NULL, "redactedAt" = now()
  WHERE "correlationId" = p_entity AND "redactedAt" IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('auditEntries', n);

  -- 7, 8, 9. The ledger keeps probabilities and outcomes (calibration needs them), not the words.
  IF to_regclass('public."Prediction"') IS NOT NULL THEN
    EXECUTE 'UPDATE "Prediction" SET "claim" = ''[forgotten]'', "evidence" = ''[]''::jsonb, "resolutionCriteria" = ''[forgotten]''
             WHERE "subjectEntityId" = $1 AND "claim" <> ''[forgotten]''' USING p_entity;
    GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('predictions', n);
    EXECUTE 'UPDATE "Resolution" SET "evidence" = NULL
             WHERE "predictionId" IN (SELECT "id" FROM "Prediction" WHERE "subjectEntityId" = $1) AND "evidence" IS NOT NULL' USING p_entity;
    GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('resolutions', n);
    EXECUTE 'UPDATE "Recommendation" SET "text" = NULL, "rationale" = NULL, "expectedEffect" = NULL, "outcomeNote" = NULL
             WHERE "predictionId" IN (SELECT "id" FROM "Prediction" WHERE "subjectEntityId" = $1)
               AND ("text" IS NOT NULL OR "rationale" IS NOT NULL OR "expectedEffect" IS NOT NULL OR "outcomeNote" IS NOT NULL)' USING p_entity;
    GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('recommendations', n);
  END IF;

  -- 9. Proposals whose args name it.
  UPDATE "Proposal" SET "args" = NULL, "argsPurgedAt" = coalesce("argsPurgedAt", now()), "reason" = NULL, "result" = NULL, "error" = NULL
  WHERE "args" IS NOT NULL AND strpos("args"::text, p_entity) > 0;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('proposals', n);

  -- 10. History rows about it.
  UPDATE "RowChange" SET "changed" = NULL WHERE "rowId" = p_entity AND "changed" IS NOT NULL;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('rowChanges', n);

  -- 12. A record that it happened: ids and counts, no content.
  INSERT INTO "AuditEntry" ("id", "actor", "context", "kind", "action", "inputs", "decision", "outcome", "correlationId")
  VALUES ('au' || replace(gen_random_uuid()::text, '-', ''), 'will', 'console', 'forget', 'world.forget',
          jsonb_build_object('entityId', p_entity, 'approvalId', p_approval, 'counts', counts), 'act', 'ok', p_approval);
  PERFORM set_config('flint.forget_approval', '', true);
  RETURN counts;
END;
$$;

-- ---- Grants -----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION entity_guard(), relation_close_only(), source_enable_guard(), entity_source_suppressed(),
  forget_entity(text, text) FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE ON "Entity", "Relation", "EntitySource", "SourceCursor", "MetricSeries", "BackupRun" TO flint_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "SourceEvent", "MetricPoint" TO flint_app;
GRANT SELECT, INSERT ON "EntityVersion" TO flint_app;
GRANT SELECT ON "SuppressedKey" TO flint_app;
GRANT EXECUTE ON FUNCTION forget_entity(text, text) TO flint_app;
