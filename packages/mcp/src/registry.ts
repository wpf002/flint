import type { Tool } from '@flint/core';
import { connectServer, type ConnectedServer } from './client.js';
import type { McpServerSpec, RegistryOptions } from './types.js';

/**
 * The tool registry Flint reads to know what it can do (Phase 1). Connects to
 * one or more MCP servers — each of your apps — and aggregates their tools into
 * a single Flint tool set, with the read-only-safe / side-effect-checkpointed
 * gate applied uniformly.
 *
 * Pass `registry.tools()` straight into `flint.chat({ tools })` /
 * `persona.chat({ tools })`.
 */
export class McpRegistry {
  private readonly servers: ConnectedServer[] = [];

  private constructor(servers: ConnectedServer[]) {
    this.servers.push(...servers);
  }

  /** Connect all servers. A server that fails to connect is skipped (logged via onError). */
  static async connect(
    specs: McpServerSpec[],
    options: RegistryOptions & { onError?: (server: string, err: unknown) => void } = {},
  ): Promise<McpRegistry> {
    const results = await Promise.allSettled(specs.map((s) => connectServer(s, options)));
    const connected: ConnectedServer[] = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') connected.push(r.value);
      else options.onError?.(specs[i]!.name, r.reason);
    });
    return new McpRegistry(connected);
  }

  /** Every tool across every connected server, ready for the tool loop. */
  tools(): Tool[] {
    return this.servers.flatMap((s) => s.tools);
  }

  /** Names of the servers that connected successfully. */
  connectedServers(): string[] {
    return this.servers.map((s) => s.name);
  }

  /** Disconnect everything. */
  async close(): Promise<void> {
    await Promise.allSettled(this.servers.map((s) => s.close()));
    this.servers.length = 0;
  }
}
