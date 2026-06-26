/**
 * Meridian connector — a READ-ONLY MCP server over Meridian's on-disk trading
 * signals. Pure file reads (no DB, no service); never imports or modifies
 * Meridian.
 *
 *   MERIDIAN_DIR=/path/to/meridian tsx packages/mcp/connectors/meridian-server.ts
 *
 * All tools readOnlyHint:true ⇒ Flint runs them freely.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const MERIDIAN_DIR =
  process.env.MERIDIAN_DIR ?? join(homedir(), 'Documents', 'GitHub', 'meridian');
const INPUTS = join(MERIDIAN_DIR, 'data', 'inputs');

interface Signal {
  signal_type: string;
  direction: string;
  magnitude: number;
  confidence: number;
  source: string;
  raw_payload?: { note?: string };
}

function tickers(): string[] {
  if (!existsSync(INPUTS)) return [];
  return readdirSync(INPUTS)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''));
}

function signalsFor(ticker: string): Signal[] | null {
  const path = join(INPUTS, `${ticker.toUpperCase()}.json`);
  if (!existsSync(path)) return null;
  try {
    return (JSON.parse(readFileSync(path, 'utf8')) as { signals?: Signal[] }).signals ?? [];
  } catch {
    return null;
  }
}

/** Net directional bias: Σ sign(direction)·magnitude·confidence, normalized. */
function netBias(signals: Signal[]): { score: number; label: string } {
  if (signals.length === 0) return { score: 0, label: 'no signal' };
  const dir = (d: string) => (d === 'bullish' ? 1 : d === 'bearish' ? -1 : 0);
  const sum = signals.reduce((acc, s) => acc + dir(s.direction) * s.magnitude * s.confidence, 0);
  const score = sum / signals.length;
  const label =
    score > 0.25 ? 'bullish' : score < -0.25 ? 'bearish' : score === 0 ? 'no signal' : 'neutral';
  return { score: Number(score.toFixed(3)), label };
}

const server = new McpServer({ name: 'meridian', version: '1.0.0' });

server.registerTool(
  'list_tickers',
  { description: 'List tickers Meridian has signals for.', inputSchema: {}, annotations: { readOnlyHint: true } },
  async () => ({ content: [{ type: 'text', text: JSON.stringify(tickers()) }] }),
);

server.registerTool(
  'get_signals',
  {
    description: 'All raw signals for one ticker (macro/tactical/sentiment/risk, direction, magnitude, confidence).',
    inputSchema: { ticker: z.string() },
    annotations: { readOnlyHint: true },
  },
  async ({ ticker }) => {
    const signals = signalsFor(ticker);
    if (!signals) {
      return { content: [{ type: 'text', text: `No Meridian signals for '${ticker}'.` }], isError: true };
    }
    return { content: [{ type: 'text', text: JSON.stringify(signals, null, 2) }] };
  },
);

server.registerTool(
  'bias_summary',
  {
    description:
      'Net directional bias per ticker (Σ direction·magnitude·confidence). Omit ticker for the whole universe, ranked.',
    inputSchema: { ticker: z.string().optional() },
    annotations: { readOnlyHint: true },
  },
  async ({ ticker }) => {
    const list = ticker ? [ticker.toUpperCase()] : tickers();
    const rows = list
      .map((t) => {
        const s = signalsFor(t);
        return s ? { ticker: t, ...netBias(s), signals: s.length } : null;
      })
      .filter(Boolean) as Array<{ ticker: string; score: number; label: string; signals: number }>;
    rows.sort((a, b) => b.score - a.score);
    return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
  },
);

await server.connect(new StdioServerTransport());
