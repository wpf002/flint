/**
 * The P2 promotion table (Machine plan P2 rollout): after the shadow week,
 * one signed policy change that moves P2's autonomous actions to ALONE for
 * 180 days. Built from the code table, filed as an ordinary policy.change
 * proposal Will signs with his key (or does not).
 *
 *  - Refused before 7 days of shadow decisions: the week is the evidence.
 *  - Never runtime.frontier.complete or triage.rule.create (they stay at
 *    APPROVAL), never anything FORBIDDEN, never an action a pattern of Will's
 *    choosing was dropped for (`--drop`).
 *  - The reason carries what the week measured, as numbers only.
 *  - Filing the same table twice is the same proposal.
 */
import { CODE_TABLE } from '@flint/policy';
import type { Db } from '../db.js';
import { createProposal, Refused } from './proposals.js';
import { PolicyArgs } from './internal.js';

/** What P2 asks Will to promote, and the cap each keeps. */
export const P2_PROMOTIONS: ReadonlyArray<{ pattern: string; dailyCap?: number }> = [
  { pattern: 'triage.rule' },
  // Its 120-an-hour cap is in code: a daily cap here would only add a second, looser one.
  { pattern: 'triage.local_model' },
  { pattern: 'notify.inapp' },
  { pattern: 'notify.banner' },
  { pattern: 'notify.push', dailyCap: 3 },
  { pattern: 'health.check' },
  { pattern: 'health.report' },
  { pattern: 'digest.daily' },
  { pattern: 'maintenance.retention' },
  { pattern: 'inbox_recent' },
  { pattern: 'escalations_open' },
  { pattern: 'explain_decision' },
  { pattern: 'world.sync.deploy' },
  { pattern: 'world.sync.knowledge' },
  { pattern: 'world.sync.nexus_inbox' },
];

/** Never in the table, whatever is asked. */
export const NEVER_PROMOTED: ReadonlySet<string> = new Set(['runtime.frontier.complete', 'triage.rule.create']);

export const SHADOW_DAYS = 7;
const DAY = 86_400_000;

export async function promotionTable(db: Db, opts: { drop?: readonly string[]; now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const first = await db.triageDecision.findFirst({ where: { shadow: true }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } });
  if (!first || now.getTime() - first.createdAt.getTime() < SHADOW_DAYS * DAY) {
    const days = first ? ((now.getTime() - first.createdAt.getTime()) / DAY).toFixed(1) : '0';
    throw new Refused(409, `the shadow week is not over: ${days} of ${SHADOW_DAYS} days of shadow decisions`);
  }
  const drop = new Set(opts.drop ?? []);
  // Milliseconds, and inside the database's 180-day limit when Will signs it a few days later.
  const expiresAt = new Date(Math.floor((now.getTime() + 175 * DAY) / 1000) * 1000).toISOString();
  const since = new Date(now.getTime() - 14 * DAY);
  const relevant = await db.triageDecision.count({ where: { lane: 'relevant', createdAt: { gt: since } } });
  const days = Math.max(1, Math.min(14, (now.getTime() - first.createdAt.getTime()) / DAY));
  const marked = await db.escalation.findMany({ where: { useful: { not: null } }, select: { useful: true } });
  const precision = marked.length ? Math.round((marked.filter((m) => m.useful).length / marked.length) * 100) : null;
  const reason = `P2 shadow week: ${(relevant / days).toFixed(2)} relevant a day; precision ${precision === null ? 'n/a' : `${precision}%`} over ${marked.length} marked`;
  const rows = P2_PROMOTIONS.filter((r) => !drop.has(r.pattern) && !NEVER_PROMOTED.has(r.pattern) && CODE_TABLE[r.pattern]?.tier !== 'forbidden' && CODE_TABLE[r.pattern]?.promotable !== false).map((r) => ({
    pattern: r.pattern, tier: 'alone' as const, ...(r.dailyCap ? { dailyCap: r.dailyCap } : {}), reason, expiresAt,
  }));
  if (!rows.length) throw new Refused(400, 'nothing left to promote');
  const args = PolicyArgs.parse({ rows });
  const p = await createProposal(db, {
    kind: 'policy', origin: 'cli', action: 'policy.change', templateId: 'p2.promotion', args,
    argsProvenance: { rows: { source: 'template', ref: 'p2.promotion', tainted: false } },
    tainted: false, sensitivity: 'ops', destructive: false, consequential: true, ttlMinutes: 7 * 24 * 60,
    reason: `Promote P2's autonomous actions to ALONE for 180 days (${rows.length} rows). ${reason}`.slice(0, 1000),
  }, 'will:cli', now);
  return { proposalId: p.id, deduped: p.deduped, rows };
}
