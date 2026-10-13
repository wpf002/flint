/**
 * The runtime's goal routes (P3 part 2), for the server's goals panel proxy.
 * Every one under /v1/goals needs the `proposals` scope, which the runtime
 * connector's token (world:read|ledger) never holds: a model can never read a
 * goal's words. The P3 report (part 4) is the one route here on `world:read`,
 * like P2's and P2.5's reports: it holds numbers only.
 *
 *   GET  /v1/goals?tab=active|suggested|finished   a tab of the panel (GoalsPage)
 *   GET  /v1/goals/:id                             one goal, open (GoalView)
 *   GET  /v1/goals/now                             the active goals for the server's chat block (GoalsNowAnswer, part 4)
 *   POST /v1/goals {draftKey, args}                a new goal's card
 *   POST /v1/goals/linkable {q}                    items a check may watch (a POST: q never lands in a log)
 *   POST /v1/goals/candidates {kind, text, quote, ...}   a goal or commitment Will set in chat, from the server's own
 *                                                  check of his words (part 5): a card, or nothing twice
 *   POST /v1/goals/:id/edit|timing|done|abandon|resume|start|plan {args}   that card (start: Make It a Goal, part 5)
 *   POST /v1/goals/:id/pause|dismiss               unsigned, audited
 *   POST /v1/goals/:id/review                      Review Now: unsigned, audited; it sends the goal's review job (part 3)
 *   POST /v1/goals/:id/criteria/:cid {met}         unsigned, audited
 *   POST /v1/goals/:id/steps/:key {status}         unsigned, audited
 *   GET  /v1/p3/report                             P3's exit criteria, measured now: numbers only (scope world:read)
 *
 * Input is checked with the shared contracts (@flint/policy); a refusal is one of
 * GOAL_SAYS's sentences with its code, and a zod failure is logged by field
 * paths and codes only. Answers are checked against their contracts on the way
 * out. Nothing here logs a goal's words.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  CandidateAnswer,
  CriterionId,
  EmptyBody,
  GOAL_CARD_BODIES,
  GOAL_CARD_VERBS,
  GOAL_TABS,
  GoalAnswer,
  GoalDone,
  GoalFiled,
  GoalId,
  GoalsNowAnswer,
  GoalsPage,
  Linkable,
  LinkableBody,
  MarkBody,
  NewGoalBody,
  StepBody,
  StepKey,
  goalCodeOf,
  type GoalCardVerb,
} from '@flint/policy';
import type { RuntimeScope } from '../config.js';
import type { Db } from '../db.js';
import type { Bus } from '../bus.js';
import { Refused } from '../governance/proposals.js';
import { SAY } from '../goals/errors.js';
import { linkable } from '../goals/items.js';
import { dismissGoal, fileGoalCard, fileNewGoal, markCriterion, pauseGoal, requestReview, setStep } from '../goals/service.js';
import { goalView, goalsPage } from '../goals/view.js';
import { goalsNow } from '../goals/now.js';
import { takeCandidate } from '../goals/candidates.js';
import { p3Report } from '../report/p3.js';

export interface GoalRouteDeps {
  db: Db;
  need: (scope: RuntimeScope) => (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  tz: string;
  /** Flint reviews goals (FLINT_PLANNER is on). Off: the views say so, nothing is late, and Review Now is refused. */
  reviews?: boolean;
  /** The bus, once it has started: Review Now sends the goal's review job through it. */
  bus?: () => Pick<Bus, 'boss'> | undefined;
}

/** An answer that broke its contract on the way out: the runtime's bug (a 500), never a leak. */
export class GoalAnswerBroken extends Error {}

function out<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const r = schema.safeParse(value);
  if (!r.success) throw new GoalAnswerBroken(`a goals answer broke ${r.error.issues.length} rule(s) of its contract at ${[...new Set(r.error.issues.map((i) => i.path.join('.')))].join(', ').slice(0, 200)}`);
  return r.data;
}

/** Input as the contract reads it, or a refusal that names fields and codes (never a value). */
function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const r = schema.safeParse(value);
  if (!r.success) throw new Refused(400, SAY.invalid, r.error.issues.map((i) => `${i.path.join('.') || '<body>'}: ${i.code}`).join('; ').slice(0, 300));
  return r.data;
}

const Tab = z.object({ tab: z.enum(GOAL_TABS).default('active') }).strict();
const Goal = z.object({ id: GoalId }).strict();
const Verb = z.object({ id: GoalId, verb: z.enum(['pause', 'dismiss', 'review', ...(Object.keys(GOAL_CARD_VERBS) as GoalCardVerb[])]) }).strict();
const Criterion = z.object({ id: GoalId, cid: CriterionId }).strict();
const Step = z.object({ id: GoalId, key: StepKey }).strict();

export function registerGoalRoutes(app: FastifyInstance, d: GoalRouteDeps): void {
  const { db, need, tz } = d;
  const reviews = d.reviews ?? false;
  const view = { reviews, tz };
  const pre = { preHandler: need('proposals') };

  /** A refusal as Will reads it, with its code (the server passes on only these); anything else to the app's handler. */
  const guarded = <T>(fn: (req: FastifyRequest, reply: FastifyReply) => Promise<T>) => async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      return await fn(req, reply);
    } catch (err) {
      if (!(err instanceof Refused)) throw err;
      const code = goalCodeOf(err.message);
      if (err.why) {
        const ref = `ref${Date.now().toString(36)}`;
        req.log.warn({ ref, status: err.status, why: err.why }, 'goal route refused');
        return reply.code(err.status).send({ error: err.message, ...(code ? { code } : {}), ref });
      }
      return reply.code(err.status).send({ error: err.message, ...(code ? { code } : {}) });
    }
  };

  app.get('/v1/goals', pre, guarded(async (req) => {
    const { tab } = parse(Tab, req.query ?? {});
    return out(GoalsPage, await goalsPage(db, tab, new Date(), view));
  }));

  // The active goals for the server's chat block (part 4): closed values, and a title only for a goal Will
  // signed that carries no outside text. The same scope as the panel's: never the runtime connector's.
  app.get('/v1/goals/now', pre, guarded(async (req) => {
    parse(EmptyBody, req.query ?? {});
    return out(GoalsNowAnswer, await goalsNow(db, tz));
  }));

  app.get('/v1/goals/:id', pre, guarded(async (req) => {
    const { id } = parse(Goal, req.params);
    const goal = await goalView(db, id, tz, new Date(), view);
    if (!goal) throw new Refused(404, SAY.noGoal);
    return out(GoalAnswer, { goal });
  }));

  app.post('/v1/goals', pre, guarded(async (req) => {
    const body = parse(NewGoalBody, req.body);
    return out(GoalFiled, await fileNewGoal(db, body.args as typeof body.args & Record<string, unknown>));
  }));

  // A suggestion from chat (part 5). The server's own token only (`proposals`): the runtime connector's, the one a
  // model's tools hold, never reaches it. The body is checked again here, whatever the server checked.
  app.post('/v1/goals/candidates', pre, guarded(async (req, reply) => {
    const answer = out(CandidateAnswer, await takeCandidate({ db, tz, reviews, ...(d.bus ? { bus: d.bus } : {}) }, req.body));
    if (answer.outcome !== 'known') void reply.code(201);
    return answer;
  }));

  app.post('/v1/goals/linkable', pre, guarded(async (req) => {
    const { q } = parse(LinkableBody, req.body);
    return out(Linkable, { items: await linkable(db, q, tz) });
  }));

  app.post('/v1/goals/:id/:verb', pre, guarded(async (req) => {
    const { id, verb } = parse(Verb, req.params);
    if (verb === 'pause' || verb === 'dismiss' || verb === 'review') {
      parse(EmptyBody, req.body ?? {});
      if (verb === 'review') await requestReview(db, d.bus?.(), id, { reviews, tz });
      else await (verb === 'pause' ? pauseGoal(db, id) : dismissGoal(db, id));
      return out(GoalDone, { ok: true });
    }
    const v = verb as GoalCardVerb;
    const body = parse(GOAL_CARD_BODIES[v], req.body) as { args: Record<string, unknown> & { goalId: string } };
    return out(GoalFiled, await fileGoalCard(db, v, id, body.args));
  }));

  app.post('/v1/goals/:id/criteria/:cid', pre, guarded(async (req) => {
    const { id, cid } = parse(Criterion, req.params);
    const { met } = parse(MarkBody, req.body);
    await markCriterion(db, id, cid, met, tz);
    return out(GoalDone, { ok: true });
  }));

  app.post('/v1/goals/:id/steps/:key', pre, guarded(async (req) => {
    const { id, key } = parse(Step, req.params);
    const { status } = parse(StepBody, req.body);
    await setStep(db, id, key, status);
    return out(GoalDone, { ok: true });
  }));

  // P3's exit criteria, measured now (part 4). Numbers only, so it is on world:read like P2's and P2.5's reports.
  app.get('/v1/p3/report', { preHandler: need('world:read') }, async () => p3Report(db, { tz, planner: view.reviews }));
}
