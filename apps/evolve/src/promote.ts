import { isListedModel } from '@flint/core';
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
 * unpriced, unserved, or merely noise loses to the incumbent, because the
 * incumbent is known to work and a bad promotion degrades Flint until someone
 * notices.
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
 * Checks that run BEFORE any money is spent testing a candidate.
 *
 * Unpriced is a hard no: the spend guards price an unlisted model at the
 * pessimistic UNLISTED_PRICE, so promoting one would silently shrink every
 * budget Flint has. Unserved is a hard no because it is the exact failure that
 * put a deprecated gpt-5.2-codex in the live config.
 */
export function screen(c: Candidate, catalogs: VendorCatalog[]): Refusal | { ok: true } {
  const cat = catalogs.find((x) => x.vendor === c.provider);
  if (!cat) return { ok: false, reason: `no catalog for provider ${c.provider}` };
  if (cat.error) return { ok: false, reason: `${c.provider} unreachable (${cat.error}); not risking a swap` };
  if (!isServed(cat, c.model)) return { ok: false, reason: `${c.provider} does not serve ${c.model}` };
  if (!isListedModel(c.model)) {
    return {
      ok: false,
      reason: `${c.model} is not in the price table; promoting it would price every call at the unlisted rate and shrink the spend guards`,
    };
  }
  return { ok: true };
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
}): Decision {
  const { candidate, incumbent } = opts;
  const margin = opts.margin ?? 0.05;

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

/** `hard=openai:gpt-5.6-sol` -> a Candidate. */
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
