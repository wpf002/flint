-- P2.6: Will's Apple Calendar, read-only (the apple_calendar source). Flint
-- Calendar, a helper on the Mac, pushes what it reads to the runtime, which
-- maps it the way it maps Google's. This adds the source to the source lists
-- and its job queue, and lets a person come from either of Will's calendars
-- (PersonGuard, Decision 17), each checked against its own. Hand-written: no
-- tables and no grants (CREATE OR REPLACE keeps each function's owner and its
-- REVOKE FROM PUBLIC). Reversed by down.sql in this directory.

-- The calendar source.
ALTER TABLE "SourceCursor" DROP CONSTRAINT "SourceCursor_source_check",
  ADD CONSTRAINT "SourceCursor_source_check" CHECK ("source" IN ('launchd', 'health', 'git', 'spend', 'github', 'railway', 'nexus', 'google', 'deploy', 'knowledge', 'nexus_inbox', 'google_calendar', 'apple_calendar'));
ALTER TABLE "EntitySource" DROP CONSTRAINT "EntitySource_source_check",
  ADD CONSTRAINT "EntitySource_source_check" CHECK ("source" IN ('launchd', 'health', 'git', 'spend', 'github', 'railway', 'nexus', 'google', 'deploy', 'knowledge', 'nexus_inbox', 'google_calendar', 'apple_calendar'));
SELECT pgboss.create_queue('sync.apple_calendar', '{"policy":"singleton","retryLimit":1,"retryDelay":30,"expireInSeconds":600,"deadLetter":"dead"}'::jsonb);

-- ---- PersonGuard (Decision 17), for both calendars ----------------------------------------------
-- A person comes from Will's calendars and nowhere else: its only source rows are
-- google_calendar or apple_calendar, and it cannot exist without one (checked when
-- the transaction that created it commits). Who may be created at all, and from
-- which calendar, is checked in the runtime (an attendee of an event from that
-- same calendar).
CREATE OR REPLACE FUNCTION person_source_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW."source" NOT IN ('google_calendar', 'apple_calendar') AND EXISTS (SELECT 1 FROM "Entity" WHERE "id" = NEW."entityId" AND "kind" = 'person') THEN
    RAISE EXCEPTION 'a person comes only from the calendar (google_calendar, apple_calendar), not %', NEW."source" USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION person_insert_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "EntitySource" WHERE "entityId" = NEW."id" AND "source" IN ('google_calendar', 'apple_calendar')) THEN
    RAISE EXCEPTION 'a person needs its calendar source (google_calendar or apple_calendar)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NULL;
END;
$$;

-- Forgetting an entity (inside forget_entity, as flint_owner, while its source
-- rows still hold their real ids) also forgets, at once:
--  * its text;
--  * for an event from either calendar, its heads-ups (named `upcoming:<id>:<when>`,
--    which forget_entity's own `<externalId>@` match does not reach), and the same
--    event under its other kind (a meeting renamed into a deadline, or back, is
--    one event): that key is suppressed, and an entity already made under it is
--    forgotten too, the way forget_entity forgets, and audited as such. Each is
--    looked for under the calendar its source row names;
--  * for a person, their name and address on the calendar cards that proposed
--    them, and the person under both calendars: someone Will forgot from one
--    calendar never comes back through the other (the runtime refuses them too),
--    and their entity from the other calendar, if one was made, is forgotten
--    too, the way forget_entity forgets, and audited as such.
CREATE OR REPLACE FUNCTION entity_forgotten_p25() RETURNS trigger
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
    SELECT s."externalId", s."source" FROM "EntitySource" s
    WHERE s."entityId" = NEW."id" AND s."source" IN ('google_calendar', 'apple_calendar') AND (s."externalId" LIKE 'event:%' OR s."externalId" LIKE 'deadline:%')
  LOOP
    local_id := CASE WHEN src."externalId" LIKE 'event:%' THEN substr(src."externalId", 7) ELSE substr(src."externalId", 10) END;
    other_ext := CASE WHEN src."externalId" LIKE 'event:%' THEN 'deadline:' ELSE 'event:' END || local_id;
    -- The event's heads-ups, both kinds and every re-raise. Matched by their name (the p2 trigger has
    -- already cleared their payloads), with left() and not LIKE: `_` may be in an id.
    heads := 'upcoming:' || local_id || ':';
    SELECT coalesce(array_agg("id"), '{}') INTO events FROM "SourceEvent" WHERE "source" = src."source" AND left("sourceRef", length(heads)) = heads;
    UPDATE "TriageDecision" SET "reasoning" = NULL WHERE "sourceEventId" = ANY (events) AND "reasoning" IS NOT NULL;
    UPDATE "Escalation" SET "title" = 'Something needs a look', "body" = NULL, "fields" = '{}'::jsonb, "contentPurgedAt" = now()
    WHERE "contentPurgedAt" IS NULL AND "triageDecisionId" IN (SELECT "id" FROM "TriageDecision" WHERE "sourceEventId" = ANY (events));
    UPDATE "SourceEvent" SET "payload" = NULL, "lastError" = NULL, "sourceRef" = 'forgotten:' || encode(sha256(convert_to("sourceRef", 'UTF8')), 'hex')
    WHERE "id" = ANY (events);

    INSERT INTO "SuppressedKey" ("source", "externalIdHash", "approvalId")
    VALUES (src."source", encode(sha256(convert_to(other_ext, 'UTF8')), 'hex'), approval)
    ON CONFLICT DO NOTHING;
    -- The other kind's entity, if one was made: locked (a sync may be changing it; its source row first,
    -- in the order a sync takes them), forgotten as well, and audited (its own trigger then finds this one
    -- already forgotten).
    PERFORM 1 FROM "EntitySource" WHERE "source" = src."source" AND "externalId" = other_ext FOR UPDATE;
    FOR sib IN
      SELECT e."id", e."kind", e."key", e."version", s."externalId" FROM "Entity" e JOIN "EntitySource" s ON s."entityId" = e."id"
      WHERE s."source" = src."source" AND s."externalId" = other_ext AND e."status" <> 'forgotten'
      FOR UPDATE OF e
    LOOP
      SELECT coalesce(array_agg(DISTINCT x), '{}') INTO events FROM (
        SELECT "sourceEventId" AS x FROM "EntityVersion" WHERE "entityId" = sib."id" AND "sourceEventId" IS NOT NULL
        UNION SELECT ev."id" FROM "SourceEvent" ev WHERE ev."source" = src."source" AND left(ev."sourceRef", length(sib."externalId") + 1) = sib."externalId" || '@'
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
    -- Under both calendars (a person's external id is `person:<hash>` in either).
    INSERT INTO "SuppressedKey" ("source", "externalIdHash", "approvalId")
    SELECT c."source", encode(sha256(convert_to('person:' || (OLD."state"->>'emailHash'), 'UTF8')), 'hex'), approval
    FROM (VALUES ('google_calendar'), ('apple_calendar')) AS c("source")
    ON CONFLICT DO NOTHING;
    UPDATE "Proposal" SET "args" = NULL, "argsPurgedAt" = coalesce("argsPurgedAt", now()), "reason" = NULL, "result" = NULL, "error" = NULL
    WHERE "action" = 'world.person.create' AND "args" IS NOT NULL
      AND jsonb_path_exists("args", '$.people[*] ? (@.emailHash == $h)', jsonb_build_object('h', OLD."state"->>'emailHash'));
    -- The same person under the other calendar (someone in both is two entities), if one was made: locked
    -- (its source row first, in the order a sync takes them), forgotten as well, and audited (its own trigger
    -- then finds this one already forgotten).
    other_ext := 'person:' || (OLD."state"->>'emailHash');
    PERFORM 1 FROM "EntitySource" WHERE "source" IN ('google_calendar', 'apple_calendar') AND "externalId" = other_ext FOR UPDATE;
    FOR sib IN
      SELECT e."id", e."kind", e."key", e."version", s."externalId", s."source" FROM "Entity" e JOIN "EntitySource" s ON s."entityId" = e."id"
      WHERE s."source" IN ('google_calendar', 'apple_calendar') AND s."externalId" = other_ext
        AND e."kind" = 'person' AND e."id" <> NEW."id" AND e."status" <> 'forgotten'
      FOR UPDATE OF e
    LOOP
      SELECT coalesce(array_agg(DISTINCT x), '{}') INTO events FROM (
        SELECT "sourceEventId" AS x FROM "EntityVersion" WHERE "entityId" = sib."id" AND "sourceEventId" IS NOT NULL
        UNION SELECT "sourceEventId" FROM "Relation" WHERE ("fromId" = sib."id" OR "toId" = sib."id") AND "sourceEventId" IS NOT NULL
        UNION SELECT ev."id" FROM "SourceEvent" ev WHERE ev."source" = sib."source" AND left(ev."sourceRef", length(sib."externalId") + 1) = sib."externalId" || '@'
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
      UPDATE "Relation" SET "attrs" = NULL WHERE ("fromId" = sib."id" OR "toId" = sib."id") AND "attrs" IS NOT NULL;
      UPDATE "SourceEvent" SET "payload" = NULL, "lastError" = NULL,
        "sourceRef" = CASE WHEN "sourceRef" LIKE 'forgotten:%' THEN "sourceRef" ELSE 'forgotten:' || encode(sha256(convert_to("sourceRef", 'UTF8')), 'hex') END
      WHERE "id" = ANY (events) AND ("payload" IS NOT NULL OR "lastError" IS NOT NULL OR "sourceRef" NOT LIKE 'forgotten:%');
      GET DIAGNOSTICS n_events = ROW_COUNT;
      UPDATE "Proposal" SET "args" = NULL, "argsPurgedAt" = coalesce("argsPurgedAt", now()), "reason" = NULL, "result" = NULL, "error" = NULL
      WHERE "args" IS NOT NULL AND strpos("args"::text, sib."id") > 0;
      UPDATE "AuditEntry" SET "reasoning" = NULL, "outcomeDetail" = NULL, "redactedAt" = now()
      WHERE "correlationId" = sib."id" AND "redactedAt" IS NULL;
      INSERT INTO "AuditEntry" ("id", "actor", "context", "kind", "action", "inputs", "decision", "outcome", "correlationId")
      VALUES ('au' || replace(gen_random_uuid()::text, '-', ''), 'will', 'console', 'forget', 'world.forget',
              jsonb_build_object('entityId', sib."id", 'cascadeOf', NEW."id", 'approvalId', approval,
                                 'counts', jsonb_build_object('versions', n_versions, 'sourceEvents', n_events)), 'act', 'ok', approval);
    END LOOP;
  END IF;
  RETURN NULL;
END;
$$;

-- People Will forgot before this (P2.5's trigger suppressed them under their own calendar only), or while it
-- was rolled back: suppressed under both calendars, as every forget is from now on. A forgotten person's
-- calendar source row is `forgotten:<sha256 of person:<hash>>`, and that digest is its suppressed key.
INSERT INTO "SuppressedKey" ("source", "externalIdHash", "approvalId")
SELECT c."source", k."externalIdHash", k."approvalId"
FROM "Entity" e
JOIN "EntitySource" es ON es."entityId" = e."id" AND es."source" IN ('google_calendar', 'apple_calendar') AND left(es."externalId", 10) = 'forgotten:'
JOIN "SuppressedKey" k ON k."source" = es."source" AND k."externalIdHash" = substr(es."externalId", 11)
CROSS JOIN (VALUES ('google_calendar'), ('apple_calendar')) AS c("source")
WHERE e."kind" = 'person' AND e."status" = 'forgotten'
ON CONFLICT DO NOTHING;
