/**
 * Will's own words never reach a model that is not on this Mac (model/here),
 * against a real stand-in for Ollama on loopback, over real sockets.
 *
 * The runtime's three local calls carry text that must stay here: a goal
 * review's plan stage sends the goal's title and why it matters, in his words;
 * triage's judge sends an item's title; a prediction's second opinion sends a
 * series' values (spend and calendar hours among them). The address alone
 * proves nothing: this Mac's Ollama serves a cloud model under any name. So
 * each call asks that Ollama for its listing first, for that exact model.
 *
 * The stand-in's chat endpoint ALWAYS answers, with a reply each caller would
 * take. Only its listing changes:
 *  - it marks the model as run elsewhere (a remote host on its row);
 *  - it hangs;
 *  - it fails (500), while chat would have answered;
 *  - it does not hold the model.
 * In each, for each caller, no chat request is made at all: nothing personal
 * is sent, and the caller ends on its no-model path. And once, with the model
 * listed as here, the same call does send it: the stand-in would have had it.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { planDiff, type PlanFacts } from '../../src/goals/planner';
import { judge } from '../../src/triage/judge';
import { decide } from '../../src/triage/triage';
import { estimate, type EstimateFacts } from '../../src/predict/reason';
import { localModelCheck, localModels } from '../../src/health/machine';
import { facts as eventFacts, noCode } from '../triage/helpers';
import { fresh, standIn, type ListingMode, type StandIn } from '../ollama-kit';
import { SYNTHETIC_FACTS } from '../predict/reason-facts';

const MODEL = 'looks-local:7b';
/** Words and a number no test writes anywhere but into what a model would be sent. */
const TITLE = 'CANARY-goal-title: run a half marathon';
const WHY = 'CANARY-why-it-matters: my father ran one at my age';
const ISSUE = 'CANARY-issue-title: the build is broken on main';
const DOLLARS = 73415.25;

const GOAL: PlanFacts = {
  today: '2026-10-12', finishBy: '2026-12-01', title: TITLE, why: WHY, tainted: false,
  criteria: [{ id: 'c1', text: 'CANARY-check: the race is run', state: 'unmet' }],
  steps: [{ key: 's1', title: 'CANARY-step: sign up', status: 'todo', kind: 'will_task', due: null }],
  items: [],
};
const EVENT = eventFacts({ created: true }, { name: ISSUE, state: { number: 7, state: 'open', labels: ['bug'] }, taintedPaths: ['name'] });
const SPEND: EstimateFacts = { ...SYNTHETIC_FACTS, name: 'Anthropic Spend', unit: 'usd', values: SYNTHETIC_FACTS.values.map((v, i) => ({ day: v.day, value: i === 27 ? DOLLARS : v.value })) };

interface Called {
  ok: boolean;
  why?: string;
  requests: number;
}
const gates = (n: { claims: number; loads: number }) => ({ load: async () => (n.loads++, 'proceed' as const), claim: async () => (n.claims++, true) });

/** Each local call the runtime makes: what it would send, a reply it would take, and the call itself (the real fetch, no stub). */
const CALLERS: Array<{ name: string; holds: string[]; reply: unknown; call: (s: StandIn, n: { claims: number; loads: number }) => Promise<Called> }> = [
  {
    name: 'a goal review’s plan stage', holds: [TITLE, WHY, 'CANARY-check', 'CANARY-step'], reply: { reasonCode: 'on_track', ops: [] },
    call: (s, n) => planDiff(GOAL, { ollama: { url: s.url, model: MODEL }, ...gates(n), resolve: () => [], models: fresh() }),
  },
  {
    name: 'triage’s judge', holds: [ISSUE], reply: { relevance: 0.9, reasonCode: 'failure', reasoning: 'main is broken' },
    call: (s, n) => judge(EVENT, { ollama: { url: s.url, model: MODEL }, ...gates(n), models: fresh() }),
  },
  {
    name: 'a prediction’s second opinion', holds: [String(DOLLARS), 'Anthropic Spend'], reply: { probability: 0.6, reasonCode: 'recent_level' },
    call: (s, n) => estimate(SPEND, { ollama: { url: s.url, model: MODEL }, ...gates(n), models: fresh() }),
  },
];

describe.each(CALLERS)('$name against a stand-in Ollama', ({ holds, reply, call }) => {
  let s: StandIn;
  beforeAll(async () => {
    s = await standIn(MODEL, reply);
  });
  afterAll(async () => {
    await s.close();
  });
  beforeEach(() => {
    s.seen.length = 0;
    s.chats.length = 0;
  });

  it('listed as run here: the model is asked, and is sent the text (the stand-in would have had it)', async () => {
    s.listing = 'here';
    const n = { claims: 0, loads: 0 };
    expect(await call(s, n)).toMatchObject({ ok: true, requests: 1 });
    expect(s.seen).toEqual([{ method: 'GET', path: '/api/tags' }, { method: 'POST', path: '/api/chat' }]);
    expect(s.chats).toHaveLength(1);
    for (const text of holds) expect(s.chats[0], text).toContain(text);
    expect(JSON.parse(s.chats[0]!)).toMatchObject({ model: MODEL, stream: false });
  });

  const cases: Array<[string, ListingMode]> = [
    ['its listing marks the model as run elsewhere', 'remote'],
    ['its listing hangs', 'hang'],
    ['its listing fails with a 500 while chat would have answered', 'error500'],
    ['its listing does not hold the model', 'gone'],
  ];
  it.each(cases)('%s: nothing is sent to the model, nothing is claimed, and the call ends unavailable', async (_what, mode) => {
    s.listing = mode;
    const n = { claims: 0, loads: 0 };
    const started = Date.now();
    const r = await call(s, n);
    expect(r).toMatchObject({ ok: false, why: 'unavailable', requests: 0 });
    // The listing was asked, once, and that is the whole conversation: no chat request, so no text of his.
    expect(s.seen).toEqual([{ method: 'GET', path: '/api/tags' }]);
    expect(s.chats).toEqual([]);
    expect(n).toEqual({ claims: 0, loads: 0 });
    // Soon: a listing that hangs costs its short limit, never the model's 90 seconds.
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('a model that was here and is repointed elsewhere is not sent the next call’s text', async () => {
    // (Each call makes a record of its own, as two calls more than two seconds apart would: each asks again.)
    s.listing = 'here';
    const n = { claims: 0, loads: 0 };
    expect(await call(s, n)).toMatchObject({ ok: true });
    expect(s.chats).toHaveLength(1);
    s.listing = 'remote';
    expect(await call(s, n)).toMatchObject({ ok: false, why: 'unavailable' });
    expect(s.chats).toHaveLength(1);
    expect(n).toEqual({ claims: 1, loads: 1 });
  });
});

describe('the no-model path says so in plain words', () => {
  it('triage decides without the model, and Settings > Health says the local model isn’t on this Mac', async () => {
    const s = await standIn(MODEL, { relevance: 0.9, reasonCode: 'failure', reasoning: 'r' });
    try {
      s.listing = 'remote';
      const j = await judge(EVENT, { ollama: { url: s.url, model: MODEL }, load: async () => 'proceed', claim: async () => true, models: fresh() });
      // The event is logged to Other without the model's review: never escalated on a guess, never held.
      const v = await decide(EVENT, { rules: [], code: noCode, rulesAllowed: true, model: MODEL, judge: async () => j });
      expect(v).toMatchObject({ action: 'log', lane: 'quiet', decidedBy: 'fallback:unavailable' });
      // Health reads the same listing through the same reader, and says what is wrong in a sentence.
      const up = { component: 'ollama', status: 'ok' } as const;
      expect(localModelCheck(up, MODEL, await localModels(s.url, fetch, fresh()))).toEqual({ component: 'ollama', status: 'down', detail: 'The local model isn’t on this Mac.' });
      s.listing = 'error500';
      expect(localModelCheck(up, MODEL, await localModels(s.url, fetch, fresh()))).toEqual({ component: 'ollama', status: 'unknown', detail: 'Flint couldn’t check which models are installed.' });
      s.listing = 'gone';
      expect(localModelCheck(up, MODEL, await localModels(s.url, fetch, fresh()))).toEqual({ component: 'ollama', status: 'down', detail: 'The local model isn’t installed.' });
      expect(s.chats).toEqual([]);
    } finally {
      await s.close();
    }
  });
});
