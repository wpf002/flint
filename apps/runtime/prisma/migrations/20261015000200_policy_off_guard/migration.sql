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
--    And each rule a card adds ends at a time written ONE way: in full, with
--    its zone (2026-11-12T09:47:57.000Z). A time with no zone, or a date that
--    reads as two (03/04/2027), is a different moment under each session's
--    TimeZone or DateStyle, and those are the runtime's own to set: one listed
--    row would be made once for every way of reading it, and could end later
--    than the card showed. Such a card is never filed, and the guards below
--    read no end as a moment until it is written that way (so no cast in this
--    file depends on a session's settings). Days are counted in UTC for the
--    same reason: each guard that adds days to a moment pins its own TimeZone,
--    as its search_path is pinned, so a day is 24 hours whoever asks.
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
--    nothing to do twice. Who switched it off is the guard's to say and never
--    the writer's: the row's history names the approval of the card that let
--    it through, or else the database role that wrote it, whatever the writer
--    had said of itself. That holds for the one row: once its history is
--    written, the writer's own name for itself is back for whatever it does
--    next in the transaction.
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
  pid text := CASE WHEN NEW."id" ~ '^[A-Za-z0-9_-]{1,64}$' THEN NEW."id" ELSE '?' END;
  list jsonb;
  timed boolean := true;
BEGIN
  IF jsonb_typeof(NEW."args") = 'object' AND (SELECT count(*) FROM jsonb_object_keys(NEW."args")) = 1 THEN
    list := coalesce(NEW."args"->'rows', NEW."args"->'off');
  END IF;
  -- (A list's length is asked only of a list.)
  IF NOT coalesce(CASE WHEN jsonb_typeof(list) = 'array' THEN jsonb_array_length(list) > 0 ELSE false END, false) THEN
    RAISE EXCEPTION 'proposal %: a policy change adds rules or switches rules off, and nothing else', pid USING ERRCODE = 'check_violation';
  END IF;
  -- Each rule it adds ends at a time written one way, in full and with its zone...
  IF NEW."args" ? 'rows' THEN
    timed := NOT EXISTS (SELECT 1 FROM jsonb_array_elements(list) AS r
                         WHERE coalesce(r->>'expiresAt', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,3})?(Z|[+-][0-9]{2}:[0-9]{2})$');
    -- ...and that is a moment (a thirteenth month is none). Read as one only now that it is written that way.
    IF timed THEN
      BEGIN
        PERFORM 1 FROM jsonb_array_elements(list) AS r WHERE (r->>'expiresAt')::timestamptz IS NULL;
      EXCEPTION WHEN data_exception THEN
        timed := false;
      END;
    END IF;
  END IF;
  IF NOT timed THEN
    RAISE EXCEPTION 'proposal %: each rule a policy change adds ends at a time written in full, with its zone', pid USING ERRCODE = 'check_violation';
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
LANGUAGE plpgsql SET search_path = public, pg_temp SET TimeZone = 'UTC' AS $$
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
  -- args he signed, saying this one thing, and ending each row it lists at a time written one way (in full, with
  -- its zone: no setting of the session's reads that as another moment).
  BEGIN
    stands := coalesce(
      NOT p."args" ? 'off'
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p."args"->'rows') AS r
                      WHERE coalesce(r->>'expiresAt', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,3})?(Z|[+-][0-9]{2}:[0-9]{2})$')
      AND p."expiresAt" > clock_timestamp() AND p."expiresAt" <= a."expiresAt" + interval '7 days'
      AND p."origin" IN ('console', 'cli') AND NOT p."tainted" AND p."consequential"
      AND a."payload"->>'action' = 'policy.change' AND a."payload"->>'argsDigest' = p."argsDigest"
      AND EXISTS (SELECT 1 FROM "ApprovalCredential" k WHERE k."credentialId" = a."credentialId" AND k."revokedAt" IS NULL)
      AND p3_args_digest(p."args") = p."argsDigest", false);
    -- Each of those ends is a moment (a thirteenth month is none). Read as one only now that it is written that way.
    IF stands THEN
      PERFORM 1 FROM jsonb_array_elements(p."args"->'rows') AS r WHERE (r->>'expiresAt')::timestamptz IS NULL;
    END IF;
  EXCEPTION WHEN check_violation OR statement_too_complex OR data_exception THEN
    -- Args that have no digest (a number that is no whole number, a key that is not plain, a depth past reading),
    -- or an end that is no moment, are not what he signed.
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
  readable boolean;
  short boolean := false;
BEGIN
  SELECT p."args"->'rows' INTO listed FROM "Proposal" p WHERE p."approvalId" = NEW."approvalId";
  -- The rows as the card lists them now: a list, and each end a time written the one way a card writes it. Only
  -- then is an end read as a moment (no setting of the session's reads that as another one).
  readable := coalesce(jsonb_typeof(listed) = 'array', false);
  IF readable THEN
    readable := NOT EXISTS (SELECT 1 FROM jsonb_array_elements(listed) AS r
                            WHERE coalesce(r->>'expiresAt', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,3})?(Z|[+-][0-9]{2}:[0-9]{2})$');
  END IF;
  IF readable THEN
    BEGIN
      short := EXISTS (
        SELECT 1
        FROM (SELECT r->>'pattern' AS pattern, r->>'tier' AS tier, coalesce(r->'dailyCap', 'null'::jsonb) AS cap, coalesce(r->'scope', 'null'::jsonb) AS scope,
                     (r->>'expiresAt')::timestamptz AS until, count(*) AS listed
              FROM jsonb_array_elements(listed) AS r GROUP BY 1, 2, 3, 4, 5) want
        LEFT JOIN (SELECT x."pattern" AS pattern, x."tier" AS tier, coalesce(to_jsonb(x."dailyCap"), 'null'::jsonb) AS cap, coalesce(x."scope", 'null'::jsonb) AS scope,
                          x."expiresAt" AS until, count(*) AS made
                   FROM "ActionPolicy" x WHERE x."approvalId" = NEW."approvalId" GROUP BY 1, 2, 3, 4, 5) have
          ON have.pattern = want.pattern AND have.tier = want.tier AND have.cap = want.cap AND have.scope = want.scope AND have.until = want.until
        WHERE coalesce(have.made, 0) < want.listed);
    EXCEPTION WHEN data_exception THEN
      -- An end that is no moment.
      readable := false;
    END;
  END IF;
  IF NOT readable THEN
    RAISE EXCEPTION 'policy row %: its card''s rows cannot be read, so none is made', rid USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF short THEN
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
LANGUAGE plpgsql SET search_path = public, pg_temp SET TimeZone = 'UTC' AS $$
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
  -- AFTER: the history trigger fires next (by name) and reads flint.actor. Whose change this was is said here and
  -- never by the writer: the approval of the card that let the row through, or else nobody's name, which the
  -- history trigger records as the database role that wrote it. What the writer had said of itself is kept aside
  -- and put back once this row's history is written (action_policy_actor_back, below).
  PERFORM set_config('flint.actor_was', coalesce(current_setting('flint.actor', true), ''), true);
  PERFORM set_config('flint.actor', CASE WHEN card IS NOT NULL THEN 'will:approval:' || card ELSE '' END, true);
  RETURN NULL;
END;
$$;

-- After the row's history is written: the writer's own name for itself is back, so nothing it does next in the
-- transaction is recorded under the name the guard gave this one row. (The owner's name is never taken away.)
CREATE FUNCTION action_policy_actor_back() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF current_user <> 'flint_owner' THEN
    PERFORM set_config('flint.actor', coalesce(current_setting('flint.actor_was', true), ''), true);
  END IF;
  RETURN NULL;
END;
$$;

-- Only a row going from on to off. BEFORE triggers fire in name order, and this one before
-- ActionPolicy_update_guard: both must pass, and neither changes the row.
CREATE TRIGGER "ActionPolicy_off_guard" BEFORE UPDATE ON "ActionPolicy"
  FOR EACH ROW WHEN (OLD."active" AND NOT NEW."active") EXECUTE FUNCTION action_policy_off_guard();
-- Named to fire just before ActionPolicy_history, and the next just after it (AFTER triggers fire in name order,
-- row by row: for each row the name is set, its history written, and the name put back).
CREATE TRIGGER "ActionPolicy_card_actor" AFTER UPDATE ON "ActionPolicy"
  FOR EACH ROW WHEN (OLD."active" AND NOT NEW."active") EXECUTE FUNCTION action_policy_off_guard();
CREATE TRIGGER "ActionPolicy_history_actor_back" AFTER UPDATE ON "ActionPolicy"
  FOR EACH ROW WHEN (OLD."active" AND NOT NEW."active") EXECUTE FUNCTION action_policy_actor_back();

-- Trigger functions, like the others: no role calls them.
REVOKE ALL ON FUNCTION proposal_policy_shape(), action_policy_whole_card(), action_policy_off_guard(), action_policy_actor_back() FROM PUBLIC;
