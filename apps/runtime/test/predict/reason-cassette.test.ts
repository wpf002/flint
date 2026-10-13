/**
 * One real second opinion from the local model (muse-glimmer:30b on this Mac's
 * Ollama, recorded by scripts/record-estimate-cassette.ts for $0) on a
 * synthetic number: made-up deploy counts with a weekday shape. Replayed
 * through estimate(): the request sent today must be the one recorded
 * (re-record when the prompt or the schema changes), and the reply, end-of-turn
 * token and all, must come out as a probability inside 0.05 to 0.95 and one of
 * the six reason codes, with no word of the model's own.
 */
import { describe, it, expect } from 'vitest';
import cassette from '../fixtures/ollama-estimate-cassette.json';
import { ESTIMATE_REASONS, ESTIMATE_SCHEMA, Estimate, MAX_PROBABILITY, MIN_PROBABILITY, estimate, estimatePrompt } from '../../src/predict/reason';
import { opinionSays } from '../../src/predict/phrasing';
import { modelsHere } from '../ollama-kit';
import { SYNTHETIC_FACTS } from './reason-facts';

// Ollama says the model is its own: what makes a model "not here" is model/here.test.ts's.
modelsHere([cassette.model]);

describe('estimate against the recorded Ollama reply', () => {
  it('sends what was recorded, and reads the reply as an estimate', async () => {
    const sent: unknown[] = [];
    const replay = (async (_url: string, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)));
      const ex = cassette.exchanges[sent.length - 1]!;
      return new Response(JSON.stringify(ex.response), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const r = await estimate(SYNTHETIC_FACTS, { ollama: { url: 'http://127.0.0.1:11434', model: cassette.model, numCtx: cassette.numCtx }, load: async () => 'proceed', claim: async () => true, fetch: replay });
    expect(sent).toEqual(cassette.exchanges.map((e) => e.request));
    expect(r).toMatchObject({ ...cassette.result, requests: cassette.exchanges.length });
    expect(cassette.result.ok).toBe(true);
    // What the model said, end-of-turn token and all, is the strict shape: a number in band and a code, and nothing else.
    const raw = cassette.exchanges.at(-1)!.response.message!.content;
    expect(raw).toMatch(/<\|eot\|>$/);
    const said = Estimate.parse(JSON.parse(raw.replace(/<\|eot\|>$/, '')));
    expect(Object.keys(said).sort()).toEqual(['probability', 'reasonCode']);
    expect(said.probability).toBeGreaterThanOrEqual(MIN_PROBABILITY);
    expect(said.probability).toBeLessThanOrEqual(MAX_PROBABILITY);
    expect(ESTIMATE_REASONS).toContain(said.reasonCode);
    expect(cassette.exchanges.at(-1)!.response.done_reason).toBe('stop');
    // And what Will would read of it: one plain sentence.
    expect(opinionSays(said.probability)).toMatch(/^The local model said about \d{1,2}%\.$/);
  });

  it('what was sent is the format, no thinking, and a prompt of numbers and fixed words', () => {
    const request = cassette.exchanges[0]!.request as { model: string; stream: boolean; think: boolean; format: unknown; options: Record<string, unknown>; messages: Array<{ role: string; content: string }> };
    expect(request).toMatchObject({ model: cassette.model, stream: false, think: false });
    expect(request.format).toEqual(ESTIMATE_SCHEMA);
    expect(request.options).toEqual({ temperature: 0, num_ctx: cassette.numCtx, num_predict: 200 });
    const p = estimatePrompt(SYNTHETIC_FACTS);
    expect(request.messages).toEqual([{ role: 'system', content: p.system }, { role: 'user', content: p.user }]);
    // Synthetic numbers only: nothing of a real series, an item, a goal or a person is in the cassette.
    const everything = JSON.stringify(cassette);
    expect(everything).not.toMatch(/daily\.|weekly\.|<data|@|https?:|wpf002|Will\b|\/Users\//);
    expect(Object.keys(cassette).sort()).toEqual(['exchanges', 'model', 'numCtx', 'recordedAt', 'result']);
    // The listing the estimate asked first is no part of it: only the chat exchange was kept.
    expect(cassette.exchanges).toHaveLength(1);
    expect(everything).not.toMatch(/api\/tags|remote_host|"models"/);
  });
});
