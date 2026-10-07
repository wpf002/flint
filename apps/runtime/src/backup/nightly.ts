/**
 * Whether tonight's backup, offsite copy or restore drill may run (plan P1
 * backups): FORBIDDEN never; promoted (ALONE) under its cap; otherwise only on
 * a card Will approved. Each night offers one card that lives 26 hours, so a
 * card approved any time before the next run (a 25-hour night included) is
 * claimed by it; older pending cards are withdrawn. The drill runs on Sundays
 * only (backup-nightly.sh), so its card lives a week and two hours: approved
 * any time that week, the next Sunday's run claims it.
 */
import { localDay, resolveTier, type WebAuthnRelyingParty } from '@flint/policy';
import type { Db } from '../db.js';
import { activePolicies, claimProposal, createProposal, rejectProposal } from '../governance/proposals.js';
import { claim } from '../governance/counters.js';

export type Command = 'backup' | 'offsite' | 'drill';
export const ACTION: Record<Command, string> = { backup: 'backup.local', offsite: 'backup.offsite', drill: 'restore.drill' };

export async function gate(db: Db, cmd: Command, tz: string, rp: WebAuthnRelyingParty | undefined, now: Date): Promise<{ go: boolean; proposalId?: string; why: string }> {
  return cardGate(db, { action: ACTION[cmd], job: cmd, templateId: `nightly.${cmd}` }, tz, rp, now);
}

/**
 * The nightly card for any job that runs at APPROVAL until promoted (backups,
 * the drill, retention): run under the cap once promoted; otherwise run on a
 * card Will approved, or offer tonight's card and wait.
 */
export async function cardGate(
  db: Db,
  job: { action: string; job: string; templateId: string },
  tz: string,
  rp: WebAuthnRelyingParty | undefined,
  now: Date,
): Promise<{ go: boolean; proposalId?: string; why: string }> {
  const { action } = job;
  const cmd = job.job;
  const t = resolveTier(action, { context: 'autonomous', tainted: false, policies: await activePolicies(db, now), now });
  if (t.tier === 'forbidden') return { go: false, why: `forbidden: ${t.reason}` };
  if (t.tier === 'alone') {
    if (t.cap && (await claim(db, t.key, t.cap, tz, now)) === null) return { go: false, why: `the ${t.cap.period}ly cap is reached` };
    return { go: true, why: 'promoted' };
  }
  // APPROVAL: run an approved proposal for it, or file one (one a day) and wait.
  // Flint's day, not UTC's: a card offered at 23:30 Chicago time is that night's.
  const day = localDay(tz, now);
  const approved = await db.proposal.findFirst({ where: { action, origin: `runtime:${cmd}`, status: 'approved', expiresAt: { gt: now } }, orderBy: { createdAt: 'desc' } });
  let refused: string | undefined;
  if (approved) {
    try {
      const c = await claimProposal(db, approved.id, rp, tz, 'runtime');
      return { go: true, proposalId: c.id, why: 'approved by Will' };
    } catch (err) {
      // Expired a moment ago, re-verification failed, a cap: say so, and ask again below.
      refused = err instanceof Error ? err.message : String(err);
    }
  }
  // Each night offers one card, living 26 hours: approved any time before the
  // next run (even across a 25-hour night), that run claims it. The drill's
  // next run is a week away (Sundays only), so its card lives a week and two
  // hours (a 169-hour DST week included). Older pending cards are withdrawn,
  // so Will never approves one that would expire first.
  const pending = await db.proposal.findMany({ where: { action, origin: `runtime:${cmd}`, status: 'pending', expiresAt: { gt: now } }, orderBy: { createdAt: 'desc' } });
  const tonight = pending.find((p) => (p.args as { day?: unknown } | null)?.day === day);
  if (!tonight) {
    await createProposal(db, {
      kind: 'tool_call', origin: `runtime:${cmd}`, templateId: job.templateId, action, args: { day },
      argsProvenance: { day: { source: 'template', ref: job.templateId, tainted: false } },
      tainted: false, sensitivity: 'ops', destructive: false, consequential: false, ttlMinutes: cmd === 'drill' ? 7 * 24 * 60 + 120 : 26 * 60,
      reason: `It waits for your approval each ${cmd === 'drill' ? 'week' : 'night'} until you let it run on its own.`,
    }, 'runtime');
  }
  for (const old of pending) {
    if (old === tonight) continue;
    await rejectProposal(db, old.id, { error: 'replaced by a newer card for the same nightly job' }, rp, 'runtime').catch((err: unknown) =>
      console.error(`${action}: could not withdraw an older card: ${err instanceof Error ? err.message : String(err)}`),
    );
  }
  return { go: false, why: refused ? `the approved proposal could not be claimed (${refused}); asked again` : 'waiting for Will to approve (or promote) it' };
}
