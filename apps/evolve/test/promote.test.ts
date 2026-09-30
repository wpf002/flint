import { describe, it, expect } from 'vitest';
import { decide, parseCandidate, screen, tierEnvVar, tierReach } from '../src/promote';
import type { DailyRow } from '../src/measure';

const row = (winRate: number, signal: DailyRow['signal']): DailyRow => ({
  ts: 't',
  config: 'c',
  n: 8,
  wins: 6,
  losses: 2,
  ties: 0,
  winRate,
  signal,
  costUsd: 0.4,
});

const cat = (vendor: string, ids: string[]) => ({ vendor, models: ids.map((id) => ({ id })) });

describe('parseCandidate', () => {
  it('reads tier, provider and model', () => {
    expect(parseCandidate('hard=openai:gpt-5.6-sol')).toEqual({
      tier: 'hard',
      provider: 'openai',
      model: 'gpt-5.6-sol',
    });
  });

  it('keeps colons inside an ollama tag', () => {
    expect(parseCandidate('routine=ollama:qwen3:32b')?.model).toBe('qwen3:32b');
  });

  it('rejects junk', () => {
    for (const s of ['', 'hard', 'hard=', '=openai:gpt-5', 'hard=openai']) {
      expect(parseCandidate(s)).toBeUndefined();
    }
  });
});

describe('tierEnvVar', () => {
  it('maps a tier to its env var', () => {
    expect(tierEnvVar('hard')).toBe('FLINT_TIER_HARD');
  });
});

describe('screen', () => {
  const served = [cat('openai', ['gpt-5.5', 'gpt-5.6-sol', 'gpt-6-sol'])];

  it('passes a model that is both served and priced', () => {
    expect(screen({ tier: 'hard', provider: 'openai', model: 'gpt-5.5' }, served).ok).toBe(true);
  });

  // The failure that put a deprecated model in the live config.
  it('refuses a model the vendor does not serve', () => {
    const r = screen({ tier: 'code', provider: 'openai', model: 'gpt-5.2-codex' }, served);
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toContain('does not serve');
  });

  // gpt-6-sol is real but absent from pricing.ts: promoting it would price every
  // call at UNLISTED_PRICE and quietly shrink every budget guard.
  it('refuses a served model that has no price', () => {
    const r = screen({ tier: 'hard', provider: 'openai', model: 'gpt-6-sol' }, served);
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toContain('price table');
  });

  it('refuses when the vendor could not be reached, rather than guessing', () => {
    const r = screen({ tier: 'hard', provider: 'openai', model: 'gpt-5.5' }, [
      { vendor: 'openai', models: [], error: 'HTTP 500' },
    ]);
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toContain('unreachable');
  });
});

describe('decide', () => {
  it('never promotes on noise, however high the rate', () => {
    const d = decide({ candidate: row(0.9, 'NOISE'), incumbent: row(0.5, 'BETTER') });
    expect(d).toMatchObject({ action: 'rollback' });
  });

  it('rolls back a candidate that is measurably worse', () => {
    expect(decide({ candidate: row(0.2, 'WORSE'), incumbent: row(0.5, 'BETTER') })).toMatchObject({
      action: 'rollback',
    });
  });

  it('requires a real margin, not a hair', () => {
    const d = decide({ candidate: row(0.52, 'BETTER'), incumbent: row(0.5, 'BETTER') });
    expect(d).toMatchObject({ action: 'rollback' });
    expect((d as { why: string }).why).toContain('margin');
  });

  it('keeps a candidate that clears the margin with a real signal', () => {
    expect(decide({ candidate: row(0.75, 'BETTER'), incumbent: row(0.5, 'BETTER') })).toMatchObject({
      action: 'keep',
    });
  });

  it('keeps a proven candidate when there is no incumbent score yet', () => {
    expect(decide({ candidate: row(0.7, 'BETTER'), incumbent: undefined })).toMatchObject({ action: 'keep' });
  });
});

// --- probe ------------------------------------------------------------------
import { probe } from '../src/probe';

describe('probe', () => {
  it('refuses a provider it has no probe for, rather than assuming', async () => {
    const r = await probe({ provider: 'mystery', model: 'x', env: {} });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('no probe');
  });

  it('refuses when the provider has no key', async () => {
    for (const p of ['openai', 'anthropic', 'google']) {
      const r = await probe({ provider: p, model: 'x', env: {} });
      expect(r.ok).toBe(false);
      expect(r.detail).toContain('no ');
    }
  });
});

// The 8 questions the frozen baseline measured on 2026-09-29.
const MEASURED = [
  'Explain the birthday paradox.',
  'How did the enclosure movement in England displace rural populations and feed early industrialization?',
  'What are the odds the Astros make the playoffs?',
  'Describe the mechanistic relationship between telomere shortening, p53-mediated repression of PGC-1α and PGC-1β, and the resulting mitochondrial dysfunction observed in aging tissues?',
  'What are the trade-offs between blue-green deployments and canary releases in terms of rollback speed and blast radius?',
  'What is the difference between weather and climate?',
  'How does quantum tunneling allow electrons to pass through energy barriers they classically cannot overcome?',
  'What is the difference between cross-validation and a train-test split for model evaluation?',
];

describe('tierReach', () => {
  // `try routine=anthropic:claude-sonnet-5-5` would have paid ~$0.50 for a
  // measurement Sonnet 5.5 never answered a single question of.
  it('finds that no measured question reaches the routine or code tier', () => {
    expect(tierReach('routine', MEASURED)).toEqual({ reachable: 0, total: 8 });
    expect(tierReach('code', MEASURED)).toEqual({ reachable: 0, total: 8 });
    expect(tierReach('standard', MEASURED)).toEqual({ reachable: 7, total: 8 });
    expect(tierReach('hard', MEASURED)).toEqual({ reachable: 1, total: 8 });
  });

  it('counts greetings and one-liners for the routine tier', () => {
    expect(tierReach('routine', ['How are you doing today Flint?', 'thanks!', 'Explain the birthday paradox.'])).toEqual({
      reachable: 2,
      total: 3,
    });
  });

  // The tool router can move a routine one-liner to standard, and evolve can't
  // know which way it will go, so the prompt counts for both: never undercount.
  it('counts a prompt the tool router could move for both tiers it might land in', () => {
    expect(tierReach('routine', ["what's the weather"]).reachable).toBe(1);
    expect(tierReach('standard', ["what's the weather"]).reachable).toBe(1);
  });

  it('finds nothing for a tier no message is classified into', () => {
    expect(tierReach('last_resort', MEASURED).reachable).toBe(0);
    expect(tierReach('routine', [])).toEqual({ reachable: 0, total: 0 });
  });
});

describe('decide, when the candidate never answered', () => {
  it('rolls back even a BETTER score the candidate did not produce', () => {
    const d = decide({ candidate: row(0.9, 'BETTER'), incumbent: row(0.5, 'NOISE'), candidateAnswers: 0 });
    expect(d).toMatchObject({ ok: true, action: 'rollback' });
    expect(d.ok && d.why).toMatch(/no measured answer came from the candidate/);
  });

  it('decides as before once the candidate answered anything', () => {
    expect(decide({ candidate: row(0.9, 'BETTER'), incumbent: row(0.5, 'NOISE'), candidateAnswers: 1 })).toMatchObject({ action: 'keep' });
    expect(decide({ candidate: row(0.9, 'BETTER'), incumbent: row(0.5, 'NOISE') })).toMatchObject({ action: 'keep' });
  });
});
