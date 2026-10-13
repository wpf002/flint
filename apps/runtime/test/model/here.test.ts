/**
 * "A model on this Mac", for every local request the runtime makes (model/here):
 * the name is not a cloud model's, the address is this machine, and Ollama's
 * own listing holds the model and says nothing of a remote host or model.
 *
 * The runtime asks before every request to the model, and goes only on a word
 * from an ask that began within the last two seconds. The rule is the shared
 * one (@flint/policy ModelPlaces): a word is as old as when its ask began; an
 * ask that yields no word drops what was believed to run here; a listing that
 * fails at once is asked once more inside the same ask, one that hangs is not;
 * a silent Ollama is not asked again for two seconds.
 *
 * First the record itself, then the one reader of Ollama's lists, then the
 * static check that nothing reaches a model without asking, then each caller:
 * triage's judge, a goal review's plan stage and a prediction's second
 * opinion. For each, a cloud tag, a plain name that Ollama lists with a remote
 * host, a listing that hangs or fails, and an Ollama that is not this machine
 * all end "unavailable" with no model request sent; and the listing is asked
 * again immediately before EVERY request, so a slot held for seconds, or a
 * second attempt, never goes out on an old word.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { LISTING_MAX_CHARS, LISTING_WORD_MS, LocalModels } from '../../src/model/here';
import { modelSlot } from '../../src/model/slot';
import { judge } from '../../src/triage/judge';
import { planDiff, type PlanFacts } from '../../src/goals/planner';
import { estimate } from '../../src/predict/reason';
import { SYNTHETIC_FACTS } from '../predict/reason-facts';
import { facts as eventFacts } from '../triage/helpers';
import { hangs, listening, tags, type Listened } from '../ollama-kit';

const URL_ = 'http://127.0.0.1:11434';
const MODEL = 'muse-glimmer:30b';
const HERE = [{ name: MODEL, model: MODEL, size: 1 }, { name: 'llama3.1:latest' }];
const REMOTE = [{ name: MODEL, model: MODEL, remote_host: 'https://ollama.com:443', remote_model: 'gpt-oss:120b' }];
/** A cloud model under a plain name, as `ollama cp gpt-oss:120b-cloud mine` leaves it. */
const ALIAS = { name: 'mine:latest', model: 'mine:latest', remote_host: 'https://ollama.com:443', remote_model: 'gpt-oss:120b' };
const GET = { method: 'GET', url: `${URL_}/api/tags` };
const paths = (o: Listened) => o.seen.map((s) => new URL(s.url).pathname);
const ticks = async (n = 20) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

afterEach(() => vi.restoreAllMocks());

describe('what the runtime knows of the models on this Mac', () => {
  it('a model Ollama lists with no remote host is here; it is asked again for every request, unless its word is from the last two seconds', async () => {
    let now = 1_000_000;
    const models = new LocalModels({ now: () => now });
    const o = listening(() => tags(HERE));
    expect(await models.runsHere({ url: URL_, model: MODEL }, o.fetch)).toBe(true);
    // Requests that come together share the one answer.
    expect(await models.runsHere({ url: URL_, model: 'Llama3.1' }, o.fetch)).toBe(true);
    expect(await models.runsHere({ url: `${URL_}/`, model: MODEL }, o.fetch)).toBe(true);
    expect(o.seen).toEqual([GET]);
    now += LISTING_WORD_MS;
    expect(await models.runsHere({ url: URL_, model: MODEL }, o.fetch)).toBe(true);
    expect(o.seen).toHaveLength(1);
    // Two seconds on, it is asked again: and again for the request after that.
    now += 1;
    expect(await models.runsHere({ url: URL_, model: MODEL }, o.fetch)).toBe(true);
    expect(o.seen).toHaveLength(2);
    now += 60_000;
    expect(await models.runsHere({ url: URL_, model: MODEL }, o.fetch)).toBe(true);
    expect(o.seen).toHaveLength(3);
    expect(LISTING_WORD_MS).toBe(2_000);
  });

  it('a word is as old as when its ask BEGAN: a listing that was slow to arrive is not handed on for two more seconds', async () => {
    let now = 0;
    const models = new LocalModels({ now: () => now });
    // The listing takes 1.5 s to arrive.
    const o = listening(async () => { now += 1_500; return tags(HERE); });
    expect(await models.runsHere({ url: URL_, model: MODEL }, o.fetch)).toBe(true);
    expect(o.seen).toHaveLength(1);
    // Half a second after it landed it is two seconds old, not half a second: it is asked for again.
    now += 501;
    expect(await models.runsHere({ url: URL_, model: MODEL }, o.fetch)).toBe(true);
    expect(o.seen).toHaveLength(2);
    // And a word still inside its two seconds (from its start) is not: 1.5 s to arrive, 0.4 s since.
    now += 400;
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
    for (const url of ['http://10.0.0.5:11434', 'http://192.168.1.20:11434', 'https://ollama.com', 'http://127.0.0.1.example.com:11434', 'http://studio.local:11434', 'http://ollama.localhost:11434', 'http://0.0.0.0:11434', 'not a url', '']) {
      expect(await models.runsHere({ url, model: MODEL }, o.fetch), url).toBe(false);
    }
    expect(o.seen).toEqual([]);
    // Nor does a listing heard from one make it this machine.
    models.learn('http://10.0.0.5:11434', HERE);
    expect(await models.runsHere({ url: 'http://10.0.0.5:11434', model: MODEL }, o.fetch)).toBe(false);
    expect(o.seen).toEqual([]);
  });

  it('an address Node’s env proxy would carry is not this machine, whatever its host says', async () => {
    const models = new LocalModels();
    const o = listening(() => tags(HERE));
    expect(await models.runsHere({ url: URL_, model: MODEL, proxied: true }, o.fetch)).toBe(false);
    expect(o.seen).toEqual([]);
    // Even with a listing already believed.
    models.learn(URL_, HERE);
    expect(await models.runsHere({ url: URL_, model: MODEL, proxied: true }, o.fetch)).toBe(false);
    expect(await models.runsHere({ url: URL_, model: MODEL }, o.fetch)).toBe(true);
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

  it('nothing is local until Ollama has said so: a listing that fails at once is asked once more, and then it is silence; one that is no listing is an answer', async () => {
    // These say nothing either way, at once. The same ask tries once more (one bad answer does not cost the work
    // its model); two bad answers are silence. A silent Ollama is not asked again for two seconds.
    const silent: Array<[string, () => Response | Promise<Response>]> = [
      ['a 500', () => new Response('{"error":"x"}', { status: 500 })],
      // (Whatever a failed listing's body holds: it is not read.)
      ['a 500 that carries a listing', () => new Response(JSON.stringify({ models: HERE }), { status: 500 })],
      ['a 503 that carries a listing', () => new Response(JSON.stringify({ models: HERE }), { status: 503 })],
      ['a 401', () => new Response('', { status: 401 })],
      ['a redirect', () => new Response(null, { status: 302, headers: { location: 'https://ollama.com/api/tags' } })],
      ['a redirect that carries a listing', () => new Response(JSON.stringify({ models: HERE }), { status: 307, headers: { location: `${URL_}/elsewhere` } })],
      ['refused', () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); }],
    ];
    for (const [what, listing] of silent) {
      let now = 0;
      const models = new LocalModels({ now: () => now });
      const o = listening(listing);
      expect(await models.runsHere({ url: URL_, model: MODEL }, o.fetch), what).toBe(false);
      expect(o.seen, what).toEqual([GET, GET]);
      // Asked again a moment later: not asked, and as silent as it was.
      now += 500;
      expect(await models.runsHere({ url: URL_, model: MODEL }, o.fetch), what).toBe(false);
      expect(o.seen, what).toHaveLength(2);
      // Two seconds after the silence was found, it is asked again.
      now += LISTING_WORD_MS;
      expect(await models.runsHere({ url: URL_, model: MODEL }, o.fetch), what).toBe(false);
      expect(o.seen, what).toHaveLength(4);
    }
    // One bad answer, then a good one inside the same ask: its word is taken.
    let n = 0;
    const flaky = listening(() => (n++ === 0 ? new Response('', { status: 500 }) : tags(HERE)));
    expect(await new LocalModels().runsHere({ url: URL_, model: MODEL }, flaky.fetch)).toBe(true);
    expect(flaky.seen).toEqual([GET, GET]);
    // These are an answer: it is no Ollama, or an Ollama without the model. One request, and its word stands for its two seconds.
    const answered: Array<[string, () => Response | Promise<Response>]> = [
      ['a 404', () => new Response('not found', { status: 404 })],
      ['no JSON', () => new Response('<html>hello</html>', { status: 200 })],
      ['JSON that is no listing', () => new Response('{"models":"all of them"}', { status: 200 })],
      ['null', () => new Response('null', { status: 200 })],
      ['an Ollama with no models', () => new Response('{"models":null}', { status: 200 })],
      ['an empty listing', () => tags([])],
    ];
    for (const [what, listing] of answered) {
      const models = new LocalModels({ now: () => 0 });
      const o = listening(listing);
      expect(await models.runsHere({ url: URL_, model: MODEL }, o.fetch), what).toBe(false);
      expect(await models.runsHere({ url: URL_, model: MODEL }, o.fetch), what).toBe(false);
      expect(o.seen, what).toEqual([GET]);
    }
  });

  it('a silent listing is not a yes: what Ollama said a moment ago is not believed once it stops answering', async () => {
    let now = 0;
    let up = true;
    const models = new LocalModels({ now: () => now });
    const o = listening(() => (up ? tags(HERE) : new Response('', { status: 503 })));
    expect(await models.runsHere({ url: URL_, model: MODEL }, o.fetch)).toBe(true);
    // It stops answering. The next request asks, hears nothing (twice), and does not fall back on what it heard before.
    up = false;
    now = LISTING_WORD_MS + 1;
    expect(await models.runsHere({ url: URL_, model: MODEL }, o.fetch)).toBe(false);
    expect(o.seen).toHaveLength(3);
    now += 30_000;
    expect(await models.runsHere({ url: URL_, model: MODEL }, o.fetch)).toBe(false);
    expect(o.seen).toHaveLength(5);
    // It answers again: here again, on its own fresh word, at the next ask (two seconds after the last silence).
    up = true;
    now += LISTING_WORD_MS + 1;
    expect(await models.runsHere({ url: URL_, model: MODEL }, o.fetch)).toBe(true);
    expect(o.seen).toHaveLength(6);
    // The same for a listing that hangs, or is refused, after one that answered.
    for (const quietly of [hangs, () => { throw new TypeError('fetch failed'); }]) {
      let t = 0;
      let quiet = false;
      const m = new LocalModels({ now: () => t, timeoutMs: 30 });
      const l = listening(() => (quiet ? quietly() : tags(HERE)));
      expect(await m.runsHere({ url: URL_, model: MODEL }, l.fetch)).toBe(true);
      quiet = true;
      t = LISTING_WORD_MS + 1;
      expect(await m.runsHere({ url: URL_, model: MODEL }, l.fetch)).toBe(false);
    }
  });

  it('silence keeps what was said to run elsewhere: it never turns that into a yes, nor into "not listed"', async () => {
    let now = 0;
    let up = true;
    const models = new LocalModels({ now: () => now });
    const o = listening(() => (up ? tags([ALIAS, ...HERE]) : new Response('', { status: 500 })));
    expect(await models.runsHere({ url: URL_, model: 'mine' }, o.fetch)).toBe(false);
    up = false;
    now = LISTING_WORD_MS + 1;
    expect(await models.runsHere({ url: URL_, model: MODEL }, o.fetch)).toBe(false);
    expect(await models.runsHere({ url: URL_, model: 'mine' }, o.fetch)).toBe(false);
  });

  it('a model that is repointed at Ollama’s servers stops being here at the very next ask', async () => {
    let now = 0;
    let rows: unknown[] = HERE;
    const models = new LocalModels({ now: () => now });
    const o = listening(() => tags(rows));
    expect(await models.runsHere({ url: URL_, model: MODEL }, o.fetch)).toBe(true);
    rows = REMOTE;
    now = LISTING_WORD_MS + 1;
    expect(await models.runsHere({ url: URL_, model: MODEL }, o.fetch)).toBe(false);
    // "Runs elsewhere" is Ollama's own word too: it stands, and is asked about again like any other.
    now += LISTING_WORD_MS + 1;
    expect(await models.runsHere({ url: URL_, model: MODEL }, o.fetch)).toBe(false);
    rows = HERE;
    now += LISTING_WORD_MS + 1;
    expect(await models.runsHere({ url: URL_, model: MODEL }, o.fetch)).toBe(true);
    // An answer that is no listing after one that was: nothing is believed to run there any more.
    now += LISTING_WORD_MS + 1;
    const other = listening(() => new Response('not found', { status: 404 }));
    expect(await models.runsHere({ url: URL_, model: MODEL }, other.fetch)).toBe(false);
  });

  it('a listing that hangs is given up: not here, in about the time it is allowed, and it is asked once', async () => {
    const models = new LocalModels({ timeoutMs: 40 });
    const o = listening(hangs);
    const started = Date.now();
    expect(await models.runsHere({ url: URL_, model: MODEL }, o.fetch)).toBe(false);
    expect(Date.now() - started).toBeLessThan(2_000);
    // Whoever waited for it has waited as long as an ask may take: it is not tried a second time.
    expect(o.seen).toEqual([GET]);
    // A transport that honours the signal is told to stop.
    let aborted = false;
    const polite = (async (_u: string, init?: RequestInit) => new Promise<Response>((_, reject) => init!.signal!.addEventListener('abort', () => { aborted = true; reject(new DOMException('timed out', 'TimeoutError')); }))) as unknown as typeof fetch;
    expect(await new LocalModels({ timeoutMs: 40 }).runsHere({ url: URL_, model: MODEL }, polite)).toBe(false);
    expect(aborted).toBe(true);
    // A listing that arrives after it was given up is not taken.
    let late!: (r: Response) => void;
    let now = 0;
    const slow = new LocalModels({ timeoutMs: 20, now: () => now });
    const s = listening(() => new Promise<Response>((r) => (late = r)));
    expect(await slow.runsHere({ url: URL_, model: MODEL }, s.fetch)).toBe(false);
    late(tags(HERE));
    await ticks();
    now += LISTING_WORD_MS + 1;
    const none = listening(() => new Response('', { status: 500 }));
    expect(await slow.runsHere({ url: URL_, model: MODEL }, none.fetch)).toBe(false);
  });

  it('a listing longer than 4 MB is not read as one', async () => {
    const huge = (chars: number) => () => new Response(JSON.stringify({ models: HERE, pad: 'x'.repeat(chars) }), { status: 200 });
    // Just under the limit it is a listing like any other.
    const under = listening(huge(LISTING_MAX_CHARS - 2_000));
    expect(await new LocalModels().runsHere({ url: URL_, model: MODEL }, under.fetch)).toBe(true);
    // Over it, nothing is taken from it: the model is not here, and Health's reader gets no list.
    const over = listening(huge(LISTING_MAX_CHARS + 1));
    const models = new LocalModels();
    expect(await models.runsHere({ url: URL_, model: MODEL }, over.fetch)).toBe(false);
    expect(await new LocalModels().list({ url: URL_ }, '/api/tags', over.fetch)).toBeUndefined();
    expect(await new LocalModels().list({ url: URL_ }, '/api/ps', listening(() => tags(HERE), (async () => huge(LISTING_MAX_CHARS + 1)()) as unknown as typeof fetch).fetch)).toBeUndefined();
    expect(LISTING_MAX_CHARS).toBe(4_000_000);
  });

  it('requests that ask together share one request', async () => {
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

  it('the word’s age is counted on a clock that does not follow the Mac’s: setting the wall clock back does not make an old word young', async () => {
    // The helper's own clock (none given): the monotonic one. The wall clock is set back a minute after a yes.
    let mono = 50_000;
    vi.spyOn(performance, 'now').mockImplementation(() => mono);
    let wall = 1_800_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => wall);
    let rows: unknown[] = HERE;
    const models = new LocalModels();
    const o = listening(() => tags(rows));
    expect(await models.runsHere({ url: URL_, model: MODEL }, o.fetch)).toBe(true);
    rows = REMOTE;
    wall -= 60_000;
    // Two real seconds later the listing is asked again, whatever the wall clock says: the model is not here.
    mono += LISTING_WORD_MS + 1;
    expect(await models.runsHere({ url: URL_, model: MODEL }, o.fetch)).toBe(false);
    expect(o.seen).toHaveLength(2);
    // It never reads the wall clock at all.
    const code = readFileSync(join(__dirname, '..', '..', 'src', 'model', 'here.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/Date\.now|new Date\(/);
    expect(code).toContain('performance.now()');
  });

  it('a clock that is given and goes backwards: everything heard is forgotten, never believed for longer', async () => {
    let now = 100_000;
    let rows: unknown[] = HERE;
    const models = new LocalModels({ now: () => now });
    const o = listening(() => tags(rows));
    expect(await models.runsHere({ url: URL_, model: MODEL }, o.fetch)).toBe(true);
    rows = REMOTE;
    // Set back a minute. With an age that cannot be told, the listing is asked for again at once.
    now -= 60_000;
    const seen: boolean[] = [];
    for (let sec = 0; sec <= 64; sec += 4) {
      now = 40_000 + sec * 1000;
      seen.push(await models.runsHere({ url: URL_, model: MODEL }, o.fetch));
    }
    expect(seen.every((here) => here === false)).toBe(true);
    expect(o.seen.length).toBeGreaterThan(2);
  });
});

describe('the one reader of Ollama’s lists', () => {
  const both = (installed: unknown[], loaded: unknown[]) => listening(() => tags(installed), (async () => tags(loaded)) as unknown as typeof fetch);

  it('gives each list as Ollama gave it, and what the listing said is what a local request that comes with it goes by', async () => {
    const models = new LocalModels({ now: () => 0 });
    const o = both([ALIAS, ...HERE], [{ name: MODEL }]);
    expect(await models.list({ url: URL_ }, '/api/tags', o.fetch)).toEqual([ALIAS, ...HERE]);
    expect(await models.list({ url: URL_ }, '/api/ps', o.fetch)).toEqual([{ name: MODEL }]);
    expect(o.seen).toEqual([GET, { method: 'GET', url: `${URL_}/api/ps` }]);
    // A local request that comes with it asks nothing more: the listing a health run just heard is the same word.
    expect(await models.runsHere({ url: URL_, model: MODEL }, o.fetch)).toBe(true);
    expect(await models.runsHere({ url: URL_, model: 'mine' }, o.fetch)).toBe(false);
    expect(o.seen).toHaveLength(2);
    // Asked for again, it is asked now, whatever was heard before.
    await models.list({ url: URL_ }, '/api/tags', o.fetch);
    expect(o.seen).toHaveLength(3);
  });

  it('a look that hears nothing is a silence like any other: what was believed to run here is dropped', async () => {
    let now = 0;
    let up = true;
    const models = new LocalModels({ now: () => now });
    const o = listening(() => (up ? tags(HERE) : new Response('', { status: 500 })));
    expect(await models.runsHere({ url: URL_, model: MODEL }, o.fetch)).toBe(true);
    // A health run looks a second later and the listing fails: its look is one request, and it is silence.
    up = false;
    now = 1_000;
    expect(await models.list({ url: URL_ }, '/api/tags', o.fetch)).toBeUndefined();
    expect(o.seen).toHaveLength(2);
    // A request right after does not go on the word from a second ago, and does not ask a silent Ollama again yet.
    expect(await models.runsHere({ url: URL_, model: MODEL }, o.fetch)).toBe(false);
    expect(o.seen).toHaveLength(2);
  });

  it('what is loaded says nothing of where a model runs: only the listing is taken into the record', async () => {
    const models = new LocalModels();
    const o = both([], [{ name: MODEL }]);
    expect(await models.list({ url: URL_ }, '/api/ps', o.fetch)).toEqual([{ name: MODEL }]);
    const sent = o.seen.length;
    expect(await models.runsHere({ url: URL_, model: MODEL }, o.fetch)).toBe(false);
    // It had to ask for the listing itself.
    expect(o.seen.slice(sent)).toEqual([GET]);
  });

  it('an address that is not this machine, or one a proxy would carry, is asked nothing', async () => {
    const models = new LocalModels();
    const o = both(HERE, HERE);
    for (const url of ['http://10.0.0.5:11434', 'https://ollama.com', 'http://127.0.0.1.example.com:11434', 'not a url']) {
      expect(await models.list({ url }, '/api/tags', o.fetch), url).toBeUndefined();
      expect(await models.list({ url }, '/api/ps', o.fetch), url).toBeUndefined();
    }
    expect(await models.list({ url: URL_, proxied: true }, '/api/tags', o.fetch)).toBeUndefined();
    expect(await models.list({ url: URL_, proxied: true }, '/api/ps', o.fetch)).toBeUndefined();
    expect(o.seen).toEqual([]);
  });

  it('an answer that is no list, a failure and a hang are all no list', async () => {
    for (const bad of [() => new Response('', { status: 503 }), () => new Response('<html>'), () => new Response('{"models":"many"}'), () => new Response('', { status: 404 }), () => { throw new Error('ECONNREFUSED'); }, hangs]) {
      const models = new LocalModels({ timeoutMs: 30 });
      expect(await models.list({ url: URL_ }, '/api/tags', listening(bad).fetch)).toBeUndefined();
      expect(await models.list({ url: URL_ }, '/api/ps', listening(() => tags(HERE), (async () => bad()) as unknown as typeof fetch).fetch)).toBeUndefined();
    }
    expect(await new LocalModels().list({ url: URL_ }, '/api/tags', listening(() => new Response('{"models":null}')).fetch)).toEqual([]);
  });
});

// ── nothing reaches a model without asking first (static) ────────────────────

/** Every file in the runtime that asks a local model. A new one is added here, and to the callers below. */
const LOCAL_CALLERS = ['goals/planner.ts', 'predict/reason.ts', 'triage/judge.ts'];
const HERE_FILE = 'model/here.ts';
/** Code only: a comment may name what the code must never do. */
const bare = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/**
 * Every way a file under src/ could send text to a model without asking where it runs, read off the source. Each
 * problem is a sentence that names its file. `sources`: path under src/ to source text.
 */
function reachProblems(sources: ReadonlyMap<string, string>, callers: readonly string[] = LOCAL_CALLERS): string[] {
  const problems: string[] = [];
  const count = (c: string, re: RegExp) => (c.match(re) ?? []).length;
  for (const [file, raw] of sources) {
    const c = bare(raw);
    const listed = callers.includes(file);
    const say = (what: string) => void problems.push(`${file}: ${what}`);
    // The model providers live in @flint/core. Only a listed caller imports anything from it, and then exactly
    // OllamaProvider, by its own name: an alias, a namespace or a require is another way in.
    const fromCore = count(c, /['"]@flint\/core(\/[^'"]*)?['"]/g);
    if (!listed && fromCore > 0) say('it imports @flint/core, where the model providers are');
    if (listed && (fromCore !== 1 || !c.includes("import { OllamaProvider } from '@flint/core/ollama';"))) say('its one import from @flint/core is OllamaProvider, by its own name');
    // An import decided at run time could be anything: only a module of the runtime's own, named in full.
    if (/\bimport\s*\(\s*(?!['"]\.{1,2}\/[^'"]*['"]\s*\))/.test(c) || /\brequire\s*\(/.test(c)) say('it imports by a name worked out at run time');
    // A provider is built once in each listed caller, and nowhere else.
    const built = count(c, /\bnew\s+[A-Za-z_$][\w$]*Provider\s*\(/g);
    if (!listed && built > 0) say('it builds a model provider');
    if (listed && (built !== 1 || count(c, /\bnew OllamaProvider\(\{ baseURL: origin, fetch: gated,/g) !== 1)) say('it builds exactly one provider, and hands it the gated fetch');
    // Ollama's chat endpoint by its path: a listed caller only. Any other model endpoint: nowhere.
    if (!listed && /\/api\/chat\b/.test(c)) say('it names Ollama’s chat endpoint');
    if (/\/api\/(generate|embed|embeddings)\b|\/v1\/(chat\/completions|completions|embeddings)\b/.test(c)) say('it names a model endpoint no local request uses');
    // Ollama's lists are fetched in one file. Health names the two paths when it asks the reader for them, and nothing more.
    if (/\/api\/(tags|ps)\b/.test(c) && file !== HERE_FILE && file !== 'health/machine.ts') say('it names one of Ollama’s lists');
    if (file !== HERE_FILE && /pathPrefix: [^,]*\/api\/(tags|ps)/.test(c)) say('it fetches one of Ollama’s lists itself');
    if (!listed) continue;
    // A listed caller asks where its model runs: once before anything is built to send with, and again
    // immediately before every request, after the slot, the load check and the claim.
    if (count(c, /const here = \(\): Promise<boolean> => \(d\.models \?\? LOCAL_MODELS\)\.runsHere\(d\.ollama, d\.fetch \?\? fetch\);/g) !== 1) say('it asks model/here through one `here`');
    if (count(c, /\.runsHere\(/g) !== 1) say('it asks model/here in one place');
    if (count(c, /await here\(\)/g) !== 2) say('it asks twice: before anything is built, and before every request');
    const first = c.indexOf('await here()');
    if (first < 0 || first > c.indexOf('scopedFetch(') || first > c.indexOf('new OllamaProvider(')) say('it asks before it builds anything to send with');
    if (count(c, /scopedFetch\(/g) !== 1 || !c.includes("scopedFetch([{ origin, pathPrefix: '/api/chat', methods: ['POST'] }], d.fetch ?? fetch, d.timeoutMs ?? 90_000)")) say('its one way out is a POST to /api/chat');
    if (count(c, /await post\(/g) !== 1) say('it sends in one place');
    if (/\bfetch\s*\(/.test(c)) say('it calls fetch itself');
    // The last look is the statement before the request: nothing awaited comes between them.
    if (!/if \(!\(await here\(\)\)\) \{\s*stopped = 'unavailable';\s*throw new Stop\('[^']*'\);\s*\}\s*requests \+= 1;\s*(made \+= 1;\s*)?const res = await post\(String\(url\), init\);/.test(c)) say('the listing is asked immediately before every request');
    // And that request is inside the slot, after the load check and the claim.
    const slot = c.indexOf('modelSlot(async () => {');
    const order = [slot, c.indexOf('await d.load()', slot), c.indexOf('await d.claim()', slot), c.indexOf('await here()', slot), c.indexOf('await post(', slot)];
    if (slot < 0 || order.some((x, i) => x < 0 || (i > 0 && x < order[i - 1]!))) say('before each request: the slot, the load check, the claim, the listing, then the request');
  }
  return problems;
}

describe('nothing in the runtime reaches a model without asking where it runs', () => {
  const src = join(__dirname, '..', '..', 'src');
  const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []));
  const real = (): Map<string, string> => new Map(files(src).map((f) => [f.slice(src.length + 1), readFileSync(f, 'utf8')]));

  it('every file under src/ passes: three callers, each asking first and again before every request; one reader of Ollama’s lists', () => {
    const sources = real();
    expect(sources.size).toBeGreaterThan(100);
    expect(reachProblems(sources)).toEqual([]);
    // The callers are exactly the files that build a provider or name the chat endpoint.
    const askers = [...sources].filter(([, s]) => /new OllamaProvider\(|\/api\/chat/.test(bare(s))).map(([f]) => f).sort();
    expect(askers).toEqual(LOCAL_CALLERS);
    expect(bare(sources.get(HERE_FILE)!)).toContain("scopedFetch([{ origin, pathPrefix: path, methods: ['GET'] }]");
  });

  it('the check itself catches each way round it: a new file, an alias, another endpoint, a second provider, a check taken out', () => {
    const base = real();
    const withFile = (file: string, source: string) => new Map([...base, [file, source]]);
    const changed = (file: string, from: string | RegExp, to: string) => {
      const was = base.get(file)!;
      const now = was.replace(from, to);
      expect(now, `${file}: the change applies`).not.toBe(was);
      return new Map([...base, [file, now]]);
    };
    const caught = (sources: Map<string, string>, file: string, what: RegExp) => {
      const problems = reachProblems(sources).filter((p) => p.startsWith(`${file}: `));
      expect(problems.join('\n'), file).toMatch(what);
    };
    // A new file asks Ollama through an aliased provider, with no check.
    caught(withFile('zzsneak/one.ts', "import { OllamaProvider as P } from '@flint/core/ollama';\nexport const ask = (url: string, model: string, text: string) => new P({ baseURL: url }).generate({ model, messages: [{ id: 'x', role: 'user', content: text, timestamp: 0 }] });\n"), 'zzsneak/one.ts', /imports @flint\/core/);
    // ...or through the whole package, or a require, or an import worked out at run time.
    caught(withFile('zzsneak/ns.ts', "import * as core from '@flint/core';\nexport const ask = (url: string) => new core.OllamaProvider({ baseURL: url });\n"), 'zzsneak/ns.ts', /imports @flint\/core/);
    caught(withFile('zzsneak/req.ts', "const { OllamaProvider: P } = require('@flint/core/ollama');\nexport const ask = (url: string) => new P({ baseURL: url });\n"), 'zzsneak/req.ts', /imports @flint\/core[\s\S]*run time/);
    caught(withFile('zzsneak/dyn.ts', "export const ask = async (name: string, url: string) => new (await import(name)).OllamaProvider({ baseURL: url });\n"), 'zzsneak/dyn.ts', /run time/);
    // A new file POSTs a prompt to Ollama's /api/generate through the scoped fetch.
    caught(withFile('zzsneak/two.ts', "import { scopedFetch } from '../policy/egress.js';\nexport const ask = (origin: string, model: string, prompt: string) => scopedFetch([{ origin, pathPrefix: '/api/generate', methods: ['POST'] }])(`${origin}/api/generate`, { method: 'POST', body: JSON.stringify({ model, prompt }) });\n"), 'zzsneak/two.ts', /model endpoint no local request uses/);
    // A new file calls an OpenAI-compatible /v1/chat/completions with plain fetch.
    caught(withFile('zzsneak/three.ts', "export const ask = (origin: string, model: string, text: string) => fetch(`${origin}/v1/chat/completions`, { method: 'POST', body: JSON.stringify({ model, messages: [{ role: 'user', content: text }] }) });\n"), 'zzsneak/three.ts', /model endpoint no local request uses/);
    // A new file embeds text at Ollama's /api/embed.
    caught(withFile('zzsneak/four.ts', "import { scopedFetch } from '../policy/egress.js';\nexport const embed = (origin: string, model: string, input: string) => scopedFetch([{ origin, pathPrefix: '/api/embed', methods: ['POST'] }])(`${origin}/api/embed`, { method: 'POST', body: JSON.stringify({ model, input }) });\n"), 'zzsneak/four.ts', /model endpoint no local request uses/);
    // A new file posts to /api/chat itself.
    caught(withFile('zzsneak/five.ts', "export const ask = (origin: string, body: string) => fetch(`${origin}/api/chat`, { method: 'POST', body });\n"), 'zzsneak/five.ts', /names Ollama’s chat endpoint/);
    // Inside a listed caller: a second, unchecked provider; the last look taken out; the last look moved before the claim.
    for (const file of LOCAL_CALLERS) {
      caught(changed(file, 'class Stop extends Error {}', 'class Stop extends Error {}\nexport const quick = (url: string, model: string) => new OllamaProvider({ baseURL: url }).generate({ model, messages: [] });'), file, /exactly one provider/);
      caught(changed(file, /      if \(!\(await here\(\)\)\) \{\s*stopped = 'unavailable';\s*throw new Stop\('[^']*'\);\s*\}\n/, ''), file, /asks twice[\s\S]*immediately before every request/);
      caught(changed(file, /if \(!\(await here\(\)\)\) (return|\{\n    return)/, 'if (false) $1'), file, /asks twice|before it builds/);
      caught(changed(file, "import { OllamaProvider } from '@flint/core/ollama';", "import { OllamaProvider as Provider } from '@flint/core/ollama';"), file, /by its own name/);
      caught(changed(file, 'const res = await post(String(url), init);', 'await d.load();\n      const res = await post(String(url), init);'), file, /immediately before every request/);
    }
    // Health fetching the listing itself, as it did before there was one reader.
    caught(changed('health/machine.ts', "const installed = await rows('/api/tags');", "const installed = await rows('/api/tags');\n  void scopedFetch([{ origin: 'x', pathPrefix: '/api/tags', methods: ['GET'] }]);"), 'health/machine.ts', /fetches one of Ollama’s lists itself/);
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
type Caller = (ollama: { url: string; model: string; proxied?: boolean }, o: Listened, models: LocalModels, n: Counts) => Promise<Called>;

const gates = (n: Counts) => ({ load: async () => (n.loads++, 'proceed' as const), claim: async () => (n.claims++, true) });

/** Each caller, a reply it takes, and a reply it does not (so it asks a second time). */
const CALLERS: Array<[string, Caller, unknown, unknown]> = [
  [
    'triage’s judge',
    (ollama, o, models, n) => judge(eventFacts({ created: true }, { name: 'Synthetic issue', state: { number: 7, state: 'open' } }), { ollama, ...gates(n), fetch: o.fetch, models }),
    { relevance: 0.2, reasonCode: 'fyi', reasoning: 'r' },
    { nope: 1 },
  ],
  [
    'a goal review’s plan stage',
    (ollama, o, models, n) => planDiff(PLAN, { ollama, ...gates(n), resolve: () => [], fetch: o.fetch, models }),
    { reasonCode: 'on_track', ops: [] },
    { nope: 1 },
  ],
  [
    'a prediction’s second opinion',
    (ollama, o, models, n) => estimate(SYNTHETIC_FACTS, { ollama, ...gates(n), fetch: o.fetch, models }),
    { probability: 0.6, reasonCode: 'weekday_pattern' },
    { probability: 0.99, reasonCode: 'trend' },
  ],
];

describe.each(CALLERS)('%s asks only a model on this Mac', (_name, call, good, bad) => {
  const model = (o: { n: number }) => (async () => (o.n++, chatReply(good))) as unknown as typeof fetch;
  const refused = async (ollama: { url: string; model: string; proxied?: boolean }, listing: () => Response | Promise<Response>, listings: number, models = new LocalModels({ timeoutMs: 40 })) => {
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

  it('a model Ollama says is here is asked, on a look at the listing from the last two seconds', async () => {
    const sent = { n: 0 };
    const o = listening(() => tags(HERE), model(sent));
    const n = { claims: 0, loads: 0 };
    let now = 0;
    const models = new LocalModels({ now: () => now });
    expect(await call({ url: URL_, model: MODEL }, o, models, n)).toMatchObject({ ok: true, requests: 1 });
    // The look before the call is the same word at the request: one listing, then the request.
    expect(o.seen.map((s) => `${s.method} ${new URL(s.url).pathname}`)).toEqual(['GET /api/tags', 'POST /api/chat']);
    expect(n).toEqual({ claims: 1, loads: 1 });
    // A call that comes within two seconds shares that answer; the next one asks again.
    expect(await call({ url: URL_, model: MODEL }, o, models, n)).toMatchObject({ ok: true, requests: 1 });
    now = LISTING_WORD_MS + 1;
    expect(await call({ url: URL_, model: MODEL }, o, models, n)).toMatchObject({ ok: true, requests: 1 });
    expect(paths(o)).toEqual(['/api/tags', '/api/chat', '/api/chat', '/api/tags', '/api/chat']);
  });

  it('a model that was here and is now listed with a remote host is not asked at the next call', async () => {
    let rows: unknown[] = HERE;
    let now = 0;
    const models = new LocalModels({ now: () => now });
    const sent = { n: 0 };
    const o = listening(() => tags(rows), model(sent));
    const n = { claims: 0, loads: 0 };
    expect(await call({ url: URL_, model: MODEL }, o, models, n)).toMatchObject({ ok: true });
    rows = REMOTE;
    now = LISTING_WORD_MS + 1;
    expect(await call({ url: URL_, model: MODEL }, o, models, n)).toMatchObject({ ok: false, why: 'unavailable' });
    expect(sent.n).toBe(1);
    expect(n).toEqual({ claims: 1, loads: 1 });
  });

  it('the slot was another caller’s for seconds while the model was repointed: the listing is asked again at the last moment, and nothing is sent', async () => {
    let rows: unknown[] = HERE;
    let now = 0;
    const models = new LocalModels({ now: () => now });
    const sent = { n: 0 };
    const o = listening(() => tags(rows), model(sent));
    const n = { claims: 0, loads: 0 };
    // Another local request holds the model slot.
    let release!: () => void;
    const held = modelSlot(() => new Promise<void>((r) => (release = r)));
    const waiting = call({ url: URL_, model: MODEL }, o, models, n);
    await ticks();
    // It looked before it queued: the listing said here.
    expect(paths(o)).toEqual(['/api/tags']);
    // While it waits, the name is pointed at a cloud model, and 3.2 seconds pass.
    rows = REMOTE;
    now = 3_200;
    release();
    await held;
    expect(await waiting).toMatchObject({ ok: false, why: 'unavailable', requests: 0 });
    // Asked again when its turn came, after the load check and the claim, and that was all: no request to the model.
    expect(paths(o)).toEqual(['/api/tags', '/api/tags']);
    expect(sent.n).toBe(0);
    expect(n).toEqual({ claims: 1, loads: 1 });
  });

  it('the bound is two seconds from when the listing was asked: a slot held for less sends on that word, one held for more asks again', async () => {
    for (const [heldMs, listings] of [[LISTING_WORD_MS, 1], [LISTING_WORD_MS + 1, 2]] as const) {
      let now = 0;
      const models = new LocalModels({ now: () => now });
      const sent = { n: 0 };
      const o = listening(() => tags(HERE), model(sent));
      let release!: () => void;
      const held = modelSlot(() => new Promise<void>((r) => (release = r)));
      const waiting = call({ url: URL_, model: MODEL }, o, models, { claims: 0, loads: 0 });
      await ticks();
      now = heldMs;
      release();
      await held;
      expect(await waiting, String(heldMs)).toMatchObject({ ok: true, requests: 1 });
      expect(paths(o).filter((p) => p === '/api/tags'), String(heldMs)).toHaveLength(listings);
      expect(sent.n).toBe(1);
    }
  });

  it('a second attempt is asked about again: after an unusable first reply the listing says elsewhere, and the second request is not sent', async () => {
    let rows: unknown[] = HERE;
    let now = 0;
    const models = new LocalModels({ now: () => now });
    let sent = 0;
    // The first reply is one this caller cannot use. While it was written (2.6 s), the name was pointed at a cloud model.
    const o = listening(() => tags(rows), (async () => {
      sent += 1;
      rows = REMOTE;
      now += 2_600;
      return chatReply(bad);
    }) as unknown as typeof fetch);
    const n = { claims: 0, loads: 0 };
    expect(await call({ url: URL_, model: MODEL }, o, models, n)).toMatchObject({ ok: false, why: 'unavailable', requests: 1 });
    expect(sent).toBe(1);
    // One listing before the first request, one before the second that was never sent.
    expect(paths(o)).toEqual(['/api/tags', '/api/chat', '/api/tags']);
  });

  it('a second attempt inside two seconds of the listing goes on that word, and one after it does not: with the model still here, both are sent', async () => {
    for (const [replyMs, listings] of [[500, 1], [2_600, 2]] as const) {
      let now = 0;
      const models = new LocalModels({ now: () => now });
      let sent = 0;
      const o = listening(() => tags(HERE), (async () => {
        sent += 1;
        now += replyMs;
        return chatReply(sent === 1 ? bad : good);
      }) as unknown as typeof fetch);
      expect(await call({ url: URL_, model: MODEL }, o, models, { claims: 0, loads: 0 }), String(replyMs)).toMatchObject({ ok: true, requests: 2 });
      expect(sent).toBe(2);
      expect(paths(o).filter((p) => p === '/api/tags'), String(replyMs)).toHaveLength(listings);
    }
  });

  it('a cloud tag: unavailable, and not even the listing is asked', async () => {
    for (const name of ['gpt-oss:120b-cloud', 'glm-4.6:cloud']) await refused({ url: URL_, model: name }, () => tags([{ name }]), 0);
  });

  it('a plain name Ollama lists with a remote host: unavailable', async () => {
    await refused({ url: URL_, model: 'mine' }, () => tags([ALIAS, ...HERE]), 1);
    await refused({ url: URL_, model: 'mine:latest' }, () => tags([{ name: 'mine:latest', remote_model: 'gpt-oss:120b' }]), 1);
  });

  it('a listing that hangs: unavailable, soon, after one try', async () => {
    const started = Date.now();
    await refused({ url: URL_, model: MODEL }, hangs, 1);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('a listing that fails at once (tried twice), or does not hold the model: unavailable', async () => {
    await refused({ url: URL_, model: MODEL }, () => new Response('', { status: 500 }), 2);
    await refused({ url: URL_, model: MODEL }, () => new Response(JSON.stringify({ models: HERE }), { status: 500 }), 2);
    await refused({ url: URL_, model: MODEL }, () => { throw new TypeError('fetch failed'); }, 2);
    await refused({ url: URL_, model: MODEL }, () => new Response('not a listing', { status: 200 }), 1);
    await refused({ url: URL_, model: MODEL }, () => new Response('', { status: 404 }), 1);
    await refused({ url: URL_, model: MODEL }, () => tags([{ name: 'llama3.1:latest' }]), 1);
  });

  it('an Ollama that is not this machine: unavailable, and nothing at all is sent there', async () => {
    for (const url of ['http://10.0.0.5:11434', 'https://ollama.com', 'http://127.0.0.1.example.com:11434']) await refused({ url, model: MODEL }, () => tags(HERE), 0);
  });

  it('an address Node’s env proxy would carry: unavailable, and nothing at all is sent', async () => {
    await refused({ url: URL_, model: MODEL, proxied: true }, () => tags(HERE), 0);
  });

  it('nothing is believed on a caller’s say-so: a model nobody has listed is not here', async () => {
    // No listing was ever heard and Ollama does not answer.
    await refused({ url: URL_, model: MODEL }, () => new Response(null, { status: 599 }), 2);
  });
});
