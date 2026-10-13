/**
 * The runtime's prediction routes (P4 part 4), for the server's Predictions
 * panel proxy. Every one needs the `proposals` scope, which the runtime
 * connector's token (world:read|ledger) never holds: a model can never read a
 * forecast's numbers (spend and calendar hours among them), a question's words
 * or answer one for Will.
 *
 *   GET  /v1/predictions/waiting                      is the panel there, and how many questions wait (PredictionsWaiting: no number of a series)
 *   GET  /v1/predictions                              the Forecasts tab (PredictionsPage)
 *   GET  /v1/predictions/series/:key                  one number, open (SeriesAnswer)
 *   GET  /v1/predictions/questions                    Will's questions (QuestionsPage)
 *   GET  /v1/predictions/accuracy                     how Flint has done (AccuracyView)
 *   POST /v1/predictions/turn-on {series}             the Turn On Predictions card, for the numbers he ticked
 *   POST /v1/predictions/series/:key/turn-off {}      unsigned, audited
 *   POST /v1/predictions/questions/:id/answer {answer}  his yes, no or skip: unsigned, audited, recorded as his
 *
 * With predictions switched off on this Mac (FLINT_PREDICT), turning on and
 * answering are refused with the sentence that says so, and the page, the
 * questions and the scores say it too. Turning a number off stays allowed: it
 * only narrows what Flint does. The reads still answer.
 *
 * Input is checked with the shared contracts (@flint/policy); a refusal is one
 * of PREDICT_SAYS's sentences with its code, and a zod failure is logged by
 * field paths and codes only. Answers are checked against their contracts on
 * the way out. Nothing here logs a number's value or a prediction's words.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AccuracyView, AnswerBody, PREDICT_SAYS, PredictDone, PredictEmptyBody, PredictFiled, PredictionRef, PredictionsPage, PredictionsWaiting, QuestionsPage, SeriesAnswer, SeriesKey, TurnOnBody, predictCodeOf } from '@flint/policy';
import type { RuntimeScope } from '../config.js';
import type { Db } from '../db.js';
import { Refused } from '../governance/proposals.js';
import { proposeForecasts, turnOffSeries } from '../predict/enable.js';
import { answerQuestion, questionsPage, questionsWaiting } from '../predict/questions.js';
import { accuracyView, predictionsPage, questionsAnnounced, seriesView } from '../predict/view.js';

export interface PredictionRouteDeps {
  db: Db;
  need: (scope: RuntimeScope) => (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  tz: string;
  /** Predictions may run on this Mac (FLINT_PREDICT is on). Off: the views say so, and nothing can be turned on from here. */
  predict?: boolean;
}

/** An answer that broke its contract on the way out: the runtime's bug (a 500), never a leak. */
export class PredictAnswerBroken extends Error {}

function out<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const r = schema.safeParse(value);
  if (!r.success) throw new PredictAnswerBroken(`a predictions answer broke ${r.error.issues.length} rule(s) of its contract at ${[...new Set(r.error.issues.map((i) => i.path.join('.')))].join(', ').slice(0, 200)}`);
  return r.data;
}

/** Input as the contract reads it, or a refusal that names fields and codes (never a value). */
function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const r = schema.safeParse(value);
  if (!r.success) throw new Refused(400, PREDICT_SAYS.request, r.error.issues.map((i) => `${i.path.join('.') || '<body>'}: ${i.code}`).join('; ').slice(0, 300));
  return r.data;
}

const Series = z.object({ key: SeriesKey }).strict();
const Question = z.object({ id: PredictionRef }).strict();
const None = z.object({}).strict();

export function registerPredictionRoutes(app: FastifyInstance, d: PredictionRouteDeps): void {
  const { db, need, tz } = d;
  const view = { tz, predict: d.predict ?? false };
  const pre = { preHandler: need('proposals') };

  /** A refusal as Will reads it, with its code (the server passes on only these); anything else to the app's handler. */
  const guarded = <T>(fn: (req: FastifyRequest) => Promise<T>) => async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      return await fn(req);
    } catch (err) {
      if (!(err instanceof Refused)) throw err;
      const code = predictCodeOf(err.message);
      if (err.why) {
        const ref = `ref${Date.now().toString(36)}`;
        req.log.warn({ ref, status: err.status, why: err.why }, 'predictions route refused');
        return reply.code(err.status).send({ error: err.message, ...(code ? { code } : {}), ref });
      }
      return reply.code(err.status).send({ error: err.message, ...(code ? { code } : {}) });
    }
  };

  // What the console asks when it loads: two facts, and no number of any series. A forecast is read only when
  // Will opens the panel.
  app.get('/v1/predictions/waiting', pre, guarded(async (req) => {
    parse(None, req.query ?? {});
    // Switched off on this Mac, nothing can be answered here: nothing is said to wait.
    if (!view.predict) return out(PredictionsWaiting, { questions: 0, announce: false });
    return out(PredictionsWaiting, { questions: await questionsWaiting(db), announce: await questionsAnnounced(db) });
  }));

  app.get('/v1/predictions', pre, guarded(async (req) => {
    parse(None, req.query ?? {});
    return out(PredictionsPage, await predictionsPage(db, view));
  }));

  app.get('/v1/predictions/questions', pre, guarded(async (req) => {
    parse(None, req.query ?? {});
    return out(QuestionsPage, await questionsPage(db, { tz, predict: view.predict }));
  }));

  app.get('/v1/predictions/accuracy', pre, guarded(async (req) => {
    parse(None, req.query ?? {});
    return out(AccuracyView, await accuracyView(db, view));
  }));

  app.get('/v1/predictions/series/:key', pre, guarded(async (req) => {
    const { key } = parse(Series, req.params);
    parse(None, req.query ?? {});
    const series = await seriesView(db, key, view);
    if (!series) throw new Refused(404, PREDICT_SAYS.unknown);
    return out(SeriesAnswer, { series });
  }));

  // The card Will signs in the console, for the numbers he ticked. Not while predictions are switched off on this
  // Mac: a card signed then would turn numbers on that nothing forecasts.
  app.post('/v1/predictions/turn-on', pre, guarded(async (req) => {
    const { series } = parse(TurnOnBody, req.body);
    if (!view.predict) throw new Refused(409, PREDICT_SAYS.offHere);
    const filed = await proposeForecasts(db, series, new Date(), 'console');
    return out(PredictFiled, { id: filed.id, deduped: filed.deduped });
  }));

  app.post('/v1/predictions/series/:key/turn-off', pre, guarded(async (req) => {
    const { key } = parse(Series, req.params);
    parse(PredictEmptyBody, req.body ?? {});
    await turnOffSeries(db, key);
    return out(PredictDone, { ok: true });
  }));

  app.post('/v1/predictions/questions/:id/answer', pre, guarded(async (req) => {
    const { id } = parse(Question, req.params);
    const { answer } = parse(AnswerBody, req.body);
    // Switched off on this Mac, nothing is recorded here: an answer waits until predictions are on again.
    if (!view.predict) throw new Refused(409, PREDICT_SAYS.offHere);
    await answerQuestion(db, id, answer, { tz });
    return out(PredictDone, { ok: true });
  }));
}
