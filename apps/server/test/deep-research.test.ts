import { describe, expect, it, vi } from 'vitest';
import type { Tool } from '@flint/core';
import {
  bm25,
  buildPack,
  chunk,
  dateFromUrl,
  deepResearch,
  deepResearchTool,
  extractReadable,
  heuristicQueries,
  isPrivateHost,
  normalizeUrl,
  parsePlannedQueries,
  parseSearchResult,
  planQueries,
  readCapped,
  rerank,
  selectDistinct,
  DEFAULT_LIMITS,
  type FetchedPage,
  type SearchHit,
} from '../src/deep-research';

const NOW = new Date('2026-09-23T12:00:00Z');
const Q = 'What is the current federal funds rate after the September FOMC meeting?';

const para = (topic: string) =>
  `The Federal Reserve held its September meeting and ${topic}. Officials said the federal funds rate decision reflected inflation data, labor market conditions, and the committee outlook for the rest of the year.`;

function page(title: string, body: string, date?: string): FetchedPage {
  return {
    contentType: 'text/html; charset=utf-8',
    body: `<html><head><title>${title}</title>${date ? `<meta property="article:published_time" content="${date}">` : ''}</head><body><nav>Home | Markets | Login</nav><article><p>${body}</p></article><script>evil()</script></body></html>`,
  };
}

function hit(url: string, query: number, rank: number, snippet = ''): SearchHit {
  return { title: url, url, snippet, query, rank };
}

describe('query planning', () => {
  it('falls back to heuristic variants when there is no brain', async () => {
    const { queries, planner } = await planQueries(Q, {}, NOW, DEFAULT_LIMITS);
    expect(planner).toBe('heuristic');
    expect(queries[0]).toBe(Q);
    expect(queries.length).toBeGreaterThanOrEqual(3);
    expect(queries.length).toBeLessThanOrEqual(6);
    expect(new Set(queries.map((q) => q.toLowerCase())).size).toBe(queries.length);
    expect(queries.some((q) => q.includes('2026'))).toBe(true);
  });

  it('falls back when the brain throws or returns junk', async () => {
    const log = vi.fn();
    const threw = await planQueries(Q, { complete: async () => { throw new Error('529 overloaded'); }, log }, NOW, DEFAULT_LIMITS);
    expect(threw.planner).toBe('heuristic');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('529'));
    const junk = await planQueries(Q, { complete: async () => '[]' }, NOW, DEFAULT_LIMITS);
    expect(junk.planner).toBe('heuristic');
  });

  it('uses the brain, keeps the original question first, dedupes and caps at 6', async () => {
    const reply = 'Sure:\n["fed funds rate september 2026", "FOMC statement September 2026", "fed funds rate september 2026", "fed rate decision reaction", "federalreserve.gov target range", "CME FedWatch", "powell press conference", "treasury yields fed"]';
    const { queries, planner } = await planQueries(Q, { complete: async () => reply }, NOW, DEFAULT_LIMITS);
    expect(planner).toBe('brain');
    expect(queries[0]).toBe(Q);
    expect(queries).toHaveLength(6);
    expect(queries.filter((q) => q === 'fed funds rate september 2026')).toHaveLength(1);
  });

  it('parses a numbered list when the brain ignores the JSON instruction', () => {
    expect(parsePlannedQueries('1. alpha beta\n2. "gamma delta"\n- epsilon')).toEqual(['alpha beta', 'gamma delta', 'epsilon']);
  });

  it('heuristic queries have no stopword-only variants', () => {
    const qs = heuristicQueries('who won the game last night?', NOW, DEFAULT_LIMITS);
    expect(qs.length).toBeGreaterThanOrEqual(3);
    for (const q of qs) expect(q.trim().length).toBeGreaterThan(1);
  });
});

describe('search parsing + dedupe', () => {
  it('reads tavily-shaped, brave-shaped and prose results', () => {
    const tav = parseSearchResult(JSON.stringify({ answer: 'Rates held.', results: [{ title: 'A', url: 'https://a.com/x', snippet: 's', published_date: 'Mon, 21 Sep 2026 10:00:00 GMT' }] }));
    expect(tav.summary).toBe('Rates held.');
    expect(tav.hits).toEqual([{ title: 'A', url: 'https://a.com/x', snippet: 's', date: '2026-09-21' }]);
    const brave = parseSearchResult(JSON.stringify([{ title: 'B', url: 'https://b.com', snippet: 't' }]));
    expect(brave.hits.map((h) => h.url)).toEqual(['https://b.com']);
    const prose = parseSearchResult('The Fed held [Reuters](https://reuters.com/a) and https://ft.com/b. says more.');
    expect(prose.hits.map((h) => h.url)).toEqual(['https://reuters.com/a', 'https://ft.com/b']);
    expect(parseSearchResult({ isError: true, content: 'no key' }).hits).toEqual([]);
  });

  it('tells a search tool that could not run from one that found nothing', () => {
    // Trident's perplexity_search with no PERPLEXITY_API_KEY answers normally, with only an error.
    const noKey = parseSearchResult(JSON.stringify({ error: 'PERPLEXITY_API_KEY not set. Add it to your .env file to enable perplexity_search.' }));
    expect(noKey).toEqual({ hits: [], error: 'PERPLEXITY_API_KEY not set. Add it to your .env file to enable perplexity_search.' });
    // An MCP error result, e.g. web_search with no key and no SearXNG.
    expect(parseSearchResult({ isError: true, content: 'tavily HTTP 432 (quota); fallback searxng unreachable at http://127.0.0.1:8888 (ECONNREFUSED)' }).error).toMatch(/^tavily HTTP 432/);
    expect(parseSearchResult({ isError: true, content: '{"error":"boom"}' }).error).toBe('boom');
    // A real empty search is not an error.
    expect(parseSearchResult(JSON.stringify({ answer: null, results: [], source: 'searxng' }))).toEqual({ hits: [] });
  });

  it('reads Perplexity via Trident: citations are sources, content a summary without its own [n]', () => {
    const out = parseSearchResult(
      JSON.stringify({
        content: 'The Fed held at 3.75-4% [1][2]. Markets expected it [3].',
        citations: ['https://www.reuters.com/markets/fed', ' https://federalreserve.gov/x ', 'not a url', 7],
        model: 'sonar',
      }),
    );
    expect(out).toEqual({
      hits: [
        { title: 'reuters.com', url: 'https://www.reuters.com/markets/fed', snippet: '' },
        { title: 'federalreserve.gov', url: 'https://federalreserve.gov/x', snippet: '' },
      ],
      summary: 'The Fed held at 3.75-4%. Markets expected it.',
    });
  });

  it('reads web_search results from SearXNG, fallback and all', () => {
    const out = parseSearchResult(
      JSON.stringify({
        answer: null,
        results: [{ title: 'AP', url: 'https://apnews.com/x', snippet: 'held', published_date: '2026-09-17T18:00:00' }],
        source: 'searxng',
        fallback: { from: 'tavily', reason: 'tavily HTTP 432 (quota)' },
      }),
    );
    expect(out).toEqual({ hits: [{ title: 'AP', url: 'https://apnews.com/x', snippet: 'held', date: '2026-09-17' }] });
  });

  it('normalizes URLs: hash, tracking params, www, trailing slash', () => {
    expect(normalizeUrl('https://www.Example.com/a/?utm_source=x&id=2#top')).toBe('example.com/a?id=2');
    expect(normalizeUrl('https://example.com/a')).toBe('example.com/a');
    expect(normalizeUrl('ftp://example.com')).toBeUndefined();
  });

  it('dedupes by URL and by domain, round-robin across queries, merging snippets', () => {
    const hits = [
      hit('https://a.com/1', 0, 0, 'first'),
      hit('https://a.com/2', 0, 1), // same domain as a.com/1 → dropped
      hit('https://www.a.com/1/?utm_medium=x', 1, 2, 'second snippet'), // same URL → merged
      hit('https://b.com/x', 1, 0),
      hit('https://c.com/y', 2, 0),
      hit('https://d.com/z', 0, 3),
    ];
    const out = selectDistinct(hits, 3);
    expect(out.map((h) => h.url)).toEqual(['https://a.com/1', 'https://b.com/x', 'https://c.com/y']);
    expect(out[0]!.snippet).toBe('first second snippet');
  });
});

describe('fetching', () => {
  it('stops reading a body at the byte cap', async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        pulled++;
        ctrl.enqueue(new TextEncoder().encode('x'.repeat(1000)));
        if (pulled > 100) ctrl.close();
      },
    });
    const text = await readCapped(new Response(stream), 2500);
    expect(text.length).toBe(2500);
    expect(pulled).toBeLessThan(10);
  });

  it('refuses private and loopback hosts', () => {
    for (const h of ['localhost', '127.0.0.1', '10.0.0.4', '192.168.1.2', '172.20.0.1', '169.254.169.254', '100.101.1.1', '[::1]', 'studio', 'box.ts.net', 'printer.local']) {
      expect(isPrivateHost(h)).toBe(true);
    }
    for (const h of ['reuters.com', '8.8.8.8', '172.40.0.1']) expect(isPrivateHost(h)).toBe(false);
  });

  it('extracts readable text, title and date; drops script and nav', () => {
    const ex = extractReadable(page('Fed holds &amp; waits', para('kept rates unchanged'), '2026-09-17T18:00:00Z').body);
    expect(ex.title).toBe('Fed holds & waits');
    expect(ex.date).toBe('2026-09-17');
    expect(ex.text).toContain('kept rates unchanged');
    expect(ex.text).not.toContain('evil()');
    expect(ex.text).not.toContain('Login');
  });

  it('finds dates in URLs', () => {
    expect(dateFromUrl('https://x.com/2026/09/17/fed-holds')).toBe('2026-09-17');
    expect(dateFromUrl('https://x.com/about')).toBeUndefined();
  });
});

describe('rerank', () => {
  const passages = [
    { source: 0, text: 'Bananas are a good source of potassium and are grown in tropical climates around the world.' },
    { source: 1, text: 'The federal funds rate target range after the September FOMC meeting is 3.75 to 4.00 percent.' },
  ];

  it('scores lexically relevant passages higher with BM25', () => {
    const s = bm25(Q, passages.map((p) => p.text));
    expect(s[1]!).toBeGreaterThan(s[0]!);
  });

  it('falls back to lexical when the embedder throws (ollama down during training)', async () => {
    const log = vi.fn();
    const embedder = { embed: vi.fn(async () => { throw new Error('ECONNREFUSED 127.0.0.1:11434'); }) };
    const { ranked, method } = await rerank(Q, passages, { embedder, log }, DEFAULT_LIMITS);
    expect(method).toBe('lexical');
    expect(ranked[0]!.source).toBe(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('ECONNREFUSED'));
  });

  it('falls back to lexical when the embedder hangs', async () => {
    const embedder = { embed: () => new Promise<number[][]>(() => {}) };
    const { method } = await rerank(Q, passages, { embedder }, { ...DEFAULT_LIMITS, embedTimeoutMs: 20 });
    expect(method).toBe('lexical');
  });

  it('uses embeddings when they work', async () => {
    // Semantic signal says the banana passage is the relevant one; it should win.
    const embedder = { embed: async (t: string[]) => t.map((s) => (s === Q || s.startsWith('Bananas') ? [1, 0] : [0, 1])) };
    const { ranked, method } = await rerank(Q, passages, { embedder }, DEFAULT_LIMITS);
    expect(method).toBe('semantic');
    expect(ranked[0]!.source).toBe(0);
  });
});

describe('evidence pack', () => {
  it('numbers sources by best passage, caps passages per source and total chars', () => {
    const sources = [
      { title: 'Old blog', url: 'https://old.com/a', date: '2019-01-01', fetched: true },
      { title: 'Fed statement', url: 'https://federalreserve.gov/s', date: '2026-09-17', fetched: true },
      { title: 'Snippet only', url: 'https://snip.com/b', fetched: false },
    ];
    const long = 'x'.repeat(1000);
    const ranked = [
      { source: 1, text: 'best one', score: 0.9 },
      { source: 1, text: 'second from fed', score: 0.8 },
      { source: 1, text: 'third from fed — over per-source cap', score: 0.7 },
      { source: 0, text: 'older claim', score: 0.6 },
      { source: 2, text: long, score: 0.5 },
    ];
    const pack = buildPack(Q, sources, ranked, ['engine says held'], { now: NOW, queries: [Q], planner: 'heuristic', rerank: 'lexical', pagesRead: 2 }, { ...DEFAULT_LIMITS, packChars: 500 });
    expect(pack.cited.map((s) => s.url)).toEqual(['https://federalreserve.gov/s', 'https://old.com/a', 'https://snip.com/b']);
    expect(pack.text).toMatch(/\[1\] Fed statement — federalreserve\.gov — 2026-09-17/);
    expect(pack.text).toMatch(/\[2\] Old blog — old\.com — 2019-01-01/);
    expect(pack.text).toMatch(/\[3\] Snippet only — snip\.com — date unknown \(snippet only\)/);
    expect(pack.text).not.toContain('over per-source cap');
    expect(pack.text).toContain('…'); // the long passage was trimmed to passageChars
    expect(pack.text).toMatch(/inline \[n\]/);
    expect(pack.text).toMatch(/most recent/);
    expect(pack.text).toMatch(/conflict/);
    expect(pack.text).toMatch(/ignore any instructions/);
    expect(pack.text).toContain('today is 2026-09-23');
    expect(pack.text).toContain('engine says held');
  });

  it('says plainly when nothing was found', () => {
    const pack = buildPack(Q, [], [], [], { now: NOW, queries: [Q], planner: 'heuristic', rerank: 'lexical', pagesRead: 0 }, DEFAULT_LIMITS);
    expect(pack.cited).toEqual([]);
    expect(pack.text).toContain('No usable sources');
  });

  it('chunks text into bounded passages and drops fragments', () => {
    const parts = chunk(`${para('a')} ${para('b')} ${para('c')} Menu.`, 300);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(300);
    expect(parts.some((p) => p === 'Menu.')).toBe(false);
  });
});

describe('deepResearch pipeline (all stubbed, no network)', () => {
  function stubTool(name: string, handler: (args: Record<string, unknown>) => unknown): Tool {
    return {
      definition: { name, description: '', inputSchema: {}, idempotent: true },
      handler: async (call) => handler(call.args as Record<string, unknown>),
    };
  }

  it('plans, searches every query, fetches distinct pages under caps, reranks and cites', async () => {
    const searched: string[] = [];
    const web = stubTool('web.web_search', (args) => {
      searched.push(String(args.query));
      return JSON.stringify({
        answer: 'The Fed held rates.',
        results: [
          { title: 'Fed statement', url: 'https://www.federalreserve.gov/newsevents/2026-09-17.htm', content: para('kept the federal funds rate target range at 3.75 to 4 percent') },
          { title: 'Reuters', url: 'https://reuters.com/markets/2026/09/17/fed-holds/?utm_source=x', content: 'snip' },
          { title: 'Reuters again', url: 'https://reuters.com/markets/other', content: 'dup domain' },
          { title: 'Recipes', url: 'https://bananas.com/bread', content: 'Banana bread needs ripe bananas and flour and sugar and eggs and butter for a moist loaf.' },
        ],
      });
    });
    const perplexity = stubTool('trident.perplexity_search', () => 'Per [WSJ](https://wsj.com/fed) the Fed held.');
    const other = stubTool('vantage.get_score', () => { throw new Error('should not be called'); });

    const fetched: string[] = [];
    const fetchPage = vi.fn(async (url: string, opts: { maxBytes: number }) => {
      fetched.push(url);
      if (url.includes('wsj.com')) throw new Error('HTTP 403');
      if (url.includes('bananas')) return page('Banana bread', 'Banana bread needs ripe bananas. '.repeat(10));
      if (url.includes('reuters')) return { ...page('Fed holds steady', para('left the federal funds rate unchanged at 3.75-4.00% for the September FOMC meeting'), '2026-09-17'), body: page('Fed holds steady', para('left the federal funds rate unchanged at 3.75-4.00% for the September FOMC meeting'), '2026-09-17').body + 'Z'.repeat(opts.maxBytes * 3) };
      return page('Federal Reserve issues FOMC statement', para('decided to maintain the target range for the federal funds rate at 3-3/4 to 4 percent'), '2026-09-17');
    });
    const embedder = { embed: vi.fn(async () => { throw new Error('ollama down'); }) };

    const pack = await deepResearch(Q, {
      tools: [web, perplexity, other],
      fetchPage,
      embedder,
      now: () => NOW,
      limits: { maxBytesPerPage: 4096 },
      log: () => {},
    });

    // heuristic planner (no brain) → ≥3 queries, all searched on web; perplexity once
    expect(pack.planner).toBe('heuristic');
    expect(pack.queries.length).toBeGreaterThanOrEqual(3);
    expect(searched).toEqual(pack.queries);
    // one page per domain, reuters URL deduped across queries
    expect(new Set(fetched).size).toBe(fetched.length);
    expect(fetched.filter((u) => u.includes('reuters'))).toHaveLength(1);
    expect(fetched).toContain('https://wsj.com/fed');
    // the failed fetch still counts as a snippet-less source but isn't a page read
    expect(pack.pagesRead).toBe(3);
    expect(pack.rerank).toBe('lexical');
    // byte cap applied even though the stub ignored it
    expect(pack.text).not.toContain('ZZZZ');
    // relevant sources ranked above the banana page, numbered from [1]
    expect(pack.cited[0]!.url).toMatch(/federalreserve|reuters/);
    // the off-topic page is dropped entirely, and decimals survive sentence splitting
    expect(pack.cited.some((s) => s.url.includes('bananas'))).toBe(false);
    expect(pack.text).toContain('3.75-4.00%');
    expect(pack.text).toMatch(/^\[1\] /m);
    expect(pack.cited.every((s, i) => pack.text.includes(`[${i + 1}] ${s.title}`))).toBe(true);
    expect(pack.cited.find((s) => s.url.includes('reuters'))?.date).toBe('2026-09-17');
  });

  it('keyless: no frontier brain, no Perplexity key, SearXNG web results — still a cited pack', async () => {
    const searched: string[] = [];
    const web = stubTool('web.web_search', (args) => {
      searched.push(String(args.query));
      return JSON.stringify({
        answer: null,
        results: [
          { title: 'FOMC statement', url: 'https://www.federalreserve.gov/newsevents/2026-09-17.htm', snippet: para('kept the federal funds rate target range at 3.75 to 4 percent') },
          { title: 'AP', url: 'https://apnews.com/article/fed-holds', snippet: para('left the federal funds rate unchanged at the September FOMC meeting') },
        ],
        source: 'searxng',
      });
    });
    const perplexityCalls = vi.fn();
    const perplexity = stubTool('trident.perplexity_search', (args) => {
      perplexityCalls(args);
      return JSON.stringify({ error: 'PERPLEXITY_API_KEY not set. Add it to your .env file to enable perplexity_search.' });
    });
    const logs: string[] = [];
    const pack = await deepResearch(Q, {
      tools: [web, perplexity],
      // Exactly how apps/server wires it when no frontier brain is configured.
      complete: async () => {
        throw new Error('no frontier brain');
      },
      fetchPage: async (url) =>
        url.includes('federalreserve')
          ? page('Federal Reserve statement', para('decided to maintain the target range for the federal funds rate at 3-3/4 to 4 percent'))
          : page('Fed holds', 'Markets had priced in a hold before the September FOMC meeting, and Treasury yields barely moved after the federal funds rate decision was announced on Wednesday afternoon.'),
      embedder: { embed: async () => { throw new Error('ollama down'); } },
      now: () => NOW,
      log: (m) => logs.push(m),
    });

    expect(pack.planner).toBe('heuristic');
    expect(logs).toContain('[research] planner failed (no frontier brain); using heuristics');
    expect(searched).toEqual(pack.queries);
    expect(perplexityCalls).toHaveBeenCalledOnce(); // first query only, as with a key
    expect(logs.some((l) => l.startsWith('[research] trident.perplexity_search unavailable') && l.includes('PERPLEXITY_API_KEY not set'))).toBe(true);
    expect(pack.cited.map((s) => s.url)).toEqual(
      expect.arrayContaining(['https://www.federalreserve.gov/newsevents/2026-09-17.htm', 'https://apnews.com/article/fed-holds']),
    );
    // The key error is neither evidence nor an engine summary.
    expect(pack.text).not.toContain('PERPLEXITY_API_KEY');
    expect(pack.text).not.toContain('Search-engine summary');
  });

  it("fetches and cites the sources a paid Perplexity call returned (Trident's real reply shape)", async () => {
    const web = stubTool('web.web_search', () => JSON.stringify({ answer: null, results: [], source: 'searxng' }));
    const perplexity = stubTool('trident.perplexity_search', () =>
      JSON.stringify({ content: 'The Fed held [1].', citations: ['https://www.federalreserve.gov/newsevents/2026-09-17.htm'], model: 'sonar' }),
    );
    const fetched: string[] = [];
    const pack = await deepResearch(Q, {
      tools: [web, perplexity],
      fetchPage: async (url) => {
        fetched.push(url);
        return page('Federal Reserve statement', para('decided to maintain the target range for the federal funds rate at 3-3/4 to 4 percent'), '2026-09-17');
      },
      now: () => NOW,
      log: () => {},
    });
    expect(fetched).toEqual(['https://www.federalreserve.gov/newsevents/2026-09-17.htm']);
    expect(pack.cited.map((s) => s.url)).toEqual(['https://www.federalreserve.gov/newsevents/2026-09-17.htm']);
    expect(pack.text).toContain('Search-engine summary (unsourced — trust only where [n] agrees): The Fed held.');
  });

  it('skips Perplexity entirely when Trident is not wired', async () => {
    const calls: string[] = [];
    const web = stubTool('web.web_search', (args) => {
      calls.push(`web:${String(args.query)}`);
      return JSON.stringify({ answer: null, results: [{ title: 'AP', url: 'https://apnews.com/x', snippet: para('held rates') }], source: 'searxng' });
    });
    const pack = await deepResearch(Q, { tools: [web], fetchPage: async () => page('AP', para('held rates')), now: () => NOW, log: () => {} });
    expect(calls.every((c) => c.startsWith('web:'))).toBe(true);
    expect(calls).toHaveLength(pack.queries.length);
    expect(pack.cited.map((s) => s.url)).toEqual(['https://apnews.com/x']);
  });

  it('uses the brain for planning when given one', async () => {
    const complete = vi.fn(async () => '["fomc september 2026 decision", "fed funds target range"]');
    const call = vi.fn(async () => '[]');
    const pack = await deepResearch(Q, { callTool: call, searchTools: [{ name: 's', args: (query) => ({ query }) }], complete, now: () => NOW, fetchPage: async () => page('', '') });
    expect(complete).toHaveBeenCalledOnce();
    expect(pack.planner).toBe('brain');
    expect(pack.queries).toEqual([Q, 'fomc september 2026 decision', 'fed funds target range']);
    expect(call).toHaveBeenCalledTimes(3);
    expect(pack.cited).toEqual([]);
  });

  it('survives every search failing', async () => {
    const pack = await deepResearch(Q, {
      callTool: async () => { throw new Error('mcp down'); },
      now: () => NOW,
      log: () => {},
    });
    expect(pack.text).toContain('No usable sources');
  });

  it('the tool validates input and returns the pack text', async () => {
    const tool = deepResearchTool({ callTool: async () => '[]', now: () => NOW, log: () => {} });
    expect(tool.definition.name).toBe('deep_research');
    expect(tool.definition.description.length).toBeLessThan(200); // rides in every local prompt
    expect(await tool.handler({ id: '1', toolName: 'deep_research', args: {} })).toMatchObject({ isError: true });
    const out = await tool.handler({ id: '2', toolName: 'deep_research', args: { question: Q } });
    expect(typeof out).toBe('string');
    expect(out).toContain('Research on:');
  });
});
