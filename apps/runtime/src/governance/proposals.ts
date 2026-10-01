/**
 * Proposals: every action that needs Will's approval waits here (plan 3.0.3,
 * 3.0.7). The lifecycle is pending -> approved -> executing -> executed|failed,
 * and the database refuses any other path (proposal_transition). This module
 * adds what the database cannot do:
 *  - the tier engine decides at creation, at approval and again at claim, so a
 *    FORBIDDEN action is refused with 409 however it got here, and a policy that
 *    tightened in the meantime wins;
 *  - Will's signature is re-verified before approving and again before
 *    executing (approvals.ts);
 *  - caps are claimed atomically at claim time, in the same transaction as the
 *    intent entry, so an intent is never written without its claim.
 *
 * MCP tool calls are proposed under the action `mcp:<server>.<tool>`, the same
 * key policies and caps use, so they can never be confused with Flint's own
 * actions of the same name.
 */
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { digestOf, redact, resolveTier, type McpFacts, type PolicyRow, type TierContext, type TierDecision, type WebAuthnRelyingParty } from '@flint/policy';
import type { Db, Tx } from '../db.js';
import { appendAudit } from './audit.js';
import { jsonbBytes } from '../jsonsize.js';
import { claim } from './counters.js';
import { reverifyApproval } from './approvals.js';

export class Refused extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 429,
    message: string,
  ) {
    super(message);
    this.name = 'Refused';
  }
}

const Provenance = z.record(
  z.string().max(64),
  z.object({ source: z.enum(['will', 'model', 'template', 'event']), ref: z.string().max(120).optional(), tainted: z.boolean() }).strict(),
);

export const CreateProposal = z
  .object({
    kind: z.enum(['tool_call', 'goal', 'plan', 'rule', 'policy', 'task', 'pr', 'spend', 'forget', 'void']),
    origin: z.string().regex(/^(chat:[A-Za-z0-9_-]{1,80}|runtime:[a-z0-9_.-]{1,60}|console|cli)$/),
    action: z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:-]+$/),
    templateId: z.string().max(80).optional(),
    args: z.record(z.string(), z.unknown()).refine((a) => jsonbBytes(a) <= 65536, 'args are over 64 KB'),
    argsProvenance: Provenance,
    tainted: z.boolean().default(false),
    sensitivity: z.enum(['ops', 'personal', 'financial']).default('ops'),
    destructive: z.boolean().default(false),
    consequential: z.boolean().default(false),
    readOnlyHint: z.boolean().optional(),
    reason: z.string().max(1000).optional(),
    estCostUsd: z.number().nonnegative().max(1000).optional(),
    /** How long Will has to decide. Default 24 hours, at most 7 days. */
    ttlMinutes: z.number().int().min(1).max(7 * 24 * 60).default(24 * 60),
  })
  .strict();
export type CreateProposal = z.infer<typeof CreateProposal>;

/** `chat:<id>` is chat, `runtime:<job>` is autonomous, the console and the CLI are Will. */
export function contextOf(origin: string): TierContext['context'] {
  if (origin.startsWith('chat:')) return 'chat';
  if (origin === 'console' || origin === 'cli') return 'console';
  return 'autonomous';
}

/** `mcp:server.tool` -> MCP facts; anything else is one of Flint's own actions. */
export function mcpOf(action: string, hints: { destructive?: boolean; readOnlyHint?: boolean } = {}): McpFacts | undefined {
  const m = /^mcp:([A-Za-z0-9_-]+)\.(.+)$/.exec(action);
  if (!m) return undefined;
  return { server: m[1]!, tool: m[2]!, ...(hints.destructive ? { destructiveHint: true } : {}), ...(hints.readOnlyHint ? { readOnlyHint: true } : {}) };
}

/** The live policy rows the tier engine reads. */
export async function activePolicies(db: Db | Tx, now = new Date()): Promise<PolicyRow[]> {
  const rows = await db.actionPolicy.findMany({ where: { active: true, expiresAt: { gt: now } } });
  return rows.map((r) => ({ pattern: r.pattern, tier: r.tier as PolicyRow['tier'], dailyCap: r.dailyCap, scope: r.scope ?? undefined, active: r.active, expiresAt: r.expiresAt }));
}

interface ProposalFacts {
  action: string;
  origin: string;
  tainted: boolean;
  sensitivity: string;
  destructive: boolean;
}

async function tierOf(db: Db | Tx, p: ProposalFacts, now: Date, readOnlyHint?: boolean): Promise<TierDecision> {
  const mcp = mcpOf(p.action, { destructive: p.destructive, ...(readOnlyHint ? { readOnlyHint } : {}) });
  return resolveTier(p.action, {
    context: contextOf(p.origin),
    tainted: p.tainted,
    sensitivity: p.sensitivity as TierContext['sensitivity'] & string,
    ...(mcp ? { mcp } : {}),
    policies: await activePolicies(db, now),
    now,
  });
}

const auditInputs = (p: { id: string; action: string; argsDigest: string }, extra: Record<string, string | number | boolean | null> = {}) => ({
  proposalId: p.id,
  argsDigest: p.argsDigest,
  ...extra,
});

/** Record a proposal. A FORBIDDEN action is refused (409) and the refusal audited. */
export async function createProposal(db: Db, input: CreateProposal, actor: string, now = new Date()) {
  // A policy change is checked against the database's rules before Will is asked to sign it.
  if (input.action === 'policy.change') {
    const { PolicyArgs } = await import('./internal.js');
    const ok = PolicyArgs.safeParse(input.args);
    if (!ok.success) throw new Refused(400, `invalid policy change: ${ok.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  const argsDigest = digestOf(input.args);
  const decision = await tierOf(db, { ...input }, now, input.readOnlyHint);
  const id = `pr${now.getTime().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
  const context = contextOf(input.origin);
  if (decision.tier === 'forbidden') {
    await appendAudit(db, [{
      actor, context, kind: 'decision', action: input.action, tier: 'forbidden', decision: 'deny', outcome: 'denied',
      inputs: { argsDigest, origin: input.origin.slice(0, 200), rule: decision.rule }, reasoning: decision.reason, tainted: input.tainted,
    }]);
    throw new Refused(409, `forbidden: ${decision.reason}`);
  }
  const expiresAt = new Date(now.getTime() + input.ttlMinutes * 60_000);
  return db.$transaction(async (tx) => {
    const row = await tx.proposal.create({
      data: {
        id,
        kind: input.kind,
        origin: input.origin,
        action: input.action,
        templateId: input.templateId ?? null,
        args: input.args as Prisma.InputJsonObject,
        argsDigest,
        argsProvenance: input.argsProvenance as Prisma.InputJsonObject,
        tainted: input.tainted,
        sensitivity: input.sensitivity,
        destructive: input.destructive,
        consequential: input.consequential,
        reason: input.reason ? redact(input.reason) : null,
        estCostUsd: input.estCostUsd ?? null,
        expiresAt,
      },
    });
    await appendAudit(tx, [{
      actor, context, kind: 'decision', action: input.action, tier: decision.tier, decision: 'queue', outcome: 'pending',
      inputs: auditInputs(row, { rule: decision.rule }), correlationId: row.id, tainted: input.tainted,
    }]);
    return { id: row.id, argsDigest, expiresAt, tier: decision.tier, rule: decision.rule, reason: decision.reason };
  });
}

/**
 * Approve with Will's signed approval (already verified by the server and
 * recorded by flint_approver). The signature is verified again here; an action
 * that is FORBIDDEN now is refused with 409 and the approval is left unused.
 */
export async function approveProposal(db: Db, id: string, approvalId: string, rp: WebAuthnRelyingParty | undefined, actor: string, now = new Date()) {
  const p = await db.proposal.findUnique({ where: { id } });
  if (!p) throw new Refused(404, 'no such proposal');
  if (p.status !== 'pending') throw new Refused(409, `the proposal is ${p.status}`);
  const v = await reverifyApproval(db, approvalId, rp);
  if (!v.ok) throw new Refused(403, `the approval does not verify: ${v.reason}`);
  if (v.payload.subjectType !== 'proposal' || v.payload.subjectId !== id || v.payload.decision !== 'approve' || v.payload.action !== p.action || v.payload.argsDigest !== p.argsDigest) {
    throw new Refused(403, 'the approval was signed for something else');
  }
  const decision = await tierOf(db, p, now);
  if (decision.tier === 'forbidden') throw new Refused(409, `forbidden: ${decision.reason}`);
  await db.$transaction(async (tx) => {
    // proposal_transition checks the approval again and consumes it.
    await tx.proposal.update({ where: { id }, data: { status: 'approved', approvalId } });
    await appendAudit(tx, [{
      actor, context: 'console', kind: 'approval', action: p.action, tier: decision.tier, decision: 'act', outcome: 'ok',
      inputs: auditInputs(p, { approvalId }), correlationId: id, tainted: p.tainted,
    }]);
  });
}

/** Reject: Will's signed rejection when there is one, or the runtime refusing on its own. */
export async function rejectProposal(db: Db, id: string, opts: { approvalId?: string; error?: string }, rp: WebAuthnRelyingParty | undefined, actor: string) {
  const p = await db.proposal.findUnique({ where: { id } });
  if (!p) throw new Refused(404, 'no such proposal');
  if (p.status !== 'pending') throw new Refused(409, `the proposal is ${p.status}`);
  if (opts.approvalId) {
    const v = await reverifyApproval(db, opts.approvalId, rp);
    if (!v.ok) throw new Refused(403, `the rejection does not verify: ${v.reason}`);
  }
  await db.$transaction(async (tx) => {
    await tx.proposal.update({
      where: { id },
      data: { status: 'rejected', ...(opts.approvalId ? { approvalId: opts.approvalId } : {}), ...(opts.error ? { error: redact(opts.error).slice(0, 2000) } : {}) },
    });
    await appendAudit(tx, [{
      actor, context: opts.approvalId ? 'console' : contextOf(p.origin), kind: 'rejection', action: p.action, decision: 'deny', outcome: 'denied',
      inputs: auditInputs(p, { approvalId: opts.approvalId ?? null }), correlationId: id, tainted: p.tainted,
    }]);
  });
}

/**
 * Take an approved proposal for execution: verify the signature again, decide
 * the tier again, claim its cap, move it to executing and write the intent, all
 * in one transaction. Returns the exact args that were approved.
 */
export async function claimProposal(db: Db, id: string, rp: WebAuthnRelyingParty | undefined, tz: string, actor: string, now = new Date()) {
  // A refusal that changes state (approved -> failed) must commit before it is
  // reported, so the transaction returns it instead of throwing it.
  const out = await db.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "Proposal" WHERE id = ${id} FOR UPDATE`;
    if (locked.length === 0) throw new Refused(404, 'no such proposal');
    const p = await tx.proposal.findUniqueOrThrow({ where: { id } });
    if (p.status !== 'approved' || !p.approvalId) throw new Refused(409, `the proposal is ${p.status}`);
    if (p.expiresAt <= now) throw new Refused(409, 'the proposal has expired');
    const fail = async (reason: string, status: 403 | 409) => {
      await tx.proposal.update({ where: { id }, data: { status: 'failed', error: reason, executedAt: now } });
      await appendAudit(tx, [{
        actor, context: contextOf(p.origin), kind: 'action', action: p.action, decision: 'deny', outcome: 'denied',
        inputs: auditInputs(p), reasoning: reason, correlationId: id, tainted: p.tainted,
      }], now);
      return { refused: new Refused(status, reason) } as const;
    };
    const v = await reverifyApproval(tx, p.approvalId, rp);
    if (!v.ok || v.payload.argsDigest !== p.argsDigest || v.payload.action !== p.action) {
      return fail(`refused to execute: the approval no longer verifies (${v.ok ? 'it covers different args' : v.reason})`, 403);
    }
    if (p.args === null || digestOf(p.args) !== p.argsDigest) return fail('refused to execute: the args do not match their digest', 409);
    const decision = await tierOf(tx, p, now);
    if (decision.tier === 'forbidden') return fail(`refused to execute: forbidden: ${decision.reason}`, 409);
    if (decision.cap) {
      const n = await claim(tx, decision.key, decision.cap, tz, now);
      // Nothing changed yet, so throwing (and rolling back) is right; it stays approved.
      if (n === null) throw new Refused(429, `the ${decision.cap.period}ly cap of ${decision.cap.limit} for ${decision.key} is reached`);
    }
    await tx.proposal.update({ where: { id }, data: { status: 'executing' } });
    await appendAudit(tx, [{
      actor, context: contextOf(p.origin), kind: 'intent', action: p.action, tier: decision.tier, decision: 'act', outcome: 'pending',
      inputs: auditInputs(p), correlationId: id, tainted: p.tainted,
    }], now);
    return { claimed: { id, action: p.action, args: p.args as Record<string, unknown>, argsDigest: p.argsDigest } } as const;
  });
  if ('refused' in out) throw out.refused;
  return out.claimed;
}

export const CompleteProposal = z
  .object({
    ok: z.boolean(),
    result: z.record(z.string(), z.unknown()).optional(),
    error: z.string().max(2000).optional(),
    costUsd: z.number().nonnegative().max(1000).optional(),
  })
  .strict();

/** Record how an execution ended; the intent's outcome is a new audit entry with the same correlation id. */
export async function completeProposal(db: Db, id: string, body: z.infer<typeof CompleteProposal>, actor: string, now = new Date()) {
  const p = await db.proposal.findUnique({ where: { id } });
  if (!p) throw new Refused(404, 'no such proposal');
  if (p.status !== 'executing') throw new Refused(409, `the proposal is ${p.status}`);
  let result: Prisma.InputJsonObject | undefined;
  if (body.result) {
    // Measured as the database measures it (jsonb text), with room to spare: an
    // action that ran must be recorded as having run, however large its result.
    const r = redact(body.result);
    const size = jsonbBytes(r);
    result = (size <= 15000 ? r : { truncated: true, bytes: size }) as Prisma.InputJsonObject;
  }
  await db.$transaction(async (tx) => {
    await tx.proposal.update({
      where: { id },
      data: {
        status: body.ok ? 'executed' : 'failed',
        executedAt: now,
        ...(result ? { result } : {}),
        ...(body.error ? { error: redact(body.error).slice(0, 2000) } : {}),
      },
    });
    await appendAudit(tx, [{
      actor, context: contextOf(p.origin), kind: 'action', action: p.action, decision: 'act', outcome: body.ok ? 'ok' : 'failed',
      inputs: auditInputs(p), correlationId: id, tainted: p.tainted, ...(body.costUsd !== undefined ? { costUsd: body.costUsd } : {}),
      // The audit keeps no PERSONAL free text (plan 3.0.5): for personal, financial or
      // tainted work the error's words stay in Proposal.error (which retention clears).
      ...(body.error && p.sensitivity === 'ops' && !p.tainted ? { reasoning: redact(body.error).slice(0, 1000) } : {}),
    }], now);
  });
}

/** Pending and approved proposals past their expiry become expired, each one audited. Returns how many. */
export async function expireProposals(db: Db, now = new Date()): Promise<number> {
  const due = await db.proposal.findMany({ where: { status: { in: ['pending', 'approved'] }, expiresAt: { lte: now } } });
  let n = 0;
  for (const p of due) {
    await db.$transaction(async (tx) => {
      const r = await tx.proposal.updateMany({ where: { id: p.id, status: { in: ['pending', 'approved'] } }, data: { status: 'expired' } });
      if (r.count === 0) return;
      n += 1;
      await appendAudit(tx, [{
        actor: 'runtime', context: contextOf(p.origin), kind: 'decision', action: p.action, decision: 'log', outcome: 'skipped',
        inputs: auditInputs(p, { was: p.status }), reasoning: 'expired before it was decided or run', correlationId: p.id, tainted: p.tainted,
      }], now);
    });
  }
  return n;
}

/** What the console's approval card shows: the full args, where each came from, and the tainted banner. */
export async function listProposals(db: Db, status: string | undefined, limit: number) {
  return db.proposal.findMany({
    where: status ? { status } : {},
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}
