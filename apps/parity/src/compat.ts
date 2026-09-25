/**
 * More frontier vendors: Google (Gemini) and Amazon (Nova), plus any other
 * OpenAI-compatible endpoint, as contestants and as judge-panel members.
 *
 * - Google: Gemini's OpenAI-compatible chat-completions endpoint, through
 *   @flint/core's OpenAiCompatibleProvider (the same wire as OpenAI and
 *   Perplexity). Key: GEMINI_API_KEY.
 * - Amazon: Bedrock with a Bedrock API key (AWS_BEARER_TOKEN_BEDROCK) sent as a
 *   bearer token, in AWS_REGION (default us-east-1). By default through the
 *   Converse API, which serves every Nova model. Bedrock also has an
 *   OpenAI-compatible endpoint (PARITY_AMAZON_API=openai), but which models it
 *   serves has changed over time, so it is opt-in.
 * - `--openai-compatible name=...,url=...,key=...,model=...`: any other
 *   OpenAI-compatible endpoint (a new lab, a proxy), under its own name.
 *
 * DEFAULT MODEL IDS ARE "VERIFY BEFORE USE". They were real ids when this was
 * written and vendors retire and supersede models; the comparison is only
 * frontier-grade if the id is the vendor's current top model. Override with
 * PARITY_GOOGLE_MODEL / PARITY_AMAZON_MODEL (or --google-model / --amazon-model).
 * For Google the run checks the id against the endpoint's model list first
 * (a free call) and skips Google with a note if it isn't there.
 *
 * A vendor with no key is skipped with a note in the report, never silently.
 */
import {
  AnthropicProvider,
  FlintError,
  OpenAiCompatibleProvider,
  OpenAiProvider,
  PerplexityProvider,
  makeAiError,
  type GenerateArgs,
  type GenerateResult,
  type Message,
  type ModelCapabilities,
  type ProviderAdapter,
  type StreamDoneReason,
  type StreamEvent,
  type TokenUsage,
} from '@flint/core';
import { providerContestant, type Contestant } from './contestants.js';
import type { Vendor } from './pricing.js';

/** Gemini's OpenAI-compatible base URL (chat completions at `<base>chat/completions`). */
export const GOOGLE_OPENAI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/';
/** VERIFY BEFORE USE: a real Gemini id when written; use Google's current top model. */
export const DEFAULT_GOOGLE_MODEL = 'gemini-2.5-pro';
/** VERIFY BEFORE USE: Nova Premier's US cross-region inference profile when written; use Amazon's current top Nova. */
export const DEFAULT_AMAZON_MODEL = 'us.amazon.nova-premier-v1:0';
export const DEFAULT_AMAZON_REGION = 'us-east-1';

/** Where each vendor's key comes from (env or ~/.flint/secrets.env). */
export const VENDOR_KEY_ENV = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  perplexity: 'PERPLEXITY_API_KEY',
  google: 'GEMINI_API_KEY',
  amazon: 'AWS_BEARER_TOKEN_BEDROCK',
} as const;
export type KnownVendor = keyof typeof VENDOR_KEY_ENV;

type Env = Record<string, string | undefined>;
const envOf = (env: Env, name: string): string | undefined => env[name]?.trim() || undefined;

/** An OpenAI-compatible chat-completions endpoint, as a contestant or judge. */
export interface CompatEndpoint {
  /** Contestant name, and the vendor name on the privacy allowlist. */
  name: string;
  /** Who bills the call (pricing.ts). */
  vendor: Vendor;
  baseURL: string;
  /** Env var holding the key. */
  keyEnv: string;
  model: string;
  /** Which field carries the output cap: the endpoints disagree. */
  maxTokensField: 'max_tokens' | 'max_completion_tokens';
  /** Reasoning models count thinking against the cap: never ask for less than this. */
  minMaxTokens?: number;
}

/** Google's Gemini endpoint. PARITY_GOOGLE_MODEL / PARITY_GOOGLE_BASE_URL override. */
export function googleEndpoint(env: Env = process.env, model?: string): CompatEndpoint {
  return {
    name: 'google',
    vendor: 'google',
    baseURL: envOf(env, 'PARITY_GOOGLE_BASE_URL') ?? GOOGLE_OPENAI_BASE_URL,
    keyEnv: VENDOR_KEY_ENV.google,
    model: model?.trim() || envOf(env, 'PARITY_GOOGLE_MODEL') || DEFAULT_GOOGLE_MODEL,
    maxTokensField: 'max_tokens',
    // Gemini 2.5+ thinks by default, and the thinking counts against max_tokens.
    minMaxTokens: 16_384,
  };
}

export type AmazonApi = 'converse' | 'openai';

export interface AmazonConfig {
  model: string;
  region: string;
  api: AmazonApi;
}

/** Amazon on Bedrock: PARITY_AMAZON_MODEL, AWS_REGION, PARITY_AMAZON_API=converse|openai. */
export function amazonConfig(env: Env = process.env, model?: string): AmazonConfig {
  const api = (envOf(env, 'PARITY_AMAZON_API') ?? 'converse').toLowerCase();
  if (api !== 'converse' && api !== 'openai') throw new Error(`PARITY_AMAZON_API must be converse or openai, not "${api}"`);
  const region = envOf(env, 'AWS_REGION') ?? envOf(env, 'AWS_DEFAULT_REGION') ?? DEFAULT_AMAZON_REGION;
  if (!/^[a-z]{2}(-gov)?-[a-z]+-\d$/.test(region)) throw new Error(`AWS_REGION "${region}" isn't an AWS region name`);
  return { model: model?.trim() || envOf(env, 'PARITY_AMAZON_MODEL') || DEFAULT_AMAZON_MODEL, region, api };
}

/** Bedrock's OpenAI-compatible endpoint for a region (PARITY_AMAZON_API=openai). */
export function bedrockOpenAiEndpoint(cfg: AmazonConfig): CompatEndpoint {
  return {
    name: 'amazon',
    vendor: 'amazon',
    baseURL: `https://bedrock-runtime.${cfg.region}.amazonaws.com/openai/v1`,
    keyEnv: VENDOR_KEY_ENV.amazon,
    model: cfg.model,
    maxTokensField: 'max_tokens',
  };
}

/** Names the harness already uses; a `--openai-compatible` endpoint can't take one. */
const RESERVED = new Set(['flint', 'flint-local', 'openai', 'claude', 'anthropic', 'perplexity', 'google', 'amazon', 'judge', 'panel']);
const NAME_RE = /^[a-z][a-z0-9-]{1,30}$/;
const ENV_RE = /^[A-Z_][A-Z0-9_]*$/;

/**
 * `--openai-compatible name=mistral,url=https://api.mistral.ai/v1,key=MISTRAL_API_KEY,model=mistral-large-latest`
 * (optional `field=max_tokens|max_completion_tokens`, `min-tokens=N`). The key is
 * the NAME of an env var, never the key itself. Priced as UNLISTED (pessimistic)
 * unless its model is in pricing.ts.
 */
export function parseCompatSpec(spec: string): CompatEndpoint {
  const kv = new Map<string, string>();
  for (const part of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    const i = part.indexOf('=');
    if (i <= 0) throw new Error(`--openai-compatible: "${part}" is not key=value`);
    kv.set(part.slice(0, i).trim().toLowerCase(), part.slice(i + 1).trim());
  }
  const name = kv.get('name') ?? '';
  if (!NAME_RE.test(name)) throw new Error(`--openai-compatible: name "${name}" must be 2-31 lowercase letters, digits or -`);
  if (RESERVED.has(name)) throw new Error(`--openai-compatible: "${name}" is a built-in contestant name; pick another`);
  const url = kv.get('url') ?? '';
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`--openai-compatible ${name}: url "${url}" is not a URL`);
  }
  // https, or plain http to this machine only (a local proxy such as LiteLLM).
  const loopback = parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !loopback) throw new Error(`--openai-compatible ${name}: url must be https (or http to localhost)`);
  const key = kv.get('key') ?? '';
  if (!ENV_RE.test(key)) throw new Error(`--openai-compatible ${name}: key must be the NAME of an env var (e.g. MISTRAL_API_KEY), not the key`);
  const model = kv.get('model') ?? '';
  if (!model) throw new Error(`--openai-compatible ${name}: model required`);
  const field = kv.get('field') ?? 'max_tokens';
  if (field !== 'max_tokens' && field !== 'max_completion_tokens') throw new Error(`--openai-compatible ${name}: field must be max_tokens or max_completion_tokens`);
  const minTokens = kv.has('min-tokens') ? Number(kv.get('min-tokens')) : undefined;
  if (minTokens !== undefined && !(Number.isInteger(minTokens) && minTokens > 0)) throw new Error(`--openai-compatible ${name}: min-tokens must be a positive integer`);
  const unknown = [...kv.keys()].filter((k) => !['name', 'url', 'key', 'model', 'field', 'min-tokens'].includes(k));
  if (unknown.length) throw new Error(`--openai-compatible ${name}: unknown field(s) ${unknown.join(', ')}`);
  return { name, vendor: 'compat', baseURL: url, keyEnv: key, model, maxTokensField: field, ...(minTokens ? { minMaxTokens: minTokens } : {}) };
}

/** Capabilities for an endpoint we only send text to. Honest: no tools, no files. */
const COMPAT_CAPS: ModelCapabilities = {
  toolCalling: 'unsupported',
  structuredOutput: 'prompted',
  streaming: 'text-only',
  maxContextTokens: 128_000,
  maxOutputTokens: 65_536,
};

export function compatProvider(e: CompatEndpoint, apiKey: string, fetchFn?: typeof fetch): ProviderAdapter {
  return new OpenAiCompatibleProvider({
    name: e.name,
    baseURL: e.baseURL,
    apiKey,
    maxTokensField: e.maxTokensField,
    supportsTools: false,
    capabilities: () => COMPAT_CAPS,
    defaultMaxTokens: 4096,
    ...(fetchFn ? { fetch: fetchFn } : {}),
  });
}

/** A contestant on an OpenAI-compatible endpoint. No tools, like every competitor. */
export function compatContestant(e: CompatEndpoint, apiKey: string, system: string, maxTokens: number, fetchFn?: typeof fetch): Contestant {
  return providerContestant({
    name: e.name,
    vendor: e.vendor,
    model: e.model,
    provider: compatProvider(e, apiKey, fetchFn),
    maxTokens: Math.max(maxTokens, e.minMaxTokens ?? 0),
    system,
  });
}

/** Amazon as a contestant: Converse (default) or Bedrock's OpenAI-compatible endpoint. */
export function amazonContestant(cfg: AmazonConfig, apiKey: string, system: string, maxTokens: number, fetchFn?: typeof fetch): Contestant {
  if (cfg.api === 'openai') return compatContestant(bedrockOpenAiEndpoint(cfg), apiKey, system, maxTokens, fetchFn);
  return providerContestant({
    name: 'amazon',
    vendor: 'amazon',
    model: cfg.model,
    provider: new BedrockConverseProvider({ apiKey, region: cfg.region, ...(fetchFn ? { fetch: fetchFn } : {}) }),
    maxTokens,
    system,
  });
}

/**
 * Is `model` served at this OpenAI-compatible endpoint? `GET <base>/models`, a
 * free call. `unknown` when the listing itself fails (not every endpoint has
 * one): the run goes ahead and a wrong id shows up as failed answers.
 */
export async function checkCompatModel(
  e: CompatEndpoint,
  apiKey: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ status: 'ok' } | { status: 'missing'; available: string[] } | { status: 'unknown'; why: string }> {
  try {
    const r = await fetchFn(`${e.baseURL.replace(/\/$/, '')}/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return { status: 'unknown', why: `model list answered HTTP ${r.status}` };
    const body = (await r.json()) as { data?: Array<{ id?: unknown }> };
    const ids = (body.data ?? []).map((m) => (typeof m.id === 'string' ? m.id.replace(/^models\//, '') : '')).filter(Boolean);
    if (ids.length === 0) return { status: 'unknown', why: 'model list was empty' };
    return ids.includes(e.model.replace(/^models\//, '')) ? { status: 'ok' } : { status: 'missing', available: ids };
  } catch (err) {
    return { status: 'unknown', why: err instanceof Error ? err.message : String(err) };
  }
}

// --------------------------------------------------------------------------
// Bedrock Converse

interface ConverseResponse {
  output?: { message?: { content?: Array<{ text?: string }> } };
  stopReason?: string;
  usage?: { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheWriteInputTokens?: number };
  message?: string;
}

/**
 * Amazon Bedrock's Converse API with a Bedrock API key (a bearer token), text
 * only: exactly what the eval needs, a system prompt and one user message.
 * `POST https://bedrock-runtime.<region>.amazonaws.com/model/<modelId>/converse`.
 */
export class BedrockConverseProvider implements ProviderAdapter {
  readonly name = 'amazon';
  private readonly baseURL: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: { apiKey: string; region: string; fetch?: typeof fetch; baseURL?: string }) {
    if (!opts.apiKey) throw new Error('amazon requires a Bedrock API key (AWS_BEARER_TOKEN_BEDROCK)');
    this.baseURL = (opts.baseURL ?? `https://bedrock-runtime.${opts.region}.amazonaws.com`).replace(/\/$/, '');
    this.fetchImpl = opts.fetch ?? fetch;
  }

  getCapabilities(): ModelCapabilities {
    return { ...COMPAT_CAPS, maxOutputTokens: 10_000 };
  }

  estimateTokens(messages: Message[]): number {
    return Math.ceil(messages.reduce((s, m) => s + m.content.length, 0) / 4);
  }

  /** The request body for `args` (exported shape for tests via generate's fetch). */
  static body(args: GenerateArgs): Record<string, unknown> {
    return {
      ...(args.system ? { system: [{ text: args.system }] } : {}),
      messages: args.messages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({ role: m.role, content: [{ text: m.content }] })),
      inferenceConfig: { maxTokens: args.maxTokens ?? 4096 },
    };
  }

  async generate(args: GenerateArgs): Promise<GenerateResult> {
    const url = `${this.baseURL}/model/${encodeURIComponent(args.model)}/converse`;
    let r: Response;
    try {
      r = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.opts.apiKey}` },
        body: JSON.stringify(BedrockConverseProvider.body(args)),
        ...(args.signal ? { signal: args.signal } : {}),
      });
    } catch (err) {
      throw new FlintError(makeAiError('provider_unavailable', `amazon: ${err instanceof Error ? err.message : String(err)}`));
    }
    const text = await r.text();
    let body: ConverseResponse = {};
    try {
      body = JSON.parse(text) as ConverseResponse;
    } catch {
      /* not JSON: an edge page, reported below */
    }
    if (!r.ok) {
      const kind = r.status === 429 ? 'rate_limit' : r.status >= 500 ? 'provider_unavailable' : 'validation';
      throw new FlintError(makeAiError(kind, `amazon HTTP ${r.status}: ${body.message ?? text.slice(0, 300)}`, { providerCode: String(r.status) }));
    }
    const out = (body.output?.message?.content ?? []).map((c) => c.text ?? '').join('');
    const u = body.usage ?? {};
    const usage: TokenUsage = {
      input: u.inputTokens ?? 0,
      output: u.outputTokens ?? 0,
      ...(u.cacheReadInputTokens ? { cacheRead: u.cacheReadInputTokens } : {}),
      ...(u.cacheWriteInputTokens ? { cacheWrite: u.cacheWriteInputTokens } : {}),
    };
    return {
      message: { id: `amazon-${Date.now()}`, role: 'assistant', content: out, timestamp: Date.now() },
      usage,
      reason: converseReason(body.stopReason),
    };
  }

  async *stream(args: GenerateArgs): AsyncIterable<StreamEvent> {
    try {
      const res = await this.generate(args);
      if (res.message.content) yield { type: 'text', delta: res.message.content };
      yield { type: 'done', reason: res.reason, usage: res.usage };
    } catch (err) {
      yield { type: 'error', error: err instanceof FlintError ? err.error : makeAiError('internal', String(err)) };
    }
  }
}

export function converseReason(stop: string | undefined): StreamDoneReason {
  switch (stop) {
    case 'max_tokens':
      return 'max_tokens';
    case 'guardrail_intervened':
    case 'content_filtered':
      return 'refusal';
    case 'tool_use':
      return 'tool_call';
    default:
      return 'complete';
  }
}

// --------------------------------------------------------------------------
// One factory for judges (and anything else that needs a vendor's provider)

/**
 * The provider a judge-panel member of `vendor` calls, with its key from `env`.
 * Throws naming the missing env var, so a panel fails before anything is bought.
 */
export function providerForVendor(vendor: KnownVendor, env: Env = process.env): ProviderAdapter {
  const key = envOf(env, VENDOR_KEY_ENV[vendor]);
  if (!key) throw new Error(`${vendor} needs ${VENDOR_KEY_ENV[vendor]} (env or ~/.flint/secrets.env)`);
  switch (vendor) {
    case 'anthropic':
      return new AnthropicProvider({ apiKey: key });
    case 'openai':
      return new OpenAiProvider({ apiKey: key });
    case 'perplexity':
      return new PerplexityProvider({ apiKey: key });
    case 'google':
      return compatProvider(googleEndpoint(env), key);
    case 'amazon': {
      const cfg = amazonConfig(env);
      return cfg.api === 'openai' ? compatProvider(bedrockOpenAiEndpoint(cfg), key) : new BedrockConverseProvider({ apiKey: key, region: cfg.region });
    }
  }
}

// --------------------------------------------------------------------------
// Contestants for `run` and `tasks`

/**
 * The google / amazon / --openai-compatible contestants a run asked for. `google`
 * and `amazon` join only when named in `--contestants`; an `--openai-compatible`
 * endpoint joins whenever the flag names it. A vendor without a key, or (Google,
 * an OpenAI-compatible endpoint) whose model the endpoint doesn't list, is
 * skipped with a note in the report: never silently.
 */
export async function addVendorContestants(opts: {
  wanted: ReadonlySet<string>;
  env: Env;
  system: string;
  maxTokens: number;
  googleModel?: string | undefined;
  amazonModel?: string | undefined;
  compatSpecs: readonly string[];
  notes: string[];
  log: (msg: string) => void;
  /** Check the model against the endpoint's list first (free). Off when nothing will be asked (--judge-only). */
  verifyModels: boolean;
  fetchFn?: typeof fetch;
}): Promise<Contestant[]> {
  const out: Contestant[] = [];
  const skip = (name: string, why: string): void => {
    opts.notes.push(`${name} skipped: ${why}`);
    opts.log(`${name}: skipped (${why})`);
  };
  const withEndpoint = async (e: CompatEndpoint, how: string): Promise<void> => {
    const key = envOf(opts.env, e.keyEnv);
    if (!key) return skip(e.name, `no ${e.keyEnv} in env or ~/.flint/secrets.env.`);
    if (opts.verifyModels) {
      const check = await checkCompatModel(e, key, opts.fetchFn);
      if (check.status === 'missing') {
        const family = (e.model.split(/[-.:]/)[0] ?? '').toLowerCase();
        const near = check.available.filter((id) => family && id.toLowerCase().startsWith(family)).slice(0, 15);
        return skip(e.name, `${e.baseURL} doesn't serve model "${e.model}" (it lists ${near.length ? near.join(', ') : `${check.available.length} other models`}). ${how}`);
      }
      if (check.status === 'unknown') opts.notes.push(`${e.name}: couldn't confirm that ${e.baseURL} serves "${e.model}" (${check.why}); a wrong id shows up as failed answers.`);
    }
    opts.notes.push(`${e.name} answered with \`${e.model}\` at ${e.baseURL}. Model id: verify before use (it should be the vendor's current top model).`);
    out.push(compatContestant(e, key, opts.system, opts.maxTokens, opts.fetchFn));
    opts.log(`${e.name}: ${e.model} at ${e.baseURL}`);
  };

  if (opts.wanted.has('google')) await withEndpoint(googleEndpoint(opts.env, opts.googleModel), 'Set PARITY_GOOGLE_MODEL or --google-model.');
  if (opts.wanted.has('amazon')) {
    const cfg = amazonConfig(opts.env, opts.amazonModel);
    if (cfg.api === 'openai') {
      await withEndpoint(bedrockOpenAiEndpoint(cfg), 'Set PARITY_AMAZON_MODEL or --amazon-model, or use PARITY_AMAZON_API=converse.');
    } else {
      const key = envOf(opts.env, VENDOR_KEY_ENV.amazon);
      if (!key) {
        skip('amazon', `no ${VENDOR_KEY_ENV.amazon} in env or ~/.flint/secrets.env.`);
      } else {
        out.push(amazonContestant(cfg, key, opts.system, opts.maxTokens, opts.fetchFn));
        opts.notes.push(
          `amazon answered with \`${cfg.model}\` on Bedrock (${cfg.region}, Converse API). Model id: verify before use (it should be Amazon's current top Nova, with model access enabled in that region).`,
        );
        opts.log(`amazon: ${cfg.model} in ${cfg.region} (Converse)`);
      }
    }
  }
  for (const spec of opts.compatSpecs) await withEndpoint(parseCompatSpec(spec), 'Fix model= in --openai-compatible.');
  return out;
}

/**
 * The vendor a contestant sends data to, as named on the privacy allowlist
 * (`--share-personal-with`): `claude` is Anthropic, and every other contestant
 * is its own vendor (an `--openai-compatible` endpoint goes by its name).
 */
export function privacyVendorOf(contestant: string): string {
  return contestant === 'claude' ? 'anthropic' : contestant;
}
