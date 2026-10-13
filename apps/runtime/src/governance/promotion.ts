/**
 * A phase's promotion table (Machine plan 3.0.4): after its shadow week, one
 * signed policy change that moves the phase's autonomous actions to ALONE for
 * 180 days. Built from the code table, filed as an ordinary policy.change
 * proposal Will signs with his key (or does not). P1, P2, P2.5, P2.6 and P3
 * each have one, with its own card and its own evidence; P3 has a second, later
 * one for suggestions from chat (p3c).
 *
 *  - Refused before 7 days of evidence: P1's chat reads (since chat first asked
 *    to read the world model or the ledger); P2's shadow decisions; P2.5's
 *    Google Calendar syncs, and P2.6's Apple Calendar syncs (each source
 *    running for a week); P3's goal reviews (on for each of the 7 days, none
 *    over a day late, the local model answering). p3c needs 14 days of chat's
 *    suggestion cards.
 *  - Never runtime.frontier.complete or triage.rule.create (they stay at
 *    APPROVAL), never anything FORBIDDEN, never an action a pattern of Will's
 *    choosing was dropped for (`--drop`).
 *  - The card's reason says what signing lets Flint do and until when, then what
 *    the week measured, as numbers only, in sentences; the signed rows carry a
 *    fixed one. P3's two tables count the gate and the sentence over one
 *    window, so the card never says a number the gate did not see.
 *  - Filing the same table again is the same card: a waiting one is reused,
 *    but only one this command filed itself, with the very rules it would file
 *    now. A waiting card that only looks like the table's (another cap, another
 *    filer, an evidence sentence of its own) is never returned as the table.
 *  - A policy change always asks on its own: createProposal sets the mark and
 *    the database refuses one without it.
 *
 * The gate is evidence for Will, not the boundary. It reads rows the runtime
 * writes (health checks, reviews, cards), and the runtime's role could write
 * such rows; the database dates them itself, so a week cannot be made in an
 * afternoon, and no more is claimed for it. What stands between a table and
 * its rule is Will's signature over the rows on the card.
 */
import { CODE_TABLE, FORECAST_SIGNED_ACTIONS, GOAL_SIGNED_ACTIONS, PROPHET_ACTIONS, localDay, localDayBounds, previousDay } from '@flint/policy';
import type { Db } from '../db.js';
import { createProposal, Refused } from './proposals.js';
import { PolicyArgs } from './internal.js';
import { chatSuggestions, daysNotRunning, firstReviewAt, overdueNow, reviewCounts, reviewsNow, windowStart } from '../goals/measures.js';
import { CHAT_FLOOR_SAYS, chatFloorInDatabase } from '../goals/candidates.js';

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

/**
 * What P3 asks Will to promote: Flint's goal reviews, out of their trial week.
 * A promoted review files the plan changes it suggests, and each of those is
 * still a card he signs. The local model keeps its 20 reviews a day. Nothing
 * else of P3 is here: the six signed goal and plan actions are never promoted.
 */
export const P3_PROMOTIONS: ReadonlyArray<{ pattern: string; dailyCap?: number }> = [
  { pattern: 'goal.review.local', dailyCap: 20 },
];

/**
 * P3's later table, for suggestions from chat: a goal Flint takes from Will's
 * own quoted words lands as a suggestion (never active), 3 a day at most; a
 * commitment lands unconfirmed, 10 a day at most (the numbers the candidates
 * intake files under while each card still waits for him: @flint/policy
 * SUGGESTIONS_PER_DAY; a test keeps the two the same). It takes two weeks of
 * those cards, not one. Only the goal's row is ever offered (P3C_OFFERED): the
 * database holds a goal from chat to a signed card or rule, and has no such
 * floor under a commitment, so a commitment stays a card.
 */
export const P3C_PROMOTIONS: ReadonlyArray<{ pattern: string; dailyCap?: number }> = [
  { pattern: 'goal.propose', dailyCap: 3 },
  { pattern: 'world.commitment.from_chat', dailyCap: 10 },
];
/** The rows of that table the command offers: what the database has a floor under. */
export const P3C_OFFERED: ReadonlySet<string> = new Set(['goal.propose']);
/** p3c's evidence: two weeks of chat's goal suggestion cards. */
export const P3C_SHADOW_DAYS = 14;

/**
 * Never in a table, whatever is asked: P3's six passkey actions and the Nexus
 * write among them; P4's signed card (turning predictions on) and the outside
 * forecaster's names, which are FORBIDDEN outright. Their code entries are not
 * promotable either; this is belt and braces.
 */
export const NEVER_PROMOTED: ReadonlySet<string> = new Set([
  'runtime.frontier.complete', 'triage.rule.create', 'world.commitment.from_mail', ...GOAL_SIGNED_ACTIONS, 'nexus.remember_goal_decision',
  ...FORECAST_SIGNED_ACTIONS, ...PROPHET_ACTIONS,
]);

export const PHASES_LIST = ['p1', 'p2', 'p25', 'p26', 'p3', 'p3c'] as const;
export type Phase = (typeof PHASES_LIST)[number];

export const SHADOW_DAYS = 7;
/** Who files a table: the CLI, as Will. The audit trail keeps it with the card, and a table reuses only a card it filed. */
const PROMOTION_ACTOR = 'will:cli';

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
  /**
   * Of `rows`, the ones this table offers now, when that depends on what the
   * weeks hold (P3's later table offers commitments only when Flint suggested
   * some: with their switch off there is nothing to promote). Unset: all rows.
   */
  offered?: (db: Db, now: Date, tz: string) => Promise<ReadonlySet<string>>;
  template: string;
  label: string;
  /** What signing it lets happen without asking, for the card's first sentence: said for the rows it holds. */
  lets: string | ((patterns: readonly string[]) => string);
  evidence: string;
  /** Days of evidence it needs (SHADOW_DAYS unless said). */
  shadowDays?: number;
  first: (db: Db) => Promise<Date | undefined>;
  /** Why the week does not count yet (it must have been lived, not only begun), or undefined. */
  covered?: (db: Db, now: Date, tz: string) => Promise<string | undefined>;
  measured: (db: Db, first: Date, now: Date) => Promise<string>;
  /**
   * The gate and the card's sentence from ONE count over one window: why the
   * weeks do not count yet (`gap`), else what they measured. A phase that has
   * it is asked nothing else.
   */
  weighed?: (db: Db, now: Date, tz: string) => Promise<{ gap: string } | { measured: string }>;
  /** The shape of the sentence `weighed` writes on the card, after the card's fixed first one. */
  says?: RegExp;
}

/** "Oct 5": the day a window starts, as the card says it. */
const dayWords = (tz: string, at: Date): string => new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric' }).format(at);

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
  p3: {
    rows: P3_PROMOTIONS,
    template: 'p3.promotion',
    label: 'P3',
    lets: 'Flint review your goals and send its plan suggestions as cards',
    says: /^Since [A-Z][a-z]{2} \d{1,2}, Flint reviewed your goals \d+ times?, and (?:none was|1 was|\d+ were) late\. The local model answered \d+\. It (?:would have suggested|suggested) \d+ changes?\.$/,
    evidence: 'goal reviews',
    // Flint's first review of any goal: the trial week runs from there.
    first: (db) => firstReviewAt(db),
    // The week was lived: reviews were on for each of the 7 whole local days before today (every time the
    // health check looked; a day with nothing due still counts: a weekly goal has no review on most days)
    // and are on right now, none ran over 24 hours late and none is that late now, and the local model
    // answered at least one. Days on are read from the health check's Goal Reviews rows, as goals/late.ts
    // reads them; a late review from its own audit entry. The sentence on the card counts the same reviews,
    // from the same moment: the start of the first of those 7 days.
    covered: async () => undefined,
    measured: async () => '',
    weighed: async (db, now, tz) => {
      if (!(await firstReviewAt(db))) return { gap: 'Flint has not reviewed a goal yet' };
      const { since, missing } = await daysNotRunning(db, tz, now, SHADOW_DAYS);
      if (missing.length) return { gap: `goal reviews were on all day on ${SHADOW_DAYS - missing.length} of the ${SHADOW_DAYS} days before today (not on ${missing.join(', ')})` };
      const today = await reviewsNow(db, now);
      if (today === 'off') return { gap: 'goal reviews are off right now' };
      if (today === 'stopped') return { gap: 'a rule stops goal reviews right now' };
      if (today === 'unknown') return { gap: 'the health check has not looked at goal reviews in the last 15 minutes' };
      const c = await reviewCounts(db, since, now);
      if (c.late) return { gap: `${count(c.late, 'review')} ran over 24 hours late` };
      const waiting = await overdueNow(db, now);
      if (waiting) return { gap: `${count(waiting, 'goal is', 'goals are')} over 24 hours past a review` };
      if (!c.answered) return { gap: 'the local model has not answered a review yet' };
      // Late as the digest counted it, day by day: over an hour. (Over 24 hours, the card is not filed at all.)
      const late = c.lateHour ? `${c.lateHour} ${c.lateHour === 1 ? 'was' : 'were'} late` : 'none was late';
      // In the trial week a review files nothing: it records what it would have suggested.
      const suggested = `${c.shadow === c.reviews ? 'It would have suggested' : 'It suggested'} ${count(c.suggested, 'change')}.`;
      return { measured: `Since ${dayWords(tz, since)}, Flint reviewed your goals ${count(c.reviews, 'time')}, and ${late}. The local model answered ${c.answered}. ${suggested}` };
    },
  },
  p3c: {
    rows: P3C_PROMOTIONS,
    template: 'p3c.promotion',
    label: 'P3 chat',
    lets: (patterns) => (patterns.includes('world.commitment.from_chat') ? 'Flint take goals and commitments from your chats' : 'Flint suggest goals from your chats'),
    // Goals only: a commitment is never added without a card (the database has no floor under one), so its row
    // is never offered, however many were suggested.
    offered: async () => P3C_OFFERED,
    evidence: 'goal suggestions from chat',
    shadowDays: P3C_SHADOW_DAYS,
    says: /^Since [A-Z][a-z]{2} \d{1,2}, Flint suggested \d+ goals? from chat: you approved \d+, made \d+ into goals yourself, rejected \d+, and \d+ expired\.$/,
    // The first goal chat suggested: Will has signed or rejected each one since.
    first: async (db) => (await db.proposal.findFirst({ where: { action: { in: [...P3C_OFFERED] } }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }))?.createdAt,
    // Two weeks of suggestions means there were some: the 14 whole local days before today, and today. The
    // card that opened the gate is 14 days old, so it is inside that window; one much older, with nothing
    // since, is not two weeks of evidence. The sentence counts the same cards: the goal's, the row it signs.
    covered: async () => undefined,
    measured: async () => '',
    weighed: async (db, now, tz) => {
      const since = windowStart(tz, now, P3C_SHADOW_DAYS);
      const g = await chatSuggestions(db, { since, actions: [...P3C_OFFERED] });
      if (!g.filed) return { gap: `Flint suggested no goal from chat in the last ${P3C_SHADOW_DAYS} days` };
      // Making a suggestion a goal himself is a yes, counted as one (it sets the suggestion's own card aside).
      return { measured: `Since ${dayWords(tz, since)}, Flint suggested ${count(g.filed, 'goal')} from chat: you approved ${g.executed}, made ${g.made} into goals yourself, rejected ${g.rejected}, and ${g.expired} expired.` };
    },
  },
};

/** The expiry's date as the console's cards show it (a UTC midnight is that date anywhere): "Mar 29, 2027". */
function untilDay(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

/** A waiting card's rules, as far as they can be read. */
const rulesOf = (args: unknown): Array<Record<string, unknown>> => {
  const rows = (args as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? rows.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object' && !Array.isArray(r)) : [];
};

/**
 * Are a waiting card's rules the very rules this table would file now? Each
 * pattern once, ALONE, with the table's cap and its fixed reason and nothing
 * else on the row; one last day for all of them, no later than today's table
 * would give. (An earlier day's table, still waiting, is the same table.)
 */
function sameRules(theirs: Array<Record<string, unknown>>, mine: readonly PromotionRow[], now: Date): boolean {
  if (theirs.length !== mine.length) return false;
  const until = theirs[0]?.expiresAt;
  if (typeof until !== 'string' || !(Date.parse(until) > now.getTime()) || Date.parse(until) > Date.parse(mine[0]!.expiresAt)) return false;
  return mine.every((m) => {
    const t = theirs.filter((r) => r.pattern === m.pattern);
    if (t.length !== 1) return false;
    const r = t[0]!;
    const keys = Object.keys(r).sort().join(',');
    return keys === Object.keys({ ...m }).sort().join(',') && r.tier === 'alone' && r.dailyCap === m.dailyCap && r.reason === m.reason && r.expiresAt === until;
  });
}

export async function promotionTable(db: Db, opts: { phase?: Phase; drop?: readonly string[]; now?: Date; tz: string }) {
  const now = opts.now ?? new Date();
  const phase = PHASES[opts.phase ?? 'p2'];
  // Nothing from chat runs without a card unless the database itself holds what it adds to a signed card or rule
  // (goals/candidates.ts chatFloorInDatabase, asked of the database now): without that guard this table is not
  // filed at all, however many weeks have been lived.
  if (opts.phase === 'p3c' && !(await chatFloorInDatabase(db))) throw new Refused(409, CHAT_FLOOR_SAYS);
  const first = await phase.first(db);
  const need = phase.shadowDays ?? SHADOW_DAYS;
  if (!first || now.getTime() - first.getTime() < need * DAY) {
    const days = first ? (Math.max(0, now.getTime() - first.getTime()) / DAY).toFixed(1) : '0';
    throw new Refused(409, `the shadow ${need === SHADOW_DAYS ? 'week is' : 'weeks are'} not over: ${days} of ${need} days of ${phase.evidence}`);
  }
  // One count for the gate and for the card's sentence, where a phase has one (P3's two tables).
  const weighed = await phase.weighed?.(db, now, opts.tz);
  const gap = weighed ? ('gap' in weighed ? weighed.gap : undefined) : await phase.covered?.(db, now, opts.tz);
  if (gap) throw new Refused(409, `the shadow ${need === SHADOW_DAYS ? 'week does' : 'weeks do'} not count yet: ${gap}`);
  const drop = new Set(opts.drop ?? []);
  const offered = await phase.offered?.(db, now, opts.tz);
  const patterns = phase.rows.filter((r) => (!offered || offered.has(r.pattern)) && !drop.has(r.pattern) && !NEVER_PROMOTED.has(r.pattern) && CODE_TABLE[r.pattern]?.tier !== 'forbidden' && CODE_TABLE[r.pattern]?.promotable !== false);
  const lets = typeof phase.lets === 'function' ? phase.lets(patterns.map((r) => r.pattern)) : phase.lets;
  if (!patterns.length) throw new Refused(400, 'nothing left to promote');
  // The rows are stable for a day (the expiry from the day's start, a fixed reason), so a refiling is the same card.
  const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const expiresAt = new Date(dayStart + 175 * DAY).toISOString();
  const rows: PromotionRow[] = patterns.map((r) => ({ pattern: r.pattern, tier: 'alone' as const, ...(r.dailyCap ? { dailyCap: r.dailyCap } : {}), reason: `${phase.label} promotion table, after the shadow ${need === SHADOW_DAYS ? 'week' : 'weeks'}`, expiresAt }));
  const args = PolicyArgs.parse({ rows });
  // This table's own card, still waiting: that one (Will signs one table, not several). Its own means this
  // command filed it (the audit trail's actor), as Will's card that asks on its own, with the very rules it
  // would file now and the reason this command writes for them. A waiting card that only carries the table's
  // name is not it, whatever it says.
  const ownReason = (w: { reason: string | null; args: unknown }): boolean => {
    // The fixed first sentence, for that card's own last day; then, for a table whose gate writes one, a
    // sentence of the gate's shape. (Its numbers were true when it was filed; they are evidence, not checked here.)
    const lead = `This lets ${lets} without asking until ${untilDay(String(rulesOf(w.args)[0]?.expiresAt ?? ''))}. `;
    return typeof w.reason === 'string' && w.reason.startsWith(lead) && (!phase.says || phase.says.test(w.reason.slice(lead.length)));
  };
  const own = async (w: { id: string; origin: string; consequential: boolean; args: unknown; reason: string | null }): Promise<boolean> =>
    w.origin === 'cli' && w.consequential === true && sameRules(rulesOf(w.args), rows, now) && ownReason(w)
    && (await db.auditEntry.count({ where: { correlationId: w.id, kind: 'decision', action: 'policy.change', decision: 'queue', actor: PROMOTION_ACTOR } })) > 0;
  const waiting = await db.proposal.findMany({ where: { action: 'policy.change', templateId: phase.template, status: 'pending', expiresAt: { gt: now } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  for (const w of waiting) {
    if (await own(w)) return { proposalId: w.id, deduped: true, rows: (w.args as unknown as { rows: PromotionRow[] }).rows };
  }
  // What the week measured goes on the card, outside the signed rows.
  const measured = weighed && 'measured' in weighed ? weighed.measured : await phase.measured(db, first, now);
  const p = await createProposal(db, {
    kind: 'policy', origin: 'cli', action: 'policy.change', templateId: phase.template, args,
    argsProvenance: { rows: { source: 'template', ref: phase.template, tainted: false } },
    tainted: false, sensitivity: 'ops', destructive: false, consequential: true, ttlMinutes: 7 * 24 * 60,
    reason: `This lets ${lets} without asking until ${untilDay(expiresAt)}. ${measured}`.slice(0, 1000),
  }, PROMOTION_ACTOR, now);
  // The same rules, already waiting on a card this command did not file (a proposal is one card for its
  // args): never handed back as the table's own. It is named by its id alone, for Will to reject.
  if (p.deduped) {
    const there = await db.proposal.findUnique({ where: { id: p.id } });
    if (!there || !(await own(there))) throw new Refused(409, `a card with these rules is already waiting, and this command did not file it: reject card ${p.id} in Approvals, then run this again`);
  }
  return { proposalId: p.id, deduped: p.deduped, rows };
}
