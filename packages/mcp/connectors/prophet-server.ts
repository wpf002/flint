/**
 * Prophet connector — a READ-ONLY MCP server that surfaces Prophet's live state
 * (production models + MLflow benchmark runs) to Flint. It only READS Prophet's
 * on-disk data; it never imports or modifies the Prophet project.
 *
 *   PROPHET_DIR=/path/to/prophet tsx packages/mcp/connectors/prophet-server.ts
 *
 * All tools are annotated readOnlyHint:true ⇒ Flint runs them freely (nothing to
 * gate — read-only by construction).
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const PROPHET_DIR =
  process.env.PROPHET_DIR ?? join(homedir(), 'Documents', 'GitHub', 'prophet');

function dirs(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path).filter((n) => {
    try {
      return statSync(join(path, n)).isDirectory();
    } catch {
      return false;
    }
  });
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** MLflow metric files are lines of "timestamp value step"; take the last value. */
function lastMetricValue(path: string): number | null {
  const raw = readText(path);
  if (!raw) return null;
  const lines = raw.trim().split('\n').filter(Boolean);
  const last = lines[lines.length - 1];
  if (!last) return null;
  const value = Number(last.split(/\s+/)[1]);
  return Number.isFinite(value) ? value : null;
}

const server = new McpServer({ name: 'prophet', version: '1.0.0' });

// --- list_models: production models + their metadata --------------------------
server.registerTool(
  'list_models',
  {
    description: 'List Prophet production models with their key metadata.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => {
    const base = join(PROPHET_DIR, 'models', 'production');
    const models = dirs(base).map((name) => {
      const meta = readText(join(base, name, 'metadata.json'));
      const m = meta ? (JSON.parse(meta) as Record<string, unknown>) : {};
      return {
        name,
        model: m.model,
        engine: m.engine,
        freq: m.freq,
        horizon: m.horizon,
        n_series: m.n_series,
        trained_at: m.trained_at,
      };
    });
    return { content: [{ type: 'text', text: JSON.stringify(models, null, 2) }] };
  },
);

// --- model_details: full metadata for one model -------------------------------
server.registerTool(
  'model_details',
  {
    description: 'Full metadata for one Prophet production model (series, obs, seasonality, …).',
    inputSchema: { name: z.string() },
    annotations: { readOnlyHint: true },
  },
  async ({ name }) => {
    const meta = readText(join(PROPHET_DIR, 'models', 'production', name, 'metadata.json'));
    if (!meta) {
      return { content: [{ type: 'text', text: `No production model named '${name}'.` }], isError: true };
    }
    return { content: [{ type: 'text', text: meta }] };
  },
);

// --- best_runs: top models by a benchmark metric across MLflow runs -----------
server.registerTool(
  'best_runs',
  {
    description:
      'Best models by a benchmark metric (mase/smape/wape/rmse/mae — lower is better) across MLflow runs.',
    inputSchema: { metric: z.string().optional(), limit: z.number().optional() },
    annotations: { readOnlyHint: true },
  },
  async ({ metric, limit }) => {
    const m = (metric ?? 'mase').toLowerCase();
    const top = Math.max(1, Math.min(limit ?? 5, 50));
    const mlruns = join(PROPHET_DIR, 'mlruns');
    const rows: Array<{ run: string; model: string; metric: string; value: number }> = [];

    for (const exp of dirs(mlruns)) {
      const expPath = join(mlruns, exp);
      for (const runId of dirs(expPath)) {
        const runPath = join(expPath, runId);
        const metricsDir = join(runPath, 'metrics');
        if (!existsSync(metricsDir)) continue;
        const runName = readText(join(runPath, 'tags', 'mlflow.runName'))?.trim() || runId.slice(0, 8);
        for (const file of readdirSync(metricsDir)) {
          const lower = file.toLowerCase();
          if (lower === m || lower.endsWith(`_${m}`)) {
            const value = lastMetricValue(join(metricsDir, file));
            if (value === null) continue;
            const model = lower === m ? runName : file.slice(0, file.length - (`_${m}`).length);
            rows.push({ run: runName, model, metric: file, value });
          }
        }
      }
    }

    rows.sort((a, b) => a.value - b.value);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ metric: m, lowerIsBetter: true, top: rows.slice(0, top) }, null, 2),
        },
      ],
    };
  },
);

await server.connect(new StdioServerTransport());
