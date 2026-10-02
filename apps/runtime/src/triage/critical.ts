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
 *  - a source's circuit opening: logged in the relevant lane (closing: quietly).
 *
 * Fields are typed: refs, enums, numbers and hex SHAs. A raised event carries
 * its entity's id, never its name.
 */
import { entityRef } from '@flint/policy';
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
  /** This vendor's cap was already escalated in the last day (the server and the watchdog both see it). */
  vendorCapEscalated?(vendor: string, at: Date): Promise<boolean>;
}

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
  if (name === 'knowledge:knowledge.fact') {
    // Two things and a relation between them: propose the link. Anything else is only logged.
    const linked = typeof f.payload.relation === 'string' && typeof f.payload.fromId === 'string' && typeof f.payload.toId === 'string';
    return { action: linked ? 'act' : 'log', lane: 'quiet', decidedBy: 'code:knowledge.fact', ruleName: 'knowledge.fact', critical: false };
  }
  return undefined;
}
