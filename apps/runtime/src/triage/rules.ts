/**
 * Will's triage rules (TriageRule, each one a signed triage.rule.create): a
 * predicate over an event's STRUCTURAL fields only.
 *
 *  - A rule may read only the paths allowlisted for its source and event type
 *    (RULE_PATHS): states, statuses, numbers, labels, never a name or a title.
 *    That is checked when the rule is proposed, before anyone is asked to
 *    sign it, and again when it runs.
 *  - A tainted or missing value makes every operator false, `neq` included:
 *    a stranger's text can never make a rule match by being absent or odd.
 *  - A per-sender daily cap is allowed only where the sender is structural (a
 *    Nexus namespace slug); past it the rule's match is logged quietly.
 */
import { z } from 'zod';
import { isPathTainted, SOURCES } from '@flint/policy';
import type { Action, EventFacts, Lane, Verdict } from './verdict.js';

const OPS = ['eq', 'neq', 'in', 'has', 'gt', 'lt', 'exists'] as const;
const Scalar = z.union([z.string().max(120), z.number().finite(), z.boolean()]);
const Condition = z
  .object({ path: z.string().regex(/^(entity|payload)(\.[A-Za-z0-9_]{1,40}){1,4}$/), op: z.enum(OPS), value: z.union([Scalar, z.array(Scalar).min(1).max(20)]).optional() })
  .strict()
  .superRefine((c, ctx) => {
    if (c.op === 'exists' && c.value !== undefined) ctx.addIssue({ code: 'custom', message: 'exists takes no value' });
    if (c.op === 'in' && !Array.isArray(c.value)) ctx.addIssue({ code: 'custom', message: 'in takes a list' });
    if ((c.op === 'gt' || c.op === 'lt') && typeof c.value !== 'number') ctx.addIssue({ code: 'custom', message: `${c.op} takes a number` });
    if ((c.op === 'eq' || c.op === 'neq' || c.op === 'has') && (c.value === undefined || Array.isArray(c.value))) ctx.addIssue({ code: 'custom', message: `${c.op} takes one value` });
  });
export const Predicate = z
  .object({ all: z.array(Condition).max(10).optional(), any: z.array(Condition).max(10).optional() })
  .strict()
  .refine((p) => (p.all?.length ?? 0) + (p.any?.length ?? 0) > 0, 'a predicate needs at least one condition');
export type Predicate = z.infer<typeof Predicate>;

/** Event sources a rule may name: the world sources, the server's pushed events, the runtime's own. */
const RULE_SOURCES = [...SOURCES, 'server', 'runtime'] as const;

const ENTITY = ['entity.kind', 'entity.status', 'entity.key'];
/** source:eventType -> the paths a rule may read. A wildcard type may read only what every type has. */
export const RULE_PATHS: Readonly<Record<string, readonly string[]>> = {
  'launchd:service.status': [...ENTITY, 'entity.state.loaded', 'entity.state.running', 'entity.state.lastExit'],
  'health:service.health': [...ENTITY, 'entity.state.health'],
  'git:repo.head': [...ENTITY, 'entity.state.branch'],
  'git:deployment.status': [...ENTITY, 'entity.state.status'],
  'spend:account.level': [...ENTITY, 'entity.state.vendor', 'entity.state.level'],
  'github:repo.meta': [...ENTITY, 'entity.state.defaultBranch'],
  'github:issue.state': [...ENTITY, 'entity.state.state', 'entity.state.labels', 'entity.state.number', 'entity.state.byBot'],
  'github:pull_request.state': [...ENTITY, 'entity.state.state', 'entity.state.draft', 'entity.state.number', 'entity.state.byBot'],
  'github:ci_run.state': [...ENTITY, 'entity.state.status', 'entity.state.conclusion', 'entity.state.workflow'],
  'github:deadline.due': [...ENTITY, 'entity.state.dueOn'],
  'railway:service.railway': [...ENTITY, 'entity.state.managedBy'],
  'railway:deployment.railway': [...ENTITY, 'entity.state.status'],
  'nexus:thread.state': [...ENTITY, 'entity.state.status'],
  'server:spend.threshold': ['payload.vendor', 'payload.level', 'payload.period'],
  'server:route.error': ['payload.route', 'payload.status'],
  'deploy:gate.failed': ['payload.component'],
  'deploy:migrate.failed': ['payload.component'],
  'deploy:restart.failed': ['payload.component'],
  'deploy:health.failed': ['payload.component'],
  'deploy:deploy.ok': ['payload.component'],
  'nexus_inbox:handoff.received': ['payload.namespace', 'payload.kind'],
  'nexus_inbox:handoff.unaccepted_24h': ['payload.namespace', 'payload.kind'],
  'knowledge:knowledge.fact': ['payload.kind'],
};
const WILDCARD_PATHS = ENTITY;

/** Where a source's sender is structural (the only place a per-sender cap may apply). */
export const SENDER_PATHS: Readonly<Record<string, string>> = { nexus_inbox: 'payload.namespace' };

export const RuleArgs = z
  .object({
    name: z.string().regex(/^[a-z0-9_.-]{1,80}$/),
    source: z.enum(RULE_SOURCES),
    eventType: z.string().regex(/^(\*|[a-z_]{1,40}(\.[a-z0-9_]{1,40}){0,3})$/),
    predicate: Predicate,
    action: z.enum(['ignore', 'log', 'act', 'escalate']),
    lane: z.enum(['quiet', 'relevant']),
    priority: z.number().int().min(0).max(1000).default(100),
    perSenderDailyCap: z.number().int().min(1).max(100).nullable().default(null),
    createdBy: z.enum(['will', 'flint']),
  })
  .strict();
export type RuleArgs = z.infer<typeof RuleArgs>;

/** Why a rule may not exist (empty: it may). Checked before a proposal is made. */
export function ruleProblems(r: RuleArgs): string[] {
  const problems: string[] = [];
  const allowed = r.eventType === '*' ? WILDCARD_PATHS : RULE_PATHS[`${r.source}:${r.eventType}`];
  if (!allowed) problems.push(`${r.source} has no event type ${r.eventType}`);
  for (const c of [...(r.predicate.all ?? []), ...(r.predicate.any ?? [])]) {
    if (allowed && !allowed.includes(c.path)) problems.push(`${c.path} is not a field a rule may read for ${r.source}:${r.eventType}`);
  }
  if (r.action === 'escalate' && r.lane !== 'relevant') problems.push('an escalation is in the relevant lane');
  if (r.action === 'ignore' && r.lane !== 'quiet') problems.push('an ignored event is in the quiet lane');
  if (r.perSenderDailyCap !== null && !SENDER_PATHS[r.source]) problems.push(`${r.source} has no structural sender for a per-sender cap`);
  return problems;
}

/** A rule as it is stored. */
export interface DbRule {
  name: string;
  source: string;
  eventType: string;
  predicate: unknown;
  action: string;
  lane: string;
  priority: number;
  perSenderDailyCap: number | null;
}

const MISSING = Symbol('missing');

/** The value at an allowlisted path; MISSING when absent, tainted, or not allowlisted. */
function valueAt(f: EventFacts, allowed: readonly string[], path: string): unknown {
  if (!allowed.includes(path)) return MISSING;
  const walk = (root: unknown, parts: string[]) =>
    parts.reduce<unknown>((o, k) => (o !== null && typeof o === 'object' && !Array.isArray(o) && Object.prototype.hasOwnProperty.call(o, k) ? (o as Record<string, unknown>)[k] : MISSING), root);
  if (path.startsWith('entity.')) {
    if (!f.entity) return MISSING;
    const sub = path.slice('entity.'.length);
    if (isPathTainted(sub, f.entity.taintedPaths)) return MISSING;
    const v = walk(f.entity, sub.split('.'));
    return v === undefined || v === null ? MISSING : v;
  }
  // A tainted event's payload holds a stranger's text somewhere: rules read none of it.
  if (f.tainted) return MISSING;
  const v = walk(f.payload, path.slice('payload.'.length).split('.'));
  return v === undefined || v === null ? MISSING : v;
}

function holds(v: unknown, op: string, value: unknown): boolean {
  if (v === MISSING) return false;
  switch (op) {
    case 'exists': return true;
    case 'eq': return v === value;
    case 'neq': return v !== value && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean');
    case 'in': return Array.isArray(value) && value.includes(v);
    case 'has': return Array.isArray(v) && v.includes(value);
    case 'gt': return typeof v === 'number' && typeof value === 'number' && v > value;
    case 'lt': return typeof v === 'number' && typeof value === 'number' && v < value;
    default: return false;
  }
}

export function ruleMatches(rule: DbRule, f: EventFacts): boolean {
  if (rule.source !== f.source || (rule.eventType !== '*' && rule.eventType !== f.type)) return false;
  const p = Predicate.safeParse(rule.predicate);
  if (!p.success) return false;
  const allowed = rule.eventType === '*' ? WILDCARD_PATHS : RULE_PATHS[`${rule.source}:${rule.eventType}`] ?? [];
  const all = p.data.all ?? [];
  const any = p.data.any ?? [];
  return all.every((c) => holds(valueAt(f, allowed, c.path), c.op, c.value)) && (any.length === 0 || any.some((c) => holds(valueAt(f, allowed, c.path), c.op, c.value)));
}

/** The sender slug for a per-sender cap, when the event has a clean one. */
export function senderOf(rule: DbRule, f: EventFacts): string | null {
  const path = SENDER_PATHS[rule.source];
  if (!path || f.tainted) return null;
  const v = (f.payload as Record<string, unknown>)[path.slice('payload.'.length)];
  return typeof v === 'string' && /^[a-z0-9][a-z0-9_-]{0,39}$/.test(v) ? v : null;
}

/** A matching rule's verdict. An escalation names the rule_match template. */
export function ruleVerdict(rule: DbRule, f: EventFacts): Verdict | undefined {
  if (!['ignore', 'log', 'act', 'escalate'].includes(rule.action) || !['quiet', 'relevant'].includes(rule.lane)) return undefined;
  const v: Verdict = { action: rule.action as Action, lane: rule.lane as Lane, decidedBy: `rule:${rule.name}`, ruleName: rule.name, critical: false };
  if (v.action === 'escalate') {
    v.template = { id: 'rule_match', fields: { rule: rule.name, source: f.source, eventType: f.type, entity: f.entity ? `${f.entity.kind}#${f.entity.id.slice(-6)}` : null } };
  }
  if (rule.perSenderDailyCap !== null) {
    const sender = senderOf(rule, f);
    v.perDay = { key: `triage.sender:${rule.name}:${sender ?? 'unknown'}`, limit: rule.perSenderDailyCap };
  }
  return v;
}
