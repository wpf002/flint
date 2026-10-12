import { classifyMessage, isOllamaCloudModel } from '@flint/core';
import type { DailyRow } from './measure.js';
import type { VendorCatalog } from './discover.js';
import { isServed } from './discover.js';

/**
 * Stage 3: act on a finding instead of reporting it.
 *
 * A candidate is tried by swapping it into the live config, measuring it the
 * same way stage 2 measures anything, and keeping it only if it is measurably
 * better. Everything here is the decision half — the swapping and restarting
 * lives in run-try.ts, so the rules can be tested without touching a server.
 *
 * The bias is deliberate: a candidate has to EARN the swap. Anything unproven,
 * unserved, or merely noise loses to the incumbent, because the incumbent is
 * known to work and a bad promotion degrades Flint until someone notices.
 *
 * And a candidate is always a LOCAL model (`ollama:...`, localOnly). `try`
 * rewrites FLINT_TIER_* in the live config; it used to accept any provider, so
 * a script could point a tier at an outside AI. Flint moving a tier onto
 * another company's model is never its own call to make: Will does that by
 * hand, or not at all.
 */

export interface Candidate {
  tier: string;
  provider: string;
  model: string;
}

export type Refusal =
  | { ok: false; reason: string };

export type Decision =
  | { ok: true; action: 'keep'; why: string }
  | { ok: true; action: 'rollback'; why: string }
  | Refusal;

/**
 * Is this a model on Will's own Ollama? The one rule every step of `try`
 * checks again for itself (parse, screen, the probe, the config write), so no
 * later change to one of them can let an outside model through:
 *  - the provider is `ollama`, exactly;
 *  - the model is not an Ollama cloud model (`...-cloud`, `:cloud`): those are
 *    open weights, but they run on Ollama's servers, not here.
 */
export function localOnly(c: Pick<Candidate, 'provider' | 'model'>): Refusal | { ok: true } {
  if (c.provider !== 'ollama') {
    return { ok: false, reason: `evolve only tries local models (ollama:<model>); ${c.provider}:${c.model} is an outside AI, and moving a tier onto one is Will's call, by hand` };
  }
  if (isOllamaCloudModel(c.model)) {
    return { ok: false, reason: `${c.model} is an Ollama cloud model, which runs on Ollama's servers, not on this Mac` };
  }
  return { ok: true };
}

/**
 * Checks that run BEFORE anything is spent testing a candidate.
 *
 * Not local is a hard no (localOnly). Unserved is a hard no because it is the
 * exact failure that put a deprecated gpt-5.2-codex in the live config: the
 * model has to be pulled on this Mac's Ollama. A local model costs nothing per
 * call, so there is no price to check.
 */
export function screen(c: Candidate, catalogs: VendorCatalog[]): Refusal | { ok: true } {
  const local = localOnly(c);
  if (!local.ok) return local;
  const cat = catalogs.find((x) => x.vendor === c.provider);
  if (!cat) return { ok: false, reason: `no catalog for provider ${c.provider}` };
  if (cat.error) return { ok: false, reason: `${c.provider} unreachable (${cat.error}); not risking a swap` };
  if (!isServed(cat, c.model)) return { ok: false, reason: `${c.model} is not pulled on this Mac's Ollama (run "ollama pull ${c.model}" first)` };
  return { ok: true };
}

/**
 * How many measured prompts Flint could send to `tier`.
 *
 * A candidate is swapped into ONE tier, and Flint picks a tier per message
 * (classifyMessage). A tier no measured prompt is sent to never answers during
 * the measurement: the run scores the incumbent tiers and can only come back as
 * noise. The routine tier takes greetings and one-liners, and on 2026-09-29 none
 * of the 8 measured prompts was one, so `try routine=...` would have spent about
 * $0.50 to learn nothing. A prompt counts if it reaches the tier with or without
 * the tool router's `toolsLikely` (which only ever moves routine to standard),
 * so this never undercounts; /generate sends no history, so turns are 0.
 */
export function tierReach(tier: string, prompts: readonly string[]): { reachable: number; total: number } {
  const reachable = prompts.filter(
    (p) => classifyMessage(p, { toolsLikely: false }) === tier || classifyMessage(p, { toolsLikely: true }) === tier,
  ).length;
  return { reachable, total: prompts.length };
}

/**
 * Keep the candidate only on a real, better signal.
 *
 * `candidate` and `incumbent` are both scored against the SAME frozen baseline,
 * so their win rates are directly comparable. NOISE never promotes: a coin flip
 * that happens to land high is not evidence, and swapping on it would make the
 * config wander.
 */
export function decide(opts: {
  candidate: DailyRow;
  incumbent: DailyRow | undefined;
  /** How much better the candidate must be, in win rate. */
  margin?: number;
  /**
   * How many of the measured answers the candidate itself gave. 0 means the
   * score is the incumbent tiers' and says nothing about the candidate, however
   * it came out; undefined skips the check.
   */
  candidateAnswers?: number;
}): Decision {
  const { candidate, incumbent } = opts;
  const margin = opts.margin ?? 0.05;

  if (opts.candidateAnswers === 0) {
    return { ok: true, action: 'rollback', why: 'no measured answer came from the candidate, so the score is not its own' };
  }

  if (candidate.signal === 'NOISE') {
    return { ok: true, action: 'rollback', why: `candidate scored ${candidate.winRate.toFixed(3)} but the signal is NOISE` };
  }
  if (candidate.signal === 'WORSE') {
    return { ok: true, action: 'rollback', why: `candidate is measurably worse (${candidate.winRate.toFixed(3)})` };
  }
  if (!incumbent) {
    return {
      ok: true,
      action: 'keep',
      why: `candidate is measurably better (${candidate.winRate.toFixed(3)}, ${candidate.signal}) and there is no incumbent score to beat`,
    };
  }
  const gain = candidate.winRate - incumbent.winRate;
  if (gain < margin) {
    return {
      ok: true,
      action: 'rollback',
      why: `candidate ${candidate.winRate.toFixed(3)} vs incumbent ${incumbent.winRate.toFixed(3)}: +${gain.toFixed(3)} is under the ${margin} margin`,
    };
  }
  return {
    ok: true,
    action: 'keep',
    why: `candidate ${candidate.winRate.toFixed(3)} beats incumbent ${incumbent.winRate.toFixed(3)} by ${gain.toFixed(3)} (${candidate.signal})`,
  };
}

/** `hard=ollama:qwen3.8:27b` -> a Candidate (any provider parses; localOnly decides whether it may be tried). */
export function parseCandidate(spec: string): Candidate | undefined {
  const eq = spec.indexOf('=');
  if (eq <= 0) return undefined;
  const tier = spec.slice(0, eq).trim().toLowerCase();
  const rest = spec.slice(eq + 1).trim();
  const colon = rest.indexOf(':');
  if (!tier || colon <= 0 || colon === rest.length - 1) return undefined;
  return { tier, provider: rest.slice(0, colon), model: rest.slice(colon + 1) };
}

/** The env var a tier lives in. */
export function tierEnvVar(tier: string): string {
  return `FLINT_TIER_${tier.toUpperCase()}`;
}
