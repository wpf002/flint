import { describe, expect, it } from 'vitest';
import { FlintError } from '@flint/core';
import {
  BedrockConverseProvider,
  DEFAULT_AMAZON_MODEL,
  DEFAULT_GOOGLE_MODEL,
  GOOGLE_OPENAI_BASE_URL,
  addVendorContestants,
  amazonConfig,
  bedrockOpenAiEndpoint,
  checkCompatModel,
  compatContestant,
  googleEndpoint,
  parseCompatSpec,
  privacyVendorOf,
  providerForVendor,
} from '../src/compat.js';
import { panelistMaxTokens, parseJudgePanel } from '../src/panel.js';
import { costOf, priceOf, UNLISTED } from '../src/pricing.js';

interface Seen {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
}

/** A fetch that records requests and answers from `route`. */
function stubFetch(route: (url: string, body: Record<string, unknown> | undefined) => Response): typeof fetch & { seen: Seen[] } {
  const seen: Seen[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    seen.push({ url, headers: (init?.headers ?? {}) as Record<string, string>, body });
    return route(url, body);
  }) as unknown as typeof fetch & { seen: Seen[] };
  f.seen = seen;
  return f;
}

const chatReply = (text: string) =>
  new Response(JSON.stringify({ id: 'c1', choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 1000, completion_tokens: 200 } }), { status: 200 });

describe('Google (Gemini, OpenAI-compatible endpoint)', () => {
  it('defaults to the documented endpoint and key, with the model overridable (verify before use)', () => {
    expect(googleEndpoint({})).toMatchObject({ name: 'google', vendor: 'google', baseURL: GOOGLE_OPENAI_BASE_URL, keyEnv: 'GEMINI_API_KEY', model: DEFAULT_GOOGLE_MODEL, maxTokensField: 'max_tokens' });
    expect(googleEndpoint({ PARITY_GOOGLE_MODEL: 'gemini-next-pro' }).model).toBe('gemini-next-pro');
    expect(googleEndpoint({ PARITY_GOOGLE_MODEL: 'gemini-next-pro' }, 'gemini-flag').model).toBe('gemini-flag');
  });

  it('answers through chat completions: bearer key, no tools, a thinking-sized cap, priced as Gemini', async () => {
    const f = stubFetch(() => chatReply('Gemini says hi'));
    const c = compatContestant(googleEndpoint({}), 'g-key', 'You are a helpful assistant for Will.', 8192, f);
    const res = await c.answer({ id: 'p1', prompt: 'hello' }, new AbortController().signal);
    expect(f.seen[0]!.url).toBe('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
    expect(f.seen[0]!.headers.authorization).toBe('Bearer g-key');
    expect(f.seen[0]!.body).toMatchObject({ model: DEFAULT_GOOGLE_MODEL, max_tokens: 16_384 });
    expect(f.seen[0]!.body).not.toHaveProperty('tools');
    expect(f.seen[0]!.body!.messages).toEqual([
      { role: 'system', content: 'You are a helpful assistant for Will.' },
      { role: 'user', content: 'hello' },
    ]);
    expect(res.text).toBe('Gemini says hi');
    expect(res.costUsd).toBeCloseTo(costOf('google', DEFAULT_GOOGLE_MODEL, { input: 1000, output: 200 }));
    expect(priceOf(DEFAULT_GOOGLE_MODEL)).not.toBe(UNLISTED);
  });

  it("checks the model against the endpoint's list (free) before buying anything", async () => {
    const list = (ids: string[]) => stubFetch(() => new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: 200 }));
    expect(await checkCompatModel(googleEndpoint({}), 'k', list([`models/${DEFAULT_GOOGLE_MODEL}`, 'models/gemini-2.5-flash']))).toEqual({ status: 'ok' });
    expect(await checkCompatModel(googleEndpoint({}), 'k', list(['models/gemini-9-pro']))).toEqual({ status: 'missing', available: ['gemini-9-pro'] });
    const down = stubFetch(() => new Response('nope', { status: 500 }));
    expect(await checkCompatModel(googleEndpoint({}), 'k', down)).toMatchObject({ status: 'unknown' });
  });
});

describe('Amazon (Bedrock)', () => {
  it('reads the model, region and API from env, and refuses a bad region', () => {
    expect(amazonConfig({})).toEqual({ model: DEFAULT_AMAZON_MODEL, region: 'us-east-1', api: 'converse' });
    expect(amazonConfig({ AWS_REGION: 'us-west-2', PARITY_AMAZON_API: 'openai', PARITY_AMAZON_MODEL: 'm' })).toEqual({ model: 'm', region: 'us-west-2', api: 'openai' });
    expect(() => amazonConfig({ AWS_REGION: 'evil.com/x' })).toThrow(/region/);
    expect(() => amazonConfig({ PARITY_AMAZON_API: 'soap' })).toThrow(/converse or openai/);
    expect(bedrockOpenAiEndpoint(amazonConfig({ AWS_REGION: 'us-west-2' })).baseURL).toBe('https://bedrock-runtime.us-west-2.amazonaws.com/openai/v1');
  });

  it('calls Converse with the Bedrock API key as a bearer token, and reads text, usage and stop reason', async () => {
    const f = stubFetch(() =>
      new Response(
        JSON.stringify({ output: { message: { role: 'assistant', content: [{ text: 'Nova ' }, { text: 'here' }] } }, stopReason: 'max_tokens', usage: { inputTokens: 900, outputTokens: 120, totalTokens: 1020 } }),
        { status: 200 },
      ),
    );
    const p = new BedrockConverseProvider({ apiKey: 'b-key', region: 'us-east-1', fetch: f });
    const res = await p.generate({ model: 'us.amazon.nova-premier-v1:0', system: 'sys', messages: [{ id: 'u', role: 'user', content: 'hi', timestamp: 0 }], maxTokens: 777 });
    expect(f.seen[0]!.url).toBe('https://bedrock-runtime.us-east-1.amazonaws.com/model/us.amazon.nova-premier-v1%3A0/converse');
    expect(f.seen[0]!.headers.authorization).toBe('Bearer b-key');
    expect(f.seen[0]!.body).toEqual({ system: [{ text: 'sys' }], messages: [{ role: 'user', content: [{ text: 'hi' }] }], inferenceConfig: { maxTokens: 777 } });
    expect(res).toMatchObject({ message: { role: 'assistant', content: 'Nova here' }, usage: { input: 900, output: 120 }, reason: 'max_tokens' });
    expect(priceOf('us.amazon.nova-premier-v1:0')).toEqual(priceOf('amazon.nova-premier-v1:0'));
    expect(priceOf('amazon.nova-premier-v1:0')).not.toBe(UNLISTED);
  });

  it('turns an HTTP error into a FlintError naming the status and message', async () => {
    const f = stubFetch(() => new Response(JSON.stringify({ message: 'The provided model identifier is invalid.' }), { status: 400 }));
    const p = new BedrockConverseProvider({ apiKey: 'k', region: 'us-east-1', fetch: f });
    const err = await p.generate({ model: 'nope', messages: [{ id: 'u', role: 'user', content: 'hi', timestamp: 0 }] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FlintError);
    expect((err as FlintError).message).toBe('amazon HTTP 400: The provided model identifier is invalid.');
  });
});

describe('vendor contestants', () => {
  it('skips google and amazon with a note when their keys are missing, never silently', async () => {
    const notes: string[] = [];
    const out = await addVendorContestants({ wanted: new Set(['google', 'amazon']), env: {}, system: 's', maxTokens: 8192, compatSpecs: [], notes, log: () => {}, verifyModels: true });
    expect(out).toEqual([]);
    expect(notes).toEqual(['google skipped: no GEMINI_API_KEY in env or ~/.flint/secrets.env.', 'amazon skipped: no AWS_BEARER_TOKEN_BEDROCK in env or ~/.flint/secrets.env.']);
  });

  it("adds them with keys, notes the model to verify, and skips google when its model isn't served", async () => {
    const env = { GEMINI_API_KEY: 'g', AWS_BEARER_TOKEN_BEDROCK: 'b' };
    const served = stubFetch(() => new Response(JSON.stringify({ data: [{ id: `models/${DEFAULT_GOOGLE_MODEL}` }] }), { status: 200 }));
    const notes: string[] = [];
    const out = await addVendorContestants({ wanted: new Set(['google', 'amazon']), env, system: 's', maxTokens: 8192, compatSpecs: [], notes, log: () => {}, verifyModels: true, fetchFn: served });
    expect(out.map((c) => [c.name, c.model])).toEqual([
      ['google', DEFAULT_GOOGLE_MODEL],
      ['amazon', DEFAULT_AMAZON_MODEL],
    ]);
    expect(notes.join('\n')).toMatch(/verify before use/);
    const retired = stubFetch(() => new Response(JSON.stringify({ data: [{ id: 'models/gemini-9-pro' }, { id: 'models/embedding-001' }] }), { status: 200 }));
    const notes2: string[] = [];
    const out2 = await addVendorContestants({ wanted: new Set(['google']), env, system: 's', maxTokens: 8192, compatSpecs: [], notes: notes2, log: () => {}, verifyModels: true, fetchFn: retired });
    expect(out2).toEqual([]);
    expect(notes2[0]).toMatch(/^google skipped: .* doesn't serve model "gemini-2.5-pro" \(it lists gemini-9-pro\)/);
  });

  it('only adds google and amazon when named in --contestants', async () => {
    const out = await addVendorContestants({ wanted: new Set(['flint', 'openai']), env: { GEMINI_API_KEY: 'g', AWS_BEARER_TOKEN_BEDROCK: 'b' }, system: 's', maxTokens: 8192, compatSpecs: [], notes: [], log: () => {}, verifyModels: false });
    expect(out).toEqual([]);
  });

  it('adds any OpenAI-compatible endpoint by spec, keyed by an env var name', async () => {
    const spec = parseCompatSpec('name=mistral,url=https://api.mistral.ai/v1,key=MISTRAL_API_KEY,model=mistral-large-latest,field=max_tokens,min-tokens=4096');
    expect(spec).toEqual({ name: 'mistral', vendor: 'compat', baseURL: 'https://api.mistral.ai/v1', keyEnv: 'MISTRAL_API_KEY', model: 'mistral-large-latest', maxTokensField: 'max_tokens', minMaxTokens: 4096 });
    const notes: string[] = [];
    const out = await addVendorContestants({ wanted: new Set(), env: {}, system: 's', maxTokens: 8192, compatSpecs: ['name=mistral,url=https://api.mistral.ai/v1,key=MISTRAL_API_KEY,model=m'], notes, log: () => {}, verifyModels: false });
    expect(out).toEqual([]);
    expect(notes[0]).toBe('mistral skipped: no MISTRAL_API_KEY in env or ~/.flint/secrets.env.');
    // Plain http only to this machine (a local proxy).
    expect(parseCompatSpec('name=proxy,url=http://127.0.0.1:4000/v1,key=PROXY_KEY,model=m').baseURL).toBe('http://127.0.0.1:4000/v1');
    for (const bad of [
      'name=openai,url=https://x,key=K,model=m',
      'name=x1,url=http://x,key=K,model=m',
      'name=x1,url=http://10.0.0.5/v1,key=K,model=m',
      'name=x1,url=https://x,key=sk-live-123,model=m',
      'name=x1,url=https://x,key=K',
      'name=x1,url=https://x,key=K,model=m,temperature=0',
    ]) {
      expect(() => parseCompatSpec(bad), bad).toThrow();
    }
  });

  it('names the privacy vendor of each contestant', () => {
    expect(privacyVendorOf('claude')).toBe('anthropic');
    expect(privacyVendorOf('openai')).toBe('openai');
    expect(privacyVendorOf('google')).toBe('google');
    expect(privacyVendorOf('mistral')).toBe('mistral');
  });
});

describe('Google and Amazon on the judge panel', () => {
  it('are accepted panel vendors, Gemini with a thinking-sized cap', () => {
    const panel = parseJudgePanel('anthropic:claude-opus-5-5,google:gemini-2.5-pro,amazon:us.amazon.nova-premier-v1:0');
    expect(panel.map((p) => p.vendor)).toEqual(['amazon', 'anthropic', 'google']);
    expect(panelistMaxTokens(panel.find((p) => p.vendor === 'google')!, 4096)).toBe(16_384);
    expect(panelistMaxTokens(panel.find((p) => p.vendor === 'amazon')!, 4096)).toBe(4096);
    expect(() => parseJudgePanel('perplexity:sonar,openai:gpt-5')).toThrow(/isn't supported/);
  });

  it('get their provider from the vendor key, and fail naming the missing variable', () => {
    expect(providerForVendor('google', { GEMINI_API_KEY: 'g' }).name).toBe('google');
    expect(providerForVendor('amazon', { AWS_BEARER_TOKEN_BEDROCK: 'b' }).name).toBe('amazon');
    expect(() => providerForVendor('amazon', {})).toThrow(/AWS_BEARER_TOKEN_BEDROCK/);
    expect(() => providerForVendor('google', {})).toThrow(/GEMINI_API_KEY/);
  });
});
