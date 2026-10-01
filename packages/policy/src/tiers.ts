/**
 * The tier engine: may Flint take this action alone, only with Will's approval,
 * or never? (Machine plan 3.0.3.)
 *
 * resolveTier works through six steps, in order, and an earlier step can only be
 * made STRICTER by a later one:
 *
 *  1. FORBIDDEN rules in code: NEVER_AUTO names, merges, trading pools, policy
 *     self-edits, self-modification outside the path allowlist, notification
 *     content pushes, anything about people, audit edits, prediction edits.
 *     Nothing below can loosen these.
 *  2. Context rules. An autonomous context may run only the closed
 *     AUTONOMOUS_ACTIONS list: no MCP tool and nothing else, ever. A tainted chat
 *     turn moves every network-egress tool and every write to at least APPROVAL.
 *  3. An active ActionPolicy row (created only from an approved policy proposal)
 *     may loosen an APPROVAL entry to ALONE, if that entry is promotable. Any row
 *     may tighten. A row can never loosen steps 1 or 2.
 *  4. The code table. Every entry the Machine plan adds is APPROVAL or FORBIDDEN.
 *  5. MCP tools in chat or the console (today's behaviour, kept for untainted
 *     turns): `readOnlyHint` from a TRUSTED_READONLY server, or a name that
 *     passes isSafeTool, is ALONE; anything else is APPROVAL.
 *  6. Unknown: APPROVAL.
 *
 * MCP tools and Flint's own actions live in separate name spaces: an MCP server
 * called `ledger` exposing `void` is the key `mcp:ledger.void`, never the code
 * table's `ledger.void`.
 */
import { MONEY_SEGMENTS, NEVER_AUTO, isSafeTool, segmentsOf } from './tool-safety.js';
import { selfmodPathAllowed } from './selfmod-paths.js';

export type Tier = 'alone' | 'approval' | 'forbidden';
export type ActionContext = 'chat' | 'autonomous' | 'console';
export type Sensitivity = 'ops' | 'personal' | 'financial';

const RANK: Record<Tier, number> = { alone: 0, approval: 1, forbidden: 2 };
/** The stricter of two tiers. */
export const stricter = (a: Tier, b: Tier): Tier => (RANK[a] >= RANK[b] ? a : b);

export interface Cap {
  limit: number;
  period: 'day' | 'week';
}

export interface CodeEntry {
  tier: Tier;
  /** May an ActionPolicy row loosen it to ALONE? */
  promotable: boolean;
  cap?: Cap;
  /** Sends data off the box or takes Will's attention (plan 3.0.4). */
  egress?: boolean;
  /** Changes something (anything but a read). */
  write?: boolean;
  note?: string;
}

/** The world-model sources. Each `world.sync.<source>` reaches only its own endpoints. */
export const SOURCES = ['launchd', 'health', 'git', 'spend', 'github', 'railway', 'nexus'] as const;
export type Source = (typeof SOURCES)[number];

const approval = (extra: Partial<CodeEntry> = {}): CodeEntry => ({ tier: 'approval', promotable: true, write: true, ...extra });
const fixed = (extra: Partial<CodeEntry> = {}): CodeEntry => ({ tier: 'approval', promotable: false, write: true, ...extra });
const forbidden = (note: string): CodeEntry => ({ tier: 'forbidden', promotable: false, write: true, note });

/**
 * Step 4: every action Flint's own code can take, and Flint's built-in chat
 * tools. New entries ship at APPROVAL (plan 3.0.4); Will promotes them by signing
 * a policy proposal, never by editing this table from Flint.
 */
export const CODE_TABLE: Readonly<Record<string, CodeEntry>> = {
  // World model (P1). The sync's endpoints are the source's scope.
  ...Object.fromEntries(SOURCES.map((s) => [`world.sync.${s}`, approval({ note: `read-only sync of the ${s} source's fixed endpoints` })])),
  'world.source.enable': fixed({ note: 'turning a source on is an approval' }),
  'world.entity.write': approval(),
  'world.relation.write': approval(),
  'world.entity.merge': fixed({ note: 'stays APPROVAL (passkey)' }),
  'world.forget': fixed({ note: 'stays APPROVAL (passkey)' }),
  // Ledger (P1).
  'ledger.prediction.record': approval({ cap: { limit: 50, period: 'day' } }),
  'ledger.resolve.auto': approval({ note: 'world or metric resolution; cannot VOID' }),
  'ledger.expire': approval({ note: 'marks predictions past resolveBy as expired' }),
  'ledger.calibration.snapshot': approval(),
  'ledger.void': fixed({ note: 'stays APPROVAL (passkey)' }),
  'ledger.resolution.correct': fixed({ note: 'stays APPROVAL (passkey)' }),
  // Chat tools over the world and the ledger. Reads, but they can taint the turn.
  world_now: approval({ write: false }),
  world_entity: approval({ write: false }),
  world_search: approval({ write: false }),
  world_history: approval({ write: false }),
  ledger_open: approval({ write: false }),
  ledger_calibration: approval({ write: false }),
  ledger_record_prediction: approval({ cap: { limit: 10, period: 'day' } }),
  // Backups (P1).
  'backup.local': approval({ cap: { limit: 1, period: 'day' } }),
  'restore.drill': approval({ cap: { limit: 1, period: 'week' }, note: 'into a scratch database' }),
  'backup.offsite': approval({ cap: { limit: 1, period: 'day' }, egress: true, note: 'age-encrypted, to iCloud' }),
  // Housekeeping the runtime does to its own tables.
  'maintenance.retention': approval({ note: 'nulls payloads and args past their retention' }),
  'maintenance.partitions': approval({ note: 'creates audit partitions; dropping one is partition_drop' }),
  'maintenance.partition_drop': fixed({ note: 'drops an audit month; needs a partition_drop approval' }),
  // Policy. Never promotable: a rule change always needs Will's signature.
  'policy.change': fixed(),
  // Forbidden outright (also caught by step 1; listed so the table is complete).
  'world.person.create': forbidden('no collection on people in P1'),
  'audit.update': forbidden('the audit trail is append-only'),
  'audit.delete': forbidden('the audit trail is append-only'),
  'ledger.prediction.edit': forbidden('a prediction is never edited after it is made'),
  // Existing built-in chat tools keep today's behaviour (they ran without asking),
  // now audited; a tainted turn still moves their egress and writes to APPROVAL.
  calculate: { tier: 'alone', promotable: false, write: false },
  spend_status: { tier: 'alone', promotable: false, write: false },
  training_status: { tier: 'alone', promotable: false, write: false },
  remember: { tier: 'alone', promotable: false, write: true, note: "writes only Flint's local memory" },
  deep_research: { tier: 'alone', promotable: false, write: false, egress: true },
};

/**
 * Step 2: the ONLY actions an autonomous context may take. Closed: adding one is
 * a code change Will reviews. No MCP tool is ever on it.
 */
export const AUTONOMOUS_ACTIONS: ReadonlySet<string> = new Set([
  ...SOURCES.map((s) => `world.sync.${s}`),
  'world.entity.write',
  'world.relation.write',
  'ledger.prediction.record',
  'ledger.resolve.auto',
  'ledger.expire',
  'ledger.calibration.snapshot',
  'backup.local',
  'restore.drill',
  'backup.offsite',
  'maintenance.retention',
  'maintenance.partitions',
]);

/** Step 5: servers whose `readOnlyHint` is believed. Any other server's hint is ignored. */
export const TRUSTED_READONLY: ReadonlySet<string> = new Set(['runtime', 'nexus', 'web', 'github-observer']);

/**
 * MCP servers whose tools stay inside Will's own systems: the runtime on this
 * Mac, and Nexus (his memory service). Every OTHER server's tools count as
 * network egress, because any of them can carry text to a third party (a search
 * query is enough: `trident.web_search` sends it to a vendor). Deny by default:
 * a new server is egress until it is added here in a reviewed change.
 */
export const INTERNAL_SERVERS: ReadonlySet<string> = new Set(['runtime', 'nexus']);
/** Name segments that mean a request leaves the box, even on an internal server. */
const EGRESS_SEGMENTS: ReadonlySet<string> = new Set([
  'fetch', 'url', 'http', 'https', 'request', 'download', 'browse', 'crawl', 'scrape', 'webhook', 'research', 'perplexity',
  'web', 'send', 'post', 'upload', 'email', 'mail', 'notify', 'publish', 'share',
]);

/** Step 1 name lists. */
const FORBIDDEN_ACTIONS: ReadonlySet<string> = new Set([
  'audit.update', 'audit.delete', 'ledger.prediction.edit', 'notify.push_with_content', 'world.person.create',
]);
/** The one `merge` that is not a code merge: joining two world entities. */
const MERGE_EXEMPT: ReadonlySet<string> = new Set(['world.entity.merge']);
const PERSON_SEGMENTS: ReadonlySet<string> = new Set(['person', 'persons', 'people', 'whois']);
/** Self-modification actions that carry the files they touch. */
const SELFMOD_PATH_ACTIONS: ReadonlySet<string> = new Set(['selfmod.attempt', 'selfmod.open_pr']);

export interface McpFacts {
  server: string;
  tool: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
}

export interface PolicyRow {
  pattern: string;
  tier: Tier;
  dailyCap?: number | null;
  /** What the promotion covers ({endpoints}, {series}, {namespaces}). A scoped row promotes only when ctx.scopeAllows says this call is inside it. */
  scope?: unknown;
  active: boolean;
  expiresAt: Date | string;
}

export interface TierContext {
  context: ActionContext;
  /** The turn (or job) has read untrusted text. */
  tainted: boolean;
  sensitivity?: Sensitivity;
  /** Set when the action is an MCP tool call. */
  mcp?: McpFacts;
  /** For self-modification: the repo-relative files the change touches. */
  paths?: readonly string[];
  /** For dispatch: the target pool. */
  pool?: string;
  /** ActionPolicy rows; inactive and expired ones are ignored here. */
  policies?: readonly PolicyRow[];
  /** Is this call inside a row's scope? Without it, a scoped row never promotes (it may still tighten). */
  scopeAllows?: (scope: unknown) => boolean;
  now?: Date;
}

export type TierRule =
  | 'forbidden'
  | 'autonomous'
  | 'tainted'
  | 'policy'
  | 'code'
  | 'mcp-trusted-readonly'
  | 'mcp-safe-name'
  | 'mcp'
  | 'unknown';

export interface TierDecision {
  tier: Tier;
  /** The step that decided. */
  rule: TierRule;
  reason: string;
  /** The key policies and caps are matched on: the action, or `mcp:server.tool`. */
  key: string;
  cap?: Cap;
  /** The ActionPolicy pattern that loosened or tightened it, if any. */
  policyPattern?: string;
}

/** The name policies and caps are keyed on. */
export function actionKey(action: string, mcp?: McpFacts): string {
  return mcp ? `mcp:${mcp.server}.${mcp.tool}` : action;
}

/** Does an ActionPolicy pattern cover this key? Exact, or `prefix.*`. A bare `*` matches nothing. */
export function patternMatches(pattern: string, key: string): boolean {
  if (pattern === key) return true;
  if (!pattern.endsWith('.*') || pattern.length < 3) return false;
  return key.startsWith(pattern.slice(0, -1));
}

/**
 * The words of a name, splitting camelCase as well as punctuation:
 * `github.mergePullRequest` -> [github, merge, pull, request]. The forbidden
 * rules use this; isSafeTool keeps its own (stricter) segmenting.
 */
export function wordsOf(name: string): string[] {
  return segmentsOf(name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2'));
}

/** Step 1. The reason it is forbidden, or undefined. */
export function forbiddenReason(action: string, ctx: Pick<TierContext, 'mcp' | 'paths' | 'pool'>): string | undefined {
  const name = ctx.mcp ? `${ctx.mcp.server}.${ctx.mcp.tool}` : action;
  const segs = wordsOf(name);
  // NEVER_AUTO on the raw name and on its snake_case form (placeOrder -> place_order).
  if (NEVER_AUTO.test(name) || NEVER_AUTO.test(segs.join('_'))) return 'trades and money movement are never run (NEVER_AUTO)';
  if (!ctx.mcp && FORBIDDEN_ACTIONS.has(action)) return `${action} is forbidden`;
  // Any merge an MCP tool can do is a code or record merge Will makes himself;
  // a substring match catches `automerge` and `squashmerge` too.
  if (ctx.mcp ? /merge/i.test(ctx.mcp.tool) || /merge/i.test(ctx.mcp.server) : segs.includes('merge') && !MERGE_EXEMPT.has(action)) {
    return 'Flint never merges; Will does';
  }
  if (ctx.pool && /trad|broker|exchange/i.test(ctx.pool)) return `pool ${ctx.pool} trades`;
  if (!ctx.mcp && action.startsWith('policy.') && action !== 'policy.change') return 'policy is changed only through policy.change';
  if (!ctx.mcp && action.startsWith('selfmod.')) {
    if (SELFMOD_PATH_ACTIONS.has(action)) {
      const paths = ctx.paths ?? [];
      if (paths.length === 0) return `${action} must name the files it touches`;
      const bad = paths.filter((p) => !selfmodPathAllowed(p));
      if (bad.length) return `outside the self-modification allowlist: ${bad.slice(0, 3).join(', ')}`;
    } else if (action !== 'selfmod.comment_on_own_pr') {
      return `${action} is not a self-modification action`;
    }
  }
  if (segs.some((s) => PERSON_SEGMENTS.has(s))) return 'no collection on people';
  return undefined;
}

/** Network egress: a request leaves the box (or may: an unknown server counts). */
export function isEgress(action: string, mcp?: McpFacts): boolean {
  if (!mcp) return CODE_TABLE[action]?.egress === true;
  if (!INTERNAL_SERVERS.has(mcp.server)) return true;
  return wordsOf(mcp.tool).some((s) => EGRESS_SEGMENTS.has(s));
}

/** Writes anything. An MCP tool is a write unless its name proves it is a read and it is not marked destructive. */
export function isWrite(action: string, mcp?: McpFacts): boolean {
  if (!mcp) return CODE_TABLE[action]?.write ?? true;
  if (mcp.destructiveHint) return true;
  if (mcp.readOnlyHint && TRUSTED_READONLY.has(mcp.server)) return false;
  return !isSafeTool(`${mcp.server}.${mcp.tool}`);
}

/** Any money word in the name (camelCase split), or a NEVER_AUTO match. */
export function touchesMoney(name: string): boolean {
  const words = wordsOf(name);
  return NEVER_AUTO.test(name) || NEVER_AUTO.test(words.join('_')) || words.some((w) => MONEY_SEGMENTS.has(w) || w === 'swap' || w === 'trade');
}

const live = (p: PolicyRow, now: Date): boolean => p.active && new Date(p.expiresAt).getTime() > now.getTime();

/** Steps 4 to 6: the tier before policies and context floors. */
function baseTier(action: string, ctx: TierContext): Omit<TierDecision, 'key'> & { promotable: boolean } {
  if (ctx.mcp) {
    const { server, tool, readOnlyHint, destructiveHint } = ctx.mcp;
    if (destructiveHint) return { tier: 'approval', rule: 'mcp', reason: `${server} marks ${tool} destructive`, promotable: true };
    if (readOnlyHint && TRUSTED_READONLY.has(server)) {
      return { tier: 'alone', rule: 'mcp-trusted-readonly', reason: `${server} is trusted and marks ${tool} read-only`, promotable: false };
    }
    if (isSafeTool(`${server}.${tool}`)) return { tier: 'alone', rule: 'mcp-safe-name', reason: 'the name proves a read', promotable: false };
    // A name that touches money (a trade, a payment, an order) stays APPROVAL
    // whatever a policy row says: `mcp:hive.*` ALONE must not reach `hive.open_position`.
    if (touchesMoney(`${server}.${tool}`)) return { tier: 'approval', rule: 'mcp', reason: 'it may move money', promotable: false };
    return { tier: 'approval', rule: 'mcp', reason: 'a tool that may write', promotable: true };
  }
  const entry = CODE_TABLE[action];
  if (entry) {
    return {
      tier: entry.tier,
      rule: 'code',
      reason: entry.note ?? `${action} is ${entry.tier.toUpperCase()} in code`,
      promotable: entry.promotable,
      ...(entry.cap ? { cap: entry.cap } : {}),
    };
  }
  return { tier: 'approval', rule: 'unknown', reason: `${action} is not in the code table`, promotable: false };
}

/** Decide the tier of one action. Pure: same inputs, same answer. */
export function resolveTier(action: string, ctx: TierContext): TierDecision {
  const key = actionKey(action, ctx.mcp);
  const now = ctx.now ?? new Date();

  // 1. Forbidden in code.
  const why = forbiddenReason(action, ctx);
  if (why) return { tier: 'forbidden', rule: 'forbidden', reason: why, key };

  // 2a. Autonomous: the closed list, and never an MCP tool. Any context that is
  // not exactly chat or console is treated as autonomous (fail closed).
  const autonomous = ctx.context !== 'chat' && ctx.context !== 'console';
  if (autonomous) {
    if (ctx.mcp) return { tier: 'forbidden', rule: 'autonomous', reason: 'no MCP tool runs autonomously', key };
    if (!AUTONOMOUS_ACTIONS.has(action)) return { tier: 'forbidden', rule: 'autonomous', reason: `${action} is not an autonomous action`, key };
  }

  // 4-6. The base tier.
  const base = baseTier(action, ctx);
  let decision: TierDecision = {
    tier: base.tier,
    rule: base.rule,
    reason: base.reason,
    key,
    ...(base.cap ? { cap: base.cap } : {}),
  };

  // 2b. The floor a tainted chat turn, or personal data headed off the box, sets.
  const egress = isEgress(action, ctx.mcp);
  const tainted = ctx.tainted && !autonomous && (egress || isWrite(action, ctx.mcp));
  const sensitive = egress && (ctx.sensitivity === 'personal' || ctx.sensitivity === 'financial');
  const floored = tainted || sensitive;

  // 3. Policies: any live row may tighten; a row may loosen only a promotable
  // APPROVAL entry, and never below a step-2 floor.
  const rows = (ctx.policies ?? []).filter((p) => live(p, now) && patternMatches(p.pattern, key));
  const tightest = rows.reduce<PolicyRow | undefined>((t, p) => (!t || RANK[p.tier] > RANK[t.tier] ? p : t), undefined);
  // A scoped row promotes only inside its scope, and only when the caller can tell.
  const inScope = (p: PolicyRow): boolean => p.scope == null || ctx.scopeAllows?.(p.scope) === true;
  const promoters = rows.filter((p) => p.tier === 'alone' && inScope(p));
  if (tightest && RANK[tightest.tier] > RANK[decision.tier]) {
    decision = { ...decision, tier: tightest.tier, rule: 'policy', reason: `ActionPolicy ${tightest.pattern}`, policyPattern: tightest.pattern };
  } else if (tightest?.tier === 'alone' && promoters.length > 0 && decision.tier === 'approval' && base.promotable && !floored) {
    // Every matching row's cap applies, whatever order the rows came in: the lowest wins.
    const caps = promoters.map((p) => p.dailyCap).filter((c): c is number => c != null && c >= 0);
    const limit = Math.min(...caps, decision.cap?.limit ?? Infinity);
    const cap: Cap | undefined = Number.isFinite(limit) ? { limit, period: decision.cap?.period ?? 'day' } : undefined;
    const first = promoters[0]!;
    decision = {
      ...decision,
      tier: 'alone',
      rule: 'policy',
      reason: `promoted by ActionPolicy ${first.pattern}`,
      policyPattern: first.pattern,
      ...(cap ? { cap } : {}),
    };
  }

  if (floored && RANK[decision.tier] < RANK.approval) {
    decision = {
      ...decision,
      tier: 'approval',
      rule: 'tainted',
      reason: tainted ? 'this turn read untrusted text, so egress and writes need approval' : `${ctx.sensitivity} data would leave the box`,
    };
  }
  return decision;
}
