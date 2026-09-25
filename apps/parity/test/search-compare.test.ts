import { describe, expect, it } from 'vitest';
import type { GenerateArgs, ProviderAdapter } from '@flint/core';
import type { SearchOutcome } from '@flint/mcp';
import { BudgetGuard } from '../src/budget.js';
import {
  compareOne,
  loadComparePrompts,
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
import { mkdtempSync, writeFileSync } from 'node:fs';
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

  it('a side with nothing forfeits without a judge call; a failed metered search costs nothing', async () => {
    const down = deps({ searxng: async () => ({ ok: false, source: 'searxng', kind: 'network', error: 'searxng unreachable' }) });
    expect(await compareOne(P, down)).toMatchObject({ winner: 'provider', how: 'forfeit', reason: 'searxng unreachable', searchUsd: 0.008 });
    expect(down.judge.calls).toHaveLength(0);

    const quota = deps({ primary: async () => ({ ok: false, source: 'tavily', kind: 'quota', error: 'tavily HTTP 432 (quota)' }) });
    expect(await compareOne(P, quota)).toMatchObject({ winner: 'searxng', how: 'forfeit', searchUsd: 0 });

    const nothing = deps({
      primary: async () => okResults('tavily', []),
      searxng: async () => ({ ok: false, source: 'searxng', kind: 'empty', error: 'searxng found nothing (engines failing: qwant: CAPTCHA)' }),
    });
    expect(await compareOne(P, nothing)).toMatchObject({ winner: 'none', how: 'skipped', reason: 'tavily returned no results; searxng found nothing (engines failing: qwant: CAPTCHA)' });
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
    expect(md).toMatch(/\| 2 \| weather in Dallas \| 2 · \d\.\ds \| ✗ searxng timed out after 10000ms \| 0 \| tavily \(forfeit\) \|/);
    expect(md).toContain('**Totals:** tavily 1 · searxng 0 · tie 1 · no contest 0 (judged 1, forfeits 1, of 2)');
    expect(md).toMatch(/\*\*Sign test\*\* \(ties dropped\): p = 1\.000, NOISE: no detectable difference/);
    expect(md).toMatch(/\*\*Spend:\*\* \$0\.0\d{3} of \$1\.00 \(tavily searches \$0\.0160, judge \$0\.0012\)/);
  });
});
