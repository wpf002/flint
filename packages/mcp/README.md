# @flint/mcp

The Phase 1 **tool substrate**. Connect any [MCP](https://modelcontextprotocol.io)
server — i.e. each of your apps — and expose its tools to the Flint tool loop,
with a safety gate so Flint *operates your world* without operating it
recklessly.

This is how Crossbar, Prophet, Vantage, Sentinel, Trident, et al. each get a
second life as a Flint tool: wrap the app once as an MCP server, point Flint at
it, done.

## Safety model (the risk rail)

Every tool is classified from its MCP annotations:

| MCP annotation | Class | Behavior |
| --- | --- | --- |
| `readOnlyHint: true` | **safe** | runs freely |
| anything else / `destructiveHint` | **guarded** | requires approval |

- Guarded tools call your `approver` before executing. **No approver ⇒ denied**
  (fail-safe — "until trust is earned per-tool").
- `idempotent` on the resulting Flint tool comes from `idempotentHint ??
  readOnlyHint ?? false`, so the tool loop only auto-retries side-effect-free
  tools.
- `autoApprove: 'all'` skips the gate — only for fully-trusted, isolated setups.

## Consume it

```ts
import { McpRegistry } from '@flint/mcp';
import { Persona } from '@flint/persona';

const registry = await McpRegistry.connect(
  [
    { name: 'crossbar', transport: 'stdio', command: 'node', args: ['crossbar-mcp.js'] },
    { name: 'prophet',  transport: 'stdio', command: 'node', args: ['prophet-mcp.js'] },
  ],
  {
    // Called before any guarded (non-read-only) tool runs.
    approver: async (req) => confirmWithUser(`${req.server}.${req.tool}`, req.args),
  },
);

// Hand the whole tool set to Flint — names are namespaced as `${server}.${tool}`.
for await (const ev of persona.chat({ conversationId, message, tools: registry.tools() })) {
  if (ev.type === 'text') process.stdout.write(ev.delta);
}

await registry.close();
```

A server that fails to connect is skipped (surfaced via the `onError` option), so
one broken app doesn't take down the rest of Flint's tools.

## Wrap an app as a server

See [examples/demo-server.ts](examples/demo-server.ts) for a runnable template.
The shape:

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'crossbar', version: '1.0.0' });

// Read-only ⇒ Flint runs it freely.
server.registerTool('positions', {
  description: 'Current open positions.',
  inputSchema: {},
  annotations: { readOnlyHint: true },
}, async () => ({ content: [{ type: 'text', text: JSON.stringify(await getPositions()) }] }));

// Side-effecting ⇒ Flint checkpoints it behind your approver.
server.registerTool('place_order', {
  description: 'Place an order.',
  inputSchema: { market: z.string(), stake: z.number() },
  annotations: { destructiveHint: true },
}, async ({ market, stake }) => ({ content: [{ type: 'text', text: await placeOrder(market, stake) }] }));

await server.connect(new StdioServerTransport());
```

**Annotate honestly** — `readOnlyHint`/`destructiveHint` are what the safety gate
trusts. A write tool that lies about being read-only defeats the checkpoint.

## Connectors

[connectors/prophet-server.ts](connectors/prophet-server.ts) is a real,
read-only wrap of the **Prophet** app — it reads Prophet's on-disk model
metadata and MLflow benchmark runs and exposes `list_models`, `model_details`,
and `best_runs`. It imports/modifies nothing in Prophet; it only reads its files
(`PROPHET_DIR`, default `~/Documents/GitHub/prophet`). Use it as the template for
wrapping a file/data-backed app:

```json
{ "servers": [ { "name": "prophet", "command": "tsx",
  "args": ["packages/mcp/connectors/prophet-server.ts"] } ] }
```

[connectors/meridian-server.ts](connectors/meridian-server.ts) does the same for
**Meridian's** trading signals (`list_tickers`, `get_signals`, `bias_summary` —
net directional bias per ticker), reading `data/inputs/*.json`.

[connectors/vantage-server.ts](connectors/vantage-server.ts) reads **Vantage's**
live Postgres (`get_score`, `top_scores`, `find_company`, `list_watchlists`) and
exposes ONE side-effecting tool — `add_to_watchlist` — annotated non-readonly so
the safety gate checkpoints it (a real, reversible, non-financial **gated
write**; approved executes, denied blocks).

Verified end to end: Flint (local qwen2.5:14b) fused BOTH apps in one answer —
"top 3 bullish tickers (Meridian) + best forecasting model by MASE (Prophet)" —
with live data, no cloud. Point `ask` at multiple servers in `~/.flint/mcp.json`
and their tools aggregate into one set.

## Status

- Transports: **stdio** (spawn a server) and any pre-built `Transport`
  (in-memory, for tests). HTTP/SSE is a later addition.
- One registry, many servers, tools namespaced to avoid collisions.
