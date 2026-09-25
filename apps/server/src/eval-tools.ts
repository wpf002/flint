/**
 * Eval-only server hooks for the "Flint tasks" suite in apps/parity (see its
 * README). Neither changes a normal turn.
 *
 * 1. `groundingChars` on an eval /generate. The suite hands each frontier
 *    competitor the data Flint's tools returned, so the comparison is answer
 *    quality on the same data. The eval response's `grounding` cuts every tool
 *    result to 800 characters (./grounding), which is a fraction of a 50-row
 *    Vantage or Gmail result, so a competitor would be judged on less data than
 *    Flint read. An eval request may ask for longer excerpts, up to
 *    GROUNDING_CHARS_MAX. Without the field nothing changes.
 *
 * 2. Discovery. The suite's prompts name real things in Will's systems (a
 *    ticker Meridian tracks, a Bellwether industry, a TDL rule id), picked when
 *    the task set is built rather than frozen into the repo. `GET /eval/tools`
 *    lists the wired tool names (to check the templates' expected tools), and
 *    `POST /eval/tool` runs ONE tool from DISCOVERY_TOOLS: a fixed, read-only
 *    allowlist. Anything else is refused before any handler runs, so this can't
 *    reach a write, and never creates an approval proposal.
 *
 * Kept free of index.ts so it is unit-testable (index.ts runs main() on import).
 */
import type { Tool } from '@flint/core';
import { TOOL_EXCERPT_CHARS, toolExcerpt } from './grounding';
import { isSafeTool } from './policy';

/** The shortest excerpt a request may ask for: the default. */
export const GROUNDING_CHARS_MIN = TOOL_EXCERPT_CHARS;
/** The longest: a big deep_research evidence pack or a 50-thread Gmail search fits. */
export const GROUNDING_CHARS_MAX = 32_000;

export type GroundingCharsRequest = { ok: true; chars: number | undefined } | { ok: false; status: 400; error: string };

/**
 * Validate the `groundingChars` field of a /generate body. `chars` is undefined
 * when none was asked for (all normal traffic). Like `styleVariant`: the value
 * is checked first, then the eval-only rule.
 */
export function parseGroundingCharsRequest(body: Record<string, unknown>): GroundingCharsRequest {
  const raw = body.groundingChars;
  if (raw === undefined || raw === null) return { ok: true, chars: undefined };
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < GROUNDING_CHARS_MIN || raw > GROUNDING_CHARS_MAX) {
    return { ok: false, status: 400, error: `groundingChars must be an integer from ${GROUNDING_CHARS_MIN} to ${GROUNDING_CHARS_MAX}` };
  }
  if (body.eval !== true) return { ok: false, status: 400, error: 'groundingChars is only accepted with eval: true' };
  return { ok: true, chars: raw };
}

/**
 * The only tools `POST /eval/tool` runs: reads that list what a system has, used
 * to fill a task template's slots. Every one is a read by the server's own gate
 * (policy.isSafeTool, checked again at call time), and none takes a write.
 */
export const DISCOVERY_TOOLS: readonly string[] = [
  'meridian.list_tickers',
  'meridian.bias_summary',
  'vantage.top_scores',
  'bellwether.list_industries',
  'prophet.list_models',
  'tdl.coverage',
  'tdl.recommendations',
  'nexus.thread_list',
  'nexus.read_canon',
];

export interface DiscoveryResponse {
  status: number;
  body: Record<string, unknown>;
}

/** What the audit hook is told about a discovery call (index.ts writes it to the action log). */
export interface DiscoveryAudit {
  name: string;
  args: Record<string, unknown>;
  result: unknown;
  isError: boolean;
  durationMs: number;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * `POST /eval/tool { eval: true, name, args }`: run one DISCOVERY_TOOLS tool and
 * return its result as text (cut to `maxChars`). 400 without `eval: true` or with
 * args that aren't an object, 403 for a tool outside the allowlist, 404 for one
 * that isn't wired (its server didn't connect), 502 when the tool throws.
 */
export async function runDiscoveryTool(opts: {
  tools: readonly Tool[];
  body: Record<string, unknown>;
  maxChars?: number;
  audit?: (entry: DiscoveryAudit) => void;
  now?: () => number;
}): Promise<DiscoveryResponse> {
  const { body } = opts;
  const now = opts.now ?? Date.now;
  if (body.eval !== true) return { status: 400, body: { error: '/eval/tool is only accepted with eval: true' } };
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return { status: 400, body: { error: 'name required' } };
  if (!DISCOVERY_TOOLS.includes(name) || !isSafeTool(name)) {
    return { status: 403, body: { error: `${name} is not a discovery tool (allowed: ${DISCOVERY_TOOLS.join(', ')})` } };
  }
  const rawArgs = body.args ?? {};
  if (!isPlainObject(rawArgs)) return { status: 400, body: { error: 'args must be an object' } };
  const tool = opts.tools.find((t) => t.definition.name === name);
  if (!tool) return { status: 404, body: { error: `${name} is not wired (its MCP server isn't connected)` } };
  const t0 = now();
  let result: unknown;
  try {
    result = await tool.handler({ id: `discovery-${t0}`, toolName: name, args: rawArgs });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    opts.audit?.({ name, args: rawArgs, result: message, isError: true, durationMs: now() - t0 });
    return { status: 502, body: { error: `${name} failed: ${message}` } };
  }
  const isError = isPlainObject(result) && result.isError === true;
  opts.audit?.({ name, args: rawArgs, result, isError, durationMs: now() - t0 });
  return { status: 200, body: { ok: true, name, isError, text: toolExcerpt(result, opts.maxChars ?? GROUNDING_CHARS_MAX) } };
}

/** `GET /eval/tools`: every wired tool's name, sorted. */
export function wiredToolNames(tools: readonly Tool[]): string[] {
  return tools.map((t) => t.definition.name).sort();
}
