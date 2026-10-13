-- Reverses policy_off_guard: its triggers and their functions, and P1's own
-- action_policy_matches_approval back to the letter (copied from
-- 20261001000000_p1_governance; the round-trip test compares them). No data is
-- lost, and nothing else of the schema changes. Afterwards, as before it: the
-- runtime's role can switch off any policy row, one that holds an action back
-- included; a card left executing can make its rows again; a signed table can
-- be applied in part; a policy change may be filed with any args; and a row's
-- end is read under the session's own settings again. P1's other rules stay
-- (a row is made only as an executing card lists it, only ever goes off, and
-- is never deleted). A row switched off while the guard was there stays off.
-- It also removes its own row from _prisma_migrations, so the next deploy
-- re-applies it. Every statement tolerates a half-applied state.
DROP TRIGGER IF EXISTS "ActionPolicy_off_guard" ON "ActionPolicy";
DROP TRIGGER IF EXISTS "ActionPolicy_card_actor" ON "ActionPolicy";
DROP TRIGGER IF EXISTS "ActionPolicy_history_actor_back" ON "ActionPolicy";
DROP TRIGGER IF EXISTS "ActionPolicy_whole_card" ON "ActionPolicy";
DROP TRIGGER IF EXISTS "Proposal_policy_shape" ON "Proposal";
DROP FUNCTION IF EXISTS action_policy_off_guard();
DROP FUNCTION IF EXISTS action_policy_actor_back();
DROP FUNCTION IF EXISTS action_policy_whole_card();
DROP FUNCTION IF EXISTS proposal_policy_shape();

-- Only where P1 is there: on an empty database there is no guard to put back.
DO $do$
BEGIN
  IF to_regprocedure('action_policy_matches_approval()') IS NOT NULL THEN
    EXECUTE $fn$
CREATE OR REPLACE FUNCTION action_policy_matches_approval() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $p1$
DECLARE
  a "Approval"%ROWTYPE;
  p "Proposal"%ROWTYPE;
BEGIN
  SELECT * INTO a FROM "Approval" WHERE "id" = NEW."approvalId";
  IF NOT FOUND OR a."decision" <> 'approve' OR a."subjectType" <> 'proposal' THEN
    RAISE EXCEPTION 'policy row: approval % is not an approved proposal', NEW."approvalId" USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO p FROM "Proposal" WHERE "id" = a."subjectId";
  IF NOT FOUND OR p."kind" <> 'policy' OR p."action" <> 'policy.change' OR p."approvalId" IS DISTINCT FROM a."id"
     OR p."status" <> 'executing' OR p."args" IS NULL OR jsonb_typeof(p."args"->'rows') <> 'array' THEN
    RAISE EXCEPTION 'policy row: proposal % is not an approved policy change being executed', a."subjectId" USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(p."args"->'rows') AS r
    WHERE r->>'pattern' = NEW."pattern"
      AND r->>'tier' = NEW."tier"
      AND coalesce(r->'dailyCap', 'null'::jsonb) = coalesce(to_jsonb(NEW."dailyCap"), 'null'::jsonb)
      AND coalesce(r->'scope', 'null'::jsonb) = coalesce(NEW."scope", 'null'::jsonb)
      AND (r->>'expiresAt')::timestamptz = NEW."expiresAt"
  ) THEN
    RAISE EXCEPTION 'policy row %: not in the signed proposal', NEW."pattern" USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."expiresAt" > now() + interval '181 days' THEN
    RAISE EXCEPTION 'policy row %: expires more than 180 days out', NEW."pattern";
  END IF;
  IF NOT NEW."active" THEN
    RAISE EXCEPTION 'policy row %: inserted inactive', NEW."pattern";
  END IF;
  RETURN NEW;
END;
$p1$;
$fn$;
  END IF;
END;
$do$;

DO $$
BEGIN
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    DELETE FROM _prisma_migrations WHERE migration_name = '20261015000200_policy_off_guard';
  END IF;
END;
$$;
