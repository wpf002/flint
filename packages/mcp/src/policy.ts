import type { Approver, ApprovalRequest } from './types.js';

/**
 * Autonomy policy for UNATTENDED runs (e.g. an overnight task). This is the
 * guardrail that makes "do it while I sleep" safe: instead of a human approving
 * each action, you pre-authorize a WHITELIST of specific reversible tools. The
 * approver auto-approves only those; everything else is refused and surfaces for
 * morning review. Default = allow nothing (deny-all): autonomy is opt-in,
 * per-tool.
 *
 * This implements the roadmap's ceiling — autonomous on reversible steps,
 * human-in-loop on the rest — as code.
 */
export interface AutonomyPolicy {
  /**
   * Tools that may run unattended. Each entry matches either the namespaced
   * name `server.tool`, the bare `tool`, or a `server.*` prefix.
   * Example: ['vantage.add_to_watchlist', 'meridian.*'].
   */
  allow: string[];
  /**
   * Allow auto-approving tools the server flagged `destructiveHint: true`.
   * Default false — destructive actions are NEVER auto-approved, even if listed.
   */
  allowDestructive?: boolean;
  /** Hard cap on auto-approved actions per run (runaway guard). Default 25. */
  maxActions?: number;
}

/**
 * Build an Approver from a policy. Read-only tools never reach this (the gate
 * runs them freely); this only governs side-effecting tools in unattended runs.
 */
export function policyApprover(policy: AutonomyPolicy): Approver {
  const max = policy.maxActions ?? 25;
  let approved = 0;

  return (req: ApprovalRequest): boolean => {
    // Never auto-approve destructive actions unless explicitly opted in.
    if (req.destructive && !policy.allowDestructive) return false;
    if (approved >= max) return false;

    const full = `${req.server}.${req.tool}`;
    const allowed = policy.allow.some(
      (p) => p === full || p === req.tool || (p.endsWith('.*') && full.startsWith(p.slice(0, -1))),
    );
    if (allowed) {
      approved++;
      return true;
    }
    return false;
  };
}
