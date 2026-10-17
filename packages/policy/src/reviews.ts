/**
 * Reviews (P5): an argued verdict on a card, written before Will approves it, by
 * Local Reviews on this Mac's own model. A review is advice: it never rejects
 * anything. Requiring one before a card can be approved is Will's switch
 * (review.enforce), and then his signature names the review and the verdict he
 * saw; the database holds both (migration p5_assets).
 *
 * What a review holds, as the database takes it:
 *  - findings: what the CODE found in the card, as closed codes (findingsOf):
 *    the same facts that made the card need a review. A model never writes one.
 *  - attack, defense: the case against approving it and the case for, in the
 *    model's own words. Outside text, always shown marked.
 *  - verdict, confidence, reason codes: the judge's, from closed lists, and one
 *    sentence of its own (verdictReason), outside text too.
 *  - agreed: whether the judge gave the same verdict twice, once hearing the case
 *    against first and once the case for first. When it did not, the more careful
 *    of its two verdicts is the one kept.
 *
 * Nothing here puts a card's args, or any word a model wrote, into a reason, an
 * error or a log: the sentences below are what the panel and a refusal say.
 */
import { z } from 'zod';

/** What the database calls the local engine, and the writer of a review's forecasts. */
export const REVIEW_ENGINE = 'local_adj';
export const REVIEWS_WRITER = 'runtime:reviews';

export const REVIEW_VERDICTS = ['proceed', 'proceed_with_changes', 'block'] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];
/** The more careful of two verdicts: a block over a change, a change over going ahead. */
export const carefulOf = (a: ReviewVerdict, b: ReviewVerdict): ReviewVerdict => (REVIEW_VERDICTS.indexOf(a) >= REVIEW_VERDICTS.indexOf(b) ? a : b);

// ---- What the code finds --------------------------------------------------------------

/**
 * The facts about a card that make it need a review (the database's
 * proposal_review_floor reads the same columns), and one more: whether it needs
 * Will's own fresh touch. In this order, always.
 */
export const REVIEW_FINDINGS = ['outside_text', 'cannot_undo', 'spends', 'changes_policy', 'changes_rule', 'opens_pr', 'forgets', 'voids', 'financial', 'consequential'] as const;
export type ReviewFinding = (typeof REVIEW_FINDINGS)[number];

/** A card as the code reads it for its findings: its own columns, never its args. */
export interface CardFacts {
  kind: string;
  tainted: boolean;
  destructive: boolean;
  consequential: boolean;
  sensitivity: string;
}

/** What the code finds in a card. Pure, and a function of the card's own columns alone. */
export function findingsOf(c: CardFacts): ReviewFinding[] {
  const has: Record<ReviewFinding, boolean> = {
    outside_text: c.tainted,
    cannot_undo: c.destructive,
    spends: c.kind === 'spend',
    changes_policy: c.kind === 'policy',
    changes_rule: c.kind === 'rule',
    opens_pr: c.kind === 'pr',
    forgets: c.kind === 'forget',
    voids: c.kind === 'void',
    financial: c.sensitivity === 'financial',
    consequential: c.consequential,
  };
  return REVIEW_FINDINGS.filter((f) => has[f]);
}

/** Each finding as the panel says it. */
export const REVIEW_FINDING_SAYS: Readonly<Record<ReviewFinding, string>> = {
  outside_text: 'It holds text from outside Flint.',
  cannot_undo: 'It can’t be undone.',
  spends: 'It spends money.',
  changes_policy: 'It changes one of your policies.',
  changes_rule: 'It changes one of your rules.',
  opens_pr: 'It opens a pull request.',
  forgets: 'It has Flint forget something.',
  voids: 'It voids a prediction.',
  financial: 'It is about financial data.',
  consequential: 'It needs your own fresh touch to approve.',
};

// ---- What the judge says ----------------------------------------------------------------

/**
 * Why the judge decided as it did: a closed list, at most REVIEW_REASONS_MAX of
 * them on one review. (The database takes up to 8 codes of this shape.)
 */
export const REVIEW_REASONS = [
  'matches_request', 'reversible', 'narrow_scope', 'low_risk',
  'cannot_undo', 'scope_too_wide', 'args_unclear', 'outside_text_steers', 'spends_money', 'changes_rules', 'removes_data', 'bad_timing', 'duplicate',
] as const;
export type ReviewReason = (typeof REVIEW_REASONS)[number];
export const REVIEW_REASONS_MAX = 4;

export const REVIEW_REASON_SAYS: Readonly<Record<ReviewReason, string>> = {
  matches_request: 'It does what it says it does.',
  reversible: 'It can be undone.',
  narrow_scope: 'It touches only what it names.',
  low_risk: 'Little can go wrong.',
  cannot_undo: 'It can’t be undone if it is wrong.',
  scope_too_wide: 'It reaches further than it needs to.',
  args_unclear: 'What it would do isn’t clear from the card.',
  outside_text_steers: 'Text from outside Flint may be steering it.',
  spends_money: 'It spends money.',
  changes_rules: 'It changes how Flint is allowed to act.',
  removes_data: 'It removes something that can’t be brought back.',
  bad_timing: 'Now may be the wrong time for it.',
  duplicate: 'It repeats something already done or waiting.',
};

/** How long each part of a review's words may be (the database's own limits). */
export const ATTACK_CHARS = 2000;
export const DEFENSE_CHARS = 2000;
export const VERDICT_REASON_CHARS = 500;

/** The judge's reply, strictly: a field not named here is refused, and a reason it was not given is too. */
export const JudgeReply = z
  .object({
    verdict: z.enum(REVIEW_VERDICTS),
    confidence: z.number().finite().min(0).max(1),
    reasonCodes: z.array(z.enum(REVIEW_REASONS)).min(1).max(REVIEW_REASONS_MAX).refine((rs) => new Set(rs).size === rs.length, 'a reason is given once'),
    verdictReason: z.string().min(1).max(VERDICT_REASON_CHARS),
  })
  .strict();
export type JudgeReply = z.infer<typeof JudgeReply>;

/** Each verdict as the panel names it, Title Case. */
export const REVIEW_VERDICT_WORDS: Readonly<Record<ReviewVerdict, string>> = {
  proceed: 'Go Ahead',
  proceed_with_changes: 'Go Ahead with Changes',
  block: 'Hold Off',
};

// ---- Approving a card that has one ------------------------------------------------------

/**
 * What Approve says when a card's review stands in its way. Once reviews are
 * required, a card that needs one is approved only by a signature that names its
 * review and that review's verdict; and whenever a card has a review, the one
 * Will signs is the one his card showed.
 */
export const REVIEW_SAYS = {
  waiting: 'It needs its review before you can approve it, and the review isn’t in yet.',
  unseen: 'A review of it came in after you opened it. Read the review, then approve it again.',
} as const;

/**
 * A card's review as the card shows it: the code's findings, the judge's closed verdict and reasons, and its words.
 * Strict: the server passes the console nothing else of a review (never its models, its cost or the digest it was of).
 */
export const ReviewShown = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
    verdict: z.enum(REVIEW_VERDICTS),
    confidence: z.number().finite().min(0).max(1),
    agreed: z.boolean(),
    findings: z.array(z.enum(REVIEW_FINDINGS)).max(REVIEW_FINDINGS.length),
    reasonCodes: z.array(z.enum(REVIEW_REASONS)).max(REVIEW_REASONS_MAX),
    /** The model's words: outside text, always shown marked. Null once cleared (textPurged). */
    attack: z.string().max(ATTACK_CHARS).nullable(),
    defense: z.string().max(DEFENSE_CHARS).nullable(),
    verdictReason: z.string().max(VERDICT_REASON_CHARS).nullable(),
    shadow: z.boolean(),
    textPurged: z.boolean(),
    createdAt: z.string().max(40),
  })
  .strip();
export type ReviewShown = z.infer<typeof ReviewShown>;

// ---- The job ----------------------------------------------------------------------------

/** A card's id as a review names it (the database's Review takes 40 characters at most). */
export const ReviewSubjectId = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);
/** One review's job: the card it is of, and nothing of its words. */
export const CardReviewJob = z.object({ proposalId: ReviewSubjectId }).strict();
export type CardReviewJob = z.infer<typeof CardReviewJob>;
