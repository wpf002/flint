-- P4 part 3: two things the nightly forecast jobs remember, so that a forecast says what it was made from and the
-- night's work does not grow. No rule of part 1 changes, and nothing here is readable off this Mac.

-- How many of the steps a run was made from were filled in (a missing day or two, taken from the week before). Never
-- more than a fifth of them, and never the latest one: the runner holds that, and this says what it did.
ALTER TABLE "ForecastRun" ADD COLUMN "filled" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ForecastRun" ADD CONSTRAINT "ForecastRun_filled_check" CHECK ("filled" >= 0);

-- Where a daily or weekly number's builder has read to: the first instant it has not read yet. A day it found nothing
-- to record for (nothing was watching, or its source had no reading) is then not read again every night after.
ALTER TABLE "MetricSeries" ADD COLUMN "readTo" TIMESTAMPTZ(3);
