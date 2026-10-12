/**
 * The tools an ask is offered when its brain was given Will's goals (Machine
 * plan P3 part 4). A local model that has read a goal can put its words in a
 * tool call. So for that ask, the tools an OUTSIDE AI answers are not offered:
 * the goal's words must not reach another company's model through a side door.
 *
 * Which tools those are:
 *  - a paid tool whose vendor sells a model's tokens, as the spend guard knows
 *    it (./spend paidToolSpecs): today `trident.perplexity_search`. Tavily is a
 *    search index, not a model, so plain web search stays; so does fetch_url;
 *  - any tool named for an AI vendor (`perplexity`, `openai`, `anthropic`,
 *    `claude`, `chatgpt`, `gemini` as a word of its name), so one wired later
 *    is caught before anyone prices it;
 *  - `deep_research` as the server builds it: it plans its queries with a
 *    frontier model and asks Perplexity once. It is not dropped, it is swapped
 *    for a local build of the same tool (no planner, so it plans by rule, and
 *    only the search tools that are left), under the same name and schema.
 *
 * What this does not do: a local model may still put a goal's words in a plain
 * web search's query. That goes to a search engine, not to a model, and is the
 * same as anything Will types or Flint remembers about him.
 *
 * Kept free of index.ts so it is unit-testable (index.ts runs main() on import).
 */
import { vendorOfProvider, type Tool } from '@flint/core';
import type { PaidToolSpec } from './spend';

/** A tool named for an AI vendor: the vendor's name as one word of the tool's name. */
const AI_VENDOR_NAME = /(^|[._-])(perplexity|openai|anthropic|claude|chatgpt|gemini)([._-]|$)/i;

/** Is this tool answered by an outside AI, by the spend guard's list or by its name? */
export function isAiBacked(name: string, specs: readonly PaidToolSpec[]): boolean {
  // An AI vendor is one a brain can be on: the vendors that bill model tokens (anthropic, openai, perplexity).
  if (specs.some((s) => s.name === name && vendorOfProvider(s.vendor) !== undefined)) return true;
  return AI_VENDOR_NAME.test(name);
}

/** The names, among these tools, that an outside AI answers. */
export function aiBackedTools(tools: readonly Tool[], specs: readonly PaidToolSpec[]): Set<string> {
  return new Set(tools.map((t) => t.definition.name).filter((n) => isAiBacked(n, specs)));
}

/**
 * What an ask that carries Will's goals is offered, from what the turn would
 * have offered: the same tools in the same order, without the ones an outside
 * AI answers, and with each `local` tool in place of the one that shares its
 * name (deep_research's local build).
 */
export function withoutOutsideAi(o: { specs: readonly PaidToolSpec[]; local?: readonly Tool[] }): (offered: readonly Tool[]) => Tool[] {
  const swap = new Map((o.local ?? []).map((t) => [t.definition.name, t] as const));
  return (offered) => offered.flatMap((t) => (isAiBacked(t.definition.name, o.specs) ? [] : [swap.get(t.definition.name) ?? t]));
}
