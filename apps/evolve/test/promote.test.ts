import { describe, it, expect } from 'vitest';
import { decide, localOnly, parseCandidate, screen, tierEnvVar, tierReach } from '../src/promote';
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

// `try` rewrites FLINT_TIER_* in the live config. It may only ever put a model on this Mac's
// Ollama there: an outside model is Will's call, by hand.
describe('localOnly', () => {
  it('passes a model on the local Ollama', () => {
    for (const model of ['qwen3.8:27b', 'muse-glimmer:30b', 'qwen2.5:7b', 'hf.co/org/repo:Q4_K_M']) {
      expect(localOnly({ provider: 'ollama', model }), model).toEqual({ ok: true });
    }
  });

  it('refuses every outside provider, by name', () => {
    for (const provider of ['openai', 'anthropic', 'google', 'perplexity', 'bedrock', 'Ollama', 'ollama ', '']) {
      const r = localOnly({ provider, model: 'x' });
      expect(r.ok, JSON.stringify(provider)).toBe(false);
      expect((r as { reason: string }).reason).toContain('evolve only tries local models');
    }
  });

  it('refuses an Ollama cloud model: it runs on Ollama\'s servers', () => {
    for (const model of ['gpt-oss:120b-cloud', 'glm-4.6:cloud', 'qwen3-coder-cloud']) {
      const r = localOnly({ provider: 'ollama', model });
      expect(r.ok, model).toBe(false);
      expect((r as { reason: string }).reason).toContain('cloud model');
    }
  });
});

describe('screen', () => {
  const pulled = [cat('ollama', ['qwen3.8:27b', 'qwen2.5:7b', 'gpt-oss:120b-cloud']), cat('openai', ['gpt-5.5', 'gpt-5.6-sol'])];

  // A local model costs nothing per call, so there is no price table to pass.
  it('passes a local model that is pulled', () => {
    expect(screen({ tier: 'hard', provider: 'ollama', model: 'qwen3.8:27b' }, pulled).ok).toBe(true);
  });

  // The failure that put a deprecated model in the live config, in its local form.
  it('refuses a local model that is not pulled', () => {
    const r = screen({ tier: 'code', provider: 'ollama', model: 'qwen2.5:14b' }, pulled);
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toContain('not pulled');
  });

  it('refuses an outside model even when its vendor serves it and it has a price', () => {
    const r = screen({ tier: 'hard', provider: 'openai', model: 'gpt-5.5' }, pulled);
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toContain('evolve only tries local models');
  });

  it('refuses an Ollama cloud model even when it is listed', () => {
    const r = screen({ tier: 'hard', provider: 'ollama', model: 'gpt-oss:120b-cloud' }, pulled);
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toContain('cloud model');
  });

  it('refuses when Ollama could not be reached, rather than guessing', () => {
    const r = screen({ tier: 'hard', provider: 'ollama', model: 'qwen3.8:27b' }, [{ vendor: 'ollama', models: [], error: 'HTTP 500' }]);
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toContain('unreachable');
    expect(screen({ tier: 'hard', provider: 'ollama', model: 'qwen3.8:27b' }, []).ok).toBe(false);
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
  /** A fetch that records what it was asked and answers `status`. */
  function recording(status = 200) {
    const asked: Array<{ url: string; body: { model: string; options: { num_predict: number } } }> = [];
    const f = (async (url: string, init: { body: string }) => {
      asked.push({ url, body: JSON.parse(init.body) });
      return new Response(status === 200 ? '{"message":{"content":""}}' : 'model not found', { status });
    }) as unknown as typeof fetch;
    return { f, asked };
  }

  it('asks the local Ollama for one token, and nothing else', async () => {
    const { f, asked } = recording();
    const r = await probe({ provider: 'ollama', model: 'qwen3.8:27b', env: { OLLAMA_HOST: 'http://127.0.0.1:11434/' }, fetch: f });
    expect(r).toEqual({ ok: true, detail: 'answered' });
    expect(asked).toHaveLength(1);
    expect(asked[0]!.url).toBe('http://127.0.0.1:11434/api/chat');
    expect(asked[0]!.body).toMatchObject({ model: 'qwen3.8:27b', options: { num_predict: 1 } });
  });

  // The screen listed the tier's Ollama; the probe must ask that same one, or it proves nothing about the tier.
  it('asks the Ollama the server\'s ollama: tier is served from, not the local brain\'s', async () => {
    const { f, asked } = recording();
    await probe({ provider: 'ollama', model: 'big:70b', env: { OLLAMA_HOST: 'http://127.0.0.1:11434', FLINT_TIER_OLLAMA_HOST: 'http://bigbox:11434/' }, fetch: f });
    await probe({ provider: 'ollama', model: 'big:70b', env: { OLLAMA_HOST: 'http://127.0.0.1:11434', FLINT_FRONTIER_BASE_URL: 'http://frontier:11434' }, fetch: f });
    await probe({ provider: 'ollama', model: 'big:70b', env: {}, fetch: f });
    expect(asked.map((a) => a.url)).toEqual(['http://bigbox:11434/api/chat', 'http://frontier:11434/api/chat', 'http://127.0.0.1:11434/api/chat']);
  });

  it('reports a model that does not answer', async () => {
    const { f } = recording(404);
    const r = await probe({ provider: 'ollama', model: 'qwen2.5:14b', env: {}, fetch: f });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('HTTP 404');
  });

  // Every key is present: it still makes no request. There is no vendor probe left to reach.
  it('never contacts an outside vendor, whatever keys are set', async () => {
    const { f, asked } = recording();
    const env = { OPENAI_API_KEY: 'sk-test', ANTHROPIC_API_KEY: 'sk-ant-test', GEMINI_API_KEY: 'g-test' };
    for (const p of ['openai', 'anthropic', 'google', 'perplexity', 'mystery']) {
      const r = await probe({ provider: p, model: 'x', env, fetch: f });
      expect(r.ok, p).toBe(false);
      expect(r.detail, p).toContain('evolve only tries local models');
    }
    const cloud = await probe({ provider: 'ollama', model: 'gpt-oss:120b-cloud', env, fetch: f });
    expect(cloud.ok).toBe(false);
    expect(asked).toEqual([]);
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
