/**
 * The runtime's goal routes (P3 part 2), for the server's goals panel proxy.
 * Every one needs the `proposals` scope, which the runtime connector's token
 * (world:read|ledger) never holds: a model can never read a goal's words.
 *
 *   GET  /v1/goals?tab=active|suggested|finished   a tab of the panel (GoalsPage)
 *   GET  /v1/goals/:id                             one goal, open (GoalView)
 *   POST /v1/goals {draftKey, args}                a new goal's card
 *   POST /v1/goals/linkable {q}                    items a check may watch (a POST: q never lands in a log)
 *   POST /v1/goals/:id/edit|timing|done|abandon|resume|plan {args}   that card
 *   POST /v1/goals/:id/pause|dismiss               unsigned, audited
 *   POST /v1/goals/:id/criteria/:cid {met}         unsigned, audited
 *   POST /v1/goals/:id/steps/:key {status}         unsigned, audited
 *
 * Input is checked with the shared contracts (@flint/policy); a refusal is one of
 * GOAL_SAYS's sentences with its code, and a zod failure is logged by field
 * paths and codes only. Answers are checked against their contracts on the way
 * out. Nothing here logs a goal's words.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  CriterionId,
  EmptyBody,
  GOAL_CARD_BODIES,
  GOAL_CARD_VERBS,
  GOAL_TABS,
  GoalAnswer,
  GoalDone,
  GoalFiled,
  GoalId,
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
import { Refused } from '../governance/proposals.js';
import { SAY } from '../goals/errors.js';
import { linkable } from '../goals/items.js';
import { dismissGoal, fileGoalCard, fileNewGoal, markCriterion, pauseGoal, setStep } from '../goals/service.js';
import { goalView, goalsPage } from '../goals/view.js';

export interface GoalRouteDeps {
  db: Db;
  need: (scope: RuntimeScope) => (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  tz: string;
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
const Verb = z.object({ id: GoalId, verb: z.enum(['pause', 'dismiss', ...(Object.keys(GOAL_CARD_VERBS) as GoalCardVerb[])]) }).strict();
const Criterion = z.object({ id: GoalId, cid: CriterionId }).strict();
const Step = z.object({ id: GoalId, key: StepKey }).strict();

export function registerGoalRoutes(app: FastifyInstance, d: GoalRouteDeps): void {
  const { db, need, tz } = d;
  const pre = { preHandler: need('proposals') };

  /** A refusal as Will reads it, with its code (the server passes on only these); anything else to the app's handler. */
  const guarded = <T>(fn: (req: FastifyRequest) => Promise<T>) => async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      return await fn(req);
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
    return out(GoalsPage, await goalsPage(db, tab));
  }));

  app.get('/v1/goals/:id', pre, guarded(async (req) => {
    const { id } = parse(Goal, req.params);
    const goal = await goalView(db, id, tz);
    if (!goal) throw new Refused(404, SAY.noGoal);
    return out(GoalAnswer, { goal });
  }));

  app.post('/v1/goals', pre, guarded(async (req) => {
    const body = parse(NewGoalBody, req.body);
    return out(GoalFiled, await fileNewGoal(db, body.args as typeof body.args & Record<string, unknown>));
  }));

  app.post('/v1/goals/linkable', pre, guarded(async (req) => {
    const { q } = parse(LinkableBody, req.body);
    return out(Linkable, { items: await linkable(db, q, tz) });
  }));

  app.post('/v1/goals/:id/:verb', pre, guarded(async (req) => {
    const { id, verb } = parse(Verb, req.params);
    if (verb === 'pause' || verb === 'dismiss') {
      parse(EmptyBody, req.body ?? {});
      await (verb === 'pause' ? pauseGoal(db, id) : dismissGoal(db, id));
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
}
