-- Reverses p3_chat_goal_floor: its two triggers and their function. No data is
-- lost, and nothing else of the schema changes: a goal from chat is then held
-- by the runtime alone, as before, and the runtime (which reads whether the
-- floor is there) goes back to filing a card for every suggestion and refusing
-- the later promotion table. The record of which approvals were used stays, so
-- a card that added its goal is still used after a re-deploy. It also removes
-- its own row from _prisma_migrations, so the next deploy re-applies it. Every
-- statement tolerates a half-applied state.
DROP TRIGGER IF EXISTS "Goal_chat_floor" ON "Goal";
DROP TRIGGER IF EXISTS "Goal_chat_floor_bind" ON "Goal";
DROP FUNCTION IF EXISTS goal_chat_floor();
DO $$
BEGIN
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    DELETE FROM _prisma_migrations WHERE migration_name = '20261015000100_p3_chat_goal_floor';
  END IF;
END;
$$;
