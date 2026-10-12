-- Reverses public_schema_floor: the public schema and the database go back to
-- what a database built before it had. Everyone may use the public schema and
-- connect again (temporary tables stay refused, as the first migration left
-- them), and Flint's roles lose the rights this gave them by name: they keep
-- working, through what everyone has. It loses no data. It also removes its own
-- row from _prisma_migrations, so the next deploy re-applies it. Every statement
-- tolerates a half-applied state, and a database with none of Flint's roles.
DO $$
DECLARE
  r text;
BEGIN
  GRANT USAGE ON SCHEMA public TO PUBLIC;
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO PUBLIC', current_database());
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flint_backup') THEN
    REVOKE ALL ON SCHEMA public FROM flint_backup;
  END IF;
  FOREACH r IN ARRAY ARRAY['flint_app', 'flint_approver', 'flint_backup'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM %I', current_database(), r);
    END IF;
  END LOOP;
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    DELETE FROM _prisma_migrations WHERE migration_name = '20261013000050_public_schema_floor';
  END IF;
END;
$$;
