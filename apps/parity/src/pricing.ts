import type { TokenUsage } from '@flint/core';

/** Dollars per million tokens. */
export interface Price {
  input: number;
  output: number;
  /** Rate for cache-read input tokens. */
  cachedInput: number;
  /** Rate for cache-write input tokens (Anthropic only). */
  cacheWrite?: number;
  /** Flat fee per request (Perplexity's search fee). */
  perRequest?: number;
}

export type Vendor = 'anthropic' | 'openai' | 'perplexity';

/*
 * Published list prices, longest prefix first (every mini's name starts with its
 * parent's). An estimate for the budget guard, not an invoice: when a price here
 * drifts, the guard is off by that much, which is why unknown models are priced
 * HIGH — the guard should trip early, never late.
 */
const PRICES: ReadonlyArray<readonly [prefix: string, price: Price]> = [
  ['claude-fable-5', { input: 10, output: 50, cachedInput: 1, cacheWrite: 12.5 }],
  ['claude-opus-5-5', { input: 4, output: 20, cachedInput: 0.4, cacheWrite: 5 }],
  ['claude-opus-5', { input: 5, output: 25, cachedInput: 0.5, cacheWrite: 6.25 }],
  ['claude-opus-4', { input: 5, output: 25, cachedInput: 0.5, cacheWrite: 6.25 }],
  ['claude-sonnet-5', { input: 2, output: 10, cachedInput: 0.2, cacheWrite: 2.5 }],
  ['claude-sonnet-4', { input: 3, output: 15, cachedInput: 0.3, cacheWrite: 3.75 }],
  ['claude-haiku-4', { input: 1, output: 5, cachedInput: 0.1, cacheWrite: 1.25 }],
  ['gpt-5-pro', { input: 15, output: 120, cachedInput: 15 }],
  ['gpt-5-mini', { input: 0.25, output: 2, cachedInput: 0.025 }],
  ['gpt-5-nano', { input: 0.05, output: 0.4, cachedInput: 0.005 }],
  ['gpt-5', { input: 1.25, output: 10, cachedInput: 0.125 }],
  ['gpt-4.1', { input: 2, output: 8, cachedInput: 0.5 }],
  ['gpt-4o', { input: 2.5, output: 10, cachedInput: 1.25 }],
  ['o3', { input: 2, output: 8, cachedInput: 0.5 }],
  ['sonar-deep-research', { input: 2, output: 8, cachedInput: 2, perRequest: 0.5 }],
  ['sonar-reasoning-pro', { input: 2, output: 8, cachedInput: 2, perRequest: 0.014 }],
  ['sonar-pro', { input: 3, output: 15, cachedInput: 3, perRequest: 0.014 }],
  ['sonar', { input: 1, output: 1, cachedInput: 1, perRequest: 0.012 }],
];

/** Deliberately pessimistic. */
export const UNLISTED: Price = { input: 10, output: 50, cachedInput: 10, cacheWrite: 12.5, perRequest: 0.02 };

export function priceOf(model: string): Price {
  return PRICES.find(([prefix]) => model.startsWith(prefix))?.[1] ?? UNLISTED;
}

/**
 * Dollar cost of one call. The vendors count cached tokens differently:
 * Anthropic's `input` EXCLUDES cache reads/writes (they're reported beside it),
 * OpenAI's `input` INCLUDES the cached part. The core adapters pass both through
 * as-is, so the split happens here.
 */
export function costOf(vendor: Vendor, model: string, usage: TokenUsage): number {
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
 * A pre-call estimate for the budget guard: the prompt at ~4 chars/token plus a
 * fixed overhead (system prompt, tool schemas), and a typical answer length
 * (thinking included). Errs high.
 */
export function estimateCost(
  vendor: Vendor,
  model: string,
  promptChars: number,
  opts: { overheadTokens?: number; expectedOutputTokens?: number } = {},
): number {
  const input = Math.ceil(promptChars / 4) + (opts.overheadTokens ?? 600);
  return costOf(vendor, model, { input, output: opts.expectedOutputTokens ?? 1500 });
}
