/**
 * What the server and the runtime say to each other (Machine plan P2), as one
 * contract both sides validate against. They deploy separately (the server
 * first), so every field added later is optional, and an older peer answering
 * 404 is handled quietly by the caller.
 *
 *  - Server -> runtime, POST /v1/events: what happened in chat, spend and
 *    routing, as ids, enums and numbers only (never message text). Each event
 *    carries an id the runtime dedupes on, so a resent batch adds nothing.
 *  - Runtime -> server, POST /internal/notify: a note for Will. The runtime
 *    decides the channels (only promoted notify.* actions); the server pings
 *    the phone, content-free, only for `push`. `ref` (the escalation id) makes
 *    a retried delivery a duplicate, not a second note.
 *  - Runtime -> server, POST /internal/load: chat turns in flight (triage
 *    yields to chat).
 *  - Runtime -> server, POST /internal/complete: a metered frontier call for a
 *    background spend kind; every kind is capped at $0 until Will raises it.
 */
import { z } from 'zod';

const Id = z.string().regex(/^[0-9a-f]{32}$/);
const At = z.string().datetime({ offset: true });
/** A tool or route name as it appears in chat (`server.tool`), never free text. */
const Name = z.string().regex(/^[A-Za-z0-9_.:-]{1,100}$/);

// Each part only when the server measured it (World now is sent only when it was added).
const CtxTokens = z.object({ world: z.number().int().min(0).max(100_000).optional(), recall: z.number().int().min(0).max(100_000).optional(), history: z.number().int().min(0).max(1_000_000).optional() });

export const ChatTurnEvent = z
  .object({
    id: Id,
    type: z.literal('chat.turn'),
    at: At,
    brain: z.enum(['local', 'frontier']),
    outcome: z.enum(['answered', 'empty', 'unanswered', 'failed', 'aborted']),
    tools: z.array(Name).max(30),
    ms: z.number().int().min(0).max(3_600_000),
    tainted: z.boolean(),
    // For the "chat unaffected" measures (P2 exit 6); optional, so an older server's events still pass.
    tier: z.enum(['routine', 'standard', 'hard', 'code']).optional(),
    // How memory recall went (the [route] line's): lexical, timeout and error are its fallbacks.
    recall: z.enum(['semantic', 'lexical', 'timeout', 'error', 'none', 'skipped']).optional(),
    ctxTokens: CtxTokens.strict().optional(),
  })
  .strict();

export const SpendThresholdEvent = z
  .object({
    id: Id,
    type: z.literal('spend.threshold'),
    at: At,
    vendor: z.enum(['anthropic', 'openai', 'perplexity', 'tavily']),
    level: z.enum(['notice', 'degrade', 'exhausted']),
    period: z.enum(['day', 'month']),
  })
  .strict();

export const RouteErrorEvent = z
  .object({
    id: Id,
    type: z.literal('route.error'),
    at: At,
    route: z.enum(['chat', 'generate', 'speak', 'transcribe', 'approvals', 'proposals', 'other']),
    status: z.number().int().min(400).max(599),
  })
  .strict();

export const ServerEvent = z.discriminatedUnion('type', [ChatTurnEvent, SpendThresholdEvent, RouteErrorEvent]);
export type ServerEvent = z.infer<typeof ServerEvent>;
export const ServerEventBatch = z.object({ events: z.array(ServerEvent).min(1).max(50) }).strict();
/**
 * What the runtime reads: the same events, with a field it does not know yet
 * dropped instead of refused. The server deploys first, so a newer server's
 * new optional field must not get every event of its type set aside by an
 * older runtime; dropping keeps the ids-enums-numbers-only rule.
 */
export const ServerEventBatchIn = z
  .object({
    events: z
      .array(z.discriminatedUnion('type', [ChatTurnEvent.extend({ ctxTokens: CtxTokens.strip().optional() }).strip(), SpendThresholdEvent.strip(), RouteErrorEvent.strip()]))
      .min(1)
      .max(50),
  })
  .strip();

export const NOTIFY_CHANNELS = ['inapp', 'banner', 'push'] as const;
export type NotifyChannel = (typeof NOTIFY_CHANNELS)[number];

export const NotifyRequest = z
  .object({
    title: z.string().min(1).max(80),
    body: z.string().max(500).default(''),
    /** Omitted: the P1 behaviour (in-app note, banner and a content-free ping). */
    channels: z.array(z.enum(NOTIFY_CHANNELS)).min(1).max(3).optional(),
    /** The escalation (or job) this note is for: a resent note with the same ref is a duplicate. */
    ref: z.string().regex(/^[A-Za-z0-9_:-]{1,64}$/).optional(),
  })
  .strict();
export type NotifyRequest = z.infer<typeof NotifyRequest>;
export const NotifyResponse = z.object({ ok: z.literal(true), stored: z.boolean(), pinged: z.boolean() }).strict();

export const LoadResponse = z.object({ chatInFlight: z.number().int().min(0) }).strict();

/** Background spend kinds (plan 3.0.8): each has its own cap, $0 until Will raises it. */
export const SPEND_KINDS = ['runtime', 'review', 'dispatch', 'selfmod'] as const;
export type SpendKind = (typeof SPEND_KINDS)[number];

export const InternalCompleteRequest = z
  .object({
    kind: z.enum(SPEND_KINDS),
    /** What the call is for (an escalation or job id), for the audit trail and the ledger. */
    ref: z.string().regex(/^[A-Za-z0-9_:-]{1,64}$/),
    system: z.string().max(8000),
    prompt: z.string().min(1).max(32000),
    maxTokens: z.number().int().min(1).max(4000),
  })
  .strict();
export type InternalCompleteRequest = z.infer<typeof InternalCompleteRequest>;

// ---- the runtime's answers --------------------------------------------------------
//
// Two audiences. The console (through the server, scope `events`) sees a
// decision in full, model reasoning included, rendered as text only and under
// its tainted banner. The chat tools (the runtime connector, scope
// `world:read`, reachable by the model) see projections: ids, enums, numbers,
// entity refs and template-rendered titles, never model reasoning or a
// stranger's words, each row with its own taint mark.

const DecisionId = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);
export const TRIAGE_ACTIONS = ['ignore', 'log', 'act', 'escalate'] as const;
export const LANES = ['quiet', 'relevant'] as const;
export const FEEDBACK = ['should_escalate', 'should_be_quiet', 'ok'] as const;
export const ESCALATION_STATUS = ['open', 'acked', 'dismissed', 'acted', 'expired'] as const;
export const REASON_CODES = ['needs_will', 'deadline', 'security', 'money', 'failure', 'fyi', 'routine', 'noise'] as const;
/** kind#<last 6 of its id> (entityRef), the only way an entity is named to the model. */
const Ref = z.string().regex(/^[a-z_]{2,20}#[A-Za-z0-9]{1,12}$/);

export const EscalationView = z
  .object({
    id: DecisionId,
    templateId: z.string().max(40),
    title: z.string().max(80),
    body: z.string().max(500).nullable(),
    status: z.enum(ESCALATION_STATUS),
    channels: z.array(z.enum(NOTIFY_CHANNELS)),
    tainted: z.boolean(),
    createdAt: At,
  })
  .strict();

/** One decision, as the console shows it. */
export const InboxItem = z
  .object({
    id: DecisionId,
    at: At,
    lane: z.enum(LANES),
    action: z.enum(TRIAGE_ACTIONS),
    decidedBy: z.string().max(120),
    ruleName: z.string().max(120).nullable(),
    relevance: z.number().min(0).max(1).nullable(),
    reasonCode: z.enum(REASON_CODES).nullable(),
    source: z.string().max(40),
    eventType: z.string().max(80),
    entity: z.object({ ref: Ref, kind: z.string().max(40), name: z.string().max(300) }).strict().nullable(),
    /** The model's words (it may have read a stranger's text): text only, under the tainted banner; null once purged. */
    reasoning: z.string().max(500).nullable(),
    feedback: z.enum(FEEDBACK).nullable(),
    tainted: z.boolean(),
    sensitivity: z.enum(['ops', 'personal', 'financial']),
    escalation: EscalationView.nullable(),
  })
  .strict();
export const InboxPage = z.object({ items: z.array(InboxItem), next: At.nullable() }).strict();

export const HEALTH_STATUS = ['ok', 'degraded', 'down', 'unknown', 'disabled'] as const;
export const HealthReport = z
  .object({
    at: At,
    instance: z.object({ gitSha: z.string().max(64), startedAt: At, lastBeatAt: At }).strict().nullable(),
    uptime14d: z.number().min(0).max(1).nullable(),
    components: z.array(z.object({ component: z.string().max(80), status: z.enum(HEALTH_STATUS), detail: z.string().max(300).nullable(), at: At }).strict()),
    /** When the health job last ran: older than 10 minutes means the bus is wedged. */
    lastHealthRun: At.nullable(),
    triage: z.enum(['on', 'off']),
  })
  .strict();

/** inbox_recent: what triage decided lately, projected for the model. */
export const TriageRecent = z
  .object({
    decisions: z.array(
      z
        .object({
          id: DecisionId,
          at: At,
          lane: z.enum(LANES),
          action: z.enum(TRIAGE_ACTIONS),
          reasonCode: z.enum(REASON_CODES).nullable(),
          source: z.string().max(40),
          eventType: z.string().max(80),
          entity: Ref.nullable(),
          escalationId: DecisionId.nullable(),
          tainted: z.boolean(),
        })
        .strict(),
    ),
    more: z.number().int().min(0).optional(),
  })
  .strict();

/** escalations_open: what is waiting on Will, projected for the model. */
export const EscalationsOpen = z
  .object({
    escalations: z.array(z.object({ id: DecisionId, at: At, templateId: z.string().max(40), title: z.string().max(80), status: z.enum(ESCALATION_STATUS), decisionId: DecisionId, tainted: z.boolean() }).strict()),
    more: z.number().int().min(0).optional(),
  })
  .strict();

/** explain_decision: why triage did what it did, as fields and ids (never the model's words). */
export const DecisionExplained = z
  .object({
    id: DecisionId,
    at: At,
    decidedBy: z.string().max(120),
    ruleName: z.string().max(120).nullable(),
    critical: z.boolean(),
    action: z.enum(TRIAGE_ACTIONS),
    lane: z.enum(LANES),
    relevance: z.number().min(0).max(1).nullable(),
    reasonCode: z.enum(REASON_CODES).nullable(),
    source: z.string().max(40),
    eventType: z.string().max(80),
    entity: Ref.nullable(),
    escalation: z.object({ id: DecisionId, templateId: z.string().max(40), fields: z.record(z.string(), z.union([z.string().max(120), z.number(), z.boolean(), z.null()])), predictionId: z.string().max(40).nullable() }).strict().nullable(),
    tainted: z.boolean(),
  })
  .strict();

/**
 * One line of ~/.flint/deploy-events.jsonl (0600), appended by the install
 * scripts and read by the runtime's `deploy` source: a stage that failed (the
 * gate, the migration, the restart, the health check), or a deploy that
 * finished. Ids make a line read twice the same event.
 */
export const DeployEvent = z
  .object({
    id: Id,
    at: At,
    component: z.enum(['server', 'runtime']),
    stage: z.enum(['gate', 'migrate', 'restart', 'health', 'deploy']),
    outcome: z.enum(['ok', 'failed']),
    sha: z.string().regex(/^[0-9a-f]{40}$/),
  })
  .strict();
export type DeployEvent = z.infer<typeof DeployEvent>;
