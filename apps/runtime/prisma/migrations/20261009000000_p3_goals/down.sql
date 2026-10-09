-- Reverses p3_goals. Run it only after a pg_dump, and only after deploying a
-- runtime from before P3 with FLINT_PLANNER off: that runtime's job bus does not
-- expect the three goal queues this drops. Goals, their plans and their reviews
-- are lost by design. Their RowChange rows stay (the table is append-only), but
-- those hold lengths only, never text. Their forecasts stay in the ledger,
-- without their goalId. Goal cards stay as proposals: a pending one expires, and
-- one approved while rolled back is refused by the runtime ("not carried out by
-- the runtime"). It also removes its own row from _prisma_migrations, so the
-- next deploy re-applies it. Every statement tolerates a half-applied state.
ALTER TABLE IF EXISTS "Prediction" DROP CONSTRAINT IF EXISTS "Prediction_goal_check", DROP COLUMN IF EXISTS "goalId";
DROP TABLE IF EXISTS "GoalReview", "PlanStep", "Plan", "GoalEntity", "Goal" CASCADE;
-- CASCADE takes the quote floor's trigger on Proposal with its function.
DROP FUNCTION IF EXISTS proposal_quote_check(), p3_signed_proposal(text, text, text[]), p3_step_norm(jsonb), goal_insert_check(), goal_guard(),
  goal_entity_guard(), plan_insert_check(), plan_guard(), plan_step_guard(), goal_review_insert_check(), goal_review_guard(),
  row_history_masked() CASCADE;
DO $$
DECLARE
  q text;
BEGIN
  -- pg-boss's delete_queue fails on a queue that is not there (a half-applied migration),
  -- and its table is not there at all on an empty database: look only once it is.
  IF to_regclass('pgboss.queue') IS NOT NULL THEN
    FOREACH q IN ARRAY ARRAY['goals.plan', 'goals.review', 'goals.tick'] LOOP
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
    DELETE FROM _prisma_migrations WHERE migration_name = '20261009000000_p3_goals';
  END IF;
END;
$$;
