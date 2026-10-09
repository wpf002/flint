/**
 * Goals and plans, carried out (Machine plan P3): the six actions only Will's
 * signature takes (goal.activate, goal.criteria_change, goal.horizon_change,
 * goal.done, goal.abandon, plan.change). A card is:
 *  - checked when it is filed (checkGoalCard): its args against the shared
 *    contract, normalized so what Will signs is what the database compares;
 *    its goal's state; its items; and, for a plan change, each operation's
 *    precondition against the plan as it stands. It is PERSONAL, and its
 *    reason is a fixed sentence. One that could not apply is never filed.
 *  - carried out in ONE transaction (runGoal): the claim (signature checked
 *    again, tier, intent), the guarded writes under flint.actor
 *    `will:approval:<id>`, and the card's completion. A crash anywhere leaves
 *    nothing applied and the card approved, never a change made under a card
 *    whose outcome is unknown.
 * The database checks every write against the executing card it names
 * (migration p3_goals); the checks here come first so that Will reads a
 * sentence, not a refusal. Results, audit entries and errors carry ids and
 * counts, never a goal's words.
 */
import { Prisma } from '@prisma/client';
import {
  GOAL_ARGS,
  GOAL_KIND,
  GOAL_REASONS,
  checkFits,
  composePlan,
  digestOf,
  isGoalSignedAction,
  localDay,
  nextReviewAt,
  type Criterion,
  type GoalArgs,
  type GoalSignedAction,
  type Link,
  type WebAuthnRelyingParty,
} from '@flint/policy';
import type { z } from 'zod';
import type { Db, Tx } from '../db.js';
import { appendAudit } from '../governance/audit.js';
import { Refused, claimIn, completeIn, contextOf, type CreateProposal } from '../governance/proposals.js';
import { dbRefused, failureOf, failureReport, schemaSkew, sqlState } from '../dbcodes.js';
import { GoalFailure, SAY, goalStatusWords, sanitize } from './errors.js';
import { RATIONALE, activePlan, currentLinks, lastVersion, sameDefinition, sameLinks, sameTiming, syncLinks, writeDraft } from './ops.js';

/** The templates a review files its plan cards under (Proposal_template_check needs one for a runtime origin). */
export const PLAN_TEMPLATES: readonly string[] = ['plan.diff.minor', 'plan.diff.material'];
/** Where a review's cards come from. */
export const GOALS_ORIGIN = 'runtime:goals';

type ActivateArgs = GoalArgs<'goal.activate'>;
type CriteriaArgs = GoalArgs<'goal.criteria_change'>;
type TimingArgs = GoalArgs<'goal.horizon_change'>;
type FinishArgs = GoalArgs<'goal.done'>;
type PlanArgs = GoalArgs<'plan.change'>;

/** A provenance ref on a goal card is an id: a proposal's provenance is kept for good, so it never holds words. */
const PROVENANCE_REF = /^[A-Za-z0-9_.:@-]{1,120}$/;

/** A zod error as paths and codes (a message of ours, never a value): it is logged under a ref, not shown. */
function issuesOf(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join('.') || '<args>'}: ${i.code === 'custom' ? i.message : i.code}`).join('; ').slice(0, 500);
}

/** The items a card links, as they are now: all there, none a person, and every item check one Flint can make of its kind. */
async function itemProblem(db: Db | Tx, links: readonly Link[], criteria: readonly Criterion[]): Promise<string | undefined> {
  const ids = links.map((l) => l.entityId);
  const found = ids.length ? await db.entity.findMany({ where: { id: { in: ids } }, select: { id: true, kind: true, status: true } }) : [];
  if (found.length !== ids.length || found.some((e) => e.status === 'forgotten')) return SAY.itemGone;
  if (found.some((e) => e.kind === 'person')) return SAY.person;
  for (const c of criteria) {
    if (c.check.kind !== 'item') continue;
    const { entityId, key, value } = c.check;
    const kind = found.find((e) => e.id === entityId)?.kind;
    if (!kind || !checkFits(kind, key, value)) return SAY.checkItem;
  }
  return undefined;
}

/** A steps check names steps of this plan. */
function stepsKnown(criteria: readonly Criterion[], keys: ReadonlySet<string>): boolean {
  return criteria.every((c) => c.check.kind !== 'steps' || c.check.keys.every((k) => keys.has(k)));
}

const COMPOSE_SAYS = { exists: SAY.exists, missing: SAY.missing, done: SAY.stepDone, depends: SAY.depends, circle: SAY.circle } as const;

/**
 * A goal card as it may be filed, or a refusal (400 for what it says, 409 for
 * where the goal stands). Also gives chat's goal and commitment suggestions
 * (P3 part 5) their kind check and fixed reason; the database holds them to
 * Will's quote.
 */
export async function checkGoalCard(db: Db, input: CreateProposal, now = new Date()): Promise<CreateProposal> {
  const { action } = input;
  if (action === 'goal.propose' || action === 'world.commitment.from_chat') {
    const kind = action === 'goal.propose' ? 'goal' : 'tool_call';
    if (input.kind !== kind) throw new Refused(400, action === 'goal.propose' ? SAY.kindGoal : 'A commitment from chat is filed as kind tool_call.');
    return { ...input, reason: action === 'goal.propose' ? GOAL_REASONS.propose : GOAL_REASONS.commitment, sensitivity: 'personal' };
  }
  if (!isGoalSignedAction(action)) return input;
  if (input.kind !== GOAL_KIND[action]) throw new Refused(400, GOAL_KIND[action] === 'plan' ? SAY.kindPlan : SAY.kindGoal);
  if (Object.values(input.argsProvenance).some((p) => p.ref !== undefined && !PROVENANCE_REF.test(p.ref))) throw new Refused(400, SAY.provenance);
  const context = contextOf(input.origin);
  if (context === 'chat') throw new Refused(409, SAY.fromConsole);
  // A job may ask for plan.change alone: the tier engine refuses any other (FORBIDDEN, autonomous), and audits it.
  if (context === 'autonomous' && action !== 'plan.change') return input;
  // A review files its plan cards under its own templates; Will's cards carry none.
  const template = context === 'autonomous' ? input.origin === GOALS_ORIGIN && PLAN_TEMPLATES.includes(input.templateId ?? '') : input.templateId === undefined;
  if (!template) throw new Refused(400, SAY.template);
  const parsed = GOAL_ARGS[action].safeParse(input.args);
  if (!parsed.success) throw new Refused(400, SAY.invalid, issuesOf(parsed.error));
  const args = parsed.data as { goalId: string };
  const goal = await db.goal.findUnique({ where: { id: args.goalId } });
  const live = (g: typeof goal): NonNullable<typeof goal> => {
    if (!g) throw new Refused(409, SAY.noGoal);
    if (g.status !== 'active' && g.status !== 'paused') throw new Refused(409, goalStatusWords(g.status));
    return g;
  };
  const titled = (g: NonNullable<typeof goal>, goalTitle: string) => {
    if (g.title !== goalTitle) throw new Refused(409, SAY.looked);
  };
  const items = async (links: readonly Link[], criteria: readonly Criterion[]) => {
    const why = await itemProblem(db, links, criteria);
    if (why) throw new Refused(400, why);
  };
  let reason: string = GOAL_REASONS.start;

  if (action === 'goal.activate') {
    const a = args as ActivateArgs;
    if (goal?.status === 'paused') {
      if (a.plan) throw new Refused(400, SAY.resumePlan);
      if (!sameDefinition(goal, a) || !sameTiming(goal, a) || !sameLinks(await currentLinks(db, goal.id), a.links)) throw new Refused(409, SAY.looked);
      const plan = await activePlan(db, goal.id);
      if (!stepsKnown(a.successCriteria, new Set(plan?.steps.map((s) => s.key)))) throw new Refused(400, SAY.checkStep);
      reason = GOAL_REASONS.resume;
    } else {
      if (goal && goal.status !== 'proposed') throw new Refused(409, goalStatusWords(goal.status));
      if (a.horizonAt && Date.parse(a.horizonAt) <= now.getTime()) throw new Refused(400, SAY.future);
      if (!stepsKnown(a.successCriteria, new Set(a.plan?.ops.map((o) => o.key)))) throw new Refused(400, SAY.checkStep);
    }
    await items(a.links, a.successCriteria);
  } else if (action === 'goal.criteria_change') {
    const a = args as CriteriaArgs;
    const g = live(goal);
    if (sameDefinition(g, a) && sameLinks(await currentLinks(db, g.id), a.links)) throw new Refused(400, SAY.nothing);
    await items(a.links, a.successCriteria);
    const plan = await activePlan(db, g.id);
    if (!stepsKnown(a.successCriteria, new Set(plan?.steps.map((s) => s.key)))) throw new Refused(400, SAY.checkStep);
    reason = GOAL_REASONS.criteria;
  } else if (action === 'goal.horizon_change') {
    const a = args as TimingArgs;
    const g = live(goal);
    titled(g, a.goalTitle);
    if (sameTiming(g, a)) throw new Refused(400, SAY.nothing);
    if (a.horizonAt && Date.parse(a.horizonAt) <= now.getTime()) throw new Refused(400, SAY.future);
    reason = GOAL_REASONS.timing;
  } else if (action === 'goal.done' || action === 'goal.abandon') {
    titled(live(goal), (args as FinishArgs).goalTitle);
    reason = action === 'goal.done' ? GOAL_REASONS.done : GOAL_REASONS.abandon;
  } else {
    const a = args as PlanArgs;
    const g = live(goal);
    titled(g, a.goalTitle);
    const c = composePlan((await activePlan(db, g.id))?.steps ?? [], a.ops);
    if (!c.ok) throw c.why === 'stale' ? new Refused(409, SAY.planLooked) : new Refused(400, COMPOSE_SAYS[c.why]);
    reason = context === 'autonomous' ? GOAL_REASONS.planFlint : GOAL_REASONS.planWill;
  }
  return {
    ...input,
    args: parsed.data as Record<string, unknown>,
    reason,
    sensitivity: 'personal',
    // Marked for Will's fresh touch: every goal card, and every plan card but a review's minor ones (part 3
    // says which). Nothing reads the mark yet: the console must (a README requirement for the goals panel).
    consequential: action === 'plan.change' ? input.consequential || context !== 'autonomous' : true,
  };
}

interface ApplyContext {
  approvalId: string;
  /** What Will signed: the stored args' digest. */
  argsDigest: string;
  origin: string;
  now: Date;
  tz: string;
}
type Applied = { result: Record<string, string | number | boolean> } | { refusal: string };

/** The goal row, locked for this transaction (a review, a tick and another card wait), or null. */
async function lockGoal(tx: Tx, id: string) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "Goal" WHERE id = ${id} FOR UPDATE`;
  return rows.length ? tx.goal.findUniqueOrThrow({ where: { id } }) : null;
}

/**
 * Will's marks that still mean what he marked: a mark stays only while the check
 * under its id is the same check (its words and what it looks at). An id reused
 * for a new check starts unmarked.
 */
function keptMarks(marks: Prisma.JsonValue, before: Prisma.JsonValue, after: readonly Criterion[]): Record<string, string> {
  const was = new Map(((before ?? []) as Criterion[]).map((c) => [c.id, digestOf({ text: c.text, check: c.check })]));
  const now = new Map(after.map((c) => [c.id, digestOf({ text: c.text, check: c.check })]));
  return Object.fromEntries(Object.entries((marks ?? {}) as Record<string, string>).filter(([id]) => now.has(id) && was.get(id) === now.get(id)));
}

const json = (v: unknown) => v as Prisma.InputJsonValue;

/** One signed card's change, inside the caller's transaction. A refusal is returned before anything is written. */
export async function applyGoal(tx: Tx, action: GoalSignedAction, raw: unknown, ctx: ApplyContext): Promise<Applied> {
  // The args as signed, read again with the shared contract. Normalizing them again must change nothing: what
  // is written is what Will signed, or nothing is (a contract that changed between filing and running).
  const parsed = GOAL_ARGS[action].safeParse(raw);
  if (!parsed.success || digestOf(parsed.data) !== ctx.argsDigest) return { refusal: SAY.reshaped };
  const args = parsed.data as { goalId: string };
  const { approvalId, now } = ctx;
  const goal = await lockGoal(tx, args.goalId);

  if (action === 'goal.activate') {
    const a = args as ActivateArgs;
    if (goal?.status === 'paused') {
      // Resuming changes nothing else (the database refuses it otherwise): what the card shows is what there is.
      if (a.plan || !sameDefinition(goal, a) || !sameTiming(goal, a) || !sameLinks(await currentLinks(tx, goal.id), a.links)) return { refusal: SAY.goalChanged };
      await tx.goal.update({ where: { id: goal.id }, data: { status: 'active', approvalId, nextReviewAt: now } });
      return { result: { goalId: goal.id, resumed: true } };
    }
    if (goal && goal.status !== 'proposed') return { refusal: goalStatusWords(goal.status) };
    // Every check before the first write: a refusal commits the card's failure, and nothing else.
    const why = await itemProblem(tx, a.links, a.successCriteria);
    if (why) return { refusal: why };
    if (a.horizonAt && new Date(a.horizonAt) <= (goal?.createdAt ?? now)) return { refusal: SAY.passed };
    const first = a.plan ? composePlan([], a.plan.ops) : undefined;
    if (first && !first.ok) return { refusal: SAY.invalid };
    const g = goal ?? (await tx.goal.create({
      data: {
        id: a.goalId, title: a.title, description: a.description, owner: 'will', origin: 'will', successCriteria: json(a.successCriteria),
        horizonAt: a.horizonAt ? new Date(a.horizonAt) : null, reviewCadence: a.reviewCadence,
      },
    }));
    // Links and the first plan while it is still proposed (the database lets goal.activate bring them only then), then the goal.
    const links = await syncLinks(tx, g.id, a.links);
    let steps = 0;
    let planId: string | undefined;
    if (first?.ok) {
      planId = await writeDraft(tx, g.id, 1, first.steps, 'will', RATIONALE.first);
      await tx.plan.update({ where: { id: planId }, data: { status: 'active', approvalId } });
      steps = first.steps.length;
    }
    await tx.goal.update({
      where: { id: g.id },
      data: {
        status: 'active', approvalId, title: a.title, description: a.description, successCriteria: json(a.successCriteria),
        horizonAt: a.horizonAt ? new Date(a.horizonAt) : null, reviewCadence: a.reviewCadence, criteriaMet: json(keptMarks(g.criteriaMet, g.successCriteria, a.successCriteria)),
        // The first review runs within minutes of starting (once reviews are on).
        nextReviewAt: now,
      },
    });
    return { result: { goalId: g.id, links: a.links.length, linksAdded: links.added, steps, ...(planId ? { planId } : {}) } };
  }

  if (!goal) return { refusal: SAY.noGoal };
  if (goal.status !== 'active' && goal.status !== 'paused') return { refusal: goalStatusWords(goal.status) };

  if (action === 'goal.criteria_change') {
    const a = args as CriteriaArgs;
    const why = await itemProblem(tx, a.links, a.successCriteria);
    if (why) return { refusal: why };
    const links = await syncLinks(tx, goal.id, a.links);
    const marks = keptMarks(goal.criteriaMet, goal.successCriteria, a.successCriteria);
    const changed = !sameDefinition(goal, a);
    // A change to the links alone moves no approval onto the goal (the database lets them in on this card).
    if (changed) {
      await tx.goal.update({ where: { id: goal.id }, data: { title: a.title, description: a.description, successCriteria: json(a.successCriteria), criteriaMet: json(marks), approvalId } });
    }
    const cleared = Object.keys((goal.criteriaMet ?? {}) as object).length - Object.keys(marks).length;
    return { result: { goalId: goal.id, criteria: a.successCriteria.length, linksAdded: links.added, linksRemoved: links.removed, marksCleared: changed ? cleared : 0 } };
  }

  if (action === 'goal.horizon_change') {
    const a = args as TimingArgs;
    if (sameTiming(goal, a)) return { result: { goalId: goal.id, unchanged: true } };
    if (a.horizonAt && new Date(a.horizonAt) <= goal.createdAt) return { refusal: SAY.passed };
    // A shorter cadence brings the next review forward: the earlier of the one already set and the new cadence's next slot.
    let next = goal.nextReviewAt;
    if (goal.status === 'active' && a.reviewCadence !== goal.reviewCadence) {
      // Monthly reviews keep the goal's own day of the month, from when it started.
      const anchor = Number(localDay(ctx.tz, goal.activatedAt ?? goal.createdAt).slice(8, 10));
      const slot = nextReviewAt(a.reviewCadence, ctx.tz, now, now, anchor);
      next = next && next < slot ? next : slot;
    }
    await tx.goal.update({
      where: { id: goal.id },
      data: { horizonAt: a.horizonAt ? new Date(a.horizonAt) : null, reviewCadence: a.reviewCadence, approvalId, nextReviewAt: next },
    });
    return { result: { goalId: goal.id, reviewMoved: (next?.getTime() ?? null) !== (goal.nextReviewAt?.getTime() ?? null) } };
  }

  if (action === 'goal.done' || action === 'goal.abandon') {
    const done = action === 'goal.done';
    await tx.goal.update({ where: { id: goal.id }, data: { status: done ? 'done' : 'abandoned', approvalId } });
    // Its forecasts, open or superseded, resolve now, as Will: done comes true if it was done by that
    // forecast's own date; abandoned is false. The event is this moment; the evidence ids only.
    const resolved = await tx.$executeRaw`
      INSERT INTO "Resolution" (id, "predictionId", outcome, "eventAt", "resolvedBy", evidence)
      SELECT 'rs' || replace(gen_random_uuid()::text, '-', ''), p.id, ${done}::boolean AND t.at <= p."resolveBy", t.at, 'will',
             jsonb_build_object('goalId', p."goalId", 'approvalId', ${approvalId}::text, 'via', ${action}::text)
      FROM "Prediction" p CROSS JOIN (SELECT clock_timestamp() AS at) t
      WHERE p."goalId" = ${goal.id} AND p.status IN ('open', 'superseded') AND p.kind = 'binary'
        AND NOT EXISTS (SELECT 1 FROM "Resolution" r WHERE r."predictionId" = p.id)`;
    return { result: { goalId: goal.id, predictionsResolved: resolved } };
  }

  // plan.change: lock the active version (a step tick waiting on it is then refused), check every
  // precondition, write the next version as a draft, supersede the old one, activate the new one.
  const a = args as PlanArgs;
  const cur = await activePlan(tx, goal.id, true);
  const next = composePlan(cur?.steps ?? [], a.ops);
  if (!next.ok) return { refusal: ctx.origin.startsWith('runtime:') ? SAY.staleFlint : SAY.staleWill };
  const version = (await lastVersion(tx, goal.id)) + 1;
  const flint = ctx.origin.startsWith('runtime:');
  const planId = await writeDraft(tx, goal.id, version, next.steps, flint ? 'flint' : 'will', flint ? RATIONALE.flint : RATIONALE.will);
  if (cur) await tx.plan.update({ where: { id: cur.id }, data: { status: 'superseded' } });
  await tx.plan.update({ where: { id: planId }, data: { status: 'active', approvalId } });
  return { result: { goalId: goal.id, planId, version, steps: next.steps.length, ops: a.ops.length } };
}

/** Test seams: a fault injected after the writes, before the card completes. */
export interface GoalHooks {
  afterWrites?: (tx: Tx) => Promise<void>;
}

/**
 * Claim, apply and complete one approved goal card, in one transaction. A
 * refusal (the signature no longer verifies, the goal moved on, the plan
 * changed) fails the card with a sentence; any other error rolls everything
 * back, leaving the card approved, and is rethrown as its class and SQLSTATE.
 */
export async function runGoal(db: Db, id: string, rp: WebAuthnRelyingParty | undefined, tz: string, actor: string, hooks: GoalHooks = {}) {
  const now = new Date();
  let out: { refused: Refused } | { done: Record<string, string | number | boolean> };
  try {
    out = await db.$transaction(
      async (tx) => {
        const c = await claimIn(tx, id, rp, tz, actor, now);
        if ('refused' in c) return c;
        const p = await tx.proposal.findUniqueOrThrow({ where: { id }, select: { approvalId: true, origin: true, templateId: true } });
        // Only Will's own cards from the console, or a review's under its templates (the :95 pattern: a foreign
        // template is refused). A card from chat never runs, however it was filed.
        const context = contextOf(p.origin);
        const template = context === 'autonomous'
          ? c.claimed.action === 'plan.change' && p.origin === GOALS_ORIGIN && PLAN_TEMPLATES.includes(p.templateId ?? '')
          : p.templateId === null;
        const r = context === 'chat'
          ? ({ refusal: SAY.fromConsole } as const)
          : template
            ? await (async () => {
                await tx.$queryRaw`SELECT set_config('flint.actor', ${`will:approval:${p.approvalId}`}, true)`;
                return applyGoal(tx, c.claimed.action as GoalSignedAction, c.claimed.args, { approvalId: p.approvalId!, argsDigest: c.claimed.argsDigest, origin: p.origin, now, tz });
              })()
            : ({ refusal: SAY.template } as const);
        if ('refusal' in r) {
          await completeIn(tx, id, { ok: false, error: r.refusal }, actor, now);
          return { refused: new Refused(409, r.refusal) };
        }
        await hooks.afterWrites?.(tx);
        await completeIn(tx, id, { ok: true, result: r.result }, actor, now);
        return { done: r.result };
      },
      { maxWait: 10_000, timeout: 30_000 },
    );
  } catch (err) {
    throw sanitize(err);
  }
  if ('refused' in out) throw out.refused;
  return out.done;
}

/** A card whose transaction rolled back is still approved: it fails now, saying so with a reference only. */
async function failApproved(db: Db, id: string, error: string, failure: string, actor: string): Promise<void> {
  await db.$transaction(async (tx) => {
    const p = await tx.proposal.findUnique({ where: { id } });
    if (!p || p.status !== 'approved') return;
    await tx.proposal.update({ where: { id }, data: { status: 'failed', error, executedAt: new Date() } });
    await appendAudit(tx, [{
      actor, context: contextOf(p.origin), kind: 'action', action: p.action, decision: 'act', outcome: 'failed',
      inputs: { proposalId: id, argsDigest: p.argsDigest, failure: failure.slice(0, 200) }, correlationId: id, tainted: p.tainted,
    }]);
  });
}

/**
 * runInternal's goal branch: runGoal and, when it fails other than by a
 * refusal, a log line with a reference, the failure's class, SQLSTATE and
 * constraint, and its top frames (never its message). Nothing was applied. When
 * the database refused the change itself (a data, integrity, privilege or rule
 * error: running it again would only be refused again), the card fails, saying
 * so with the reference only. After anything else it stays approved, to run
 * again: a lost connection, a conflict, a crash, or a schema the code does not
 * expect yet (a deploy out of order, which the next deploy clears).
 */
export async function runGoalCard(db: Db, id: string, rp: WebAuthnRelyingParty | undefined, tz: string, actor: string, hooks: GoalHooks = {}) {
  try {
    return await runGoal(db, id, rp, tz, actor, hooks);
  } catch (err) {
    if (err instanceof Refused) throw err;
    const ref = `err${Date.now().toString(36)}`;
    const failure = failureOf(err);
    console.error(`[runtime] ${ref} running proposal ${id} failed: ${failureReport(err)}`);
    const state = err instanceof GoalFailure ? err.code : sqlState(err);
    if (state && /^(22|23|42|P0)/.test(state) && !schemaSkew(state)) await failApproved(db, id, `could not carry it out (${ref})`, failure, actor).catch(() => {});
    // The database refusing what was signed is the input's fault (a CHECK, 23514).
    if (dbRefused(err)) throw new Refused(400, 'The database refused this change.');
    throw new Refused(409, 'Flint couldn’t carry it out.');
  }
}
