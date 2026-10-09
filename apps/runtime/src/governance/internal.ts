/**
 * Actions the runtime carries out itself once Will has approved them: turning a
 * source on, applying a signed policy change, adding a triage rule, writing a
 * proposed link, creating the people on a calendar card (P2.5), and changing a
 * goal or its plan (P3). Each goes through claimProposal (re-verification,
 * tier, cap, intent) and then completes, so the audit trail reads the same as
 * any other approved action; a goal card does all three in one transaction
 * (goals/apply.ts). The database checks the effect too: a cursor turns on only
 * under an executing enable proposal, a policy row must appear in the signed
 * proposal, and a goal moves only as its executing card says.
 */
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { GOAL_SIGNED_ACTIONS, SOURCES, isGoalSignedAction, type WebAuthnRelyingParty } from '@flint/policy';
import type { Db } from '../db.js';
import { GONE, Refused, claimProposal, completeProposal, createProposal } from './proposals.js';
import { dbRefused, failureOf } from '../dbcodes.js';
import { RuleArgs, ruleProblems } from '../triage/rules.js';
import { ACTION_TEMPLATES } from '../templates/actions.js';
import { TEMPLATE as PERSON_TEMPLATE, createPeople } from '../world/person-create.js';
import { runGoalCard } from '../goals/apply.js';

export const INTERNAL_ACTIONS = new Set(['world.source.enable', 'policy.change', 'triage.rule.create', 'world.relation.write', 'world.person.create', ...GOAL_SIGNED_ACTIONS]);

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
/**
 * A signed policy change, held to the database's own rules (pattern shape,
 * 180-day expiry, millisecond times, int4 caps) so a bad row is refused when the
 * proposal is made, not half-applied when it runs.
 */
export const PolicyArgs = z
  .object({
    rows: z
      .array(
        z
          .object({
            pattern: z.string().max(200).regex(/^[A-Za-z0-9_:-]+(\.[A-Za-z0-9_:-]+)*(\.\*)?$/),
            tier: z.enum(['alone', 'approval', 'forbidden']),
            dailyCap: z.number().int().min(0).max(2_147_483_647).optional(),
            scope: z.record(z.string(), z.unknown()).optional(),
            reason: z.string().min(1).max(500).optional(),
            expiresAt: z
              .string()
              .datetime({ offset: true })
              .refine((t) => new Date(t).toISOString() === new Date(Date.parse(t)).toISOString() && !/\.\d{4,}/.test(t), 'times are kept to the millisecond')
              .refine((t) => Date.parse(t) > Date.now() && Date.parse(t) <= Date.now() + 180 * 86400_000, 'a policy row expires within 180 days'),
          })
          .strict(),
      )
      .min(1)
      .max(200),
  })
  .strict();

export async function runInternal(db: Db, id: string, rp: WebAuthnRelyingParty | undefined, tz: string, actor: string) {
  const p = await db.proposal.findUnique({ where: { id }, select: { action: true } });
  if (!p) throw new Refused(404, GONE);
  if (!INTERNAL_ACTIONS.has(p.action)) throw new Refused(409, `${p.action} is not carried out by the runtime`);
  // P3: a goal card is claimed, applied and completed in one transaction.
  if (isGoalSignedAction(p.action)) return runGoalCard(db, id, rp, tz, actor);
  const claimed = await claimProposal(db, id, rp, tz, actor);
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
    if (claimed.action === 'policy.change') {
      const { rows } = PolicyArgs.parse(claimed.args);
      const approvalId = (await db.proposal.findUniqueOrThrow({ where: { id }, select: { approvalId: true } })).approvalId!;
      // All rows or none: a signed table is applied whole.
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
    // No database internals in the reply, the record or the log: a reference, and what failed with its
    // SQLSTATE (a database's message can carry the row it refused).
    const ref = `err${Date.now().toString(36)}`;
    console.error(`[runtime] ${ref} running ${claimed.action} failed: ${failureOf(err)}`);
    await completeProposal(db, id, { ok: false, error: `could not carry it out (${ref})` }, actor).catch(() => {});
    if (err instanceof Refused) throw err;
    // The database refusing what was signed is the input's fault, a 400: a CHECK (23514, wherever Prisma
    // puts it: a raw query's SQLSTATE is in meta.code), or a rule's name taken by one signed just before.
    const e = err as { code?: unknown; meta?: { code?: unknown }; message?: unknown };
    const codes = [e.code, e.meta?.code].map(String);
    const refusedInput = dbRefused(err) || (claimed.action === 'triage.rule.create' && (codes.includes('23505') || codes.includes('P2002') || /Code: `23505`/.test(String(e.message ?? ''))));
    // The ref is in the log above; Will reads a sentence under the card.
    if (refusedInput) throw new Refused(400, 'The database refused this change.');
    throw new Refused(409, 'Flint couldn’t carry it out.');
  }
}
