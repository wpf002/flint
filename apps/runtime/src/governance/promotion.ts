/**
 * A phase's promotion table (Machine plan 3.0.4): after its shadow week, one
 * signed policy change that moves the phase's autonomous actions to ALONE for
 * 180 days. Built from the code table, filed as an ordinary policy.change
 * proposal Will signs with his key (or does not). P1, P2, P2.5 and P2.6 each
 * have one, with its own card and its own evidence.
 *
 *  - Refused before 7 days of evidence: P1's chat reads (since chat first asked
 *    to read the world model or the ledger); P2's shadow decisions; P2.5's
 *    Google Calendar syncs, and P2.6's Apple Calendar syncs (each source
 *    running for a week).
 *  - Never runtime.frontier.complete or triage.rule.create (they stay at
 *    APPROVAL), never anything FORBIDDEN, never an action a pattern of Will's
 *    choosing was dropped for (`--drop`).
 *  - The card's reason says what signing lets Flint do and until when, then what
 *    the week measured, as numbers only, in sentences; the signed rows carry a
 *    fixed one.
 *  - Filing the same table again is the same card: a waiting one is reused.
 */
import { CODE_TABLE, localDay, localDayBounds, previousDay } from '@flint/policy';
import type { Db } from '../db.js';
import { createProposal, Refused } from './proposals.js';
import { PolicyArgs } from './internal.js';

/**
 * What P1 asks Will to promote (the plan's P1 table): chat's reads of the world
 * model and the ledger, which ask for his approval each time until he signs this.
 * Recording a prediction from chat keeps its 10 a day.
 */
export const P1_PROMOTIONS: ReadonlyArray<{ pattern: string; dailyCap?: number }> = [
  // Only the tools the runtime connector serves: a tool added later is not signed for in advance.
  { pattern: 'world_now' },
  { pattern: 'world_entity' },
  { pattern: 'ledger_open' },
  { pattern: 'ledger_calibration' },
  { pattern: 'ledger_record_prediction', dailyCap: 10 },
];
/** How chat files them: an MCP call to the runtime connector. */
const P1_CHAT_ACTIONS = P1_PROMOTIONS.map((r) => `mcp:runtime.${r.pattern}`);

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

/**
 * What P2.6 asks Will to promote: reading Apple Calendar on its own. Creating
 * people keeps its own approval (P2.5's table, or each card), as before.
 */
export const P26_PROMOTIONS: ReadonlyArray<{ pattern: string; dailyCap?: number }> = [
  { pattern: 'world.sync.apple_calendar' },
];

/** Never in a table, whatever is asked. */
export const NEVER_PROMOTED: ReadonlySet<string> = new Set(['runtime.frontier.complete', 'triage.rule.create', 'world.commitment.from_mail']);

export const PHASES_LIST = ['p1', 'p2', 'p25', 'p26'] as const;
export type Phase = (typeof PHASES_LIST)[number];

export const SHADOW_DAYS = 7;

export interface PromotionRow {
  pattern: string;
  tier: 'alone';
  dailyCap?: number;
  reason: string;
  expiresAt: string;
}
const DAY = 86_400_000;
/** "1 time", "3 times". */
const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

interface PhaseOf {
  rows: ReadonlyArray<{ pattern: string; dailyCap?: number }>;
  template: string;
  label: string;
  /** What signing it lets happen without asking, for the card's first sentence. */
  lets: string;
  evidence: string;
  first: (db: Db) => Promise<Date | undefined>;
  /** Why the week does not count yet (it must have been lived, not only begun), or undefined. */
  covered?: (db: Db, now: Date, tz: string) => Promise<string | undefined>;
  measured: (db: Db, first: Date, now: Date) => Promise<string>;
}

const CALENDAR_NAMES = { google_calendar: 'Google Calendar', apple_calendar: 'Apple Calendar' } as const;

/** A calendar phase (P2.5 Google's, P2.6 Apple's): its evidence is that calendar's own week of syncs. */
function calendarPhase(source: keyof typeof CALENDAR_NAMES, rows: PhaseOf['rows'], template: string, label: string, lets: string, evidence: string): PhaseOf {
  const action = `world.sync.${source}`;
  const cal = CALENDAR_NAMES[source];
  return {
    rows,
    template,
    label,
    lets,
    evidence,
    // The calendar's first audited sync: the source has been running since.
    first: async (db) => (await db.auditEntry.findFirst({ where: { action, outcome: 'ok' }, orderBy: { at: 'asc' }, select: { at: true } }))?.at,
    // Each of the 7 whole local days before today had a good sync (one that changed something is an ok
    // audit entry; a quiet one is counted in AuditRollup), and the source synced in the last hour (today).
    // Days are calendar dates, stepped back one at a time: a 23- or 25-hour day is still one day.
    covered: async (db, now, tz) => {
      const want: string[] = [];
      for (let d = previousDay(localDay(tz, now)); want.length < SHADOW_DAYS; d = previousDay(d)) want.push(d);
      const since = localDayBounds(tz, want[want.length - 1]!).start;
      const days = new Set<string>();
      for (const a of await db.auditEntry.findMany({ where: { action, outcome: 'ok', at: { gte: since } }, select: { at: true } })) days.add(localDay(tz, a.at));
      for (const r of await db.auditRollup.findMany({ where: { action, count: { gt: 0 }, day: { gte: want[want.length - 1]! } }, select: { day: true } })) days.add(r.day);
      const missing = want.filter((d) => !days.has(d));
      if (missing.length) return `${SHADOW_DAYS - missing.length} of the ${SHADOW_DAYS} days before today had a good ${cal} sync (none on ${missing.join(', ')})`;
      const last = (await db.sourceCursor.findUnique({ where: { source }, select: { lastOkAt: true } }))?.lastOkAt;
      if (!last || now.getTime() - last.getTime() > 3_600_000) return `${cal} has not synced in the last hour`;
      return undefined;
    },
    measured: async (db, _first, now) => {
      const inRow = (await db.sourceCursor.findUnique({ where: { source }, select: { consecutiveFailures: true } }))?.consecutiveFailures ?? 0;
      const week = await db.auditEntry.count({ where: { action, outcome: 'failed', at: { gt: new Date(now.getTime() - SHADOW_DAYS * DAY) } } });
      const people = await db.entity.count({ where: { kind: 'person' } });
      const cards = await db.proposal.groupBy({ by: ['status'], where: { action: 'world.person.create' }, _count: { _all: true } });
      const n = (st: string) => cards.find((c) => c.status === st)?._count._all ?? 0;
      const knows = people ? `Flint knows ${count(people, 'person', 'people')}.` : 'Flint knows no one yet.';
      const did = [`approved ${count(n('executed'), 'card')} to add people`, ...(n('rejected') ? [`rejected ${n('rejected')}`] : []), ...(n('expired') ? [`let ${n('expired')} expire`] : [])];
      const decided = `You ${did.length > 1 ? `${did.slice(0, -1).join(', ')} and ${did[did.length - 1]}` : did[0]}`;
      const failed = `${week ? count(week, `${cal} read`) : `no ${cal} reads`} failed this week`;
      const inARow = inRow ? ` The last ${inRow === 1 ? `${cal} read` : `${inRow} ${cal} reads`} failed.` : '';
      return `${knows} ${decided}, and ${failed}.${inARow}`;
    },
  };
}

/** Each phase's rows, its card's template, what counts as its week of evidence, and what the week measured. */
const PHASES: Record<Phase, PhaseOf> = {
  p1: {
    rows: P1_PROMOTIONS,
    template: 'p1.promotion',
    label: 'P1',
    lets: 'chat look things up and record predictions',
    evidence: 'chat reads',
    // The first time chat asked to read the world model or the ledger: Will has approved each one since.
    first: async (db) => (await db.proposal.findFirst({ where: { action: { in: P1_CHAT_ACTIONS } }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }))?.createdAt,
    measured: async (db, _first, now) => {
      const asked = await db.proposal.groupBy({ by: ['status'], where: { action: { in: P1_CHAT_ACTIONS }, createdAt: { gt: new Date(now.getTime() - SHADOW_DAYS * DAY) } }, _count: { _all: true } });
      const n = (st: string) => asked.find((c) => c.status === st)?._count._all ?? 0;
      const tainted = await db.proposal.count({ where: { action: { in: P1_CHAT_ACTIONS }, tainted: true, createdAt: { gt: new Date(now.getTime() - SHADOW_DAYS * DAY) } } });
      const total = asked.reduce((s, c) => s + c._count._all, 0);
      if (!total) return 'Chat didn’t ask this week.';
      return `This week chat asked ${count(total, 'time')}: ${n('executed')} ran, ${n('rejected')} ${n('rejected') === 1 ? 'was' : 'were'} rejected, ${n('expired')} expired, and ${tainted || 'none'} had outside text.`;
    },
  },
  p2: {
    rows: P2_PROMOTIONS,
    template: 'p2.promotion',
    label: 'P2',
    lets: 'Flint sort events, send its notes and run its upkeep',
    evidence: 'shadow decisions',
    first: async (db) => (await db.triageDecision.findFirst({ where: { shadow: true }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }))?.createdAt,
    measured: async (db, first, now) => {
      const since = new Date(now.getTime() - 14 * DAY);
      const relevant = await db.triageDecision.count({ where: { lane: 'relevant', createdAt: { gt: since } } });
      const days = Math.max(1, Math.min(14, (now.getTime() - first.getTime()) / DAY));
      const marked = await db.escalation.findMany({ where: { useful: { not: null } }, select: { useful: true } });
      const useful = marked.filter((m) => m.useful).length;
      const rated = !marked.length
        ? 'you haven’t rated any yet'
        : marked.length === 1 ? `the one you rated ${useful ? 'was' : 'wasn’t'} useful` : `${useful} of the ${marked.length} you rated were useful`;
      return `Lately ${(relevant / days).toFixed(1)} items a day were important, and ${rated}.`;
    },
  },
  p25: calendarPhase('google_calendar', P25_PROMOTIONS, 'p25.promotion', 'P2.5', 'Flint read your Google Calendar and add people', 'Google Calendar syncs'),
  p26: calendarPhase('apple_calendar', P26_PROMOTIONS, 'p26.promotion', 'P2.6', 'Flint read your Apple Calendar', 'Apple Calendar syncs'),
};

/** The expiry's date as the console's cards show it (a UTC midnight is that date anywhere): "Mar 29, 2027". */
function untilDay(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

export async function promotionTable(db: Db, opts: { phase?: Phase; drop?: readonly string[]; now?: Date; tz?: string } = {}) {
  const now = opts.now ?? new Date();
  const phase = PHASES[opts.phase ?? 'p2'];
  const first = await phase.first(db);
  if (!first || now.getTime() - first.getTime() < SHADOW_DAYS * DAY) {
    const days = first ? ((now.getTime() - first.getTime()) / DAY).toFixed(1) : '0';
    throw new Refused(409, `the shadow week is not over: ${days} of ${SHADOW_DAYS} days of ${phase.evidence}`);
  }
  const gap = await phase.covered?.(db, now, opts.tz ?? 'UTC');
  if (gap) throw new Refused(409, `the shadow week does not count yet: ${gap}`);
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
    reason: `This lets ${phase.lets} without asking until ${untilDay(expiresAt)}. ${measured}`.slice(0, 1000),
  }, 'will:cli', now);
  return { proposalId: p.id, deduped: p.deduped, rows };
}
