import type { Tool } from '@flint/core';
import { cosineSimilarity } from '@flint/persona';

/** The slice of OllamaEmbedder the router needs; a stub in tests. */
export interface Embedder {
  embed(texts: string[]): Promise<number[][]>;
}

export interface RouterOptions {
  maxAppend?: number;
  floor?: number;
  /** Minimum gap between attempts to embed the rest tools after a failure. */
  retryMs?: number;
  now?: () => number;
}

/**
 * Tool router that keeps the common case fast AND reaches everything:
 *  - a STABLE CORE (the daily tools) goes on every request → the prompt prefix is
 *    cacheable, so most queries are quick;
 *  - extra tools are APPENDED only when the query embeds close enough to them
 *    (above a relevance floor), up to a small cap — so specialized asks
 *    (forecasting, security rules, the bot fleet) still reach their tools.
 * General/conversational queries get just the core; nothing irrelevant clutters
 * the prompt to confuse the small model.
 *
 * The rest-tool vectors are retried if they couldn't be built. A training run
 * unloads ollama, and a server that restarts during one (a deploy, a crash) used
 * to lose every appended tool until the next restart, long after ollama was back.
 */
export class ToolRouter {
  private restVectors: number[][] = [];
  private lastAttempt = -Infinity;
  private attempts = 0;
  private embedding: Promise<void> | undefined;

  private constructor(
    private readonly core: Tool[],
    private readonly rest: Tool[],
    private readonly embedder: Embedder,
    private readonly maxAppend: number,
    private readonly floor: number,
    private readonly retryMs: number,
    private readonly now: () => number,
  ) {}

  static async build(
    tools: Tool[],
    embedder: Embedder,
    coreNames: readonly string[],
    opts: RouterOptions = {},
  ): Promise<ToolRouter> {
    const maxAppend = Math.max(0, opts.maxAppend ?? Number(process.env.FLINT_TOOL_APPEND ?? 4));
    const floor = opts.floor ?? Number(process.env.FLINT_TOOL_FLOOR ?? 0.55);
    const byName = new Map(tools.map((t) => [t.definition.name, t] as const));
    const core: Tool[] = [];
    for (const n of coreNames) {
      const t = byName.get(n);
      if (t) core.push(t);
    }
    const inCore = new Set(core.map((t) => t.definition.name));
    const rest = tools.filter((t) => !inCore.has(t.definition.name));
    // If the core didn't match anything wired, fall back to "everything is core".
    const finalCore = core.length > 0 ? core : tools;
    const finalRest = core.length > 0 ? rest : [];
    const router = new ToolRouter(
      finalCore,
      finalRest,
      embedder,
      maxAppend,
      floor,
      opts.retryMs ?? 60_000,
      opts.now ?? Date.now,
    );
    await router.ensureVectors();
    console.error(
      `[router] core=${finalCore.length} (cached) + up to ${maxAppend} of ${finalRest.length} by relevance (floor ${floor})`,
    );
    return router;
  }

  /**
   * How many tools at the FRONT of every selection are the fixed core. Callers
   * use it to place a prompt-cache breakpoint on the last core tool: tools are
   * rendered before the system prompt, so a query that triggers an append still
   * reads the core schemas from cache instead of paying full price for them.
   */
  get coreLength(): number {
    return this.core.length;
  }

  /** Whether appends are live (the rest tools have vectors). */
  get appendsReady(): boolean {
    return this.rest.length > 0 && this.restVectors.length === this.rest.length;
  }

  /** Embed the rest tools if they aren't yet, at most once per retry window. */
  private async ensureVectors(): Promise<void> {
    if (this.rest.length === 0 || this.appendsReady) return;
    if (this.embedding) return this.embedding;
    const t = this.now();
    if (t - this.lastAttempt < this.retryMs) return;
    this.lastAttempt = t;
    const attempt = ++this.attempts;
    this.embedding = (async () => {
      try {
        const v = await this.embedder.embed(
          this.rest.map((x) => `${x.definition.name}: ${x.definition.description}`),
        );
        if (v.length !== this.rest.length) throw new Error(`got ${v.length} vectors for ${this.rest.length} tools`);
        this.restVectors = v;
        if (attempt > 1) console.error(`[router] rest embedding recovered on attempt ${attempt} — appends live`);
      } catch (err) {
        // Log the first failure only; a training run keeps ollama down for hours.
        if (attempt === 1) {
          console.error(`[router] rest embedding failed — appends off, retrying every ${this.retryMs / 1000}s:`, err);
        }
      } finally {
        this.embedding = undefined;
      }
    })();
    return this.embedding;
  }

  /** The stable core, plus any rest-tools the message clearly needs. */
  async select(message: string): Promise<Tool[]> {
    if (this.maxAppend === 0 || this.rest.length === 0) return this.core;
    await this.ensureVectors();
    if (!this.appendsReady) return this.core;
    let qv: number[];
    try {
      qv = (await this.embedder.embed([message.slice(0, 2000)]))[0] ?? [];
    } catch {
      return this.core;
    }
    if (qv.length === 0) return this.core;
    const appends = this.rest
      .map((t, i) => ({ t, score: cosineSimilarity(qv, this.restVectors[i] ?? []) }))
      .filter((x) => x.score >= this.floor)
      .sort((a, b) => b.score - a.score)
      .slice(0, this.maxAppend)
      .map((x) => x.t);
    return appends.length > 0 ? [...this.core, ...appends] : this.core;
  }
}
