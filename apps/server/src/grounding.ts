/**
 * What an eval turn was grounded on, for apps/parity `--judge-grounding`.
 *
 * The parity judge sees Flint's answer and a vendor's, and nothing else. When
 * Flint states something it read from long-term memory or a tool result (Will's
 * dog's name, a Vantage score, a calendar entry), the judge can't tell that from
 * an invention and scores it as a fabrication. So the /generate EVAL response
 * (never a normal one) carries what the turn had:
 *
 *   grounding: { memory: string[], tools: [{ name, isError, excerpt }] }
 *
 * `memory` is exactly the recalled facts injected into the turn's context block;
 * `tools` is every tool result the turn produced (that turn's only: see
 * TurnLog), each cut to 800 characters.
 * Building the context block lives here too, so the facts reported are the ones
 * the model saw. The block itself is byte-identical to what the server built
 * before, so answers don't change.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ActionEntry } from '@flint/core';

/**
 * Longest tool-result excerpt returned (and so shown to the judge) by default.
 * An eval request may ask for longer ones with `groundingChars` (./eval-tools):
 * the Flint-tasks suite hands competitors the same data Flint read, and 800
 * characters of a 50-row result is not the same data.
 */
export const TOOL_EXCERPT_CHARS = 800;

export interface GroundingTool {
  name: string;
  isError: boolean;
  excerpt: string;
}

export interface Grounding {
  /** The recalled long-term facts injected into the turn's context. */
  memory: string[];
  /** Every tool result the turn produced, in order. */
  tools: GroundingTool[];
}

/** The per-turn context block: `base` plus the recalled facts, if any. Same text the server has always sent. */
export function withMemory(base: string, facts: readonly string[]): string {
  if (facts.length === 0) return base;
  const block = facts.map((f) => `- ${f}`).join('\n');
  return `${base}\n[Long-term memory — things you already know about Will; use if relevant, don't recite back:\n${block}\n]`;
}

/**
 * Recall the facts relevant to `message` and build the context block from them.
 * Recall is best-effort: if it throws, the turn gets `base` alone and no facts.
 */
export async function recallContext(
  base: string,
  message: string,
  knowledge: { recall(query: string): Promise<string[]> },
): Promise<{ block: string; facts: string[] }> {
  let facts: string[] = [];
  try {
    facts = await knowledge.recall(message);
  } catch {
    /* memory recall is best-effort */
  }
  return { block: withMemory(base, facts), facts };
}

/**
 * The action-log entries of one request's turn, and no other's.
 *
 * The server has one action log, shared by the local brain, the bake-off
 * personas and every frontier tier. Reading "what was logged while this turn
 * ran" off it picks up whatever else ran at the same time: Will chatting (his
 * email or calendar results), a second harness, `--flint-concurrency` > 1. Those
 * excerpts would be shown to every judge, OpenAI in a panel included, as what
 * Flint had. So the turn runs inside `run()` (an AsyncLocalStorage scope), and
 * the log's `onEntry` hook, `recordTurnEntry`, files each entry under the turn
 * whose async context produced it. The core emits tool events from inside the
 * turn's own tool loop, so they land in the right turn; a request that isn't
 * in a scope (/chat, a normal /generate) is recorded nowhere but the log.
 *
 * This also doesn't depend on the log's 2000-entry ring buffer: once that is
 * full its length stops growing, so an index taken before the turn finds nothing.
 */
export class TurnLog {
  readonly entries: ActionEntry[] = [];
  private active = 0;

  /** Run `fn` as (part of) this turn: what the action log records inside it is this turn's. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    this.active++;
    try {
      return await turnScope.run(this, fn);
    } finally {
      this.active--;
    }
  }

  /**
   * Called by recordTurnEntry. Only while a run() is in flight: something the
   * turn started that outlives it (a timer, a lazily opened connection) keeps its
   * async context, and must not keep filling a finished turn's log.
   */
  record(entry: ActionEntry): void {
    if (this.active > 0) this.entries.push(entry);
  }

  /**
   * The `grounding` of the eval response: `facts` (the recalled memory) and this
   * turn's tool results, each cut to `maxChars` (default 800; an eval request's
   * `groundingChars` asks for more, see ./eval-tools).
   */
  grounding(facts: readonly string[], maxChars = TOOL_EXCERPT_CHARS): Grounding {
    return evalGrounding(facts, this.entries, maxChars);
  }
}

const turnScope = new AsyncLocalStorage<TurnLog>();

/** The action log's `onEntry` hook (index.ts): files the entry under the turn it was produced in, if any. */
export function recordTurnEntry(entry: ActionEntry): void {
  turnScope.getStore()?.record(entry);
}

/**
 * A tool result as text, cut to `max` characters (an ellipsis marks a cut).
 * Strings are used as they are; an MCP error (`{ isError, content }`) is its
 * content; anything else is JSON.
 */
export function toolExcerpt(result: unknown, max = TOOL_EXCERPT_CHARS): string {
  const text = resultText(result).trim();
  if (text.length <= max) return text;
  let cut = text.slice(0, Math.max(0, max - 1));
  // Don't leave half a surrogate pair at the end.
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut}…`;
}

function resultText(result: unknown): string {
  if (result === undefined || result === null) return '';
  if (typeof result === 'string') return result;
  if (typeof result === 'object' && !Array.isArray(result)) {
    const r = result as { isError?: unknown; content?: unknown };
    if (r.isError === true && 'content' in r) return resultText(r.content);
  }
  try {
    return JSON.stringify(result) ?? String(result);
  } catch {
    return String(result);
  }
}

/** The tool results among `entries`, as grounding, each cut to `maxChars`. */
export function groundingTools(entries: readonly ActionEntry[], maxChars = TOOL_EXCERPT_CHARS): GroundingTool[] {
  const out: GroundingTool[] = [];
  for (const e of entries) {
    if (e.type !== 'tool_result') continue;
    out.push({ name: e.tool, isError: e.isError, excerpt: toolExcerpt(e.result, maxChars) });
  }
  return out;
}

/** The `grounding` field of an eval /generate response. */
export function evalGrounding(facts: readonly string[], turnEntries: readonly ActionEntry[], maxChars = TOOL_EXCERPT_CHARS): Grounding {
  return { memory: [...facts], tools: groundingTools(turnEntries, maxChars) };
}
