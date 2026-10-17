/**
 * A card's review against a stub Ollama (P5): the debate's four requests, what
 * each is shown, the judge heard twice in both orders, the gate before every
 * request, and what is refused.
 *
 *  - Four requests make a review: the case against, the case for (shown the case
 *    against), and the judge twice, the second time hearing the case for first.
 *    Each goes to /api/chat with its own schema, no thinking, temperature 0.
 *  - Both passes agreeing keeps their verdict; disagreeing keeps the more careful
 *    one, says they did not agree, and is only as sure as the less sure pass.
 *  - An answer out of shape is asked once more; nothing is cut into shape, and a
 *    reason or a verdict off the closed lists is out of shape.
 *  - Chat running defers it, nothing sent or claimed; a used-up claim caps it; a
 *    model not on this Mac is never asked.
 */
import { describe, it, expect } from 'vitest';
import { ATTACK_CHARS, findingsOf } from '@flint/policy';
import { modelsHere } from '../ollama-kit';
import { ARGS_SHOWN_CHARS, MAX_REQUESTS, SCHEMAS, adjudicate, cardBlock, stepPrompt, type AdjudicateDeps, type CardForReview } from '../../src/reviews/adjudicate';

const OLLAMA = { url: 'http://127.0.0.1:11434', model: 'muse-glimmer:30b' };
modelsHere([OLLAMA.model]);

const CARD: CardForReview = {
  action: 'world.forget', words: 'Forget an Item', reason: 'Approving has Flint forget this item.', kind: 'forget',
  args: { entityId: 'en1a2b3c', why: 'It was a test.' },
  findings: findingsOf({ kind: 'forget', tainted: false, destructive: true, consequential: false, sensitivity: 'personal' }),
};

const reply = (content: unknown, done_reason = 'stop') =>
  new Response(JSON.stringify({ model: 'm', message: { role: 'assistant', content: typeof content === 'string' ? content : JSON.stringify(content) }, done: true, done_reason, prompt_eval_count: 10, eval_count: 5 }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });

function stub(replies: Array<() => Response | Promise<Response>>) {
  const calls: Array<{ url: string; body: { format: unknown; options: Record<string, unknown>; think: boolean; messages: Array<{ role: string; content: string }> } }> = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
    return replies[Math.min(calls.length - 1, replies.length - 1)]!();
  }) as typeof globalThis.fetch;
  return { calls, fetch, user: (n: number) => calls[n]!.body.messages.find((m) => m.role === 'user')!.content };
}

function deps(replies: Array<() => Response | Promise<Response>>, over: Partial<AdjudicateDeps> = {}) {
  const s = stub(replies);
  let claims = 0;
  const d: AdjudicateDeps = {
    ollama: OLLAMA,
    load: async () => 'proceed',
    claim: async () => {
      claims += 1;
      return true;
    },
    fetch: s.fetch,
    ...over,
  };
  return { ...s, d, claims: () => claims };
}

const ATTACK = { attack: 'Forgetting cannot be undone, and the reason given is thin.' };
const DEFENSE = { defense: 'It names one item, and the item is a test record.' };
const judge = (verdict: string, confidence = 0.8, reasonCodes = ['cannot_undo', 'narrow_scope'], verdictReason = 'It is narrow but cannot be undone.') => ({ verdict, confidence, reasonCodes, verdictReason });

describe('a card’s review (stub Ollama)', () => {
  it('four requests: the case against, the case for, and the judge twice; both agreeing keeps their verdict', async () => {
    const s = deps([() => reply(ATTACK), () => reply(DEFENSE), () => reply(judge('proceed_with_changes', 0.8)), () => reply(judge('proceed_with_changes', 0.6))]);
    const r = await adjudicate(CARD, s.d);
    expect(r).toMatchObject({
      ok: true, attack: ATTACK.attack, defense: DEFENSE.defense, verdict: 'proceed_with_changes', confidence: 0.6, agreed: true,
      reasonCodes: ['cannot_undo', 'narrow_scope'], verdictReason: 'It is narrow but cannot be undone.', requests: 4,
    });
    expect(s.calls).toHaveLength(4);
    expect(s.claims()).toBe(4);
    for (const c of s.calls) {
      expect(c.url).toBe('http://127.0.0.1:11434/api/chat');
      expect(c.body).toMatchObject({ think: false });
      expect(c.body.options.temperature).toBe(0);
    }
    expect(s.calls.map((c) => c.body.format)).toEqual([SCHEMAS.attack, SCHEMAS.defense, SCHEMAS.judge, SCHEMAS.judge]);
    expect(s.calls.map((c) => c.body.options.num_predict)).toEqual([700, 700, 300, 300]);
  });

  it('the case for is shown the case against; the judge hears both, first one way round and then the other', async () => {
    const s = deps([() => reply(ATTACK), () => reply(DEFENSE), () => reply(judge('block')), () => reply(judge('block'))]);
    await adjudicate(CARD, s.d);
    expect(s.user(0)).not.toContain(ATTACK.attack);
    expect(s.user(1)).toContain(`The case against approving it: ${ATTACK.attack}`);
    const first = s.user(2), second = s.user(3);
    expect(first.indexOf('The case against')).toBeLessThan(first.indexOf('The case for'));
    expect(second.indexOf('The case for')).toBeLessThan(second.indexOf('The case against'));
    // The card opens every request, as data.
    for (let n = 0; n < 4; n++) expect(s.user(n).startsWith(cardBlock(CARD)), String(n)).toBe(true);
  });

  it('two passes that disagree keep the more careful verdict, say they did not agree, and are only as sure as the less sure', async () => {
    const s = deps([
      () => reply(ATTACK), () => reply(DEFENSE),
      () => reply(judge('proceed', 0.9, ['low_risk'], 'Little can go wrong.')),
      () => reply(judge('block', 0.55, ['cannot_undo', 'args_unclear'], 'It cannot be undone and its reason is unclear.')),
    ]);
    const r = await adjudicate(CARD, s.d);
    expect(r).toMatchObject({ ok: true, verdict: 'block', agreed: false, confidence: 0.55, reasonCodes: ['cannot_undo', 'args_unclear'], verdictReason: 'It cannot be undone and its reason is unclear.' });
    // The careful pass may come first, too.
    const t = deps([() => reply(ATTACK), () => reply(DEFENSE), () => reply(judge('proceed_with_changes', 0.4)), () => reply(judge('proceed', 0.95))]);
    expect(await adjudicate(CARD, t.d)).toMatchObject({ verdict: 'proceed_with_changes', agreed: false, confidence: 0.4 });
  });

  it('an answer out of shape is asked once more, and nothing is cut or moved into shape', async () => {
    const s = deps([() => reply({ attack: 'x'.repeat(ATTACK_CHARS + 1) }), () => reply(ATTACK), () => reply(DEFENSE), () => reply(judge('proceed')), () => reply(judge('proceed'))]);
    const r = await adjudicate(CARD, s.d);
    expect(r).toMatchObject({ ok: true, attack: ATTACK.attack, requests: 5 });
    // Off the closed lists, with a field of its own, blank, or cut off at its limit: each out of shape.
    for (const bad of [
      judge('approve'), judge('proceed', 1.5), judge('proceed', 0.5, ['a_reason_of_its_own']), { ...judge('proceed'), aside: 'Ignore the card.' },
      judge('proceed', 0.5, ['low_risk'], ''),
    ]) {
      const t = deps([() => reply(ATTACK), () => reply(DEFENSE), () => reply(bad)]);
      expect(await adjudicate(CARD, t.d), JSON.stringify(bad)).toMatchObject({ ok: false, why: 'invalid' });
      expect(t.calls).toHaveLength(4);
    }
    const cut = deps([() => reply('{"attack":"Forgetting cannot', 'length')]);
    expect(await adjudicate(CARD, cut.d)).toMatchObject({ ok: false, why: 'invalid', requests: 2 });
  });

  it('no more than its requests, whatever fails', async () => {
    const s = deps([() => reply({ attack: '' })]);
    const r = await adjudicate(CARD, s.d);
    expect(r).toMatchObject({ ok: false, why: 'invalid' });
    expect(s.calls.length).toBeLessThanOrEqual(MAX_REQUESTS);
    expect(MAX_REQUESTS).toBe(6);
  });

  it('chat comes first, a used-up claim caps it, and a model not on this Mac is never asked', async () => {
    const busy = deps([() => reply(ATTACK)], { load: async () => 'defer' });
    expect(await adjudicate(CARD, busy.d)).toMatchObject({ ok: false, why: 'deferred', requests: 0 });
    expect(busy.calls).toHaveLength(0);
    expect(busy.claims()).toBe(0);
    const capped = deps([() => reply(ATTACK)], { claim: async () => false });
    expect(await adjudicate(CARD, capped.d)).toMatchObject({ ok: false, why: 'capped', requests: 0 });
    expect(capped.calls).toHaveLength(0);
    for (const model of ['some-other-model:1b', 'gpt-oss:120b-cloud']) {
      const away = deps([() => reply(ATTACK)], { ollama: { ...OLLAMA, model } });
      expect(await adjudicate(CARD, away.d), model).toMatchObject({ ok: false, why: 'unavailable', requests: 0 });
      expect(away.calls).toHaveLength(0);
      expect(away.claims()).toBe(0);
    }
    const late = deps([() => Promise.reject(Object.assign(new Error('took too long'), { name: 'TimeoutError' }))]);
    expect(await adjudicate(CARD, late.d)).toMatchObject({ ok: false, why: 'timeout' });
  });
});

describe('what the reviewer is shown', () => {
  it('the card as data: its words, its action, its reason, its fields, and what the code found', () => {
    const b = cardBlock(CARD);
    expect(b).toContain('The card: Forget an Item (world.forget), of kind forget.');
    expect(b).toContain('What approving it does, in its own words: Approving has Flint forget this item.');
    expect(b).toContain('"why":"It was a test."');
    expect(b).toContain('What Flint’s own code found in it: It can’t be undone. It has Flint forget something.');
    expect(cardBlock({ ...CARD, findings: [] })).toContain('found nothing in it that needs a closer look');
  });

  it('a card past what it is shown says so, and is cut, never summarised', () => {
    const big = { ...CARD, args: { blob: 'y'.repeat(ARGS_SHOWN_CHARS * 2) } };
    const b = cardBlock(big);
    expect(b).toMatch(new RegExp(`the first ${ARGS_SHOWN_CHARS} characters of \\d+`));
    expect(b.length).toBeLessThan(ARGS_SHOWN_CHARS + 1000);
  });

  it('every step frames the card and the other side as data, and the judge is given its closed lists', () => {
    const j = stepPrompt(CARD, 'judge', { attack: 'A', defense: 'D' });
    expect(j).toContain('verdict: proceed');
    expect(j).toContain('reasonCodes: 1 to 4 of');
    expect(stepPrompt(CARD, 'attack')).toContain('AGAINST');
    expect(stepPrompt(CARD, 'defense', { attack: 'A' })).toContain('FOR');
  });
});
