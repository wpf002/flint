-- Rollup batches the runtime has already counted (review of the server
-- integration): the server sends each batch of read counts with an id, and a
-- batch whose reply was lost is sent again with the same id. Counting it twice
-- is what this table prevents. Rows older than a week are cleared by the same
-- request that adds one.
CREATE TABLE "AuditRollupBatch" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditRollupBatch_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AuditRollupBatch_id_check" CHECK ("id" ~ '^[0-9a-f]{32}$')
);
CREATE INDEX "AuditRollupBatch_at_idx" ON "AuditRollupBatch"("at");
GRANT SELECT, INSERT, DELETE ON "AuditRollupBatch" TO flint_app;
