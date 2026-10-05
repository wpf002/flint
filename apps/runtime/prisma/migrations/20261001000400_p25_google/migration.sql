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
--  * for a calendar event, the same event under its other kind (a meeting renamed
--    into a deadline, or back, is one event): that key is suppressed, and an
--    entity already made under it is forgotten too, the way forget_entity forgets;
--  * for a person, their name and address on the calendar cards that proposed them.
CREATE FUNCTION entity_forgotten_p25() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  approval text := current_setting('flint.forget_approval', true);
  other record;
  sib record;
  events text[];
BEGIN
  DELETE FROM "EntityText" WHERE "entityId" = NEW."id";
  FOR other IN
    SELECT CASE WHEN s."externalId" LIKE 'event:%' THEN 'deadline:' || substr(s."externalId", 7)
                ELSE 'event:' || substr(s."externalId", 10) END AS ext
    FROM "EntitySource" s
    WHERE s."entityId" = NEW."id" AND s."source" = 'google_calendar' AND (s."externalId" LIKE 'event:%' OR s."externalId" LIKE 'deadline:%')
  LOOP
    INSERT INTO "SuppressedKey" ("source", "externalIdHash", "approvalId")
    VALUES ('google_calendar', encode(sha256(convert_to(other.ext, 'UTF8')), 'hex'), approval)
    ON CONFLICT DO NOTHING;
    -- The other kind's entity, if one was made: forgotten as well (its own trigger then finds this one already forgotten).
    FOR sib IN
      SELECT e."id", e."kind", e."key", e."version", s."externalId" FROM "Entity" e JOIN "EntitySource" s ON s."entityId" = e."id"
      WHERE s."source" = 'google_calendar' AND s."externalId" = other.ext AND e."status" <> 'forgotten'
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
      INSERT INTO "EntityVersion" ("id", "entityId", "version", "changeKind", "actor", "validFrom")
      VALUES ('ev' || replace(gen_random_uuid()::text, '-', ''), sib."id", sib."version" + 1, 'forgotten', 'forget:' || approval, now());
      UPDATE "EntitySource" SET "externalId" = 'forgotten:' || encode(sha256(convert_to("externalId", 'UTF8')), 'hex'), "namespace" = NULL
      WHERE "entityId" = sib."id" AND "externalId" NOT LIKE 'forgotten:%';
      UPDATE "SourceEvent" SET "payload" = NULL, "lastError" = NULL,
        "sourceRef" = CASE WHEN "sourceRef" LIKE 'forgotten:%' THEN "sourceRef" ELSE 'forgotten:' || encode(sha256(convert_to("sourceRef", 'UTF8')), 'hex') END
      WHERE "id" = ANY (events) AND ("payload" IS NOT NULL OR "lastError" IS NOT NULL OR "sourceRef" NOT LIKE 'forgotten:%');
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
