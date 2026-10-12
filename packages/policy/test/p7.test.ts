/**
 * P7: replacing the production database with a backup (`restore.production`)
 * is Will's alone. APPROVAL in code for him at the keyboard, never promotable,
 * and not an autonomous action: Flint on its own is refused it whatever a
 * policy row says. The scratch restore drill keeps its own, promotable entry.
 */
import { describe, it, expect } from 'vitest';
import { resolveTier, forbiddenReason, CODE_TABLE, AUTONOMOUS_ACTIONS, type PolicyRow, type TierContext } from '../src/tiers';

const chat: TierContext = { context: 'chat', tainted: false };
const auto: TierContext = { context: 'autonomous', tainted: false };
const NOW = new Date('2026-10-01T12:00:00Z');
const row = (pattern: string, tier: PolicyRow['tier']): PolicyRow => ({ pattern, tier, active: true, expiresAt: '2027-03-30T00:00:00Z' });

describe('P7: restoring the production database', () => {
  const consoleCtx: TierContext = { context: 'console', tainted: false };

  it('is APPROVAL in code for Will at the keyboard, and never ALONE whatever a policy row says', () => {
    expect(CODE_TABLE['restore.production']).toMatchObject({ tier: 'approval', promotable: false, write: true });
    for (const ctx of [chat, consoleCtx]) {
      expect(resolveTier('restore.production', ctx)).toMatchObject({ tier: 'approval', rule: 'code' });
      const promoted = resolveTier('restore.production', { ...ctx, policies: [row('restore.production', 'alone'), row('restore.*', 'alone')], now: NOW });
      expect(promoted.tier, ctx.context).toBe('approval');
    }
  });

  it('is FORBIDDEN for Flint on its own: it is not an autonomous action, and a promotion does not make it one', () => {
    expect(AUTONOMOUS_ACTIONS.has('restore.production')).toBe(false);
    expect(resolveTier('restore.production', auto)).toMatchObject({ tier: 'forbidden', rule: 'autonomous' });
    expect(resolveTier('restore.production', { ...auto, policies: [row('restore.*', 'alone')], now: NOW }).tier).toBe('forbidden');
    // Any context that is not exactly chat or console is treated as autonomous.
    expect(resolveTier('restore.production', { context: 'deploy' as TierContext['context'], tainted: false }).tier).toBe('forbidden');
  });

  it('the scratch restore drill keeps its own entry: promoting it never reaches production', () => {
    expect(resolveTier('restore.drill', { ...auto, policies: [row('restore.*', 'alone')], now: NOW }).tier).toBe('alone');
    expect(resolveTier('restore.production', { ...consoleCtx, policies: [row('restore.*', 'alone')], now: NOW }).tier).toBe('approval');
    expect(forbiddenReason('restore.production', {})).toBeUndefined();
  });
});
