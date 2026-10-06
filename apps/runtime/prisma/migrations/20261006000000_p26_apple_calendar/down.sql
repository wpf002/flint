-- Reverses p26_apple_calendar. Run only after a pg_dump, and only after
-- deploying a runtime from before P2.6 (P2.6's job bus expects the Apple
-- Calendar queue this drops). PersonGuard and the forget trigger go back to
-- P2.5's bodies exactly (copied from 20261001000400_p25_google), and the Apple
-- Calendar cursor and its queue go. Entities it made stay (an entity is never
-- deleted), and so do their apple_calendar source rows (the source list keeps
-- allowing them), so a forget made while rolled back still suppresses them for
-- good; their titles go with the nightly retention. It also removes its own row
-- from _prisma_migrations, so the next deploy re-applies it.
CREATE OR REPLACE FUNCTION person_source_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW."source" <> 'google_calendar' AND EXISTS (SELECT 1 FROM "Entity" WHERE "id" = NEW."entityId" AND "kind" = 'person') THEN
    RAISE EXCEPTION 'a person comes only from the calendar (google_calendar), not %', NEW."source" USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION person_insert_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "EntitySource" WHERE "entityId" = NEW."id" AND "source" = 'google_calendar') THEN
    RAISE EXCEPTION 'a person needs its calendar source (google_calendar)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NULL;
END;
$$;

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
    -- The other kind's entity, if one was made: locked (a sync may be changing it; its source row first,
    -- in the order a sync takes them), forgotten as well, and audited (its own trigger then finds this one
    -- already forgotten).
    PERFORM 1 FROM "EntitySource" WHERE "source" = 'google_calendar' AND "externalId" = other_ext FOR UPDATE;
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
DO $$
BEGIN
  -- pg-boss's delete_queue fails on a queue that is not there (a half-applied migration).
  IF to_regclass('pgboss.queue') IS NOT NULL AND EXISTS (SELECT 1 FROM pgboss.queue WHERE name = 'sync.apple_calendar') THEN
    PERFORM pgboss.delete_queue('sync.apple_calendar');
  END IF;
END;
$$;
-- P2.5's cursor list again (no Apple Calendar cursor); the source rows' list keeps apple_calendar (see above).
DELETE FROM "SourceCursor" WHERE "source" = 'apple_calendar';
ALTER TABLE "SourceCursor" DROP CONSTRAINT "SourceCursor_source_check",
  ADD CONSTRAINT "SourceCursor_source_check" CHECK ("source" IN ('launchd', 'health', 'git', 'spend', 'github', 'railway', 'nexus', 'google', 'deploy', 'knowledge', 'nexus_inbox', 'google_calendar'));
DO $$
BEGIN
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    DELETE FROM _prisma_migrations WHERE migration_name = '20261006000000_p26_apple_calendar';
  END IF;
END;
$$;
