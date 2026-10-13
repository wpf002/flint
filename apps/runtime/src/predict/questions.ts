/**
 * Will's questions (P4 part 4; queue ledger.ask, action ledger.resolve.ask_will):
 * a prediction only Will can settle (one Flint made in a chat) is put to him
 * once it is due, as a yes/no question in the console's Predictions panel.
 *
 *  - Asking (askQuestions, each morning): the due, unresolved yes/no
 *    predictions only he resolves that have no question yet, oldest first, at
 *    most 5 new ones a day. A question and its slot under the day's cap are
 *    written in one transaction, so two runs at once can never ask a sixth, and
 *    a question the database refuses (it was asked meanwhile, or is no longer
 *    due) gives its slot back. While the action is at APPROVAL a question is
 *    recorded in shadow and waits in the panel: nothing announces it. One audit
 *    entry per run, counts and ids.
 *  - Answering (answerQuestion, from the console's route only): Yes or No
 *    records his answer and the result as his, with the prediction's own
 *    resolve time as when it happened, in one transaction that says it is his
 *    (flint.actor `will:console`). The database refuses a result recorded as
 *    his without that answer, and refuses a second answer. Skip records the
 *    answer and no result: the prediction runs out, unscored. Unsigned on
 *    purpose: an answer is his own observation, not an action of Flint's.
 *  - A question waits two weeks from when it was asked (the sweep's rule for
 *    letting his predictions run out); after that it is gone from the list and
 *    can no longer be answered.
 *
 * A prediction's words are shown to Will only: nothing here logs or audits
 * them. One made from outside text has no free words at all (its claim is a
 * fixed template around an item's ref), and it is shown in fixed words around
 * the item's own label.
 */
import { randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { CODE_TABLE, PREDICT_SAYS, resolveTier, runsInShadow, type QuestionAnswer, type QuestionView, type QuestionsPage } from '@flint/policy';
import type { Db, Tx } from '../db.js';
import { sqlState } from '../dbcodes.js';
import { appendAudit } from '../governance/audit.js';
import { claim } from '../governance/counters.js';
import { Refused, activePolicies } from '../governance/proposals.js';
import { labelFor } from '../goals/items.js';
import { LEDGER_ACTOR, WILL_GRACE_MS } from '../ledger/sweep.js';
import { PANEL, answeredSays, dayWords, saidSays, templatedClaim, thresholdClaim } from './phrasing.js';
import { refusedByDb } from './run.js';
import { forecastSeries } from './series.js';
import type { ForecastUnit } from './forecast.js';

/** The policy action questions are asked under. */
export const ASK_ACTION = 'ledger.resolve.ask_will';
/** What the audit entry of one of his answers is recorded under. */
export const ANSWER_ACTION = 'ledger.resolve.will';
/** Who an answer is by. */
export const CONSOLE_ACTOR = 'will:console';
/** The most answered questions the panel lists. */
const ANSWERED_SHOWN = 10;

const RC = { maxWait: 10_000, timeout: 20_000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted } as const;
const newId = (prefix: string, now: Date) => `${prefix}${now.getTime().toString(36)}${randomBytes(6).toString('hex')}`;

export interface AskCounts {
  /** Due predictions with no question yet (at most four days' worth is read). */
  due: number;
  /** Questions asked this run. */
  asked: number;
  /** Left for another day: the day's cap was reached. */
  capped: number;
  /** Not asked: the database refused (asked meanwhile, or no longer due). */
  refused: number;
  /** Recorded in shadow: nothing announces them. */
  shadow: boolean;
  /** False when a rule forbids asking. */
  allowed: boolean;
}

/** The morning's questions: the oldest due predictions only Will resolves, up to the day's cap. */
export async function askQuestions(db: Db, o: { tz: string; now?: Date }): Promise<AskCounts> {
  const now = o.now ?? new Date();
  const t = resolveTier(ASK_ACTION, { context: 'autonomous', tainted: false, policies: await activePolicies(db, now), now });
  const cap = t.cap ?? CODE_TABLE[ASK_ACTION]!.cap!;
  const allowed = t.tier === 'alone' || (t.tier === 'approval' && runsInShadow(ASK_ACTION));
  const c: AskCounts = { due: 0, asked: 0, capped: 0, refused: 0, shadow: t.tier !== 'alone', allowed };
  const asked: string[] = [];
  if (allowed) {
    const due = await db.$queryRaw<Array<{ id: string }>>`
      SELECT p.id FROM "Prediction" p
      WHERE p.resolver = 'will' AND p.kind = 'binary' AND p.status IN ('open', 'superseded') AND p."resolveBy" <= ${now}
        AND NOT EXISTS (SELECT 1 FROM "Resolution" r WHERE r."predictionId" = p.id)
        AND NOT EXISTS (SELECT 1 FROM "PredictionQuestion" q WHERE q."predictionId" = p.id)
      ORDER BY p."resolveBy", p.id LIMIT ${cap.limit * 4}`;
    c.due = due.length;
    for (const [i, p] of due.entries()) {
      try {
        // The slot and the question together: a question that is not written gives its slot back.
        const did = await db.$transaction(async (tx: Tx) => {
          if ((await claim(tx, ASK_ACTION, cap, o.tz, now)) === null) return false;
          await tx.predictionQuestion.create({ data: { predictionId: p.id, shadow: c.shadow } });
          return true;
        }, RC);
        if (!did) {
          c.capped = due.length - i;
          break;
        }
        c.asked += 1;
        asked.push(p.id);
      } catch (err) {
        if (!refusedByDb(err) && (err as { code?: unknown } | null)?.code !== 'P2002') throw err;
        c.refused += 1;
      }
    }
  }
  await appendAudit(db, [{
    actor: LEDGER_ACTOR, context: 'autonomous', kind: 'action', action: ASK_ACTION, tier: t.tier, decision: c.shadow ? 'log' : 'act', outcome: allowed ? 'ok' : 'skipped',
    inputs: { due: c.due, asked: c.asked, capped: c.capped, refused: c.refused, shadow: c.shadow, ...(asked.length ? { predictionIds: asked.slice(0, 20) } : {}) },
  }], now);
  return c;
}

/** A question still open to an answer: unanswered, asked within two weeks, its prediction unsettled. */
const waitingWhere = (now: Date): Prisma.PredictionQuestionWhereInput => ({
  answer: null,
  askedAt: { gt: new Date(now.getTime() - WILL_GRACE_MS) },
  prediction: { is: { resolver: 'will', status: { in: ['open', 'superseded'] }, resolution: { is: null } } },
});

/** How many questions wait for Will. */
export async function questionsWaiting(db: Db, now = new Date()): Promise<number> {
  return db.predictionQuestion.count({ where: waitingWhere(now) });
}

const REF = '([a-z_]{2,20})#([A-Za-z0-9]{1,12})';
const TEMPLATED: ReadonlyArray<readonly [RegExp, 'healthy' | 'deploy' | 'closed']> = [
  [new RegExp(`^${REF} reports healthy at the resolve time$`), 'healthy'],
  [new RegExp(`^the next deployment of ${REF} succeeds$`), 'deploy'],
  [new RegExp(`^${REF} is closed by the resolve time$`), 'closed'],
];
const THRESHOLD = /^([a-z0-9_]+(?:\.[a-z0-9_-]+)+) is (above|below) (-?\d+(?:\.\d+)?(?:e[+-]?\d+)?) at the resolve time$/;

/**
 * A prediction as the panel says it. Chat records one in its own words, or as a
 * fixed template around an item's ref or a series' key (always a template when
 * the turn read outside text). A template is said in fixed words around the
 * item's own label or the number's name, so a ref or a key is never shown; its
 * own words are shown as they are. One made from outside text whose template
 * cannot be named (its item is gone, or is a person) is said only as a
 * prediction Flint made in a chat: never in words that could be a stranger's.
 */
async function titleOf(db: Db, p: { claim: string; tainted: boolean }, tz: string, now: Date): Promise<string> {
  for (const [shape, kind] of TEMPLATED) {
    const m = p.claim.match(shape);
    if (!m) continue;
    // The ref is the item's kind and the last six characters of its id; a person is never named here.
    const found = m[1] === 'person' ? [] : await db.entity.findMany({ where: { kind: m[1]!, id: { endsWith: m[2]! }, status: { not: 'forgotten' } }, take: 2, select: { id: true, kind: true, key: true, name: true, taintedPaths: true, firstSeenAt: true } });
    return found.length === 1 ? templatedClaim(kind, await labelFor(db, found[0]!, tz, now)).slice(0, 300) : PANEL.outsideClaim;
  }
  const t = p.claim.match(THRESHOLD);
  if (t) {
    const def = forecastSeries(t[1]!);
    return def && Number.isFinite(Number(t[3])) ? thresholdClaim(def.name, t[2] as 'above' | 'below', Number(t[3]), def.unit as ForecastUnit) : PANEL.outsideClaim;
  }
  if (p.tainted) return PANEL.outsideClaim;
  return p.claim.replace(/\s+/g, ' ').trim().slice(0, 300) || PANEL.outsideClaim;
}

/** The Questions tab: what waits for Will, oldest first, and the latest he answered. */
export async function questionsPage(db: Db, o: { tz: string; now?: Date }): Promise<QuestionsPage> {
  const now = o.now ?? new Date();
  const select = { predictionId: true, answer: true, answeredAt: true, prediction: { select: { claim: true, tainted: true, probability: true, createdAt: true } } } as const;
  const [open, done] = [
    await db.predictionQuestion.findMany({ where: waitingWhere(now), orderBy: [{ askedAt: 'asc' }, { predictionId: 'asc' }], take: 50, select }),
    await db.predictionQuestion.findMany({ where: { answer: { not: null } }, orderBy: [{ answeredAt: 'desc' }, { predictionId: 'asc' }], take: ANSWERED_SHOWN, select }),
  ];
  const view = async (q: (typeof open)[number]): Promise<QuestionView> => {
    const answer = q.answer === 'yes' || q.answer === 'no' || q.answer === 'skip' ? q.answer : null;
    return {
      id: q.predictionId,
      title: await titleOf(db, q.prediction, o.tz, now),
      says: answer && q.answeredAt ? answeredSays(answer, dayWords(q.answeredAt, o.tz, now)) : saidSays(q.prediction.probability ?? 0.5, dayWords(q.prediction.createdAt, o.tz, now)),
      answer,
    };
  };
  const waiting: QuestionView[] = [];
  for (const q of open) waiting.push(await view(q));
  const answered: QuestionView[] = [];
  for (const q of done) answered.push(await view(q));
  return { waiting, answered };
}

/**
 * Will's answer to one question, once. Yes or No also records the result as
 * his; Skip records none. Refused, in a sentence, when the question is not
 * there, was answered, or can no longer be (its prediction is settled or ran
 * out, or two weeks have passed).
 */
export async function answerQuestion(db: Db, id: string, answer: QuestionAnswer, now = new Date()): Promise<void> {
  try {
    await db.$transaction(async (tx: Tx) => {
      // This transaction's writes are Will's: the database takes an answer from no one else.
      await tx.$queryRaw`SELECT set_config('flint.actor', ${CONSOLE_ACTOR}, true)`;
      const [q] = await tx.$queryRaw<Array<{ answer: string | null; askedAt: Date; status: string; resolveBy: Date; resolver: string; resolved: boolean }>>`
        SELECT q.answer, q."askedAt", p.status, p."resolveBy", p.resolver, EXISTS (SELECT 1 FROM "Resolution" r WHERE r."predictionId" = p.id) AS resolved
        FROM "PredictionQuestion" q JOIN "Prediction" p ON p.id = q."predictionId"
        WHERE q."predictionId" = ${id} FOR UPDATE OF q`;
      if (!q) throw new Refused(404, PREDICT_SAYS.noQuestion);
      if (q.answer !== null) throw new Refused(409, PREDICT_SAYS.answered);
      const open = q.resolver === 'will' && (q.status === 'open' || q.status === 'superseded') && !q.resolved && q.askedAt.getTime() > now.getTime() - WILL_GRACE_MS;
      if (!open) throw new Refused(409, PREDICT_SAYS.noQuestion);
      await tx.$executeRaw`UPDATE "PredictionQuestion" SET answer = ${answer} WHERE "predictionId" = ${id}`;
      if (answer !== 'skip') {
        // The result, as his: what happened, as of the prediction's own resolve time. The database checks it against the answer just written.
        await tx.resolution.create({ data: { id: newId('rs', now), predictionId: id, outcome: answer === 'yes', eventAt: q.resolveBy, resolvedBy: 'will', evidence: { via: ANSWER_ACTION } } });
      }
      await appendAudit(tx, [{ actor: CONSOLE_ACTOR, context: 'console', kind: 'action', action: ANSWER_ACTION, outcome: 'ok', correlationId: `${id}.answer`, tainted: false, inputs: { predictionId: id, answer } }], now);
    }, RC);
  } catch (err) {
    if (err instanceof Refused) throw err;
    const state = sqlState(err);
    if (state === '40001' || state === '40P01' || state === '55P03') throw new Refused(409, PREDICT_SAYS.busy);
    throw err;
  }
}
