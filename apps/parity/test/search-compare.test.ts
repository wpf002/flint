import { describe, expect, it } from 'vitest';
import type { GenerateArgs, ProviderAdapter } from '@flint/core';
import type { SearchOutcome } from '@flint/mcp';
import { BudgetGuard } from '../src/budget.js';
import {
  compareOne,
  keyUnusable,
  loadComparePrompts,
  openCompareBudget,
  promptsFromQueries,
  providerIsA,
  renderCompare,
  renderResultSet,
  resolveSearchKey,
  runCompare,
  sharedUrls,
  summarizeCompare,
  type CompareDeps,
  type ComparePrompt,
} from '../src/search-compare.js';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const NOW = new Date('2026-09-25T12:00:00Z');

const okResults = (source: 'tavily' | 'searxng', urls: string[], answer: string | null = null): SearchOutcome => ({
  ok: true,
  source,
  answer,
  results: urls.map((url, i) => ({ title: `${source} ${i + 1}`, url, snippet: `snippet ${i + 1}` })),
});

function fakeJudge(replies: string[]): ProviderAdapter & { calls: GenerateArgs[] } {
  const calls: GenerateArgs[] = [];
  return {
    name: 'fake',
    calls,
    getCapabilities: () => ({ toolCalling: 'native', structuredOutput: 'native', streaming: 'full', maxContextTokens: 1, maxOutputTokens: 1 }),
    estimateTokens: () => 0,
    async generate(args) {
      calls.push(args);
      return { message: { id: 'm', role: 'assistant', content: replies[calls.length - 1] ?? '', timestamp: 0 }, usage: { input: 1000, output: 40 }, reason: 'complete' };
    },
    // eslint-disable-next-line require-yield
    async *stream() {
      throw new Error('unused');
    },
  };
}

function deps(over: Partial<CompareDeps> & { replies?: string[] } = {}): CompareDeps & { judge: ReturnType<typeof fakeJudge>; searched: string[] } {
  const searched: string[] = [];
  const judge = fakeJudge(over.replies ?? ['{"verdict":"A","reason":"A cites the primary source"}']);
  return {
    providerName: 'tavily',
    primary: async (q) => (searched.push(`tavily:${q}`), okResults('tavily', ['https://www.federalreserve.gov/a', 'https://cnbc.com/b'], 'Rates rose.')),
    searxng: async (q) => (searched.push(`searxng:${q}`), okResults('searxng', ['https://federalreserve.gov/a/', 'https://foxbusiness.com/c'])),
    judgeModel: 'claude-haiku-4-5',
    budget: new BudgetGuard(1),
    searchCostUsd: 0.008,
    seed: 1,
    now: NOW,
    searched,
    ...over,
    judge,
  };
}

const P: ComparePrompt = { id: 'p1', prompt: 'What did the Fed decide in September 2026?', category: 'research' };

describe('what the judge sees', () => {
  it('renders a result set with titles, URLs, capped snippets and an optional engine summary', () => {
    const text = renderResultSet(
      [
        { title: 'Fed statement', url: 'https://federalreserve.gov/a', snippet: 'x'.repeat(500), published_date: '2026-09-16T18:00:00' },
        { title: 'No snippet', url: 'https://b.com', snippet: '' },
      ],
      'Rates rose.',
    );
    expect(text).toContain('Engine summary: Rates rose.');
    expect(text).toContain('1. Fed statement (2026-09-16)\n   https://federalreserve.gov/a\n   ' + 'x'.repeat(299) + '…');
    expect(text).toContain('2. No snippet\n   https://b.com');
    expect(renderResultSet([])).toBe('(no results)');
  });

  it('puts the sets in stable, roughly balanced blind slots', () => {
    expect(providerIsA('abc', 1)).toBe(providerIsA('abc', 1));
    let a = 0;
    for (let i = 0; i < 400; i++) if (providerIsA(`p${i}`, 1)) a++;
    expect(a).toBeGreaterThan(160);
    expect(a).toBeLessThan(240);
  });

  it('counts the same page from two engines once', () => {
    expect(sharedUrls(['https://www.a.com/x/', 'https://b.com/y?utm=1'], ['https://a.com/x', 'https://b.com/y', 'https://c.com'])).toBe(2);
  });
});

describe('compareOne', () => {
  it('judges blind: the verdict maps back to the right backend in either slot', async () => {
    for (const verdict of ['A', 'B'] as const) {
      for (const id of ['p1', 'p2', 'p3', 'p4']) {
        const d = deps({ replies: [`{"verdict":"${verdict}","reason":"r"}`] });
        const row = await compareOne({ ...P, id }, d);
        const providerWasA = providerIsA(id, 1);
        expect(row.providerWasA).toBe(providerWasA);
        expect(row.winner).toBe((verdict === 'A') === providerWasA ? 'provider' : 'searxng');
        const msg = String(d.judge.calls[0]!.messages[0]!.content);
        const aBlock = msg.slice(msg.indexOf('<results_a>'), msg.indexOf('</results_a>'));
        expect(aBlock).toContain(providerWasA ? 'tavily 1' : 'searxng 1');
      }
    }
  });

  it('records sides, shared URLs and spend; the engine summary is hidden unless asked for', async () => {
    const d = deps();
    const row = await compareOne(P, d);
    expect(row).toMatchObject({ how: 'judge', shared: 1, searchUsd: 0.008 });
    expect(row.provider).toMatchObject({ n: 2, urls: ['https://www.federalreserve.gov/a', 'https://cnbc.com/b'] });
    expect(row.searxng.n).toBe(2);
    expect(row.judgeUsd).toBeCloseTo((1000 * 1 + 40 * 5) / 1e6);
    expect(String(d.judge.calls[0]!.messages[0]!.content)).not.toContain('Engine summary');
    expect(d.judge.calls[0]!.model).toBe('claude-haiku-4-5');
    const withAnswer = deps({ includeAnswer: true });
    await compareOne(P, withAnswer);
    expect(String(withAnswer.judge.calls[0]!.messages[0]!.content)).toContain('Engine summary: Rates rose.');
  });

  it('allows ties and retries one unparseable verdict', async () => {
    expect((await compareOne(P, deps({ replies: ['{"verdict":"TIE","reason":"same"}'] }))).winner).toBe('tie');
    const d = deps({ replies: ['A is better', '{"verdict":"TIE","reason":"same"}'] });
    const row = await compareOne(P, d);
    expect(row.winner).toBe('tie');
    expect(d.judge.calls).toHaveLength(2);
    const bad = await compareOne(P, deps({ replies: ['nope', 'still nope'] }));
    expect(bad).toMatchObject({ winner: 'none', how: 'skipped' });
    expect(bad.judgeUsd).toBeGreaterThan(0); // tokens spent on bad replies still count
  });

  it('a side that searched and found nothing forfeits, without a judge call', async () => {
    const bare = deps({ primary: async () => okResults('tavily', []) });
    expect(await compareOne(P, bare)).toMatchObject({ winner: 'searxng', how: 'forfeit', reason: 'tavily returned no results', searchUsd: 0.008 });
    expect(bare.judge.calls).toHaveLength(0);
    const quiet = deps({ searxng: async () => okResults('searxng', []) });
    expect(await compareOne(P, quiet)).toMatchObject({ winner: 'provider', how: 'forfeit', reason: 'searxng returned no results' });
    const neither = deps({ primary: async () => okResults('tavily', []), searxng: async () => okResults('searxng', []) });
    expect(await compareOne(P, neither)).toMatchObject({ winner: 'none', how: 'skipped', reason: 'tavily returned no results; searxng returned no results' });
  });

  it("a side that couldn't search at all wins nothing for the other: the row is unavailable, and a rejected metered search costs nothing", async () => {
    const down = deps({ searxng: async () => ({ ok: false, source: 'searxng', kind: 'network', error: 'searxng unreachable' }) });
    expect(await compareOne(P, down)).toMatchObject({ winner: 'none', how: 'unavailable', reason: 'searxng unreachable', searchUsd: 0.008 });
    expect(down.judge.calls).toHaveLength(0);

    const quota = deps({ primary: async () => ({ ok: false, source: 'tavily', kind: 'quota', error: 'tavily HTTP 432 (quota)' }) });
    const row = await compareOne(P, quota);
    expect(row).toMatchObject({ winner: 'none', how: 'unavailable', reason: 'tavily HTTP 432 (quota)', searchUsd: 0 });
    expect(row.provider).toMatchObject({ kind: 'quota', error: 'tavily HTTP 432 (quota)' });

    const captcha = deps({
      primary: async () => okResults('tavily', []),
      searxng: async () => ({ ok: false, source: 'searxng', kind: 'empty', error: 'searxng found nothing (engines failing: qwant: CAPTCHA)' }),
    });
    expect(await compareOne(P, captcha)).toMatchObject({ winner: 'none', how: 'unavailable', reason: 'searxng found nothing (engines failing: qwant: CAPTCHA)' });

    const both = deps({
      primary: async () => ({ ok: false, source: 'tavily', kind: 'timeout', error: 'tavily timed out after 25000ms' }),
      searxng: async () => ({ ok: false, source: 'searxng', kind: 'network', error: 'searxng unreachable' }),
    });
    expect(await compareOne(P, both)).toMatchObject({ winner: 'none', how: 'unavailable', reason: 'tavily timed out after 25000ms; searxng unreachable' });
  });

  it('a judge error is a skipped row, not a crash', async () => {
    const d = deps();
    d.judge.generate = async () => {
      throw new Error('529 overloaded');
    };
    expect(await compareOne(P, d)).toMatchObject({ winner: 'none', how: 'skipped', reason: 'judge failed: 529 overloaded' });
  });
});

describe('budget', () => {
  it('never starts a metered search the budget cannot cover', async () => {
    const d = deps({ budget: new BudgetGuard(0.005), searchCostUsd: 0.008 });
    const row = await compareOne(P, d);
    expect(row).toMatchObject({ winner: 'none', how: 'skipped', reason: 'budget exhausted' });
    expect(d.searched).toEqual([]);
  });

  it('stops launching prompts once the cap is hit, and stays under it', async () => {
    const prompts = promptsFromQueries(Array.from({ length: 20 }, (_, i) => `question ${i}`));
    const d = deps({ budget: new BudgetGuard(0.05) });
    const rows = await runCompare(prompts, d, 1);
    expect(rows.length).toBeLessThan(prompts.length);
    expect(d.budget.spent).toBeLessThanOrEqual(0.05);
    const t = summarizeCompare(rows);
    expect(t.searchUsd + t.judgeUsd).toBeCloseTo(d.budget.spent, 10);
  });
});

describe('an unusable key or a blocked SearXNG is not a quality verdict', () => {
  const quota = async (): Promise<SearchOutcome> => ({ ok: false, source: 'tavily', kind: 'quota', error: 'tavily HTTP 432 (quota)' });
  const prompts = promptsFromQueries(Array.from({ length: 25 }, (_, i) => `research question ${i}`));

  it('stops at the first auth or quota failure: nothing judged, nothing charged, no "searxng ahead"', async () => {
    for (const kind of ['quota', 'auth'] as const) {
      const d = deps({ primary: async () => ({ ok: false, source: 'tavily', kind, error: `tavily HTTP ${kind === 'auth' ? 401 : 432}` }) });
      const rows = await runCompare(prompts, d, 1);
      expect(rows).toHaveLength(1);
      expect(keyUnusable(rows)).toMatch(/^tavily HTTP (401|432)$/);
      expect(d.judge.calls).toHaveLength(0);
      expect(d.budget.spent).toBe(0);
      const t = summarizeCompare(rows);
      expect(t).toMatchObject({ provider: 0, searxng: 0, judged: 0, forfeits: 0, signal: 'NOISE', unavailable: { provider: 1, searxng: 0 } });
    }
  });

  it('with concurrency, stops launching once a key failure lands', async () => {
    const d = deps({ primary: quota });
    const rows = await runCompare(prompts, d, 2);
    expect(rows.length).toBeLessThanOrEqual(2);
  });

  it('a key that runs out partway keeps the rows judged before it, and counts only those', async () => {
    let n = 0;
    const d = deps({ primary: async (q) => (++n <= 4 ? okResults('tavily', [`https://t.com/${q}`]) : quota()), replies: Array(4).fill('{"verdict":"A","reason":"r"}') });
    const rows = await runCompare(prompts, d, 1);
    expect(rows).toHaveLength(5);
    const t = summarizeCompare(rows);
    expect(t.judged).toBe(4);
    expect(t.provider + t.searxng + t.tie).toBe(4);
    expect(t.unavailable.provider).toBe(1);
  });

  it('SearXNG blocked on every prompt is not a provider win either', async () => {
    const d = deps({ searxng: async () => ({ ok: false, source: 'searxng', kind: 'empty', error: 'searxng found nothing (engines failing: duckduckgo: CAPTCHA)' }) });
    const rows = await runCompare(prompts, d, 2);
    expect(rows).toHaveLength(25);
    const t = summarizeCompare(rows);
    expect(t).toMatchObject({ provider: 0, searxng: 0, signal: 'NOISE', unavailable: { provider: 0, searxng: 25 } });
    expect(d.judge.calls).toHaveLength(0);
    const md = renderCompare(rows, t, { providerName: 'tavily', judgeModel: d.judgeModel, searxngUrl: 'http://127.0.0.1:8888', budgetUsd: 1, results: 5, now: NOW });
    expect(md).toContain('**Availability:** tavily failed 0 of 25 · searxng failed 25 of 25 (those rows are left out of the wins and the sign test)');
    expect(md).toContain('**Sign test:** nothing was judged');
    expect(md).not.toMatch(/ahead/);
  });
});

describe('inputs', () => {
  it('reads research prompts from a frozen set and skips junk lines', () => {
    const dir = mkdtempSync(join(tmpdir(), 'search-compare-'));
    const path = join(dir, 'prompts.jsonl');
    writeFileSync(
      path,
      [
        JSON.stringify({ id: 'a', prompt: 'weather in Dallas today', category: 'research' }),
        JSON.stringify({ id: 'b', prompt: 'explain entropy', category: 'knowledge' }),
        '{torn',
        JSON.stringify({ id: 'c', category: 'research' }),
      ].join('\n'),
    );
    expect(loadComparePrompts(path, 'research').map((p) => p.id)).toEqual(['a']);
    expect(loadComparePrompts(path, 'all').map((p) => p.id)).toEqual(['a', 'b']);
    expect(promptsFromQueries(['  q1 ', '', 'q2']).map((p) => p.prompt)).toEqual(['q1', 'q2']);
  });

  it('takes the search key from the env, else the web server in mcp.json, and never echoes it', () => {
    const mcp = JSON.stringify({ servers: [{ name: 'trident' }, { name: 'web', env: { SEARCH_PROVIDER: 'tavily', SEARCH_API_KEY: 'tvly-FROM-MCP' } }] });
    expect(resolveSearchKey({ SEARCH_API_KEY: 'BSA-env', SEARCH_PROVIDER: 'brave' }, mcp)).toEqual({ provider: 'brave', apiKey: 'BSA-env', from: 'SEARCH_API_KEY in the environment' });
    const fromFile = resolveSearchKey({}, mcp);
    expect(fromFile).toEqual({ provider: 'tavily', apiKey: 'tvly-FROM-MCP', from: "the web server's env in mcp.json" });
    expect(fromFile.from).not.toContain('tvly');
    expect(resolveSearchKey({ SEARCH_KEY_PROVIDER: 'brave' }, '{not json')).toEqual({ provider: 'brave', from: 'nowhere' });
    expect(resolveSearchKey({}, JSON.stringify({ servers: [{ name: 'web', env: { SEARCH_PROVIDER: 'auto', SEARCH_KEY_PROVIDER: 'brave', SEARCH_API_KEY: 'k' } }] })).provider).toBe('brave');
  });

  it('in auto, places the key by its prefix like web_search does, and never guesses', () => {
    expect(resolveSearchKey({ SEARCH_PROVIDER: 'auto', SEARCH_API_KEY: 'BSAkey' }).provider).toBe('brave');
    expect(resolveSearchKey({ SEARCH_PROVIDER: 'auto', SEARCH_API_KEY: 'tvly-key' }).provider).toBe('tavily');
    const mystery = resolveSearchKey({ SEARCH_PROVIDER: 'auto', SEARCH_API_KEY: 'mystery-key' });
    expect(mystery.provider).toBeUndefined();
    expect(mystery.error).toMatch(/can't tell whether SEARCH_API_KEY is a tavily or a brave key/);
    expect(mystery.error).not.toContain('mystery-key');
    // --provider names it; a key carrying the other vendor's prefix is still refused
    expect(resolveSearchKey({ SEARCH_PROVIDER: 'auto', SEARCH_API_KEY: 'mystery-key' }, undefined, 'brave').provider).toBe('brave');
    expect(resolveSearchKey({ SEARCH_PROVIDER: 'auto', SEARCH_API_KEY: 'BSAkey' }, undefined, 'tavily')).toMatchObject({ error: expect.stringMatching(/looks like a brave key/) });
  });
});

describe('report', () => {
  it('renders a per-prompt table and totals', async () => {
    const d = deps();
    const rows = [
      await compareOne(P, deps({ replies: ['{"verdict":"TIE","reason":"both cite the Fed | CNBC"}'] })),
      await compareOne({ ...P, id: 'p2', prompt: 'weather in Dallas' }, deps({ searxng: async () => ({ ok: false, source: 'searxng', kind: 'timeout', error: 'searxng timed out after 10000ms' }) })),
    ];
    const md = renderCompare(rows, summarizeCompare(rows), { providerName: 'tavily', judgeModel: d.judgeModel, searxngUrl: 'http://127.0.0.1:8888', budgetUsd: 1, results: 5, now: NOW });
    expect(md).toContain('| # | prompt | tavily | searxng | shared | winner | why |');
    expect(md).toContain('| 1 | What did the Fed decide in September 2026? |');
    // pipes escaped, and the blind layout named so "Set A" in a reason can be read
    expect(md).toContain(`| tie | A=${providerIsA('p1', 1) ? 'tavily' : 'searxng'}: both cite the Fed \\| CNBC |`);
    expect(md).toMatch(/\| 2 \| weather in Dallas \| 2 · \d\.\ds \| ✗ searxng timed out after 10000ms \| 0 \| — \(unavailable\) \|/);
    expect(md).toContain('**Totals:** tavily 0 · searxng 0 · tie 1 · no contest 1 (judged 1, forfeits 0, unavailable 1, of 2)');
    expect(md).toContain('**Availability:** tavily failed 0 of 2 · searxng failed 1 of 2 (those rows are left out of the wins and the sign test)');
    expect(md).toMatch(/\*\*Sign test\*\* \(ties dropped\): p = 1\.000, NOISE: no detectable difference/);
    expect(md).toMatch(/\*\*Spend:\*\* \$0\.0\d{3} of \$1\.00 \(tavily searches \$0\.0160, judge \$0\.0012\)/);
  });
});

describe('the shared daily eval budget', () => {
  const NOON = Date.UTC(2026, 8, 25, 17, 0); // 12:00 CDT
  const ledgerRows = (path: string) =>
    readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { type: string; run: string; usd: number });

  it("reserves --budget-usd out of today's eval budget and settles every search and judge call into the shared ledger", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'search-compare-daily-'));
    try {
      const logged: string[] = [];
      const { budget, daily } = openCompareBudget({ budgetUsd: 1, ledgerFlag: undefined, env: { PARITY_DAILY_BUDGET_USD: '5' }, evalDir: dir, log: (m) => logged.push(m), now: () => NOON });
      const d = deps({ budget });
      const row = await compareOne(P, d);
      expect(row.how).toBe('judge');
      daily.close();
      const rows = ledgerRows(join(dir, 'spend-ledger.jsonl'));
      expect(rows[0]).toMatchObject({ type: 'reserve', usd: 1 });
      expect(rows[0]!.run).toMatch(/^search-compare\//);
      const spent = rows.filter((r) => r.type === 'spend').reduce((a, r) => a + r.usd, 0);
      expect(spent).toBeGreaterThan(0.008); // the metered search plus the judge (SearXNG is free)
      expect(spent).toBeCloseTo(budget.spent, 10);
      expect(rows.at(-1)).toMatchObject({ type: 'release' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is capped by what today's other evals left, and refuses to start once the day is spent", () => {
    const dir = mkdtempSync(join(tmpdir(), 'search-compare-daily-'));
    try {
      const ledger = join(dir, 'ledger.jsonl');
      const env = { PARITY_DAILY_BUDGET_USD: '2' };
      const open = (budgetUsd: number) => openCompareBudget({ budgetUsd, ledgerFlag: ledger, env, evalDir: dir, log: () => {}, now: () => NOON });
      const first = open(1.5);
      first.budget.reserve(1.5)!(1.5);
      first.daily.close();
      const capped = open(1);
      expect(capped.clipped).toBe(true);
      expect(capped.budget.limitUsd).toBeCloseTo(0.5, 9);
      capped.budget.reserve(0.5)!(0.5);
      capped.daily.close();
      expect(() => open(1)).toThrow(/spent|left/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
