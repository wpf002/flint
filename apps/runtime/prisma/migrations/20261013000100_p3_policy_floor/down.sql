-- Reverses p3_policy_floor: the three triggers and their two functions. No
-- data is lost. A runtime from before it files a policy change with whatever
-- mark its caller gave, and dates a health check itself, as before. It also
-- removes its own row from _prisma_migrations, so the next deploy re-applies
-- it. Every statement tolerates a half-applied state.
DROP TRIGGER IF EXISTS "Proposal_policy_floor" ON "Proposal";
DROP TRIGGER IF EXISTS "Proposal_clock" ON "Proposal";
DROP TRIGGER IF EXISTS "HealthCheck_clock" ON "HealthCheck";
DROP FUNCTION IF EXISTS proposal_policy_floor(), row_clock();
DO $$
BEGIN
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    DELETE FROM _prisma_migrations WHERE migration_name = '20261013000100_p3_policy_floor';
  END IF;
END;
$$;
