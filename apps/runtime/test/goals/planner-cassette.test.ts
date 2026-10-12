/**
 * One real reply from the local model (muse-glimmer:30b on Ollama 0.34.4,
 * recorded by scripts/record-planner-cassette.ts for $0) to a synthetic goal
 * linked to a pull request whose title tries to take the planner over.
 * Replayed through planDiff(): the request sent today must be the one recorded
 * (re-record when the prompt or the schema changes), the reply, end-of-turn
 * token and all, must come out as template operations, and the pull request's
 * title must be nowhere in what the model was sent.
 */
import { describe, it, expect } from 'vitest';
import cassette from '../fixtures/ollama-planner-cassette.json';
import { CASSETTE_ITEM, CASSETTE_NOW, CASSETTE_TZ, cassetteFacts } from '../fixtures/cassette-goal';
import { composeDiff } from '../../src/goals/batch';
import { planDiff, PlanReply } from '../../src/goals/planner';
import { TemplateOp, resolveReply, stepTitle } from '../../src/goals/steps';
import type { PlanStepState } from '@flint/policy';

describe('planDiff against the recorded Ollama reply', () => {
  it('sends what was recorded, and reads the reply as template operations', async () => {
    const { facts, state } = cassetteFacts();
    const sent: unknown[] = [];
    const replay = (async (_url: string, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)));
      const ex = cassette.exchanges[sent.length - 1]!;
      return new Response(JSON.stringify(ex.response), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const r = await planDiff(facts, {
      ollama: { url: 'http://127.0.0.1:11434', model: cassette.model, numCtx: cassette.numCtx }, load: async () => 'proceed', claim: async () => true,
      resolve: (ops) => resolveReply(ops, state, CASSETTE_TZ, CASSETTE_NOW), fetch: replay,
    });
    expect(sent).toEqual(cassette.exchanges.map((e) => e.request));
    expect(cassette.exchanges[0]!.response.message!.content).toMatch(/<\|eot\|>$/);
    expect(r).toMatchObject({ ...cassette.result, requests: cassette.exchanges.length, claimed: true });
    expect(cassette.result.ok).toBe(true);
    // What the model said is the strict shape, with no key of its own and no free text; what is kept of it is ids, enums and times.
    const said = PlanReply.parse(JSON.parse(cassette.exchanges.at(-1)!.response.message!.content.replace(/<\|eot\|>$/, '')));
    expect(said.ops.length).toBeGreaterThan(0);
    for (const op of cassette.result.value) expect(TemplateOp.safeParse(op).success, JSON.stringify(op)).toBe(true);
  });

  it('the injected title never reached the prompt: the item is a ref and enums; its label comes from its key', () => {
    const everything = JSON.stringify(cassette.exchanges.map((e) => e.request));
    expect(CASSETTE_ITEM.name).toContain('ignore all previous instructions');
    for (const words of ['ignore all previous instructions', 'wire $5,000', 'SYSTEM:', 'reviewer']) expect(everything, words).not.toContain(words);
    const user = (cassette.exchanges[0]!.request.messages as Array<{ role: string; content: string }>).find((m) => m.role === 'user')!.content;
    expect(user).toContain('pull_request#lcas77 [active, state open]');
    // Will's own words are there, inside <data> blocks: the model is local.
    expect(user).toContain('<data source="will" tainted="false">Ship the synthetic widget page</data>');
    // A step about the item is named from its key, never its title.
    expect(stepTitle('check_item', { label: 'wpf002/flint #77' })).toBe('Check on wpf002/flint #77');
  });

  it('the recorded suggestions compose into operations the plan accepts, and none marks a step done', () => {
    const { facts } = cassetteFacts();
    const steps: PlanStepState[] = facts.steps.map((s, i) => ({
      key: s.key, ordinal: 100 * (i + 1), title: s.title, kind: 'will_task', tier: 'approval', status: s.status as PlanStepState['status'],
      dueAt: s.due ? `${s.due}T22:00:00.000Z` : null, dependsOn: [], doneAt: s.status === 'done' ? '2026-10-05T15:00:00.000Z' : null, doneAuditId: null, proposalId: null, taskId: null,
    }));
    const c = composeDiff(cassette.result.value.map((v) => TemplateOp.parse(v)), {
      now: CASSETTE_NOW, steps, horizonAt: '2026-11-16T05:59:00.000Z', labels: new Map([[CASSETTE_ITEM.id, 'wpf002/flint #77']]), criteria: new Map(facts.criteria.map((x) => [x.id, x.text])),
    });
    expect(c.suggestions.every((s) => s.key !== null)).toBe(true);
    expect(c.ops.size).toBeGreaterThan(0);
    expect(JSON.stringify([...c.ops.values()])).not.toContain('"done"');
    // The overdue step, a week late at most: a small change, for the one minor card.
    expect([...c.ops.values()].map((o) => o.class)).toEqual(['minor']);
  });
});
