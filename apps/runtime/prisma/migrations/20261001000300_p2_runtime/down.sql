-- Reverses p2_runtime. Run only after a pg_dump: this drops every triage
-- decision, escalation and queued job. P1 data is untouched. It also removes
-- its own row from _prisma_migrations, so the next deploy re-applies it.
DROP SCHEMA IF EXISTS pgboss CASCADE;
DROP TRIGGER IF EXISTS "Entity_forgotten_p2" ON "Entity";
DROP TABLE IF EXISTS "EscalationDelivery", "Escalation", "TriageDecision", "TriageRule", "RuntimeInstance", "HealthCheck" CASCADE;
DROP FUNCTION IF EXISTS count_action(text, text), triage_rule_matches_approval(), triage_rule_update_guard(), triage_decision_guard(),
  escalation_guard(), escalation_delivery_guard(), entity_forgotten_p2() CASCADE;
-- P1's counter keys and source lists again.
DELETE FROM "ActionCounter" WHERE "day" ~ 'T\d{2}$';
ALTER TABLE "ActionCounter" DROP CONSTRAINT "ActionCounter_day_check",
  ADD CONSTRAINT "ActionCounter_day_check" CHECK ("day" ~ '^\d{4}-(\d{2}-\d{2}|W\d{2})$');
DELETE FROM "SourceCursor" WHERE "source" IN ('deploy', 'knowledge', 'nexus_inbox');
ALTER TABLE "SourceCursor" DROP CONSTRAINT "SourceCursor_source_check",
  ADD CONSTRAINT "SourceCursor_source_check" CHECK ("source" IN ('launchd', 'health', 'git', 'spend', 'github', 'railway', 'nexus', 'google'));
ALTER TABLE "EntitySource" DROP CONSTRAINT "EntitySource_source_check",
  ADD CONSTRAINT "EntitySource_source_check" CHECK ("source" IN ('launchd', 'health', 'git', 'spend', 'github', 'railway', 'nexus', 'google'));
DO $$
BEGIN
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    DELETE FROM _prisma_migrations WHERE migration_name = '20261001000300_p2_runtime';
  END IF;
END;
$$;
