-- Reverses p4_forecast_inputs: the two columns go, with what they held (how many steps of each run were filled in, and
-- where each number was read to; the next night's run reads a day or two again and loses nothing). Run it before
-- p4_forecasts' own down.sql when rolling P4 back. It also removes its own row from _prisma_migrations, so the next
-- deploy re-applies it. Every statement tolerates a half-applied state, and an empty database.
ALTER TABLE IF EXISTS "MetricSeries" DROP COLUMN IF EXISTS "readTo";
ALTER TABLE IF EXISTS "ForecastRun" DROP CONSTRAINT IF EXISTS "ForecastRun_filled_check";
ALTER TABLE IF EXISTS "ForecastRun" DROP COLUMN IF EXISTS "filled";
DO $$
BEGIN
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    DELETE FROM _prisma_migrations WHERE migration_name = '20261014000000_p4_forecast_inputs';
  END IF;
END;
$$;
