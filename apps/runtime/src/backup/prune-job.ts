/**
 * `prune`, as it is run (P7; the action `backup.prune`): remove the old copies
 * of the database that deploys took before a migration. backup/prune.ts says
 * which stay and what may ever be removed; this is who may do it, and when.
 *
 *  - Run by hand it is Will at the keyboard. It lists what would go, by count
 *    and size, and removes nothing unless he adds `--remove`. A rule of his
 *    that forbids the action forbids it here too.
 *  - Run by the nightly job (`--auto`) it is Flint. The action deletes files,
 *    so it ships at APPROVAL: on a night there is something to remove it files
 *    one card and waits. The card says how many copies would go and how much
 *    room that frees, asks on its own, and is marked as one that cannot be
 *    undone.
 *  - What a card signs is those copies and no others. The card carries their
 *    count, their megabytes and a digest of the list (each one's name, size
 *    and time); the list itself is kept beside Flint's state, and is only
 *    believed when it gives that digest. (While the folder is as it was, what
 *    may go tonight is that list, and gives it.) A run on the card removes the
 *    copies on that list that are still the same files and may still go under
 *    the rule: never one that was not on it, never more room than the card
 *    said. If the folder changed so that none of them may go, or the list
 *    cannot be believed, it removes nothing, and the next night's run files a
 *    new card.
 *  - Once he promotes the action by its own name it runs on its own, once a
 *    day at most, and removes whatever the rule says may go.
 *  - With nothing to remove it ends at once: no card is filed for nothing.
 *
 * Before anything is removed the audit trail says a run is starting (a card's
 * claim writes that; a run with no card writes it here), and nothing goes if
 * that cannot be written. What it did is written after. Both are by count and
 * size, never by name.
 */
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveTier, type WebAuthnRelyingParty } from '@flint/policy';
import { z } from 'zod';
import type { Db } from '../db.js';
import { appendAudit } from '../governance/audit.js';
import { activePolicies, completeProposal } from '../governance/proposals.js';
import { cardGate } from './nightly.js';
import { planPrune, prune, type Copy, type PrunePlan } from './prune.js';

export const PRUNE_ACTION = 'backup.prune';
/** The card the nightly job files, and the job's own name for it. */
export const PRUNE_CARD = { action: PRUNE_ACTION, job: 'prune', templateId: 'nightly.prune' } as const;

/** Whole megabytes, and never "0 MB" for something that is there. */
export const megabytes = (bytes: number): number => Math.max(1, Math.round(bytes / 1e6));

/**
 * How it was asked to run, from what follows `prune` on the command line:
 * nothing lists, `--remove` removes, `--auto` is the nightly job. Anything
 * else (another word, the two together, one of them twice) is refused, so
 * nothing but `--remove` itself can ever mean "remove".
 */
export function pruneMode(argv: readonly string[]): PruneEnv['mode'] {
  if (argv.length === 0) return 'list';
  if (argv.length === 1 && argv[0] === '--remove') return 'remove';
  if (argv.length === 1 && argv[0] === '--auto') return 'auto';
  throw new Error('usage: cli.ts prune [--remove] | prune --auto');
}

// ---- what a card signs ---------------------------------------------------------------

/** What a card says of the copies it is for: how many, how much room, and a digest of the list. */
const Signed = z.object({ copies: z.number().int().min(0), megabytes: z.number().int().min(0), digest: z.string().regex(/^[0-9a-f]{64}$/) });
export type Signed = z.infer<typeof Signed>;

const Listed = z.array(z.object({ name: z.string().regex(/^[0-9a-f]{40}\.dump$/), bytes: z.number().int().min(0), mtimeMs: z.number().min(0) }).strict()).max(10_000);

const total = (copies: readonly Copy[]): number => copies.reduce((n, c) => n + c.bytes, 0);

/** The digest of a list of copies: each one's name, size and time, in the order of their names. */
export function digestOf(copies: readonly Copy[]): string {
  const lines = copies.map((c) => `${c.name}\t${c.bytes}\t${c.mtimeMs}\n`).sort();
  return createHash('sha256').update(lines.join('')).digest('hex');
}

/** What a card for these copies says. */
export const signedFor = (copies: readonly Copy[]): Signed => ({ copies: copies.length, megabytes: copies.length ? megabytes(total(copies)) : 0, digest: digestOf(copies) });

/** Where the lists are kept: beside Flint's state, for this user alone, each named for its digest. */
export const signedDir = (home: string): string => join(home, '.flint', 'prune-plans');
const LIST = /^[0-9a-f]{64}\.json$/;

/** Keep the list a card is about to sign. False when it could not be kept (a run on that card then removes nothing). */
export function keepSigned(home: string, copies: readonly Copy[]): boolean {
  const dir = signedDir(home);
  const file = join(dir, `${digestOf(copies)}.json`);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(`${file}.part`, JSON.stringify(copies.map(({ name, bytes, mtimeMs }) => ({ name, bytes, mtimeMs }))), { mode: 0o600 });
    renameSync(`${file}.part`, file);
    return true;
  } catch {
    return false;
  }
}

/**
 * The copies a card signed, or none. The card's own numbers come first (a card
 * without them signed nothing). The list is read from the file named for the
 * card's digest and believed only when it is a plain file of this user's whose
 * contents give that digest, that count and those megabytes.
 */
export function readSigned(home: string, args: unknown): { card: Signed; copies: Copy[] } | undefined {
  const card = Signed.safeParse(args);
  if (!card.success) return undefined;
  const file = join(signedDir(home), `${card.data.digest}.json`);
  try {
    const st = lstatSync(file);
    if (!st.isFile() || st.uid !== process.getuid?.() || st.size > 4_000_000) return undefined;
    const copies = Listed.parse(JSON.parse(readFileSync(file, 'utf8')));
    const says = signedFor(copies);
    return says.digest === card.data.digest && says.copies === card.data.copies && says.megabytes === card.data.megabytes ? { card: card.data, copies } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Tonight's plan, cut down to what a card signed: only a copy on the card's
 * list that is still the file it listed (the same size and time) and that the
 * rule still lets go today, the oldest first, and never more room than the
 * card said. With no list to believe, nothing.
 */
export function onCard(plan: PrunePlan, signed: { card: Signed; copies: readonly Copy[] } | undefined): PrunePlan {
  const listed = new Map((signed?.copies ?? []).map((c) => [c.name, c]));
  const remove: Copy[] = [];
  let bytes = 0;
  for (const c of plan.remove) {
    const s = listed.get(c.name);
    if (!signed || !s || s.bytes !== c.bytes || s.mtimeMs !== c.mtimeMs) continue;
    if (remove.length >= signed.card.copies || megabytes(bytes + c.bytes) > signed.card.megabytes) break;
    remove.push(c);
    bytes += c.bytes;
  }
  return { ...plan, remove, kept: plan.kept + (plan.remove.length - remove.length), bytes };
}

/** Remove the lists no card that could still run names. Never throws: a list left behind is only a small file. */
async function tidySigned(db: Db, home: string, now: Date): Promise<void> {
  try {
    const dir = signedDir(home);
    const st = lstatSync(dir);
    if (!st.isDirectory() || st.uid !== process.getuid?.()) return;
    const cards = await db.proposal.findMany({ where: { action: PRUNE_ACTION, origin: `runtime:${PRUNE_CARD.job}`, status: { in: ['pending', 'approved'] }, expiresAt: { gt: now } }, select: { args: true } });
    const live = new Set(cards.map((c) => (c.args as { digest?: unknown } | null)?.digest).filter((d): d is string => typeof d === 'string'));
    for (const name of readdirSync(dir)) {
      if (!LIST.test(name) || live.has(name.slice(0, 64))) continue;
      const f = lstatSync(join(dir, name));
      if (f.isFile() && f.uid === process.getuid?.()) unlinkSync(join(dir, name));
    }
  } catch {
    // No folder yet, or the database did not answer: nothing to tidy this time.
  }
}

// ---- the run -------------------------------------------------------------------------

export interface PruneOutcome {
  /**
   *  - nothing: there is nothing to remove;
   *  - held: there is, and the running release could not be told, so nothing is removed;
   *  - listed: run by hand without `--remove`;
   *  - forbidden: run by hand with `--remove`, and a rule of Will's says the action never runs;
   *  - waiting: the nightly job may not remove it yet (`why` says: a card is waiting, a rule forbids it, the cap);
   *  - removed / failed: it removed what it may, or could not remove some of it.
   */
  did: 'nothing' | 'held' | 'listed' | 'forbidden' | 'waiting' | 'removed' | 'failed';
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

  const warn = env.warn ?? console.error;
  const auto = env.mode === 'auto';
  const actor = auto ? 'runtime' : 'will:cli';
  const context = auto ? ('autonomous' as const) : ('console' as const);
  let proposalId: string | undefined;
  if (auto) {
    // The list a card filed tonight would sign, kept before the card exists: a card is never without its list.
    if (!keepSigned(env.home, plan.remove)) warn(`${PRUNE_ACTION}: could not keep the list of copies for tonight's card; a run on that card removes nothing`);
    const g = await cardGate(
      db,
      {
        ...PRUNE_CARD,
        // What the card says beside its day: how much would go, and which. Worked out by this run, nobody's words.
        args: signedFor(plan.remove),
        destructive: true,
        reason: 'It waits for your approval each night there are old backups to remove, until you let it run on its own.',
      },
      env.tz, env.rp, env.now,
    );
    if (g.proposalId) {
      // On a card: what that card signed, and nothing else.
      const card = await db.proposal.findUnique({ where: { id: g.proposalId }, select: { args: true } });
      plan = onCard(plan, readSigned(env.home, card?.args));
    }
    await tidySigned(db, env.home, env.now);
    if (!g.go) return { did: 'waiting', ...said, why: g.why };
    proposalId = g.proposalId;
  } else {
    // By hand it is Will, who needs no card. A rule of his that forbids the action still forbids it.
    const t = resolveTier(PRUNE_ACTION, { context, tainted: false, policies: await activePolicies(db, env.now), now: env.now });
    if (t.tier === 'forbidden') {
      await appendAudit(db, [{ actor, context, kind: 'decision', action: PRUNE_ACTION, tier: 'forbidden', decision: 'deny', outcome: 'denied', inputs: { rule: t.rule }, reasoning: t.reason }]);
      return { did: 'forbidden', ...said };
    }
  }

  // Said before anything goes. A card's claim has said it; a run with no card says it here, and removes nothing if it cannot.
  const run = proposalId ?? `prune${env.now.getTime().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
  if (!proposalId) {
    await appendAudit(db, [{
      actor, context, kind: 'intent', action: PRUNE_ACTION, decision: 'act', outcome: 'pending', correlationId: run,
      inputs: { copies: plan.remove.length, megabytes: plan.remove.length ? megabytes(plan.bytes) : 0 },
    }]);
  }
  const done = prune(plan);
  const ok = done.failed.length === 0;
  const detail = { removed: done.removed.length, megabytes: done.removed.length ? megabytes(done.bytes) : 0, kept: plan.kept + done.failed.length + done.left.length, failed: done.failed.length };
  if (proposalId) {
    // Recording the card's end must not cost the audit entry.
    await completeProposal(db, proposalId, { ok, ...(ok ? {} : { error: 'some copies could not be removed' }), result: detail }, actor).catch((err: unknown) =>
      warn(`${PRUNE_ACTION}: could not complete its proposal: ${err instanceof Error ? err.message : String(err)}`),
    );
  }
  await appendAudit(db, [{ actor, context, kind: 'action', action: PRUNE_ACTION, decision: 'act', outcome: ok ? 'ok' : 'failed', inputs: detail, correlationId: run }]);
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
    case 'forbidden':
      return ['A rule of yours says Flint never removes old update backups, so it removed nothing.'];
    case 'waiting':
      return ['Flint may not remove them on its own yet. Its card is in Approvals.'];
    case 'removed':
      return o.removed === 0 ? [`Flint removed nothing. It keeps ${o.kept}.`] : [`Flint removed ${copies(o.removed)}, which freed ${o.megabytes} MB. It keeps ${o.kept}.`];
    case 'failed':
      return [`Flint removed ${copies(o.removed)} and could not remove ${o.failed}. It tries again the next time this runs.`];
  }
}
