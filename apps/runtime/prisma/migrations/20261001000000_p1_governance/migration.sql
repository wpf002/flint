-- p1_governance (Machine plan P1, 3.0.2, 3.0.5, 3.0.7).
-- Generated tables first, then the hand-written CHECKs, triggers, partitions and grants.
-- Reversed by down.sql in this directory.

-- CreateTable
CREATE TABLE "ApprovalCredential" (
    "id" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "factor" TEXT NOT NULL,
    "publicKey" BYTEA NOT NULL,
    "label" TEXT NOT NULL,
    "signCount" INTEGER NOT NULL DEFAULT 0,
    "enrolledVia" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMPTZ(3),

    CONSTRAINT "ApprovalCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Approval" (
    "id" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "challenge" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "authenticatorData" BYTEA,
    "clientDataJson" BYTEA,
    "signature" BYTEA NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "consumedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Approval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActionPolicy" (
    "id" TEXT NOT NULL,
    "pattern" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "dailyCap" INTEGER,
    "scope" JSONB,
    "reason" TEXT NOT NULL,
    "approvalId" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ActionPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActionCounter" (
    "action" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ActionCounter_pkey" PRIMARY KEY ("action","day")
);

-- CreateTable
CREATE TABLE "Proposal" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "templateId" TEXT,
    "args" JSONB,
    "argsDigest" TEXT NOT NULL,
    "argsProvenance" JSONB NOT NULL,
    "tainted" BOOLEAN NOT NULL DEFAULT false,
    "sensitivity" TEXT NOT NULL DEFAULT 'ops',
    "destructive" BOOLEAN NOT NULL DEFAULT false,
    "consequential" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT,
    "estCostUsd" DECIMAL(10,4),
    "status" TEXT NOT NULL DEFAULT 'pending',
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "approvalId" TEXT,
    "executedAt" TIMESTAMPTZ(3),
    "result" JSONB,
    "error" TEXT,
    "argsPurgedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Proposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEntry" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "seq" BIGSERIAL NOT NULL,
    "actor" TEXT NOT NULL,
    "context" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "tier" TEXT,
    "inputs" JSONB NOT NULL,
    "reasoning" TEXT,
    "decision" TEXT,
    "outcome" TEXT NOT NULL,
    "outcomeDetail" JSONB,
    "correlationId" TEXT,
    "costUsd" DECIMAL(10,4),
    "tainted" BOOLEAN NOT NULL DEFAULT false,
    "redactedAt" TIMESTAMPTZ(3),

    CONSTRAINT "AuditEntry_pkey" PRIMARY KEY ("id","at")
) PARTITION BY RANGE ("at");

-- CreateTable
CREATE TABLE "AuditRollup" (
    "day" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "context" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "AuditRollup_pkey" PRIMARY KEY ("day","action","context")
);

-- CreateTable
CREATE TABLE "RowChange" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tableName" TEXT NOT NULL,
    "rowId" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "changed" JSONB,

    CONSTRAINT "RowChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ApprovalCredential_credentialId_key" ON "ApprovalCredential"("credentialId");

-- CreateIndex
CREATE INDEX "Approval_subjectType_subjectId_idx" ON "Approval"("subjectType", "subjectId");

-- CreateIndex
CREATE INDEX "ActionPolicy_pattern_active_idx" ON "ActionPolicy"("pattern", "active");

-- CreateIndex
CREATE UNIQUE INDEX "Proposal_approvalId_key" ON "Proposal"("approvalId");

-- CreateIndex
CREATE INDEX "Proposal_status_createdAt_idx" ON "Proposal"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Proposal_status_expiresAt_idx" ON "Proposal"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "Proposal_origin_idx" ON "Proposal"("origin");

-- CreateIndex
CREATE INDEX "AuditEntry_kind_at_idx" ON "AuditEntry"("kind", "at");

-- CreateIndex
CREATE INDEX "AuditEntry_action_at_idx" ON "AuditEntry"("action", "at");

-- CreateIndex
CREATE INDEX "AuditEntry_correlationId_idx" ON "AuditEntry"("correlationId");

-- CreateIndex
CREATE INDEX "RowChange_tableName_rowId_at_idx" ON "RowChange"("tableName", "rowId", "at");

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "ApprovalCredential"("credentialId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActionPolicy" ADD CONSTRAINT "ActionPolicy_approvalId_fkey" FOREIGN KEY ("approvalId") REFERENCES "Approval"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===========================================================================
-- Hand-written below this line.
-- ===========================================================================

-- Audit partitions live in their own schema so Prisma's drift check never sees them.
CREATE SCHEMA flint_part;

-- ---- CHECKs (no Prisma enums: a CHECK can be dropped in down.sql) --------------
ALTER TABLE "ApprovalCredential"
  ADD CONSTRAINT "ApprovalCredential_factor_check" CHECK ("factor" IN ('webauthn', 'secure_enclave')),
  ADD CONSTRAINT "ApprovalCredential_signCount_check" CHECK ("signCount" >= 0),
  ADD CONSTRAINT "ApprovalCredential_label_check" CHECK (char_length("label") BETWEEN 1 AND 100);

ALTER TABLE "Approval"
  ADD CONSTRAINT "Approval_subjectType_check" CHECK ("subjectType" IN ('proposal', 'goal', 'plan', 'task', 'policy', 'forget', 'void', 'correction', 'credential', 'partition_drop')),
  ADD CONSTRAINT "Approval_decision_check" CHECK ("decision" IN ('approve', 'reject')),
  ADD CONSTRAINT "Approval_challenge_check" CHECK ("challenge" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "Approval_note_check" CHECK ("note" IS NULL OR char_length("note") <= 500),
  -- The signed payload must name this row's subject and decision, and carry a digest.
  ADD CONSTRAINT "Approval_payload_check" CHECK (
    jsonb_typeof("payload") = 'object'
    AND "payload"->>'subjectType' = "subjectType"
    AND "payload"->>'subjectId' = "subjectId"
    AND "payload"->>'decision' = "decision"
    AND ("payload"->>'argsDigest') ~ '^[0-9a-f]{64}$'
    AND ("payload"->>'action') IS NOT NULL
  );

ALTER TABLE "ActionPolicy"
  ADD CONSTRAINT "ActionPolicy_tier_check" CHECK ("tier" IN ('alone', 'approval', 'forbidden')),
  ADD CONSTRAINT "ActionPolicy_pattern_check" CHECK ("pattern" ~ '^[A-Za-z0-9_:-]+(\.[A-Za-z0-9_:-]+)*(\.\*)?$' AND char_length("pattern") <= 200),
  ADD CONSTRAINT "ActionPolicy_dailyCap_check" CHECK ("dailyCap" IS NULL OR "dailyCap" >= 0),
  ADD CONSTRAINT "ActionPolicy_reason_check" CHECK (char_length("reason") BETWEEN 1 AND 500);

ALTER TABLE "ActionCounter"
  ADD CONSTRAINT "ActionCounter_count_check" CHECK ("count" >= 0),
  ADD CONSTRAINT "ActionCounter_day_check" CHECK ("day" ~ '^\d{4}-(\d{2}-\d{2}|W\d{2})$');

ALTER TABLE "Proposal"
  ADD CONSTRAINT "Proposal_kind_check" CHECK ("kind" IN ('tool_call', 'goal', 'plan', 'rule', 'policy', 'task', 'pr', 'spend', 'forget', 'void')),
  ADD CONSTRAINT "Proposal_status_check" CHECK ("status" IN ('pending', 'approved', 'executing', 'executed', 'failed', 'rejected', 'expired')),
  ADD CONSTRAINT "Proposal_sensitivity_check" CHECK ("sensitivity" IN ('ops', 'personal', 'financial')),
  ADD CONSTRAINT "Proposal_argsDigest_check" CHECK ("argsDigest" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "Proposal_args_size_check" CHECK ("args" IS NULL OR octet_length("args"::text) <= 65536),
  ADD CONSTRAINT "Proposal_result_size_check" CHECK ("result" IS NULL OR octet_length("result"::text) <= 16384),
  ADD CONSTRAINT "Proposal_error_check" CHECK ("error" IS NULL OR char_length("error") <= 2000),
  ADD CONSTRAINT "Proposal_reason_check" CHECK ("reason" IS NULL OR char_length("reason") <= 1000),
  ADD CONSTRAINT "Proposal_provenance_check" CHECK (jsonb_typeof("argsProvenance") = 'object'),
  ADD CONSTRAINT "Proposal_template_check" CHECK ("origin" NOT LIKE 'runtime:%' OR "templateId" IS NOT NULL),
  ADD CONSTRAINT "Proposal_purged_check" CHECK ("argsPurgedAt" IS NULL OR "args" IS NULL),
  ADD CONSTRAINT "Proposal_expiry_check" CHECK ("expiresAt" > "createdAt");

ALTER TABLE "AuditEntry"
  ADD CONSTRAINT "AuditEntry_context_check" CHECK ("context" IN ('chat', 'autonomous', 'console', 'deploy')),
  ADD CONSTRAINT "AuditEntry_kind_check" CHECK ("kind" IN ('intent', 'decision', 'action', 'approval', 'rejection', 'spend', 'policy', 'sync', 'escalation', 'health', 'forget', 'error')),
  ADD CONSTRAINT "AuditEntry_decision_check" CHECK ("decision" IS NULL OR "decision" IN ('act', 'log', 'escalate', 'queue', 'deny')),
  ADD CONSTRAINT "AuditEntry_outcome_check" CHECK ("outcome" IN ('pending', 'ok', 'denied', 'failed', 'skipped')),
  ADD CONSTRAINT "AuditEntry_tier_check" CHECK ("tier" IS NULL OR "tier" IN ('alone', 'approval', 'forbidden')),
  ADD CONSTRAINT "AuditEntry_inputs_check" CHECK (jsonb_typeof("inputs") = 'object' AND octet_length("inputs"::text) <= 16384),
  ADD CONSTRAINT "AuditEntry_outcomeDetail_check" CHECK ("outcomeDetail" IS NULL OR octet_length("outcomeDetail"::text) <= 16384),
  ADD CONSTRAINT "AuditEntry_reasoning_check" CHECK ("reasoning" IS NULL OR char_length("reasoning") <= 1000);

ALTER TABLE "AuditRollup"
  ADD CONSTRAINT "AuditRollup_count_check" CHECK ("count" >= 0),
  ADD CONSTRAINT "AuditRollup_day_check" CHECK ("day" ~ '^\d{4}-\d{2}-\d{2}$');

-- ---- Append-only tables -----------------------------------------------------
-- An UPDATE is allowed only inside forget_entity(): the current user is
-- flint_owner (the function's owner), flint.forget_approval is set, and every
-- changed column is listed as redactable and set to NULL or '[forgotten]'. A
-- column listed as '@name' may instead be set once, from NULL. DELETE and
-- TRUNCATE are always refused.
CREATE FUNCTION guard_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  o jsonb;
  n jsonb;
  k text;
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION '% is append-only: % is refused', TG_TABLE_NAME, TG_OP USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF current_user <> 'flint_owner' OR coalesce(current_setting('flint.forget_approval', true), '') = '' THEN
    RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
  END IF;
  o := to_jsonb(OLD);
  n := to_jsonb(NEW);
  FOR k IN SELECT jsonb_object_keys(n) LOOP
    CONTINUE WHEN (o -> k) IS NOT DISTINCT FROM (n -> k);
    CONTINUE WHEN k = ANY (TG_ARGV) AND ((n -> k) = 'null'::jsonb OR (n -> k) = '"[forgotten]"'::jsonb);
    CONTINUE WHEN ('@' || k) = ANY (TG_ARGV) AND (o -> k) = 'null'::jsonb;
    RAISE EXCEPTION '% is append-only: column % cannot change', TG_TABLE_NAME, k USING ERRCODE = 'insufficient_privilege';
  END LOOP;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "AuditEntry_append_only" BEFORE UPDATE OR DELETE ON "AuditEntry"
  FOR EACH ROW EXECUTE FUNCTION guard_append_only('reasoning', 'outcomeDetail', '@redactedAt');
CREATE TRIGGER "AuditEntry_no_truncate" BEFORE TRUNCATE ON "AuditEntry"
  FOR EACH STATEMENT EXECUTE FUNCTION guard_append_only();
CREATE TRIGGER "RowChange_append_only" BEFORE UPDATE OR DELETE ON "RowChange"
  FOR EACH ROW EXECUTE FUNCTION guard_append_only('changed');
CREATE TRIGGER "RowChange_no_truncate" BEFORE TRUNCATE ON "RowChange"
  FOR EACH STATEMENT EXECUTE FUNCTION guard_append_only();

-- ---- Approvals ----------------------------------------------------------------
-- An Approval is written once (by flint_approver, after the server verified the
-- signature) and then only its consumedAt may be set, once.
CREATE FUNCTION approval_consume_once() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'approvals are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (to_jsonb(NEW) - 'consumedAt') IS DISTINCT FROM (to_jsonb(OLD) - 'consumedAt') THEN
    RAISE EXCEPTION 'approval %: only consumedAt may change', OLD."id" USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD."consumedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'approval % was already used', OLD."id" USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Approval_consume_once" BEFORE UPDATE OR DELETE ON "Approval"
  FOR EACH ROW EXECUTE FUNCTION approval_consume_once();
CREATE TRIGGER "Approval_no_truncate" BEFORE TRUNCATE ON "Approval"
  FOR EACH STATEMENT EXECUTE FUNCTION approval_consume_once();

-- A new Approval must come from a live credential, expire when its payload says,
-- and not already be consumed.
CREATE FUNCTION approval_insert_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "ApprovalCredential" c WHERE c."credentialId" = NEW."credentialId" AND c."revokedAt" IS NULL) THEN
    RAISE EXCEPTION 'approval: credential is unknown or revoked' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."consumedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'approval: a new approval cannot already be consumed';
  END IF;
  IF (NEW."payload"->>'expiresAt')::timestamptz IS DISTINCT FROM NEW."expiresAt" THEN
    RAISE EXCEPTION 'approval: expiresAt must equal the signed payload''s expiresAt';
  END IF;
  IF NEW."expiresAt" <= now() OR NEW."expiresAt" > now() + interval '1 day' THEN
    RAISE EXCEPTION 'approval: expiresAt must be in the next 24 hours';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Approval_insert_check" BEFORE INSERT ON "Approval"
  FOR EACH ROW EXECUTE FUNCTION approval_insert_check();

-- A credential's id, key and factor never change; its counter only rises; it is
-- revoked once and stays revoked.
CREATE FUNCTION approval_credential_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'credentials are revoked, never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (to_jsonb(NEW) - 'signCount' - 'revokedAt') IS DISTINCT FROM (to_jsonb(OLD) - 'signCount' - 'revokedAt') THEN
    RAISE EXCEPTION 'credential %: only signCount and revokedAt may change', OLD."id" USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."signCount" < OLD."signCount" THEN
    RAISE EXCEPTION 'credential %: the signature counter cannot go down', OLD."id";
  END IF;
  IF OLD."revokedAt" IS NOT NULL AND NEW."revokedAt" IS DISTINCT FROM OLD."revokedAt" THEN
    RAISE EXCEPTION 'credential %: a revocation is permanent', OLD."id";
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "ApprovalCredential_guard" BEFORE UPDATE OR DELETE ON "ApprovalCredential"
  FOR EACH ROW EXECUTE FUNCTION approval_credential_guard();
CREATE TRIGGER "ApprovalCredential_no_truncate" BEFORE TRUNCATE ON "ApprovalCredential"
  FOR EACH STATEMENT EXECUTE FUNCTION approval_credential_guard();

-- The one approval a subject may use: approved (or rejected) for exactly this
-- subject, unconsumed, unexpired, from a credential that is not revoked, and
-- signed over this action and args digest. Locks and consumes it, so it cannot
-- be used twice even by concurrent transactions. Raises otherwise.
CREATE FUNCTION consume_approval(p_approval text, p_subject_type text, p_subject_id text, p_decision text, p_action text, p_args_digest text)
RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  a "Approval"%ROWTYPE;
BEGIN
  SELECT * INTO a FROM "Approval" WHERE "id" = p_approval FOR UPDATE;
  IF NOT FOUND
     OR a."subjectType" <> p_subject_type
     OR a."subjectId" <> p_subject_id
     OR a."decision" <> p_decision
     OR a."consumedAt" IS NOT NULL
     OR a."expiresAt" <= now()
     OR a."payload"->>'action' IS DISTINCT FROM p_action
     OR (p_args_digest IS NOT NULL AND a."payload"->>'argsDigest' IS DISTINCT FROM p_args_digest)
     OR NOT EXISTS (SELECT 1 FROM "ApprovalCredential" c WHERE c."credentialId" = a."credentialId" AND c."revokedAt" IS NULL)
  THEN
    RAISE EXCEPTION '% %: no matching, unused, unexpired % approval for %', p_subject_type, p_subject_id, p_decision, p_action
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE "Approval" SET "consumedAt" = now() WHERE "id" = p_approval;
END;
$$;

-- ---- Proposals ------------------------------------------------------------------
-- pending -> approved | rejected | expired; approved -> executing | expired |
-- failed; executing -> executed | failed. Approving needs a matching approval,
-- which this consumes. What was proposed never changes; args only become NULL,
-- by retention once terminal, or by a forget.
CREATE FUNCTION proposal_insert_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" <> 'pending' OR NEW."approvalId" IS NOT NULL OR NEW."executedAt" IS NOT NULL
     OR NEW."result" IS NOT NULL OR NEW."error" IS NOT NULL OR NEW."argsPurgedAt" IS NOT NULL OR NEW."args" IS NULL THEN
    RAISE EXCEPTION 'a proposal starts pending, with its args, and nothing else set';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Proposal_insert_check" BEFORE INSERT ON "Proposal"
  FOR EACH ROW EXECUTE FUNCTION proposal_insert_check();

CREATE FUNCTION proposal_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  forgetting boolean := current_user = 'flint_owner' AND coalesce(current_setting('flint.forget_approval', true), '') <> '';
  fixed text[] := ARRAY['id', 'kind', 'origin', 'action', 'templateId', 'argsDigest', 'argsProvenance', 'tainted',
                        'sensitivity', 'destructive', 'consequential', 'estCostUsd', 'expiresAt', 'createdAt'];
  terminal text[] := ARRAY['executed', 'failed', 'rejected', 'expired'];
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'proposals are never deleted (ids are never reused)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (SELECT jsonb_object_agg(k, v) FROM jsonb_each(to_jsonb(NEW)) AS e(k, v) WHERE k = ANY (fixed))
     IS DISTINCT FROM (SELECT jsonb_object_agg(k, v) FROM jsonb_each(to_jsonb(OLD)) AS e(k, v) WHERE k = ANY (fixed)) THEN
    RAISE EXCEPTION 'proposal %: what was proposed cannot change', OLD."id" USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- A forget redacts the text and nothing else.
  IF forgetting THEN
    IF NEW."status" <> OLD."status" OR NEW."approvalId" IS DISTINCT FROM OLD."approvalId" OR NEW."executedAt" IS DISTINCT FROM OLD."executedAt"
       OR (NEW."args" IS DISTINCT FROM OLD."args" AND NEW."args" IS NOT NULL)
       OR (NEW."reason" IS DISTINCT FROM OLD."reason" AND NEW."reason" IS NOT NULL)
       OR (NEW."result" IS DISTINCT FROM OLD."result" AND NEW."result" IS NOT NULL)
       OR (NEW."error" IS DISTINCT FROM OLD."error" AND NEW."error" IS NOT NULL) THEN
      RAISE EXCEPTION 'proposal %: a forget only clears text', OLD."id";
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."reason" IS DISTINCT FROM OLD."reason" THEN
    RAISE EXCEPTION 'proposal %: the reason cannot change', OLD."id";
  END IF;
  IF NEW."args" IS DISTINCT FROM OLD."args" THEN
    IF NOT (NEW."args" IS NULL AND NEW."argsPurgedAt" IS NOT NULL AND NEW."status" = ANY (terminal)) THEN
      RAISE EXCEPTION 'proposal %: args never change; retention may clear them once terminal', OLD."id" USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  IF OLD."argsPurgedAt" IS NOT NULL AND NEW."argsPurgedAt" IS DISTINCT FROM OLD."argsPurgedAt" THEN
    RAISE EXCEPTION 'proposal %: argsPurgedAt is set once', OLD."id";
  END IF;
  IF OLD."approvalId" IS NOT NULL AND NEW."approvalId" IS DISTINCT FROM OLD."approvalId" THEN
    RAISE EXCEPTION 'proposal %: the approval is set once', OLD."id" USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW."status" = OLD."status" THEN
    IF NEW."approvalId" IS DISTINCT FROM OLD."approvalId" OR NEW."executedAt" IS DISTINCT FROM OLD."executedAt" OR NEW."error" IS DISTINCT FROM OLD."error" THEN
      RAISE EXCEPTION 'proposal %: these fields change only with the status', OLD."id";
    END IF;
    IF NEW."result" IS DISTINCT FROM OLD."result" AND NOT (NEW."result" IS NULL AND NEW."status" = ANY (terminal) AND NEW."argsPurgedAt" IS NOT NULL) THEN
      RAISE EXCEPTION 'proposal %: the result is set once, when it finishes', OLD."id";
    END IF;
    RETURN NEW;
  END IF;

  IF NOT ((OLD."status" = 'pending' AND NEW."status" IN ('approved', 'rejected', 'expired'))
       OR (OLD."status" = 'approved' AND NEW."status" IN ('executing', 'expired', 'failed'))
       OR (OLD."status" = 'executing' AND NEW."status" IN ('executed', 'failed'))) THEN
    RAISE EXCEPTION 'proposal %: % -> % is not allowed', OLD."id", OLD."status", NEW."status" USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW."status" = 'approved' THEN
    IF NEW."approvalId" IS NULL THEN
      RAISE EXCEPTION 'proposal %: approving needs an approval', OLD."id" USING ERRCODE = 'insufficient_privilege';
    END IF;
    PERFORM consume_approval(NEW."approvalId", 'proposal', NEW."id", 'approve', NEW."action", NEW."argsDigest");
  ELSIF NEW."status" = 'rejected' AND NEW."approvalId" IS NOT NULL THEN
    -- Will's signed rejection, when there is one, must match too. The runtime may
    -- also reject on its own (forbidden at execution), with no approval.
    PERFORM consume_approval(NEW."approvalId", 'proposal', NEW."id", 'reject', NEW."action", NEW."argsDigest");
  ELSIF NEW."approvalId" IS DISTINCT FROM OLD."approvalId" THEN
    RAISE EXCEPTION 'proposal %: an approval is attached only by approving or rejecting', OLD."id";
  END IF;
  IF NEW."status" = 'expired' AND NEW."expiresAt" > now() THEN
    RAISE EXCEPTION 'proposal %: it has not expired', OLD."id";
  END IF;

  IF NEW."executedAt" IS DISTINCT FROM OLD."executedAt" AND NOT (OLD."executedAt" IS NULL AND NEW."status" IN ('executed', 'failed')) THEN
    RAISE EXCEPTION 'proposal %: executedAt is set when it finishes', OLD."id";
  END IF;
  IF NEW."result" IS DISTINCT FROM OLD."result" AND NOT (OLD."result" IS NULL AND NEW."status" IN ('executed', 'failed')) THEN
    RAISE EXCEPTION 'proposal %: the result is set once, when it finishes', OLD."id";
  END IF;
  IF NEW."error" IS DISTINCT FROM OLD."error" AND NOT (OLD."error" IS NULL AND NEW."status" IN ('failed', 'rejected', 'expired')) THEN
    RAISE EXCEPTION 'proposal %: the error is set once, when it stops', OLD."id";
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Proposal_transition" BEFORE UPDATE OR DELETE ON "Proposal"
  FOR EACH ROW EXECUTE FUNCTION proposal_transition();
CREATE TRIGGER "Proposal_no_truncate" BEFORE TRUNCATE ON "Proposal"
  FOR EACH STATEMENT EXECUTE FUNCTION proposal_transition();

-- ---- Action policies --------------------------------------------------------------
-- A row exists only because Will signed the policy proposal that lists it, with
-- exactly these fields, for at most 180 days. Afterwards it can only be switched
-- off; every change is kept in RowChange.
CREATE FUNCTION action_policy_matches_approval() RETURNS trigger
LANGUAGE plpgsql AS $$
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
$$;
CREATE TRIGGER "ActionPolicy_matches_approval" BEFORE INSERT ON "ActionPolicy"
  FOR EACH ROW EXECUTE FUNCTION action_policy_matches_approval();

CREATE FUNCTION action_policy_update_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'policy rows are switched off, never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (to_jsonb(NEW) - 'active') IS DISTINCT FROM (to_jsonb(OLD) - 'active') OR (NEW."active" AND NOT OLD."active") THEN
    RAISE EXCEPTION 'policy row %: it can only be switched off', OLD."id" USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "ActionPolicy_update_guard" BEFORE UPDATE OR DELETE ON "ActionPolicy"
  FOR EACH ROW EXECUTE FUNCTION action_policy_update_guard();
CREATE TRIGGER "ActionPolicy_no_truncate" BEFORE TRUNCATE ON "ActionPolicy"
  FOR EACH STATEMENT EXECUTE FUNCTION action_policy_update_guard();

-- History of every change to a governed row. SECURITY DEFINER so that flint_app
-- can cause a RowChange row but never write one directly.
CREATE FUNCTION row_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  o jsonb := to_jsonb(OLD);
  n jsonb := to_jsonb(NEW);
  changed jsonb := '{}'::jsonb;
  k text;
BEGIN
  FOR k IN SELECT jsonb_object_keys(n) LOOP
    IF (o -> k) IS DISTINCT FROM (n -> k) THEN
      changed := changed || jsonb_build_object(k, jsonb_build_array(o -> k, n -> k));
    END IF;
  END LOOP;
  IF changed <> '{}'::jsonb THEN
    INSERT INTO "RowChange" ("id", "tableName", "rowId", "actor", "changed")
    VALUES ('rc' || replace(gen_random_uuid()::text, '-', ''), TG_TABLE_NAME, NEW."id",
            coalesce(nullif(current_setting('flint.actor', true), ''), session_user), changed);
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "ActionPolicy_history" AFTER UPDATE ON "ActionPolicy"
  FOR EACH ROW EXECUTE FUNCTION row_history();

-- ---- Daily caps -------------------------------------------------------------------
-- Claim one slot under a cap, atomically, at decision time. Returns the new
-- count, or NULL when the cap is already reached (or is 0).
CREATE FUNCTION claim_action(p_action text, p_period text, p_cap integer) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  c integer;
BEGIN
  IF p_cap IS NULL OR p_cap <= 0 THEN
    RETURN NULL;
  END IF;
  INSERT INTO "ActionCounter" ("action", "day", "count") VALUES (p_action, p_period, 1)
  ON CONFLICT ("action", "day") DO UPDATE SET "count" = "ActionCounter"."count" + 1
    WHERE "ActionCounter"."count" < p_cap
  RETURNING "count" INTO c;
  RETURN c;
END;
$$;

-- ---- Audit partitions -------------------------------------------------------------
-- One partition per UTC month in flint_part, made ahead of time; a DEFAULT
-- partition catches anything that arrives before its month exists, so no audit
-- entry is ever refused for want of a partition.
CREATE FUNCTION ensure_partitions(months_ahead integer DEFAULT 2) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET "TimeZone" = 'UTC' AS $$
DECLARE
  lo timestamptz;
  made integer := 0;
  part text;
BEGIN
  IF months_ahead < 0 OR months_ahead > 24 THEN
    RAISE EXCEPTION 'months_ahead must be 0 to 24';
  END IF;
  IF to_regclass('flint_part."AuditEntry_default"') IS NULL THEN
    CREATE TABLE flint_part."AuditEntry_default" PARTITION OF public."AuditEntry" DEFAULT;
  END IF;
  FOR i IN 0..months_ahead LOOP
    lo := date_trunc('month', now()) + make_interval(months => i);
    part := 'AuditEntry_' || to_char(lo, 'YYYY_MM');
    CONTINUE WHEN to_regclass(format('flint_part.%I', part)) IS NOT NULL;
    BEGIN
      EXECUTE format('CREATE TABLE flint_part.%I PARTITION OF public."AuditEntry" FOR VALUES FROM (%L) TO (%L)',
                     part, lo, lo + interval '1 month');
      made := made + 1;
    EXCEPTION WHEN check_violation THEN
      -- Rows for this month already sit in the default partition; they stay there.
      RAISE WARNING 'audit partition % not created: the default partition holds rows for it', part;
    END;
  END LOOP;
  RETURN made;
END;
$$;

-- Dropping a month of audit needs Will's partition_drop approval, and only for
-- months more than 24 months old (plan 3.0.5 retention).
CREATE FUNCTION drop_audit_partition(p_month text, p_approval text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET "TimeZone" = 'UTC' AS $$
DECLARE
  lo timestamptz;
BEGIN
  IF p_month !~ '^\d{4}-\d{2}$' THEN
    RAISE EXCEPTION 'month must be YYYY-MM';
  END IF;
  lo := to_timestamp(p_month || '-01', 'YYYY-MM-DD');
  IF lo + interval '1 month' > date_trunc('month', now()) - interval '24 months' THEN
    RAISE EXCEPTION 'audit for % is kept for 24 months', p_month;
  END IF;
  PERFORM consume_approval(p_approval, 'partition_drop', p_month, 'approve', 'maintenance.partition_drop', NULL);
  EXECUTE format('DROP TABLE IF EXISTS flint_part.%I', 'AuditEntry_' || replace(p_month, '-', '_'));
END;
$$;

SELECT ensure_partitions(2);

-- Intents older than an hour with no outcome yet: must stay empty (plan 3.0.7).
CREATE VIEW audit_open_intents AS
SELECT i."id", i."at", i."action", i."correlationId"
FROM "AuditEntry" i
WHERE i."kind" = 'intent'
  AND i."at" < now() - interval '1 hour'
  AND NOT EXISTS (
    SELECT 1 FROM "AuditEntry" o
    WHERE o."correlationId" = i."correlationId" AND o."kind" <> 'intent' AND o."outcome" <> 'pending'
  );

-- ---- Grants ---------------------------------------------------------------------
-- flint_owner owns everything (it runs the migrations). flint_app is the
-- runtime: it cannot create approvals, write history, or edit the audit trail.
-- flint_approver is the server's approval path and touches nothing else.
REVOKE ALL ON FUNCTION guard_append_only(), approval_consume_once(), approval_insert_check(), approval_credential_guard(),
  proposal_insert_check(), proposal_transition(), action_policy_matches_approval(), action_policy_update_guard(), row_history(),
  consume_approval(text, text, text, text, text, text), claim_action(text, text, integer), ensure_partitions(integer),
  drop_audit_partition(text, text) FROM PUBLIC;
REVOKE ALL ON SCHEMA flint_part FROM PUBLIC;

GRANT USAGE ON SCHEMA public TO flint_app, flint_approver;

GRANT SELECT ON "ApprovalCredential", "Approval", "ActionPolicy", "ActionCounter", "Proposal", "AuditEntry", "AuditRollup", "RowChange", audit_open_intents TO flint_app;
GRANT UPDATE ("consumedAt") ON "Approval" TO flint_app;
GRANT INSERT, UPDATE ("active") ON "ActionPolicy" TO flint_app;
GRANT INSERT, UPDATE ON "ActionCounter", "AuditRollup" TO flint_app;
GRANT INSERT, UPDATE ON "Proposal" TO flint_app;
GRANT INSERT ON "AuditEntry" TO flint_app;
GRANT USAGE ON SEQUENCE "AuditEntry_seq_seq" TO flint_app;
GRANT EXECUTE ON FUNCTION consume_approval(text, text, text, text, text, text), claim_action(text, text, integer), ensure_partitions(integer),
  drop_audit_partition(text, text) TO flint_app;

GRANT SELECT, INSERT ON "ApprovalCredential", "Approval" TO flint_approver;
GRANT UPDATE ("signCount", "revokedAt") ON "ApprovalCredential" TO flint_approver;
