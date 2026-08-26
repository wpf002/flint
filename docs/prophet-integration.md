# Prophet integration — grounding AI answers in real forecasts

Flint is the AI layer; **Prophet** is its numbers sibling — a forecasting service
that also reports whether a series is *even forecastable* and how *calibrated* its
intervals are. Together: the AI can stop guessing at trends and ground a claim in
a real, interval-quantified, calibration-checked projection.

They connect through the substrate Flint already has — `@flint/mcp`. Prophet is
exposed as MCP tools by **Trident**; point Flint's MCP registry at Trident and the
tools appear in the Flint tool loop. All Prophet tools are read-only, so they run
freely through the autonomy gate (no approver checkpoint).

## Wire it (no code change)

Any Flint app that loads MCP specs (e.g. `ask`, from `$MCP_CONFIG` or
`~/.flint/mcp.json`) gets Prophet by adding Trident to that config —
see `examples/mcp.prophet.json`:

```json
{ "servers": [{
  "name": "trident",
  "transport": "stdio",
  "command": "node",
  "args": ["../trident/packages/mcp-server/dist/index.js"],
  "env": { "PROPHET_URL": "https://prophet-api-production.up.railway.app", "PROPHET_API_KEY": "" }
}]}
```

```bash
# build Trident once, then run any Flint app with the config
(cd ../trident/packages/mcp-server && npm run build)
MCP_CONFIG=./examples/mcp.prophet.json pnpm --filter @flint/ask start
```

In code the wiring is the standard registry pattern:

```ts
import { McpRegistry } from "@flint/mcp";
const registry = await McpRegistry.connect(specs);   // specs incl. Trident
for await (const ev of persona.chat({ conversationId, message, tools: registry.tools() })) { … }
```

## The four tools the AI gains

| Tool | The AI uses it to… |
|---|---|
| `prophet_forecast_adhoc` | Forecast a series it has inline **and get the verdict** — `beats_naive` tells it whether the series is predictable before it asserts a trend. |
| `prophet_forecast` | Project a series Prophet already hosts (macro indicators, market volume) with intervals. |
| `prophet_calibration` | Check how much to trust a managed model — is a "95%" interval really 95%? has it drifted? |
| `prophet_models` | Discover the hosted models. |

## The grounding pattern

Instead of the AI writing "sales are trending up," the loop becomes: the model
calls `prophet_forecast_adhoc` with the sales series → if `beats_naive` is false,
it says "no reliable trend — a naive guess is as good"; if true, it reports the
projection with its interval. For a hosted model, `prophet_calibration` gates the
confidence language ("the 95% band has held at 88% — treat as ~88%").

This is the sibling architecture working: `@flint/core` for language, Prophet for
numbers, unified at the tool layer via Trident — not merged.
