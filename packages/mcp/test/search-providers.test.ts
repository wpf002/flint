import { describe, expect, it } from 'vitest';
import {
  NO_KEY_MESSAGE,
  WebSearch,
  describeSearchConfig,
  searchConfigFromEnv,
  toToolPayload,
  type FetchLike,
  type SearchOutcome,
  type SearchSuccess,
} from '../src/search-providers.js';

// ---------------------------------------------------------------- stubs

type Backend = 'tavily' | 'brave' | 'searxng';
type Route = (url: string, init: RequestInit) => Response | Promise<Response>;

function stubFetch(routes: Partial<Record<Backend, Route>>) {
  const calls: Array<{ backend: Backend; url: string; init: RequestInit }> = [];
  const fetch: FetchLike = async (url, init) => {
    const backend: Backend = url.startsWith('https://api.tavily.com')
      ? 'tavily'
      : url.startsWith('https://api.search.brave.com')
        ? 'brave'
        : 'searxng';
    calls.push({ backend, url, init });
    const route = routes[backend];
    if (!route) throw new Error(`unexpected ${backend} call`);
    return route(url, init);
  };
  return { fetch, calls, count: (b: Backend) => calls.filter((c) => c.backend === b).length };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/** A server that never answers — only the timeout gets us out. */
const hang: Route = (_url, init) =>
  new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));

/** Nothing listening (Node's fetch: TypeError with the socket error as cause). */
const refused: Route = () => {
  throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
};

const TAVILY_OK = {
  answer: 'The Fed held rates at 3.75-4%.',
  results: [
    { title: 'FOMC statement', url: 'https://www.federalreserve.gov/a', content: 'held the target range', score: 0.9 },
    { title: 'Reuters', url: 'https://reuters.com/b', content: 'Fed holds', score: 0.8 },
  ],
};

const SEARX_OK = {
  query: 'fed rate',
  results: [
    { title: 'Fed holds rates', url: 'https://apnews.com/x', content: 'The Federal Reserve held...', engine: 'duckduckgo', publishedDate: '2026-09-17T18:00:00' },
    { title: 'bad scheme', url: 'javascript:alert(1)', content: 'dropped' },
    { title: '', url: 'https://federalreserve.gov/y', content: '' },
    { title: 'Third', url: 'https://c.com/3', content: 'three' },
  ],
  answers: [{ answer: '3.75% to 4%', url: 'https://federalreserve.gov' }],
  suggestions: [],
  unresponsive_engines: [],
};

const FAST = { SEARCH_TIMEOUT_MS: '40', SEARXNG_TIMEOUT_MS: '40' };

function router(env: Record<string, string>, routes: Partial<Record<Backend, Route>>, clock = { t: 0 }) {
  const stub = stubFetch(routes);
  const logs: string[] = [];
  const ws = new WebSearch(searchConfigFromEnv(env), { fetch: stub.fetch, now: () => clock.t, log: (m) => logs.push(m) });
  return { ws, stub, logs, clock };
}

function ok(out: SearchOutcome): SearchSuccess {
  if (!out.ok) throw new Error(`expected success, got ${out.kind}: ${out.error}`);
  return out;
}

// ---------------------------------------------------------------- config

describe('config from env', () => {
  it('keeps tavily as the default when SEARCH_PROVIDER is unset or unknown, with the old timeouts', () => {
    for (const env of [{}, { SEARCH_PROVIDER: 'duckduckgo' }, { SEARCH_PROVIDER: ' Tavily ' }]) {
      const c = searchConfigFromEnv(env);
      expect(c.mode).toBe('tavily');
      expect(c.timeoutMs).toEqual({ tavily: 25_000, brave: 20_000, searxng: 10_000 });
    }
  });

  it('reads auto, the key provider, the SearXNG URL and the overrides', () => {
    const c = searchConfigFromEnv({
      SEARCH_PROVIDER: 'AUTO',
      SEARCH_API_KEY: ' k ',
      SEARCH_KEY_PROVIDER: 'brave',
      SEARXNG_URL: 'http://127.0.0.1:8899///',
      SEARCH_COOLDOWN_MS: '5000',
    });
    expect(c).toMatchObject({ mode: 'auto', apiKey: 'k', keyProvider: 'brave', searxngUrl: 'http://127.0.0.1:8899', cooldownMs: 5000 });
    // auto leaves room for the fallback inside deep_research's 25s search budget
    expect(c.timeoutMs.brave).toBe(12_000);
    expect(searchConfigFromEnv({ SEARCH_PROVIDER: 'auto' }).searxngUrl).toBe('http://127.0.0.1:8888');
    expect(searchConfigFromEnv({ SEARCH_PROVIDER: 'auto' }).apiKey).toBeUndefined();
    expect(searchConfigFromEnv({ SEARCH_TIMEOUT_MS: 'soon' }).timeoutMs.tavily).toBe(25_000);
  });

  it('describes itself without the key', () => {
    const secret = 'tvly-SECRET123';
    const lines = [
      describeSearchConfig(searchConfigFromEnv({ SEARCH_PROVIDER: 'auto', SEARCH_API_KEY: secret })),
      describeSearchConfig(searchConfigFromEnv({ SEARCH_API_KEY: secret })),
      describeSearchConfig(searchConfigFromEnv({ SEARCH_PROVIDER: 'auto' })),
      describeSearchConfig(searchConfigFromEnv({})),
    ];
    expect(lines).toEqual([
      'auto: tavily (key set), searxng fallback at http://127.0.0.1:8888',
      'tavily (key set, no fallback)',
      'auto: no key, searxng at http://127.0.0.1:8888',
      'tavily with no key: web_search disabled',
    ]);
    expect(lines.join('\n')).not.toContain(secret);
  });
});

// ---------------------------------------------------------------- mapping

describe('mapping each backend to the tool shape', () => {
  it('tavily: same request as before; answer + results + source', async () => {
    const { ws, stub } = router({ SEARCH_API_KEY: 'tvly-x' }, { tavily: () => json(TAVILY_OK) });
    const out = ok(await ws.search('fed rate', 3));
    const body = JSON.parse(String(stub.calls[0]!.init.body));
    expect(body).toEqual({ api_key: 'tvly-x', query: 'fed rate', max_results: 3, include_answer: true, search_depth: 'basic' });
    expect(toToolPayload(out)).toEqual({
      answer: 'The Fed held rates at 3.75-4%.',
      results: [
        { title: 'FOMC statement', url: 'https://www.federalreserve.gov/a', snippet: 'held the target range' },
        { title: 'Reuters', url: 'https://reuters.com/b', snippet: 'Fed holds' },
      ],
      source: 'tavily',
    });
  });

  it('brave: query and count in the URL, key in the header, capped at n', async () => {
    const results = Array.from({ length: 8 }, (_, i) => ({ title: `T${i}`, url: `https://b.com/${i}`, description: `d${i}` }));
    const { ws, stub } = router({ SEARCH_PROVIDER: 'brave', SEARCH_API_KEY: 'BSAkey' }, { brave: () => json({ web: { results } }) });
    const out = ok(await ws.search('a b', 2));
    expect(stub.calls[0]!.url).toBe('https://api.search.brave.com/res/v1/web/search?q=a%20b&count=2');
    expect((stub.calls[0]!.init.headers as Record<string, string>)['X-Subscription-Token']).toBe('BSAkey');
    expect(toToolPayload(out)).toEqual({
      results: [
        { title: 'T0', url: 'https://b.com/0', snippet: 'd0' },
        { title: 'T1', url: 'https://b.com/1', snippet: 'd1' },
      ],
      source: 'brave',
    });
  });

  it('searxng: GET /search?format=json; content → snippet, dates kept, non-http dropped, first answer', async () => {
    const { ws, stub } = router({ SEARCH_PROVIDER: 'searxng', SEARXNG_URL: 'http://127.0.0.1:8899/' }, { searxng: () => json(SEARX_OK) });
    const out = ok(await ws.search('fed rate & more'));
    expect(stub.calls[0]!.url).toBe('http://127.0.0.1:8899/search?q=fed%20rate%20%26%20more&format=json');
    expect(stub.calls[0]!.init.method ?? 'GET').toBe('GET');
    expect(toToolPayload(out)).toEqual({
      answer: '3.75% to 4%',
      results: [
        { title: 'Fed holds rates', url: 'https://apnews.com/x', snippet: 'The Federal Reserve held...', published_date: '2026-09-17T18:00:00' },
        { title: 'https://federalreserve.gov/y', url: 'https://federalreserve.gov/y', snippet: '' },
        { title: 'Third', url: 'https://c.com/3', snippet: 'three' },
      ],
      source: 'searxng',
    });
    expect(ok(await ws.search('fed rate', 1)).results).toHaveLength(1);
  });

  it('clamps max_results to 1..10 like before', async () => {
    const { ws, stub } = router({ SEARCH_API_KEY: 'k' }, { tavily: () => json(TAVILY_OK) });
    await ws.search('q', 0);
    await ws.search('q', 50);
    await ws.search('q');
    expect(stub.calls.map((c) => JSON.parse(String(c.init.body)).max_results)).toEqual([1, 10, 5]);
  });
});

// ---------------------------------------------------------------- explicit modes

describe('explicit tavily/brave: exactly the old behaviour', () => {
  it('no key → the config error, and nothing is fetched', async () => {
    const { ws, stub } = router({}, {});
    const out = await ws.search('q');
    expect(out).toMatchObject({ ok: false, kind: 'config', error: NO_KEY_MESSAGE });
    expect(stub.calls).toHaveLength(0);
  });

  it('a provider failure is an error, never a silent SearXNG answer', async () => {
    const { ws, stub } = router({ SEARCH_PROVIDER: 'tavily', SEARCH_API_KEY: 'k' }, { tavily: () => json({}, 429), searxng: () => json(SEARX_OK) });
    const out = await ws.search('q');
    expect(out).toMatchObject({ ok: false, source: 'tavily', kind: 'rate_limit', error: 'tavily HTTP 429 (rate limited)' });
    expect(stub.count('searxng')).toBe(0);
  });
});

// ---------------------------------------------------------------- auto

describe('auto: keyed primary, SearXNG fallback', () => {
  const AUTO = { SEARCH_PROVIDER: 'auto', SEARCH_API_KEY: 'tvly-x', ...FAST };

  it('with a key, the provider answers and SearXNG is never called', async () => {
    const { ws, stub } = router(AUTO, { tavily: () => json(TAVILY_OK), searxng: () => json(SEARX_OK) });
    expect(ws.plan()).toEqual(['tavily', 'searxng']);
    const out = ok(await ws.search('q'));
    expect(out.source).toBe('tavily');
    expect(out.fallback).toBeUndefined();
    expect(stub.count('searxng')).toBe(0);
  });

  it('with no key, SearXNG is the only backend (no metered call at all)', async () => {
    const { ws, stub } = router({ SEARCH_PROVIDER: 'auto' }, { searxng: () => json(SEARX_OK) });
    expect(ws.plan()).toEqual(['searxng']);
    const out = ok(await ws.search('q'));
    expect(out.source).toBe('searxng');
    expect(out.fallback).toBeUndefined();
    expect(stub.calls.map((c) => c.backend)).toEqual(['searxng']);
  });

  it('SEARCH_KEY_PROVIDER=brave makes brave the primary', async () => {
    const { ws } = router({ ...AUTO, SEARCH_KEY_PROVIDER: 'brave' }, { brave: () => json({ web: { results: [] } }) });
    expect(ws.plan()).toEqual(['brave', 'searxng']);
  });

  it.each([
    ['429', () => json({ detail: 'slow down' }, 429), /tavily HTTP 429 \(rate limited\)/],
    ['quota 432', () => json({ detail: { error: 'plan limit' } }, 432), /tavily HTTP 432 \(quota\)/],
    ['500', () => json({}, 500), /tavily HTTP 500$/],
    ['timeout', hang, /tavily timed out after 40ms/],
    ['network', refused, /tavily request failed \(ECONNREFUSED\)/],
    ['non-JSON', () => new Response('<html>Bad Gateway</html>', { status: 200, headers: { 'content-type': 'text/html' } }), /tavily returned non-JSON \(text\/html: "<html>Bad Gateway<\/html>"\)/],
  ] as Array<[string, Route, RegExp]>)('falls back to SearXNG on %s, and says why', async (_name, tavily, reason) => {
    const { ws, stub, logs } = router(AUTO, { tavily, searxng: () => json(SEARX_OK) });
    const out = ok(await ws.search('q'));
    expect(out.source).toBe('searxng');
    expect(out.fallback?.from).toBe('tavily');
    expect(out.fallback?.reason).toMatch(reason);
    expect(toToolPayload(out)).toMatchObject({ source: 'searxng', fallback: { from: 'tavily' } });
    expect(stub.calls.map((c) => c.backend)).toEqual(['tavily', 'searxng']);
    expect(logs.join('\n')).toContain('searxng answered');
    expect(logs.join('\n')).not.toContain('tvly-x');
  });

  it('a primary that finds nothing gets a free SearXNG second opinion', async () => {
    const { ws } = router(AUTO, { tavily: () => json({ answer: null, results: [] }), searxng: () => json(SEARX_OK) });
    const out = ok(await ws.search('q'));
    expect(out.source).toBe('searxng');
    expect(out.fallback).toEqual({ from: 'tavily', reason: 'tavily found nothing' });
  });

  it('keeps the primary empty result (and its answer) when SearXNG has nothing either', async () => {
    const { ws } = router(AUTO, {
      tavily: () => json({ answer: 'Only an answer.', results: [] }),
      searxng: () => json({ results: [], unresponsive_engines: [] }),
    });
    const out = ok(await ws.search('q'));
    expect(out).toMatchObject({ source: 'tavily', answer: 'Only an answer.', results: [] });
  });

  it('reports both failures when SearXNG is down too', async () => {
    const { ws } = router({ ...AUTO, SEARXNG_URL: 'http://127.0.0.1:8899' }, { tavily: () => json({}, 500), searxng: refused });
    const out = await ws.search('q');
    expect(out).toMatchObject({ ok: false, source: 'tavily', kind: 'http' });
    expect(!out.ok && out.error).toBe('tavily HTTP 500; fallback searxng unreachable at http://127.0.0.1:8899 (ECONNREFUSED)');
  });

  it('parks a spent key: after a quota error, SearXNG goes first until the cooldown ends', async () => {
    const clock = { t: 1_000 };
    let quota = true;
    const { ws, stub, logs } = router(
      { ...AUTO, SEARCH_COOLDOWN_MS: '600000' },
      { tavily: () => (quota ? json({}, 432) : json(TAVILY_OK)), searxng: () => json(SEARX_OK) },
      clock,
    );
    ok(await ws.search('first'));
    expect(logs.some((l) => l.includes('tavily HTTP 432 (quota); searxng answers for in 10 min'))).toBe(true);
    expect(ws.plan()).toEqual(['searxng', 'tavily']);

    const logsBefore = logs.length;
    const parked = ok(await ws.search('second'));
    expect(parked.source).toBe('searxng');
    expect(parked.fallback?.reason).toMatch(/^skipped after tavily HTTP 432 \(quota\), retrying in 10 min$/);
    expect(stub.count('tavily')).toBe(1); // not re-tried while parked
    expect(logs.length).toBe(logsBefore); // one log line for the whole cooldown, not one per query

    quota = false;
    clock.t += 600_000;
    expect(ws.plan()).toEqual(['tavily', 'searxng']);
    expect(ok(await ws.search('third')).source).toBe('tavily');
  });

  it('a 429 parks the key only for Retry-After', async () => {
    const clock = { t: 0 };
    const { ws } = router(AUTO, { tavily: () => json({}, 429, { 'retry-after': '30' }), searxng: () => json(SEARX_OK) }, clock);
    await ws.search('q');
    expect(ws.plan()[0]).toBe('searxng');
    clock.t += 30_000;
    expect(ws.plan()[0]).toBe('tavily');
  });

  it('timeouts and 5xx do not park the key', async () => {
    const { ws } = router(AUTO, { tavily: hang, searxng: () => json(SEARX_OK) });
    await ws.search('q');
    expect(ws.plan()[0]).toBe('tavily');
  });

  it('while parked, a failing SearXNG still gets the key a try', async () => {
    const clock = { t: 0 };
    let calls = 0;
    const { ws } = router(AUTO, { tavily: () => (++calls === 1 ? json({}, 401) : json(TAVILY_OK)), searxng: refused }, clock);
    expect((await ws.search('q')).ok).toBe(false); // 401 then SearXNG down
    const out = ok(await ws.search('q')); // parked: SearXNG first (down), then the key, which works now
    expect(out.source).toBe('tavily');
    expect(out.fallback).toBeUndefined();
    expect(ws.plan()[0]).toBe('tavily'); // a success clears the cooldown
  });
});

// ---------------------------------------------------------------- searxng garbage

describe('SearXNG replies that are not results', () => {
  const S = { SEARCH_PROVIDER: 'searxng', ...FAST };

  it('an HTML page (json format disabled) is a parse failure with the fix in it', async () => {
    const { ws } = router(S, { searxng: () => new Response('<!DOCTYPE html><html>SearXNG</html>', { headers: { 'content-type': 'text/html' } }) });
    const out = await ws.search('q');
    expect(out).toMatchObject({ ok: false, kind: 'parse' });
    expect(!out.ok && out.error).toMatch(/non-JSON.*search\.formats/);
  });

  it('403 says to enable the json format', async () => {
    const { ws } = router(S, { searxng: () => new Response('Forbidden', { status: 403 }) });
    expect(await ws.search('q')).toMatchObject({ ok: false, kind: 'http', status: 403, error: expect.stringMatching(/search\.formats/) });
  });

  it('JSON without a results list, or truncated JSON, is a parse failure', async () => {
    for (const body of ['{"results": "none"}', '{"results": [', '[]', 'null']) {
      const { ws } = router(S, { searxng: () => new Response(body, { headers: { 'content-type': 'application/json' } }) });
      expect(await ws.search('q'), body).toMatchObject({ ok: false, kind: 'parse' });
    }
  });

  it('junk entries inside results are skipped, not fatal', async () => {
    const { ws } = router(S, { searxng: () => json({ results: [null, 7, 'x', { url: 42 }, { title: 'ok', url: 'https://ok.com' }] }) });
    expect(ok(await ws.search('q')).results).toEqual([{ title: 'ok', url: 'https://ok.com', snippet: '' }]);
  });

  it('no results because every engine failed is a failure; a genuinely empty web is not', async () => {
    const blocked = router(S, { searxng: () => json({ results: [], unresponsive_engines: [['duckduckgo', 'CAPTCHA'], ['brave', 'timeout']] }) });
    expect(await blocked.ws.search('q')).toMatchObject({ ok: false, kind: 'empty', error: 'searxng found nothing (engines failing: duckduckgo: CAPTCHA, brave: timeout)' });
    const quiet = router(S, { searxng: () => json({ results: [], unresponsive_engines: [] }) });
    expect(ok(await quiet.ws.search('q')).results).toEqual([]);
  });

  it('times out instead of hanging', async () => {
    const { ws } = router(S, { searxng: hang });
    expect(await ws.search('q')).toMatchObject({ ok: false, kind: 'timeout', error: 'searxng timed out after 40ms' });
  });
});
