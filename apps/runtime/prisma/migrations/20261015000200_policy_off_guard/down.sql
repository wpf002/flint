-- Reverses policy_off_guard: its trigger and the trigger's function. No data is
-- lost, and nothing else of the schema changes. Afterwards the runtime's role
-- can again switch off any policy row, one that holds an action back included,
-- as it could before: P1's own rules stay (a row only ever goes off, and is
-- never deleted). A row switched off while the guard was there stays off. It
-- also removes its own row from _prisma_migrations, so the next deploy
-- re-applies it. Every statement tolerates a half-applied state.
DROP TRIGGER IF EXISTS "ActionPolicy_off_guard" ON "ActionPolicy";
DROP FUNCTION IF EXISTS action_policy_off_guard();
DO $$
BEGIN
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    DELETE FROM _prisma_migrations WHERE migration_name = '20261015000200_policy_off_guard';
  END IF;
END;
$$;
