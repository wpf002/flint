import type { TokenUsage } from './types/stream.js';

/**
 * What Flint's paid calls cost, in one place: the server's spend ledger and the
 * parity harness's budget guard both price from this table, so a price fixed
 * here is fixed everywhere.
 *
 * An ESTIMATE for budget guards, not an invoice. When a price here drifts, the
 * guards are off by that much, which is why unknown models are priced HIGH: a
 * guard should trip early, never late. Every row names its source; rows marked
 * "verify" were not confirmed against the vendor's page when they were written.
 */

/** Dollars per million tokens. */
export interface TokenPrice {
  input: number;
  output: number;
  /** Rate for cache-read input tokens. */
  cachedInput: number;
  /** Rate for cache-write input tokens (Anthropic's 5-minute TTL; Anthropic only). */
  cacheWrite?: number;
  /** Flat fee per request (Perplexity's search fee). */
  perRequest?: number;
}

/** The vendors Flint pays by the token. */
export type TokenVendor = 'anthropic' | 'openai' | 'perplexity';

/** Every vendor Flint pays at all: the token vendors, plus Tavily (per search credit). */
export type PaidVendor = TokenVendor | 'tavily';

export const PAID_VENDORS: readonly PaidVendor[] = ['anthropic', 'openai', 'perplexity', 'tavily'];

/*
 * Sources:
 *  [A] Anthropic list prices, claude-api reference (models table cached
 *      2026-06-24; Opus 5.5 / Fable 5.1 cache-read rates from its models notes).
 *      Cache writes are the 5-minute TTL (1.25x input); reads 0.1x unless noted.
 *  [O] https://developers.openai.com/api/docs/pricing, fetched 2026-09-25.
 *  [P] https://docs.perplexity.ai/getting-started/pricing, fetched 2026-09-25.
 *      `perRequest` is the HIGH search-context fee on purpose: the default is
 *      low ($5 / $6 per 1K requests), so this over-counts by at most $0.008 a
 *      request. Sonar Deep Research bills per search query instead; $0.50 is a
 *      deliberately high stand-in (verify).
 *
 * Matching: longest prefix first, and a prefix only matches when the model name
 * continues with something other than a digit or a dot. So `gpt-5` prices
 * `gpt-5-2025-08-07` but NOT `gpt-5.5` (which costs 4x more), and a model this
 * table has never seen falls through to UNLISTED_PRICE instead of borrowing a
 * cheaper sibling's rate.
 */
const TOKEN_PRICES: ReadonlyArray<readonly [prefix: string, price: TokenPrice]> = [
  ['claude-fable-5-1', { input: 10, output: 50, cachedInput: 0.25, cacheWrite: 12.5 }], // [A]
  ['claude-fable-5', { input: 10, output: 50, cachedInput: 1, cacheWrite: 12.5 }], // [A]
  ['claude-opus-5-5', { input: 4, output: 20, cachedInput: 0.2, cacheWrite: 5 }], // [A]
  ['claude-opus-5', { input: 5, output: 25, cachedInput: 0.5, cacheWrite: 6.25 }], // [A]
  ['claude-opus-4-1', { input: 15, output: 75, cachedInput: 1.5, cacheWrite: 18.75 }], // legacy list price (verify)
  ['claude-opus-4', { input: 5, output: 25, cachedInput: 0.5, cacheWrite: 6.25 }], // [A] 4.6 / 4.7 / 4.8
  ['claude-sonnet-5', { input: 2, output: 10, cachedInput: 0.2, cacheWrite: 2.5 }], // [A]
  ['claude-sonnet-4', { input: 3, output: 15, cachedInput: 0.3, cacheWrite: 3.75 }], // [A] 4.6 (and 4.5)
  ['claude-haiku-4', { input: 1, output: 5, cachedInput: 0.1, cacheWrite: 1.25 }], // [A] 4.5
  ['gpt-5.6', { input: 4, output: 20, cachedInput: 0.4 }], // [O] gpt-5.6-sol
  ['gpt-5.5', { input: 5, output: 30, cachedInput: 0.5 }], // [O]
  ['gpt-5.4', { input: 2.5, output: 15, cachedInput: 0.25 }], // [O]
  ['gpt-5.2', { input: 1.75, output: 14, cachedInput: 0.175 }], // [O]
  ['gpt-5.1', { input: 1.25, output: 10, cachedInput: 0.125 }], // [O]
  ['gpt-5-pro', { input: 15, output: 120, cachedInput: 15 }], // [O] no cached rate: billed as input
  ['gpt-5-mini', { input: 0.25, output: 2, cachedInput: 0.025 }], // [O]
  ['gpt-5-nano', { input: 0.05, output: 0.4, cachedInput: 0.005 }], // [O]
  ['gpt-5', { input: 1.25, output: 10, cachedInput: 0.125 }], // [O]
  ['gpt-4.1', { input: 2, output: 8, cachedInput: 0.5 }], // list price (verify)
  ['gpt-4o', { input: 2.5, output: 10, cachedInput: 1.25 }], // list price (verify)
  ['o3-pro', { input: 20, output: 80, cachedInput: 20 }], // list price (verify)
  ['o3', { input: 2, output: 8, cachedInput: 0.5 }], // list price (verify)
  ['sonar-deep-research', { input: 2, output: 8, cachedInput: 2, perRequest: 0.5 }], // [P]
  ['sonar-reasoning-pro', { input: 2, output: 8, cachedInput: 2, perRequest: 0.014 }], // [P]
  ['sonar-pro', { input: 3, output: 15, cachedInput: 3, perRequest: 0.014 }], // [P]
  ['sonar', { input: 1, output: 1, cachedInput: 1, perRequest: 0.012 }], // [P]
];

/** Deliberately pessimistic: at or above the dearest listed model on every axis. */
export const UNLISTED_PRICE: TokenPrice = { input: 10, output: 50, cachedInput: 10, cacheWrite: 12.5, perRequest: 0.02 };

/** Whether `model` is `prefix` or a variant of it (never a different version: `gpt-5` is not `gpt-5.5`). */
function matches(model: string, prefix: string): boolean {
  if (!model.startsWith(prefix)) return false;
  const next = model.charAt(prefix.length);
  return next === '' || !/[0-9.]/.test(next);
}

/** The per-token price of `model` (UNLISTED_PRICE when the table doesn't know it). */
export function priceOf(model: string): TokenPrice {
  return TOKEN_PRICES.find(([prefix]) => matches(model, prefix))?.[1] ?? UNLISTED_PRICE;
}

/** Whether the table has a real price for `model` (false: priced as UNLISTED_PRICE). */
export function isListedModel(model: string): boolean {
  return TOKEN_PRICES.some(([prefix]) => matches(model, prefix));
}

/**
 * Dollar cost of one call. The vendors count cached tokens differently:
 * Anthropic's `input` EXCLUDES cache reads/writes (they're reported beside it),
 * OpenAI's `input` INCLUDES the cached part. The core adapters pass both through
 * as-is, so the split happens here.
 */
export function costOf(vendor: TokenVendor, model: string, usage: TokenUsage): number {
  const p = priceOf(model);
  const read = usage.cacheRead ?? 0;
  const write = usage.cacheWrite ?? 0;
  let inputCost: number;
  if (vendor === 'anthropic') {
    inputCost = usage.input * p.input + read * p.cachedInput + write * (p.cacheWrite ?? p.input);
  } else {
    const cached = Math.min(read, usage.input);
    inputCost = (usage.input - cached) * p.input + cached * p.cachedInput;
  }
  return (inputCost + usage.output * p.output) / 1_000_000 + (p.perRequest ?? 0);
}

/**
 * A pre-call estimate for a budget guard: the prompt at ~4 chars/token plus a
 * fixed overhead (system prompt, tool schemas), and a typical answer length
 * (thinking included). Errs high.
 */
export function estimateCost(
  vendor: TokenVendor,
  model: string,
  promptChars: number,
  opts: { overheadTokens?: number; expectedOutputTokens?: number } = {},
): number {
  const input = Math.ceil(promptChars / 4) + (opts.overheadTokens ?? 600);
  return costOf(vendor, model, { input, output: opts.expectedOutputTokens ?? 1500 });
}

/**
 * The paid vendor behind a provider adapter's `name`, or undefined when the
 * provider costs nothing per call (Ollama: the local brain) or is unknown.
 */
export function vendorOfProvider(providerName: string): TokenVendor | undefined {
  switch (providerName) {
    case 'anthropic':
    case 'openai':
    case 'perplexity':
      return providerName;
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// text-to-speech (OpenAI), priced per input character

/*
 * [O] tts-1 $15 and tts-1-hd $30 per 1M characters. gpt-4o-mini-tts is billed
 * by the token ($0.60/1M text in, $12/1M audio out, about $0.015 a minute);
 * at ~900 spoken characters a minute that is ~$17 per 1M characters (an
 * estimate, verify against a real bill). Unknown TTS models get the HD rate.
 */
const TTS_USD_PER_MILLION_CHARS: ReadonlyArray<readonly [prefix: string, usd: number]> = [
  ['gpt-4o-mini-tts', 17],
  ['tts-1-hd', 30],
  ['tts-1', 15],
];

/** Dollar cost of synthesizing `chars` characters with an OpenAI TTS model. */
export function ttsCostOf(model: string, chars: number): number {
  const rate = TTS_USD_PER_MILLION_CHARS.find(([prefix]) => matches(model, prefix))?.[1] ?? 30;
  return (Math.max(0, chars) * rate) / 1_000_000;
}

// ---------------------------------------------------------------------------
// search APIs, priced per call

/**
 * [T] https://docs.tavily.com/documentation/api-credits, fetched 2026-09-25:
 * pay-as-you-go is $0.008 a credit; a basic search is 1 credit, an advanced one
 * 2. (The free plan's 1,000 credits a month are worth $8 at that rate.)
 */
export const TAVILY_USD_PER_CREDIT = 0.008;

/** Credits one Tavily search costs at a `search_depth`. */
export function tavilySearchCredits(depth?: unknown): number {
  return depth === 'advanced' ? 2 : 1;
}

/**
 * One Perplexity `sonar` search as the trident MCP server makes it (default,
 * low search context): a $0.005 request fee [P] plus ~1-3K tokens at $1/M.
 * An estimate per call, since the call runs in another process and its token
 * usage never reaches Flint.
 */
export const PERPLEXITY_SEARCH_CALL_USD = 0.008;

// ---------------------------------------------------------------------------
// calendar periods for daily / monthly budgets

const DAY_FORMATS = new Map<string, Intl.DateTimeFormat>();

/**
 * The calendar day (`YYYY-MM-DD`) and month (`YYYY-MM`) that `ts` falls in, in
 * `timeZone` (an IANA name). Budgets reset at local midnight, not UTC's.
 */
export function spendPeriod(ts: number, timeZone: string): { day: string; month: string } {
  let fmt = DAY_FORMATS.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    DAY_FORMATS.set(timeZone, fmt);
  }
  const parts = Object.fromEntries(fmt.formatToParts(new Date(ts)).map((p) => [p.type, p.value]));
  const month = `${parts.year}-${parts.month}`;
  return { day: `${month}-${parts.day}`, month };
}
