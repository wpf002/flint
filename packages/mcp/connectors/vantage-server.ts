/**
 * Vantage connector — MCP server over Vantage's live Postgres. Mostly read-only
 * (scores, companies, classifications, watchlists), plus ONE side-effecting tool
 * — add_to_watchlist — which is NON-readonly so Flint's safety gate checkpoints
 * it (the roadmap's "one safe write": non-financial, reversible).
 *
 *   VANTAGE_DATABASE_URL=postgres://vantage:vantage@localhost:5434/vantage \
 *     tsx packages/mcp/connectors/vantage-server.ts
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import pg from 'pg';

const pool = new pg.Pool({
  connectionString:
    process.env.VANTAGE_DATABASE_URL ?? 'postgres://vantage:vantage@localhost:5434/vantage',
  max: 4,
});

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const res = await pool.query(sql, params);
  return res.rows as T[];
}

function text(value: unknown) {
  return { content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}

const server = new McpServer({ name: 'vantage', version: '1.0.0' });

// --- reads (safe) -----------------------------------------------------------
server.registerTool(
  'get_score',
  { description: 'Latest Vantage score/label/direction/confidence for a ticker.', inputSchema: { ticker: z.string() }, annotations: { readOnlyHint: true } },
  async ({ ticker }) => {
    const rows = await q(
      `select ticker, score, label, direction, confidence, as_of from public_scores where ticker = upper($1) order by as_of desc limit 1`,
      [ticker],
    );
    return text(rows[0] ?? `No Vantage score for ${ticker.toUpperCase()}.`);
  },
);

server.registerTool(
  'top_scores',
  {
    description: 'Top Vantage scores, optionally by direction (bullish/bearish/neutral).',
    inputSchema: { direction: z.string().optional(), limit: z.number().optional() },
    annotations: { readOnlyHint: true },
  },
  async ({ direction, limit }) => {
    const n = Math.max(1, Math.min(limit ?? 10, 50));
    const rows = direction
      ? await q(`select ticker, score, label, direction, confidence from public_scores where direction = $1 order by score desc limit $2`, [direction, n])
      : await q(`select ticker, score, label, direction, confidence from public_scores order by score desc limit $1`, [n]);
    return text(rows);
  },
);

server.registerTool(
  'find_company',
  { description: 'Find companies by name or ticker.', inputSchema: { query: z.string() }, annotations: { readOnlyHint: true } },
  async ({ query }) => {
    const rows = await q(`select name, ticker, sector, market_type from platform_companies where name ilike '%'||$1||'%' or ticker ilike '%'||$1||'%' limit 10`, [query]);
    return text(rows);
  },
);

server.registerTool(
  'list_watchlists',
  { description: 'List Vantage watchlists.', inputSchema: {}, annotations: { readOnlyHint: true } },
  async () => text(await q(`select name, kind, description from platform_watchlists order by name`)),
);

// --- the gated write (side-effecting, reversible, non-financial) -------------
server.registerTool(
  'add_to_watchlist',
  {
    description: 'Add an entity (ticker/company) to a named watchlist. Side-effecting — requires approval.',
    inputSchema: { watchlist: z.string(), entity: z.string() },
    annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false },
  },
  async ({ watchlist, entity }) => {
    const wl = await q<{ id: string }>(`select id from platform_watchlists where name = $1 limit 1`, [watchlist]);
    if (wl.length === 0) return { content: [{ type: 'text', text: `No watchlist named "${watchlist}".` }], isError: true };
    await q(
      `insert into platform_watchlist_items (id, watchlist_id, entity, added_at) values (gen_random_uuid(), $1, $2, now())`,
      [wl[0]!.id, entity.toUpperCase()],
    );
    return text(`Added ${entity.toUpperCase()} to watchlist "${watchlist}".`);
  },
);

await server.connect(new StdioServerTransport());
