import type { McpServerSpec } from '@flint/mcp';

/*
 * What ~/.flint/mcp.json may list: servers started on this machine with a command, and
 * remote servers reached at a URL. The loader used to map every entry to a spawned
 * command, so a remote server such as Nexus had no way in, and Flint answered questions
 * about Nexus with a dictionary definition.
 */

interface Entry {
  name?: unknown;
  command?: unknown;
  args?: unknown;
  cwd?: unknown;
  env?: unknown;
  url?: unknown;
  headers?: unknown;
}

export interface McpConfig {
  specs: McpServerSpec[];
  /** One line per entry that was skipped, safe to log: it never includes a header value. */
  problems: string[];
}

const strings = (value: unknown): value is Record<string, string> =>
  typeof value === 'object' && value !== null && Object.values(value).every((v) => typeof v === 'string');

/**
 * Fills `${NAME}` from the environment, so a token can live in the LaunchAgent's
 * environment rather than in the file. Returns the names that were not set.
 */
function fill(value: string, env: Record<string, string | undefined>, missing: Set<string>): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
    const set = env[name];
    if (set === undefined || set === '') {
      missing.add(name);
      return '';
    }
    return set;
  });
}

export function parseMcpConfig(text: string, env: Record<string, string | undefined> = process.env): McpConfig {
  let servers: unknown;
  try {
    servers = (JSON.parse(text) as { servers?: unknown }).servers ?? [];
  } catch (err) {
    return { specs: [], problems: [`mcp.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`] };
  }
  if (!Array.isArray(servers)) return { specs: [], problems: ['mcp.json "servers" must be a list'] };

  const specs: McpServerSpec[] = [];
  const problems: string[] = [];
  servers.forEach((raw: Entry, i) => {
    const name = typeof raw?.name === 'string' && raw.name.trim() ? raw.name.trim() : null;
    if (!name) {
      problems.push(`server ${i + 1} has no name, skipped`);
      return;
    }

    if (typeof raw.url === 'string') {
      let url: URL;
      try {
        url = new URL(raw.url);
      } catch {
        problems.push(`${name}: "${raw.url}" is not a URL, skipped`);
        return;
      }
      if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        problems.push(`${name}: only http and https URLs are supported, skipped`);
        return;
      }
      if (raw.headers !== undefined && !strings(raw.headers)) {
        problems.push(`${name}: "headers" must map names to strings, skipped`);
        return;
      }
      const missing = new Set<string>();
      const headers = raw.headers
        ? Object.fromEntries(Object.entries(raw.headers).map(([k, v]) => [k, fill(v, env, missing)]))
        : undefined;
      // Connecting with an empty token would fail at the server with a less useful error.
      if (missing.size > 0) {
        problems.push(`${name}: ${[...missing].join(', ')} not set in the environment, skipped`);
        return;
      }
      specs.push({ name, transport: 'http', url: url.toString(), ...(headers ? { headers } : {}) });
      return;
    }

    if (typeof raw.command === 'string') {
      specs.push({
        name,
        transport: 'stdio',
        command: raw.command,
        ...(Array.isArray(raw.args) && raw.args.every((a) => typeof a === 'string') ? { args: raw.args as string[] } : {}),
        ...(typeof raw.cwd === 'string' ? { cwd: raw.cwd } : {}),
        ...(strings(raw.env) ? { env: raw.env } : {}),
      });
      return;
    }

    problems.push(`${name}: needs a "command" to start or a "url" to reach, skipped`);
  });
  return { specs, problems };
}
