-- Reverses p2_runtime. Run only after a pg_dump: this drops every triage
-- decision, escalation and queued job. P1 data is untouched. It also removes
-- its own row from _prisma_migrations, so the next deploy re-applies it.
DROP SCHEMA IF EXISTS pgboss CASCADE;
DROP TRIGGER IF EXISTS "Entity_forgotten_p2" ON "Entity";
DROP TABLE IF EXISTS "EscalationDelivery", "Escalation", "TriageDecision", "TriageRule", "RuntimeInstance", "HealthCheck" CASCADE;
DROP FUNCTION IF EXISTS count_action(text, text), triage_rule_matches_approval(), triage_rule_update_guard(), triage_decision_guard(),
  escalation_guard(), escalation_delivery_guard(), entity_forgotten_p2() CASCADE;
-- P1's counter keys and source lists again. Only where P1's tables are: on an empty database (the test
-- helpers' first run) there is nothing to put back, and a statement on a table that is not there would fail.
DO $p2$
BEGIN
  IF to_regclass('public."ActionCounter"') IS NOT NULL THEN
    DELETE FROM "ActionCounter" WHERE "day" ~ 'T\d{2}$';
    ALTER TABLE "ActionCounter" DROP CONSTRAINT IF EXISTS "ActionCounter_day_check",
      ADD CONSTRAINT "ActionCounter_day_check" CHECK ("day" ~ '^\d{4}-(\d{2}-\d{2}|W\d{2})$');
  END IF;
  IF to_regclass('public."SourceCursor"') IS NOT NULL THEN
    DELETE FROM "SourceCursor" WHERE "source" IN ('deploy', 'knowledge', 'nexus_inbox');
  END IF;
  -- Source rows of later sources (P2.5's google_calendar, which its own down keeps) go with a rollback to P1.
  IF to_regclass('public."EntitySource"') IS NOT NULL THEN
    DELETE FROM "EntitySource" WHERE "source" NOT IN ('launchd', 'health', 'git', 'spend', 'github', 'railway', 'nexus', 'google');
  END IF;
  IF to_regclass('public."SourceCursor"') IS NOT NULL THEN
    ALTER TABLE "SourceCursor" DROP CONSTRAINT IF EXISTS "SourceCursor_source_check",
      ADD CONSTRAINT "SourceCursor_source_check" CHECK ("source" IN ('launchd', 'health', 'git', 'spend', 'github', 'railway', 'nexus', 'google'));
  END IF;
  IF to_regclass('public."EntitySource"') IS NOT NULL THEN
    ALTER TABLE "EntitySource" DROP CONSTRAINT IF EXISTS "EntitySource_source_check",
      ADD CONSTRAINT "EntitySource_source_check" CHECK ("source" IN ('launchd', 'health', 'git', 'spend', 'github', 'railway', 'nexus', 'google'));
  END IF;
END;
$p2$;
DO $$
BEGIN
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    DELETE FROM _prisma_migrations WHERE migration_name = '20261001000300_p2_runtime';
  END IF;
END;
$$;
