/**
 * Goals and commitments from chat (Machine plan P3 part 5): the runtime's side.
 *
 * The server's memory extractor reads Will's chats on its local model, and when
 * he set a goal or said he would do something it hands the runtime a candidate:
 * a few words, his own quoted words, and the conversation and turn they came
 * from (POST /v1/goals/candidates, scope `proposals`). The server has already
 * checked that the quote is in his own message of that turn. The runtime holds
 * no transcript, so that check is the server's; everything else is checked
 * again here, whatever the server says:
 *
 *  - the request, against the shared contract (@flint/policy ChatCandidate):
 *    ids of the shape the server names turns by, a quote of 12 to 300
 *    characters in his own characters, a short text that could be a
 *    goal's title (its length, no control or format character), a real day
 *    that has not passed and is not over ten years out, a turn that ended in
 *    the last 30 days and not in the future;
 *  - the same conversation, turn and quote is one suggestion, for good: its
 *    source (`chat:<sha256>`) is kept in the audit trail, and a replay files
 *    nothing. And once Will has turned a suggestion down, nothing more of that
 *    kind is taken from that turn, however it is quoted;
 *  - the day's limit (3 goals, 10 commitments);
 *  - the tier, in chat context: FORBIDDEN is refused; otherwise a card is
 *    filed for Will to sign, one that asks on its own (never in Approve All).
 * All of it under one lock on the source, in one transaction with the day's
 * claim: identical or racing posts make one card and use one slot, and a card
 * that could not be filed uses none.
 *
 * WHAT RUNS WITHOUT A CARD rests on the database (chatFloorInDatabase). A
 * goal is added directly, under a rule Will signed (ALONE), only while the
 * database itself holds a goal from chat to a signed card or to that rule
 * (the p3_chat_goal_floor migration: the intake asks the database whether the
 * guard is there, every time). Without it the intake files a card whatever a
 * rule says, and the later promotion table is refused
 * (governance/promotion.ts). The database has the last word after that too:
 * if it refuses the add, the suggestion becomes a card. A commitment is never
 * added without a card: the database has no such floor under commitments.
 *
 * Nothing but this intake files these two actions (createProposal refuses any
 * other caller), and no model can reach it: the route takes the server's own
 * token, never the runtime connector's.
 *
 * What an approved card (or ALONE) does is small on purpose:
 *  - goal.propose adds a PROPOSED goal: Flint's suggestion (origin flint), its
 *    title the short text, its description Will's quote, its source recorded.
 *    It does nothing until Will makes it a goal with his own signature.
 *  - world.commitment.from_chat adds an unconfirmed commitment: no title in the
 *    world model, Will's quote in EntityText (which retention clears after a
 *    week), a hash of it in the state. It has no source row and no attendees,
 *    so it can never stand behind a person (PersonGuard reads calendar sources).
 *
 * A new suggestion that shares two content words with an active goal's title
 * asks for that goal's review, as a watched item's change does.
 *
 * Words are PERSONAL. Logs, audit entries, results and errors here carry ids,
 * hashes, days and counts: never a title, a quote or a goal's words.
 */
import { createHash, randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import {
  ChatCandidate,
  SUGGESTIONS_PER_DAY,
  SUGGESTION_ACTION,
  SUGGESTION_ARGS,
  SUGGESTION_CARD_KIND,
  SUGGESTION_MAX_AGE_DAYS,
  SUGGESTION_MAX_DAYS_AHEAD,
  SUGGESTION_TEMPLATE,
  GOAL_REASONS,
  digestOf,
  isChatSuggestion,
  localDay,
  localWallTime,
  resolveTier,
  sharedWords,
  suggestionGoalId,
  suggestionSourceRef,
  suggestionTurnRef,
  type CandidateAnswer,
  type ChatCommitmentArgs,
  type ChatSuggestionAction,
  type GoalProposeArgs,
  type WebAuthnRelyingParty,
} from '@flint/policy';
import type { Db, Tx } from '../db.js';
import type { Bus } from '../bus.js';
import { appendAudit } from '../governance/audit.js';
import { claim } from '../governance/counters.js';
import { CANDIDATES_INTAKE, Refused, activePolicies, claimIn, completeIn, createProposal, type CreateProposal } from '../governance/proposals.js';
import { dbRefused, failureOf, failureReport, schemaSkew, sqlState } from '../dbcodes.js';
import { CHAT_COMMITMENT } from '../world/kinds.js';
import { stateHash } from '../world/mapper.js';
import { failApproved } from './apply.js';
import { GoalFailure, SAY, sanitize } from './errors.js';
import { REVIEW_QUEUE, reviewStanding, reviewsLeft, type ReviewJob } from './review.js';

/** Who files and adds a suggestion: this intake. */
export const CANDIDATES_ACTOR = 'runtime:goals.candidates';
/** How long a suggestion's card waits for Will. */
const CARD_TTL_MINUTES = 7 * 24 * 60;
/** A turn's time may be this far ahead of the runtime's clock (the two share a Mac). */
const CLOCK_SKEW_MS = 5 * 60_000;
/**
 * Does the database hold a goal Flint adds from chat to a signed card, or to a
 * rule Will signed? Asked of the database itself, each time: the guard of the
 * p3_chat_goal_floor migration is on the Goal table, before every insert, and
 * switched on. Never a constant: a runtime ahead of its database (a rollback,
 * a restore of an older backup) must not believe a floor that is not there.
 * While it is absent nothing from chat runs without a card: the intake files a
 * card even under a rule that says ALONE, and `promotion-table --phase p3c` is
 * refused.
 */
export async function chatFloorInDatabase(db: Db | Tx): Promise<boolean> {
  // Both of its triggers, each switched on and running the guard's own function: the check before every insert,
  // and the one after it that records the card's approval as used. (pg_trigger.tgtype: 1 for each row, 2 before,
  // 4 on insert, 64 instead of. Before is 7 of those; after is 5.)
  const [r] = await db.$queryRaw<Array<{ floor: boolean }>>`
    SELECT count(*) = 2 AS floor
    FROM pg_trigger t JOIN pg_proc f ON f.oid = t.tgfoid JOIN pg_namespace n ON n.oid = f.pronamespace
    WHERE t.tgrelid = to_regclass('public."Goal"') AND NOT t.tgisinternal AND t.tgenabled IN ('O', 'A')
      AND n.nspname = 'public' AND f.proname = 'goal_chat_floor'
      AND ((t.tgname = 'Goal_chat_floor' AND (t.tgtype & 71) = 7) OR (t.tgname = 'Goal_chat_floor_bind' AND (t.tgtype & 71) = 5))`;
  return r?.floor === true;
}
/** What the later promotion table says while it is not. */
export const CHAT_FLOOR_SAYS = 'Suggestions from chat stay cards for now: the database does not yet hold a goal Flint adds from chat to a card you signed.';
/** The one action the database lets a signed rule add without a card. */
const ALONE_WITH_FLOOR: ChatSuggestionAction = 'goal.propose';
/** The counter the day's filings are claimed under, per action. */
export const filedCounter = (action: ChatSuggestionAction): string => `${action}:filed`;
/** A triggered review waits this long, as the review tick's do. */
const REVIEW_AFTER_SECONDS = 60;
/** A suggestion is about a goal when it shares this many content words with its title. */
export const RELATED_WORDS = 2;

const DAY_MS = 86_400_000;
const TURN_REF = /^turn:([A-Za-z0-9_-]{1,80})$/;
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

type SuggestionArgs = GoalProposeArgs | ChatCommitmentArgs;

/** A card's args and where each part came from: Will's quote (by turn id), the model's short text and date, the rest made here. */
function cardOf(c: ChatCandidate, sourceRef: string): { args: SuggestionArgs; provenance: CreateProposal['argsProvenance'] } {
  const made = { source: 'template' as const, tainted: false };
  const model = { source: 'model' as const, tainted: false };
  const shared = { quote: c.quote, ...(c.dueOn ? { dueOn: c.dueOn } : {}), saidAt: c.sourceAt, sourceRef };
  const provenance: CreateProposal['argsProvenance'] = {
    quote: { source: 'will', ref: `turn:${c.turnId}`, tainted: false },
    ...(c.dueOn ? { dueOn: model } : {}),
    saidAt: { source: 'event', tainted: false },
    sourceRef: made,
  };
  if (c.kind === 'goal') return { args: { goalId: suggestionGoalId(sourceRef), title: c.text, ...shared }, provenance: { ...provenance, goalId: made, title: model } };
  return { args: { text: c.text, ...shared }, provenance: { ...provenance, text: model } };
}

/**
 * Why a suggestion's card is not one this intake files, or undefined: its
 * origin a chat's, its template and kind its action's, untainted, its args the
 * contract's, its quote Will's by a turn id, and its source the hash of that
 * conversation, that turn and that quote. Checked when it is filed and again
 * when it runs.
 */
export function suggestionCardProblem(
  action: ChatSuggestionAction,
  p: { kind: string; origin: string; templateId?: string | null | undefined; tainted: boolean; args: unknown; argsProvenance: unknown },
): string | undefined {
  const cid = /^chat:([A-Za-z0-9_-]{1,80})$/.exec(p.origin)?.[1];
  if (!cid || p.kind !== SUGGESTION_CARD_KIND[action] || p.templateId !== SUGGESTION_TEMPLATE[action] || p.tainted) return 'the card is not a suggestion from chat';
  const args = SUGGESTION_ARGS[action].safeParse(p.args);
  if (!args.success) return `args: ${args.error.issues.map((i) => `${i.path.join('.') || '<args>'}: ${i.code}`).join('; ').slice(0, 300)}`;
  const quote = (p.argsProvenance as Record<string, { source?: unknown; ref?: unknown; tainted?: unknown } | undefined> | null)?.quote;
  const turn = typeof quote?.ref === 'string' ? TURN_REF.exec(quote.ref)?.[1] : undefined;
  if (!quote || quote.source !== 'will' || quote.tainted !== false || !turn) return 'the quote is not Will’s, by a turn';
  const a = args.data as SuggestionArgs;
  if (a.sourceRef !== suggestionSourceRef(cid, turn, a.quote)) return 'the source is not this conversation, turn and quote';
  if ('goalId' in a && a.goalId !== suggestionGoalId(a.sourceRef)) return 'the goal id is not made from the source';
  return undefined;
}

/** createProposal's check of a suggestion card (through checkGoalCard): the card as this intake files it, with its fixed reason. */
export function checkSuggestionCard(input: CreateProposal): CreateProposal {
  const action = input.action as ChatSuggestionAction;
  const why = suggestionCardProblem(action, input);
  if (why) throw new Refused(400, SAY.suggestionInvalid, why);
  return {
    ...input,
    reason: action === 'goal.propose' ? GOAL_REASONS.propose : GOAL_REASONS.commitment,
    // It asks on its own, with a fresh touch, never in Approve All: what Will does with each one is the evidence
    // the later table rests on, and that must be one decision a card.
    sensitivity: 'personal', destructive: false, consequential: true, ttlMinutes: CARD_TTL_MINUTES,
  };
}

interface ApplyContext {
  now: Date;
  tz: string;
  actor: string;
}
type Applied = { result: Record<string, string | number | boolean> };

/**
 * What a suggestion adds, inside the caller's transaction: a proposed goal, or
 * an unconfirmed commitment. Either one already there (by its id or its source)
 * is left as it is.
 */
export async function applySuggestion(tx: Tx, action: ChatSuggestionAction, args: SuggestionArgs, ctx: ApplyContext): Promise<Applied> {
  if (action === 'goal.propose') {
    const a = args as GoalProposeArgs;
    const there = await tx.goal.findFirst({ where: { OR: [{ id: a.goalId }, { sourceRef: a.sourceRef }] }, select: { id: true } });
    if (there) return { result: { goalId: there.id, existed: true } };
    // The day Flint read, to its end in his zone, while that is still ahead: a goal's date is never in the past.
    const horizon = a.dueOn ? localWallTime(ctx.tz, a.dueOn, 23, 59) : null;
    await tx.goal.create({
      data: {
        id: a.goalId, title: a.title, description: a.quote, owner: 'will', origin: 'flint', sensitivity: 'personal', tainted: false,
        successCriteria: [], reviewCadence: 'P1W', horizonAt: horizon && horizon.getTime() > ctx.now.getTime() + 60_000 ? horizon : null, sourceRef: a.sourceRef,
      },
    });
    return { result: { goalId: a.goalId } };
  }
  const a = args as ChatCommitmentArgs;
  const there = await tx.entity.findUnique({ where: { kind_key: { kind: 'commitment', key: a.sourceRef } }, select: { id: true } });
  if (there) return { result: { entityId: there.id, existed: true } };
  const state = CHAT_COMMITMENT.parse({ source: 'chat', confirmation: 'unconfirmed', ...(a.dueOn ? { dueOn: a.dueOn } : {}), quoteSha256: sha256(a.quote) }) as Record<string, unknown>;
  // A name made of what it is, never of what he said: the words are in EntityText alone.
  const name = `chat commitment${a.dueOn ? ` due ${a.dueOn}` : ''}`;
  const id = `en${ctx.now.getTime().toString(36)}${randomBytes(5).toString('hex')}`;
  await tx.entity.create({
    data: {
      id, kind: 'commitment', key: a.sourceRef, name, state: state as Prisma.InputJsonObject, stateHash: stateHash({ name, state, status: 'active', taintedPaths: [] }),
      status: 'active', sensitivity: 'personal', taintedPaths: [], lastObservedAt: ctx.now,
    },
  });
  await tx.entityVersion.create({
    data: { id: `ev${ctx.now.getTime().toString(36)}${randomBytes(5).toString('hex')}`, entityId: id, version: 1, changeKind: 'created', state: state as Prisma.InputJsonObject, actor: ctx.actor, tainted: false, validFrom: ctx.now },
  });
  // His words, kept apart from the world model and marked as text (the table's rule): gone a week after.
  await tx.entityText.create({ data: { entityId: id, field: 'title', text: a.quote, source: 'chat', tainted: true, observedAt: ctx.now } });
  return { result: { entityId: id } };
}

export interface IntakeDeps {
  db: Db;
  tz: string;
  /** Flint reviews goals (FLINT_PLANNER is on): a suggestion about an active goal then asks for its review. */
  reviews?: boolean;
  /** The bus, once it has started. */
  bus?: () => Pick<Bus, 'boss'> | undefined;
  now?: () => Date;
}

/** Field paths and codes of a refused request: never a value. */
const issuesOf = (issues: ReadonlyArray<{ path: Array<string | number>; code: string }>): string =>
  issues.map((i) => `${i.path.join('.') || '<body>'}: ${i.code}`).join('; ').slice(0, 300);

/** A card that was turned down (rejected by Will, or dismissed), not one set aside because it was made a goal. */
const turnedDown = (card: { status: string; error: string | null } | null): boolean => card?.status === 'rejected' && card.error !== SAY.replaced;

/**
 * Has this suggestion been taken before? By its source: an intake entry in the
 * audit trail, a goal, a commitment, or a card that still holds its args. Or by
 * its turn: once Will turned down a suggestion of this kind from this turn
 * (dismissed it, or rejected its card), nothing more of that kind is taken
 * from that turn, however it is quoted.
 */
async function known(db: Db | Tx, action: ChatSuggestionAction, sourceRef: string, turnRef: string): Promise<boolean> {
  if (await db.auditEntry.findFirst({ where: { correlationId: sourceRef, actor: CANDIDATES_ACTOR }, select: { id: true } })) return true;
  if (await db.goal.findUnique({ where: { sourceRef }, select: { id: true } })) return true;
  if (await db.entity.findUnique({ where: { kind_key: { kind: 'commitment', key: sourceRef } }, select: { id: true } })) return true;
  const [card] = await db.$queryRaw<Array<{ id: string }>>`SELECT id FROM "Proposal" WHERE action = ${action} AND args->>'sourceRef' = ${sourceRef} LIMIT 1`;
  if (card) return true;
  const earlier = await db.auditEntry.findMany({ where: { action, actor: CANDIDATES_ACTOR, inputs: { path: ['turnRef'], equals: turnRef } }, select: { correlationId: true, inputs: true }, take: 50 });
  for (const e of earlier) {
    const pid = (e.inputs as { proposalId?: unknown } | null)?.proposalId;
    if (typeof pid === 'string' && turnedDown(await db.proposal.findUnique({ where: { id: pid }, select: { status: true, error: true } }))) return true;
    if (e.correlationId && (await db.goal.findFirst({ where: { sourceRef: e.correlationId, status: 'rejected' }, select: { id: true } }))) return true;
  }
  return false;
}

/** Thrown inside the intake's transaction to undo its claim: the suggestion turned out to be one it has. */
const KNOWN = Symbol('known');

/**
 * Take one candidate from the server: check it, and file its card. A refusal is
 * a sentence with its reason logged by field and code; nothing of the
 * candidate's words is kept anywhere but the card or the row it becomes.
 */
export async function takeCandidate(d: IntakeDeps, raw: unknown): Promise<CandidateAnswer> {
  const { db, tz } = d;
  const now = d.now?.() ?? new Date();
  const parsed = ChatCandidate.safeParse(raw);
  if (!parsed.success) throw new Refused(400, SAY.suggestionInvalid, issuesOf(parsed.error.issues));
  const c = parsed.data;
  const at = Date.parse(c.sourceAt);
  if (at > now.getTime() + CLOCK_SKEW_MS) throw new Refused(400, SAY.suggestionInvalid, 'sourceAt: in the future');
  if (at < now.getTime() - SUGGESTION_MAX_AGE_DAYS * DAY_MS) throw new Refused(400, SAY.suggestionStale);
  if (c.dueOn) {
    const today = localDay(tz, now);
    if (c.dueOn < today) throw new Refused(400, SAY.suggestionInvalid, 'dueOn: past');
    if (Date.parse(`${c.dueOn}T00:00:00.000Z`) > now.getTime() + SUGGESTION_MAX_DAYS_AHEAD * DAY_MS) throw new Refused(400, SAY.suggestionInvalid, 'dueOn: too far ahead');
  }
  const action = SUGGESTION_ACTION[c.kind];
  const sourceRef = suggestionSourceRef(c.conversationId, c.turnId, c.quote);
  const turnRef = suggestionTurnRef(c.conversationId, c.turnId, c.kind);

  const decision = resolveTier(action, { context: 'chat', tainted: false, sensitivity: 'personal', policies: await activePolicies(db, now), now });
  const origin = `chat:${c.conversationId}`;
  const { args, provenance } = cardOf(c, sourceRef);
  const subject = 'goalId' in args ? { goalId: args.goalId } : {};
  if (decision.tier === 'forbidden') {
    // Written outside the transaction below: a refusal is recorded whatever else happens. (One already known is not recorded twice.)
    if (await known(db, action, sourceRef, turnRef)) return { outcome: 'known' };
    await appendAudit(db, [{
      actor: CANDIDATES_ACTOR, context: 'chat', kind: 'decision', action, tier: 'forbidden', decision: 'deny', outcome: 'denied',
      inputs: { sourceRef, turnRef, rule: decision.rule }, reasoning: decision.reason, correlationId: sourceRef, tainted: false,
    }], now);
    throw new Refused(409, `forbidden: ${decision.reason}`);
  }
  // ALONE only for a goal, and only while the database itself holds a goal from chat to a signed card or rule
  // (asked of the database now, never assumed): otherwise a card, whatever a rule says.
  const wantsAlone = decision.tier === 'alone' && action === ALONE_WITH_FLOOR && (await chatFloorInDatabase(db));

  const attempt = (alone: boolean): Promise<CandidateAnswer['outcome']> =>
    db.$transaction(async (tx) => {
      // One at a time for a source: a second identical post waits here, then finds the first one's card.
      await tx.$queryRaw`SELECT 1 FROM (SELECT pg_advisory_xact_lock(hashtext(${`suggestion:${sourceRef}`}))) AS l`;
      if (await known(tx, action, sourceRef, turnRef)) return 'known' as const;
      // The day's limit, in either tier: at most this many cards wait on Will, and no more are added without him.
      // Claimed in this transaction: another post of the same kind waits on the counter's row, and a card that
      // cannot be filed gives its slot back.
      if ((await claim(tx, filedCounter(action), { limit: SUGGESTIONS_PER_DAY[action], period: 'day' }, tz, now)) === null) throw new Refused(429, SAY.suggestionCap);
      if (!alone) {
        const filed = await createProposal(db, {
          kind: SUGGESTION_CARD_KIND[action], origin, action, templateId: SUGGESTION_TEMPLATE[action], args: args as Record<string, unknown>, argsProvenance: provenance,
          tainted: false, sensitivity: 'personal', destructive: false, consequential: true, ttlMinutes: CARD_TTL_MINUTES,
        }, CANDIDATES_ACTOR, now, CANDIDATES_INTAKE, tx);
        if (filed.deduped) throw KNOWN;
        await appendAudit(tx, [{
          actor: CANDIDATES_ACTOR, context: 'chat', kind: 'decision', action, tier: 'approval', decision: 'log', outcome: 'ok',
          inputs: { sourceRef, turnRef, proposalId: filed.id, saidAt: c.sourceAt, ...subject }, correlationId: sourceRef, tainted: false,
        }], now);
        return 'filed' as const;
      }
      // ALONE: only under a rule Will signed. Its cap is claimed with the write.
      if (decision.cap && (await claim(tx, decision.key, decision.cap, tz, now)) === null) throw new Refused(429, SAY.suggestionCap);
      // On record first. The database lets the goal in only with this entry there, and only if the digest it
      // carries is the digest of what the row then holds (its title, the quote, when he said it, the day).
      await appendAudit(tx, [{
        actor: CANDIDATES_ACTOR, context: 'chat', kind: 'action', action, tier: 'alone', decision: 'act', outcome: 'ok',
        inputs: {
          sourceRef, turnRef, saidAt: c.sourceAt, ...(c.dueOn ? { dueOn: c.dueOn } : {}), argsDigest: digestOf(args), rule: decision.rule,
          ...(decision.policyPattern ? { policy: decision.policyPattern } : {}), ...subject,
        },
        correlationId: sourceRef, tainted: false,
      }], now);
      const r = await applySuggestion(tx, action, args, { now, tz, actor: CANDIDATES_ACTOR });
      if (r.result.existed === true) throw KNOWN;
      return 'added' as const;
    }, { maxWait: 10_000, timeout: 30_000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });

  let outcome: CandidateAnswer['outcome'];
  try {
    try {
      outcome = await attempt(wantsAlone);
    } catch (err) {
      // The database has the last word. It refused the add (the rule ended between the decision and the write,
      // or it reads a row more strictly than the code did): nothing was written, and the suggestion is a card.
      if (!wantsAlone || err === KNOWN || err instanceof Refused || sqlState(err) !== '42501') throw err;
      console.error(`[goals] the database let no suggestion in without a card (${failureReport(err)}): filed as a card`);
      outcome = await attempt(false);
    }
  } catch (err) {
    if (err === KNOWN) return { outcome: 'known' };
    if (err instanceof Refused) throw err;
    // Two of the same at once past the lock (a unique key refused this one): the other one made it.
    if (sqlState(err) === '23505' || (err as { code?: unknown }).code === 'P2002') return { outcome: 'known' };
    throw sanitize(err);
  }
  if (outcome !== 'known') await askReviews(d, c, sourceRef, now).catch(() => {});
  return { outcome };
}

/**
 * A new suggestion about an active goal (two content words of its title, in the
 * suggestion's short text or Will's quote) asks for that goal's review, set off
 * by `chat:<source>`: once per goal, within its 12 triggered reviews a day, and
 * only while Flint reviews goals. The review claims its own slot when it runs.
 */
export async function askReviews(d: IntakeDeps, c: Pick<ChatCandidate, 'text' | 'quote'>, sourceRef: string, now: Date): Promise<number> {
  const bus = d.bus?.();
  if (!d.reviews || !bus) return 0;
  if (!(await reviewStanding(d.db, now)).may) return 0;
  const goals = await d.db.goal.findMany({ where: { status: 'active' }, select: { id: true, title: true }, orderBy: { createdAt: 'asc' }, take: 200 });
  const said = `${c.text} ${c.quote}`;
  let sent = 0;
  for (const g of goals) {
    if (sharedWords(g.title, said) < RELATED_WORDS) continue;
    if (!(await reviewsLeft(d.db, g.id, d.tz, now))) continue;
    const job: ReviewJob = { goalId: g.id, kind: 'triggered', triggerEventId: sourceRef };
    if (await bus.boss.send(REVIEW_QUEUE, job, { singletonKey: g.id, startAfter: REVIEW_AFTER_SECONDS })) sent += 1;
  }
  return sent;
}

/**
 * Claim, apply and complete one approved suggestion card, in one transaction.
 * A card that is not what this intake files (its origin, template, args or
 * source) fails with a sentence and adds nothing.
 */
export async function runSuggestion(db: Db, id: string, rp: WebAuthnRelyingParty | undefined, tz: string, actor: string) {
  const now = new Date();
  let out: { refused: Refused } | { done: Record<string, string | number | boolean> };
  try {
    out = await db.$transaction(
      async (tx) => {
        const c = await claimIn(tx, id, rp, tz, actor, now);
        if ('refused' in c) return c;
        const action = c.claimed.action;
        const p = await tx.proposal.findUniqueOrThrow({ where: { id }, select: { kind: true, origin: true, templateId: true, tainted: true, argsProvenance: true } });
        const why = isChatSuggestion(action) ? suggestionCardProblem(action, { ...p, args: c.claimed.args }) : 'not a suggestion from chat';
        if (why || !isChatSuggestion(action)) {
          await completeIn(tx, id, { ok: false, error: SAY.suggestionMoved }, actor, now);
          return { refused: new Refused(409, SAY.suggestionMoved, why) };
        }
        const r = await applySuggestion(tx, action, SUGGESTION_ARGS[action].parse(c.claimed.args) as SuggestionArgs, { now, tz, actor });
        await completeIn(tx, id, { ok: true, result: r.result }, actor, now);
        return { done: r.result };
      },
      { maxWait: 10_000, timeout: 30_000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
  } catch (err) {
    throw sanitize(err);
  }
  if ('refused' in out) throw out.refused;
  return out.done;
}

/**
 * runInternal's branch for a suggestion card: runSuggestion and, when it fails
 * other than by a refusal, a log line with a reference and the failure's class
 * and SQLSTATE (never its message). When the database refused the write itself
 * the card fails, saying so with the reference only; after anything else it
 * stays approved, to run again.
 */
export async function runSuggestionCard(db: Db, id: string, rp: WebAuthnRelyingParty | undefined, tz: string, actor: string) {
  try {
    return await runSuggestion(db, id, rp, tz, actor);
  } catch (err) {
    if (err instanceof Refused) throw err;
    const ref = `err${Date.now().toString(36)}`;
    console.error(`[runtime] ${ref} running proposal ${id} failed: ${failureReport(err)}`);
    const state = err instanceof GoalFailure ? err.code : sqlState(err);
    if (state && /^(22|23|42|P0)/.test(state) && !schemaSkew(state)) await failApproved(db, id, `could not carry it out (${ref})`, failureOf(err), actor).catch(() => {});
    if (dbRefused(err)) throw new Refused(400, 'The database refused this change.');
    throw new Refused(409, 'Flint couldn’t carry it out.');
  }
}

/**
 * The waiting card of a suggested goal that is not a goal row yet: pending, not
 * expired, naming this goal id. With `lock`, taken FOR UPDATE (Make It a Goal
 * and an approval of the card itself then run one after the other).
 */
export async function waitingSuggestion(db: Db | Tx, goalId: string, now: Date, lock = false): Promise<{ id: string; sourceRef: string } | null> {
  // (Under the intake's lock a source has one card; were there ever more, each call names the oldest still waiting.)
  const rows = lock
    ? await db.$queryRaw<Array<{ id: string; sourceRef: string | null }>>`
        SELECT id, args->>'sourceRef' AS "sourceRef" FROM "Proposal"
        WHERE action = 'goal.propose' AND status = 'pending' AND "expiresAt" > ${now} AND args->>'goalId' = ${goalId} ORDER BY "createdAt" ASC LIMIT 1 FOR UPDATE`
    : await db.$queryRaw<Array<{ id: string; sourceRef: string | null }>>`
        SELECT id, args->>'sourceRef' AS "sourceRef" FROM "Proposal"
        WHERE action = 'goal.propose' AND status = 'pending' AND "expiresAt" > ${now} AND args->>'goalId' = ${goalId} ORDER BY "createdAt" ASC LIMIT 1`;
  const r = rows[0];
  return r && typeof r.sourceRef === 'string' && /^chat:[0-9a-f]{64}$/.test(r.sourceRef) && suggestionGoalId(r.sourceRef) === goalId ? { id: r.id, sourceRef: r.sourceRef } : null;
}
