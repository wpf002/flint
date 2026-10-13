/**
 * "A model on this Mac", for every local call the runtime makes (model/here):
 * the name is not a cloud model's, the address is this machine, and Ollama's
 * own listing holds the model and says nothing of a remote host or model.
 *
 * First the record itself, then each caller against it: triage's judge, a goal
 * review's plan stage and a prediction's second opinion. For each, a cloud
 * tag, a plain name that Ollama lists with a remote host, a listing that hangs
 * or fails, and an Ollama that is not this machine all end "unavailable" with
 * nothing claimed and no model request sent.
 */
import { describe, it, expect } from 'vitest';
import { LISTING_MAX_AGE_MS, LocalModels } from '../../src/model/here';
import { judge } from '../../src/triage/judge';
import { planDiff, type PlanFacts } from '../../src/goals/planner';
import { facts as eventFacts } from '../triage/helpers';
import { hangs, listening, tags, type Listened } from '../ollama-kit';

const URL_ = 'http://127.0.0.1:11434';
const MODEL = 'muse-glimmer:30b';
const HERE = [{ name: MODEL, model: MODEL, size: 1 }, { name: 'llama3.1:latest' }];
/** A cloud model under a plain name, as `ollama cp gpt-oss:120b-cloud mine` leaves it. */
const ALIAS = { name: 'mine:latest', model: 'mine:latest', remote_host: 'https://ollama.com:443', remote_model: 'gpt-oss:120b' };

describe('what the runtime knows of the models on this Mac', () => {
  it('a model Ollama lists with no remote host is here, and the listing is asked for once a minute at most', async () => {
    let now = 1_000_000;
    const models = new LocalModels({ now: () => now });
    const o = listening(() => tags(HERE));
    expect(await models.runsHere({ url: URL_, model: MODEL }, o.fetch)).toBe(true);
    expect(await models.runsHere({ url: URL_, model: 'Llama3.1' }, o.fetch)).toBe(true);
    expect(await models.runsHere({ url: `${URL_}/`, model: MODEL }, o.fetch)).toBe(true);
    expect(o.seen).toEqual([{ method: 'GET', url: `${URL_}/api/tags` }]);
    now += LISTING_MAX_AGE_MS;
    expect(await models.runsHere({ url: URL_, model: MODEL }, o.fetch)).toBe(true);
    expect(o.seen).toHaveLength(1);
    // A minute on, it is asked again.
    now += 1;
    expect(await models.runsHere({ url: URL_, model: MODEL }, o.fetch)).toBe(true);
    expect(o.seen).toHaveLength(2);
  });

  it('a cloud model’s name is refused without asking anything', async () => {
    const models = new LocalModels();
    // Even when a listing would vouch for it.
    const o = listening(() => tags([{ name: 'gpt-oss:120b-cloud' }, { name: 'glm-4.6:cloud' }]));
    for (const model of ['gpt-oss:120b-cloud', 'glm-4.6:cloud', 'qwen3-coder-cloud', 'Kimi-K2:1T-Cloud', '', '  ']) expect(await models.runsHere({ url: URL_, model }, o.fetch), model).toBe(false);
    expect(o.seen).toEqual([]);
  });

  it('an Ollama that is not this machine is refused without asking anything', async () => {
    const models = new LocalModels();
    const o = listening(() => tags(HERE));
    for (const url of ['http://10.0.0.5:11434', 'http://192.168.1.20:11434', 'https://ollama.com', 'http://127.0.0.1.example.com:11434', 'http://studio.local:11434', 'http://0.0.0.0:11434', 'not a url', '']) {
      expect(await models.runsHere({ url, model: MODEL }, o.fetch), url).toBe(false);
    }
    expect(o.seen).toEqual([]);
    // Nor is a listing taken for one.
    models.learn('http://10.0.0.5:11434', HERE);
    expect(await models.runsHere({ url: 'http://10.0.0.5:11434', model: MODEL }, o.fetch)).toBe(false);
  });

  it('a plain name that Ollama lists with a remote host or a remote model runs elsewhere', async () => {
    const models = new LocalModels();
    const o = listening(() => tags([ALIAS, ...HERE, { name: 'other:1', remote_model: 'x' }, { name: 'twice:1' }, { name: 'twice:1', remote_host: 'h' }]));
    expect(await models.runsHere({ url: URL_, model: 'mine' }, o.fetch)).toBe(false);
    expect(await models.runsHere({ url: URL_, model: 'mine:latest' }, o.fetch)).toBe(false);
    expect(await models.runsHere({ url: URL_, model: 'other:1' }, o.fetch)).toBe(false);
    expect(await models.runsHere({ url: URL_, model: 'twice:1' }, o.fetch)).toBe(false);
    expect(await models.runsHere({ url: URL_, model: MODEL }, o.fetch)).toBe(true);
  });

  it('a model the listing does not hold is not here', async () => {
    const models = new LocalModels();
    const o = listening(() => tags(HERE));
    expect(await models.runsHere({ url: URL_, model: 'qwen3.6:35b' }, o.fetch)).toBe(false);
    expect(await models.runsHere({ url: URL_, model: 'muse-glimmer:7b' }, o.fetch)).toBe(false);
  });

  it('a listing that fails is no listing: not here, and asked again the next time', async () => {
    const failures: Array<[string, () => Response | Promise<Response>]> = [
      ['a 500', () => new Response('{"error":"x"}', { status: 500 })],
      ['a 404', () => new Response('not found', { status: 404 })],
      ['a redirect', () => new Response(null, { status: 302, headers: { location: 'https://ollama.com/api/tags' } })],
      ['refused', () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); }],
      ['no JSON', () => new Response('<html>hello</html>', { status: 200 })],
      ['JSON that is no listing', () => new Response('{"models":"all of them"}', { status: 200 })],
      ['null', () => new Response('null', { status: 200 })],
      ['an empty listing', () => tags([])],
    ];
    for (const [what, listing] of failures) {
      const models = new LocalModels();
      const o = listening(listing);
      expect(await models.runsHere({ url: URL_, model: MODEL }, o.fetch), what).toBe(false);
      expect(o.seen, what).toHaveLength(1);
    }
    // What was known before a failure is not believed after it.
    let now = 0;
    let up = true;
    const models = new LocalModels({ now: () => now });
    const o = listening(() => (up ? tags(HERE) : new Response('', { status: 503 })));
    expect(await models.runsHere({ url: URL_, model: MODEL }, o.fetch)).toBe(true);
    up = false;
    now += LISTING_MAX_AGE_MS + 1;
    expect(await models.runsHere({ url: URL_, model: MODEL }, o.fetch)).toBe(false);
    up = true;
    expect(await models.runsHere({ url: URL_, model: MODEL }, o.fetch)).toBe(true);
    expect(o.seen).toHaveLength(3);
  });

  it('a listing that hangs is given up: not here, in about the time it is allowed', async () => {
    const models = new LocalModels({ timeoutMs: 40 });
    const o = listening(hangs);
    const started = Date.now();
    expect(await models.runsHere({ url: URL_, model: MODEL }, o.fetch)).toBe(false);
    expect(Date.now() - started).toBeLessThan(2_000);
    // A transport that honours the signal is told to stop.
    let aborted = false;
    const polite = (async (_u: string, init?: RequestInit) => new Promise<Response>((_, reject) => init!.signal!.addEventListener('abort', () => { aborted = true; reject(new DOMException('timed out', 'TimeoutError')); }))) as unknown as typeof fetch;
    expect(await new LocalModels({ timeoutMs: 40 }).runsHere({ url: URL_, model: MODEL }, polite)).toBe(false);
    expect(aborted).toBe(true);
  });

  it('callers that ask together share one request', async () => {
    const models = new LocalModels();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const o = listening(async () => { await gate; return tags(HERE); });
    const asked = Promise.all([1, 2, 3].map(() => models.runsHere({ url: URL_, model: MODEL }, o.fetch)));
    release();
    expect(await asked).toEqual([true, true, true]);
    expect(o.seen).toHaveLength(1);
  });

  it('the listing can only be asked of that Ollama, by GET, with no redirect followed', async () => {
    const seen: RequestInit[] = [];
    const f = (async (_u: string, init?: RequestInit) => (seen.push(init!), tags(HERE))) as unknown as typeof fetch;
    await new LocalModels().runsHere({ url: URL_, model: MODEL }, f);
    expect(seen[0]).toMatchObject({ method: 'GET', redirect: 'manual' });
    expect(seen[0]!.body).toBeUndefined();
  });
});

// ── every caller ────────────────────────────────────────────────────────────

const chatReply = (content: unknown) => new Response(JSON.stringify({ model: 'm', message: { role: 'assistant', content: JSON.stringify(content) }, done: true, done_reason: 'stop', prompt_eval_count: 10, eval_count: 5 }), { status: 200, headers: { 'content-type': 'application/json' } });

const PLAN: PlanFacts = {
  today: '2026-10-12', finishBy: null, title: 'Synthetic goal', why: '', tainted: false,
  criteria: [{ id: 'c1', text: 'Synthetic check', state: 'unmet' }], steps: [], items: [],
};

interface Called {
  ok: boolean;
  why?: string;
  requests: number;
}
interface Counts {
  claims: number;
  loads: number;
}
/** One local call the runtime makes: asked of `ollama`, through `o`, with what it knows in `models`. */
type Caller = (ollama: { url: string; model: string }, o: Listened, models: LocalModels, n: Counts) => Promise<Called>;

const gates = (n: Counts) => ({ load: async () => (n.loads++, 'proceed' as const), claim: async () => (n.claims++, true) });

const CALLERS: Array<[string, Caller, unknown]> = [
  [
    'triage’s judge',
    (ollama, o, models, n) => judge(eventFacts({ created: true }, { name: 'Synthetic issue', state: { number: 7, state: 'open' } }), { ollama, ...gates(n), fetch: o.fetch, models }),
    { relevance: 0.2, reasonCode: 'fyi', reasoning: 'r' },
  ],
  [
    'a goal review’s plan stage',
    (ollama, o, models, n) => planDiff(PLAN, { ollama, ...gates(n), resolve: () => [], fetch: o.fetch, models }),
    { reasonCode: 'on_track', ops: [] },
  ],
];

describe.each(CALLERS)('%s asks only a model on this Mac', (_name, call, good) => {
  const model = (o: { n: number }) => (async () => (o.n++, chatReply(good))) as unknown as typeof fetch;
  const refused = async (ollama: { url: string; model: string }, listing: () => Response | Promise<Response>, listings: number, models = new LocalModels({ timeoutMs: 40 })) => {
    const sent = { n: 0 };
    const o = listening(listing, model(sent));
    const n = { claims: 0, loads: 0 };
    const r = await call(ollama, o, models, n);
    expect(r).toMatchObject({ ok: false, why: 'unavailable', requests: 0 });
    // Nothing was sent to a model, nothing was claimed of the cap, and chat was not asked to wait on it.
    expect(sent.n).toBe(0);
    expect(o.sent()).toBe(0);
    expect(n).toEqual({ claims: 0, loads: 0 });
    expect(o.seen.map((s) => `${s.method} ${s.url}`)).toEqual(Array(listings).fill(`GET ${URL_}/api/tags`));
  };

  it('a model Ollama says is here is asked, after one look at the listing', async () => {
    const sent = { n: 0 };
    const o = listening(() => tags(HERE), model(sent));
    const n = { claims: 0, loads: 0 };
    const models = new LocalModels();
    expect(await call({ url: URL_, model: MODEL }, o, models, n)).toMatchObject({ ok: true, requests: 1 });
    expect(o.seen.map((s) => `${s.method} ${new URL(s.url).pathname}`)).toEqual(['GET /api/tags', 'POST /api/chat']);
    expect(n).toEqual({ claims: 1, loads: 1 });
    // Within the minute the listing is believed: the next call asks the model only.
    expect(await call({ url: URL_, model: MODEL }, o, models, n)).toMatchObject({ ok: true, requests: 1 });
    expect(o.seen.map((s) => new URL(s.url).pathname)).toEqual(['/api/tags', '/api/chat', '/api/chat']);
  });

  it('a cloud tag: unavailable, and not even the listing is asked', async () => {
    for (const name of ['gpt-oss:120b-cloud', 'glm-4.6:cloud']) await refused({ url: URL_, model: name }, () => tags([{ name }]), 0);
  });

  it('a plain name Ollama lists with a remote host: unavailable', async () => {
    await refused({ url: URL_, model: 'mine' }, () => tags([ALIAS, ...HERE]), 1);
    await refused({ url: URL_, model: 'mine:latest' }, () => tags([{ name: 'mine:latest', remote_model: 'gpt-oss:120b' }]), 1);
  });

  it('a listing that hangs: unavailable, soon', async () => {
    const started = Date.now();
    await refused({ url: URL_, model: MODEL }, hangs, 1);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('a listing that fails, or does not hold the model: unavailable', async () => {
    await refused({ url: URL_, model: MODEL }, () => new Response('', { status: 500 }), 1);
    await refused({ url: URL_, model: MODEL }, () => { throw new TypeError('fetch failed'); }, 1);
    await refused({ url: URL_, model: MODEL }, () => new Response('not a listing', { status: 200 }), 1);
    await refused({ url: URL_, model: MODEL }, () => tags([{ name: 'llama3.1:latest' }]), 1);
  });

  it('an Ollama that is not this machine: unavailable, and nothing at all is sent there', async () => {
    for (const url of ['http://10.0.0.5:11434', 'https://ollama.com', 'http://127.0.0.1.example.com:11434']) await refused({ url, model: MODEL }, () => tags(HERE), 0);
  });

  it('nothing is believed on a caller’s say-so: a model nobody has listed is not here', async () => {
    // No listing was ever heard and Ollama does not answer.
    await refused({ url: URL_, model: MODEL }, () => new Response(null, { status: 599 }), 1);
  });
});
