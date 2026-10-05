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
--  * for a calendar event, the event under its other kind: an event renamed
--    from a meeting into a deadline (or back) is the same event, still forgotten;
--  * for a person, their name and address on the calendar cards that proposed them.
CREATE FUNCTION entity_forgotten_p25() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  DELETE FROM "EntityText" WHERE "entityId" = NEW."id";
  INSERT INTO "SuppressedKey" ("source", "externalIdHash", "approvalId")
  SELECT 'google_calendar',
         encode(sha256(convert_to(CASE WHEN s."externalId" LIKE 'event:%' THEN 'deadline:' || substr(s."externalId", 7)
                                       ELSE 'event:' || substr(s."externalId", 10) END, 'UTF8')), 'hex'),
         current_setting('flint.forget_approval', true)
  FROM "EntitySource" s
  WHERE s."entityId" = NEW."id" AND s."source" = 'google_calendar' AND (s."externalId" LIKE 'event:%' OR s."externalId" LIKE 'deadline:%')
  ON CONFLICT DO NOTHING;
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
