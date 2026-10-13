/**
 * Actions the runtime carries out itself once Will has approved them: turning a
 * source on, applying a signed policy change, adding a triage rule, writing a
 * proposed link, creating the people on a calendar card (P2.5), changing a
 * goal or its plan (P3), turning predictions on (P4), and the seven asset and
 * task cards (P5). Each goes through claimProposal (re-verification, tier, cap,
 * intent) and then completes, so the audit trail reads the same as any other
 * approved action; a goal card, the predictions card and a task card do all
 * three in one transaction (goals/apply.ts, predict/enable.ts, tasks/card.ts).
 * The database checks the effect too: a cursor turns on only under an executing
 * enable proposal, a policy row must appear in the signed proposal, a row that
 * holds an action back goes off only when the executing card names it
 * (action_policy_off_guard), a goal moves only as its executing card says, a
 * number is forecast only as the executing card's signed list says, and an
 * asset turns on, and a task goes out or is accepted, only as its executing
 * card says.
 */
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { CHAT_SUGGESTION_ACTIONS, GOAL_SIGNED_ACTIONS, POLICY_CHANGE_SHAPE, SOURCES, TASK_SIGNED_ACTIONS, coversPolicyChange, isChatSuggestion, isGoalSignedAction, isTaskSignedAction, policyChangeKind, type WebAuthnRelyingParty } from '@flint/policy';
import { runForecastCard } from '../predict/enable.js';
import type { Db } from '../db.js';
import { GONE, Refused, claimProposal, completeProposal, createProposal } from './proposals.js';
import { dbRefused, failureReport, sqlState } from '../dbcodes.js';
import { RuleArgs, ruleProblems } from '../triage/rules.js';
import { ACTION_TEMPLATES } from '../templates/actions.js';
import { TEMPLATE as PERSON_TEMPLATE, createPeople } from '../world/person-create.js';
import { runGoalCard } from '../goals/apply.js';
import { runSuggestionCard } from '../goals/candidates.js';
import { runTaskCard, type TaskCardDeps } from '../tasks/card.js';

/**
 * P4 adds forecast.series.enable (turning predictions on), and nothing else. P3 part 5 adds the two suggestions
 * from chat: an approved one adds a proposed goal, or an unconfirmed commitment. P5 adds its seven: never a
 * dispatch that spends, which nothing carries out.
 */
export const INTERNAL_ACTIONS: ReadonlySet<string> = new Set([
  'world.source.enable', 'policy.change', 'triage.rule.create', 'world.relation.write', 'world.person.create', ...GOAL_SIGNED_ACTIONS,
  'forecast.series.enable', ...CHAT_SUGGESTION_ACTIONS, ...TASK_SIGNED_ACTIONS,
]);

/**
 * A triage rule is policy (kind `rule`): its predicate may read only the
 * structural fields allowlisted for its source and event type, checked before
 * Will is asked to sign it. The database inserts it only as the exact rule of
 * the signed proposal being executed.
 */
export const RuleCreateArgs = z.object({ rule: RuleArgs }).strict();

/** Why a proposed rule may not exist, or undefined when it may. */
export function refuseRule(args: unknown): string | undefined {
  const parsed = RuleCreateArgs.safeParse(args);
  if (!parsed.success) return parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ').slice(0, 500);
  const problems = ruleProblems(parsed.data.rule);
  return problems.length ? problems.join('; ').slice(0, 500) : undefined;
}

const EnableArgs = z.object({ source: z.enum(SOURCES) }).strict();

/**
 * The card that asks Will to turn a source on (`pnpm --filter @flint/runtime
 * enable-source <name>`): Will acting at the terminal, so origin cli. He signs
 * it in the console; the same card filed again while it waits is that card.
 */
export async function proposeEnable(db: Db, source: string, now = new Date()) {
  const { source: s } = EnableArgs.parse({ source });
  return createProposal(db, {
    kind: 'tool_call', origin: 'cli', action: 'world.source.enable', args: { source: s }, argsProvenance: { source: { source: 'will', tainted: false } },
    tainted: false, sensitivity: 'ops', destructive: false, consequential: false, ttlMinutes: 7 * 24 * 60, reason: 'Approving turns this source on.',
  }, 'will:cli', now);
}
/** A policy row's pattern, as the database's own CHECK reads it. */
const POLICY_PATTERN = z.string().max(200).regex(/^[A-Za-z0-9_:-]+(\.[A-Za-z0-9_:-]+)*(\.\*)?$/);
/**
 * When a rule ends, written the one way the database takes (Proposal_policy_shape, and both policy guards): in
 * full, with its zone. A time with no zone, or a date that reads two ways, is a different moment under each
 * session's settings, so one listed row could be made once for every way of reading it.
 */
export const POLICY_TIME = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,3})?(Z|[+-][0-9]{2}:[0-9]{2})$/;

/**
 * A signed policy change, held to the database's own rules (pattern shape,
 * 180-day expiry, times written in full with their zone and to the millisecond,
 * int4 caps, no row that covers a policy change itself) so a bad row is refused
 * when the proposal is made, not when it runs. The database makes a card's rows
 * together or not at all.
 */
export const PolicyArgs = z
  .object({
    rows: z
      .array(
        z
          .object({
            pattern: POLICY_PATTERN.refine((p) => !coversPolicyChange(p), 'no rule covers a policy change'),
            tier: z.enum(['alone', 'approval', 'forbidden']),
            dailyCap: z.number().int().min(0).max(2_147_483_647).optional(),
            scope: z.record(z.string(), z.unknown()).optional(),
            reason: z.string().min(1).max(500).optional(),
            // (Nothing here throws on a text that is no time: a filing is refused with a sentence, never a fault.)
            expiresAt: z
              .string()
              .regex(POLICY_TIME, 'a time is written in full, with its zone, to the millisecond at most')
              .datetime({ offset: true })
              .refine((t) => Date.parse(t) > Date.now() && Date.parse(t) <= Date.now() + 180 * 86400_000, 'a policy row expires within 180 days'),
          })
          .strict(),
      )
      .min(1)
      .max(200),
  })
  .strict();

/**
 * A signed switch-off: the rows a policy change takes out of force. Each is
 * named by its id and by what it says (its pattern and its tier), so the card
 * shows Will what stops applying and the database lets exactly those rows go
 * (action_policy_off_guard checks all three against the row). A card either
 * adds rows (PolicyArgs) or switches rows off, never both. This is the only
 * way a row that holds an action back goes off: the runtime's role cannot
 * switch one off on its own.
 */
export const PolicyOffArgs = z
  .object({
    off: z
      .array(z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), pattern: POLICY_PATTERN, tier: z.enum(['alone', 'approval', 'forbidden']) }).strict())
      .min(1)
      .max(200)
      .refine((rows) => new Set(rows.map((r) => r.id)).size === rows.length, 'a rule is named once'),
  })
  .strict();

/** What Will reads when the database would not let a signed switch-off through (its guard found no card of his that still stands). */
export const POLICY_OFF_REFUSED = 'The database refused to switch it off, so it’s still on. File it again and sign it.';
/** What Will reads when the database would not make a signed card's rules (the same guard, on a row made). None of them is made. */
export const POLICY_ROWS_REFUSED = 'The database refused to add the rules, so none was added. File the card again and sign it.';
/** What the rules command and a filing say about a rule that cannot be named on a card. */
export const POLICY_OFF_SAYS = {
  card: 'A card that switches rules off is your own: a policy card from the console or the CLI, with nothing untrusted in it.',
  unknown: 'One of the rules named isn’t on record as written.',
  alreadyOff: 'One of the rules named is already switched off.',
} as const;
/** What a filing says of a rule card that could never be carried out, each a sentence. */
export const POLICY_SAYS = {
  /** A row that would cover policy.change: such a rule could never be signed away, so none is ever made. */
  coversPolicy: 'A rule can’t cover policy changes. Those always take your signature.',
  /** Args the database cannot digest again (p3_canonical): it would refuse the card when it ran. */
  unsignable: 'A rule card holds only whole numbers and plain names, a few levels deep.',
  /** A card the database would make no row under: not his own policy card, or one with something untrusted in it. */
  card: 'A card that adds rules is your own: a policy card from the console or the CLI, with nothing untrusted in it.',
} as const;

/**
 * Can the database compute this card's digest again (p3_canonical)? Whole
 * numbers only, keys in printable ASCII, and nothing nested past a depth it
 * reads. A card that fails this would be signed and then refused when it ran.
 */
export function policyArgsSignable(v: unknown, depth = 0): boolean {
  if (typeof v === 'number') return Number.isSafeInteger(v);
  if (v === null || typeof v !== 'object') return true;
  if (depth >= 16) return false;
  if (Array.isArray(v)) return v.every((x) => policyArgsSignable(x, depth + 1));
  return Object.entries(v).every(([k, x]) => /^[ -~]*$/.test(k) && policyArgsSignable(x, depth + 1));
}

/**
 * A policy change's args, checked before Will is asked to sign: one thing
 * (rows or off, @flint/policy policyChangeKind), in the shape the runtime
 * carries out, and nothing the database would refuse when it ran. Throws the
 * sentence that says why not. Returns which of the two it is.
 */
export function checkPolicyChange(args: unknown): 'rows' | 'off' {
  const kind = policyChangeKind(args);
  if (!kind) throw new Refused(400, POLICY_CHANGE_SHAPE);
  const rows = kind === 'rows' ? (args as { rows: unknown[] }).rows : [];
  if (rows.some((r) => r !== null && typeof r === 'object' && typeof (r as { pattern?: unknown }).pattern === 'string' && coversPolicyChange((r as { pattern: string }).pattern))) {
    throw new Refused(400, POLICY_SAYS.coversPolicy);
  }
  const ok = (kind === 'off' ? PolicyOffArgs : PolicyArgs).safeParse(args);
  if (!ok.success) throw new Refused(400, `invalid policy change: ${ok.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  if (!policyArgsSignable(args)) throw new Refused(400, POLICY_SAYS.unsignable);
  return kind;
}

/**
 * Why a card that adds rules may not be filed, checked before Will is asked to sign it: the database makes a row
 * only under his own untainted policy card from the console or the CLI (action_policy_matches_approval). One
 * from a chat, one with something untrusted in it, or one of another kind would be signed and then make nothing.
 */
export function checkPolicyRows(input: { kind: string; origin: string; tainted: boolean }): void {
  if (input.kind !== 'policy' || (input.origin !== 'console' && input.origin !== 'cli') || input.tainted) throw new Refused(400, POLICY_SAYS.card);
}

/**
 * Why a switch-off card may not be filed, checked before Will is asked to sign it: the card is one the
 * database will take (action_policy_off_guard takes only his own untainted policy card), and each row it
 * names is there, still on, and says what the card says. One that could not apply is never filed.
 */
export async function checkPolicyOff(db: Db, input: { kind: string; origin: string; tainted: boolean; args: unknown }): Promise<void> {
  if (input.kind !== 'policy' || (input.origin !== 'console' && input.origin !== 'cli') || input.tainted) throw new Refused(400, POLICY_OFF_SAYS.card);
  const { off } = PolicyOffArgs.parse(input.args);
  const rows = await db.actionPolicy.findMany({ where: { id: { in: off.map((r) => r.id) } }, select: { id: true, pattern: true, tier: true, active: true } });
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const r of off) {
    const there = byId.get(r.id);
    if (!there || there.pattern !== r.pattern || there.tier !== r.tier) throw new Refused(400, POLICY_OFF_SAYS.unknown);
    if (!there.active) throw new Refused(409, POLICY_OFF_SAYS.alreadyOff);
  }
}

/**
 * Carry out an approved action the runtime runs itself. `internal` is the set it
 * takes (INTERNAL_ACTIONS; a test passes a wider one to show that a listed action
 * without a branch below fails closed). `tasks` is what a task card needs from
 * the process: whether tasks are switched off, and the bus to send a run on.
 */
export async function runInternal(db: Db, id: string, rp: WebAuthnRelyingParty | undefined, tz: string, actor: string, internal: ReadonlySet<string> = INTERNAL_ACTIONS, tasks: TaskCardDeps = {}) {
  const p = await db.proposal.findUnique({ where: { id }, select: { action: true } });
  if (!p) throw new Refused(404, GONE);
  if (!internal.has(p.action)) throw new Refused(409, `${p.action} is not carried out by the runtime`);
  // P3: a goal card is claimed, applied and completed in one transaction.
  if (isGoalSignedAction(p.action)) return runGoalCard(db, id, rp, tz, actor);
  // P4: so is the card that turns predictions on.
  if (p.action === 'forecast.series.enable') return runForecastCard(db, id, rp, tz, actor);
  // P3 part 5: and a suggestion from chat (a proposed goal, or an unconfirmed commitment).
  if (isChatSuggestion(p.action)) return runSuggestionCard(db, id, rp, tz, actor);
  // P5: so is each asset and task card.
  if (isTaskSignedAction(p.action)) return runTaskCard(db, id, rp, tz, actor, tasks);
  const claimed = await claimProposal(db, id, rp, tz, actor);
  // A policy change says one thing (the database files no other, and each of its guards refuses a card that
  // carries the other key): anything else is carried out as neither.
  const change = claimed.action === 'policy.change' ? policyChangeKind(claimed.args) : undefined;
  try {
    if (claimed.action === 'world.source.enable') {
      const { source } = EnableArgs.parse(claimed.args);
      await db.sourceCursor.upsert({ where: { source }, create: { source, cursor: '', enabled: true }, update: { enabled: true } });
      await completeProposal(db, id, { ok: true, result: { source, enabled: true } }, actor);
      return { source, enabled: true };
    }
    if (claimed.action === 'world.relation.write') {
      // Only the link a knowledge fact proposed (template knowledge.link), between two things that are still here.
      const p = await db.proposal.findUniqueOrThrow({ where: { id }, select: { templateId: true, tainted: true } });
      if (p.templateId !== 'knowledge.link') throw new Refused(409, 'the runtime writes only the knowledge.link relation');
      const link = ACTION_TEMPLATES['knowledge.link'].params.parse(claimed.args);
      if ((await db.entity.count({ where: { id: { in: [link.fromId, link.toId] }, status: 'active' } })) !== 2) throw new Refused(409, 'One of the two items no longer exists.');
      const open = { type: link.type, fromId: link.fromId, toId: link.toId, validTo: null };
      let rel = await db.relation.findFirst({ where: open, select: { id: true } });
      let existed = !!rel;
      if (!rel) {
        try {
          rel = await db.relation.create({ data: { type: link.type, fromId: link.fromId, toId: link.toId, attrs: { knowledgeId: link.knowledgeId }, tainted: true, validFrom: new Date() }, select: { id: true } });
        } catch (err) {
          // Written by someone else between the look and the write: the link is there, which is what was asked.
          if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
          rel = await db.relation.findFirstOrThrow({ where: open, select: { id: true } });
          existed = true;
        }
      }
      await completeProposal(db, id, { ok: true, result: { relationId: rel.id, ...(existed ? { existed: true } : {}) } }, actor);
      return { relationId: rel.id, ...(existed ? { existed: true } : {}) };
    }
    if (claimed.action === 'world.person.create') {
      // Only the calendar's card, and only the people PersonGuard still allows (checked again inside).
      const p = await db.proposal.findUniqueOrThrow({ where: { id }, select: { templateId: true } });
      if (p.templateId !== PERSON_TEMPLATE) throw new Refused(409, `the runtime creates people only from the ${PERSON_TEMPLATE} card`);
      const done = await createPeople(db, claimed.args, new Date(), actor);
      await completeProposal(db, id, { ok: true, result: done }, actor);
      return done;
    }
    if (claimed.action === 'triage.rule.create') {
      const why = refuseRule(claimed.args);
      if (why) throw new Refused(400, `invalid triage rule: ${why}`);
      const { rule } = RuleCreateArgs.parse(claimed.args);
      const approvalId = (await db.proposal.findUniqueOrThrow({ where: { id }, select: { approvalId: true } })).approvalId!;
      // A name taken since it was proposed (another rule signed first).
      if (await db.triageRule.findUnique({ where: { name: rule.name }, select: { id: true } })) throw new Refused(400, `a triage rule named ${rule.name} exists`);
      // The predicate as exact JSON: the database compares it with the signed one.
      await db.$executeRaw`
        INSERT INTO "TriageRule" (id, name, source, "eventType", predicate, action, lane, priority, "perSenderDailyCap", "createdBy", "approvalId")
        VALUES (${`tr${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`}, ${rule.name}, ${rule.source}, ${rule.eventType},
                ${JSON.stringify(rule.predicate)}::jsonb, ${rule.action}, ${rule.lane}, ${rule.priority}, ${rule.perSenderDailyCap}, ${rule.createdBy}, ${approvalId})`;
      await completeProposal(db, id, { ok: true, result: { rule: rule.name } }, actor);
      return { rule: rule.name };
    }
    if (claimed.action === 'policy.change' && !change) throw new Refused(409, POLICY_CHANGE_SHAPE);
    if (change === 'off') {
      const { off } = PolicyOffArgs.parse(claimed.args);
      const approvalId = (await db.proposal.findUniqueOrThrow({ where: { id }, select: { approvalId: true } })).approvalId!;
      // All rows or none: a signed switch-off is applied whole. Each row only as the card names it (the database
      // checks the same three); one that went off since the card was filed is left as it is. The row's history
      // says which approval switched it off: the database's guard writes that name itself, from the card it let
      // through and whatever is set here; this says the same for a database from before the guard.
      const switched = await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT set_config('flint.actor', ${`will:approval:${approvalId}`}, true)`;
        let n = 0;
        for (const r of off) n += (await tx.actionPolicy.updateMany({ where: { id: r.id, pattern: r.pattern, tier: r.tier, active: true }, data: { active: false } })).count;
        return n;
      });
      await completeProposal(db, id, { ok: true, result: { off: switched } }, actor);
      return { off: switched };
    }
    if (change === 'rows') {
      const { rows } = PolicyArgs.parse(claimed.args);
      const approvalId = (await db.proposal.findUniqueOrThrow({ where: { id }, select: { approvalId: true } })).approvalId!;
      // All rows or none: a signed table is applied whole. (The database holds that too: when this transaction
      // commits, every row the card lists is there or none of them stays.)
      await db.$transaction(async (tx) => {
        for (const r of rows) {
          await tx.actionPolicy.create({
            data: {
              id: `ap${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`,
              pattern: r.pattern, tier: r.tier, dailyCap: r.dailyCap ?? null, ...(r.scope ? { scope: r.scope as Prisma.InputJsonObject } : {}),
              reason: r.reason ?? 'signed policy change', approvalId, expiresAt: new Date(r.expiresAt),
            },
          });
        }
      });
      await completeProposal(db, id, { ok: true, result: { rows: rows.length } }, actor);
      return { rows: rows.length };
    }
    // An action listed above with no branch here fails closed: it is never run as something else.
    throw new Refused(409, 'Flint can’t carry this out yet.');
  } catch (err) {
    // No database internals in the reply or the record, and no error's message in the log (a database's can
    // carry the row it refused): a reference, what failed (class, SQLSTATE, constraint) and where.
    const ref = `err${Date.now().toString(36)}`;
    console.error(`[runtime] ${ref} running ${claimed.action} failed: ${failureReport(err)}`);
    await completeProposal(db, id, { ok: false, error: `could not carry it out (${ref})` }, actor).catch(() => {});
    if (err instanceof Refused) throw err;
    // The database refusing what was signed is the input's fault, a 400: a CHECK (23514, wherever Prisma
    // puts it: a raw query's SQLSTATE is in meta.code), or a rule's name taken by one signed just before.
    const e = err as { code?: unknown; meta?: { code?: unknown }; message?: unknown };
    const codes = [e.code, e.meta?.code].map(String);
    const refusedInput = dbRefused(err) || (claimed.action === 'triage.rule.create' && (codes.includes('23505') || codes.includes('P2002') || /Code: `23505`/.test(String(e.message ?? ''))));
    // The ref is in the log above; Will reads a sentence under the card.
    if (refusedInput) throw new Refused(400, 'The database refused this change.');
    // The database's guard on a switch-off or on a row made (42501): the card has failed and is on record as
    // failed (above), the rows are as they were (a card's rows are made together or not at all), and nothing here
    // tries again. Will reads what to do.
    if (change === 'off' && sqlState(err) === '42501') throw new Refused(409, POLICY_OFF_REFUSED);
    if (change === 'rows' && sqlState(err) === '42501') throw new Refused(409, POLICY_ROWS_REFUSED);
    throw new Refused(409, 'Flint couldn’t carry it out.');
  }
}
