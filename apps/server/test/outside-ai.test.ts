import { describe, it, expect } from 'vitest';
import type { Tool } from '@flint/core';
import {
  LOCAL_BUILTINS,
  LOCAL_SERVERS,
  OUTSIDE_OFF_LOCAL_MODE,
  OUTSIDE_OFF_PRIVATE,
  PRIVATE_TOOL_REFUSED,
  PRIVATE_TURN_NOTE,
  privateToolRefused,
  keptHereOnPrivate,
  keylessCapable,
  notOfferedOnPrivate,
  offered,
  offeredPrivate,
  outsideOffText,
  outsideTools,
  runsHere,
  withPrivateNote,
  withheldWhenOff,
} from '../src/outside-ai';
import { paidToolSpecs } from '../src/spend';

/**
 * Two promises, kept apart.
 *  - A PRIVATE turn: nothing leaves this Mac. Only the tools on an explicit
 *    list of ones that run here are offered, and any other refuses if called.
 *  - LOCAL MODE, an ordinary turn: no outside AI and no paid service. Every
 *    paid tool is one or the other (Perplexity's model answers, and Tavily's
 *    search comes back with an answer its own model wrote); keyless search,
 *    the page fetch and Will's account tools remain.
 */

const tool = (name: string, properties: Record<string, unknown> = {}): Tool => ({
  definition: { name, description: name, inputSchema: { type: 'object', properties }, idempotent: true },
  handler: () => `${name} ran`,
});
const specs = paidToolSpecs({});
/** The tools as the server has them wired: web.web_search has the keyless switch, trident's has none. */
const wired = [tool('web.web_search', { query: { type: 'string' }, keyless: { type: 'boolean' } }), tool('trident.perplexity_search'), tool('trident.web_search', { query: {}, search_depth: {} }), tool('web.fetch_url')];

describe('outsideTools', () => {
  // The routing review: this used to list Perplexity alone, and Tavily stayed on in Local mode as "plain web
  // search". Tavily is asked with include_answer, so what comes back includes an answer its model wrote.
  it('is the whole paid-tool table: Perplexity, and both Tavily searches', () => {
    expect([...outsideTools(specs)].sort()).toEqual(['trident.perplexity_search', 'trident.web_search', 'web.web_search']);
  });

  it('covers any tool added to the table, on any vendor', () => {
    expect([...outsideTools([{ name: 'x.ask_claude' }, { name: 'x.search' }])]).toEqual(['x.ask_claude', 'x.search']);
  });
});

describe('keylessCapable / withheldWhenOff', () => {
  it('a paid search with a keyless switch that is really wired can run with no outside service', () => {
    expect([...keylessCapable(wired, specs)]).toEqual(['web.web_search']);
    expect([...withheldWhenOff(wired, specs)].sort()).toEqual(['trident.perplexity_search', 'trident.web_search']);
  });

  it('an older web server whose search has no keyless switch is as outside as any other', () => {
    const older = [tool('web.web_search', { query: { type: 'string' } }), tool('trident.perplexity_search')];
    expect([...keylessCapable(older, specs)]).toEqual([]);
    expect([...withheldWhenOff(older, specs)].sort()).toEqual(['trident.perplexity_search', 'trident.web_search', 'web.web_search']);
  });

  it('before the tools are known, everything in the table is withheld', () => {
    expect([...withheldWhenOff([], specs)].sort()).toEqual(['trident.perplexity_search', 'trident.web_search', 'web.web_search']);
  });
});

describe('offered', () => {
  const withheld = withheldWhenOff(wired, specs);

  it('with outside services off: the keyless search and the page fetch stay; Perplexity and the search with no keyless switch are not offered', () => {
    expect(offered(wired, withheld, true).map((t) => t.definition.name)).toEqual(['web.web_search', 'web.fetch_url']);
  });

  it('otherwise everything is offered, in the same order', () => {
    expect(offered(wired, withheld, false).map((t) => t.definition.name)).toEqual(['web.web_search', 'trident.perplexity_search', 'trident.web_search', 'web.fetch_url']);
  });
});

describe('a private turn: only the tools that run on this Mac', () => {
  // Everything a server like this one has wired: search, fetch, Google, research, memory, the runtime's reads.
  const everything = [
    ...wired,
    tool('google.gmail_search'),
    tool('google.calendar_list_events'),
    tool('google.drive_search'),
    tool('deep_research'),
    tool('remember'),
    tool('training_status'),
    tool('calculate'),
    tool('spend_status'),
    tool('runtime.world_search'),
    tool('runtime.inbox_recent'),
    tool('vantage.query'),
    tool('computer.screenshot'),
  ];

  it('the list is explicit and short: four built-ins, and the runtime connector\'s reads of this Mac\'s own data', () => {
    expect([...LOCAL_BUILTINS].sort()).toEqual(['calculate', 'remember', 'spend_status', 'training_status']);
    expect([...LOCAL_SERVERS]).toEqual(['runtime']);
  });

  it('runsHere: a name is on the list or it is not; nothing is inferred from how a name looks', () => {
    for (const name of ['remember', 'calculate', 'training_status', 'spend_status', 'runtime.world_search', 'runtime.anything_new']) expect(runsHere(name), name).toBe(true);
    for (const name of ['web.web_search', 'web.fetch_url', 'google.gmail_search', 'deep_research', 'trident.web_search', 'local.search', 'runtime', '.runtime', 'runtimex.read', 'xruntime.read', 'remember.more', '']) {
      expect(runsHere(name), name).toBe(false);
    }
  });

  it('offeredPrivate: no web search of any kind, no page fetch, no Google tool, no research', () => {
    expect(offeredPrivate(everything).map((t) => t.definition.name)).toEqual(['remember', 'training_status', 'calculate', 'spend_status', 'runtime.world_search', 'runtime.inbox_recent']);
    expect(offeredPrivate(wired)).toEqual([]);
  });

  it('keptHereOnPrivate: a tool that does not run here refuses when it is called on a private turn, whoever calls it', async () => {
    let isPrivate = false;
    const refused: string[] = [];
    const calls: string[] = [];
    const real = everything.map((t) => ({ ...t, handler: () => (calls.push(t.definition.name), `${t.definition.name} ran`) }));
    const kept = keptHereOnPrivate(real, { isPrivate: () => isPrivate, onRefused: (name) => refused.push(name) });
    const call = (name: string) => kept.find((t) => t.definition.name === name)!.handler({ id: '1', name, args: {} } as never);
    // An ordinary turn: every tool runs as it did.
    expect(await call('web.web_search')).toBe('web.web_search ran');
    expect(await call('google.gmail_search')).toBe('google.gmail_search ran');
    calls.length = 0;
    // A private turn: asked at call time, so a tool the model was never offered refuses too.
    isPrivate = true;
    for (const name of ['web.web_search', 'web.fetch_url', 'trident.perplexity_search', 'google.gmail_search', 'google.calendar_list_events', 'deep_research', 'vantage.query', 'computer.screenshot']) {
      expect(await call(name), name).toEqual({ isError: true, content: PRIVATE_TOOL_REFUSED });
    }
    expect(calls).toEqual([]); // not one of them ran
    expect(refused).toHaveLength(8);
    // The ones that run here are the very same objects: nothing wraps them.
    for (const name of ['remember', 'calculate', 'runtime.world_search']) {
      expect(kept.find((t) => t.definition.name === name)).toBe(real.find((t) => t.definition.name === name));
      expect(await call(name)).toBe(`${name} ran`);
    }
    // The definitions the model sees are untouched.
    expect(kept.map((t) => t.definition)).toEqual(real.map((t) => t.definition));
  });

  // The privacy review's M34. A private turn is not OFFERED the tools that leave this Mac, so a model that names one
  // anyway (it used web search earlier in the conversation) calls a tool its turn does not have. Nothing runs, and
  // the model used to be told "Unknown tool": now it is told why, in the rule's own sentence.
  it('notOfferedOnPrivate: a tool the private turn was not offered answers with the private rule’s sentence, not "Unknown tool"', () => {
    let isPrivate = true;
    const refused: string[] = [];
    const names = everything.map((t) => t.definition.name);
    const rule = { isPrivate: () => isPrivate, onRefused: (name: string) => refused.push(name) };
    const ask = (called: string) => notOfferedOnPrivate(called, names, rule);
    for (const name of ['web.web_search', 'web.fetch_url', 'trident.perplexity_search', 'google.gmail_search', 'deep_research', 'vantage.query', 'computer.screenshot']) {
      expect(ask(name), name).toEqual({ isError: true, content: PRIVATE_TOOL_REFUSED });
    }
    expect(refused).toEqual(['web.web_search', 'web.fetch_url', 'trident.perplexity_search', 'google.gmail_search', 'deep_research', 'vantage.query', 'computer.screenshot']);
    // A name the model mangled the way models do still means the tool it means.
    for (const name of ['web__web_search', 'WEB.WEB_SEARCH', 'gmail_search', 'fetch_url', 'deepresearch']) expect(ask(name), name).toEqual({ isError: true, content: PRIVATE_TOOL_REFUSED });
    refused.length = 0;
    // A tool that runs here was offered, so it is not this function's to answer; a name that is nobody's gets the default.
    for (const name of ['remember', 'calculate', 'runtime.world_search', 'no_such_tool', '', 'web']) expect(ask(name), name).toBeUndefined();
    // Not a private turn: the default answer, whatever is called. (An ordinary turn that was not offered a tool is not told it is private.)
    isPrivate = false;
    for (const name of ['web.web_search', 'deep_research', 'remember']) expect(ask(name), name).toBeUndefined();
    expect(refused).toEqual([]);
    // With the local model on a server Will allowed, the sentence names it, as the tools' own refusal does.
    expect(notOfferedOnPrivate('web.web_search', names, { isPrivate: () => true, allowedRemote: () => true })).toEqual({ isError: true, content: privateToolRefused(true) });
    expect(privateToolRefused(true)).not.toBe(PRIVATE_TOOL_REFUSED);
  });

  it('the wrappers and that answer read ONE rule: the same object decides both, so they cannot disagree', async () => {
    let isPrivate = false;
    const rule = { isPrivate: () => isPrivate };
    const kept = keptHereOnPrivate([{ ...tool('web.web_search'), handler: () => 'ran' }], rule);
    const both = async () => [await kept[0]!.handler({ id: '1', name: 'web.web_search', args: {} } as never), notOfferedOnPrivate('web.web_search', ['web.web_search'], rule)];
    expect(await both()).toEqual(['ran', undefined]);
    isPrivate = true;
    expect(await both()).toEqual([{ isError: true, content: PRIVATE_TOOL_REFUSED }, { isError: true, content: PRIVATE_TOOL_REFUSED }]);
  });

  it('the model is told once, in one plain sentence, and only on a private turn', () => {
    expect(PRIVATE_TURN_NOTE).toBe('[Private message: nothing outside this Mac is asked for it, so answer from this conversation and what you already know, with no web search, page reading, account lookup or research.]');
    expect(withPrivateNote('the clock', true)).toBe(`the clock\n\n${PRIVATE_TURN_NOTE}`);
    expect(withPrivateNote('', true)).toBe(PRIVATE_TURN_NOTE);
    expect(withPrivateNote('the clock', false)).toBe('the clock');
  });
});

describe('outsideOffText', () => {
  const all = new Set(wired.map((t) => t.definition.name));

  it('Local mode: says why, and names only what still works and is neither an outside AI nor paid', () => {
    const local = outsideOffText(OUTSIDE_OFF_LOCAL_MODE, { wired: all, keyless: new Set(['web.web_search']), fetchTool: 'web.fetch_url' });
    expect(local).toBe('Flint is in Local mode, which uses no outside AI and no paid service. Use web.web_search or web.fetch_url instead, or answer from what you already know and say that live research is limited right now.');
    expect(local).not.toMatch(/perplexity|trident/); // it never sends the model to another outside tool
  });

  it('a private turn: nothing outside this Mac works, so it names no tool at all', () => {
    const priv = outsideOffText(OUTSIDE_OFF_PRIVATE, { wired: all, keyless: new Set(['web.web_search']), fetchTool: 'web.fetch_url' });
    expect(priv).toBe(PRIVATE_TOOL_REFUSED);
    expect(priv).toBe('This message is private, so nothing outside this Mac is asked. Answer from what you already know, and say that searching is not available for a private message.');
    expect(priv).not.toMatch(/web\.|fetch_url|perplexity|trident|Use /);
  });

  it('with nothing left to use: answer from what it knows', () => {
    expect(outsideOffText(OUTSIDE_OFF_LOCAL_MODE, { wired: new Set(['trident.perplexity_search']), keyless: new Set(), fetchTool: 'web.fetch_url' })).toBe(
      'Flint is in Local mode, which uses no outside AI and no paid service. Answer from what you already know, and say that live search is not available right now.',
    );
    // A keyless search that is not wired is not named.
    expect(outsideOffText(OUTSIDE_OFF_LOCAL_MODE, { wired: new Set(['web.fetch_url']), keyless: new Set(['web.web_search']), fetchTool: 'web.fetch_url' })).toContain('Use web.fetch_url instead');
  });
});
