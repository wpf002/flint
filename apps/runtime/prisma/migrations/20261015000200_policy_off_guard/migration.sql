-- Who may switch a policy row off. Rules only: one trigger and its function. No
-- table, no column, no grant.
--
-- A policy row is switched off, never deleted (action_policy_update_guard, P1),
-- and until now the runtime's role could switch off any of them. For a row that
-- lets an action run alone that is right: switched off, the action goes back to
-- asking Will. For a row that holds an action back it is wrong. A row at
-- approval or forbidden is a brake Will signed, and with it switched off a
-- wider row promotes the action again (goal.* at alone under goal.propose at
-- approval; task.check_bar at alone under task.* at approval). The two floors
-- that read "no live row holds it back" (goal_chat_floor, task_guard) stood on
-- a row the runtime could switch off.
--
-- From here a row goes from on to off, for every role but the owner, only when
-- one of these holds:
--
--   1. Switching it off cannot make any action less restricted. The tier
--      engine (@flint/policy resolveTier) reads the rows like this: of the
--      live rows that match an action the strictest wins, so a row at approval
--      or forbidden holds whatever else is there; an action is promoted only
--      when every matching row is at alone, and then under the LOWEST daily
--      cap among the rows that promote it. So the row must be at alone, and it
--      must not be the one that keeps a cap down: either it has no cap, or no
--      other row that is on, at alone, and able to match an action this one
--      matches has a higher cap or none. This reads wider than the engine
--      does: another row counts whether or not it has expired, whatever its
--      scope, and whether or not the action is promoted by name only; and this
--      row's own expiry is not read. So a switch-off refused here may be one
--      that would have been safe; one allowed here is safe, whatever the
--      clock says.
--   2. A card Will signed says so: an executing policy.change card from the
--      console or the CLI, untainted, marked for his own touch, approved under
--      a key that is still live, not expired (by the wall clock) and expiring
--      no later than 7 days after his approval does, whose stored args are the
--      args he signed (their digest is computed again here) and name this row
--      under `off` by its id, its pattern and its tier. This is how a row is
--      made (action_policy_matches_approval), held to what the later cards are
--      held to (p4_signed_proposal, p5_signed_proposal). A row goes off once
--      and never comes back on, so a card left executing has nothing to do
--      twice, and no record of its use is kept.
--
-- Only at READ COMMITTED. The first way reads the other rows and the second a
-- card, its approval and its key, as they are committed now. Above READ
-- COMMITTED a transaction keeps reading the database as it was when it began:
-- a row with a higher cap signed since, a card that has since ended, a key
-- since revoked. So a switch-off at any other level is refused outright, as
-- the goal store's and the task store's guards refuse theirs. Every writer in
-- the runtime runs at READ COMMITTED. (That a row at approval or forbidden
-- never goes off without a card rests on the row alone, at every level.)
--
-- Rows that are already there are held like new ones: the guard is on the
-- change, not on the row. Nothing P1's guards do is touched: a row is still
-- made only as its signed card lists it, nothing but `active` ever changes, a
-- row never comes back on, and none is deleted. The owner role is not held to
-- this (a restore carries forward what Will switched off and switches off what
-- his signature no longer covers; a test's fixture; a repair by hand), as it is
-- not held to the other floors.
-- Reversed by down.sql in this directory.

-- Errors name the row's id only, and only one shaped as an id (no word dressed
-- as an id is repeated): never a pattern's words, a reason or a card's args.
CREATE FUNCTION action_policy_off_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  rid text := CASE WHEN OLD."id" ~ '^[A-Za-z0-9_-]{1,64}$' THEN OLD."id" ELSE '?' END;
  -- How a card names this row: all three, so what Will read on the card is the row that goes off. (Only a list
  -- holds it: `@>` finds an object in a list of objects, never in an object, a text or a list inside a list.)
  named jsonb := jsonb_build_array(jsonb_build_object('id', OLD."id", 'pattern', OLD."pattern", 'tier', OLD."tier"));
  c record;
BEGIN
  IF current_user = 'flint_owner' THEN
    RETURN NEW;
  END IF;
  -- Everything below reads what is committed now: the other rows, the card, its approval, its key.
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'policy row %: a row is switched off at READ COMMITTED', rid USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- 1. It lets an action run alone, and it is not what keeps a cap down. Two patterns can match one action when
  -- they are the same, or when one is `prefix.*` and the other starts with that prefix.
  IF OLD."tier" = 'alone' AND (OLD."dailyCap" IS NULL OR NOT EXISTS (
       SELECT 1 FROM "ActionPolicy" o
       WHERE o."active" AND o."tier" = 'alone' AND (o."dailyCap" IS NULL OR o."dailyCap" > OLD."dailyCap")
         AND (o."pattern" = OLD."pattern"
              OR (right(o."pattern", 2) = '.*' AND starts_with(OLD."pattern", left(o."pattern", -1)))
              OR (right(OLD."pattern", 2) = '.*' AND starts_with(o."pattern", left(OLD."pattern", -1)))))) THEN
    RETURN NEW;
  END IF;

  -- 2. A card Will signed names it.
  FOR c IN
    SELECT p."args", p."argsDigest", p."expiresAt" AS card_until, p."origin", p."tainted", p."consequential",
           a."expiresAt" AS signed_until, a."payload", a."credentialId"
    FROM "Proposal" p JOIN "Approval" a ON a."id" = p."approvalId"
    WHERE p."status" = 'executing' AND p."action" = 'policy.change' AND p."kind" = 'policy'
      AND a."decision" = 'approve' AND a."subjectType" = 'proposal' AND a."subjectId" = p."id"
      AND p."args"->'off' @> named
  LOOP
    BEGIN
      IF coalesce(
           c.card_until > clock_timestamp() AND c.card_until <= c.signed_until + interval '7 days'
           AND c."origin" IN ('console', 'cli') AND NOT c."tainted" AND c."consequential"
           AND c."payload"->>'action' = 'policy.change' AND c."payload"->>'argsDigest' = c."argsDigest"
           AND EXISTS (SELECT 1 FROM "ApprovalCredential" k WHERE k."credentialId" = c."credentialId" AND k."revokedAt" IS NULL)
           AND p3_args_digest(c."args") = c."argsDigest", false) THEN
        RETURN NEW;
      END IF;
    EXCEPTION WHEN check_violation THEN
      -- Args that have no digest (a number that is no whole number, a key that is not plain) are not what he signed.
      CONTINUE;
    END;
  END LOOP;

  RAISE EXCEPTION 'policy row %: it holds something back, so only a card Will signed switches it off', rid USING ERRCODE = 'insufficient_privilege';
END;
$$;

-- Only a row going from on to off. Named to fire before ActionPolicy_update_guard (BEFORE triggers fire in name
-- order): both must pass, and neither changes the row.
CREATE TRIGGER "ActionPolicy_off_guard" BEFORE UPDATE ON "ActionPolicy"
  FOR EACH ROW WHEN (OLD."active" AND NOT NEW."active") EXECUTE FUNCTION action_policy_off_guard();

-- A trigger function, like the others: no role calls it.
REVOKE ALL ON FUNCTION action_policy_off_guard() FROM PUBLIC;
