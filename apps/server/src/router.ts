import type { Tool } from '@flint/core';
import { cosineSimilarity } from '@flint/persona';

/** The slice of OllamaEmbedder the router needs; a stub in tests. */
export interface Embedder {
  embed(texts: string[]): Promise<number[][]>;
}

/**
 * How close an appended tool must be before it says the message needs to DO
 * things, which moves a routine one-liner to the standard tier. Higher than the
 * append floor on purpose. Measured 2026-09-30 on 504 real messages and 25 tool
 * asks (nomic-embed-text): at the 0.55 floor, unrelated tools reached greetings
 * ("How are you doing today Flint?" -> spend_status 0.602) and sent 5 of the 12
 * routine one-liners to Opus, none of which used the tool; a real ask can score
 * as low as that ("How much have I spent on Claude today?" -> spend_status
 * 0.603), so the floor itself stays low and the tool is still OFFERED. Only the
 * tier move waits for a clear match, e.g. the Nexus thread asks at 0.84.
 */
export const DEFAULT_TIER_TOOL_SCORE = 0.65;

/** FLINT_TIER_TOOL_SCORE, or the default when unset or not a score in [0, 1] (reported via `warn`). */
export function parseTierToolScore(raw: string | undefined, warn: (msg: string) => void = () => {}): number {
  const s = raw?.trim();
  if (!s) return DEFAULT_TIER_TOOL_SCORE;
  const n = Number(s);
  if (Number.isFinite(n) && n >= 0 && n <= 1) return n;
  warn(`[router] FLINT_TIER_TOOL_SCORE="${s}" is not a score from 0 to 1; using ${DEFAULT_TIER_TOOL_SCORE}`);
  return DEFAULT_TIER_TOOL_SCORE;
}

export interface RouterOptions {
  maxAppend?: number;
  floor?: number;
  /** An appended tool at or above this moves a routine one-liner to standard (see DEFAULT_TIER_TOOL_SCORE). */
  tierScore?: number;
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
    private readonly tierScore: number,
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
    const tierScore = opts.tierScore ?? parseTierToolScore(process.env.FLINT_TIER_TOOL_SCORE, (m) => console.error(m));
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
      tierScore,
      opts.retryMs ?? 60_000,
      opts.now ?? Date.now,
    );
    await router.ensureVectors();
    console.error(
      `[router] core=${finalCore.length} (cached) + up to ${maxAppend} of ${finalRest.length} by relevance (floor ${floor}; a tier move needs ${tierScore})`,
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

  /**
   * Whether the appended tools say the message needs to DO things: one at or
   * above the tier score, not merely over the append floor. classifyMessage's
   * `toolsLikely`, which moves a routine one-liner to the standard tier.
   */
  toolsLikely(appended: ReadonlyArray<{ score: number }>): boolean {
    return appended.some((a) => a.score >= this.tierScore);
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
    return (await this.selectScored(message)).tools;
  }

  /**
   * `select`, plus each appended tool's similarity score, for the route log: an
   * append is what moves a routine one-liner to the standard tier, and the
   * score against the floor says whether it was a clear match or a near miss.
   */
  async selectScored(message: string): Promise<{ tools: Tool[]; appended: Array<{ name: string; score: number }> }> {
    const none = { tools: this.core, appended: [] };
    if (this.maxAppend === 0 || this.rest.length === 0) return none;
    await this.ensureVectors();
    if (!this.appendsReady) return none;
    let qv: number[];
    try {
      qv = (await this.embedder.embed([message.slice(0, 2000)]))[0] ?? [];
    } catch {
      return none;
    }
    if (qv.length === 0) return none;
    const appends = this.rest
      .map((t, i) => ({ t, score: cosineSimilarity(qv, this.restVectors[i] ?? []) }))
      .filter((x) => x.score >= this.floor)
      .sort((a, b) => b.score - a.score)
      .slice(0, this.maxAppend);
    if (appends.length === 0) return none;
    return {
      tools: [...this.core, ...appends.map((x) => x.t)],
      appended: appends.map((x) => ({ name: x.t.definition.name, score: x.score })),
    };
  }
}
