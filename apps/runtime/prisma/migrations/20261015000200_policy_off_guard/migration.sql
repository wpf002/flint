-- Who may make a policy row, and who may switch one off. Rules only: triggers
-- and their functions. No table, no column, no grant.
--
-- A policy row either lets an action run alone or holds one back (at approval,
-- or forbidden). Of the live rows that match an action the strictest wins, and
-- an action is promoted only when every matching row is at alone, under the
-- LOWEST daily cap among them (@flint/policy resolveTier). So a row at
-- approval or forbidden is a brake Will signed, and so is a cap: with either
-- gone, a wider row promotes the action again or runs it more often. Until now
-- the runtime's role could switch off any row; a card left executing could
-- make its rows again for as long as it stayed that way; a signed table could
-- be applied in part (the row that lets go, and never the brake beside it); and
-- nothing kept one card from saying two things. The two floors that read "no
-- live row holds it back" (goal_chat_floor, task_guard) stood on all of that.
--
-- 1. A policy change says ONE thing. A card whose action is policy.change is
--    filed only with args that are one key, `rows` or `off`, holding a list that
--    is not empty: it adds rules, or it switches rules off. A card that carried
--    both would serve both guards below under one signature, and read as a
--    switch-off while it added a rule. For a card filed before this (the check
--    is on INSERT), each guard also refuses a card that carries the other key.
--
-- 2. A row is made once, whole, under a card that still stands
--    (action_policy_matches_approval, P1's guard, with more to pass). As
--    before: the approval is Will's yes to an executing policy.change card that
--    lists exactly this row, for at most 180 days, and the row is born on. Now
--    also: the card is from the console or the CLI, untainted and marked for
--    his own touch; its key is still live; it has not expired (by the wall
--    clock) and expires no later than 7 days after his approval does; its
--    stored args are the args he signed (their digest is computed again here);
--    and it has not made this row before. A card makes one row for each time it
--    lists one, ever, so a row that was switched off is never made again from
--    the card that made it. And a card's rows are made together or not at all
--    (action_policy_whole_card, checked when the transaction commits): a row
--    that lets an action run alone never lands without the brake signed beside
--    it. A row's id is shaped as an id (so a card can name it to switch it
--    off), and no row covers policy.change itself (a rule that forbade a
--    policy change could never be signed away).
--
-- 3. A row goes from on to off, for every role but the owner, only when one of
--    these holds (action_policy_off_guard):
--      a. it is at alone and has no cap. Switching it off cannot make any
--         action less restricted, whatever else is there now or is signed
--         later: the action goes back to asking, or another row still decides.
--         Its expiry is not read. A row with a cap is not let through: its cap
--         may be the lowest one in force, now or once a wider row arrives.
--      b. a card Will signed says so: an executing policy.change card, held to
--         all that a card is held to under 2, whose args name this row under
--         `off` by its id, its pattern and its tier.
--    A row goes off once and never comes back on, so a card left executing has
--    nothing to do twice. The row's history then names the approval of the
--    card that let it through, whatever the writer said of itself; and no
--    switch-off without such a card is recorded under an approval's name.
--
-- Only at READ COMMITTED, for a row made and a row switched off alike. The
-- guards read a card, its approval, its key and the card's other rows as they
-- are committed now. Above READ COMMITTED a transaction keeps reading the
-- database as it was when it began: a card that has since ended, a key since
-- revoked, a row the card has since made. So any other level is refused
-- outright, as the goal store's and the task store's guards refuse theirs.
-- Every writer in the runtime runs at READ COMMITTED. (That a row at approval
-- or forbidden, or one with a cap, never goes off without a card rests on the
-- row alone, at every level.)
--
-- Rows and cards that are already there are held like new ones: the guards are
-- on the change, not on the row. Nothing else P1's guards do is touched:
-- nothing but `active` ever changes, a row never comes back on, and none is
-- deleted. The owner role is not held to the switch-off rule (a restore
-- carries forward what Will switched off; a test's fixture; a repair by hand),
-- as it is not held to the other floors; it IS held to how a row is made, as
-- it was under P1. A restore loads rows before any trigger exists.
-- Reversed by down.sql in this directory, which puts P1's own
-- action_policy_matches_approval back to the letter.

-- ---- 1. A policy change says one thing -------------------------------------------
-- Errors here and below name ids only, and only one shaped as an id (no word
-- dressed as an id is repeated): never a pattern's words, a reason or a card's
-- args.
CREATE FUNCTION proposal_policy_shape() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  list jsonb;
BEGIN
  IF jsonb_typeof(NEW."args") = 'object' AND (SELECT count(*) FROM jsonb_object_keys(NEW."args")) = 1 THEN
    list := coalesce(NEW."args"->'rows', NEW."args"->'off');
  END IF;
  -- (A list's length is asked only of a list.)
  IF NOT coalesce(CASE WHEN jsonb_typeof(list) = 'array' THEN jsonb_array_length(list) > 0 ELSE false END, false) THEN
    RAISE EXCEPTION 'proposal %: a policy change adds rules or switches rules off, and nothing else',
      CASE WHEN NEW."id" ~ '^[A-Za-z0-9_-]{1,64}$' THEN NEW."id" ELSE '?' END USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Proposal_policy_shape" BEFORE INSERT ON "Proposal"
  FOR EACH ROW WHEN (NEW."action" = 'policy.change') EXECUTE FUNCTION proposal_policy_shape();

-- ---- 2. A row is made once, whole, under a card that still stands ------------------
-- P1's guard, replaced in place (CREATE OR REPLACE keeps its owner, its grants
-- and its trigger). P1's own checks are here as they were; what an error
-- repeats is now an id shaped as one.
CREATE OR REPLACE FUNCTION action_policy_matches_approval() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  a "Approval"%ROWTYPE;
  p "Proposal"%ROWTYPE;
  rid text := CASE WHEN NEW."id" ~ '^[A-Za-z0-9_-]{1,64}$' THEN NEW."id" ELSE '?' END;
  aid text := CASE WHEN NEW."approvalId" ~ '^[A-Za-z0-9_-]{1,64}$' THEN NEW."approvalId" ELSE '?' END;
  stands boolean := false;
  listed integer;
  made integer;
BEGIN
  -- What a row is, whoever makes it.
  IF rid = '?' THEN
    RAISE EXCEPTION 'policy row: its id is not shaped as an id' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."pattern" = 'policy.change' OR (right(NEW."pattern", 2) = '.*' AND starts_with('policy.change', left(NEW."pattern", -1))) THEN
    RAISE EXCEPTION 'policy row %: no rule covers a policy change', rid USING ERRCODE = 'check_violation';
  END IF;
  -- Everything below reads what is committed now: the card, its approval, its key, the rows it has made.
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'policy row %: a row is made at READ COMMITTED', rid USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO a FROM "Approval" WHERE "id" = NEW."approvalId";
  IF NOT FOUND OR a."decision" <> 'approve' OR a."subjectType" <> 'proposal' THEN
    RAISE EXCEPTION 'policy row: approval % is not an approved proposal', aid USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO p FROM "Proposal" WHERE "id" = a."subjectId";
  IF NOT FOUND OR NOT coalesce(
       p."kind" = 'policy' AND p."action" = 'policy.change' AND p."approvalId" = a."id" AND p."status" = 'executing'
       AND jsonb_typeof(p."args"->'rows') = 'array', false) THEN
    RAISE EXCEPTION 'policy row %: its card is not an approved policy change being executed', rid USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- The card still stands: Will's own, with nothing untrusted in it, under a live key, not expired, holding the
  -- args he signed, and saying this one thing.
  BEGIN
    stands := coalesce(
      NOT p."args" ? 'off'
      AND p."expiresAt" > clock_timestamp() AND p."expiresAt" <= a."expiresAt" + interval '7 days'
      AND p."origin" IN ('console', 'cli') AND NOT p."tainted" AND p."consequential"
      AND a."payload"->>'action' = 'policy.change' AND a."payload"->>'argsDigest' = p."argsDigest"
      AND EXISTS (SELECT 1 FROM "ApprovalCredential" k WHERE k."credentialId" = a."credentialId" AND k."revokedAt" IS NULL)
      AND p3_args_digest(p."args") = p."argsDigest", false);
  EXCEPTION WHEN check_violation OR statement_too_complex THEN
    -- Args that have no digest (a number that is no whole number, a key that is not plain, a depth past reading)
    -- are not what he signed.
    stands := false;
  END;
  IF NOT stands THEN
    RAISE EXCEPTION 'policy row %: its card is not one Will signed that still stands', rid USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT count(*) INTO listed FROM jsonb_array_elements(p."args"->'rows') AS r
  WHERE r->>'pattern' = NEW."pattern"
    AND r->>'tier' = NEW."tier"
    AND coalesce(r->'dailyCap', 'null'::jsonb) = coalesce(to_jsonb(NEW."dailyCap"), 'null'::jsonb)
    AND coalesce(r->'scope', 'null'::jsonb) = coalesce(NEW."scope", 'null'::jsonb)
    AND (r->>'expiresAt')::timestamptz = NEW."expiresAt";
  IF listed = 0 THEN
    RAISE EXCEPTION 'policy row %: not in the signed proposal', rid USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- One row for each time the card lists it, ever: a row switched off is never made again from the card that made
  -- it. One writer at a time for a card, so the count is exact (the next waits here until this one has landed).
  PERFORM pg_advisory_xact_lock(hashtext('action_policy_card'), hashtext(NEW."approvalId"));
  SELECT count(*) INTO made FROM "ActionPolicy" x
  WHERE x."approvalId" = NEW."approvalId" AND x."pattern" = NEW."pattern" AND x."tier" = NEW."tier"
    AND coalesce(to_jsonb(x."dailyCap"), 'null'::jsonb) = coalesce(to_jsonb(NEW."dailyCap"), 'null'::jsonb)
    AND coalesce(x."scope", 'null'::jsonb) = coalesce(NEW."scope", 'null'::jsonb)
    AND x."expiresAt" = NEW."expiresAt";
  IF made >= listed THEN
    RAISE EXCEPTION 'policy row %: its card has made this row already', rid USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."expiresAt" > now() + interval '181 days' THEN
    RAISE EXCEPTION 'policy row %: expires more than 180 days out', rid;
  END IF;
  IF NOT NEW."active" THEN
    RAISE EXCEPTION 'policy row %: inserted inactive', rid;
  END IF;
  RETURN NEW;
END;
$$;

-- A card's rows are made together or not at all. Checked when the transaction
-- commits (a constraint trigger, deferred): by then every row the card lists
-- is there, once for each time it is listed, or none of this transaction's
-- rows stay. So what Will signed as a table is never in force in part: not the
-- row that lets go without the brake beside it. A card whose args are gone by
-- then (cleared in the same transaction) cannot be checked, and is refused.
CREATE FUNCTION action_policy_whole_card() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  rid text := CASE WHEN NEW."id" ~ '^[A-Za-z0-9_-]{1,64}$' THEN NEW."id" ELSE '?' END;
  listed jsonb;
BEGIN
  SELECT p."args"->'rows' INTO listed FROM "Proposal" p WHERE p."approvalId" = NEW."approvalId";
  IF NOT coalesce(jsonb_typeof(listed) = 'array', false) THEN
    RAISE EXCEPTION 'policy row %: its card''s rows cannot be read, so none is made', rid USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM (SELECT r->>'pattern' AS pattern, r->>'tier' AS tier, coalesce(r->'dailyCap', 'null'::jsonb) AS cap, coalesce(r->'scope', 'null'::jsonb) AS scope,
                 (r->>'expiresAt')::timestamptz AS until, count(*) AS listed
          FROM jsonb_array_elements(listed) AS r GROUP BY 1, 2, 3, 4, 5) want
    LEFT JOIN (SELECT x."pattern" AS pattern, x."tier" AS tier, coalesce(to_jsonb(x."dailyCap"), 'null'::jsonb) AS cap, coalesce(x."scope", 'null'::jsonb) AS scope,
                      x."expiresAt" AS until, count(*) AS made
               FROM "ActionPolicy" x WHERE x."approvalId" = NEW."approvalId" GROUP BY 1, 2, 3, 4, 5) have
      ON have.pattern = want.pattern AND have.tier = want.tier AND have.cap = want.cap AND have.scope = want.scope AND have.until = want.until
    WHERE coalesce(have.made, 0) < want.listed) THEN
    RAISE EXCEPTION 'policy row %: a card''s rows are made together, all of them or none', rid USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER "ActionPolicy_whole_card" AFTER INSERT ON "ActionPolicy"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION action_policy_whole_card();

-- ---- 3. Who may switch a row off --------------------------------------------------
-- One function, fired twice for a row that goes from on to off: BEFORE the
-- change, to let it through or refuse it; and AFTER it, just ahead of the
-- history trigger, to say whose change it was.
CREATE FUNCTION action_policy_off_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  rid text := CASE WHEN OLD."id" ~ '^[A-Za-z0-9_-]{1,64}$' THEN OLD."id" ELSE '?' END;
  -- How a card names this row: all three, so what Will read on the card is the row that goes off. (Only a list
  -- holds it: `@>` finds an object in a list of objects, never in an object, a text or a list inside a list.)
  named jsonb := jsonb_build_array(jsonb_build_object('id', OLD."id", 'pattern', OLD."pattern", 'tier', OLD."tier"));
  -- a. At alone with no cap, it goes off with no card: that cannot loosen anything, now or later.
  free boolean := OLD."tier" = 'alone' AND OLD."dailyCap" IS NULL;
  card text;
  c record;
BEGIN
  IF current_user = 'flint_owner' THEN
    RETURN NEW;
  END IF;
  -- Everything below reads what is committed now: the card, its approval, its key.
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'policy row %: a row is switched off at READ COMMITTED', rid USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- b. The card Will signed that names it: the approval's id, or none. (Looked for whatever the row is: a card may
  -- name a row that needs none, and its history then says so.)
  FOR c IN
    SELECT a."id" AS approval, p."args", p."argsDigest", p."expiresAt" AS card_until, p."origin", p."tainted", p."consequential",
           a."expiresAt" AS signed_until, a."payload", a."credentialId"
    FROM "Proposal" p JOIN "Approval" a ON a."id" = p."approvalId"
    WHERE p."status" = 'executing' AND p."action" = 'policy.change' AND p."kind" = 'policy'
      AND a."decision" = 'approve' AND a."subjectType" = 'proposal' AND a."subjectId" = p."id"
      AND p."args"->'off' @> named AND NOT p."args" ? 'rows'
  LOOP
    BEGIN
      IF coalesce(
           c.card_until > clock_timestamp() AND c.card_until <= c.signed_until + interval '7 days'
           AND c."origin" IN ('console', 'cli') AND NOT c."tainted" AND c."consequential"
           AND c."payload"->>'action' = 'policy.change' AND c."payload"->>'argsDigest' = c."argsDigest"
           AND EXISTS (SELECT 1 FROM "ApprovalCredential" k WHERE k."credentialId" = c."credentialId" AND k."revokedAt" IS NULL)
           AND p3_args_digest(c."args") = c."argsDigest", false) THEN
        card := c.approval;
        EXIT;
      END IF;
    EXCEPTION WHEN check_violation OR statement_too_complex THEN
      -- Args that have no digest (a number that is no whole number, a key that is not plain, a depth past reading)
      -- are not what he signed. The next card is read: one that cannot be read never stands in a good one's way.
      CONTINUE;
    END;
  END LOOP;

  IF card IS NULL AND NOT free THEN
    RAISE EXCEPTION 'policy row %: it holds something back, so only a card Will signed switches it off', rid USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_WHEN = 'BEFORE' THEN
    RETURN NEW;
  END IF;
  -- AFTER: the history trigger fires next (by name) and reads flint.actor. A row a card let through is recorded
  -- under that card's approval, whatever the writer had set; one that no card names is never recorded under an
  -- approval's name (the writer's own word for itself stands otherwise).
  IF card IS NOT NULL THEN
    PERFORM set_config('flint.actor', 'will:approval:' || card, true);
  ELSIF coalesce(current_setting('flint.actor', true), '') LIKE 'will:approval:%' THEN
    PERFORM set_config('flint.actor', '', true);
  END IF;
  RETURN NULL;
END;
$$;

-- Only a row going from on to off. BEFORE triggers fire in name order, and this one before
-- ActionPolicy_update_guard: both must pass, and neither changes the row.
CREATE TRIGGER "ActionPolicy_off_guard" BEFORE UPDATE ON "ActionPolicy"
  FOR EACH ROW WHEN (OLD."active" AND NOT NEW."active") EXECUTE FUNCTION action_policy_off_guard();
-- Named to fire before ActionPolicy_history (AFTER triggers fire in name order, row by row).
CREATE TRIGGER "ActionPolicy_card_actor" AFTER UPDATE ON "ActionPolicy"
  FOR EACH ROW WHEN (OLD."active" AND NOT NEW."active") EXECUTE FUNCTION action_policy_off_guard();

-- Trigger functions, like the others: no role calls them.
REVOKE ALL ON FUNCTION proposal_policy_shape(), action_policy_whole_card(), action_policy_off_guard() FROM PUBLIC;
