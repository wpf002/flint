#!/usr/bin/env tsx
/**
 * search-compare: is keyless SearXNG good enough to stand in for the metered
 * search provider?
 *
 * For each research prompt, fetch the top N results from the current provider
 * (Tavily or Brave, with SEARCH_API_KEY) and from SearXNG, through the same
 * code web_search runs (@flint/mcp's search providers). Then a cheap judge
 * picks which result set better supports answering the prompt. The sets go in
 * seeded-random A/B slots and ties are allowed. A hard --budget-usd covers both
 * the metered searches and the judge, and every paid call is reserved against
 * it before it's made.
 *
 *   pnpm --filter @flint/parity search-compare --limit 3 --budget-usd 0.25   # smoke
 *   pnpm --filter @flint/parity search-compare --budget-usd 1                # all research prompts
 *   pnpm --filter @flint/parity search-compare --query "..." --query "..."
 *
 * Keys: ANTHROPIC_API_KEY from the env or ~/.flint/secrets.env. SEARCH_API_KEY
 * from the env, else the `web` server's env in ~/.flint/mcp.json. Both files
 * are only read, and no key is ever printed. See ../README.md.
 */
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { AnthropicProvider, decodeAssistantTurn, type ProviderAdapter, type TokenUsage } from '@flint/core';
import {
  DEFAULT_SEARXNG_URL,
  braveSearch,
  keyOwner,
  searxngSearch,
  tavilySearch,
  type FailureKind,
  type KeyedBackend,
  type SearchItem,
  type SearchOutcome,
} from '@flint/mcp';
import { BudgetGuard } from './budget.js';
import { parseJudgeOutput, type Verdict } from './judge.js';
import { costOf, estimateCost } from './pricing.js';
import { loadSecretsInto } from './secrets.js';
import { signalOf } from './stats.js';
import { appendJsonl, pool, readJsonl, seededRng, seedFrom, sha } from './util.js';

export interface ComparePrompt {
  id: string;
  prompt: string;
  category: string;
}

export interface Side {
  n: number;
  ms: number;
  urls: string[];
  /** Set when the search itself failed (as opposed to finding nothing). */
  error?: string;
  kind?: FailureKind;
}

export type Winner = 'provider' | 'searxng' | 'tie' | 'none';

export const BUDGET_EXHAUSTED = 'budget exhausted';

export interface CompareRow {
  id: string;
  prompt: string;
  provider: Side;
  searxng: Side;
  /** URLs both sets share (normalized). */
  shared: number;
  winner: Winner;
  /**
   * judge: a verdict. forfeit: one side searched and found nothing, the other
   * had results. unavailable: a side's search failed (key refused or spent,
   * rate limit, timeout, SearXNG's engines blocked), which says nothing about
   * result quality, so no winner. skipped: nothing on either side, budget, or a
   * judge error.
   */
  how: 'judge' | 'forfeit' | 'unavailable' | 'skipped';
  reason: string;
  providerWasA?: boolean;
  searchUsd: number;
  judgeUsd: number;
}

export interface CompareDeps {
  providerName: KeyedBackend;
  primary: (query: string) => Promise<SearchOutcome>;
  searxng: (query: string) => Promise<SearchOutcome>;
  judge: ProviderAdapter;
  judgeModel: string;
  budget: BudgetGuard;
  /** Dollars per metered search, reserved before each call and charged on success. */
  searchCostUsd: number;
  seed: number;
  now: Date;
  /** Show each backend's synthesized answer to the judge too (default: sources only). */
  includeAnswer?: boolean;
}

export const JUDGE_MAX_TOKENS = 300;

export const SEARCH_JUDGE_SYSTEM = `You compare two sets of web search results retrieved for the same request from Will. Don't answer the request. Decide which set would better let an assistant answer it correctly, currently, and with sources it can cite.

Judge on, in order of weight:
1. Relevance: do the results address what was actually asked (the specific entity, place, time or number), not just its topic?
2. Authority: primary, official and reputable sources beat SEO pages, content farms and unrelated sites.
3. Currency: for time-sensitive requests, recent results beat stale ones. The evaluation date is given.
4. Coverage: enough distinct, substantive information to answer. Duplicates and empty snippets add nothing.

Ignore which set is A or B, the order of results within a set, and length for its own sake. Off-topic results count against a set. If the sets are equally useful, or equally useless, call it a TIE.

Reply with ONLY a JSON object, no prose before or after, no code fence:
{"verdict": "A" | "B" | "TIE", "reason": "<one sentence>"}`;

/** Which slot the provider's set goes in: seeded by prompt, so a re-run judges the same layout. */
export function providerIsA(promptId: string, seed: number): boolean {
  return seededRng(seedFrom(`${seed}:search-compare:${promptId}`))() < 0.5;
}

/** One result set as the judge sees it. */
export function renderResultSet(items: SearchItem[], answer?: string | null): string {
  const lines: string[] = [];
  if (answer) lines.push(`Engine summary: ${clip(answer, 400)}`, '');
  if (items.length === 0) lines.push('(no results)');
  items.forEach((r, i) => {
    lines.push(`${i + 1}. ${clip(r.title, 150)}${r.published_date ? ` (${r.published_date.slice(0, 10)})` : ''}`);
    lines.push(`   ${r.url}`);
    if (r.snippet) lines.push(`   ${clip(r.snippet, 300)}`);
  });
  return lines.join('\n');
}

export function judgeMessage(prompt: string, setA: string, setB: string, now: Date): string {
  return [
    `Date of this evaluation: ${now.toISOString().slice(0, 10)}.`,
    '',
    `<request>\n${prompt}\n</request>`,
    '',
    `<results_a>\n${setA}\n</results_a>`,
    '',
    `<results_b>\n${setB}\n</results_b>`,
    '',
    'Which result set better supports answering the request? Reply with the JSON object only.',
  ].join('\n');
}

/** host+path, lowercased, no www/query/hash/trailing slash: the same page from two engines. */
export function urlKey(u: string): string {
  try {
    const url = new URL(u);
    return `${url.hostname.toLowerCase().replace(/^www\./, '')}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return u;
  }
}

export function sharedUrls(a: string[], b: string[]): number {
  const bs = new Set(b.map(urlKey));
  return new Set(a.map(urlKey).filter((k) => bs.has(k))).size;
}

function side(out: SearchOutcome, ms: number): Side {
  if (!out.ok) return { n: 0, ms, urls: [], error: out.error, kind: out.kind };
  return { n: out.results.length, ms, urls: out.results.map((r) => r.url) };
}

async function timed(fn: () => Promise<SearchOutcome>): Promise<{ out: SearchOutcome; ms: number }> {
  const t = Date.now();
  const out = await fn();
  return { out, ms: Date.now() - t };
}

/** Compare one prompt: both searches, then a judgment when both sides have something to judge. */
export async function compareOne(p: ComparePrompt, d: CompareDeps): Promise<CompareRow> {
  const base = { id: p.id, prompt: p.prompt };
  const empty: Side = { n: 0, ms: 0, urls: [] };
  const settleSearch = d.budget.reserve(d.searchCostUsd);
  if (!settleSearch) {
    return { ...base, provider: empty, searxng: empty, shared: 0, winner: 'none', how: 'skipped', reason: BUDGET_EXHAUSTED, searchUsd: 0, judgeUsd: 0 };
  }
  const [prim, sx] = await Promise.all([timed(() => d.primary(p.prompt)), timed(() => d.searxng(p.prompt))]);
  // Metered APIs bill a successful search; a rejected one (quota, bad key) costs nothing.
  const searchUsd = prim.out.ok ? d.searchCostUsd : 0;
  settleSearch(searchUsd);
  const row = {
    ...base,
    provider: side(prim.out, prim.ms),
    searxng: side(sx.out, sx.ms),
    shared: sharedUrls(prim.out.ok ? prim.out.results.map((r) => r.url) : [], sx.out.ok ? sx.out.results.map((r) => r.url) : []),
    searchUsd,
    judgeUsd: 0,
  };
  // A side that couldn't search tells us nothing about the other side's results.
  const failed = [row.provider.error, row.searxng.error].filter((e): e is string => e !== undefined);
  if (failed.length > 0) return { ...row, winner: 'none', how: 'unavailable', reason: failed.join('; ') };
  const pHas = row.provider.n > 0;
  const sHas = row.searxng.n > 0;
  const none = (name: string) => `${name} returned no results`;
  if (!pHas && !sHas) return { ...row, winner: 'none', how: 'skipped', reason: `${none(d.providerName)}; ${none('searxng')}` };
  if (!sHas) return { ...row, winner: 'provider', how: 'forfeit', reason: none('searxng') };
  if (!pHas) return { ...row, winner: 'searxng', how: 'forfeit', reason: none(d.providerName) };

  const pOut = prim.out as Extract<SearchOutcome, { ok: true }>;
  const sOut = sx.out as Extract<SearchOutcome, { ok: true }>;
  const providerWasA = providerIsA(p.id, d.seed);
  const pSet = renderResultSet(pOut.results, d.includeAnswer ? pOut.answer : undefined);
  const sSet = renderResultSet(sOut.results, d.includeAnswer ? sOut.answer : undefined);
  const content = judgeMessage(p.prompt, providerWasA ? pSet : sSet, providerWasA ? sSet : pSet, d.now);
  // Priced for the retry too, so the reservation covers the worst case.
  const est = 2 * estimateCost('anthropic', d.judgeModel, SEARCH_JUDGE_SYSTEM.length + content.length, { overheadTokens: 50, expectedOutputTokens: JUDGE_MAX_TOKENS });
  const settleJudge = d.budget.reserve(est);
  if (!settleJudge) return { ...row, winner: 'none', how: 'skipped', reason: 'budget exhausted before judging', providerWasA };

  const usage: TokenUsage = { input: 0, output: 0 };
  try {
    let verdict: Verdict | undefined;
    let reason = '';
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 2 && !verdict; attempt++) {
      const res = await d.judge.generate({
        model: d.judgeModel,
        system: SEARCH_JUDGE_SYSTEM,
        messages: [{ id: `search-judge-${p.id}-${attempt}`, role: 'user', content, timestamp: Date.now() }],
        maxTokens: JUDGE_MAX_TOKENS,
      });
      usage.input += res.usage.input;
      usage.output += res.usage.output;
      try {
        ({ verdict, reason } = parseJudgeOutput(decodeAssistantTurn(res.message).text));
      } catch (err) {
        lastErr = err;
      }
    }
    const judgeUsd = costOf('anthropic', d.judgeModel, usage);
    settleJudge(judgeUsd);
    if (!verdict) return { ...row, winner: 'none', how: 'skipped', reason: `judge unparseable: ${String(lastErr)}`, providerWasA, judgeUsd };
    const winner: Winner = verdict === 'TIE' ? 'tie' : (verdict === 'A') === providerWasA ? 'provider' : 'searxng';
    return { ...row, winner, how: 'judge', reason, providerWasA, judgeUsd };
  } catch (err) {
    const judgeUsd = costOf('anthropic', d.judgeModel, usage);
    settleJudge(judgeUsd);
    return { ...row, winner: 'none', how: 'skipped', reason: `judge failed: ${err instanceof Error ? err.message : String(err)}`, providerWasA, judgeUsd };
  }
}

/**
 * The provider's error when its key was refused or is spent: every later prompt
 * would fail the same way, so there is nothing left to compare.
 */
export function keyUnusable(rows: CompareRow[]): string | undefined {
  return rows.find((r) => r.provider.kind === 'auth' || r.provider.kind === 'quota')?.provider.error;
}

/**
 * Every prompt, `concurrency` at a time. Stops launching new ones once the
 * budget refuses anything, or once the provider's key is refused or spent.
 */
export async function runCompare(prompts: ComparePrompt[], d: CompareDeps, concurrency = 2): Promise<CompareRow[]> {
  const rows = new Map<string, CompareRow>();
  let dead = false;
  await pool(
    prompts,
    concurrency,
    async (p) => {
      const row = await compareOne(p, d);
      rows.set(p.id, row);
      if (keyUnusable([row])) dead = true;
    },
    () => d.budget.exhausted || dead,
  );
  return prompts.flatMap((p) => rows.get(p.id) ?? []);
}

export interface CompareTotals {
  prompts: number;
  /** Wins, ties and the sign test count judged rows and genuine forfeits only. */
  provider: number;
  searxng: number;
  tie: number;
  none: number;
  judged: number;
  forfeits: number;
  /** Rows where a side's search failed, and how often each side failed, of `searched`. */
  unavailable: { rows: number; provider: number; searxng: number };
  /** Rows where both searches ran (not stopped by the budget first). */
  searched: number;
  p: number;
  signal: string;
  meanMs: { provider: number; searxng: number };
  meanShared: number;
  searchUsd: number;
  judgeUsd: number;
}

export function summarizeCompare(rows: CompareRow[]): CompareTotals {
  const count = (w: Winner) => rows.filter((r) => r.winner === w).length;
  const ran = rows.filter((r) => r.provider.ms > 0 || r.searxng.ms > 0);
  const searched = rows.filter((r) => r.reason !== BUDGET_EXHAUSTED);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  // An unavailable row's winner is 'none', so it never reaches these counts.
  const { signal, p } = signalOf(count('provider'), count('searxng'));
  return {
    prompts: rows.length,
    provider: count('provider'),
    searxng: count('searxng'),
    tie: count('tie'),
    none: count('none'),
    judged: rows.filter((r) => r.how === 'judge').length,
    forfeits: rows.filter((r) => r.how === 'forfeit').length,
    unavailable: {
      rows: rows.filter((r) => r.how === 'unavailable').length,
      provider: searched.filter((r) => r.provider.error !== undefined).length,
      searxng: searched.filter((r) => r.searxng.error !== undefined).length,
    },
    searched: searched.length,
    p,
    signal,
    meanMs: { provider: mean(ran.map((r) => r.provider.ms)), searxng: mean(ran.map((r) => r.searxng.ms)) },
    meanShared: mean(ran.map((r) => r.shared)),
    searchUsd: rows.reduce((s, r) => s + r.searchUsd, 0),
    judgeUsd: rows.reduce((s, r) => s + r.judgeUsd, 0),
  };
}

export function renderCompare(
  rows: CompareRow[],
  t: CompareTotals,
  meta: { providerName: string; judgeModel: string; searxngUrl: string; budgetUsd: number; results: number; now: Date },
): string {
  const P = meta.providerName;
  const cell = (s: Side) => (s.error ? `✗ ${clip(s.error, 40)}` : `${s.n} · ${(s.ms / 1000).toFixed(1)}s`);
  const who = (r: CompareRow) =>
    r.winner === 'none'
      ? r.how === 'unavailable'
        ? '— (unavailable)'
        : '—'
      : `${r.winner === 'provider' ? P : r.winner}${r.how === 'forfeit' ? ' (forfeit)' : ''}`;
  const decisive = t.provider + t.searxng + t.tie;
  const sign =
    decisive === 0
      ? '**Sign test:** nothing was judged'
      : `**Sign test** (ties dropped): p = ${t.p.toFixed(3)}, ${t.signal}${t.signal === 'NOISE' ? ': no detectable difference' : t.provider > t.searxng ? `: ${P} ahead` : ': searxng ahead'}`;
  const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\s+/g, ' ');
  // The judge's reasons say "Set A"/"Set B"; say which backend that was.
  const why = (r: CompareRow) => (r.how === 'judge' && r.providerWasA !== undefined ? `A=${r.providerWasA ? P : 'searxng'}: ${r.reason}` : r.reason);
  const out = [
    `# Search compare: ${P} vs SearXNG (${meta.now.toISOString().slice(0, 10)})`,
    '',
    `Top ${meta.results} from each · judge ${meta.judgeModel} · SearXNG ${meta.searxngUrl} · budget $${meta.budgetUsd.toFixed(2)}`,
    '',
    `| # | prompt | ${P} | searxng | shared | winner | why |`,
    '|---|---|---|---|---|---|---|',
    ...rows.map((r, i) => `| ${i + 1} | ${esc(clip(r.prompt, 70))} | ${esc(cell(r.provider))} | ${esc(cell(r.searxng))} | ${r.shared} | ${who(r)} | ${esc(clip(why(r), 150))} |`),
    '',
    `**Totals:** ${P} ${t.provider} · searxng ${t.searxng} · tie ${t.tie} · no contest ${t.none} (judged ${t.judged}, forfeits ${t.forfeits}, unavailable ${t.unavailable.rows}, of ${t.prompts})`,
    `**Availability:** ${P} failed ${t.unavailable.provider} of ${t.searched} · searxng failed ${t.unavailable.searxng} of ${t.searched} (those rows are left out of the wins and the sign test)`,
    sign,
    `**Latency** (mean): ${P} ${(t.meanMs.provider / 1000).toFixed(2)}s · searxng ${(t.meanMs.searxng / 1000).toFixed(2)}s · shared URLs (mean) ${t.meanShared.toFixed(1)} of ${meta.results}`,
    `**Spend:** $${(t.searchUsd + t.judgeUsd).toFixed(4)} of $${meta.budgetUsd.toFixed(2)} (${P} searches $${t.searchUsd.toFixed(4)}, judge $${t.judgeUsd.toFixed(4)})`,
  ];
  return out.join('\n');
}

// ---------------------------------------------------------------- inputs

/** Research prompts from a frozen parity set (read-only), or `all` categories. */
export function loadComparePrompts(path: string, category: string): ComparePrompt[] {
  return readJsonl<ComparePrompt>(path).filter((p) => p && typeof p.prompt === 'string' && (category === 'all' || p.category === category));
}

export function promptsFromQueries(queries: string[]): ComparePrompt[] {
  return queries.map((q) => q.trim()).filter(Boolean).map((q) => ({ id: sha(q), prompt: q, category: 'query' }));
}

/**
 * The metered provider and its key: SEARCH_API_KEY in the env first, else the
 * `web` server's env in mcp.json (what Flint actually runs with). Returns
 * where it came from; never the key in any message.
 */
export function resolveSearchKey(
  env: Record<string, string | undefined>,
  mcpJson?: string,
  /** --provider: names the key's provider, like SEARCH_KEY_PROVIDER. */
  override?: string,
): { provider?: KeyedBackend; apiKey?: string; from: string; error?: string } {
  const key = env.SEARCH_API_KEY?.trim();
  if (key) return { ...keyProvider(env, key, override), apiKey: key, from: 'SEARCH_API_KEY in the environment' };
  if (mcpJson) {
    try {
      const cfg = JSON.parse(mcpJson) as { servers?: Array<{ name?: string; env?: Record<string, unknown> }> };
      const web = cfg.servers?.find((s) => s?.name === 'web')?.env ?? {};
      const k = typeof web.SEARCH_API_KEY === 'string' ? web.SEARCH_API_KEY.trim() : '';
      if (k) return { ...keyProvider(web, k, override), apiKey: k, from: "the web server's env in mcp.json" };
    } catch {
      /* unreadable config: same as no key */
    }
  }
  return { ...keyProvider(env, undefined, override), from: 'nowhere' };
}

/**
 * Which provider a key is for: --provider, SEARCH_KEY_PROVIDER, or an explicit
 * SEARCH_PROVIDER=tavily|brave, checked against the key's prefix exactly as
 * web_search's auto mode checks it (keyOwner), so a key is never sent to a
 * vendor it evidently isn't for. Without a key, only names the provider.
 */
function keyProvider(e: Record<string, unknown>, key: string | undefined, override?: string): { provider?: KeyedBackend; error?: string } {
  const s = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : '');
  const mode = s(e.SEARCH_PROVIDER);
  const declared = s(override) || s(e.SEARCH_KEY_PROVIDER) || (mode === 'tavily' || mode === 'brave' ? mode : '');
  if (!key) return { provider: declared === 'brave' ? 'brave' : 'tavily' };
  const owner = keyOwner(key, declared || undefined);
  return 'provider' in owner ? { provider: owner.provider } : { error: owner.error };
}

function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

// ---------------------------------------------------------------- CLI

const DEFAULT_SEARCH_COST: Record<KeyedBackend, number> = { tavily: 0.008, brave: 0.005 };

async function main(argv: string[]): Promise<void> {
  const flint = join(homedir(), '.flint');
  const evalDir = process.env.PARITY_DIR?.trim() || join(flint, 'eval');
  const { values } = parseArgs({
    args: argv,
    options: {
      prompts: { type: 'string', default: join(evalDir, 'parity_prompts.jsonl') },
      category: { type: 'string', default: 'research' },
      query: { type: 'string', multiple: true },
      limit: { type: 'string' },
      'budget-usd': { type: 'string', default: '1' },
      'judge-model': { type: 'string', default: process.env.SEARCH_COMPARE_JUDGE_MODEL?.trim() || 'claude-haiku-4-5' },
      provider: { type: 'string' },
      'searxng-url': { type: 'string', default: process.env.SEARXNG_URL?.trim() || DEFAULT_SEARXNG_URL },
      results: { type: 'string', default: '5' },
      'search-cost-usd': { type: 'string' },
      'include-answer': { type: 'boolean', default: false },
      seed: { type: 'string', default: '1' },
      concurrency: { type: 'string', default: '2' },
      out: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
  });
  const log = (m: string) => process.stderr.write(`${m}\n`);
  const budgetUsd = Number(values['budget-usd']);
  const n = Math.max(1, Math.min(Number(values.results), 10));
  const searxngUrl = values['searxng-url']!.replace(/\/+$/, '');

  let prompts = values.query?.length ? promptsFromQueries(values.query) : loadComparePrompts(resolve(values.prompts!), values.category!);
  if (values.limit) prompts = prompts.slice(0, Math.max(0, Number(values.limit)));
  if (prompts.length === 0) throw new Error(`no prompts (category ${values.category} in ${values.prompts}, or pass --query)`);

  loadSecretsInto(join(flint, 'secrets.env'));
  const mcpPath = process.env.MCP_CONFIG?.trim() || join(flint, 'mcp.json');
  const key = resolveSearchKey(process.env, existsSync(mcpPath) ? readFileSync(mcpPath, 'utf8') : undefined, values.provider);
  if (!key.provider) throw new Error(`${key.error ?? 'unknown search provider'} (key from ${key.from}; --provider tavily|brave also names it)`);
  const providerName = key.provider;
  const searchCostUsd = values['search-cost-usd'] !== undefined ? Number(values['search-cost-usd']) : DEFAULT_SEARCH_COST[providerName];
  const judgeModel = values['judge-model']!;
  const worst = prompts.length * (searchCostUsd + 2 * estimateCost('anthropic', judgeModel, 12_000, { overheadTokens: 50, expectedOutputTokens: JUDGE_MAX_TOKENS }));
  log(`${prompts.length} prompt(s); ${providerName} key from ${key.from}; judge ${judgeModel}; worst-case spend ≈ $${worst.toFixed(3)}, hard cap $${budgetUsd.toFixed(2)}`);
  if (values['dry-run']) {
    for (const p of prompts) log(`  ${p.id}  ${clip(p.prompt, 100)}`);
    return;
  }
  if (!key.apiKey) throw new Error(`no ${providerName} key: set SEARCH_API_KEY, or give the web server one in ${mcpPath}`);
  if (!process.env.ANTHROPIC_API_KEY?.trim()) throw new Error('the judge needs ANTHROPIC_API_KEY (env or ~/.flint/secrets.env)');
  // A dead SearXNG would turn every prompt into a paid forfeit; check before spending anything.
  const health = await fetch(`${searxngUrl}/healthz`, { signal: AbortSignal.timeout(5_000) }).catch((e: unknown) => e);
  if (!(health instanceof Response) || !health.ok) throw new Error(`SearXNG not answering at ${searxngUrl}/healthz; start it (apps/studio/install_searxng.sh) or pass --searxng-url`);

  const apiKey = key.apiKey;
  const primaryOpts = { fetch, timeoutMs: 25_000 };
  const deps: CompareDeps = {
    providerName,
    primary: (q) => (providerName === 'brave' ? braveSearch(q, n, apiKey, primaryOpts) : tavilySearch(q, n, apiKey, primaryOpts)),
    searxng: (q) => searxngSearch(q, n, searxngUrl, { fetch, timeoutMs: 15_000 }),
    judge: new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY!.trim() }),
    judgeModel,
    budget: new BudgetGuard(budgetUsd),
    searchCostUsd,
    seed: Number(values.seed),
    now: new Date(),
    includeAnswer: values['include-answer']!,
  };
  const rows = await runCompare(prompts, deps, Math.max(1, Number(values.concurrency)));
  const totals = summarizeCompare(rows);
  const dead = keyUnusable(rows);
  // A refused or spent key on the first prompt: no quality verdict, nothing charged.
  if (dead && totals.judged + totals.forfeits === 0) throw new Error(`provider key unusable: nothing to compare (${dead})`);
  if (values.out) for (const r of rows) appendJsonl(resolve(values.out), { ...r, providerName, judgeModel, at: deps.now.toISOString() });
  process.stdout.write(`${renderCompare(rows, totals, { providerName, judgeModel, searxngUrl, budgetUsd, results: n, now: deps.now })}\n`);
  if (dead) log(`stopped after ${rows.length} of ${prompts.length}: provider key unusable (${dead}); the totals cover the rows before it`);
  else if (rows.length < prompts.length) log(`stopped after ${rows.length} of ${prompts.length}: budget reached`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
