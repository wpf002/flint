/**
 * A card's review on flint_test (P5): the sweep that sends cards for review,
 * the review written and attached to the card it is of, and each way one is
 * not written. The model is a stand-in for Ollama; the database is real.
 *
 *  - The sweep sends each waiting card that needs a review and has none, once,
 *    while Local Reviews is on and a local model is named; nothing otherwise.
 *  - A review is written of the card as it waits: its digest, its findings (the
 *    code's), the judge's verdict, in shadow, as tainted and as sensitive as the
 *    card; the card names it; one audit entry says so with ids and the verdict
 *    only. A second run finds it there.
 *  - Not written: Local Reviews off, no model, a rule's cap used up, a card that
 *    needs none, and a card decided while the model answered. A reviewer turned
 *    off while the model answered is refused by the database itself.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NO_DB, freshDb, type TestUrls } from '../db';
import { createDb, type Db } from '../../src/db';
import { LOCAL_REVIEWER, LOCAL_WORKER } from '../../src/assets/registry';
import { fileEnable, turnOff } from '../../src/assets/service';
import { REVIEW_QUEUE, runCardReview, sendCardReviews, type ReviewDeps } from '../../src/reviews/run';
import { modelsHere } from '../ollama-kit';
import { CANARY, FakeBus, taskFixture, type TaskFixture } from '../tasks/fixture';

const OLLAMA = { url: 'http://127.0.0.1:11434', model: 'muse-glimmer:30b' };
modelsHere([OLLAMA.model]);

const reply = (content: unknown) =>
  new Response(JSON.stringify({ model: 'm', message: { role: 'assistant', content: JSON.stringify(content) }, done: true, done_reason: 'stop', prompt_eval_count: 10, eval_count: 5 }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });

/** A debate that ends in this verdict: four answers, in the order they are asked. Every word carries the canary. */
function debate(verdict = 'proceed_with_changes') {
  const answers = [
    { attack: `${CANARY} it turns on an asset that runs on its own.` },
    { defense: `${CANARY} it only does what each card allows.` },
    { verdict, confidence: 0.7, reasonCodes: ['changes_rules', 'reversible'], verdictReason: `${CANARY} fine once you know what it does.` },
    { verdict, confidence: 0.6, reasonCodes: ['changes_rules'], verdictReason: `${CANARY} fine.` },
  ];
  const sent: string[] = [];
  const fetch = (async (_url: string, init?: RequestInit) => {
    sent.push(String(init?.body ?? ''));
    return reply(answers[Math.min(sent.length - 1, answers.length - 1)]);
  }) as typeof globalThis.fetch;
  return { fetch, sent };
}

describe.skipIf(NO_DB)('reviews on flint_test', () => {
  let urls: TestUrls;
  let db: Db;
  let bus: FakeBus;
  let fx: TaskFixture;

  beforeAll(async () => {
    urls = await freshDb();
    db = createDb(urls.app);
    bus = new FakeBus();
    fx = await taskFixture(urls, db, bus, { source: true });
  });
  afterAll(async () => {
    await db.$disconnect();
  });

  const deps = (fetch: typeof globalThis.fetch, over: Partial<ReviewDeps> = {}): ReviewDeps => ({
    db, config: { tz: 'UTC', ollama: OLLAMA }, load: async () => 'proceed', seam: { fetch }, ...over,
  });
  /** A card that needs a review: the one that would turn the Local Worker on (it changes a policy, and needs his fresh touch). One a waiting card dedupes. */
  const waitingCard = async () => {
    const filed = await fileEnable(db, LOCAL_WORKER.id);
    return db.proposal.findUniqueOrThrow({ where: { id: filed.proposalId } });
  };
  /** A card of its own that needs a review, for a test that must not share one: it can't be undone. */
  let n = 0;
  const freshCard = async () => {
    const filed = await fx.file('world.source.enable', { source: 'github', n: ++n }, { kind: 'tool_call', destructive: true });
    return db.proposal.findUniqueOrThrow({ where: { id: filed.id } });
  };

  it('Local Reviews off: the sweep sends nothing, and a review is not written', async () => {
    const card = await waitingCard();
    expect(card).toMatchObject({ status: 'pending', reviewRequired: true, reviewId: null });
    expect(await sendCardReviews({ db, bus, config: { ollama: OLLAMA } })).toBe(0);
    const m = debate();
    expect(await runCardReview(deps(m.fetch), { proposalId: card.id })).toEqual({ outcome: 'off' });
    expect(m.sent).toHaveLength(0);
    expect(await db.review.count()).toBe(0);
  });

  it('on: each waiting card that needs a review is sent once, and only while a model is named', async () => {
    // Turning Local Reviews on is a card too; reviews are not required, so it is approved without one.
    await fx.assetOn(LOCAL_REVIEWER.id);
    const card = await db.proposal.findFirstOrThrow({ where: { action: 'asset.enable', status: 'pending', reviewId: null }, orderBy: { createdAt: 'desc' } });
    expect(await sendCardReviews({ db, bus, config: {} })).toBe(0);
    const before = bus.sent.length;
    expect(await sendCardReviews({ db, bus, config: { ollama: OLLAMA } })).toBeGreaterThanOrEqual(1);
    const sent = bus.sent.slice(before).filter((j) => j.queue === REVIEW_QUEUE);
    expect(sent.map((j) => j.data)).toContainEqual({ proposalId: card.id });
    // Stately on the card: sent again while it waits, it is not sent twice.
    const again = bus.sent.length;
    await sendCardReviews({ db, bus, config: { ollama: OLLAMA } });
    expect(bus.sent.slice(again).filter((j) => j.queue === REVIEW_QUEUE && (j.data as { proposalId: string }).proposalId === card.id)).toHaveLength(0);
  });

  it('a review is written of the card as it waits, attached to it, in shadow; and a second run finds it there', async () => {
    const card = await waitingCard();
    const m = debate('proceed_with_changes');
    const logs: string[] = [];
    const r = await runCardReview(deps(m.fetch, { log: (x) => logs.push(x) }), { proposalId: card.id });
    expect(r.outcome).toBe('written');
    expect(m.sent).toHaveLength(4);
    const review = await db.review.findUniqueOrThrow({ where: { id: r.reviewId! } });
    expect(review).toMatchObject({
      subjectType: 'proposal', subjectId: card.id, subjectDigest: card.argsDigest, engine: 'local_adj',
      findings: ['changes_policy', 'consequential'], reasonCodes: ['changes_rules', 'reversible'],
      verdict: 'proceed_with_changes', confidence: 0.6, agreed: true, shadow: true, tainted: card.tainted, sensitivity: card.sensitivity,
      models: { attacker: OLLAMA.model, defender: OLLAMA.model, judge: OLLAMA.model },
    });
    expect(review.attack).toContain('CANARY');
    expect((await db.proposal.findUniqueOrThrow({ where: { id: card.id } })).reviewId).toBe(review.id);
    // One audit entry: ids, the verdict and counts. Never a word of the card or of the review.
    const entry = await db.auditEntry.findFirstOrThrow({ where: { action: 'review.local', correlationId: `proposal:${card.id}` }, orderBy: { seq: 'desc' } });
    expect(entry).toMatchObject({ actor: 'runtime:reviews', outcome: 'ok', tier: 'approval' });
    expect(entry.inputs).toMatchObject({ proposalId: card.id, reviewId: review.id, verdict: 'proceed_with_changes', agreed: true, result: 'written', requests: 4 });
    expect(JSON.stringify(entry, (_k, v: unknown) => (typeof v === 'bigint' ? String(v) : v))).not.toContain('CANARY');
    expect(logs.join('\n')).not.toContain('CANARY');
    // Again: it is there, and nothing more is asked.
    const n = debate();
    expect(await runCardReview(deps(n.fetch), { proposalId: card.id })).toEqual({ outcome: 'exists' });
    expect(n.sent).toHaveLength(0);
    // And the sweep no longer sends it.
    const before = bus.sent.length;
    await sendCardReviews({ db, bus, config: { ollama: OLLAMA } });
    expect(bus.sent.slice(before).some((j) => (j.data as { proposalId?: string }).proposalId === card.id)).toBe(false);
  });

  it('a card decided while the model answered gets no review', async () => {
    const card = await freshCard();
    const m = debate();
    const r = await runCardReview(deps(m.fetch, { hooks: { answered: async () => void (await fx.approve(card.id)) } }), { proposalId: card.id });
    expect(r).toEqual({ outcome: 'nothing' });
    expect(m.sent).toHaveLength(4);
    expect(await db.review.count({ where: { subjectId: card.id } })).toBe(0);
  });

  it('a card that needs no review is not reviewed, and no model is no review', async () => {
    const plain = await fx.file('world.source.enable', { source: 'github' }, { kind: 'tool_call' });
    expect((await db.proposal.findUniqueOrThrow({ where: { id: plain.id } })).reviewRequired).toBe(false);
    const m = debate();
    expect(await runCardReview(deps(m.fetch), { proposalId: plain.id })).toEqual({ outcome: 'nothing' });
    const card = await freshCard();
    expect(await runCardReview(deps(m.fetch, { config: { tz: 'UTC' } }), { proposalId: card.id })).toEqual({ outcome: 'no_model' });
    expect(m.sent).toHaveLength(0);
  });

  it('the day’s cap: a card with no slot left today is not reviewed, and nothing is asked', async () => {
    const card = await freshCard();
    const today = new Date().toISOString().slice(0, 10);
    await db.$queryRaw`SELECT claim_action('review.local', ${today}, 20) FROM generate_series(1, 20)`;
    const m = debate();
    expect(await runCardReview(deps(m.fetch), { proposalId: card.id })).toEqual({ outcome: 'capped' });
    expect(m.sent).toHaveLength(0);
    expect(await db.review.count({ where: { subjectId: card.id } })).toBe(0);
  });

  it('a reviewer turned off while the model answered: the database refuses the review, and nothing is left behind', async () => {
    // The cap the last test used up is given back (the owner's to do: the runtime's role cannot).
    await fx.owner('DELETE FROM "ActionCounter" WHERE action = $1', ['review.local']);
    const card = await freshCard();
    const m = debate();
    const r = await runCardReview(deps(m.fetch, { hooks: { answered: async () => turnOff(db, LOCAL_REVIEWER.id) } }), { proposalId: card.id });
    expect(r).toEqual({ outcome: 'refused' });
    expect(await db.review.count({ where: { subjectId: card.id } })).toBe(0);
    expect((await db.proposal.findUniqueOrThrow({ where: { id: card.id } })).reviewId).toBeNull();
  });
});
