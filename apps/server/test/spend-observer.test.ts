/**
 * The ledger sees EVERY paid provider pass: each tool-loop iteration, the
 * answer-only call past the loop limit, retries, and each fallback tier's
 * attempt. Real Flint clients, scripted providers, no network.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Flint, costOf, makeAiError, type ProviderAdapter, type StreamEvent, type TokenUsage, type Tool } from '@flint/core';
import { SpendLedger, spendObserver, spendContext } from '../src/spend';
import { answerWithFallback } from '../src/unanswered';
import type { BrainTier } from '../src/brains';

const NOON = Date.UTC(2026, 8, 25, 17, 0);
const FAST_RETRY = { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 };

/** A provider that streams one scripted turn per call (the last one repeats). */
function scripted(name: string, turns: StreamEvent[][]): ProviderAdapter & { calls: () => number } {
  let i = 0;
  return {
    name,
    calls: () => i,
    getCapabilities: () => ({ toolCalling: 'native', structuredOutput: 'native', streaming: 'full', maxContextTokens: 200_000, maxOutputTokens: 8_192 }),
    estimateTokens: () => 10,
    generate: () => Promise.reject(new Error('stream only')),
    stream: () => {
      const events = turns[Math.min(i++, turns.length - 1)]!;
      return (async function* () {
        for (const e of events) yield e;
      })();
    },
  };
}

const done = (reason: 'complete' | 'tool_call' | 'refusal', usage: TokenUsage): StreamEvent => ({ type: 'done', reason, usage });
const text = (delta: string): StreamEvent => ({ type: 'text', delta });
const callTool = (id: string): StreamEvent => ({ type: 'tool_call', call: { id, toolName: 'web.web_search', args: { query: 'x' } } });
const fail = (retryable: boolean): StreamEvent => ({ type: 'error', error: makeAiError(retryable ? 'rate_limit' : 'server', 'boom', { retryable }) });

const search: Tool = {
  definition: { name: 'web.web_search', description: 'search', inputSchema: { type: 'object' }, idempotent: true },
  handler: async () => 'results',
};

let dir: string;
let ledger: SpendLedger;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flint-spend-obs-'));
  ledger = new SpendLedger({ dir, timeZone: 'America/Chicago', now: () => NOON });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const rows = () =>
  readFileSync(join(dir, 'spend-2026-09.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as { vendor: string; model: string; kind: string; usd: number; tokens: TokenUsage });

describe('spendObserver', () => {
  it('records every iteration of a tool loop, cache reads and writes priced', async () => {
    const u1: TokenUsage = { input: 1_000, output: 100, cacheRead: 5_000, cacheWrite: 2_000 };
    const u2: TokenUsage = { input: 1_200, output: 300, cacheRead: 7_000 };
    const u3: TokenUsage = { input: 900, output: 800, cacheRead: 7_000 };
    const provider = scripted('anthropic', [
      [callTool('t1'), done('tool_call', u1)],
      [callTool('t2'), done('tool_call', u2)],
      [text('The answer.'), done('complete', u3)],
    ]);
    const flint = new Flint({ provider, defaultModel: 'claude-opus-5-5', observer: spendObserver(ledger) });
    const out = await flint.generate({ prompt: 'look it up', tools: [search] });
    expect(out.text).toBe('The answer.');
    const r = rows();
    expect(r).toHaveLength(3);
    expect(r.map((x) => x.kind)).toEqual(['chat', 'chat', 'chat']);
    expect(r[0]!.tokens).toEqual(u1);
    const expected = [u1, u2, u3].reduce((s, u) => s + costOf('anthropic', 'claude-opus-5-5', u), 0);
    expect(ledger.totals('anthropic').day.usd).toBeCloseTo(expected, 5);
    expect(ledger.totals('anthropic').day.calls).toBe(3);
  });

  it('records the answer-only call a runaway tool loop ends with', async () => {
    const u: TokenUsage = { input: 100, output: 10 };
    const provider = scripted('anthropic', [
      ...Array.from({ length: 6 }, (_, i) => [callTool(`t${i}`), done('tool_call', u)]),
      [text('From what I found: x.'), done('complete', u)],
    ]);
    const flint = new Flint({ provider, defaultModel: 'claude-opus-5-5', observer: spendObserver(ledger) });
    await flint.generate({ prompt: 'keep searching', tools: [search] });
    expect(provider.calls()).toBe(7);
    expect(rows()).toHaveLength(7); // 6 loop passes + the answer-only call
  });

  it('records a retried call once: the failed attempt reported no usage', async () => {
    const provider = scripted('anthropic', [[fail(true)], [text('ok'), done('complete', { input: 10, output: 5 })]]);
    const flint = new Flint({ provider, defaultModel: 'claude-sonnet-5', observer: spendObserver(ledger), retryPolicy: FAST_RETRY });
    await flint.generate({ prompt: 'hi' });
    expect(provider.calls()).toBe(2);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]!.model).toBe('claude-sonnet-5');
  });

  it('records a stream cut off mid-answer at the usage the provider billed', async () => {
    // What the Anthropic adapter yields when /chat's tab closes part way: the input
    // (and cache) counts from message_start, output so far, on the error event.
    const billed: TokenUsage = { input: 3_000, output: 40, cacheRead: 9_000 };
    const ac = new AbortController();
    const provider = scripted('anthropic', [
      [text('Partial '), { type: 'error', error: makeAiError('internal', 'Request was aborted', { retryable: false }), usage: billed }],
    ]);
    const flint = new Flint({ provider, defaultModel: 'claude-opus-5-5', observer: spendObserver(ledger) });
    ac.abort();
    const events: StreamEvent[] = [];
    for await (const ev of flint.stream({ prompt: 'long answer' }, { signal: ac.signal })) events.push(ev);
    expect(events[events.length - 1]!.type).toBe('error');
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ vendor: 'anthropic', model: 'claude-opus-5-5', kind: 'chat', tokens: billed });
    expect(ledger.totals('anthropic').day.usd).toBeCloseTo(costOf('anthropic', 'claude-opus-5-5', billed), 6);
  });

  it('records every fallback attempt that finished, on its own vendor', async () => {
    const brain = (label: string, provider: ProviderAdapter, model: string): BrainTier<Flint> => ({
      tier: 'standard',
      provider,
      model,
      label,
      persona: new Flint({ provider, defaultModel: model, observer: spendObserver(ledger), retryPolicy: FAST_RETRY }),
    });
    // Opus refuses (billed), Sonnet errors before finishing (no usage), GPT-5 answers.
    const chain = [
      brain('anthropic:claude-opus-5-5', scripted('anthropic', [[done('refusal', { input: 2_000, output: 20 })]]), 'claude-opus-5-5'),
      brain('anthropic:claude-sonnet-5', scripted('anthropic', [[fail(false)]]), 'claude-sonnet-5'),
      brain('openai:gpt-5', scripted('openai', [[text('Here you go.'), done('complete', { input: 1_500, output: 400 })]]), 'gpt-5'),
    ];
    const won = await answerWithFallback(chain, (b) => b.persona.generate({ prompt: 'q' }));
    expect(won.brain.label).toBe('openai:gpt-5');
    expect(rows().map((r) => `${r.vendor}:${r.model}`)).toEqual(['anthropic:claude-opus-5-5', 'openai:gpt-5']);
    expect(ledger.totals('anthropic').day.usd).toBeCloseTo(costOf('anthropic', 'claude-opus-5-5', { input: 2_000, output: 20 }), 6);
    expect(ledger.totals('openai').day.usd).toBeCloseTo(costOf('openai', 'gpt-5', { input: 1_500, output: 400 }), 6);
  });

  it('tags a call with its kind from CallOptions.context', async () => {
    const provider = scripted('anthropic', [[text('[]'), done('complete', { input: 5_000, output: 50 })]]);
    const flint = new Flint({ provider, defaultModel: 'claude-opus-5-5', observer: spendObserver(ledger) });
    await flint.generate({ prompt: 'extract' }, { context: spendContext('extract') });
    await flint.generate({ prompt: 'plan' }, { context: spendContext('plan') });
    await flint.generate({ prompt: 'eval' }, { context: spendContext('eval') });
    expect(rows().map((r) => r.kind)).toEqual(['extract', 'plan', 'eval']);
    // The eval replay is logged but not charged against Flint's caps.
    expect(ledger.totals('anthropic').day.evalUsd).toBeGreaterThan(0);
    expect(ledger.totals('anthropic').day.usd).toBeCloseTo(2 * costOf('anthropic', 'claude-opus-5-5', { input: 5_000, output: 50 }), 6);
  });

  it('never records the local brain', async () => {
    const provider = scripted('ollama', [[text('local'), done('complete', { input: 3_000, output: 300 })]]);
    const flint = new Flint({ provider, defaultModel: 'muse-glimmer:30b', observer: spendObserver(ledger) });
    await flint.generate({ prompt: 'hi' });
    expect(ledger.totals('anthropic').day.calls + ledger.totals('openai').day.calls).toBe(0);
  });
});
