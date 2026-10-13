-- P3 part 5's floor: a goal Flint takes from chat is added only on a card Will
-- signed, or under a rule he signed. Rules only: no table, no column, no grant.
--
-- Until now the database held the CARD of a suggestion to Will's own quoted
-- words (proposal_quote_check) and left the GOAL it becomes to the runtime. A
-- runtime that broke its own rules could insert a proposed goal with a made-up
-- chat source and any words, and the Goals panel would show it as something he
-- said. Now a goal whose origin is flint is inserted only when one of these
-- holds, and the row is held to what that names:
--
--   1. its own card: an executing goal.propose that Will approved, naming this
--      goal and this source, from a chat, untainted. The goal's title is the
--      card's title and its description the card's quote.
--   2. Make It a Goal: an executing goal.activate that Will approved for this
--      goal, signed as one Flint suggested, with the row's title and
--      description, while the suggestion's own card still waits and names this
--      goal and this source.
--   3. a rule he signed: a live, unscoped ActionPolicy row that lets
--      goal.propose run alone (it exists only on a policy card he signed), no
--      live row holding it back, and the intake's own audit entry for this
--      source and goal, whose digest is the digest of what the row holds. The
--      description is a quote by the card's own measure (12 to 300 characters).
--
-- A card's approval is used once, in one transaction, for this goal
-- (p3_bind_approval, after the row is written: an insert that meets a goal
-- already there and writes nothing spends nothing). A goal's id is made from
-- its source, so no card or entry for one goal covers another.
--
-- Goals that are already there are not touched: this guards INSERT only, and a
-- proposed goal from before it is started or dismissed as before. The owner
-- role is not held to it (a test's fixture, a repair by hand), as it is not
-- held to the row clock: it can do anything. A restore loads rows before any
-- trigger exists.
--
-- Commitments from chat stay on cards: nothing here lets one be added under a
-- rule, and the runtime files a card for each whatever a rule says.
-- Reversed by down.sql in this directory.

-- Named to fire first of Goal's BEFORE INSERT triggers (name order), and once
-- more AFTER the row is written, to use the card's approval. Errors name the
-- goal's id only (and only one shaped as an id): never a title or a quote.
CREATE FUNCTION goal_chat_floor() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  gid text := CASE WHEN NEW."id" ~ '^[A-Za-z0-9_-]{1,40}$' THEN NEW."id" ELSE '?' END;
  cand text;
  p "Proposal"%ROWTYPE;
  e record;
  signed jsonb;
  day_from text;
  day_to text;
BEGIN
  IF current_user = 'flint_owner' THEN
    RETURN NEW;
  END IF;
  -- What every goal from chat is, whoever adds it: Will's, personal, untainted, with nothing counted as done yet,
  -- and named by its source (so a card or an entry for one goal is never one for another).
  IF NOT coalesce(
       NEW."origin" = 'flint' AND NEW."owner" = 'will' AND NOT NEW."tainted" AND NEW."sensitivity" = 'personal' AND NEW."nexusProjectId" IS NULL
       AND NEW."sourceRef" ~ '^chat:[0-9a-f]{64}$' AND NEW."id" = 'go' || substr(NEW."sourceRef", 6, 32), false) THEN
    RAISE EXCEPTION 'goal %: a goal from chat is Will''s own, personal and untainted, and named by its source', gid USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- The day a horizon falls on, anywhere on Earth: the card's day must be one of them (no text of the card is cast).
  IF NEW."horizonAt" IS NOT NULL THEN
    day_from := to_char((NEW."horizonAt" - interval '12 hours') AT TIME ZONE 'UTC', 'YYYY-MM-DD');
    day_to := to_char((NEW."horizonAt" + interval '14 hours') AT TIME ZONE 'UTC', 'YYYY-MM-DD');
  END IF;

  -- 1. The suggestion's own card.
  FOR cand IN
    SELECT "approvalId" FROM "Proposal"
    WHERE "status" = 'executing' AND "action" = 'goal.propose' AND "approvalId" IS NOT NULL AND "args"->>'goalId' = NEW."id"
  LOOP
    BEGIN
      p := p3_signed_proposal(cand, NEW."id", ARRAY['goal.propose']);
      IF coalesce(
           p."origin" LIKE 'chat:%' AND NOT p."tainted" AND p."args"->>'sourceRef' = NEW."sourceRef"
           AND p."args"->>'title' = NEW."title" AND p."args"->>'quote' = NEW."description"
           AND NEW."successCriteria" = '[]'::jsonb
           AND (NEW."horizonAt" IS NULL OR p."args"->>'dueOn' BETWEEN day_from AND day_to), false) THEN
        IF TG_WHEN = 'AFTER' THEN
          PERFORM p3_bind_approval(cand, NEW."id", 'goal.propose');
          RETURN NULL;
        END IF;
        RETURN NEW;
      END IF;
    EXCEPTION WHEN insufficient_privilege THEN
      CONTINUE;
    END;
  END LOOP;

  -- 2. Make It a Goal on a suggestion whose own card still waits: Will's signed start of this goal.
  FOR cand IN
    SELECT "approvalId" FROM "Proposal"
    WHERE "status" = 'executing' AND "action" = 'goal.activate' AND "approvalId" IS NOT NULL AND "args"->>'goalId' = NEW."id"
  LOOP
    BEGIN
      p := p3_signed_proposal(cand, NEW."id", ARRAY['goal.activate']);
      IF coalesce(p."args"->>'origin' = 'flint' AND p."args"->>'title' = NEW."title" AND p."args"->>'description' = NEW."description", false)
         AND EXISTS (
           SELECT 1 FROM "Proposal" s
           WHERE s."action" = 'goal.propose' AND s."kind" = 'goal' AND s."status" = 'pending' AND s."expiresAt" > clock_timestamp()
             AND s."origin" LIKE 'chat:%' AND NOT s."tainted" AND s."args"->>'goalId' = NEW."id" AND s."args"->>'sourceRef' = NEW."sourceRef") THEN
        IF TG_WHEN = 'AFTER' THEN
          -- The same approval, goal and action goal_guard uses when the goal then starts, in this transaction.
          PERFORM p3_bind_approval(cand, NEW."id", 'goal.activate');
          RETURN NULL;
        END IF;
        RETURN NEW;
      END IF;
    EXCEPTION WHEN insufficient_privilege THEN
      CONTINUE;
    END;
  END LOOP;

  -- 3. A rule Will signed lets goal.propose run alone (read as the helpers' store reads its own promotion: a live,
  -- unscoped row, and none that holds it back), and the intake put this goal on record first.
  IF EXISTS (SELECT 1 FROM "ActionPolicy" ap WHERE ap."active" AND ap."expiresAt" > clock_timestamp() AND ap."tier" = 'alone'
             AND ap."pattern" IN ('goal.propose', 'goal.*') AND (ap."scope" IS NULL OR jsonb_typeof(ap."scope") = 'null'))
     AND NOT EXISTS (SELECT 1 FROM "ActionPolicy" ap WHERE ap."active" AND ap."expiresAt" > clock_timestamp() AND ap."tier" <> 'alone'
                     AND ap."pattern" IN ('goal.propose', 'goal.*'))
     AND coalesce(char_length(NEW."description") BETWEEN 12 AND 300 AND NEW."successCriteria" = '[]'::jsonb, false) THEN
    FOR e IN
      SELECT a."inputs" FROM "AuditEntry" a
      WHERE a."correlationId" = NEW."sourceRef" AND a."actor" = 'runtime:goals.candidates' AND a."context" = 'chat' AND a."kind" = 'action'
        AND a."action" = 'goal.propose' AND a."tier" = 'alone' AND a."decision" = 'act' AND a."outcome" = 'ok' AND NOT a."tainted"
        AND a."inputs"->>'goalId' = NEW."id" AND a."inputs"->>'sourceRef' = NEW."sourceRef"
        AND jsonb_typeof(a."inputs"->'saidAt') = 'string' AND jsonb_typeof(a."inputs"->'argsDigest') = 'string'
        AND (NOT a."inputs" ? 'dueOn' OR jsonb_typeof(a."inputs"->'dueOn') = 'string')
    LOOP
      -- What the entry recorded (the digest of the suggestion's args, as digestOf computes it) is what the row holds.
      signed := jsonb_build_object('goalId', NEW."id", 'title', NEW."title", 'quote', NEW."description", 'saidAt', e."inputs"->'saidAt', 'sourceRef', NEW."sourceRef")
                || CASE WHEN e."inputs" ? 'dueOn' THEN jsonb_build_object('dueOn', e."inputs"->'dueOn') ELSE '{}'::jsonb END;
      IF p3_args_digest(signed) = e."inputs"->>'argsDigest'
         AND (NEW."horizonAt" IS NULL OR coalesce(e."inputs"->>'dueOn' BETWEEN day_from AND day_to, false)) THEN
        IF TG_WHEN = 'AFTER' THEN
          RETURN NULL;
        END IF;
        RETURN NEW;
      END IF;
    END LOOP;
  END IF;

  RAISE EXCEPTION 'goal %: a goal from chat is added only by its own signed card, or under a rule Will signed', gid USING ERRCODE = 'insufficient_privilege';
END;
$$;

-- Every goal that is not plainly Will's own: goal_valid (after this) refuses any other origin, and a source on a
-- goal of his.
CREATE TRIGGER "Goal_chat_floor" BEFORE INSERT ON "Goal"
  FOR EACH ROW WHEN (NEW."origin" IS DISTINCT FROM 'will' OR NEW."sourceRef" IS NOT NULL) EXECUTE FUNCTION goal_chat_floor();
CREATE TRIGGER "Goal_chat_floor_bind" AFTER INSERT ON "Goal"
  FOR EACH ROW WHEN (NEW."origin" IS DISTINCT FROM 'will' OR NEW."sourceRef" IS NOT NULL) EXECUTE FUNCTION goal_chat_floor();

-- A trigger function, like the others: no role calls it.
REVOKE ALL ON FUNCTION goal_chat_floor() FROM PUBLIC;
