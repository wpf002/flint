import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

/**
 * How to reach an MCP server. Each of your apps becomes one of these: a stdio
 * server you spawn (`command`), or — for tests / custom transports — a
 * pre-built Transport.
 */
export type McpServerSpec =
  | {
      name: string;
      transport: 'stdio';
      command: string;
      args?: string[];
      env?: Record<string, string>;
      /** Working directory for the spawned server. */
      cwd?: string;
    }
  | {
      name: string;
      /** A pre-built transport (InMemoryTransport in tests, or any custom one). */
      transport: Transport;
    };

/**
 * Safety class for a tool, derived from MCP annotations. Drives the checkpoint
 * gate (the roadmap's risk rail): read-only tools run freely; everything else
 * is guarded until you approve it.
 */
export type ToolSafety = 'safe' | 'guarded';

/** What an approver is asked before a guarded tool runs. */
export interface ApprovalRequest {
  server: string;
  tool: string;
  args: unknown;
  safety: ToolSafety;
  /** The MCP server hinted this tool is destructive. */
  destructive: boolean;
}

/** App-supplied gate. Return true to allow a guarded tool to execute. */
export type Approver = (req: ApprovalRequest) => boolean | Promise<boolean>;

export interface RegistryOptions {
  /**
   * Called before any GUARDED (non-read-only) tool runs. If absent, guarded
   * tools are DENIED by default — fail-safe, "until trust is earned per-tool".
   */
  approver?: Approver;
  /**
   * What runs without approval. 'safe' (default) = read-only tools only.
   * 'all' = skip the gate entirely (only for fully-trusted, isolated setups).
   */
  autoApprove?: 'safe' | 'all';
  /**
   * Namespace tool names as `${server}.${tool}` to avoid collisions across
   * servers. Default true.
   */
  namespace?: boolean;
}
