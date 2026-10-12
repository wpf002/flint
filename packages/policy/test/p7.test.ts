/**
 * P7: replacing the production database with a backup (`restore.production`)
 * is Will's alone. APPROVAL in code for him at the keyboard, never promotable,
 * forbidden from chat, and not an autonomous action: Flint on its own is refused it whatever a
 * policy row says. The scratch restore drill keeps its own, promotable entry.
 */
import { describe, it, expect } from 'vitest';
import { resolveTier, forbiddenReason, CODE_TABLE, AUTONOMOUS_ACTIONS, CONSOLE_ONLY, type PolicyRow, type TierContext } from '../src/tiers';

const chat: TierContext = { context: 'chat', tainted: false };
const auto: TierContext = { context: 'autonomous', tainted: false };
const NOW = new Date('2026-10-01T12:00:00Z');
const row = (pattern: string, tier: PolicyRow['tier']): PolicyRow => ({ pattern, tier, active: true, expiresAt: '2027-03-30T00:00:00Z' });

describe('P7: restoring the production database', () => {
  const consoleCtx: TierContext = { context: 'console', tainted: false };

  it('is APPROVAL in code for Will at the keyboard, and never ALONE whatever a policy row says', () => {
    expect(CODE_TABLE['restore.production']).toMatchObject({ tier: 'approval', promotable: false, write: true });
    expect(resolveTier('restore.production', consoleCtx)).toMatchObject({ tier: 'approval', rule: 'code' });
    const promoted = resolveTier('restore.production', { ...consoleCtx, policies: [row('restore.production', 'alone'), row('restore.*', 'alone')], now: NOW });
    expect(promoted.tier).toBe('approval');
  });

  it('a row of Will\'s own that forbids it is honoured, at the keyboard too', () => {
    for (const pattern of ['restore.production', 'restore.*']) {
      expect(resolveTier('restore.production', { ...consoleCtx, policies: [row(pattern, 'forbidden')], now: NOW })).toMatchObject({ tier: 'forbidden', rule: 'policy' });
    }
    // One that has expired, or was switched off, no longer does.
    expect(resolveTier('restore.production', { ...consoleCtx, policies: [{ ...row('restore.*', 'forbidden'), active: false }], now: NOW }).tier).toBe('approval');
    expect(resolveTier('restore.production', { ...consoleCtx, policies: [{ ...row('restore.*', 'forbidden'), expiresAt: '2026-09-30T00:00:00Z' }], now: NOW }).tier).toBe('approval');
  });

  it('is FORBIDDEN from chat: nothing but the command Will runs himself may even ask for it', () => {
    expect(CONSOLE_ONLY.has('restore.production')).toBe(true);
    expect(resolveTier('restore.production', chat)).toMatchObject({ tier: 'forbidden', rule: 'forbidden' });
    expect(resolveTier('restore.production', { ...chat, policies: [row('restore.*', 'alone')], now: NOW }).tier).toBe('forbidden');
    // The drill, which only ever touches a scratch database, is not console-only.
    expect(CONSOLE_ONLY.has('restore.drill')).toBe(false);
    expect(resolveTier('restore.drill', chat).tier).toBe('approval');
  });

  it('is FORBIDDEN for Flint on its own: it is not an autonomous action, and a promotion does not make it one', () => {
    expect(AUTONOMOUS_ACTIONS.has('restore.production')).toBe(false);
    expect(resolveTier('restore.production', auto).tier).toBe('forbidden');
    expect(resolveTier('restore.production', { ...auto, policies: [row('restore.*', 'alone')], now: NOW }).tier).toBe('forbidden');
    // Any context that is not exactly console is refused.
    expect(resolveTier('restore.production', { context: 'deploy' as TierContext['context'], tainted: false }).tier).toBe('forbidden');
  });

  it('the scratch restore drill keeps its own entry: promoting it never reaches production', () => {
    expect(resolveTier('restore.drill', { ...auto, policies: [row('restore.*', 'alone')], now: NOW }).tier).toBe('alone');
    expect(resolveTier('restore.production', { ...consoleCtx, policies: [row('restore.*', 'alone')], now: NOW }).tier).toBe('approval');
    expect(forbiddenReason('restore.production', {})).toBeUndefined();
  });
});
