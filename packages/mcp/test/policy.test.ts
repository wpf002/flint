import { describe, it, expect } from 'vitest';
import { policyApprover } from '../src/index.js';
import type { ApprovalRequest } from '../src/index.js';

function req(over: Partial<ApprovalRequest>): ApprovalRequest {
  return { server: 'vantage', tool: 'add_to_watchlist', args: {}, safety: 'guarded', destructive: false, ...over };
}

describe('policyApprover', () => {
  it('denies everything by default (empty allow-list)', async () => {
    const approve = policyApprover({ allow: [] });
    expect(await approve(req({}))).toBe(false);
  });

  it('approves a whitelisted tool (namespaced or bare)', async () => {
    expect(await policyApprover({ allow: ['vantage.add_to_watchlist'] })(req({}))).toBe(true);
    expect(await policyApprover({ allow: ['add_to_watchlist'] })(req({}))).toBe(true);
  });

  it('supports server.* wildcards', async () => {
    expect(await policyApprover({ allow: ['vantage.*'] })(req({ tool: 'anything' }))).toBe(true);
    expect(await policyApprover({ allow: ['vantage.*'] })(req({ server: 'crossbar', tool: 'x' }))).toBe(false);
  });

  it('NEVER auto-approves destructive actions unless explicitly opted in', async () => {
    const allow = ['vantage.add_to_watchlist'];
    expect(await policyApprover({ allow })(req({ destructive: true }))).toBe(false);
    expect(await policyApprover({ allow, allowDestructive: true })(req({ destructive: true }))).toBe(true);
  });

  it('caps the number of auto-approved actions per run', async () => {
    const approve = policyApprover({ allow: ['vantage.*'], maxActions: 2 });
    expect(await approve(req({}))).toBe(true);
    expect(await approve(req({}))).toBe(true);
    expect(await approve(req({}))).toBe(false); // 3rd blocked
  });
});
