/**
 * The tools an ask is offered when its brain was given Will's goals (P3 part
 * 4, ./goals-tools). A model that has read a goal can put its words in a tool
 * call, so for that ask the tools an OUTSIDE AI answers are not offered:
 *  - `trident.perplexity_search`, and whatever else the spend guard prices as
 *    an AI vendor's, or is named for one;
 *  - `deep_research` is offered in a local build: no frontier planner, and no
 *    Perplexity among its searches.
 * Plain web search and fetch_url stay. An ask that went without the goals (a
 * frontier tier, a turn with no goals, a block that did not fit) is offered
 * everything, as before; so is every ask once FLINT_GOALS_TO_FRONTIER=on.
 * What is left, and documented: a goal's words in a plain web search's query.
 * Synthetic text only. No network.
 */
import { afterEach, describe, it, expect } from 'vitest';
import type { Tool } from '@flint/core';
import { deepResearchTool } from '../src/deep-research';
import { aiBackedTools, isAiBacked, withoutOutsideAi } from '../src/goals-tools';
import { paidToolSpecs } from '../src/spend';
import { asLocalTurn } from '../src/turn-taint';
import { CANARY, answer, cleanup, miniServer as server, type Step } from './goals-mini';

afterEach(cleanup);

const specs = paidToolSpecs({});
/** A tool that keeps what it was called with and answers `result`. */
function stub(name: string, result: unknown = { results: [] }) {
  const calls: unknown[] = [];
  const tool: Tool = {
    definition: { name, description: `${name} (stub)`, inputSchema: { type: 'object', properties: { query: { type: 'string' } } }, idempotent: true },
    handler: async (call) => {
      calls.push(call.args);
      return result;
    },
  };
  return { tool, calls };
}
const names = (tools: readonly { definition?: { name: string }; name?: string }[]) => tools.map((t) => t.definition?.name ?? t.name);

describe('which tools an outside AI answers', () => {
  it('the paid tools whose vendor sells a model’s tokens: Perplexity’s search. A search index is not a model', () => {
    expect(specs.map((s) => [s.name, s.vendor])).toEqual([['trident.perplexity_search', 'perplexity'], ['web.web_search', 'tavily'], ['trident.web_search', 'tavily']]);
    expect(isAiBacked('trident.perplexity_search', specs)).toBe(true);
    for (const plain of ['web.web_search', 'trident.web_search', 'web.fetch_url', 'trident.gcal_upcoming', 'calculate', 'remember', 'deep_research', 'runtime.world_now', 'nexus.thread_list']) {
      expect(isAiBacked(plain, specs), plain).toBe(false);
    }
  });

  it('a paid tool priced on any AI vendor counts, whatever it is called', () => {
    const later = [...specs, { name: 'trident.ask_expert', vendor: 'openai' as const, kind: 'tool-search' as const, model: 'x', usdPerCall: () => 0.01, instead: [] }];
    expect(isAiBacked('trident.ask_expert', later)).toBe(true);
    expect(isAiBacked('trident.ask_expert', specs)).toBe(false);
  });

  it('and so does any tool named for an AI vendor, before anyone prices it', () => {
    for (const named of ['x.perplexity_ask', 'perplexity.search', 'trident.openai_summarize', 'web.ask-claude', 'tools.chatgpt', 'anthropic.messages', 'google.gemini_search']) {
      expect(isAiBacked(named, []), named).toBe(true);
    }
    // The vendor's name as a word of the tool's name, not as part of another word.
    for (const not of ['web.declaude', 'notes.geminids', 'x.openairlock', 'trident.perplexitysearch_log']) expect(isAiBacked(not, []), not).toBe(false);
  });

  it('aiBackedTools names them among the tools that are wired', () => {
    const wired = ['web.web_search', 'web.fetch_url', 'trident.perplexity_search', 'calculate'].map((n) => stub(n).tool);
    expect([...aiBackedTools(wired, specs)]).toEqual(['trident.perplexity_search']);
  });
});

describe('withoutOutsideAi: what an ask that carries the goals is offered', () => {
  it('the same tools in the same order, without the outside-AI ones, deep_research in its local build', () => {
    const standard = stub('deep_research').tool;
    const local = stub('deep_research').tool;
    const offered = [stub('remember').tool, standard, stub('web.web_search').tool, stub('web.fetch_url').tool, stub('trident.perplexity_search').tool, stub('trident.gcal_upcoming').tool, stub('x.ask-claude').tool];
    const kept = withoutOutsideAi({ specs, local: [local] })(offered);
    expect(names(kept)).toEqual(['remember', 'deep_research', 'web.web_search', 'web.fetch_url', 'trident.gcal_upcoming']);
    expect(kept[1]).toBe(local);
    expect(kept[1]).not.toBe(standard);
    // Every other tool is the very tool the turn had.
    expect(kept[0]).toBe(offered[0]);
    expect(kept[2]).toBe(offered[2]);
    // Nothing offered, nothing kept; no local build, nothing swapped.
    expect(withoutOutsideAi({ specs })([])).toEqual([]);
    expect(withoutOutsideAi({ specs })([standard])).toEqual([standard]);
  });
});

describe('deep_research in its local build, as main() builds it', () => {
  const question = `what should I do next on ${CANARY} goal 1?`;
  function wired() {
    const web = stub('web.web_search');
    const perplexity = stub('trident.perplexity_search', { content: 'an answer', citations: [] });
    const planned: string[] = [];
    const mcpTools = [web.tool, perplexity.tool, stub('web.fetch_url').tool];
    const fetchPage = async () => ({ body: '', contentType: 'text/plain' });
    const quiet = () => {};
    // The server's own: plans with a frontier model, asks every search tool it has.
    const standard = deepResearchTool({ tools: mcpTools, fetchPage, log: quiet, complete: async (prompt) => (planned.push(prompt), '["one query","another query","a third query"]') });
    // The local build (index.ts): no planner, and only the tools no outside AI answers.
    const local = deepResearchTool({ tools: mcpTools.filter((t) => !isAiBacked(t.definition.name, specs)), fetchPage, log: quiet });
    return { web, perplexity, planned, standard, local };
  }
  const run = (t: Tool) => t.handler({ id: 'r1', toolName: 'deep_research', args: { question } });

  it('the server’s own build sends the question to a frontier planner and to Perplexity: an outside AI answers it', async () => {
    const w = wired();
    await run(w.standard);
    expect(w.planned).toHaveLength(1);
    expect(w.planned[0]).toContain(CANARY);
    expect(w.perplexity.calls).toHaveLength(1);
    expect(JSON.stringify(w.perplexity.calls)).toContain(CANARY);
  });

  it('the local build asks neither: it plans by rule and searches only the plain web', async () => {
    const w = wired();
    const out = await run(w.local);
    expect(typeof out).toBe('string');
    expect(w.planned).toEqual([]);
    expect(w.perplexity.calls).toEqual([]);
    expect(w.web.calls.length).toBeGreaterThan(0);
    // What is left, and documented: the plain web search's query can hold a goal's words.
    expect(JSON.stringify(w.web.calls)).toContain(CANARY);
  });

  it('is the same tool to the model: one name, one description, one schema', () => {
    const w = wired();
    expect(w.local.definition).toEqual(w.standard.definition);
  });
});

describe('on the server in miniature: who is offered what, ask by ask', () => {
  const claude = [{ name: 'anthropic', model: 'claude-opus-5-5', script: ['answer'] as Step[] }];
  function tools() {
    const standard = stub('deep_research');
    const local = stub('deep_research');
    const offered = [stub('remember').tool, standard.tool, stub('web.web_search').tool, stub('web.fetch_url').tool, stub('trident.perplexity_search').tool, stub('trident.web_search').tool];
    return { offered, goalsTools: withoutOutsideAi({ specs, local: [local.tool] }) };
  }
  const ALL = ['remember', 'deep_research', 'web.web_search', 'web.fetch_url', 'trident.perplexity_search', 'trident.web_search'];
  const LOCAL_ONLY = ['remember', 'deep_research', 'web.web_search', 'web.fetch_url', 'trident.web_search'];

  it('the local model, given the goals, is not offered Perplexity; plain web search and fetch_url stay', async () => {
    const t = tools();
    const s = server({ frontier: claude, tools: t.offered, goalsTools: t.goalsTools });
    expect((await s.chat('local')).goalsTokens).toBeGreaterThan(0);
    expect(names(s.local.requests[0]!.tools ?? [])).toEqual(LOCAL_ONLY);
  });

  it('a frontier tier, which went without the goals, is offered everything as before', async () => {
    const t = tools();
    const s = server({ frontier: claude, tools: t.offered, goalsTools: t.goalsTools });
    expect((await s.chat('frontier')).goalsTokens).toBe(0);
    expect(names(s.tiers[0]!.requests[0]!.tools ?? [])).toEqual(ALL);
  });

  it('in one turn: the frontier tier that failed was offered everything, the local model that answered with the goals was not', async () => {
    const t = tools();
    const s = server({ frontier: [{ ...claude[0]!, script: ['fail'] }], tools: t.offered, goalsTools: t.goalsTools });
    const r = await s.chat('frontier');
    expect(r.answeredBy).toBe('local');
    expect(names(s.tiers[0]!.requests[0]!.tools ?? [])).toEqual(ALL);
    expect(names(s.local.requests[0]!.tools ?? [])).toEqual(LOCAL_ONLY);
  });

  it('the local model without the goals (there are none to give) is offered everything: nothing is held back that need not be', async () => {
    const t = tools();
    const s = server({ frontier: claude, tools: t.offered, goalsTools: t.goalsTools, goals: answer([]) });
    expect((await s.chat('local')).goalsTokens).toBe(0);
    expect(names(s.local.requests[0]!.tools ?? [])).toEqual(ALL);
  });

  it('the swap is the local build itself, not only its name', async () => {
    const standard = stub('deep_research').tool;
    const local = stub('deep_research').tool;
    const s = server({ frontier: claude, tools: [standard], goalsTools: withoutOutsideAi({ specs, local: [local] }) });
    const turn = await s.GOALS.forTurn();
    // As /chat asks the local model: as its own turn (./turn-taint asLocalTurn).
    expect(asLocalTurn(() => turn.ask(s.localPersona, { context: '', tools: [standard] })).tools).toEqual([local]);
    expect(turn.ask(s.chain[0]!.persona, { context: '', tools: [standard] }).tools).toEqual([standard]);
  });

  it('FLINT_GOALS_TO_FRONTIER=on lifts it: Will chose to send goal text out, so no tool is held back', async () => {
    const t = tools();
    const s = server({ frontier: claude, tools: t.offered, goalsTools: t.goalsTools, toFrontier: true });
    expect((await s.chat('local')).goalsTokens).toBeGreaterThan(0);
    expect(names(s.local.requests[0]!.tools ?? [])).toEqual(ALL);
    expect((await s.chat('frontier', 'again', 'c2')).goalsTokens).toBeGreaterThan(0);
    expect(names(s.tiers[0]!.requests[0]!.tools ?? [])).toEqual(ALL);
  });
});
