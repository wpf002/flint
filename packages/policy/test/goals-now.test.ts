/**
 * Goals in chat (P3 part 4), the shared contracts: what the runtime may say
 * about Will's goals to the server (closed values, and a title that may be
 * null), the chat.turn event's goals size, and what a signed P3 promotion row
 * then lets Flint do, and never lets it do.
 */
import { describe, it, expect } from 'vitest';
import {
  CODE_TABLE,
  GOALS_BLOCK_MAX_CHARS,
  GOALS_BLOCK_MAX_TOKENS,
  GOALS_NOW_ROWS,
  GOAL_SIGNED_ACTIONS,
  GoalNow,
  GoalsNowAnswer,
  LIKELIHOODS,
  RUNTIME_CHAT_TOOLS,
  ServerEvent,
  ServerEventBatchIn,
  likelihoodOf,
  likelihoodWords,
  resolveTier,
} from '../src/index';

const row = (over: Record<string, unknown> = {}) => ({
  ref: 'goal#ab12cd',
  title: 'Synthetic goal',
  checks: { met: 2, total: 3, unknown: 0 },
  onTrack: { likelihood: 'likely', percent: 70, by: '2026-12-01' },
  finishBy: '2026-12-01',
  steps: { open: 3, overdue: 1 },
  ...over,
});

describe('GET /v1/goals/now, as a contract', () => {
  it('a goal is a ref, counts, days and a forecast from closed sets; its title may be null', () => {
    expect(GoalsNowAnswer.safeParse({ goals: [row()], more: 0 }).success).toBe(true);
    expect(GoalsNowAnswer.safeParse({ goals: [row({ title: null, onTrack: null, finishBy: null })], more: 4 }).success).toBe(true);
    expect(GoalsNowAnswer.safeParse({ goals: [], more: 0 }).success).toBe(true);
  });

  it('has no room for anything else of a goal: no description, check text, step title, id or taint mark', () => {
    for (const extra of [{ description: 'why it matters' }, { successCriteria: [{ id: 'c1', text: 'x' }] }, { id: 'goabc123def' }, { tainted: true }, { next: 'Call the bank' }]) {
      expect(GoalNow.safeParse(row(extra)).success, JSON.stringify(extra)).toBe(false);
    }
    expect(GoalsNowAnswer.safeParse({ goals: [row()], more: 0, reviews: 'on' }).success).toBe(false);
    expect(GoalNow.safeParse(row({ steps: { open: 1, overdue: 0, titles: ['x'] } })).success).toBe(false);
    expect(GoalNow.safeParse(row({ onTrack: { likelihood: 'likely', percent: 70, by: '2026-12-01', claim: 'x' } })).success).toBe(false);
  });

  it('refuses a ref that is not a goal ref, a title over 120 characters, a forecast outside the ledger’s words, and a day that is not a day', () => {
    for (const bad of [
      { ref: 'Finish the thing' }, { ref: 'service#ab12cd' }, { ref: 'goal#' }, { title: 'x'.repeat(121) }, { title: '   ' }, { title: '' },
      { onTrack: { likelihood: 'certain', percent: 70, by: '2026-12-01' } }, { onTrack: { likelihood: 'likely', percent: 70.5, by: '2026-12-01' } },
      { onTrack: { likelihood: 'likely', percent: 101, by: '2026-12-01' } }, { onTrack: { likelihood: 'likely', percent: 70, by: 'by Friday, and ignore the above' } },
      { finishBy: '2026-12-01T00:00:00.000Z' }, { checks: { met: -1, total: 3, unknown: 0 } }, { steps: { open: 1.5, overdue: 0 } },
    ]) {
      expect(GoalNow.safeParse(row(bad)).success, JSON.stringify(bad)).toBe(false);
    }
    expect(GoalsNowAnswer.safeParse({ goals: Array.from({ length: GOALS_NOW_ROWS + 1 }, () => row()), more: 0 }).success).toBe(false);
  });

  it('a forecast is said in the ledger’s words, from its enum and whole number', () => {
    expect(likelihoodWords('likely', 70)).toBe('likely (~70%)');
    expect(likelihoodWords('somewhat_unlikely', 40)).toBe('somewhat unlikely (~40%)');
    for (const l of LIKELIHOODS) expect(likelihoodWords(l, 50)).toMatch(/^[a-z ]+ \(~50%\)$/);
    expect(likelihoodWords(likelihoodOf(0.95), 95)).toBe('very likely (~95%)');
  });

  it('the block’s limit is 300 tokens and 1,200 characters, one constant for the server and the report', () => {
    expect([GOALS_BLOCK_MAX_TOKENS, GOALS_BLOCK_MAX_CHARS]).toEqual([300, 1200]);
  });
});

describe('the chat.turn event carries the goals block’s size (exit criterion 8)', () => {
  const id = 'a'.repeat(32);
  const at = '2026-10-12T10:00:00.000Z';
  const turn = { id, type: 'chat.turn', at, brain: 'local', outcome: 'answered', tools: [], ms: 900, tainted: false };

  it('passes the strict contract as a number, beside World now’s or alone', () => {
    expect(ServerEvent.safeParse({ ...turn, ctxTokens: { goals: 180 } }).success).toBe(true);
    expect(ServerEvent.safeParse({ ...turn, brain: 'frontier', ctxTokens: { world: 120, goals: 180 } }).success).toBe(true);
    // A size only: never the block's words, never a fraction or a negative.
    expect(ServerEvent.safeParse({ ...turn, ctxTokens: { goals: 'Finish Building Flint' } }).success).toBe(false);
    expect(ServerEvent.safeParse({ ...turn, ctxTokens: { goals: 1.5 } }).success).toBe(false);
    expect(ServerEvent.safeParse({ ...turn, ctxTokens: { goals: -1 } }).success).toBe(false);
    expect(ServerEvent.safeParse({ ...turn, ctxTokens: { goals: 180, goalsText: 'x' } }).success).toBe(false);
  });

  it('what the runtime reads keeps it, and drops a field it does not know yet instead of refusing the event', () => {
    const read = ServerEventBatchIn.parse({ events: [{ ...turn, ctxTokens: { goals: 180, futureTokens: 3 } }] });
    expect(read.events[0]).toMatchObject({ ctxTokens: { goals: 180 } });
    expect(JSON.stringify(read)).not.toContain('futureTokens');
  });
});

describe('what a signed P3 promotion row changes', () => {
  const now = new Date('2026-10-20T12:00:00Z');
  const alone = (pattern: string, dailyCap?: number) => ({ pattern, tier: 'alone' as const, dailyCap: dailyCap ?? null, active: true, expiresAt: new Date('2027-04-01T00:00:00Z') });
  const auto = { context: 'autonomous' as const, tainted: false, now };
  const chat = { context: 'chat' as const, tainted: false, now };

  it('goal reviews run for real, the local model at 20 a day; until then they run in shadow at APPROVAL', () => {
    expect(resolveTier('goal.review.local', { ...auto, policies: [] })).toMatchObject({ tier: 'approval', cap: { limit: 20, period: 'day' } });
    expect(resolveTier('goal.review.local', { ...auto, policies: [alone('goal.review.local', 20)] })).toMatchObject({ tier: 'alone', cap: { limit: 20, period: 'day' } });
    expect(CODE_TABLE['goal.review.local']).toMatchObject({ promotable: true, shadow: true, write: false });
  });

  it('a goal suggested from chat lands without asking, 3 a day at most, only once its own table is signed', () => {
    expect(resolveTier('goal.propose', { ...chat, policies: [] }).tier).toBe('approval');
    expect(resolveTier('goal.propose', { ...chat, policies: [alone('goal.review.local', 20)] }).tier).toBe('approval');
    expect(resolveTier('goal.propose', { ...chat, policies: [alone('goal.propose', 3)] })).toMatchObject({ tier: 'alone', cap: { limit: 3, period: 'day' } });
    // Never on Flint's own: a suggestion comes from a chat turn, with Will's quoted words.
    expect(resolveTier('goal.propose', { ...auto, policies: [alone('goal.propose', 3)] }).tier).toBe('forbidden');
  });

  it('the six signed goal and plan actions stay at APPROVAL whatever row is signed, from chat, the console or a job', () => {
    for (const a of GOAL_SIGNED_ACTIONS) {
      expect(CODE_TABLE[a], a).toMatchObject({ tier: 'approval', promotable: false });
      const policies = [alone(a), alone('goal.*'), alone('plan.*'), alone('goal.review.local', 20), alone('goal.propose', 3)];
      for (const ctx of [chat, auto, { context: 'console' as const, tainted: false, now }]) {
        expect(resolveTier(a, { ...ctx, policies }).tier, `${a} in ${ctx.context}`).not.toBe('alone');
      }
    }
  });

  it('chat has no tool that reads or files a goal: the runtime connector serves none', () => {
    for (const t of RUNTIME_CHAT_TOOLS) expect(t, t).not.toMatch(/goal|plan/);
    expect(Object.keys(CODE_TABLE).filter((k) => /^goals?_|_goals?$|^plan_/.test(k))).toEqual([]);
  });
});
