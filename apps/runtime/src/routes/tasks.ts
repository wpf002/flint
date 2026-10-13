/**
 * The runtime's asset and task routes (P5), for the server's proxy to the
 * console. Every one needs the `proposals` scope, which the runtime connector's
 * token (world:read|ledger) never holds: a model can never read a task's words
 * or its result, and chat has no tool that files or runs a task.
 *
 *   GET  /v1/assets                       Settings > Assets (AssetsPage)
 *   POST /v1/assets/:id/on                the card that turns it on
 *   POST /v1/assets/:id/off               unsigned, audited
 *   GET  /v1/tasks?tab=active|finished    a tab of the panel (TasksPage)
 *   GET  /v1/tasks/:id                    one task, open (TaskView)
 *   POST /v1/tasks {draftKey, template, params, ...}   a new task and its dispatch card
 *   POST /v1/tasks/:id/cancel             unsigned while it has not gone out; else its card
 *   POST /v1/tasks/:id/accept|reject      Accept Anyway, Reject Anyway: that card
 *
 * Input is checked with the shared contracts (@flint/policy); a refusal is one
 * of TASK_SAYS's sentences with its code, and a zod failure is logged by field
 * paths and codes only. Answers are checked against their contracts on the way
 * out. Nothing here logs a task's words. While tasks are switched off (the
 * default; FLINT_ASSETS=on turns them on) every route here answers with one
 * sentence saying so, before it reads its input or the database.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AssetId, AssetsPage, EmptyBody, NewTaskBody, TASK_TABS, TaskAnswer, TaskCardFiled, TaskDone, TaskFiled, TaskId, TasksPage, taskCodeOf } from '@flint/policy';
import type { RuntimeScope } from '../config.js';
import type { Db } from '../db.js';
import { Refused } from '../governance/proposals.js';
import { fileEnable, turnOff } from '../assets/service.js';
import { assetsPage } from '../assets/view.js';
import { SAY } from '../tasks/errors.js';
import { cancelTask, createTask, overrideTask } from '../tasks/service.js';
import { taskView, tasksPage } from '../tasks/view.js';

export interface TaskRouteDeps {
  db: Db;
  need: (scope: RuntimeScope) => (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  tz: string;
  /** True only while tasks and assets are switched on (FLINT_ASSETS=on). */
  on: boolean;
}

/** An answer that broke its contract on the way out: the runtime's bug (a 500), never a leak. */
export class TaskAnswerBroken extends Error {}

function out<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const r = schema.safeParse(value);
  if (!r.success) throw new TaskAnswerBroken(`a tasks answer broke ${r.error.issues.length} rule(s) of its contract at ${[...new Set(r.error.issues.map((i) => i.path.join('.')))].join(', ').slice(0, 200)}`);
  return r.data;
}

/** Input as the contract reads it, or a refusal that names fields and codes (never a value). */
function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const r = schema.safeParse(value);
  if (!r.success) throw new Refused(400, SAY.invalid, r.error.issues.map((i) => `${i.path.join('.') || '<body>'}: ${i.code}`).join('; ').slice(0, 300));
  return r.data;
}

const Tab = z.object({ tab: z.enum(TASK_TABS).default('active') }).strict();
const Task = z.object({ id: TaskId }).strict();
const TaskVerb = z.object({ id: TaskId, verb: z.enum(['cancel', 'accept', 'reject']) }).strict();
const AssetVerb = z.object({ id: AssetId, verb: z.enum(['on', 'off']) }).strict();

export function registerTaskRoutes(app: FastifyInstance, d: TaskRouteDeps): void {
  const { db, need, tz } = d;
  const pre = { preHandler: need('proposals') };
  /**
   * A refusal as Will reads it, with its code; anything else to the app's
   * handler. Switched off, the refusal is the whole answer: no route's own code runs.
   */
  const guarded = <T>(fn: (req: FastifyRequest) => Promise<T>) => async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      if (!d.on) throw new Refused(409, SAY.off);
      return await fn(req);
    } catch (err) {
      if (!(err instanceof Refused)) throw err;
      const code = taskCodeOf(err.message);
      if (err.why) {
        const ref = `ref${Date.now().toString(36)}`;
        req.log.warn({ ref, status: err.status, why: err.why }, 'task route refused');
        return reply.code(err.status).send({ error: err.message, ...(code ? { code } : {}), ref });
      }
      return reply.code(err.status).send({ error: err.message, ...(code ? { code } : {}) });
    }
  };

  app.get('/v1/assets', pre, guarded(async () => out(AssetsPage, await assetsPage(db))));

  app.post('/v1/assets/:id/:verb', pre, guarded(async (req) => {
    const { id, verb } = parse(AssetVerb, req.params);
    parse(EmptyBody, req.body ?? {});
    if (verb === 'off') {
      await turnOff(db, id);
      return out(TaskDone, { ok: true });
    }
    return out(TaskCardFiled, await fileEnable(db, id));
  }));

  app.get('/v1/tasks', pre, guarded(async (req) => {
    const { tab } = parse(Tab, req.query ?? {});
    return out(TasksPage, await tasksPage(db, tab, tz));
  }));

  app.get('/v1/tasks/:id', pre, guarded(async (req) => {
    const { id } = parse(Task, req.params);
    const task = await taskView(db, id, tz);
    if (!task) throw new Refused(404, SAY.noTask);
    return out(TaskAnswer, { task });
  }));

  app.post('/v1/tasks', pre, guarded(async (req) => out(TaskFiled, await createTask(db, parse(NewTaskBody, req.body)))));

  app.post('/v1/tasks/:id/:verb', pre, guarded(async (req) => {
    const { id, verb } = parse(TaskVerb, req.params);
    parse(EmptyBody, req.body ?? {});
    if (verb === 'cancel') {
      const r = await cancelTask(db, id);
      return 'ok' in r ? out(TaskDone, r) : out(TaskCardFiled, r);
    }
    return out(TaskCardFiled, await overrideTask(db, id, verb === 'accept' ? 'accepted' : 'rejected'));
  }));
}
