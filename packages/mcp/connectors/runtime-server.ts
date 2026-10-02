/**
 * Runtime connector: Flint's own world model and prediction ledger, over the
 * runtime's loopback API (Machine plan P1, "runtime added to mcp.json").
 *
 *   tsx packages/mcp/connectors/runtime-server.ts
 *
 * It reads its token from ~/.flint/tokens/runtime-mcp.token (written by
 * apps/runtime/install-runtime.sh, scopes world:read and ledger only). These
 * tools are Flint's own actions served over MCP: the tier engine gives them
 * their code-table entries (APPROVAL until Will promotes them), and a result
 * that carries text someone else wrote says `"tainted": true`, which taints
 * the turn that read it.
 *
 * The front door (Machine plan P2): inbox_recent, escalations_open and
 * explain_decision read what triage decided and what is waiting on Will. They
 * only read: acknowledging, dismissing and labelling are console buttons, and
 * the connector's token cannot do them.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { CLAIM_TEMPLATE_HELP, ClaimTemplate, DecisionExplained, EscalationsOpen, TriageRecent, entityRef } from '@flint/policy';

const BASE = process.env.FLINT_RUNTIME_URL ?? 'http://[::1]:8090';
const TOKEN_FILE = join(homedir(), '.flint', 'tokens', 'runtime-mcp.token');
const NO_TOKEN = 'the runtime connector token is missing (run apps/runtime/install-runtime.sh)';

function token(): string {
  let t = '';
  try {
    t = readFileSync(TOKEN_FILE, 'utf8').trim();
  } catch {
    // Unreadable is the same as missing (and the error would carry a path).
  }
  if (!/^[0-9a-f]{64}$/.test(t)) throw new Error(NO_TOKEN);
  return t;
}

/** A runtime answer that was not 2xx; the message is the runtime's own error text. */
export class RuntimeHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'RuntimeHttpError';
    this.status = status;
  }
}

export async function runtimeCall(path: string, init: { method?: 'GET' | 'POST'; body?: unknown } = {}, fetchImpl: typeof fetch = fetch): Promise<unknown> {
  const r = await fetchImpl(`${BASE}${path}`, {
    method: init.method ?? 'GET',
    headers: { authorization: `Bearer ${token()}`, ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    signal: AbortSignal.timeout(10_000),
  });
  const data: unknown = await r.json().catch(() => ({}));
  if (!r.ok) {
    const said = data && typeof data === 'object' ? (data as Record<string, unknown>).error : undefined;
    throw new RuntimeHttpError(r.status, String(said ?? `runtime HTTP ${r.status}`));
  }
  return data;
}

/**
 * What a tool may put into the model's context (in line with the web
 * connector's fetch_url); past it, a marker (and, not knowing what was cut,
 * tainted).
 */
export const MAX_RESULT_CHARS = 8_000;
/** The most rows (from the front) whose result fits MAX_RESULT_CHARS, built with `wrap`. */
export function fitRows<T>(rows: T[], wrap: (shown: T[], more: number) => unknown): unknown {
  let n = rows.length;
  while (n > 0 && JSON.stringify(wrap(rows.slice(0, n), rows.length - n), null, 2).length > MAX_RESULT_CHARS) n--;
  return wrap(rows.slice(0, n), rows.length - n);
}

export const text = (v: unknown) => {
  const t = JSON.stringify(v, null, 2);
  const out = t.length <= MAX_RESULT_CHARS ? t : JSON.stringify({ truncated: true, chars: t.length, note: 'too large to show in chat; ask for less', tainted: true });
  return { content: [{ type: 'text' as const, text: out }] };
};
const readOnly = { readOnlyHint: true };

/**
 * A front-door failure, as an error result. Only the connector's own words,
 * never the runtime's: `tainted` is false when nothing from the runtime is
 * shown, and true for an answer that failed its wire schema (fail closed: what
 * it held is unknown, so the server's gate taints the turn).
 */
export const failure = (error: string, tainted: boolean) => ({
  isError: true,
  content: [{ type: 'text' as const, text: JSON.stringify({ error, tainted }) }],
});

/** A thrown runtime call, as a class of error. */
function callFailure(err: unknown, notFound: string) {
  if (err instanceof RuntimeHttpError) {
    if (err.status === 404) return failure(notFound, false);
    if (err.status === 401 || err.status === 403) return failure("the runtime refused this connector's token", false);
    return failure(`the runtime answered HTTP ${err.status}`, false);
  }
  if (err instanceof Error && err.message === NO_TOKEN) return failure(NO_TOKEN, false);
  return failure('the runtime could not be reached', false);
}

type Schema<T> = { safeParse(v: unknown): { success: true; data: T } | { success: false } };

/** GET a front-door route and show it only if it is exactly the wire contract's shape. */
async function frontDoor<T>(
  call: typeof runtimeCall,
  path: string,
  schema: Schema<T>,
  notFound: string,
  show: (v: T) => unknown,
  check: (v: T) => boolean = () => true,
) {
  let raw: unknown;
  try {
    raw = await call(path);
  } catch (err) {
    return callFailure(err, notFound);
  }
  const v = schema.safeParse(raw);
  if (!v.success || !check(v.data)) return failure("the runtime's answer was not in the expected shape, so none of it is shown", true);
  return text(show(v.data));
}

/** As many rows as fit, each keeping its own taint mark, and how many more there are (cut here or past the runtime's limit). */
const fitted = <R>(key: string, rows: R[], more: number | undefined) =>
  fitRows(rows, (shown, cut) => ({ [key]: shown, ...(cut + (more ?? 0) > 0 ? { more: cut + (more ?? 0) } : {}) }));

const ACK_IN_CONSOLE = 'Read-only: acknowledging, dismissing and labelling are Will\'s, with the console\'s buttons; no tool does them.';

export function buildServer(call = runtimeCall): McpServer {
  const server = new McpServer({ name: 'runtime', version: '1.0.0' });

  server.registerTool(
    'world_now',
    { description: "What Flint's world model says right now: each service's health and how many entities of each kind it tracks. Never contains text from outside.", inputSchema: {}, annotations: readOnly },
    async () => {
      // Each service with the `ref` a prediction's template names it by.
      const r = (await call('/v1/world/now')) as { services?: Array<Record<string, unknown>> } & Record<string, unknown>;
      const services = (r.services ?? []).map((sv) => (typeof sv.id === 'string' ? { ...sv, ref: entityRef('service', sv.id) } : sv));
      return text({ ...r, services, tainted: false });
    },
  );

  server.registerTool(
    'world_entity',
    {
      description: 'One entity in the world model by id, with its current state. If any of its text came from outside (an issue title, a Nexus note), the result says tainted: true.',
      inputSchema: { id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/) },
      annotations: readOnly,
    },
    async ({ id }) => {
      // Only what the model needs; never the raw sources list.
      const r = (await call(`/v1/world/entities/${id}`)) as { entity?: Record<string, unknown>; tainted?: boolean };
      const e = r.entity ?? {};
      const pick = ['id', 'kind', 'key', 'name', 'status', 'state', 'taintedPaths', 'version', 'lastObservedAt'];
      const ref = typeof e.kind === 'string' && typeof e.id === 'string' ? { ref: entityRef(e.kind, e.id) } : {};
      return text({ entity: { ...Object.fromEntries(pick.filter((k) => k in e).map((k) => [k, e[k]])), ...ref }, tainted: r.tainted !== false });
    },
  );

  server.registerTool(
    'ledger_open',
    { description: "Flint's open predictions, soonest to resolve first.", inputSchema: { limit: z.number().int().min(1).max(20).optional() }, annotations: readOnly },
    async ({ limit }) => {
      const r = (await call(`/v1/ledger/open?limit=${limit ?? 10}`)) as { predictions?: Array<Record<string, unknown>> };
      const pick = ['id', 'claim', 'probability', 'domain', 'type', 'resolveBy', 'status', 'tainted'];
      const rows = (r.predictions ?? []).map((p) => ({
        ...Object.fromEntries(pick.filter((k) => k in p).map((k) => [k, p[k]])),
        evidence: Array.isArray(p.evidence) ? p.evidence.length : 0,
      }));
      // As many as fit (each row keeps its own taint mark), and how many more there are.
      return text(fitRows(rows, (shown, more) => ({ predictions: shown, ...(more ? { more } : {}) })));
    },
  );

  server.registerTool(
    'ledger_calibration',
    { description: "How well calibrated Flint's predictions have been: Brier score, skill and reliability per domain.", inputSchema: {}, annotations: readOnly },
    async () => text(await call('/v1/ledger/calibration')),
  );

  server.registerTool(
    'ledger_record_prediction',
    {
      description:
        'Record a prediction in the ledger so it can be scored later. Needs a probability between 0.05 and 0.95, how it will be resolved, and a resolve-by date within 180 days. ' +
        'Give the claim in your own words, OR (required once the conversation has read anything from outside: a web page, an issue, a thread) a template: ' +
        CLAIM_TEMPLATE_HELP,
      inputSchema: {
        claim: z.string().min(1).max(300).optional(),
        template: ClaimTemplate.optional().describe(`One of the ledger's claim templates: ${CLAIM_TEMPLATE_HELP}`),
        probability: z.number().min(0.05).max(0.95),
        domain: z.enum(['services', 'deploys', 'spend', 'repos', 'projects', 'calendar', 'goals', 'assets', 'selfmod', 'triage', 'recommendation']),
        type: z.enum(['event_occurs', 'deadline_met', 'threshold_cross', 'trend', 'relevance', 'task_meets_bar', 'effect_given_accept']),
        resolutionCriteria: z.string().min(1).max(1000),
        resolveBy: z.string().datetime({ offset: true }),
        evidence: z.array(z.object({ kind: z.string().max(40), ref: z.string().max(200), note: z.string().max(200).optional() })).max(20).optional(),
      },
    },
    async (a, extra) => {
      if (!a.claim && !a.template) return { isError: true, content: [{ type: 'text' as const, text: 'give a claim, or a template with its params' }] };
      // Whether the turn read text from outside comes from Flint's server, in the
      // request's _meta, never from the model; without it, assume it did.
      const flag = (extra?._meta as Record<string, unknown> | undefined)?.['flint/tainted'];
      const tainted = flag !== false;
      return text(
        await call('/v1/ledger/predictions', {
          method: 'POST',
          body: { ...a, method: 'model_reasoning', resolver: 'will', evidence: a.evidence ?? [], tainted },
        }),
      );
    },
  );

  // ---- the front door (P2): projections only, each row with its own taint mark ----

  server.registerTool(
    'inbox_recent',
    {
      description:
        "What Flint's triage decided lately: for each decision its id, lane (relevant or quiet), action, reason code, source, event type, the entity's ref and its escalation's id. " +
        "Never the triage model's words. " + ACK_IN_CONSOLE,
      inputSchema: { limit: z.number().int().min(1).max(20).optional() },
      annotations: readOnly,
    },
    async ({ limit }) =>
      frontDoor(call, `/v1/triage/recent?limit=${limit ?? 10}`, TriageRecent, 'the runtime does not serve triage decisions (it may be older than this connector)', (r) =>
        fitted('decisions', r.decisions, r.more),
      ),
  );

  server.registerTool(
    'escalations_open',
    {
      description:
        'What is waiting on Will: the open escalations, each with its id, template, rendered title, status and the id of the triage decision behind it (explain_decision tells why). ' + ACK_IN_CONSOLE,
      inputSchema: { limit: z.number().int().min(1).max(20).optional() },
      annotations: readOnly,
    },
    async ({ limit }) =>
      frontDoor(call, `/v1/escalations/open?limit=${limit ?? 10}`, EscalationsOpen, 'the runtime does not serve escalations (it may be older than this connector)', (r) =>
        fitted('escalations', r.escalations, r.more),
      ),
  );

  server.registerTool(
    'explain_decision',
    {
      description:
        'Why triage did what it did with one decision (its id from inbox_recent, or an escalation\'s decisionId): what decided it (a rule or the local model), whether a critical rule fired, ' +
        "the action, lane, relevance and reason code, the entity's ref, and the escalation's template and typed fields. Fields and ids only, never the triage model's words. " + ACK_IN_CONSOLE,
      inputSchema: { id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/) },
      annotations: readOnly,
    },
    async ({ id }) =>
      frontDoor(
        call,
        `/v1/triage/decisions/${encodeURIComponent(id)}/explain`,
        DecisionExplained,
        'no triage decision has that id (or the runtime is older than this connector)',
        (r) => r,
        // An answer about another decision is not an answer.
        (r) => r.id === id,
      ),
  );

  return server;
}

// Run as a stdio MCP server unless imported (tests).
if (process.argv[1] && /runtime-server\.(ts|mjs|js)$/.test(process.argv[1])) {
  await buildServer().connect(new StdioServerTransport());
}
