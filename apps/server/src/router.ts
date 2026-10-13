import type { Tool } from '@flint/core';
import { cosineSimilarity } from '@flint/persona';
import { logError } from './error-log';

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

/**
 * How long boot waits for Ollama to embed the rest tools before the server listens without
 * them. A warm embedder needs well under a second; an Ollama that is slow or silent finishes
 * (or fails) behind a server that is already up, and appends start when the vectors land.
 */
export const BOOT_EMBED_WAIT_MS = 3_000;

/** How long one pass over the rest tools may take before it counts as failed and is retried later. */
export const EMBED_DEADLINE_MS = 60_000;

export interface RouterOptions {
  maxAppend?: number;
  floor?: number;
  /** An appended tool at or above this moves a routine one-liner to standard (see DEFAULT_TIER_TOOL_SCORE). */
  tierScore?: number;
  /** Minimum gap between attempts to embed the rest tools after a failure. */
  retryMs?: number;
  now?: () => number;
  /** How long build() waits for the rest tools' vectors (default BOOT_EMBED_WAIT_MS). */
  bootWaitMs?: number;
  /** How long one embedding pass may take (default EMBED_DEADLINE_MS). */
  embedDeadlineMs?: number;
}

/** `p`, or a rejection after `ms` by the clock, whichever is first. The timer never keeps the process alive. */
function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      t = setTimeout(() => reject(Object.assign(new Error(what), { code: 'ETIMEDOUT' })), ms);
      t.unref?.();
    }),
  ]).finally(() => clearTimeout(t));
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
 *
 * Neither boot nor a turn waits on them for long. build() gives Ollama
 * BOOT_EMBED_WAIT_MS and then returns (a server that waited here never listened
 * while Ollama hung, and the installer's /health poll failed the deploy); a
 * message that arrives while they are still being built gets the core at once.
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
    private readonly embedDeadlineMs: number,
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
      opts.embedDeadlineMs ?? EMBED_DEADLINE_MS,
    );
    const bootWaitMs = opts.bootWaitMs ?? BOOT_EMBED_WAIT_MS;
    const embedded = router.ensureVectors();
    const inTime = await within(embedded.then(() => true), bootWaitMs, 'boot wait').catch(() => false);
    console.error(
      `[router] core=${finalCore.length} (cached) + up to ${maxAppend} of ${finalRest.length} by relevance (floor ${floor}; a tier move needs ${tierScore})`,
    );
    if (!inTime) {
      console.error(`[router] Ollama has not embedded the rest tools after ${bootWaitMs / 1000}s: starting with the core, and appends go live when it answers`);
      void embedded.then(() => {
        if (router.appendsReady) console.error('[router] rest embedding finished: appends live');
      });
    }
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
        // By the clock: an Ollama that takes the request and never answers would otherwise leave
        // this pass in flight for good, and appends off until the next restart.
        const v = await within(
          this.embedder.embed(this.rest.map((x) => `${x.definition.name}: ${x.definition.description}`)),
          this.embedDeadlineMs,
          `no answer in ${this.embedDeadlineMs / 1000}s`,
        );
        if (v.length !== this.rest.length) throw new Error(`got ${v.length} vectors for ${this.rest.length} tools`);
        this.restVectors = v;
        if (attempt > 1) console.error(`[router] rest embedding recovered on attempt ${attempt} — appends live`);
      } catch (err) {
        // Log the first failure only; a training run keeps ollama down for hours.
        if (attempt === 1) {
          logError(`[router] rest embedding failed — appends off, retrying every ${this.retryMs / 1000}s:`, err);
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
    // Vectors still being built (boot's, when Ollama was slow) are not waited for: this message
    // gets the core now. Otherwise this call makes the attempt, when one is due.
    if (!this.appendsReady && !this.embedding) await this.ensureVectors();
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
      // An appended tool was matched to THIS message: on a small window it is the last to be left out
      // (@flint/core Tool.keep), where it used to be the first (it is listed last).
      tools: [...this.core, ...appends.map((x) => ({ ...x.t, keep: true }))],
      appended: appends.map((x) => ({ name: x.t.definition.name, score: x.score })),
    };
  }
}
