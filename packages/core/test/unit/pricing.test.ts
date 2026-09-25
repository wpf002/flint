import { describe, it, expect } from 'vitest';
import {
  priceOf,
  isListedModel,
  costOf,
  estimateCost,
  vendorOfProvider,
  ttsCostOf,
  tavilySearchCredits,
  TAVILY_USD_PER_CREDIT,
  spendPeriod,
  UNLISTED_PRICE,
} from '../../src/pricing.js';

describe('priceOf', () => {
  it('prices the models Flint runs on', () => {
    expect(priceOf('claude-opus-5-5')).toMatchObject({ input: 4, output: 20, cachedInput: 0.2, cacheWrite: 5 });
    expect(priceOf('claude-opus-5')).toMatchObject({ input: 5, output: 25 });
    expect(priceOf('claude-sonnet-5')).toMatchObject({ input: 2, output: 10 });
    expect(priceOf('claude-sonnet-4-6')).toMatchObject({ input: 3, output: 15 });
    expect(priceOf('claude-haiku-4-5')).toMatchObject({ input: 1, output: 5 });
    expect(priceOf('gpt-5')).toMatchObject({ input: 1.25, output: 10 });
    expect(priceOf('sonar')).toMatchObject({ input: 1, output: 1 });
  });

  it('matches the longest prefix, so a cheaper sibling never borrows a dearer price or vice versa', () => {
    expect(priceOf('claude-opus-5-5').input).toBe(4); // not claude-opus-5's $5
    expect(priceOf('claude-fable-5-1').cachedInput).toBe(0.25); // not claude-fable-5's $1
    expect(priceOf('gpt-5-mini').input).toBe(0.25);
    expect(priceOf('sonar-pro').output).toBe(15);
    expect(priceOf('gpt-5-2025-08-07').input).toBe(1.25); // dated snapshot of gpt-5
  });

  it('never prices a newer version as its cheaper predecessor', () => {
    // gpt-5.5 is 4x gpt-5; a plain startsWith would have priced it at gpt-5.
    expect(priceOf('gpt-5.5').input).toBe(5);
    // A version the table has never seen is priced HIGH, not as gpt-5.
    expect(priceOf('gpt-5.3')).toBe(UNLISTED_PRICE);
    expect(isListedModel('gpt-5.3')).toBe(false);
    expect(isListedModel('claude-opus-5-5')).toBe(true);
  });
});

describe('costOf', () => {
  it('prices Anthropic cache reads/writes beside uncached input', () => {
    const c = costOf('anthropic', 'claude-opus-5-5', { input: 1_000_000, output: 100_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 });
    expect(c).toBeCloseTo(4 + 2 + 0.2 + 5, 6);
  });

  it('prices OpenAI cached tokens as part of input', () => {
    const c = costOf('openai', 'gpt-5', { input: 1_000_000, output: 0, cacheRead: 400_000 });
    expect(c).toBeCloseTo(0.6 * 1.25 + 0.4 * 0.125, 6);
  });

  it('adds the Perplexity request fee', () => {
    expect(costOf('perplexity', 'sonar', { input: 0, output: 0 })).toBeCloseTo(0.012, 6);
  });

  it('estimates grow with prompt length', () => {
    expect(estimateCost('anthropic', 'claude-opus-5', 40_000)).toBeGreaterThan(estimateCost('anthropic', 'claude-opus-5', 40));
  });
});

describe('other paid calls', () => {
  it('maps provider names to paid vendors; the local brain is free', () => {
    expect(vendorOfProvider('anthropic')).toBe('anthropic');
    expect(vendorOfProvider('openai')).toBe('openai');
    expect(vendorOfProvider('perplexity')).toBe('perplexity');
    expect(vendorOfProvider('ollama')).toBeUndefined();
  });

  it('prices TTS per character, unknown models at the HD rate', () => {
    expect(ttsCostOf('tts-1', 1_000_000)).toBeCloseTo(15, 6);
    expect(ttsCostOf('tts-1-hd', 1_000_000)).toBeCloseTo(30, 6);
    expect(ttsCostOf('some-new-voice', 1_000_000)).toBeCloseTo(30, 6);
    expect(ttsCostOf('tts-1', 400)).toBeCloseTo(0.006, 6);
  });

  it('counts an advanced Tavily search as two credits', () => {
    expect(tavilySearchCredits('advanced') * TAVILY_USD_PER_CREDIT).toBeCloseTo(0.016, 6);
    expect(tavilySearchCredits(undefined)).toBe(1);
    expect(tavilySearchCredits('basic')).toBe(1);
  });
});

describe('spendPeriod', () => {
  it('rolls the day over at local midnight, not UTC midnight', () => {
    // 2026-09-26 04:30Z is still 23:30 on the 25th in Chicago (CDT, UTC-5).
    expect(spendPeriod(Date.UTC(2026, 8, 26, 4, 30), 'America/Chicago')).toEqual({ day: '2026-09-25', month: '2026-09' });
    expect(spendPeriod(Date.UTC(2026, 8, 26, 5, 30), 'America/Chicago')).toEqual({ day: '2026-09-26', month: '2026-09' });
  });

  it('rolls the month over at local midnight too, across DST', () => {
    // 2026-12-01 05:59Z is 23:59 on Nov 30 in Chicago (CST, UTC-6).
    expect(spendPeriod(Date.UTC(2026, 11, 1, 5, 59), 'America/Chicago')).toEqual({ day: '2026-11-30', month: '2026-11' });
    expect(spendPeriod(Date.UTC(2026, 11, 1, 6, 0), 'America/Chicago')).toEqual({ day: '2026-12-01', month: '2026-12' });
  });
});
