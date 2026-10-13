/**
 * Will's goals, for the console's Goals panel (Machine plan P3 part 2): a proxy
 * to the runtime's goal routes. Console buttons only, never model tools: they
 * need the console's full token (a scoped voice or eval token cannot reach
 * them, ./access).
 *
 *   GET  /goals?tab=active|suggested|finished   -> runtime GET /v1/goals
 *   GET  /goals/:id                             -> runtime GET /v1/goals/:id
 *   POST /goals {draftKey, args}                -> a new goal's card
 *   POST /goals/linkable {q}                    -> items a check may watch (a POST: what Will types never lands in a request log)
 *   POST /goals/:id/edit|timing|done|abandon|resume|start|plan {args}   -> that card (start: Make It a Goal, for one Flint suggested from a chat)
 *   POST /goals/:id/pause|dismiss               -> unsigned
 *   POST /goals/:id/review                      -> Review Now: unsigned (part 3; the runtime runs the review on its local model)
 *   POST /goals/:id/criteria/:cid {met}         -> unsigned
 *   POST /goals/:id/steps/:key {status}         -> unsigned
 *
 * Every id and body is checked here with the shared contracts (@flint/policy,
 * bodies up to 64 KB, the runtime's own limit and the contracts' largest card)
 * before the runtime sees it, and every answer against its contract before the
 * console does. A goal card is filed with the runtime straight away: nothing is
 * ever spooled to disk (RuntimeProposals.propose would write its args there), so
 * a runtime that is down is a 503 and nothing changed. A write the runtime did
 * not answer (in time, or because the connection dropped on the way) is a 504
 * that says Flint isn't sure it went through (the runtime may still finish it):
 * the same card filed again is the same card. The
 * runtime's own words never pass through: a refusal reaches the
 * console only as one of GOAL_SAYS's codes and its fixed sentence. A runtime
 * 401 or 403 is a 502 (the console forgets its token on a 401); a 404 on the
 * list is a 501 (an older runtime: the console hides its Goals button). Logs
 * carry statuses, field paths and references only, never goal text.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { z } from 'zod';
import {
  CriterionId,
  EmptyBody,
  GOAL_CARD_BODIES,
  GOAL_CARD_VERBS,
  GOAL_PLAIN_VERBS,
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
  goalSayOf,
  type GoalCardVerb,
} from '@flint/policy';
import { readJsonLimited } from './attachments';
import type { Runtime } from './audit-sink';

export interface GoalsDeps {
  /** The runtime link main() builds. */
  runtime: () => Runtime | undefined;
  fetchImpl?: typeof fetch;
  /** Per call to the runtime. Default: 10 s for a read; 30 s for a write, which may wait that long on a goal's lock before it lands. */
  timeoutMs?: number;
  /** Log an error with a short reference, and return the reference for the client. */
  errorRef: (tag: string, err: unknown) => string;
}

/**
 * A goals request's largest body: the runtime's own (64 KB), which holds the
 * contracts' largest card (ten checks and ten steps at full length, in any script,
 * with what it changes from).
 */
export const GOALS_BODY_BYTES = 64 * 1024;
const READ_TIMEOUT_MS = 10_000;
const WRITE_TIMEOUT_MS = 30_000;
/**
 * ask()'s status for a call that reached the runtime, or may have, and got no answer: it timed out, or the
 * connection dropped on the way. (0: the runtime could not be reached at all, so it got nothing.)
 */
const NO_ANSWER = -2;
/** A connection that was never made: the request did not leave. */
const UNREACHED: ReadonlySet<string> = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL', 'EAI_AGAIN']);
/** The largest runtime answer the server reads. */
const MAX_ANSWER = 2 * 1024 * 1024;

/** What Will reads when the runtime can't be asked. */
export const GOALS_SAY = {
  noRuntime: 'Goals need the runtime.',
  older: 'This needs a newer runtime.',
  down: 'The runtime isn’t answering, so goals can’t load.',
  downWrite: 'The runtime isn’t answering, so nothing changed.',
  unsure: 'Flint isn’t sure it went through. Check the goal before trying again.',
  token: 'The runtime rejected Flint’s token. Reinstall the runtime to fix it.',
  refused: 'The runtime refused that change.',
  gone: 'That goal no longer exists.',
  stuck: 'That goal can no longer change.',
  busy: 'The runtime is busy. Try again shortly.',
  failed: 'The runtime hit an error. Try again.',
  unreadable: 'The runtime sent an answer Flint can’t read.',
  invalid: 'Flint can’t send that: it isn’t a valid goal request.',
  tooLarge: 'That is too large to send.',
} as const;

function reply(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
  return true;
}

type Answer = { ok: true; json: unknown } | { ok: false; status: number; code?: unknown };

/** One call to the runtime: its JSON, or its status (0: unreachable; NO_ANSWER: sent, or maybe sent, and not answered) and a refusal's code. The body is always read or cancelled. */
async function ask(deps: GoalsDeps, rt: Runtime, method: 'GET' | 'POST', path: string, body?: unknown): Promise<Answer> {
  try {
    const r = await (deps.fetchImpl ?? fetch)(`${rt.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${rt.token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(deps.timeoutMs ?? (method === 'GET' ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS)),
    });
    const text = await r.text();
    if (text.length > MAX_ANSWER) return { ok: false, status: -1 };
    if (!r.ok) {
      let code: unknown;
      try {
        code = (JSON.parse(text) as { code?: unknown } | null)?.code;
      } catch {
        code = undefined;
      }
      return { ok: false, status: r.status, code };
    }
    return { ok: true, json: JSON.parse(text) as unknown };
  } catch (err) {
    // Only a connection that was never made is "the runtime got nothing". A timeout, a reset, a socket closed
    // mid-answer: the runtime may have the request, and a write may still land.
    const cause = (err as { cause?: { code?: unknown; errors?: Array<{ code?: unknown }> } } | null)?.cause;
    // One address, or several tried in turn (localhost): unreached only when every attempt was.
    const codes = Array.isArray(cause?.errors) && cause.errors.length ? cause.errors.map((e) => e?.code) : [cause?.code];
    return { ok: false, status: codes.every((c) => typeof c === 'string' && UNREACHED.has(c)) ? 0 : NO_ANSWER };
  }
}

/** The console's answer when the runtime did not give a usable one. `list`: the panel's list (a 404 there is an older runtime). */
function failed(res: ServerResponse, deps: GoalsDeps, a: { status: number; code?: unknown }, what: string, read: boolean, list: boolean): true {
  const s = a.status;
  if (s === 0) return reply(res, 503, { error: read ? GOALS_SAY.down : GOALS_SAY.downWrite });
  // No answer (in time, or the connection dropped): a read just did not load; a write may still land, and saying
  // "nothing changed" would be a guess.
  if (s === NO_ANSWER) return read ? reply(res, 503, { error: GOALS_SAY.down }) : reply(res, 504, { error: GOALS_SAY.unsure });
  if (s === 401 || s === 403) return reply(res, 502, { error: GOALS_SAY.token });
  // A refusal the runtime named by a code in the closed set: its fixed sentence, and the code.
  const say = goalSayOf(a.code);
  if (say && typeof a.code === 'string' && (s === 400 || s === 404 || s === 409 || s === 429)) return reply(res, s, { error: say, code: a.code });
  if (s === 404) return list || !read ? reply(res, 501, { error: GOALS_SAY.older }) : reply(res, 404, { error: GOALS_SAY.gone });
  if (s === 400 || s === 422) return reply(res, 400, { error: GOALS_SAY.refused });
  if (s === 409) return reply(res, 409, { error: GOALS_SAY.stuck });
  if (s === 413) return reply(res, 413, { error: GOALS_SAY.tooLarge });
  if (s === 429) return reply(res, 429, { error: GOALS_SAY.busy });
  return reply(res, 502, { error: GOALS_SAY.failed, ref: deps.errorRef('goals', `the runtime answered ${s} for a ${what} request`) });
}

const paths = (e: z.ZodError) => [...new Set(e.issues.map((i) => i.path.join('.') || '(root)'))].join(', ').slice(0, 300);

/** The runtime answered 2xx with something that is not the contract: logged by field paths, never values. */
function malformed(res: ServerResponse, deps: GoalsDeps, what: string, e: z.ZodError): true {
  return reply(res, 502, { error: GOALS_SAY.unreadable, ref: deps.errorRef('goals', `malformed ${what} answer (${paths(e)})`) });
}

/** The console sent something no goal route takes: refused here, before the runtime sees it, by field paths only. */
function invalid(res: ServerResponse, deps: GoalsDeps, what: string, e?: z.ZodError): true {
  if (e) deps.errorRef('goals', `refused a ${what} request (${paths(e)})`);
  return reply(res, 400, { error: GOALS_SAY.invalid });
}

/** Ask, check the answer against its contract, and pass it on. */
async function forward<T extends z.ZodTypeAny>(res: ServerResponse, deps: GoalsDeps, rt: Runtime, method: 'GET' | 'POST', path: string, body: unknown, schema: T, what: string, list = false): Promise<true> {
  const a = await ask(deps, rt, method, path, body);
  if (!a.ok) return failed(res, deps, a, what, method === 'GET' || what === 'linkable', list);
  const answer = schema.safeParse(a.json);
  if (!answer.success) return malformed(res, deps, what, answer.error);
  return reply(res, 200, answer.data);
}

const CARD = /^\/goals\/([^/]+)\/(edit|timing|done|abandon|resume|start|plan)$/;
const PLAIN = /^\/goals\/([^/]+)\/(pause|dismiss|review)$/;
const MARK = /^\/goals\/([^/]+)\/criteria\/([^/]+)$/;
const STEP = /^\/goals\/([^/]+)\/steps\/([^/]+)$/;
const ONE = /^\/goals\/([^/]+)$/;

/** Handle one goals route; false when `url` is not one of them. */
export async function goalsRoutes(req: IncomingMessage, res: ServerResponse, url: string, deps: GoalsDeps): Promise<boolean> {
  const u = new URL(url, 'http://x');
  const path = u.pathname;
  if (path !== '/goals' && !path.startsWith('/goals/')) return false;
  const get = req.method === 'GET';
  const post = req.method === 'POST';
  const card = post ? CARD.exec(path) : null;
  const plain = post ? PLAIN.exec(path) : null;
  const mark = post ? MARK.exec(path) : null;
  const step = post ? STEP.exec(path) : null;
  const one = get && path !== '/goals' ? ONE.exec(path) : null;
  const ours = (get && (path === '/goals' || one)) || (post && (path === '/goals' || path === '/goals/linkable' || card || plain || mark || step));
  if (!ours) return false;
  const rt = deps.runtime();
  // Without the runtime there are no goals: the console hides its button, as for an older runtime.
  if (!rt) {
    if (post) await readJsonLimited(req, GOALS_BODY_BYTES);
    return reply(res, 501, { error: GOALS_SAY.noRuntime });
  }

  if (get && path === '/goals') {
    const keys = [...u.searchParams.keys()];
    const tab = u.searchParams.get('tab') ?? 'active';
    if (keys.some((k) => k !== 'tab') || !(GOAL_TABS as readonly string[]).includes(tab)) return invalid(res, deps, 'list');
    return forward(res, deps, rt, 'GET', `/v1/goals?${new URLSearchParams({ tab })}`, undefined, GoalsPage, 'list', true);
  }
  if (one) {
    const id = GoalId.safeParse(one[1]);
    if (!id.success || u.search) return invalid(res, deps, 'goal');
    return forward(res, deps, rt, 'GET', `/v1/goals/${id.data}`, undefined, GoalAnswer, 'goal');
  }

  // The POSTs: the body is read (and drained) whatever happens, up to 64 KB.
  const read = await readJsonLimited(req, GOALS_BODY_BYTES);
  if (read.tooLarge) return reply(res, 413, { error: GOALS_SAY.tooLarge });
  const body = read.body;

  if (path === '/goals') {
    const b = NewGoalBody.safeParse(body);
    if (!b.success) return invalid(res, deps, 'new goal', b.error);
    return forward(res, deps, rt, 'POST', '/v1/goals', b.data, GoalFiled, 'new goal');
  }
  if (path === '/goals/linkable') {
    const b = LinkableBody.safeParse(body);
    if (!b.success) return invalid(res, deps, 'linkable', b.error);
    return forward(res, deps, rt, 'POST', '/v1/goals/linkable', b.data, Linkable, 'linkable');
  }
  const m = (card ?? plain ?? mark ?? step)!;
  const id = GoalId.safeParse(m[1]);
  if (!id.success) return invalid(res, deps, 'goal');
  if (card) {
    const verb = card[2] as GoalCardVerb;
    const b = GOAL_CARD_BODIES[verb].safeParse(body);
    if (!b.success) return invalid(res, deps, GOAL_CARD_VERBS[verb], b.error);
    if ((b.data as { args: { goalId: string } }).args.goalId !== id.data) return invalid(res, deps, GOAL_CARD_VERBS[verb]);
    return forward(res, deps, rt, 'POST', `/v1/goals/${id.data}/${verb}`, b.data, GoalFiled, GOAL_CARD_VERBS[verb]);
  }
  if (plain) {
    const verb = plain[2] as (typeof GOAL_PLAIN_VERBS)[number];
    const b = EmptyBody.safeParse(body);
    if (!b.success) return invalid(res, deps, verb, b.error);
    return forward(res, deps, rt, 'POST', `/v1/goals/${id.data}/${verb}`, {}, GoalDone, verb);
  }
  if (mark) {
    const cid = CriterionId.safeParse(mark[2]);
    const b = MarkBody.safeParse(body);
    if (!cid.success || !b.success) return invalid(res, deps, 'mark', b.success ? undefined : b.error);
    return forward(res, deps, rt, 'POST', `/v1/goals/${id.data}/criteria/${cid.data}`, b.data, GoalDone, 'mark');
  }
  const key = StepKey.safeParse(step![2]);
  const b = StepBody.safeParse(body);
  if (!key.success || !b.success) return invalid(res, deps, 'step', b.success ? undefined : b.error);
  return forward(res, deps, rt, 'POST', `/v1/goals/${id.data}/steps/${key.data}`, b.data, GoalDone, 'step');
}
