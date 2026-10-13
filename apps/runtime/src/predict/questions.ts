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
 *  - A question waits two weeks from when Will was told of it (the sweep's rule
 *    for letting his predictions run out, ledger/sweep.ts questionLapsed);
 *    after that it is gone from the list and can no longer be answered. One
 *    asked in shadow was announced to nobody, so its two weeks have not
 *    begun: it waits, and stays answerable, until two weeks after he first
 *    lets Flint ask on its own.
 *  - What he is shown is what he answers: the prediction in plain words, what
 *    Flint said and when, and when it was due (his answer is recorded as of
 *    that moment). A prediction Flint cannot put in plain words (its item is
 *    gone or is a person, its number is not one of Flint's, its words are from
 *    outside text, or it would not fit the panel) is never answered Yes or No
 *    by anyone: the panel offers only Skip, and Yes or No is refused here.
 *
 * A prediction's words are shown to Will only: nothing here logs or audits
 * them. One made from outside text has no free words at all (its claim is a
 * fixed template around an item's ref), and it is shown in fixed words around
 * the item's own label; were its words ever free text, they are not shown.
 */
import { randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { CODE_TABLE, PREDICT_SAYS, QuestionView, resolveTier, runsInShadow, type QuestionAnswer, type QuestionsPage } from '@flint/policy';
import type { Db, Tx } from '../db.js';
import { sqlState } from '../dbcodes.js';
import { appendAudit } from '../governance/audit.js';
import { claim } from '../governance/counters.js';
import { Refused, activePolicies } from '../governance/proposals.js';
import { labelFor } from '../goals/items.js';
import { LEDGER_ACTOR, WILL_GRACE_MS, announcedSince, questionLapsed } from '../ledger/sweep.js';
import { PANEL, answeredSays, dayWords, dueSays, saidSays, templatedClaim, thresholdClaim } from './phrasing.js';
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

/**
 * A question still open to an answer: unanswered, its prediction unsettled, and its two weeks not run out
 * (questionLapsed: the same rule, here as a filter). `since`: announcedSince().
 */
function waitingWhere(now: Date, since: Date | null): Prisma.PredictionQuestionWhereInput {
  const cutoff = new Date(now.getTime() - WILL_GRACE_MS);
  // Asked in shadow: its two weeks start at `since`; with none, or one inside the last two weeks, every such question still waits.
  const quiet: Prisma.PredictionQuestionWhereInput = since === null || since.getTime() > cutoff.getTime() ? { shadow: true } : { shadow: true, askedAt: { gt: cutoff } };
  return {
    answer: null,
    OR: [{ shadow: false, askedAt: { gt: cutoff } }, quiet],
    prediction: { is: { resolver: 'will', status: { in: ['open', 'superseded'] }, resolution: { is: null } } },
  };
}

/** How many questions wait for Will. */
export async function questionsWaiting(db: Db, now = new Date()): Promise<number> {
  return db.predictionQuestion.count({ where: waitingWhere(now, await announcedSince(db, now)) });
}

const REF = '([a-z_]{2,20})#([A-Za-z0-9]{1,12})';
const TEMPLATED: ReadonlyArray<readonly [RegExp, 'healthy' | 'deploy' | 'closed']> = [
  [new RegExp(`^${REF} reports healthy at the resolve time$`), 'healthy'],
  [new RegExp(`^the next deployment of ${REF} succeeds$`), 'deploy'],
  [new RegExp(`^${REF} is closed by the resolve time$`), 'closed'],
];
const THRESHOLD = /^([a-z0-9_]+(?:\.[a-z0-9_-]+)+) is (above|below) (-?\d+(?:\.\d+)?(?:e[+-]?\d+)?) at the resolve time$/;
/** The largest value a templated claim is said with. Past it the number is no number of Flint's, and its digits alone would overflow the panel. */
export const MAX_SAID = 1e12;
/** A title's longest form (QuestionView, @flint/policy). */
const TITLE_MAX = 300;

/** A prediction as it can be said: its words, and whether they say plainly what it was about. */
interface Said {
  title: string;
  answerable: boolean;
}
/** One Flint cannot put in plain words: said only as a prediction it made in a chat, and never answered Yes or No. */
const UNSAID: Said = { title: PANEL.outsideClaim, answerable: false };

/**
 * A prediction as the panel says it. Chat records one in its own words, or as a
 * fixed template around an item's ref or a series' key (always a template when
 * the turn read outside text). A template is said in fixed words around the
 * item's own label or the number's name, so a ref or a key is never shown; its
 * own words are shown as they are.
 *
 * What cannot be said plainly is not said at all, and cannot be answered Yes or
 * No: a template whose item is gone, forgotten, ambiguous or a person; a
 * threshold on a number that is not one of Flint's, or with a value no number
 * of Flint's takes; anything that would not fit a title; and free words on a
 * prediction marked as made from outside text (the ledger turns those into a
 * template when it records one, so such a row is a rogue or an older one: this
 * check is what stands between a stranger's words and Will's screen).
 */
async function saidOf(db: Db | Tx, p: { claim: string; tainted: boolean }, tz: string, now: Date): Promise<Said> {
  const fits = (title: string): Said => (title.length >= 1 && title.length <= TITLE_MAX ? { title, answerable: true } : UNSAID);
  for (const [shape, kind] of TEMPLATED) {
    const m = p.claim.match(shape);
    if (!m) continue;
    // The ref is the item's kind and the last six characters of its id; a person is never named here.
    const found = m[1] === 'person' ? [] : await db.entity.findMany({ where: { kind: m[1]!, id: { endsWith: m[2]! }, status: { not: 'forgotten' } }, take: 2, select: { id: true, kind: true, key: true, name: true, taintedPaths: true, firstSeenAt: true } });
    return found.length === 1 ? fits(templatedClaim(kind, await labelFor(db, found[0]!, tz, now))) : UNSAID;
  }
  const t = p.claim.match(THRESHOLD);
  if (t) {
    const def = forecastSeries(t[1]!);
    const value = Number(t[3]);
    return def && Number.isFinite(value) && Math.abs(value) <= MAX_SAID ? fits(thresholdClaim(def.name, t[2] as 'above' | 'below', value, def.unit as ForecastUnit)) : UNSAID;
  }
  if (p.tainted) return UNSAID;
  return fits(p.claim.replace(/\s+/g, ' ').trim());
}

/** What one question's row is made from. */
interface AskedRow {
  predictionId: string;
  answer: string | null;
  answeredAt: Date | null;
  prediction: { claim: string; tainted: boolean; probability: number | null; createdAt: Date; resolveBy: Date };
}

/**
 * One question as the panel shows it, or undefined for a row that cannot be shown at all (its id is no id).
 * A waiting one says what Flint said, when, and when it was due; one that cannot be said plainly says that
 * instead, and is Skip only. A row that would break the panel's contract is never passed on as it is, and never
 * takes the page down: it is replaced by the plain one.
 */
async function questionView(db: Db | Tx, q: AskedRow, tz: string, now: Date): Promise<QuestionView | undefined> {
  const answer = q.answer === 'yes' || q.answer === 'no' || q.answer === 'skip' ? q.answer : null;
  const answered = answer && q.answeredAt ? answeredSays(answer, dayWords(q.answeredAt, tz, now)) : undefined;
  const plain = { id: q.predictionId, title: UNSAID.title, says: answered ?? PREDICT_SAYS.unanswerable, answer, answerable: false };
  let said: Said;
  try {
    said = await saidOf(db, q.prediction, tz, now);
  } catch (err) {
    // A database that cannot be read is the route's failure to report, not a reason to show a made-up row.
    if (sqlState(err) !== undefined || (err instanceof Error && err.name.startsWith('PrismaClient'))) throw err;
    said = UNSAID;
  }
  const asked = (): string => `${saidSays(q.prediction.probability ?? 0.5, dayWords(q.prediction.createdAt, tz, now))} ${dueSays(q.prediction.resolveBy, tz, now)}`;
  let row: unknown = plain;
  if (said.answerable && q.prediction.probability !== null) {
    try {
      row = { ...plain, title: said.title, says: answered ?? asked(), answerable: true };
    } catch {
      row = plain;
    }
  }
  const fit = QuestionView.safeParse(row);
  if (fit.success) return fit.data;
  const fallback = QuestionView.safeParse(plain);
  return fallback.success ? fallback.data : undefined;
}

/**
 * The Questions tab: what waits for Will, oldest first, and the latest he answered. `predict`: predictions may run
 * on this Mac; switched off, the page says so and nothing on it can be answered.
 */
export async function questionsPage(db: Db, o: { tz: string; now?: Date; predict?: boolean }): Promise<QuestionsPage> {
  const now = o.now ?? new Date();
  const select = { predictionId: true, answer: true, answeredAt: true, prediction: { select: { claim: true, tainted: true, probability: true, createdAt: true, resolveBy: true } } } as const;
  const [open, done] = [
    await db.predictionQuestion.findMany({ where: waitingWhere(now, await announcedSince(db, now)), orderBy: [{ askedAt: 'asc' }, { predictionId: 'asc' }], take: 50, select }),
    await db.predictionQuestion.findMany({ where: { answer: { not: null } }, orderBy: [{ answeredAt: 'desc' }, { predictionId: 'asc' }], take: ANSWERED_SHOWN, select }),
  ];
  const waiting: QuestionView[] = [];
  for (const q of open) {
    const v = await questionView(db, q, o.tz, now);
    if (v) waiting.push(v);
  }
  const answered: QuestionView[] = [];
  for (const q of done) {
    const v = await questionView(db, q, o.tz, now);
    if (v) answered.push(v);
  }
  return { waiting, answered, offHere: o.predict === false };
}

/**
 * Will's answer to one question, once. Yes or No also records the result as
 * his; Skip records none. Refused, in a sentence, when the question is not
 * there, was answered, can no longer be answered (its prediction is settled,
 * set aside or ran out, or its two weeks have passed), or when it is Yes or No
 * to a prediction Flint cannot say plainly (questionView: what the panel
 * shows is what decides, so nothing is answered that he was not shown).
 */
export async function answerQuestion(db: Db, id: string, answer: QuestionAnswer, o: { tz: string; now?: Date }): Promise<void> {
  const now = o.now ?? new Date();
  try {
    await db.$transaction(async (tx: Tx) => {
      // This transaction's writes are Will's: the database takes an answer from no one else.
      await tx.$queryRaw`SELECT set_config('flint.actor', ${CONSOLE_ACTOR}, true)`;
      const [q] = await tx.$queryRaw<Array<{
        answer: string | null; askedAt: Date; shadow: boolean; status: string; resolveBy: Date; resolver: string; resolved: boolean; claim: string; tainted: boolean; probability: number | null; createdAt: Date;
      }>>`
        SELECT q.answer, q."askedAt", q.shadow, p.status, p."resolveBy", p.resolver, p.claim, p.tainted, p.probability, p."createdAt",
               EXISTS (SELECT 1 FROM "Resolution" r WHERE r."predictionId" = p.id) AS resolved
        FROM "PredictionQuestion" q JOIN "Prediction" p ON p.id = q."predictionId"
        WHERE q."predictionId" = ${id} FOR UPDATE OF q`;
      if (!q) throw new Refused(404, PREDICT_SAYS.noQuestion);
      if (q.answer !== null) throw new Refused(409, PREDICT_SAYS.answered);
      // Only a prediction that is his to settle and still unsettled: not one resolved, run out, set aside, or another resolver's.
      if (q.resolver !== 'will') throw new Refused(409, PREDICT_SAYS.noQuestion);
      if (q.status !== 'open' && q.status !== 'superseded') throw new Refused(409, PREDICT_SAYS.noQuestion);
      if (q.resolved) throw new Refused(409, PREDICT_SAYS.noQuestion);
      if (questionLapsed(q, await announcedSince(tx, now), now)) throw new Refused(409, PREDICT_SAYS.noQuestion);
      if (answer !== 'skip') {
        // Yes or No only to what the panel showed him in plain words.
        const shown = await questionView(tx, { predictionId: id, answer: null, answeredAt: null, prediction: q }, o.tz, now);
        if (!shown?.answerable) throw new Refused(409, PREDICT_SAYS.unanswerable);
      }
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
    // The database said no to the answer or its result: the prediction was settled, ran out or was set aside between
    // the look above and the write (the sweep got there first), or the same answer landed twice. Nothing was written.
    if (refusedByDb(err) || (err as { code?: unknown } | null)?.code === 'P2002') throw new Refused(409, PREDICT_SAYS.noQuestion);
    throw err;
  }
}
