/**
 * Flint's tasks and assets, for the console's Tasks panel and Settings >
 * Assets (P5 part 4): a proxy to the runtime's task and asset routes. Console
 * buttons only, never model tools: they need the console's full token (a
 * scoped voice or eval token cannot reach them, ./access), and chat has no
 * tool that reaches one.
 *
 *   GET  /assets                                 -> Settings > Assets (runtime GET /v1/assets)
 *   POST /assets/:id/on {}                       -> the card that turns it on
 *   POST /assets/:id/off {}                      -> unsigned
 *   GET  /tasks?tab=active|finished              -> a tab of the panel
 *   GET  /tasks/form                             -> what New Task can offer now (runtime GET /v1/task-form)
 *   GET  /tasks/:id                              -> one task, open
 *   POST /tasks {draftKey, template, params, ...}  -> a new task and its dispatch card
 *   POST /tasks/:id/cancel {}                    -> unsigned while it has not gone out; else its card
 *   POST /tasks/:id/accept|reject {}             -> Accept Anyway, Reject Anyway: that card
 *   POST /tasks/:id/again {draftKey}             -> Run Again: a new task like an ended one, and its card
 *
 * Every id and body is checked here with the shared contracts (@flint/policy,
 * bodies up to 32 KB) before the runtime sees it, and every answer against its
 * contract before the console does. A card is filed with the runtime straight
 * away: nothing is ever spooled to disk, so a runtime that is down is a 503 and
 * nothing changed. A write the runtime did not answer (in time, or because the
 * connection dropped on the way) is a 504 that says Flint isn't sure it went
 * through: a form sent again with its key is the same task, and the same card.
 * The runtime's own words never pass through: a refusal reaches the console
 * only as one of TASK_SAYS's codes and its fixed sentence. That is how the
 * console learns tasks are switched off on this Mac (`off`, a 409 on every
 * route). A runtime 401 or 403 is a 502 (the console forgets its token on a
 * 401); a 404 on a page (the assets, a tab, the form) is a 501 (an older
 * runtime: the console hides what it cannot offer).
 *
 * A task's title and its result are Will's words, or a watched system's. They
 * pass through here from the runtime to the console and go nowhere else: this
 * file keeps nothing, pushes no note, and logs statuses, field paths and
 * references only.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { AssetId, AssetsPage, EmptyBody, NewTaskBody, TASK_TABS, TaskAgainBody, TaskAnswer, TaskCardFiled, TaskDone, TaskFiled, TaskForm, TaskId, TasksPage, taskSayOf } from '@flint/policy';
import { readJsonLimited } from './attachments';
import type { Runtime } from './audit-sink';

export interface TasksDeps {
  /** The runtime link main() builds. */
  runtime: () => Runtime | undefined;
  fetchImpl?: typeof fetch;
  /** Per call to the runtime. Default: 10 s for a read, 30 s for a write. */
  timeoutMs?: number;
  /** Log an error with a short reference, and return the reference for the client. */
  errorRef: (tag: string, err: unknown) => string;
}

/** A tasks request's largest body: a task's spec is at most 16 KB, so a form fits twice over. */
export const TASKS_BODY_BYTES = 32 * 1024;
const READ_TIMEOUT_MS = 10_000;
const WRITE_TIMEOUT_MS = 30_000;
/**
 * ask()'s status for a call that reached the runtime, or may have, and got no answer: it timed out, or the
 * connection dropped on the way. (0: the runtime could not be reached at all, so it got nothing.)
 */
const NO_ANSWER = -2;
/** A connection that was never made: the request did not leave. */
const UNREACHED: ReadonlySet<string> = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL', 'EAI_AGAIN']);
/** The largest runtime answer the server reads (a tab holds up to 200 rows). */
const MAX_ANSWER = 1024 * 1024;

/** What Will reads when the runtime can't be asked. */
export const TASKS_SAY = {
  noRuntime: 'Tasks need the runtime.',
  older: 'This needs a newer runtime.',
  down: 'The runtime isn’t answering, so tasks can’t load.',
  downWrite: 'The runtime isn’t answering, so nothing changed.',
  unsure: 'Flint isn’t sure it went through. Check Tasks before trying again.',
  token: 'The runtime rejected Flint’s token. Reinstall the runtime to fix it.',
  refused: 'The runtime refused that change.',
  gone: 'That is no longer there.',
  stuck: 'That can no longer change.',
  busy: 'The runtime is busy. Try again shortly.',
  failed: 'The runtime hit an error. Try again.',
  unreadable: 'The runtime sent an answer Flint can’t read.',
  invalid: 'Flint can’t send that: it isn’t a valid tasks request.',
  tooLarge: 'That is too large to send.',
} as const;

/**
 * Every answer, whatever its status: never kept by a browser or anything between. A task's words and its result
 * are for the open panel only, and a disk cache would outlive it.
 */
function reply(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
  return true;
}

type Answer = { ok: true; json: unknown } | { ok: false; status: number; code?: unknown };

/** One call to the runtime: its JSON, or its status (0: unreachable; NO_ANSWER: sent, or maybe sent, and not answered) and a refusal's code. The body is always read or cancelled. */
async function ask(deps: TasksDeps, rt: Runtime, method: 'GET' | 'POST', path: string, body?: unknown): Promise<Answer> {
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

/** How a route's failure is read. `page`: a read the console opens with (a 404 there is an older runtime). `newer`: a write only a newer runtime knows. */
interface How {
  what: string;
  read: boolean;
  page?: boolean;
  newer?: boolean;
}

/** The console's answer when the runtime did not give a usable one. */
function failed(res: ServerResponse, deps: TasksDeps, a: { status: number; code?: unknown }, how: How): true {
  const s = a.status;
  if (s === 0) return reply(res, 503, { error: how.read ? TASKS_SAY.down : TASKS_SAY.downWrite });
  // No answer (in time, or the connection dropped): a read just did not load; a write may still land, and saying
  // "nothing changed" would be a guess.
  if (s === NO_ANSWER) return how.read ? reply(res, 503, { error: TASKS_SAY.down }) : reply(res, 504, { error: TASKS_SAY.unsure });
  if (s === 401 || s === 403) return reply(res, 502, { error: TASKS_SAY.token });
  // What this proxy sent was checked with the contract first. A runtime that calls it invalid is one from before
  // the route: said as that, never as a mistake of Will's.
  if (how.newer && s === 400 && a.code === 'invalid') return reply(res, 501, { error: TASKS_SAY.older });
  // A refusal the runtime named by a code in the closed set: its fixed sentence, and the code.
  const say = taskSayOf(a.code);
  if (say && typeof a.code === 'string' && (s === 400 || s === 404 || s === 409 || s === 429)) return reply(res, s, { error: say, code: a.code });
  if (s === 404) return how.page || !how.read ? reply(res, 501, { error: TASKS_SAY.older }) : reply(res, 404, { error: TASKS_SAY.gone });
  if (s === 400 || s === 422) return reply(res, 400, { error: TASKS_SAY.refused });
  if (s === 409) return reply(res, 409, { error: TASKS_SAY.stuck });
  if (s === 413) return reply(res, 413, { error: TASKS_SAY.tooLarge });
  if (s === 429) return reply(res, 429, { error: TASKS_SAY.busy });
  return reply(res, 502, { error: TASKS_SAY.failed, ref: deps.errorRef('tasks', `the runtime answered ${s} for a ${how.what} request`) });
}

const paths = (e: z.ZodError) => [...new Set(e.issues.map((i) => i.path.join('.') || '(root)'))].join(', ').slice(0, 300);

/** The runtime answered 2xx with something that is not the contract: logged by field paths, never values. */
function malformed(res: ServerResponse, deps: TasksDeps, what: string, e: z.ZodError): true {
  return reply(res, 502, { error: TASKS_SAY.unreadable, ref: deps.errorRef('tasks', `malformed ${what} answer (${paths(e)})`) });
}

/** The console sent something no tasks route takes: refused here, before the runtime sees it, by field paths only. */
function invalid(res: ServerResponse, deps: TasksDeps, what: string, e?: z.ZodError): true {
  if (e) deps.errorRef('tasks', `refused a ${what} request (${paths(e)})`);
  return reply(res, 400, { error: TASKS_SAY.invalid });
}

/** Ask, check the answer against its contract, and pass it on. */
async function forward<T extends z.ZodTypeAny>(res: ServerResponse, deps: TasksDeps, rt: Runtime, method: 'GET' | 'POST', path: string, body: unknown, schema: T, how: Omit<How, 'read'>): Promise<true> {
  const a = await ask(deps, rt, method, path, body);
  if (!a.ok) return failed(res, deps, a, { ...how, read: method === 'GET' });
  const answer = schema.safeParse(a.json);
  if (!answer.success) return malformed(res, deps, how.what, answer.error);
  return reply(res, 200, answer.data);
}

/** A cancel is done there and then (the task had not gone out), or it is a card for Will to sign. */
const Cancelled = z.union([TaskDone, TaskCardFiled]);

const ASSET = /^\/assets\/([^/]+)\/(on|off)$/;
const TASK = /^\/tasks\/([^/]+)$/;
const VERB = /^\/tasks\/([^/]+)\/(cancel|accept|reject|again)$/;
const VERBS = { cancel: ['cancel', Cancelled], accept: ['accept anyway', TaskCardFiled], reject: ['reject anyway', TaskCardFiled] } as const;

/** Handle one tasks or assets route; false when `url` is not one of them. */
export async function tasksRoutes(req: IncomingMessage, res: ServerResponse, url: string, deps: TasksDeps): Promise<boolean> {
  const u = new URL(url, 'http://x');
  const path = u.pathname;
  if (path !== '/tasks' && !path.startsWith('/tasks/') && path !== '/assets' && !path.startsWith('/assets/')) return false;
  const get = req.method === 'GET';
  const post = req.method === 'POST';
  const page = get && (path === '/assets' || path === '/tasks' || path === '/tasks/form');
  const one = get && !page ? TASK.exec(path) : null;
  const asset = post ? ASSET.exec(path) : null;
  const verb = post ? VERB.exec(path) : null;
  const create = post && path === '/tasks';
  if (!page && !one && !asset && !verb && !create) return false;
  const rt = deps.runtime();
  // Without the runtime there are no tasks: the console hides its button, as for an older runtime.
  if (!rt) {
    if (post) await readJsonLimited(req, TASKS_BODY_BYTES);
    return reply(res, 501, { error: TASKS_SAY.noRuntime });
  }

  if (path === '/tasks' && get) {
    // The one read with a query, and the one thing it may say: which tab.
    const keys = [...u.searchParams.keys()];
    const tab = u.searchParams.get('tab') ?? 'active';
    if (keys.some((k) => k !== 'tab') || keys.length > 1 || !(TASK_TABS as readonly string[]).includes(tab)) return invalid(res, deps, 'tab');
    return forward(res, deps, rt, 'GET', `/v1/tasks?${new URLSearchParams({ tab })}`, undefined, TasksPage, { what: 'tab', page: true });
  }
  if (page) {
    if (u.search) return invalid(res, deps, path === '/assets' ? 'assets' : 'form');
    if (path === '/assets') return forward(res, deps, rt, 'GET', '/v1/assets', undefined, AssetsPage, { what: 'assets', page: true });
    return forward(res, deps, rt, 'GET', '/v1/task-form', undefined, TaskForm, { what: 'form', page: true });
  }
  if (one) {
    const id = TaskId.safeParse(one[1]);
    if (!id.success || u.search) return invalid(res, deps, 'task');
    return forward(res, deps, rt, 'GET', `/v1/tasks/${id.data}`, undefined, TaskAnswer, { what: 'task' });
  }

  // The POSTs: the body is read (and drained) whatever happens, up to 32 KB.
  const got = await readJsonLimited(req, TASKS_BODY_BYTES);
  if (got.tooLarge) return reply(res, 413, { error: TASKS_SAY.tooLarge });
  const body = got.body;
  if (u.search) return invalid(res, deps, 'write');

  if (create) {
    const b = NewTaskBody.safeParse(body);
    if (!b.success) return invalid(res, deps, 'new task', b.error);
    return forward(res, deps, rt, 'POST', '/v1/tasks', b.data, TaskFiled, { what: 'new task' });
  }
  if (asset) {
    const id = AssetId.safeParse(asset[1]);
    const b = EmptyBody.safeParse(body ?? {});
    const what = asset[2] === 'on' ? 'turn on' : 'turn off';
    if (!id.success || !b.success) return invalid(res, deps, what, b.success ? undefined : b.error);
    return forward(res, deps, rt, 'POST', `/v1/assets/${id.data}/${asset[2]}`, {}, asset[2] === 'on' ? TaskCardFiled : TaskDone, { what });
  }
  const id = TaskId.safeParse(verb![1]);
  if (verb![2] === 'again') {
    const b = TaskAgainBody.safeParse(body);
    if (!id.success || !b.success) return invalid(res, deps, 'run again', b.success ? undefined : b.error);
    return forward(res, deps, rt, 'POST', `/v1/tasks/${id.data}/again`, b.data, TaskFiled, { what: 'run again', newer: true });
  }
  const [what, schema] = VERBS[verb![2] as keyof typeof VERBS];
  const b = EmptyBody.safeParse(body ?? {});
  if (!id.success || !b.success) return invalid(res, deps, what, b.success ? undefined : b.error);
  return forward(res, deps, rt, 'POST', `/v1/tasks/${id.data}/${verb![2]}`, {}, schema, { what });
}
