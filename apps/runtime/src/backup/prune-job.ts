/**
 * `prune`, as it is run (P7; the action `backup.prune`): remove the old copies
 * of the database that deploys took before a migration. backup/prune.ts says
 * which stay and what may ever be removed; this is who may do it, and when.
 *
 *  - Run by hand it is Will at the keyboard. It lists what would go, by count
 *    and size, and removes nothing unless he adds `--remove`.
 *  - Run by the nightly job (`--auto`) it is Flint. The action deletes files,
 *    so it ships at APPROVAL: on a night there is something to remove it files
 *    one card and waits. The card says how many copies would go and how much
 *    room that frees, asks on its own, and is marked as one that cannot be
 *    undone. A run on that card removes no more copies than the card said (the
 *    oldest first): what he signed is the most that goes.
 *  - Once he promotes the action by its own name it runs on its own, once a
 *    day at most, and removes whatever the rule says may go.
 *  - With nothing to remove it ends at once: no card is filed for nothing.
 *
 * Every run that removed something, or tried to, is in the audit trail, by
 * count and size, never by name.
 */
import type { WebAuthnRelyingParty } from '@flint/policy';
import type { Db } from '../db.js';
import { appendAudit } from '../governance/audit.js';
import { completeProposal } from '../governance/proposals.js';
import { cardGate } from './nightly.js';
import { planPrune, prune, type PrunePlan } from './prune.js';

export const PRUNE_ACTION = 'backup.prune';
/** The card the nightly job files, and the job's own name for it. */
export const PRUNE_CARD = { action: PRUNE_ACTION, job: 'prune', templateId: 'nightly.prune' } as const;

/** Whole megabytes, and never "0 MB" for something that is there. */
export const megabytes = (bytes: number): number => Math.max(1, Math.round(bytes / 1e6));

export interface PruneOutcome {
  /**
   *  - nothing: there is nothing to remove;
   *  - held: there is, and the running release could not be told, so nothing is removed;
   *  - listed: run by hand without `--remove`;
   *  - waiting: the nightly job may not remove it yet (`why` says: a card is waiting, a rule forbids it, the cap);
   *  - removed / failed: it removed what it may, or could not remove some of it.
   */
  did: 'nothing' | 'held' | 'listed' | 'waiting' | 'removed' | 'failed';
  /** How many copies the rule says may go, and what removing them all frees. */
  would: number;
  megabytes: number;
  kept: number;
  removed: number;
  failed: number;
  why?: string;
}

export interface PruneEnv {
  home: string;
  tz: string;
  rp: WebAuthnRelyingParty | undefined;
  now: Date;
  /** `auto`: the nightly job. `list`: by hand, saying only. `remove`: by hand, removing. */
  mode: 'auto' | 'list' | 'remove';
  warn?: (line: string) => void;
}

export async function pruneJob(db: Db, env: PruneEnv): Promise<PruneOutcome> {
  let plan: PrunePlan = planPrune(env.home, env.now);
  const said = { would: plan.remove.length, megabytes: plan.remove.length ? megabytes(plan.bytes) : 0, kept: plan.kept, removed: 0, failed: 0 };
  if (plan.held) return { did: 'held', ...said };
  if (!plan.remove.length) return { did: 'nothing', ...said };
  if (env.mode === 'list') return { did: 'listed', ...said };

  const auto = env.mode === 'auto';
  const actor = auto ? 'runtime' : 'will:cli';
  let proposalId: string | undefined;
  if (auto) {
    const g = await cardGate(
      db,
      {
        ...PRUNE_CARD,
        // What the card says beside its day: how much would go tonight. Numbers this run worked out, nobody's words.
        args: { copies: said.would, megabytes: said.megabytes },
        destructive: true,
        reason: 'It waits for your approval each night there are old backups to remove, until you let it run on its own.',
      },
      env.tz, env.rp, env.now,
    );
    if (!g.go) return { did: 'waiting', ...said, why: g.why };
    proposalId = g.proposalId;
    if (proposalId) {
      // On a card: no more copies than that card said, the oldest first.
      const card = await db.proposal.findUnique({ where: { id: proposalId }, select: { args: true } });
      const signed = (card?.args as { copies?: unknown } | null)?.copies;
      const most = typeof signed === 'number' && Number.isInteger(signed) && signed >= 0 ? signed : 0;
      const remove = plan.remove.slice(0, most);
      plan = { ...plan, remove, kept: plan.kept + (plan.remove.length - remove.length), bytes: remove.reduce((n, c) => n + c.bytes, 0) };
    }
  }
  const done = prune(plan);
  const ok = done.failed.length === 0;
  const detail = { removed: done.removed.length, megabytes: done.removed.length ? megabytes(done.bytes) : 0, kept: plan.kept + done.failed.length, failed: done.failed.length };
  if (proposalId) {
    // Recording the card's end must not cost the audit entry.
    await completeProposal(db, proposalId, { ok, ...(ok ? {} : { error: 'some copies could not be removed' }), result: detail }, actor).catch((err: unknown) =>
      (env.warn ?? console.error)(`${PRUNE_ACTION}: could not complete its proposal: ${err instanceof Error ? err.message : String(err)}`),
    );
  }
  await appendAudit(db, [{
    actor, context: auto ? 'autonomous' : 'console', kind: 'action', action: PRUNE_ACTION, decision: 'act', outcome: ok ? 'ok' : 'failed', inputs: detail,
    ...(proposalId ? { correlationId: proposalId } : {}),
  }]);
  return { did: ok ? 'removed' : 'failed', would: said.would, megabytes: detail.megabytes, kept: detail.kept, removed: detail.removed, failed: detail.failed };
}

const copies = (n: number): string => (n === 1 ? '1 old update backup' : `${n} old update backups`);

/** What `prune` says when Will runs it himself: whole sentences, counts and sizes, never a file's name. */
export function pruneLines(o: PruneOutcome): string[] {
  switch (o.did) {
    case 'nothing':
      return [o.kept === 0 ? 'There are no update backups to remove.' : `There is nothing to remove. Flint keeps ${o.kept === 1 ? 'the 1 update backup it has' : `all ${o.kept} update backups it has`}.`];
    case 'held':
      return ['Flint could not tell which release is running, so it removed nothing.'];
    case 'listed':
      return [`Flint would remove ${copies(o.would)}, which frees ${o.megabytes} MB. It keeps ${o.kept}.`, 'To remove them, run this again with --remove.'];
    case 'waiting':
      return ['Flint may not remove them on its own yet. Its card is in Approvals.'];
    case 'removed':
      return [`Flint removed ${copies(o.removed)}, which freed ${o.megabytes} MB. It keeps ${o.kept}.`];
    case 'failed':
      return [`Flint removed ${copies(o.removed)} and could not remove ${o.failed}. It tries again the next time this runs.`];
  }
}
