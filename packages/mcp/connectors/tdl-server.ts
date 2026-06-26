/**
 * TDL connector — read-only MCP server over the TDL detection-rule library
 * (~1,500 ATT&CK-mapped SIEM rules + recommendation/coverage exports). Pure file
 * reads, zero infrastructure; modifies nothing in TDL.
 *
 *   TDL_DIR=/path/to/tdl tsx packages/mcp/connectors/tdl-server.ts
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const TDL_DIR = process.env.TDL_DIR ?? join(homedir(), 'Documents', 'GitHub', 'tdl');

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}
function text(v: unknown) {
  return { content: [{ type: 'text' as const, text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] };
}
const readOnly = { readOnlyHint: true };

/** Recursively find a rule file named `<id>.yaml` under rules/. */
function findRuleFile(dir: string, id: string): string | null {
  if (!existsSync(dir)) return null;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    let isDir = false;
    try {
      isDir = statSync(p).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      const hit = findRuleFile(p, id);
      if (hit) return hit;
    } else if (name.toLowerCase() === `${id.toLowerCase()}.yaml`) {
      return p;
    }
  }
  return null;
}

const server = new McpServer({ name: 'tdl', version: '1.0.0' });

server.registerTool(
  'recommendations',
  {
    description: 'Top recommended detection rules for the current profile, optionally by tactic/severity.',
    inputSchema: { tactic: z.string().optional(), severity: z.string().optional(), limit: z.number().optional() },
    annotations: readOnly,
  },
  async ({ tactic, severity, limit }) => {
    const data = readJson(join(TDL_DIR, 'exports', 'latest_recommendations.json')) as
      | { total_rules?: number; deployable_count?: number; top_rules?: Array<Record<string, unknown>> }
      | null;
    if (!data) return { content: [{ type: 'text', text: 'No recommendations export found.' }], isError: true };
    let rules = data.top_rules ?? [];
    if (tactic) rules = rules.filter((r) => String(r.tactic ?? '').toLowerCase().includes(tactic.toLowerCase()));
    if (severity) rules = rules.filter((r) => String(r.severity ?? '').toLowerCase() === severity.toLowerCase());
    return text({
      total_rules: data.total_rules,
      deployable_count: data.deployable_count,
      rules: rules.slice(0, Math.max(1, Math.min(limit ?? 10, 50))),
    });
  },
);

server.registerTool(
  'coverage',
  {
    description: 'ATT&CK coverage summary (overall + per tactic).',
    inputSchema: {},
    annotations: readOnly,
  },
  async () => {
    const data = readJson(join(TDL_DIR, 'matrix', 'coverage_report.json')) as
      | { summary?: unknown; by_tactic?: unknown; generated_at?: unknown }
      | null;
    if (!data) return { content: [{ type: 'text', text: 'No coverage report found.' }], isError: true };
    return text({ summary: data.summary, by_tactic: data.by_tactic, generated_at: data.generated_at });
  },
);

server.registerTool(
  'get_rule',
  {
    description: 'Full detection rule (logic, queries, ATT&CK mapping) by rule id, e.g. TDL-CA-001.',
    inputSchema: { rule_id: z.string() },
    annotations: readOnly,
  },
  async ({ rule_id }) => {
    const file = findRuleFile(join(TDL_DIR, 'rules'), rule_id.trim());
    if (!file) return { content: [{ type: 'text', text: `No rule '${rule_id}'.` }], isError: true };
    return text(readFileSync(file, 'utf8'));
  },
);

await server.connect(new StdioServerTransport());
