-- P5: the asset, task and review store. An asset is something Flint may hand
-- work to; a task is one piece of that work, with a written bar; a review is an
-- argued verdict on a card before Will approves it. What the database
-- guarantees about them, whatever the runtime does:
--  - an asset is born off, and is turned on only as the exact asset of a card
--    Will signed, in one transaction; turning it off needs nothing;
--  - a card he signed earlier never undoes what he decided after it: an
--    approval decides nothing once he has signed a later card about the same
--    asset, task or review requirement, whichever is carried out first and
--    whatever becomes of the later card, nor does one signed before its asset
--    was last turned off; when he signed, and for what, is stamped by the
--    database as the signature is recorded;
--  - a task is handed over only as the exact task of an executing dispatch card
--    he signed (its digest checked, its approval used once), with its forecast
--    on record, naming it and the rule that settles it; a spending asset's task
--    rides a spend card that carries its estimate, and ends with its cost;
--  - a task is checked and accepted only with its result on record and its own
--    successful check, and on Will's signed card (which names that result, and
--    was signed after it was handed in) until he lets Flint accept on its own;
--    going against the check, and cancelling what went out, each take a signed
--    card; its forecast is scored only for it, a day after it ended, as it
--    ended, so nothing closes the door on his override before then;
--  - a review is written once, while a reviewer is on, of exactly the args of a
--    card still waiting (or of a task's output as it is checked); once Will has
--    signed for it, a card that needs a review is not approved without one, and
--    his signature names the review he was shown, written before he signed;
--  - a plan step that is a Flint task is done only when its task was accepted,
--    and is no longer done once he rejects that result.
-- Task and review text is personal or outside text: history keeps only its
-- length, and a row refused on INSERT or UPDATE never puts it in the error's
-- message or DETAIL; nor does a card of any kind that one of Proposal's own
-- rules refuses. A forget clears all of it, a write in flight included, and
-- no output, review or result is written back. Also the four task and review
-- job queues (nothing sends to them yet). It replaces P3's plan_step_guard (one
-- rule added, near the end of this file), and stamps each approval with its
-- time and what it was signed for (Approval.signedFor, a new column). The only
-- P5 migration. Reversed by down.sql in this directory.

-- AlterTable
ALTER TABLE "Approval" ADD COLUMN     "signedFor" TEXT;

-- AlterTable
ALTER TABLE "Proposal" ADD COLUMN     "reviewId" TEXT,
ADD COLUMN     "reviewRequired" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "Asset" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "externalRef" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "capabilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "dispatchAction" TEXT NOT NULL,
    "spends" BOOLEAN NOT NULL,
    "entityId" TEXT,
    "approvalId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "changedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "goalId" TEXT,
    "stepKey" TEXT,
    "title" TEXT NOT NULL,
    "spec" JSONB,
    "acceptance" JSONB,
    "entityIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "origin" TEXT NOT NULL,
    "sensitivity" TEXT NOT NULL DEFAULT 'personal',
    "tainted" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "dispatchApprovalId" TEXT,
    "externalJobId" TEXT,
    "outputRef" TEXT,
    "outputSummary" TEXT,
    "metBar" BOOLEAN,
    "barEvidence" JSONB,
    "barCheckedBy" TEXT,
    "acceptedAuditId" TEXT,
    "predictionId" TEXT,
    "estCostUsd" DECIMAL(10,4),
    "costUsd" DECIMAL(10,4),
    "costIsEstimate" BOOLEAN NOT NULL DEFAULT true,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "failure" TEXT,
    "dispatchedAt" TIMESTAMPTZ(3),
    "submittedAt" TIMESTAMPTZ(3),
    "dueAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "textPurgedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskOutput" (
    "taskId" TEXT NOT NULL,
    "body" JSONB NOT NULL,
    "sha256" TEXT NOT NULL,
    "tainted" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskOutput_pkey" PRIMARY KEY ("taskId")
);

-- CreateTable
CREATE TABLE "Review" (
    "id" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "subjectDigest" TEXT NOT NULL,
    "engine" TEXT NOT NULL,
    "models" JSONB NOT NULL,
    "findings" JSONB NOT NULL DEFAULT '[]',
    "reasonCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "attack" TEXT,
    "defense" TEXT,
    "verdict" TEXT NOT NULL,
    "verdictReason" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL,
    "agreed" BOOLEAN NOT NULL DEFAULT true,
    "shadow" BOOLEAN NOT NULL DEFAULT true,
    "tainted" BOOLEAN NOT NULL DEFAULT false,
    "sensitivity" TEXT NOT NULL DEFAULT 'personal',
    "costUsd" DECIMAL(10,4),
    "modelMs" INTEGER,
    "overridePredictionId" TEXT,
    "textPurgedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Review_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewGate" (
    "id" TEXT NOT NULL,
    "enforced" BOOLEAN NOT NULL DEFAULT false,
    "approvalId" TEXT,
    "changedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReviewGate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskApprovalUse" (
    "approvalId" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "xact" TEXT NOT NULL,
    "usedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskApprovalUse_pkey" PRIMARY KEY ("approvalId")
);

-- CreateIndex
CREATE INDEX "Approval_signedFor_createdAt_idx" ON "Approval"("signedFor", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Asset_kind_externalRef_key" ON "Asset"("kind", "externalRef");

-- CreateIndex
CREATE UNIQUE INDEX "Task_predictionId_key" ON "Task"("predictionId");

-- CreateIndex
CREATE INDEX "Task_status_dueAt_idx" ON "Task"("status", "dueAt");

-- CreateIndex
CREATE INDEX "Task_assetId_createdAt_idx" ON "Task"("assetId", "createdAt");

-- CreateIndex
CREATE INDEX "Task_goalId_idx" ON "Task"("goalId");

-- CreateIndex
CREATE UNIQUE INDEX "Review_overridePredictionId_key" ON "Review"("overridePredictionId");

-- CreateIndex
CREATE INDEX "Review_subjectType_subjectId_idx" ON "Review"("subjectType", "subjectId");

-- CreateIndex
CREATE INDEX "Proposal_reviewId_idx" ON "Proposal"("reviewId");

-- AddForeignKey
ALTER TABLE "Proposal" ADD CONSTRAINT "Proposal_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "Review"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "Goal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskOutput" ADD CONSTRAINT "TaskOutput_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- ===========================================================================
-- Hand-written below this line. Every RAISE names its SQLSTATE: 23514
-- (check_violation) refuses what the caller sent; 42501 (insufficient_privilege)
-- is a rule no caller may break; 40001 (serialization_failure) is a write above
-- READ COMMITTED (try again). Messages name ids and the rule, never a task's or a
-- review's words: an error's words reach logs, cards and Postgres's own log. An
-- id is repeated only once it is known to be shaped like one. No pattern written
-- here uses a backslash, so none depends on the session's
-- standard_conforming_strings.
-- ===========================================================================

-- ---- Rules on each row ------------------------------------------------------------
-- No Prisma enums. Task, TaskOutput and Review hold words (Will's, or a model's),
-- and a refused CHECK or NOT NULL writes the row into its error's DETAIL
-- ("Failing row contains (...)"), which Postgres also logs. So their rules are
-- validation triggers (task_valid, task_output_guard, review_valid, below) that
-- name the row's id and the rule only, and run before any constraint could. A
-- task or spend card's args hold the task's words too: p5_card_valid does the
-- same for Proposal's own rules. An asset holds no words of Will's (its name is
-- the code registry's), so it keeps plain CHECKs, as do the gate and the record
-- of used approvals.
ALTER TABLE "Asset"
  ADD CONSTRAINT "Asset_id_check" CHECK ("id" ~ '^[A-Za-z0-9_-]{1,40}$'),
  ADD CONSTRAINT "Asset_kind_check" CHECK ("kind" IN ('local_worker', 'local_reviewer', 'ci_runner', 'nexus_participant', 'trident_panel', 'hive_bot')),
  ADD CONSTRAINT "Asset_externalRef_check" CHECK ("externalRef" ~ '^[a-z0-9][a-z0-9_.:/-]{0,119}$'),
  ADD CONSTRAINT "Asset_name_check" CHECK (char_length("name") BETWEEN 1 AND 80),
  ADD CONSTRAINT "Asset_capabilities_check" CHECK (
    "capabilities" IS NOT NULL AND cardinality("capabilities") <= 20 AND array_position("capabilities", NULL) IS NULL
    AND (cardinality("capabilities") = 0 OR array_to_string("capabilities", ',') ~ '^[a-z][a-z0-9_]{0,39}(,[a-z][a-z0-9_]{0,39})*$')
  ),
  -- One action per kind: what a card that hands it work is called.
  ADD CONSTRAINT "Asset_dispatchAction_check" CHECK ("dispatchAction" = CASE "kind"
    WHEN 'local_reviewer' THEN 'review.local' WHEN 'trident_panel' THEN 'review.trident_panel' WHEN 'hive_bot' THEN 'hive.dispatch_job'
    ELSE 'task.dispatch.' || "kind" END),
  -- An asset that runs on someone else's keys always spends; one on this Mac never does.
  ADD CONSTRAINT "Asset_spends_check" CHECK (
    ("kind" NOT IN ('nexus_participant', 'trident_panel') OR "spends") AND ("kind" NOT IN ('local_worker', 'local_reviewer', 'ci_runner') OR NOT "spends")
  ),
  ADD CONSTRAINT "Asset_entityId_check" CHECK ("entityId" IS NULL OR "entityId" ~ '^[A-Za-z0-9_-]{1,40}$'),
  ADD CONSTRAINT "Asset_approvalId_check" CHECK ("approvalId" IS NULL OR "approvalId" ~ '^[A-Za-z0-9_-]{1,40}$');

ALTER TABLE "ReviewGate"
  ADD CONSTRAINT "ReviewGate_id_check" CHECK ("id" = 'proposal'),
  ADD CONSTRAINT "ReviewGate_approvalId_check" CHECK ("approvalId" IS NULL OR "approvalId" ~ '^[A-Za-z0-9_-]{1,40}$');

ALTER TABLE "TaskApprovalUse"
  ADD CONSTRAINT "TaskApprovalUse_subject_check" CHECK ("subject" ~ '^(taskId|assetId|gate):[A-Za-z0-9_-]{1,40}$');

-- ---- Partial indexes (Prisma's diff does not see them) ---------------------------
-- One live task per plan step; a step whose task failed, was rejected or cancelled may get another.
CREATE UNIQUE INDEX "Task_one_live_per_step_key" ON "Task" ("goalId", "stepKey")
  WHERE "stepKey" IS NOT NULL AND "status" NOT IN ('rejected', 'failed', 'cancelled');

-- ---- The signed card a guarded change rides on ------------------------------------
-- An approval Will signed (approve, a live credential) for a card that is
-- executing now and not expired (by the wall clock: a transaction opened before
-- the card expired gains nothing), for one of these actions, whose stored args
-- are the args he signed (their digest is computed again here, as digestOf
-- computes it) and name this subject under `p_key` (taskId, assetId or gate).
-- The card expires no later than 7 days after his approval does, so one filed
-- with a far-off expiry cannot be signed now and kept for months. A card that
-- turns an asset on or changes the review gate is a policy card from the console
-- or the CLI, with nothing untrusted in it, marked for Will's own fresh touch;
-- a cancellation or an override is a task card from the console or the CLI,
-- untainted; a dispatch or an acceptance is a task or spend card from the
-- console, the CLI or one of the runtime's own jobs (never from chat). The
-- approval was recorded as signed for this subject (Approval.signedFor: the
-- card was there, with these args, when he signed). It never
-- consumes the approval (proposal_transition did that when the card was
-- approved); p5_bind_approval, below, makes each one count in one transaction
-- only. Raises otherwise. VOLATILE (the default): each call reads the wall clock
-- and what is committed now. Called from trigger bodies, which run as flint_app:
-- it has EXECUTE.
CREATE FUNCTION p5_signed_proposal(p_approval text, p_key text, p_subject text, p_actions text[]) RETURNS "Proposal"
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  a "Approval"%ROWTYPE;
  p "Proposal"%ROWTYPE;
  -- What an error here may repeat: nothing that is not shaped like an id or an action's name.
  k text := CASE WHEN p_key IN ('taskId', 'assetId', 'gate') THEN p_key ELSE '?' END;
  s text := CASE WHEN p_subject ~ '^[A-Za-z0-9_-]{1,40}$' THEN p_subject ELSE '?' END;
  ap text := CASE WHEN p_approval ~ '^[A-Za-z0-9_-]{1,40}$' THEN p_approval ELSE '?' END;
  acts text := coalesce((SELECT string_agg(x, ' or ') FROM unnest(p_actions) AS x WHERE x ~ '^[a-z][a-z0-9_.]{0,79}$'), '?');
BEGIN
  IF k = '?' OR s = '?' OR ap = '?' THEN
    RAISE EXCEPTION '% %: approval % is not shaped as a card''s approval', k, s, ap USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO a FROM "Approval" WHERE "id" = p_approval;
  IF NOT FOUND OR a."decision" <> 'approve' OR a."subjectType" <> 'proposal'
     OR NOT EXISTS (SELECT 1 FROM "ApprovalCredential" c WHERE c."credentialId" = a."credentialId" AND c."revokedAt" IS NULL) THEN
    RAISE EXCEPTION '% %: approval % is not a live signed approval of a card', k, s, ap USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO p FROM "Proposal" WHERE "id" = a."subjectId";
  IF NOT FOUND OR NOT coalesce(
       p."approvalId" = a."id" AND p."status" = 'executing' AND p."expiresAt" > clock_timestamp()
       AND p."expiresAt" <= a."expiresAt" + interval '7 days'
       AND p."action" = ANY (p_actions)
       AND CASE
             WHEN p."action" IN ('asset.enable', 'review.enforce') THEN p."kind" = 'policy' AND p."origin" IN ('console', 'cli') AND NOT p."tainted" AND p."consequential"
             WHEN p."action" IN ('task.cancel', 'task.bar_override') THEN p."kind" = 'task' AND p."origin" IN ('console', 'cli') AND NOT p."tainted"
             ELSE p."kind" IN ('task', 'spend') AND (p."origin" IN ('console', 'cli') OR p."origin" LIKE 'runtime:%')
           END
       AND a."payload"->>'action' = p."action" AND a."payload"->>'argsDigest' = p."argsDigest"
       AND jsonb_typeof(p."args") = 'object' AND p."args"->>p_key = p_subject AND a."signedFor" = k || ':' || s, false) THEN
    RAISE EXCEPTION '% %: approval % is not for an executing % of it', k, s, ap, acts USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Only now (the args are an object): what is stored is what he signed.
  IF p3_args_digest(p."args") IS DISTINCT FROM p."argsDigest" THEN
    RAISE EXCEPTION '% %: the card approval % signed does not hold the args he signed', k, s, ap USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN p;
END;
$$;

-- An approval counts in one transaction only, for one subject and one action:
-- the first use records the transaction, and any use from another one (the card
-- left executing, a replay) is refused, as is its use for another subject or
-- action. Only a live, executing card for that subject and action is ever
-- recorded, and only from inside a trigger (the guards below are the only
-- callers, and flint_app can create none): a call of its own can neither spend a
-- card nor fill the table. Every caller is a BEFORE UPDATE trigger, which fires
-- only for a row that is then written (or the statement fails, and the use goes
-- with it): an approval is used only by a change that lands. Order counts too,
-- and it is the order Will signed in, not the order the runtime applies cards
-- in: an approval decides nothing once he has signed a later card about the
-- same asset, task or gate, whichever of the two is carried out first. So the
-- later signature wins, and a card kept back never undoes it. When he signed,
-- and for what, is on the approval itself, written as the server records it
-- (Approval_clock and Approval_signed_for, below): nothing the runtime does to
-- the later card afterwards (ending it unused, clearing its args) brings the
-- earlier one back. Two signed in the same millisecond are ordered by id, so
-- one of them still wins both ways. SECURITY DEFINER: flint_app has no grant
-- on TaskApprovalUse, so it can only use an approval, never free one.
CREATE FUNCTION p5_bind_approval(p_approval text, p_key text, p_subject text, p_action text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  u "TaskApprovalUse"%ROWTYPE;
  subj text := p_key || ':' || p_subject;
  -- This transaction: its id, and when it began (so the same id met again after a restore into a new cluster is not it).
  me text := pg_current_xact_id()::text || '@' || (extract(epoch FROM transaction_timestamp()) * 1000000)::bigint::text;
  signed_at timestamptz;
BEGIN
  IF pg_trigger_depth() < 1 THEN
    RAISE EXCEPTION 'task or asset card: an approval is used only by the change it signed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Raises unless the key, the subject and the approval are shaped as such, and the card is live.
  PERFORM p5_signed_proposal(p_approval, p_key, p_subject, ARRAY[p_action]);
  INSERT INTO "TaskApprovalUse" ("approvalId", "subject", "action", "xact", "usedAt")
  VALUES (p_approval, subj, p_action, me, clock_timestamp())
  ON CONFLICT ("approvalId") DO NOTHING;
  SELECT * INTO u FROM "TaskApprovalUse" WHERE "approvalId" = p_approval;
  IF NOT coalesce(u."xact" = me AND u."subject" = subj AND u."action" = p_action, false) THEN
    RAISE EXCEPTION '% %: approval % was already used', p_key, p_subject, p_approval USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Will has since signed another card about the same asset, task or gate: the later signature stands, carried out or not.
  SELECT a."createdAt" INTO signed_at FROM "Approval" a WHERE a."id" = p_approval;
  IF EXISTS (SELECT 1 FROM "Approval" b WHERE b."signedFor" = subj AND b."decision" = 'approve' AND (b."createdAt", b."id") > (signed_at, p_approval)) THEN
    RAISE EXCEPTION '% %: approval % was signed before a later decision', p_key, p_subject, p_approval USING ERRCODE = 'insufficient_privilege';
  END IF;
END;
$$;

-- ---- When Will signed, and for what ---------------------------------------------------
-- The order rule above, and the rule that a review comes before the signature
-- that names it, compare when an approval was recorded. That time is stamped
-- here, by the wall clock, for every role but the owner (a test's fixture): the
-- server's role, which records approvals, cannot date one into the past or the
-- future. Named to fire before P1's Approval_insert_check.
CREATE FUNCTION approval_clock() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF current_user <> 'flint_owner' THEN
    NEW."createdAt" := clock_timestamp();
  END IF;
  RETURN NEW;
END;
$$;

-- What a signature is about is recorded with it, as it is recorded: the asset,
-- task or gate its card names, read from the card as it was filed (a card's
-- action and args never change). The order rule reads this and never a card's
-- args, which retention or a forget clears, and which the runtime may clear
-- once it has ended a card. NULL for a rejection, for a card of any other
-- action, and for a card that is not there or has no such id (such a signature
-- acts on nothing here). Whatever the writer sent is overwritten, the owner's
-- too, and P1's approval_consume_once then holds it fixed. SECURITY DEFINER:
-- the server's role cannot read cards; all it learns back is that id. It reads
-- one row and raises nothing: recording a signature never fails here.
CREATE FUNCTION approval_signed_for() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  c "Proposal"%ROWTYPE;
  s text;
BEGIN
  NEW."signedFor" := NULL;
  IF NEW."subjectType" = 'proposal' AND NEW."decision" = 'approve' THEN
    SELECT * INTO c FROM "Proposal" WHERE "id" = NEW."subjectId";
    IF FOUND AND jsonb_typeof(c."args") = 'object' THEN
      s := CASE
             WHEN c."action" = 'asset.enable' THEN 'assetId:' || (c."args"->>'assetId')
             WHEN c."action" = 'review.enforce' THEN 'gate:' || (c."args"->>'gate')
             WHEN c."action" LIKE 'task.%' OR c."action" IN ('review.local', 'review.trident_panel', 'hive.dispatch_job') THEN 'taskId:' || (c."args"->>'taskId')
           END;
      IF s ~ '^(taskId|assetId|gate):[A-Za-z0-9_-]{1,40}$' THEN
        NEW."signedFor" := s;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- ---- What Will signs is what is stored ----------------------------------------------
-- A task, asset or gate card's digest is its args' digest (p3_args_digest,
-- digestOf's): what Will signs is what the guards below compare rows with. Its
-- own function, calling P3's by name: were p3_goals ever rolled back under this
-- migration, it refuses every such card (fails closed) instead of vanishing with
-- a CASCADE.
CREATE FUNCTION p5_digest_check() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW."args" IS NULL OR p3_args_digest(NEW."args") IS DISTINCT FROM NEW."argsDigest" THEN
    RAISE EXCEPTION 'proposal %: its digest is not its args'' digest',
      CASE WHEN NEW."id" ~ '^[A-Za-z0-9_-]{1,64}$' THEN NEW."id" ELSE '?' END USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

-- Every card's own rules (Proposal's CHECKs and NOT NULLs), checked first and
-- named by id: a card's args hold words (a dispatch card's the task's title,
-- spec and bar; a tool call's whatever it was asked), and a refused CHECK would
-- write them into the error's DETAIL. The same rules P3's proposal_valid checks
-- for goal and plan cards, in a function of its own for the reason
-- p5_digest_check has one. It refuses nothing the constraints allow, but for
-- two rules about money that hold for a card as it is filed and for no card
-- that is already there: an estimate is never negative, and a spend card says
-- an estimate above nothing. One rule more, for the cards this migration acts
-- on: a card whose args a forget cleared while it ran takes no result when it
-- finishes (what it did was about what was forgotten; it still ends, and may
-- still say why it failed).
CREATE FUNCTION p5_card_valid() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  bad text;
BEGIN
  bad := CASE
    WHEN NEW."id" IS NULL OR NEW."kind" IS NULL OR NEW."origin" IS NULL OR NEW."action" IS NULL OR NEW."argsDigest" IS NULL OR NEW."argsProvenance" IS NULL
         OR NEW."tainted" IS NULL OR NEW."sensitivity" IS NULL OR NEW."destructive" IS NULL OR NEW."consequential" IS NULL OR NEW."status" IS NULL
         OR NEW."expiresAt" IS NULL OR NEW."createdAt" IS NULL OR NEW."reviewRequired" IS NULL THEN 'a required field'
    WHEN NOT coalesce(NEW."kind" IN ('tool_call', 'goal', 'plan', 'rule', 'policy', 'task', 'pr', 'spend', 'forget', 'void'), false) THEN 'kind'
    WHEN NOT coalesce(NEW."status" IN ('pending', 'approved', 'executing', 'executed', 'failed', 'rejected', 'expired'), false) THEN 'status'
    WHEN NOT coalesce(NEW."sensitivity" IN ('ops', 'personal', 'financial'), false) THEN 'sensitivity'
    WHEN NOT coalesce(NEW."argsDigest" ~ '^[0-9a-f]{64}$', false) THEN 'digest'
    WHEN NOT coalesce(NEW."args" IS NULL OR octet_length(NEW."args"::text) <= 65536, false) THEN 'args'
    WHEN NOT coalesce(NEW."result" IS NULL OR octet_length(NEW."result"::text) <= 16384, false) THEN 'result'
    WHEN NOT coalesce(NEW."error" IS NULL OR char_length(NEW."error") <= 2000, false) THEN 'error'
    WHEN NOT coalesce(NEW."reason" IS NULL OR char_length(NEW."reason") <= 1000, false) THEN 'reason'
    WHEN NOT coalesce(jsonb_typeof(NEW."argsProvenance") = 'object', false) THEN 'provenance'
    WHEN NOT coalesce(NEW."origin" NOT LIKE 'runtime:%' OR NEW."templateId" IS NOT NULL, false) THEN 'template'
    WHEN NOT coalesce(NEW."argsPurgedAt" IS NULL OR NEW."args" IS NULL, false) THEN 'purge'
    WHEN NOT coalesce(NEW."expiresAt" > NEW."createdAt", false) THEN 'expiry'
    WHEN TG_OP = 'INSERT' AND NOT coalesce((NEW."estCostUsd" IS NULL OR NEW."estCostUsd" >= 0)
                                           AND (NEW."kind" <> 'spend' OR NEW."estCostUsd" > 0), false) THEN 'estimate'
  END;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'proposal %: its % is not valid', CASE WHEN NEW."id" ~ '^[A-Za-z0-9_-]{1,64}$' THEN NEW."id" ELSE '?' END, bad USING ERRCODE = 'check_violation';
  END IF;
  -- (Args are cleared before a card has ended only by a forget: retention waits until it has.)
  IF TG_OP = 'UPDATE' AND NEW."result" IS NOT NULL AND OLD."result" IS NULL AND OLD."argsPurgedAt" IS NOT NULL
     AND (NEW."kind" IN ('task', 'spend') OR NEW."action" ~ '^(task[.]|asset[.]enable$|review[.])' OR NEW."action" = 'hive.dispatch_job') THEN
    RAISE EXCEPTION 'proposal %: its args were cleared, so it takes no result', OLD."id" USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

-- ---- Assets -------------------------------------------------------------------------
-- An asset is born off and unsigned, made now (the wall clock).
CREATE FUNCTION asset_insert_check() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT coalesce(NEW."id" ~ '^[A-Za-z0-9_-]{1,40}$', false) THEN
    RAISE EXCEPTION 'asset: its id is not valid' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT coalesce(NOT NEW."enabled" AND NEW."approvalId" IS NULL, false) THEN
    RAISE EXCEPTION 'asset %: an asset starts off and unsigned', NEW."id" USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW."createdAt" := clock_timestamp();
  NEW."changedAt" := NEW."createdAt";
  RETURN NEW;
END;
$$;

-- What an asset is never changes (a changed asset is a new row, with a new
-- externalRef, that Will turns on again), and it is never deleted. It is turned on
-- only with a new approval whose executing asset.enable card signed exactly what
-- it is (kind, reference, name, capabilities, dispatch action, whether it spends
-- and the item it stands for), the latest he signed for it, and signed after it
-- was last turned on or off (turning it off needs no card, so only the asset
-- says when that was: a card kept from before does not turn it back on), used in
-- this transaction only. Turning it off needs nothing, except for the last reviewer
-- while reviews are required (stop requiring them first: that is a signed card,
-- and the one card that never waits for a review). On and off both happen at
-- READ COMMITTED (each check reads what is committed now), and each is stamped
-- by the wall clock.
CREATE FUNCTION asset_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  p "Proposal"%ROWTYPE;
  required boolean;
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'assets are never deleted (an asset is turned off)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (to_jsonb(NEW) - 'enabled' - 'approvalId' - 'changedAt') IS DISTINCT FROM (to_jsonb(OLD) - 'enabled' - 'approvalId' - 'changedAt') THEN
    RAISE EXCEPTION 'asset %: what it is never changes', OLD."id" USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."enabled" IS NULL THEN
    RAISE EXCEPTION 'asset %: it is on or off', OLD."id" USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."changedAt" IS DISTINCT FROM OLD."changedAt" THEN
    RAISE EXCEPTION 'asset %: when it last changed is stamped here', OLD."id" USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."enabled" IS DISTINCT FROM OLD."enabled" THEN
    IF current_setting('transaction_isolation') <> 'read committed' THEN
      RAISE EXCEPTION 'asset %: it is turned on or off at read committed only', OLD."id" USING ERRCODE = 'serialization_failure';
    END IF;
    NEW."changedAt" := clock_timestamp();
  END IF;
  IF NEW."enabled" AND NOT OLD."enabled" THEN
    -- A new approval each time: one that turned it on once never turns it on again.
    IF NEW."approvalId" IS NULL OR NEW."approvalId" IS NOT DISTINCT FROM OLD."approvalId" THEN
      RAISE EXCEPTION 'asset %: turning it on needs a new approval', OLD."id" USING ERRCODE = 'insufficient_privilege';
    END IF;
    p := p5_signed_proposal(NEW."approvalId", 'assetId', NEW."id", ARRAY['asset.enable']);
    PERFORM p5_bind_approval(NEW."approvalId", 'assetId', NEW."id", 'asset.enable');
    -- Signed after it last changed: turning it off needs no card, so no use on record says when that was.
    IF NOT coalesce((SELECT a."createdAt" FROM "Approval" a WHERE a."id" = NEW."approvalId") > OLD."changedAt", false) THEN
      RAISE EXCEPTION 'asset %: approval % was signed before it last changed', OLD."id", NEW."approvalId" USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT coalesce(
         p."args" ?& ARRAY['kind', 'externalRef', 'name', 'capabilities', 'dispatchAction', 'spends', 'entityId']
         AND p."args"->>'kind' = NEW."kind" AND p."args"->>'externalRef' = NEW."externalRef" AND p."args"->>'name' = NEW."name"
         AND p."args"->'capabilities' = to_jsonb(NEW."capabilities") AND p."args"->>'dispatchAction' = NEW."dispatchAction"
         AND p."args"->'spends' = to_jsonb(NEW."spends") AND p."args"->'entityId' = coalesce(to_jsonb(NEW."entityId"), 'null'::jsonb), false) THEN
      RAISE EXCEPTION 'asset %: what it is is not what approval % signed', OLD."id", NEW."approvalId" USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF NEW."approvalId" IS DISTINCT FROM OLD."approvalId" THEN
    RAISE EXCEPTION 'asset %: its approval changes only when it is turned on', OLD."id" USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD."enabled" AND NOT NEW."enabled" AND OLD."kind" = 'local_reviewer' THEN
    -- The gate, locked: it cannot be turned on under this, and two reviewers are not turned off at once.
    SELECT g."enforced" INTO required FROM "ReviewGate" g WHERE g."id" = 'proposal' FOR NO KEY UPDATE;
    IF coalesce(required, true)
       AND NOT EXISTS (SELECT 1 FROM "Asset" o WHERE o."kind" = 'local_reviewer' AND o."enabled" AND o."id" <> OLD."id") THEN
      RAISE EXCEPTION 'asset %: reviews are required, so the last reviewer stays on', OLD."id" USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- ---- Tasks ---------------------------------------------------------------------------
-- A task is born proposed: unsigned, undispatched, unchecked, with its spec, its
-- bar and its estimate. Made now (the wall clock).
CREATE FUNCTION task_insert_check() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT coalesce(NEW."id" ~ '^[A-Za-z0-9_-]{1,40}$', false) THEN
    RAISE EXCEPTION 'task: its id is not valid' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT coalesce(NEW."status" = 'proposed' AND NEW."dispatchApprovalId" IS NULL AND NEW."externalJobId" IS NULL AND NEW."outputRef" IS NULL
                  AND NEW."outputSummary" IS NULL AND NEW."metBar" IS NULL AND NEW."barEvidence" IS NULL AND NEW."barCheckedBy" IS NULL
                  AND NEW."acceptedAuditId" IS NULL AND NEW."predictionId" IS NULL AND NEW."costUsd" IS NULL AND NEW."attempts" = 0
                  AND NEW."failure" IS NULL AND NEW."dispatchedAt" IS NULL AND NEW."submittedAt" IS NULL AND NEW."completedAt" IS NULL AND NEW."textPurgedAt" IS NULL
                  AND NEW."spec" IS NOT NULL AND NEW."acceptance" IS NOT NULL AND NEW."estCostUsd" IS NOT NULL, false) THEN
    RAISE EXCEPTION 'task %: a task starts proposed, with its spec, its bar and its estimate, and nothing else set', NEW."id" USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW."createdAt" := clock_timestamp();
  NEW."updatedAt" := NEW."createdAt";
  RETURN NEW;
END;
$$;

-- What a task is (its asset, goal and step, title, origin, sensitivity, taint, the
-- items it names, its estimate and its due time) never changes, and it is never
-- deleted. Its spec and its bar never change; the summary is written once, as it
-- is handed in, and the evidence once, while it is being checked; retention may
-- clear all four once it has ended, and a forget at any time (a forget clears
-- them and changes nothing else).
--   proposed   -> queued      the dispatch: a new approval whose executing card (the
--                             asset's own dispatch action) signed exactly this task,
--                             used in this transaction only; the asset is on; its
--                             forecast is open and names it; a spending asset's card is a spend
--                             card from the console carrying the same estimate, any
--                             other a task card at no cost
--   queued     -> dispatched  the asset is still on; the time is the wall clock's
--   ...        -> submitted   with its output's reference; the time is the wall clock's
--   submitted  -> checking    with that output on record (so is every acceptance)
--   checking   -> accepted | rejected   as the bar check found (metBar); accepted only
--                             with its own successful check on record, and on Will's
--                             signed card (which names this output and that it met
--                             its bar) until a live policy row he signed lets Flint
--                             accept on its own
--   against the check, or accepted <-> rejected   Will's override: an executing
--                             task.bar_override card to that status, before the
--                             forecast is scored, and it says the checker was Will
--   proposed   -> cancelled   needs nothing (nothing went out)
--   any other  -> cancelled   an executing task.cancel card for this task
--   ...        -> failed      the asset or the runner gave up; says why, as a class
-- A spending asset's task that went out ends with its cost. Status changes run at
-- READ COMMITTED only (each check reads what is committed now). dispatchedAt and
-- completedAt are set here.
CREATE FUNCTION task_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  forgetting boolean := current_user = 'flint_owner' AND coalesce(current_setting('flint.forget_approval', true), '') <> '';
  fixed text[] := ARRAY['id', 'assetId', 'goalId', 'stepKey', 'title', 'origin', 'sensitivity', 'tainted', 'entityIds', 'estCostUsd', 'dueAt', 'createdAt'];
  words text[] := ARRAY['spec', 'acceptance', 'outputSummary', 'barEvidence'];
  once text[] := ARRAY['dispatchApprovalId', 'externalJobId', 'outputRef', 'predictionId', 'costUsd', 'acceptedAuditId', 'failure', 'textPurgedAt', 'metBar'];
  terminal text[] := ARRAY['accepted', 'rejected', 'failed', 'cancelled'];
  o jsonb := to_jsonb(OLD);
  n jsonb := to_jsonb(NEW);
  a "Asset"%ROWTYPE;
  p "Proposal"%ROWTYPE;
  k text;
  cand text;
  ok boolean;
  ended boolean;
  checker boolean;
  with_bar boolean;
  override boolean := false;
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'tasks are never deleted (a task is cancelled)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  FOREACH k IN ARRAY fixed LOOP
    IF (n -> k) IS DISTINCT FROM (o -> k) THEN
      RAISE EXCEPTION 'task %: % never changes', OLD."id", k USING ERRCODE = 'insufficient_privilege';
    END IF;
  END LOOP;
  ended := OLD."status" = ANY (terminal);
  -- Words: the spec and the bar never change; the summary and the evidence are written once; all four may be cleared.
  FOREACH k IN ARRAY words LOOP
    CONTINUE WHEN (n -> k) IS NOT DISTINCT FROM (o -> k);
    IF (n -> k) = 'null'::jsonb THEN
      IF NEW."textPurgedAt" IS NULL OR NOT (forgetting OR ended) THEN
        RAISE EXCEPTION 'task %: its % is cleared only once it has ended', OLD."id", k USING ERRCODE = 'insufficient_privilege';
      END IF;
    ELSIF forgetting OR OLD."textPurgedAt" IS NOT NULL OR k IN ('spec', 'acceptance') OR (o -> k) <> 'null'::jsonb THEN
      -- (Nothing is written back once its text was cleared.)
      RAISE EXCEPTION 'task %: its % is written once', OLD."id", k USING ERRCODE = 'insufficient_privilege';
    ELSIF (k = 'outputSummary' AND NEW."status" IS DISTINCT FROM 'submitted') OR (k = 'barEvidence' AND OLD."status" <> 'checking') THEN
      -- The summary belongs to the result as it is handed in; the evidence to the check as it is made.
      RAISE EXCEPTION 'task %: its % is written at its own step', OLD."id", k USING ERRCODE = 'insufficient_privilege';
    END IF;
  END LOOP;
  IF NEW."textPurgedAt" IS DISTINCT FROM OLD."textPurgedAt" AND NOT (forgetting OR ended) THEN
    RAISE EXCEPTION 'task %: it is marked as cleared only once it has ended', OLD."id" USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- A forget clears the words and nothing else.
  IF forgetting THEN
    IF (n - words - 'textPurgedAt' - 'updatedAt') IS DISTINCT FROM (o - words - 'textPurgedAt' - 'updatedAt') THEN
      RAISE EXCEPTION 'task %: a forget only clears text', OLD."id" USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  FOREACH k IN ARRAY once LOOP
    IF (o -> k) <> 'null'::jsonb AND (n -> k) IS DISTINCT FROM (o -> k) THEN
      RAISE EXCEPTION 'task %: % is set once', OLD."id", k USING ERRCODE = 'insufficient_privilege';
    END IF;
  END LOOP;
  IF NEW."attempts" < OLD."attempts" THEN
    RAISE EXCEPTION 'task %: its attempts only go up', OLD."id" USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Whether a cost is an estimate is said when the cost is: an estimate is not relabeled as metered afterwards.
  IF NEW."costIsEstimate" IS DISTINCT FROM OLD."costIsEstimate" AND NOT (OLD."costUsd" IS NULL AND NEW."costUsd" IS NOT NULL) THEN
    RAISE EXCEPTION 'task %: whether its cost is an estimate is said with its cost', OLD."id" USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- The bar is checked while the task is being checked, and says who checked it (never Will: his is an override).
  IF NEW."metBar" IS DISTINCT FROM OLD."metBar" AND OLD."status" <> 'checking' THEN
    RAISE EXCEPTION 'task %: its bar is checked while it is being checked', OLD."id" USING ERRCODE = 'insufficient_privilege';
  END IF;
  checker := NEW."barCheckedBy" IS DISTINCT FROM OLD."barCheckedBy";
  with_bar := OLD."barCheckedBy" IS NULL AND NEW."metBar" IS DISTINCT FROM OLD."metBar" AND NEW."barCheckedBy" IS DISTINCT FROM 'will';

  IF NEW."status" IS NOT DISTINCT FROM OLD."status" THEN
    IF NEW."dispatchApprovalId" IS DISTINCT FROM OLD."dispatchApprovalId" OR NEW."predictionId" IS DISTINCT FROM OLD."predictionId"
       OR NEW."acceptedAuditId" IS DISTINCT FROM OLD."acceptedAuditId" OR NEW."dispatchedAt" IS DISTINCT FROM OLD."dispatchedAt"
       OR NEW."submittedAt" IS DISTINCT FROM OLD."submittedAt"
       OR NEW."completedAt" IS DISTINCT FROM OLD."completedAt" OR NEW."failure" IS DISTINCT FROM OLD."failure" THEN
      RAISE EXCEPTION 'task %: these change only with its status', OLD."id" USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF checker AND NOT with_bar THEN
      RAISE EXCEPTION 'task %: who checked it is set with its bar', OLD."id" USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;

  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'task %: its status changes at read committed only', OLD."id" USING ERRCODE = 'serialization_failure';
  END IF;
  IF NOT coalesce(
       (OLD."status" = 'proposed' AND NEW."status" IN ('queued', 'cancelled'))
       OR (OLD."status" = 'queued' AND NEW."status" IN ('dispatched', 'failed', 'cancelled'))
       OR (OLD."status" = 'dispatched' AND NEW."status" IN ('running', 'submitted', 'failed', 'cancelled'))
       OR (OLD."status" = 'running' AND NEW."status" IN ('submitted', 'failed', 'cancelled'))
       OR (OLD."status" = 'submitted' AND NEW."status" IN ('checking', 'failed', 'cancelled'))
       OR (OLD."status" = 'checking' AND NEW."status" IN ('accepted', 'rejected', 'failed', 'cancelled'))
       OR (OLD."status" = 'accepted' AND NEW."status" = 'rejected')
       OR (OLD."status" = 'rejected' AND NEW."status" = 'accepted'), false) THEN
    RAISE EXCEPTION 'task %: % -> % is not allowed', OLD."id", OLD."status", CASE WHEN NEW."status" ~ '^[a-z]{1,20}$' THEN NEW."status" ELSE '?' END
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- The asset, locked: it cannot be turned on or off under this move.
  SELECT * INTO a FROM "Asset" WHERE "id" = NEW."assetId" FOR SHARE;

  IF OLD."status" = 'proposed' AND NEW."status" = 'queued' THEN
    IF NEW."dispatchApprovalId" IS NULL THEN
      RAISE EXCEPTION 'task %: dispatching it needs an approval', OLD."id" USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT coalesce(a."enabled", false) THEN
      RAISE EXCEPTION 'task %: asset % is off', OLD."id", NEW."assetId" USING ERRCODE = 'insufficient_privilege';
    END IF;
    p := p5_signed_proposal(NEW."dispatchApprovalId", 'taskId', NEW."id", ARRAY[a."dispatchAction"]);
    PERFORM p5_bind_approval(NEW."dispatchApprovalId", 'taskId', NEW."id", a."dispatchAction");
    -- Only a time and a whole number are cast (a cast's error would repeat whatever text it was given), so each
    -- shape is checked first, in a step of its own.
    IF NOT coalesce(jsonb_typeof(p."args"->'dueAt') = 'null'
                    OR (p."args"->>'dueAt') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$', false) THEN
      RAISE EXCEPTION 'task %: the due time approval % signed is not a time', OLD."id", NEW."dispatchApprovalId" USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT coalesce(jsonb_typeof(p."args"->'estCostMicros') = 'number', false) THEN
      RAISE EXCEPTION 'task %: the estimate approval % signed is not a number', OLD."id", NEW."dispatchApprovalId" USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT coalesce(
         p."args" ?& ARRAY['assetId', 'assetKind', 'title', 'spec', 'acceptance', 'goalId', 'stepKey', 'dueAt', 'sensitivity', 'tainted', 'estCostMicros']
         AND p."args"->>'assetId' = NEW."assetId" AND p."args"->>'assetKind' = a."kind" AND p."args"->>'title' = NEW."title"
         AND p."args"->'spec' = NEW."spec" AND p."args"->'acceptance' = NEW."acceptance"
         AND p."args"->'goalId' = coalesce(to_jsonb(NEW."goalId"), 'null'::jsonb) AND p."args"->'stepKey' = coalesce(to_jsonb(NEW."stepKey"), 'null'::jsonb)
         AND (p."args"->>'dueAt')::timestamptz IS NOT DISTINCT FROM NEW."dueAt"
         AND p."args"->>'sensitivity' = NEW."sensitivity" AND p."args"->'tainted' = to_jsonb(NEW."tainted")
         AND p."sensitivity" = NEW."sensitivity" AND p."tainted" = NEW."tainted"
         AND (p."args"->>'estCostMicros')::numeric = NEW."estCostUsd" * 1000000, false) THEN
      RAISE EXCEPTION 'task %: it is not the task approval % signed', OLD."id", NEW."dispatchApprovalId" USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- Money: a spending asset's dispatch is a spend card, filed from the console, with the same estimate; any other costs nothing.
    IF a."spends" THEN
      IF NOT coalesce(p."kind" = 'spend' AND p."origin" IN ('console', 'cli') AND p."estCostUsd" = NEW."estCostUsd" AND NEW."estCostUsd" > 0, false) THEN
        RAISE EXCEPTION 'task %: a spending asset is dispatched by a spend card with its estimate', OLD."id" USING ERRCODE = 'insufficient_privilege';
      END IF;
    ELSIF NOT coalesce(p."kind" = 'task' AND NEW."estCostUsd" = 0, false) THEN
      RAISE EXCEPTION 'task %: an asset that does not spend is dispatched by a task card, at no cost', OLD."id" USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- Its forecast: an open assets prediction that it meets its bar, from the tasks writer, carrying the rule that
    -- says whose it is to settle: this task's (as a goal's forecast names its goal and its rule). The ledger's own
    -- sweep settles and runs out only what is its own: a prediction with a rule it does not know is left alone,
    -- and one with no rule at all would run out there before this task's score was due.
    PERFORM 1 FROM "Prediction" WHERE "id" = NEW."predictionId" AND "domain" = 'assets' AND "type" = 'task_meets_bar'
      AND "createdBy" = 'runtime:tasks' AND "status" = 'open' AND "resolver" = 'auto_world'
      AND "resolverSpec"->>'rule' = 'task_meets_bar' AND "resolverSpec"->>'taskId' = NEW."id" FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'task %: dispatching it needs its open forecast, with its rule', OLD."id" USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF NEW."dispatchApprovalId" IS DISTINCT FROM OLD."dispatchApprovalId" OR NEW."predictionId" IS DISTINCT FROM OLD."predictionId" THEN
    RAISE EXCEPTION 'task %: its approval and forecast are set when it is dispatched', OLD."id" USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW."status" = 'dispatched' THEN
    IF NOT coalesce(a."enabled", false) THEN
      RAISE EXCEPTION 'task %: asset % was turned off', OLD."id", NEW."assetId" USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW."dispatchedAt" := clock_timestamp();
  ELSIF NEW."dispatchedAt" IS DISTINCT FROM OLD."dispatchedAt" THEN
    RAISE EXCEPTION 'task %: dispatchedAt is set when it is dispatched', OLD."id" USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- When its result was handed in: the database's to say (an accept card counts only if signed after it).
  IF NEW."status" = 'submitted' THEN
    NEW."submittedAt" := clock_timestamp();
  ELSIF NEW."submittedAt" IS DISTINCT FROM OLD."submittedAt" THEN
    RAISE EXCEPTION 'task %: submittedAt is set when it is handed in', OLD."id" USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Checked and accepted only with its result on record: its reference names the output it has (the start of that output's digest).
  IF NEW."status" IN ('checking', 'accepted') AND NOT EXISTS (
       SELECT 1 FROM "TaskOutput" o
       WHERE o."taskId" = NEW."id" AND NEW."outputRef" = 'out:' || left(o."sha256", greatest(char_length(NEW."outputRef") - 4, 12))) THEN
    RAISE EXCEPTION 'task %: it is checked and accepted only with its result on record', OLD."id" USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW."status" = 'cancelled' AND OLD."status" <> 'proposed' THEN
    ok := false;
    FOR cand IN
      SELECT "approvalId" FROM "Proposal"
      WHERE "status" = 'executing' AND "action" = 'task.cancel' AND "approvalId" IS NOT NULL AND "args"->>'taskId' = OLD."id"
    LOOP
      BEGIN
        PERFORM p5_bind_approval(cand, 'taskId', OLD."id", 'task.cancel');
        ok := true;
        EXIT;
      EXCEPTION WHEN insufficient_privilege THEN
        CONTINUE;
      END;
    END LOOP;
    IF NOT ok THEN
      RAISE EXCEPTION 'task %: a dispatched task is cancelled only by a signed card', OLD."id" USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  IF NEW."status" IN ('accepted', 'rejected') THEN
    IF NEW."metBar" IS NULL THEN
      RAISE EXCEPTION 'task %: it ends accepted or rejected only after its bar was checked', OLD."id" USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF OLD."status" = 'checking' AND (NEW."status" = 'accepted') = NEW."metBar" THEN
      -- What the check found. Accepting it is task.check_bar: on its own only while a live policy row Will signed
      -- promotes exactly that (unscoped), and none holds it back; until then, on Will's signed card for this task.
      -- (Rejecting a failed check is Flint's own record, and needs neither.)
      IF NEW."status" = 'accepted' AND NOT (
           EXISTS (SELECT 1 FROM "ActionPolicy" ap WHERE ap."active" AND ap."expiresAt" > clock_timestamp() AND ap."tier" = 'alone'
                   AND ap."pattern" IN ('task.check_bar', 'task.*') AND (ap."scope" IS NULL OR jsonb_typeof(ap."scope") = 'null'))
           AND NOT EXISTS (SELECT 1 FROM "ActionPolicy" ap WHERE ap."active" AND ap."expiresAt" > clock_timestamp() AND ap."tier" <> 'alone'
                           AND ap."pattern" IN ('task.check_bar', 'task.*'))) THEN
        ok := false;
        -- The card signs what it accepts: this output, having met its bar, and it was signed after the result was
        -- handed in (a reference is the runtime's to choose: one signed before there was a result accepts nothing).
        FOR cand IN
          SELECT c."approvalId" FROM "Proposal" c JOIN "Approval" s ON s."id" = c."approvalId"
          WHERE c."status" = 'executing' AND c."action" = 'task.check_bar' AND c."args"->>'taskId' = OLD."id"
            AND c."args"->>'outputRef' = OLD."outputRef" AND c."args"->'metBar' = to_jsonb(NEW."metBar")
            AND s."createdAt" > OLD."submittedAt"
        LOOP
          BEGIN
            PERFORM p5_bind_approval(cand, 'taskId', OLD."id", 'task.check_bar');
            ok := true;
            EXIT;
          EXCEPTION WHEN insufficient_privilege THEN
            CONTINUE;
          END;
        END LOOP;
        IF NOT ok THEN
          RAISE EXCEPTION 'task %: accepting it needs Will''s signed card for this result until he lets Flint accept on its own', OLD."id" USING ERRCODE = 'insufficient_privilege';
        END IF;
      END IF;
    ELSE
      -- Not what the check found: Will's override, on a signed card that names this status, before the forecast is scored.
      override := true;
      ok := false;
      IF NEW."barCheckedBy" = 'will' THEN
        FOR cand IN
          SELECT "approvalId" FROM "Proposal"
          WHERE "status" = 'executing' AND "action" = 'task.bar_override' AND "approvalId" IS NOT NULL
            AND "args"->>'taskId' = OLD."id" AND "args"->>'to' = NEW."status"
        LOOP
          BEGIN
            PERFORM p5_bind_approval(cand, 'taskId', OLD."id", 'task.bar_override');
            ok := true;
            EXIT;
          EXCEPTION WHEN insufficient_privilege THEN
            CONTINUE;
          END;
        END LOOP;
      END IF;
      IF NOT ok THEN
        RAISE EXCEPTION 'task %: ending it against its check needs Will''s signed override', OLD."id" USING ERRCODE = 'insufficient_privilege';
      END IF;
      -- Its forecast, locked (recording a resolution locks the prediction too): none lands under this override.
      PERFORM 1 FROM "Prediction" WHERE "id" = OLD."predictionId" FOR SHARE;
      IF EXISTS (SELECT 1 FROM "Resolution" r WHERE r."predictionId" = OLD."predictionId") THEN
        RAISE EXCEPTION 'task %: its forecast is already scored', OLD."id" USING ERRCODE = 'insufficient_privilege';
      END IF;
    END IF;
    -- Accepted only with its own successful check (or override) on record.
    IF NEW."status" = 'accepted' AND NOT EXISTS (
         SELECT 1 FROM "AuditEntry" e
         WHERE e."id" = NEW."acceptedAuditId" AND e."kind" = 'action' AND e."outcome" = 'ok'
           AND e."action" IN ('task.check_bar', 'task.bar_override') AND e."correlationId" = 'task:' || NEW."id") THEN
      RAISE EXCEPTION 'task %: it is accepted only with its own successful check on record', OLD."id" USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF NEW."acceptedAuditId" IS DISTINCT FROM OLD."acceptedAuditId" THEN
    RAISE EXCEPTION 'task %: its proof is attached when it is accepted', OLD."id" USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF checker AND NOT (with_bar OR (override AND NEW."barCheckedBy" = 'will')) THEN
    RAISE EXCEPTION 'task %: who checked it is set with its bar, or by Will''s override', OLD."id" USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW."status" = 'failed' AND NEW."failure" IS NULL THEN
    RAISE EXCEPTION 'task %: a failed task says why', OLD."id" USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = ANY (terminal) THEN
    IF NOT ended THEN
      NEW."completedAt" := clock_timestamp();
    ELSIF NEW."completedAt" IS DISTINCT FROM OLD."completedAt" THEN
      RAISE EXCEPTION 'task %: completedAt is set once, when it ends', OLD."id" USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- A spending asset's task that went out ends with what it cost.
    IF coalesce(a."spends", true) AND OLD."dispatchedAt" IS NOT NULL AND NEW."costUsd" IS NULL THEN
      RAISE EXCEPTION 'task %: a spending task ends with its cost', OLD."id" USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF NEW."completedAt" IS DISTINCT FROM OLD."completedAt" THEN
    RAISE EXCEPTION 'task %: completedAt is set when it ends', OLD."id" USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

-- A task's own rules (the CHECKs it would otherwise have), naming the rule, never a value.
CREATE FUNCTION task_valid() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  bad text;
BEGIN
  bad := CASE
    WHEN NEW."id" IS NULL OR NEW."assetId" IS NULL OR NEW."tainted" IS NULL OR NEW."costIsEstimate" IS NULL OR NEW."createdAt" IS NULL OR NEW."updatedAt" IS NULL THEN 'a required field'
    WHEN NOT coalesce(NEW."id" ~ '^[A-Za-z0-9_-]{1,40}$' AND NEW."assetId" ~ '^[A-Za-z0-9_-]{1,40}$', false) THEN 'id'
    WHEN NOT coalesce(NEW."status" IN ('proposed', 'queued', 'dispatched', 'running', 'submitted', 'checking', 'accepted', 'rejected', 'failed', 'cancelled'), false) THEN 'status'
    WHEN NOT coalesce(NEW."origin" IN ('will', 'flint'), false) THEN 'origin'
    WHEN NOT coalesce(NEW."sensitivity" IN ('ops', 'personal', 'financial'), false) THEN 'sensitivity'
    WHEN NOT coalesce(char_length(NEW."title") BETWEEN 1 AND 200, false) THEN 'title'
    WHEN NOT coalesce(NEW."spec" IS NULL OR (jsonb_typeof(NEW."spec") = 'object' AND octet_length(NEW."spec"::text) <= 16384
                      AND (NEW."spec"->>'template') ~ '^[a-z][a-z0-9_]{0,39}$'), false) THEN 'spec'
    WHEN NOT coalesce(NEW."acceptance" IS NULL OR (jsonb_typeof(NEW."acceptance") = 'array' AND jsonb_array_length(NEW."acceptance") BETWEEN 1 AND 10
                      AND octet_length(NEW."acceptance"::text) <= 8192), false) THEN 'bar'
    WHEN NOT coalesce((NEW."spec" IS NOT NULL AND NEW."acceptance" IS NOT NULL) OR NEW."textPurgedAt" IS NOT NULL, false) THEN 'purge'
    WHEN NOT coalesce(NEW."entityIds" IS NOT NULL AND cardinality(NEW."entityIds") <= 20 AND array_position(NEW."entityIds", NULL) IS NULL
                      AND (cardinality(NEW."entityIds") = 0 OR array_to_string(NEW."entityIds", ',') ~ '^[A-Za-z0-9_-]{1,40}(,[A-Za-z0-9_-]{1,40})*$'), false) THEN 'items'
    WHEN NOT coalesce((NEW."goalId" IS NULL OR NEW."goalId" ~ '^[A-Za-z0-9_-]{1,40}$')
                      AND (NEW."stepKey" IS NULL OR (NEW."goalId" IS NOT NULL AND NEW."stepKey" ~ '^s[0-9]{1,3}$')), false) THEN 'step'
    WHEN NOT coalesce(NEW."outputSummary" IS NULL OR char_length(NEW."outputSummary") <= 1000, false) THEN 'summary'
    WHEN NOT coalesce(NEW."barEvidence" IS NULL OR (jsonb_typeof(NEW."barEvidence") = 'array' AND octet_length(NEW."barEvidence"::text) <= 8192), false) THEN 'evidence'
    WHEN NOT coalesce((NEW."metBar" IS NULL) = (NEW."barCheckedBy" IS NULL)
                      AND (NEW."barCheckedBy" IS NULL OR NEW."barCheckedBy" ~ '^(flint:rule|ollama:[A-Za-z0-9._:/-]{1,80}|will)$'), false) THEN 'checker'
    -- Why it failed is a class, never words; only a failed task has one.
    WHEN NOT coalesce((NEW."failure" IS NULL OR NEW."failure" IN ('unavailable', 'invalid', 'capped', 'timeout', 'asset_off', 'budget', 'expired', 'error'))
                      AND (NEW."failure" IS NULL OR NEW."status" = 'failed'), false) THEN 'failure'
    WHEN NOT coalesce(NEW."estCostUsd" >= 0 AND (NEW."costUsd" IS NULL OR NEW."costUsd" >= 0), false) THEN 'cost'
    WHEN NOT coalesce(NEW."attempts" BETWEEN 0 AND 100, false) THEN 'attempts'
    WHEN NOT coalesce(NEW."status" IN ('proposed', 'cancelled') OR NEW."dispatchApprovalId" IS NOT NULL, false) THEN 'approval'
    WHEN NOT coalesce(NEW."status" NOT IN ('submitted', 'checking', 'accepted', 'rejected') OR NEW."outputRef" IS NOT NULL, false) THEN 'output'
    WHEN NOT coalesce(NEW."status" <> 'accepted' OR NEW."acceptedAuditId" IS NOT NULL, false) THEN 'proof'
    WHEN NOT coalesce((NEW."dispatchApprovalId" IS NULL OR NEW."dispatchApprovalId" ~ '^[A-Za-z0-9_-]{1,40}$')
                      AND (NEW."externalJobId" IS NULL OR NEW."externalJobId" ~ '^[A-Za-z0-9_.:@/-]{1,120}$')
                      AND (NEW."outputRef" IS NULL OR NEW."outputRef" ~ '^[a-z_]{2,20}[:#][A-Za-z0-9_.:@-]{1,99}$')
                      AND (NEW."acceptedAuditId" IS NULL OR NEW."acceptedAuditId" ~ '^[A-Za-z0-9_-]{1,40}$')
                      AND (NEW."predictionId" IS NULL OR NEW."predictionId" ~ '^[A-Za-z0-9_-]{1,40}$'), false) THEN 'references'
  END;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'task %: its % is not valid', CASE WHEN NEW."id" ~ '^[A-Za-z0-9_-]{1,40}$' THEN NEW."id" ELSE '?' END, bad USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- A task's raw output: written once, now, while the task is out; always marked
-- as outside text (a model wrote it); never updated; deleted only once the task
-- has ended (retention) or in a forget. None is taken once the task's text was
-- cleared (a forget of an item it is about): nothing is written back after
-- that. Its own rules are checked here, by the task's id only: the body is a
-- model's words.
CREATE FUNCTION task_output_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  forgetting boolean := current_user = 'flint_owner' AND coalesce(current_setting('flint.forget_approval', true), '') <> '';
  st text;
  purged timestamptz;
  bad text;
BEGIN
  IF TG_OP IN ('TRUNCATE', 'UPDATE') THEN
    RAISE EXCEPTION 'a task''s output is written once' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT coalesce(NEW."taskId" ~ '^[A-Za-z0-9_-]{1,40}$', false) THEN
      RAISE EXCEPTION 'task output: the id of its task is not valid' USING ERRCODE = 'check_violation';
    END IF;
    bad := CASE
      WHEN NEW."body" IS NULL OR jsonb_typeof(NEW."body") <> 'object' THEN 'body'
      WHEN octet_length(NEW."body"::text) > 32768 THEN 'size'
      WHEN NOT coalesce(NEW."sha256" ~ '^[0-9a-f]{64}$', false) THEN 'digest'
      WHEN NEW."tainted" IS DISTINCT FROM true THEN 'taint'
    END;
    IF bad IS NOT NULL THEN
      RAISE EXCEPTION 'task %: the % of its output is not valid', NEW."taskId", bad USING ERRCODE = 'check_violation';
    END IF;
    -- The task, locked: it cannot be moved on under this.
    SELECT "status", "textPurgedAt" INTO st, purged FROM "Task" WHERE "id" = NEW."taskId" FOR SHARE;
    IF NOT coalesce(st IN ('dispatched', 'running'), false) THEN
      RAISE EXCEPTION 'task %: output is taken only while it is out', NEW."taskId" USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF purged IS NOT NULL THEN
      RAISE EXCEPTION 'task %: its text was cleared, so no output is taken', NEW."taskId" USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW."createdAt" := clock_timestamp();
    RETURN NEW;
  END IF;
  SELECT "status" INTO st FROM "Task" WHERE "id" = OLD."taskId";
  IF NOT (forgetting OR coalesce(st IN ('accepted', 'rejected', 'failed', 'cancelled'), false)) THEN
    RAISE EXCEPTION 'task %: its output is kept until it has ended', OLD."taskId" USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN OLD;
END;
$$;

-- ---- Reviews -----------------------------------------------------------------------------
-- A review is written once, now, of exactly what it names: a card still waiting
-- for Will (locked, so the card cannot be approved under it), by that card's args
-- digest, at least as tainted and exactly as sensitive as the card; or a task
-- being checked, by its output's digest, always tainted (it read a model's
-- words). The other subject types have no writer yet. A review needs its
-- reviewer: one from the local engine is taken only while a local reviewer is on
-- (locked, so it is not turned off under this), and none from the paid panel is
-- taken at all until there is a card that says its price first. None is written
-- of a card whose args are gone or a task whose text was cleared (a forget):
-- there is nothing left to review, and nothing is written back.
CREATE FUNCTION review_insert_check() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  p "Proposal"%ROWTYPE;
  t "Task"%ROWTYPE;
BEGIN
  IF NOT coalesce(NEW."id" ~ '^[A-Za-z0-9_-]{1,40}$' AND NEW."subjectId" ~ '^[A-Za-z0-9_-]{1,40}$', false) THEN
    RAISE EXCEPTION 'review: its id or its subject''s is not valid' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."textPurgedAt" IS NOT NULL OR NEW."overridePredictionId" IS NOT NULL THEN
    RAISE EXCEPTION 'review %: these are set later', NEW."id" USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."engine" = 'trident_panel' THEN
    RAISE EXCEPTION 'review %: no paid review is taken yet', NEW."id" USING ERRCODE = 'insufficient_privilege';
  ELSIF NEW."engine" = 'local_adj' THEN
    PERFORM 1 FROM "Asset" a WHERE a."kind" = 'local_reviewer' AND a."enabled" FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'review %: no reviewer is on', NEW."id" USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  IF NEW."subjectType" = 'proposal' THEN
    SELECT * INTO p FROM "Proposal" WHERE "id" = NEW."subjectId" AND "status" = 'pending' FOR SHARE;
    IF NOT FOUND OR NOT coalesce(p."argsDigest" = NEW."subjectDigest" AND (NEW."tainted" OR NOT p."tainted") AND NEW."sensitivity" = p."sensitivity", false) THEN
      RAISE EXCEPTION 'review %: it is not of card % as it waits', NEW."id", NEW."subjectId" USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF p."args" IS NULL THEN
      RAISE EXCEPTION 'review %: card % has no args left to review', NEW."id", NEW."subjectId" USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF NEW."subjectType" = 'task' THEN
    SELECT * INTO t FROM "Task" WHERE "id" = NEW."subjectId" AND "status" = 'checking' FOR SHARE;
    -- (A task whose text was cleared has no output left, and takes none: there is nothing of it to review.)
    IF NOT FOUND OR NOT coalesce(NEW."tainted" AND NEW."sensitivity" = t."sensitivity" AND t."textPurgedAt" IS NULL, false)
       OR NOT EXISTS (SELECT 1 FROM "TaskOutput" o WHERE o."taskId" = t."id" AND o."sha256" = NEW."subjectDigest") THEN
      RAISE EXCEPTION 'review %: it is not of task %''s output as it is checked', NEW."id", NEW."subjectId" USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSE
    RAISE EXCEPTION 'review %: nothing reviews that kind of subject yet', NEW."id" USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW."createdAt" := clock_timestamp();
  RETURN NEW;
END;
$$;

-- What a review found never changes, and it is never deleted. Its words (the
-- case against, the case for, the reason) may be cleared, by retention or a
-- forget, never rewritten; and never while its card still waits for Will or its
-- task is still being checked (but in a forget): a block's words are there when
-- he decides. The forecast that scores Will's approval past a block
-- is attached once: to a block, on a card he approved with this review attached,
-- and only a forecast from the reviews writer.
-- (guard_append_only allows changes only inside a forget, so it cannot say this.)
CREATE FUNCTION review_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  forgetting boolean := current_user = 'flint_owner' AND coalesce(current_setting('flint.forget_approval', true), '') <> '';
  words text[] := ARRAY['attack', 'defense', 'verdictReason'];
  o jsonb := to_jsonb(OLD);
  n jsonb := to_jsonb(NEW);
  k text;
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'reviews are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (n - words - 'textPurgedAt' - 'overridePredictionId') IS DISTINCT FROM (o - words - 'textPurgedAt' - 'overridePredictionId') THEN
    RAISE EXCEPTION 'review %: what it found never changes', OLD."id" USING ERRCODE = 'insufficient_privilege';
  END IF;
  FOREACH k IN ARRAY words LOOP
    IF (n -> k) IS DISTINCT FROM (o -> k) AND NOT ((n -> k) = 'null'::jsonb AND NEW."textPurgedAt" IS NOT NULL) THEN
      RAISE EXCEPTION 'review %: its words may only be cleared', OLD."id" USING ERRCODE = 'insufficient_privilege';
    END IF;
  END LOOP;
  IF OLD."textPurgedAt" IS NOT NULL AND NEW."textPurgedAt" IS DISTINCT FROM OLD."textPurgedAt" THEN
    RAISE EXCEPTION 'review %: its text is cleared once', OLD."id" USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT forgetting
     AND (NEW."textPurgedAt" IS DISTINCT FROM OLD."textPurgedAt" OR NEW."attack" IS DISTINCT FROM OLD."attack"
          OR NEW."defense" IS DISTINCT FROM OLD."defense" OR NEW."verdictReason" IS DISTINCT FROM OLD."verdictReason")
     AND ((OLD."subjectType" = 'proposal' AND EXISTS (SELECT 1 FROM "Proposal" c WHERE c."id" = OLD."subjectId" AND c."status" = 'pending'))
       OR (OLD."subjectType" = 'task' AND EXISTS (SELECT 1 FROM "Task" t WHERE t."id" = OLD."subjectId" AND t."status" = 'checking'))) THEN
    RAISE EXCEPTION 'review %: its words are kept while what it reviews still waits', OLD."id" USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."overridePredictionId" IS DISTINCT FROM OLD."overridePredictionId" THEN
    IF OLD."overridePredictionId" IS NOT NULL OR OLD."verdict" <> 'block' OR OLD."subjectType" <> 'proposal'
       OR NOT EXISTS (SELECT 1 FROM "Proposal" p JOIN "Approval" a ON a."id" = p."approvalId" AND a."decision" = 'approve'
                      WHERE p."id" = OLD."subjectId" AND p."reviewId" = OLD."id")
       OR NOT EXISTS (SELECT 1 FROM "Prediction" f WHERE f."id" = NEW."overridePredictionId" AND f."domain" = 'assets'
                      AND f."type" = 'effect_given_accept' AND f."createdBy" = 'runtime:reviews') THEN
      RAISE EXCEPTION 'review %: an override''s forecast is attached once, to a block Will approved past', OLD."id" USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- A review's own rules (the CHECKs it would otherwise have), naming the rule, never a value.
CREATE FUNCTION review_valid() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  bad text;
BEGIN
  bad := CASE
    WHEN NEW."id" IS NULL OR NEW."subjectId" IS NULL OR NEW."agreed" IS NULL OR NEW."shadow" IS NULL OR NEW."tainted" IS NULL OR NEW."createdAt" IS NULL THEN 'a required field'
    WHEN NOT coalesce(NEW."id" ~ '^[A-Za-z0-9_-]{1,40}$' AND NEW."subjectId" ~ '^[A-Za-z0-9_-]{1,40}$', false) THEN 'id'
    WHEN NOT coalesce(NEW."subjectType" IN ('proposal', 'task', 'recommendation', 'change_request'), false) THEN 'subject'
    WHEN NOT coalesce(NEW."subjectDigest" ~ '^[0-9a-f]{64}$', false) THEN 'digest'
    WHEN NOT coalesce(NEW."engine" IN ('local_adj', 'trident_panel'), false) THEN 'engine'
    WHEN NOT coalesce(NEW."verdict" IN ('proceed', 'proceed_with_changes', 'block'), false) THEN 'verdict'
    -- NaN sorts above every number here, so BETWEEN refuses it too.
    WHEN NOT coalesce(NEW."confidence" BETWEEN 0 AND 1, false) THEN 'confidence'
    WHEN NOT coalesce(NEW."sensitivity" IN ('ops', 'personal', 'financial'), false) THEN 'sensitivity'
    WHEN NOT coalesce(jsonb_typeof(NEW."models") = 'object' AND octet_length(NEW."models"::text) <= 1024, false) THEN 'models'
    WHEN NOT coalesce(jsonb_typeof(NEW."findings") = 'array' AND octet_length(NEW."findings"::text) <= 4096, false) THEN 'findings'
    WHEN NOT coalesce(NEW."reasonCodes" IS NOT NULL AND cardinality(NEW."reasonCodes") <= 8 AND array_position(NEW."reasonCodes", NULL) IS NULL
                      AND (cardinality(NEW."reasonCodes") = 0 OR array_to_string(NEW."reasonCodes", ',') ~ '^[a-z][a-z0-9_]{0,39}(,[a-z][a-z0-9_]{0,39})*$'), false) THEN 'reason codes'
    WHEN NOT coalesce((NEW."attack" IS NULL OR char_length(NEW."attack") <= 2000) AND (NEW."defense" IS NULL OR char_length(NEW."defense") <= 2000)
                      AND (NEW."verdictReason" IS NULL OR char_length(NEW."verdictReason") <= 500), false) THEN 'words'
    -- The local engine is free, and no paid review is taken yet (review_insert_check): no review carries a cost.
    WHEN NOT coalesce(coalesce(NEW."costUsd", 0) = 0, false) THEN 'cost'
    WHEN NOT coalesce(NEW."modelMs" IS NULL OR NEW."modelMs" >= 0, false) THEN 'time'
  END;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'review %: its % is not valid', CASE WHEN NEW."id" ~ '^[A-Za-z0-9_-]{1,40}$' THEN NEW."id" ELSE '?' END, bad USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- ---- The review gate -------------------------------------------------------------------------
-- Whether a card that needs a review can be approved without one. One row, made
-- here, off. It changes only as an executing review.enforce card says (that exact
-- value), in the transaction that uses its approval, at READ COMMITTED, and only
-- by the latest review.enforce card he signed (a card he signed earlier does
-- not undo his later decision, whichever is carried out first); requiring
-- reviews also needs a reviewer that is on. Stamped by the wall clock.
CREATE FUNCTION review_gate_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  p "Proposal"%ROWTYPE;
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    -- Its one row is made by the migration (the owner), and stays.
    IF TG_OP = 'INSERT' AND current_user = 'flint_owner' AND NOT coalesce(NEW."enforced", true) AND NEW."approvalId" IS NULL THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'the review gate is one row, and stays' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."enforced" IS NULL OR NEW."enforced" IS NOT DISTINCT FROM OLD."enforced"
     OR NEW."approvalId" IS NULL OR NEW."approvalId" IS NOT DISTINCT FROM OLD."approvalId" THEN
    RAISE EXCEPTION 'the review gate changes only with a new approval' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'the review gate changes at read committed only' USING ERRCODE = 'serialization_failure';
  END IF;
  p := p5_signed_proposal(NEW."approvalId", 'gate', 'proposal', ARRAY['review.enforce']);
  PERFORM p5_bind_approval(NEW."approvalId", 'gate', 'proposal', 'review.enforce');
  IF (p."args"->'enforced') IS DISTINCT FROM to_jsonb(NEW."enforced") THEN
    RAISE EXCEPTION 'the review gate: not what approval % signed', NEW."approvalId" USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- (Turning a reviewer off locks this row first, so none is turned off under this check.)
  IF NEW."enforced" AND NOT EXISTS (SELECT 1 FROM "Asset" a WHERE a."kind" = 'local_reviewer' AND a."enabled") THEN
    RAISE EXCEPTION 'the review gate: requiring reviews needs a reviewer that is on' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW."changedAt" := clock_timestamp();
  RETURN NEW;
END;
$$;

-- ---- Which cards need a review ------------------------------------------------------------------
-- The floor under "needs a review", whatever the writer says: a card with outside
-- text, one that cannot be undone, one that spends, changes policy or a rule,
-- opens a pull request, forgets or voids, or touches money. (The runtime's own
-- classifier may ask for more; it can never ask for less.) Never the card that
-- turns the requirement itself on or off: it must stay signable when no reviewer
-- can answer. That card is a policy card from the console or the CLI; anything
-- else under its name is held to the floor like any other card. A card is born
-- unreviewed.
CREATE FUNCTION proposal_review_floor() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW."reviewId" IS NOT NULL THEN
    RAISE EXCEPTION 'proposal %: a card starts unreviewed', CASE WHEN NEW."id" ~ '^[A-Za-z0-9_-]{1,64}$' THEN NEW."id" ELSE '?' END
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF coalesce(NEW."action" = 'review.enforce' AND NEW."kind" = 'policy' AND NEW."origin" IN ('console', 'cli'), false) THEN
    NEW."reviewRequired" := false;
  ELSIF coalesce(NEW."tainted" OR NEW."destructive" OR NEW."kind" IN ('spend', 'policy', 'rule', 'pr', 'forget', 'void') OR NEW."sensitivity" = 'financial', false) THEN
    NEW."reviewRequired" := true;
  ELSE
    -- Never NULL: a refused NOT NULL would write the card's row into the error.
    NEW."reviewRequired" := coalesce(NEW."reviewRequired", false);
  END IF;
  RETURN NEW;
END;
$$;

-- Whether a card needs a review never changes. Its review is attached once, while
-- it waits, and is a review of this card's args as they are. While reviews are
-- required, a card that needs one is approved only with it attached, and only by
-- an approval whose signed fields name that review and its verdict, signed once
-- the review was written: Will signs what he was shown, a block included, and
-- never a review that did not exist yet. The gate is locked while it is read, so it
-- cannot be turned on under an approval. (Fires before proposal_transition, by
-- name order, so nothing is consumed before this has had its say.)
CREATE FUNCTION proposal_review_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  r "Review"%ROWTYPE;
  f jsonb;
  signed_at timestamptz;
  required boolean;
BEGIN
  IF NEW."reviewRequired" IS DISTINCT FROM OLD."reviewRequired" THEN
    RAISE EXCEPTION 'proposal %: whether it needs a review never changes', OLD."id" USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."reviewId" IS DISTINCT FROM OLD."reviewId" THEN
    IF OLD."reviewId" IS NOT NULL OR OLD."status" <> 'pending' OR NEW."status" IS DISTINCT FROM 'pending' THEN
      RAISE EXCEPTION 'proposal %: its review is attached once, while it waits', OLD."id" USING ERRCODE = 'insufficient_privilege';
    END IF;
    SELECT * INTO r FROM "Review" WHERE "id" = NEW."reviewId";
    IF NOT FOUND OR NOT coalesce(r."subjectType" = 'proposal' AND r."subjectId" = OLD."id" AND r."subjectDigest" = OLD."argsDigest", false) THEN
      RAISE EXCEPTION 'proposal %: that review is not a review of it', OLD."id" USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  IF OLD."status" = 'pending' AND NEW."status" = 'approved' AND OLD."reviewRequired" THEN
    SELECT g."enforced" INTO required FROM "ReviewGate" g WHERE g."id" = 'proposal' FOR SHARE;
    IF coalesce(required, true) THEN
      IF OLD."reviewId" IS NULL THEN
        RAISE EXCEPTION 'proposal %: it needs a review before it is approved', OLD."id" USING ERRCODE = 'insufficient_privilege';
      END IF;
      SELECT * INTO r FROM "Review" WHERE "id" = OLD."reviewId";
      SELECT a."payload"->'fields', a."createdAt" INTO f, signed_at FROM "Approval" a WHERE a."id" = NEW."approvalId";
      IF NOT coalesce(f->>'reviewId' = r."id" AND f->>'verdict' = r."verdict", false) THEN
        RAISE EXCEPTION 'proposal %: the approval does not name the review Will was shown', OLD."id" USING ERRCODE = 'insufficient_privilege';
      END IF;
      -- A review's id is the runtime's to choose: a signature that names one written afterwards was not of something he was shown.
      IF NOT coalesce(r."createdAt" <= signed_at, false) THEN
        RAISE EXCEPTION 'proposal %: its review was written after Will signed', OLD."id" USING ERRCODE = 'insufficient_privilege';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- Every approved card that needed a review, and whether its review came first.
-- The share with reviewedFirst is the coverage a trial reports;
-- review_gate_violations (below) is the invariant.
CREATE VIEW review_coverage AS
SELECT p."id", p."action", a."createdAt" AS "approvedAt", r."createdAt" AS "reviewedAt",
       coalesce(r."createdAt" <= a."createdAt", false) AS "reviewedFirst"
FROM "Proposal" p
JOIN "Approval" a ON a."id" = p."approvalId" AND a."decision" = 'approve'
LEFT JOIN "Review" r ON r."id" = p."reviewId"
WHERE p."reviewRequired";

-- Must stay empty: a card that needed a review and was approved without one
-- first, since reviews were last required. While they are not required it is
-- empty by definition.
CREATE VIEW review_gate_violations AS
SELECT c.* FROM review_coverage c
WHERE NOT c."reviewedFirst" AND c."approvedAt" >= (SELECT g."changedAt" FROM "ReviewGate" g WHERE g."id" = 'proposal' AND g."enforced");

-- ---- Plan steps: a Flint task is done only when its task was accepted -----------------------
-- P3's plan_step_guard, with one rule added (the last block; the rest is P3's
-- body, to the letter). A step of kind asset_task names only a task of its own
-- goal and key, and is done only when that task is accepted: Will cannot tick it,
-- and neither can the runtime without the task's own proof (task_guard). A copy
-- into a new draft keeps what a version that was active already had. CREATE OR
-- REPLACE keeps the function's owner, its grants and its REVOKE FROM PUBLIC;
-- down.sql puts P3's own body back to the letter.
CREATE OR REPLACE FUNCTION plan_step_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
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
  -- P5. A Flint task: its step names only a task of this goal and step, and is done only when that task was
  -- accepted. A copy into a new draft keeps what a version that was active already had.
  IF NEW."kind" = 'asset_task' THEN
    IF NEW."taskId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."taskId" IS DISTINCT FROM OLD."taskId")
       AND NOT EXISTS (SELECT 1 FROM "Task" t WHERE t."id" = NEW."taskId" AND t."goalId" = pl."goalId" AND t."stepKey" = NEW."key") THEN
      RAISE EXCEPTION 'step %: its task is a task of this goal and step', NEW."id" USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW."status" = 'done' AND (TG_OP = 'INSERT' OR OLD."status" <> 'done' OR NEW."taskId" IS DISTINCT FROM OLD."taskId")
       AND NOT EXISTS (SELECT 1 FROM "Task" t WHERE t."id" = NEW."taskId" AND t."goalId" = pl."goalId" AND t."stepKey" = NEW."key" AND t."status" = 'accepted')
       AND NOT (TG_OP = 'INSERT' AND EXISTS (
         SELECT 1 FROM "PlanStep" o JOIN "Plan" op ON op."id" = o."planId"
         WHERE op."goalId" = pl."goalId" AND op."approvalId" IS NOT NULL AND o."key" = NEW."key" AND o."kind" = 'asset_task'
           AND o."status" = 'done' AND o."taskId" IS NOT DISTINCT FROM NEW."taskId"
       )) THEN
      RAISE EXCEPTION 'step %: a Flint task is done only when its task was accepted', NEW."id" USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- ---- Forget reaches tasks and reviews ---------------------------------------------------------
-- forget_entity() marks the entity forgotten; this then clears what is kept here
-- that names it: the words of tasks about it (by the items they list, or by its
-- id in their spec) and their outputs; the args of those tasks' cards (a
-- dispatch card holds the task's title, spec and bar, and may not hold the
-- item's id at all); the words of the reviews of those tasks, of those cards,
-- and of every card whose args name it (forget_entity clears those cards' args
-- itself, after this); and the words of each of those tasks' own forecasts, as
-- forget_entity blanks the forecasts about the item itself (the numbers and the
-- outcome stay). Verdicts, numbers and ids stay.
--
-- A write in flight does not outlive it. The cards are locked first, then the
-- tasks (the order a dispatch takes its card and its task in): a review being
-- written of one of those cards holds the card, and an output or a review being
-- written of one of those tasks holds the task, so each has landed, or has not
-- begun, before its rows are cleared; outputs go after their tasks, reviews
-- after both. At READ COMMITTED only, so each of these statements reads what
-- has landed by then. Afterwards task_output_guard and review_insert_check
-- refuse a task whose text was cleared and a card whose args are gone, and
-- p5_card_valid a result onto such a card.
CREATE FUNCTION entity_forgotten_p5() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  tasks text[];
  cards text[];
  forecasts text[];
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'entity %: it is forgotten at read committed only', NEW."id" USING ERRCODE = 'serialization_failure';
  END IF;
  SELECT coalesce(array_agg("id"), '{}') INTO tasks FROM "Task"
  WHERE NEW."id" = ANY ("entityIds") OR ("spec" IS NOT NULL AND strpos("spec"::text, NEW."id") > 0);
  -- The cards of those tasks, and the cards that name the item themselves, while their args are still there to tell.
  SELECT coalesce(array_agg("id"), '{}') INTO cards FROM "Proposal"
  WHERE "args" IS NOT NULL AND (strpos("args"::text, NEW."id") > 0 OR "args"->>'taskId' = ANY (tasks));
  PERFORM 1 FROM "Proposal" WHERE "id" = ANY (cards) ORDER BY "id" FOR UPDATE;
  UPDATE "Task" SET "spec" = NULL, "acceptance" = NULL, "outputSummary" = NULL, "barEvidence" = NULL, "textPurgedAt" = coalesce("textPurgedAt", now())
  WHERE "id" = ANY (tasks) AND ("spec" IS NOT NULL OR "acceptance" IS NOT NULL OR "outputSummary" IS NOT NULL OR "barEvidence" IS NOT NULL);
  DELETE FROM "TaskOutput" WHERE "taskId" = ANY (tasks);
  UPDATE "Review" SET "attack" = NULL, "defense" = NULL, "verdictReason" = NULL, "textPurgedAt" = coalesce("textPurgedAt", now())
  WHERE ("attack" IS NOT NULL OR "defense" IS NOT NULL OR "verdictReason" IS NOT NULL)
    AND (("subjectType" = 'task' AND "subjectId" = ANY (tasks)) OR ("subjectType" = 'proposal' AND "subjectId" = ANY (cards)));
  -- A task's cards that do not name the item (forget_entity would pass them by): cleared as it clears the others.
  UPDATE "Proposal" SET "args" = NULL, "argsPurgedAt" = coalesce("argsPurgedAt", now()), "reason" = NULL, "result" = NULL, "error" = NULL
  WHERE "id" = ANY (cards) AND "args" IS NOT NULL AND "args"->>'taskId' = ANY (tasks) AND strpos("args"::text, NEW."id") = 0;
  -- Each task's own forecast (its claim says the task), its resolution and any correction of it: blanked as forget_entity blanks them.
  SELECT coalesce(array_agg("predictionId"), '{}') INTO forecasts FROM "Task" WHERE "id" = ANY (tasks) AND "predictionId" IS NOT NULL;
  UPDATE "Prediction" SET "claim" = '[forgotten]', "evidence" = '[]'::jsonb, "resolutionCriteria" = '[forgotten]', "resolverSpec" = NULL, "modelConfig" = NULL
  WHERE "id" = ANY (forecasts) AND "claim" <> '[forgotten]';
  UPDATE "Resolution" SET "evidence" = NULL WHERE "predictionId" = ANY (forecasts) AND "evidence" IS NOT NULL;
  UPDATE "ResolutionCorrection" SET "reason" = '[forgotten]'
  WHERE "resolutionId" IN (SELECT r."id" FROM "Resolution" r WHERE r."predictionId" = ANY (forecasts)) AND "reason" <> '[forgotten]';
  RETURN NULL;
END;
$$;

-- ---- A task's forecast is scored as its task ended, and not before Will could overrule it ----------
-- A forecast that a task meets its bar (told by its own domain and type, which
-- never change) is scored only for its task, whoever records the resolution:
-- the task has ended as accepted, rejected or failed, a day ago or more, and
-- the outcome says whether it was accepted. So the runtime cannot end Will's
-- right to overrule a check by scoring first, nor score a task that is still
-- out or a forecast that has no task yet, nor record an outcome the task did
-- not have. A cancelled task's forecast is left to expire.
--
-- It is decided by the forecast, never by the task's link to it alone: a
-- dispatch still in flight has not committed that link. The forecast is locked
-- first, and the task is looked up after. A dispatch holds the forecast until
-- its link is committed, and an override until the task's new status is: one
-- that has it makes this wait, and is then read; one that comes later waits
-- for this, and then finds the forecast scored. At READ COMMITTED only, so the
-- lookup reads what is committed by then. Fires before P1's
-- Resolution_leak_guard (name order), which takes the same lock, and would
-- otherwise take it only after the task had been read.
CREATE FUNCTION resolution_task_check() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  pid text := CASE WHEN NEW."predictionId" ~ '^[A-Za-z0-9_-]{1,40}$' THEN NEW."predictionId" ELSE '?' END;
  mine boolean;
  t "Task"%ROWTYPE;
BEGIN
  SELECT coalesce(f."domain" = 'assets' AND f."type" = 'task_meets_bar', false) INTO mine FROM "Prediction" f WHERE f."id" = NEW."predictionId" FOR UPDATE;
  IF NOT FOUND THEN
    -- (P1's guard would say so next. Said here, so that a forecast made while this statement runs is never scored unseen.)
    RAISE EXCEPTION 'resolution: there is no prediction % to score', pid USING ERRCODE = 'check_violation';
  END IF;
  IF NOT mine THEN
    RETURN NEW;
  END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'prediction %: a task''s forecast is scored at read committed only', pid USING ERRCODE = 'serialization_failure';
  END IF;
  SELECT * INTO t FROM "Task" WHERE "predictionId" = NEW."predictionId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'prediction %: a task''s forecast is scored only for its task', pid USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT coalesce(t."status" IN ('accepted', 'rejected', 'failed') AND t."completedAt" <= clock_timestamp() - interval '24 hours', false) THEN
    RAISE EXCEPTION 'task %: its forecast is scored a day after it ended as accepted, rejected or failed', t."id" USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."outcome" IS DISTINCT FROM (t."status" = 'accepted') THEN
    RAISE EXCEPTION 'task %: its forecast''s outcome is whether it was accepted', t."id" USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

-- ---- A step whose task Will rejected is no longer done -------------------------------------------------
-- A Flint-task step is done only when its task was accepted (plan_step_guard,
-- above). When Will overrules that acceptance, the step in the goal's active
-- plan that the task had done goes back to blocked, in the same transaction
-- (P3's step guard takes the goal's lock, as every step write does). A task
-- that is live again for the step is then the only way it is done again: one
-- live task per step (Task_one_live_per_step_key).
CREATE FUNCTION task_step_undone() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE "PlanStep" s SET "status" = 'blocked', "doneAt" = NULL
  FROM "Plan" pl
  WHERE pl."id" = s."planId" AND pl."goalId" = NEW."goalId" AND pl."status" = 'active'
    AND s."key" = NEW."stepKey" AND s."kind" = 'asset_task' AND s."taskId" = NEW."id" AND s."status" = 'done';
  RETURN NULL;
END;
$$;

-- ---- Triggers --------------------------------------------------------------------------------------
CREATE TRIGGER "Asset_insert_check" BEFORE INSERT ON "Asset"
  FOR EACH ROW EXECUTE FUNCTION asset_insert_check();
CREATE TRIGGER "Asset_guard" BEFORE UPDATE OR DELETE ON "Asset"
  FOR EACH ROW EXECUTE FUNCTION asset_guard();
CREATE TRIGGER "Asset_no_truncate" BEFORE TRUNCATE ON "Asset"
  FOR EACH STATEMENT EXECUTE FUNCTION asset_guard();
-- Every on and off, with who did it (flint.actor).
CREATE TRIGGER "Asset_history" AFTER UPDATE ON "Asset"
  FOR EACH ROW EXECUTE FUNCTION row_history();

CREATE TRIGGER "Task_insert_check" BEFORE INSERT ON "Task"
  FOR EACH ROW EXECUTE FUNCTION task_insert_check();
CREATE TRIGGER "Task_guard" BEFORE UPDATE OR DELETE ON "Task"
  FOR EACH ROW EXECUTE FUNCTION task_guard();
CREATE TRIGGER "Task_no_truncate" BEFORE TRUNCATE ON "Task"
  FOR EACH STATEMENT EXECUTE FUNCTION task_guard();
CREATE TRIGGER "Task_history" AFTER UPDATE ON "Task"
  FOR EACH ROW EXECUTE FUNCTION row_history_masked('title', 'spec', 'acceptance', 'outputSummary', 'barEvidence');
CREATE TRIGGER "Task_step_undone" AFTER UPDATE OF "status" ON "Task"
  FOR EACH ROW WHEN (OLD."status" = 'accepted' AND NEW."status" = 'rejected' AND NEW."stepKey" IS NOT NULL) EXECUTE FUNCTION task_step_undone();
-- Named to fire after the guards (BEFORE triggers fire in name order) and before any constraint.
CREATE TRIGGER "Task_valid" BEFORE INSERT OR UPDATE ON "Task"
  FOR EACH ROW EXECUTE FUNCTION task_valid();

CREATE TRIGGER "TaskOutput_guard" BEFORE INSERT OR UPDATE OR DELETE ON "TaskOutput"
  FOR EACH ROW EXECUTE FUNCTION task_output_guard();
CREATE TRIGGER "TaskOutput_no_truncate" BEFORE TRUNCATE ON "TaskOutput"
  FOR EACH STATEMENT EXECUTE FUNCTION task_output_guard();

CREATE TRIGGER "Review_insert_check" BEFORE INSERT ON "Review"
  FOR EACH ROW EXECUTE FUNCTION review_insert_check();
CREATE TRIGGER "Review_guard" BEFORE UPDATE OR DELETE ON "Review"
  FOR EACH ROW EXECUTE FUNCTION review_guard();
CREATE TRIGGER "Review_no_truncate" BEFORE TRUNCATE ON "Review"
  FOR EACH STATEMENT EXECUTE FUNCTION review_guard();
CREATE TRIGGER "Review_valid" BEFORE INSERT OR UPDATE ON "Review"
  FOR EACH ROW EXECUTE FUNCTION review_valid();

CREATE TRIGGER "ReviewGate_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ReviewGate"
  FOR EACH ROW EXECUTE FUNCTION review_gate_guard();
CREATE TRIGGER "ReviewGate_no_truncate" BEFORE TRUNCATE ON "ReviewGate"
  FOR EACH STATEMENT EXECUTE FUNCTION review_gate_guard();
CREATE TRIGGER "ReviewGate_history" AFTER UPDATE ON "ReviewGate"
  FOR EACH ROW EXECUTE FUNCTION row_history();

-- On Proposal, BEFORE triggers fire in name order. On INSERT: P5's digest check, the floor, then the rules
-- (Proposal_valid, Proposal_valid_p5), all before any constraint. On UPDATE: Proposal_review_guard, then P1's
-- Proposal_transition, then the rules. The digest check covers every card a P5 guard may act on: by its
-- action, and every task or spend card whatever its action (a reviewer's or the Hive's dispatch card).
CREATE TRIGGER "Proposal_p5_digest_check" BEFORE INSERT ON "Proposal"
  FOR EACH ROW WHEN (NEW."kind" IN ('task', 'spend') OR NEW."action" ~ '^(task[.]|asset[.]enable$|review[.]enforce$)') EXECUTE FUNCTION p5_digest_check();
CREATE TRIGGER "Proposal_review_floor" BEFORE INSERT ON "Proposal"
  FOR EACH ROW EXECUTE FUNCTION proposal_review_floor();
CREATE TRIGGER "Proposal_review_guard" BEFORE UPDATE ON "Proposal"
  FOR EACH ROW EXECUTE FUNCTION proposal_review_guard();
-- Every card, of every kind: no rule of Proposal's own that refuses one prints its args.
CREATE TRIGGER "Proposal_valid_p5" BEFORE INSERT OR UPDATE ON "Proposal"
  FOR EACH ROW EXECUTE FUNCTION p5_card_valid();

-- Named to fire before P1's Resolution_leak_guard.
CREATE TRIGGER "Resolution_for_task" BEFORE INSERT ON "Resolution"
  FOR EACH ROW EXECUTE FUNCTION resolution_task_check();

-- Named to fire before P1's Approval_insert_check, and after it.
CREATE TRIGGER "Approval_clock" BEFORE INSERT ON "Approval"
  FOR EACH ROW EXECUTE FUNCTION approval_clock();
CREATE TRIGGER "Approval_signed_for" BEFORE INSERT ON "Approval"
  FOR EACH ROW EXECUTE FUNCTION approval_signed_for();

CREATE TRIGGER "Entity_forgotten_p5" AFTER UPDATE OF "status" ON "Entity"
  FOR EACH ROW WHEN (NEW."status" = 'forgotten' AND OLD."status" <> 'forgotten') EXECUTE FUNCTION entity_forgotten_p5();

-- The gate's one row, off.
INSERT INTO "ReviewGate" ("id", "enforced") VALUES ('proposal', false);

-- ---- The task and review queues (the closed set; nothing sends to them until an asset is on) -----------
--   tasks.tick    files the cards for plan steps that are ready, scores forecasts, sweeps; every 2 minutes
--   tasks.run     one task's run on its asset (stately per task: one waiting and one running)
--   tasks.check   one task's bar check (stately per task)
--   reviews.run   one subject's review on the local model (stately per subject)
SELECT pgboss.create_queue('tasks.tick', '{"policy":"singleton","retryLimit":1,"retryDelay":60,"expireInSeconds":300,"deadLetter":"dead"}'::jsonb);
SELECT pgboss.create_queue('tasks.run', '{"policy":"stately","retryLimit":2,"retryDelay":60,"retryBackoff":true,"expireInSeconds":900,"deadLetter":"dead"}'::jsonb);
SELECT pgboss.create_queue('tasks.check', '{"policy":"stately","retryLimit":2,"retryDelay":60,"expireInSeconds":900,"deadLetter":"dead"}'::jsonb);
SELECT pgboss.create_queue('reviews.run', '{"policy":"stately","retryLimit":3,"retryDelay":30,"retryBackoff":true,"expireInSeconds":900,"deadLetter":"dead"}'::jsonb);

-- ---- Grants ------------------------------------------------------------------------------------------------
-- flint_app writes the columns its runner and its reviewer write, no more: never
-- what an asset or a task is, never a task's times (the triggers set them), never
-- what a review found. The two helpers run inside trigger bodies as flint_app, so
-- it may execute them: one only reads, and p5_bind_approval writes only
-- TaskApprovalUse, on which flint_app has no grant at all. flint_approver (the
-- server) gets nothing here: the time on an approval it records, and what it
-- was signed for, are stamped for it (Approval_clock, Approval_signed_for).
REVOKE ALL ON FUNCTION p5_signed_proposal(text, text, text, text[]), p5_bind_approval(text, text, text, text), p5_digest_check(), p5_card_valid(),
  asset_insert_check(), asset_guard(), task_insert_check(), task_guard(), task_valid(), task_output_guard(), review_insert_check(),
  review_guard(), review_valid(), review_gate_guard(), proposal_review_floor(), proposal_review_guard(), entity_forgotten_p5(),
  resolution_task_check(), task_step_undone(), approval_clock(), approval_signed_for() FROM PUBLIC;
REVOKE ALL ON "Asset", "Task", "TaskOutput", "Review", "ReviewGate", "TaskApprovalUse", review_coverage, review_gate_violations FROM PUBLIC;
GRANT EXECUTE ON FUNCTION p5_signed_proposal(text, text, text, text[]), p5_bind_approval(text, text, text, text) TO flint_app;

GRANT SELECT, INSERT, UPDATE ("enabled", "approvalId") ON "Asset" TO flint_app;
GRANT SELECT, INSERT, UPDATE ("status", "dispatchApprovalId", "externalJobId", "outputRef", "outputSummary", "metBar", "barEvidence", "barCheckedBy",
  "acceptedAuditId", "predictionId", "costUsd", "costIsEstimate", "attempts", "failure", "spec", "acceptance", "textPurgedAt", "updatedAt") ON "Task" TO flint_app;
GRANT SELECT, INSERT, DELETE ON "TaskOutput" TO flint_app;
GRANT SELECT, INSERT, UPDATE ("attack", "defense", "verdictReason", "textPurgedAt", "overridePredictionId") ON "Review" TO flint_app;
GRANT SELECT, UPDATE ("enforced", "approvalId") ON "ReviewGate" TO flint_app;
GRANT SELECT ON review_coverage, review_gate_violations TO flint_app;
