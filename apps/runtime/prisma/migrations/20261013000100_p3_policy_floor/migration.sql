-- P3 part 4: two floors under the promotion tables. Rules only: no table, no
-- column, no grant.
--
-- 1. A policy change always asks on its own. `consequential` is the mark the
--    console reads to keep a card out of Approve All and to ask for a fresh
--    touch. For a policy.change it is no longer the filer's to leave off: a card
--    without it is refused here, whoever files it, and the runtime's own
--    createProposal sets it. The mark cannot change afterwards
--    (proposal_transition holds it fixed). It is checked on INSERT, not as a
--    table CHECK: a CHECK is evaluated again whenever a row is updated, and an
--    older policy card filed without the mark must still be approved, expired
--    and cleared by retention.
CREATE FUNCTION proposal_policy_floor() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW."consequential" IS NOT TRUE THEN
    RAISE EXCEPTION 'proposal %: a policy change always asks on its own', NEW."id" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Proposal_policy_floor" BEFORE INSERT ON "Proposal"
  FOR EACH ROW WHEN (NEW."action" = 'policy.change') EXECUTE FUNCTION proposal_policy_floor();

-- 2. The rows a promotion table counts as evidence are dated by the database,
--    as a goal review already is (goal_review_insert_check): when a health
--    check ran, and when a proposal was filed. The runtime's role cannot write
--    either into the past, so it cannot make a week of checks, or a two-week-old
--    suggestion, in one afternoon. The owner still can (a restore, a test's
--    fixture), as it can do anything. Every row of one statement gets the same
--    time, so the checks of one health run still share theirs.
--
--    This is evidence, not the boundary: the runtime's role can still write a
--    row dated now, and delete a health row (retention needs to). What stands
--    between a promotion and its rule is Will's signature over the rows.
CREATE FUNCTION row_clock() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF current_user <> 'flint_owner' THEN
    IF TG_TABLE_NAME = 'HealthCheck' THEN
      NEW."at" := statement_timestamp();
    ELSE
      NEW."createdAt" := statement_timestamp();
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
-- Named to fire first (BEFORE triggers fire in name order): the checks after it read the time it set.
CREATE TRIGGER "Proposal_clock" BEFORE INSERT ON "Proposal"
  FOR EACH ROW EXECUTE FUNCTION row_clock();
CREATE TRIGGER "HealthCheck_clock" BEFORE INSERT ON "HealthCheck"
  FOR EACH ROW EXECUTE FUNCTION row_clock();

-- Trigger functions, like the others: no role calls them.
REVOKE ALL ON FUNCTION proposal_policy_floor(), row_clock() FROM PUBLIC;
