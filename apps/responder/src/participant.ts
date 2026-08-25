import { connectServer, type ConnectedServer } from '@flint/mcp';
import type { ProviderAdapter } from '@flint/core';
import { replyMode, resolveSecret, type ParticipantConfig, type ReplyMode } from './config.js';

/** Longest any single Nexus call may take. Generous — it is a backstop, not a budget. */
const NEXUS_CALL_TIMEOUT_MS = 30_000;
import { buildProvider } from './providers.js';

/**
 * One AI in the shared space: a Nexus namespace it speaks as, and a model that
 * produces what it says.
 *
 * The Nexus connection is authenticated with that namespace's own token, which is
 * the whole reason this is safe to automate. Authorship comes from the credential,
 * so a participant cannot claim to be another one however it is prompted, and
 * write-scoping means it cannot edit anyone else's memory or turns either.
 */
export class Participant {
  private constructor(
    readonly cfg: ParticipantConfig,
    readonly provider: ProviderAdapter,
    private readonly server: ConnectedServer,
  ) {}

  get slug(): string {
    return this.cfg.slug;
  }

  /** How this participant's reply shape is obtained: enforced, or merely asked for. */
  get replyMode(): ReplyMode {
    return replyMode(this.cfg.provider);
  }

  static async connect(cfg: ParticipantConfig, nexusUrl: string): Promise<Participant> {
    // Everything that can fail on configuration alone is resolved before the socket
    // is opened. Connecting first would leave a live MCP session behind every
    // participant that turns out to be missing an API key.
    const token = resolveSecret(cfg.token, `participant '${cfg.slug}' token`);
    const provider = buildProvider(cfg);

    const server = await connectServer({
      name: 'nexus',
      transport: 'http',
      url: nexusUrl,
      headers: { Authorization: `Bearer ${token}` },
    });
    return new Participant(cfg, provider, server);
  }

  /**
   * Calls a Nexus tool and returns its parsed JSON payload.
   *
   * On its own clock. A hung request has no natural end, and the loop awaits these one
   * at a time — so a single call that never returns stops the participant taking any
   * turn, on any thread, indefinitely, while the process still reports as running.
   */
  async call<T = unknown>(tool: string, args: Record<string, unknown> = {}): Promise<T> {
    const result = (await this.server.client.callTool(
      { name: tool, arguments: args },
      undefined,
      { timeout: NEXUS_CALL_TIMEOUT_MS },
    )) as {
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };

    const text = (result.content ?? [])
      .filter((c) => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('\n');

    if (result.isError) {
      throw new Error(`nexus.${tool} failed for '${this.slug}': ${text || 'unknown error'}`);
    }

    try {
      return JSON.parse(text) as T;
    } catch {
      // A tool that answers in prose rather than JSON is still a valid answer.
      return text as unknown as T;
    }
  }

  /**
   * Publishes what this participant is good at, and that it answers on its own.
   *
   * Nominations and Nexus's own routing both read these profiles, so an empty one
   * makes a participant invisible to both. The autonomous claim is what stops Nexus
   * telling a human to go relay a turn to something that already picked it up.
   */
  async publishRole(): Promise<void> {
    if (!this.cfg.role) return;
    await this.call('set_role', { role: this.cfg.role, autonomous: true });
  }

  async close(): Promise<void> {
    await this.server.close().catch(() => {});
  }
}
