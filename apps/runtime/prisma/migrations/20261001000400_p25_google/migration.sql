-- P2.5: Will's calendar, read-only (the google_calendar source). Untrusted text
-- about an entity (a calendar event's title) lives in EntityText, which can be
-- deleted, never in the world model's append-only history; and a person may
-- come from that source only (PersonGuard, Decision 17). Reversed by down.sql
-- in this directory.

-- CreateTable
CREATE TABLE "EntityText" (
    "entityId" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "tainted" BOOLEAN NOT NULL DEFAULT true,
    "observedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EntityText_pkey" PRIMARY KEY ("entityId","field")
);

-- CreateIndex
CREATE INDEX "EntityText_observedAt_idx" ON "EntityText"("observedAt");

-- AddForeignKey
ALTER TABLE "EntityText" ADD CONSTRAINT "EntityText_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written below this line.

-- Always tainted: whoever wrote an invitation's title, it was not Will's code.
ALTER TABLE "EntityText"
  ADD CONSTRAINT "EntityText_field_check" CHECK ("field" IN ('title')),
  ADD CONSTRAINT "EntityText_text_check" CHECK (char_length("text") BETWEEN 1 AND 300),
  ADD CONSTRAINT "EntityText_source_check" CHECK ("source" ~ '^[a-z_]{1,40}$'),
  ADD CONSTRAINT "EntityText_tainted_check" CHECK ("tainted");

-- The calendar source.
ALTER TABLE "SourceCursor" DROP CONSTRAINT "SourceCursor_source_check",
  ADD CONSTRAINT "SourceCursor_source_check" CHECK ("source" IN ('launchd', 'health', 'git', 'spend', 'github', 'railway', 'nexus', 'google', 'deploy', 'knowledge', 'nexus_inbox', 'google_calendar'));
ALTER TABLE "EntitySource" DROP CONSTRAINT "EntitySource_source_check",
  ADD CONSTRAINT "EntitySource_source_check" CHECK ("source" IN ('launchd', 'health', 'git', 'spend', 'github', 'railway', 'nexus', 'google', 'deploy', 'knowledge', 'nexus_inbox', 'google_calendar'));
SELECT pgboss.create_queue('sync.google_calendar', '{"policy":"singleton","retryLimit":1,"retryDelay":30,"expireInSeconds":600,"deadLetter":"dead"}'::jsonb);

-- ---- PersonGuard (Decision 17) -----------------------------------------------------------------
-- A person comes from Will's calendar and nowhere else: its only source rows are
-- google_calendar, and it cannot exist without one (checked when the transaction
-- that created it commits). Who may be created at all is checked in the runtime.
CREATE FUNCTION person_source_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW."source" <> 'google_calendar' AND EXISTS (SELECT 1 FROM "Entity" WHERE "id" = NEW."entityId" AND "kind" = 'person') THEN
    RAISE EXCEPTION 'a person comes only from the calendar (google_calendar), not %', NEW."source" USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "EntitySource_person_guard" BEFORE INSERT OR UPDATE OF "source", "entityId" ON "EntitySource"
  FOR EACH ROW EXECUTE FUNCTION person_source_guard();

CREATE FUNCTION person_insert_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "EntitySource" WHERE "entityId" = NEW."id" AND "source" = 'google_calendar') THEN
    RAISE EXCEPTION 'a person needs its calendar source (google_calendar)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER "Entity_person_guard" AFTER INSERT ON "Entity" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW."kind" = 'person') EXECUTE FUNCTION person_insert_guard();

-- Forgetting an entity (inside forget_entity, as flint_owner, while its source
-- rows still hold their real ids) also forgets, at once:
--  * its text;
--  * for a calendar event, its heads-ups (named `upcoming:<id>:<when>`, which
--    forget_entity's own `<externalId>@` match does not reach), and the same
--    event under its other kind (a meeting renamed into a deadline, or back, is
--    one event): that key is suppressed, and an entity already made under it is
--    forgotten too, the way forget_entity forgets, and audited as such;
--  * for a person, their name and address on the calendar cards that proposed them.
CREATE FUNCTION entity_forgotten_p25() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  approval text := current_setting('flint.forget_approval', true);
  src record;
  sib record;
  local_id text;
  other_ext text;
  heads text;
  events text[];
  n_versions int;
  n_events int;
BEGIN
  DELETE FROM "EntityText" WHERE "entityId" = NEW."id";
  FOR src IN
    SELECT s."externalId" FROM "EntitySource" s
    WHERE s."entityId" = NEW."id" AND s."source" = 'google_calendar' AND (s."externalId" LIKE 'event:%' OR s."externalId" LIKE 'deadline:%')
  LOOP
    local_id := CASE WHEN src."externalId" LIKE 'event:%' THEN substr(src."externalId", 7) ELSE substr(src."externalId", 10) END;
    other_ext := CASE WHEN src."externalId" LIKE 'event:%' THEN 'deadline:' ELSE 'event:' END || local_id;
    -- The event's heads-ups, both kinds and every re-raise. Matched by their name (the p2 trigger has
    -- already cleared their payloads), with left() and not LIKE: `_` may be in an id.
    heads := 'upcoming:' || local_id || ':';
    SELECT coalesce(array_agg("id"), '{}') INTO events FROM "SourceEvent" WHERE "source" = 'google_calendar' AND left("sourceRef", length(heads)) = heads;
    UPDATE "TriageDecision" SET "reasoning" = NULL WHERE "sourceEventId" = ANY (events) AND "reasoning" IS NOT NULL;
    UPDATE "Escalation" SET "title" = 'Something needs a look', "body" = NULL, "fields" = '{}'::jsonb, "contentPurgedAt" = now()
    WHERE "contentPurgedAt" IS NULL AND "triageDecisionId" IN (SELECT "id" FROM "TriageDecision" WHERE "sourceEventId" = ANY (events));
    UPDATE "SourceEvent" SET "payload" = NULL, "lastError" = NULL, "sourceRef" = 'forgotten:' || encode(sha256(convert_to("sourceRef", 'UTF8')), 'hex')
    WHERE "id" = ANY (events);

    INSERT INTO "SuppressedKey" ("source", "externalIdHash", "approvalId")
    VALUES ('google_calendar', encode(sha256(convert_to(other_ext, 'UTF8')), 'hex'), approval)
    ON CONFLICT DO NOTHING;
    -- The other kind's entity, if one was made: locked (a sync may be changing it), forgotten as well, and
    -- audited (its own trigger then finds this one already forgotten).
    FOR sib IN
      SELECT e."id", e."kind", e."key", e."version", s."externalId" FROM "Entity" e JOIN "EntitySource" s ON s."entityId" = e."id"
      WHERE s."source" = 'google_calendar' AND s."externalId" = other_ext AND e."status" <> 'forgotten'
      FOR UPDATE OF e
    LOOP
      SELECT coalesce(array_agg(DISTINCT x), '{}') INTO events FROM (
        SELECT "sourceEventId" AS x FROM "EntityVersion" WHERE "entityId" = sib."id" AND "sourceEventId" IS NOT NULL
        UNION SELECT ev."id" FROM "SourceEvent" ev WHERE ev."source" = 'google_calendar' AND left(ev."sourceRef", length(sib."externalId") + 1) = sib."externalId" || '@'
        UNION SELECT ev."id" FROM "SourceEvent" ev WHERE ev."payload"->>'entityId' = sib."id"
      ) q;
      UPDATE "Entity" SET "name" = 'forgotten:' || left(encode(sha256(convert_to(sib."kind" || ':' || sib."key", 'UTF8')), 'hex'), 16),
        "key" = 'forgotten:' || encode(sha256(convert_to(sib."kind" || ':' || sib."key", 'UTF8')), 'hex'), "state" = '{}'::jsonb,
        "stateHash" = encode(sha256(convert_to('{}', 'UTF8')), 'hex'), "status" = 'forgotten', "taintedPaths" = '{}',
        "confidence" = NULL, "mergedIntoId" = NULL, "version" = sib."version" + 1, "lastObservedAt" = now()
      WHERE "id" = sib."id";
      UPDATE "EntityVersion" SET "state" = NULL, "patch" = NULL WHERE "entityId" = sib."id" AND ("state" IS NOT NULL OR "patch" IS NOT NULL);
      GET DIAGNOSTICS n_versions = ROW_COUNT;
      INSERT INTO "EntityVersion" ("id", "entityId", "version", "changeKind", "actor", "validFrom")
      VALUES ('ev' || replace(gen_random_uuid()::text, '-', ''), sib."id", sib."version" + 1, 'forgotten', 'forget:' || approval, now());
      UPDATE "EntitySource" SET "externalId" = 'forgotten:' || encode(sha256(convert_to("externalId", 'UTF8')), 'hex'), "namespace" = NULL
      WHERE "entityId" = sib."id" AND "externalId" NOT LIKE 'forgotten:%';
      UPDATE "SourceEvent" SET "payload" = NULL, "lastError" = NULL,
        "sourceRef" = CASE WHEN "sourceRef" LIKE 'forgotten:%' THEN "sourceRef" ELSE 'forgotten:' || encode(sha256(convert_to("sourceRef", 'UTF8')), 'hex') END
      WHERE "id" = ANY (events) AND ("payload" IS NOT NULL OR "lastError" IS NOT NULL OR "sourceRef" NOT LIKE 'forgotten:%');
      GET DIAGNOSTICS n_events = ROW_COUNT;
      UPDATE "AuditEntry" SET "reasoning" = NULL, "outcomeDetail" = NULL, "redactedAt" = now()
      WHERE "correlationId" = sib."id" AND "redactedAt" IS NULL;
      INSERT INTO "AuditEntry" ("id", "actor", "context", "kind", "action", "inputs", "decision", "outcome", "correlationId")
      VALUES ('au' || replace(gen_random_uuid()::text, '-', ''), 'will', 'console', 'forget', 'world.forget',
              jsonb_build_object('entityId', sib."id", 'cascadeOf', NEW."id", 'approvalId', approval,
                                 'counts', jsonb_build_object('versions', n_versions, 'sourceEvents', n_events)), 'act', 'ok', approval);
    END LOOP;
  END LOOP;
  IF OLD."kind" = 'person' AND OLD."state"->>'emailHash' IS NOT NULL THEN
    UPDATE "Proposal" SET "args" = NULL, "argsPurgedAt" = coalesce("argsPurgedAt", now()), "reason" = NULL, "result" = NULL, "error" = NULL
    WHERE "action" = 'world.person.create' AND "args" IS NOT NULL
      AND jsonb_path_exists("args", '$.people[*] ? (@.emailHash == $h)', jsonb_build_object('h', OLD."state"->>'emailHash'));
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER "Entity_forgotten_p25" AFTER UPDATE OF "status" ON "Entity"
  FOR EACH ROW WHEN (NEW."status" = 'forgotten' AND OLD."status" <> 'forgotten') EXECUTE FUNCTION entity_forgotten_p25();

-- ---- Grants ------------------------------------------------------------------------------------
REVOKE ALL ON FUNCTION person_source_guard(), person_insert_guard(), entity_forgotten_p25() FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON "EntityText" TO flint_app;
