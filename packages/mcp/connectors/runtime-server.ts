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
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

const BASE = process.env.FLINT_RUNTIME_URL ?? 'http://[::1]:8090';
const TOKEN_FILE = join(homedir(), '.flint', 'tokens', 'runtime-mcp.token');

function token(): string {
  const t = readFileSync(TOKEN_FILE, 'utf8').trim();
  if (!/^[0-9a-f]{64}$/.test(t)) throw new Error('the runtime connector token is missing (run apps/runtime/install-runtime.sh)');
  return t;
}

export async function runtimeCall(path: string, init: { method?: 'GET' | 'POST'; body?: unknown } = {}, fetchImpl: typeof fetch = fetch): Promise<unknown> {
  const r = await fetchImpl(`${BASE}${path}`, {
    method: init.method ?? 'GET',
    headers: { authorization: `Bearer ${token()}`, ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    signal: AbortSignal.timeout(10_000),
  });
  const data = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok) throw new Error(String(data.error ?? `runtime HTTP ${r.status}`));
  return data;
}

/** What a tool may put into the model's context; past it, a marker (and, not knowing what was cut, tainted). */
export const MAX_RESULT_CHARS = 32_000;
export const text = (v: unknown) => {
  const t = JSON.stringify(v, null, 2);
  const out = t.length <= MAX_RESULT_CHARS ? t : JSON.stringify({ truncated: true, chars: t.length, note: 'too large to show in chat; ask for less', tainted: true });
  return { content: [{ type: 'text' as const, text: out }] };
};
const readOnly = { readOnlyHint: true };

export function buildServer(call = runtimeCall): McpServer {
  const server = new McpServer({ name: 'runtime', version: '1.0.0' });

  server.registerTool(
    'world_now',
    { description: "What Flint's world model says right now: each service's health and how many entities of each kind it tracks. Never contains text from outside.", inputSchema: {}, annotations: readOnly },
    async () => text({ ...((await call('/v1/world/now')) as object), tainted: false }),
  );

  server.registerTool(
    'world_entity',
    {
      description: 'One entity in the world model by id, with its current state. If any of its text came from outside (an issue title, a Nexus note), the result says tainted: true.',
      inputSchema: { id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/) },
      annotations: readOnly,
    },
    async ({ id }) => text(await call(`/v1/world/entities/${id}`)),
  );

  server.registerTool(
    'ledger_open',
    { description: "Flint's open predictions, soonest to resolve first.", inputSchema: { limit: z.number().int().min(1).max(50).optional() }, annotations: readOnly },
    async ({ limit }) => text(await call(`/v1/ledger/open?limit=${limit ?? 20}`)),
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
        'Record a prediction in the ledger so it can be scored later. Needs a probability between 0.05 and 0.95, how it will be resolved, and a resolve-by date within 180 days.',
      inputSchema: {
        claim: z.string().min(1).max(300),
        probability: z.number().min(0.05).max(0.95),
        domain: z.enum(['services', 'deploys', 'spend', 'repos', 'projects', 'calendar', 'goals', 'assets', 'selfmod', 'triage', 'recommendation']),
        type: z.enum(['event_occurs', 'deadline_met', 'threshold_cross', 'trend', 'relevance', 'task_meets_bar', 'effect_given_accept']),
        resolutionCriteria: z.string().min(1).max(1000),
        resolveBy: z.string().datetime({ offset: true }),
        evidence: z.array(z.object({ kind: z.string().max(40), ref: z.string().max(200), note: z.string().max(200).optional() })).max(20).optional(),
        // Set by Flint's server from the turn (it overwrites whatever the model sends): a
        // prediction worded in a turn that read untrusted text is stored as tainted.
        tainted: z.boolean().optional(),
      },
    },
    async (a) =>
      text(
        await call('/v1/ledger/predictions', {
          method: 'POST',
          body: { ...a, method: 'model_reasoning', resolver: 'will', evidence: a.evidence ?? [], tainted: a.tainted === true },
        }),
      ),
  );

  return server;
}

// Run as a stdio MCP server unless imported (tests).
if (process.argv[1] && /runtime-server\.(ts|mjs|js)$/.test(process.argv[1])) {
  await buildServer().connect(new StdioServerTransport());
}
