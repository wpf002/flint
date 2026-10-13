/**
 * One local model, one request at a time (model/slot.ts): triage's judge, a
 * goal review's plan stage and a prediction's second opinion share the
 * process's one slot. However many of each run together, and however their
 * requests fail, no two are ever in flight at once.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { judge } from '../../src/triage/judge';
import { planDiff, type PlanFacts } from '../../src/goals/planner';
import { estimate } from '../../src/predict/reason';
import { modelSlot } from '../../src/model/slot';
import { facts as eventFacts } from '../triage/helpers';
import { modelsHere } from '../ollama-kit';
import { SYNTHETIC_FACTS } from '../predict/reason-facts';

const OLLAMA = { url: 'http://127.0.0.1:11434', model: 'muse-glimmer:30b' };
modelsHere([OLLAMA.model]);

const PLAN: PlanFacts = { today: '2026-10-12', finishBy: null, title: 'Synthetic goal', why: '', tainted: false, criteria: [{ id: 'c1', text: 'Synthetic check', state: 'unmet' }], steps: [], items: [] };
const EVENT = eventFacts({ created: true }, { name: 'Synthetic issue', state: { number: 7, state: 'open' } });
const chat = (content: unknown) => new Response(JSON.stringify({ model: 'm', message: { role: 'assistant', content: typeof content === 'string' ? content : JSON.stringify(content) }, done: true, done_reason: 'stop', prompt_eval_count: 10, eval_count: 5 }), { status: 200, headers: { 'content-type': 'application/json' } });

describe('the shared model slot', () => {
  it('judge, plan stage and estimate never overlap: several of each at once, some failing, some retrying', async () => {
    let inFlight = 0;
    let most = 0;
    const order: string[] = [];
    /** A stand-in Ollama for one caller: slow, and it counts who is in flight. `replies` are given in turn (the last one repeats). */
    const slow = (who: string, replies: Array<() => Response>) => {
      let n = 0;
      return (async () => {
        inFlight += 1;
        most = Math.max(most, inFlight);
        order.push(`${who} in`);
        await new Promise((r) => setTimeout(r, 5 + (order.length % 3) * 4));
        order.push(`${who} out`);
        inFlight -= 1;
        return replies[Math.min(n++, replies.length - 1)]!();
      }) as unknown as typeof fetch;
    };
    const boom = () => { throw new TypeError('fetch failed'); };
    const gates = { load: async () => 'proceed' as const, claim: async () => true };
    const good = { judge: () => chat({ relevance: 0.4, reasonCode: 'fyi', reasoning: 'r' }), plan: () => chat({ reasonCode: 'on_track', ops: [] }), estimate: () => chat({ probability: 0.6, reasonCode: 'trend' }) };
    const results = await Promise.all([
      judge(EVENT, { ollama: OLLAMA, ...gates, fetch: slow('judge 1', [good.judge]) }),
      planDiff(PLAN, { ollama: OLLAMA, ...gates, resolve: () => [], fetch: slow('plan 1', [good.plan]) }),
      estimate(SYNTHETIC_FACTS, { ollama: OLLAMA, ...gates, fetch: slow('estimate 1', [good.estimate]) }),
      // A first reply that is not usable: each asks a second time, and the second request waits its turn too.
      judge(EVENT, { ollama: OLLAMA, ...gates, fetch: slow('judge 2', [() => chat('not json'), good.judge]) }),
      planDiff(PLAN, { ollama: OLLAMA, ...gates, resolve: () => [], fetch: slow('plan 2', [() => chat('not json'), good.plan]) }),
      estimate(SYNTHETIC_FACTS, { ollama: OLLAMA, ...gates, fetch: slow('estimate 2', [() => chat({ probability: 0.99, reasonCode: 'trend' }), good.estimate]) }),
      // A transport that throws frees the slot for the next.
      judge(EVENT, { ollama: OLLAMA, ...gates, fetch: slow('judge 3', [boom]) }),
      planDiff(PLAN, { ollama: OLLAMA, ...gates, resolve: () => [], fetch: slow('plan 3', [boom]) }),
      estimate(SYNTHETIC_FACTS, { ollama: OLLAMA, ...gates, fetch: slow('estimate 3', [boom]) }),
    ]);
    expect(results.map((r) => r.ok)).toEqual([true, true, true, true, true, true, false, false, false]);
    expect(most).toBe(1);
    // 3 single requests, 3 pairs and 3 failed pairs: every one went in and came out before the next went in.
    expect(order).toHaveLength(2 * (3 + 6 + 6));
    for (let i = 0; i < order.length; i += 2) expect(order[i + 1]).toBe(order[i]!.replace(/ in$/, ' out'));
    // All three kinds of caller were in the queue together, not one kind after another.
    const kinds = order.filter((o) => o.endsWith(' in')).map((o) => o.split(' ')[0]);
    expect(new Set(kinds.slice(0, 3))).toEqual(new Set(['judge', 'plan', 'estimate']));
  });

  it('a chat turn that starts while an estimate waits its turn is seen when its turn comes', async () => {
    let busy = false;
    const first = (async () => { busy = true; return chat({ relevance: 0.2, reasonCode: 'fyi', reasoning: 'r' }); }) as unknown as typeof fetch;
    let asked = 0;
    const second = (async () => (asked++, chat({ probability: 0.6, reasonCode: 'trend' }))) as unknown as typeof fetch;
    const [, waited] = await Promise.all([
      judge(EVENT, { ollama: OLLAMA, load: async () => 'proceed', claim: async () => true, fetch: first }),
      estimate(SYNTHETIC_FACTS, { ollama: OLLAMA, load: async () => (busy ? 'defer' : 'proceed'), claim: async () => true, fetch: second }),
    ]);
    expect(waited).toMatchObject({ ok: false, why: 'deferred', requests: 0 });
    expect(asked).toBe(0);
  });

  it('there is one slot: each caller sends through it, and nothing else in the runtime queues model requests', () => {
    const src = join(__dirname, '..', '..', 'src');
    const code = (f: string) => readFileSync(join(src, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const f of ['triage/judge.ts', 'goals/planner.ts', 'predict/reason.ts']) {
      const c = code(f);
      expect(c, f).toContain("import { modelSlot } from '../model/slot.js';");
      // The gated fetch is the only thing the provider is given, and every request it makes goes through the slot.
      expect(c.match(/modelSlot\(async \(\) => \{/g), f).toHaveLength(1);
      expect(c, f).toMatch(/new OllamaProvider\(\{ baseURL: origin, fetch: gated,/);
      expect(c.match(/await post\(/g), f).toHaveLength(1);
      expect(c.indexOf('modelSlot(async () => {'), f).toBeLessThan(c.indexOf('await post('));
    }
    const slot = code('model/slot.ts');
    expect(slot.match(/^let tail\b/gm)).toHaveLength(1);
    expect(slot).toContain('export function modelSlot<T>(request: () => Promise<T>): Promise<T>');
  });

  it('a request that fails frees the slot', async () => {
    await expect(modelSlot(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await modelSlot(async () => 'next')).toBe('next');
  });
});
