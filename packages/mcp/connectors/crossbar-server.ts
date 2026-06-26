/**
 * Crossbar connector (Legion, Roadmap v2 Phase 9) — READ-ONLY view of the
 * Crossbar prediction-market exchange + its trading bots. Flint observes and
 * reports; it NEVER places an order or moves money (no write tools exist here,
 * by design).
 *
 *   CROSSBAR_DATABASE_URL=postgres://crossbar:crossbar@localhost:5433/crossbar \
 *     tsx packages/mcp/connectors/crossbar-server.ts
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import pg from 'pg';

const pool = new pg.Pool({
  connectionString:
    process.env.CROSSBAR_DATABASE_URL ?? 'postgres://crossbar:crossbar@localhost:5433/crossbar',
  max: 4,
});

async function q(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
  return (await pool.query(sql, params)).rows as Record<string, unknown>[];
}
function text(v: unknown) {
  return { content: [{ type: 'text' as const, text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] };
}
const readOnly = { readOnlyHint: true };

const server = new McpServer({ name: 'crossbar', version: '1.0.0' });

server.registerTool(
  'markets',
  { description: 'Open markets with status and prices.', inputSchema: { limit: z.number().optional() }, annotations: readOnly },
  async ({ limit }) => text(await q(`select * from "Market" limit $1`, [Math.min(limit ?? 15, 50)])),
);

server.registerTool(
  'positions',
  { description: 'Current bot/user positions (read-only).', inputSchema: { limit: z.number().optional() }, annotations: readOnly },
  async ({ limit }) => text(await q(`select * from "Position" limit $1`, [Math.min(limit ?? 20, 50)])),
);

server.registerTool(
  'recent_trades',
  { description: 'Recent trades across the exchange.', inputSchema: { limit: z.number().optional() }, annotations: readOnly },
  async ({ limit }) => text(await q(`select * from "Trade" limit $1`, [Math.min(limit ?? 20, 50)])),
);

server.registerTool(
  'bot_snapshots',
  { description: 'Learner/strategy snapshots — the bots’ state over time.', inputSchema: { limit: z.number().optional() }, annotations: readOnly },
  async ({ limit }) => text(await q(`select * from "LearnerSnapshot" limit $1`, [Math.min(limit ?? 10, 50)])),
);

await server.connect(new StdioServerTransport());
