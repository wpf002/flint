/**
 * Hive connector (Legion, Roadmap v2 Phase 9) — READ-ONLY view of the Hive
 * bot-orchestration control plane: configured bots, recent job runs (with their
 * real results), the live worker fleet, and any paper-trading activity. Flint
 * observes and reports; it NEVER dispatches a job, creates a bot, or enables
 * live trading (no write tools exist here, by design — that stays human-gated in
 * Hive's own admin API).
 *
 *   HIVE_DATABASE_URL=postgres://hive:hive@localhost:5436/hive \
 *     tsx packages/mcp/connectors/hive-server.ts
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import pg from 'pg';

const pool = new pg.Pool({
  connectionString: process.env.HIVE_DATABASE_URL ?? 'postgres://hive:hive@localhost:5436/hive',
  max: 4,
});

async function q(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
  return (await pool.query(sql, params)).rows as Record<string, unknown>[];
}
function text(v: unknown) {
  return { content: [{ type: 'text' as const, text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] };
}
const readOnly = { readOnlyHint: true };

const server = new McpServer({ name: 'hive', version: '1.0.0' });

server.registerTool(
  'bots',
  { description: 'Configured bots and their pool/template.', inputSchema: { limit: z.number().optional() }, annotations: readOnly },
  async ({ limit }) =>
    text(
      await q(
        `select b.id, b.name, b.enabled, t.name as template, t."poolType" as pool, b."createdAt"
           from "Bot" b join "BotTemplate" t on t.id = b."templateId"
          order by b."createdAt" desc limit $1`,
        [Math.min(limit ?? 20, 50)],
      ),
    ),
);

server.registerTool(
  'recent_jobs',
  {
    description: 'Recent job runs with status and their real results (e.g. scraped data).',
    inputSchema: { limit: z.number().optional(), status: z.string().optional() },
    annotations: readOnly,
  },
  async ({ limit, status }) =>
    text(
      await q(
        `select j.id, b.name as bot, t."poolType" as pool, j.status, j.attempts,
                j."startedAt", j."finishedAt", j.error, j.result
           from "Job" j
           join "Bot" b on b.id = j."botId"
           join "BotTemplate" t on t.id = b."templateId"
          ${status ? 'where j.status = $2' : ''}
          order by j."createdAt" desc limit $1`,
        status ? [Math.min(limit ?? 10, 30), status] : [Math.min(limit ?? 10, 30)],
      ),
    ),
);

server.registerTool(
  'workers',
  { description: 'The live worker fleet — pools, status, capacity, active jobs.', inputSchema: { limit: z.number().optional() }, annotations: readOnly },
  async ({ limit }) =>
    text(
      await q(
        `select id, "poolType" as pool, hostname, status, capacity, "activeJobs", "lastSeenAt", region, zone
           from "Worker" order by "lastSeenAt" desc nulls last limit $1`,
        [Math.min(limit ?? 20, 50)],
      ),
    ),
);

server.registerTool(
  'paper_trades',
  { description: 'Paper-trading activity (read-only; real prices, simulated fills — no real money).', inputSchema: { limit: z.number().optional() }, annotations: readOnly },
  async ({ limit }) => text(await q(`select * from "PaperTrade" order by "createdAt" desc limit $1`, [Math.min(limit ?? 20, 50)])),
);

await server.connect(new StdioServerTransport());
