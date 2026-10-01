/**
 * Bellwether connector — read-only MCP server over Bellwether's live Postgres
 * (24/7 market-intelligence signals with provenance). All tools are read-only.
 *
 *   BELLWETHER_DATABASE_URL=postgres://<user>:<password>@localhost:5432/bellwether \
 *     tsx packages/mcp/connectors/bellwether-server.ts
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { dbFromEnv } from '../src/db.js';

// No URL, no connection: the tools say what to set (../src/db).
const db = dbFromEnv('BELLWETHER_DATABASE_URL');

async function q(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
  return db.q(sql, params);
}
function text(v: unknown) {
  return { content: [{ type: 'text' as const, text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] };
}
const readOnly = { readOnlyHint: true };

const server = new McpServer({ name: 'bellwether', version: '1.0.0' });

server.registerTool(
  'list_industries',
  { description: 'Industries Bellwether tracks.', inputSchema: {}, annotations: readOnly },
  async () => text(await q(`select id, label from industries order by label`)),
);

server.registerTool(
  'recent_signals',
  {
    description: 'Most recent market-intelligence signals (headline + kind), optionally by industry.',
    inputSchema: { industry: z.string().optional(), limit: z.number().optional() },
    annotations: readOnly,
  },
  async ({ industry, limit }) => {
    const n = Math.max(1, Math.min(limit ?? 10, 50));
    const rows = industry
      ? await q(`select industry_id, entity_kind, payload->>'headline' as headline, payload->>'kind' as kind, created_at from signals where industry_id=$1 order by created_at desc limit $2`, [industry, n])
      : await q(`select industry_id, entity_kind, payload->>'headline' as headline, payload->>'kind' as kind, created_at from signals order by created_at desc limit $1`, [n]);
    return text(rows);
  },
);

server.registerTool(
  'latest_digest',
  {
    description: 'The latest digest for an industry (the rolled-up intelligence brief).',
    inputSchema: { industry: z.string() },
    annotations: readOnly,
  },
  async ({ industry }) => {
    const rows = await q(`select period_start, period_end, status, body from digests where industry_id=$1 order by created_at desc limit 1`, [industry]);
    return text(rows[0] ?? `No digest for industry '${industry}'.`);
  },
);

server.registerTool(
  'source_health',
  {
    description: 'Health of Bellwether data sources (unhealthy/failing first) — is the intel pipeline ok?',
    inputSchema: { industry: z.string().optional() },
    annotations: readOnly,
  },
  async ({ industry }) => {
    const rows = industry
      ? await q(`select label, healthy, consecutive_failures, last_status, last_error from sources where industry_id=$1 order by consecutive_failures desc, healthy asc`, [industry])
      : await q(`select label, healthy, consecutive_failures, last_status, last_error from sources order by consecutive_failures desc, healthy asc limit 25`);
    return text(rows);
  },
);

await server.connect(new StdioServerTransport());
