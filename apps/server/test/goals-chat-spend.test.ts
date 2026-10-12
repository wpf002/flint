/**
 * The goals block in the chat-spend report (P3 exit criterion 8): its size, in
 * estimated tokens, on the turn's `[route]` line and in the chat.turn event the
 * runtime rolls up each day. A size only, at most 300, and only on a turn whose
 * last-asked brain was given Will's goals. Never a word of them.
 */
import { describe, it, expect } from 'vitest';
import { ChatTurnEvent, GOALS_BLOCK_MAX_TOKENS, ServerEvent } from '@flint/policy';
import { GOALS_NOW_MAX_TOKENS, GoalsNow, renderGoals } from '../src/goals-now';
import { routeLine, type RouteRecord } from '../src/route-log';
import { chatTurnEvent } from '../src/runtime-events';
import { estimateTokens } from '../src/world-now';

const CANARY = 'CANARY-p3spend';
const rec: RouteRecord = { path: 'chat', tier: 'routine', appended: [], turns: 1, brain: 'local', answeredBy: 'qwen2.5:14b', outcome: 'answered', ms: 900 };
const parse = (line: string) => JSON.parse(line.slice('[route] '.length)) as Record<string, unknown>;
const goal = (n: number) => ({
  ref: `goal#g${String(n).padStart(5, '0')}`, title: `${CANARY} a goal with a long title number ${n} that says what it is for`,
  checks: { met: 1, total: 4, unknown: 0 }, onTrack: { likelihood: 'about_even', percent: 50, by: '2026-12-01' }, finishBy: '2026-12-15', steps: { open: 12, overdue: 3 },
});

describe('the [route] line', () => {
  it('says the goals block’s size beside World now’s, or alone on a local turn', () => {
    expect(parse(routeLine({ ...rec, ctxTokens: { goals: 180 } })).ctxTokens).toEqual({ goals: 180 });
    expect(parse(routeLine({ ...rec, brain: 'frontier', answeredBy: 'ollama:qwen2.5:72b', ctxTokens: { world: 118, goals: 180 } })).ctxTokens).toEqual({ world: 118, goals: 180 });
    expect(parse(routeLine(rec))).not.toHaveProperty('ctxTokens');
  });

  it('for the fullest block the server can build: a number within 300, and the line holds no goal text', async () => {
    const answer = { goals: Array.from({ length: 20 }, (_, i) => goal(i + 1)), more: 30 };
    const local = { name: 'local' };
    const g = new GoalsNow<{ name: string }>({
      runtime: () => ({ url: 'http://[::1]:8090', token: 'c'.repeat(64) }),
      brainOf: () => ({ provider: 'ollama', model: 'qwen2.5:14b', baseURL: 'http://127.0.0.1:11434' }),
      fetchImpl: (async () => new Response(JSON.stringify(answer))) as unknown as typeof fetch,
    });
    const asked = (await g.forTurn()).ask(local, 'Right now it is Monday.');
    expect(asked.context).toContain(CANARY);
    expect(asked.tokens).toBe(estimateTokens(renderGoals(answer)));
    expect(asked.tokens).toBeGreaterThan(200);
    expect(asked.tokens).toBeLessThanOrEqual(GOALS_NOW_MAX_TOKENS);
    expect(GOALS_NOW_MAX_TOKENS).toBe(GOALS_BLOCK_MAX_TOKENS);
    const line = routeLine({ ...rec, ctxTokens: { goals: asked.tokens } });
    expect(parse(line).ctxTokens).toEqual({ goals: asked.tokens });
    expect(line).not.toContain(CANARY);
    expect(line).not.toContain('goal#');
  });
});

describe('the chat.turn event', () => {
  const turn = { brain: 'local', outcome: 'answered' as const, tools: [], ms: 900, tainted: false };
  const wire = (e: object) => ({ ...e, id: 'a'.repeat(32), at: '2026-10-12T10:00:00.000Z' });

  it('carries the goals block’s size as a whole number, and passes the strict contract', () => {
    const e = chatTurnEvent({ ...turn, goalsTokens: 180.4 });
    expect(e).toMatchObject({ type: 'chat.turn', brain: 'local', ctxTokens: { goals: 180 } });
    expect(ChatTurnEvent.safeParse(wire(e)).success).toBe(true);
    expect(ServerEvent.safeParse(wire(e)).success).toBe(true);
  });

  it('beside World now’s on a turn that carried both, and neither when the turn carried none', () => {
    expect(chatTurnEvent({ ...turn, brain: 'frontier', worldTokens: 120, goalsTokens: 180 })).toMatchObject({ ctxTokens: { world: 120, goals: 180 } });
    expect(chatTurnEvent({ ...turn, worldTokens: 120 })).toMatchObject({ ctxTokens: { world: 120 } });
    expect((chatTurnEvent({ ...turn, worldTokens: 120 }) as { ctxTokens: object }).ctxTokens).not.toHaveProperty('goals');
    expect(chatTurnEvent(turn)).not.toHaveProperty('ctxTokens');
  });

  it('a size that is not a real number is left out; one out of range is clamped', () => {
    expect(chatTurnEvent({ ...turn, goalsTokens: Number.NaN })).not.toHaveProperty('ctxTokens');
    expect(chatTurnEvent({ ...turn, goalsTokens: Number.POSITIVE_INFINITY })).not.toHaveProperty('ctxTokens');
    expect(chatTurnEvent({ ...turn, goalsTokens: -3 })).toMatchObject({ ctxTokens: { goals: 0 } });
    expect(chatTurnEvent({ ...turn, goalsTokens: 9e9 })).toMatchObject({ ctxTokens: { goals: 100_000 } });
  });

  it('has no room for the block’s words', () => {
    const e = wire(chatTurnEvent({ ...turn, goalsTokens: 180 })) as Record<string, unknown>;
    expect(ServerEvent.safeParse({ ...e, ctxTokens: { goals: `${CANARY} goal` } }).success).toBe(false);
    expect(ServerEvent.safeParse({ ...e, goals: `${CANARY} goal` }).success).toBe(false);
    expect(JSON.stringify(e)).not.toContain(CANARY);
  });
});
