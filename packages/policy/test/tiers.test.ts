import { describe, it, expect } from 'vitest';
import {
  resolveTier,
  forbiddenReason,
  patternMatches,
  actionKey,
  CODE_TABLE,
  AUTONOMOUS_ACTIONS,
  SOURCES,
  type PolicyRow,
  type TierContext,
} from '../src/tiers';

const chat: TierContext = { context: 'chat', tainted: false };
const auto: TierContext = { context: 'autonomous', tainted: false };
const NOW = new Date('2026-10-01T12:00:00Z');
const row = (pattern: string, tier: PolicyRow['tier'], extra: Partial<PolicyRow> = {}): PolicyRow => ({
  pattern,
  tier,
  active: true,
  expiresAt: '2027-03-30T00:00:00Z',
  ...extra,
});
const mcp = (server: string, tool: string, hints: { readOnlyHint?: boolean; destructiveHint?: boolean } = {}) => ({ server, tool, ...hints });

describe('step 1: forbidden in code', () => {
  it('a dangerous word in the NAMESPACE is forbidden (execute.trade)', () => {
    const d = resolveTier('x', { ...chat, mcp: mcp('execute', 'trade') });
    expect(d.tier).toBe('forbidden');
    expect(d.rule).toBe('forbidden');
  });

  it('NEVER_AUTO names are forbidden even with readOnlyHint from a trusted server', () => {
    expect(resolveTier('x', { ...chat, mcp: mcp('nexus', 'submit_order', { readOnlyHint: true }) }).tier).toBe('forbidden');
  });

  it('an ActionPolicy cannot loosen a FORBIDDEN action', () => {
    for (const action of ['audit.delete', 'ledger.prediction.edit', 'world.person.create', 'notify.push_with_content']) {
      const d = resolveTier(action, { ...chat, policies: [row(action, 'alone'), row('*', 'alone')], now: NOW });
      expect(d.tier, action).toBe('forbidden');
    }
    const t = resolveTier('x', { ...chat, mcp: mcp('broker', 'buy'), policies: [row('mcp:broker.*', 'alone')], now: NOW });
    expect(t.tier).toBe('forbidden');
  });

  it('Flint never merges; joining two world entities is the one exception', () => {
    expect(resolveTier('selfmod.merge', chat).tier).toBe('forbidden');
    expect(resolveTier('x', { ...chat, mcp: mcp('github', 'merge_pull_request') }).tier).toBe('forbidden');
    expect(resolveTier('world.entity.merge', chat).tier).toBe('approval');
  });

  it('trading pools are forbidden', () => {
    expect(resolveTier('assets.dispatch', { ...chat, pool: 'crypto-trading' }).tier).toBe('forbidden');
    expect(resolveTier('assets.dispatch', { ...chat, pool: 'research' }).tier).toBe('approval');
  });

  it('policy changes only through policy.change, which is never promotable', () => {
    expect(resolveTier('policy.write', chat).tier).toBe('forbidden');
    expect(resolveTier('policy.change', chat).tier).toBe('approval');
    expect(resolveTier('policy.change', { ...chat, policies: [row('policy.change', 'alone')], now: NOW }).tier).toBe('approval');
  });

  it('self-modification must name its files, all inside the allowlist', () => {
    expect(resolveTier('selfmod.open_pr', chat).tier).toBe('forbidden');
    expect(resolveTier('selfmod.open_pr', { ...chat, paths: ['packages/mcp/connectors/web-server.ts'] }).tier).toBe('approval');
    const d = resolveTier('selfmod.open_pr', { ...chat, paths: ['packages/mcp/connectors/web-server.ts', 'packages/policy/src/tiers.ts'] });
    expect(d.tier).toBe('forbidden');
    expect(d.reason).toMatch(/packages\/policy\/src\/tiers\.ts/);
    expect(resolveTier('selfmod.comment_on_own_pr', chat).tier).toBe('approval');
    expect(resolveTier('selfmod.force_push', chat).tier).toBe('forbidden');
  });

  it('nothing about people', () => {
    expect(resolveTier('world.person.lookup', chat).tier).toBe('forbidden');
    expect(resolveTier('x', { ...chat, mcp: mcp('contacts', 'find_people', { readOnlyHint: true }) }).tier).toBe('forbidden');
    expect(forbiddenReason('world.person.create', {})).toMatch(/forbidden|people/);
  });
});

describe('step 2: context', () => {
  it('no MCP tool runs autonomously, even a trusted read-only one', () => {
    const d = resolveTier('x', { ...auto, mcp: mcp('nexus', 'recall', { readOnlyHint: true }) });
    expect(d.tier).toBe('forbidden');
    expect(d.rule).toBe('autonomous');
  });

  it('an autonomous context runs only the closed list, and a policy cannot widen it', () => {
    expect(resolveTier('calculate', auto).tier).toBe('forbidden');
    expect(resolveTier('remember', { ...auto, policies: [row('remember', 'alone')], now: NOW }).tier).toBe('forbidden');
    for (const a of AUTONOMOUS_ACTIONS) expect(resolveTier(a, auto).tier, a).toBe('approval');
  });

  it('a tainted chat turn moves egress to APPROVAL (web.fetch_url, deep_research)', () => {
    const fetchUrl = { ...chat, mcp: mcp('web', 'fetch_url', { readOnlyHint: true }) };
    expect(resolveTier('x', fetchUrl).tier).toBe('alone');
    const d = resolveTier('x', { ...fetchUrl, tainted: true });
    expect(d.tier).toBe('approval');
    expect(d.rule).toBe('tainted');
    expect(resolveTier('deep_research', chat).tier).toBe('alone');
    expect(resolveTier('deep_research', { ...chat, tainted: true }).tier).toBe('approval');
    expect(resolveTier('x', { ...chat, tainted: true, mcp: mcp('trident', 'api_fetch') }).tier).toBe('approval');
  });

  it('a tainted turn moves writes to APPROVAL (remember), and a policy cannot lift that floor', () => {
    expect(resolveTier('remember', chat).tier).toBe('alone');
    expect(resolveTier('remember', { ...chat, tainted: true }).tier).toBe('approval');
    const promoted = { ...chat, tainted: true, policies: [row('world_entity', 'alone')], now: NOW };
    expect(resolveTier('world_entity', { ...promoted, tainted: false }).tier).toBe('alone');
    // world_entity is a read and not egress: the taint floor leaves it alone.
    expect(resolveTier('world_entity', promoted).tier).toBe('alone');
    const rec = { ...chat, tainted: true, policies: [row('ledger_record_prediction', 'alone')], now: NOW };
    expect(resolveTier('ledger_record_prediction', rec).tier).toBe('approval');
  });

  it('tainted reads that stay on the box are not floored', () => {
    expect(resolveTier('calculate', { ...chat, tainted: true }).tier).toBe('alone');
    expect(resolveTier('x', { ...chat, tainted: true, mcp: mcp('nexus', 'recall', { readOnlyHint: true }) }).tier).toBe('alone');
  });

  it('personal or financial data headed off the box needs approval', () => {
    const ctx = { ...chat, sensitivity: 'personal' as const, mcp: mcp('web', 'web_search', { readOnlyHint: true }) };
    expect(resolveTier('x', ctx).tier).toBe('approval');
    expect(resolveTier('x', { ...ctx, sensitivity: 'ops' }).tier).toBe('alone');
  });
});

describe('step 3: ActionPolicy rows', () => {
  it('promote a promotable APPROVAL entry, with the lower cap', () => {
    const d = resolveTier('ledger.prediction.record', { ...auto, policies: [row('ledger.*', 'alone', { dailyCap: 20 })], now: NOW });
    expect(d).toMatchObject({ tier: 'alone', rule: 'policy', policyPattern: 'ledger.*', cap: { limit: 20, period: 'day' } });
    const wide = resolveTier('ledger.prediction.record', { ...auto, policies: [row('ledger.prediction.record', 'alone', { dailyCap: 500 })], now: NOW });
    expect(wide.cap).toEqual({ limit: 50, period: 'day' });
  });

  it('do not promote entries that stay APPROVAL (passkey)', () => {
    for (const a of ['world.forget', 'world.entity.merge', 'ledger.void', 'ledger.resolution.correct', 'world.source.enable']) {
      expect(resolveTier(a, { ...chat, policies: [row(a, 'alone')], now: NOW }).tier, a).toBe('approval');
    }
  });

  it('ignore inactive and expired rows', () => {
    const a = 'world.sync.github';
    expect(resolveTier(a, { ...auto, policies: [row(a, 'alone', { active: false })], now: NOW }).tier).toBe('approval');
    expect(resolveTier(a, { ...auto, policies: [row(a, 'alone', { expiresAt: '2026-09-30T00:00:00Z' })], now: NOW }).tier).toBe('approval');
    expect(resolveTier(a, { ...auto, policies: [row(a, 'alone')], now: NOW }).tier).toBe('alone');
  });

  it('may always tighten, and the tightest row wins', () => {
    expect(resolveTier('calculate', { ...chat, policies: [row('calculate', 'forbidden')], now: NOW }).tier).toBe('forbidden');
    const both = [row('world.sync.*', 'alone'), row('world.sync.github', 'approval')];
    expect(resolveTier('world.sync.github', { ...auto, policies: both, now: NOW }).tier).toBe('approval');
    expect(resolveTier('world.sync.git', { ...auto, policies: both, now: NOW }).tier).toBe('alone');
  });

  it('match MCP tools only under the mcp: key, so a server cannot borrow a code-table promotion', () => {
    const policies = [row('ledger.*', 'alone')];
    const d = resolveTier('ledger.void', { ...chat, mcp: mcp('ledger', 'void'), policies, now: NOW });
    expect(d.key).toBe('mcp:ledger.void');
    expect(d.tier).toBe('approval');
    expect(resolveTier('x', { ...chat, mcp: mcp('gcal', 'create_event'), policies: [row('mcp:gcal.*', 'alone')], now: NOW }).tier).toBe('alone');
  });

  it('pattern matching is exact or prefix.*, never a bare wildcard', () => {
    expect(patternMatches('*', 'calculate')).toBe(false);
    expect(patternMatches('.*', 'x')).toBe(false);
    expect(patternMatches('world.sync.*', 'world.sync.git')).toBe(true);
    expect(patternMatches('world.sync.*', 'world.synchronise')).toBe(false);
    expect(patternMatches('world.sync', 'world.sync.git')).toBe(false);
    expect(actionKey('a', mcp('s', 't'))).toBe('mcp:s.t');
  });
});

describe('steps 4 to 6', () => {
  it('every entry the Machine plan adds is APPROVAL or FORBIDDEN', () => {
    const existing = new Set(['calculate', 'spend_status', 'training_status', 'remember', 'deep_research']);
    for (const [name, e] of Object.entries(CODE_TABLE)) {
      if (existing.has(name)) continue;
      expect(['approval', 'forbidden'], name).toContain(e.tier);
    }
    for (const s of SOURCES) expect(CODE_TABLE[`world.sync.${s}`]?.tier).toBe('approval');
  });

  it('caps come from the table', () => {
    expect(resolveTier('restore.drill', auto).cap).toEqual({ limit: 1, period: 'week' });
    expect(resolveTier('ledger_record_prediction', chat).cap).toEqual({ limit: 10, period: 'day' });
  });

  it('readOnlyHint from an untrusted server is ignored', () => {
    const d = resolveTier('x', { ...chat, mcp: mcp('random', 'wipe_disk', { readOnlyHint: true }) });
    expect(d.tier).toBe('approval');
    expect(resolveTier('x', { ...chat, mcp: mcp('random', 'list_items', { readOnlyHint: true }) }).rule).toBe('mcp-safe-name');
    expect(resolveTier('x', { ...chat, mcp: mcp('runtime', 'world_now', { readOnlyHint: true }) }).rule).toBe('mcp-trusted-readonly');
  });

  it('a destructive hint always needs approval', () => {
    expect(resolveTier('x', { ...chat, mcp: mcp('nexus', 'list_and_purge', { readOnlyHint: true, destructiveHint: true }) }).tier).toBe('approval');
  });

  it('unknown actions need approval', () => {
    const d = resolveTier('frobnicate', chat);
    expect(d).toMatchObject({ tier: 'approval', rule: 'unknown' });
    expect(resolveTier('frobnicate', { ...chat, policies: [row('frobnicate', 'alone')], now: NOW }).tier).toBe('approval');
  });
});
