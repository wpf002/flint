-- Reverses p5_assets. Run it only after a pg_dump, and only after deploying a
-- runtime from before P5: that runtime's job bus does not expect the four queues
-- this drops, and its Prisma client does not know Proposal.reviewId. Lost by
-- design: assets (and which were on), tasks and their outputs, reviews, the
-- review gate, and the record of which approvals they used. What stays: every
-- card (a pending task or asset card expires on its own; one approved while
-- rolled back is refused by the runtime, "not carried out by the runtime"),
-- though it loses its review and whether it needed one; every task forecast and
-- its resolution, in the ledger; and the history in RowChange (the table is
-- append-only: a task's rows hold lengths only, never text). The record of used
-- approvals goes with its table, so a task, asset or review card that is
-- approved or running could act once more after a re-deploy. So this refuses to
-- run while one is: let each finish, fail or expire first (a week at most after
-- it was signed), and then run it again. plan_step_guard goes back to P3's own
-- body, to the letter (copied from 20261009000000_p3_goals; the round-trip test
-- compares them): a step that is a Flint task is then held by nothing but the
-- console, as before P5. The time on an approval is again whatever the role
-- that records it sends (Approval_clock goes; the server sends none, so the
-- column's default dates it). It also removes its own row from
-- _prisma_migrations, so the next deploy re-applies it. Every statement
-- tolerates a half-applied state, and an empty database.

-- Nothing is dropped while a card of this migration's could still act: its one use is on record only in a
-- table this drops. (Looked at only where both tables are there: an empty or half-applied database has none.)
DO $do$
DECLARE
  n integer;
BEGIN
  IF to_regclass('public."Proposal"') IS NOT NULL AND to_regclass('public."TaskApprovalUse"') IS NOT NULL THEN
    SELECT count(*) INTO n FROM "Proposal"
    WHERE "status" IN ('approved', 'executing')
      AND ("kind" IN ('task', 'spend') OR "action" ~ '^(task[.]|asset[.]enable$|review[.])' OR "action" = 'hive.dispatch_job');
    IF n > 0 THEN
      RAISE EXCEPTION 'p5_assets is not rolled back while % task, asset or review card(s) are approved or running: let each finish, fail or expire first', n
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
  END IF;
END;
$do$;

-- Only where P3 is there: on an empty database there is no plan_step_guard to put back.
DO $do$
BEGIN
  IF to_regprocedure('plan_step_guard()') IS NOT NULL THEN
    EXECUTE $fn$
CREATE OR REPLACE FUNCTION plan_step_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $p3$
DECLARE
  mutable text[] := ARRAY['status', 'doneAt', 'doneAuditId', 'proposalId', 'taskId'];
  pl "Plan"%ROWTYPE;
  goal text;
  mine boolean;
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'plan steps are never deleted (a step is skipped)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'plan %: steps are written at read committed only', NEW."planId" USING ERRCODE = 'serialization_failure';
  END IF;
  SELECT "goalId" INTO goal FROM "Plan" WHERE "id" = NEW."planId";
  -- FOR NO KEY UPDATE, not FOR SHARE: two step writes that then each record progress on the goal would both hold
  -- a share lock and wait on each other's upgrade. Taken this way, the second waits for the first to finish.
  PERFORM 1 FROM "Goal" WHERE "id" = goal FOR NO KEY UPDATE;
  SELECT * INTO pl FROM "Plan" WHERE "id" = NEW."planId" FOR SHARE;
  IF TG_OP = 'INSERT' THEN
    SELECT "xmin" = pg_current_xact_id()::xid INTO mine FROM "Plan" WHERE "id" = NEW."planId";
    IF NOT FOUND OR pl."status" <> 'draft' OR NOT coalesce(mine, false) THEN
      RAISE EXCEPTION 'plan %: steps are written only into a draft this transaction made', NEW."planId" USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSE
    IF (to_jsonb(NEW) - mutable) IS DISTINCT FROM (to_jsonb(OLD) - mutable) THEN
      RAISE EXCEPTION 'step %: only its progress changes', OLD."id" USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF pl."status" = 'draft' THEN
      RAISE EXCEPTION 'step %: a draft''s steps are written once', OLD."id" USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF pl."status" <> 'active' THEN
      RAISE EXCEPTION 'step %: plan % is no longer the active plan', OLD."id", OLD."planId" USING ERRCODE = 'serialization_failure';
    END IF;
    IF to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) AND (OLD."status" = 'skipped' OR NEW."status" = 'skipped') THEN
      RAISE EXCEPTION 'step %: skipping a step, or bringing one back, is a signed plan change', OLD."id" USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  IF NEW."kind" = 'flint_action' AND NEW."status" = 'done'
     AND (TG_OP = 'INSERT' OR OLD."status" <> 'done' OR NEW."doneAuditId" IS DISTINCT FROM OLD."doneAuditId")
     AND NOT EXISTS (
       SELECT 1 FROM "AuditEntry" a
       WHERE a."id" = NEW."doneAuditId" AND a."kind" = 'action' AND a."outcome" = 'ok' AND a."correlationId" = pl."goalId" || ':' || NEW."key"
     )
     AND NOT (TG_OP = 'INSERT' AND EXISTS (
       SELECT 1 FROM "PlanStep" o JOIN "Plan" op ON op."id" = o."planId"
       WHERE op."goalId" = pl."goalId" AND op."approvalId" IS NOT NULL AND o."key" = NEW."key" AND o."kind" = 'flint_action'
         AND o."status" = 'done' AND o."doneAuditId" = NEW."doneAuditId"
     )) THEN
    RAISE EXCEPTION 'step %: a Flint action is done only with its own successful action on record', NEW."id" USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$p3$
    $fn$;
  END IF;
END;
$do$;

DROP VIEW IF EXISTS review_gate_violations;
DROP VIEW IF EXISTS review_coverage;
-- The triggers this put on older tables.
DROP TRIGGER IF EXISTS "Proposal_valid_p5" ON "Proposal";
DROP TRIGGER IF EXISTS "Proposal_review_guard" ON "Proposal";
DROP TRIGGER IF EXISTS "Proposal_review_floor" ON "Proposal";
DROP TRIGGER IF EXISTS "Proposal_p5_digest_check" ON "Proposal";
DROP TRIGGER IF EXISTS "Entity_forgotten_p5" ON "Entity";
DROP TRIGGER IF EXISTS "Resolution_for_task" ON "Resolution";
DROP TRIGGER IF EXISTS "Approval_clock" ON "Approval";
ALTER TABLE IF EXISTS "Proposal" DROP CONSTRAINT IF EXISTS "Proposal_reviewId_fkey", DROP COLUMN IF EXISTS "reviewId", DROP COLUMN IF EXISTS "reviewRequired";
DROP TABLE IF EXISTS "TaskOutput", "Task", "Asset", "Review", "ReviewGate", "TaskApprovalUse" CASCADE;
DROP FUNCTION IF EXISTS p5_signed_proposal(text, text, text, text[]), p5_bind_approval(text, text, text, text), p5_digest_check(), p5_card_valid(),
  asset_insert_check(), asset_guard(), task_insert_check(), task_guard(), task_valid(), task_output_guard(), review_insert_check(),
  review_guard(), review_valid(), review_gate_guard(), proposal_review_floor(), proposal_review_guard(), entity_forgotten_p5(),
  resolution_task_check(), task_step_undone(), approval_clock() CASCADE;
DO $$
DECLARE
  q text;
BEGIN
  -- pg-boss's delete_queue fails on a queue that is not there (a half-applied migration),
  -- and its table is not there at all on an empty database: look only once it is.
  IF to_regclass('pgboss.queue') IS NOT NULL THEN
    FOREACH q IN ARRAY ARRAY['reviews.run', 'tasks.check', 'tasks.run', 'tasks.tick'] LOOP
      IF EXISTS (SELECT 1 FROM pgboss.queue WHERE name = q) THEN
        PERFORM pgboss.delete_queue(q);
      END IF;
    END LOOP;
  END IF;
END;
$$;
DO $$
BEGIN
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    DELETE FROM _prisma_migrations WHERE migration_name = '20261014000000_p5_assets';
  END IF;
END;
$$;
