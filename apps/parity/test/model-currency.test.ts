import { describe, expect, it } from 'vitest';
import { claudeAlwaysThinks, claudeContestant, THINKING_MIN_MAX_TOKENS } from '../src/contestants.js';
import {
  assessModel,
  checkModels,
  describeCheck,
  listVendorModels,
  newerInFamily,
  parseModelId,
  refusal,
  usable,
  type Listing,
} from '../src/model-currency.js';
import { panelistMaxTokens } from '../src/panel.js';
import { isPriced, priceOf, UNLISTED } from '../src/pricing.js';

const TODAY = new Date('2026-09-25T12:00:00Z');

/** A model list as the vendors return it (OpenAI and Gemini's OpenAI-compatible endpoint). */
const OPENAI_LIST = ['gpt-5', 'gpt-5-2025-08-07', 'gpt-5-mini', 'gpt-5.1', 'gpt-5.1-codex', 'gpt-5.2', 'gpt-5.2-pro', 'gpt-4o', 'o3', 'text-embedding-3-large'];
const GOOGLE_LIST = ['models/gemini-2.5-pro', 'models/gemini-2.5-flash', 'models/gemini-3-pro-preview', 'models/gemini-3-flash-preview'];
const ANTHROPIC_LIST = ['claude-fable-5-1', 'claude-fable-5', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-sonnet-4-5-20250929', 'claude-haiku-4-5'];

describe('model ids', () => {
  it('split into family, version and variant, ignoring dates and preview tags', () => {
    expect(parseModelId('gpt-5.1')).toEqual({ family: 'gpt', version: [5, 1], variant: '' });
    expect(parseModelId('gpt-5-2025-08-07')).toEqual({ family: 'gpt', version: [5], variant: '' });
    expect(parseModelId('gpt-5-mini')).toEqual({ family: 'gpt', version: [5], variant: 'mini' });
    expect(parseModelId('gpt-4o')).toEqual({ family: 'gpt', version: [4], variant: 'o' });
    expect(parseModelId('o3')).toEqual({ family: 'o', version: [3], variant: '' });
    expect(parseModelId('models/gemini-2.5-pro')).toEqual({ family: 'gemini', version: [2, 5], variant: 'pro' });
    expect(parseModelId('gemini-3-pro-preview')).toEqual({ family: 'gemini', version: [3], variant: 'pro' });
    expect(parseModelId('claude-fable-5-1')).toEqual({ family: 'claude-fable', version: [5, 1], variant: '' });
    expect(parseModelId('claude-sonnet-4-5-20250929')).toEqual({ family: 'claude-sonnet', version: [4, 5], variant: '' });
    expect(parseModelId('sonar-pro')).toBeUndefined();
  });

  it('find newer versions of the same model only (not a mini, a pro or another family)', () => {
    expect(newerInFamily('gpt-5', OPENAI_LIST)).toEqual(['gpt-5.2', 'gpt-5.1']);
    expect(newerInFamily('gpt-5.2', OPENAI_LIST)).toEqual([]);
    expect(newerInFamily('gpt-5-mini', OPENAI_LIST)).toEqual([]);
    expect(newerInFamily('gemini-2.5-pro', GOOGLE_LIST)).toEqual(['gemini-3-pro-preview']);
    expect(newerInFamily('claude-fable-5-1', ANTHROPIC_LIST)).toEqual([]);
    expect(newerInFamily('claude-fable-5-1', [...ANTHROPIC_LIST, 'claude-fable-5-2'])).toEqual(['claude-fable-5-2']);
    expect(newerInFamily('claude-opus-5', ANTHROPIC_LIST)).toEqual(['claude-opus-5-5']);
  });
});

describe('is it the vendor’s current top model?', () => {
  const check = (vendor: 'openai' | 'google' | 'anthropic' | 'amazon' | 'perplexity', model: string, source: 'default' | 'flag', listing?: Listing) =>
    assessModel({ role: vendor === 'anthropic' ? 'claude' : vendor, vendor, model, source, listing, today: TODAY });

  it('refuses a default with a newer model in its family, and says which flag to pass', () => {
    const c = check('openai', 'gpt-5', 'default', { ids: OPENAI_LIST });
    expect(c).toMatchObject({ status: 'newer-available', newer: ['gpt-5.2', 'gpt-5.1'], checkedOn: '2026-09-25' });
    expect(usable(c)).toBe(false);
    expect(refusal(c)).toMatch(/^openai: the default gpt-5 isn't OpenAI's newest: its model list has gpt-5\.2, gpt-5\.1\. Pass --openai-model <id>/);
    const g = check('google', 'gemini-2.5-pro', 'default', { ids: GOOGLE_LIST });
    expect(refusal(g)).toMatch(/gemini-3-pro-preview.*--google-model/);
    // The default judge panel is the competitor models: the competitor flag fixes it.
    const judge = assessModel({ role: 'judge:openai', vendor: 'openai', model: 'gpt-5', source: 'default', listing: { ids: OPENAI_LIST }, today: TODAY });
    expect(refusal(judge)).toMatch(/^judge:openai: the default gpt-5 .* Pass --openai-model <id> .*, or --judge-panel\.$/);
  });

  it('uses a current default, and an explicit model as given (noting anything newer)', () => {
    const c = check('anthropic', 'claude-fable-5-1', 'default', { ids: ANTHROPIC_LIST });
    expect(c.status).toBe('current');
    expect(refusal(c)).toBeUndefined();
    expect(describeCheck(c)).toBe("verified current on 2026-09-25 (newest of its family on Anthropic's model list; default)");
    const explicit = check('openai', 'gpt-5', 'flag', { ids: OPENAI_LIST });
    expect(usable(explicit)).toBe(true);
    expect(describeCheck(explicit)).toMatch(/\*\*not the newest\*\*: OpenAI's list had gpt-5\.2, gpt-5\.1/);
  });

  it('refuses a default it cannot verify: no list, an id the vendor does not list, or Amazon', () => {
    expect(refusal(check('openai', 'gpt-5', 'default', { error: 'model list answered HTTP 401' }))).toMatch(/can't be verified.*HTTP 401/);
    expect(check('openai', 'gpt-9', 'default', { ids: OPENAI_LIST }).status).toBe('not-listed');
    const nova = check('amazon', 'us.amazon.nova-premier-v1:0', 'default');
    expect(nova.status).toBe('unverified');
    expect(refusal(nova)).toMatch(/--amazon-model/);
    // Named explicitly, it runs (and the report says it is unverified).
    expect(usable(check('amazon', 'us.amazon.nova-2-pro-v1:0', 'flag'))).toBe(true);
    // Perplexity's versionless aliases are kept current by Perplexity.
    expect(check('perplexity', 'sonar-pro', 'default')).toMatchObject({ status: 'alias' });
    expect(refusal(check('perplexity', 'sonar-pro', 'default'))).toBeUndefined();
  });

  it('reads each vendor list once, and not for Amazon or Perplexity', async () => {
    const asked: string[] = [];
    const checks = await checkModels(
      [
        { role: 'openai', vendor: 'openai', model: 'gpt-5.2', source: 'flag' },
        { role: 'judge:openai', vendor: 'openai', model: 'gpt-5.2', source: 'flag' },
        { role: 'amazon', vendor: 'amazon', model: 'us.amazon.nova-2-pro-v1:0', source: 'flag' },
        { role: 'perplexity', vendor: 'perplexity', model: 'sonar-pro', source: 'default' },
      ],
      async (v) => {
        asked.push(v);
        return { ids: OPENAI_LIST };
      },
      TODAY,
    );
    expect(asked).toEqual(['openai']);
    expect(checks.map((c) => c.status)).toEqual(['current', 'current', 'unverified', 'alias']);
  });
});

describe('the vendor model lists (free calls)', () => {
  const stub = (body: unknown, seen: Array<{ url: string; init?: RequestInit }>) =>
    (async (url: unknown, init?: RequestInit) => {
      seen.push({ url: String(url), ...(init ? { init } : {}) });
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;

  it("reads OpenAI's and Gemini's with the key as a bearer token", async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    expect(await listVendorModels('openai', { OPENAI_API_KEY: 'k1' }, stub({ data: OPENAI_LIST.map((id) => ({ id })) }, seen))).toEqual({ ids: OPENAI_LIST });
    expect(seen[0]!.url).toBe('https://api.openai.com/v1/models');
    expect((seen[0]!.init!.headers as Record<string, string>).authorization).toBe('Bearer k1');
    expect(await listVendorModels('google', { GEMINI_API_KEY: 'k2' }, stub({ data: GOOGLE_LIST.map((id) => ({ id })) }, seen))).toEqual({ ids: GOOGLE_LIST });
    expect(seen[1]!.url).toBe('https://generativelanguage.googleapis.com/v1beta/openai/models');
  });

  it("reads Anthropic's through the SDK", async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const body = { data: ANTHROPIC_LIST.map((id) => ({ id, type: 'model', display_name: id, created_at: '2026-01-01T00:00:00Z' })), has_more: false, first_id: ANTHROPIC_LIST[0], last_id: ANTHROPIC_LIST.at(-1) };
    expect(await listVendorModels('anthropic', { ANTHROPIC_API_KEY: 'k3' }, stub(body, seen))).toEqual({ ids: ANTHROPIC_LIST });
    expect(seen[0]!.url).toMatch(/^https:\/\/api\.anthropic\.com\/v1\/models\?limit=1000/);
  });

  it('says why when there is no list', async () => {
    expect(await listVendorModels('openai', {})).toEqual({ error: 'no OPENAI_API_KEY' });
    expect(await listVendorModels('amazon', { AWS_BEARER_TOKEN_BEDROCK: 'k' })).toMatchObject({ error: expect.stringContaining('no model list') });
    const failing = (async () => new Response('{}', { status: 500 })) as unknown as typeof fetch;
    expect(await listVendorModels('openai', { OPENAI_API_KEY: 'k' }, failing)).toEqual({ error: 'model list answered HTTP 500' });
  });
});

describe('prices and caps for the newer models', () => {
  it("never prices a newer version at an older one's rate (it is UNLISTED until listed)", () => {
    // gpt-5.2 is listed now (packages/core/src/pricing.ts); gpt-5.3 is not.
    expect(priceOf('gpt-5.3')).toBe(UNLISTED);
    expect(isPriced('gpt-5.3')).toBe(false);
    expect(priceOf('gpt-5.2')).not.toEqual(priceOf('gpt-5'));
    expect(priceOf('gpt-5-2025-08-07')).toEqual(priceOf('gpt-5'));
    expect(priceOf('gpt-5-mini')).not.toEqual(priceOf('gpt-5'));
    expect(priceOf('gemini-3-pro-preview')).toBe(UNLISTED);
    expect(priceOf('claude-fable-5-1')).toMatchObject({ input: 10, output: 50 });
    expect(isPriced('claude-fable-5-1')).toBe(true);
  });

  it('gives always-thinking Claude models room to think before answering, as competitor and judge', () => {
    expect(claudeAlwaysThinks('claude-fable-5-1')).toBe(true);
    expect(claudeAlwaysThinks('claude-opus-5-5')).toBe(true);
    expect(claudeAlwaysThinks('claude-sonnet-5')).toBe(false);
    expect(panelistMaxTokens({ vendor: 'anthropic', model: 'claude-fable-5-1', id: 'anthropic:claude-fable-5-1' }, 4096)).toBe(16_384);
    expect(panelistMaxTokens({ vendor: 'anthropic', model: 'claude-sonnet-5', id: 'anthropic:claude-sonnet-5' }, 4096)).toBe(4096);
    expect(THINKING_MIN_MAX_TOKENS).toBe(16_384);
    // The contestant name can be the baseline's.
    expect(claudeContestant('k', 'claude-opus-5-5', 's', 8192, 'claude-base')).toMatchObject({ name: 'claude-base', model: 'claude-opus-5-5' });
  });
});
