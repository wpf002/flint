/**
 * A card's review, written (P5; queue reviews.run): the job the sweep sends for
 * a card that waits for Will, needs a review and has none. A review is advice,
 * and while reviews are not required it changes nothing about the card: it is
 * written in shadow beside it, for the panel to show and the trial to measure.
 *
 *  1. The card still waits (pending and not lapsed), still needs a review, has
 *     none yet and still has its args; and Local Reviews is on.
 *  2. A rule may stop it (review.local: autonomous, at APPROVAL in shadow, and
 *     its own 20 a day). A card takes one slot of that day's cap, however many
 *     jobs run for it.
 *  3. The debate on the local model (adjudicate.ts), with no transaction open.
 *     Each of its requests is counted in the database by the card, so a job run
 *     again asks no more than one run could.
 *  4. The review written and attached to the card in ONE transaction at READ
 *     COMMITTED. The database takes it only of the card as it waits now — the
 *     same args, still pending — and only while a reviewer is on, so a card
 *     decided, changed or lapsed while the model answered, or a reviewer turned
 *     off meanwhile, gets nothing, and nothing is left behind.
 *  5. One audit entry for every review that ends, written or not: the card's id,
 *     the review's id, the verdict, whether the judge agreed, and counts. Never a
 *     word of the card or of the review.
 *
 * A deferral (chat busy), a model that did not answer or answered out of shape,
 * all end the job: the sweep sends the card again in two minutes, until its
 * requests for the day are used up.
 */
import { Prisma } from '@prisma/client';
import {
  ACTION_WORDS,
  CODE_TABLE,
  REVIEW_ENGINE,
  REVIEWS_WRITER,
  findingsOf,
  resolveTier,
  runsInShadow,
  type Cap,
  type CardReviewJob,
  type Tier,
} from '@flint/policy';
import type { Bus } from '../bus.js';
import type { Config } from '../config.js';
import type { Db, Tx } from '../db.js';
import { failureClass, failureOf, sqlState } from '../dbcodes.js';
import { appendAudit } from '../governance/audit.js';
import { claim } from '../governance/counters.js';
import { activePolicies } from '../governance/proposals.js';
import { chatLoad, type Load } from '../triage/load.js';
import { adjudicate, MAX_REQUESTS, type AdjudicateDeps, type CardForReview } from './adjudicate.js';

export const REVIEW_QUEUE = 'reviews.run';
export const REVIEW_ACTION = 'review.local';
/** How many requests one card's reviews may make in a day: two whole reviews' worth, whatever runs the job. */
export const REQUESTS_A_DAY = 2 * MAX_REQUESTS;
/** One card's requests today, and that it has taken its slot of the day's cap: counted by the card. */
export const requestsCounter = (proposalId: string): string => `review.requests:${proposalId}`;
export const claimedCounter = (proposalId: string): string => `review.claimed:${proposalId}`;
/** How many cards one sweep sends, oldest first. */
export const SWEEP_LIMIT = 20;

export type ReviewOutcome =
  /** The review is written and attached to the card. */
  | 'written'
  /** The card already has one. */
  | 'exists'
  /** Nothing to review: the card is gone, decided, lapsed, cleared, or needs no review. */
  | 'nothing'
  /** Local Reviews is off. */
  | 'off'
  /** A rule forbids it. */
  | 'skipped'
  /** No local model is set. */
  | 'no_model'
  | 'unavailable' | 'invalid' | 'capped' | 'deferred' | 'timeout'
  /** The database refused the write: the card changed, or the reviewer was turned off, while the model answered. */
  | 'refused'
  /** The write failed some other way: nothing was written. */
  | 'failed';

export interface ReviewDeps {
  db: Db;
  config: Pick<Config, 'tz'> & Partial<Pick<Config, 'ollama' | 'server'>>;
  log?: (msg: string) => void;
  load?: () => Promise<Load>;
  /** How the seam talks to the model, for tests: handed to adjudicate as it is, and read nowhere here. */
  seam?: Partial<Omit<AdjudicateDeps, 'ollama' | 'load' | 'claim'>>;
  now?: () => Date;
  /** Test seam: called once the model has answered, before the write begins. */
  hooks?: { answered?: () => Promise<void> };
}

const READ_COMMITTED = { maxWait: 10_000, timeout: 20_000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted } as const;
/** The database refused it by one of its own rules (a trigger, a check, a lock it lost). */
const refusedByDb = (err: unknown): boolean => {
  const state = sqlState(err);
  return state !== undefined && (state.startsWith('23') || state === '42501' || state === 'P0001' || state === '40001');
};

class CapReached extends Error {}
/**
 * This card's one slot of the day's cap: taken now, or already taken today by an
 * earlier job for the same card (true either way), or not to be had (false). The
 * card's own mark and the cap's slot are one transaction.
 */
async function claimOnce(db: Db, proposalId: string, cap: Cap, tz: string, now: Date): Promise<boolean> {
  try {
    return await db.$transaction(async (tx: Tx) => {
      if ((await claim(tx, claimedCounter(proposalId), { limit: 1, period: 'day' }, tz, now)) === null) return true;
      if ((await claim(tx, REVIEW_ACTION, cap, tz, now)) === null) throw new CapReached();
      return true;
    }, READ_COMMITTED);
  } catch (err) {
    if (err instanceof CapReached) return false;
    throw err;
  }
}

/** Where review.local stands: whether it may run now, its tier, its cap, and whether a review it writes is in shadow. */
async function standing(db: Db, now: Date): Promise<{ may: boolean; tier: Tier; cap: Cap; shadow: boolean }> {
  const t = resolveTier(REVIEW_ACTION, { context: 'autonomous', tainted: false, policies: await activePolicies(db, now), now });
  const may = t.tier === 'alone' || (t.tier === 'approval' && runsInShadow(REVIEW_ACTION));
  return { may, tier: t.tier, cap: t.cap ?? CODE_TABLE[REVIEW_ACTION]?.cap ?? { limit: 20, period: 'day' }, shadow: t.tier !== 'alone' };
}

/** A card that waits and could be reviewed now, as the review reads it; undefined when there is none. */
async function waitingCard(db: Db | Tx, id: string, now: Date) {
  const p = await db.proposal.findUnique({
    where: { id },
    select: { id: true, status: true, action: true, kind: true, args: true, argsDigest: true, reason: true, tainted: true, destructive: true, consequential: true, sensitivity: true, reviewRequired: true, reviewId: true, expiresAt: true },
  });
  if (!p || p.status !== 'pending' || !p.reviewRequired || p.args === null || p.expiresAt <= now) return undefined;
  return p;
}

/** Is Local Reviews on? */
const reviewerOn = async (db: Db | Tx): Promise<boolean> => (await db.asset.count({ where: { kind: 'local_reviewer', enabled: true } })) > 0;

/** One card's review. */
export async function runCardReview(d: ReviewDeps, job: CardReviewJob): Promise<{ outcome: ReviewOutcome; reviewId?: string }> {
  const { db } = d;
  const clock = (): Date => d.now?.() ?? new Date();
  const now = clock();
  const tz = d.config.tz;
  const card = await waitingCard(db, job.proposalId, now);
  if (!card) return { outcome: 'nothing' };
  if (card.reviewId) return { outcome: 'exists' };
  if (!(await reviewerOn(db))) return { outcome: 'off' };
  const s = await standing(db, now);
  /** The review ends here: one audit entry of ids, the verdict and counts. */
  const ended = async (outcome: ReviewOutcome, m: { requests?: number; modelMs?: number; reviewId?: string; verdict?: string; agreed?: boolean } = {}) => {
    await appendAudit(db, [{
      actor: REVIEWS_WRITER, context: 'autonomous', kind: 'action', action: REVIEW_ACTION, tier: s.tier,
      outcome: outcome === 'written' ? 'ok' : outcome === 'refused' || outcome === 'failed' || outcome === 'invalid' || outcome === 'unavailable' || outcome === 'timeout' ? 'failed' : 'skipped',
      correlationId: `proposal:${card.id}`, tainted: false,
      inputs: {
        proposalId: card.id, result: outcome, requests: m.requests ?? 0,
        ...(m.reviewId ? { reviewId: m.reviewId } : {}), ...(m.verdict ? { verdict: m.verdict } : {}), ...(m.agreed !== undefined ? { agreed: m.agreed } : {}),
        ...(m.modelMs !== undefined ? { modelMs: m.modelMs } : {}),
      },
    }], now);
    return { outcome, ...(m.reviewId ? { reviewId: m.reviewId } : {}) };
  };
  if (!s.may) return ended('skipped');
  const ollama = d.config.ollama;
  if (!ollama) return ended('no_model');
  // The day's cap, once for this card: a card that got no slot today is left for tomorrow.
  if (!(await claimOnce(db, card.id, s.cap, tz, now))) return ended('capped');

  const findings = findingsOf(card);
  const facts: CardForReview = { action: card.action, words: ACTION_WORDS[card.action] ?? card.action, reason: card.reason ?? 'It gives no reason.', kind: card.kind, args: card.args, findings };
  // The local model, one request at a time, yielding to chat. No transaction is open while it is asked.
  const asked = await adjudicate(facts, {
    ollama,
    load: d.load ?? chatLoad(d.config.server),
    // Each request is counted before it goes, by the card, where a later job for it finds the count.
    claim: async () => (await claim(db, requestsCounter(card.id), { limit: REQUESTS_A_DAY, period: 'day' }, tz, now)) !== null,
    ...d.seam,
  });
  const counts = { requests: asked.requests, modelMs: asked.modelMs };
  if (!asked.ok) return ended(asked.why, counts);
  await d.hooks?.answered?.();

  // Written and attached together, of the card as it waits NOW: the model may have taken minutes.
  try {
    const reviewId = await db.$transaction(async (tx: Tx) => {
      const again = await waitingCard(tx, card.id, clock());
      if (!again || again.argsDigest !== card.argsDigest) return 'nothing' as const;
      if (again.reviewId) return 'exists' as const;
      const review = await tx.review.create({
        data: {
          subjectType: 'proposal', subjectId: card.id, subjectDigest: card.argsDigest, engine: REVIEW_ENGINE,
          models: { attacker: ollama.model, defender: ollama.model, judge: ollama.model },
          findings: [...findings], reasonCodes: [...asked.reasonCodes],
          attack: asked.attack, defense: asked.defense, verdict: asked.verdict, verdictReason: asked.verdictReason,
          confidence: asked.confidence, agreed: asked.agreed, shadow: s.shadow,
          // As outside text as the card it read, at least; and exactly as sensitive.
          tainted: card.tainted, sensitivity: card.sensitivity, modelMs: asked.modelMs,
        },
        select: { id: true },
      });
      await tx.proposal.update({ where: { id: card.id }, data: { reviewId: review.id } });
      return review.id;
    }, READ_COMMITTED);
    if (reviewId === 'nothing' || reviewId === 'exists') return ended(reviewId, counts);
    return ended('written', { ...counts, reviewId, verdict: asked.verdict, agreed: asked.agreed });
  } catch (err) {
    if (refusedByDb(err)) {
      d.log?.(`reviews: card ${card.id}'s review was not written: ${failureOf(err)}`);
      return ended('refused', counts);
    }
    d.log?.(`reviews: card ${card.id}'s review was not saved: ${failureClass(err)}`);
    return ended('failed', counts);
  }
}

/**
 * The cards to review: each waiting card that needs a review and has none, while
 * Local Reviews is on and a local model is named, oldest first. Stately on the
 * card: a second send for one already waiting is dropped. Returns how many went.
 */
export async function sendCardReviews(d: { db: Db; bus: Pick<Bus, 'boss'>; config: Partial<Pick<Config, 'ollama'>>; now?: () => Date }): Promise<number> {
  if (!d.config.ollama || !(await reviewerOn(d.db))) return 0;
  const now = d.now?.() ?? new Date();
  const cards = await d.db.proposal.findMany({
    where: { status: 'pending', reviewRequired: true, reviewId: null, args: { not: Prisma.AnyNull }, expiresAt: { gt: now } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: SWEEP_LIMIT, select: { id: true },
  });
  let sent = 0;
  for (const c of cards) {
    // A card's id longer than a review can name is never one a review could be written of.
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(c.id)) continue;
    if (await d.bus.boss.send(REVIEW_QUEUE, { proposalId: c.id } satisfies CardReviewJob, { singletonKey: c.id })) sent += 1;
  }
  return sent;
}
