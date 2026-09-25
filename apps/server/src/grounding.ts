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
 * `tools` is every tool result the turn produced, each cut to 800 characters.
 * Building the context block lives here too, so the facts reported are the ones
 * the model saw. The block itself is byte-identical to what the server built
 * before, so answers don't change.
 */
import type { ActionEntry } from '@flint/core';

/** Longest tool-result excerpt returned (and so shown to the judge). */
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
 * A position in the action log. The log is a bounded ring buffer (2000 entries):
 * once it's full, its length stops growing, so "entries after index N" (what
 * toolsSince does) finds nothing. This remembers the last entry instead, which
 * stays findable until it's evicted.
 */
export interface LogMark {
  last: ActionEntry | undefined;
}

export function markLog(entries: readonly ActionEntry[]): LogMark {
  return { last: entries[entries.length - 1] };
}

/**
 * The entries recorded after `mark`. If the marked entry has been evicted, every
 * entry still in the buffer is newer than it, so all of them are returned.
 */
export function entriesSince(entries: readonly ActionEntry[], mark: LogMark): ActionEntry[] {
  if (!mark.last) return [...entries];
  const i = entries.lastIndexOf(mark.last);
  return i < 0 ? [...entries] : entries.slice(i + 1);
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

/** The tool results among `entries`, as grounding. */
export function groundingTools(entries: readonly ActionEntry[]): GroundingTool[] {
  const out: GroundingTool[] = [];
  for (const e of entries) {
    if (e.type !== 'tool_result') continue;
    out.push({ name: e.tool, isError: e.isError, excerpt: toolExcerpt(e.result) });
  }
  return out;
}

/** The `grounding` field of an eval /generate response. */
export function evalGrounding(facts: readonly string[], turnEntries: readonly ActionEntry[]): Grounding {
  return { memory: [...facts], tools: groundingTools(turnEntries) };
}
