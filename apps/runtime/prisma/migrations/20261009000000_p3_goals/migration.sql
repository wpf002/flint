-- P3: Will's goals and their plans. Only Will activates, finishes, abandons,
-- re-scopes or re-times a goal, and every plan change is a card he signs: the
-- database holds each to the exact args of an executing card he approved, and a
-- plan version to the previous one plus exactly the signed operations. Goal text
-- is personal, so history keeps only its length. Also: the quote floor under
-- chat's goal and commitment cards, and the three goal job queues (nothing sends
-- to them yet). The only P3 migration. Reversed by down.sql in this directory.

-- AlterTable
ALTER TABLE "Prediction" ADD COLUMN     "goalId" TEXT;

-- CreateTable
CREATE TABLE "Goal" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "owner" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "priority" INTEGER NOT NULL DEFAULT 3,
    "successCriteria" JSONB NOT NULL DEFAULT '[]',
    "criteriaMet" JSONB NOT NULL DEFAULT '{}',
    "horizonAt" TIMESTAMPTZ(3),
    "reviewCadence" TEXT NOT NULL DEFAULT 'P1W',
    "nextReviewAt" TIMESTAMPTZ(3),
    "activatedAt" TIMESTAMPTZ(3),
    "progress" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "approvalId" TEXT,
    "sensitivity" TEXT NOT NULL DEFAULT 'personal',
    "tainted" BOOLEAN NOT NULL DEFAULT false,
    "nexusProjectId" TEXT,
    "sourceRef" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Goal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoalEntity" (
    "goalId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "watchPaths" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "seenVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GoalEntity_pkey" PRIMARY KEY ("goalId","entityId")
);

-- CreateTable
CREATE TABLE "Plan" (
    "id" TEXT NOT NULL,
    "goalId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "rationale" TEXT NOT NULL DEFAULT '',
    "assumptions" JSONB NOT NULL DEFAULT '[]',
    "createdBy" TEXT NOT NULL,
    "approvalId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlanStep" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'todo',
    "tier" TEXT NOT NULL DEFAULT 'approval',
    "dueAt" TIMESTAMPTZ(3),
    "dependsOn" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "proposalId" TEXT,
    "taskId" TEXT,
    "doneAuditId" TEXT,
    "doneAt" TIMESTAMPTZ(3),

    CONSTRAINT "PlanStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoalReview" (
    "id" TEXT NOT NULL,
    "goalId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "triggerEventId" TEXT,
    "dueAt" TIMESTAMPTZ(3),
    "summary" TEXT NOT NULL,
    "criteria" JSONB NOT NULL DEFAULT '[]',
    "progressBefore" DOUBLE PRECISION NOT NULL,
    "progressAfter" DOUBLE PRECISION NOT NULL,
    "predictionId" TEXT NOT NULL,
    "reviewer" TEXT NOT NULL DEFAULT 'flint:rule',
    "planner" TEXT,
    "diff" JSONB,
    "proposalId" TEXT,
    "shadow" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GoalReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Goal_sourceRef_key" ON "Goal"("sourceRef");

-- CreateIndex
CREATE INDEX "Goal_status_nextReviewAt_idx" ON "Goal"("status", "nextReviewAt");

-- CreateIndex
CREATE INDEX "GoalEntity_entityId_idx" ON "GoalEntity"("entityId");

-- CreateIndex
CREATE UNIQUE INDEX "Plan_approvalId_key" ON "Plan"("approvalId");

-- CreateIndex
CREATE UNIQUE INDEX "Plan_goalId_version_key" ON "Plan"("goalId", "version");

-- CreateIndex
CREATE INDEX "PlanStep_planId_ordinal_idx" ON "PlanStep"("planId", "ordinal");

-- CreateIndex
CREATE INDEX "PlanStep_status_dueAt_idx" ON "PlanStep"("status", "dueAt");

-- CreateIndex
CREATE UNIQUE INDEX "PlanStep_planId_key_key" ON "PlanStep"("planId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "GoalReview_predictionId_key" ON "GoalReview"("predictionId");

-- CreateIndex
CREATE INDEX "GoalReview_goalId_createdAt_idx" ON "GoalReview"("goalId", "createdAt");

-- CreateIndex
CREATE INDEX "Prediction_goalId_idx" ON "Prediction"("goalId");

-- AddForeignKey
ALTER TABLE "Prediction" ADD CONSTRAINT "Prediction_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "Goal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoalEntity" ADD CONSTRAINT "GoalEntity_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "Goal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoalEntity" ADD CONSTRAINT "GoalEntity_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Plan" ADD CONSTRAINT "Plan_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "Goal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanStep" ADD CONSTRAINT "PlanStep_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoalReview" ADD CONSTRAINT "GoalReview_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "Goal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoalReview" ADD CONSTRAINT "GoalReview_predictionId_fkey" FOREIGN KEY ("predictionId") REFERENCES "Prediction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ===========================================================================
-- Hand-written below this line. Every RAISE names its SQLSTATE: 23514
-- (check_violation) refuses what the caller sent; 42501 (insufficient_privilege)
-- is a rule no caller may break; 40001 (serialization_failure) is a step written
-- to a plan that was replaced meanwhile (try again). Messages name ids only,
-- never goal text: an error's words reach logs and cards.
-- ===========================================================================

-- ---- CHECKs (no Prisma enums) ----------------------------------------------------
ALTER TABLE "Goal"
  ADD CONSTRAINT "Goal_owner_check" CHECK ("owner" IN ('will', 'flint')),
  ADD CONSTRAINT "Goal_origin_check" CHECK ("origin" IN ('will', 'flint')),
  ADD CONSTRAINT "Goal_status_check" CHECK ("status" IN ('proposed', 'active', 'paused', 'done', 'abandoned', 'rejected')),
  ADD CONSTRAINT "Goal_priority_check" CHECK ("priority" BETWEEN 1 AND 5),
  ADD CONSTRAINT "Goal_progress_check" CHECK ("progress" BETWEEN 0 AND 1),
  ADD CONSTRAINT "Goal_title_check" CHECK (char_length("title") BETWEEN 1 AND 120),
  ADD CONSTRAINT "Goal_description_check" CHECK (char_length("description") <= 1000),
  ADD CONSTRAINT "Goal_successCriteria_check" CHECK (
    jsonb_typeof("successCriteria") = 'array' AND jsonb_array_length("successCriteria") <= 10 AND octet_length("successCriteria"::text) <= 8192
  ),
  ADD CONSTRAINT "Goal_criteriaMet_check" CHECK (jsonb_typeof("criteriaMet") = 'object' AND octet_length("criteriaMet"::text) <= 2048),
  ADD CONSTRAINT "Goal_reviewCadence_check" CHECK ("reviewCadence" IN ('P1D', 'P3D', 'P1W', 'P2W', 'P1M')),
  ADD CONSTRAINT "Goal_horizonAt_check" CHECK ("horizonAt" IS NULL OR "horizonAt" > "createdAt"),
  -- A goal Flint suggested names the chat it came from, and only such a goal does.
  ADD CONSTRAINT "Goal_sourceRef_check" CHECK (("origin" = 'flint') = ("sourceRef" IS NOT NULL) AND ("sourceRef" IS NULL OR "sourceRef" ~ '^chat:[0-9a-f]{64}$')),
  ADD CONSTRAINT "Goal_nextReviewAt_check" CHECK ("status" <> 'active' OR "nextReviewAt" IS NOT NULL),
  ADD CONSTRAINT "Goal_approvalId_check" CHECK ("status" IN ('proposed', 'rejected') OR "approvalId" IS NOT NULL),
  ADD CONSTRAINT "Goal_sensitivity_check" CHECK ("sensitivity" IN ('ops', 'personal', 'financial')),
  ADD CONSTRAINT "Goal_nexusProjectId_check" CHECK ("nexusProjectId" IS NULL OR "nexusProjectId" ~ '^[A-Za-z0-9_-]{1,64}$');

ALTER TABLE "GoalEntity"
  ADD CONSTRAINT "GoalEntity_role_check" CHECK ("role" IN ('target', 'depends_on', 'watch')),
  -- Top-level patch keys only, and never the name or a title (they can carry a stranger's words).
  ADD CONSTRAINT "GoalEntity_watchPaths_check" CHECK (
    "watchPaths" IS NOT NULL AND cardinality("watchPaths") <= 10 AND array_position("watchPaths", NULL) IS NULL
    AND (cardinality("watchPaths") = 0 OR array_to_string("watchPaths", ',') ~ '^[A-Za-z][A-Za-z0-9_]{0,39}(,[A-Za-z][A-Za-z0-9_]{0,39})*$')
    AND NOT ("watchPaths" && ARRAY['name', 'title']::text[])
  ),
  ADD CONSTRAINT "GoalEntity_seenVersion_check" CHECK ("seenVersion" >= 0);

ALTER TABLE "Plan"
  ADD CONSTRAINT "Plan_status_check" CHECK ("status" IN ('draft', 'active', 'superseded')),
  ADD CONSTRAINT "Plan_version_check" CHECK ("version" >= 1),
  ADD CONSTRAINT "Plan_rationale_check" CHECK (char_length("rationale") <= 300),
  ADD CONSTRAINT "Plan_assumptions_check" CHECK (jsonb_typeof("assumptions") = 'array' AND octet_length("assumptions"::text) <= 4096),
  ADD CONSTRAINT "Plan_createdBy_check" CHECK ("createdBy" IN ('will', 'flint')),
  ADD CONSTRAINT "Plan_approvalId_check" CHECK ("status" <> 'active' OR "approvalId" IS NOT NULL);

ALTER TABLE "PlanStep"
  ADD CONSTRAINT "PlanStep_key_check" CHECK ("key" ~ '^s[0-9]{1,3}$'),
  ADD CONSTRAINT "PlanStep_ordinal_check" CHECK ("ordinal" BETWEEN 1 AND 1000000),
  ADD CONSTRAINT "PlanStep_title_check" CHECK (char_length("title") BETWEEN 1 AND 200),
  ADD CONSTRAINT "PlanStep_kind_check" CHECK ("kind" IN ('will_task', 'flint_action', 'asset_task', 'wait', 'decision')),
  ADD CONSTRAINT "PlanStep_status_check" CHECK ("status" IN ('todo', 'in_progress', 'blocked', 'done', 'skipped')),
  ADD CONSTRAINT "PlanStep_tier_check" CHECK ("tier" IN ('alone', 'approval', 'forbidden')),
  ADD CONSTRAINT "PlanStep_dependsOn_check" CHECK (
    "dependsOn" IS NOT NULL AND cardinality("dependsOn") <= 10 AND array_position("dependsOn", NULL) IS NULL
    AND (cardinality("dependsOn") = 0 OR array_to_string("dependsOn", ',') ~ '^s[0-9]{1,3}(,s[0-9]{1,3})*$')
    AND NOT ("key" = ANY ("dependsOn"))
  ),
  ADD CONSTRAINT "PlanStep_done_check" CHECK (("status" = 'done') = ("doneAt" IS NOT NULL)),
  ADD CONSTRAINT "PlanStep_refs_check" CHECK (
    ("proposalId" IS NULL OR "proposalId" ~ '^[A-Za-z0-9_-]{1,40}$') AND ("taskId" IS NULL OR "taskId" ~ '^[A-Za-z0-9_-]{1,40}$')
    AND ("doneAuditId" IS NULL OR "doneAuditId" ~ '^[A-Za-z0-9_-]{1,40}$')
  );

ALTER TABLE "GoalReview"
  ADD CONSTRAINT "GoalReview_kind_check" CHECK ("kind" IN ('scheduled', 'triggered', 'requested')),
  ADD CONSTRAINT "GoalReview_dueAt_check" CHECK (("kind" = 'scheduled') = ("dueAt" IS NOT NULL)),
  -- What set it off, by id: version:<id>, step:<key>@<ms>, resolution:<id>, chat:<ref>. Never words.
  ADD CONSTRAINT "GoalReview_trigger_check" CHECK (
    ("kind" <> 'triggered' OR "triggerEventId" IS NOT NULL) AND ("triggerEventId" IS NULL OR "triggerEventId" ~ '^[a-z]{1,20}:[A-Za-z0-9_:@.-]{1,99}$')
  ),
  ADD CONSTRAINT "GoalReview_summary_check" CHECK (char_length("summary") <= 1000),
  ADD CONSTRAINT "GoalReview_progress_check" CHECK ("progressBefore" BETWEEN 0 AND 1 AND "progressAfter" BETWEEN 0 AND 1),
  ADD CONSTRAINT "GoalReview_criteria_check" CHECK (jsonb_typeof("criteria") = 'array' AND octet_length("criteria"::text) <= 4096),
  ADD CONSTRAINT "GoalReview_diff_check" CHECK ("diff" IS NULL OR (jsonb_typeof("diff") = 'array' AND octet_length("diff"::text) <= 8192)),
  ADD CONSTRAINT "GoalReview_reviewer_check" CHECK ("reviewer" ~ '^(flint:[a-z_]{1,20}|will)$'),
  ADD CONSTRAINT "GoalReview_planner_check" CHECK (
    "planner" IS NULL OR "planner" ~ '^(ollama:[A-Za-z0-9._:/-]{1,80}|none:(off|capped|unavailable|invalid|deferred|skipped))$'
  ),
  ADD CONSTRAINT "GoalReview_proposalId_check" CHECK ("proposalId" IS NULL OR "proposalId" ~ '^[A-Za-z0-9_-]{1,40}$');

-- A goal's prediction comes from the goals writer only (its onTrack forecast), so no
-- other writer, chat's connector included, can attach a forecast that goal.done
-- would later resolve as Will.
ALTER TABLE "Prediction"
  ADD CONSTRAINT "Prediction_goal_check" CHECK ("goalId" IS NULL OR ("domain" = 'goals' AND "createdBy" = 'runtime:goals'));

-- ---- Partial indexes (Prisma's diff does not see them) ---------------------------
-- One active plan per goal.
CREATE UNIQUE INDEX "Plan_one_active_key" ON "Plan" ("goalId") WHERE "status" = 'active';
-- A review set off by the same thing twice is one review; so is a scheduled review for the same due time.
CREATE UNIQUE INDEX "GoalReview_trigger_key" ON "GoalReview" ("goalId", "triggerEventId") WHERE "triggerEventId" IS NOT NULL;
CREATE UNIQUE INDEX "GoalReview_scheduled_key" ON "GoalReview" ("goalId", "dueAt") WHERE "kind" = 'scheduled';

-- ---- The signed card a guarded change rides on ------------------------------------
-- An approval Will signed (approve, a live credential) for a proposal that is
-- executing now, for one of these actions, about this goal. It never consumes the
-- approval: proposal_transition did that when the card was approved, and the card
-- leaves executing when it completes, so each binding is used once. Raises
-- otherwise. Called from trigger bodies, which run as flint_app: it has EXECUTE.
CREATE FUNCTION p3_signed_proposal(p_approval text, p_goal text, p_actions text[]) RETURNS "Proposal"
LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  a "Approval"%ROWTYPE;
  p "Proposal"%ROWTYPE;
BEGIN
  SELECT * INTO a FROM "Approval" WHERE "id" = p_approval;
  IF NOT FOUND OR a."decision" <> 'approve' OR a."subjectType" <> 'proposal'
     OR NOT EXISTS (SELECT 1 FROM "ApprovalCredential" c WHERE c."credentialId" = a."credentialId" AND c."revokedAt" IS NULL) THEN
    RAISE EXCEPTION 'goal %: approval % is not a live signed approval of a card', p_goal, p_approval USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO p FROM "Proposal" WHERE "id" = a."subjectId";
  IF NOT FOUND OR NOT coalesce(
       p."approvalId" = a."id" AND p."status" = 'executing' AND p."action" = ANY (p_actions)
       AND p."kind" = CASE WHEN p."action" = 'plan.change' THEN 'plan' ELSE 'goal' END
       AND a."payload"->>'action' = p."action" AND a."payload"->>'argsDigest' = p."argsDigest"
       AND jsonb_typeof(p."args") = 'object' AND p."args"->>'goalId' = p_goal, false) THEN
    RAISE EXCEPTION 'goal %: approval % is not for an executing % of this goal', p_goal, p_approval, array_to_string(p_actions, ' or ')
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN p;
END;
$$;

-- A plan step as the composition check compares it: its known fields only, times as
-- epoch milliseconds (a stored timestamptz and a signed ISO string then compare
-- exactly), dependencies sorted. Works on the partial objects in an op's `from` and
-- `to` too. STABLE: it casts text to timestamptz.
CREATE FUNCTION p3_step_norm(s jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  out jsonb := '{}'::jsonb;
  k text;
  v jsonb;
BEGIN
  IF s IS NULL OR jsonb_typeof(s) <> 'object' THEN
    RETURN '{}'::jsonb;
  END IF;
  FOR k, v IN SELECT * FROM jsonb_each(s) LOOP
    CONTINUE WHEN NOT (k = ANY (ARRAY['key', 'ordinal', 'title', 'kind', 'tier', 'status', 'dueAt', 'dependsOn', 'doneAt', 'doneAuditId', 'proposalId', 'taskId']));
    IF k IN ('dueAt', 'doneAt') AND jsonb_typeof(v) = 'string' THEN
      v := to_jsonb(floor(extract(epoch FROM (v #>> '{}')::timestamptz) * 1000)::bigint);
    ELSIF k = 'dependsOn' AND jsonb_typeof(v) = 'array' THEN
      v := coalesce((SELECT jsonb_agg(DISTINCT e ORDER BY e) FROM jsonb_array_elements(v) AS e), '[]'::jsonb);
    END IF;
    out := out || jsonb_build_object(k, v);
  END LOOP;
  RETURN out;
END;
$$;

-- ---- Goals -------------------------------------------------------------------------
-- A goal is born proposed: unsigned, with no progress, marks or review time. It
-- is made now (the wall clock), whatever the writer says.
CREATE FUNCTION goal_insert_check() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT coalesce(NEW."status" = 'proposed' AND NEW."approvalId" IS NULL AND NEW."activatedAt" IS NULL AND NEW."nextReviewAt" IS NULL
                  AND NEW."progress" = 0 AND NEW."criteriaMet" = '{}'::jsonb, false) THEN
    RAISE EXCEPTION 'goal %: a goal starts proposed and unsigned, with no progress, marks or review time', NEW."id" USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW."createdAt" := clock_timestamp();
  NEW."updatedAt" := NEW."createdAt";
  RETURN NEW;
END;
$$;

-- What a goal is (its owner, origin, source, sensitivity, taint) never changes, and
-- it is never deleted. Done, abandoned and rejected are final. Becoming active,
-- done or abandoned, and changing what counts as done (title, description, checks)
-- or its timing (horizon, cadence), each needs a new approval, and the card it
-- signed must be executing now with exactly the new values:
--   into active      goal.activate. From proposed it sets the definition and timing
--                    (at least one check); resuming from paused changes neither.
--   into done        goal.done      } nothing else changes
--   into abandoned   goal.abandon   }
--   definition only  goal.criteria_change, on an active or paused goal
--   timing only      goal.horizon_change, on an active or paused goal
--   both at once     refused: they are separate cards.
-- Progress, the review time, Will's marks, the priority, pausing an active goal
-- and dismissing a proposed one need nothing. activatedAt is set here, once.
CREATE FUNCTION goal_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  fixed text[] := ARRAY['id', 'owner', 'origin', 'sensitivity', 'tainted', 'nexusProjectId', 'sourceRef', 'createdAt'];
  definition boolean;
  timing boolean;
  moved boolean;
  want text;
  p "Proposal"%ROWTYPE;
  k text;
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'goals are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  FOREACH k IN ARRAY fixed LOOP
    IF (to_jsonb(NEW) -> k) IS DISTINCT FROM (to_jsonb(OLD) -> k) THEN
      RAISE EXCEPTION 'goal %: % never changes', OLD."id", k USING ERRCODE = 'insufficient_privilege';
    END IF;
  END LOOP;
  IF OLD."status" IN ('done', 'abandoned', 'rejected') AND (to_jsonb(NEW) - 'updatedAt') IS DISTINCT FROM (to_jsonb(OLD) - 'updatedAt') THEN
    RAISE EXCEPTION 'goal %: it is % and never changes again', OLD."id", OLD."status" USING ERRCODE = 'insufficient_privilege';
  END IF;

  definition := NEW."title" IS DISTINCT FROM OLD."title" OR NEW."description" IS DISTINCT FROM OLD."description"
                OR NEW."successCriteria" IS DISTINCT FROM OLD."successCriteria";
  timing := NEW."horizonAt" IS DISTINCT FROM OLD."horizonAt" OR NEW."reviewCadence" IS DISTINCT FROM OLD."reviewCadence";
  moved := NEW."status" IS DISTINCT FROM OLD."status";
  IF moved AND NOT ((OLD."status" = 'proposed' AND NEW."status" IN ('active', 'rejected'))
                 OR (OLD."status" = 'active' AND NEW."status" IN ('paused', 'done', 'abandoned'))
                 OR (OLD."status" = 'paused' AND NEW."status" IN ('active', 'done', 'abandoned'))) THEN
    RAISE EXCEPTION 'goal %: % -> % is not allowed', OLD."id", OLD."status", NEW."status" USING ERRCODE = 'insufficient_privilege';
  END IF;

  want := CASE
    WHEN moved AND NEW."status" = 'active' THEN 'goal.activate'
    WHEN moved AND NEW."status" = 'done' THEN 'goal.done'
    WHEN moved AND NEW."status" = 'abandoned' THEN 'goal.abandon'
    WHEN moved THEN NULL
    WHEN definition AND timing THEN 'both'
    WHEN definition THEN 'goal.criteria_change'
    WHEN timing THEN 'goal.horizon_change'
  END;

  IF want IS NULL THEN
    IF definition OR timing THEN
      RAISE EXCEPTION 'goal %: pausing or dismissing it changes nothing else', OLD."id" USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW."approvalId" IS DISTINCT FROM OLD."approvalId" THEN
      RAISE EXCEPTION 'goal %: its approval changes only with a signed change', OLD."id" USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSE
    IF want = 'both' THEN
      RAISE EXCEPTION 'goal %: what counts as done and its timing change on separate cards', OLD."id" USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF want IN ('goal.criteria_change', 'goal.horizon_change') AND OLD."status" NOT IN ('active', 'paused') THEN
      RAISE EXCEPTION 'goal %: only an active or paused goal is changed (it is %)', OLD."id", OLD."status" USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF want IN ('goal.done', 'goal.abandon') AND (definition OR timing) THEN
      RAISE EXCEPTION 'goal %: finishing it changes nothing else', OLD."id" USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF want = 'goal.activate' AND OLD."status" = 'paused' AND (definition OR timing) THEN
      RAISE EXCEPTION 'goal %: resuming it changes nothing else', OLD."id" USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- A new approval each time: an approval that moved the goal once never moves it again.
    IF NEW."approvalId" IS NULL OR NEW."approvalId" IS NOT DISTINCT FROM OLD."approvalId" THEN
      RAISE EXCEPTION 'goal %: % needs a new approval', OLD."id", want USING ERRCODE = 'insufficient_privilege';
    END IF;
    p := p3_signed_proposal(NEW."approvalId", NEW."id", ARRAY[want]);
    IF want IN ('goal.activate', 'goal.criteria_change') THEN
      IF p."args"->>'title' IS DISTINCT FROM NEW."title" OR p."args"->>'description' IS DISTINCT FROM NEW."description"
         OR (p."args"->'successCriteria') IS DISTINCT FROM NEW."successCriteria" THEN
        RAISE EXCEPTION 'goal %: what counts as done is not what approval % signed', OLD."id", NEW."approvalId" USING ERRCODE = 'insufficient_privilege';
      END IF;
      IF jsonb_array_length(NEW."successCriteria") < 1 THEN
        RAISE EXCEPTION 'goal %: an active goal needs at least one check', OLD."id" USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF want IN ('goal.activate', 'goal.horizon_change') THEN
      IF coalesce(jsonb_typeof(p."args"->'horizonAt'), 'missing') NOT IN ('string', 'null')
         OR (p."args"->>'horizonAt')::timestamptz IS DISTINCT FROM NEW."horizonAt" OR p."args"->>'reviewCadence' IS DISTINCT FROM NEW."reviewCadence" THEN
        RAISE EXCEPTION 'goal %: its timing is not what approval % signed', OLD."id", NEW."approvalId" USING ERRCODE = 'insufficient_privilege';
      END IF;
    END IF;
  END IF;

  IF OLD."status" = 'proposed' AND NEW."status" = 'active' THEN
    NEW."activatedAt" := clock_timestamp();
  ELSIF NEW."activatedAt" IS DISTINCT FROM OLD."activatedAt" THEN
    RAISE EXCEPTION 'goal %: activatedAt is set once, when it first starts', OLD."id" USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Will's marks name the goal's own checks, by date.
  IF (NEW."criteriaMet" IS DISTINCT FROM OLD."criteriaMet" OR definition) AND EXISTS (
    SELECT 1 FROM jsonb_each(NEW."criteriaMet") AS m
    WHERE jsonb_typeof(m.value) <> 'string' OR (m.value #>> '{}') !~ '^\d{4}-\d{2}-\d{2}$'
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(NEW."successCriteria") AS c WHERE c->>'id' = m.key)
  ) THEN
    RAISE EXCEPTION 'goal %: a mark names a check the goal does not have', OLD."id" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- ---- Links -----------------------------------------------------------------------------
-- What a goal is about changes only as a signed card says: a link is added only as
-- one of the exact links of an executing goal.activate (while the goal is still
-- proposed: resuming changes no link) or goal.criteria_change (active or paused), and
-- removed only by one that leaves it out. Its watch cursor starts at the item's
-- version and only moves forward. A forgotten item is never linked.
CREATE FUNCTION goal_entity_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  r "GoalEntity"%ROWTYPE;
  g "Goal"%ROWTYPE;
  p "Proposal"%ROWTYPE;
  cand text;
  link jsonb;
  listed boolean;
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'goal links are removed only by a signed card' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(NEW) - 'seenVersion') IS DISTINCT FROM (to_jsonb(OLD) - 'seenVersion') OR NEW."seenVersion" < OLD."seenVersion" THEN
      RAISE EXCEPTION 'goal %: a link only moves its cursor forward', OLD."goalId" USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    r := NEW;
    SELECT "version" INTO NEW."seenVersion" FROM "Entity" WHERE "id" = NEW."entityId" AND "status" <> 'forgotten';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'goal %: item % is not there to link', NEW."goalId", NEW."entityId" USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    r := OLD;
  END IF;
  SELECT * INTO g FROM "Goal" WHERE "id" = r."goalId";
  link := jsonb_build_object('entityId', r."entityId", 'role', r."role", 'watchPaths', to_jsonb(r."watchPaths"));
  FOR cand IN
    SELECT "approvalId" FROM "Proposal"
    WHERE "status" = 'executing' AND "action" IN ('goal.activate', 'goal.criteria_change') AND "approvalId" IS NOT NULL AND "args"->>'goalId' = r."goalId"
  LOOP
    BEGIN
      p := p3_signed_proposal(cand, r."goalId", ARRAY['goal.activate', 'goal.criteria_change']);
    EXCEPTION WHEN insufficient_privilege THEN
      CONTINUE;
    END;
    CONTINUE WHEN NOT coalesce((p."action" = 'goal.activate' AND g."status" = 'proposed')
                               OR (p."action" = 'goal.criteria_change' AND g."status" IN ('active', 'paused')), false);
    CONTINUE WHEN coalesce(jsonb_typeof(p."args"->'links'), '') <> 'array';
    listed := EXISTS (SELECT 1 FROM jsonb_array_elements(p."args"->'links') AS l WHERE l = link);
    IF TG_OP = 'INSERT' AND listed THEN
      RETURN NEW;
    ELSIF TG_OP = 'DELETE' AND NOT listed THEN
      RETURN OLD;
    END IF;
  END LOOP;
  RAISE EXCEPTION 'goal %: link to % is not what a signed card says', r."goalId", r."entityId" USING ERRCODE = 'insufficient_privilege';
END;
$$;

-- ---- Plans -------------------------------------------------------------------------------
-- A plan is born an unsigned draft, made now.
CREATE FUNCTION plan_insert_check() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT coalesce(NEW."status" = 'draft' AND NEW."approvalId" IS NULL, false) THEN
    RAISE EXCEPTION 'plan %: a plan starts as an unsigned draft', NEW."id" USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW."createdAt" := clock_timestamp();
  RETURN NEW;
END;
$$;

-- What a version is never changes; superseded is final; a draft may be dropped
-- (superseded) freely. The active version is superseded only while a signed
-- plan.change for its goal is executing. A draft becomes active only with the
-- approval of an executing plan.change (an active or paused goal) or goal.activate
-- (a new goal's first plan), and only if its steps are exactly the previous
-- version's, with the signed ops applied:
--  - an add puts a new key, as signed, starting todo;
--  - a set changes a step that still matches its `from` (title and each changed
--    field, as they were when Flint or Will suggested it) to its `to`, which never
--    makes it done and always changes something;
--  - every other step is copied as it is, its progress (doneAt, its proof, its
--    card and task) included, and no step is ever removed (a step is skipped);
--  - one op per key, every op lands, every dependency names a step, and none
--    forms a circle.
-- Steps are compared as p3_step_norm gives them.
CREATE FUNCTION plan_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  fixed text[] := ARRAY['id', 'goalId', 'version', 'rationale', 'assumptions', 'createdBy', 'createdAt'];
  k text;
  g "Goal"%ROWTYPE;
  p "Proposal"%ROWTYPE;
  prev "Plan"%ROWTYPE;
  s "PlanStep"%ROWTYPE;
  cand text;
  ops jsonb;
  op jsonb;
  cur jsonb;
  fromn jsonb;
  ton jsonb;
  expected jsonb := '{}'::jsonb;
  seen text[] := '{}';
  remaining text[];
  free text[];
  n integer := 0;
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'plans are never deleted (a version is superseded)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  FOREACH k IN ARRAY fixed LOOP
    IF (to_jsonb(NEW) -> k) IS DISTINCT FROM (to_jsonb(OLD) -> k) THEN
      RAISE EXCEPTION 'plan %: % never changes', OLD."id", k USING ERRCODE = 'insufficient_privilege';
    END IF;
  END LOOP;
  IF OLD."status" = 'superseded' AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
    RAISE EXCEPTION 'plan %: a superseded version never changes', OLD."id" USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."approvalId" IS DISTINCT FROM OLD."approvalId" AND NOT (OLD."status" = 'draft' AND NEW."status" = 'active') THEN
    RAISE EXCEPTION 'plan %: its approval is set when it becomes active', OLD."id" USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."status" = OLD."status" THEN
    RETURN NEW;
  END IF;

  IF OLD."status" = 'draft' AND NEW."status" = 'superseded' THEN
    RETURN NEW;
  END IF;

  IF OLD."status" = 'active' AND NEW."status" = 'superseded' THEN
    FOR cand IN
      SELECT "approvalId" FROM "Proposal"
      WHERE "status" = 'executing' AND "action" = 'plan.change' AND "approvalId" IS NOT NULL AND "args"->>'goalId' = OLD."goalId"
    LOOP
      BEGIN
        PERFORM p3_signed_proposal(cand, OLD."goalId", ARRAY['plan.change']);
        RETURN NEW;
      EXCEPTION WHEN insufficient_privilege THEN
        CONTINUE;
      END;
    END LOOP;
    RAISE EXCEPTION 'plan %: the active version is replaced only by a signed plan change', OLD."id" USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NOT (OLD."status" = 'draft' AND NEW."status" = 'active') THEN
    RAISE EXCEPTION 'plan %: % -> % is not allowed', OLD."id", OLD."status", NEW."status" USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- draft -> active: the composition check.
  p := p3_signed_proposal(NEW."approvalId", NEW."goalId", ARRAY['plan.change', 'goal.activate']);
  SELECT * INTO g FROM "Goal" WHERE "id" = NEW."goalId";
  IF p."action" = 'goal.activate' THEN
    IF g."status" IS DISTINCT FROM 'proposed' THEN
      RAISE EXCEPTION 'plan %: goal.activate brings only a new goal''s first plan', NEW."id" USING ERRCODE = 'insufficient_privilege';
    END IF;
    ops := p."args"->'plan'->'ops';
  ELSE
    IF g."status" IS DISTINCT FROM 'active' AND g."status" IS DISTINCT FROM 'paused' THEN
      RAISE EXCEPTION 'plan %: only an active or paused goal''s plan changes', NEW."id" USING ERRCODE = 'insufficient_privilege';
    END IF;
    ops := p."args"->'ops';
  END IF;
  IF coalesce(jsonb_typeof(ops), '') <> 'array' OR jsonb_array_length(ops) = 0 THEN
    RAISE EXCEPTION 'plan %: approval % signed no plan operations', NEW."id", NEW."approvalId" USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- The previous version is the last one that was ever active (it holds an approval); a dropped draft never counts.
  SELECT * INTO prev FROM "Plan" WHERE "goalId" = NEW."goalId" AND "approvalId" IS NOT NULL AND "id" <> NEW."id" ORDER BY "version" DESC LIMIT 1;
  IF FOUND THEN
    IF p."action" = 'goal.activate' OR NEW."version" <> prev."version" + 1 THEN
      RAISE EXCEPTION 'plan %: version % does not follow version %', NEW."id", NEW."version", prev."version" USING ERRCODE = 'insufficient_privilege';
    END IF;
    FOR s IN SELECT * FROM "PlanStep" WHERE "planId" = prev."id" LOOP
      expected := expected || jsonb_build_object(s."key", p3_step_norm(to_jsonb(s)));
    END LOOP;
  ELSIF NEW."version" <> 1 THEN
    RAISE EXCEPTION 'plan %: a first plan is version 1', NEW."id" USING ERRCODE = 'insufficient_privilege';
  END IF;

  FOR op IN SELECT * FROM jsonb_array_elements(ops) LOOP
    k := CASE WHEN jsonb_typeof(op) = 'object' THEN op->>'key' END;
    IF k IS NULL OR k !~ '^s[0-9]{1,3}$' OR k = ANY (seen) THEN
      RAISE EXCEPTION 'plan %: an operation names no step, or a step twice', NEW."id" USING ERRCODE = 'insufficient_privilege';
    END IF;
    seen := seen || k;
    IF op->>'op' = 'add' THEN
      IF expected ? k OR coalesce(jsonb_typeof(op->'step'), '') <> 'object' OR coalesce(op->'step'->>'status', 'todo') <> 'todo' THEN
        RAISE EXCEPTION 'plan %: adding step % does not fit', NEW."id", k USING ERRCODE = 'insufficient_privilege';
      END IF;
      expected := expected || jsonb_build_object(k, p3_step_norm(
        jsonb_build_object('tier', 'approval', 'dueAt', NULL, 'dependsOn', '[]'::jsonb, 'status', 'todo',
                           'doneAt', NULL, 'doneAuditId', NULL, 'proposalId', NULL, 'taskId', NULL)
        || (op->'step') || jsonb_build_object('key', k)));
    ELSIF op->>'op' = 'set' THEN
      IF NOT expected ? k OR coalesce(jsonb_typeof(op->'from'), '') <> 'object' OR coalesce(jsonb_typeof(op->'to'), '') <> 'object' THEN
        RAISE EXCEPTION 'plan %: the operation on step % lands on no step', NEW."id", k USING ERRCODE = 'insufficient_privilege';
      END IF;
      cur := expected->k;
      fromn := p3_step_norm(op->'from');
      ton := p3_step_norm(op->'to');
      IF ton = '{}'::jsonb OR ton ?| ARRAY['key', 'kind', 'tier', 'doneAt', 'doneAuditId', 'proposalId', 'taskId']
         OR coalesce(ton->>'status', '') = 'done' OR NOT fromn ? 'title'
         OR EXISTS (SELECT 1 FROM jsonb_object_keys(ton) AS t WHERE NOT fromn ? t) THEN
        RAISE EXCEPTION 'plan %: the operation on step % does not fit', NEW."id", k USING ERRCODE = 'insufficient_privilege';
      END IF;
      IF EXISTS (SELECT 1 FROM jsonb_each(fromn) AS f WHERE (cur -> f.key) IS DISTINCT FROM f.value) THEN
        RAISE EXCEPTION 'plan %: step % changed since approval % was signed', NEW."id", k, NEW."approvalId" USING ERRCODE = 'insufficient_privilege';
      END IF;
      IF EXISTS (SELECT 1 FROM jsonb_each(ton) AS t WHERE (fromn -> t.key) IS NOT DISTINCT FROM t.value) THEN
        RAISE EXCEPTION 'plan %: the operation on step % changes nothing', NEW."id", k USING ERRCODE = 'insufficient_privilege';
      END IF;
      expected := jsonb_set(expected, ARRAY[k], cur || ton);
    ELSE
      RAISE EXCEPTION 'plan %: an operation on step % is neither add nor set', NEW."id", k USING ERRCODE = 'insufficient_privilege';
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM jsonb_each(expected) AS e, jsonb_array_elements_text(coalesce(e.value->'dependsOn', '[]'::jsonb)) AS d
             WHERE NOT expected ? d OR d = e.key) THEN
    RAISE EXCEPTION 'plan %: a step depends on a step the plan does not have', NEW."id" USING ERRCODE = 'insufficient_privilege';
  END IF;
  remaining := ARRAY(SELECT jsonb_object_keys(expected));
  LOOP
    free := ARRAY(SELECT x FROM unnest(remaining) AS x
                  WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(expected->x->'dependsOn') AS d WHERE d = ANY (remaining)));
    EXIT WHEN cardinality(free) = 0;
    remaining := ARRAY(SELECT x FROM unnest(remaining) AS x WHERE NOT x = ANY (free));
  END LOOP;
  IF cardinality(remaining) > 0 THEN
    RAISE EXCEPTION 'plan %: its steps depend on each other in a circle', NEW."id" USING ERRCODE = 'insufficient_privilege';
  END IF;

  FOR s IN SELECT * FROM "PlanStep" WHERE "planId" = NEW."id" LOOP
    n := n + 1;
    IF NOT expected ? s."key" OR p3_step_norm(to_jsonb(s)) IS DISTINCT FROM expected->s."key" THEN
      RAISE EXCEPTION 'plan %: step % is not what approval % signed', NEW."id", s."key", NEW."approvalId" USING ERRCODE = 'insufficient_privilege';
    END IF;
  END LOOP;
  IF n <> (SELECT count(*) FROM jsonb_object_keys(expected)) THEN
    RAISE EXCEPTION 'plan %: it is missing a step approval % signed or kept', NEW."id", NEW."approvalId" USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

-- Steps are written into a draft. On the active plan only a step's progress
-- changes: its status (never into skipped, which is a signed plan change, and never
-- out of it), doneAt, its proof, its card and its task. A draft's steps and a
-- superseded plan's never change; a step written as its plan is replaced is
-- refused (40001: try again on the new version). A Flint action is done only with
-- its own action on record (H7): an AuditEntry of kind action, outcome ok,
-- correlated with `<goalId>:<key>`, which stays the same across versions. A copy
-- into a new draft keeps the proof a version that was active already had.
-- Nothing is deleted.
CREATE FUNCTION plan_step_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  mutable text[] := ARRAY['status', 'doneAt', 'doneAuditId', 'proposalId', 'taskId'];
  pl "Plan"%ROWTYPE;
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'plan steps are never deleted (a step is skipped)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO pl FROM "Plan" WHERE "id" = NEW."planId" FOR SHARE;
  IF TG_OP = 'INSERT' THEN
    IF NOT FOUND OR pl."status" <> 'draft' THEN
      RAISE EXCEPTION 'plan %: steps are written only into a draft', NEW."planId" USING ERRCODE = 'insufficient_privilege';
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
  RETURN NEW;
END;
$$;

-- ---- Reviews -----------------------------------------------------------------------------
-- A review is of an active goal, and comes with its onTrack forecast: an open
-- goals prediction of that goal (exit 6). The model's stage fills planner, diff and
-- proposalId later. Made now.
CREATE FUNCTION goal_review_insert_check() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "Goal" WHERE "id" = NEW."goalId" AND "status" = 'active') THEN
    RAISE EXCEPTION 'review %: goal % is not active', NEW."id", NEW."goalId" USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "Prediction" WHERE "id" = NEW."predictionId" AND "goalId" = NEW."goalId" AND "domain" = 'goals' AND "status" = 'open') THEN
    RAISE EXCEPTION 'review %: it needs an open forecast of goal %', NEW."id", NEW."goalId" USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."planner" IS NOT NULL OR NEW."diff" IS NOT NULL OR NEW."proposalId" IS NOT NULL THEN
    RAISE EXCEPTION 'review %: the plan stage fills these in later', NEW."id" USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW."createdAt" := clock_timestamp();
  RETURN NEW;
END;
$$;

-- What a review found never changes; planner, diff and proposalId are each set once.
-- (guard_append_only allows changes only inside a forget, so it cannot say this.)
CREATE FUNCTION goal_review_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  k text;
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'goal reviews are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['planner', 'diff', 'proposalId']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['planner', 'diff', 'proposalId']) THEN
    RAISE EXCEPTION 'review %: what it found never changes', OLD."id" USING ERRCODE = 'insufficient_privilege';
  END IF;
  FOREACH k IN ARRAY ARRAY['planner', 'diff', 'proposalId'] LOOP
    IF (to_jsonb(OLD) -> k) <> 'null'::jsonb AND (to_jsonb(NEW) -> k) IS DISTINCT FROM (to_jsonb(OLD) -> k) THEN
      RAISE EXCEPTION 'review %: % is set once', OLD."id", k USING ERRCODE = 'insufficient_privilege';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

-- ---- History without the words -----------------------------------------------------------
-- row_history, except that the columns named in TG_ARGV are kept as their length,
-- {"chars": n}, on both sides. RowChange is append-only and never purged, and a
-- forget redacts only rows named by the forgotten entity's id, so plain history
-- would keep goal text forever; a digest of a short title could be guessed back.
-- The actor is flint.actor, which every P3 transaction sets.
CREATE FUNCTION row_history_masked() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  o jsonb := to_jsonb(OLD);
  n jsonb := to_jsonb(NEW);
  changed jsonb := '{}'::jsonb;
  k text;
BEGIN
  FOR k IN SELECT jsonb_object_keys(n) LOOP
    CONTINUE WHEN (o -> k) IS NOT DISTINCT FROM (n -> k);
    IF k = ANY (TG_ARGV) THEN
      changed := changed || jsonb_build_object(k, jsonb_build_array(
        CASE WHEN jsonb_typeof(o -> k) = 'null' THEN 'null'::jsonb
             ELSE jsonb_build_object('chars', char_length(CASE WHEN jsonb_typeof(o -> k) = 'string' THEN o ->> k ELSE (o -> k)::text END)) END,
        CASE WHEN jsonb_typeof(n -> k) = 'null' THEN 'null'::jsonb
             ELSE jsonb_build_object('chars', char_length(CASE WHEN jsonb_typeof(n -> k) = 'string' THEN n ->> k ELSE (n -> k)::text END)) END));
    ELSE
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

-- ---- The quote floor under chat's suggestions (exit 7) ----------------------------------------
-- A goal or commitment Flint takes from chat is filed only with Will's own words,
-- quoted (12 to 300 characters), from a chat turn that read nothing untrusted.
CREATE FUNCTION proposal_quote_check() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT coalesce(
       NEW."origin" LIKE 'chat:%' AND NOT NEW."tainted"
       AND jsonb_typeof(NEW."args"->'quote') = 'string' AND char_length(NEW."args"->>'quote') BETWEEN 12 AND 300
       AND NEW."argsProvenance"->'quote'->>'source' = 'will' AND NEW."argsProvenance"->'quote'->'tainted' = 'false'::jsonb, false) THEN
    RAISE EXCEPTION 'proposal %: a % card needs Will''s own untainted words from chat, quoted', NEW."id", NEW."action" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- ---- Triggers --------------------------------------------------------------------------------------
CREATE TRIGGER "Goal_insert_check" BEFORE INSERT ON "Goal"
  FOR EACH ROW EXECUTE FUNCTION goal_insert_check();
CREATE TRIGGER "Goal_guard" BEFORE UPDATE OR DELETE ON "Goal"
  FOR EACH ROW EXECUTE FUNCTION goal_guard();
CREATE TRIGGER "Goal_no_truncate" BEFORE TRUNCATE ON "Goal"
  FOR EACH STATEMENT EXECUTE FUNCTION goal_guard();
CREATE TRIGGER "Goal_history" AFTER UPDATE ON "Goal"
  FOR EACH ROW EXECUTE FUNCTION row_history_masked('title', 'description', 'successCriteria');

CREATE TRIGGER "GoalEntity_guard" BEFORE INSERT OR UPDATE OR DELETE ON "GoalEntity"
  FOR EACH ROW EXECUTE FUNCTION goal_entity_guard();
CREATE TRIGGER "GoalEntity_no_truncate" BEFORE TRUNCATE ON "GoalEntity"
  FOR EACH STATEMENT EXECUTE FUNCTION goal_entity_guard();

CREATE TRIGGER "Plan_insert_check" BEFORE INSERT ON "Plan"
  FOR EACH ROW EXECUTE FUNCTION plan_insert_check();
CREATE TRIGGER "Plan_guard" BEFORE UPDATE OR DELETE ON "Plan"
  FOR EACH ROW EXECUTE FUNCTION plan_guard();
CREATE TRIGGER "Plan_no_truncate" BEFORE TRUNCATE ON "Plan"
  FOR EACH STATEMENT EXECUTE FUNCTION plan_guard();
CREATE TRIGGER "Plan_history" AFTER UPDATE ON "Plan"
  FOR EACH ROW EXECUTE FUNCTION row_history_masked('rationale', 'assumptions');

CREATE TRIGGER "PlanStep_guard" BEFORE INSERT OR UPDATE OR DELETE ON "PlanStep"
  FOR EACH ROW EXECUTE FUNCTION plan_step_guard();
CREATE TRIGGER "PlanStep_no_truncate" BEFORE TRUNCATE ON "PlanStep"
  FOR EACH STATEMENT EXECUTE FUNCTION plan_step_guard();
CREATE TRIGGER "PlanStep_history" AFTER UPDATE ON "PlanStep"
  FOR EACH ROW EXECUTE FUNCTION row_history_masked('title');

CREATE TRIGGER "GoalReview_insert_check" BEFORE INSERT ON "GoalReview"
  FOR EACH ROW EXECUTE FUNCTION goal_review_insert_check();
CREATE TRIGGER "GoalReview_guard" BEFORE UPDATE OR DELETE ON "GoalReview"
  FOR EACH ROW EXECUTE FUNCTION goal_review_guard();
CREATE TRIGGER "GoalReview_no_truncate" BEFORE TRUNCATE ON "GoalReview"
  FOR EACH STATEMENT EXECUTE FUNCTION goal_review_guard();

CREATE TRIGGER "Proposal_quote_check" BEFORE INSERT ON "Proposal"
  FOR EACH ROW WHEN (NEW."action" IN ('goal.propose', 'world.commitment.from_chat')) EXECUTE FUNCTION proposal_quote_check();

-- ---- The goal queues (the closed set; nothing sends to them until the planner is on) ------------------
--   goals.tick    finds the reviews that are due, every 2 minutes, one run at a time
--   goals.review  one goal's review (stately per goal: one waiting and one running)
--   goals.plan    one review's local-model plan stage (stately per goal)
SELECT pgboss.create_queue('goals.tick', '{"policy":"singleton","retryLimit":1,"retryDelay":60,"expireInSeconds":300,"deadLetter":"dead"}'::jsonb);
SELECT pgboss.create_queue('goals.review', '{"policy":"stately","retryLimit":3,"retryDelay":30,"retryBackoff":true,"expireInSeconds":300,"deadLetter":"dead"}'::jsonb);
SELECT pgboss.create_queue('goals.plan', '{"policy":"stately","retryLimit":2,"retryDelay":60,"expireInSeconds":900,"deadLetter":"dead"}'::jsonb);

-- ---- Grants ------------------------------------------------------------------------------------------------
-- flint_app writes the columns its executors and (later) its reviews write, no more:
-- never what a goal is (owner, origin, source, sensitivity, taint, createdAt) and
-- never activatedAt (the trigger sets it). The two helpers run inside trigger
-- bodies as flint_app, so it may execute them; both only read.
REVOKE ALL ON FUNCTION p3_signed_proposal(text, text, text[]), p3_step_norm(jsonb), goal_insert_check(), goal_guard(), goal_entity_guard(),
  plan_insert_check(), plan_guard(), plan_step_guard(), goal_review_insert_check(), goal_review_guard(), row_history_masked(),
  proposal_quote_check() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION p3_signed_proposal(text, text, text[]), p3_step_norm(jsonb) TO flint_app;

GRANT SELECT, INSERT, UPDATE ("status", "progress", "nextReviewAt", "approvalId", "criteriaMet", "priority", "title", "description",
  "successCriteria", "horizonAt", "reviewCadence", "updatedAt") ON "Goal" TO flint_app;
GRANT SELECT, INSERT, DELETE, UPDATE ("seenVersion") ON "GoalEntity" TO flint_app;
GRANT SELECT, INSERT, UPDATE ("status", "approvalId") ON "Plan" TO flint_app;
GRANT SELECT, INSERT, UPDATE ("status", "doneAt", "doneAuditId", "proposalId", "taskId") ON "PlanStep" TO flint_app;
GRANT SELECT, INSERT, UPDATE ("planner", "diff", "proposalId") ON "GoalReview" TO flint_app;
