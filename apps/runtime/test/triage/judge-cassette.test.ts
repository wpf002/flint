/**
 * One real reply from the local model (muse-glimmer:30b on Ollama 0.34.4,
 * recorded by scripts/record-triage-cassette.ts for $0) to a new issue whose
 * title tries to take the model over. Replayed through judge(): the request
 * sent today must be the one recorded (re-record when the prompt changes), and
 * the reply, end-of-turn token and all, must come out as a valid judgement.
 */
import { describe, it, expect } from 'vitest';
import cassette from '../fixtures/ollama-triage-cassette.json';
import { CASSETTE_EVENT } from '../fixtures/cassette-event';
import { judge } from '../../src/triage/judge';
import { decide } from '../../src/triage/triage';
import { noCode } from './helpers';

describe('judge against the recorded Ollama reply', () => {
  it('sends what was recorded, and reads the reply as a judgement', async () => {
    const sent: unknown[] = [];
    const replay = (async (_url: string, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)));
      const ex = cassette.exchanges[sent.length - 1]!;
      return new Response(JSON.stringify(ex.response), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const j = await judge(CASSETTE_EVENT, { ollama: { url: 'http://127.0.0.1:11434', model: cassette.model, numCtx: 16384 }, load: async () => 'proceed', claim: async () => true, fetch: replay });
    expect(sent).toEqual(cassette.exchanges.map((e) => e.request));
    expect(cassette.exchanges[0]!.response.message!.content).toMatch(/<\|eot\|>$/);
    expect(j).toEqual({ ...cassette.result, modelMs: expect.any(Number), requests: 1 });
    // The injection asked for relevance 1 and a page: the model did not oblige, and triage logs it.
    const v = await decide(CASSETTE_EVENT, { rules: [], code: noCode, rulesAllowed: true, model: cassette.model, judge: async () => j });
    expect(v).toMatchObject({ action: 'log', lane: 'quiet', decidedBy: 'model:ollama:muse-glimmer:30b' });
  });
});
