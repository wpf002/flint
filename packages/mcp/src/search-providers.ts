/**
 * Web search backends for the `web` connector (connectors/web-server.ts), and
 * for anything that must see exactly what that tool sees (apps/parity's
 * search-compare).
 *
 *   tavily, brave  metered APIs, need SEARCH_API_KEY
 *   searxng        self-hosted metasearch on this machine (apps/studio/install_searxng.sh), no key
 *
 * SEARCH_PROVIDER picks the mode:
 *   tavily | brave  that provider only, exactly as before: no key or a failed
 *                   call is an error. `tavily` is still the default when unset.
 *   searxng         SearXNG only.
 *   auto            (recommended) the keyed provider stays primary whenever a key
 *                   is set, so capability is unchanged while it works. SearXNG
 *                   answers when there is no key, and gets one retry when the
 *                   primary fails (non-2xx, quota, rate limit, timeout, network,
 *                   an unreadable reply) or finds nothing. After an auth or quota
 *                   failure the primary is skipped for a cooldown instead of
 *                   being re-tried on every query; it comes back after the
 *                   cooldown, or at once if SearXNG fails in the meantime.
 *
 * Every success names the backend that answered (`source`), and a fallback
 * names what it replaced and why, so logs and evals can attribute answers.
 * Nothing here logs or returns a key.
 */

export type SearchBackend = 'tavily' | 'brave' | 'searxng';
export type SearchMode = SearchBackend | 'auto';
export type KeyedBackend = Exclude<SearchBackend, 'searxng'>;

export interface SearchItem {
  title: string;
  url: string;
  snippet: string;
  /** SearXNG only, when an engine reported one. */
  published_date?: string;
}

export interface SearchSuccess {
  ok: true;
  source: SearchBackend;
  /**
   * Tavily's synthesized answer, or SearXNG's first direct answer; null when
   * the backend gave none. Absent for Brave, whose payload never carried one.
   */
  answer?: string | null;
  results: SearchItem[];
  /** Set when a fallback answered: the backend it stood in for, and why. */
  fallback?: { from: SearchBackend; reason: string };
}

export type FailureKind = 'config' | 'auth' | 'quota' | 'rate_limit' | 'http' | 'timeout' | 'network' | 'parse' | 'empty';

export interface SearchFailure {
  ok: false;
  source: SearchBackend;
  kind: FailureKind;
  error: string;
  status?: number;
  retryAfterMs?: number;
}

export type SearchOutcome = SearchSuccess | SearchFailure;

export interface SearchConfig {
  mode: SearchMode;
  apiKey?: string;
  /** In auto mode, which metered backend SEARCH_API_KEY belongs to. */
  keyProvider: KeyedBackend;
  searxngUrl: string;
  timeoutMs: Record<SearchBackend, number>;
  /** How long auto mode skips a primary after an auth or quota failure. */
  cooldownMs: number;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export const DEFAULT_SEARXNG_URL = 'http://127.0.0.1:8888';
const RATE_LIMIT_COOLDOWN_MS = 60_000;

export const NO_KEY_MESSAGE =
  'web_search needs a key: set SEARCH_API_KEY (SEARCH_PROVIDER=tavily|brave), or set SEARCH_PROVIDER=auto or searxng to search keyless through SearXNG.';

/** Read the search config from the connector's environment. */
export function searchConfigFromEnv(env: Record<string, string | undefined> = process.env): SearchConfig {
  const raw = (env.SEARCH_PROVIDER ?? '').trim().toLowerCase();
  // Anything unrecognised meant tavily before this module existed; it still does.
  const mode: SearchMode = raw === 'brave' || raw === 'searxng' || raw === 'auto' ? raw : 'tavily';
  const apiKey = env.SEARCH_API_KEY?.trim();
  const keyProvider: KeyedBackend = env.SEARCH_KEY_PROVIDER?.trim().toLowerCase() === 'brave' ? 'brave' : 'tavily';
  // auto has a second backend to try, so the primary gets less rope: a fallback
  // has to finish inside deep_research's 25s per-search budget.
  const primaryMs = positive(env.SEARCH_TIMEOUT_MS);
  const auto = mode === 'auto';
  return {
    mode,
    ...(apiKey ? { apiKey } : {}),
    keyProvider,
    searxngUrl: (env.SEARXNG_URL?.trim() || DEFAULT_SEARXNG_URL).replace(/\/+$/, ''),
    timeoutMs: {
      tavily: primaryMs ?? (auto ? 12_000 : 25_000),
      brave: primaryMs ?? (auto ? 12_000 : 20_000),
      searxng: positive(env.SEARXNG_TIMEOUT_MS) ?? 10_000,
    },
    cooldownMs: positive(env.SEARCH_COOLDOWN_MS) ?? 15 * 60_000,
  };
}

/** One line for the connector's startup log. Never includes the key. */
export function describeSearchConfig(c: SearchConfig): string {
  if (c.mode === 'searxng') return `searxng at ${c.searxngUrl}`;
  if (c.mode === 'auto') {
    return c.apiKey
      ? `auto: ${c.keyProvider} (key set), searxng fallback at ${c.searxngUrl}`
      : `auto: no key, searxng at ${c.searxngUrl}`;
  }
  return c.apiKey ? `${c.mode} (key set, no fallback)` : `${c.mode} with no key: web_search disabled`;
}

// ---------------------------------------------------------------- backends

interface CallOpts {
  fetch: FetchLike;
  timeoutMs: number;
}

export async function tavilySearch(query: string, n: number, apiKey: string, o: CallOpts): Promise<SearchOutcome> {
  return guarded('tavily', o.timeoutMs, async (signal) => {
    const res = await o.fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        max_results: n,
        include_answer: true, // Tavily synthesizes a current-info answer from live sources
        search_depth: 'basic', // basic + include_answer is ~2-3x faster than 'advanced' and still solid
      }),
      signal,
    });
    if (!res.ok) return httpFailure('tavily', res);
    const data = await readJson('tavily', res);
    if (!isRecord(data)) throw new ParseFailure('tavily reply is not an object');
    return {
      ok: true,
      source: 'tavily',
      answer: str(data.answer) ?? null,
      results: list(data.results).flatMap((r) => item(r.title, r.url, r.content)),
    };
  });
}

export async function braveSearch(query: string, n: number, apiKey: string, o: CallOpts): Promise<SearchOutcome> {
  return guarded('brave', o.timeoutMs, async (signal) => {
    const res = await o.fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${n}`, {
      headers: { 'X-Subscription-Token': apiKey, accept: 'application/json' },
      signal,
    });
    if (!res.ok) return httpFailure('brave', res);
    const data = await readJson('brave', res);
    const web = isRecord(data) && isRecord(data.web) ? data.web : {};
    return {
      ok: true,
      source: 'brave',
      results: list(web.results).flatMap((r) => item(r.title, r.url, r.description)).slice(0, n),
    };
  });
}

const FORMATS_HINT = 'is json in search.formats of its settings.yml?';

export async function searxngSearch(query: string, n: number, baseUrl: string, o: CallOpts): Promise<SearchOutcome> {
  return guarded('searxng', o.timeoutMs, async (signal) => {
    const url = `${baseUrl}/search?q=${encodeURIComponent(query)}&format=json`;
    const res = await o.fetch(url, { headers: { accept: 'application/json' }, signal }).catch((e: unknown) => {
      throw new NetworkFailure(`searxng unreachable at ${baseUrl} (${causeOf(e)})`);
    });
    // SearXNG answers 403 to format=json unless the instance enables it.
    if (res.status === 403) return { ...(await httpFailure('searxng', res)), kind: 'http', error: `searxng HTTP 403 (${FORMATS_HINT})` };
    if (!res.ok) return httpFailure('searxng', res);
    const data = await readJson('searxng', res, FORMATS_HINT);
    if (!isRecord(data) || !Array.isArray(data.results)) throw new ParseFailure('searxng reply has no results list');
    const results = list(data.results)
      .flatMap((r) => item(r.title, r.url, r.content, r.publishedDate))
      .slice(0, n);
    if (results.length === 0) {
      // Every engine blocked or timed out is a failure, not an empty web.
      const failing = unresponsive(data.unresponsive_engines);
      if (failing) return { ok: false, source: 'searxng', kind: 'empty', error: `searxng found nothing (engines failing: ${failing})` };
    }
    return { ok: true, source: 'searxng', answer: firstAnswer(data.answers) ?? null, results };
  });
}

// ---------------------------------------------------------------- the router

export interface WebSearchDeps {
  fetch?: FetchLike;
  now?: () => number;
  log?: (msg: string) => void;
}

/** The web_search tool's backend: picks, calls and falls back per the config's mode. */
export class WebSearch {
  private cooldown: { until: number; reason: string } | undefined;
  private readonly fetchFn: FetchLike;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;

  constructor(
    readonly config: SearchConfig,
    deps: WebSearchDeps = {},
  ) {
    this.fetchFn = deps.fetch ?? ((url, init) => fetch(url, init));
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? (() => {});
  }

  /** The keyed backend auto mode prefers, if it has a key. */
  get primary(): KeyedBackend | undefined {
    return this.config.mode === 'auto' && this.config.apiKey ? this.config.keyProvider : undefined;
  }

  /** The backends a search would try right now, in order. */
  plan(): SearchBackend[] {
    const { mode, apiKey } = this.config;
    if (mode !== 'auto') return mode === 'searxng' || apiKey ? [mode] : [];
    const primary = this.primary;
    if (!primary) return ['searxng'];
    return this.coolingDown() ? ['searxng', primary] : [primary, 'searxng'];
  }

  async search(query: string, maxResults?: number): Promise<SearchOutcome> {
    const n = Math.max(1, Math.min(Math.floor(maxResults ?? 5), 10));
    const order = this.plan();
    if (order.length === 0) return { ok: false, source: this.config.mode as KeyedBackend, kind: 'config', error: NO_KEY_MESSAGE };

    const primary = this.primary;
    // Parked after an auth/quota failure: SearXNG goes first (the start of the
    // cooldown was logged once; each skipped query isn't).
    const parked = primary !== undefined && order[0] !== primary;
    // Why the primary didn't answer this query, if it didn't.
    let skipped = parked ? `skipped after ${this.cooldown!.reason}, retrying ${untilText(this.cooldown!.until - this.now())}` : undefined;
    const failures: SearchFailure[] = [];
    let empty: SearchSuccess | undefined;

    for (const backend of order) {
      const out = await this.call(backend, query, n);
      if (!out.ok) {
        this.noteFailure(out);
        failures.push(out);
        if (backend === primary) skipped = out.error;
        continue;
      }
      if (backend === primary) this.cooldown = undefined;
      // A keyed primary that found nothing gets a free second opinion.
      if (backend === primary && !parked && out.results.length === 0) {
        empty = out;
        skipped = `${primary} found nothing`;
        continue;
      }
      if (backend === 'searxng' && primary && skipped) {
        if (empty && out.results.length === 0) return empty;
        if (!parked) this.log(`[web_search] ${skipped}; searxng answered`);
        return { ...out, fallback: { from: primary, reason: skipped } };
      }
      return out;
    }
    if (empty) return empty;
    const [first, ...rest] = failures;
    return {
      ...first!,
      error: [first!.error, ...rest.map((f) => `fallback ${f.error}`)].join('; '),
    };
  }

  private call(backend: SearchBackend, query: string, n: number): Promise<SearchOutcome> {
    const o = { fetch: this.fetchFn, timeoutMs: this.config.timeoutMs[backend] };
    if (backend === 'searxng') return searxngSearch(query, n, this.config.searxngUrl, o);
    const key = this.config.apiKey ?? '';
    return backend === 'brave' ? braveSearch(query, n, key, o) : tavilySearch(query, n, key, o);
  }

  private coolingDown(): boolean {
    if (this.cooldown && this.now() >= this.cooldown.until) this.cooldown = undefined;
    return this.cooldown !== undefined;
  }

  /** Auth and quota failures park the primary; transient ones (timeouts, 5xx) don't. */
  private noteFailure(out: SearchFailure): void {
    if (out.source !== this.primary) return;
    const ms =
      out.kind === 'auth' || out.kind === 'quota'
        ? this.config.cooldownMs
        : out.kind === 'rate_limit'
          ? (out.retryAfterMs ?? RATE_LIMIT_COOLDOWN_MS)
          : undefined;
    if (ms === undefined) return;
    this.cooldown = { until: this.now() + ms, reason: out.error };
    this.log(`[web_search] ${out.error}; searxng answers for ${untilText(ms)}`);
  }
}

/** The web_search tool payload: the fields it always had, plus `source` (and `fallback`). */
export function toToolPayload(out: SearchSuccess): Record<string, unknown> {
  return {
    ...(out.answer !== undefined ? { answer: out.answer } : {}),
    results: out.results,
    source: out.source,
    ...(out.fallback ? { fallback: out.fallback } : {}),
  };
}

// ---------------------------------------------------------------- helpers

class ParseFailure extends Error {}
class NetworkFailure extends Error {}

async function guarded(
  source: SearchBackend,
  timeoutMs: number,
  fn: (signal: AbortSignal) => Promise<SearchOutcome>,
): Promise<SearchOutcome> {
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Race as well as abort: an abort only helps if the fetch honours its signal.
  const timeout = new Promise<SearchFailure>((resolve) => {
    timer = setTimeout(() => {
      ctrl.abort();
      resolve({ ok: false, source, kind: 'timeout', error: `${source} timed out after ${timeoutMs}ms` });
    }, timeoutMs);
  });
  try {
    return await Promise.race([fn(ctrl.signal), timeout]);
  } catch (e) {
    if (ctrl.signal.aborted) return { ok: false, source, kind: 'timeout', error: `${source} timed out after ${timeoutMs}ms` };
    if (e instanceof ParseFailure) return { ok: false, source, kind: 'parse', error: e.message };
    if (e instanceof NetworkFailure) return { ok: false, source, kind: 'network', error: e.message };
    return { ok: false, source, kind: 'network', error: `${source} request failed (${causeOf(e)})` };
  } finally {
    clearTimeout(timer);
  }
}

async function httpFailure(source: SearchBackend, res: Response): Promise<SearchFailure> {
  await res.body?.cancel().catch(() => {});
  const status = res.status;
  // Tavily: 432 = plan limit, 433 = pay-as-you-go limit. Brave: 402 on a lapsed plan.
  const kind: FailureKind =
    status === 401 || status === 403
      ? 'auth'
      : status === 402 || status === 432 || status === 433
        ? 'quota'
        : status === 429
          ? 'rate_limit'
          : 'http';
  const label = kind === 'http' ? '' : kind === 'rate_limit' ? ' (rate limited)' : ` (${kind})`;
  const retryAfterMs = retryAfter(res.headers.get('retry-after'));
  return {
    ok: false,
    source,
    kind,
    status,
    error: `${source} HTTP ${status}${label}`,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };
}

async function readJson(source: SearchBackend, res: Response, hint?: string): Promise<unknown> {
  const body = await res.text();
  try {
    return JSON.parse(body) as unknown;
  } catch {
    const ct = res.headers.get('content-type') || 'no content-type';
    const preview = body.replace(/\s+/g, ' ').trim().slice(0, 60);
    throw new ParseFailure(`${source} returned non-JSON (${ct}: "${preview}")${hint ? `; ${hint}` : ''}`);
  }
}

function item(title: unknown, url: unknown, snippet: unknown, date?: unknown): SearchItem[] {
  const u = str(url);
  if (!u || !/^https?:\/\//i.test(u)) return [];
  const d = str(date);
  return [{ title: str(title) ?? u, url: u, snippet: str(snippet) ?? '', ...(d ? { published_date: d } : {}) }];
}

function firstAnswer(answers: unknown): string | undefined {
  for (const a of Array.isArray(answers) ? answers : []) {
    const text = typeof a === 'string' ? str(a) : isRecord(a) ? str(a.answer) : undefined;
    if (text) return text;
  }
  return undefined;
}

/** SearXNG's [[engine, reason], ...] as "duckduckgo: CAPTCHA, brave: timeout". */
function unresponsive(v: unknown): string {
  return (Array.isArray(v) ? v : [])
    .map((e) => (Array.isArray(e) ? e.map(String).join(': ') : isRecord(e) ? [e.engine, e.error].filter(Boolean).join(': ') : String(e)))
    .filter(Boolean)
    .slice(0, 6)
    .join(', ');
}

function retryAfter(h: string | null): number | undefined {
  if (!h) return undefined;
  const secs = Number(h);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 60 * 60_000);
  const at = Date.parse(h);
  return Number.isFinite(at) ? Math.max(0, Math.min(at - Date.now(), 60 * 60_000)) : undefined;
}

function untilText(ms: number): string {
  const m = Math.max(0, ms) / 60_000;
  return m >= 1 ? `in ${Math.round(m)} min` : `in ${Math.max(1, Math.round(ms / 1000))}s`;
}

function causeOf(e: unknown): string {
  const err = e as { message?: unknown; cause?: { code?: unknown; message?: unknown } } | null;
  const cause = err?.cause;
  return String(cause?.code ?? cause?.message ?? err?.message ?? e);
}

function list(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.filter(isRecord) : [];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function positive(v: string | undefined): number | undefined {
  const n = Number(v);
  return v !== undefined && v.trim() !== '' && Number.isFinite(n) && n > 0 ? n : undefined;
}
