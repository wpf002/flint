import { describe, it, expect } from 'vitest';
import {
  resolveTier,
  forbiddenReason,
  patternMatches,
  actionKey,
  CODE_TABLE,
  AUTONOMOUS_ACTIONS,
  SOURCES,
  RUNTIME_CHAT_TOOLS,
  runsInShadow,
  type PolicyRow,
  type TierContext,
  ON_TRACK_COUNTER,
} from '../src/tiers';
import { TAINTED_SOURCES } from '../src/taint';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { GOAL_SIGNED_ACTIONS, P3_ACTIONS, PlanOp, classifyPlanOp } from '../src/goals';
import { FORECAST_SIGNED_ACTIONS, P4_ACTIONS, PREDICT_JOB_ACTIONS, PROPHET_ACTIONS } from '../src/predict';

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
    for (const action of ['audit.delete', 'ledger.prediction.edit', 'world.person.lookup', 'google.calendar.write', 'notify.push_with_content']) {
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

  it('nothing about people, but world.person.create (P2.5: calendar attendees only, at APPROVAL)', () => {
    expect(resolveTier('world.person.lookup', chat).tier).toBe('forbidden');
    expect(resolveTier('x', { ...chat, mcp: mcp('contacts', 'find_people', { readOnlyHint: true }) }).tier).toBe('forbidden');
    // The exemption is the exact name of Flint's own action, never an MCP tool of that name.
    expect(forbiddenReason('world.person.create', {})).toBeUndefined();
    expect(resolveTier('x', { ...chat, mcp: mcp('world', 'person.create') }).tier).toBe('forbidden');
    expect(resolveTier('world.person.create', chat).tier).toBe('approval');
    expect(resolveTier('world.person.create', auto)).toMatchObject({ tier: 'approval', cap: { limit: 20, period: 'day' } });
    for (const a of ['world.person.createAll', 'world.people.create', 'world.person.create_from_mail']) expect(resolveTier(a, chat).tier, a).toBe('forbidden');
  });

  it('Google is read-only: no action of Flint\'s own writes to it, and no policy changes that', () => {
    for (const a of ['google.write', 'google.calendar.insert', 'google.gmail.send']) {
      expect(resolveTier(a, { ...chat, policies: [row(a, 'alone'), row('google.*', 'alone')], now: NOW }).tier, a).toBe('forbidden');
      expect(resolveTier(a, auto).tier, a).toBe('forbidden');
    }
    expect(resolveTier('world.sync.google_calendar', auto).tier).toBe('approval');
  });

  it('Apple Calendar (P2.6) is read-only too; its sync ships at APPROVAL, promotable, and its text is tainted', () => {
    for (const a of ['apple.write', 'apple.calendar.save_event', 'apple.reminders.add']) {
      expect(resolveTier(a, { ...chat, policies: [row(a, 'alone'), row('apple.*', 'alone'), row('*', 'alone')], now: NOW }).tier, a).toBe('forbidden');
      expect(resolveTier(a, auto).tier, a).toBe('forbidden');
    }
    expect(CODE_TABLE['apple.write']).toMatchObject({ tier: 'forbidden', promotable: false });
    expect(SOURCES).toContain('apple_calendar');
    expect(resolveTier('world.sync.apple_calendar', auto)).toMatchObject({ tier: 'approval', rule: 'code' });
    expect(CODE_TABLE['world.sync.apple_calendar']).toMatchObject({ tier: 'approval', promotable: true });
    // Promoted by a signed row, it runs alone; a policy can never reach a write.
    expect(resolveTier('world.sync.apple_calendar', { ...auto, policies: [row('world.sync.apple_calendar', 'alone')], now: NOW }).tier).toBe('alone');
    expect(AUTONOMOUS_ACTIONS.has('world.sync.apple_calendar')).toBe(true);
    expect(TAINTED_SOURCES.has('apple_calendar')).toBe(true);
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
    expect(resolveTier('x', { ...chat, mcp: mcp('runtime', 'list_entities', { readOnlyHint: true }) }).rule).toBe('mcp-trusted-readonly');
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

// Regressions from the PR #37 review.
describe('review fixes', () => {
  it('a tainted turn floors egress on ANY non-internal server (trident.web_search), not just `web`', () => {
    for (const [server, tool] of [['trident', 'web_search'], ['brave-search', 'brave_web_search'], ['trident', 'gdrive_search'], ['newserver', 'get_thing']]) {
      expect(resolveTier('x', { ...chat, tainted: true, mcp: mcp(server!, tool!) }).tier, `${server}.${tool}`).toBe('approval');
    }
    // Internal servers stay as they were for reads.
    expect(resolveTier('x', { ...chat, tainted: true, mcp: mcp('nexus', 'recall', { readOnlyHint: true }) }).tier).toBe('alone');
    expect(resolveTier('x', { ...chat, tainted: true, mcp: mcp('runtime', 'list_entities', { readOnlyHint: true }) }).tier).toBe('alone');
  });

  it('camelCase and joined names cannot dodge the merge, person and NEVER_AUTO rules', () => {
    for (const [server, tool] of [['github', 'mergePullRequest'], ['github', 'automerge'], ['github', 'squashMerge'], ['crm', 'lookupPerson'], ['github', 'getPersonByEmail'], ['broker', 'placeOrder'], ['broker', 'executeTrade']]) {
      const d = resolveTier('x', { ...chat, mcp: mcp(server!, tool!), policies: [row(`mcp:${server}.*`, 'alone')], now: NOW });
      expect(d.tier, `${server}.${tool}`).toBe('forbidden');
    }
  });

  it('a wildcard promotion never reaches a tool that may move money', () => {
    const policies = [row('mcp:hive.*', 'alone'), row('mcp:dex.*', 'alone'), row('mcp:bank.*', 'alone')];
    for (const [server, tool] of [['hive', 'open_position'], ['hive', 'place_trade'], ['hive', 'market_order'], ['dex', 'swap'], ['bank', 'fund_account'], ['hive', 'openPosition']]) {
      expect(resolveTier('x', { ...chat, mcp: mcp(server!, tool!), policies, now: NOW }).tier, `${server}.${tool}`).toBe('approval');
    }
    // An ordinary write on the same server is still promotable.
    expect(resolveTier('x', { ...chat, mcp: mcp('hive', 'restart_worker'), policies, now: NOW }).tier).toBe('alone');
  });

  it('every matching row\'s cap applies, whatever order the rows come in', () => {
    const a = row('world.*', 'alone');
    const b = row('world.entity.write', 'alone', { dailyCap: 5 });
    for (const policies of [[a, b], [b, a]]) {
      expect(resolveTier('world.entity.write', { ...auto, policies, now: NOW }).cap).toEqual({ limit: 5, period: 'day' });
    }
  });

  it('a scoped row promotes only when the caller confirms the call is inside its scope', () => {
    const scoped = [row('mcp:gcal.*', 'alone', { scope: { calendars: ['work'] } })];
    const ctx = { ...chat, mcp: mcp('gcal', 'create_event'), policies: scoped, now: NOW };
    expect(resolveTier('x', ctx).tier).toBe('approval');
    expect(resolveTier('x', { ...ctx, scopeAllows: () => false }).tier).toBe('approval');
    expect(resolveTier('x', { ...ctx, scopeAllows: () => true }).tier).toBe('alone');
    // A scoped row still tightens, in or out of scope.
    expect(resolveTier('calculate', { ...chat, policies: [row('calculate', 'forbidden', { scope: { x: 1 } })], now: NOW }).tier).toBe('forbidden');
  });

  it('any context other than chat or console is held to the autonomous rules', () => {
    const odd = { context: 'job' as unknown as 'chat', tainted: false };
    expect(resolveTier('calculate', odd).tier).toBe('forbidden');
    expect(resolveTier('x', { ...odd, mcp: mcp('nexus', 'recall', { readOnlyHint: true }) }).tier).toBe('forbidden');
  });
});

// Regressions from the verification pass on the review fixes.
describe('review fixes, round 2', () => {
  it('a destructive hint does not make a money tool promotable', () => {
    const d = resolveTier('x', { ...chat, mcp: mcp('hive', 'open_position', { destructiveHint: true }), policies: [row('mcp:hive.*', 'alone')], now: NOW });
    expect(d.tier).toBe('approval');
  });

  it('joined, camelCase and pay_/wire_ money names are forbidden or stay one tap away', () => {
    const policies = [row('mcp:bank.*', 'alone'), row('mcp:shop.*', 'alone'), row('mcp:broker.*', 'alone'), row('mcp:wallet.*', 'alone')];
    for (const [server, tool] of [['bank', 'payNow'], ['bank', 'pay_now'], ['bank', 'paynow'], ['bank', 'pay_bill'], ['bank', 'wireMoney'], ['bank', 'wire_money'], ['shop', 'placeorder'], ['broker', 'closeposition'], ['broker', 'cancelorder'], ['broker', 'modifyorder'], ['bank', 'send_money']]) {
      expect(resolveTier('x', { ...chat, mcp: mcp(server!, tool!), policies, now: NOW }).tier, `${server}.${tool}`).toBe('forbidden');
    }
    for (const [server, tool] of [['wallet', 'send_eth'], ['wallet', 'sendCrypto'], ['bank', 'payload_upload']]) {
      expect(resolveTier('x', { ...chat, mcp: mcp(server!, tool!), policies, now: NOW }).tier, `${server}.${tool}`).toBe('approval');
    }
  });

  it('people in any spelling are forbidden; "personal" is not a person', () => {
    for (const tool of ['findpeople', 'peoplesearch', 'personlookup', 'whoIs', 'getWhoIs', 'WhoIs']) {
      expect(resolveTier('x', { ...chat, mcp: mcp('crm', tool) }).tier, tool).toBe('forbidden');
    }
    expect(resolveTier('x', { ...chat, mcp: mcp('notes', 'list_personal_notes') }).tier).toBe('alone');
  });

  it('an unknown context keeps the taint floor', () => {
    for (const action of ['backup.offsite', 'world.entity.write', 'ledger.prediction.record']) {
      const d = resolveTier(action, { context: 'voice' as unknown as 'chat', tainted: true, policies: [row(action, 'alone')], now: NOW });
      expect(d.tier, action).toBe('approval');
    }
  });

  it('only the merge verb is forbidden: reads of merged PRs and "emergency" are fine', () => {
    expect(resolveTier('x', { ...chat, mcp: mcp('github-observer', 'list_merged_prs', { readOnlyHint: true }) }).tier).toBe('alone');
    // Not forbidden. (isSafeTool's WRITE_TOOL still sees `merge` inside it, so it asks first, as before.)
    expect(resolveTier('x', { ...chat, mcp: mcp('weather', 'get_emergency_alerts') }).tier).toBe('approval');
    expect(resolveTier('x', { ...chat, mcp: mcp('github', 'automerge') }).tier).toBe('forbidden');
    expect(resolveTier('x', { ...chat, mcp: mcp('github', 'merge') }).tier).toBe('forbidden');
  });

  it('nexus.withdraw_handoff is a reviewed NEVER_AUTO exemption: approval, not forbidden', () => {
    expect(resolveTier('x', { ...chat, mcp: mcp('nexus', 'withdraw_handoff') }).tier).toBe('approval');
    expect(resolveTier('x', { ...chat, mcp: mcp('bank', 'withdraw_funds') }).tier).toBe('forbidden');
  });

  it('over-long names are refused, and judging a huge one is fast', () => {
    const huge = 'A'.repeat(65_536);
    const t = Date.now();
    expect(resolveTier('x', { ...chat, mcp: mcp('evil', huge) }).tier).toBe('forbidden');
    expect(resolveTier(huge, chat).tier).toBe('forbidden');
    expect(Date.now() - t).toBeLessThan(200);
  });
});

describe('the runtime\'s own chat tools', () => {
  it('take their code-table entry (APPROVAL until promoted), not the trusted read-only rule', () => {
    const d = resolveTier('runtime.world_now', { ...chat, mcp: mcp('runtime', 'world_now', { readOnlyHint: true }) });
    expect(d).toMatchObject({ tier: 'approval', rule: 'code', key: 'world_now' });
    expect(resolveTier('runtime.world_now', { ...chat, mcp: mcp('runtime', 'world_now', { readOnlyHint: true }), policies: [row('world_now', 'alone')], now: NOW }).tier).toBe('alone');
    expect(resolveTier('runtime.ledger_record_prediction', { ...chat, mcp: mcp('runtime', 'ledger_record_prediction') }).cap).toEqual({ limit: 10, period: 'day' });
    // An unknown runtime tool still goes through the MCP rules.
    expect(resolveTier('runtime.other', { ...chat, mcp: mcp('runtime', 'list_things', { readOnlyHint: true }) }).rule).toBe('mcp-trusted-readonly');
  });

  it('only the connector\'s own tools are mapped: a code-table name on a server called runtime is still an MCP tool', () => {
    // remember is ALONE in code; as a runtime MCP tool it is not.
    const remember = resolveTier('runtime.remember', { ...chat, mcp: mcp('runtime', 'remember', { destructiveHint: true }) });
    expect(remember).toMatchObject({ tier: 'approval', key: 'mcp:runtime.remember' });
    expect(resolveTier('runtime.world.entity.write', { ...chat, mcp: mcp('runtime', 'world.entity.write') }).key).toBe('mcp:runtime.world.entity.write');
    // No MCP tool runs autonomously, the runtime's included.
    expect(resolveTier('runtime.world_now', { context: 'autonomous', tainted: false, mcp: mcp('runtime', 'world_now', { readOnlyHint: true }) }).tier).toBe('forbidden');
    // A destructive hint keeps the MCP rules.
    expect(resolveTier('runtime.ledger_record_prediction', { ...chat, mcp: mcp('runtime', 'ledger_record_prediction', { destructiveHint: true }), policies: [row('ledger_record_prediction', 'alone')], now: NOW }).tier).toBe('approval');
    for (const t of RUNTIME_CHAT_TOOLS) expect(CODE_TABLE).toHaveProperty([t]);
  });
});

describe('P3: goals and plans', () => {
  const consoleCtx: TierContext = { context: 'console', tainted: false };
  const SUGGESTIONS = ['goal.propose', 'world.commitment.from_chat'];

  it('every P3 action ships at APPROVAL, in chat and in the console', () => {
    expect([...P3_ACTIONS].sort()).toEqual([
      'goal.abandon', 'goal.activate', 'goal.criteria_change', 'goal.done', 'goal.horizon_change', 'goal.propose', 'goal.review.local',
      'nexus.remember_goal_decision', 'plan.change', 'world.commitment.from_chat',
    ]);
    for (const a of P3_ACTIONS) {
      expect(CODE_TABLE[a]?.tier, a).toBe('approval');
      for (const ctx of [chat, consoleCtx]) expect(resolveTier(a, ctx), a).toMatchObject({ tier: 'approval', rule: 'code' });
    }
  });

  it('autonomously, only goal.review.local and plan.change may be asked for; every other P3 action is FORBIDDEN', () => {
    for (const a of P3_ACTIONS) {
      const d = resolveTier(a, auto);
      if (a === 'goal.review.local' || a === 'plan.change') expect(d, a).toMatchObject({ tier: 'approval', rule: 'code' });
      else expect(d, a).toMatchObject({ tier: 'forbidden', rule: 'autonomous' });
    }
    expect([...AUTONOMOUS_ACTIONS].filter((a) => (P3_ACTIONS as readonly string[]).includes(a)).sort()).toEqual(['goal.review.local', 'plan.change']);
  });

  it('the six passkey actions and the Nexus write stay APPROVAL, whatever a policy row says; the rest can be promoted', () => {
    const passkey = [...GOAL_SIGNED_ACTIONS, 'nexus.remember_goal_decision'];
    for (const a of passkey) {
      expect(CODE_TABLE[a]!.promotable, a).toBe(false);
      for (const ctx of [chat, consoleCtx, auto]) {
        const d = resolveTier(a, { ...ctx, policies: [row(a, 'alone'), row(`${a.split('.')[0]}.*`, 'alone')], now: NOW });
        expect(d.tier, `${a} ${ctx.context}`).not.toBe('alone');
      }
    }
    expect(resolveTier('goal.review.local', { ...auto, policies: [row('goal.review.local', 'alone', { dailyCap: 20 })], now: NOW })).toMatchObject({ tier: 'alone', cap: { limit: 20, period: 'day' } });
    for (const a of SUGGESTIONS) {
      expect(resolveTier(a, { ...chat, policies: [row(a, 'alone', { dailyCap: 3 })], now: NOW })).toMatchObject({ tier: 'alone', cap: { limit: 3, period: 'day' } });
    }
  });

  it('a review’s onTrack forecast is counted under its own counter, never the ledger’s daily cap, and the table says so', () => {
    // The ledger's cap stands for everyone else.
    expect(CODE_TABLE['ledger.prediction.record']).toMatchObject({ cap: { limit: 50, period: 'day' }, shadow: true });
    // The exemption is written down where the cap is, and its counter is not an action: it has no tier and no cap to claim.
    expect(CODE_TABLE['ledger.prediction.record']!.note).toContain(ON_TRACK_COUNTER);
    expect(ON_TRACK_COUNTER).toBe('goal.on_track');
    expect(CODE_TABLE[ON_TRACK_COUNTER]).toBeUndefined();
    expect(AUTONOMOUS_ACTIONS.has(ON_TRACK_COUNTER)).toBe(false);
    expect(ON_TRACK_COUNTER).not.toBe('ledger.prediction.record');
    // As a name it would never be allowed to run on its own: it is only a counter's key.
    expect(resolveTier(ON_TRACK_COUNTER, { ...auto, policies: [], now: NOW }).tier).toBe('forbidden');
  });

  it('reviews run in shadow under 20 a day; the chat suggestions carry no code cap (claimed even at APPROVAL, it would stall a 4th card)', () => {
    expect(runsInShadow('goal.review.local')).toBe(true);
    expect(CODE_TABLE['goal.review.local']).toMatchObject({ write: false, cap: { limit: 20, period: 'day' } });
    for (const a of [...SUGGESTIONS, ...GOAL_SIGNED_ACTIONS]) {
      expect(CODE_TABLE[a]!.cap, a).toBeUndefined();
      expect(runsInShadow(a), a).toBe(false);
    }
    expect(CODE_TABLE['nexus.remember_goal_decision']!.egress).toBe(true);
  });

  it('no P3 name trips a step-1 rule (NEVER_AUTO, merge, people, policy., selfmod., google., apple.); the console asks a fresh touch for every goal card by its own rule, not by its money words', () => {
    for (const a of P3_ACTIONS) expect(forbiddenReason(a, {}), a).toBeUndefined();
    const html = readFileSync(join(__dirname, '..', '..', '..', 'apps', 'console', 'index.html'), 'utf8');
    // A goal card is never mistaken for money or a deletion: none of its names has those words...
    const words = /function apprAlone\(p\)\{[^]*?\/([^/]+)\/i\.test\(String\(p\.fullName/.exec(html)?.[1];
    expect(words, 'apprAlone in the console').toBeTruthy();
    for (const a of P3_ACTIONS) expect(new RegExp(words!, 'i').test(a), a).toBe(false);
    // ...and yet each one Will signs asks on its own, with a fresh touch, never in Approve All (apprAlone): by its
    // name, and by the consequential mark its card carries. Only a review's small plan change rides Approve All, and
    // which card is one is read from its operations (apprSmallPlan), never from its template's name alone.
    // The panel's own script, whole (its rule reads what a card would show as well as its name), with no page behind it.
    const js = /<script id="approvals-js">([\s\S]*?)<\/script>/.exec(html)![1]!;
    const noop = () => {};
    const el = () => ({ appendChild: noop, classList: { add: noop, remove: noop, toggle: noop }, style: {}, setAttribute: noop });
    const c: Record<string, unknown> = {
      console, setInterval: () => 0, setTimeout: () => 0, BASE: '', TOKEN: '', auth: () => ({}),
      fetch: async () => ({ ok: false, status: 401, json: async () => ({}) }),
      document: { getElementById: () => null, createElement: el, createTextNode: el, querySelectorAll: () => [] },
    };
    createContext(c);
    runInContext(js, c);
    const apprAlone = (p: Record<string, unknown>) => runInContext(`apprAlone(${JSON.stringify(p)})`, c) as boolean;
    for (const a of GOAL_SIGNED_ACTIONS) expect(apprAlone({ fullName: a }), a).toBe(true);
    const status = { op: 'set', key: 's1', from: { title: 'T', status: 'todo' }, to: { status: 'blocked' } };
    expect(apprAlone({ fullName: 'plan.change', templateId: 'plan.diff.minor', consequential: false, args: { ops: [status] } })).toBe(false);
    // The name alone is not enough: a bigger operation under it, or none to read, asks on its own.
    expect(apprAlone({ fullName: 'plan.change', templateId: 'plan.diff.minor', consequential: false })).toBe(true);
    expect(apprAlone({ fullName: 'plan.change', templateId: 'plan.diff.minor', consequential: false, args: { ops: [status, { op: 'add', key: 's9', step: { ordinal: 900, title: 'T', kind: 'will_task' } }] } })).toBe(true);
    // The console's reading agrees with the shared rule on every operation a review may file as small or bigger.
    const step = { kind: 'will_task' as const, status: 'todo' as const, dueAt: '2026-10-14T22:00:00.000Z' };
    const horizon = '2026-12-01T05:59:00.000Z';
    const cases: Array<Record<string, unknown>> = [
      status,
      { op: 'set', key: 's1', from: { title: 'T', status: 'todo' }, to: { status: 'in_progress' } },
      { op: 'set', key: 's1', from: { title: 'T', status: 'todo' }, to: { status: 'skipped' } },
      { op: 'set', key: 's1', from: { title: 'T', dueAt: step.dueAt }, to: { dueAt: '2026-10-20T22:00:00.000Z' } },
      { op: 'set', key: 's1', from: { title: 'T', dueAt: step.dueAt }, to: { dueAt: '2026-10-30T22:00:00.000Z' } },
      { op: 'set', key: 's1', from: { title: 'T', dueAt: step.dueAt }, to: { dueAt: null } },
      { op: 'set', key: 's1', from: { title: 'T', ordinal: 100 }, to: { ordinal: 50 } },
      { op: 'set', key: 's1', from: { title: 'T' }, to: { title: 'Synthetic retitled step' } },
      { op: 'add', key: 's9', step: { ordinal: 900, title: 'T', kind: 'will_task', tier: 'approval', dueAt: null, dependsOn: [] } },
    ];
    for (const op of cases) {
      const shared = classifyPlanOp(PlanOp.parse(op), step, horizon) === 'minor';
      expect(!apprAlone({ fullName: 'plan.change', templateId: 'plan.diff.minor', consequential: false, args: { ops: [op] } }), JSON.stringify(op)).toBe(shared);
    }
    expect(apprAlone({ fullName: 'plan.change', templateId: 'plan.diff.material', consequential: true })).toBe(true);
    expect(apprAlone({ fullName: 'world.source.enable', consequential: true })).toBe(true);
    // The predictions switch asks alone too, by its name, whatever mark its card carries.
    for (const a of FORECAST_SIGNED_ACTIONS) expect(apprAlone({ fullName: a }), a).toBe(true);
    for (const a of ['goal.propose', 'world.commitment.from_chat']) expect(apprAlone({ fullName: a }), a).toBe(false);
  });

  it('no runtime chat tool or server built-in tool shares a P3 name (a same-named tool would run instead of the runtime)', () => {
    const builtins = Object.entries(CODE_TABLE).filter(([, e]) => e.tier === 'alone').map(([n]) => n);
    expect(builtins.sort()).toEqual(['calculate', 'deep_research', 'remember', 'spend_status', 'training_status']);
    for (const a of P3_ACTIONS) {
      expect(RUNTIME_CHAT_TOOLS.has(a), a).toBe(false);
      expect(builtins, a).not.toContain(a);
    }
  });
});

describe('P4: predictions', () => {
  const consoleCtx: TierContext = { context: 'console', tainted: false };
  const SIGNED = [...FORECAST_SIGNED_ACTIONS];
  const OWN = [...PREDICT_JOB_ACTIONS, ...FORECAST_SIGNED_ACTIONS];
  const NO_OUTSIDE = 'Flint forecasts on this Mac and calls no outside forecaster';

  it('every P4 action is in the code table: the five jobs and the on-switch at APPROVAL, with their caps and shadow flags; the outside forecaster\'s names FORBIDDEN', () => {
    expect([...P4_ACTIONS].sort()).toEqual([
      'calibration.note', 'forecast.local', 'forecast.series.build', 'forecast.series.enable', 'ledger.reason.local',
      'ledger.resolve.ask_will', 'prophet.calibration', 'prophet.forecast_adhoc', 'prophet.models',
    ]);
    expect(SIGNED).toEqual(['forecast.series.enable']);
    for (const a of OWN) expect(CODE_TABLE[a]?.tier, a).toBe('approval');
    for (const a of PROPHET_ACTIONS) expect(CODE_TABLE[a], a).toMatchObject({ tier: 'forbidden', promotable: false });
    const facts = (a: string) => ({ shadow: runsInShadow(a), cap: CODE_TABLE[a]!.cap, promotable: CODE_TABLE[a]!.promotable, egress: CODE_TABLE[a]!.egress === true });
    expect(facts('forecast.series.build')).toEqual({ shadow: true, cap: undefined, promotable: true, egress: false });
    expect(facts('forecast.local')).toEqual({ shadow: true, cap: { limit: 50, period: 'day' }, promotable: true, egress: false });
    expect(facts('ledger.reason.local')).toEqual({ shadow: true, cap: { limit: 30, period: 'day' }, promotable: true, egress: false });
    expect(facts('ledger.resolve.ask_will')).toEqual({ shadow: true, cap: { limit: 5, period: 'day' }, promotable: true, egress: false });
    expect(facts('calibration.note')).toEqual({ shadow: true, cap: undefined, promotable: true, egress: false });
    expect(facts('forecast.series.enable')).toEqual({ shadow: false, cap: undefined, promotable: false, egress: false });
    // Nothing P4 adds is marked as sending anything off this Mac, and there is no action that would let a series leave it.
    for (const a of OWN) expect(CODE_TABLE[a]!.egress, a).toBeUndefined();
    expect(Object.keys(CODE_TABLE).filter((a) => /offbox|off_box/i.test(a))).toEqual([]);
  });

  it('in chat and in the console each of Flint\'s own is APPROVAL by the code table', () => {
    for (const a of OWN) {
      for (const ctx of [chat, consoleCtx]) expect(resolveTier(a, ctx), `${a} ${ctx.context}`).toMatchObject({ tier: 'approval', rule: 'code' });
    }
  });

  it('autonomously, only Flint\'s five prediction jobs may be asked for: never the on-switch', () => {
    for (const a of OWN) {
      const d = resolveTier(a, auto);
      if ((PREDICT_JOB_ACTIONS as readonly string[]).includes(a)) expect(d, a).toMatchObject({ tier: 'approval', rule: 'code' });
      else expect(d, a).toMatchObject({ tier: 'forbidden', rule: 'autonomous' });
    }
    expect([...AUTONOMOUS_ACTIONS].filter((a) => (P4_ACTIONS as readonly string[]).includes(a)).sort()).toEqual([...PREDICT_JOB_ACTIONS].sort());
  });

  it('the plan\'s persona.calibration_note is FORBIDDEN by the people rule, so the action is calibration.note; no exemption was added', () => {
    expect(forbiddenReason('persona.calibration_note', {})).toBe('no collection on people');
    for (const ctx of [chat, consoleCtx, auto]) expect(resolveTier('persona.calibration_note', ctx)).toMatchObject({ tier: 'forbidden', rule: 'forbidden' });
    expect(resolveTier('persona.calibration_note', { ...auto, policies: [row('persona.calibration_note', 'alone'), row('persona.*', 'alone')], now: NOW }).tier).toBe('forbidden');
    expect(CODE_TABLE['persona.calibration_note']).toBeUndefined();
    expect(forbiddenReason('calibration.note', {})).toBeUndefined();
    expect(resolveTier('calibration.note', auto)).toMatchObject({ tier: 'approval', rule: 'code' });
    // Only world.person.create is exempt from the people rule, as before.
    expect(forbiddenReason('world.person.create', {})).toBeUndefined();
    expect(forbiddenReason('world.person.lookup', {})).toBe('no collection on people');
  });

  it('Flint calls no outside forecaster: every action of its own under prophet. is FORBIDDEN in step 1, in every context, whatever a policy row says', () => {
    for (const a of [...PROPHET_ACTIONS, 'prophet.forecast', 'prophet.anything_else']) {
      expect(forbiddenReason(a, {}), a).toBe(NO_OUTSIDE);
      for (const ctx of [chat, consoleCtx, auto]) {
        expect(resolveTier(a, ctx), `${a} ${ctx.context}`).toMatchObject({ tier: 'forbidden', rule: 'forbidden', reason: NO_OUTSIDE });
        // No policy row loosens step 1: not the name, not a wildcard.
        expect(resolveTier(a, { ...ctx, policies: [row(a, 'alone'), row('prophet.*', 'alone')], now: NOW }).tier, `${a} ${ctx.context}`).toBe('forbidden');
      }
    }
    for (const a of PROPHET_ACTIONS) expect(AUTONOMOUS_ACTIONS.has(a), a).toBe(false);
    // The rule is for Flint's own actions. A tool some MCP server exposes keeps its own name space and the MCP rules.
    expect(forbiddenReason('prophet.forecast_adhoc', { mcp: mcp('prophet', 'forecast_adhoc') })).toBeUndefined();
    expect(resolveTier('prophet.forecast_adhoc', { ...auto, mcp: mcp('prophet', 'forecast_adhoc') })).toMatchObject({ tier: 'forbidden', rule: 'autonomous' });
  });

  it('no policy row promotes the on-switch, in any context; the five jobs can be promoted, under the lower cap', () => {
    for (const a of SIGNED) {
      expect(CODE_TABLE[a]!.promotable, a).toBe(false);
      for (const ctx of [chat, consoleCtx, auto]) {
        const d = resolveTier(a, { ...ctx, policies: [row(a, 'alone'), row(`${a.split('.')[0]}.*`, 'alone'), row('forecast.series.*', 'alone')], now: NOW });
        expect(d.tier, `${a} ${ctx.context}`).not.toBe('alone');
      }
    }
    expect(resolveTier('forecast.local', { ...auto, policies: [row('forecast.local', 'alone', { dailyCap: 80 })], now: NOW })).toMatchObject({ tier: 'alone', cap: { limit: 50, period: 'day' } });
    expect(resolveTier('ledger.reason.local', { ...auto, policies: [row('ledger.reason.local', 'alone', { dailyCap: 10 })], now: NOW })).toMatchObject({ tier: 'alone', cap: { limit: 10, period: 'day' } });
    expect(resolveTier('ledger.resolve.ask_will', { ...auto, policies: [row('ledger.resolve.ask_will', 'alone', { dailyCap: 5 })], now: NOW })).toMatchObject({ tier: 'alone', cap: { limit: 5, period: 'day' } });
    for (const a of ['forecast.series.build', 'calibration.note']) expect(resolveTier(a, { ...auto, policies: [row(a, 'alone')], now: NOW }).tier, a).toBe('alone');
    // A wildcard over forecast.* promotes the jobs it covers and still not the card.
    const wild = [row('forecast.*', 'alone')];
    expect(resolveTier('forecast.local', { ...auto, policies: wild, now: NOW }).tier).toBe('alone');
    for (const a of SIGNED) expect(resolveTier(a, { ...consoleCtx, policies: wild, now: NOW }).tier, a).toBe('approval');
  });

  it('none of Flint\'s own P4 names trips a step-1 rule (NEVER_AUTO, merge, people, policy., selfmod., google., apple.) or the console\'s money and delete words', () => {
    for (const a of OWN) expect(forbiddenReason(a, {}), a).toBeUndefined();
    // The console keeps a card out of Approve All when its name has a money or delete word (apprAlone).
    const html = readFileSync(join(__dirname, '..', '..', '..', 'apps', 'console', 'index.html'), 'utf8');
    const words = /function apprAlone\(p\)\{[^]*?\/([^/]+)\/i\.test\(String\(p\.fullName/.exec(html)?.[1];
    expect(words, 'apprAlone in the console').toBeTruthy();
    for (const a of OWN) expect(new RegExp(words!, 'i').test(a), a).toBe(false);
  });

  it('no runtime chat tool or server built-in tool shares a P4 name', () => {
    const builtins = Object.entries(CODE_TABLE).filter(([, e]) => e.tier === 'alone').map(([n]) => n);
    for (const a of P4_ACTIONS) {
      expect(RUNTIME_CHAT_TOOLS.has(a), a).toBe(false);
      expect(builtins, a).not.toContain(a);
    }
  });

  it('P1\'s three ledger housekeeping actions run in shadow at APPROVAL, now that code runs them (P4 part 2): Flint\'s own rows, nothing delivered', () => {
    for (const a of ['ledger.resolve.auto', 'ledger.expire', 'ledger.calibration.snapshot']) {
      expect(CODE_TABLE[a], a).toMatchObject({ tier: 'approval', promotable: true, shadow: true });
      expect(CODE_TABLE[a]!.cap, a).toBeUndefined();
      expect(CODE_TABLE[a]!.egress, a).not.toBe(true);
      expect(runsInShadow(a), a).toBe(true);
      expect(AUTONOMOUS_ACTIONS.has(a), a).toBe(true);
      // A job may run them: APPROVAL in shadow from an autonomous context, ALONE once a policy row promotes them.
      expect(resolveTier(a, { ...auto, now: NOW }).tier, a).toBe('approval');
      expect(resolveTier(a, { ...auto, policies: [row(a, 'alone')], now: NOW }).tier, a).toBe('alone');
      // A rule may still forbid one, and then it does not run at all.
      expect(resolveTier(a, { ...auto, policies: [row(a, 'forbidden')], now: NOW }).tier, a).toBe('forbidden');
    }
    // What needs Will's signature stays out of shadow: voiding a prediction and correcting a result.
    for (const a of ['ledger.void', 'ledger.resolution.correct']) {
      expect(CODE_TABLE[a], a).toMatchObject({ tier: 'approval', promotable: false });
      expect(runsInShadow(a), a).toBe(false);
    }
  });
});
