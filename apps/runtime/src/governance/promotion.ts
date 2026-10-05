/**
 * A phase's promotion table (Machine plan 3.0.4): after its shadow week, one
 * signed policy change that moves the phase's autonomous actions to ALONE for
 * 180 days. Built from the code table, filed as an ordinary policy.change
 * proposal Will signs with his key (or does not). P2 and P2.5 each have one,
 * with its own card and its own evidence.
 *
 *  - Refused before 7 days of evidence: P2's shadow decisions; P2.5's calendar
 *    syncs (the source running for a week).
 *  - Never runtime.frontier.complete or triage.rule.create (they stay at
 *    APPROVAL), never anything FORBIDDEN, never an action a pattern of Will's
 *    choosing was dropped for (`--drop`).
 *  - The card's reason carries what the week measured, as numbers only; the
 *    signed rows carry a fixed one.
 *  - Filing the same table again is the same card: a waiting one is reused.
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

/** What P2.5 asks Will to promote (Decision 17: people only through the calendar's PersonGuard). */
export const P25_PROMOTIONS: ReadonlyArray<{ pattern: string; dailyCap?: number }> = [
  { pattern: 'world.sync.google_calendar' },
  { pattern: 'world.person.create', dailyCap: 20 },
];

/** Never in a table, whatever is asked. */
export const NEVER_PROMOTED: ReadonlySet<string> = new Set(['runtime.frontier.complete', 'triage.rule.create', 'world.commitment.from_mail']);

export type Phase = 'p2' | 'p25';

export const SHADOW_DAYS = 7;

export interface PromotionRow {
  pattern: string;
  tier: 'alone';
  dailyCap?: number;
  reason: string;
  expiresAt: string;
}
const DAY = 86_400_000;

/** Each phase's rows, its card's template, what counts as its week of evidence, and what the week measured. */
const PHASES: Record<Phase, {
  rows: ReadonlyArray<{ pattern: string; dailyCap?: number }>;
  template: string;
  label: string;
  evidence: string;
  first: (db: Db) => Promise<Date | undefined>;
  measured: (db: Db, first: Date, now: Date) => Promise<string>;
}> = {
  p2: {
    rows: P2_PROMOTIONS,
    template: 'p2.promotion',
    label: 'P2',
    evidence: 'shadow decisions',
    first: async (db) => (await db.triageDecision.findFirst({ where: { shadow: true }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }))?.createdAt,
    measured: async (db, first, now) => {
      const since = new Date(now.getTime() - 14 * DAY);
      const relevant = await db.triageDecision.count({ where: { lane: 'relevant', createdAt: { gt: since } } });
      const days = Math.max(1, Math.min(14, (now.getTime() - first.getTime()) / DAY));
      const marked = await db.escalation.findMany({ where: { useful: { not: null } }, select: { useful: true } });
      const precision = marked.length ? Math.round((marked.filter((m) => m.useful).length / marked.length) * 100) : null;
      return `${(relevant / days).toFixed(2)} relevant a day; precision ${precision === null ? 'n/a' : `${precision}%`} over ${marked.length} marked`;
    },
  },
  p25: {
    rows: P25_PROMOTIONS,
    template: 'p25.promotion',
    label: 'P2.5',
    evidence: 'calendar syncs',
    // The calendar's first audited sync: the source has been running since.
    first: async (db) => (await db.auditEntry.findFirst({ where: { action: 'world.sync.google_calendar', outcome: 'ok' }, orderBy: { at: 'asc' }, select: { at: true } }))?.at,
    measured: async (db) => {
      const failed = (await db.sourceCursor.findUnique({ where: { source: 'google_calendar' }, select: { consecutiveFailures: true } }))?.consecutiveFailures ?? 0;
      const people = await db.entity.count({ where: { kind: 'person' } });
      const cards = await db.proposal.groupBy({ by: ['status'], where: { action: 'world.person.create' }, _count: { _all: true } });
      const n = (st: string) => cards.find((c) => c.status === st)?._count._all ?? 0;
      return `${people} people known; person cards ${n('executed')} signed, ${n('rejected')} rejected, ${n('expired')} expired; ${failed} sync failure(s) in a row now`;
    },
  },
};

export async function promotionTable(db: Db, opts: { phase?: Phase; drop?: readonly string[]; now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const phase = PHASES[opts.phase ?? 'p2'];
  const first = await phase.first(db);
  if (!first || now.getTime() - first.getTime() < SHADOW_DAYS * DAY) {
    const days = first ? ((now.getTime() - first.getTime()) / DAY).toFixed(1) : '0';
    throw new Refused(409, `the shadow week is not over: ${days} of ${SHADOW_DAYS} days of ${phase.evidence}`);
  }
  const drop = new Set(opts.drop ?? []);
  const patterns = phase.rows.filter((r) => !drop.has(r.pattern) && !NEVER_PROMOTED.has(r.pattern) && CODE_TABLE[r.pattern]?.tier !== 'forbidden' && CODE_TABLE[r.pattern]?.promotable !== false);
  if (!patterns.length) throw new Refused(400, 'nothing left to promote');
  // A card for the same rows already waiting: that one (Will signs one table, not several).
  const waiting = await db.proposal.findMany({ where: { action: 'policy.change', templateId: phase.template, status: 'pending', expiresAt: { gt: now } } });
  const want = patterns.map((r) => r.pattern).sort().join(',');
  for (const w of waiting) {
    const rows = ((w.args as { rows?: Array<{ pattern?: string }> } | null)?.rows ?? []).map((r) => r.pattern).sort().join(',');
    if (rows === want) return { proposalId: w.id, deduped: true, rows: (w.args as unknown as { rows: PromotionRow[] }).rows };
  }
  // The rows are stable for a day (the expiry from the day's start, a fixed reason), so a refiling is the same card.
  const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const expiresAt = new Date(dayStart + 175 * DAY).toISOString();
  const rows: PromotionRow[] = patterns.map((r) => ({ pattern: r.pattern, tier: 'alone' as const, ...(r.dailyCap ? { dailyCap: r.dailyCap } : {}), reason: `${phase.label} promotion table, after the shadow week`, expiresAt }));
  const args = PolicyArgs.parse({ rows });
  // What the week measured goes on the card, outside the signed rows.
  const measured = await phase.measured(db, first, now);
  const p = await createProposal(db, {
    kind: 'policy', origin: 'cli', action: 'policy.change', templateId: phase.template, args,
    argsProvenance: { rows: { source: 'template', ref: phase.template, tainted: false } },
    tainted: false, sensitivity: 'ops', destructive: false, consequential: true, ttlMinutes: 7 * 24 * 60,
    reason: `Promote ${phase.label}'s autonomous actions to ALONE until ${expiresAt.slice(0, 10)} (${rows.length} rows). The shadow week: ${measured}.`.slice(0, 1000),
  }, 'will:cli', now);
  return { proposalId: p.id, deduped: p.deduped, rows };
}
