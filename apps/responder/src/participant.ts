import { connectServer, type ConnectedServer } from '@flint/mcp';
import type { ProviderAdapter, TokenUsage } from '@flint/core';
import { replyMode, resolveSecret, type ParticipantConfig, type ReplyMode } from './config.js';
import { budgetOf, costOf, type Budget, type BudgetLedger } from './budget.js';

/** Longest any single Nexus call may take. Generous — it is a backstop, not a budget. */
const NEXUS_CALL_TIMEOUT_MS = 30_000;

/** How often a participant that reported itself failing tries again. */
const RECHECK_EVERY_MS = 5 * 60_000;
import { buildProvider, metered } from './providers.js';

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
  /** The model, with every call's usage charged to this participant's budget. */
  readonly provider: ProviderAdapter;
  readonly budget: Budget | null;
  /** When the model last answered anything. One that answered recently needs no probe. */
  lastAnsweredAt = 0;
  private restReported = false;

  private constructor(
    readonly cfg: ParticipantConfig,
    model: ProviderAdapter,
    private readonly server: ConnectedServer,
    private readonly book: BudgetLedger | null = null,
  ) {
    this.provider = metered(model, (usage) => this.charge(usage));
    this.budget = budgetOf(cfg);
  }

  private charge(usage: TokenUsage): void {
    this.lastAnsweredAt = Date.now();
    this.book?.charge(this.slug, costOf(this.cfg.model, usage));
  }

  /** Why this participant is resting on its budget, or null when it may work. */
  get resting(): string | null {
    return this.book ? this.book.over(this.slug, this.budget) : null;
  }

  /**
   * Tells Nexus when this participant starts or stops resting, once each way.
   *
   * Sent as a health report because that is what Nexus and this loop route around: a
   * participant marked failing is never handed a thread. The note says why, so the
   * console shows a participant saving credit rather than a broken one.
   */
  async syncRest(log: (line: string) => void): Promise<void> {
    const why = this.resting;
    if (why && !this.restReported) {
      this.restReported = true;
      const note = `Resting to save credit: ${why}. Its turns go to whoever else can answer.`;
      await this.call('report_health', { ok: false, note: note.slice(0, 500) }).catch(() => {});
      log(`[${this.slug}] resting: ${why}`);
    } else if (!why && this.restReported) {
      this.restReported = false;
      if (!this.reportedFailing) await this.call('report_health', { ok: true }).catch(() => {});
      log(`[${this.slug}] budget renewed; taking turns again`);
    }
  }

  get slug(): string {
    return this.cfg.slug;
  }

  /** How long this one's turn may take, if it needs longer than the shared default. */
  get turnTimeoutMs(): number | undefined {
    return this.cfg.turnTimeoutMs;
  }

  /** How this participant's reply shape is obtained: enforced, or merely asked for. */
  get replyMode(): ReplyMode {
    return replyMode(this.cfg.provider);
  }

  /*
   * Whether this participant has told Nexus it is failing.
   *
   * Health was only ever reported downward. A provider that recovered stayed marked
   * broken in the console until the next daily probe, which is up to a day of telling
   * you something is wrong when it is not — and a warning that is wrong that often
   * stops being read.
   */
  private reportedFailing = false;
  private lastRecheck = 0;

  /** Whether this one cannot work right now: its model is failing, or it is resting. */
  get failing(): boolean {
    return this.reportedFailing || this.resting !== null;
  }

  /**
   * Picks up a failure mark this process did not set.
   *
   * "Am I failing" lived only in memory, and the mark in Nexus outlives the process. A
   * restart therefore left a participant that works perfectly marked broken with nothing
   * able to clear it: reportRecovered returns early unless this process set the mark,
   * and recheck returns early for the same reason. Asking Nexus what it believes on
   * connect closes that loop — the next recheck probes the model and clears it.
   */
  async adoptHealth(): Promise<void> {
    const me = await this.call<{ health?: string }>('whoami', {}).catch(() => null);
    if (me?.health === 'failing') {
      this.reportedFailing = true;
      // Probed on the very next round rather than after the usual interval: this mark
      // may be hours stale, and leaving it up while we already work is the bug.
      this.lastRecheck = 0;
    }
  }

  async reportFailing(note: string): Promise<void> {
    await this.call('report_health', { ok: false, note: note.slice(0, 500) }).catch(() => {});
    this.reportedFailing = true;
  }

  /** Clears a failure this participant reported, once it has actually worked again. */
  async reportRecovered(): Promise<void> {
    if (!this.reportedFailing) return;
    this.reportedFailing = false;
    await this.call('report_health', { ok: true }).catch(() => {});
  }

  /**
   * Asks the model a trivial question, purely to find out whether it answers.
   *
   * Only for a participant that has reported itself failing, and only every few minutes,
   * so a healthy space costs nothing. Recovery used to depend on a turn arriving, which
   * meant a participant that got no work stayed marked broken however well it worked.
   */
  async recheck(now = Date.now()): Promise<void> {
    // A resting participant is not probed: the probe is a paid call, and one that
    // succeeded would clear the mark that keeps it resting.
    if (!this.reportedFailing || this.resting) return;
    if (now - this.lastRecheck < RECHECK_EVERY_MS) return;
    this.lastRecheck = now;

    try {
      await this.provider.generate({
        model: this.cfg.model,
        messages: [{ id: 'recheck', role: 'user', content: 'ok', timestamp: 0 }],
        maxTokens: 256,
        signal: AbortSignal.timeout(this.cfg.turnTimeoutMs ?? 60_000),
      });
      await this.reportRecovered();
    } catch (err) {
      /*
       * Still down, and this is the only place that knows why.
       *
       * A bare catch here left the console showing "model failing" with nothing behind
       * it, so a key that had simply run out of credit was indistinguishable from an
       * outage — and one of those you can fix in a minute. The note is what the console
       * shows on hover, so the reason has to be carried back on every probe, not only on
       * the turn that first failed.
       */
      const why = err instanceof Error ? err.message : String(err);
      await this.call('report_health', { ok: false, note: why.slice(0, 500) }).catch(() => {});
    }
  }

  static async connect(cfg: ParticipantConfig, nexusUrl: string, book: BudgetLedger | null = null): Promise<Participant> {
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
    return new Participant(cfg, provider, server, book);
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
