import { describe, it, expect } from 'vitest';
import { decide, parseCandidate, screen, tierEnvVar } from '../src/promote';
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
