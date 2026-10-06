/**
 * Triage's rules in code (Machine plan P2). A self-modification PR may not
 * touch this directory, no database rule lowers what a critical rule decides,
 * and critical rules never depend on a promotable tier.
 *
 * Critical (escalate; the push goes past its cap and is counted):
 *  - a service down for more than 30 minutes, a backup over 36 h old, a failed
 *    restore drill (all raised by the runtime's own watchdog);
 *  - a vendor at 100% of its cap on the unified view (the server's spend
 *    threshold `exhausted`, or the watchdog's own reading);
 *  - a deploy gate failure, a failed migration (the deploy events);
 *  - CI failing on flint's default branch.
 * Not critical:
 *  - a failed restart or health check after a deploy (it rolled back): escalate;
 *  - more than 5 server route errors in 10 minutes: escalate once per outage;
 *  - a Nexus handoff to Flint unaccepted for 24 h: escalate, once per sender a day;
 *  - a knowledge fact naming two things and a relation: act (a link
 *    proposal, never a person); any other: log;
 *  - a source's circuit opening: logged in the relevant lane (closing: quietly);
 *  - an event or deadline on Will's calendar (Google's, P2.5, or Apple's,
 *    P2.6) within a day: escalate,
 *    once per event and start, with its date and time worked out when triage
 *    decides (logged if it has passed or left the calendar), never its title.
 *
 * Fields are typed: refs, enums, numbers and hex SHAs. A raised event carries
 * its entity's id, never its name.
 */
import { entityRef, localDayBounds } from '@flint/policy';
import type { EventFacts, Template, Verdict } from './verdict.js';

const num = (v: unknown, lo: number, hi: number, dflt: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : dflt);
const sha = (v: unknown) => (typeof v === 'string' && /^[0-9a-f]{7,40}$/.test(v) ? v.slice(0, 12) : null);
const pick = <T extends string>(v: unknown, of: readonly T[]): T | null => (of as readonly unknown[]).includes(v) ? (v as T) : null;
const VENDORS = ['anthropic', 'openai', 'perplexity', 'tavily'] as const;
const STAGES = ['gate', 'restart', 'health'] as const;
/** CI on flint's own default branch: the github source's latest push run. */
const FLINT_CI = /^ci_run:github:[A-Za-z0-9_.-]{1,100}\/flint:latest$/;

/** The raised event's entity, as a ref (the id is all a raised event carries). */
const refOf = (f: EventFacts): string | null => (f.entity ? entityRef(f.entity.kind, f.entity.id) : null);

type Rule = (f: EventFacts) => Template | undefined;

const CRITICAL: Record<string, Rule> = {
  'runtime:service.down_30m': (f) => ({ id: 'service_down', fields: { service: refOf(f), downMinutes: num(f.payload.downMinutes, 30, 100_000, 30) } }),
  'runtime:backup.stale': (f) => ({ id: 'backup_stale', fields: { hoursSince: num(f.payload.hoursSince, 36, 100_000, 36) } }),
  'runtime:drill.failed': (f) => ({ id: 'drill_failed', fields: { mismatches: num(f.payload.mismatches, 0, 1_000_000, 0) } }),
  'runtime:vendor.cap_100': (f) => {
    const vendor = pick(f.payload.vendor, VENDORS);
    return vendor ? { id: 'vendor_cap', fields: { vendor } } : undefined;
  },
  'server:spend.threshold': (f) => {
    const vendor = pick(f.payload.vendor, VENDORS);
    return f.payload.level === 'exhausted' && vendor ? { id: 'vendor_cap', fields: { vendor } } : undefined;
  },
  'deploy:gate.failed': (f) => deployFailed(f, 'gate'),
  'deploy:migrate.failed': (f) => ({ id: 'migrate_failed', fields: { component: f.payload.component === 'runtime' ? 'runtime' : 'server', sha: sha(f.payload.sha) } }),
  // The watchdog's own reading of ~/.flint/runtime/migrate-failed.
  'runtime:migrate.failed': (f) => ({ id: 'migrate_failed', fields: { component: 'runtime', sha: sha(f.payload.sha) } }),
  'github:ci_run.state': (f) => {
    const e = f.entity;
    if (!e || !FLINT_CI.test(e.key) || e.state.status !== 'completed' || e.state.conclusion !== 'failure') return undefined;
    return { id: 'ci_failing', fields: { run: refOf(f), sha: sha(e.state.sha) } };
  },
};

function deployFailed(f: EventFacts, stage: (typeof STAGES)[number]): Template {
  return { id: 'deploy_failed', fields: { component: f.payload.component === 'runtime' ? 'runtime' : 'server', stage, sha: sha(f.payload.sha) } };
}

export function criticalVerdict(f: EventFacts): Verdict | undefined {
  const name = `${f.source}:${f.type}`;
  const template = CRITICAL[name]?.(f);
  if (!template) return undefined;
  return { action: 'escalate', lane: 'relevant', decidedBy: `code:${f.type}`, ruleName: f.type, template, critical: true };
}

/** The ids of the critical templates (they bypass the push cap). */
export const CRITICAL_TEMPLATES: ReadonlySet<string> = new Set(['service_down', 'backup_stale', 'drill_failed', 'vendor_cap', 'deploy_failed', 'migrate_failed', 'ci_failing']);

/** What the non-critical code rules need from the database. */
export interface CodeRuleContext {
  /** Server route errors in the 10 minutes up to `at`. */
  routeErrorsIn10m(at: Date): Promise<number>;
  /** A burst was already escalated in this outage (since the last 30 quiet minutes). */
  burstEscalatedThisOutage(at: Date): Promise<boolean>;
  /**
   * An escalation of this template with this field value was made within the
   * window before `at`. Once escalations are delivered, only one that was
   * (not held) counts: a shadow escalation told nobody.
   */
  escalatedRecently?(templateId: string, field: string, value: string, withinMs: number, at: Date): Promise<boolean>;
  /** When triage decides, and Flint's zone: a heads-up is worked out then, not when its event was read. */
  now?: Date;
  tz?: string;
  /** A heads-up for the same entity was raised after this one (the event moved, and moved again): that one tells it. */
  laterHeadsUp?(entityId: string, type: string, receivedAt: Date): Promise<boolean>;
  /** The time (`until`) of the last heads-up Will was told for this item: the same time is never told twice. */
  lastToldUntil?(item: string): Promise<string | undefined>;
}

/** A heads-up is given from a day before its event to a quarter of an hour after it starts. */
export const UPCOMING_WITHIN_MS = 24 * 3_600_000;
export const UPCOMING_SINCE_MS = 15 * 60_000;

/** The day after a YYYY-MM-DD day. */
function nextDay(d: string): string {
  const [y, m, n] = d.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, n + 1)).toISOString().slice(0, 10);
}

/** The local day (YYYY-MM-DD) and time (HH:mm) of an instant in tz. */
function wallClock(tz: string, at: Date): { day: string; time: string } {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at).map((x) => [x.type, x.value]),
  );
  return { day: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

/**
 * The calendar's heads-up, decided now from the event as it stands: only while
 * it is still on Will's calendar and still ahead (a deadline: due today or
 * tomorrow; an event: within a day, or started under a quarter of an hour ago).
 * Anything later than that is logged quietly: a heads-up for what has passed
 * would be false.
 */
async function calendarUpcoming(f: EventFacts, ctx: CodeRuleContext): Promise<Verdict> {
  const quiet: Verdict = { action: 'log', lane: 'quiet', decidedBy: 'code:calendar.upcoming', ruleName: 'calendar.upcoming.stale', critical: false };
  const moved: Verdict = { ...quiet, ruleName: 'calendar.upcoming.moved' };
  const e = f.entity;
  const item = refOf(f);
  if (!e || e.status !== 'active' || !item || !ctx.now || !ctx.tz) return quiet;
  const now = ctx.now.getTime();
  // Raised for a time the event no longer has, or followed by a newer heads-up for it: that one tells it.
  const raisedFor = typeof f.payload.at === 'string' ? f.payload.at : undefined;
  const current = f.type === 'deadline.upcoming' ? e.state.dueOn : e.state.startsAt;
  if (raisedFor !== undefined && raisedFor !== current) return moved;
  if (await ctx.laterHeadsUp?.(e.id, f.type, f.receivedAt)) return moved;
  let fields: { item: string; kind: 'commitment' | 'deadline'; date: string; time: string | null; until: string };
  if (f.type === 'deadline.upcoming') {
    const dueOn = e.state.dueOn;
    if (e.kind !== 'deadline' || typeof dueOn !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dueOn)) return quiet;
    // Due today or tomorrow, by local day (as the source raised it): a 25-hour day must not put tomorrow out of reach.
    const today = wallClock(ctx.tz, ctx.now).day;
    if (dueOn < today || dueOn > nextDay(today)) return quiet;
    fields = { item, kind: 'deadline', date: dueOn, time: null, until: localDayBounds(ctx.tz, dueOn).end.toISOString() };
  } else {
    const at = typeof e.state.startsAt === 'string' ? Date.parse(e.state.startsAt) : NaN;
    if (e.kind !== 'commitment' || !Number.isFinite(at) || at < now - UPCOMING_SINCE_MS || at > now + UPCOMING_WITHIN_MS) return quiet;
    const w = wallClock(ctx.tz, new Date(at));
    fields = { item, kind: 'commitment', date: w.day, time: e.state.allDay === true ? null : w.time, until: new Date(at).toISOString() };
  }
  // Told already, for this very time (it moved away and back while a heads-up waited): once is enough.
  if ((await ctx.lastToldUntil?.(item)) === fields.until) return { ...quiet, ruleName: 'calendar.upcoming.told' };
  return { action: 'escalate', lane: 'relevant', decidedBy: 'code:calendar.upcoming', ruleName: 'calendar.upcoming', critical: false, template: { id: 'calendar_upcoming', fields } };
}

/** The calendars' heads-ups (`source:type`): Google's (P2.5) and Apple's (P2.6). */
const CALENDAR_UPCOMING: ReadonlySet<string> = new Set(
  ['google_calendar', 'apple_calendar'].flatMap((s) => [`${s}:commitment.upcoming`, `${s}:deadline.upcoming`]),
);

export const ROUTE_ERROR_BURST = 5;

export async function codeVerdict(f: EventFacts, ctx: CodeRuleContext): Promise<Verdict | undefined> {
  const name = `${f.source}:${f.type}`;
  if (name === 'deploy:restart.failed' || name === 'deploy:health.failed') {
    const stage = f.type === 'restart.failed' ? 'restart' : 'health';
    return { action: 'escalate', lane: 'relevant', decidedBy: `code:${f.type}`, ruleName: f.type, template: deployFailed(f, stage), critical: false };
  }
  if (name === 'server:route.error') {
    const count = await ctx.routeErrorsIn10m(f.occurredAt);
    if (count <= ROUTE_ERROR_BURST) return undefined;
    if (await ctx.burstEscalatedThisOutage(f.occurredAt)) {
      return { action: 'log', lane: 'quiet', decidedBy: 'code:route.error_burst', ruleName: 'route.error_burst', critical: false };
    }
    return { action: 'escalate', lane: 'relevant', decidedBy: 'code:route.error_burst', ruleName: 'route.error_burst', template: { id: 'route_errors', fields: { count: Math.min(count, 100_000), minutes: 10 } }, critical: false };
  }
  if (name === 'nexus_inbox:handoff.unaccepted_24h') {
    const ns = typeof f.payload.namespace === 'string' && /^[a-z0-9][a-z0-9_-]{0,39}$/.test(f.payload.namespace) ? f.payload.namespace : null;
    return {
      action: 'escalate', lane: 'relevant', decidedBy: 'code:handoff.unaccepted_24h', ruleName: 'handoff.unaccepted_24h', critical: false,
      template: { id: 'handoff_unaccepted', fields: { handoff: refOf(f), namespace: ns } },
      // Once per sender a day; without a clean sender, once a day for all of them.
      perDay: { key: `notify.handoff:${ns ?? 'unknown'}`, limit: 1 },
    };
  }
  // A source failing 5 times in a row: in the relevant lane, no ping; its recovery quietly.
  if (name === 'runtime:source.circuit_open') return { action: 'log', lane: 'relevant', decidedBy: 'code:source.circuit_open', ruleName: 'source.circuit_open', critical: false };
  if (name === 'runtime:source.circuit_closed') return { action: 'log', lane: 'quiet', decidedBy: 'code:source.circuit_closed', ruleName: 'source.circuit_closed', critical: false };
  // The heads-up the Watcher used to give, once per occurrence of an event at a time (the source's own key),
  // from either of Will's calendars (P2.6: Apple's too).
  if (CALENDAR_UPCOMING.has(name)) return calendarUpcoming(f, ctx);
  if (name === 'knowledge:knowledge.fact') {
    // Two things and a relation between them: propose the link. Anything else is only logged.
    const linked = typeof f.payload.relation === 'string' && typeof f.payload.fromId === 'string' && typeof f.payload.toId === 'string';
    return { action: linked ? 'act' : 'log', lane: 'quiet', decidedBy: 'code:knowledge.fact', ruleName: 'knowledge.fact', critical: false };
  }
  return undefined;
}
