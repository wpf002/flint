/**
 * Actions the runtime carries out itself once Will has approved them: turning a
 * source on, and applying a signed policy change. Each goes through
 * claimProposal (re-verification, tier, cap, intent) and then completes, so the
 * audit trail reads the same as any other approved action. The database checks
 * the effect too: a cursor turns on only under an executing enable proposal,
 * and a policy row must appear in the signed proposal.
 */
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { SOURCES, type WebAuthnRelyingParty } from '@flint/policy';
import type { Db } from '../db.js';
import { Refused, claimProposal, completeProposal } from './proposals.js';

export const INTERNAL_ACTIONS = new Set(['world.source.enable', 'policy.change']);

const EnableArgs = z.object({ source: z.enum(SOURCES) }).strict();
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
  if (!p) throw new Refused(404, 'no such proposal');
  if (!INTERNAL_ACTIONS.has(p.action)) throw new Refused(409, `${p.action} is not carried out by the runtime`);
  const claimed = await claimProposal(db, id, rp, tz, actor);
  try {
    if (claimed.action === 'world.source.enable') {
      const { source } = EnableArgs.parse(claimed.args);
      await db.sourceCursor.upsert({ where: { source }, create: { source, cursor: '', enabled: true }, update: { enabled: true } });
      await completeProposal(db, id, { ok: true, result: { source, enabled: true } }, actor);
      return { source, enabled: true };
    }
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
  } catch (err) {
    // No database internals in the reply or the record: a reference, and the detail in the log.
    const ref = `err${Date.now().toString(36)}`;
    console.error(`[runtime] ${ref} running ${claimed.action} failed:`, err);
    await completeProposal(db, id, { ok: false, error: `could not carry it out (${ref})` }, actor).catch(() => {});
    throw err instanceof Refused ? err : new Refused(409, `could not carry it out (${ref})`);
  }
}
