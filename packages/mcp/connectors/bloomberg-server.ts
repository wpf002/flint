/**
 * Bloomberg connector (Legion, Roadmap v2 Phase 9) — READ-ONLY view of the
 * Bloomberg / AURORA trading terminal: live market quotes, the (paper) brokerage
 * account, open positions with real P&L, and recent orders (including bot-placed
 * paper trades). Flint observes and reports; it NEVER places, cancels, or
 * modifies an order, and never enables live trading (no write tools exist here,
 * by design — order entry stays in Bloomberg behind its own auth + the
 * BOTS_ALLOW_LIVE gate).
 *
 * It reads Bloomberg's own HTTP API (not the DB) so every number is exactly what
 * the terminal shows — quotes/account/positions are sourced live from Alpaca.
 *
 *   BLOOMBERG_API_URL=http://localhost:8000 \
 *     tsx packages/mcp/connectors/bloomberg-server.ts
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const BASE = process.env.BLOOMBERG_API_URL ?? 'http://localhost:8000';

async function get(path: string): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`);
  const body = await res.text();
  if (!res.ok) return { error: `HTTP ${res.status}`, body: body.slice(0, 300) };
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}
function text(v: unknown) {
  return { content: [{ type: 'text' as const, text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] };
}
const readOnly = { readOnlyHint: true };

const server = new McpServer({ name: 'bloomberg', version: '1.0.0' });

server.registerTool(
  'quotes',
  { description: 'Live market quotes for one or more symbols (price, change, volume).', inputSchema: { symbols: z.string().describe('comma-separated, e.g. "AAPL,MSFT,SPY"') }, annotations: readOnly },
  async ({ symbols }) => text(await get(`/api/quotes?symbols=${encodeURIComponent(symbols)}`)),
);

server.registerTool(
  'account',
  { description: 'The brokerage account snapshot — cash, equity, buying power (paper).', inputSchema: {}, annotations: readOnly },
  async () => text(await get('/api/portfolio/account')),
);

server.registerTool(
  'positions',
  { description: 'Open positions with live mark-to-market and unrealized P&L.', inputSchema: {}, annotations: readOnly },
  async () => text(await get('/api/portfolio/positions')),
);

server.registerTool(
  'orders',
  { description: 'Recent orders, including bot-placed paper trades.', inputSchema: { status: z.string().optional().describe('e.g. "all", "open", "closed"') }, annotations: readOnly },
  async ({ status }) => text(await get(`/api/orders${status ? `?status=${encodeURIComponent(status)}` : ''}`)),
);

await server.connect(new StdioServerTransport());
